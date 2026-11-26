const { normalizeVideoCommentCount, belowCommentMinimum } = require('./video-comment-count.cjs')
const { commentSample, SAMPLE_LIMIT } = require('./custom-goals.cjs')
// P2-17B 固定批次：三来源寻找 → 试采评论判断价值 → 筛选 → 入池；支持暂停/继续/停止/重启恢复。
// 本模块只负责"找人与入池"；真实关注/私信由外部通过 onBatchDone 钩子接管（训练模式逐人确认，正式模式批次结束执行）。
const { candidateRecords } = require('../social-brain/library-candidates.cjs')
const { VideoSources } = require('./video-sources.cjs')
const { parseSearchTerms, keywordQueries, rankVideos } = require('./search-query.cjs')
const { evaluateBatchCandidate, normalizeBatchFilters } = require('./batch-filter.cjs')
const { createVideoReader, isInterested, roundLimits } = require('./video-rounds.cjs')
const { retryableClassification } = require('./classification-retry.cjs')
const { createHash } = require('node:crypto')
const { normalizeSampling, INTENT_LEVELS } = require('./selection-policy.cjs')
const { buildProfileFacts } = require('./profile-facts.cjs')
const { classifyCollection, COLLECTION_CODES } = require('./collection-outcome.cjs')

const STATUS = { IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused', STOPPED: 'stopped', DONE: 'done', FAILED: 'failed', INTERRUPTED: 'interrupted' }
const ACTIVE = [STATUS.RUNNING, STATUS.PAUSED]
const VERIFICATION_CODES = ['CHALLENGE', 'PROFILE_ACCESS_RESTRICTED', 'VERIFICATION_CHECK_UNAVAILABLE']

const int = (v, def, min, max) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : def)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Opening context comes from the actual match in this batch, including resumed batches.
function batchOpeningInput(candidate, batch, entry) {
  const input = { url: candidate.profileUrl, name: candidate.nickname, commentText: candidate.firstComment, videoTitle: '' }
  const goal = batch?.targetSnapshot
  if (!goal || !entry?.goalMatch) return input
  return {
    ...input,
    commentText: entry.goalSource?.commentText || entry.goalMatch.text || '',
    videoTitle: entry.goalSource?.videoTitle || '',
    openingGoal: { name: goal.name, description: goal.description, instructions: goal.openingInstructions || '' },
  }
}

function normalizeBatchConfig(input = {}) {
  const v = input && typeof input === 'object' ? input : {}
  const sources = v.sources && typeof v.sources === 'object' ? v.sources : {}
  const list = (arr, max = 10) => (Array.isArray(arr) ? arr : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, max)
  const budgets = v.budgets || {}
  return {
    target: int(v.target, 20, 1, 100),
    maxProfileChecks: int(v.maxProfileChecks, Math.min(60, int(v.target, 20, 1, 100) * 2), 1, 60),
    minVideoComments: int(v.minVideoComments, 20, 0, 1000000),
    sources: {
      keywords: parseSearchTerms(sources.keywords),
      tags: parseSearchTerms(sources.tags, { tags: true }),
      combinedSearch: sources.combinedSearch !== false,
      favorites: sources.favorites === true,
    },
    filters: normalizeBatchFilters(v.filters),
    sampling: normalizeSampling(v.sampling),
    budgets: {
      maxVideos: int(budgets.maxVideos, 30, 1, 200),
      maxComments: int(budgets.maxComments, 400, 10, 2000),
      maxMinutes: int(budgets.maxMinutes, 30, 1, 240),
      maxAiCalls: int(budgets.maxAiCalls, 30, 0, 200),
      sampleSize: int(budgets.sampleSize, 20, 5, 30),
      valueThreshold: int(budgets.valueThreshold, 2, 0, 50),
    },
  }
}

class BatchRunner {
  // deps: { manager, storage, accountId, ai, libraryStore, learningStore, collectorFactory, classify, draftOpening, emit }
  constructor(deps) {
    this.deps = deps
    this.sourcesFactory = deps.sourcesFactory || (engine => new VideoSources(engine))
    this.buildRecords = deps.buildRecords || candidateRecords
    this.running = false
    this.stopping = false
    this.paused = false
    this.generation = 0
    this.genderChecks = new Map()
    // 首句生成不再阻塞主循环：入池即投递到后台队列（最多 3 个并发），批次收尾时统一等待。
    // 这样多个候选的首句与后续视频采集重叠，且写候选池串行化，避免并发 get→save 覆盖。
    this.draftQueue = []
    this.pendingDrafts = new Set()
    this.draftRunning = 0
    this.draftScheduled = 0
    this.draftWrite = Promise.resolve()
  }

  enqueueClassification(comments, item) {
    const queue = new Map((this.state.classificationQueue || []).map(row => [row.key, row]))
    for (const comment of comments) if (!queue.has(comment.key)) queue.set(comment.key, { key: comment.key, videoId: item.videoId })
    this.save({ classificationQueue: [...queue.values()] })
  }

  async flushClassificationQueue(alive, force = false) {
    const state = this.state
    if (!state?.crossVideoClassification || !alive()) return false
    const queued = state.classificationQueue || []
    const comments = new Map((this.deps.libraryStore.read().comments || []).map(c => [c.key, c]))
    const attempts = state.classificationRetryCounts || {}
    const pending = queued.filter(row => {
      const c = comments.get(row.key)
      return c && (!c.classification?.intent || retryableClassification(c)) && (attempts[row.key] || 0) < 2
    })
    const size = pending.some(row => (attempts[row.key] || 0) > 0) ? 12 : 20
    const pendingKeys = new Set(pending.map(row => row.key))
    const removed = queued.filter(row => !pendingKeys.has(row.key))
    if ((!force && pending.length < size) || !pending.length || this.budgetLeft(state).aiLeft <= 0) {
      if (removed.length) this.commitClassificationQueue(pending, removed.map(row => row.videoId))
      return removed.length > 0
    }
    const requested = pending.slice(0, size), next = { ...attempts }
    for (const row of requested) next[row.key] = (next[row.key] || 0) + 1
    this.save({ classificationRetryCounts: next })
    const started = Date.now()
    let result
    try { result = await this.deps.classify(requested.map(row => row.key), 1) }
    catch (error) {
      // Reserve the attempted call even when a provider throws, preventing unbounded retries.
      result = { aiCalls: 1, tokens: 0 }
      this.save({ classificationError: String(error?.message || error).slice(0, 160) })
    }
    this.bumpProgress({ aiCalls: result?.aiCalls || 0, tokens: result?.tokens || 0, classifyTargets: requested.length })
    this.bumpPerf({ classifyMs: Date.now() - started }, false)
    const latest = new Map((this.deps.libraryStore.read().comments || []).map(c => [c.key, c]))
    const remaining = pending.filter(row => {
      const c = latest.get(row.key)
      return c && (!c.classification?.intent || retryableClassification(c)) && (next[row.key] || 0) < 2
    })
    this.commitClassificationQueue(remaining, [...removed, ...requested].map(row => row.videoId))
    return true
  }

  commitClassificationQueue(queue, videoIds) {
    const wake = new Set(videoIds)
    this.save({ classificationQueue: queue,
      queue: this.state.queue.map(item => item.status === 'awaiting_classification' && wake.has(item.videoId)
        ? { ...item, status: 'pending', classificationReplay: true, code: null } : item) })
  }

  observeProfileAccess(author, check) {
    if ((!this.state.crossVideoClassification && !this.state.targetSnapshot) || !check || check.status === 'blocked') return
    if (check.profileQueuePaused) { this.save({ profileReadCircuit: { failures: [author], disabled: true, since: new Date().toISOString(), reason: check.reason || '主页入口连续核验失败，本批保留待核实' } }); return }
    const prior = this.state.profileReadCircuit || { failures: [], disabled: false }
    if (prior.disabled) return
    const failures = check.code === 'PROFILE_UNAVAILABLE' ? [...new Set([...prior.failures, author])].slice(-3) : []
    this.save({ profileReadCircuit: { failures, disabled: failures.length >= 3,
      ...(failures.length >= 3 ? { since: new Date().toISOString(), reason: '连续不同主页提示用户不存在，本批已转为保留待核实；评论寻找继续' } : {}) } })
  }

  deferProfile(record, payload, evaluation, source) {
    if ((!this.state.crossVideoClassification && !this.state.targetSnapshot) || evaluation.status !== 'pending'
      || !evaluation.pendingReasons.some(reason => ['GENDER_UNVERIFIED','AGE_UNVERIFIED'].includes(reason))) return
    this.deferredProfileBuffer ||= []
    this.deferredProfileBuffer.push({ platformUserId: record.platformUserId, nickname: record.nickname,
      profileUrl: record.profileUrl, reasons: evaluation.pendingReasons, source,
      record: payload, at: new Date().toISOString() })
  }

  scheduleDraft(candidate, batch, entry) {
    if (!this.deps.draftOpening || !candidate?.id) return
    const max = batch.config?.budgets?.maxAiCalls ?? 30
    const openingPolicy = this.deps.openingPolicy?.()
    const cost = openingPolicy?.mode === 'fixed' ? 0 : 1
    if (cost && (this.state?.progress?.aiCalls || 0) + this.draftScheduled >= max) return
    this.draftScheduled += cost
    this.draftQueue.push({ candidate, batch, entry, openingPolicy })
    this.pumpDrafts()
  }

  pumpDrafts() {
    while (this.draftRunning < 3 && this.draftQueue.length) {
      const { candidate, batch, entry, openingPolicy } = this.draftQueue.shift()
      this.draftRunning += 1
      const task = Promise.resolve()
        .then(() => this.generateDraft(candidate, batch, entry, openingPolicy))
        .catch(error => {
          this.bumpProgress({ draftFailed: 1 })
          this.save({ draftError: String(error?.message || error).slice(0, 160) })
        })
        .finally(() => {
          this.draftRunning -= 1
          this.pendingDrafts.delete(task)
          this.pumpDrafts()
        })
      this.pendingDrafts.add(task)
    }
  }

  saveGoalDraft(batchId, candidateId, text, { replace = false } = {}) {
    const current = this.state
    const entry = current?.added?.find(row => row.candidateId === candidateId)
    if (current?.id !== batchId || !entry?.goalMatch) return false
    if (entry.draftOpening && !replace) return false
    this.save({ added: current.added.map(row => row === entry ? { ...row, draftOpening: text } : row) })
    return true
  }

  async generateDraft(candidate, batch, entry, openingPolicy) {
    const input = batchOpeningInput(candidate, batch, entry)
    const draft = await this.deps.draftOpening(candidate, { ...input, ...(openingPolicy ? { openingPolicy } : {}) })
    if (!draft?.text) return
    this.draftWrite = this.draftWrite.then(() => {
      if (entry?.goalMatch) {
        this.saveGoalDraft(batch.id, candidate.id, draft.text)
        return
      }
      const exists = this.deps.manager.get().candidates.some(item => item.id === candidate.id)
      if (exists) this.deps.manager.patch(candidate.id, { review: { draftOpening: draft.text } })
    }).catch(() => {})
    await this.draftWrite
    this.bumpProgress({ drafts: 1, aiCalls: draft.aiCalls ?? 1 })
  }

