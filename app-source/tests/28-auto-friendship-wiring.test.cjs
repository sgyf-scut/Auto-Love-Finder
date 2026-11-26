const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
require('./setup.cjs')
const { JsonStorage, migrateLegacy, defaults } = require('../electron/storage.cjs')

const user = (suffix, status = 'selected') => ({ id: `job-${suffix}`, url: `https://www.douyin.com/user/${suffix}`, name: `朋友${suffix}`, status, openingText: '你好呀', createdAt: '2026-10-10T10:00:00+08:00' })

function mainFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-wiring-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const handlers = new Map(), appEvents = new Map(), calls = []
  let clearError
  class Storage {
    constructor() { this.state = { friendship: { followed: [] }, contacts: [], settings: {}, selfPersona: { name: '本人', interests: '宠物' }, providers: [{ name: 'private-provider' }] } }
    get() { return structuredClone(this.state) }
    update(patch) {
      for (const [key, value] of Object.entries(patch)) this.state[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...this.state[key], ...value } : value
      return this.get()
    }
    addLog() {}
  }
  class Douyin {
    constructor(options) { Object.assign(this, options); this.lastSeen = new Map(); this.lastSent = new Map() }
    startWorker() { calls.push(['worker-start', this.partition]) }
    getEventFollowups() {}
    destroy() { this.destroyed = true; calls.push(['douyin-destroy', this.accountId]) }
    async logout() { calls.push(['douyin-logout', this.accountId]); if (this.logoutError) throw this.logoutError; return { ok: true } }
  }
  class Friendship {
    constructor(douyin) { this.douyin = douyin }
    destroy() { this.destroyed = true; calls.push(['friendship-destroy', this.douyin.accountId]) }
  }
  class Automatic {
    constructor(options) { Object.assign(this, options); this.updates = []; this.runs = 0 }
    start() { this.started = true; calls.push(['auto-start', this.accountId]) }
    destroy() { this.destroyed = true; calls.push(['auto-destroy', this.accountId]) }
    update(config) { this.updates.push(config); this.storage.update({ friendship: { automatic: { ...this.storage.get().friendship.automatic, ...config } } }); return { ok: true, automatic: this.storage.get().friendship.automatic } }
    async runOnce() { this.runs++; if (this.runError) throw this.runError; return { ok: true, accountId: this.accountId } }
  }
  class Video { constructor(douyin) { this.douyin = douyin } destroy() { this.destroyed = true } }
  const electron = {
    app: { requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} }, on: (event, handler) => appEvents.set(event, handler), whenReady: () => ({ then() {} }), getPath: () => dir, setPath() {}, getVersion: () => 'test' },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    session: { fromPartition: partition => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, clearStorageData: async () => { calls.push(['clear-session', partition]); if (clearError) throw clearError } }) },
    BrowserWindow: { getAllWindows: () => [] },
  }
  const dependencies = {
    electron,
    './navigation-policy.cjs': require('../electron/navigation-policy.cjs'),
    './storage.cjs': { JsonStorage: Storage },
    './social-brain/self-profile.cjs': require('../electron/social-brain/self-profile.cjs'),
    './social-brain/self-profile-extractor.cjs': require('../electron/social-brain/self-profile-extractor.cjs'),
    './providers-store.cjs': {},
    './automation.cjs': { DouyinService: Douyin },
    './friendship.cjs': { FriendshipService: Friendship, normalizePersona: value => value },
    './auto-friendship.cjs': { AutoFriendshipService: Automatic },
    './contact-engine.cjs': { ContactEngine: class { constructor(options) { Object.assign(this, options) } start() {} destroy() { this.destroyed = true } update() {} refresh() {} } },
    './discovery/discovery-engine.cjs': { DiscoveryEngine: class { destroy() {} } },
    './discovery/comment-collection-service.cjs': require('../electron/discovery/comment-collection-service.cjs'),
    './discovery/favorites-sync.cjs': require('../electron/discovery/favorites-sync.cjs'),
    './discovery/discovery-pipeline.cjs': require('../electron/discovery/discovery-pipeline.cjs'),
    './discovery/discovery-scheduler.cjs': require('../electron/discovery/discovery-scheduler.cjs'),
    './discovery/auto-contact.cjs': require('../electron/discovery/auto-contact.cjs'),
    './discovery/candidate-audit.cjs': require('../electron/discovery/candidate-audit.cjs'),
    // P2-15：统一动作门控是 main.cjs 的新依赖，接线测试必须显式映射，否则退回真实 require。
    './contact/action-gate.cjs': require('../electron/contact/action-gate.cjs'),
    './discovery/profile-navigator.cjs': require('../electron/discovery/profile-navigator.cjs'),
    './discovery/comment-snapshot.cjs': require('../electron/discovery/comment-snapshot.cjs'),
    // P2-17B：三来源批次与筛选是 main.cjs 的新依赖，接线测试必须显式映射。
    './discovery/batch-runner.cjs': require('../electron/discovery/batch-runner.cjs'),
    './discovery/batch-filter.cjs': require('../electron/discovery/batch-filter.cjs'),
    './social-brain/comment-collector.cjs': require('../electron/social-brain/comment-collector.cjs'),
    './social-brain/library-store.cjs': require('../electron/social-brain/library-store.cjs'),
    './social-brain/library-classifier.cjs': require('../electron/social-brain/library-classifier.cjs'),
    './social-brain/library-candidates.cjs': require('../electron/social-brain/library-candidates.cjs'),
    './social-brain/first-contact.cjs': require('../electron/social-brain/first-contact.cjs'),
    './social-brain/comment-learning.cjs': require('../electron/social-brain/comment-learning.cjs'),
    './social-brain/comment-learning-runner.cjs': require('../electron/social-brain/comment-learning-runner.cjs'),
    './social-brain/comment-classifier.cjs': require('../electron/social-brain/comment-classifier.cjs'),
    './social-brain/library-benchmark.cjs': require('../electron/social-brain/library-benchmark.cjs'),
    './video-openings.cjs': { VideoOpeningService: Video },
    './ai-service.cjs': { AiService: class { constructor(storage) { this.storage = storage } } },
    './update-service.cjs': {},
  }
  const context = vm.createContext({
    require: request => Object.hasOwn(dependencies, request) ? dependencies[request] : require(request),
    __dirname: dir, Buffer, Date, structuredClone,
    process: { env: { DOUYIN_ASSISTANT_DATA_DIR: dir }, argv: [], pid: 0, platform: 'linux', on() {} },
    setTimeout, setInterval, clearInterval,
  })
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
  vm.runInContext(`${source}\n globalThis.wiring = { startAccountServices, stopAccountServices, clearAccount, activateAccount, writeAccountIndex, services };`, context)
  const wiring = context.wiring
  const invoke = (channel, payload) => handlers.get(channel)(null, payload)
  return { ...wiring, handlers, appEvents, calls, invoke, setClearError: error => { clearError = error } }
}

