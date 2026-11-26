// P2-12A/B/C：人工基准集、自动调度、候选人发现等级的质量与安全边界。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const {
  DEFAULT_SIZE, createBenchmarkSet, buildView, evaluateBenchmark, evaluateHumanLabels,
  eligibleSamples, metricsOfRows, rejectionLeaks, LABEL_OPTIONS,
} = require('../electron/social-brain/library-benchmark.cjs')
const { emptyScheduler } = require('../electron/social-brain/library-store.cjs')
const { DiscoveryScheduler, localDayKey, startOfNextLocalDay } = require('../electron/discovery/discovery-scheduler.cjs')
const { candidateRecords, gradeOfIntent } = require('../electron/social-brain/library-candidates.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')

// ── P2-12A 基准集构造 ────────────────────────────────────────────────────────
const video = (id = 'v1') => ({ video_id: id, source: 'favorites', favoritesFolder: '交友收藏', title: '同城交友认识新朋友' })
const learningOf = (counts, { videoId = 'v1', prefix = 'k' } = {}) => {
  const samples = []
  let index = 0
  for (const [intent, count] of Object.entries(counts)) {
    for (let at = 0; at < count; at += 1) {
      index += 1
      samples.push({
        key: `${prefix}${String(index).padStart(4, '0')}`,
        videoId,
        text: `${intent} 评论样本 ${index}`,
        videoTitle: '同城交友',
        createdAt: '2026-11-01T10:00:00.000Z',
        ai: { intent, confidence: 0.7, evidence: intent === 'EXPLICIT_INVITATION' ? ['想认识'] : [] },
      })
    }
  }
  return { samples }
}

test('基准集按需求配额抽样，排除已有人工标签与非收藏夹视频', () => {
  const learning = learningOf({
    EXPLICIT_INVITATION: 5, SEEKING_FRIENDS: 20, CONTEXTUAL_INTEREST: 25, ORDINARY: 25,
    DO_NOT_CONTACT: 3, ADVERTISEMENT: 3, UNKNOWN: 5,
  })
  // 已有人工标签的样本不得进入新基准集，避免非盲污染。
  learning.samples[4].human = { intent: 'SEEKING_FRIENDS', at: '2026-11-02T10:00:00.000Z' }
  learning.samples[10].excluded = true
  // 未分类样本：模型没有给出有效标签。
  learning.samples.push({ key: 'u0001', videoId: 'v1', text: '纯表情评论', ai: {} })
  learning.samples.push({ key: 'u0002', videoId: 'v1', text: '只发了一个标点', ai: {} })
  // 另一个非收藏夹视频的样本不能计入。
  learning.samples.push({ key: 'other-video', videoId: 'v2', text: '普通评论', ai: { intent: 'ORDINARY' } })
  const library = { videos: [video('v1')], comments: [] }
  const result = createBenchmarkSet({ learning, library, size: DEFAULT_SIZE })
  assert.equal(result.created, true)
  const keys = result.set.keys
  assert.equal(keys.length, DEFAULT_SIZE)
  assert.ok(!keys.includes('k0005'), '已有人工标签的样本不应进入基准集')
  assert.ok(!keys.includes('k0011'), '被排除的样本不应进入基准集')
  assert.ok(!keys.includes('other-video'), '非收藏夹视频的样本不应进入基准集')
  const pool = eligibleSamples(learning, library)
  assert.ok(pool.every(sample => sample.videoId === 'v1'))
  assert.equal(result.set.quotaActual.EXPLICIT_INVITATION, 3)
  assert.equal(result.set.quotaActual.SEEKING_FRIENDS, 15)
  assert.equal(result.set.quotaActual.CONTEXTUAL_INTEREST, 20)
  assert.equal(result.set.quotaActual.ORDINARY, 18)
  assert.equal(result.set.quotaActual.ADVERTISEMENT, 1)
  assert.equal(result.set.quotaActual.UNKNOWN, 2)
  assert.equal(result.set.quotaActual.UNCLASSIFIED, 1)
  assert.ok(result.set.keys.length === new Set(result.set.keys).size, '同一评论不能重复入集')
  assert.equal(Object.values(result.set.shortage).reduce((sum, value) => sum + value, 0), 0)
})

