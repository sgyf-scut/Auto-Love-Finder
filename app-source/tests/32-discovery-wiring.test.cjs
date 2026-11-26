const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
require('./setup.cjs')
const { JsonStorage, migrateLegacy, defaults } = require('../electron/storage.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')

function mainFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-discovery-wiring-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const handlers = new Map(), appEvents = new Map(), calls = []
  let clearError
  class Storage {
    constructor() { this.state = { contacts: [], friendship: {}, discovery: { candidates: [] }, settings: {}, providers: [] } }
    get() { return structuredClone(this.state) }
    update(patch) { Object.assign(this.state, patch); return this.get() }
    addLog() {}
  }
  class Douyin {
    constructor(options) { Object.assign(this, options); this.lastSeen = new Map(); this.lastSent = new Map() }
    startWorker() {}
    getEventFollowups() {}
    destroy() { this.destroyed = true; calls.push(['douyin-destroy', this.accountId]) }
    async logout() { if (this.logoutError) throw this.logoutError; return { ok: true } }
  }
  class Discovery {
    constructor(douyin, { accountId }) { this.douyin = douyin; this.accountId = accountId; this.calls = []; calls.push(['discovery-create', accountId]) }
    destroy() { this.destroyed = true; calls.push(['discovery-destroy', this.accountId]) }
    operation(method, ...args) { this.calls.push([method, ...args]); if (this.error) throw this.error; return { ok: true, accountId: this.accountId } }
    start() { return this.operation('start') }
    stop() { return this.operation('stop') }
    open(id) { return this.operation('open', id) }
    inspect(id) { return this.operation('inspect', id) }
    updateConfig(config) { return this.operation('config', config) }
    parseRequirements(text, ai) { return this.operation('parse', text, !!ai) }
    review(id, review) { return this.operation('review', id, review) }
  }
  const dependencies = {
    './navigation-policy.cjs': require('../electron/navigation-policy.cjs'),
    electron: {
      app: { requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} }, on: (event, fn) => appEvents.set(event, fn), whenReady: () => ({ then() {} }), getPath: () => dir, setPath() {}, getVersion: () => 'test' },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      session: { fromPartition: partition => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, clearStorageData: async () => { calls.push(['session-clear', partition]); if (clearError) throw clearError } }) },
      BrowserWindow: { getAllWindows: () => [] },
    },
    './storage.cjs': { JsonStorage: Storage },
    './social-brain/self-profile.cjs': require('../electron/social-brain/self-profile.cjs'),
    './social-brain/self-profile-extractor.cjs': require('../electron/social-brain/self-profile-extractor.cjs'),
    './providers-store.cjs': {},
    './automation.cjs': { DouyinService: Douyin },
    './friendship.cjs': { FriendshipService: class { destroy() {} }, normalizePersona: value => value },
    './auto-friendship.cjs': { AutoFriendshipService: class { start() {} destroy() {} update() {} } },
    './contact-engine.cjs': { ContactEngine: class { start() {} destroy() {} update() {} refresh() {} } },
    './discovery/discovery-engine.cjs': { DiscoveryEngine: Discovery },
    './discovery/comment-collection-service.cjs': require('../electron/discovery/comment-collection-service.cjs'),
    './discovery/favorites-sync.cjs': require('../electron/discovery/favorites-sync.cjs'),
    './discovery/discovery-pipeline.cjs': require('../electron/discovery/discovery-pipeline.cjs'),
    './discovery/discovery-scheduler.cjs': require('../electron/discovery/discovery-scheduler.cjs'),
    './discovery/auto-contact.cjs': require('../electron/discovery/auto-contact.cjs'),
    './discovery/candidate-audit.cjs': require('../electron/discovery/candidate-audit.cjs'),
    './discovery/batch-runner.cjs': require('../electron/discovery/batch-runner.cjs'),
    './discovery/batch-filter.cjs': require('../electron/discovery/batch-filter.cjs'),
    // P2-15：统一动作门控是 main.cjs 的新依赖，接线测试必须显式映射，否则退回真实 require。
    './contact/action-gate.cjs': require('../electron/contact/action-gate.cjs'),
    './discovery/profile-navigator.cjs': require('../electron/discovery/profile-navigator.cjs'),
    './discovery/comment-snapshot.cjs': require('../electron/discovery/comment-snapshot.cjs'),
    './social-brain/comment-collector.cjs': require('../electron/social-brain/comment-collector.cjs'),
    './social-brain/library-store.cjs': require('../electron/social-brain/library-store.cjs'),
    './social-brain/library-classifier.cjs': require('../electron/social-brain/library-classifier.cjs'),
    './social-brain/library-candidates.cjs': require('../electron/social-brain/library-candidates.cjs'),
    './social-brain/first-contact.cjs': require('../electron/social-brain/first-contact.cjs'),
    './social-brain/comment-learning.cjs': require('../electron/social-brain/comment-learning.cjs'),
    './social-brain/comment-learning-runner.cjs': require('../electron/social-brain/comment-learning-runner.cjs'),
    './social-brain/comment-classifier.cjs': require('../electron/social-brain/comment-classifier.cjs'),
    './social-brain/library-benchmark.cjs': require('../electron/social-brain/library-benchmark.cjs'),
    './video-openings.cjs': { VideoOpeningService: class { destroy() {} } },
    './ai-service.cjs': { AiService: class {} },
    './update-service.cjs': {},
  }
  const context = vm.createContext({ require: request => Object.hasOwn(dependencies, request) ? dependencies[request] : require(request), __dirname: dir, Buffer, Date, structuredClone, process: { env: { DOUYIN_ASSISTANT_DATA_DIR: dir }, argv: [], pid: 0, platform: 'linux', on() {} }, setTimeout, setInterval, clearInterval })
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')}\n globalThis.fixture = { startAccountServices, stopAccountServices, activateAccount, clearAccount, writeAccountIndex, services };`, context)
  return { ...context.fixture, handlers, appEvents, calls, invoke: (channel, payload) => handlers.get(channel)(null, payload), setClearError: value => { clearError = value } }
}