  // 批次收尾等待所有后台首句：自动联系钩子拿到的一定是已写回池里的首句。
  async finishDrafts() {
    let guard = 0
    while (this.pendingDrafts.size && guard++ < 20) await Promise.allSettled([...this.pendingDrafts])
    this.draftQueue.length = 0
  }

  get state() {
    if (typeof this.deps.storage?.getBatch === 'function') return this.deps.storage.getBatch()
    const discovery = this.deps.manager.get()
    return discovery[this.deps.stateKey || "batch"] || null
  }

  save(patch) {
    const discovery = this.deps.manager.get()
    const key = this.deps.stateKey || 'batch'
    if (key === 'batch' && patch.id && discovery.batch?.id && patch.id !== discovery.batch.id) {
      discovery.batchHistory = [...(discovery.batchHistory || []), Object.fromEntries(['id','status','startedAt','config','progress','genderReadResults','candidateDecisions','stopCode','reason','error','sourceRuns','profileDeferred','profileReadCircuit','classificationQueue','targetSnapshot','goalChecks'].map(k => [k,discovery.batch[k]]))].slice(-5)
    }
    const next = { ...(discovery[key] || {}), ...patch, updatedAt: new Date().toISOString() }
    this.deps.manager.save({ ...discovery, [key]: next })
    this.deps.emit?.()
    return next
  }

  // 启动时恢复：运行中的批次一律标为中断，等待用户点继续
  recoverOnBoot() {
    const batch = this.state
    if (batch && [STATUS.RUNNING].includes(batch.status)) {
      this.save({ status: STATUS.INTERRUPTED, reason: '应用重启，上次批次已中断；已完成的候选保留，可点继续从队列剩余部分恢复' })
    }
  }

  status() {
    const batch = this.state
    if (!batch) return { ok: true, batch: null }
    if (batch?.sampleOnly) return { ok: true, batch, cards: [] }
    const warnings = (batch?.warnings || []).filter(message => !/^(还没有设置人设|首句生成需要可用本人资料|介绍原文已保存，但本人信息库)/.test(message))
    return { ok: true, batch: batch ? { ...batch, warnings } : null, cards: this.cardsOf(batch), history: (this.deps.manager.get().batchHistory || []).map(x => ({ id: x.id, status: x.status, startedAt: x.startedAt, config: x.config, progress: x.progress, candidateDecisions: x.candidateDecisions || [], genderReadResults: x.genderReadResults || [] })) }
  }

  cardsOf(batch) {
    if (!batch) return []
    const discovery = this.deps.manager.get()
    const ids = new Set((batch.added || []).map(item => item.candidateId))
    const excluded = new Set((discovery.batchExcluded || []).map(item => item.platformUserId))
    // 卡片来源标注：added 记录带 sourceType，队列项带 query（如标签名/关键词）。
    const addedOf = new Map((batch.added || []).map(item => [item.candidateId, item]))
    const queueByVideo = new Map((batch.queue || []).filter(item => item.videoId).map(item => [item.videoId, item]))
    return discovery.candidates
      .filter(c => ids.has(c.id))
      .map(c => {
        const added = addedOf.get(c.id)
        const source = added?.commentSource || added?.goalSource || c.sources?.[0]
        const evaluation = evaluateBatchCandidate(c, batch.config?.filters, source, added?.goalMatch)
        const videoId = evaluation.evidence.videoId || (added || {}).videoId || null
        const queueItem = videoId ? queueByVideo.get(videoId) : null
        return {
          id: c.id, nickname: c.nickname, avatarUrl: c.avatarUrl, profileUrl: c.profileUrl, platformUserId: c.platformUserId,
          gender: evaluation.facts.gender, age: evaluation.facts.age, intent: c.libraryIntent, intentClass: evaluation.intentClass,
          sourceType: (added || {}).sourceType || c.sources?.[0]?.type || null,
          sourceQuery: (added || {}).query || queueItem?.query || c.sources?.[0]?.topic || null,
          comment: evaluation.evidence.commentText.slice(0, 400),
          ...(added?.goalMatch ? { goalMatch: added.goalMatch } : {}),
          commentTime: evaluation.evidence.commentTime, commentIp: evaluation.evidence.ipLocation,
          commentIpSource: evaluation.evidence.ipLocationSource,
          videoId, replyCount: evaluation.evidence.replyCount,
          replyTotal: evaluation.evidence.replyCount,
          commentId: evaluation.evidence.commentId,
          reviewStatus: c.review?.status || 'pending',
          filterBasis: evaluation.reasons,
          facts: evaluation.facts,
          draftOpening: (added?.goalMatch ? added.draftOpening : c.review?.draftOpening) || '',
          mock: c.review?.mockSend || null,
          realContact: c.review?.realContact || null,
          notInterested: excluded.has(c.platformUserId),
        }
      })
      .sort((a, b) => {
        const left = Number.isSafeInteger(a.replyCount) ? a.replyCount : Number.POSITIVE_INFINITY
        const right = Number.isSafeInteger(b.replyCount) ? b.replyCount : Number.POSITIVE_INFINITY
        if (left !== right) return left - right
        return String(a.nickname || '').localeCompare(String(b.nickname || ''), 'zh-CN')
      })
  }

  // 启用条件与可用证据不匹配时明确提示，不能静默把所有人挡在"待核实"里。
  warningsOf(config) {
    const warnings = []
    const filters = config?.filters || {}
    const comments = (this.deps.libraryStore?.read()?.comments || [])
    if (filters.requireIp && !comments.some(c => String(c.ip_location || c.ipLocation || '').trim())) {
      warnings.push('素材库暂未记录评论 IP 属地。本轮会继续读取页面显示的属地，未读到属地的评论无法通过地区筛选')
    }
    if (filters.requireReplyLimit) {
      const withReply = comments.filter(c => Number.isSafeInteger(c.reply_count ?? c.replyCount))
      if (comments.length && !withReply.length) warnings.push('素材库评论都没有回复总数（页面未提供）：启用回复数限制会让所有候选进入待核实')
    }
    // 收藏夹来源依赖已同步的收藏视频：库里没有收藏视频时本批会是 0 个视频，先明确提示去同步。
    if (config?.sources?.favorites) {
      const videos = (this.deps.libraryStore?.read()?.videos || [])
      const favorites = videos.filter(v => v.favoritesFolder || v.source === 'favorites')
      if (!favorites.length) warnings.push('收藏夹来源已选，但素材库里还没有收藏视频：请先在批次表单填写并保存收藏夹名称，否则本批检索不到任何视频')
    }
    return warnings
  }

  async start(input, { targetSnapshot = null, sampleOnly = false } = {}) {
    const current = this.state
    if (this.running || (current && ACTIVE.includes(current.status))) throw new Error('已有正在进行的批次，请先停止或等它结束')
    const config = normalizeBatchConfig(input)
    if (!config.sources.keywords.length && !config.sources.tags.length && !config.sources.favorites) {
      throw new Error('请至少选择一种来源：关键词、标签或收藏夹')
    }
    this.deps.prepareClassification?.()
    // 新一轮批次重置首句后台队列，避免上一轮的计数把本轮预算吃光。
    this.genderChecks.clear()
    this.deferredProfileBuffer = []
    this.decisionBuffer = []
    this.stopping = false
    this.paused = false
    this.draftQueue.length = 0
    this.pendingDrafts.clear()
    this.draftRunning = 0
    this.draftScheduled = 0
    this.draftWrite = Promise.resolve()
    if ((targetSnapshot || sampleOnly) && (!targetSnapshot || !this.deps.goalStore || !this.deps.enableVideoRounds)) {
      throw new Error('自定义寻找服务尚未就绪')
    }
    const batch = {
      targetSnapshot,
      sampleOnly,
      sampleKeys: [],
      ...(targetSnapshot ? { goalPoolSnapshot: this.deps.manager.get().candidates.filter(c => c.goalMatches?.some(match => match.id === targetSnapshot.id && match.version === targetSnapshot.version)).map(c => c.platformUserId) } : { goalPoolSnapshot: [] }),
      goalChecks: [],
      id: `batch_${Date.now().toString(36)}`,
      status: STATUS.RUNNING,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      config,
      ...(this.deps.enableVideoRounds ? { videoRounds: true } : {}),
      warnings: this.warningsOf(config),
      genderReadResults: [],
      candidateDecisions: [], classificationRetryCounts: null,
      crossVideoClassification: !targetSnapshot && this.deps.crossVideoClassification === true,
      intentPool: this.deps.retainIntentPool === true,
      classificationQueue: [], classificationDrain: false, classificationError: null,
      profileReadCircuit: null, profileDeferred: [],
      // 计数按真实含义命名：fetched=页面上读到的行数，added=本次入库的新评论，
      // existing=库里已有，usable=有交友意愿的评论，records=生成的候选记录，
      // filtered=被筛选挡下（排除+待核实），qualified=真正入批。
      progress: {
        videosFound: 0, videosEvaluated: 0, videosSkipped: 0, videosFailed: 0, videosLowComments: 0,
        commentsFetched: 0, commentsAdded: 0, commentsExisting: 0, commentsUsable: 0,
        classifyTargets: 0, candidatesSeen: 0, filtered: 0,
        qualified: targetSnapshot ? 0 : (current?.added || []).length, excluded: 0, pending: 0, poolExisting: 0,
        aiCalls: 0, tokens: 0, drafts: 0, draftFailed: 0, minutes: 0,
        // 兼容旧字段：历史上叫 commentsRead，含义是"本次新增评论数"。
        commentsRead: 0, commentBudgetUsed: 0, genderChecks: 0, genderFound: 0, genderMissing: 0, genderErrors: 0, genderUnavailable: 0, genderConflicts: 0, ageFound: 0, ageMissing: 0, ageErrors: 0, ageConflicts: 0,
      },
      // 各阶段耗时累计（毫秒）与采集结果分布，用于成本和性能复盘。
      perf: { collectMs: 0, classifyMs: 0, recordsMs: 0, filterMs: 0, draftMs: 0, videos: 0, avgVideoMs: 0 },
      // byCode 用 null 起步：storage.update 是 deepMerge，空对象 {} 不会覆盖上一批的 byCode
      // 键，导致采集结果跨批次累加（P2-17B.3 真实验收：4 个视频却显示 19 条采集结果）。
      diagnostics: { byCode: null, lastCode: '', lastLabel: '' },
      stopCode: null,
      queue: [],
      added: [],
      sourceRuns: [], sourceProgress: null, sourcePlanningPending: false,
      reason: '',
      error: null,
      draftError: null,
    }
    // 快照批次启动时池内已有的人：他们不占本批目标名额（目标 N 人 = N 个新面孔），
    // 但仍会参与评估与资料合并。本批内跨视频合并不受影响（用的是启动时快照）。
    this.poolSnapshotIds = new Set(((this.deps.manager.get().candidates) || [])
      .filter(c => !c.customOnly && (!batch.intentPool || !c.intentPoolOnly)).map(c => c.platformUserId).filter(Boolean))
    this.save(batch)
    return this.run(batch.id)
  }

