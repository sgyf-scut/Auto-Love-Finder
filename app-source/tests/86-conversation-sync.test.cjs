const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { ConversationSyncManager, normalizeConversationSync, RECONCILE_INTERVAL_MS } = require('../electron/conversation-sync.cjs')

function fixture(initial = {}, accountId = 'account-a') {
  const storage = createMemoryStorage(initial)
  let now = Date.parse('2026-10-14T00:00:00Z')
  const clock = () => new Date(now)
  const manager = new ConversationSyncManager({ storage, accountId, clock })
  return { manager, storage, clock, advance(ms) { now += ms }, now: () => now }
}
const contact = (id = 'c1', name = 'Alice', platformUserId = '') => ({ id, name, profile: platformUserId ? { platformUserId, dmIdentityVerified: true } : {}, learning: { facts: ['keep'] } })
function exhaust(f, contactId = 'c1') {
  for (const delay of [10000, 30000, 90000, 0]) {
    f.manager.failure(contactId, { reason: 'missing_conversation' })
    if (delay) f.advance(delay)
  }
}

test('four genuine failures stop targeted work after 10/30/90-second backoff', () => {
  const f = fixture(); f.manager.observe([contact()])
  assert.equal(f.manager.canAttempt('c1'), true)
  for (const [index, delay] of [10000, 30000, 90000].entries()) {
    const record = f.manager.failure('c1', { reason: 'list_missing' })
    assert.equal(record.attempts, index + 1); assert.equal(record.status, 'TEMP_UNAVAILABLE')
    assert.equal(record.nextRetryAt, f.now() + delay); assert.equal(f.manager.canAttempt('c1'), false)
    assert.deepEqual(f.manager.due().targets, [])
    f.advance(delay - 1); assert.equal(f.manager.canAttempt('c1'), false)
    f.advance(1); assert.equal(f.manager.canAttempt('c1'), true)
  }
  assert.equal(f.manager.failure('c1', {}).status, 'NEEDS_REVIEW')
  f.advance(3600000)
  assert.equal(f.manager.failure('c1', {}).attempts, 4)
  assert.equal(f.manager.canAttempt('c1'), false); assert.deepEqual(f.manager.due().targets, [])
})

test('snapshot, manual refresh, reconnect and manual window defer preserve exhaustion', () => {
  const f = fixture(); f.manager.observe([contact()]); exhaust(f)
  for (let n = 0; n < 20; n++) { f.advance(5000); f.manager.observe([contact()]) }
  f.manager.request({ reason: 'manual_refresh', contactId: 'c1' }); f.manager.resetForReconnect()
  f.manager.defer('c1', 'manual_window_visible')
  assert.equal(f.manager.getRecord('c1').attempts, 4); assert.equal(f.manager.getRecord('c1').status, 'NEEDS_REVIEW')
  assert.deepEqual(f.manager.due({ manualVisible: true }), { targets: [], events: [], reconcile: false })
  assert.deepEqual(f.manager.due({ idle: false }), { targets: [], events: [], reconcile: false })
})

test('only distinct incoming evidence revives failures; an old event remains deduplicated after success', () => {
  const f = fixture(); f.manager.observe([contact()]); exhaust(f)
  f.manager.request({ reason: 'new_incoming', contactId: 'c1' })
  assert.equal(f.manager.getRecord('c1').attempts, 4)
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'message-1' })
  assert.equal(f.manager.getRecord('c1').attempts, 0)
  f.manager.failure('c1', {}); f.advance(10000)
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'message-1' })
  assert.equal(f.manager.getRecord('c1').attempts, 1)
  f.manager.bind({ contactId: 'c1', name: 'Alice', platformUserId: 'user1', verified: true, source: 'active_panel' })
  f.manager.markReady('c1'); assert.equal(f.manager.state().pending.length, 0)
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'message-1' })
  assert.equal(f.manager.state().pending.length, 0)
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'message-2' })
  assert.equal(f.manager.getRecord('c1').status, 'IDENTITY_VERIFIED')
  assert.equal(f.manager.state().pending.length, 1)
})

