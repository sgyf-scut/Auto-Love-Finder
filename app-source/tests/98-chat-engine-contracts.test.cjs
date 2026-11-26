const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CHAT_ENGINE_ACTIONS, DEFAULT_CHAT_ENGINE_CONFIG, validateChatContext, createReadonlyChatContext, validateChatEngineResult, normalizeChatEngineResult } = require('../electron/chat-core/chat-types.cjs')
const { createChatEngineRouter } = require('../electron/chat-core/chat-engine-router.cjs')

function context(patch = {}) {
  return {
    traceId: 'trace-synthetic', accountId: 'account-synthetic', contactId: 'contact-synthetic',
    incomingMessages: [{ id: 'incoming-1', role: 'contact', text: '好吃', at: '2026-10-15T03:00:00Z' }],
    recentMessages: [], contactFacts: [], selfFacts: [], sharedMemories: [],
    relationship: { stage: 'STRANGER' }, interactionNotes: [],
    conversation: { summary: null, openLoops: [] }, constraints: { privacy: [], handoffTopics: [] }, metadata: {}, ...patch,
  }
}
const reply = patch => ({ action: 'REPLY', messages: ['确实哈哈'], handoff: false, reason: null, metadata: {}, ...patch })

test('public engine actions remain distinct from Legacy Planner actions', () => {
  assert.deepEqual(CHAT_ENGINE_ACTIONS, ['REPLY', 'NO_REPLY', 'HANDOFF'])
  assert.throws(() => normalizeChatEngineResult({ action: 'TEASE' }), /action/)
  assert.ok(Object.isFrozen(CHAT_ENGINE_ACTIONS))
})
test('public context accepts only the complete transport schema', () => {
  assert.deepEqual(validateChatContext(context()), context())
  for (const key of ['traceId', 'accountId', 'contactId']) assert.throws(() => validateChatContext(context({ [key]: '' })), new RegExp(key))
  for (const key of ['incomingMessages', 'recentMessages', 'contactFacts', 'selfFacts', 'sharedMemories', 'interactionNotes']) assert.throws(() => validateChatContext(context({ [key]: {} })), new RegExp(key))
})
test('context requires conversation summary, open loops and external constraints', () => {
  assert.throws(() => validateChatContext(context({ conversation: {} })), /summary/)
  assert.throws(() => validateChatContext(context({ conversation: { summary: null, openLoops: null } })), /openLoops/)
  assert.throws(() => validateChatContext(context({ constraints: { privacy: [], handoffTopics: null } })), /handoffTopics/)
})
test('readonly context clones and freezes every nested value without freezing the caller state', () => {
  const original = context({ metadata: { legacy: { facts: ['a'] } } })
  const input = createReadonlyChatContext(original)
  assert.notEqual(input, original)
  assert.notEqual(input.metadata.legacy, original.metadata.legacy)
  assert.ok(Object.isFrozen(input.incomingMessages[0]))
  assert.throws(() => input.metadata.legacy.facts.push('b'), TypeError)
  original.metadata.legacy.facts.push('changed outside')
  assert.deepEqual(input.metadata.legacy.facts, ['a'])
})
test('functions and indirect storage or send capabilities cannot enter context', () => {
  for (const metadata of [{ sendMessage() {} }, { nested: { storage: { save() {} } } }, { effectExecutor: async () => {} }]) {
    assert.throws(() => createReadonlyChatContext(context({ metadata })), /JSON data/)
  }
})
test('context rejects custom objects, dates, cyclic and invalid primitive values', () => {
  const cyclic = {}; cyclic.self = cyclic
  for (const value of [new Date(), new Map(), cyclic, NaN, Infinity, undefined, 1n, Symbol('x')]) {
    assert.throws(() => createReadonlyChatContext(context({ metadata: { value } })), /JSON|cycle/)
  }
})
test('context never executes getters or toJSON hooks', () => {
  let accesses = 0
  const metadata = Object.defineProperty({}, 'store', { enumerable: true, get() { accesses++; return {} } })
  assert.throws(() => createReadonlyChatContext(context({ metadata })), /data property/)
  assert.throws(() => createReadonlyChatContext(context({ metadata: { toJSON() { accesses++; return {} } } })), /JSON data/)
  assert.equal(accesses, 0)
})
test('context rejects unsafe keys and sparse arrays instead of normalizing hidden capabilities', () => {
  assert.throws(() => createReadonlyChatContext(context({ metadata: JSON.parse('{"__proto__":{"x":1}}') })), /unsafe key/)
  assert.throws(() => createReadonlyChatContext(context({ incomingMessages: [, 'a'] })), /sparse array/)
})
test('context metadata has a finite byte limit', () => {
  assert.throws(() => createReadonlyChatContext(context({ metadata: { value: 'x'.repeat(1024 * 1024) } })), /metadata.*byte limit/)
})
test('context has a finite nesting limit', () => {
  let nested = null
  for (let i = 0; i < 50; i++) nested = { nested }
  assert.throws(() => createReadonlyChatContext(context({ metadata: { nested } })), /limits/)
})
test('normal text result preserves exact message text and Legacy diagnostic data', () => {
  const result = reply({ messages: ['  原文字  ', '第二句'], metadata: { legacyResult: { text: '  原文字  ', text2: '第二句', strategy: { action: 'TEASE' } } } })
  assert.deepEqual(normalizeChatEngineResult(result), result)
  assert.notEqual(validateChatEngineResult(result).metadata, result.metadata)
})
test('NO_REPLY normalizes to no messages without sendable expressions', () => {
  assert.deepEqual(normalizeChatEngineResult({ action: 'NO_REPLY' }), { action: 'NO_REPLY', messages: [], handoff: false, reason: null, metadata: {} })
  assert.throws(() => normalizeChatEngineResult({ action: 'NO_REPLY', messages: ['不该发'] }), /sendable/)
})
test('HANDOFF normalizes without a generated sendable reply', () => {
  assert.deepEqual(normalizeChatEngineResult({ action: 'HANDOFF', reason: 'PHOTO_REQUEST' }), { action: 'HANDOFF', messages: [], handoff: true, reason: 'PHOTO_REQUEST', metadata: {} })
  assert.throws(() => normalizeChatEngineResult({ action: 'HANDOFF', handoff: false }), /agree/)
  assert.throws(() => normalizeChatEngineResult({ action: 'HANDOFF', messages: ['发出去'] }), /sendable/)
})
test('existing sticker only expression is a real REPLY with no text', () => {
  const result = reply({ messages: [], metadata: { expression: { mode: 'STICKER_ONLY', stickerIntent: 'HAPPY', stickerPosition: 'only', slot: 1 } } })
  assert.deepEqual(normalizeChatEngineResult(result), result)
})
test('empty replies need valid sticker intent and cannot masquerade as NO_REPLY', () => {
  assert.throws(() => normalizeChatEngineResult(reply({ messages: [] })), /STICKER_ONLY/)
  assert.throws(() => normalizeChatEngineResult(reply({ messages: [], metadata: { expression: { mode: 'STICKER_ONLY', stickerIntent: 'NONE' } } })), /STICKER_ONLY/)
  for (const action of ['NO_REPLY', 'HANDOFF']) assert.throws(() => normalizeChatEngineResult({ action, metadata: { expression: { mode: 'STICKER_ONLY', stickerIntent: 'HAPPY' } } }), /sendable expression/)
})
test('malformed result messages and contradictory handoff fail explicitly', () => {
  for (const messages of ['text', [''], ['   '], [null], [1]]) assert.throws(() => normalizeChatEngineResult(reply({ messages })), /messages/)
  assert.throws(() => normalizeChatEngineResult(reply({ handoff: true })), /agree/)
})
test('normalizing a result never executes an accessor supplied by an engine', () => {
  let accesses = 0
  const result = Object.defineProperty({}, 'action', { enumerable: true, get() { accesses++; return 'NO_REPLY' } })
  assert.throws(() => normalizeChatEngineResult(result), /data property/)
  assert.equal(accesses, 0)
})
test('router runs the configured default primary engine and invokes only generateReply with frozen context', async () => {
  let calls = 0
  const original = context()
  const generateReply = async (input) => { calls++; assert.ok(Object.isFrozen(input)); assert.notEqual(input, original); return reply() }
  const router = createChatEngineRouter({ engines: { legacy: { generateReply }, simple_v3: { generateReply } } })
  const result = await router.generateReply(original)
  assert.equal(calls, 1)
  assert.equal(DEFAULT_CHAT_ENGINE_CONFIG.primaryChatEngine, 'simple_v3')
  assert.equal(result.metadata.engine, DEFAULT_CHAT_ENGINE_CONFIG.primaryChatEngine)
  assert.deepEqual(router.resolveConfig(), { ...DEFAULT_CHAT_ENGINE_CONFIG, diagnostics: [] })
})
test('unknown configuration falls back to Legacy with explicit diagnostics', async () => {
  const diagnostics = []
  const router = createChatEngineRouter({ engines: { legacy: { generateReply: async () => reply() } }, config: { primaryChatEngine: 'typo' }, onDiagnostic: row => diagnostics.push(row) })
  const result = await router.generateReply(context())
  assert.equal(result.metadata.engine, 'legacy')
  assert.equal(diagnostics[0].code, 'CHAT_ENGINE_CONFIG_FALLBACK')
  assert.equal(diagnostics[0].requestedEngine, 'typo')
  assert.equal(result.metadata.routing.diagnostics.length, 1)
})
test('Simple V3 is a selectable primary engine and runs only when explicitly selected', async () => {
  let simpleCalls = 0, legacyCalls = 0
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'simple_v3' }, engines: {
    legacy: { generateReply: async () => { legacyCalls++; return reply() } },
    simple_v3: { generateReply: async () => { simpleCalls++; return reply({ metadata: { engine: 'simple_v3' } }) } } } })
  const result = await router.generateReply(context())
  assert.equal(simpleCalls, 1)
  assert.equal(legacyCalls, 0)
  assert.equal(result.metadata.engine, 'simple_v3')
  assert.equal(router.getDiagnostics().length, 0)
})
test('a selected but unregistered Simple V3 fails explicitly instead of silently degrading', async () => {
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'simple_v3' }, engines: { legacy: { generateReply: async () => reply() } } })
  await assert.rejects(router.generateReply(context()), /simple_v3 Chat Engine is not registered/)
})
test('Shadow runs the side-effect-free Simple V3 engine alongside the Legacy primary', async () => {
  const calls = { legacy: 0, simple: 0 }
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'legacy', shadowChatEngine: 'simple_v3', shadowEnabled: true }, engines: {
    legacy: { generateReply: async () => { calls.legacy++; return reply() } },
    simple_v3: { generateReply: async () => { calls.simple++; return reply({ messages: ['影子的回复'], metadata: { engine: 'simple_v3', model: 'shadow-model' } }) } } } })
  const result = await router.generateReply(context())
  assert.equal(calls.legacy, 1)
  assert.equal(calls.simple, 1)
  assert.equal(result.metadata.engine, 'legacy')
  assert.equal(result.metadata.routing.shadowEnabled, true)
  assert.equal(result.metadata.shadow.engine, 'simple_v3')
  assert.equal(result.metadata.shadow.ok, true)
  assert.deepEqual(result.metadata.shadow.messages, ['影子的回复'])
  assert.equal(result.metadata.shadow.model, 'shadow-model')
  assert.equal(router.getDiagnostics().length, 0)
})
test('an unsupported Shadow engine is rejected with a diagnostic and never runs', async () => {
  let calls = 0
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'legacy', shadowChatEngine: 'legacy', shadowEnabled: true }, engines: { legacy: { generateReply: async () => { calls++; return reply() } } } })
  const result = await router.generateReply(context())
  assert.equal(calls, 1)
  assert.equal(result.metadata.routing.shadowEnabled, false)
  assert.equal(result.metadata.shadow, null)
  assert.equal(router.getDiagnostics()[0].code, 'CHAT_ENGINE_SHADOW_UNSUPPORTED')
})
test('a failing Shadow is recorded in the comparison record without affecting the primary result', async () => {
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'legacy', shadowChatEngine: 'simple_v3', shadowEnabled: true }, engines: {
    legacy: { generateReply: async () => reply() },
    simple_v3: { generateReply: async () => { throw Object.assign(new Error('shadow exploded'), { code: 'SHADOW_BOOM' }) } } } })
  const result = await router.generateReply(context())
  assert.equal(result.metadata.engine, 'legacy')
  assert.equal(result.action, 'REPLY')
  assert.deepEqual(result.messages, ['确实哈哈'])
  assert.equal(result.metadata.shadow.ok, false)
  assert.equal(result.metadata.shadow.error, 'SHADOW_BOOM')
  assert.deepEqual(result.metadata.shadow.messages, [])
})
test('Shadow duplication and incomplete Shadow settings are reported instead of guessing', async () => {
  let calls = 0
  const duplicate = createChatEngineRouter({ config: { primaryChatEngine: 'simple_v3', shadowChatEngine: 'simple_v3', shadowEnabled: true }, engines: { simple_v3: { generateReply: async () => { calls++; return reply() } } } })
  const result = await duplicate.generateReply(context())
  assert.equal(calls, 1)
  assert.equal(result.metadata.routing.shadowEnabled, false)
  assert.equal(duplicate.getDiagnostics()[0].code, 'CHAT_ENGINE_SHADOW_DUPLICATE')
  const incomplete = createChatEngineRouter({ config: { primaryChatEngine: 'legacy', shadowChatEngine: 'simple_v3' }, engines: { legacy: { generateReply: async () => reply() } } })
  await incomplete.generateReply(context())
  assert.equal(incomplete.getDiagnostics()[0].code, 'CHAT_ENGINE_SHADOW_INCOMPLETE')
})
test('router caches an injected async engine factory across concurrent calls', async () => {
  let factories = 0, generations = 0
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'legacy' }, engines: { legacy: async () => { factories++; return { generateReply: async () => { generations++; return reply() } } } } })
  await Promise.all([router.generateReply(context()), router.generateReply(context({ traceId: 'another' }))])
  assert.equal(factories, 1)
  assert.equal(generations, 2)
})
test('router does not retry a failed generation or hide its effect-related error', async () => {
  let calls = 0
  const failure = new Error('Core effect failed')
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'legacy' }, engines: { legacy: { generateReply: async () => { calls++; throw failure } } } })
  await assert.rejects(router.generateReply(context()), error => error === failure)
  assert.equal(calls, 1)
})
test('router rejects invalid engine registration and invalid generated results', async () => {
  await assert.rejects(createChatEngineRouter().generateReply(context()), /not registered/)
  await assert.rejects(createChatEngineRouter({ config: { primaryChatEngine: 'legacy' }, engines: { legacy: {} } }).generateReply(context()), /generateReply/)
  await assert.rejects(createChatEngineRouter({ config: { primaryChatEngine: 'legacy' }, engines: { legacy: { generateReply: async () => ({ action: 'TEASE' }) } } }).generateReply(context()), /action/)
})
test('per-call engine override is resolved without mutating persistent router configuration', async () => {
  const router = createChatEngineRouter({ engines: { legacy: { generateReply: async () => reply() } } })
  await router.generateReply(context(), { primaryChatEngine: 'missing' })
  assert.deepEqual(router.resolveConfig(), { ...DEFAULT_CHAT_ENGINE_CONFIG, diagnostics: [] })
})
