// P2-15.1：三类证据分别记录（平台权限 / 对方同意 / 操作者确认），互不替代；
// 写入降级可回退；旧自动交友在联系引擎缺席时也不能绕过候选池审计。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { authorizationOf, EVIDENCE_STATUS } = require('../electron/discovery/candidate-audit.cjs')
const { LibraryStore } = require('../electron/social-brain/library-store.cjs')
const { AutoFriendshipService } = require('../electron/auto-friendship.cjs')
const { writeFileAtomicSync, readJsonWithRecoverySync } = require('../electron/atomic-write.cjs')
const { JsonStorage } = require('../electron/storage.cjs')

const CANDIDATE = { platformUserId: 'sec_1', profileUrl: 'https://www.douyin.com/user/sec_1', nickname: '小美' }
const CONSENT_OK = { ok: true, evidenceId: 'comment:c:1', reasonCode: null }

function authorization(overrides = {}) {
  return {
    platform: { allowed: true, verifiedAt: '2026-11-01T00:00:00.000Z', basis: '账号实测：单日关注 5 次无风控，未见自动化限制提示', expiresAt: null },
    recipientAiConsent: { sec_1: { accepted: true, at: '2026-11-02T00:00:00.000Z', source: '对方在主页简介中声明接受 AI 助手联系', revokedAt: null, expiresAt: null } },
    operator: { sec_1: { confirmedAt: '2026-11-03T00:00:00.000Z', actions: ['follow', 'firstMessage'], expiresAt: null } },
    ...overrides,
  }
}

function audit(auth, { action = 'follow', consent = CONSENT_OK, candidate = CANDIDATE } = {}) {
  return authorizationOf(candidate, consent, { authorization: auth, action, now: Date.parse('2026-11-04T00:00:00.000Z') })
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2151-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ── 一、三类证据分别记录，互不替代 ───────────────────────────────────────

test('P2-15.1-01 三类证据齐全时才授权，并分别返回证据明细', () => {
  const result = audit(authorization())
  assert.equal(result.allowed, true)
  assert.equal(result.evidence.platform.status, EVIDENCE_STATUS.RECORDED)
  assert.equal(result.evidence.recipient.status, EVIDENCE_STATUS.RECORDED)
  assert.equal(result.evidence.operator.status, EVIDENCE_STATUS.RECORDED)
  assert.equal(result.evidence.platform.verifiedAt, '2026-11-01T00:00:00.000Z')
  assert.match(result.evidence.platform.basis, /自动化限制/)
  assert.equal(result.evidence.recipient.at, '2026-11-02T00:00:00.000Z')
})

test('P2-15.1-02 操作者确认不能替代对方同意', () => {
  const result = audit(authorization({ recipientAiConsent: {} }))
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, ['RECIPIENT_AI_CONSENT_MISSING'])
  assert.equal(result.evidence.operator.status, EVIDENCE_STATUS.RECORDED)
  assert.equal(result.evidence.recipient.status, EVIDENCE_STATUS.MISSING)
})

test('P2-15.1-03 对方同意也不能替代操作者确认', () => {
  const result = audit(authorization({ operator: {} }))
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, ['OPERATOR_CONFIRMATION_MISSING'])
})

test('P2-15.1-04 平台自动化权限是独立一类证据，登录状态不写这里', () => {
  const result = audit(authorization({ platform: { allowed: false, verifiedAt: null, basis: '', expiresAt: null } }))
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, ['PLATFORM_PERMISSION_UNVERIFIED'])
  assert.equal(result.evidence.platform.status, EVIDENCE_STATUS.MISSING)
})

test('P2-15.1-05 只有布尔值的旧平台权限记录不能当成已核实', () => {
  const legacy = authorization({ platform: { allowed: true } })
  const result = audit(legacy)
  assert.equal(result.allowed, false)
  assert.equal(result.evidence.platform.status, EVIDENCE_STATUS.LEGACY_UNSCOPED)
  assert.deepEqual(result.reasons, ['PLATFORM_PERMISSION_UNVERIFIED'])
})