test('backoff and incoming dedup survive a new manager using persisted storage', () => {
  const f = fixture(); f.manager.observe([contact()])
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'saved-message' }); f.manager.failure('c1', {})
  f.advance(4000)
  const restarted = new ConversationSyncManager({ storage: f.storage, accountId: 'account-a', clock: f.clock })
  assert.equal(restarted.canAttempt('c1'), false); assert.equal(restarted.getRecord('c1').nextRetryAt, f.now() + 6000)
  restarted.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'saved-message' })
  assert.equal(restarted.getRecord('c1').attempts, 1)
  f.advance(6000); assert.equal(restarted.canAttempt('c1'), true)
})

test('account identity, events and retries remain isolated even for identical contact IDs', () => {
  const f = fixture(); f.manager.observe([contact('same', 'Alice', 'user1')]); exhaust(f, 'same')
  const b = new ConversationSyncManager({ storage: f.storage, accountId: 'account-b', clock: f.clock })
  b.observe([contact('same', 'Alice', 'user2'), { ...contact('foreign', 'Foreign', 'user1'), accountId: 'account-a' }])
  b.request({ reason: 'new_incoming', contactId: 'same', eventKey: 'shared-message' })
  assert.equal(b.getRecord('same').attempts, 0); assert.equal(b.getRecord('same').platformUserId, 'user2')
  assert.equal(b.getRecord('foreign'), null)
  assert.equal(f.manager.getRecord('same').attempts, 4); assert.equal(f.manager.getRecord('same').platformUserId, 'user1')
  assert.equal(f.storage.get().conversationSync.accounts.length, 2)
})

test('the ten-minute idle reconcile schedule advances only on completed work', () => {
  const f = fixture()
  assert.equal(f.manager.due().reconcile, false)
  f.advance(RECONCILE_INTERVAL_MS - 1); assert.equal(f.manager.due().reconcile, false)
  f.advance(1); assert.equal(f.manager.due().reconcile, true)
  assert.equal(f.manager.due({ idle: false }).reconcile, false)
  assert.equal(f.manager.state().lastReconciledAt, 0)
  f.manager.completeReconcile()
  assert.equal(f.manager.state().lastReconciledAt, f.now()); assert.equal(f.manager.due().reconcile, false)
  f.advance(RECONCILE_INTERVAL_MS); assert.equal(f.manager.due().reconcile, true)
})

test('follow confirmation without a conversation queues bounded reconcile and creates no contact', () => {
  const f = fixture()
  f.manager.request({ reason: 'follow_confirmed', name: 'Alice', platformUserId: 'user1', eventKey: 'follow-1' })
  assert.equal(f.manager.state().records.length, 0); assert.equal(f.storage.get().contacts.length, 0)
  assert.equal(f.manager.due().reconcile, true); assert.equal(f.manager.due().targets.length, 0)
  f.manager.completeReconcile(); assert.equal(f.manager.due().reconcile, false)
  f.advance(5000); f.manager.request({ reason: 'follow_confirmed', name: 'Alice', platformUserId: 'user1', eventKey: 'follow-1' })
  assert.equal(f.manager.due().reconcile, false); assert.equal(f.manager.state().pending.length, 1)
  f.manager.observe([contact('c1', 'Alice')]); assert.equal(f.manager.state().pending[0].contactId, '')
  f.manager.observe([contact('c1', 'Alice', 'user1')])
  assert.equal(f.manager.state().pending[0].contactId, 'c1'); assert.equal(f.manager.due().targets.length, 1)
})

test('plain names, avatars, candidate IDs and unverified binds cannot reach READY', () => {
  const f = fixture()
  f.manager.observe([{ ...contact(), avatar: 'same.png', platformUserId: 'candidate1' }])
  assert.equal(f.manager.getRecord('c1').identityVerified, false)
  f.manager.bind({ contactId: 'c1', platformUserId: 'candidate1', source: 'candidate' })
  f.manager.markReady('c1'); assert.notEqual(f.manager.getRecord('c1').status, 'READY')
  assert.equal(f.manager.getRecord('c1').platformUserId, '')
  assert.equal(f.manager.getRecord('c1').lastVerifiedAt, 0)
  f.manager.bind({ contactId: 'c1', platformUserId: 'candidate1', verified: true })
  assert.equal(f.manager.getRecord('c1').identityVerified, false)
})

