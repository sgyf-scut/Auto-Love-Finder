const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { STAGE_DESCRIPTIONS, DEFAULT_STAGE_DESCRIPTION, DEFAULT_SIMPLE_V3_CONFIG, describeStage } = require('../electron/chat-engines/simple-v3/config.cjs')
const { SYSTEM_PROMPT, buildSimpleV3Messages, buildContextBlock } = require('../electron/chat-engines/simple-v3/prompt.cjs')
const { parseSimpleV3Output, VALID_ACTIONS, NO_REPLY_MARKER } = require('../electron/chat-engines/simple-v3/parser.cjs')
const { createSimpleV3Engine } = require('../electron/chat-engines/simple-v3/engine.cjs')
const { validateChatEngineResult, normalizeChatEngineResult } = require('../electron/chat-core/chat-types.cjs')
const { guardEngineResult } = require('../electron/chat-core/safety-guard.cjs')
const { createChatEngineRouter } = require('../electron/chat-core/chat-engine-router.cjs')
const { ConversationOrchestrator } = require('../electron/chat-core/conversation-orchestrator.cjs')
const { AiService } = require('../electron/ai-service.cjs')

function context(patch = {}) {
  return {
    traceId: 'trace-simple', accountId: 'account-simple', contactId: 'contact-simple',
    incomingMessages: [{ id: 'in-1', role: 'contact', text: '第一句' }, { id: 'in-2', role: 'contact', text: '第二句' }],
    recentMessages: [{ role: 'me', text: '早上好' }, { role: 'contact', text: '早' }, { role: 'me', text: '吃了吗' }],
    contactFacts: [{ label: '专业', value: '材料' }, { label: '学校', value: '虚构大学' }],
    selfFacts: [{ label: '爱好', value: '打游戏' }, { label: '作息', value: '晚睡' }],
    sharedMemories: [{ summary: '一起聊过三角洲' }, { summary: '一起吐槽过食堂' }],
    relationship: { stage: 'EXPLORING' }, interactionNotes: [],
    conversation: { summary: null, openLoops: [] }, constraints: { privacy: [], handoffTopics: [] }, metadata: {}, ...patch,
  }
}

// ---- config: fixed stage wording ----

test('relationship stages map to fixed natural-language wording', () => {
  assert.ok(Object.isFrozen(STAGE_DESCRIPTIONS))
  assert.equal(describeStage('STRANGER'), STAGE_DESCRIPTIONS.STRANGER)
  assert.equal(describeStage('CLOSE_FRIEND'), STAGE_DESCRIPTIONS.CLOSE_FRIEND)
  assert.equal(describeStage('UNKNOWN_STAGE'), DEFAULT_STAGE_DESCRIPTION)
  assert.equal(describeStage(undefined), DEFAULT_STAGE_DESCRIPTION)
  assert.equal(DEFAULT_SIMPLE_V3_CONFIG.maxMessages, 3)
  assert.equal(DEFAULT_SIMPLE_V3_CONFIG.minMessages, 1)
  assert.ok(Object.isFrozen(DEFAULT_SIMPLE_V3_CONFIG))
})

// ---- prompt: public fields only, bounded, pure ----

test('prompt builds one system and one user message from public context fields only', () => {
  const messages = buildSimpleV3Messages(context())
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, SYSTEM_PROMPT)
  assert.equal(messages[1].role, 'user')
  const block = messages[1].content
  assert.ok(block.includes(`【关系阶段】${STAGE_DESCRIPTIONS.EXPLORING}`))
  assert.ok(block.includes('对方：第一句') && block.includes('对方：第二句'))
  assert.ok(block.includes('我：早上好') && block.includes('对方：早'))
  assert.ok(block.includes('爱好：打游戏'))
  assert.ok(block.includes('专业：材料'))
  assert.ok(block.includes('一起聊过三角洲'))
  assert.ok(block.includes('【约束】'))
})

test('prompt states the JSON contract, the initiative rules and the forbidden identities', () => {
  for (const token of ['REPLY', 'NO_REPLY', 'HANDOFF', '{"action":"REPLY","messages":["第一条","第二条"]']) assert.ok(SYSTEM_PROMPT.includes(token), token)
  for (const token of ['客服', '采访式提问', '1到3条', '严禁编造']) assert.ok(SYSTEM_PROMPT.includes(token), token)
})