test('样本不足时如实记录缺口，不伪造样本', () => {
  const learning = learningOf({ EXPLICIT_INVITATION: 2, SEEKING_FRIENDS: 2, ORDINARY: 1 })
  const library = { videos: [video('v1')], comments: [] }
  const result = createBenchmarkSet({ learning, library, size: DEFAULT_SIZE })
  assert.equal(result.set.keys.length, 5)
  assert.deepEqual(result.set.shortage, {
    EXPLICIT_INVITATION: 1, SEEKING_FRIENDS: 13, CONTEXTUAL_INTEREST: 20, ORDINARY: 17, ADVERTISEMENT: 1, UNKNOWN: 2, UNCLASSIFIED: 1,
  })
  assert.match(result.set.note, /可用样本 5 条/)
  assert.equal(result.set.requestedSize, DEFAULT_SIZE)
})

test('盲评视图不返回模型分类、置信度、证据或作者身份', () => {
  const learning = learningOf({ SEEKING_FRIENDS: 3 })
  const library = { videos: [video('v1')], comments: [] }
  const created = createBenchmarkSet({ learning, library, size: 3 })
  const state = created.state
  const view = buildView(state, learning, { limit: 3 })
  assert.equal(view.total, 3)
  assert.equal(view.queue.length, 3)
  for (const item of view.queue) {
    assert.equal(Object.hasOwn(item, 'ai'), false)
    assert.equal(Object.hasOwn(item, 'human'), false)
    assert.equal(Object.hasOwn(item, 'authorId'), false)
    assert.equal(Object.hasOwn(item, 'confidence'), false)
    assert.equal(Object.hasOwn(item, 'evidence'), false)
    assert.ok(item.text.includes('SEEKING_FRIENDS'), '原文必须保留给人工判断')
  }
  assert.ok(view.labelOptions.length >= 7)
  assert.equal(LABEL_OPTIONS.length, view.labelOptions.length)
})

test('指标与混淆矩阵：可计算逐类 P/R/F1、Macro-F1 和严重误判', () => {
  const rows = []
  const add = (expected, predicted, count = 1) => {
    for (let at = 0; at < count; at += 1) {
      rows.push({ key: `r${rows.length}`, expected, predicted, correct: expected === predicted })
    }
  }
  add('EXPLICIT_INVITATION', 'EXPLICIT_INVITATION', 5)
  add('SEEKING_FRIENDS', 'SEEKING_FRIENDS', 8)
  add('CONTEXTUAL_INTEREST', 'CONTEXTUAL_INTEREST', 8)
  add('ORDINARY', 'ORDINARY', 19)
  add('ORDINARY', 'SEEKING_FRIENDS', 1)
  add('DO_NOT_CONTACT', 'DO_NOT_CONTACT', 1)
  add('DO_NOT_CONTACT', 'SEEKING_FRIENDS', 1)
  add('ADVERTISEMENT', 'ADVERTISEMENT', 2)
  add('UNKNOWN', 'UNKNOWN', 2)
  const metrics = metricsOfRows(rows)
  assert.equal(metrics.total, 47)
  assert.equal(metrics.evidenceSufficient, true)
  assert.equal(metrics.perClass.EXPLICIT_INVITATION.precision, 1)
  assert.equal(metrics.perClass.SEEKING_FRIENDS.recall, 1)
  assert.ok(metrics.perClass.SEEKING_FRIENDS.precision < 1)
  assert.equal(metrics.perClass.ORDINARY.recall, 0.95)
  assert.equal(metrics.perClass.DO_NOT_CONTACT.f1, 0.6667)
  assert.ok(metrics.macroF1 > 0.9, `macroF1=${metrics.macroF1}`)
  assert.equal(metrics.friendship.precision, 0.913)
  assert.equal(metrics.consentToDmErrors, 0)
  assert.equal(metrics.confusion.ORDINARY.SEEKING_FRIENDS, 1)
  assert.equal(metrics.confusion.DO_NOT_CONTACT.SEEKING_FRIENDS, 1)
  const severe = metrics.severeWrong.map(row => row.severe)
  assert.ok(severe.includes('ORDINARY_TO_SEEKING'))
  assert.ok(severe.includes('REJECTION_TO_POSITIVE'))
})