  pause() {
    const batch = this.state
    if (!batch || batch.status !== STATUS.RUNNING) throw new Error('当前没有正在运行的批次')
    this.paused = true
    this.deps.cancelFavorites?.()
    return this.save({ status: STATUS.PAUSED, pausedAt: new Date().toISOString(), reason: '用户暂停', stopCode: 'USER_PAUSE' })
  }

  stop() {
    const batch = this.state
    if (!batch || (!ACTIVE.includes(batch.status) && !(batch.targetSnapshot && batch.status === STATUS.INTERRUPTED))) throw new Error('当前没有可停止的批次')
    this.stopping = true
    this.paused = false
    this.deps.cancelFavorites?.()
    return this.save({ status: STATUS.STOPPED, finishedAt: new Date().toISOString(), reason: '用户停止', stopCode: 'USER_STOP' })
  }

  async resume() {
    const batch = this.state
    if (!batch) throw new Error('没有可继续的批次')
    const oldVerificationFailure = batch.status === STATUS.FAILED && batch.stopCode === 'CHALLENGE'
    if (![STATUS.PAUSED, STATUS.INTERRUPTED].includes(batch.status) && !oldVerificationFailure) throw new Error('只有暂停或中断的批次可以继续')
    if (this.running) throw new Error('批次正在运行')
    const gate = await this.checkBatchGate()
    if (this.state?.id !== batch.id || this.state.status !== batch.status) return this.status()
    if (!gate.ok) { this.pauseForVerification(gate); return this.status() }
    this.paused = false
    this.stopping = false
    // 重启后恢复：进程内没有启动时快照，此时补一份（池内已有者不占名额的语义尽量延续）。
    if (!(this.poolSnapshotIds instanceof Set)) {
      this.poolSnapshotIds = new Set(((this.deps.manager.get().candidates) || [])
        .map(c => c.platformUserId).filter(Boolean))
    }
    this.genderChecks.clear()
    for (const row of batch.genderReadResults || []) {
      if (row.status === 'blocked') this.genderChecks.delete(row.platformUserId)
      else this.genderChecks.set(row.platformUserId, row)
    }
    const waiting = VERIFICATION_CODES.includes(batch.stopCode)
    const since = waiting ? Date.parse(batch.pausedAt || batch.finishedAt || '') : NaN
    const interrupted = (batch.queue || []).filter(item => VERIFICATION_CODES.includes(item.code))
    const progress = { ...batch.progress }
    if (oldVerificationFailure) {
      progress.videosEvaluated = Math.max(0, (progress.videosEvaluated || 0) - interrupted.length)
      progress.videosFailed = Math.max(0, (progress.videosFailed || 0) - interrupted.filter(item => item.status === 'failed').length)
    }
    this.save({ status: STATUS.RUNNING, resumedAt: new Date().toISOString(), finishedAt: null, phase: '', error: null, reason: '继续本批寻找', stopCode: null,
      verification: null, verificationWaitMs: (batch.verificationWaitMs || 0) + (Number.isFinite(since) ? Math.max(0, Date.now() - since) : 0), progress,
      sourcePlanningPending: batch.sourcePlanningPending || oldVerificationFailure && (batch.sourceRuns || []).some(run => run.kind === 'CHALLENGE'),
      queue: (batch.queue || []).map(item => VERIFICATION_CODES.includes(item.code) ? { ...item, status: 'pending', code: null, blockReason: null, error: null, failureStage: null } : item) })
    return this.run(batch.id)
  }

  async checkBatchGate() {
    try {
      if (this.deps.checkVerification) return await this.deps.checkVerification()
      if (this.deps.engine?.checkBatchVerification) return await this.deps.engine.checkBatchVerification()
      return { ok: true }
    } catch { return { ok: false, code: 'VERIFICATION_CHECK_UNAVAILABLE', reason: '暂时无法确认验证状态，请稍后点继续' } }
  }

  pauseForVerification(result, patch = {}) {
    this.paused = true
    const prior = this.state
    const since = VERIFICATION_CODES.includes(prior?.stopCode) ? prior.pausedAt || prior.finishedAt : null
    return this.save({ ...patch, status: STATUS.PAUSED, finishedAt: null, phase: '', pausedAt: since || new Date().toISOString(),
      reason: `${result.reason || '请手动完成安全验证'}；进度已保留，处理后点“继续”恢复本批`, error: result.reason || result.code, stopCode: result.code || 'CHALLENGE',
      verification: { source: result.source || '', windowId: result.windowId || null } })
  }

  async verifyOrPause(alive, patch = {}) {
    const gate = await this.checkBatchGate()
    if (!alive()) return false
    if (!gate.ok) { this.pauseForVerification(gate, patch); return false }
    return true
  }

  canContinue(batch) {
    if (!batch || ![STATUS.RUNNING].includes(batch.status)) return false
    return this.running && !this.paused && !this.stopping
  }

  budgetLeft(batch) {
    const p = batch.progress, b = batch.config.budgets
    const started = Date.parse(batch.startedAt || batch.createdAt)
    const minutes = Math.max(0, Math.floor((Date.now() - started - (batch.verificationWaitMs || 0)) / 60000))
    return {
      minutes, minutesLeft: b.maxMinutes - minutes,
      commentsLeft: b.maxComments - (batch.videoRounds ? p.commentBudgetUsed || 0 : p.commentsRead),
      videosLeft: b.maxVideos - (batch.crossVideoClassification ? batch.queue.filter(item => item.collectionVisited || item.status !== 'pending').length : p.videosEvaluated),
      aiLeft: b.maxAiCalls - p.aiCalls - (batch.videoRounds ? this.draftQueue.length + this.pendingDrafts.size : 0),
    }
  }

  async run(batchId) {
    if (this.running) return this.status()
    this.running = true
    const generation = ++this.generation
    try {
      const batch = this.state
      if (!batch || batch.id !== batchId) throw new Error('批次已变化')
      await this.loop(batch, generation)
      // 首句与视频采集重叠执行：收尾时等它们全部写回候选池，再做后续真实联系。
      await this.finishDrafts()
      // 批次正常结束才有后续联系；暂停/停止/失败一律不触发。
      const finished = this.state
      if (finished && finished.id === batchId && finished.status === STATUS.DONE && !finished.sampleOnly) {
        try { await this.deps.onBatchDone?.(finished) } catch { /* 自动联系失败不改写批次结果 */ }
      }
    } catch (error) {
      if (this.state && this.state.id === batchId) {
        this.save({ status: STATUS.FAILED, finishedAt: new Date().toISOString(), error: String(error?.message || error), reason: `批次失败：${error?.message || error}`, stopCode: 'ERROR' })
      }
    } finally {
      // 异常/暂停也要把已经发出的首句任务收尾，避免后台任务在批次结束后继续写状态。
      await this.finishDrafts().catch(() => {})
      this.running = false
    }
    return this.status()
  }

