// P2-15：统一动作门控——所有真实关注 / 首次私信入口共用同一套判定。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { evaluateActionGate, describePolicy, POLICY, ACTIONS, SOURCES, STATUS, GATE_VERSION } = require('../electron/contact/action-gate.cjs')

const candidate = (over = {}) => ({
  id: 'candidate_1', platformUserId: 'sec_1', profileUrl: 'https://www.douyin.com/user/sec_1',
  nickname: '小美', libraryIntent: 'SEEKING_FRIENDS', status: 'DISCOVERED', discoveryStatus: 'DISCOVERED',
  ...over,
})
const auditOf = ({ contact = true, action = true, explicit = true } = {}) => ({
  intent: explicit ? 'EXPLICIT_INVITATION' : 'SEEKING_FRIENDS',
  contact: { allowed: contact, status: contact ? 'CONTACT_ELIGIBLE' : 'CONTACT_INSUFFICIENT_INFO', reasons: contact ? [] : ['AGE_UNVERIFIED'] },
  action: { allowed: action, status: action ? 'ACTION_AUTHORIZED' : 'ACTION_NOT_AUTHORIZED', reasons: action ? [] : ['PLATFORM_PERMISSION_UNVERIFIED'] },
  facts: { explicitInvitation: explicit },
})
const autoState = (over = {}) => ({ mode: 'auto', status: 'planned', ...over })
const run = (over = {}) => evaluateActionGate({
  action: ACTIONS.FOLLOW, source: SOURCES.MANUAL, candidate: candidate(), confirmation: { confirmed: true }, ...over,
})

test('P2-15-01 门控版本与四种入口策略齐全', () => {
  assert.equal(GATE_VERSION, 'P2-15.1')
  const policy = describePolicy()
  assert.deepEqual(policy.map(item => item.source).sort(), ['autoContact', 'autoFriendship', 'contactEngine', 'manual'])
  for (const entry of policy) {
    assert.equal(typeof entry.follow, 'object')
    assert.equal(typeof entry.firstMessage, 'object')
  }
  assert.equal(POLICY[SOURCES.MANUAL].follow.requireAutoMode, false, '人工点击不受训练模式限制')
  assert.equal(POLICY[SOURCES.AUTO_CONTACT].follow.requireActionAuthorization, true, '自动联系必须有动作授权')
})

test('P2-15-02 暂停与安全验证对所有入口一致阻断', () => {
  for (const source of [SOURCES.MANUAL, SOURCES.AUTO_CONTACT, SOURCES.CONTACT_ENGINE, SOURCES.AUTO_FRIENDSHIP]) {
    const paused = run({ source, autoState: autoState(), audit: auditOf(), automation: { paused: true } })
    assert.equal(paused.code, 'ACCOUNT_PAUSED', `${source} 必须在账号暂停时阻断`)
    assert.equal(paused.allowed, false)
    const verification = run({ source, autoState: autoState(), audit: auditOf(), platform: { verificationActive: true } })
    assert.equal(verification.code, 'CHALLENGE_REQUIRED', `${source} 必须在安全验证时阻断`)
  }
})

test('P2-15-03 拒绝与排除保护优先级高于任何授权', () => {
  for (const source of [SOURCES.MANUAL, SOURCES.AUTO_CONTACT]) {
    const rejected = run({ source, autoState: autoState(), audit: auditOf(), candidate: candidate({ status: 'REJECTED' }) })
    assert.equal(rejected.code, 'REJECTED_PROTECTED')
    assert.equal(rejected.allowed, false)
    const excluded = run({ source, autoState: autoState(), audit: auditOf(), candidate: candidate({ discoveryStatus: 'EXCLUDED' }) })
    assert.equal(excluded.code, 'EXCLUDED')
    const already = run({ source, autoState: autoState(), audit: auditOf(), excludes: ['sec_1'] })
    assert.equal(already.code, 'ALREADY_CONTACT')
    const blacklisted = run({ source, autoState: autoState(), audit: auditOf(), blacklist: ['小美'] })
    assert.equal(blacklisted.code, 'BLACKLISTED')
  }
})

test('P2-15-04 训练模式阻断自动入口，不阻断人工单次点击', () => {
  const training = autoState({ mode: 'training' })
  assert.equal(run({ source: SOURCES.AUTO_CONTACT, autoState: training, audit: auditOf() }).code, 'TRAINING_MODE')
  assert.equal(run({ source: SOURCES.AUTO_FRIENDSHIP, autoState: training }).code, 'TRAINING_MODE')
  assert.equal(run({ source: SOURCES.MANUAL, autoState: training }).allowed, true, '人工点击是操作者当次决定，不受自动模式约束')
  assert.equal(run({ source: SOURCES.AUTO_CONTACT, autoState: autoState(), audit: auditOf() }).allowed, true)
})

test('P2-15-05 紧急停止对所有系统入口生效，人工动作需明确不受影响', () => {
  const stopped = autoState({ status: 'stopped' })
  for (const source of [SOURCES.AUTO_CONTACT, SOURCES.CONTACT_ENGINE, SOURCES.AUTO_FRIENDSHIP]) {
    assert.equal(run({ source, autoState: stopped, audit: auditOf() }).code, 'EMERGENCY_STOPPED', `${source} 必须遵守紧急停止`)
  }
  assert.equal(run({ source: SOURCES.MANUAL, autoState: stopped }).allowed, true)
  assert.equal(run({ source: SOURCES.MANUAL, autoState: stopped }).checks.find(item => item.code === 'EMERGENCY_STOPPED').applies, false)
})

