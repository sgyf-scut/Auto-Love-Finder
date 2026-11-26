const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { LibraryStore, normalizeAutoContact } = require('../electron/social-brain/library-store.cjs')
const { BenchmarkStore } = require('../electron/social-brain/library-benchmark.cjs')
const { AutoContactQueue, taskIdOf, evaluateCandidate } = require('../electron/discovery/auto-contact.cjs')
const { auditCandidates, auditCandidate, explainFollowPlans, DISCOVERY, CONTACT, ACTION } = require('../electron/discovery/candidate-audit.cjs')
const { MockAdapter, DryRunAdapter, createActionAdapter } = require('../electron/contact/action-adapter.cjs')

const COMMENT_TEXT = '想认识你，方便私信聊聊吗'
function seedStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p214-'))
  const store = new LibraryStore(dir)
  const library = store.read()
  library.videos = [{ key: 'video_1', video_id: 'v1', video_url: 'https://www.douyin.com/video/v1', title: '同城交友认识新朋友', source: 'favorites' }]
  library.comments = [{ key: 'comment_1', comment_id: 'c1', video_id: 'v1', author_id: 'sec_1', author_name: '小美', text: COMMENT_TEXT, classification: { intent: 'EXPLICIT_INVITATION', reviewedByUser: true, evidence: ['方便私信'], inputHash: 'reviewed' } }]
  store.save(library)
  return { dir, store, library: store.read() }
}
function candidateOf(over = {}) {
  return {
    id: 'candidate_1', accountId: 'acc', platformUserId: 'sec_1', profileUrl: 'https://www.douyin.com/user/sec_1', nickname: '小美',
    status: 'DISCOVERED', discoveryStatus: 'DISCOVERED', discoveryGrade: 'A', libraryIntent: 'EXPLICIT_INVITATION', consentToDm: true, explicitInvitation: true,
    publicSignals: { genderText: '女', age: 24, followerCount: 120 }, source: { commentId: 'c1', videoId: 'v1', commentText: COMMENT_TEXT },
    ...over,
  }
}
const baseConfig = over => ({ ...normalizeAutoContact({}).config, ...over })
function autoReady(store, config = {}) {
  const current = store.autoContactState()
  store.setAutoContact({ mode: 'auto', riskAcceptedAt: '2026-11-03T00:00:00.000Z', realActionsAuthorized: true, config: { ...current.config, autoFollow: true, autoFirstMessage: true, dailyFollowLimit: 5, dailyFirstMessageLimit: 5, ...config } })
}

test('P2-14-01 训练模式零外发：计划可生成，但队列不入队且不能运行', async () => {
  const { store } = seedStore()
  const queue = new AutoContactQueue({ store })
  const plan = queue.plan({ candidates: [candidateOf()] })
  assert.equal(plan.summary.follow, 1)
  assert.equal(queue.enqueue(plan.plans).followAdded, 0)
  assert.equal((await queue.run({ dryRun: true })).error, 'NOT_AUTO_MODE')
})

test('P2-14-02 正式模式资格判断：三层结论分离，不共用同一个 approved 字段', () => {
  const { store, library } = seedStore()
  const result = auditCandidates([candidateOf()], { library, config: baseConfig() })
  const audit = result.audits[0]
  assert.equal(audit.discovery.status, DISCOVERY.QUALIFIED)
  assert.equal(audit.contact.status, CONTACT.ELIGIBLE)
  assert.equal(audit.action.status, ACTION.NOT_AUTHORIZED)
  assert.equal(result.summary.counts.actionAuthorized, 0, '缺少平台权限与对方同意时不得授权真实动作')
  assert.ok(audit.action.reasons.includes('PLATFORM_PERMISSION_UNVERIFIED'))
})

test('P2-14-03 性别未知不得进入联系资格', () => {
  const { library } = seedStore()
  const audit = auditCandidate(candidateOf({ publicSignals: { age: 24 } }), { library, config: baseConfig({ targetGender: 'female' }) })
  assert.equal(audit.contact.status, CONTACT.INSUFFICIENT)
  assert.ok(audit.contact.reasons.includes('GENDER_UNVERIFIED'))
})

test('P2-14-04 年龄未知不得进入联系资格，且成年身份不可推断', () => {
  const { library } = seedStore()
  const audit = auditCandidate(candidateOf({ publicSignals: { genderText: '女' } }), { library, config: baseConfig() })
  assert.equal(audit.facts.adultVerified, false)
  assert.ok(audit.contact.reasons.includes('AGE_UNVERIFIED'))
  assert.equal(audit.contact.allowed, false)
})

