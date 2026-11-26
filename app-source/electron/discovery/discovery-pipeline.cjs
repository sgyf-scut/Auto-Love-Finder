// P2-11B：收藏夹新视频 → 评论收集 → P2-09 分类 → 候选证据判断 的自动处理流水线。
// 边界：
// 1) 只处理素材库里「收藏夹来源」的视频，不处理手动导入/测试视频；
// 2) 页面读取复用 comment-collector + comment-collection-service，遇到登录失效、验证、限频直接停止，不绕过；
// 3) 分类复用 library-classifier / comment-classifier：规则优先，规则弃权才调用豆包；
// 4) 同一评论输入未变化时不重复请求模型（inputHash 相同会跳过）；
// 5) 没读到评论只标 unknown_no_comments，绝不据此判定视频低质量；
// 6) 本模块不关注、不发私信、不训练视频模型。
const { CommentCollector } = require('../social-brain/comment-collector.cjs')
const { classifyLibrary, commentInputHash, CANDIDATE_INTENTS } = require('../social-brain/library-classifier.cjs')

const DEFAULTS = {
  maxVideosPerRound: 5,
  maxCommentsPerVideo: 40,
  maxPagesPerVideo: 4,
  maxAiCallsPerRound: 12,
  firstBatchComments: 12,
  // 首批没有证据时，从剩余评论中按位置间隔再抽一批；不能因为开头没命中就淘汰视频。
  secondBatchComments: 10,
}
// 单次“同步并自动分析”任务的全局预算：达到后持久化状态，下一次任务继续。
const TASK_DEFAULTS = { maxVideos: 10, maxAiCalls: 12 }
const MAX_ATTEMPTS = 3
// 账号级权限/验证问题：整轮停止，等用户处理后再继续。
const HARD_STOP_CODES = ['LOGIN_REQUIRED', 'CHALLENGE', 'ACCESS_RESTRICTED', 'ACCESS_DENIED', 'NO_TRANSPORT']
// 限频/网络问题：只中断当前视频并停止本轮，保留断点，不继续请求。
const TRANSIENT_STOP_CODES = ['RATE_LIMITED', 'NETWORK_ERROR']

const now = () => new Date().toISOString()
const clampInt = (value, fallback, min, max) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}
const isFavoritesVideo = video => Boolean(video && (video.source === 'favorites' || video.favoritesFolder))

function commentBelongsTo(comment, video) {
  return Boolean((video.video_id && comment.video_id === video.video_id)
    || (video.video_url && comment.video_url === video.video_url))
}

// “真实证据”只认原文里能核对到的标签：必须有 evidence，且分类结果与当前视频语境的输入哈希一致。
// 人工审核过的标签是用户结论，不受模型输入哈希约束；旧模型标签换视频/改标题后必须重算，不能算作证据。
function evidenceOf(comments = [], video = null) {
  let evidence = 0
  let invitations = 0
  for (const comment of comments) {
    const classification = comment?.classification || {}
    const intent = classification.intent
    if (!CANDIDATE_INTENTS.includes(intent)) continue
    if (!Array.isArray(classification.evidence) || !classification.evidence.length) continue
    if (video && !classification.reviewedByUser && classification.inputHash
      && classification.inputHash !== commentInputHash(comment, video)) continue
    evidence += 1
    if (intent === 'EXPLICIT_INVITATION') invitations += 1
  }
  return { evidence, invitations }
}

// 从剩余评论里按位置均匀抽取，覆盖列表前中后段，避免第二批仍是连续相邻评论。
function sampleAcross(list = [], count = 0) {
  if (!list.length || count <= 0) return []
  const take = Math.min(list.length, count)
  if (take >= list.length) return list.slice()
  const picked = []
  const step = list.length / take
  for (let index = 0; index < take; index += 1) {
    const at = Math.min(list.length - 1, Math.floor(index * step + step / 2))
    if (!picked.includes(list[at])) picked.push(list[at])
  }
  return picked
}