test('P2-15.1-06 旧的全局操作者时间戳不再解锁任何人', () => {
  const result = audit(authorization({ operator: {}, operatorConfirmedAt: '2026-10-01T00:00:00.000Z' }))
  assert.equal(result.allowed, false)
  assert.equal(result.evidence.operator.status, EVIDENCE_STATUS.LEGACY_UNSCOPED)
  assert.deepEqual(result.reasons, ['OPERATOR_CONFIRMATION_UNSCOPED'])
})

test('P2-15.1-07 操作者确认按动作生效：只批准关注不代表批准私信', () => {
  const auth = authorization({ operator: { sec_1: { confirmedAt: '2026-11-03T00:00:00.000Z', actions: ['follow'], expiresAt: null } } })
  assert.equal(audit(auth, { action: 'follow' }).allowed, true)
  const message = audit(auth, { action: 'firstMessage' })
  assert.equal(message.allowed, false)
  assert.deepEqual(message.reasons, ['OPERATOR_CONFIRMATION_ACTION_MISMATCH'])
})

test('P2-15.1-08 操作者确认过期后自动失效', () => {
  const auth = authorization({ operator: { sec_1: { confirmedAt: '2026-11-03T00:00:00.000Z', actions: ['follow'], expiresAt: '2026-11-03T12:00:00.000Z' } } })
  const result = audit(auth)
  assert.equal(result.allowed, false)
  assert.equal(result.evidence.operator.status, EVIDENCE_STATUS.EXPIRED)
  assert.deepEqual(result.reasons, ['OPERATOR_CONFIRMATION_EXPIRED'])
})

test('P2-15.1-09 对方撤销同意后立即失效', () => {
  const auth = authorization({ recipientAiConsent: { sec_1: { accepted: true, at: '2026-11-02T00:00:00.000Z', revokedAt: '2026-11-03T18:00:00.000Z' } } })
  const result = audit(auth)
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, ['RECIPIENT_AI_CONSENT_REVOKED'])
})

test('P2-15.1-10 一般交友意愿即使三类证据齐全也不构成私信授权', () => {
  const result = audit(authorization(), { action: 'firstMessage', consent: { ok: false, evidenceId: null, reasonCode: 'CONSENT_NOT_EXPLICIT' } })
  assert.equal(result.allowed, false)
  assert.deepEqual(result.reasons, ['CONSENT_NOT_EXPLICIT'])
})

// ── 二、授权证据的持久化 ────────────────────────────────────────────────

test('P2-15.1-11 平台权限写入时记录核实时间与依据，撤销后清空', t => {
  const store = new LibraryStore(tempDir(t))
  const platform = store.setPlatformAuthorization({ allowed: true, verifiedAt: '2026-11-01T10:00:00.000Z', basis: '人工逐条核对平台条款后记录' })
  assert.equal(platform.allowed, true)
  assert.equal(platform.verifiedAt, '2026-11-01T10:00:00.000Z')
  const revoked = store.revokeAuthorization({ kind: 'platform' })
  assert.equal(revoked.platform.allowed, false)
  assert.equal(revoked.platform.verifiedAt, null)
})

test('P2-15.1-12 操作者确认必须指定动作范围，缺少用户 ID 直接拒绝', t => {
  const store = new LibraryStore(tempDir(t))
  assert.throws(() => store.setOperatorConfirmation('sec_1', { actions: [] }), /动作范围/)
  assert.throws(() => store.setRecipientConsent('', { accepted: true }), /用户 ID/)
  const record = store.setOperatorConfirmation('sec_1', { actions: ['follow'] })
  assert.deepEqual(record.actions, ['follow'])
  assert.ok(record.confirmedAt)
})

test('P2-15.1-13 授权证据与模拟记录分开落盘，重新读取后仍在', t => {
  const dir = tempDir(t)
  const store = new LibraryStore(dir)
  store.setPlatformAuthorization({ allowed: true, verifiedAt: '2026-11-01T10:00:00.000Z', basis: '人工核对' })
  store.setRecipientConsent('sec_1', { accepted: true, at: '2026-11-02T10:00:00.000Z' })
  const reopened = new LibraryStore(dir).autoContactState()
  assert.equal(reopened.authorization.platform.allowed, true)
  assert.equal(reopened.authorization.recipientAiConsent.sec_1.accepted, true)
  assert.equal(reopened.authorization.operator.sec_1, undefined)
  // 授权证据不改变模拟/真实开关
  assert.equal(reopened.dryRun, true)
  assert.equal(reopened.realActionsAuthorized, false)
})