  async loop(batch, generation) {
    const deps = this.deps
    const alive = () => {
      const s = this.state
      return !this.stopping && !this.paused && s && s.id === batch.id && s.status === STATUS.RUNNING && generation === this.generation
    }

    // 1) 收集视频（可恢复：队列里已有的不重复收集）
    if (!await this.verifyOrPause(alive)) return
    if (!batch.queue.length || batch.sourcePlanningPending) {
      await this.planVideos(batch, alive)
      if (!alive()) return this.finishIfStopped(batch)
    }
    if (!alive()) return this.finishIfStopped(batch)

    // 2) 逐视频处理
    while (alive()) {
      if (!await this.verifyOrPause(alive)) return
      let batchNow = this.state
      const target = batchNow.config.target
      if ((batchNow.added || []).length >= target) {
        this.save({ status: STATUS.DONE, finishedAt: new Date().toISOString(), phase: '', reason: `已达到目标 ${target} 人`, stopCode: 'TARGET_REACHED' })
        return
      }
      if (batchNow.sampleOnly && batchNow.sampleKeys.length >= SAMPLE_LIMIT) {
        return this.save({ status: STATUS.DONE, finishedAt: new Date().toISOString(), reason: '人工标注样本已准备好', stopCode: 'LABEL_SAMPLES_READY' })
      }
      let budget = this.budgetLeft(batchNow)
      if (batchNow.crossVideoClassification && (batchNow.classificationQueue || []).length >= 20 && budget.aiLeft > 0 && budget.minutesLeft > 0) {
        await this.flushClassificationQueue(alive)
        if (!alive()) return this.finishIfStopped(batchNow)
        batchNow = this.state; budget = this.budgetLeft(batchNow)
      }
      const replayAvailable = batchNow.queue.some(item => (item.classificationReplay || item.collectionVisited) && ['pending','sampling'].includes(item.status))
      const collectionLimited = budget.commentsLeft <= 0 || budget.videosLeft <= 0
      if (batchNow.crossVideoClassification && collectionLimited && !replayAvailable && budget.aiLeft > 0 && budget.minutesLeft > 0 && (batchNow.classificationQueue || []).length) {
        this.save({ classificationDrain: true })
        await this.flushClassificationQueue(alive, true)
        continue
      }
      if (budget.minutesLeft <= 0) return this.stopByBudget(batchNow, '达到时间上限', 'BUDGET_TIME')
      if (budget.commentsLeft <= 0 && !replayAvailable) return this.stopByBudget(batchNow, '达到采集量上限', 'BUDGET_COMMENTS')
      if (budget.videosLeft <= 0 && !replayAvailable) return this.stopByBudget(batchNow, '达到视频处理上限', 'BUDGET_VIDEOS')
      if (!batchNow.targetSnapshot && budget.aiLeft <= 0 && !replayAvailable) return this.stopByBudget(batchNow, '达到模型调用上限', 'BUDGET_AI')

      // 批次结束条件：队列里没有 pending 了
      const next = (this.state.queue || []).find(item => ['pending', 'sampling'].includes(item.status) && (!collectionLimited || item.classificationReplay || item.collectionVisited))
      if (!next) {
        if (batchNow.crossVideoClassification && (batchNow.classificationQueue || []).length && budget.aiLeft > 0) {
          await this.flushClassificationQueue(alive, true)
          continue
        }
        if (batchNow.crossVideoClassification && batchNow.classificationDrain) this.save({ classificationDrain: false })
        if (batchNow.sampleOnly && batchNow.sampleKeys.length) {
          return this.save({ status: STATUS.DONE, finishedAt: new Date().toISOString(), reason: '本轮可读样本已采集', stopCode: 'LABEL_SAMPLES_READY' })
        }
        if (batchNow.videoRounds && await this.extendSearchQueue(batchNow, alive)) continue
        if (!alive()) return this.finishIfStopped(batchNow)
        const sourceFailure = (this.state.sourceRuns || []).find(run => !run.ok && run.sourceType !== 'favorites')
        if (!batchNow.queue.length && sourceFailure) {
          const detail = `${sourceFailure.query || '视频来源'}：${sourceFailure.kind || 'ERROR'}`
          return this.save({ status: STATUS.FAILED, finishedAt: new Date().toISOString(), phase: '',
            reason: `视频来源读取失败（${detail}），尚未完成候选筛选`, error: detail, stopCode: 'SOURCE_FAILED' })
        }
        const failedVideos = (this.state.queue || []).filter(item => item.status === 'failed')
        if (failedVideos.length && failedVideos.length === this.state.queue.length) {
          return this.save({ status: STATUS.FAILED, finishedAt: new Date().toISOString(), phase: '',
            reason: `评论读取失败：${failedVideos.length} 个视频均未读取成功（${failedVideos[0].code || 'ERROR'}），请查看错误详情`,
            error: failedVideos[0].error || failedVideos[0].reason || failedVideos[0].code, stopCode: 'COLLECTION_FAILED' })
        }
        // 收藏夹来源一个视频都没有：不是"候选不足"，是收藏夹还没同步——给出可执行的下一步。
        if (batchNow.config?.sources?.favorites && (this.state.progress?.videosFound || 0) === 0) {
          const favRun = (this.state.sourceRuns || []).find(r => r.sourceType === 'favorites')
          const sync = favRun?.events?.find(e => e?.sync)?.sync || null
          const detail = sync && sync.ok === false
            ? `收藏夹同步失败：${sync.reason || sync.code || '未知原因'}${sync.nextAction ? `（${sync.nextAction}）` : ''}`
            : '收藏夹里还没有已同步的收藏视频：请先在批次表单填写并保存收藏夹名称，再开始寻找'
          return this.save({ status: STATUS.DONE, finishedAt: new Date().toISOString(), reason: detail, stopCode: 'FAVORITES_EMPTY' })
        }
        if (batchNow.targetSnapshot && !batchNow.sampleOnly && budget.aiLeft <= 0) return this.stopByBudget(batchNow, '达到模型调用上限', 'BUDGET_AI')
        return this.save({ status: STATUS.DONE, finishedAt: new Date().toISOString(), phase: '', reason: `候选不足：队列已处理完，实际 ${(this.state.added || []).length} 人`, stopCode: 'QUEUE_EXHAUSTED' })
      }

      if (belowCommentMinimum(next.commentCount, batchNow.config.minVideoComments)) {
        this.patchQueueItem(next.videoId, { status: 'skipped', code: 'VIDEO_COMMENTS_BELOW_MIN', blockReason: 'VIDEO_COMMENTS_BELOW_MIN',
          reason: `视频总评论 ${normalizeVideoCommentCount(next.commentCount)} 条，少于本批门槛 ${batchNow.config.minVideoComments} 条，未打开采集`, ms: 0 })
        this.bumpProgress({ videosEvaluated: 1, videosSkipped: 1, videosLowComments: 1 })
        this.bumpDiagnostics('VIDEO_COMMENTS_BELOW_MIN')
        continue
      }
      // 取下一个视频：标记 sampling
      this.patchQueueItem(next.videoId, { status: 'sampling', collectionVisited: true, startedAt: new Date().toISOString() })
      if (batchNow.sampleOnly) await this.sampleVideo(batchNow, next, alive)
      else if (batchNow.videoRounds) await this.processVideoRounds(batchNow, next, alive)
      else await this.processVideo(batchNow, next, alive)
      if (this.state.status === STATUS.PAUSED && this.state.stopCode === 'PROFILE_CHECK_LIMIT') return
      const processed = this.state.queue.find(item => item.videoId === next.videoId)
      if (VERIFICATION_CODES.includes(processed?.code)) return this.pauseForVerification({ code: processed.code, reason: processed.error || '请在抖音窗口完成安全验证', source: processed.verificationSource || '' })
      if (['LOGIN_REQUIRED', 'WINDOW_CLOSED'].includes(processed?.code)) {
        return this.save({ status: STATUS.FAILED, finishedAt: new Date().toISOString(), phase: '',
          reason: `${processed.failureStage === 'profile_read' ? '主页核实' : '评论读取'}已停止：${processed.error || processed.code}，处理后重新开始`,
          error: processed.error || processed.code, stopCode: processed.code })
      }
      if (['READ_CANCELLED', 'READ_TARGET_MISMATCH'].includes(processed?.code)) {
        return this.save({ status: STATUS.PAUSED, phase: '', reason: '读取任务或目标页面发生变化，已暂停并保留进度；请查看读取现场后继续', error: processed.error, stopCode: processed.code })
      }
      const completed = this.state.queue.filter(item => ['failed', 'processed', 'skipped'].includes(item.status))
      const lastThree = completed.slice(-3)
      if (lastThree.length === 3 && lastThree.every(item => item.status === 'failed'
        && ['NETWORK_ERROR', 'TIMEOUT', 'COMMENTS_UNAVAILABLE', 'PANEL_NOT_LOADED'].includes(item.code))) {
        return this.save({ status: STATUS.PAUSED, finishedAt: null, phase: '',
          reason: '连续 3 个视频未能读取评论，已暂停；已保留进度，请查看逐视频诊断后点继续',
          error: processed.error || processed.code, stopCode: 'CONSECUTIVE_FAILURES' })
      }
      if (!alive()) return this.finishIfStopped(batchNow)
    }
    return this.finishIfStopped(this.state)
  }

  finishIfStopped(batch) {
    const s = this.state
    if (!s) return this.status()
    if (this.stopping) {
      if (s.status !== STATUS.STOPPED) this.save({ status: STATUS.STOPPED, finishedAt: new Date().toISOString(), reason: '用户停止', stopCode: 'USER_STOP' })
      return this.status()
    }
    if (this.paused) {
      if (s.status !== STATUS.PAUSED) this.save({ status: STATUS.PAUSED, reason: '用户暂停', stopCode: 'USER_PAUSE' })
      return this.status()
    }
    return this.status()
  }

  stopByBudget(batch, reason, stopCode = 'BUDGET') {
    this.save({ status: STATUS.DONE, finishedAt: new Date().toISOString(), phase: '', reason: `${reason}：已交付实际 ${(batch.added || []).length} 人，未放宽条件`, stopCode })
    return this.status()
  }

  patchQueueItem(videoId, patch) {
    const batch = this.state
    const queue = (batch.queue || []).map(item => item.videoId === videoId ? { ...item, ...patch } : item)
    this.save({ queue })
  }

  async planVideos(batch, alive) {
    const { manager, storage } = this.deps
    const config = batch.config
    const discovery = manager.get()
    const excluded = new Set([
      ...(discovery.batchExcluded || []).map(x => x.platformUserId),
      ...((storage.get().contacts || []).map(c => c.profile?.platformUserId).filter(Boolean)),
    ])
    const seen = new Set((batch.queue || []).map(item => item.videoId))
    const queue = []
    const sources = this.sourcesFactory(this.deps.engine)
    const sourceRuns = []
    const priorRuns = batch.sourceRuns || []
    const alreadyPlanned = (type, query) => priorRuns.some(run => run.sourceType === type && run.query === query && run.ok)
    const mergedRuns = () => [...priorRuns.filter(run => !sourceRuns.some(next => next.sourceType === run.sourceType && next.query === run.query)), ...sourceRuns]

    for (const keyword of keywordQueries(config.sources)) {
      if (!alive()) break
      if (alreadyPlanned('keyword', keyword)) continue
      if (!await this.verifyOrPause(alive, { queue: [...(batch.queue || []), ...queue], sourceRuns: mergedRuns(), sourcePlanningPending: true })) return
      this.save({ phase: `关键词：${keyword}` })
      let run
      try { run = await sources.collectByKeyword(keyword, { limit: 10, maxPages: 1 }) }
      catch (error) { run = { ok: false, kind: error?.code || 'ERROR', query: keyword, videos: [], events: [{ error: String(error?.message || error) }] } }
      sourceRuns.push({ sourceType: 'keyword', query: keyword, ok: run.ok, kind: run.kind, videos: run.videos.length, pages: run.pages, nextOffset: run.nextOffset, events: run.events })
      for (const video of run.videos || []) {
        if (seen.has(video.videoId)) continue
        seen.add(video.videoId)
        queue.push({ videoId: video.videoId, videoUrl: video.videoUrl, title: video.title, authorName: video.authorName,
          sourceType: 'keyword', query: keyword, commentCount: video.commentCount, status: 'pending' })
      }
      if (run.kind === 'CHALLENGE') {
        this.pauseForVerification({ code: 'CHALLENGE', source: '交友发现窗口', reason: '请在交友发现窗口手动完成安全验证' }, { queue: [...(batch.queue || []), ...queue], sourceRuns: mergedRuns(), sourcePlanningPending: true })
        return
      }
      await sleep(600)
    }

    for (const tag of config.sources.tags) {
      if (!alive()) break
      if (alreadyPlanned('hashtag', tag)) continue
      if (!await this.verifyOrPause(alive, { queue: [...(batch.queue || []), ...queue], sourceRuns: mergedRuns(), sourcePlanningPending: true })) return
      this.save({ phase: `标签：${tag}` })
      let run
      try { run = await sources.collectByTag(tag, { limit: 10, maxPages: 1 }) }
      catch (error) { run = { ok: false, kind: error?.code || 'ERROR', query: tag, videos: [], events: [{ error: String(error?.message || error) }] } }
      sourceRuns.push({ sourceType: 'hashtag', query: tag, ok: run.ok, kind: run.kind, videos: run.videos.length, pages: run.pages, nextOffset: run.nextOffset, topicId: run.topicId || null, events: run.events })
      for (const video of run.videos || []) {
        if (seen.has(video.videoId)) continue
        seen.add(video.videoId)
        queue.push({ videoId: video.videoId, videoUrl: video.videoUrl, title: video.title, authorName: video.authorName,
          sourceType: 'hashtag', query: tag, commentCount: video.commentCount, status: 'pending' })
      }
      if (run.kind === 'CHALLENGE') {
        this.pauseForVerification({ code: 'CHALLENGE', source: '交友发现窗口', reason: '请在交友发现窗口手动完成安全验证' }, { queue: [...(batch.queue || []), ...queue], sourceRuns: mergedRuns(), sourcePlanningPending: true })
        return
      }
      await sleep(600)
    }

    if (config.sources.favorites) {
      if (!await this.verifyOrPause(alive, { queue: [...(batch.queue || []), ...queue], sourceRuns: mergedRuns(), sourcePlanningPending: true })) return
      // 收藏夹来源就应该直接进用户的抖音收藏夹读：先调用现有同步服务增量同步（只读已登录页面
      // 可见作品、按作品 ID 去重入库），再读素材库里的收藏视频。同步失败不静默，记录来源事件。
      let syncEvent = null
      if (typeof this.deps.syncFavorites === 'function') {
        this.save({ phase: '同步收藏夹' })
        try { syncEvent = await this.deps.syncFavorites({ onProgress: progress => {
          if (!alive()) return
          const rawPhase = String(progress.phase || '同步收藏夹')
          const phase = rawPhase.startsWith('已识别 ') ? '正在收集收藏夹作品' : rawPhase
          if (this.state?.sourceProgress?.phase === phase) return
          this.save({ phase: '同步收藏夹 · ' + phase, sourceProgress: { phase, phaseStartedAt: progress.phaseStartedAt || progress.updatedAt, elapsedMs: progress.elapsedMs || 0, stageTimings: progress.stageTimings || [] } })
        } }) }
        catch (error) { syncEvent = { ok: false, code: 'SYNC_FAILED', reason: String(error?.message || error) } }
      }
      if (!alive()) return
      if (syncEvent?.code === 'CHALLENGE') {
        this.pauseForVerification({ code: 'CHALLENGE', source: '收藏夹窗口', reason: '请在收藏夹窗口手动完成安全验证' }, { queue: [...(batch.queue || []), ...queue], sourceRuns: mergedRuns(), sourcePlanningPending: true })
        return
      }
      const library = this.deps.libraryStore.read()
      const videos = (library.videos || []).filter(v => v.favoritesFolder || v.source === 'favorites')
      sourceRuns.push({ sourceType: 'favorites', ok: !syncEvent || syncEvent.ok !== false,
        kind: syncEvent?.ok === false ? (syncEvent.code || 'SYNC_FAILED') : 'OK',
        videos: videos.length, events: syncEvent ? [{ sync: syncEvent }] : [] })
      for (const video of videos) {
        const videoId = String(video.video_id || video.videoId || '')
        if (!/^\d{8,24}$/.test(videoId)) continue
        if (seen.has(videoId)) {
          if (batch.videoRounds) {
            const existing = queue.find(item => item.videoId === videoId)
            if (existing) Object.assign(existing, { sourceType: 'favorites', query: '收藏夹' })
          }
          continue
        }
        seen.add(videoId)
        queue.push({ videoId, videoUrl: `https://www.douyin.com/video/${videoId}`, title: video.title || null, authorName: null,
          sourceType: 'favorites', query: '收藏夹', commentCount: null, status: 'pending' })
      }
      // 同步失败但库里已有收藏视频：不静默降级，把"改用库内视频继续"写进警告，用户能看出本批不是最新收藏。
      if (syncEvent?.ok === false && videos.length) {
        this.save({ warnings: [...(this.state.warnings || []),
          `收藏夹同步未完成（${syncEvent.code || 'SYNC_FAILED'}）：${syncEvent.reason || ''}${syncEvent.nextAction ? '；' + syncEvent.nextAction : ''}。本批改用素材库已收藏的 ${videos.length} 个视频继续` ] })
      }
    }

    const prev = this.state
    this.save({ queue: [...(prev.queue || []), ...rankVideos(queue, config.sources)], sourceRuns: mergedRuns(), sourcePlanningPending: false,
      progress: { ...prev.progress, videosFound: (prev.queue || []).length + queue.length } })
  }

