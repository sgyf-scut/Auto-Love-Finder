// P2-13：双模式与正式自动联系的安全边界、幂等、预算与 Dry Run。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LibraryStore, normalizeAutoContact } = require('../electron/social-brain/library-store.cjs')
const { normalizeCandidateAction } = require('../electron/discovery/candidate-manager.cjs')
const { candidateRecords } = require('../electron/social-brain/library-candidates.cjs')
const {
  AutoContactQueue, planCandidates, evaluateCandidate, taskIdOf, POLICY_VERSION,
} = require('../electron/discovery/auto-contact.cjs')

const COMMENT_TEXT = '想认识你，方便私信聊聊吗'
function seedStore({ intent = 'EXPLICIT_INVITATION', text = COMMENT_TEXT, reviewedByUser = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p213-'))
  const store = new LibraryStore(dir)
  const library = store.read()
  library.videos = [{ key: 'video_1', video_id: 'v1', video_url: 'https://www.douyin.com/video/v1', title: '同城交友认识新朋友', source: 'favorites', favoritesFolder: '恋爱视频' }]
  library.comments = [{
    key: 'comment_1', comment_id: 'c1', video_id: 'v1', author_id: 'sec_1', author_name: '小美', text,
    classification: { intent, reviewedByUser, evidence: ['方便私信'], inputHash: 'old-hash' },
  }]
  store.save(library)
  return { dir, store }
}
function candidateOf(over = {}) {
  return {
    id: 'candidate_1', accountId: 'acc', platformUserId: 'sec_1',
    profileUrl: 'https://www.douyin.com/user/sec_1', nickname: '小美',
    status: 'DISCOVERED', discoveryStatus: 'DISCOVERED', discoveryGrade: 'A',
    libraryIntent: 'EXPLICIT_INVITATION', consentToDm: true, explicitInvitation: true,
    publicSignals: { genderText: '女', age: 24, followerCount: 120 },
    source: { commentId: 'c1', videoId: 'v1', commentText: COMMENT_TEXT },
    ...over,
  }
}
const baseConfig = over => ({ ...normalizeAutoContact({}).config, ...over })
function autoReady(store, config = {}) {
  const current = store.autoContactState()
  store.setAutoContact({
    mode: 'auto', riskAcceptedAt: '2026-11-03T00:00:00.000Z', realActionsAuthorized: true,
    config: { ...current.config, autoFollow: true, autoFirstMessage: true, dailyFollowLimit: 5, dailyFirstMessageLimit: 5, ...config },
  })
}

test('训练模式绝不执行关注或私信，队列也不会入队', async () => {
  const { store } = seedStore()
  const queue = new AutoContactQueue({ store })
  assert.equal(store.autoContactState().mode, 'training')
  const plan = queue.plan({ candidates: [candidateOf()] })
  assert.equal(plan.summary.follow, 1, '训练模式仍可生成候选与计划')
  const enqueued = queue.enqueue(plan.plans)
  assert.equal(enqueued.followAdded, 0, '训练模式不得入队关注')
  assert.equal(enqueued.firstMessageAdded, 0, '训练模式不得入队私信')
  const run = await queue.run({ dryRun: true, executor: null })
  assert.equal(run.ok, false)
  assert.equal(run.error, 'NOT_AUTO_MODE')
})

test('正式模式自动生成候选人执行计划，并生成可追溯首次消息计划', () => {
  const { store } = seedStore()
  autoReady(store)
  const { plans, summary } = planCandidates([candidateOf()], { library: store.read(), config: baseConfig() })
  assert.equal(summary.follow, 1)
  assert.equal(summary.firstMessage, 1)
  const plan = plans[0]
  assert.equal(plan.follow.status, 'planned')
  assert.ok(String(plan.firstMessage.consentEvidenceId || '').includes('c1'), '同意证据必须可追溯到原始评论')
  assert.match(plan.firstMessage.message.text, /小美/)
  assert.match(plan.firstMessage.message.text, /同城交友/)
})

test('不符合条件、无作者 ID 的候选人不会进入自动执行队列', () => {
  const { store } = seedStore()
  const library = store.read()
  const missing = evaluateCandidate(candidateOf({ platformUserId: '', profileUrl: null }), { library, config: baseConfig() })
  assert.equal(missing.follow.status, 'blocked')
  assert.equal(missing.follow.reasonCode, 'MISSING_AUTHOR_ID')
  const excluded = evaluateCandidate(candidateOf({ discoveryStatus: 'EXCLUDED' }), { library, config: baseConfig() })
  assert.equal(excluded.follow.reasonCode, 'EXCLUDED')
  const queue = new AutoContactQueue({ store })
  const enqueued = queue.enqueue([missing, excluded])
  assert.equal(enqueued.followAdded + enqueued.firstMessageAdded, 0)
})

test('普通交友意愿不会被误判为私信授权', () => {
  const { store } = seedStore({ intent: 'SEEKING_FRIENDS', text: '想找对象，认识一下朋友' })
  const library = store.read()
  // 只有一般意愿、明确拒绝私信授权：不得生成首次联系。
  const ordinary = evaluateCandidate(candidateOf({ libraryIntent: 'SEEKING_FRIENDS', discoveryGrade: 'B', consentToDm: false, explicitInvitation: false, source: { commentId: 'c1', videoId: 'v1', commentText: '想找对象，认识一下朋友' } }), { library, config: baseConfig() })
  assert.equal(ordinary.follow.eligible, true, '一般交友意愿可以进入关注计划')
  assert.equal(ordinary.firstMessage.eligible, false)
  assert.equal(ordinary.firstMessage.reasonCode, 'CONSENT_NOT_EXPLICIT')
  // 即使候选字段被误置为同意，只要原始评论不是明确邀请，也不得作为授权证据。
  const forged = evaluateCandidate(candidateOf({ libraryIntent: 'SEEKING_FRIENDS', discoveryGrade: 'B' }), { library, config: baseConfig() })
  assert.equal(forged.firstMessage.reasonCode, 'CONSENT_INTENT_MISMATCH')
})

test('拒绝联系永远最高优先级，重新分类也不会回到联系队列', () => {
  const { store } = seedStore()
  const library = store.read()
  const action = normalizeCandidateAction({ followStatus: 'pending', firstMessageStatus: 'pending' }, { status: 'REJECTED', discoveryStatus: 'REJECTED' })
  assert.equal(action.followStatus, 'blocked')
  assert.equal(action.firstMessageStatus, 'blocked')
  const rejected = candidateOf({ status: 'REJECTED', discoveryStatus: 'REJECTED', action: { followStatus: 'pending', firstMessageStatus: 'pending' } })
  const plan = evaluateCandidate(rejected, { library, config: baseConfig() })
  assert.equal(plan.follow.reasonCode, 'REJECTED_PROTECTED')
  const queue = new AutoContactQueue({ store })
  assert.equal(queue.enqueue([plan]).followAdded, 0)
})

test('作者 ID 缺失不会产生错误联系；执行前兜底拦截拒绝用户', async () => {
  const { store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  const plan = queue.plan({ candidates: [candidateOf()] })
  queue.enqueue(plan.plans)
  const run = await queue.run({ dryRun: true, blockedPlatformUserIds: ['sec_1'] })
  assert.equal(run.results[0].status, 'blocked')
  assert.equal(run.results[0].reasonCode, 'REJECTED_PROTECTED')
})

test('年龄或性别未知时遵守筛选规则，不根据头像猜测', () => {
  const { store } = seedStore()
  const library = store.read()
  const genderUnknown = evaluateCandidate(candidateOf({ publicSignals: { age: 24 } }), { library, config: baseConfig({ targetGender: 'female' }) })
  assert.equal(genderUnknown.follow.status, 'skipped')
  assert.equal(genderUnknown.follow.reasonCode, 'GENDER_UNVERIFIED')
  const ageUnknown = evaluateCandidate(candidateOf({ publicSignals: { genderText: '女' } }), { library, config: baseConfig({ requireAgeRange: true, ageMin: 20, ageMax: 30 }) })
  assert.equal(ageUnknown.follow.status, 'skipped')
  assert.equal(ageUnknown.follow.reasonCode, 'AGE_UNVERIFIED')
  const male = evaluateCandidate(candidateOf({ publicSignals: { genderText: '男', age: 24 } }), { library, config: baseConfig({ targetGender: 'female' }) })
  assert.equal(male.follow.reasonCode, 'GENDER_MISMATCH')
})

test('同一作者不会重复关注：任务 ID 稳定，重复入队被去重', () => {
  const { store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  const plan = queue.plan({ candidates: [candidateOf()] })
  const first = queue.enqueue(plan.plans)
  const second = queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  assert.equal(first.followAdded, 1)
  assert.equal(second.followAdded, 0)
  assert.equal(store.autoContactState().queues.follow.length, 1)
  assert.equal(taskIdOf('acc', 'sec_1', 'follow'), taskIdOf('acc', 'sec_1', 'follow'))
})

test('同一作者不会重复发送首次消息，Dry Run 不调用任何真实执行器', async () => {
  const { store } = seedStore()
  autoReady(store)
  let calls = 0
  const executor = () => { calls++; return { ok: true } }
  const queue = new AutoContactQueue({ store })
  const plan = queue.plan({ candidates: [candidateOf()] })
  queue.enqueue(plan.plans)
  await queue.run({ dryRun: true, executor })
  await queue.run({ dryRun: true, executor })
  assert.equal(calls, 0, 'Dry Run 绝不允许调用真实执行器')
  const executed = store.autoContactState().executed
  assert.equal(Object.keys(executed.firstMessage).length, 1)
  assert.equal(Object.keys(executed.follow).length, 1)
})

test('未授权时即使请求真实执行也自动降级为 Dry Run', async () => {
  const { store } = seedStore()
  autoReady(store)
  store.setAutoContact({ realActionsAuthorized: false })
  let calls = 0
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  const run = await queue.run({ dryRun: false, executor: () => { calls++; return { ok: true } } })
  assert.equal(run.dryRun, true)
  assert.equal(calls, 0)
})

test('已授权时只对关注任务调用真实执行器，任务携带可核对主页', async () => {
  const { store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans, { dryRun: false })
  const calls = []
  const run = await queue.run({
    dryRun: false, onlyAction: 'follow',
    executor: payload => { calls.push(payload); return { ok: true } },
  })
  assert.equal(run.dryRun, false)
  assert.equal(calls.length, 1, '只执行关注，不提前执行首次联系')
  assert.equal(calls[0].action, 'follow')
  assert.equal(calls[0].profileUrl, 'https://www.douyin.com/user/sec_1')
  assert.equal(calls[0].nickname, '小美')
  assert.equal(run.state.budget.follows, 1)
  assert.equal(run.state.budget.messages, 0)
})

test('首次联系必须发生在关注成功之后，困难时不越过阶段', async () => {
  const { store } = seedStore()
  autoReady(store, { autoFollow: false, autoFirstMessage: true })
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  const run = await queue.run({ dryRun: true })
  const blocked = run.results.find(item => item.action === 'firstMessage')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.reasonCode, 'FOLLOW_NOT_DONE')
})

test('每日预算限制生效，超出上限不再执行', async () => {
  const { store } = seedStore()
  autoReady(store, { dailyFollowLimit: 1 })
  const queue = new AutoContactQueue({ store })
  const second = candidateOf({ id: 'candidate_2', platformUserId: 'sec_2', profileUrl: 'https://www.douyin.com/user/sec_2', source: { commentId: 'c1', videoId: 'v1', commentText: COMMENT_TEXT } })
  queue.enqueue(queue.plan({ candidates: [candidateOf(), second] }).plans)
  const run = await queue.run({ dryRun: true })
  const done = run.results.filter(item => item.action === 'follow' && item.status === 'done')
  assert.equal(done.length, 1)
  assert.ok(run.results.some(item => item.reasonCode === 'DAILY_LIMIT_REACHED'))
})

test('暂停后可以继续，重启后队列与预算仍在', async () => {
  const { dir, store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  queue.pause()
  const paused = await queue.run({ dryRun: true })
  assert.equal(paused.error, 'PAUSED')
  queue.recover()
  const resumed = await queue.run({ dryRun: true })
  assert.equal(resumed.ok, true)
  // 模拟程序重启：新实例读取同一份 library.json。
  const reopened = new LibraryStore(dir)
  const state = reopened.autoContactState()
  assert.equal(state.mode, 'auto')
  assert.equal(state.queues.follow.length, 1)
  assert.equal(Object.keys(state.executed.follow).length, 1)
  const again = await new AutoContactQueue({ store: reopened }).run({ dryRun: true })
  assert.equal(again.ok, true)
  assert.ok(again.results.every(item => item.status !== 'done' || item.reasonCode !== 'OK'), '重启后不得重复执行已完成的关注')
})

test('验证码或频率限制触发安全停止，并阻断后续运行', async () => {
  const { store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  const run = await queue.run({ dryRun: false, executor: () => ({ ok: false, reasonCode: 'RATE_LIMITED', reason: '平台频率限制' }) })
  assert.equal(run.stopped.code, 'RATE_LIMITED')
  assert.equal(run.state.status, 'stopped')
  const next = await queue.run({ dryRun: true })
  assert.equal(next.error, 'EMERGENCY_STOPPED')
  assert.equal((await queue.run({ dryRun: true })).error, 'EMERGENCY_STOPPED')
  queue.recover()
  assert.equal((await queue.run({ dryRun: true })).ok, true)
})

test('AI 分类不会覆盖人工标签：人工审核过的证据不视为过期', () => {
  const { store } = seedStore({ reviewedByUser: true })
  const records = candidateRecords(store.read())
  assert.equal(records.unmapped.length, 0, '人工确认的评论不应因 inputHash 变化被判过期')
  assert.ok(records.records.some(item => item.platformUserId === 'sec_1'))
})

test('模式切换不污染历史学习数据与候选人', () => {
  const { store } = seedStore()
  const before = store.read()
  store.setAutoContact({ mode: 'auto', riskAcceptedAt: '2026-11-03T00:00:00.000Z' })
  store.setAutoContact({ mode: 'training' })
  const after = store.read()
  assert.deepEqual(after.comments, before.comments)
  assert.deepEqual(after.videos, before.videos)
  assert.equal(after.autoContact.riskAcceptedAt, '2026-11-03T00:00:00.000Z')
  assert.equal(after.autoContact.mode, 'training')
})

test('策略版本与队列任务持久化字段完整', () => {
  const { store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  const task = store.autoContactState().queues.follow[0]
  assert.equal(task.policyVersion, POLICY_VERSION)
  assert.equal(typeof task.taskId, 'string')
  assert.equal(task.status, 'pending')
  assert.equal(task.attempts, 0)
})
