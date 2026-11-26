const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { ContactEngine } = require('../electron/contact-engine.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { AutoFriendshipService } = require('../electron/auto-friendship.cjs')
const { activeChatIdentity, profileSnapshot } = require('../electron/friendship.cjs')
const { DouyinService } = require('../electron/automation.cjs')

function mainFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-pipeline-wiring-'))
  const handlers = new Map(), calls = []
  class Storage { constructor() { return createMemoryStorage({ selfPersona: { name: '本人', interests: '摄影' } }) } }
  class Douyin {
    constructor(options) { Object.assign(this, options); this.lastSeen = new Map(); this.lastSent = new Map() }
    startWorker() {} getEventFollowups() {} emitEvent() {} getSendAllowance() { return { ok: true } }
    destroy() { this._destroyed = true } async logout() { return { ok: true } }
  }
  class Friendship {
    constructor(douyin) { this.douyin = douyin; this.candidates = new Map() }
    async search(keyword) { calls.push(['search', keyword]); return { ok: true, keyword, candidates: [{ url: 'https://www.douyin.com/user/search-person', name: '新朋友', summary: '在读研究生，喜欢摄影' }] } }
    destroy() { this.destroyed = true }
  }
  class Automatic { constructor(options) { Object.assign(this, options) } start() {} update() {} destroy() { this.destroyed = true } }
  class Discovery { constructor(douyin, options) { this.douyin = douyin; this.accountId = options.accountId } destroy() { this.destroyed = true } review(id, options) { calls.push(['review', id, options]); return { ok: true } } }
  const dependencies = {
    electron: { app: { requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} }, on() {}, whenReady: () => ({ then() {} }), getPath: () => dir, setPath() {}, getVersion: () => 'test' }, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, BrowserWindow: { getAllWindows: () => [] }, session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, clearStorageData: async () => {} }) } },
    './navigation-policy.cjs': require('../electron/navigation-policy.cjs'),
    './storage.cjs': { JsonStorage: Storage }, './providers-store.cjs': {}, './automation.cjs': { DouyinService: Douyin },
    './social-brain/self-profile.cjs': require('../electron/social-brain/self-profile.cjs'),
    './social-brain/self-profile-extractor.cjs': require('../electron/social-brain/self-profile-extractor.cjs'),
    './friendship.cjs': { FriendshipService: Friendship, normalizePersona: v => v }, './auto-friendship.cjs': { AutoFriendshipService: Automatic },
    './contact-engine.cjs': { ContactEngine }, './discovery/discovery-engine.cjs': { DiscoveryEngine: Discovery },
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
    './discovery/candidate-manager.cjs': { CandidateManager }, './video-openings.cjs': { VideoOpeningService: class { destroy() {} } }, './ai-service.cjs': { AiService: class {} }, './update-service.cjs': {},
  }
  const context = vm.createContext({ require: request => dependencies[request] || require(request), __dirname: dir, Buffer, Date, structuredClone,
    process: { env: { DOUYIN_ASSISTANT_DATA_DIR: dir }, argv: [], pid: 0, platform: 'linux', on() {} }, setTimeout, setInterval, clearInterval })
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')}\nglobalThis.wiring={activateAccount,stopAccountServices,services,clearAccount,writeAccountIndex}`, context)
  t.after(() => { for (const id of context.wiring.services.keys()) context.wiring.stopAccountServices(id); fs.rmSync(dir, { recursive: true, force: true }) })
  return { ...context.wiring, calls, invoke: (channel, payload) => handlers.get(channel)(null, payload) }
}

test('contact get-state is read-only and does not refresh or recompute the returned snapshot', async t => {
  const f = mainFixture(t), entry = f.activateAccount('default')
  let reads = 0
  entry.contactEngine.refresh = () => assert.fail('Reading status must not mutate or refresh candidates')
  entry.contactEngine.state = () => { reads++; return { metrics: { discovered: 7 } } }
  const out = await f.invoke('contact:get-state', { accountId: 'default' })
  assert.equal(out.ok, true); assert.equal(out.metrics.discovered, 7); assert.equal(reads, 1)
})

