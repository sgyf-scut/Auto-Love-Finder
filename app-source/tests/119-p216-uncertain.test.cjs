// P2-16 专项一：结果未知（平台已执行但回执丢失）绝不能被自动重试。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LibraryStore, normalizeAutoContact } = require('../electron/social-brain/library-store.cjs')
const { AutoContactQueue, classifyFailure, CONFIRMED_NOT_EXECUTED_CODES } = require('../electron/discovery/auto-contact.cjs')

function seedStore(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p216-uncertain-'))
  const store = new LibraryStore(dir)
  const library = store.read()
  library.videos = [{ key: 'video_1', video_id: 'v1', video_url: 'https://www.douyin.com/video/v1', title: '同城交友', source: 'favorites', favoritesFolder: '恋爱视频' }]
  library.comments = [{
    key: 'comment_1', comment_id: 'c1', video_id: 'v1', author_id: 'sec_1', author_name: '小美', text: '想认识一下',
    classification: { intent: 'SEEKING_FRIENDS', reviewedByUser: true, evidence: ['想认识'], inputHash: 'h1' },
  }]
  store.save(library)
  store.setAutoContact({
    mode: 'auto', riskAcceptedAt: '2026-11-04T00:00:00.000Z', realActionsAuthorized: true,
    config: { ...normalizeAutoContact({}).config, autoFollow: true, autoFirstMessage: false, dailyFollowLimit: 5, maxAttempts: 2, ...over },
  })
  return { dir, store }
}

const candidateOf = (over = {}) => ({
  id: 'candidate_1', accountId: 'acc', platformUserId: 'sec_1',
  profileUrl: 'https://www.douyin.com/user/sec_1', nickname: '小美',
  status: 'DISCOVERED', discoveryStatus: 'DISCOVERED', discoveryGrade: 'B', libraryIntent: 'SEEKING_FRIENDS',
  publicSignals: { genderText: '女', age: 24, followerCount: 120 },
  source: { commentId: 'c1', videoId: 'v1', commentText: '想认识一下' },
  ...over,
})

function queued(store) {
  const queue = new AutoContactQueue({ store })
  const enqueued = queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  assert.equal(enqueued.followAdded, 1)
  return queue
}

const followTask = store => store.autoContactState().queues.follow[0]
const executedFollow = store => Object.values(store.autoContactState().executed.follow)[0] || null

test('P2-16-01 执行器抛超时：记为结果未知，而不是失败或完成', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  let calls = 0
  const run = await queue.run({
    dryRun: false,
    executor: async () => { calls++; const error = new Error('ETIMEDOUT'); error.code = 'ETIMEDOUT'; throw error },
  })
  assert.equal(calls, 1)
  const task = followTask(store)
  assert.equal(task.status, 'uncertain')
  assert.equal(task.reasonCode, 'EXECUTOR_ERROR')
  assert.equal(task.outcome, 'UNCERTAIN')
  assert.equal(task.realAction, true)
  assert.equal(task.simulated, false)
  assert.equal(executedFollow(store).status, 'uncertain')
  assert.equal(run.counts.uncertain, 1)
  // 结果未知不能占用每日真实额度。
  assert.equal(store.autoContactState().budget.realFollows, 0)
})

test('P2-16-02 下一轮调度不会重发结果未知的任务', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  let calls = 0
  const executor = async () => { calls++; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }
  await queue.run({ dryRun: false, executor })
  const second = await queue.run({ dryRun: false, executor })
  assert.equal(calls, 1, '结果未知后不得再次调用执行器')
  assert.equal(second.results.some(item => item.reasonCode === 'UNCERTAIN_NEEDS_REVIEW'), true, '必须显式报出待人工核对')
  assert.equal(followTask(store).attempts, 1)
})

test('P2-16-03 重启恢复后结果未知的任务仍然不重试', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  let calls = 0
  await queue.run({ dryRun: false, executor: async () => { calls++; throw new Error('timeout') } })
  // 模拟进程重启：全新的 store 与队列实例。
  const reopened = new LibraryStore(store.dir)
  const restarted = new AutoContactQueue({ store: reopened })
  const run = await restarted.run({ dryRun: false, executor: async () => { calls++ } })
  assert.equal(calls, 1, '重启后不得重试结果未知的任务')
  assert.equal(run.counts.real, 0)
  assert.equal(followTask(reopened).status, 'uncertain')
})

test('P2-16-04 执行中进程中断：落盘的 running 会被判定为结果未知', () => {
  const { store } = seedStore()
  queued(store)
  const state = store.autoContactState()
  const task = state.queues.follow[0]
  // 模拟"调用平台时进程被杀"：磁盘上仍是 running，且时间已经过去很久。
  store.setAutoContact({ queues: { ...state.queues, follow: [{ ...task, status: 'running', startedAt: '2026-11-01T00:00:00.000Z' }] } })
  const later = () => '2026-11-02T00:00:00.000Z'
  const reopened = new AutoContactQueue({ store: new LibraryStore(store.dir), now: later })
  const recovered = reopened.inFlight.recovered
  assert.equal(recovered.length, 1)
  const after = reopened.state()
  assert.equal(after.queues.follow[0].status, 'uncertain')
  assert.equal(after.queues.follow[0].reasonCode, 'INTERRUPTED_IN_FLIGHT')
  assert.equal(after.executed.follow[after.queues.follow[0].taskId].status, 'uncertain')
})