test('verified profile identity revives an unknown legacy record once, and repeated snapshots preserve failures', () => {
  const f = fixture(); f.manager.observe([contact()]); exhaust(f)
  f.manager.observe([contact('c1', 'Alice', 'user1')])
  assert.equal(f.manager.getRecord('c1').attempts, 0); assert.equal(f.manager.getRecord('c1').status, 'IDENTITY_VERIFIED')
  f.manager.failure('c1', {}); const retry = f.manager.getRecord('c1').nextRetryAt
  f.advance(5000); f.manager.observe([contact('c1', 'Alice', 'user1')])
  assert.equal(f.manager.getRecord('c1').attempts, 1); assert.equal(f.manager.getRecord('c1').nextRetryAt, retry)
  f.manager.markReady('c1'); assert.equal(f.manager.getRecord('c1').status, 'TEMP_UNAVAILABLE')
  f.advance(5000); f.manager.markReady('c1'); assert.equal(f.manager.getRecord('c1').status, 'READY')
})

test('all supported explicit contact proof fields are recognized', () => {
  const f = fixture()
  f.manager.observe([
    { ...contact('p1'), profile: { platformUserId: 'user1', identityVerified: true } },
    { ...contact('p2', 'Bob'), platformUserId: 'user2', identityVerified: true },
    contact('p3', 'Carol', 'user3'),
  ])
  for (const cid of ['p1', 'p2', 'p3']) assert.equal(f.manager.getRecord(cid).identityVerified, true)
})

test('identity proof applies to its matching ID field and contradictory trusted proofs stop binding', () => {
  const f = fixture()
  f.manager.observe([{ ...contact('mixed'), profile: { platformUserId: 'candidate1' }, platformUserId: 'verified1', identityVerified: true }])
  assert.equal(f.manager.getRecord('mixed').platformUserId, 'verified1')
  f.manager.observe([{ ...contact('conflict'), profile: { platformUserId: 'verified2', dmIdentityVerified: true }, platformUserId: 'verified3', identityVerified: true }])
  assert.equal(f.manager.getRecord('conflict').platformUserId, 'verified2')
  assert.equal(f.manager.getRecord('conflict').identityConflict, 'platform_identity_conflict')
})

test('same verified platform ID retains aliases and contact associations through renames', () => {
  const f = fixture(); f.manager.observe([contact('old', 'Alice', 'user1')]); f.manager.markReady('old')
  f.manager.observe([contact('old', 'Alice renamed', 'user1')])
  assert.equal(f.manager.getRecord('old').status, 'READY')
  f.manager.observe([contact('new', 'Alice newest', 'user1')])
  assert.equal(f.manager.state().records.length, 1)
  const record = f.manager.getRecord('new')
  assert.equal(record.contactId, 'old'); assert.deepEqual(record.contactIds, ['old', 'new'])
  assert.ok(record.aliases.includes('Alice')); assert.ok(record.aliases.includes('Alice renamed'))
  assert.equal(record.platformUserId, 'user1')
})

test('same nickname with different verified IDs stays pending and cannot be silently rebound', () => {
  const f = fixture(); f.manager.observe([contact('a', 'Same', 'user1'), contact('b', 'Same', 'user2')])
  for (const cid of ['a', 'b']) {
    assert.equal(f.manager.getRecord(cid).status, 'IDENTITY_PENDING'); assert.equal(f.manager.canAttempt(cid), false)
    f.manager.markReady(cid); assert.equal(f.manager.getRecord(cid).status, 'IDENTITY_PENDING')
  }
  f.manager.request({ reason: 'new_incoming', contactId: 'a', eventKey: 'new-real-message' })
  assert.equal(f.manager.getRecord('a').status, 'IDENTITY_PENDING')
  f.manager.bind({ contactId: 'a', name: 'Same', platformUserId: 'user2', verified: true, source: 'active_panel' })
  assert.equal(f.manager.getRecord('a').platformUserId, 'user1')
  assert.equal(f.manager.getRecord('a').identityConflict, 'platform_identity_conflict')
})