test('prompt honors each context limit instead of dumping the whole history', () => {
  const block = buildContextBlock(context(), { ...DEFAULT_SIMPLE_V3_CONFIG, maxIncoming: 1, recentMessages: 1, maxSelfFacts: 1, maxContactFacts: 1, maxSharedMemories: 1 })
  assert.ok(block.includes('对方：第二句'))
  assert.equal(block.includes('对方：第一句'), false)
  assert.ok(block.includes('我：吃了吗'))
  assert.equal(block.includes('我：早上好'), false)
  assert.equal(block.includes('作息：晚睡'), false)
  assert.equal(block.includes('学校：虚构大学'), false)
  assert.equal(block.includes('一起吐槽过食堂'), false)
})

test('prompt handles an empty inbound turn without inventing one', () => {
  const block = buildContextBlock(context({ incomingMessages: [] }), DEFAULT_SIMPLE_V3_CONFIG)
  assert.ok(block.includes('（本轮没有新的对方消息）'))
})

test('prompt building is pure and never mutates the caller context', () => {
  const input = context()
  const before = JSON.stringify(input)
  assert.deepEqual(buildSimpleV3Messages(input), buildSimpleV3Messages(input))
  assert.equal(JSON.stringify(input), before)
})

// ---- parser: model text -> public result ----

test('parser normalizes a JSON reply into one to three direct messages', () => {
  const parsed = parseSimpleV3Output('{"action":"REPLY","messages":["刚忙完啊","晚上吃点好的"],"handoff":false,"reason":null}')
  assert.deepEqual(parsed, { action: 'REPLY', messages: ['刚忙完啊', '晚上吃点好的'], handoff: false, reason: null })
})

test('parser caps message count, message length, duplicates and empty rows', () => {
  assert.deepEqual(parseSimpleV3Output(JSON.stringify({ action: 'REPLY', messages: ['一', '二', '三', '四'] })).messages, ['一', '二', '三'])
  assert.deepEqual(parseSimpleV3Output(JSON.stringify({ action: 'REPLY', messages: ['在的', '在的', '忙啥呢', '', '   '] })).messages, ['在的', '忙啥呢'])
  assert.deepEqual(parseSimpleV3Output(JSON.stringify({ action: 'REPLY', messages: ['一二三四五六七'] }), { maxMessageChars: 5 }).messages, ['一二三四五'])
})

test('parser tolerates fences, thinking blocks and a spoken AI prefix', () => {
  assert.deepEqual(parseSimpleV3Output('```json\n{"action":"REPLY","messages":["好"]}\n```').messages, ['好'])
  assert.deepEqual(parseSimpleV3Output('<think>内部推理</think>{"action":"REPLY","messages":["好"]}').messages, ['好'])
  assert.deepEqual(parseSimpleV3Output(JSON.stringify({ action: 'REPLY', messages: ['【AI · gpt-4o-mini】你好'] })).messages, ['你好'])
  assert.deepEqual(parseSimpleV3Output(JSON.stringify({ action: 'REPLY', messages: [123] })).messages, ['123'])
})

test('parser drops messages for NO_REPLY and lets an explicit handoff win', () => {
  assert.deepEqual(parseSimpleV3Output('{"action":"NO_REPLY","messages":["不该发"],"handoff":false}'), { action: 'NO_REPLY', messages: [], handoff: false, reason: null })
  assert.deepEqual(parseSimpleV3Output('{"action":"HANDOFF","messages":[],"handoff":true,"reason":"PHOTO_REQUEST"}'), { action: 'HANDOFF', messages: [], handoff: true, reason: 'PHOTO_REQUEST' })
  assert.deepEqual(parseSimpleV3Output('{"action":"REPLY","messages":["发照片吧"],"handoff":true}'), { action: 'HANDOFF', messages: [], handoff: true, reason: 'HANDOFF' })
})

test('parser keeps the natural conversation when the action label is unknown', () => {
  assert.deepEqual(parseSimpleV3Output('{"action":"TEASE","messages":["哈哈"]}').action, 'REPLY')
  assert.deepEqual(parseSimpleV3Output('{"action":"TEASE","messages":[]}').action, 'NO_REPLY')
})