test('P2-15-06 人工首次私信：一般交友意愿必须单独确认，不能自动升级', () => {
  const base = { action: ACTIONS.FIRST_MESSAGE, source: SOURCES.MANUAL, candidate: candidate(), confirmation: { confirmed: true } }
  const needs = evaluateActionGate(base)
  assert.equal(needs.allowed, false)
  assert.equal(needs.status, STATUS.NEEDS_CONFIRMATION)
  assert.equal(needs.code, 'INVITATION_NOT_EXPLICIT')
  assert.deepEqual(needs.requires, ['INVITATION_NOT_EXPLICIT'])
  const acked = evaluateActionGate({ ...base, confirmation: { confirmed: true, invitationAcknowledged: true } })
  assert.equal(acked.allowed, true, '操作者单独确认后允许发送')
  const explicit = evaluateActionGate({ ...base, candidate: candidate({ libraryIntent: 'EXPLICIT_INVITATION' }) })
  assert.equal(explicit.allowed, true, '明确邀请不需要额外确认')
  const noConfirm = evaluateActionGate({ ...base, candidate: candidate({ libraryIntent: 'EXPLICIT_INVITATION' }), confirmation: {} })
  assert.equal(noConfirm.code, 'OPERATOR_CONFIRMATION_REQUIRED')
})

test('P2-15-07 自动联系入口必须同时具备联系资格与动作授权', () => {
  const base = { source: SOURCES.AUTO_CONTACT, autoState: autoState() }
  const noContact = run({ ...base, audit: auditOf({ contact: false }) })
  assert.equal(noContact.code, 'CONTACT_NOT_ELIGIBLE')
  const noAction = run({ ...base, audit: auditOf({ action: false }) })
  assert.equal(noAction.code, 'ACTION_NOT_AUTHORIZED')
  const both = run({ ...base, audit: auditOf() })
  assert.equal(both.allowed, true)
})

test('P2-15-08 统一联系引擎要求人工批准与手写首句', () => {
  const approved = candidate({ status: 'APPROVED', review: { status: 'approved' } })
  const notApproved = run({ source: SOURCES.CONTACT_ENGINE, candidate: candidate(), autoState: autoState() })
  assert.equal(notApproved.code, 'CANDIDATE_NOT_APPROVED')
  const dm = evaluateActionGate({ action: ACTIONS.FIRST_MESSAGE, source: SOURCES.CONTACT_ENGINE, candidate: approved, autoState: autoState(), confirmation: { openingMessage: '你好，看到你的评论想认识一下' } })
  assert.equal(dm.allowed, true)
  const empty = evaluateActionGate({ action: ACTIONS.FIRST_MESSAGE, source: SOURCES.CONTACT_ENGINE, candidate: approved, autoState: autoState(), confirmation: {} })
  assert.equal(empty.code, 'OPENING_MESSAGE_MISSING')
})

test('P2-15-09 身份缺失与预算上限在门控内阻断', () => {
  const missing = run({ candidate: { nickname: '无 ID', libraryIntent: 'SEEKING_FRIENDS' } })
  assert.equal(missing.code, 'MISSING_AUTHOR_ID')
  const over = run({ remaining: { left: 0 } })
  assert.equal(over.code, 'DAILY_LIMIT_REACHED')
  const available = run({ remaining: { left: 2 } })
  assert.equal(available.allowed, true)
})

test('P2-15-10 账号级预检不因缺少候选人而误判身份', () => {
  const preflight = evaluateActionGate({ action: ACTIONS.FOLLOW, source: SOURCES.AUTO_CONTACT, autoState: autoState(), confirmation: { confirmed: true } })
  assert.equal(preflight.allowed, true)
  assert.equal(preflight.checks.find(item => item.code === 'MISSING_AUTHOR_ID').applies, false)
})

test('P2-15-11 四个真实动作入口都已接入统一门控', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /require\('\.\/contact\/action-gate\.cjs'\)/, '主进程必须引用统一门控')
  assert.match(main, /if \(method === 'follow'\)[\s\S]{0,600}GATE_SOURCES\.MANUAL/, 'friendship:follow-user 必须过门控')
  assert.match(main, /ipcMain\.handle\('friendship:approach'[\s\S]{0,1200}GATE_SOURCES\.MANUAL/, 'friendship:approach 必须过门控')
  assert.match(main, /channel === 'run'\)[\s\S]{0,400}EMERGENCY_STOPPED/, 'contact:run 必须遵守紧急停止')
  assert.match(main, /friendship:auto-run'[\s\S]{0,600}EMERGENCY_STOPPED/, '旧自动交友入口必须遵守紧急停止')
  assert.match(main, /library:auto-follow'[\s\S]{0,900}GATE_SOURCES\.AUTO_CONTACT/, '自动联系队列必须复用门控')
  // 旧入口不得在门控之前直接调用真实服务。
  assert.ok(main.indexOf("GATE_SOURCES.MANUAL") < main.indexOf('entry.friendship[method](payload)'), '门控必须发生在真实调用之前')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.1.0')
})
