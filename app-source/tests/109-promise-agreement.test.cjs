const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildPromiseCandidates, extractPromises } = require('../electron/social-brain/promise-extractor.cjs')
const { normalizePromises } = require('../electron/social-brain/promise.cjs')

const at = (d = 1, m = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(m).padStart(2, '0')}:00+08:00`
const now = d => Date.parse(at(d, 59))
const person = (id = 'a', extra = {}) => ({ id, name: `联系人${id}`, profile: {}, ...extra })
const row = (id, role, text, { d = 1, m = 0, contactId = 'a', ...extra } = {}) => ({ id, contactId, role, text, at: at(d, m),
  source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}), ...extra })
const run = (contact, messages, d = 1) => extractPromises({ contact, messages, now: now(d) })

// The regression this file exists for: the contact proposes a concrete plan, the
// AI accepts it, and that accepted plan — not the AI's own wording — is the
// promise. Both halves alone are invisible to the old extractor.
test('a plan the contact offers and the AI accepts becomes a REAL_WORLD_PLAN', () => {
  const output = run(person('a'), [
    row('c1', 'contact', '可以啊，那我们周六早上11点在五山地铁口集合吧', { m: 0 }),
    row('m1', 'me', '好呀', { m: 1 }),
  ])
  assert.equal(output.changed, true)
  assert.equal(output.promises.items.length, 1)
  const promise = output.promises.items[0]
  assert.equal(promise.type, 'REAL_WORLD_PLAN')
  assert.equal(promise.status, 'pending')
  assert.equal(promise.summary, '可以啊，那我们周六早上11点在五山地铁口集合吧')
  assert.equal(promise.dueHint, '周六')
  assert.deepEqual(promise.sourceMessageIds, ['c1', 'm1'])
})

test('a plan split across contact bubbles is joined before the AI accepts it', () => {
  const output = run(person('a'), [
    row('c1', 'contact', '那要不这周六', { m: 0 }),
    row('c2', 'contact', '我们在五山地铁口那边', { m: 1 }),
    row('c3', 'contact', '见一面', { m: 2 }),
    row('m1', 'me', '好呀', { m: 3 }),
  ])
  assert.equal(output.promises.items.length, 1)
  assert.equal(output.promises.items[0].summary, '那要不这周六，我们在五山地铁口那边，见一面')
  assert.deepEqual(output.promises.items[0].sourceMessageIds, ['c1', 'c2', 'c3', 'm1'])
})

test('an AI reply that is still a question never closes the plan', () => {
  const output = run(person('a'), [
    row('c1', 'contact', '可以啊，那我们周六早上11点在五山地铁口集合吧', { m: 0 }),
    row('m1', 'me', '可以啊，周六几点方便？', { m: 1 }),
  ])
  assert.deepEqual(output.promises.items, [])
})

test('a hedged AI reply is not acceptance', () => {
  for (const text of ['可以啊，到时候再看吧', '行吧，看情况', '好的，我应该有空']) {
    const output = run(person('a'), [
      row('c1', 'contact', '那我们周六早上11点在五山地铁口集合吧', { m: 0 }),
      row('m1', 'me', text, { m: 1 }),
    ])
    assert.deepEqual(output.promises.items, [], text)
  }
})

test('an AI acceptance without a concrete time or place is not a promise', () => {
  const output = run(person('a'), [
    row('c1', 'contact', '我们见一面吧', { m: 0 }),
    row('m1', 'me', '好呀', { m: 1 }),
  ])
  assert.deepEqual(output.promises.items, [])
})

test('an AI acceptance of an unrelated contact message is not a promise', () => {
  const output = run(person('a'), [
    row('c1', 'contact', '今天天气不错', { m: 0 }),
    row('m1', 'me', '好呀', { m: 1 }),
  ])
  assert.deepEqual(output.promises.items, [])
})

test('a plan the AI never answered stays an OPEN_LOOP instead', () => {
  const output = run(person('a'), [row('c1', 'contact', '那咱们周六去逛街吧', { m: 0 })])
  assert.equal(output.promises.items.length, 1)
  assert.equal(output.promises.items[0].type, 'OPEN_LOOP')
})

test('an AI commitment that names a weekday is now captured', () => {
  const output = run(person('a'), [row('m1', 'me', '我周六过去找你', { m: 0 })])
  assert.equal(output.promises.items.length, 1)
  assert.equal(output.promises.items[0].type, 'REAL_WORLD_PLAN')
  assert.equal(output.promises.items[0].key, 'visit')
})

test('an unconfirmed draft acceptance never closes the plan', () => {
  const messages = [
    row('c1', 'contact', '那我们周六早上11点在五山地铁口集合吧', { m: 0 }),
    row('d1', 'me', '好呀', { m: 1, source: 'planner_draft', confirmedSent: false, status: 'draft' }),
  ]
  const output = run(person('a'), messages)
  // The draft never left the app, so the AI never actually answered: the plan
  // stays an open loop instead of becoming an agreed REAL_WORLD_PLAN.
  assert.equal(output.promises.items.length, 1)
  assert.equal(output.promises.items[0].type, 'OPEN_LOOP')
})

test('re-running the same accepted plan changes nothing', () => {
  const messages = [
    row('c1', 'contact', '那我们周六早上11点在五山地铁口集合吧', { m: 0 }),
    row('m1', 'me', '好呀', { m: 1 }),
  ]
  const first = run(person('a'), messages, 1)
  const second = run({ ...person('a'), promises: first.promises }, messages, 2)
  assert.equal(second.changed, false)
  assert.equal(second.promises.items.length, 1)
})

test('an accepted plan stays scoped to its own contact', () => {
  const storedA = run(person('a'), [
    row('c1', 'contact', '那我们周六早上11点在五山地铁口集合吧', { m: 0 }),
    row('m1', 'me', '好呀', { m: 1 }),
  ]).promises
  assert.equal(storedA.items.length, 1)
  assert.equal(storedA.items[0].contactId, 'a')
  const storedB = run(person('b'), [
    row('c9', 'contact', '那我们周日下午三点在图书馆门口见吧', { m: 0, contactId: 'b' }),
    row('m9', 'me', '好呀', { m: 1, contactId: 'b' }),
  ]).promises
  assert.equal(storedB.items.length, 1)
  assert.equal(storedB.items[0].contactId, 'b')
  assert.notEqual(storedB.items[0].id, storedA.items[0].id)
  // A's promise never surfaces for B, and vice versa.
  assert.deepEqual(normalizePromises(person('b'), { now: now(1) }).items, [])
  assert.deepEqual(normalizePromises({ ...person('a'), promises: storedA }, { now: now(1) }).items.length, 1)
})

// The real exchange from the live account: the AI agreed twice ("好呀", then
// "放心，我肯定到") but only the plan-carrying pair may become a promise.
test('the live meetup exchange yields exactly one accepted-plan promise', () => {
  const output = run(person('a'), [
    row('c1', 'contact', '要不咱们找个时间线下见一面吧', { m: 0 }),
    row('m1', 'me', '逛街倒是可以哎', { m: 1 }),
    row('c2', 'contact', '可以啊，那我们周六早上11点在五山地铁口集合吧', { m: 2 }),
    row('m2', 'me', '好呀', { m: 3 }),
    row('c3', 'contact', '说到做到哦，不要放我鸽子', { m: 4 }),
    row('m3', 'me', '放心，我肯定到', { m: 5 }),
  ])
  assert.equal(output.promises.items.length, 1)
  const promise = output.promises.items[0]
  assert.equal(promise.type, 'REAL_WORLD_PLAN')
  assert.equal(promise.summary, '可以啊，那我们周六早上11点在五山地铁口集合吧')
  assert.deepEqual(promise.sourceMessageIds, ['c2', 'm2'])
})

test('buildPromiseCandidates reports the accepted plan with its evidence intact', () => {
  const contact = person('a')
  const candidates = buildPromiseCandidates({ contact, messages: [
    row('c1', 'contact', '那我们周六早上11点在五山地铁口集合吧', { m: 0 }),
    row('m1', 'me', '好呀', { m: 1 }),
  ], now: now(1) })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].type, 'REAL_WORLD_PLAN')
  assert.equal(candidates[0].dueHint, '周六')
  assert.equal(candidates[0].sourceMessages.length, 2)
  assert.deepEqual(candidates[0].sourceMessages.map(item => item.role), ['contact', 'me'])
})