test('consentToDm 误判单独计数，证据不足时不得宣称达标', () => {
  const rows = metricsOfRows([
    { key: 'a', expected: 'ORDINARY', predicted: 'EXPLICIT_INVITATION', correct: false },
    { key: 'b', expected: 'SEEKING_FRIENDS', predicted: 'SEEKING_FRIENDS', correct: true },
    { key: 'c', expected: 'CONTEXTUAL_INTEREST', predicted: 'CONTEXTUAL_INTEREST', correct: true },
  ])
  assert.equal(rows.consentToDmErrors, 1)
  assert.equal(rows.consentToDmErrorRows[0].expected, 'ORDINARY')
  assert.equal(rows.evidenceSufficient, false)
  assert.match(rows.evidenceNote, /样本不足/)
  const learning = learningOf({ EXPLICIT_INVITATION: 5, SEEKING_FRIENDS: 5, CONTEXTUAL_INTEREST: 5, ORDINARY: 5 })
  const library = { videos: [video('v1')], comments: [] }
  const created = createBenchmarkSet({ learning, library, size: 20 })
  const evaluated = evaluateBenchmark(created.state, learning, library)
  assert.equal(evaluated.targets.status, 'insufficient_evidence')
  assert.match(evaluated.targets.note, /不能宣称分类器已达标/)
})

test('基准集满分时不把“证据不足”伪装成达标', () => {
  const learning = learningOf({ EXPLICIT_INVITATION: 6, SEEKING_FRIENDS: 10, CONTEXTUAL_INTEREST: 10, ORDINARY: 20 })
  const library = { videos: [video('v1')], comments: [] }
  const created = createBenchmarkSet({ learning, library, size: 46 })
  // 先抽样，再给入集样本写人工标签：否则已有人工标签的样本会被排除在基准集外。
  const chosen = new Set(created.set.keys)
  learning.samples.forEach(sample => {
    if (chosen.has(sample.key)) sample.human = { intent: sample.ai.intent, at: '2026-11-02T10:00:00.000Z' }
  })
  const evaluated = evaluateBenchmark(created.state, learning, library)
  assert.equal(evaluated.evidenceSufficient, true)
  assert.equal(evaluated.targets.macroF1Pass, true)
  assert.equal(evaluated.targets.friendshipPrecisionPass, true)
  assert.equal(evaluated.targets.consentToDmPass, true)
  assert.equal(evaluated.targets.rejectionProtectionPass, true)
  assert.equal(evaluated.targets.status, 'meets_targets')
})

test('拒绝联系者进入候选池会被识别为保护泄漏', () => {
  const learning = {
    samples: [
      { key: 'x1', authorId: 'a-reject', ai: { intent: 'ORDINARY' }, human: { intent: 'DO_NOT_CONTACT' }, excluded: false },
      { key: 'x2', authorId: 'a-model', ai: { intent: 'DO_NOT_CONTACT', evidence: ['别私信我'] }, excluded: false },
    ],
  }
  const library = {
    comments: [
      { key: 'c1', author_id: 'a-reject', candidate: { status: 'in_pool' } },
      { key: 'c2', author_id: 'a-model', candidate: { status: 'in_pool' } },
    ],
  }
  const leaks = rejectionLeaks(learning, library, ['a-reject'])
  assert.equal(leaks.humanRejectedCount, 1)
  assert.equal(leaks.modelRejectedCount, 1)
  assert.equal(leaks.poolAuthorCount, 2)
  assert.equal(leaks.leakedCandidates, 1)
  assert.equal(leaks.leakCount, 2)
})

// ── P2-12B 自动调度 ─────────────────────────────────────────────────────────
function schedulerStore(initial = {}) {
  const base = emptyScheduler()
  let scheduler = {
    ...base,
    ...initial,
    budget: {
      ...base.budget,
      ...(initial.budget || {}),
      limits: { ...base.budget.limits, ...((initial.budget || {}).limits || {}) },
    },
  }
  return {
    pipelineState: () => ({ scheduler }),
    setPipeline(patch = {}) {
      scheduler = { ...scheduler, ...(patch.scheduler || {}) }
      return { scheduler }
    },
    read: () => scheduler,
  }
}
const fixedNow = (iso) => {
  let value = new Date(iso)
  const now = () => value
  now.set = (next) => { value = new Date(next) }
  return now
}

test('预算按本地日期重置，程序重启当天不清零', () => {
  const store = schedulerStore({ budget: { day: '2026-10-31', modelCalls: 24, tokens: 12000, videos: 9, syncs: 1 } })
  const scheduler = new DiscoveryScheduler({ store, now: fixedNow('2026-11-03T09:00:00+08:00') })
  const state = scheduler.ensureDay()
  assert.equal(state.budget.day, '2026-11-03')
  assert.equal(state.budget.modelCalls, 0)
  assert.equal(state.budget.tokens, 0)
  assert.equal(state.budget.syncs, 0)
  // 同一天重启不做清零。
  const again = new DiscoveryScheduler({ store, now: fixedNow('2026-11-03T18:00:00+08:00') }).ensureDay()
  assert.equal(again.budget.day, '2026-11-03')
})

