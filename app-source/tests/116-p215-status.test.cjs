// P2-15：模拟 / 真实 / 不确定状态必须可区分，模拟不得污染真实执行记录与额度。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LibraryStore, normalizeAutoContact } = require('../electron/social-brain/library-store.cjs')
const { AutoContactQueue, recordRealness, POLICY_VERSION } = require('../electron/discovery/auto-contact.cjs')

const COMMENT_TEXT = '想认识你，方便私信聊聊吗'
function seedStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p215-'))
  const store = new LibraryStore(dir)
  const library = store.read()
  library.videos = [{ key: 'video_1', video_id: 'v1', video_url: 'https://www.douyin.com/video/v1', title: '同城交友认识新朋友', source: 'favorites', favoritesFolder: '恋爱视频' }]
  library.comments = [{
    key: 'comment_1', comment_id: 'c1', video_id: 'v1', author_id: 'sec_1', author_name: '小美', text: COMMENT_TEXT,
    classification: { intent: 'EXPLICIT_INVITATION', reviewedByUser: true, evidence: ['方便私信'], inputHash: 'old-hash' },
  }]
  store.save(library)
  store.setAutoContact({
    mode: 'auto', riskAcceptedAt: '2026-11-04T00:00:00.000Z', realActionsAuthorized: true,
    config: { ...normalizeAutoContact({}).config, autoFollow: true, autoFirstMessage: true, dailyFollowLimit: 5, dailyFirstMessageLimit: 5 },
  })
  return { dir, store }
}
const candidateOf = (over = {}) => ({
  id: 'candidate_1', accountId: 'acc', platformUserId: 'sec_1',
  profileUrl: 'https://www.douyin.com/user/sec_1', nickname: '小美',
  status: 'DISCOVERED', discoveryStatus: 'DISCOVERED', discoveryGrade: 'A', libraryIntent: 'EXPLICIT_INVITATION',
  consentToDm: true, explicitInvitation: true,
  publicSignals: { genderText: '女', age: 24, followerCount: 120 },
  source: { commentId: 'c1', videoId: 'v1', commentText: COMMENT_TEXT },
  ...over,
})
const queued = (store, over = {}) => {
  const queue = new AutoContactQueue({ store })
  const enqueued = queue.enqueue(queue.plan({ candidates: [candidateOf(over)] }).plans)
  assert.equal(enqueued.followAdded, 1)
  return queue
}

test('P2-15-12 模拟完成写入 simulated 标记，不写成真实完成', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  const run = await queue.run({ dryRun: true })
  assert.equal(run.dryRun, true)
  const record = store.autoContactState().executed.follow[Object.keys(store.autoContactState().executed.follow)[0]]
  assert.equal(record.status, 'done')
  assert.equal(record.simulated, true)
  assert.equal(record.realAction, false)
  assert.equal(record.outcome, 'SIMULATED')
  assert.equal(recordRealness(record), 'simulated')
  assert.equal(run.counts.simulated >= 1, true)
  assert.equal(run.counts.real, 0)
})

test('P2-15-13 模拟记录不阻止真实执行，队列任务回到待执行', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  await queue.run({ dryRun: true })
  const calls = []
  const again = await queue.run({ dryRun: false, onlyAction: 'follow', executor: payload => { calls.push(payload); return { ok: true } } })
  assert.equal(again.dryRun, false)
  assert.equal(calls.length, 1, '模拟完成后真实执行仍应发生一次')
  const records = Object.values(store.autoContactState().executed.follow)
  assert.equal(records.length, 1)
  assert.equal(records[0].simulated, false)
  assert.equal(records[0].realAction, true)
  assert.equal(records[0].outcome, 'CONFIRMED')
})

test('P2-15-14 真实执行缺少执行器时返回阻塞，绝不记录成功', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  const run = await queue.run({ dryRun: false, onlyAction: 'follow', executor: null })
  assert.equal(run.ok, false)
  assert.equal(run.error, 'EXECUTOR_MISSING')
  const state = store.autoContactState()
  assert.equal(Object.keys(state.executed.follow).length, 0)
  assert.equal(state.queues.follow[0].status, 'pending', '任务保持待执行，不伪造完成')
  assert.equal(state.budget.realFollows, 0)
})

test('P2-15-15 执行器异常记为结果不确定，禁止自动重发', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  let calls = 0
  const first = await queue.run({ dryRun: false, onlyAction: 'follow', executor: () => { calls++; throw new Error('页面已消失') } })
  assert.equal(calls, 1)
  assert.equal(first.results[0].status, 'uncertain')
  const record = Object.values(store.autoContactState().executed.follow)[0]
  assert.equal(record.status, 'uncertain')
  assert.equal(record.realAction, true)
  assert.equal(record.outcome, 'UNCERTAIN')
  const second = await queue.run({ dryRun: false, onlyAction: 'follow', executor: () => { calls++; return { ok: true } } })
  assert.equal(calls, 1, '结果不确定后不得再次调用执行器')
  assert.equal(second.results.filter(item => item.status === 'done').length, 0)
  assert.equal(store.autoContactState().budget.realFollows, 0)
})

test('P2-15-16 未标记的旧记录按结果不明处理，需人工核对', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  const taskId = Object.keys(queue.state().queues.follow.reduce((acc, task) => ({ ...acc, [task.taskId]: task }), {}))[0]
  const legacy = { ...queue.state().queues.follow[0], status: 'done', simulated: false, realAction: false, dryRun: false }
  assert.equal(recordRealness(legacy), 'unknown')
  store.setAutoContact({ executed: { follow: { [taskId]: legacy }, firstMessage: {} } })
  let calls = 0
  const run = await queue.run({ dryRun: false, onlyAction: 'follow', executor: () => { calls++; return { ok: true } } })
  assert.equal(calls, 0, '旧记录不能当成真实完成，也不能盲目重发')
  assert.ok(run.results.some(item => item.reasonCode === 'LEGACY_RECORD_UNCONFIRMED'))
})

test('P2-15-17 真实首次私信必须建立在真实关注之上', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  // 只模拟关注，然后尝试真实私信：没有真实关注记录，必须拦截。
  await queue.run({ dryRun: true, onlyAction: 'follow' })
  const calls = []
  const run = await queue.run({ dryRun: false, onlyAction: 'firstMessage', executor: payload => { calls.push(payload); return { ok: true } } })
  assert.equal(calls.length, 0, '模拟关注不能作为真实私信的前置条件')
  assert.ok(run.results.some(item => item.reasonCode === 'FOLLOW_NOT_DONE'))
})

test('P2-15-18 模拟额度与真实额度分开累计', async () => {
  const { store } = seedStore()
  const queue = queued(store)
  await queue.run({ dryRun: true, onlyAction: 'follow' })
  await queue.run({ dryRun: false, onlyAction: 'follow', executor: () => ({ ok: true }) })
  const budget = store.autoContactState().budget
  assert.equal(budget.realFollows, 1, '真实额度只统计真实执行')
  assert.equal(budget.simulatedFollows, 1)
  assert.equal(budget.follows, 2, '总次数仍统计两种执行，便于审计')
})

test('P2-15-19 状态字段可持久化并在重启后保持', async () => {
  const { dir, store } = seedStore()
  const queue = queued(store)
  await queue.run({ dryRun: true, onlyAction: 'follow' })
  const reopened = new LibraryStore(dir)
  const record = Object.values(reopened.autoContactState().executed.follow)[0]
  assert.equal(record.simulated, true)
  assert.equal(record.realAction, false)
  assert.equal(reopened.autoContactState().policyVersion, POLICY_VERSION)
})