test('fresh and migrated discovery data has no enabled background discovery or send controls', () => {
  assert.equal(JSON.stringify(migrateLegacy({}).discovery), JSON.stringify(defaults.discovery))
  assert.equal(defaults.discovery.runState.running, undefined)
  assert.equal(defaults.discovery.config.enabled, undefined)
  assert.deepEqual(defaults.discovery.candidates, [])
})

test('requirements parsing uses the current account AI and rejects stale account requests', async t => {
  const f = mainFixture(t); f.activateAccount('default')
  const ok = await f.invoke('discovery:parse', { accountId: 'default', text: '女生粉丝少于150' })
  assert.equal(ok.ok, true); assert.deepEqual(f.services.get('default').discovery.calls[0], ['parse', '女生粉丝少于150', true])
  const stale = await f.invoke('discovery:parse', { accountId: 'other', text: '女生' })
  assert.equal(stale.ok, false); assert.match(stale.error, /账号已经切换/)
})

test('JSON reload preserves reviewed candidates, comment provenance and unrelated private settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-discovery-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const original = migrateLegacy({ selfPersona: { name: '本人', identity: '学生', interests: '徒步' }, providers: [{ name: 'private-model', encryptedKey: 'opaque-encrypted-value' }], contacts: [{ id: 'old', name: '老朋友', profile: { relationship: '室友', chatMode: 'oldfriend', examples: ['确实哈哈'] } }], settings: { quietHours: false, aiReplyDraftOnly: true }, friendship: { automatic: { enabled: true, dailyLimit: 4 } } })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(original))
  const storage = new JsonStorage(dir), manager = new CandidateManager(storage)
  manager.updateConfig({ topics: [{ id: 'walk', label: '徒步', enabled: true, keywords: ['周末徒步'] }], videoTags: ['户外'], videoKeywords: ['周末徒步'], maxVideosPerRun: 2, commentsPerVideo: 12 })
  manager.upsert([{ nickname: '山野朋友', profileUrl: 'https://www.douyin.com/user/MS4wLjABhiker', source: { topic: '徒步', keyword: '周末徒步', videoId: '76123456', videoTitle: '周末路线', commentId: 'comment-1', commentText: '这个路线我也走过' } }], { accountId: 'default' })
  const candidate = manager.get().candidates[0]
  manager.review(candidate.id, { status: 'REJECTED', note: '人工判断不适合' })
  const expected = storage.get().discovery
  const reloaded = new JsonStorage(dir).get()
  assert.deepEqual(reloaded.discovery, expected)
  assert.deepEqual(reloaded.discovery.config.videoTags, ['户外']); assert.deepEqual(reloaded.discovery.config.videoKeywords, ['周末徒步'])
  for (const key of ['selfPersona', 'providers', 'contacts', 'settings', 'friendship']) assert.deepEqual(reloaded[key], original[key])
  assert.equal(reloaded.discovery.candidates[0].sources[0].commentText, '这个路线我也走过')
  assert.equal(reloaded.discovery.candidates[0].status, 'REJECTED')
  assert.equal(reloaded.discovery.candidates[0].contact.openingStatus, 'not_started')
})