test('同步成功后按预算启动一轮分析，并持久化视频/评论/Token', async () => {
  const store = schedulerStore({
    autoSync: true, autoAnalyze: true, status: 'waiting',
    nextSyncAt: '2026-11-03T08:00:00+08:00', nextRunAt: '2026-11-03T08:00:00+08:00',
  })
  const calls = { sync: 0, pipeline: null }
  const scheduler = new DiscoveryScheduler({
    store,
    now: fixedNow('2026-11-03T09:00:00+08:00'),
    syncFavorites: async () => { calls.sync += 1; return { ok: true, found: 5, added: 2 } },
    runPipeline: async (options) => {
      calls.pipeline = options
      return { processed: 2, comments: 20, aiCalls: 3, tokens: 4800, remaining: 0 }
    },
    pendingCount: () => 3,
    isBusy: () => false,
  })
  const result = await scheduler.tick()
  assert.equal(result.worked, true)
  assert.equal(calls.sync, 1)
  assert.equal(calls.pipeline.maxVideosPerRound, 10)
  assert.equal(calls.pipeline.maxAiCallsPerRound, 12)
  assert.equal(calls.pipeline.maxCommentsPerVideo, 40)
  assert.deepEqual(calls.pipeline.taskLimits, { maxVideos: 10, maxAiCalls: 12 })
  const state = store.read()
  assert.equal(state.budget.syncs, 1)
  assert.equal(state.budget.videos, 2)
  assert.equal(state.budget.comments, 20)
  assert.equal(state.budget.modelCalls, 3)
  assert.equal(state.budget.tokens, 4800)
  assert.equal(state.budget.tokenSource, 'model_returned')
  assert.equal(state.status, 'completed')
  assert.ok(state.nextSyncAt)
  assert.equal(state.lastRound.analysis.processed, 2)
})

test('每日预算不足时只跑剩余次数；耗尽后等待下一本地日期', async () => {
  const store = schedulerStore({ autoAnalyze: true, status: 'waiting', nextRunAt: '2026-11-03T08:00:00+08:00', budget: { day: '2026-11-03', modelCalls: 23 } })
  let options = null
  const scheduler = new DiscoveryScheduler({
    store, now: fixedNow('2026-11-03T09:00:00+08:00'),
    runPipeline: async (value) => { options = value; return { processed: 1, comments: 4, aiCalls: 1, tokens: 900, remaining: 1 } },
    pendingCount: () => 2,
  })
  await scheduler.tick()
  assert.equal(options.maxAiCallsPerRound, 1)
  assert.equal(store.read().budget.modelCalls, 24)

  const exhausted = schedulerStore({ autoAnalyze: true, status: 'waiting', nextRunAt: '2026-11-03T08:00:00+08:00', budget: { day: '2026-11-03', modelCalls: 24 } })
  let ran = false
  const second = new DiscoveryScheduler({
    store: exhausted, now: fixedNow('2026-11-03T10:00:00+08:00'),
    runPipeline: async () => { ran = true; return { processed: 1 } },
    pendingCount: () => 3,
  })
  const result = await second.tick()
  assert.equal(ran, false)
  assert.equal(result.budgetWait, true)
  const next = new Date(exhausted.read().nextRunAt)
  assert.equal(localDayKey(next), '2026-11-04')
  assert.equal(startOfNextLocalDay(new Date('2026-11-03T10:00:00+08:00')).getHours(), 0)
  assert.equal(exhausted.read().status, 'budget_wait')
})

test('队列为空时不空转，暂停/阻塞时不自动恢复', async () => {
  const idleStore = schedulerStore({ autoAnalyze: true, status: 'waiting', nextRunAt: '2026-11-03T08:00:00+08:00' })
  let ran = false
  const idle = new DiscoveryScheduler({ store: idleStore, now: fixedNow('2026-11-03T09:00:00+08:00'), runPipeline: async () => { ran = true; return {} }, pendingCount: () => 0 })
  const idleResult = await idle.tick()
  assert.equal(ran, false)
  assert.equal(idleResult.done, true)
  assert.equal(idleStore.read().nextRunAt, null)
  assert.equal(idleStore.read().status, 'completed')

  const pausedStore = schedulerStore({ autoSync: true, autoAnalyze: true, status: 'paused' })
  const paused = new DiscoveryScheduler({ store: pausedStore, now: fixedNow('2026-11-03T09:00:00+08:00'), runPipeline: async () => { ran = true; return {} }, pendingCount: () => 5 })
  const pausedResult = await paused.tick()
  assert.equal(ran, false)
  assert.equal(pausedResult.reason, 'paused')
})

