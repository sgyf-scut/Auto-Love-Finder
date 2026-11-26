const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CORE_EFFECT_PHASES, createCoreEffectBoundary } = require('../electron/chat-core/core-effects.cjs')

const scope = { traceId: 'trace-one', accountId: 'account-one', contactId: 'contact-one' }
const request = (payload = {}) => ({ phase: 'INBOUND_OBSERVED', type: 'OBSERVE_MEMORY', payload })
const boundary = patch => createCoreEffectBoundary({ ...scope, handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': async () => {} }, ...patch })

test('only three named external mutation phases are supported', () => {
  assert.deepEqual(CORE_EFFECT_PHASES, ['INBOUND_OBSERVED', 'REPLY_DECIDED', 'SEND_CONFIRMED'])
  assert.ok(Object.isFrozen(CORE_EFFECT_PHASES))
})
test('Legacy receives a frozen dispatch-only port with no storage capability', () => {
  const port = boundary()
  assert.ok(Object.isFrozen(port))
  assert.deepEqual(Object.keys(port), ['dispatch'])
  assert.equal(port.storage, undefined)
})
test('awaited inbound effect is visible before the next Planner or Writer step', async () => {
  const state = { memory: [] }, order = []
  const port = boundary({ isCurrent: async () => { order.push('freshness'); return true }, handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': async effect => { await Promise.resolve(); state.memory.push(effect.payload.fact); order.push('mutation') } } })
  await port.dispatch(request({ fact: 'likes games' }))
  order.push('planner')
  assert.deepEqual(state.memory, ['likes games'])
  assert.deepEqual(order, ['freshness', 'mutation', 'planner'])
})
test('payload is cloned before asynchronous freshness checks and deeply frozen for handler', async () => {
  let release, seen
  const gate = new Promise(resolve => { release = resolve })
  const payload = { facts: ['a'] }
  const port = boundary({ isCurrent: async () => { await gate; return true }, handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': effect => { seen = effect; assert.throws(() => effect.payload.facts.push('bad'), TypeError) } } })
  const pending = port.dispatch(request(payload))
  payload.facts.push('outside mutation')
  release()
  await pending
  assert.deepEqual(seen.payload.facts, ['a'])
  assert.deepEqual({ traceId: seen.traceId, accountId: seen.accountId, contactId: seen.contactId }, scope)
})
test('handler may return approved facts as a separate readonly result', async () => {
  const result = { approved: [{ key: 'gaming', value: 'aram' }] }
  const port = boundary({ handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => result } })
  const returned = await port.dispatch(request())
  assert.notEqual(returned, result)
  assert.ok(Object.isFrozen(returned.approved[0]))
  result.approved[0].value = 'changed externally'
  assert.equal(returned.approved[0].value, 'aram')
})
test('scope is construction-owned and cannot be overwritten across contacts or accounts', async () => {
  let calls = 0
  const port = boundary({ handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { calls++ } } })
  for (const key of Object.keys(scope)) await assert.rejects(port.dispatch({ ...request(), [key]: 'different' }), { code: 'CHAT_EFFECT_SCOPE_MISMATCH' })
  assert.equal(calls, 0)
  await port.dispatch({ ...request(), ...scope })
  assert.equal(calls, 1)
})
test('unknown phases and unregistered phase/type pairs cannot call an arbitrary handler', async () => {
  const port = boundary()
  await assert.rejects(port.dispatch({ phase: 'OTHER', type: 'OBSERVE_MEMORY' }), { code: 'CHAT_EFFECT_INVALID' })
  await assert.rejects(port.dispatch({ phase: 'REPLY_DECIDED', type: 'OBSERVE_MEMORY' }), { code: 'CHAT_EFFECT_UNREGISTERED' })
  await assert.rejects(port.dispatch({ phase: 'INBOUND_OBSERVED', type: 'SAVE_ANYTHING' }), { code: 'CHAT_EFFECT_UNREGISTERED' })
})
test('dispatch waits for freshness and refuses a stale conversation before mutation', async () => {
  let calls = 0
  const port = boundary({ isCurrent: async () => false, handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { calls++ } } })
  await assert.rejects(port.dispatch(request()), { code: 'CHAT_EFFECT_STALE' })
  assert.equal(calls, 0)
})
test('freshness must be explicitly true and may not be a truthy unknown status', async () => {
  const port = boundary({ isCurrent: () => 'UNKNOWN' })
  await assert.rejects(port.dispatch(request()), { code: 'CHAT_EFFECT_STALE' })
})
test('handler failure propagates unchanged and is never retried', async () => {
  let calls = 0
  const failure = new Error('storage failure')
  const port = boundary({ handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { calls++; throw failure } } })
  await assert.rejects(port.dispatch(request()), error => error === failure)
  assert.equal(calls, 1)
})
test('a later cancellation does not undo an effect that already executed', async () => {
  let current = true, writes = 0
  const port = boundary({ isCurrent: () => current, handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { writes++; current = false; return { done: true } } } })
  assert.deepEqual(await port.dispatch(request()), { done: true })
  assert.equal(writes, 1)
  await assert.rejects(port.dispatch(request()), { code: 'CHAT_EFFECT_STALE' })
  assert.equal(writes, 1)
})
test('SEND_CONFIRMED without an external proof never runs its registered handler', async () => {
  let calls = 0
  const port = boundary({ handlers: { 'SEND_CONFIRMED:UPDATE_SHARED_MEMORY': () => { calls++ } } })
  await assert.rejects(port.dispatch({ phase: 'SEND_CONFIRMED', type: 'UPDATE_SHARED_MEMORY', payload: { confirmedSent: true } }), { code: 'CHAT_EFFECT_SEND_UNCONFIRMED' })
  assert.equal(calls, 0)
})
test('request cannot inject a confirmed-send proof or forged top-level acknowledgement', async () => {
  const port = boundary({ handlers: { 'SEND_CONFIRMED:UPDATE_SHARED_MEMORY': () => {} } })
  await assert.rejects(port.dispatch({ phase: 'SEND_CONFIRMED', type: 'UPDATE_SHARED_MEMORY', confirmedSent: true }), { code: 'CHAT_EFFECT_INVALID' })
  await assert.rejects(port.dispatch({ phase: 'SEND_CONFIRMED', type: 'UPDATE_SHARED_MEMORY', confirmationProof: { valid: true } }), { code: 'CHAT_EFFECT_INVALID' })
})
test('SEND_CONFIRMED accepts only a live true confirmation from external construction', async () => {
  let confirmed = false, writes = 0
  const port = boundary({ confirmationProof: { valid: async () => confirmed }, handlers: { 'SEND_CONFIRMED:UPDATE_SHARED_MEMORY': () => { writes++; return { saved: true } } } })
  const effect = { phase: 'SEND_CONFIRMED', type: 'UPDATE_SHARED_MEMORY' }
  await assert.rejects(port.dispatch(effect), { code: 'CHAT_EFFECT_SEND_UNCONFIRMED' })
  confirmed = true
  assert.deepEqual(await port.dispatch(effect), { saved: true })
  assert.equal(writes, 1)
})
test('external proof cannot grant an Engine an unregistered SEND_CONFIRMED capability', async () => {
  const port = boundary({ confirmationProof: { valid: () => true } })
  await assert.rejects(port.dispatch({ phase: 'SEND_CONFIRMED', type: 'UPDATE_SHARED_MEMORY' }), { code: 'CHAT_EFFECT_UNREGISTERED' })
})
test('NO_REPLY and generation failure preserve already committed inbound and compatibility effects', async () => {
  for (const outcome of ['NO_REPLY', 'DRAFT', 'FAILED']) {
    const phases = []
    const port = boundary({ handlers: {
      'INBOUND_OBSERVED:OBSERVE_MEMORY': effect => { phases.push(effect.phase) },
      'REPLY_DECIDED:LEGACY_FOCUS': effect => { phases.push(effect.phase) },
    } })
    await port.dispatch(request({ outcome }))
    await port.dispatch({ phase: 'REPLY_DECIDED', type: 'LEGACY_FOCUS', payload: { legacyCompatibility: true } })
    assert.deepEqual(phases, ['INBOUND_OBSERVED', 'REPLY_DECIDED'])
  }
})
test('diagnostics contain no payload, generated text, storage error message or handler result', async () => {
  const events = []
  const failure = new Error('private account data')
  const port = boundary({ onEffect: event => events.push(event), handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { throw failure } } })
  await assert.rejects(port.dispatch(request({ secret: 'private incoming text' })), error => error === failure)
  assert.deepEqual(events, [{ ...scope, phase: 'INBOUND_OBSERVED', type: 'OBSERVE_MEMORY', status: 'failed', code: 'CHAT_EFFECT_HANDLER_FAILED' }])
  assert.equal(JSON.stringify(events).includes('private'), false)
})
test('a throwing diagnostic observer cannot cancel, roll back or retry a successful mutation', async () => {
  let writes = 0
  const port = boundary({ onEffect: () => { throw new Error('observer down') }, handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { writes++; return { done: true } } } })
  assert.deepEqual(await port.dispatch(request()), { done: true })
  assert.equal(writes, 1)
})
test('a rejecting async observer cannot replace a business error', async () => {
  const failure = new Error('actual failure')
  const port = boundary({ onEffect: async () => { throw new Error('observer down') }, handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { throw failure } } })
  await assert.rejects(port.dispatch(request()), error => error === failure)
})
test('capability values, accessors, class instances and cycles are rejected before handler execution', async () => {
  let calls = 0, accessors = 0
  const port = boundary({ handlers: { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => { calls++ } } })
  const cycle = {}; cycle.self = cycle
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { accessors++; return 'x' } })
  for (const payload of [{ save() {} }, { value: undefined }, new Date(), cycle, accessor]) await assert.rejects(port.dispatch(request(payload)), { code: 'CHAT_EFFECT_INVALID' })
  assert.equal(calls, 0)
  assert.equal(accessors, 0)
})
test('registration is captured at construction and never expanded by later external mutation', async () => {
  const handlers = { 'INBOUND_OBSERVED:OBSERVE_MEMORY': () => {} }
  const port = boundary({ handlers })
  handlers['SEND_CONFIRMED:UPDATE_SHARED_MEMORY'] = () => {}
  await assert.rejects(port.dispatch({ phase: 'SEND_CONFIRMED', type: 'UPDATE_SHARED_MEMORY' }), { code: 'CHAT_EFFECT_UNREGISTERED' })
})