test('every contact IPC rejects missing or stale account before touching the queue', async t => {
  const f = mainFixture(t), entry = f.activateAccount('default')
  for (const method of ['get-state', 'update', 'enqueue', 'run', 'pause', 'resume', 'retry', 'refresh']) {
    for (const payload of [undefined, {}, { accountId: 'wrong', id: 'x', config: { enabled: true } }]) {
      const result = await f.invoke(`contact:${method}`, payload)
      assert.equal(result.ok, false); assert.match(result.error, /账号已经切换/)
    }
  }
  assert.equal(entry.contactEngine.config().enabled, false)
})

test('actual main service passes the same Contact Engine to both sources and cancels it on account switch', t => {
  const f = mainFixture(t), first = f.activateAccount('default'), old = first.contactEngine
  assert.equal(first.friendshipAutomatic.contactEngine, old); assert.equal(first.douyin.contactEngine, old)
  const second = f.activateAccount('other')
  assert.equal(old.destroyed, true); assert.equal(first.contactEngine, null)
  assert.notEqual(second.contactEngine, old)
  f.activateAccount('default')
  assert.notEqual(first.contactEngine, old); assert.equal(first.friendshipAutomatic.contactEngine, first.contactEngine)
})

test('manual user search persists unified identity and source without enabling remote contact', async t => {
  const f = mainFixture(t), entry = f.activateAccount('default')
  const result = await f.invoke('friendship:search-users', '摄影')
  assert.equal(result.ok, true); assert.equal(result.discovery.candidates.length, 1)
  const candidate = result.discovery.candidates[0]
  assert.equal(candidate.platformUserId, 'search-person'); assert.equal(candidate.source.type, 'user_search')
  assert.equal(candidate.source.keyword, '摄影'); assert.equal(candidate.accountId, 'default')
  assert.equal(entry.contactEngine.config().enabled, false)
})

test('manual search returning after an account switch cannot import into either candidate pool', async t => {
  const f = mainFixture(t), first = f.activateAccount('default')
  let done; first.friendship.search = () => new Promise(resolve => { done = resolve })
  const pending = f.invoke('friendship:search-users', '摄影'), second = f.activateAccount('other')
  done({ ok: true, candidates: [{ url: 'https://www.douyin.com/user/stale', name: '过期' }] }); await pending
  assert.equal(first.storage.get().discovery?.candidates?.length || 0, 0); assert.equal(second.storage.get().discovery?.candidates?.length || 0, 0)
})

test('contact settings preserve empty user templates and never execute a contact from save', async t => {
  const f = mainFixture(t), entry = f.activateAccount('default')
  const result = await f.invoke('contact:update', { accountId: 'default', config: { enabled: false, mode: 'review', templates: { default: '' } } })
  assert.equal(result.ok, true); assert.equal(result.config.templates.default, '')
  assert.equal(result.metrics.openingSent, 0); assert.equal(entry.friendship.candidates.size, 0)
})

test('manual age evidence passes through discovery IPC without invoking contact', async t => {
  const f = mainFixture(t); f.activateAccount('default')
  await f.invoke('discovery:review', { accountId: 'default', id: 'person', status: 'APPROVED', ageConfirmation: 25 })
  assert.equal(f.calls[0][2].ageConfirmation, 25)
})

test('preload preserves all structured contact payloads', () => {
  let api; const calls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { api = value } }, ipcRenderer: { invoke: (...args) => calls.push(args), on() {}, removeListener() {} } }) })
  const value = { accountId: 'one', id: 'candidate', config: { templates: { default: '' } } }
  for (const key of ['getState', 'update', 'enqueue', 'run', 'pause', 'resume', 'retry', 'refresh']) api.contact[key](value)
  assert.deepEqual(calls.map(call => call[0]), ['contact:get-state', 'contact:update', 'contact:enqueue', 'contact:run', 'contact:pause', 'contact:resume', 'contact:retry', 'contact:refresh'])
  assert.ok(calls.every(call => call[1] === value))
})