  async extendSearchQueue(batch, alive) {
    const seen = new Set(batch.queue.map(item => item.videoId))
    const sources = this.sourcesFactory(this.deps.engine)
    const runs = [...(batch.sourceRuns || [])]
    const latest = new Map()
    for (const run of runs) latest.set(JSON.stringify([run.sourceType, run.query]), run)
    for (const run of latest.values()) {
      if (!alive()) break
      if (!['keyword', 'hashtag'].includes(run.sourceType) || !run.ok || !Number.isSafeInteger(run.nextOffset)) continue
      const search = run.sourceType === 'keyword' ? sources.collectByKeyword.bind(sources) : sources.collectByTag.bind(sources)
      let page
      try { page = await search(run.query, { startOffset: run.nextOffset }) }
      catch (error) { page = { ok: false, kind: error?.code || 'ERROR', events: [{ error: String(error?.message || error) }], videos: [] } }
      const videos = (page.videos || []).filter(video => {
        if (seen.has(video.videoId)) return false
        seen.add(video.videoId)
        return true
      }).map(video => ({ ...video, sourceType: run.sourceType, query: run.query, status: 'pending' }))
      if (page.kind === 'CHALLENGE') {
        this.pauseForVerification({ code: 'CHALLENGE', source: '交友发现窗口', reason: '请在交友发现窗口完成安全验证' })
        return false
      }
      runs.push({
        sourceType: run.sourceType, query: run.query, ok: page.ok, kind: page.kind, videos: videos.length,
        pages: page.pages, events: page.events, nextOffset: page.nextOffset > run.nextOffset ? page.nextOffset : null,
      })
      const current = this.state
      const queue = [...current.queue.filter(item => item.status !== 'pending'), ...rankVideos([...current.queue.filter(item => item.status === 'pending'), ...videos], batch.config.sources)]
      this.save({ sourceRuns: runs, queue, progress: { ...current.progress, videosFound: queue.length } })
      return true
    }
    return false
  }

  skipAccount(platformUserId, reason) {
    const discovery = this.deps.manager.get()
    const list = Array.isArray(discovery.batchExcluded) ? discovery.batchExcluded : []
    if (!platformUserId || list.some(x => x.platformUserId === platformUserId)) return
    this.deps.manager.save({ ...discovery, batchExcluded: [...list, { platformUserId, reason, at: new Date().toISOString() }] })
  }

  // 采集没读成：记录分类码与原始错误，但不计入"视频无价值"。
  markCollectionFailed(item, diagnosis, { collectMs = 0, started = Date.now() } = {}) {
    this.patchQueueItem(item.videoId, {
      status: ['VIDEO_NOT_FOUND', 'COMMENTS_CLOSED', 'CONTENT_UNSUPPORTED', 'VIDEO_COMMENTS_BELOW_MIN'].includes(diagnosis.code) ? 'skipped' : 'failed', code: diagnosis.code, collectionCode: diagnosis.code,
      error: diagnosis.detail || diagnosis.reason, reason: diagnosis.reason,
      nextAction: diagnosis.nextAction, ms: Date.now() - started,
      stages: { code: diagnosis.code, judgeable: false, read: 0, existing: 0, fresh: 0,
        fetched: Number(diagnosis.fetched) || 0, classifyTargets: 0, friendly: null, total: null,
        records: null, filtered: null, added: 0, collectMs },
    })
    this.bumpProgress({ videosEvaluated: 1, ...(['VIDEO_NOT_FOUND', 'COMMENTS_CLOSED', 'CONTENT_UNSUPPORTED', 'VIDEO_COMMENTS_BELOW_MIN'].includes(diagnosis.code) ? { videosSkipped: 1 } : { videosFailed: 1 }) })
    this.bumpDiagnostics(diagnosis.code)
  }

  async processVideo(batch, item, alive) {
    const deps = this.deps
    const library = deps.libraryStore
    const before = new Set((library.read().comments || []).map(c => c.key))
    const started = Date.now()
    let result = null
    const collectStart = Date.now()
    try {
      result = await deps.collectorFactory().run({ videoId: item.videoId, videoUrl: item.videoUrl, title: item.title,
        limit: batch.config.budgets.sampleSize, maxPages: 2, minVideoComments: batch.config.minVideoComments || 0 })
    } catch (error) {
      result = { ok: false, code: 'NETWORK_ERROR', error: String(error?.message || error) }
    }
    const collectMs = Date.now() - collectStart
    // 暂停：当前视频已采完，继续走完再停；停止：立即中止不写候选。
    if (this.stopping) return

    // 采集失败：先按错误码归类。失败/未加载/验证页都不是"视频无价值"，不继续走价值门。
    if (!result?.ok) {
      if (VERIFICATION_CODES.includes(result?.code)) {
        this.patchQueueItem(item.videoId, { status: 'pending', code: result.code, error: result.reason || result.error || result.code, failureStage: 'comment_read', readDiagnostics: result.diagnostics || null })
        return
      }
      const diagnosis = classifyCollection(result)
      this.markCollectionFailed(item, diagnosis, { collectMs, started })
      if (diagnosis.code === 'VIDEO_COMMENTS_BELOW_MIN') this.bumpProgress({ videosLowComments: 1 })
      if (result?.diagnostics) this.patchQueueItem(item.videoId, { readDiagnostics: result.diagnostics })
      return
    }

    // 分阶段计数（P2-17B.1/P2-17B.2）：读取数/已有数/新增数分开记，"0 新增"不再等于"没有可用评论"。
    const libAfterCollect = library.read()
    const videoComments = (libAfterCollect.comments || []).filter(c => String(c.video_id || '') === item.videoId)
    const existing = videoComments.filter(c => before.has(c.key)).length
    const freshComments = videoComments.filter(c => !before.has(c.key))
    // 采集器返回 ok 但没有任何可读证据（评论区没加载出来）时，同样不能当成"没价值"。
    const diagnosis = classifyCollection(result, { added: freshComments.length, fetched: result.fetched, existing, emptySeen: result.empty })
    if (!diagnosis.judgeable) {
      this.markCollectionFailed(item, diagnosis, { collectMs, started })
      return
    }
    // 分类：本次新评论 + 本视频缺 intent 的旧评论。
    // 复跑同一视频（评论已采过、0 新增）时仍要补分类，否则价值恒为 0、视频被"试采价值不足"跳过。
    const classifyTargets = videoComments.filter(c => !c.classification?.intent)
    let classified = null
    const classifyStart = Date.now()
    if (classifyTargets.length && deps.classify) {
      try {
        classified = await deps.classify(classifyTargets.map(c => c.key), Math.min(3, batch.config.budgets.maxAiCalls - this.state.progress.aiCalls))
      } catch (error) { classified = { error: String(error?.message || error) } }
      if (this.stopping) return
    }
    const classifyMs = Date.now() - classifyStart

    const stages = { code: diagnosis.code, judgeable: true, read: videoComments.length, existing, fresh: freshComments.length,
      fetched: Number(result?.fetched) || 0, classifyTargets: classifyTargets.length,
      friendly: null, total: null, records: null, filtered: null, added: 0, collectMs, classifyMs }

    const lib = library.read()
    const comments = (lib.comments || []).filter(c => String(c.video_id || '') === item.videoId)
    const value = this.evaluateVideoValue(comments)
    const isFavorites = item.sourceType === 'favorites'
    stages.friendly = value.friendly
    stages.total = value.total

    // 确实没有评论：这不是"价值不足"，单独标记，避免把空评论区当成筛选结论。
    if (!comments.length) {
      this.patchQueueItem(item.videoId, { status: 'skipped', code: 'NO_COMMENTS', blockReason: 'NO_COMMENTS',
        reason: '该视频没有可读评论（评论区已确认暂无评论），不参与价值判断', ms: Date.now() - started, value, stages })
      this.bumpProgress({ videosEvaluated: 1, videosSkipped: 1, commentsFetched: stages.fetched, commentsAdded: freshComments.length,
        commentsExisting: existing, commentsUsable: 0, aiCalls: classified?.aiCalls || 0, tokens: classified?.tokens || 0 })
      this.bumpDiagnostics('NO_COMMENTS')
      return
    }

    // 关键词/标签：先试采，价值不足就不继续。收藏夹跳过视频价值判断。
    if (!isFavorites && value.friendly < batch.config.budgets.valueThreshold) {
      this.patchQueueItem(item.videoId, { status: 'skipped', code: 'LOW_VALUE', blockReason: 'LOW_VALUE',
        reason: `试采价值不足（交友意愿 ${value.friendly}/${value.total}，阈值 ${batch.config.budgets.valueThreshold}）`, ms: Date.now() - started, value, stages })
      this.bumpProgress({ videosEvaluated: 1, videosSkipped: 1, commentsFetched: stages.fetched, commentsAdded: freshComments.length,
        commentsExisting: existing, commentsUsable: value.friendly,
        aiCalls: classified?.aiCalls || 0, tokens: classified?.tokens || 0 })
      this.bumpDiagnostics(diagnosis.code)
      return
    }

    let processed
    try { processed = await this.addVideoCandidates(batch, item, lib, stages, null, () => !this.stopping) }
    catch (error) {
      if (VERIFICATION_CODES.includes(error.code)) {
        this.patchQueueItem(item.videoId, { status: 'pending', code: error.code, error: error.message, failureStage: 'profile_read', verificationSource: error.source || '' })
        return
      }
      this.patchQueueItem(item.videoId, { status: 'failed', code: error.code || 'CANDIDATE_BUILD_FAILED', blockReason: error.code || 'CANDIDATE_BUILD_FAILED',
        error: String(error?.message || error), ...(error.code === 'CHALLENGE' || error.code === 'LOGIN_REQUIRED' ? { failureStage: 'profile_read' } : {}),
        ms: Date.now() - started, stages })
      this.bumpProgress({ videosEvaluated: 1, videosFailed: 1 })
      this.bumpDiagnostics('CANDIDATE_BUILD_FAILED')
      return
    }
    const { qualified, excluded, pending, poolExisting, records, recordsMs, filterMs } = processed
    stages.totalMs = Date.now() - started

    this.patchQueueItem(item.videoId, { status: 'processed', ms: Date.now() - started, value, added: qualified, stages,
      code: diagnosis.code, blockReason: qualified ? null : (records.length ? 'FILTER_BLOCKED' : 'NO_RECORDS') })
    this.bumpProgress({ videosEvaluated: 1, commentsFetched: stages.fetched, commentsAdded: freshComments.length,
      commentsExisting: existing, commentsUsable: value.friendly, classifyTargets: classifyTargets.length,
      candidatesSeen: records.length, qualified: (this.state.added || []).length, excluded, pending, poolExisting,
      aiCalls: classified?.aiCalls || 0, tokens: classified?.tokens || 0 })
    this.bumpPerf({ collectMs, classifyMs, recordsMs, filterMs })
    this.bumpDiagnostics(diagnosis.code)
  }

