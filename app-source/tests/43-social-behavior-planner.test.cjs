const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { ACTIONS, parsePlan, planConversation } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { AiService } = require('../electron/ai-service.cjs')
function fixture(incoming = '我今天又迟到了', extras = {}) {
  const contact = { id: 'friend', name: '测试朋友', profile: { chatMode: 'friendship', ...extras.profile }, learning: { messages: extras.history || [{ id: 'incoming', role: 'contact', text: incoming }] } }
  const context = buildContext({ contact, incoming, persona: extras.persona || {}, media: extras.media || {} })
  return { contact, context }
}
const json = (patch = {}) => JSON.stringify({ plan: { shouldReply: true, action: 'ACK', goal: '自然接话', ...patch }, observations: {}, learning: { enabled: false } })
const full = { shouldReply: true, action: 'TEASE', goal: '轻度善意调侃', messageCount: 2, length: 'very_short', allowQuestion: false, allowSelfDisclosure: false, conversationIntent: 'keep_light', tone: 'playful', relationshipIntensity: 0.55, shouldCloseTopic: false, avoid: [] }
const semantic = (patch = {}) => ({ messageId: 'incoming', originalText: '[表情包]', type: 'sticker', originalType: 'sticker', understandingStatus: 'understood', emotion: ['playful'], socialMeaning: '可能是在玩笑式嫌弃', visualDescription: '熊猫翻白眼', confidence: 0.8, sourceFrameCount: 1, ...patch })