test('瞬时错误有限退避，连续三次后阻塞；平台限制立即阻塞', async () => {
  const store = schedulerStore({ autoAnalyze: true, status: 'waiting', nextRunAt: '2026-11-03T08:00:00+08:00' })
  const now = fixedNow('2026-11-03T09:00:00+08:00')
  let attempts = 0
  const scheduler = new DiscoveryScheduler({
    store, now,
    runPipeline: async () => { attempts += 1; return { code: 'NETWORK_ERROR', aiCalls: 0, tokens: 0, remaining: 1 } },
    pendingCount: () => 2,
  })
  await scheduler.tick()
  assert.equal(store.read().status, 'waiting')
  assert.equal(store.read().attempts, 1)
  assert.equal(new Date(store.read().nextRunAt).getTime() - now().getTime(), 5 * 60 * 1000)
  now.set('2026-11-03T09:06:00+08:00')
  await scheduler.tick()
  assert.equal(store.read().attempts, 2)
  assert.equal(new Date(store.read().nextRunAt).getTime() - now().getTime(), 15 * 60 * 1000)
  now.set('2026-11-03T09:22:00+08:00')
  await scheduler.tick()
  assert.equal(store.read().status, 'blocked')
  assert.equal(store.read().attempts, 3)
  const blockedResult = await scheduler.tick()
  assert.equal(blockedResult.reason, 'blocked')

  const hardStore = schedulerStore({ autoAnalyze: true, status: 'waiting', nextRunAt: '2026-11-03T08:00:00+08:00' })
  const hard = new DiscoveryScheduler({ store: hardStore, now: fixedNow('2026-11-03T09:00:00+08:00'), runPipeline: async () => ({ stoppedBy: 'blocked', code: 'LOGIN_REQUIRED', aiCalls: 0, remaining: 1 }), pendingCount: () => 2 })
  await hard.tick()
  assert.equal(hardStore.read().status, 'blocked')
  assert.equal(hardStore.read().code, 'LOGIN_REQUIRED')
})

test('收藏夹同步失败按退避重试；验证码/登录失效立即暂停', async () => {
  const store = schedulerStore({ autoSync: true, autoAnalyze: true, status: 'waiting', nextSyncAt: '2026-11-03T08:00:00+08:00' })
  const now = fixedNow('2026-11-03T09:00:00+08:00')
  const scheduler = new DiscoveryScheduler({
    store, now,
    syncFavorites: async () => ({ ok: false, code: 'NETWORK_ERROR', reason: '网络中断' }),
    runPipeline: async () => ({ processed: 1, remaining: 0 }),
    pendingCount: () => 1,
  })
  const result = await scheduler.tick()
  assert.equal(result.syncFailed, true)
  assert.equal(store.read().lastRound.status, 'sync_failed')
  assert.equal(store.read().attempts, 1)

  const challengeStore = schedulerStore({ autoSync: true, status: 'waiting', nextSyncAt: '2026-11-03T08:00:00+08:00' })
  const challenge = new DiscoveryScheduler({ store: challengeStore, now, syncFavorites: async () => ({ ok: false, code: 'CHALLENGE', reason: '出现验证码' }), pendingCount: () => 1 })
  await challenge.tick()
  assert.equal(challengeStore.read().status, 'blocked')
  assert.equal(challengeStore.read().code, 'CHALLENGE')
  assert.match(challengeStore.read().lastError, /验证码/)
})

test('手动同步/分析也消耗每日预算，开关与状态持久化', async () => {
  const store = schedulerStore({ budget: { day: '2026-11-03', modelCalls: 0 } })
  const scheduler = new DiscoveryScheduler({ store, now: fixedNow('2026-11-03T09:00:00+08:00') })
  const configured = scheduler.configure({ autoSync: true, autoAnalyze: true })
  assert.equal(configured.autoSync, true)
  assert.equal(configured.autoAnalyze, true)
  assert.equal(configured.status, 'waiting')
  scheduler.accountManualRun({ aiCalls: 2, tokens: 500, processed: 1, comments: 5 })
  scheduler.accountManualSync({ ok: true })
  const state = store.read()
  assert.equal(state.budget.modelCalls, 2)
  assert.equal(state.budget.tokens, 500)
  assert.equal(state.budget.tokenSource, 'model_returned')
  assert.equal(state.budget.videos, 1)
  assert.equal(state.budget.comments, 5)
  assert.equal(state.budget.syncs, 1)
  const summary = scheduler.summary()
  assert.equal(summary.dailyLeft, 22)
  assert.equal(summary.budget.dailyLeft, 22)
})