test('P2-14-05 明确邀请证据必须来自原始评论且可追溯', () => {
  const { store, library } = seedStore()
  const plan = evaluateCandidate(candidateOf(), { library, config: baseConfig() })
  assert.ok(String(plan.firstMessage.consentEvidenceId).includes('c1'))
  // 候选字段声称明确邀请，但原始评论分类不是明确邀请：不得作为授权证据。
  const skewed = { ...library, comments: [{ ...library.comments[0], classification: { ...library.comments[0].classification, intent: 'SEEKING_FRIENDS' } }] }
  const forged = evaluateCandidate(candidateOf({ libraryIntent: 'SEEKING_FRIENDS', discoveryGrade: 'B' }), { library: skewed, config: baseConfig() })
  assert.equal(forged.firstMessage.reasonCode, 'CONSENT_INTENT_MISMATCH')
})

test('P2-14-06 普通交友意愿不自动授权私信', () => {
  const { store, library } = seedStore()
  const normal = candidateOf({ libraryIntent: 'SEEKING_FRIENDS', discoveryGrade: 'B', consentToDm: false })
  const plan = evaluateCandidate(normal, { library, config: baseConfig() })
  assert.equal(plan.follow.eligible, true)
  assert.equal(plan.firstMessage.eligible, false)
  const audit = auditCandidate(normal, { library, config: baseConfig() })
  assert.ok(audit.action.reasons.includes('CONSENT_NOT_EXPLICIT'))
})

test('P2-14-07 拒绝保护优先于任何其他资格', () => {
  const { library } = seedStore()
  const audit = auditCandidate(candidateOf({ status: 'REJECTED', discoveryStatus: 'REJECTED' }), { library, config: baseConfig() })
  assert.equal(audit.discovery.allowed, false)
  assert.ok(audit.discovery.reasons.includes('REJECTED_PROTECTED'))
  assert.equal(audit.facts.rejected, true)
})

test('P2-14-08 作者 ID 缺失阻断发现与执行', () => {
  const { library } = seedStore()
  const audit = auditCandidate(candidateOf({ platformUserId: '', profileUrl: null }), { library, config: baseConfig() })
  assert.equal(audit.discovery.allowed, false)
  assert.ok(audit.discovery.reasons.includes('MISSING_AUTHOR_ID'))
})

test('P2-14-09 重复候选被标记合并，不产生第二条动作', () => {
  const { library } = seedStore()
  const second = candidateOf({ id: 'candidate_2' })
  const result = auditCandidates([candidateOf(), second], { library, config: baseConfig() })
  assert.equal(result.summary.counts.duplicateMerged, 1)
  assert.ok(result.audits.every(item => item.discovery.reasons.includes('DUPLICATE_CANDIDATE')))
})

test('P2-14-10 重复任务幂等：同一作者只入队一次', () => {
  const { store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  assert.equal(store.autoContactState().queues.follow.length, 1)
  assert.equal(taskIdOf('acc', 'sec_1', 'follow'), taskIdOf('acc', 'sec_1', 'follow'))
})

test('P2-14-11 预算耗尽后不再执行新的关注', async () => {
  const { store } = seedStore()
  autoReady(store, { dailyFollowLimit: 1 })
  const queue = new AutoContactQueue({ store })
  const second = candidateOf({ id: 'candidate_2', platformUserId: 'sec_2', profileUrl: 'https://www.douyin.com/user/sec_2' })
  queue.enqueue(queue.plan({ candidates: [candidateOf(), second] }).plans)
  const run = await queue.run({ dryRun: true })
  assert.equal(run.results.filter(item => item.action === 'follow' && item.status === 'done').length, 1)
  assert.ok(run.results.some(item => item.reasonCode === 'DAILY_LIMIT_REACHED'))
})

test('P2-14-12 中断恢复：重建队列后状态、预算和任务仍存在', async () => {
  const { store } = seedStore()
  autoReady(store, { dailyFollowLimit: 1 })
  const queue = new AutoContactQueue({ store })
  queue.enqueue(queue.plan({ candidates: [candidateOf()] }).plans)
  await queue.run({ dryRun: true })
  const before = store.autoContactState()
  const restarted = new AutoContactQueue({ store })
  assert.equal(restarted.state().queues.follow.length, before.queues.follow.length)
  assert.equal(restarted.state().budget.follows, 1)
})

test('P2-14-13 模式切换不把训练候选自动批准为可联系状态', () => {
  const { store } = seedStore()
  assert.equal(store.autoContactState().mode, 'training')
  const before = new AutoContactQueue({ store }).plan({ candidates: [candidateOf()] }).summary.follow
  autoReady(store)
  const after = new AutoContactQueue({ store }).plan({ candidates: [candidateOf()] }).summary.follow
  assert.equal(before, 1, '训练模式只生成计划')
  assert.equal(after, 1, '正式模式重新计算，不继承训练审核结论')
  assert.equal(store.autoContactState().queues.follow.length, 0, '切换本身不入队')
})

test('P2-14-14 盲评数据独立保存，不写入评论分类与生产联系人', () => {
  const { dir, store, library } = seedStore()
  const benchmark = new BenchmarkStore(dir)
  const commentKey = library.comments[0].key
  const saved = benchmark.save({ activeSet: { id: 'set_1', keys: [commentKey], requestedSize: 1 } })
  assert.ok(fs.existsSync(path.join(dir, 'library', 'benchmark.json')), '盲评成员独立文件')
  assert.equal(saved.activeSet.keys.length, 1)
  assert.ok(saved.activeSet.keys.includes(commentKey), '基准集只记录成员 key')
  const raw = fs.readFileSync(path.join(dir, 'library', 'benchmark.json'), 'utf8')
  assert.ok(!raw.includes('EXPLICIT_INVITATION'), '基准集文件不包含模型分类结果')
  assert.ok(!fs.existsSync(path.join(dir, 'library', 'learning.json')), '基准集写入不触发人工标签文件')
  const after = store.read()
  assert.deepEqual(after.comments[0].classification, library.comments[0].classification, '不覆盖模型分类')
})

test('P2-14-15 Mock Adapter 只产生模拟结果，不触碰真实接口', async () => {
  const adapter = createActionAdapter('mock')
  assert.ok(adapter instanceof MockAdapter)
  assert.equal(adapter.simulated, true)
  const result = await adapter.run({ task: { taskId: 't1', action: 'follow', platformUserId: 'sec_1' } })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'done')
  assert.equal(result.record.simulated, true)
})