  async addVideoCandidates(batch, item, lib, stages, sample = null, alive = () => !this.stopping, decisions = null) {
    const deps = this.deps
    // 生成候选记录（复用素材库→候选）
    const discovery = deps.manager.get()
    // 硬排除：不感兴趣/清空名单 + 已联系——记录直接不生成。
    // 池内已有（含往批待审核）不在这里排除：他们仍要参与评估与资料合并（来源/IP 刷新），
    // 只是合格后不占目标名额、不重复进卡片——"目标 N 人"指 N 个新面孔（P2-17B.3 真实验收发现）。
    const poolSnapshot = this.poolSnapshotIds instanceof Set ? this.poolSnapshotIds : new Set()
    const contactedIds = new Set((deps.storage.get().contacts || []).map(c => c.profile?.platformUserId).filter(Boolean))
    const existingIds = decisions ? new Set(discovery.candidates.map(c => c.platformUserId)) : null
    const excludedIds = new Set([
      ...(discovery.batchExcluded || []).map(x => x.platformUserId),
      ...[...contactedIds].filter(id => !existingIds?.has(id)),
    ])
    let records = []
    const recordsStart = Date.now()
    try {
      const built = this.buildRecords(lib, { excludePlatformUserIds: [...excludedIds], ...(decisions ? { goalDecisions: decisions, goal: batch.targetSnapshot } : {}) })
      // candidateRecords 产出的是 source（单数）；CandidateManager 合并存储后才有 sources 数组。两处都要认，
      // 否则记录恒为 0——这是真实批次零候选的主根因（P2-17B.1）。
      records = (built.records || [])
        .filter(r => !excludedIds.has(r.platformUserId) && (!sample || sample.get(r.platformUserId) === r._libraryKey))
        .filter(r => [r.source, ...(r.sources || [])].filter(Boolean).some(s => String(s.videoId || '') === item.videoId))
    } catch (error) {
      throw Object.assign(error, { code: 'CANDIDATE_BUILD_FAILED' })
    }
    if (batch.intentPool && records.length) deps.manager.upsert(records.map(({ _libraryKey, ...record }) => ({ ...record, intentPoolOnly: true })), { accountId: deps.accountId })
    const recordsMs = Date.now() - recordsStart
    stages.records = records.length

    let qualified = 0, excluded = 0, pending = 0, poolExisting = 0
    const filterStart = Date.now()
    const filterCounts = {}
    const existingProfiles = new Map(discovery.candidates.map(candidate => [candidate.platformUserId, candidate]))
    const byAuthor = new Map(records.map(record => [record.platformUserId, record]))
    const entries = sample ? [...sample.keys()].map(author => [author, byAuthor.get(author)]) : records.map(record => [record.platformUserId, record])
    const consumed = []
    for (const [author, record] of entries) {
      // Cached candidates can otherwise run synchronously for an entire round.
      // Let stop/pause IPC through before starting another person's work.
      await new Promise(resolve => setImmediate(resolve))
      if (!alive()) break
      if ((this.state.added || []).length >= batch.config.target) break
      if (!record) { consumed.push(author); continue }
      const isPoolKnown = decisions ? batch.goalPoolSnapshot.includes(record.platformUserId) : poolSnapshot.has(record.platformUserId)
      const commentSource = [record.source, ...(record.sources || [])].find(source => source?.videoId === item.videoId)
      const existing = existingProfiles.get(author)
      let payload = record
      if (existing) {
        payload = { ...record, publicProfile: existing.publicProfile, publicSignals: existing.publicSignals, review: existing.review }
        payload.profileFacts = buildProfileFacts({ ...payload, sources: [...existing.sources, commentSource].filter(Boolean) })
      }
      let evaluation = evaluateBatchCandidate(payload, batch.config.filters, commentSource, decisions ? record.goalMatch : null)
      const profileReasons = { GENDER_UNVERIFIED: 'gender', AGE_UNVERIFIED: 'age' }
      const requiredFields = [...new Set(evaluation.pendingReasons.map(reason => profileReasons[reason]).filter(Boolean))]
      const canCheckGender = evaluation.status === 'pending' && requiredFields.length > 0
        && evaluation.pendingReasons.every(reason => profileReasons[reason]) && !isPoolKnown && this.deps.engine?.readBatchGender
        && !this.state.profileReadCircuit?.disabled
      if (canCheckGender) {
        let check = this.genderChecks.get(author)
        const authorAttempts = Number(check?.readAttempts) || 0
        if (check?.status === 'failed' && check.retryable === true && authorAttempts < 2 && Date.now() >= (check.nextRetryAt || 0)) check = null
        const attempts = Number(this.state.progress?.genderChecks) || 0
        if (!check && attempts >= (batch.config.maxProfileChecks ?? Math.min(60, batch.config.target * 2))) {
          this.recordDecision(record, { ...evaluation, reasons: [...evaluation.reasons, 'PROFILE_CHECK_LIMIT'] })
          this.flushDecisions()
          throw Object.assign(new Error('本批主页核验额度已用完，已暂停；可调整下一批核验上限后重新开始，未核实对象不算不符合'), {
            code: 'PROFILE_CHECK_LIMIT', partialCandidates: { qualified, excluded, pending, poolExisting, records, recordsMs, filterMs: Date.now() - filterStart, consumed: [...consumed] },
          })
        }
        if (!check && attempts < (batch.config.maxProfileChecks ?? Math.min(60, batch.config.target * 2)) && this.budgetLeft(this.state).minutesLeft > 0) {
          this.bumpProgress({ genderChecks: attempts + 1 })
          try {
            const gate = await this.checkBatchGate()
            if (!alive()) break
            check = gate.ok ? await this.deps.engine.readBatchGender(record, alive, { requiredFields }) : { status: 'blocked', ...gate, retryable: false }
          }
          catch (error) {
            if (error?.blocked) check = { status: 'blocked', code: error.code || 'CHALLENGE', reason: String(error.message || error), retryable: false }
            else check = { status: 'failed', code: error.code || 'PROFILE_READ_ERROR', reason: String(error.message || error).slice(0,220), retryable: true }
          }
          if (!alive()) break
          if (check?.status === 'cancelled') throw Object.assign(new Error(check.reason || '主页核验任务已切换'), { code: 'READ_CANCELLED' })
          if (check) {
            check = { ...check, requestedFields: check.requestedFields || requiredFields, readAttempts: authorAttempts + 1, nextRetryAt: check.status === 'failed' && check.retryable ? Date.now() + 30000 : null }
            this.genderChecks.set(author, check)
            const row = { platformUserId: author, nickname: record.nickname, profileUrl: record.profileUrl, status: check.status,
              sourceVideoId: item.videoId, sourceCommentId: commentSource?.commentId || '', sourceCommentText: String(commentSource?.commentText || '').slice(0,1000),
              code: check.code || ({ found: 'PROFILE_GENDER_FOUND', not_present: 'PROFILE_GENDER_NOT_PUBLIC', conflict: 'PROFILE_GENDER_CONFLICT' }[check.status] || 'PROFILE_READ_ERROR'),
              reason: check.reason || ({ found: '读到公开性别字段', not_present: '公开资料未显示性别', conflict: '公开字段存在冲突' }[check.status] || '主页读取失败'),
              source: check.source || '', retryable: check.retryable === true, readAttempts: check.readAttempts, nextRetryAt: check.nextRetryAt, at: new Date().toISOString(),
              requestedFields: check.requestedFields, fieldStatuses: check.fieldStatuses,
              ...(check.publicSignals ? { publicSignals: check.publicSignals } : {}), diagnostics: check.diagnostics || null }
            this.save({ genderReadResults: [...(this.state.genderReadResults || []), row].slice(-60) })
          }
          this.observeProfileAccess(author, check)
          if (check?.status === 'blocked') {
            this.flushDecisions()
            throw Object.assign(new Error(check.reason || '主页核实需要登录或安全验证，请处理后继续'), { code: check.code, source: check.source || '', windowId: check.windowId || null,
              partialCandidates: { qualified, excluded, pending, poolExisting, records, recordsMs, filterMs: Date.now() - filterStart, consumed: [...consumed] } })
          }
          if (check) {
            for (const field of requiredFields) {
              const value = check.fieldStatuses?.[field] || (field === 'gender' ? check.status : Number.isSafeInteger(check.publicSignals?.age) ? 'found' : ['failed','blocked'].includes(check.status) ? 'failed' : 'not_present')
              const resultField = field + ({ found: 'Found', not_present: 'Missing', conflict: 'Conflicts' }[value] || 'Errors')
              this.bumpProgress({ [resultField]: (this.state.progress[resultField] || 0) + 1 })
            }
            if (check.code === 'PROFILE_UNAVAILABLE') this.bumpProgress({ genderUnavailable: (this.state.progress.genderUnavailable || 0) + 1 })
          }
        }
        if (check?.publicSignals && ['found', 'not_present', 'conflict'].includes(check.status)) {
          payload = { ...payload, publicProfile: check.publicProfile, publicSignals: { ...payload.publicSignals, ...check.publicSignals } }
          payload.profileFacts = buildProfileFacts({ ...payload, sources: [...(existing?.sources || []), commentSource].filter(Boolean) })
          evaluation = evaluateBatchCandidate(payload, batch.config.filters, commentSource, decisions ? record.goalMatch : null)
        }
      }
      if (batch.intentPool) {
        const saved = deps.manager.get().candidates.find(c => c.platformUserId === author)
        if (saved) deps.manager.patch(saved.id, {
          ...(payload.publicSignals ? { publicSignals: payload.publicSignals } : {}),
          ...(payload.publicProfile ? { publicProfile: payload.publicProfile } : {}),
          intentPoolOnly: evaluation.status !== 'qualified',
          batchScreening: { status: evaluation.status, reasons: evaluation.reasons, filters: batch.config.filters, batchId: batch.id, at: new Date().toISOString() },
        })
      }
      this.recordDecision(record, evaluation)
      this.deferProfile(record, payload, evaluation, commentSource)
      consumed.push(author)
      if (evaluation.status !== 'qualified') {
        if (evaluation.status === 'excluded') excluded++
        else pending++
        for (const reason of evaluation.reasons || []) filterCounts[reason] = (filterCounts[reason] || 0) + 1
        continue
      }
      payload = { ...payload, batchId: batch.id }
      delete payload._libraryKey
      // 池内已有人也 upsert：新评论/新来源会合并进现有候选（资料刷新），这是有价值的副作用。
      const saved = deps.manager.upsert([payload], { accountId: deps.accountId })
      const candidate = (saved.discovery.candidates || []).find(c => c.platformUserId === record.platformUserId)
      if (!candidate) { pending++; filterCounts.CANDIDATE_SAVE_FAILED = (filterCounts.CANDIDATE_SAVE_FAILED || 0) + 1; continue }
      const addedList = this.state.added || []
      const realContact = candidate.review?.realContact
      const alreadyContacted = decisions && (contactedIds.has(author) || realContact?.messageStatus === 'sent'
        || realContact?.needsReview || candidate.action?.firstMessageStatus === 'sent' || candidate.action?.needsReview)
      if (isPoolKnown || alreadyContacted) {
        // 已在池里：资料已合并更新，但不算"新找到的人"，也不重复进本批卡片。
        poolExisting++
        continue
      }
      if (!addedList.some(x => x.candidateId === candidate.id)) {
        const entry = { candidateId: candidate.id, platformUserId: candidate.platformUserId, nickname: candidate.nickname,
          videoId: item.videoId, sourceType: item.sourceType, commentSource, ...(record.goalMatch ? { goalMatch: record.goalMatch, goalSource: commentSource } : {}), replyCount: evaluation.facts.replyCount, intentClass: evaluation.intentClass, addedAt: new Date().toISOString() }
        this.save({ added: [...addedList, entry] })
        qualified++
        // 首句生成在后台执行，批次收尾时统一等待。
        this.scheduleDraft(candidate, batch, entry)
      }
      if (this.stopping) break
    }
    this.flushDecisions()
    const filterMs = Date.now() - filterStart
    stages.filtered = excluded + pending
    stages.added = qualified
    stages.poolExisting = poolExisting
    stages.filterCounts = filterCounts
    stages.recordsMs = recordsMs
    stages.filterMs = filterMs
    return { qualified, excluded, pending, poolExisting, records, recordsMs, filterMs, consumed }


  }