function intentStatsOf(comments = [], video = null) {
  const stats = { ruleClassified: 0, aiClassified: 0, explicitInvitations: 0, seekingFriends: 0, contextualInterest: 0, rejectCount: 0, unknownCount: 0 }
  for (const comment of comments) {
    const classification = comment?.classification || {}
    if (!classification.intent) { stats.unknownCount += 1; continue }
    if (video && !classification.reviewedByUser && classification.inputHash
      && classification.inputHash !== commentInputHash(comment, video)) {
      stats.unknownCount += 1
      continue
    }
    if (classification.model === 'rule') stats.ruleClassified += 1
    else stats.aiClassified += 1
    if (classification.intent === 'EXPLICIT_INVITATION') stats.explicitInvitations += 1
    else if (classification.intent === 'SEEKING_FRIENDS') stats.seekingFriends += 1
    else if (classification.intent === 'CONTEXTUAL_INTEREST') stats.contextualInterest += 1
    else if (classification.intent === 'DO_NOT_CONTACT') stats.rejectCount += 1
    else if (classification.intent === 'UNKNOWN') stats.unknownCount += 1
  }
  return stats
}

class DiscoveryPipeline {
  constructor({ store, learningStore = null, ai = null, transportFactory = null, syncCandidates = null, onProgress = () => {}, accountId = '' } = {}) {
    if (!store) throw new Error('缺少素材库')
    this.store = store
    this.learningStore = learningStore
    this.ai = ai
    this.transportFactory = transportFactory
    this.syncCandidates = syncCandidates
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {}
    this.accountId = accountId
    this.running = false
    this.paused = false
  }

  push(patch = {}) {
    const state = this.store.setPipeline({ ...patch, updatedAt: now() })
    try { this.onProgress(state) } catch { /* 进度回调失败不影响处理 */ }
    return state
  }

  // 应用重启后，把遗留的“处理中”恢复成可继续的中断状态，避免任务永远卡住。
  recover() {
    const state = this.store.pipelineState()
    const staleItems = (state.items || []).some(item => item.status === 'running')
    if (state.status !== 'running' && !staleItems) return state
    const items = (state.items || []).map(item => item.status === 'running'
      ? { ...item, status: 'interrupted', code: 'APP_RESTARTED', reason: '应用重启，已中断；再次启动会从该视频继续', phase: item.phase || '' }
      : item)
    return this.push({
      status: 'interrupted', code: 'APP_RESTARTED', phase: '上次运行被应用重启中断，可继续处理',
      nextAction: '点击“继续自动分析”从未完成的视频继续；已分类的评论不会重复请求模型', items,
    })
  }

  pause() {
    if (this.running) {
      this.paused = true
      return this.push({ status: 'paused', phase: '已请求暂停，将在当前视频处理完成后停止', nextAction: '点击“继续自动分析”恢复' })
    }
    return this.push({ status: 'paused', phase: '已暂停', nextAction: '点击“继续自动分析”恢复' })
  }

  limits(options = {}) {
    const base = this.store.pipelineState().limits || DEFAULTS
    const task = options.taskLimits || {}
    const maxCommentsPerVideo = clampInt(options.maxCommentsPerVideo ?? base.maxCommentsPerVideo, DEFAULTS.maxCommentsPerVideo, 1, 100)
    return {
      maxVideosPerRound: clampInt(options.maxVideosPerRound ?? base.maxVideosPerRound, DEFAULTS.maxVideosPerRound, 1, 20),
      maxCommentsPerVideo,
      maxPagesPerVideo: clampInt(options.maxPagesPerVideo ?? base.maxPagesPerVideo, DEFAULTS.maxPagesPerVideo, 1, 8),
      maxAiCallsPerRound: clampInt(options.maxAiCallsPerRound ?? base.maxAiCallsPerRound, DEFAULTS.maxAiCallsPerRound, 0, 30),
      firstBatchComments: clampInt(options.firstBatchComments ?? base.firstBatchComments, DEFAULTS.firstBatchComments, 1, Math.min(50, maxCommentsPerVideo)),
      secondBatchComments: clampInt(options.secondBatchComments ?? base.secondBatchComments, DEFAULTS.secondBatchComments, 1, Math.min(20, maxCommentsPerVideo)),
      // 整次任务预算：单次“同步并自动分析”最多处理多少视频、最多调用多少次模型。
      task: {
        maxVideos: clampInt(task.maxVideos ?? base.task?.maxVideos, TASK_DEFAULTS.maxVideos, 1, 50),
        maxAiCalls: clampInt(task.maxAiCalls ?? base.task?.maxAiCalls, TASK_DEFAULTS.maxAiCalls, 0, 50),
      },
    }
  }