test('调度状态跨实例保留，运行中被重启会转为可继续等待', () => {
  const store = schedulerStore({ autoSync: true, autoAnalyze: true, status: 'running' })
  const boot = new DiscoveryScheduler({ store, pendingCount: () => 4, now: fixedNow('2026-11-03T09:00:00+08:00') }).bootstrap()
  assert.equal(boot.state.status, 'waiting')
  assert.equal(boot.state.code, 'APP_RESTARTED')
  assert.match(boot.state.lastError, /重启/)
  assert.equal(boot.pending, 4)
})

test('历史人工标注只能作为非盲参考，且带免责说明', () => {
  const learning = learningOf({ EXPLICIT_INVITATION: 3, SEEKING_FRIENDS: 4, ORDINARY: 4 })
  learning.samples.forEach(sample => { sample.human = { intent: sample.ai.intent } })
  const reference = evaluateHumanLabels(learning, { videos: [video('v1')], comments: [] })
  assert.equal(reference.scope, 'all_human_labels')
  assert.match(reference.caveat, /非盲/)
  assert.equal(reference.evidenceSufficient, false)
})

// ── P2-12C 候选人发现等级 ───────────────────────────────────────────────────
function commentOf({ key, author, intent, evidence = [], text = '评论原文', videoId = 'v1' }) {
  return {
    key, author_id: author, author_name: `用户${author}`, text, video_id: videoId,
    created_at: '2026-11-01T10:00:00.000Z',
    classification: { intent, evidence, confidence: 0.8 },
  }
}

test('候选人等级 A/B/C/D 与私信同意证据门槛', () => {
  const library = {
    videos: [video('v1')],
    comments: [
      commentOf({ key: 'c1', author: 'a1', intent: 'EXPLICIT_INVITATION', evidence: ['想认识你'] }),
      commentOf({ key: 'c2', author: 'a2', intent: 'EXPLICIT_INVITATION', evidence: [] }),
      commentOf({ key: 'c3', author: 'a3', intent: 'SEEKING_FRIENDS' }),
      commentOf({ key: 'c4', author: 'a4', intent: 'CONTEXTUAL_INTEREST' }),
      commentOf({ key: 'c5', author: 'a5', intent: 'ORDINARY' }),
      commentOf({ key: 'c6', author: 'a5', intent: 'DO_NOT_CONTACT', evidence: ['别私信我'] }),
    ],
  }
  const { records, gradeCounts, rejectedCount } = candidateRecords(library)
  assert.equal(records.length, 4)
  const byAuthor = new Map(records.map(record => [record.platformUserId, record]))
  assert.equal(byAuthor.get('a1').discoveryGrade, 'A')
  assert.equal(byAuthor.get('a1').consentToDm, true, '明确邀请且有证据才允许私信')
  assert.equal(byAuthor.get('a2').discoveryGrade, 'A')
  assert.equal(byAuthor.get('a2').consentToDm, false, '没有可核对证据不得自动设置私信同意')
  assert.equal(byAuthor.get('a2').explicitInvitation, false)
  assert.equal(byAuthor.get('a3').discoveryGrade, 'B')
  assert.equal(byAuthor.get('a3').consentToDm, false)
  assert.equal(byAuthor.get('a4').discoveryGrade, 'C')
  assert.equal(byAuthor.get('a4').discoveryStatus, 'INSUFFICIENT_INFO')
  assert.ok(!byAuthor.has('a5'), '拒绝联系者不能进入候选记录')
  assert.equal(rejectedCount, 1)
  assert.equal(gradeCounts.A, 2)
  assert.equal(gradeCounts.B, 1)
  assert.equal(gradeCounts.C, 1)
  assert.equal(gradeCounts.D, 2, '普通评论与拒绝联系都计入 D 类统计')
  for (const record of records) {
    assert.equal(record.ageVerification, 'unknown')
    assert.equal(record.genderVerification, 'unknown')
    assert.equal(gradeOfIntent(record.libraryIntent), record.discoveryGrade)
  }
})

