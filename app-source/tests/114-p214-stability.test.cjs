// P2-14E 连续运行稳定性：离线加速模拟（不连接平台、不执行任何真实外发）。
// 覆盖：每日预算重置、空队列不空转、重启恢复、多账号隔离、紧急停止、连续 7 日模拟。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LibraryStore, normalizeAutoContact } = require('../electron/social-brain/library-store.cjs')
const { AutoContactQueue } = require('../electron/discovery/auto-contact.cjs')

function seed(count = 1, dailyFollowLimit = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p214-stab-'))
  const store = new LibraryStore(dir)
  const library = store.read()
  library.videos = []
  library.comments = []
  for (let i = 1; i <= count; i += 1) {
    library.videos.push({ key: `video_${i}`, video_id: `v${i}`, video_url: `https://www.douyin.com/video/v${i}`, title: '同城交友认识新朋友' })
    library.comments.push({ key: `comment_${i}`, comment_id: `c${i}`, video_id: `v${i}`, author_id: `sec_${i}`, author_name: `用户${i}`, text: '想认识你，方便私信聊聊吗', classification: { intent: 'EXPLICIT_INVITATION', reviewedByUser: true, evidence: ['方便私信'], inputHash: 'reviewed' } })
  }
  store.save(library)
  store.setAutoContact({ mode: 'auto', riskAcceptedAt: '2026-11-01T00:00:00.000Z', realActionsAuthorized: true, config: { ...normalizeAutoContact({}).config, autoFollow: true, autoFirstMessage: false, dailyFollowLimit } })
  return { dir, store, library: store.read() }
}
const candidate = i => ({ id: `candidate_${i}`, accountId: 'acc', platformUserId: `sec_${i}`, profileUrl: `https://www.douyin.com/user/sec_${i}`, nickname: `用户${i}`, status: 'DISCOVERED', discoveryStatus: 'DISCOVERED', discoveryGrade: 'A', libraryIntent: 'EXPLICIT_INVITATION', consentToDm: true, explicitInvitation: true, publicSignals: { genderText: '女', age: 24 }, source: { commentId: `c${i}`, videoId: `v${i}`, commentText: '想认识你，方便私信聊聊吗' } })
const dayOf = day => `${day}T09:00:00.000Z`

test('STAB-1 每日预算在跨日后自动重置', async () => {
  const { store } = seed(2, 1)
  const queue = new AutoContactQueue({ store, now: () => dayOf('2026-11-03') })
  queue.enqueue(queue.plan({ candidates: [candidate(1)] }).plans)
  const first = await queue.run({ dryRun: true })
  assert.equal(first.state.budget.follows, 1, '首日只用 1 个关注额度')
  assert.equal(first.state.budget.day, '2026-11-03')
  const next = new AutoContactQueue({ store, now: () => dayOf('2026-11-04') })
  next.enqueue(next.plan({ candidates: [candidate(2)] }).plans)
  const second = await next.run({ dryRun: true })
  assert.equal(second.state.budget.day, '2026-11-04')
  assert.equal(second.state.budget.follows, 1, '跨日后额度重置，第二条任务可执行')
})

test('STAB-2 没有新任务时不空转，也不调用执行器', async () => {
  const { store } = seed(1)
  let calls = 0
  const queue = new AutoContactQueue({ store })
  const run = await queue.run({ dryRun: false, executor: () => { calls += 1; return { ok: true } } })
  assert.equal(run.ok, true)
  assert.equal(run.results.filter(item => item.status === 'done').length, 0, '空队列不产生执行记录')
  assert.equal(calls, 0, '空队列绝不调用执行器')
  assert.equal(run.state.budget.follows, 0)
})

test('STAB-3 进程重启后队列、预算与已执行记录完整保留', async () => {
  const { store } = seed(2)
  const queue = new AutoContactQueue({ store, now: () => dayOf('2026-11-03') })
  queue.enqueue(queue.plan({ candidates: [candidate(1), candidate(2)] }).plans)
  await queue.run({ dryRun: true, limit: 1 })
  const restarted = new AutoContactQueue({ store, now: () => dayOf('2026-11-03') })
  const state = restarted.state()
  assert.equal(state.budget.follows, 1)
  assert.equal(Object.keys(state.executed.follow).length, 1)
  assert.equal(state.queues.follow.filter(task => task.status === 'pending').length, 1, '未完成任务保留')
  const again = await restarted.run({ dryRun: true })
  assert.equal(again.results.filter(item => item.status === 'done').length, 1, '重启后继续处理剩余任务')
  assert.equal(again.state.budget.follows, 2)
  const third = await new AutoContactQueue({ store, now: () => dayOf('2026-11-03') }).run({ dryRun: true })
  assert.equal(third.results.filter(item => item.status === 'done').length, 0, '全部完成后不再重复执行')
})

test('STAB-4 多账号各自独立：队列、预算和已执行记录互不串用', async () => {
  const a = seed(1)
  const b = seed(1)
  const queueA = new AutoContactQueue({ store: a.store, now: () => dayOf('2026-11-03') })
  queueA.enqueue(queueA.plan({ candidates: [candidate(1)] }).plans)
  await queueA.run({ dryRun: true })
  const stateB = b.store.autoContactState()
  assert.equal(stateB.queues.follow.length, 0, '账号 B 不受账号 A 入队影响')
  assert.equal(Object.keys(stateB.executed.follow).length, 0, '账号 B 没有账号 A 的执行记录')
})

test('STAB-5 紧急停止跨重启仍生效，恢复后才继续', async () => {
  const { store } = seed(1)
  const queue = new AutoContactQueue({ store })
  queue.stop('用户紧急停止')
  const restarted = new AutoContactQueue({ store })
  assert.equal((await restarted.run({ dryRun: true })).error, 'EMERGENCY_STOPPED', '重启后仍是停止状态')
  restarted.recover()
  const resumed = await restarted.run({ dryRun: true })
  assert.equal(resumed.ok, true)
  assert.equal(restarted.state().status !== 'stopped', true)
})

test('STAB-6 连续 7 日加速模拟：每日一条关注、无真实外发、预算逐日独立', async () => {
  const { store } = seed(7)
  const library = store.read()
  let totalFollow = 0
  const daily = []
  for (let day = 3; day <= 9; day += 1) {
    const stamp = dayOf(`2026-11-${String(day).padStart(2, '0')}`)
    const queue = new AutoContactQueue({ store, now: () => stamp })
    queue.enqueue(queue.plan({ candidates: [candidate(day - 2)] }).plans)
    const run = await queue.run({ dryRun: true })
    assert.equal(run.ok, true)
    assert.equal(run.dryRun, true)
    const done = run.results.filter(item => item.action === 'follow' && item.status === 'done')
    assert.equal(done.length, 1, '每天只处理 1 条关注计划')
    assert.equal(done.every(item => item.dryRun === true), true, '全部 Dry Run，无真实外发')
    assert.equal(run.state.budget.day, stamp.slice(0, 10))
    assert.equal(run.state.budget.follows, 1)
    totalFollow += done.length
    daily.push({ day: stamp.slice(0, 10), follows: run.state.budget.follows, messages: run.state.budget.messages, pending: run.state.queues.follow.filter(task => task.status === 'pending').length })
  }
  assert.equal(totalFollow, 7)
  assert.equal(Object.keys(store.autoContactState().executed.follow).length, 7)
  assert.equal(library.comments.length, 7, '模拟过程不修改评论与素材库')
})