  itemOf(video) {
    return (this.store.pipelineState().items || []).find(item => item.videoKey === video.key) || null
  }

  updateItem(video, patch = {}, extras = {}) {
    const state = this.store.pipelineState()
    const items = [...(state.items || [])]
    const index = items.findIndex(item => item.videoKey === video.key)
    const base = index >= 0 ? items[index] : {
      videoKey: video.key, videoId: null, videoUrl: null, title: null, folder: null,
      status: 'pending', code: null, reason: '', phase: '', attempts: 0, pages: 0, collectorKey: null,
      commentsAdded: 0, commentsTotal: 0, classifiedCount: 0, candidateEvidence: 0,
      explicitInvitations: 0, seekingFriends: 0, contextualInterest: 0, rejectCount: 0, unknownCount: 0,
      ruleClassified: 0, aiClassified: 0, samplingStage: 0, sampleMissReason: '',
      modelCalls: 0, tokens: 0, earlyStop: false, quality: null,
      startedAt: null, updatedAt: null, finishedAt: null,
    }
    const next = {
      ...base, ...patch,
      videoId: video.video_id || base.videoId || null,
      videoUrl: video.video_url || base.videoUrl || null,
      title: video.title || base.title || null,
      folder: video.favoritesFolder || base.folder || null,
      updatedAt: now(),
    }
    if (index >= 0) items[index] = next
    else items.push(next)
    return this.push({ ...extras, items })
  }

  bump(outcome = {}) {
    const state = this.store.pipelineState()
    const counters = { commentsSkipped: 0, ...state.counters }
    const stats = outcome.stats || {}
    if (outcome.status === 'completed') counters.videosCompleted += 1
    else if (outcome.status === 'failed') counters.videosFailed += 1
    else if (outcome.status === 'blocked') counters.videosBlocked += 1
    counters.commentsCollected += Number(stats.commentsAdded) || 0
    counters.commentsSkipped += Number(stats.commentsSkipped) || 0
    counters.commentsClassified += Number(stats.newlyClassified) || 0
    counters.aiCalls += Number(stats.aiCalls) || 0
    counters.tokens += Number(stats.tokens) || 0
    return this.push({ counters })
  }

  // 只挑收藏夹来源、尚未完成、且不是“失败且超过重试次数”的视频。
  selectQueue({ retryFailed = false, maxAttempts = MAX_ATTEMPTS } = {}) {
    const library = this.store.read()
    const items = new Map((library.pipeline.items || []).map(item => [item.videoKey, item]))
    return (library.videos || [])
      .filter(isFavoritesVideo)
      .filter(video => {
        const item = items.get(video.key)
        if (!item) return true
        if (item.status === 'completed' || item.status === 'skipped') return false
        if (item.status === 'failed') return retryFailed && item.attempts < maxAttempts
        // 网络/限频造成的中断最多重试 maxAttempts 次，避免一个坏页面永远卡住队列。
        if (item.status === 'interrupted' && TRANSIENT_STOP_CODES.includes(item.code)) return item.attempts < maxAttempts
        // 预算不足/模型未完成的中断可以继续，已分类部分不会重复请求。
        return ['pending', 'interrupted', 'blocked', 'running'].includes(item.status)
      })
  }