test('P2-16-05 刚开始执行的任务不会被误判为中断', () => {
  const { store } = seedStore()
  queued(store)
  const state = store.autoContactState()
  const task = state.queues.follow[0]
  store.setAutoContact({ queues: { ...state.queues, follow: [{ ...task, status: 'running', startedAt: '2026-11-05T10:00:00.000Z' }] } })
  const reopened = new AutoContactQueue({ store: new LibraryStore(store.dir), now: () => '2026-11-05T10:00:30.000Z' })
  assert.equal(reopened.inFlight.recovered.length, 0)
  assert.equal(reopened.state().queues.follow[0].status, 'running')
})

test('P2-16-06 只有确认未执行的失败才允许重试', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  let calls = 0
  const run = await queue.run({
    dryRun: false,
    executor: async () => { calls++; return { ok: false, executed: false, reasonCode: 'PREFLIGHT_BLOCKED', reason: '主页打不开，未点击关注' } },
  })
  assert.equal(calls, 1)
  assert.equal(followTask(store).status, 'pending')
  assert.equal(followTask(store).attempts, 1)
  assert.equal(run.results[0].status, 'pending')
  assert.equal(executedFollow(store), null)
})

test('P2-16-07 未知失败一律按结果未知处理，不进入重试', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  await queue.run({ dryRun: false, executor: async () => ({ ok: false, reasonCode: 'EXECUTION_FAILED' }) })
  assert.equal(followTask(store).status, 'uncertain')
  assert.equal(classifyFailure({ reasonCode: 'EXECUTION_FAILED' }), 'uncertain')
  assert.equal(classifyFailure({ reasonCode: 'PREFLIGHT_BLOCKED' }), 'not_executed')
  assert.equal(classifyFailure({ reasonCode: 'WHATEVER', executed: true }), 'executed_but_failed')
  assert.equal(CONFIRMED_NOT_EXECUTED_CODES.has('PREFLIGHT_BLOCKED'), true)
})

test('P2-16-08 确认未执行的失败会重试到上限后停止', async () => {
  const { store } = seedStore({ maxAttempts: 2 })
  const queue = queued(store)
  let calls = 0
  const executor = async () => { calls++; return { ok: false, executed: false, reasonCode: 'TARGET_UNAVAILABLE' } }
  await queue.run({ dryRun: false, executor })
  await queue.run({ dryRun: false, executor })
  await queue.run({ dryRun: false, executor })
  assert.equal(calls, 2, '达到上限后不得继续重试')
  assert.equal(followTask(store).status, 'failed')
  assert.equal(followTask(store).attempts, 2)
  assert.equal(followTask(store).reasonCode, 'TARGET_UNAVAILABLE', '保留真实失败原因，便于排查')
})

test('P2-16-09 人工确认未执行后才能重新排队', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  let calls = 0
  await queue.run({ dryRun: false, executor: async () => { calls++; throw new Error('timeout') } })
  const taskId = followTask(store).taskId
  const resolved = queue.resolveUncertain({ taskId, action: 'follow', decision: 'not_executed', note: '已核对主页，未关注' })
  assert.equal(resolved.ok, true)
  assert.equal(followTask(store).status, 'pending')
  assert.equal(followTask(store).attempts, 0)
  assert.equal(followTask(store).resolution, 'manual_not_executed')
  assert.equal(Object.keys(store.autoContactState().executed.follow).length, 0)
  const run = await queue.run({ dryRun: false, executor: async () => { calls++; return { ok: true } } })
  assert.equal(calls, 2)
  assert.equal(run.counts.real, 1)
})

test('P2-16-10 人工确认已执行则按完成记账，不再重发', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  let calls = 0
  await queue.run({ dryRun: false, executor: async () => { calls++; throw new Error('timeout') } })
  const taskId = followTask(store).taskId
  const resolved = queue.resolveUncertain({ taskId, action: 'follow', decision: 'executed', note: '主页显示已关注' })
  assert.equal(resolved.ok, true)
  assert.equal(followTask(store).status, 'done')
  assert.equal(followTask(store).reasonCode, 'MANUAL_CONFIRMED_EXECUTED')
  const run = await queue.run({ dryRun: false, executor: async () => { calls++ } })
  assert.equal(calls, 1)
  assert.equal(run.counts.real, 0)
})

test('P2-16-11 结果未知的记录阻止同任务重复入队', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  await queue.run({ dryRun: false, executor: async () => { throw new Error('timeout') } })
  const again = queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  assert.equal(again.followAdded, 0)
  assert.equal(again.duplicated, 1)
})

test('P2-16-12 人工裁决只接受明确决定，非法输入被拒绝', () => {
  const { store } = seedStore()
  const queue = queued(store)
  assert.equal(queue.resolveUncertain({ taskId: followTask(store).taskId, decision: 'maybe' }).error, 'INVALID_DECISION')
  assert.equal(queue.resolveUncertain({ taskId: 'nope', decision: 'executed' }).error, 'TASK_NOT_FOUND')
})

test('P2-16-13 Dry Run 不产生结果未知记录，也不写执行中标记', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  await queue.run({ dryRun: true })
  const task = followTask(store)
  assert.equal(task.status, 'done')
  assert.equal(task.simulated, true)
  assert.equal(task.startedAt, null)
  assert.equal(store.autoContactState().executed.follow[task.taskId].simulated, true)
})