test('each account has an isolated discovery engine without starting discovery automatically', t => {
  const fixture = mainFixture(t)
  const first = fixture.startAccountServices('default'), second = fixture.startAccountServices('second')
  assert.notEqual(first.discovery, second.discovery)
  assert.equal(first.discovery.douyin.storage, first.storage)
  assert.equal(second.discovery.accountId, 'second')
  assert.equal(first.discovery.calls.length + second.discovery.calls.length, 0)
  assert.equal(fixture.startAccountServices('default'), first)
  assert.equal(fixture.calls.filter(call => call[0] === 'discovery-create').length, 2)
})

test('discovery IPC rejects missing or stale account IDs before every operation', async t => {
  const fixture = mainFixture(t)
  const first = fixture.startAccountServices('default'), second = fixture.activateAccount('second')
  for (const channel of ['config', 'start', 'stop', 'open', 'inspect', 'review']) {
    for (const payload of [undefined, {}, { accountId: 'default', id: 'candidate', config: { keyword: '徒步' } }]) {
      const result = await fixture.invoke(`discovery:${channel}`, payload)
      assert.equal(result.ok, false)
      assert.match(result.error, /账号已经切换/)
    }
  }
  assert.equal(first.discovery.calls.length + second.discovery.calls.length, 0)
})

test('discovery IPC passes only the requested config and review fields to the engine', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default')
  const common = { accountId: 'default', id: 'candidate', status: 'APPROVED', note: '共同兴趣', config: { keywords: ['徒步'] }, send: true }
  for (const channel of ['config', 'start', 'stop', 'open', 'inspect', 'review']) assert.equal((await fixture.invoke(`discovery:${channel}`, common)).ok, true)
  assert.equal(JSON.stringify(entry.discovery.calls), JSON.stringify([
    ['config', common.config], ['start'], ['stop'], ['open', common.id], ['inspect', common.id], ['review', common.id, { status: common.status, note: common.note }],
  ]))
})

test('discovery IPC surfaces engine failures without changing candidate status', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default')
  entry.discovery.error = new Error('作者主页身份不匹配')
  const result = await fixture.invoke('discovery:inspect', { accountId: 'default', id: 'candidate' })
  assert.equal(result.ok, false)
  assert.match(result.error, /身份不匹配/)
  assert.equal(entry.storage.get().discovery.candidates.length, 0)
})

