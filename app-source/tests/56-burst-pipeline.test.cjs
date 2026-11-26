const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { normalizeIncomingBurst, withIncomingBurst, assertGenerationFresh } = require('../electron/social-brain/incoming-burst.cjs')
const { parsePlan } = require('../electron/social-brain/conversation-planner.cjs')

const at = new Date().toISOString()
const row = (id, text, extra = {}) => ({ messageId: id, id, role: 'contact', type: 'text', text, at, ...extra })
const batch = (messages, extra = {}) => ({ burstId: 'burst:A:1', contactId: 'A', conversationRevision: messages.length, messages, ...extra })
const defaultRows = () => [row('b1', '我今天去答辩了'), row('b2', '老师给我喷惨了'), row('b3', '还让我补三组实验')]
const planJson = (patch = {}) => JSON.stringify({ observations: {}, plan: { shouldReply: true, action: 'EMPATHY', goal: '接住答辩被批评的情绪', length: 'short', allowQuestion: false, ...patch }, learning: { enabled: false }, advisor: { needed: false } })

function setup(messages = defaultRows()) {
  const prior = [row('old1', '昨天还在改PPT'), row('old2', '改完就能喘口气了', { role: 'me' })]
  const contact = { id: 'A', name: '虚拟答辩朋友', profile: { chatMode: 'friendship' }, learning: { messages: prior } }
  const storage = createMemoryStorage({ contacts: [contact], providers: [{ id: 'fake', name: 'test', model: 'test', baseUrl: 'https://example.test' }], selfPersona: { identity: '研究生', experiences: '今天整理了书桌' } })
  const ai = new AiService(storage), calls = []
  ai.inquiryCompletion = async (messages, options) => {
    calls.push({ messages, options })
    return { text: options.structuredJson ? planJson() : '这也太折腾了', model: 'test', provider: 'test', usage: { prompt: 10, completion: 10, total: 20 } }
  }
  return { ai, storage, contact, calls, currentIncomingBurst: batch(messages), recentConversationContext: prior }
}
function userPayload(call) { return JSON.parse(call.messages.findLast(m => m.role === 'user').content) }

test('three burst rows remain three original evidence IDs without a concatenated synthetic message', () => {
  const f = setup(), context = buildContext({ ...f, incoming: '第一条旧预览' })
  assert.deepEqual(context.payload.currentIncomingBurst.messages.map(m => m.messageId), ['b1', 'b2', 'b3'])
  assert.deepEqual(context.messages.filter(m => /^b/.test(m.id)).map(m => m.text), defaultRows().map(m => m.text))
  assert.equal(context.messages.some(m => defaultRows().every(row => m.text.includes(row.text))), false)
})

test('last incoming burst row stays current incoming evidence rather than first preview', () => {
  const f = setup(), context = buildContext({ ...f, incoming: '我今天去答辩了' })
  assert.equal(context.payload.incoming, '还让我补三组实验'); assert.equal(context.messages.at(-1).id, 'b3')
  assert.equal(context.messages.at(-1).text, '还让我补三组实验')
})

test('empty final media caption never borrows the old preview as invented literal evidence', () => {
  const f = setup([row('caption1', '看这张照片'), row('picture1', '', { type: 'image' })])
  const context = buildContext({ ...f, incoming: '看这张照片' })
  assert.equal(context.payload.incoming, '')
  assert.equal(context.messages.at(-1).id, 'picture1'); assert.equal(context.messages.at(-1).text, '')
  assert.equal(context.messages.length, 4)
})

test('previous context and current incoming turn are separately exposed without overlap', () => {
  const f = setup(), context = buildContext({ ...f, incoming: 'ignored' })
  assert.deepEqual(context.payload.recentConversationContext.map(m => m.messageId), ['old1', 'old2'])
  assert.equal(context.payload.currentIncomingBurst.messageCount, 3)
  assert.equal(context.payload.recentConversationContext.some(m => /^b/.test(m.messageId)), false)
})

