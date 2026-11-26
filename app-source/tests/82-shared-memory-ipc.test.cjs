const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const shared = require('../electron/social-brain/shared-memory.cjs')
const { buildSharedMemoryCandidates } = require('../electron/social-brain/shared-memory-extractor.cjs')
const journey = require('../electron/social-brain/relationship-journey.cjs')
const source = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8')
const now = new Date('2026-10-10T10:00:00+08:00')
function person(id) {
  const ledger = [
    { id: id + ':c', contactId: id, accountId: 'account-a', role: 'contact', text: '我喜欢英雄联盟', at: '2026-10-09T10:00:00+08:00', source: 'platform_observed' },
    { id: id + ':m', contactId: id, accountId: 'account-a', role: 'me', text: '我也喜欢英雄联盟', at: '2026-10-09T10:01:00+08:00', source: 'platform_send_confirmed', confirmedSent: true, status: 'sent' },
  ]
  const contact = { id, name: '同名朋友', profile: { chatMode: 'oldfriend', call: id }, learning: { messages: ledger }, sharedMemoryLedger: ledger }
  const candidates = buildSharedMemoryCandidates({ contact, now })
  assert.ok(candidates.length)
  contact.sharedMemory = shared.applySharedMemoryOperations(contact, [{ action: 'CREATE', candidateId: candidates[0].id }], { candidates, now })
  contact.relationshipJourney = journey.buildRelationshipJourney({ contact, now })
  return contact
}
function fixture() {
  let state = { contacts: [person('A'), person('B')], settings: { longTermMemory: true }, pendingDrafts: [], selfProfile: {} }
  let account = 'account-a', canceled = 0
  const handlers = new Map(), recordings = []
  const entry = { storage: { get: () => structuredClone(state), update: patch => (state = { ...state, ...structuredClone(patch) }, structuredClone(state)) }, ai: { cancelSharedMemoryExtraction() { canceled++ } }, douyin: { recordConversationMessage(...args) { recordings.push(args); return state.contacts[0] } } }
  const sandbox = { require: request => request.endsWith('relationship-journey.cjs') ? journey : request.endsWith('shared-memory.cjs') ? shared : require(request),
    getActiveServices: () => entry, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
  Object.defineProperty(sandbox, 'activeAccount', { get: () => account })
  vm.runInNewContext(source.slice(source.indexOf('function preserveSharedMemoryFields('), source.indexOf('function selfProfileEntry(')) + '\nglobalThis.protect = preserveSharedMemoryFields;', sandbox)
  vm.runInNewContext(source.slice(source.indexOf('function registerAiHandlers('), source.indexOf('app.whenReady().then(')) + '\nregisterAiHandlers();', sandbox)
  return { get: () => structuredClone(state), update: patch => entry.storage.update(patch), switch: value => { account = value }, canceled: () => canceled,
    recordings, protect: sandbox.protect, invoke: (channel, payload) => handlers.get(channel)(null, payload), entry }
}

test('shared memory delete is account scoped and rejects stale account before modifying either actor', async () => {
  const f = fixture(), before = f.get(), id = before.contacts[0].sharedMemory.memories[0].id
  assert.equal((await f.invoke('shared-memory:delete', { accountId: 'wrong', contactId: 'A', memoryId: id })).ok, false)
  assert.deepEqual(f.get(), before)
  f.switch('account-b')
  assert.equal((await f.invoke('shared-memory:delete', { accountId: 'account-a', contactId: 'A', memoryId: id })).ok, false)
  assert.deepEqual(f.get(), before)
})
test('shared memory delete rejects foreign memory and unknown or ambiguous contact IDs', async () => {
  const f = fixture(), before = f.get(), b = before.contacts[1].sharedMemory.memories[0].id
  for (const payload of [{ contactId: 'A', memoryId: b }, { contactId: 'missing', memoryId: b }, { contactId: '', memoryId: b }]) {
    assert.equal((await f.invoke('shared-memory:delete', { accountId: 'account-a', ...payload })).ok, false)
    assert.deepEqual(f.get(), before)
  }
  f.update({ contacts: [before.contacts[0], before.contacts[0]] })
  assert.equal((await f.invoke('shared-memory:delete', { accountId: 'account-a', contactId: 'A', memoryId: before.contacts[0].sharedMemory.memories[0].id })).ok, false)
})
test('delete keeps a durable tombstone, returns account state and leaves same-name other actor unchanged', async () => {
  const f = fixture(), before = f.get(), id = before.contacts[0].sharedMemory.memories[0].id
  const result = await f.invoke('shared-memory:delete', { accountId: 'account-a', contactId: 'A', memoryId: id })
  assert.equal(result.contacts[0].sharedMemory.memories.length, 0)
  assert.equal(result.contacts[0].sharedMemory.tombstones[0].id, id)
  assert.deepEqual(result.contacts[1], before.contacts[1])
  assert.deepEqual(result.contacts[0].profile, before.contacts[0].profile)
  assert.deepEqual(result.contacts[0].learning, before.contacts[0].learning)
  assert.deepEqual(result.selfProfile, before.selfProfile)
})
test('delete withdraws shared-derived Journey evidence without changing current stage', async () => {
  const f = fixture(), before = f.get(), a = before.contacts[0]
  // Use only derived sources so the contribution is actually distinguishable.
  a.learning.messages = []
  a.relationshipJourney = journey.buildRelationshipJourney({ contact: { ...a, relationshipJourney: undefined }, now })
  assert.ok(a.relationshipJourney.relationshipEvidence.some(e => e.sharedMemoryId))
  f.update({ contacts: [a, before.contacts[1]] })
  const result = await f.invoke('shared-memory:delete', { accountId: 'account-a', contactId: 'A', memoryId: a.sharedMemory.memories[0].id })
  assert.ok(!result.contacts[0].relationshipJourney.relationshipEvidence.some(e => e.sharedMemoryId))
  assert.equal(result.contacts[0].relationshipJourney.currentStage, a.relationshipJourney.currentStage)
})
test('deleted memory invalidates only referencing drafts from its owning actor', async () => {
  const f = fixture(), id = f.get().contacts[0].sharedMemory.memories[0].id
  f.update({ pendingDrafts: [{ id: 1, contactId: 'A', status: 'pending', sharedMemoryIds: [id] }, { id: 2, contactId: 'B', status: 'pending', sharedMemoryIds: [id] }, { id: 3, contactId: 'A', status: 'pending', sharedMemoryIds: [] }, { id: 4, contactId: 'A', status: 'sent', sharedMemoryIds: [id] }] })
  const result = await f.invoke('shared-memory:delete', { accountId: 'account-a', contactId: 'A', memoryId: id })
  assert.deepEqual(result.pendingDrafts.map(d => d.status), ['outdated', 'pending', 'pending', 'sent'])
})
test('stale profile saves cannot overwrite newly extracted memories ledger or deletion tombstones', () => {
  const f = fixture(), state = f.get(), a = state.contacts[0]
  const config = f.protect({ contacts: [{ ...a, profile: { call: '新的称呼' }, sharedMemory: {}, sharedMemoryLedger: [] }] }, state)
  assert.equal(config.contacts[0].profile.call, '新的称呼')
  assert.deepEqual(config.contacts[0].sharedMemory, a.sharedMemory)
  assert.deepEqual(config.contacts[0].sharedMemoryLedger, a.sharedMemoryLedger)
})
test('generic contact creation cannot inject client supplied shared memories or delivery sources', () => {
  const f = fixture(), config = f.protect({ contacts: [{ id: 'new', name: '新朋友', sharedMemory: { fake: true }, sharedMemoryLedger: [{ fake: true }] }] }, f.get())
  assert.equal(config.contacts[0].sharedMemory, undefined)
  assert.equal(config.contacts[0].sharedMemoryLedger, undefined)
})
test('clear learning cancels pending extraction and retains deletion tombstones with other actors untouched', async () => {
  const f = fixture(), before = f.get()
  before.contacts[1].name = '另一个朋友'
  f.update({ contacts: before.contacts })
  const result = await f.invoke('ai:clear-learning', '同名朋友')
  assert.equal(result.ok, true); assert.equal(f.canceled(), 1)
  const after = f.get().contacts
  assert.equal(after[0].learning, undefined); assert.equal(after[0].sharedMemoryLedger, undefined)
  assert.equal(after[0].sharedMemory.memories.length, 0); assert.equal(after[0].sharedMemory.tombstones.length, 1)
  assert.deepEqual(after[1], before.contacts[1]); assert.equal(after[0].profile.call, 'A')
})
test('legacy name-only clear refuses ambiguous actors without deleting either shared memory', async () => {
  const f = fixture(), before = f.get()
  assert.equal((await f.invoke('ai:clear-learning', '同名朋友')).ok, false)
  assert.deepEqual(f.get(), before); assert.equal(f.canceled(), 0)
})
test('training examples are explicitly synthetic even when user confirms a personal speaking sample', async () => {
  const f = fixture()
  await f.invoke('train:learn', { name: '同名朋友', incoming: '假设我们一起去过西安', userText: '写个假设回复' })
  assert.equal(f.recordings.length, 2)
  assert.ok(f.recordings.every(args => args.at(-1).synthetic === true))
  assert.equal(f.get().contacts[0].sharedMemoryLedger.length, 2)
})