test('legacy and fresh accounts default to automatic friendship switched off', () => {
  assert.equal(defaults.friendship.automatic.enabled, false)
  assert.deepEqual(migrateLegacy({}).friendship, defaults.friendship)
  assert.equal(migrateLegacy({ friendship: { automatic: { enabled: 'true' } } }).friendship.automatic.enabled, false)
})

test('migration retains resumable stages, candidate identities and scheduling diagnostics', () => {
  const autoState = { jobs: [user('first'), user('second', 'followed'), user('third', 'greeted')], candidates: [user('next')], keyword: '猫咪', candidatesDay: '2026-10-10', scanDay: '2026-10-10', dailyScans: 7, nextRunAt: '2026-10-10T15:00:00+08:00', blockedReason: '请先完成验证', lastError: '验证码', lastSelectionReason: '共同兴趣' }
  const friendship = { followed: [{ url: user('third').url, name: '朋友third' }], automatic: { enabled: true, keywords: ['猫咪'], dailyLimit: 4, intervalMinutes: 60 }, autoState }
  const migrated = migrateLegacy({ friendship }).friendship
  assert.deepEqual(migrated.autoState, autoState)
  assert.deepEqual(migrated.followed, friendship.followed)
  assert.equal(migrated.automatic.enabled, true)
  assert.equal(migrated.automatic.intervalMinutes, 60)
})