test('actual facts point at their individual inbound source IDs', () => {
  const f = setup([row('identity1', '我是湖南人'), row('identity2', '我的专业是机械'), row('identity3', '我喜欢篮球')])
  const context = buildContext({ ...f })
  assert.equal(context.memory.profile.identity.province.value, '湖南')
  assert.deepEqual(context.memory.profile.identity.province.sourceMessageIds, ['identity1'])
  assert.deepEqual(context.memory.profile.identity.major.sourceMessageIds, ['identity2'])
  assert.equal(context.memory.facts.some(fact => fact.sourceMessageIds.some(id => !['identity1', 'identity2', 'identity3'].includes(id))), false)
})

test('owner quotations remain quotations and never become the contact identity', () => {
  const quote = { sourceMessageId: 'owner-quote', text: '我在北京大学读书', ownership: 'owner', sender: 'me', type: 'text' }
  const f = setup([row('quote1', '这句说得好', { type: 'quoted', quote }), row('quote2', '哈哈')])
  const context = buildContext({ ...f })
  assert.equal(context.memory.profile.identity.school.status, 'unknown')
  assert.equal(context.memory.facts.some(fact => /北京大学/.test(fact.evidence)), false)
  assert.equal(context.payload.currentIncomingBurst.messages[0].quote.text, quote.text)
})

test('mixed media rows preserve order and original IDs in context', () => {
  const f = setup([row('text1', '看这个'), row('img1', '', { type: 'image', media: { url: 'https://example.test/image' } }), row('gif1', '', { type: 'gif', media: { url: 'https://example.test/gif' } }), row('sticker1', '', { type: 'sticker' })])
  const context = buildContext({ ...f })
  assert.deepEqual(context.payload.currentIncomingBurst.messages.map(m => m.type), ['text', 'image', 'gif', 'sticker'])
  assert.deepEqual(context.payload.currentIncomingBurst.messages.map(m => m.messageId), ['text1', 'img1', 'gif1', 'sticker1'])
  assert.doesNotMatch(JSON.stringify(context.payload), /data:image\/|base64/)
})

test('earlier failed picture does not receive the last picture captured frame', async () => {
  const f = setup([row('img1', '[图片]', { type: 'image' }), row('img2', '[图片]', { type: 'image' })]), interpreted = []
  f.ai.interpretIncomingMessage = async ({ incoming, incomingMeta, media = {} }) => {
    interpreted.push({ id: incomingMeta.messageId, frameCount: media.frames?.length || 0 })
    return { messageId: incomingMeta.messageId, type: incomingMeta.type, originalText: incoming,
      understandingStatus: incomingMeta.messageId === 'img1' ? 'failed' : 'understood',
      visualDescription: incomingMeta.messageId === 'img2' ? '一只猫' : '', textInImage: '', socialMeaning: '', emotion: [], confidence: 0.8, uncertainty: [], evidence: [] }
  }
  await f.ai.draftRelationshipMessage({ ...f, media: { frames: ['data:image/png;base64,AAAA'], capturedMessageId: 'img2', captureEvidence: { verified: true } } })
  assert.deepEqual(interpreted, [{ id: 'img1', frameCount: 0 }, { id: 'img2', frameCount: 1 }])
  const payload = userPayload(f.calls[0]), first = payload.currentIncomingBurst.messages.find(m => m.messageId === 'img1')
  assert.equal(first.mediaInterpretation.understandingStatus, 'failed')
  assert.doesNotMatch(JSON.stringify(first), /一只猫/)
})

test('a burst of haha / acknowledgement / sleeping calls Planner once and never Writer', async () => {
  const f = setup([row('close1', '哈哈'), row('close2', '确实'), row('close3', '睡了')])
  const result = await f.ai.draftRelationshipMessage({ ...f })
  assert.equal(f.calls.length, 1); assert.equal(result.strategy.action, 'NO_REPLY'); assert.equal(result.text, ''); assert.equal(result.skipped, true)
  assert.deepEqual(f.storage.get().pendingDrafts, []); assert.deepEqual(f.storage.get().sendHistory, [])
})