function sharedSource(initial = {}) {
  const storage = createMemoryStorage({ selfPersona: { name: '本人', interests: '摄影' }, providers: [{}], settings: { quietHours: false }, friendship: { automatic: { enabled: true }, ...initial } })
  const calls = [], friendship = { candidates: new Map(), async search(keyword, options) { options.beforeAction(); const candidate = { name: '朋友', url: 'https://www.douyin.com/user/source-person', keyword, summary: '喜欢摄影' }; this.candidates.set(candidate.url, candidate); return { ok: true, candidates: [candidate] } }, follow() { throw Error('不应关注') }, opening() { throw Error('不应AI生成首句') }, greeting() { throw Error('不应发送') } }
  const contactEngine = { destroyed: false, refresh() { calls.push('refresh') } }
  const service = new AutoFriendshipService({ douyin: { getSendAllowance: () => ({ ok: true }) }, friendship, storage, ai: { hasProvider: () => true, pickFriendCandidate() { throw Error('不应旧AI选人') } }, contactEngine, accountId: 'default', clock: () => new Date('2026-10-10T12:00:00+08:00') })
  return { service, storage, calls, friendship, contactEngine }
}

test('shared automatic user search only discovers into the pool and cannot use legacy remote process', async () => {
  const f = sharedSource(), result = await f.service.runOnce()
  assert.equal(result.ok, true); assert.equal(result.discovered, 1); assert.equal(f.calls.length, 1)
  assert.equal(f.storage.get().discovery.candidates[0].source.type, 'user_search')
  assert.equal(f.storage.get().friendship.autoState.jobs.length, 0)
})

test('legacy uncertain follow/send and confirmed first greetings migrate without losing checkpoints', () => {
  const jobs = ['uncertain', 'follow_uncertain', 'greeted'].map((status, index) => ({ id: `old-${index}`, status, name: `朋友${index}`, url: `https://www.douyin.com/user/legacy-${index}`, keyword: '摄影', openingText: '旧首句', ...(status === 'greeted' ? { greetedAt: '2026-10-09T12:00:00+08:00', followedAt: '2026-10-09T11:59:00+08:00' } : {}) }))
  const f = sharedSource({ autoState: { jobs } }), candidates = f.storage.get().discovery.candidates
  assert.deepEqual(candidates.map(c => c.status), ['SEND_UNKNOWN', 'FOLLOW_UNCERTAIN', 'WAITING_REPLY'])
  assert.equal(candidates[2].contact.openingMessage, '旧首句'); assert.equal(f.storage.get().friendship.autoState.jobs.length, 3)
  f.service.migrateContactJobs(); assert.equal(f.storage.get().discovery.candidates.length, 3)
  assert.equal(f.storage.get().discovery.candidates[0].timeline.filter(event => event.type === 'legacy_imported').length, 1)
})

test('a stopped account shared engine prevents automatic source navigation', async () => {
  const f = sharedSource(); f.contactEngine.destroyed = true
  assert.equal((await f.service.runOnce()).skipped, true); assert.equal(f.friendship.candidates.size, 0)
})

function headerIdentity(id, extraId) {
  const title = { innerText: '新朋友', getBoundingClientRect: () => ({ width: 100, height: 30 }), getAttribute: () => '', __reactPropsTest: { curConversation: { toParticipantSecUserId: id } } }
  if (extraId) title.__reactPropsOther = { opponentUserProfile: { secUid: extraId } }
  return vm.runInNewContext(`(${activeChatIdentity.toString()})('新朋友')`, { location: { hostname: 'www.douyin.com' }, document: { querySelectorAll: () => [title] } })
}
test('active chat evidence requires exactly one reliable user ID, never a matching nickname alone', () => {
  assert.equal(headerIdentity('one').platformUserId, 'one')
  assert.equal(headerIdentity('').verified, false); assert.equal(headerIdentity('one', 'other').verified, false)
})