  // 记录一次失败，按错误类型决定是否停止整轮。
  failItem(video, { code = 'NETWORK_ERROR', reason = '', phase = '', total = 0, stopRound = false } = {}) {
    const status = HARD_STOP_CODES.includes(code) ? 'blocked' : TRANSIENT_STOP_CODES.includes(code) ? 'interrupted' : 'failed'
    const nextAction = HARD_STOP_CODES.includes(code)
      ? '请先在抖音窗口完成登录或安全验证，再点击“继续自动分析”；已完成的视频不会重复处理'
      : TRANSIENT_STOP_CODES.includes(code)
        ? '稍后点击“继续自动分析”从未完成的视频继续；已收集的评论和已分类结果不会重复请求模型'
        : '该视频无法读取，已跳过；可稍后重试或改用导入方式'
    this.updateItem(video, {
      status, code, reason, phase, finishedAt: now(),
      commentsTotal: total,
      quality: 'unavailable',
    }, {
      status: status === 'blocked' ? 'blocked' : status === 'interrupted' ? 'interrupted' : 'running',
      code, lastError: reason, phase: `${video.title || video.video_id || '视频'}：${reason}`,
      nextAction: status === 'failed' ? '继续处理其余视频' : nextAction,
    })
    return { status, code, reason, stop: stopRound || status !== 'failed', stats: { commentsAdded: 0, commentsSkipped: 0, newlyClassified: 0, aiCalls: 0, tokens: 0 } }
  }

  async classifyScope(video, keys, budget) {
    if (!keys.length) return { aiCalls: 0, tokens: 0, errors: [], pending: 0 }
    const remaining = Math.max(0, budget.maxAiCallsPerRound - budget.usedCalls)
    if (remaining <= 0) return { aiCalls: 0, tokens: 0, errors: [{ reason: '本轮模型调用预算已用尽' }], pending: keys.length, budgetExhausted: true }
    const result = await classifyLibrary({
      store: this.store,
      ai: this.ai,
      options: {
        commentKeys: keys,
        videoKeys: [video.key],
        maxAiCalls: remaining,
        settings: { aiBatchSize: clampInt(keys.length, 6, 1, 12), classificationEnabled: true },
      },
    })
    const stats = result?.result || {}
    const aiCalls = Number(stats.aiCalls) || 0
    const tokens = Number(stats.tokens) || 0
    budget.usedCalls += aiCalls
    budget.usedTokens += tokens
    return {
      aiCalls, tokens,
      errors: Array.isArray(stats.errors) ? stats.errors : [],
      pending: Number(stats.pending) || 0,
      budgetExhausted: remaining <= aiCalls && Number(stats.pending) > 0,
    }
  }

