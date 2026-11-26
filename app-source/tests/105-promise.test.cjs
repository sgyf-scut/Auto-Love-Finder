const { createMemoryStorage } = require('./setup.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizePromises, resolvePromise, cancelPromise } = require('../electron/social-brain/promise.cjs')
const { buildPromiseCandidates, extractPromises } = require('../electron/social-brain/promise-extractor.cjs')
const { AiService } = require('../electron/ai-service.cjs')

const at = (d = 1, m = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(m).padStart(2, '0')}:00+08:00`
const now = d => Date.parse(at(d, 59))
const person = (id = 'a', extra = {}) => ({ id, name: `联系人${id}`, profile: {}, ...extra })
const row = (id, role, text, { d = 1, m = 0, contactId = 'a', ...extra } = {}) => ({ id, contactId, role, text, at: at(d, m),
  source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}), ...extra })
function run(contact, messages, d = 1) { return extractPromises({ contact, messages, now: now(d) }) }

test('an empty contact normalizes to an empty revision-zero promise store', () => {
  const store = normalizePromises(person('a'), { now: now(1) })
  assert.equal(store.contactId, 'a'); assert.deepEqual(store.items, []); assert.equal(store.revision, 0)
  assert.deepEqual(store.processedCandidateIds, [])
})

test('an AI commitment to build an account becomes a HUMAN_ACTION promise', () => {
  const output = run(person('a'), [row('m1', 'me', '我这两天建个号过去')])
  assert.equal(output.changed, true); assert.equal(output.added, 1); assert.equal(output.updated, 0)
  assert.equal(output.promises.items.length, 1)
  const promise = output.promises.items[0]
  assert.equal(promise.key, 'account'); assert.equal(promise.type, 'HUMAN_ACTION')
  assert.equal(promise.summary, '我这两天建个号过去'); assert.equal(promise.status, 'pending')
  assert.equal(promise.dueHint, '这两天'); assert.equal(promise.contactId, 'a')
  assert.deepEqual(promise.sourceMessageIds, ['m1'])
})

test('a joint real-world plan and a follow-up promise land on their own types', () => {
  const plan = run(person('a'), [row('m1', 'me', '改天一起吃饭')]).promises.items[0]
  assert.equal(plan.key, 'meal'); assert.equal(plan.type, 'REAL_WORLD_PLAN')
  const follow = run(person('a'), [row('m1', 'me', '我回头告诉你')]).promises.items[0]
  assert.equal(follow.key, 'report'); assert.equal(follow.type, 'AI_FOLLOWUP')
})

test('a contact plan the AI never answered becomes an OPEN_LOOP promise', () => {
  const output = run(person('a'), [row('c1', 'contact', '改天我请你吃饭')])
  assert.equal(output.promises.items.length, 1)
  assert.equal(output.promises.items[0].type, 'OPEN_LOOP')
  assert.equal(output.promises.items[0].summary, '改天我请你吃饭')
})

test('filler, questions, third-party claims and past statements are never promises', () => {
  const texts = ['笑死', '这个确实', '我明天有点忙', '我朋友明天建个号', '我上次建了个号', '你明天打排位吗', '我这两天去健身']
  for (const text of texts) {
    const output = run(person('a'), [row('m1', 'me', text)])
    assert.equal(output.changed, false, text)
    assert.deepEqual(output.promises.items, [], text)
  }
})

test('only confirmed outgoing commitments count, never drafts or contact messages', () => {
  const messages = [
    row('d1', 'me', '我这两天建个号', { source: 'planner_draft', confirmedSent: false, status: 'draft' }),
    row('c1', 'contact', '我这两天建个号'),
  ]
  const output = run(person('a'), messages)
  assert.deepEqual(output.promises.items, [])
})

test('a repeated commitment collapses onto one entry and the newest wording wins', () => {
  const first = run(person('a'), [row('m1', 'me', '我这两天建个号过去')], 1)
  const contact = { ...person('a'), promises: first.promises }
  const messages = [row('m1', 'me', '我这两天建个号过去', { d: 1 }), row('m2', 'me', '我明天注册个号', { d: 2 })]
  const second = run(contact, messages, 2)
  assert.equal(second.promises.items.length, 1)
  assert.equal(second.promises.items[0].key, 'account')
  assert.equal(second.promises.items[0].summary, '我明天注册个号')
  assert.equal(second.updated, 1); assert.equal(second.added, 0)
})

test('a re-run over unchanged evidence changes nothing', () => {
  const first = run(person('a'), [row('m1', 'me', '我这两天建个号过去')], 1)
  const contact = { ...person('a'), promises: first.promises }
  const second = run(contact, [row('m1', 'me', '我这两天建个号过去', { d: 1 })], 2)
  assert.equal(second.changed, false)
  assert.equal(second.promises.revision, first.promises.revision)
})

test('resolving a promise records the human result and survives normalization', () => {
  const stored = run(person('a'), [row('m1', 'me', '我这两天建个号过去')]).promises
  const contact = { ...person('a'), promises: stored }
  const id = stored.items[0].id
  const resolved = resolvePromise(contact, id, { text: '黑色玫瑰，ID 546124', now: now(3) })
  assert.equal(resolved.items[0].status, 'done')
  assert.equal(resolved.items[0].resolution.text, '黑色玫瑰，ID 546124')
  assert.equal(resolved.items[0].resolution.source, 'human_writeback')
  const renormalized = normalizePromises({ ...person('a'), promises: resolved }, { now: now(3) })
  assert.equal(renormalized.items.length, 1)
  assert.equal(renormalized.items[0].status, 'done')
  assert.equal(renormalized.items[0].resolution.text, '黑色玫瑰，ID 546124')
  const after = run({ ...person('a'), promises: renormalized }, [row('m1', 'me', '我这两天建个号过去', { d: 1 })], 3)
  assert.equal(after.changed, false)
  assert.equal(after.promises.items[0].status, 'done')
})

test('cancelling a promise keeps it out of the pending list without deleting evidence', () => {
  const stored = run(person('a'), [row('m1', 'me', '我这两天建个号过去')]).promises
  const contact = { ...person('a'), promises: stored }
  const cancelled = cancelPromise(contact, stored.items[0].id, { now: now(3) })
  assert.equal(cancelled.items[0].status, 'cancelled')
  assert.deepEqual(cancelled.items[0].sourceMessageIds, ['m1'])
})

test('promises stay scoped to one contact and never load for another', () => {
  const stored = run(person('a'), [row('m1', 'me', '我这两天建个号过去')]).promises
  const contactA = { ...person('a'), promises: stored }
  assert.equal(normalizePromises(contactA, { now: now(2) }).items.length, 1)
  assert.deepEqual(normalizePromises(person('b'), { now: now(2) }).items, [])
})

test('a confirmed send queues extraction and writes the promise onto the contact', async () => {
  const contact = { id: 'c-pm', name: '黑玫瑰', profile: {}, learning: { messages: [] },
    sharedMemoryLedger: [row('m1', 'me', '我这两天建个号过去', { contactId: 'c-pm' }), row('c1', 'contact', '好呀', { contactId: 'c-pm' })] }
  const storage = createMemoryStorage({ contacts: [contact], settings: { longTermMemory: true } })
  const ai = new AiService(storage)
  const queued = ai.queuePromiseExtraction({ contactId: 'c-pm', reason: 'confirmed_send' })
  assert.equal(queued.queued, true)
  await ai.flushPromiseExtractions()
  const saved = storage.get().contacts.find(item => item.id === 'c-pm').promises
  assert.equal(saved.items.length, 1)
  assert.equal(saved.items[0].key, 'account'); assert.equal(saved.items[0].type, 'HUMAN_ACTION')
})

test('long-term memory disabled leaves promises untouched', async () => {
  const contact = { id: 'c-off', name: '关闭记忆', profile: {}, learning: { messages: [] },
    sharedMemoryLedger: [row('m1', 'me', '我这两天建个号过去', { contactId: 'c-off' })] }
  const storage = createMemoryStorage({ contacts: [contact], settings: { longTermMemory: false } })
  const ai = new AiService(storage)
  assert.equal(ai.queuePromiseExtraction({ contactId: 'c-off' }).queued, false)
  await ai.flushPromiseExtractions()
  assert.equal(storage.get().contacts[0].promises, undefined)
})