test('history normalization preserves verified identity evidence without inventing an unknown event timestamp', () => {
  const storage = createMemoryStorage({ contacts: [{ id: 'one', name: '新朋友', profile: {}, learning: { messages: [] } }], settings: { longTermMemory: false } })
  const ds = new DouyinService({ storage, ai: {}, partition: 'pipeline-test', emit() {} })
  ds.recordConversationMessage('新朋友', 'contact', '你好', {}, { human: true, at: '', platformUserId: 'verified-user', identityVerified: true })
  const message = storage.get().contacts[0].learning.messages[0]
  assert.equal(message.platformUserId, 'verified-user'); assert.equal(message.identityVerified, true); assert.ok(message.observedAt); assert.ok(!message.at)
  ds.destroy()
})

test('pipeline uses its own switch, verifies incoming identity and hands the first reply to Social Brain', async () => {
  const storage = createMemoryStorage({ selfPersona: { name: '本人' }, settings: { quietHours: false, longTermMemory: true, aiReplyDraftOnly: true }, automation: { autoReply: false, paused: false }, friendship: { automatic: { enabled: false }, contactConfig: { enabled: true } } })
  const manager = new CandidateManager(storage)
  const candidate = manager.upsertUserSearch([{ url: 'https://www.douyin.com/user/pipeline-user', name: '新朋友', summary: '本人学生' }], { accountId: 'default', keyword: '学生' }).discovery.candidates[0]
  manager.patch(candidate.id, { status: 'WAITING_REPLY', contact: { openingSentAt: '2026-10-01T12:00:00+08:00', contactId: 'new-contact', openingStatus: 'sent' } })
  const contact = { id: 'new-contact', name: '新朋友', preview: '你好呀', fromMe: false, profile: { chatMode: 'friendship', useSelfPersona: true, autoFriendship: true, contactPipeline: true, candidateId: candidate.id, platformUserId: 'pipeline-user', dmIdentityVerified: true, autoFriendshipUrl: candidate.profileUrl }, learning: { messages: [] }, turn: {} }
  storage.update({ contacts: [contact] })
  let sent = 0
  const ds = new DouyinService({ storage, ai: { hasProvider: () => true, draft: async () => ({ ok: true, text: '你好哈哈' }) }, partition: 'pipeline-test', emit() {} })
  const engine = new ContactEngine({ douyin: ds, friendship: { candidates: new Map() }, storage, accountId: 'default' }); ds.contactEngine = engine
  ds.selectConversation = async () => null; ds.isLastMessageFromMe = async () => false
  ds.window = { isDestroyed: () => false, webContents: { executeJavaScript: async () => ({ verified: true, platformUserId: 'pipeline-user' }) } }
  ds.sendMessage = async (_, __, metadata) => { await metadata.beforeSubmit(); sent++ }
  const item = { name: contact.name, key: 'fresh-incoming', preview: contact.preview, incomingIdentity: { role: 'contact' } }
  ds.enqueueIncoming(item)
  const result = await ds.handleIncomingItem(item, contact, { settings: storage.get().settings, today: '2026-10-10', factCandidates: [], topicCandidates: [], autoReplyOn: false })
  assert.equal(result, 'consumed'); assert.equal(sent, 1); assert.equal(manager.get().candidates[0].status, 'CONTACT')
  assert.ok(storage.get().contacts[0].socialBrain); assert.equal(storage.get().contacts[0].learning.messages[0].platformUserId, 'pipeline-user')
  ds.window = null; engine.destroy(); ds.destroy()
})