test('P2-14-16 Dry Run Adapter 不关注、不发送', async () => {
  const adapter = createActionAdapter('dryRun')
  assert.ok(adapter instanceof DryRunAdapter)
  const result = await adapter.run({ task: { taskId: 't1', action: 'follow', platformUserId: 'sec_1' } })
  assert.equal(result.outcome.followed, false)
  assert.equal(result.outcome.sent, false)
  assert.equal(result.outcome.dryRun, true)
})

test('P2-14-17 紧急停止后队列不再启动新的外部动作', async () => {
  const { store } = seedStore()
  autoReady(store)
  const queue = new AutoContactQueue({ store })
  queue.stop('用户紧急停止')
  const run = await queue.run({ dryRun: true })
  assert.equal(run.ok, false)
  assert.equal(run.error, 'EMERGENCY_STOPPED')
})

test('P2-14-18 执行结果不确定时禁止重复发送', async () => {
  const adapter = createActionAdapter('mock', { outcomes: ['uncertain'] })
  const first = await adapter.run({ task: { taskId: 't1', action: 'firstMessage', platformUserId: 'sec_1' } })
  assert.equal(first.status, 'uncertain')
  const second = await adapter.run({ task: { taskId: 't1', action: 'firstMessage', platformUserId: 'sec_1' }, executed: { t1: { status: 'uncertain' } } })
  assert.equal(second.status, 'blocked')
  assert.equal(second.reasonCode, 'UNCERTAIN_STATE_NO_RETRY')
})

test('P2-14-19 权限不足安全停止并标记硬停', async () => {
  const adapter = createActionAdapter('mock')
  const result = await adapter.run({ task: { taskId: 't1', action: 'follow', platformUserId: 'sec_1' }, permissionGranted: false })
  assert.equal(result.status, 'blocked')
  assert.equal(result.reasonCode, 'PERMISSION_DENIED')
  assert.equal(result.hardStop, true)
})

test('P2-14-20 源码与 staging 关键文件哈希一致', () => {
  const root = path.join(__dirname, '..')
  // P2-15：staging 目录按版本递增；检查“当前最新 staging”与源码一致，旧目录保留为历史快照。
  const stagingRoot = path.join(root, '..', 'staging')
  // P2-17B：阶段号允许字母后缀（如 P2-17B）；P2-17B.1：字母后缀后还可带小版本号。
  // 只比较数字部分的 parseFloat 会把 P2-17B.1 误判为 P2-17，导致取到旧 staging 目录。
  const versions = fs.readdirSync(stagingRoot).filter(name => /^P2-\d+(?:\.\d+)?[A-Z]?(?:\.\d+)?$/i.test(name))
  const versionKey = name => String(name).slice(3).match(/\d+|[A-Z]+/gi)?.map(part => (/^\d+$/.test(part) ? part.padStart(4, '0') : part.toUpperCase())).join('|') || ''
  const versionsSorted = versions.sort((a, b) => versionKey(a).localeCompare(versionKey(b)))
  const latest = versions.at(-1)
  const staging = path.join(stagingRoot, latest, 'app')
  const files = ['dist/app.js', 'electron/main.cjs', 'electron/preload.cjs', 'electron/discovery/auto-contact.cjs', 'electron/discovery/candidate-audit.cjs', 'electron/contact/action-adapter.cjs', 'electron/contact/action-gate.cjs', 'electron/atomic-write.cjs']
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  assert.ok(fs.existsSync(path.join(staging, 'package.json')), `缺少 ${latest} 构建`)
  for (const file of files) {
    const source = path.join(root, file)
    const copy = path.join(staging, file)
    assert.ok(fs.existsSync(source) && fs.existsSync(copy), `缺少文件：${file}`)
    assert.equal(hash(source), hash(copy), `staging 与源码不一致：${file}`)
  }
})