test('switching accounts cancels the previous discovery and recreates it on return without affecting friendship', t => {
  const fixture = mainFixture(t), first = fixture.activateAccount('default')
  const engine = first.discovery, friendship = first.friendship, automatic = first.friendshipAutomatic
  first.storage.update({ discovery: { candidates: [{ id: 'saved-review', status: 'REJECTED' }] } })
  const second = fixture.activateAccount('second'), secondEngine = second.discovery
  assert.equal(engine.destroyed, true)
  assert.equal(first.discovery, null)
  fixture.activateAccount('default')
  assert.equal(secondEngine.destroyed, true)
  assert.notEqual(first.discovery, engine)
  assert.equal(first.discovery.calls.length, 0)
  assert.equal(first.friendship, friendship)
  assert.equal(first.friendshipAutomatic, automatic)
  assert.equal(first.storage.get().discovery.candidates[0].status, 'REJECTED')
})

test('logout cancels discovery before clearing the session and reconstructs a stopped engine', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default'), old = entry.discovery
  fixture.writeAccountIndex({ active: 'default', list: [{ id: 'default', name: '测试账号' }] })
  await fixture.clearAccount('default', 'logout')
  assert.equal(old.destroyed, true)
  assert.notEqual(entry.discovery, old)
  assert.equal(entry.discovery.calls.length, 0)
  assert.equal(fixture.calls.findIndex(call => call[0] === 'discovery-destroy') < fixture.calls.findIndex(call => call[0] === 'session-clear'), true)
})

test('failed logout still reconstructs discovery without resuming any collection', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default'), old = entry.discovery
  entry.douyin.logoutError = new Error('登出失败')
  await assert.rejects(fixture.invoke('douyin:logout'), /登出失败/)
  assert.equal(old.destroyed, true)
  assert.notEqual(entry.discovery, old)
  assert.equal(entry.discovery.calls.length, 0)
})

test('failed account session clearing preserves a usable inactive discovery engine', async t => {
  const fixture = mainFixture(t), entry = fixture.activateAccount('default'), old = entry.discovery
  fixture.writeAccountIndex({ active: 'default', list: [{ id: 'default', name: '测试账号' }] })
  fixture.setClearError(new Error('会话清理失败'))
  await assert.rejects(fixture.clearAccount('default', 'logout'), /清理失败/)
  assert.equal(old.destroyed, true)
  assert.notEqual(entry.discovery, old)
  assert.equal(entry.discovery.calls.length, 0)
})

test('account removal and application shutdown destroy every discovery before its worker', async t => {
  const fixture = mainFixture(t), first = fixture.startAccountServices('default'), second = fixture.startAccountServices('second')
  const firstEngine = first.discovery, secondEngine = second.discovery
  fixture.stopAccountServices('default')
  await fixture.appEvents.get('before-quit')()
  assert.equal(firstEngine.destroyed, true)
  assert.equal(secondEngine.destroyed, true)
  for (const id of ['default', 'second']) assert.equal(fixture.calls.findIndex(call => call[0] === 'discovery-destroy' && call[1] === id) < fixture.calls.findIndex(call => call[0] === 'douyin-destroy' && call[1] === id), true)
})

test('preload discovery bridge preserves structured account payloads for all methods', async () => {
  let bridge
  const calls = []
  const context = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value } }, ipcRenderer: { invoke: async (channel, payload) => { calls.push({ channel, payload }); return { ok: true } } } }) })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), context)
  const payload = { accountId: 'default', id: 'candidate', status: 'REJECTED', note: '已审核', config: { keywords: ['宠物'] } }
  for (const [method, channel] of [['updateConfig', 'config'], ['start', 'start'], ['stop', 'stop'], ['open', 'open'], ['inspect', 'inspect'], ['review', 'review']]) {
    await bridge.discovery[method](payload)
    assert.equal(calls.at(-1).channel, `discovery:${channel}`)
    assert.equal(calls.at(-1).payload, payload)
  }
})