test('ordinary actions retain the 13 social behaviors', () => {
  assert.deepEqual(ACTIONS, ['ACK', 'REACTION', 'ANSWER', 'EMPATHY', 'TEASE', 'JOKE', 'FOLLOW_UP', 'DEEPEN', 'SHARE', 'SHARE_AND_ASK', 'SHIFT', 'CLOSE', 'NO_REPLY'])
})
for (const text of ['哈哈哈哈', '好', '行', '睡了', 'OK']) test(`${text} may close without a reply or Writer invocation`, async () => {
  const { context } = fixture(text), plan = parsePlan(json({ action: 'NO_REPLY', shouldReply: false, messageCount: 2 }), context)
  assert.equal(plan.messageCount, 0); assert.equal(plan.allowQuestion, false); assert.equal(plan.allowSelfDisclosure, false)
  const output = await writeReply(() => { throw new Error('must skip Writer') }, context, plan)
  assert.equal(output.skipped, true)
})
test('a question containing haha is still answerable', () => {
  const plan = parsePlan(json({ action: 'ANSWER' }), fixture('哈哈你几点来？').context)
  assert.equal(plan.shouldReply, true); assert.equal(plan.messageCount, 1)
})
test('new structure preserves behavior fields and limits initial familiarity', () => {
  const plan = parsePlan(json(full), fixture().context)
  assert.equal(plan.action, 'TEASE'); assert.equal(plan.relationshipIntensity, 0.25)
  for (const key of ['messageCount', 'length', 'allowQuestion', 'allowSelfDisclosure', 'conversationIntent', 'tone', 'shouldCloseTopic']) assert.equal(plan[key], full[key])
  assert.match(plan.avoid.join(' '), /轻调侃/)
})
test('explicit old friend allows stronger TEASE while explicit new relation remains conservative', () => {
  assert.equal(parsePlan(json({ ...full, relationshipIntensity: 0.9 }), fixture('我今天又迟到了', { profile: { chatMode: 'oldfriend' } }).context).relationshipIntensity, 0.8)
  assert.equal(parsePlan(json(full), fixture('我今天又迟到了', { profile: { chatMode: 'oldfriend', relationship: '刚认识的新朋友' } }).context).relationshipIntensity, 0.25)
  assert.equal(parsePlan(json(full), fixture('我今天又迟到了', { profile: { relationship: '大学舍友' } }).context).relationshipIntensity, 0.55)
})
for (const action of ['REACTION', 'TEASE']) test(`playful sticker supports ${action} without default serious empathy`, () => {
  const { context } = fixture('[表情包]', { media: { interpretation: semantic() } })
  const plan = parsePlan(json({ ...full, action, messageCount: 1 }), context)
  assert.equal(plan.action, action); assert.equal(plan.allowQuestion, false)
})
test('negative image blocks teasing and does not promote image emotion into facts', () => {
  const { context } = fixture('[表情包]', { media: { interpretation: semantic({ emotion: ['sad'] }) } })
  assert.equal(parsePlan(json(full), context).action, 'EMPATHY'); assert.equal(context.memory.facts.length, 0)
})
test('playful exasperation remains light while explicit anger overrides playfulness', () => {
  const light = fixture('[表情包]', { media: { interpretation: semantic({ emotion: ['frustrated', 'playful'] }) } }).context
  assert.equal(parsePlan(json(full), light).action, 'TEASE')
  const angry = fixture('[表情包]', { media: { interpretation: semantic({ emotion: ['angry', 'playful'] }) } }).context
  assert.equal(parsePlan(json(full), angry).action, 'EMPATHY')
})
test('failed image clears invented social goals and blocks teasing', () => {
  const { context } = fixture('[表情包]', { media: { interpretation: semantic({ understandingStatus: 'failed' }) } })
  const plan = parsePlan(json({ ...full, goal: '调侃她猫白眼是喜欢你', selectedTopic: '她喜欢我' }), context)
  assert.equal(plan.action, 'NO_REPLY'); assert.doesNotMatch(plan.goal, /猫|喜欢/)
  assert.equal(context.attention.selectedFocus, null); assert.doesNotMatch(plan.selectedTopic, /猫|喜欢/)
})
test('low-confidence media is not evidence for teasing', () => {
  const { context } = fixture('[表情包]', { media: { interpretation: semantic({ confidence: 0.3 }) } })
  const plan = parsePlan(json(full), context)
  assert.ok(['ACK', 'NO_REPLY'].includes(plan.action)); assert.equal(plan.relationshipIntensity, 0)
})
test('two recent real questions override model permission and follow-up action', () => {
  const { context } = fixture('今天上课', { history: [{ role: 'me', text: '你在哪？' }, { role: 'contact', text: '先不说' }, { role: 'me', text: '你喜欢啥？' }, { id: 'incoming', role: 'contact', text: '今天上课' }] })
  const plan = parsePlan(json({ action: 'FOLLOW_UP', allowQuestion: true }), context)
  assert.equal(plan.allowQuestion, false); assert.equal(plan.learningOpportunity.shouldAsk, false); assert.equal(plan.action, 'EMPATHY')
})
test('allowQuestion false is enforced by existing single-message Writer', async () => {
  const { context } = fixture(), plan = parsePlan(json({ allowQuestion: false }), context)
  await assert.rejects(writeReply(async () => ({ text: '后来怎么了？' }), context, plan), /禁止提问/)
})
test('CLOSE and shouldCloseTopic cannot start a new question', async () => {
  const { context } = fixture('今天聊得挺开心'), plan = parsePlan(json({ action: 'CLOSE', allowQuestion: true, allowSelfDisclosure: true }), context)
  assert.equal(plan.shouldCloseTopic, true); assert.equal(plan.allowQuestion, false)
  assert.equal(plan.conversationIntent, 'close')
  assert.equal(parsePlan(json({ action: 'SHIFT', shouldCloseTopic: true }), context).action, 'CLOSE')
  await assert.rejects(writeReply(async () => ({ text: '明天去哪玩？' }), context, plan), /禁止提问/)
})
for (const count of [1, 2, 3]) test(`Planner stores ${count} messages while Writer still returns one string`, async () => {
  const { context } = fixture(), plan = parsePlan(json({ messageCount: count }), context)
  const result = await writeReply(async () => ({ text: '你是真稳定' }), context, plan)
  assert.equal(plan.messageCount, count); assert.equal(typeof result.text, 'string'); assert.equal(result.messages, undefined)
})
for (const patch of [{ messageCount: 0 }, { messageCount: 4 }, { messageCount: 1.5 }, { messageCount: '2' }, { allowQuestion: 'false' }, { allowSelfDisclosure: 1 }, { shouldCloseTopic: 'yes' }, { length: 'long' }, { tone: 'romantic' }, { conversationIntent: 'seduce' }, { relationshipIntensity: 1.1 }, { relationshipIntensity: '0.2' }, { avoid: 'anything' }]) test(`invalid behavioral field is rejected: ${JSON.stringify(patch)}`, () => {
  assert.throws(() => parsePlan(json(patch), fixture().context), /规划|数量/)
})
test('no real self persona means SHARE cannot invent a personal experience', () => {
  const plan = parsePlan(json({ action: 'SHARE', allowSelfDisclosure: true }), fixture().context)
  assert.equal(plan.allowSelfDisclosure, false); assert.equal(plan.action, 'ACK')
})
test('event follow-up keeps its specialized action and old JSON schema', async () => {
  const { context } = fixture('哈哈'); context.payload.proactiveCandidate = { type: 'event_followup', eventId: 'event1' }
  const plan = parsePlan(JSON.stringify({ plan: { shouldInitiate: true, action: 'EVENT_FOLLOWUP', goal: '自然询问面试情况' } }), context)
  assert.equal(plan.shouldReply, true); assert.equal(plan.messageCount, 1); assert.equal(plan.action, 'EVENT_FOLLOWUP')
  assert.equal(plan.conversationIntent, 'follow_up_event')
  assert.throws(() => parsePlan(json({ action: 'EVENT_FOLLOWUP' }), fixture().context), /动作|候选/)
})
test('Planner prompt receives sticker semantics, relation cap and ending guidance', async () => {
  const { context } = fixture('[表情包]', { media: { interpretation: semantic() } })
  let input
  await planConversation(async messages => { input = messages; return { text: json(full) } }, context)
  assert.match(JSON.stringify(input), /玩笑式嫌弃|socialMeaning/)
  assert.match(input[0].content, /messageCount|REACTION|TEASE|CLOSE/)
  assert.match(input[0].content, /无需每条输入都输出/)
})
test('ordinary closing hints cannot replace or consume a due event follow-up', () => {
  const { context } = fixture('行'); context.payload.proactiveCandidate = { type: 'event_followup', eventId: 'event1' }
  const plan = parsePlan(json({ action: 'EVENT_FOLLOWUP', shouldCloseTopic: true }), context)
  assert.equal(plan.shouldReply, true); assert.equal(plan.action, 'EVENT_FOLLOWUP'); assert.equal(plan.shouldCloseTopic, false)
  assert.equal(plan.conversationIntent, 'follow_up_event')
  assert.throws(() => parsePlan(json({ action: 'CLOSE' }), context), /事件专用动作/)
})
test('behavior fields persist in plan history and do not generate extra bubbles', async () => {
  const { contact } = fixture(), storage = createMemoryStorage({ contacts: [contact] }), ai = new AiService(storage)
  let calls = 0
  ai.inquiryCompletion = async (_, options) => { calls++; return { text: options.structuredJson ? json(full) : '你是真稳定', model: 'test' } }
  const result = await ai.draftRelationshipMessage({ contact, incoming: '我今天又迟到了' })
  assert.equal(calls, 2); assert.equal(result.strategy.messageCount, 2); assert.equal(result.text2, '')
  assert.equal(storage.get().contacts[0].socialBrain.lastPlan.allowQuestion, false)
  assert.equal(storage.get().contacts[0].socialBrain.planHistory.at(-1).relationshipIntensity, 0.25)
})