test('跨视频按 sec_uid 合并：保留全部来源、取最强意愿，但不覆盖人工确认资料', () => {
  const storage = createMemoryStorage()
  const manager = new CandidateManager(storage)
  const record = (author, intent, evidence, videoId) => ({
    nickname: `用户${author}`, profileUrl: `https://www.douyin.com/user/${author}`,
    platformUserId: author, platformUserIdType: 'sec_uid',
    libraryIntent: intent, discoveryGrade: gradeOfIntent(intent),
    discoveryStatus: intent === 'CONTEXTUAL_INTEREST' ? 'INSUFFICIENT_INFO' : 'DISCOVERED',
    libraryEvidence: evidence, consentToDm: intent === 'EXPLICIT_INVITATION' && evidence.length > 0,
    explicitInvitation: intent === 'EXPLICIT_INVITATION' && evidence.length > 0,
    intentConfidence: 0.7, commentTime: '2026-11-01T10:00:00.000Z',
    source: { type: 'comment', topic: '交友', keyword: '同城', videoId, commentText: `来自 ${videoId}` },
  })
  manager.upsert([record('a1', 'CONTEXTUAL_INTEREST', [], 'v1')], { accountId: 'acc' })
  const first = manager.get().candidates[0]
  manager.review(first.id, { status: 'APPROVED', genderConfirmation: 'female', ageConfirmation: 25 })
  manager.upsert([record('a1', 'SEEKING_FRIENDS', [], 'v2'), record('a1', 'EXPLICIT_INVITATION', ['想认识你'], 'v3')], { accountId: 'acc' })
  const merged = manager.get().candidates[0]
  assert.equal(merged.discoveryGrade, 'A')
  assert.equal(merged.libraryIntent, 'EXPLICIT_INVITATION')
  assert.equal(merged.consentToDm, true)
  assert.equal(merged.sources.length, 3, '所有视频来源都要保留')
  assert.equal(merged.ageVerification, 'manual', '人工确认的年龄不能被新证据覆盖，且来源标为人工核实')
  assert.equal(merged.genderVerification, 'manual')
  assert.equal(merged.status, 'APPROVED', '人工审核状态不能被自动覆盖')
})

test('拒绝联系优先级最高：后续积极评论也不能把拒绝者放回候选池', () => {
  const storage = createMemoryStorage()
  const manager = new CandidateManager(storage)
  const record = (author, intent, evidence, videoId) => ({
    nickname: `用户${author}`, profileUrl: `https://www.douyin.com/user/${author}`,
    platformUserId: author, platformUserIdType: 'sec_uid',
    libraryIntent: intent, discoveryGrade: gradeOfIntent(intent), discoveryStatus: 'DISCOVERED',
    libraryEvidence: evidence, consentToDm: intent === 'EXPLICIT_INVITATION' && evidence.length > 0,
    explicitInvitation: false, intentConfidence: 0.7,
    source: { type: 'comment', topic: '交友', keyword: '同城', videoId, commentText: `来自 ${videoId}` },
  })
  manager.upsert([record('a9', 'ORDINARY', [], 'v1')], { accountId: 'acc' })
  const candidate = manager.get().candidates[0]
  manager.review(candidate.id, { status: 'REJECTED', note: '用户明确拒绝联系' })
  const rejected = manager.get().candidates[0]
  assert.equal(rejected.status, 'REJECTED')
  assert.equal(rejected.discoveryGrade, 'D')
  assert.equal(rejected.discoveryStatus, 'REJECTED')
  assert.equal(rejected.consentToDm, false)
  manager.upsert([record('a9', 'EXPLICIT_INVITATION', ['想认识你'], 'v2')], { accountId: 'acc' })
  const after = manager.get().candidates[0]
  assert.equal(after.status, 'REJECTED')
  assert.equal(after.discoveryGrade, 'D')
  assert.equal(after.consentToDm, false)
  assert.equal(after.explicitInvitation, false)
  assert.equal(after.libraryIntent, 'ORDINARY', '拒绝状态不因新评论升级意愿')
  assert.equal(after.sources.length, 2, '仍保留新来源作为审计证据')
})

// ── P2-12E 收藏夹配置：配置缺失 ≠ 页面未打开 ────────────────────────────────
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FavoritesSyncService } = require('../electron/discovery/favorites-sync.cjs')
const { LibraryStore } = require('../electron/social-brain/library-store.cjs')
const { BenchmarkStore } = require('../electron/social-brain/library-benchmark.cjs')
const { LearningStore } = require('../electron/social-brain/comment-learning.cjs')