test('new revision during Planner throws BURST_STALE and never persists old plan', async () => {
  const f = setup(); let fresh = true
  f.ai.inquiryCompletion = async (_, options) => { assert.equal(options.structuredJson, true); fresh = false; return { text: planJson(), model: 'test' } }
  await assert.rejects(f.ai.draftRelationshipMessage({ ...f, generationGuard: async () => fresh }), error => error.code === 'BURST_STALE')
  const current = f.storage.get().contacts[0]
  assert.equal(current.socialBrain?.lastPlan, undefined); assert.equal(current.learning.relationshipPlan, undefined)
  assert.deepEqual(f.storage.get().pendingDrafts, [])
})

test('new revision during Writer discards text without generatedReply or sending task', async () => {
  const f = setup(); let fresh = true, count = 0
  f.ai.inquiryCompletion = async (_, options) => { count++; if (!options.structuredJson) fresh = false; return { text: options.structuredJson ? planJson() : '过期的回复', model: 'test' } }
  await assert.rejects(f.ai.draftRelationshipMessage({ ...f, generationGuard: async () => fresh }), error => error.code === 'BURST_STALE')
  assert.equal(count, 2); const current = f.storage.get().contacts[0]
  assert.equal(current.learning.relationshipPlan?.generatedReply, undefined); assert.equal(current.socialBrain?.lastPlan?.generatedReply, undefined)
  assert.deepEqual(f.storage.get().pendingDrafts, []); assert.deepEqual(f.storage.get().sendHistory, [])
})

test('valid generation announces PLANNING, WRITING then READY_TO_SEND', async () => {
  const f = setup(), stages = [], guardCalls = []
  const result = await f.ai.draftRelationshipMessage({ ...f, onGenerationStage: stage => stages.push(stage), generationGuard: async () => { guardCalls.push('checked'); return true } })
  assert.deepEqual(stages, ['PLANNING', 'WRITING', 'READY_TO_SEND']); assert.ok(guardCalls.length >= 5); assert.equal(result.text, '这也太折腾了')
  assert.deepEqual(f.storage.get().sendHistory, [])
})

test('new revision at READY_TO_SEND boundary cannot persist a generated stale reply', async () => {
  const f = setup(); let fresh = true
  await assert.rejects(f.ai.draftRelationshipMessage({ ...f, generationGuard: async () => fresh,
    onGenerationStage: stage => { if (stage === 'READY_TO_SEND') fresh = false } }), error => error.code === 'BURST_STALE')
  assert.equal(f.storage.get().contacts[0].learning.relationshipPlan?.generatedReply, undefined)
})

test('guard failure before execution does not call a model or mutate plans', async () => {
  const f = setup(); await assert.rejects(f.ai.draftRelationshipMessage({ ...f, generationGuard: async () => false }), error => error.code === 'BURST_STALE')
  assert.equal(f.calls.length, 0); assert.equal(f.storage.get().contacts[0].socialBrain, undefined)
})

test('old draftRelationshipMessage API without a burst or guard stays compatible', async () => {
  const f = setup(); const result = await f.ai.draftRelationshipMessage({ contact: f.contact, incoming: '老师让我补实验' })
  assert.equal(result.text, '这也太折腾了'); assert.equal(f.calls.length, 2)
  assert.equal(userPayload(f.calls[0]).currentIncomingBurst, undefined)
})

test('top-level draft accepts a whole burst and freshness guard before forwarding to social Planner', async () => {
  const f = setup(); const result = await f.ai.draft({ ...f, incoming: '我今天去答辩了', generationGuard: async () => true })
  assert.equal(result.text, '这也太折腾了')
  const planned = f.calls.find(call => call.options.structuredJson)
  assert.deepEqual(userPayload(planned).currentIncomingBurst.messages.map(m => m.messageId), ['b1', 'b2', 'b3'])
})

test('a different contact burst is rejected instead of leaking into this contact', () => {
  const f = setup(), wrong = batch([row('privateB', 'OTHER_CONTACT_SECRET')], { contactId: 'B' })
  assert.equal(normalizeIncomingBurst(wrong, 'A'), null)
  const grouped = withIncomingBurst(f.contact, wrong)
  assert.equal(grouped.burst, null); assert.doesNotMatch(JSON.stringify(grouped), /OTHER_CONTACT_SECRET/)
})