// ── 三、旧自动交友不能绕过候选池 ────────────────────────────────────────

function makeAutoFriendship(poolCheck) {
  const state = {
    automation: {}, contacts: [], sendHistory: [], settings: {}, providers: [{ id: 'p1' }],
    selfPersona: { name: '我' }, selfProfile: {},
    friendship: {
      automatic: { enabled: true, keywords: ['读书'], dailyLimit: 3, intervalMinutes: 30, scanDailyLimit: 20 },
      autoState: { jobs: [], candidates: [] },
    },
  }
  const storage = { get: () => JSON.parse(JSON.stringify(state)), update: patch => { Object.assign(state, patch) } }
  return new AutoFriendshipService({ douyin: { getSendAllowance: () => ({ ok: true }) }, friendship: { destroyed: false }, storage, ai: {}, accountId: 'a', poolCheck })
}

test('P2-15.1-14 未入池的陌生人即使搜索命中也不能自动关注', () => {
  const service = makeAutoFriendship(() => ({ ok: false, code: 'not_in_pool', reason: '该用户不在候选池中' }))
  const gate = service.gate({ url: 'https://www.douyin.com/user/sec_9', name: '陌生人' })
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'not_in_pool')
})

test('P2-15.1-15 已入池且人工批准的候选人可以通过自动交友门', () => {
  const service = makeAutoFriendship(() => ({ ok: true }))
  const gate = service.gate({ url: 'https://www.douyin.com/user/sec_1', name: '小美' })
  assert.equal(gate.ok, true)
})

// ── 四、写入降级可回退 ──────────────────────────────────────────────────

function withRenameFailure(failures, run) {
  const original = fs.renameSync
  let calls = 0
  fs.renameSync = (from, to) => {
    calls++
    if (calls <= failures) {
      const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`)
      error.code = 'EPERM'
      throw error
    }
    return original(from, to)
  }
  try { return run() } finally { fs.renameSync = original }
}

test('P2-15.1-16 降级复制前保留上一代备份，写入内容经过校验', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, '{"generation":1}')
  const result = withRenameFailure(99, () => writeFileAtomicSync(file, '{"generation":2}', { retries: 1, delay: 1 }))
  assert.equal(result.fallback, true)
  assert.equal(result.verified, undefined)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"generation":2}')
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{"generation":1}')
})

test('P2-15.1-17 素材库主文件损坏时从 .bak 恢复并回写', t => {
  const dir = tempDir(t)
  const store = new LibraryStore(dir)
  store.setPlatformAuthorization({ allowed: true, verifiedAt: '2026-11-01T10:00:00.000Z', basis: '人工核对' })
  const file = path.join(dir, 'library', 'library.json')
  const payload = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(`${file}.bak`, payload)
  fs.writeFileSync(file, payload.slice(0, 30))
  const recovered = new LibraryStore(dir).autoContactState()
  assert.equal(recovered.authorization.platform.allowed, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).autoContact.authorization.platform.allowed, true)
})

test('P2-15.1-18 账号主状态损坏时不会静默变成空账号', t => {
  const dir = tempDir(t)
  const accountDir = path.join(dir, 'account')
  fs.mkdirSync(accountDir, { recursive: true })
  const file = path.join(accountDir, 'state.json')
  const storage = new JsonStorage(accountDir)
  storage.update({ automation: { blacklist: ['不要联系的人'] } })
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(`${file}.bak`, JSON.stringify(payload))
  fs.writeFileSync(file, JSON.stringify(payload).slice(0, 20))
  const recovered = new JsonStorage(accountDir).get()
  assert.deepEqual(recovered.automation?.blacklist, ['不要联系的人'])
})

test('P2-15.1-19 辅助读取函数在主文件损坏时返回备份内容', t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'x.json')
  fs.writeFileSync(`${file}.bak`, '{"generation":1}')
  fs.writeFileSync(file, '{"generation":2,')
  const result = readJsonWithRecoverySync(file)
  assert.equal(result.ok, true)
  assert.equal(result.source, 'backup')
  assert.equal(result.recovered, true)
  assert.equal(result.data.generation, 1)
})