  async sampleVideo(batch, item, alive) {
    const { libraryStore, collectorFactory, goalStore } = this.deps
    const identities = new Set(batch.sampleKeys)
    const previousSamples = goalStore.sampledKeys(batch.targetSnapshot)
    const collectSamples = () => {
      const library = libraryStore.read()
      const video = (library.videos || []).find(row => String(row.video_id) === item.videoId) || item
      return (library.comments || []).filter(row => String(row.video_id) === item.videoId && !identities.has(row.key) && !previousSamples.has(row.key))
        .slice(0, SAMPLE_LIMIT - identities.size).map(row => commentSample(row, video))
    }
    let samples = collectSamples(), result = { ok: true }
    if (samples.length < SAMPLE_LIMIT - identities.size && alive()) {
      try {
        const reader = createVideoReader(collectorFactory(), libraryStore, item, { timeoutMs: this.deps.videoReadTimeoutMs || 45000 })
        result = await reader({ limit: Math.min(SAMPLE_LIMIT - identities.size - samples.length, this.budgetLeft(this.state).commentsLeft), alive })
      } catch (error) { result = { ok: false, code: error.code || 'NETWORK_ERROR', reason: error.message } }
      samples = collectSamples()
    }
    if (!alive()) return
    if (samples.length) {
      goalStore.recordSamples(batch.targetSnapshot, samples)
      this.save({ sampleKeys: [...identities, ...samples.map(sample => sample.key)] })
    }
    this.bumpProgress({ videosEvaluated: 1, commentsFetched: result.fetched || 0, commentsAdded: result.added || 0,
      commentBudgetUsed: (this.state.progress.commentBudgetUsed || 0) + (result.read || 0) })
    this.patchQueueItem(item.videoId, { status: result.ok ? 'processed' : 'failed', code: result.code, error: result.reason })
  }

  recordDecision(record, evaluation) {
    const row = { platformUserId: record.platformUserId, nickname: record.nickname, intent: record.libraryIntent,
      status: evaluation.status, reasons: evaluation.reasons, facts: evaluation.facts, evidence: evaluation.evidence, at: new Date().toISOString() }
    this.decisionBuffer ||= []; this.decisionBuffer.push(row)
  }
  flushDecisions() {
    if (!this.decisionBuffer?.length) return
    const rows = this.decisionBuffer; this.decisionBuffer = []
    const deferred = new Map((this.state.profileDeferred || []).map(row => [row.platformUserId, row]))
    for (const row of this.deferredProfileBuffer || []) deferred.set(row.platformUserId, row)
    this.deferredProfileBuffer = []
    this.save({ candidateDecisions: [...(this.state.candidateDecisions || []), ...rows].slice(-200), profileDeferred: [...deferred.values()].slice(-2000) })
  }

  videoProgressKey(item, config = this.state?.config) {
    if (!config?.sampling) return item.videoId // Legacy paused batches keep their old checkpoints.
    return 'v2:' + createHash('sha256').update(JSON.stringify([config.sampling,config.filters])).digest('hex').slice(0,16) + ':' + item.videoId
  }

  classificationStamp(item, library = this.deps.libraryStore.read()) {
    return createHash('sha256').update(JSON.stringify((library.comments || [])
      .filter(c => String(c.video_id) === item.videoId).map(c => [c.key,c.classification?.intent,c.classification?.reviewedByUser === true]))).digest('hex')
  }

  videoProgress(item, target) {
    if (target) return this.deps.goalStore.video(target, item.videoId)
    const value = this.deps.manager.get().videoRoundProgress?.[this.videoProgressKey(item)] || {}
    if (this.state?.config?.sampling && value.batchId !== this.state?.id && value.classificationStamp && value.classificationStamp !== this.classificationStamp(item)) return {}
    return value
  }

  saveVideoProgress(item, progress, library, batch = this.state) {
    if (batch?.targetSnapshot) return this.deps.goalStore.saveVideo(batch.targetSnapshot, item.videoId, progress)
    const key = this.videoProgressKey(item, batch?.config)
    const record = { ...progress, batchId: batch?.id, classificationStamp: this.classificationStamp(item, library) }
    const signature = JSON.stringify(record)
    if (this.lastVideoCheckpoint?.key === key && this.lastVideoCheckpoint.signature === signature) return
    const manager = this.deps.manager, discovery = manager.get()
    manager.save({ ...discovery, videoRoundProgress: { ...discovery.videoRoundProgress, [key]: record } })
    this.lastVideoCheckpoint = { key, signature }
  }