test('parser accepts plain text and only treats an explicit marker as no reply', () => {
  assert.deepEqual(parseSimpleV3Output('哈哈那挺好的'), { action: 'REPLY', messages: ['哈哈那挺好的'], handoff: false, reason: null })
  assert.equal(parseSimpleV3Output('不回复').action, 'NO_REPLY')
  assert.equal(parseSimpleV3Output('no_reply').action, 'NO_REPLY')
  assert.deepEqual(parseSimpleV3Output('   '), { action: 'NO_REPLY', messages: [], handoff: false, reason: null })
  assert.deepEqual(parseSimpleV3Output(''), { action: 'NO_REPLY', messages: [], handoff: false, reason: null })
  assert.ok(NO_REPLY_MARKER.test('不需要回复'))
  assert.equal(NO_REPLY_MARKER.test('不想回复你'), false)
  assert.deepEqual(VALID_ACTIONS, ['REPLY', 'NO_REPLY', 'HANDOFF'])
  assert.ok(Object.isFrozen(VALID_ACTIONS))
})

// ---- engine: one model call -> public ChatEngineResult ----

test('engine requires an injected generate dependency and no other capability', () => {
  assert.throws(() => createSimpleV3Engine(), /injected generate/)
  assert.throws(() => createSimpleV3Engine({ generate: 'not-a-function' }), /injected generate/)
})

test('engine turns one model call into a validated public result', async () => {
  const seen = []
  const engine = createSimpleV3Engine({ generate: async (messages, options) => {
    seen.push({ messages, options })
    return { text: '{"action":"REPLY","messages":["刚忙完啊","晚上吃点好的"]}', model: 'fake-model', provider: 'fake-provider', aiLabel: 'AI · fake-model', usage: { prompt: 10, completion: 8, total: 18 } }
  } })
  const result = await engine.generateReply(context())
  assert.equal(seen.length, 1)
  assert.equal(seen[0].options.temperature, DEFAULT_SIMPLE_V3_CONFIG.temperature)
  assert.equal(seen[0].options.maxTokens, DEFAULT_SIMPLE_V3_CONFIG.maxTokens)
  assert.equal(seen[0].messages.length, 2)
  assert.deepEqual(result.messages, ['刚忙完啊', '晚上吃点好的'])
  assert.equal(result.action, 'REPLY')
  assert.equal(result.metadata.engine, 'simple_v3')
  assert.equal(result.metadata.version, DEFAULT_SIMPLE_V3_CONFIG.version)
  assert.equal(result.metadata.model, 'fake-model')
  assert.equal(result.metadata.provider, 'fake-provider')
  assert.deepEqual(result.metadata.usage, { prompt: 10, completion: 8, total: 18 })
  assert.doesNotThrow(() => validateChatEngineResult(result))
})

test('engine emits NO_REPLY and HANDOFF results that satisfy the public contract', async () => {
  const noReply = await createSimpleV3Engine({ generate: async () => ({ text: '{"action":"NO_REPLY","messages":[]}' }) }).generateReply(context())
  assert.equal(noReply.action, 'NO_REPLY')
  assert.deepEqual(noReply.messages, [])
  assert.doesNotThrow(() => validateChatEngineResult(noReply))
  const handoff = await createSimpleV3Engine({ generate: async () => ({ text: '{"action":"HANDOFF","messages":[],"handoff":true,"reason":"PHOTO_REQUEST"}' }) }).generateReply(context())
  assert.equal(handoff.action, 'HANDOFF')
  assert.equal(handoff.handoff, true)
  assert.equal(handoff.reason, 'PHOTO_REQUEST')
  assert.doesNotThrow(() => validateChatEngineResult(handoff))
})

test('engine checks freshness around the single call and reports stages in order', async () => {
  const order = []
  const engine = createSimpleV3Engine({
    generate: async () => { order.push('generate'); return { text: '{"action":"REPLY","messages":["好"]}' } },
    lifecycle: { assertFresh: async () => { order.push('fresh') }, stage: value => order.push(value) },
  })
  await engine.generateReply(context())
  assert.deepEqual(order, ['fresh', 'WRITING', 'generate', 'fresh', 'READY_TO_SEND'])
})