  /**
   * 处理单个视频：
   * 1) 收集页面可见评论（含登录/验证/限频判断）；
   * 2) 规则分类 + 首批模型分类；
   * 3) 首批有可核对证据才继续分析剩余评论，否则停止继续消耗模型预算；
   * 4) 写回逐视频状态。
   */
  async processVideo(video, limits, round) {
    const startedAt = now()
    const item = this.itemOf(video)
    const attempts = (item?.attempts || 0) + 1
    const title = video.title || video.video_id || video.video_url || '收藏视频'
    this.updateItem(video, {
      status: 'running', attempts, code: null, reason: '', phase: '正在检查视频是否可访问',
      startedAt, finishedAt: null, earlyStop: false, quality: null,
    }, {
      status: 'running', phase: `正在处理《${title}》`, code: null, lastError: '', nextAction: '',
    })

    let transport = null
    try { transport = this.transportFactory ? this.transportFactory(video) : null } catch (error) {
      return this.failItem(video, { code: 'NO_TRANSPORT', reason: `页面读取通道不可用：${String(error?.message || error)}`, stopRound: true })
    }
    if (!transport) return this.failItem(video, { code: 'NO_TRANSPORT', reason: '当前环境没有可用的页面读取通道', stopRound: true })

    let result = null
    try {
      const collector = new CommentCollector({ store: this.store, transport })
      // 逐视频断点：只恢复本视频上次完成的页数；collectorKey 用于确保 A 视频的进度不会用到 B 视频。
      const resumePage = Math.max(0, Number(item?.pages) || 0)
      result = await collector.run({
        videoId: video.video_id || null,
        videoUrl: video.video_url || null,
        title: video.title || null,
        limit: limits.maxCommentsPerVideo,
        maxPages: limits.maxPagesPerVideo,
        startPage: resumePage,
        startPageKey: item?.collectorKey || null,
        onPage: page => this.updateItem(video, {
          pages: page.pages || 0,
          collectorKey: page.videoKey || null,
          commentsAdded: page.collected || 0,
          commentsTotal: page.stored || page.collected || 0,
        }),
      })
    } catch (error) {
      const code = 'NETWORK_ERROR'
      const total = this.store.read().comments.filter(comment => commentBelongsTo(comment, video)).length
      return this.failItem(video, { code, reason: String(error?.message || error), total, stopRound: true })
    }

    const library = this.store.read()
    const comments = library.comments.filter(comment => commentBelongsTo(comment, video))
    const total = comments.length
    if (!result?.ok) {
      const code = result?.code || 'NETWORK_ERROR'
      // 视频本身失效/评论关闭：只跳过这个视频，不停止整轮。
      return this.failItem(video, {
        code,
        reason: result?.reason || result?.error || '无法读取评论',
        total,
        stopRound: HARD_STOP_CODES.includes(code) || TRANSIENT_STOP_CODES.includes(code),
      })
    }

    if (!comments.length) {
      // 没加载出评论不等于视频低质量：只记未知，不进入失败/低质。
      this.updateItem(video, {
        status: 'completed', code: null, reason: '该视频暂无可见评论（或评论未加载），未判定视频质量',
        phase: '已读取页面，但没有可见评论', finishedAt: now(), pages: result.pages || 0,
        commentsAdded: result.added || 0, commentsTotal: 0, classifiedCount: 0,
        candidateEvidence: 0, explicitInvitations: 0, quality: 'unknown_no_comments',
      })
      return { status: 'completed', stats: { commentsAdded: result.added || 0, commentsSkipped: result.duplicates || 0, newlyClassified: 0, aiCalls: 0, tokens: 0 } }
    }

    // 待分类 = 没有人工结论，且输入哈希与当前视频语境不一致（换视频/改标题会重新判断）。
    const pendingKeys = comments
      .filter(comment => !comment.classification?.reviewedByUser)
      .filter(comment => comment.classification?.inputHash !== commentInputHash(comment, video))
      .map(comment => comment.key)
    const beforeClassified = new Set(comments.filter(comment => comment.classification?.intent).map(comment => comment.key))

    const firstBatch = pendingKeys.slice(0, limits.firstBatchComments)
    const budget = { maxAiCallsPerRound: limits.maxAiCallsPerRound, usedCalls: round.aiCalls, usedTokens: round.tokens }
    const spent = { aiCalls: 0, tokens: 0 }
    const first = await this.classifyScope(video, firstBatch, budget)
    spent.aiCalls += first.aiCalls
    spent.tokens += first.tokens
    round.aiCalls = budget.usedCalls
    round.tokens = budget.usedTokens

    const afterFirst = this.store.read().comments.filter(comment => commentBelongsTo(comment, video))
    const byKey = new Map(afterFirst.map(comment => [comment.key, comment]))
    const firstComments = firstBatch.map(key => byKey.get(key)).filter(Boolean)
    const firstEvidence = evidenceOf(firstComments, video)
    round.evidence += firstEvidence.evidence

    // 首批如果因预算/模型错误没有真正分类，不能把“没有证据”当成视频结论。
    const firstUnclassified = firstBatch.filter(key => !byKey.get(key)?.classification?.intent).length
    const firstBlocked = first.budgetExhausted === true || first.errors.length > 0 || firstUnclassified > 0

    // 取指定评论的当前分类结果，证据判定必须绑定本视频语境（inputHash）。
    const evidenceOfKeys = keys => {
      const latest = this.store.read().comments.filter(comment => commentBelongsTo(comment, video))
      const index = new Map(latest.map(comment => [comment.key, comment]))
      return evidenceOf(keys.map(key => index.get(key)).filter(Boolean), video)
    }
    const advance = async keys => {
      if (!keys.length) return null
      if (budget.usedCalls >= limits.maxAiCallsPerRound) {
        budgetExhausted = true
        return null
      }
      const batch = await this.classifyScope(video, keys, budget)
      spent.aiCalls += batch.aiCalls
      spent.tokens += batch.tokens
      round.aiCalls = budget.usedCalls
      round.tokens = budget.usedTokens
      const unclassified = keys.filter(key => !this.store.read().comments.find(comment => comment.key === key)?.classification?.intent).length
      if (batch.budgetExhausted === true || batch.errors.length > 0 || unclassified > 0) budgetExhausted = true
      return batch
    }

    let earlyStop = false
    let budgetExhausted = firstBlocked
    let samplingStage = firstBatch.length ? 1 : 0
    let sampleMissReason = ''
    let secondBatchSize = 0
    const remainingKeys = pendingKeys.slice(firstBatch.length)

    if (pendingKeys.length && !firstBlocked) {
      if (firstEvidence.evidence > 0) {
        // 首批已发现可核对证据：继续深入剩余评论，直到评论或模型预算用尽。
        if (remainingKeys.length) {
          samplingStage = 2
          await advance(remainingKeys)
        }
      } else if (!remainingKeys.length) {
        // 全部待分类评论都在首批里且没有证据：标记抽样未命中，但没有剩余评论可再抽。
        earlyStop = true
        sampleMissReason = 'first_batch_no_evidence'
      } else {
        // 首批没有证据不立即淘汰视频：从剩余评论按位置间隔抽第二批，覆盖前中后段。
        const sampled = sampleAcross(remainingKeys, limits.secondBatchComments)
        secondBatchSize = sampled.length
        samplingStage = 2
        const second = await advance(sampled)
        if (!budgetExhausted && second) {
          const secondEvidence = evidenceOfKeys(sampled)
          round.evidence += secondEvidence.evidence
          if (secondEvidence.evidence === 0) {
            // 两批抽样都没有可核对证据：停止本轮模型调用；后续出现新评论仍可重新评估。
            earlyStop = true
            sampleMissReason = 'two_stage_sampling_no_evidence'
          } else {
            // 第二批命中：继续深入尚未分类的剩余评论。
            const deeper = remainingKeys.filter(key => !sampled.includes(key))
            if (deeper.length) {
              samplingStage = 3
              await advance(deeper)
            }
          }
        }
      }
    }

    const finalLibrary = this.store.read()
    const finalComments = finalLibrary.comments.filter(comment => commentBelongsTo(comment, video))
    const classified = finalComments.filter(comment => comment.classification?.intent && !comment.classification?.reviewedByUser)
    const newlyClassified = classified.filter(comment => !beforeClassified.has(comment.key)).length
    const evidence = evidenceOf(finalComments, video)
    const intentStats = intentStatsOf(finalComments, video)
    const pendingAfter = finalComments.filter(comment => !comment.classification?.reviewedByUser && comment.classification?.inputHash !== commentInputHash(comment, video)).length

    // 学习库同步只刷新原文/视频背景，不会覆盖人工标签。
    if (this.learningStore) {
      try { this.learningStore.syncLibrary(finalLibrary) } catch { /* 学习库写入失败不影响流水线 */ }
    }

    const phase = earlyStop
      ? `两阶段抽样（首批 ${firstBatch.length} 条${secondBatchSize ? ` + 第二批 ${secondBatchSize} 条` : ''}）未发现可核对交友证据，已停止继续分析`
      : `已分类 ${classified.length}/${finalComments.length} 条评论，可核对证据 ${evidence.evidence} 条`
    const reason = earlyStop
      ? '抽样未发现有效交友证据（不代表视频低质量）；后续出现新评论会重新评估'
      : pendingAfter
        ? `仍有 ${pendingAfter} 条评论待分类`
        : '评论分类完成'

    this.updateItem(video, {
      status: earlyStop || !(pendingAfter || budgetExhausted) ? 'completed' : 'interrupted',
      code: earlyStop ? null : pendingAfter ? (budgetExhausted ? 'BUDGET_EXHAUSTED' : 'MODEL_INCOMPLETE') : null,
      reason,
      phase,
      finishedAt: earlyStop || !(pendingAfter || budgetExhausted) ? now() : null,
      pages: result.pages || 0,
      collectorKey: result.collector?.videoKey || null,
      commentsAdded: result.added || 0,
      commentsTotal: finalComments.length,
      classifiedCount: classified.length,
      candidateEvidence: evidence.evidence,
      explicitInvitations: evidence.invitations,
      seekingFriends: intentStats.seekingFriends,
      contextualInterest: intentStats.contextualInterest,
      rejectCount: intentStats.rejectCount,
      unknownCount: intentStats.unknownCount,
      ruleClassified: intentStats.ruleClassified,
      aiClassified: intentStats.aiClassified,
      samplingStage,
      sampleMissReason,
      modelCalls: spent.aiCalls,
      tokens: spent.tokens,
      earlyStop,
      quality: earlyStop ? 'no_evidence' : 'evidence_found',
    }, {
      status: budgetExhausted && !earlyStop ? 'completed' : 'running',
      phase: `${title}：${phase}`,
      nextAction: pendingAfter && !earlyStop
        ? '本轮模型预算/分类未完成，下次点击“继续自动分析”会从未分类评论继续；已分类的不会重复请求'
        : earlyStop ? '继续处理其余视频' : '',
    })

    return {
      status: earlyStop || !(pendingAfter || budgetExhausted) ? 'completed' : 'interrupted',
      stats: {
        commentsAdded: result.added || 0,
        commentsSkipped: result.duplicates || 0,
        newlyClassified,
        aiCalls: spent.aiCalls,
        tokens: spent.tokens,
        evidence: evidence.evidence,
      },
    }
  }