function tempLibrary() {
  return new LibraryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'p212e-')))
}

test('收藏夹名称保存后可从磁盘读回，自动同步不依赖先跑一次同步', () => {
  const store = tempLibrary()
  const dir = store.dir
  store.setFavorites({ folderName: '交友收藏' })
  const reopened = new LibraryStore(dir)
  assert.equal(reopened.favoritesState().folderName, '交友收藏')
  assert.equal(reopened.favoritesState().folderName, store.favoritesState().folderName)
})

test('收藏夹名称为空返回 CONFIG_MISSING，且不覆盖已保存名称', async () => {
  const store = tempLibrary()
  store.setFavorites({ folderName: '交友收藏' })
  const douyin = { storage: createMemoryStorage(), partition: 'persist:p212e', accountId: 'acc' }
  const service = new FavoritesSyncService(douyin, { accountId: 'acc', store })
  const result = await service.run({ folderName: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONFIG_MISSING')
  assert.equal(store.favoritesState().folderName, '交友收藏', '空名称不能覆盖已保存配置')
  assert.equal(store.favoritesState().status, 'idle', '配置缺失不写入失败状态')
})

test('页面未打开返回 FOLDER_NOT_OPENED，不会被误报为配置缺失', async () => {
  const store = tempLibrary()
  store.setFavorites({ folderName: '交友收藏' })
  const douyin = { storage: createMemoryStorage(), partition: 'persist:p212e', accountId: 'acc' }
  const service = new FavoritesSyncService(douyin, { accountId: 'acc', store })
  service.createTransport = () => ({ prepare: async () => ({ ok: false, code: 'FOLDER_NOT_OPENED', reason: '打开收藏夹后没有看到作品列表' }) })
  const result = await service.run({ folderName: '交友收藏' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FOLDER_NOT_OPENED')
  assert.notEqual(result.code, 'CONFIG_MISSING')
  assert.equal(store.favoritesState().status, 'failed')
  assert.equal(store.favoritesState().code, 'FOLDER_NOT_OPENED')
})

test('主进程/预加载/界面已接入收藏夹名称保存与配置缺失提示', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'dist', 'app.js'), 'utf8')
  assert.match(main, /library:set-favorites-folder/)
  assert.match(main, /store\.setFavorites\(\{ folderName: name \}\)/)
  assert.match(preload, /saveFavoritesFolder/)
  assert.match(app, /favorites-save-folder/)
  assert.match(app, /配置缺失：收藏夹名称尚未保存/)
})

test('盲评标注持久化：重启后继续剩余队列，人工标签不覆盖模型分类', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p212e-bm-'))
  const learning = learningOf({ EXPLICIT_INVITATION: 5, SEEKING_FRIENDS: 20, CONTEXTUAL_INTEREST: 25, ORDINARY: 25, ADVERTISEMENT: 3, UNKNOWN: 5 })
  const lstore = new LearningStore(dir)
  lstore.save(learning)
  const bstore = new BenchmarkStore(dir)
  const created = createBenchmarkSet({ learning: lstore.read(), library: { videos: [video('v1')], comments: [] }, size: DEFAULT_SIZE, previous: bstore.read() })
  bstore.save(created.state)
  const key = created.set.keys[0]
  const beforeAi = lstore.read().samples.find(sample => sample.key === key).ai
  lstore.annotate(key, { intent: 'SEEKING_FRIENDS', useForTraining: false })

  // 模拟程序重启：重新从磁盘读取学习库与基准集。
  const reopenedLearning = new LearningStore(dir).read()
  const reopenedBenchmark = new BenchmarkStore(dir).read()
  const view = buildView(reopenedBenchmark, reopenedLearning)
  assert.equal(view.labeled, 1)
  assert.equal(view.remaining, created.set.keys.length - 1)
  assert.ok(!view.queue.some(item => item.key === key), '已标注的条目不再出现在待标注队列')

  const sample = reopenedLearning.samples.find(item => item.key === key)
  assert.equal(sample.human.intent, 'SEEKING_FRIENDS')
  assert.equal(sample.human.source, 'user')
  assert.deepEqual(sample.ai, beforeAi, '人工标签不覆盖模型分类与证据')
  // 盲评视图仍然不泄漏模型分类或作者身份。
  assert.ok(!('ai' in view.queue[0]) && !('confidence' in view.queue[0]) && !('authorId' in view.queue[0]))
})