test('engine propagates a model failure unchanged instead of fabricating a reply', async () => {
  const failure = Object.assign(new Error('provider unavailable'), { code: 'NO_PROVIDER' })
  const engine = createSimpleV3Engine({ generate: async () => { throw failure } })
  await assert.rejects(engine.generateReply(context()), error => error === failure)
  await assert.rejects(engine.generateReply(null), /requires a ChatContext/)
})

test('a stale generation stops the engine before and after the model call', async () => {
  const stale = Object.assign(new Error('对方已补发新消息，此回复已过期'), { code: 'BURST_STALE' })
  let calls = 0
  const after = createSimpleV3Engine({ generate: async () => { calls++; return { text: '{"action":"REPLY","messages":["好"]}' } }, lifecycle: { assertFresh: async () => { throw stale } } })
  await assert.rejects(after.generateReply(context()), error => error === stale)
  assert.equal(calls, 0)
})

// ---- boundary: router + external guard ----

test('Simple V3 result crosses the router and the external guard without extra capability', async () => {
  const engine = createSimpleV3Engine({ generate: async () => ({ text: '{"action":"REPLY","messages":["刚忙完啊","晚上吃点好的"]}', model: 'm', provider: 'p' }) })
  const router = createChatEngineRouter({ config: { primaryChatEngine: 'simple_v3' }, engines: { simple_v3: engine } })
  const generated = await router.generateReply(context())
  assert.equal(generated.metadata.engine, 'simple_v3')
  const reviewed = []
  const result = await guardEngineResult(generated, { assertFresh: async () => {}, assertProfileRevision() {}, assertProfileReply: text => reviewed.push(text), profileRevision: 0, approvedSelfDisclosure: [] })
  assert.deepEqual(result.messages, ['刚忙完啊', '晚上吃点好的'])
  assert.deepEqual(reviewed, ['刚忙完啊', '晚上吃点好的'])
  assert.deepEqual(normalizeChatEngineResult(generated).messages, result.messages)
})

// ---- orchestrator: Legacy-compatible result mapping and Shadow records ----

function stubOrchestrator() {
  const storage = createMemoryStorage({})
  const logs = []
  const ai = { accountId: 'account-simple', storage, addLog: entry => logs.push(entry) }
  return { storage, logs, ai, orchestrator: new ConversationOrchestrator(ai, {}) }
}

test('Simple V3 compat result maps up to three bubbles while keeping Legacy field names', () => {
  const { orchestrator } = stubOrchestrator()
  const result = orchestrator.buildSimpleV3CompatResult({ action: 'REPLY', messages: ['一', '二', '三'], metadata: { model: 'm', provider: 'p', aiLabel: 'AI · m', usage: { total: 3 } } }, { settings: { showAiModelLabel: true } }, 7)
  assert.equal(result.text, '一')
  assert.equal(result.text2, '二')
  assert.equal(result.text3, '三')
  assert.deepEqual(result.texts, ['一', '二', '三'])
  assert.equal(result.labeledText, '【AI · m】一')
  assert.equal(result.skipped, false)
  assert.equal(result.selfProfileRevision, 7)
  assert.equal(result.engine, 'simple_v3')
})

test('Simple V3 compat result marks NO_REPLY as skipped with no bubbles', () => {
  const { orchestrator } = stubOrchestrator()
  const result = orchestrator.buildSimpleV3CompatResult({ action: 'NO_REPLY', messages: [], metadata: {} }, { settings: { showAiModelLabel: false } }, 0)
  assert.equal(result.skipped, true)
  assert.equal(result.text, '')
  assert.equal(result.text2, '')
  assert.equal(result.text3, '')
  assert.deepEqual(result.texts, [])
  assert.equal(result.labeledText, '')
})

test('shadow comparison records the trace and both outcomes without touching relationship or memory', () => {
  const { storage, ai, orchestrator } = stubOrchestrator()
  const before = JSON.stringify(storage.get().contacts)
  orchestrator.recordShadowComparison({ ai, contact: { id: 'c1' }, traceId: 'trace-1',
    primary: { metadata: { engine: 'legacy' }, action: 'REPLY', messages: ['主回复'], handoff: false },
    shadow: { engine: 'simple_v3', ok: true, action: 'REPLY', messages: ['影子'], handoff: false, error: null, model: 'm', provider: 'p', latencyMs: 12 },
    incomingMessages: [{ id: 'in-1', role: 'contact', text: '你好' }] })
  const saved = storage.get().shadowComparisons
  assert.equal(saved.length, 1)
  assert.equal(saved[0].traceId, 'trace-1')
  assert.equal(saved[0].contactId, 'c1')
  assert.deepEqual(saved[0].incomingMessages, [{ id: 'in-1', role: 'contact', text: '你好' }])
  assert.equal(saved[0].primary.engine, 'legacy')
  assert.deepEqual(saved[0].primary.messages, ['主回复'])
  assert.equal(saved[0].shadow.engine, 'simple_v3')
  assert.deepEqual(saved[0].shadow.messages, ['影子'])
  assert.equal(JSON.stringify(storage.get().contacts), before)
  assert.equal(storage.get().logs[0].type, 'chat_shadow_compare')
})