  async run(options = {}) {
    if (this.running) {
      return { ok: false, code: 'ALREADY_RUNNING', error: '自动分析已经在运行', pipeline: this.store.pipelineState() }
    }
    this.running = true
    this.paused = false
    try {
      return await this.runRound(options)
    } finally {
      this.running = false
      this.paused = false
    }
  }

  async runRound(options = {}) {
    const state = this.recover()
    if (!this.ai) {
      const blocked = this.push({
        status: 'blocked', code: 'MODEL_UNAVAILABLE', phase: '未配置可用模型，无法执行豆包分类',
        lastError: '规则无法确定的评论需要调用豆包分类，但当前没有可用模型',
        nextAction: '先在“设置 → AI 模型”里配置可用模型，再点击“继续自动分析”',
      })
      return { ok: false, code: 'MODEL_UNAVAILABLE', error: blocked.lastError, pipeline: blocked }
    }
    const limits = this.limits(options)
    const retryFailed = options.retryFailed === true
    // 整次任务预算：即使连续多轮，也只在本次任务内消耗这些模型调用；达到后持久化状态，等下一次任务继续。
    const task = { ...limits.task, videosProcessed: 0, aiCalls: 0, tokens: 0, startedAt: now(), finishedAt: null }
    const taskLimits = {
      ...limits,
      maxVideosPerRound: Math.min(limits.maxVideosPerRound, task.maxVideos),
      maxAiCallsPerRound: Math.min(limits.maxAiCallsPerRound, task.maxAiCalls),
    }
    const queue = this.selectQueue({ retryFailed }).slice(0, taskLimits.maxVideosPerRound)
    if (!queue.length) {
      const idle = this.push({
        status: state.status === 'blocked' ? 'blocked' : 'completed',
        phase: '没有需要处理的收藏夹视频',
        nextAction: state.status === 'blocked' ? state.nextAction : '同步收藏夹后会自动加入待处理队列',
        finishedAt: now(), limits, task: { ...task, status: 'completed', finishedAt: now() },
      })
      return { ok: true, processed: 0, pipeline: idle, message: '没有需要处理的收藏夹视频' }
    }

    const round = { videos: 0, comments: 0, aiCalls: 0, tokens: 0, evidence: 0 }
    this.push({
      status: 'running', startedAt: now(), finishedAt: null, code: null, lastError: '',
      phase: `本次任务计划处理 ${queue.length} 个收藏视频`, nextAction: '', limits,
      task: { ...task, status: 'running' },
      round: { ...round },
    })

    let stop = null
    for (const video of queue) {
      if (this.paused) { stop = { type: 'paused', code: 'PAUSED', reason: '用户暂停' }; break }
      if (round.aiCalls >= taskLimits.maxAiCallsPerRound) { stop = { type: 'budget', code: 'BUDGET_EXHAUSTED', reason: `本次任务模型调用预算 ${taskLimits.maxAiCallsPerRound} 次已用尽` }; break }
      const outcome = await this.processVideo(video, taskLimits, round)
      task.videosProcessed += 1
      task.aiCalls = round.aiCalls
      task.tokens = round.tokens
      round.videos += 1
      if (outcome.stats) {
        round.comments += Number(outcome.stats.commentsAdded) || 0
        round.tokens = round.tokens // tokens already tracked in round
      }
      this.push({ round: { ...round }, task: { ...task, status: 'running' } })
      this.bump(outcome)
      if (outcome.stop) {
        stop = { type: outcome.status === 'blocked' ? 'blocked' : outcome.status === 'interrupted' ? 'interrupted' : 'failed', code: outcome.code, reason: outcome.reason }
        break
      }
    }

    const remaining = this.selectQueue({ retryFailed }).length
    // P2-11C：本轮有新完成的视频时，自动把合规意愿合并进候选池（不自动发消息）。
    let candidateSync = null
    if (round.videos > 0 && typeof this.syncCandidates === 'function') {
      try { candidateSync = await this.syncCandidates({ reason: 'pipeline_round' }) } catch (error) {
        candidateSync = { ok: false, error: String(error?.message || error) }
      }
    }
    const candidateText = candidateSync?.ok
      ? `，候选池新增 ${Number(candidateSync.added) || 0} / 合并 ${Number(candidateSync.merged) || 0}`
      : candidateSync && !candidateSync.ok ? '，候选池更新失败' : ''
    const status = !stop
      ? 'completed'
      : stop.type === 'paused'
        ? 'paused'
        : stop.type === 'blocked'
          ? 'blocked'
          : stop.type === 'interrupted'
            ? 'interrupted'
            : 'completed'
    const phase = !stop
      ? `本轮完成 ${round.videos} 个视频，新增评论 ${round.comments} 条，模型调用 ${round.aiCalls} 次${candidateText}`
      : `${stop.reason}${remaining ? `；还有 ${remaining} 个视频待继续` : ''}${candidateText}`
    const nextAction = !stop
      ? (remaining ? '达到本轮视频数上限，点击“继续自动分析”处理剩余视频' : '')
      : stop.type === 'blocked'
        ? '请先完成登录/验证，再点击“继续自动分析”'
        : stop.type === 'interrupted'
          ? '稍后点击“继续自动分析”；已收集评论和已分类结果不会重复请求模型'
          : stop.type === 'budget'
            ? '本轮模型预算已用尽，下次点击“继续自动分析”从未分类评论继续'
            : '点击“继续自动分析”恢复'

    const pipeline = this.push({
      status, code: stop?.code || null, phase,
      lastError: stop && stop.type !== 'paused' && stop.type !== 'budget' ? (stop.reason || '') : '',
      nextAction, finishedAt: now(), limits, round: { ...round },
      task: {
        ...task, aiCalls: round.aiCalls, tokens: round.tokens, status,
        finishedAt: status === 'running' ? null : now(),
      },
    })
    return {
      ok: true, status, processed: round.videos, comments: round.comments,
      aiCalls: round.aiCalls, tokens: round.tokens, evidence: round.evidence,
      stoppedBy: stop ? stop.type : null, remaining, pipeline,
      candidates: candidateSync,
      message: phase,
    }
  }
}

module.exports = {
  DEFAULTS, TASK_DEFAULTS, MAX_ATTEMPTS, HARD_STOP_CODES, TRANSIENT_STOP_CODES,
  evidenceOf, commentBelongsTo, isFavoritesVideo, sampleAcross, intentStatsOf, DiscoveryPipeline,
}