test('similar nicknames are distinct and an omitted snapshot contact keeps durable state', () => {
  const f = fixture(); f.manager.observe([contact('a', 'Alice', 'user1'), contact('b', 'Alice.', 'user2')])
  f.manager.markReady('a'); f.manager.markReady('b')
  f.manager.observe([contact('b', 'Alice.', 'user2')], { complete: true })
  assert.equal(f.manager.state().records.length, 2); assert.equal(f.manager.getRecord('a').status, 'READY')
  assert.equal(f.manager.getRecord('b').platformUserId, 'user2')
})

test('sync persists only its own root and leaves learning and contact profiles untouched', () => {
  const saved = contact('c1', 'Alice', 'user1')
  saved.relationshipJourney = { stage: 'familiar', history: ['keep'] }; saved.sharedMemory = { items: ['keep'] }
  const f = fixture({ contacts: [saved], selfPersona: { unchanged: true } }), before = f.storage.get()
  f.manager.observe(before.contacts); f.manager.failure('c1', {}); f.advance(10000); f.manager.markReady('c1')
  const after = f.storage.get(); delete before.conversationSync; delete after.conversationSync
  assert.deepEqual(after, before)
})

test('failed captures with duplicate evidence or early retry cannot consume more attempts', () => {
  const f = fixture(); f.manager.observe([contact()])
  f.manager.failure('c1', { evidenceKey: 'capture-1' }); f.manager.failure('c1', { evidenceKey: 'capture-2' })
  assert.equal(f.manager.getRecord('c1').attempts, 1)
  f.advance(10000); f.manager.failure('c1', { evidenceKey: 'capture-1' })
  assert.equal(f.manager.getRecord('c1').attempts, 1)
  f.manager.failure('c1', { evidenceKey: 'capture-2' }); assert.equal(f.manager.getRecord('c1').attempts, 2)
  f.advance(30000); f.manager.failure('c1', { evidenceKey: 'capture-1' }); assert.equal(f.manager.getRecord('c1').attempts, 2)
})

test('old malformed state is bounded and cannot import READY or another account identity without proof', () => {
  const old = { accounts: [{ accountId: 'a', records: [
    { contactId: 'legacy', name: 'Old', platformUserId: 'unverified', status: 'READY' },
    { contactId: 'cross', accountId: 'b', identityVerified: true, platformUserId: 'other', status: 'READY' },
    { contactId: 'bad', status: 'nonsense', attempts: -1 },
  ] }] }
  const normalized = normalizeConversationSync(old)
  assert.equal(normalized.accounts[0].records.length, 2)
  assert.equal(normalized.accounts[0].records[0].status, 'IDENTITY_PENDING')
  assert.equal(normalized.accounts[0].records[0].platformUserId, '')
  assert.equal(normalized.accounts[0].records[1].attempts, 0)
  assert.deepEqual(normalizeConversationSync({ records: [{ contactId: 'unscoped' }] }).accounts, [])
  const big = normalizeConversationSync({ accounts: Array.from({ length: 25 }, (_, i) => ({ accountId: `a${i}`, records: Array.from({ length: 510 }, (_, j) => ({ contactId: `c${j}` })), pending: Array.from({ length: 510 }, (_, j) => ({ id: String(j), reason: 'test' })) })) })
  assert.equal(big.accounts.length, 20); assert.equal(big.accounts[0].records.length, 500); assert.equal(big.accounts[0].pending.length, 500)
})

test('a replay remains inert after a bounded queue evicts the original event', () => {
  const f = fixture(); f.manager.observe([contact()])
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'very-old' })
  for (let n = 0; n < 510; n++) f.manager.request({ reason: 'contact_changed', contactId: 'c1', eventKey: `event-${n}` })
  assert.equal(f.manager.state().pending.length, 500)
  exhaust(f); f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'very-old' })
  assert.equal(f.manager.getRecord('c1').attempts, 4)
})

