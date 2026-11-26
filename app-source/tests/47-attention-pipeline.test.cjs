const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan, planConversation } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const now = new Date()
const msg = (id, role, text, patch = {}) => ({ id, role, text, at: new Date(now.getTime() - 60000).toISOString(), ...patch })
const history = () => [msg('m1', 'contact', '最近准备考研'), msg('m2', 'me', '准备去哪'), msg('m3', 'contact', '想考北京'), msg('m4', 'me', '有目标学校没'), msg('m5', 'contact', '北航吧，不过感觉挺难'), msg('m6', 'me', '确实挺卷'), msg('m7', 'contact', '哈哈哈哈')]
const friend = (messages = history(), patch = {}) => ({ id: 'test_friend', name: '测试朋友', profile: { chatMode: 'friendship' }, learning: { messages }, ...patch })
const context = (contact = friend(), extras = {}) => buildContext({ contact, incoming: contact.learning.messages.at(-1)?.text || '', now, ...extras })
const planJson = (patch = {}) => JSON.stringify({ observations: {}, plan: { shouldReply: true, action: 'ACK', goal: '接住当前焦点', ...patch }, learning: { enabled: false } })
const semantic = (patch = {}) => ({ messageId: 'img', originalText: '[图片]', type: 'image', originalType: 'image', understandingStatus: 'failed', confidence: 0, emotion: [], socialMeaning: '', ...patch })