test('interrupted follow and greeting recover as uncertain without losing attempt evidence', () => {
  const sending = { ...user('a', 'sending'), greetingAttempts: 1, lastAttemptAt: '2026-10-10T10:30:00+08:00' }
  const following = { ...user('b', 'following'), followAttemptAt: '2026-10-10T11:00:00+08:00' }
  const jobs = migrateLegacy({ friendship: { autoState: { jobs: [sending, following] } } }).friendship.autoState.jobs
  assert.equal(jobs[0].status, 'uncertain')
  assert.equal(jobs[0].greetingAttempts, 1)
  assert.equal(jobs[0].lastAttemptAt, sending.lastAttemptAt)
  assert.equal(jobs[1].status, 'follow_uncertain')
  assert.equal(jobs[1].followAttemptAt, following.followAttemptAt)
})

test('migration rejects unsafe candidate URLs and keeps the complete duplicate prevention ledger', () => {
  const valid = Array.from({ length: 405 }, (_, index) => user(`u${index}`, 'greeted'))
  const invalid = ['https://evil.example/user/a', 'https://www.douyin.com/user/self', 'https://www.douyin.com/user/a?token=x', 'https://me:secret@www.douyin.com/user/a'].map(url => ({ ...user('bad'), url }))
  const migrated = migrateLegacy({ friendship: { autoState: { jobs: [...valid, ...invalid], candidates: [user('ok'), ...invalid] } } }).friendship.autoState
  assert.deepEqual(migrated.jobs, valid)
  assert.deepEqual(migrated.candidates, [user('ok')])
})

test('JSON reload preserves persona, existing profiles, encrypted providers and friendship progress', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const before = migrateLegacy({ selfPersona: { name: '本人', identity: '学生', interests: '风景' }, contacts: [{ id: 'old', name: '老朋友', profile: { relationship: '大学舍友', examples: ['确实哈哈'], chatMode: 'oldfriend' }, learning: { messages: [{ role: 'contact', text: '明天见' }] } }], providers: [{ name: 'test', encryptedKey: 'opaque-value' }], settings: { quietHours: false, aiReplyDraftOnly: true }, friendship: { autoState: { jobs: [user('waiting', 'followed')] } } })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(before))
  const storage = new JsonStorage(dir)
  storage.update({ friendship: { automatic: { enabled: true, keywords: ['风景'], dailyLimit: 3, intervalMinutes: 30 } } })
  const after = new JsonStorage(dir).get()
  for (const key of ['contacts', 'providers', 'selfPersona', 'settings']) assert.deepEqual(after[key], before[key])
  assert.equal(after.friendship.automatic.enabled, true)
  assert.deepEqual(after.friendship.autoState.jobs, before.friendship.autoState.jobs)
})

test('each account keeps its historical controller without starting the retired people-search timer', t => {
  const fixture = mainFixture(t)
  const first = fixture.startAccountServices('default'), second = fixture.startAccountServices('second')
  assert.notEqual(first.friendshipAutomatic, second.friendshipAutomatic)
  assert.equal(first.friendshipAutomatic.storage, first.storage)
  assert.equal(second.friendshipAutomatic.friendship, second.friendship)
  assert.equal(first.douyin.friendshipAutomatic, first.friendshipAutomatic)
  assert.equal(second.friendshipAutomatic.accountId, 'second')
  assert.notEqual(first.friendshipAutomatic.started, true)
  assert.equal(fixture.startAccountServices('default'), first)
  assert.equal(fixture.calls.filter(call => call[0] === 'auto-start').length, 0)
})

test('automatic IPC rejects missing or stale account IDs before editing or running either account', async t => {
  const fixture = mainFixture(t)
  const first = fixture.activateAccount('default'), second = fixture.activateAccount('second')
  for (const payload of [undefined, {}, { accountId: 'default', config: { enabled: true } }]) {
    assert.equal(fixture.invoke('friendship:auto-update', payload).ok, false)
    assert.equal((await fixture.invoke('friendship:auto-run', payload)).ok, false)
  }
  assert.equal(first.friendshipAutomatic.updates.length, 0)
  assert.equal(second.friendshipAutomatic.updates.length, 0)
  assert.equal(first.friendshipAutomatic.runs + second.friendshipAutomatic.runs, 0)
  assert.equal(fixture.invoke('friendship:auto-update', { accountId: 'second', config: { enabled: true, dailyLimit: 5 } }).ok, true)
  assert.equal((await fixture.invoke('friendship:auto-run', { accountId: 'second' })).accountId, 'second')
  assert.equal(first.storage.get().friendship.automatic, undefined)
  assert.equal(second.storage.get().friendship.automatic.dailyLimit, 5)
})