test('shadow comparisons are capped so storage cannot grow without bound', () => {
  const { storage, ai, orchestrator } = stubOrchestrator()
  for (let index = 0; index < 205; index += 1) {
    orchestrator.recordShadowComparison({ ai, contact: { id: 'c1' }, traceId: `trace-${index}`,
      primary: { metadata: { engine: 'legacy' }, action: 'REPLY', messages: ['主'], handoff: false },
      shadow: { engine: 'simple_v3', ok: true, action: 'NO_REPLY', messages: [], handoff: false, error: null, model: '', provider: '', latencyMs: 1 } })
  }
  const saved = storage.get().shadowComparisons
  assert.equal(saved.length, 200)
  assert.equal(saved.at(-1).traceId, 'trace-204')
})

// ---- end to end through AiService ----

function simpleStorage(settings) {
  const contact = { id: 'simple-int-1', name: '虚构联系人', profile: { chatMode: 'oldfriend' }, learning: { messages: [
    { id: 'm1', role: 'contact', text: '今天在实验室忙了一天', at: '2026-10-15T11:00:00.000Z' },
    { id: 'm2', role: 'me', text: '早上好', at: '2026-10-15T10:00:00.000Z' },
  ] } }
  return { contact, storage: createMemoryStorage({ contacts: [contact], settings,
    providers: [{ id: 'fixture', name: 'fixture', model: 'gpt-4o-mini', baseUrl: 'https://fixture.invalid' }] }) }
}
function simpleTransport(content) {
  return async (_url, _options, body) => {
    const request = JSON.parse(body)
    const system = String(request.messages?.[0]?.content || '')
    const text = system.startsWith('你不是客服') ? content : '看得我也想整点了'
    return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }
  }
}

test('Simple V3 as primary engine returns up to three bubbles and writes no memory or outgoing history', async () => {
  const { contact, storage } = simpleStorage({ primaryChatEngine: 'simple_v3' })
  const ai = new AiService(storage)
  ai.setTransport(simpleTransport('{"action":"REPLY","messages":["刚忙完啊","晚上吃点好的"],"handoff":false,"reason":null}'))
  const before = storage.get().contacts[0].learning.messages.length
  const result = await ai.draft({ contact, incoming: '今天在实验室忙了一天', incomingMeta: { messageId: 'm1', type: 'text' } })
  assert.equal(result.chatEngine, 'simple_v3')
  assert.equal(result.chatAction, 'REPLY')
  assert.equal(result.text, '刚忙完啊')
  assert.equal(result.text2, '晚上吃点好的')
  assert.equal(result.text3, '')
  assert.deepEqual(result.texts, ['刚忙完啊', '晚上吃点好的'])
  assert.equal(result.skipped, false)
  assert.equal(storage.get().contacts[0].learning.messages.length, before)
  assert.equal(storage.get().sendHistory.length, 0)
})

test('Simple V3 NO_REPLY ends the turn without a bubble or an outgoing record', async () => {
  const { contact, storage } = simpleStorage({ primaryChatEngine: 'simple_v3' })
  const ai = new AiService(storage)
  ai.setTransport(simpleTransport('{"action":"NO_REPLY","messages":[]}'))
  const result = await ai.draft({ contact, incoming: '今天在实验室忙了一天', incomingMeta: { messageId: 'm1', type: 'text' } })
  assert.equal(result.chatEngine, 'simple_v3')
  assert.equal(result.chatAction, 'NO_REPLY')
  assert.equal(result.skipped, true)
  assert.equal(result.text, '')
  assert.equal(storage.get().sendHistory.length, 0)
})