test('pipeline continues unfinished Beihang topic after haha and Writer receives the original focus', async () => {
  const ctx = context()
  assert.equal(ctx.attention.selectedFocus.messageId, 'm5'); assert.equal(ctx.payload.attentionContext.recommendedMode, 'CONTINUE_TOPIC')
  const calls = []
  const complete = async (messages, options) => {
    calls.push({ messages, options })
    return { text: options.structuredJson ? planJson({ action: 'FOLLOW_UP', focusMode: 'CONTINUE_TOPIC', focusMessageId: 'm5' }) : '感觉难归难，也不是不能冲一把', model: 'mock' }
  }
  const planned = await planConversation(complete, ctx), output = await writeReply(complete, ctx, planned.plan)
  assert.equal(planned.plan.focusMessageId, 'm5'); assert.equal(output.text, '感觉难归难，也不是不能冲一把')
  assert.equal(JSON.parse(calls[1].messages[1].content).context.attentionContext.selectedFocus.messageId, 'm5')
})
test('latest direct question survives full planner routing', async () => {
  const ctx = context(friend([...history(), msg('direct', 'contact', '对了你研究生也是机械的吗？')]))
  assert.equal(ctx.attention.selectedFocus.messageId, 'direct')
  const { plan } = await planConversation(async () => ({ text: planJson({ action: 'ANSWER', focusMode: 'RESPOND_FOCUS', focusMessageId: 'direct' }) }), ctx)
  assert.equal(plan.focusMessageId, 'direct'); assert.equal(plan.action, 'ANSWER')
})
test('Planner cannot invent a new-topic source or reroute to unselected message', () => {
  const ctx = context()
  assert.throws(() => parsePlan(planJson({ focusMode: 'START_NEW_TOPIC' }), ctx), /焦点|来源/)
  assert.throws(() => parsePlan(planJson({ focusMode: 'CONTINUE_TOPIC', focusMessageId: 'm7' }), ctx), /焦点消息/)
})
test('router NO_REPLY overrides ordinary model response and skips Writer network invocation', async () => {
  const ctx = context(friend([msg('done', 'contact', '好')]))
  assert.equal(ctx.attention.recommendedMode, 'NO_REPLY')
  const { plan } = await planConversation(async () => ({ text: planJson({ action: 'REACTION', focusMode: 'NO_REPLY' }) }), ctx)
  assert.equal(plan.shouldReply, false); assert.equal(plan.action, 'NO_REPLY')
  const written = await writeReply(() => { throw new Error('Writer must not be called') }, ctx, plan)
  assert.equal(written.skipped, true)
})
test('failed image does not erase a valid earlier text focus or expose guessed semantics', async () => {
  const contact = friend([...history().slice(0, -1), msg('img', 'contact', '[图片]', { type: 'image' })])
  const ctx = context(contact, { media: { interpretation: semantic({ socialMeaning: '图片中是北京大学通知书', textInImage: '北京大学录取' }) } })
  assert.equal(ctx.attention.selectedFocus.messageId, 'm5'); assert.equal(ctx.attention.recommendedMode, 'CONTINUE_TOPIC')
  assert.equal(ctx.constraints.mediaUnderstandingFailed, true)
  assert.doesNotMatch(JSON.stringify(ctx.payload.attentionContext), /通知书|录取/)
  const plan = parsePlan(planJson({ action: 'ACK', focusMode: 'CONTINUE_TOPIC', focusMessageId: 'm5' }), ctx)
  const written = await writeReply(async () => ({ text: '这个目标难归难，值得认真准备' }), ctx, plan)
  assert.match(written.text, /目标/)
})
test('understood reaction sticker keeps active topic while current media evidence remains associated', () => {
  const contact = friend([...history().slice(0, -1), msg('img', 'contact', '[表情包]', { type: 'sticker' })])
  const ctx = context(contact, { media: { interpretation: semantic({ originalText: '[表情包]', type: 'sticker', originalType: 'sticker', understandingStatus: 'understood', confidence: 0.8, emotion: ['playful'], socialMeaning: '可能是在玩笑式嫌弃' }) } })
  assert.match(ctx.attention.activeTopic.summary, /考研/); assert.equal(ctx.attention.selectedFocus.messageId, 'm5')
  assert.equal(ctx.payload.currentMessageMedia.messageId, 'img'); assert.equal(ctx.attention.latestMessage.classification, 'REACTION')
})
test('event followup has its independent mode and cannot be swallowed by ending-message attention', async () => {
  const ctx = buildContext({ contact: friend([msg('sleep', 'contact', '睡了')]), incoming: '', opening: true, now })
  ctx.payload.proactiveCandidate = { type: 'event_followup', eventId: 'interview', reason: '对方昨天面试' }
  assert.equal(ctx.attention, null); assert.equal(ctx.payload.attentionContext, undefined)
  const planned = await planConversation(async () => ({ text: planJson({ action: 'EVENT_FOLLOWUP', shouldInitiate: true, allowQuestion: true }) }), ctx)
  assert.equal(planned.plan.shouldReply, true); assert.equal(planned.plan.action, 'EVENT_FOLLOWUP')
  const output = await writeReply(async () => ({ text: '昨天那个面试结束以后感觉咋样' }), ctx, planned.plan)
  assert.match(output.text, /面试/)
})
test('adding a verified mature reply example cannot change focus or recency scores', () => {
  const plain = context()
  const marked = context(friend(history(), { profile: { chatMode: 'friendship', examplesSource: 'owner', examples: [{ source: 'manual_owner', verifiedHuman: true, contextSummary: '北航感觉挺难', targetMeaning: '北航感觉挺难', action: 'ACK', relationshipStage: 'new_friend', myReply: '感觉难归难，认真准备总有机会' }] } }))
  assert.equal(marked.replyExampleCandidates.length, 1)
  assert.deepEqual(marked.attention.selectedFocus, plain.attention.selectedFocus)
  assert.deepEqual(marked.attention.rankedFocusCandidates, plain.attention.rankedFocusCandidates)
})
test('Writer uses examples as references and blocks a verbatim reused mature reply', async () => {
  const ctx = context(friend(history(), { profile: { chatMode: 'friendship', examplesSource: 'owner', examples: [{ source: 'manual_owner', verifiedHuman: true, contextSummary: '北航感觉挺难', targetMeaning: '北航感觉挺难', action: 'ACK', relationshipStage: 'new_friend', myReply: '感觉难归难，认真准备总有机会' }] } }))
  const plan = parsePlan(planJson({ focusMode: 'CONTINUE_TOPIC', focusMessageId: 'm5' }), ctx)
  await assert.rejects(writeReply(async () => ({ text: '感觉难归难，认真准备总有机会' }), ctx, plan), /照抄/)
})
test('long context stays within token budget while retaining selected focus', () => {
  const rows = Array.from({ length: 65 }, (_, index) => msg(`old${index}`, index % 2 ? 'me' : 'contact', `数学复习准备${'今天内容比较多'.repeat(80)}${index}`))
  const ctx = context(friend([...rows, ...history()]), { tokenBudget: 6000 })
  assert.ok(ctx.estimatedTokens <= ctx.tokenBudget); assert.equal(ctx.attention.selectedFocus.messageId, 'm5')
  assert.equal(ctx.payload.attentionContext.selectedFocus.messageId, 'm5')
})
test('a concrete previously delivered expansion is not repeatedly selected across turns', async () => {
  const first = context()
  const messages = [...history().slice(0, -1), msg('expanded', 'me', '北航数学难度挺高，可以考虑北理工作为备选'), msg('latest', 'contact', '哈哈哈哈')]
  const ctx = context(friend(messages, { learning: { messages, conversationAttention: first.attention.state } }))
  assert.equal(ctx.attention.selectedFocus, null); assert.equal(ctx.attention.recommendedMode, 'NO_REPLY')
  const plan = parsePlan(planJson({ action: 'ACK' }), ctx)
  assert.equal((await writeReply(() => { throw new Error('no repeat') }, ctx, plan)).skipped, true)
})
test('making a draft does not count focus as sent or append an outgoing message', async () => {
  const contact = friend(), storage = createMemoryStorage({ contacts: [contact] }), ai = new AiService(storage)
  ai.inquiryCompletion = async (_messages, options) => ({ text: options.structuredJson ? planJson({ action: 'ACK', focusMode: 'CONTINUE_TOPIC', focusMessageId: 'm5' }) : '这个目标确实难，准备过程也挺关键', model: 'mock' })
  const result = await ai.draftRelationshipMessage({ contact, incoming: '哈哈哈哈', media: { interpretation: { messageId: 'm7', originalText: '哈哈哈哈', type: 'text', originalType: 'text', understandingStatus: 'not_required' } } })
  assert.equal(result.skipped, false)
  const saved = storage.get().contacts[0]
  assert.deepEqual(saved.learning.messages, contact.learning.messages)
  assert.equal(storage.get().sendHistory.length, 0)
  const state = saved.learning.conversationAttention
  assert.ok(!state?.processedFocusIds?.includes('m5'))
  assert.notEqual(state?.lastDecision?.status, 'sent')
  assert.equal(context(saved).attention.selectedFocus.messageId, 'm5')
})