  async processVideoRounds(batch, item, alive) {
    const { libraryStore: library, collectorFactory, classify } = this.deps
    const favorites = item.sourceType === 'favorites'
    const target = batch.targetSnapshot
    const prior = this.videoProgress(item, target)
    const seen = new Set(prior.authors || [])
    const commentKeys = new Set(prior.commentKeys || [])
    const sampling = batch.config.sampling
    let round = prior.round || 0
    let count = prior.count || 0
    let interested = prior.interested || 0
    let page = prior.page || 0
    let exhausted = prior.status === 'exhausted' || item.collectionExhausted === true
    let status = prior.status === 'pass' ? 'pass' : 'open'
    if (favorites && status === 'pass' && count === roundLimits(round, sampling).size) {
      round += 1
      count = 0
      interested = 0
    }
    let code = exhausted && !item.classificationReplay ? 'COMMENTS_EXHAUSTED' : status === 'pass' && !favorites ? 'VIDEO_PASS' : null
    let totalAdded = 0, readTotal = 0, addedTotal = 0, collectMs = 0, classifyMs = 0
    const started = Date.now()
    let read
    let checkpointLibrary
    const checkpoint = () => {
      checkpointLibrary ||= library.read()
      this.saveVideoProgress(item, { authors: [...seen], commentKeys: [...commentKeys], round, count, interested, status, page }, checkpointLibrary, batch)
    }
    const targetMet = () => this.state.added.length >= batch.config.target
    const remaining = () => this.budgetLeft(this.state)
    const hasTime = () => remaining().minutesLeft > 0
    let classificationStalled = false, collectionStopped = item.collectionStopped || null
    while (!code && alive() && !targetMet() && hasTime()) {
      const limits = roundLimits(round, sampling)
      const lib = library.read()
      checkpointLibrary = lib
      const byAuthor = new Map(), comments = [], selectedKeys = new Set()
      for (const comment of lib.comments || []) {
        const author = comment.author_id
        if (String(comment.video_id) !== item.videoId) continue
        if (sampling ? !comment.key || commentKeys.has(comment.key) || selectedKeys.has(comment.key) : !author || seen.has(author) || byAuthor.has(author)) continue
        comments.push(comment); selectedKeys.add(comment.key)
        if (author && (!byAuthor.has(author) || (INTENT_LEVELS[comment.classification?.intent] || 0) > (INTENT_LEVELS[byAuthor.get(author).classification?.intent] || 0))) byAuthor.set(author, comment)
        if (comments.length >= limits.size - count) break
      }
      if (comments.length) {
        const video = target && (lib.videos || []).find(row => String(row.video_id) === item.videoId)
        const samples = target ? comments.map(comment => commentSample(comment, video || item)) : []
        const decisions = target ? this.deps.goalStore.decisions(target, samples) : null
        const hasDecision = comment => target ? decisions.has(comment.key) : Boolean(comment.classification?.intent && !retryableClassification(comment))
        const countsAsInterested = comment => target ? decisions.get(comment?.key)?.label === 'match' : isInterested(comment, sampling?.continueMinIntent)
        const attempts = this.state.classificationRetryCounts || {}
        const missing = comments.filter(comment => !hasDecision(comment))
        const retryTargets = missing.filter(comment => (attempts[comment.key] || 0) < 2)
        if (!target && batch.crossVideoClassification && retryTargets.length && classify && remaining().aiLeft > 0) {
          this.enqueueClassification(retryTargets, item)
          if (await this.flushClassificationQueue(alive)) continue
        }
        if ((target || !batch.crossVideoClassification) && retryTargets.length && !classificationStalled && (target || classify) && remaining().aiLeft > 0) {
          let result
          const classifyStarted = Date.now()
          const size = target ? 12 : retryTargets.some(c => (attempts[c.key] || 0) > 0) ? 12 : 50
          const requested = retryTargets.slice(0, size)
          const nextAttempts = { ...attempts }; for (const c of requested) nextAttempts[c.key] = (nextAttempts[c.key] || 0) + 1
          this.save({ classificationRetryCounts: nextAttempts })
          const pendingSamples = samples.filter(sample => requested.some(comment => comment.key === sample.key))
          try { result = target ? await this.deps.goalStore.classify(target, pendingSamples, this.deps.ai) : await classify(requested.map(comment => comment.key), 1) }
          catch { classificationStalled = true; continue }
          classifyMs += Date.now() - classifyStarted
          this.bumpProgress({ aiCalls: result?.aiCalls || 0, tokens: result?.tokens || 0, classifyTargets: requested.length })
          const keys = new Set(requested.map(comment => comment.key))
          classificationStalled = target ? !this.deps.goalStore.decisions(target, pendingSamples).size : !(library.read().comments || []).some(comment => keys.has(comment.key) && comment.classification?.intent && !retryableClassification(comment)) && requested.every(c => nextAttempts[c.key] >= 2)
          continue
        }
        const judged = comments.filter(hasDecision)
        if (judged.length) {
          if (target) this.deps.goalStore.recordHumanDecisions(target, samples, decisions)
          const stages = {}
          let result
          try { result = await this.addVideoCandidates(batch, item, lib, stages, new Map([...judged.reduce((selected,c) => { const old = selected.get(c.author_id); if (c.author_id && (!old || (target ? ({ match: 3, check: 2, reject: 1 })[decisions.get(c.key)?.label] : INTENT_LEVELS[c.classification.intent] || 0) > (target ? ({ match: 3, check: 2, reject: 1 })[decisions.get(old.key)?.label] : INTENT_LEVELS[old.classification.intent] || 0))) selected.set(c.author_id,c); return selected },new Map())].map(([author,c]) => [author,c.key])), alive, decisions) }
          catch (error) {
            if (![...VERIFICATION_CODES, 'LOGIN_REQUIRED', 'PROFILE_CHECK_LIMIT', 'READ_TARGET_MISMATCH'].includes(error.code)) throw error
            code = error.code
            this.patchQueueItem(item.videoId, { error: error.message, failureStage: 'profile_read', verificationSource: error.source || '' })
            result = error.partialCandidates || { consumed: [], qualified: 0, records: [], excluded: 0, pending: 0 }
          }
          if (target) {
            const checks = new Map((this.state.goalChecks || []).map(row => [row.key, row]))
            for (const author of result.consumed) {
              const comment = byAuthor.get(author)
              const decision = comment && decisions.get(comment.key)
              if (decision?.label === 'check') checks.set(comment.key, {
                key: comment.key, text: comment.text, videoId: item.videoId, videoTitle: video?.title || item.title,
                reason: decision.reason, evidence: decision.evidence,
              })
            }
            if (checks.size) this.save({ goalChecks: [...checks.values()].slice(-100) })
          }
          const consumed = new Set(result.consumed)
          const processed = sampling ? judged.filter(c => !c.author_id || consumed.has(c.author_id)) : result.consumed.map(author => byAuthor.get(author))
          for (const comment of processed) {
            if (sampling) commentKeys.add(comment.key)
            count += 1
            if (countsAsInterested(comment)) interested += 1
          }
          for (const author of result.consumed) seen.add(author)
          totalAdded += result.qualified
          this.bumpProgress({ commentsUsable: processed.filter(countsAsInterested).length,
            candidatesSeen: result.records.length, qualified: this.state.added.length, excluded: result.excluded, pending: result.pending })
          if (count === limits.size) {
            if (!favorites && interested < limits.minimum) {
              status = 'pass'
              code = 'VIDEO_PASS'
            } else {
              round += 1
              count = 0
              interested = 0
            }
          }
          checkpoint()
          if (code || targetMet()) break
          await new Promise(resolve => setImmediate(resolve))
          continue
        }
        code = batch.crossVideoClassification && retryTargets.length && remaining().aiLeft > 0 ? 'CLASSIFICATION_WAITING' : 'CLASSIFICATION_PENDING'
        break
      }

      if (this.state.classificationDrain) { code = 'CLASSIFICATION_DRAINED'; break }
      if (exhausted) { status = 'exhausted'; code = 'COMMENTS_EXHAUSTED'; break }
      if (collectionStopped) { code = collectionStopped; break }
      if (remaining().commentsLeft <= 0 || remaining().aiLeft <= 0 || classificationStalled) break
      let result
      const collectStarted = Date.now()
      const gate = await this.checkBatchGate()
      if (!alive()) break
      if (!gate.ok) {
        code = gate.code
        this.patchQueueItem(item.videoId, { error: gate.reason, failureStage: 'comment_read', verificationSource: gate.source || '' })
        break
      }
      try {
        read ||= createVideoReader(collectorFactory(), library, item, { startPage: page, timeoutMs: this.deps.videoReadTimeoutMs || 45000, minVideoComments: batch.config.minVideoComments || 0 })
        result = await read({ limit: Math.min(limits.size - count, remaining().commentsLeft), alive: () => alive() && hasTime() })
      } catch (error) {
        code = error?.code || 'NETWORK_ERROR'
        this.patchQueueItem(item.videoId, { error: String(error?.message || error).slice(0, 300), failureStage: 'comment_read' })
        break
      }
      this.deps.observeComments?.()
      checkpointLibrary = null // The collector may have added or refreshed comments.
      page = result.page ?? page
      collectMs += Date.now() - collectStarted
      readTotal += result.fetched || result.read || 0
      addedTotal += result.added || 0
      this.bumpProgress({ commentsAdded: result.added || 0, commentsFetched: result.fetched || result.read || 0,
        commentBudgetUsed: (this.state.progress.commentBudgetUsed || 0) + (result.read || 0) })
      checkpoint()
      if (!result.ok) {
        code = result.code || 'NETWORK_ERROR'
        this.patchQueueItem(item.videoId, { error: String(result.reason || result.error || code).slice(0, 300), failureStage: 'comment_read', readDiagnostics: result.diagnostics || null })
        break
      }
      exhausted = result.exhausted === true
      if (result.stalled || !result.read && !exhausted && alive() && hasTime()) collectionStopped = 'COMMENTS_STALLED'
    }

    checkpoint()
    if (!code && !alive()) return
    if (code === 'CLASSIFICATION_WAITING') {
      this.patchQueueItem(item.videoId, { status: 'awaiting_classification', code, classificationReplay: false,
        collectionExhausted: exhausted, collectionStopped, added: (item.added || 0) + totalAdded })
      this.bumpPerf({ collectMs, classifyMs }, false)
      return
    }
    if (code === 'PROFILE_CHECK_LIMIT') {
      this.patchQueueItem(item.videoId, { status: 'pending', code, failureStage: 'profile_read' })
      this.save({ status: STATUS.PAUSED, stopCode: code, phase: '', reason: '主页核验额度已用完；保留待核实对象并暂停，调整下一批上限后重新开始' })
      return
    }
    if (VERIFICATION_CODES.includes(code)) {
      this.patchQueueItem(item.videoId, { status: 'pending', code, blockReason: code, added: totalAdded, ms: Date.now() - started })
      this.bumpDiagnostics(code)
      this.bumpPerf({ collectMs, classifyMs })
      return
    }
    const skipped = ['VIDEO_PASS', 'COMMENTS_EXHAUSTED', 'VIDEO_NOT_FOUND', 'COMMENTS_CLOSED', 'CONTENT_UNSUPPORTED', 'VIDEO_COMMENTS_BELOW_MIN'].includes(code)
    const failed = code && !skipped && !['CLASSIFICATION_PENDING','COMMENTS_STALLED','CLASSIFICATION_DRAINED'].includes(code)
    this.patchQueueItem(item.videoId, { status: failed ? 'failed' : skipped ? 'skipped' : 'processed',
      code, blockReason: code, classificationReplay: false, added: (item.added || 0) + totalAdded, ms: Date.now() - started,
      stages: { added: totalAdded, round: round + 1, read: count, friendly: interested, total: count, fetched: readTotal, fresh: addedTotal, collectMs, classifyMs } })
    this.bumpProgress({ videosEvaluated: 1, videosSkipped: skipped ? 1 : 0, videosFailed: failed ? 1 : 0, videosLowComments: code === 'VIDEO_COMMENTS_BELOW_MIN' ? 1 : 0 })
    if (code) this.bumpDiagnostics(code)
    this.bumpPerf({ collectMs, classifyMs })
  }

  evaluateVideoValue(comments) {
    const list = Array.isArray(comments) ? comments : []
    let friendly = 0
    for (const c of list) {
      const intent = c?.classification?.intent
      if (intent === 'SEEKING_FRIENDS' || intent === 'EXPLICIT_INVITATION' || intent === 'CONTEXTUAL_INTEREST') friendly++
    }
    return { total: list.length, friendly }
  }

  bumpProgress(patch) {
    const batch = this.state
    if (!batch) return
    const progress = { ...batch.progress }
    const additive = ['aiCalls', 'tokens', 'drafts', 'commentsFetched', 'commentsAdded', 'commentsExisting',
      'commentsUsable', 'classifyTargets', 'videosEvaluated', 'videosSkipped', 'videosLowComments', 'videosFailed', 'candidatesSeen', 'filtered']
    for (const [key, value] of Object.entries(patch || {})) {
      if (key === 'qualified') progress.qualified = value
      else if (['excluded', 'pending'].includes(key)) progress[key] = (progress[key] || 0) + value
      else if (additive.includes(key)) progress[key] = (progress[key] || 0) + value
      else progress[key] = value
    }
    // 旧字段跟随新字段，避免老界面/老报告读到 0。
    progress.commentsRead = progress.commentsAdded || 0
    progress.filtered = (progress.excluded || 0) + (progress.pending || 0)
    const started = Date.parse(batch.startedAt || batch.createdAt)
    progress.minutes = Math.max(0, Math.floor((Date.now() - started - (batch.verificationWaitMs || 0)) / 60000))
    this.save({ progress })
  }

  bumpPerf(patch, completed = true) {
    const batch = this.state
    if (!batch) return
    const perf = { ...(batch.perf || {}) }
    for (const [key, value] of Object.entries(patch || {})) perf[key] = (perf[key] || 0) + (Number(value) || 0)
    perf.videos = (perf.videos || 0) + (completed ? 1 : 0)
    if (perf.videos) perf.avgVideoMs = Math.round(((perf.collectMs || 0) + (perf.classifyMs || 0) + (perf.recordsMs || 0) + (perf.filterMs || 0)) / perf.videos)
    this.save({ perf })
  }

  bumpDiagnostics(code) {
    const batch = this.state
    if (!batch || !code) return
    const diagnostics = batch.diagnostics && typeof batch.diagnostics === 'object' ? batch.diagnostics : { byCode: {}, lastCode: '' }
    const byCode = { ...(diagnostics.byCode || {}) }
    byCode[code] = (byCode[code] || 0) + 1
    this.save({ diagnostics: { byCode, lastCode: code, lastLabel: COLLECTION_CODES[code]?.label || '' } })
  }
}

module.exports = { BatchRunner, normalizeBatchConfig, batchOpeningInput, STATUS }