test('foreign contact rows inside a burst are excluded', () => {
  const normalized = normalizeIncomingBurst(batch([row('a', 'visible', { contactId: 'A' }), row('b', 'OTHER_CONTACT_SECRET', { contactId: 'B' })]), 'A')
  assert.deepEqual(normalized.messages.map(m => m.id), ['a']); assert.doesNotMatch(JSON.stringify(normalized), /OTHER_CONTACT_SECRET/)
})

test('proactive opening context omits ordinary incoming burst routing', () => {
  const f = setup(), context = buildContext({ ...f, opening: true, incoming: '' })
  assert.equal(context.payload.currentIncomingBurst, undefined); assert.equal(context.payload.recentConversationContext, undefined)
  assert.equal(context.attention, null)
})

test('ordinary burst prompt stays within bounded context budget and keeps all current IDs', () => {
  const f = setup(); f.recentConversationContext = Array.from({ length: 25 }, (_, i) => row(`old${i}`, '这是旧话题背景'.repeat(30), { role: i % 2 ? 'me' : 'contact' }))
  const context = buildContext({ ...f, tokenBudget: 3000 })
  assert.ok(context.estimatedTokens <= 3000)
  assert.deepEqual(context.payload.currentIncomingBurst.messages.map(m => m.messageId), ['b1', 'b2', 'b3'])
})

test('freshness helper supports absent guard, async guard and explicit guard errors', async () => {
  await assertGenerationFresh(); await assertGenerationFresh(async () => true)
  await assert.rejects(assertGenerationFresh(async () => false), error => error.code === 'BURST_STALE')
  const error = new Error('generation cancelled'); error.code = 'BURST_STALE'
  await assert.rejects(assertGenerationFresh(async () => { throw error }), current => current === error)
})
test('Planner may center a verified later supplement from this same burst and Writer receives that focus',async()=>{
  const f=setup();f.ai.inquiryCompletion=async(messages,options)=>{f.calls.push({messages,options});return {text:options.structuredJson?planJson({focusMessageId:'b3'}):'补实验确实挺折腾的',model:'test'}}
  const result=await f.ai.draftRelationshipMessage({...f,incoming:'旧预览'})
  assert.equal(result.strategy.focusMessageId,'b3');assert.equal(result.attention.selectedFocus.messageId,'b3')
  assert.equal(userPayload(f.calls[1]).context.attentionContext.selectedFocus.messageId,'b3')
})
test('burst focus refinement rejects a prior-context message or an unknown identifier',()=>{
  for(const focusMessageId of ['old1','foreign-secret']){const f=setup(),ctx=buildContext({...f,incoming:'旧预览'});assert.throws(()=>parsePlan(planJson({focusMessageId}),ctx),/焦点消息/)}
})
test('unknown image inside a burst remains ineligible for focus refinement',()=>{
  const f=setup([row('b1','老师给了修改要求'),row('image','',{type:'image'}),row('b3','还要补三组实验')]),ctx=buildContext({...f,incoming:''})
  assert.throws(()=>parsePlan(planJson({focusMessageId:'image'}),ctx),/焦点消息/)
})
test('an explicit question retains priority over other informative rows in the same burst',()=>{
  const f=setup([row('ask','你几点过来？'),row('info','我今天整理了书桌')]),ctx=buildContext({...f,incoming:''})
  assert.equal(ctx.attention.selectedFocus.directQuestion,1)
  assert.throws(()=>parsePlan(planJson({focusMessageId:'info'}),ctx),/焦点消息/)
})
test('all actual burst rows remain available in stored history for later conversations',async()=>{
  const f=setup();await f.ai.draftRelationshipMessage({...f,incoming:'旧预览'})
  const history=f.storage.get().contacts[0].learning.messages
  assert.deepEqual(history.filter(m=>/^b/.test(m.id||m.messageId)).map(m=>m.text),defaultRows().map(m=>m.text))
  assert.equal(history.some(m=>m.role==='me'&&m.text==='这也太折腾了'),false)
})
test('an outdated batch before execution cannot replace stored raw history',async()=>{
  const f=setup(),before=f.storage.get().contacts[0].learning.messages
  await assert.rejects(f.ai.draftRelationshipMessage({...f,generationGuard:async()=>false}),e=>e.code==='BURST_STALE')
  assert.deepEqual(f.storage.get().contacts[0].learning.messages,before)
})
