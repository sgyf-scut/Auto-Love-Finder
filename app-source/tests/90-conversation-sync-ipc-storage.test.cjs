const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
require('./setup.cjs')
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')

function ipcFixture({ contacts = [{ id: 'c1', name: '测试对象' }], refresh } = {}) {
  let account = 'account-a'
  const calls = [], handlers = new Map()
  let entry = { storage: { get: () => ({ contacts }) }, douyin: {
    getConversationSyncManager: () => ({ state: () => ({ accountId: account, records: [] }) }),
    refreshConversationBinding: async id => { calls.push(id); return refresh ? refresh(id) : { ok: true, conversationSync: { accountId: account, records: [{ contactId: id, status: 'IDENTITY_PENDING' }] } } },
  } }
  const sandbox = { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, getActiveServices: () => entry }
  Object.defineProperty(sandbox, 'activeAccount', { get: () => account })
  const start = main.indexOf("for (const method of ['get-state', 'refresh'])")
  assert.ok(start > 0)
  vm.runInNewContext(main.slice(start, main.indexOf("ipcMain.handle('douyin:learn-contact'", start)), sandbox)
  return { calls, call: (method, payload) => handlers.get(`conversation-sync:${method}`)(null, payload), switch: value => { account = value }, replace: value => { entry = value } }
}

test('conversation sync IPC rejects missing and other-account scopes before touching browser', async () => {
  const f = ipcFixture()
  for (const method of ['get-state', 'refresh']) for (const payload of [undefined, {}, { accountId: 'account-b', contactId: 'c1' }]) {
    const result = await f.call(method, payload)
    assert.equal(result.ok, false); assert.match(result.error, /账号/)
  }
  assert.equal(f.calls.length, 0)
})
test('conversation sync reads only active-account projection without browser mutation', async () => {
  const f = ipcFixture(), result = await f.call('get-state', { accountId: 'account-a' })
  assert.equal(result.ok, true); assert.equal(result.conversationSync.accountId, 'account-a'); assert.equal(f.calls.length, 0)
})
test('conversation sync refresh requires a unique local contact ID', async () => {
  for (const contacts of [[], [{ id: 'c1', name: 'a' }, { id: 'c1', name: 'b' }]]) {
    const f = ipcFixture({ contacts }), result = await f.call('refresh', { accountId: 'account-a', contactId: 'c1' })
    assert.equal(result.ok, false); assert.equal(f.calls.length, 0)
  }
  const f = ipcFixture()
  assert.equal((await f.call('refresh', { accountId: 'account-a' })).ok, false)
  assert.equal((await f.call('refresh', { accountId: 'account-a', contactId: '测试对象' })).ok, false)
})
test('conversation sync refresh returns actual identity-pending result without inventing READY', async () => {
  const f = ipcFixture(), result = await f.call('refresh', { accountId: 'account-a', contactId: 'c1' })
  assert.equal(result.ok, true); assert.equal(result.conversationSync.records[0].status, 'IDENTITY_PENDING'); assert.deepEqual(f.calls, ['c1'])
})
test('conversation sync late refresh result cannot update a switched account', async () => {
  let finish
  const f = ipcFixture({ refresh: () => new Promise(resolve => { finish = resolve }) })
  const pending = f.call('refresh', { accountId: 'account-a', contactId: 'c1' })
  f.switch('account-b'); finish({ ok: true, conversationSync: { accountId: 'account-a' } })
  const result = await pending
  assert.equal(result.ok, false); assert.match(result.error, /账号已经切换/)
})
test('conversation sync late refresh result cannot update a replacement service of same account', async () => {
  let finish
  const f = ipcFixture({ refresh: () => new Promise(resolve => { finish = resolve }) })
  const pending = f.call('refresh', { accountId: 'account-a', contactId: 'c1' })
  f.replace({}); finish({ ok: true })
  assert.equal((await pending).ok, false)
})
test('conversation sync refresh errors are returned without a false successful state', async () => {
  const f = ipcFixture({ refresh: async () => { throw Error('身份待核验') } })
  const result = await f.call('refresh', { accountId: 'account-a', contactId: 'c1' })
  assert.equal(result.ok, false); assert.equal(result.error, '身份待核验')
})
test('generic automation IPC cannot forge conversation handoff state', () => {
  const handlers = new Map()
  const start = main.indexOf("ipcMain.handle('automation:update'")
  const stop = main.indexOf('function selfProfileEntry(', start)
  vm.runInNewContext(main.slice(start, stop), { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, getActiveServices: () => ({ storage: { update() { throw Error('must not write') } } }) })
  assert.throws(() => handlers.get('automation:update')(null, { conversationSync: { accounts: [{ records: [{ status: 'READY' }] }] } }), /会话接管/)
})