test('automatic IPC returns controller failures to the UI without concealing errors', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default')
  entry.friendshipAutomatic.runError = new Error('页面身份不匹配')
  const result = await fixture.invoke('friendship:auto-run', { accountId: 'default' })
  assert.equal(result.ok, false)
  assert.match(result.error, /身份不匹配/)
})

test('account removal stops the automatic controller before closing its browser or worker', t => {
  const fixture = mainFixture(t), entry = fixture.startAccountServices('default')
  fixture.stopAccountServices('default')
  assert.equal(entry.friendshipAutomatic.destroyed, true)
  assert.equal(entry.friendship.destroyed, true)
  assert.equal(entry.douyin.destroyed, true)
  assert.equal(fixture.services.has('default'), false)
  const teardown = fixture.calls.filter(call => call[0].endsWith('destroy')).map(call => call[0])
  assert.deepEqual(teardown, ['auto-destroy', 'friendship-destroy', 'douyin-destroy'])
})

test('account logout disables autonomous actions and reconnects a fresh controller preserving progress', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default')
  fixture.writeAccountIndex({ active: 'default', list: [{ id: 'default', name: '测试账号' }] })
  const savedJob = user('done', 'greeted')
  entry.storage.update({ friendship: { automatic: { enabled: true }, autoState: { jobs: [savedJob] } } })
  const old = entry.friendshipAutomatic
  assert.equal((await fixture.clearAccount('default', 'logout')).ok, true)
  assert.equal(old.destroyed, true)
  assert.notEqual(entry.friendshipAutomatic, old)
  assert.equal(entry.douyin.friendshipAutomatic, entry.friendshipAutomatic)
  assert.equal(entry.storage.get().friendship.automatic.enabled, false)
  assert.deepEqual(entry.storage.get().friendship.autoState.jobs, [savedJob])
  assert.equal(fixture.calls.findIndex(call => call[0] === 'auto-destroy') < fixture.calls.findIndex(call => call[0] === 'clear-session'), true)
})

test('direct Douyin logout disables automatic actions even if logout itself fails', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default')
  entry.friendshipAutomatic.update({ enabled: true })
  const old = entry.friendshipAutomatic
  entry.douyin.logoutError = new Error('登出失败')
  await assert.rejects(fixture.invoke('douyin:logout'), /登出失败/)
  assert.equal(old.destroyed, true)
  assert.equal(entry.storage.get().friendship.automatic.enabled, false)
  assert.notEqual(entry.friendshipAutomatic, old)
  assert.equal(entry.douyin.friendshipAutomatic, entry.friendshipAutomatic)
})

test('failed account session clearing leaves a usable controller with automatic actions disabled', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default')
  fixture.writeAccountIndex({ active: 'default', list: [{ id: 'default', name: '测试账号' }] })
  entry.friendshipAutomatic.update({ enabled: true })
  const old = entry.friendshipAutomatic
  fixture.setClearError(new Error('登录会话清理失败'))
  await assert.rejects(fixture.clearAccount('default', 'logout'), /清理失败/)
  assert.equal(old.destroyed, true)
  assert.notEqual(entry.friendshipAutomatic, old)
  assert.equal(entry.friendshipAutomatic.destroyed, undefined)
  assert.equal(entry.storage.get().friendship.automatic.enabled, false)
})

test('application shutdown destroys automatic controllers for all background accounts', async t => {
  const fixture = mainFixture(t), entries = ['default', 'second'].map(id => fixture.startAccountServices(id))
  await fixture.appEvents.get('before-quit')()
  for (const entry of entries) {
    assert.equal(entry.friendshipAutomatic.destroyed, true)
    assert.equal(entry.friendship.destroyed, true)
    assert.equal(entry.douyin.destroyed, true)
  }
})

test('preload exposes the exact automatic friendship IPC methods with account payloads intact', async () => {
  let bridge
  const calls = []
  const context = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value } }, ipcRenderer: { invoke: async (channel, payload) => { calls.push({ channel, payload }); return { ok: true } } } }) })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), context)
  const update = { accountId: 'default', config: { enabled: true, keywords: ['宠物'] } }, run = { accountId: 'default' }
  await bridge.friendship.autoUpdate(update)
  await bridge.friendship.autoRun(run)
  assert.deepEqual(calls, [{ channel: 'friendship:auto-update', payload: update }, { channel: 'friendship:auto-run', payload: run }])
})