test('Legacy primary with Simple V3 Shadow records a comparison and leaves the Legacy reply untouched', async () => {
  const random = Math.random
  Math.random = () => 0.99
  try {
    const { contact, storage } = simpleStorage({ primaryChatEngine: 'legacy', shadowChatEngine: 'simple_v3', shadowEnabled: true })
    const ai = new AiService(storage)
    ai.setTransport(simpleTransport('{"action":"REPLY","messages":["影子这轮也接得住"],"handoff":false,"reason":null}'))
    const before = storage.get().contacts[0].learning.messages.length
    const result = await ai.draft({ contact, incoming: '今天在实验室忙了一天', incomingMeta: { messageId: 'm1', type: 'text' } })
    assert.equal(result.chatEngine, 'legacy')
    assert.equal(result.text, '看得我也想整点了')
    assert.equal(storage.get().contacts[0].learning.messages.length, before)
    assert.equal(storage.get().sendHistory.length, 0)
    const comparisons = storage.get().shadowComparisons
    assert.equal(comparisons.length, 1)
    assert.equal(comparisons[0].primary.engine, 'legacy')
    assert.deepEqual(comparisons[0].primary.messages, ['看得我也想整点了'])
    assert.equal(comparisons[0].shadow.engine, 'simple_v3')
    assert.equal(comparisons[0].shadow.ok, true)
    assert.deepEqual(comparisons[0].shadow.messages, ['影子这轮也接得住'])
  } finally { Math.random = random }
})

test('a failing Shadow never changes the Legacy reply that is actually sent', async () => {
  const random = Math.random
  Math.random = () => 0.99
  try {
    const { contact, storage } = simpleStorage({ primaryChatEngine: 'legacy', shadowChatEngine: 'simple_v3', shadowEnabled: true })
    const ai = new AiService(storage)
    ai.setTransport(simpleTransport(''))
    const result = await ai.draft({ contact, incoming: '今天在实验室忙了一天', incomingMeta: { messageId: 'm1', type: 'text' } })
    assert.equal(result.chatEngine, 'legacy')
    assert.equal(result.text, '看得我也想整点了')
    const comparisons = storage.get().shadowComparisons
    assert.equal(comparisons.length, 1)
    assert.equal(comparisons[0].shadow.ok, false)
    assert.equal(comparisons[0].shadow.error, 'SHADOW_GENERATION_FAILED')
    assert.equal(comparisons[0].primary.engine, 'legacy')
  } finally { Math.random = random }
})

// P1-01: 跨轮话题打转只能靠"话题进展"原则来约束，不能靠删掉主动性指令来实现。
// 这两组断言必须同时成立：新增原则在，且原来的主动聊天指令一条都没少。
test('the prompt constrains topic looping without weakening the initiative instructions', () => {
  const progress = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('关于话题进展'), SYSTEM_PROMPT.indexOf('必须避免'))
  assert.equal(progress.length > 0, true)
  for (const line of [
    '已经讲清楚的经历、观点、信息，不要为了维持对话而换一种说法反复讲',
    '想继续同一个话题，要有新的内容：新的信息、新的看法，或者对方明确追问',
    '对方只给很短的一个回应时，不必硬把刚才那件事再展开一遍',
    '一个话题聊完了，可以自然收住，也可以自然地接着聊别的；但不要生硬地跳开',
    '对方追问细节、要求澄清或让你再说一遍时，就正常重复或展开，不用刻意回避',
  ]) assert.equal(progress.includes(line), true, line)

  // 主动性指令必须在场，防止"为避免重复而不敢说话"。
  assert.equal(SYSTEM_PROMPT.includes('可以分享一点自己、顺着当前话题问一句、展开对方刚说的细节、轻微调侃、自然换到相关话题、回调以前聊过的事'), true)
  assert.equal(SYSTEM_PROMPT.includes('不要求每轮都提问，不要求每轮都分享，不要求每轮都推进关系'), true)
  assert.equal(SYSTEM_PROMPT.includes('一次可以发1到3条短消息'), true)
  assert.equal(SYSTEM_PROMPT.includes('就选择 NO_REPLY'), true)
  // 输出契约不变。
  assert.equal(SYSTEM_PROMPT.includes('{"action":"REPLY","messages":["第一条","第二条"],"handoff":false,"reason":null}'), true)
})