function followFixture(result, request) {
  const calls = [], handlers = new Map()
  const entry = { friendship: { follow: async () => result }, douyin: { requestConversationSync: payload => { calls.push(payload); return request?.(payload) }, log() {} } }
  const start = main.indexOf("for (const [method, channel] of [['search', 'search-users']")
  const stop = main.indexOf('function friendshipAutoEntry(', start)
  vm.runInNewContext(main.slice(start, stop), {
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, getActiveServices: () => entry, activeAccount: 'a',
    // P2-15：关注入口先过统一门控；本夹具只验证会话同步，门控判定由 115 专项覆盖。
    GATE_ACTIONS: { FOLLOW: 'follow', FIRST_MESSAGE: 'firstMessage' },
    GATE_SOURCES: { MANUAL: 'manual', AUTO_CONTACT: 'autoContact', CONTACT_ENGINE: 'contactEngine', AUTO_FRIENDSHIP: 'autoFriendship' },
    platformUserIdOfUrl: url => String(url || '').match(/^https:\/\/www\.douyin\.com\/user\/([A-Za-z0-9_-]+)$/)?.[1] || '',
    discoveryCandidateOf: () => null,
    evaluateEntryGate: () => ({ allowed: true, status: 'allowed', blockedBy: [], requires: [], code: 'OK' }),
    logGateDecision: () => {},
  })
  return { calls, follow: () => handlers.get('friendship:follow-user')(null, 'https://www.douyin.com/user/user1') }
}
test('manual confirmed follow queues identity-only synchronization without creating a contact or sending', async () => {
  const result = { ok: true, candidate: { url: 'https://www.douyin.com/user/user1', name: '新朋友', followedAt: '2026-10-14T12:00:00Z' } }
  const f = followFixture(result)
  assert.equal((await f.follow()).ok, true)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].reason, 'follow_confirmed'); assert.equal(f.calls[0].platformUserId, 'user1')
  assert.equal(f.calls[0].contactId, undefined)
  const pending = followFixture({ ...result, followPending: true })
  assert.equal((await pending.follow()).ok, true); assert.equal(pending.calls.length, 0)
})
test('local sync-queue failure cannot reclassify an already confirmed remote follow as failed', async () => {
  const f = followFixture({ ok: true, candidate: { url: 'https://www.douyin.com/user/user1', followedAt: '2026-10-14T12:00:00Z' } }, () => { throw Error('local queue unavailable') })
  assert.equal((await f.follow()).ok, true)
})

test('storage initializes legacy states with empty conversation-sync state and retains existing facts', () => {
  const { migrateLegacy } = require('../electron/storage.cjs')
  const result = migrateLegacy({ contacts: [{ id: 'c1', name: '旧朋友', profile: { relationship: '同学' } }], settings: { quietHours: false } })
  assert.deepEqual(result.conversationSync.accounts, [])
  assert.equal(result.contacts[0].profile.relationship, '同学')
  assert.equal(result.settings.quietHours, false)
})
test('conversation-sync state survives storage serialization and reload with backoff', t => {
  const os = require('node:os'), { JsonStorage } = require('../electron/storage.cjs')
  const { ConversationSyncManager } = require('../electron/conversation-sync.cjs')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-sync-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const storage = new JsonStorage(directory)
  storage.update({ contacts: [{ id: 'c1', name: '测试对象', profile: { relationship: '朋友' } }] })
  const clock = () => new Date('2026-10-14T12:00:00Z')
  const manager = new ConversationSyncManager({ storage, accountId: 'a', clock })
  manager.observe(storage.get().contacts)
  manager.failure('c1', { reason: '未找到会话' })
  const original = manager.getRecord('c1')
  assert.ok(original)
  const reloaded = new JsonStorage(directory), second = new ConversationSyncManager({ storage: reloaded, accountId: 'a', clock })
  const actual = second.getRecord('c1')
  assert.equal(actual.attempts, original.attempts)
  assert.equal(actual.nextRetryAt, original.nextRetryAt)
  assert.equal(second.canAttempt('c1'), false)
  assert.equal(reloaded.get().contacts[0].profile.relationship, '朋友')
})