test('exact incoming history accepts distinct dated messages and rejects evicted old or undated hints', () => {
  const f = fixture(); f.manager.observe([contact()])
  const oldest = f.now()
  for (let n = 0; n < 513; n++) {
    f.advance(1)
    f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: `incoming-${n}`, eventAt: f.now() })
  }
  assert.equal(f.manager.getRecord('c1').incomingEvents.length, 512)
  assert.equal(f.manager.getRecord('c1').evidenceVersion, 513)
  exhaust(f)
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'incoming-0', eventAt: oldest + 1 })
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'undated-hint' })
  assert.equal(f.manager.getRecord('c1').attempts, 4)
  f.advance(1)
  f.manager.request({ reason: 'new_incoming', contactId: 'c1', eventKey: 'genuinely-new', eventAt: f.now() })
  assert.equal(f.manager.getRecord('c1').attempts, 0)
})

test('legacy diagnostics cannot starve explicit targets and deferred identity hints rotate', () => {
  const f = fixture(); f.manager.observe(Array.from({ length: 28 }, (_, i) => contact(`legacy-${i}`, `name${i}`)))
  assert.equal(f.manager.state().pending.length, 0)
  f.manager.observe([contact('verified', 'Verified', 'user1')])
  for (let n = 0; n < 5; n++) f.manager.request({ reason: 'reply_requested', contactId: `legacy-${n}` })
  assert.deepEqual(f.manager.due().targets.map(record => record.contactId), ['legacy-0', 'legacy-1', 'legacy-2', 'legacy-3'])
  for (const record of f.manager.due().targets) f.manager.defer(record.contactId, 'identity_unknown')
  assert.deepEqual(f.manager.due().targets.map(record => record.contactId), ['legacy-4', 'verified'])
  assert.equal(f.manager.getRecord('legacy-0').attempts, 0)
})

test('only an eligible successful identity check clears consecutive failures', () => {
  const f = fixture(); f.manager.observe([contact('c1', 'Alice', 'user1')])
  f.manager.failure('c1', {})
  f.manager.success('c1'); assert.equal(f.manager.getRecord('c1').attempts, 1)
  f.advance(10000); f.manager.markReady('c1'); assert.equal(f.manager.getRecord('c1').attempts, 1)
  f.manager.success('c1'); assert.equal(f.manager.getRecord('c1').attempts, 0)
  exhaust(f); f.manager.success('c1'); assert.equal(f.manager.getRecord('c1').status, 'NEEDS_REVIEW')
})

test('a fresh manual matching platform check may recover exhaustion; refresh requests and wrong checks cannot', () => {
  const f = fixture(); f.manager.observe([contact('c1', 'Alice', 'user1')]); exhaust(f)
  f.manager.request({ reason: 'manual_refresh', contactId: 'c1' })
  assert.equal(f.manager.getRecord('c1').status, 'NEEDS_REVIEW')
  f.manager.success('c1', { manualVerified: true })
  f.manager.success('c1', { manualVerified: true, verifiedPlatformUserId: 'different-user' })
  assert.equal(f.manager.getRecord('c1').attempts, 4)
  f.manager.success('c1', { manualVerified: true, verifiedPlatformUserId: 'user1' })
  assert.equal(f.manager.getRecord('c1').attempts, 0); assert.equal(f.manager.getRecord('c1').status, 'READY')
  f.manager.observe([contact('c2', 'Alice', 'user2')])
  f.manager.success('c1', { manualVerified: true, verifiedPlatformUserId: 'user1' })
  assert.equal(f.manager.getRecord('c1').status, 'IDENTITY_PENDING')
})

test('target batches are bounded and destroying a manager stops future schedules', () => {
  const f = fixture(); f.manager.observe(Array.from({ length: 10 }, (_, i) => contact(`c${i}`, `name${i}`)))
  for (let n = 0; n < 10; n++) f.manager.request({ reason: 'reply_requested', contactId: `c${n}` })
  assert.equal(f.manager.due().targets.length, 4)
  f.manager.destroy(); assert.deepEqual(f.manager.due(), { targets: [], events: [], reconcile: false })
  assert.equal(f.manager.canAttempt('c1'), false)
  assert.throws(() => f.manager.observe([]), /destroyed/)
  assert.throws(() => new ConversationSyncManager({ storage: f.storage }), /accountId/)
})
