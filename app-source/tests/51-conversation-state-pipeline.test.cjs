const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan, planConversation } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { AiService } = require('../electron/ai-service.cjs')

const now = new Date()
const row = (id, role, text, patch = {}) => ({ id, role, text, at: new Date(+now - 60000).toISOString(), ...patch })
const rows = texts => texts.map((text, index) => row(`m${index}`, index % 2 ? 'me' : 'contact', text, { at: new Date(+now - (texts.length - index) * 30000).toISOString() }))
const beihang = () => rows(['最近准备考研', '准备去哪', '北航吧，不过感觉挺难', '确实挺卷', '哈哈哈哈'])
const paused = () => rows(['最近准备考研，还没决定学校', '慢慢选', '对了最近养了只小猫，刚到家', '猫咪挺可爱的'])
const friend = (messages = beihang(), patch = {}) => ({ id: 'v24_a', name: '虚拟朋友甲', profile: { chatMode: 'friendship' }, learning: { messages }, ...patch })
const context = (contact = friend(), extras = {}) => buildContext({ contact, incoming: contact.learning.messages.at(-1)?.text || '', now, ...extras })
const jsonPlan = (patch = {}) => JSON.stringify({ observations: {}, plan: { shouldReply: true, action: 'ACK', goal: '接住已验证的当前焦点', ...patch }, learning: { enabled: false } })
const interpretation = message => ({ messageId: message.id, originalText: message.text, type: message.type || 'text', originalType: message.type || 'text', understandingStatus: 'not_required' })
const draft = (ai, contact) => ai.draftRelationshipMessage({ contact, incoming: contact.learning.messages.at(-1).text, media: { interpretation: interpretation(contact.learning.messages.at(-1)) } })

test('V2.4 context passes a compact grounded thread view instead of the full topic tree', () => {
  const ctx = context(friend([...paused(), row('return', 'contact', '说回考研，我还没决定学校')]))
  assert.ok(ctx.conversationState.topicTree.length >= 2)
  assert.equal(ctx.payload.conversationState.topicTree, undefined)
  assert.equal(ctx.payload.conversationState.processedMessageIds, undefined)
  assert.equal(ctx.payload.conversationState.activeTopic.evidence, undefined)
  assert.match(ctx.payload.conversationState.activeTopic.summary, /考研/)
  assert.deepEqual(ctx.payload.conversationMomentum, ctx.momentum)
})

test('a naturally completed tangent makes its evidenced paused thread available to Planner RETURN_TOPIC', () => {
  const contact = friend([...paused(), row('completed', 'contact', '这个搞定了')])
  const ctx = context(contact)
  assert.ok(ctx.conversationState.returnCandidates.some(candidate => candidate.allowedNow && candidate.sourceMessageIds.includes('m0')))
  assert.equal(ctx.attention.recommendedMode, 'START_NEW_TOPIC')
  assert.match(ctx.attention.topicSource.summary, /考研|学校/)
  assert.ok(ctx.attention.topicSource.sourceMessageIds.includes('m0'))
  assert.equal(ctx.momentum.continuation.strategy, 'RETURN_TOPIC')
  const plan = parsePlan(jsonPlan({ action: 'ACK' }), ctx)
  assert.equal(plan.continuationStrategy, 'RETURN_TOPIC')
  assert.match(plan.focusSummary, /考研|学校/)
})

for (const ending of ['睡了', '别再问了']) test(`explicit ending ${ending} stops the previous thread and skips Writer`, async () => {
  const ctx = context(friend([...paused(), row('end', 'contact', ending)]))
  assert.equal(ctx.conversationState.activeTopic, null)
  assert.deepEqual(ctx.conversationState.returnCandidates, [])
  assert.equal(ctx.momentum.engagement.level, 'ENDING')
  assert.equal(ctx.momentum.attentionWindow.active, false)
  const plan = parsePlan(jsonPlan({ action: 'FOLLOW_UP', allowQuestion: true }), ctx)
  assert.equal(plan.shouldReply, false)
  assert.equal(plan.action, 'NO_REPLY')
  assert.equal((await writeReply(() => { throw new Error('ending must not invoke Writer') }, ctx, plan)).skipped, true)
})

test('two owner interview questions forbid a third question through Context, Planner and Writer', async () => {
  const ctx = context(friend(rows(['最近准备考研', '哪个学校？', '北航', '复习多久？', '每天三个小时'])))
  assert.equal(ctx.momentum.reciprocity.questionsByMe, 2)
  assert.equal(ctx.constraints.noQuestions, true)
  const plan = parsePlan(jsonPlan({ action: 'FOLLOW_UP', allowQuestion: true }), ctx)
  assert.equal(plan.allowQuestion, false)
  assert.notEqual(plan.action, 'FOLLOW_UP')
  await assert.rejects(writeReply(async () => ({ text: '那你明天还准备复习多久？' }), ctx, plan), /提问|追问/)
})

test('name and a relationship goal alone do not authorize fabricated SHARE', () => {
  const ctx = context(friend(), { persona: { name: '虚拟本人', goal: '认识朋友' } })
  const plan = parsePlan(jsonPlan({ action: 'SHARE', allowSelfDisclosure: true }), ctx)
  assert.notEqual(ctx.momentum.continuation.strategy, 'SHARE')
  assert.equal(plan.allowSelfDisclosure, false)
  assert.notEqual(plan.action, 'SHARE')
})

test('real owner information lets reciprocity replace interviewing with SHARE while questions stay blocked', async () => {
  const ctx = context(friend(rows(['最近准备考研', '哪个学校？', '北航', '复习多久？', '每天三个小时'])), { persona: { identity: '我也是准备考研的学生', experiences: '2026-10-12 今天复习了高数' } })
  assert.equal(ctx.momentum.continuation.strategy, 'SHARE')
  const plan = parsePlan(jsonPlan({ action: 'DEEPEN', allowQuestion: true, allowSelfDisclosure: true }), ctx)
  assert.equal(plan.action, 'SHARE')
  assert.equal(plan.allowQuestion, false)
  assert.equal(plan.allowSelfDisclosure, true)
  const output = await writeReply(async () => ({ text: '我今天也在复习高数，几个题做得头大' }), ctx, plan)
  assert.match(output.text, /高数/)
})

test('a direct question still receives ANSWER when current engagement has decayed to LOW', () => {
  const ctx = context(friend([row('question', 'contact', '你准备去哪里旅游？', { at: new Date(+now - 3600000).toISOString() })]))
  assert.equal(ctx.momentum.engagement.level, 'LOW')
  assert.equal(ctx.momentum.continuation.strategy, 'ANSWER')
  const plan = parsePlan(jsonPlan({ action: 'ANSWER', allowQuestion: true }), ctx)
  assert.equal(plan.shouldReply, true)
  assert.equal(plan.action, 'ANSWER')
  assert.equal(plan.allowQuestion, false)
})

test('a former hot-chat attention window cannot revive consecutive reaction-only turns', async () => {
  const ctx = context(friend(rows(['最近准备考研', '挺有挑战的', '嗯', '继续准备', '嗯'])))
  assert.equal(ctx.momentum.engagement.level, 'LOW')
  assert.equal(ctx.momentum.continuation.strategy, 'NO_REPLY')
  assert.equal(ctx.momentum.attentionWindow.active, false)
  const { plan } = await planConversation(async () => ({ text: jsonPlan({ action: 'DEEPEN' }) }), ctx)
  assert.equal(plan.shouldReply, false)
  assert.equal((await writeReply(() => { throw new Error('low engagement must not write') }, ctx, plan)).skipped, true)
})

test('Planner rejects a model invented continuation strategy instead of reopening a stopped conversation', () => {
  const ctx = context(friend(rows(['最近准备考研', '挺有挑战的', '嗯', '继续准备', '嗯'])))
  assert.equal(ctx.momentum.continuation.strategy, 'NO_REPLY')
  assert.throws(() => parsePlan(jsonPlan({ action: 'DEEPEN', continuationStrategy: 'DEEPEN' }), ctx), /延续策略/)
})

test('owner questions remain contextual evidence and do not become the contact personal facts', () => {
  const messages = rows(['最近准备考研，还没定院校', '你现在是北航学生吗？', '还没决定'])
  const ctx = context(friend(messages))
  assert.equal(ctx.memory.profile.identity.school.status, 'unknown')
  const evidence = ctx.conversationState.topicTree.flatMap(topic => topic.evidence)
  assert.ok(evidence.some(item => item.messageId === 'm0'))
  assert.ok(!evidence.some(item => item.messageId === 'm1'))
  assert.doesNotMatch(ctx.conversationState.activeTopic.summary, /北航学生/)
})

test('quoted third-party statements and failed media cannot supply topic facts or new return evidence', () => {
  const contact = friend([row('quote', 'contact', '引用：我朋友说我是程序员'), row('img', 'contact', '[图片]', { type: 'image' })])
  const ctx = context(contact, { media: { interpretation: { messageId: 'img', originalText: '[图片]', type: 'image', understandingStatus: 'failed', socialMeaning: '她已收到北航录取通知', textInImage: '北航录取' } } })
  assert.equal(ctx.memory.profile.identity.occupation.status, 'unknown')
  assert.equal(ctx.memory.profile.identity.school.status, 'unknown')
  assert.equal(ctx.conversationState.activeTopic, null)
  assert.deepEqual(ctx.conversationState.openPoints, [])
  assert.doesNotMatch(JSON.stringify(ctx.payload.conversationState), /程序员|北航|录取/)
  assert.equal(ctx.payload.currentMessageMedia.socialMeaning, '')
})

test('restoring another contact thread rejects it rather than leaking its topics or processed IDs', () => {
  const owner = context(friend(paused())).conversationState
  const messages = [row('other_topic', 'contact', '最近正在玩王者游戏')]
  const ctx = context(friend(messages, { id: 'v24_b', name: '虚拟朋友乙', learning: { messages, conversationState: owner } }))
  assert.equal(ctx.conversationState.contactId, 'v24_b')
  assert.match(ctx.conversationState.activeTopic.summary, /王者/)
  assert.doesNotMatch(JSON.stringify(ctx.conversationState), /考研|北航|小猫/)
  assert.deepEqual(ctx.conversationState.processedMessageIds, ['other_topic'])
})

test('AiService saves state for the current contact while preserving another contact state', async () => {
  const first = friend(), secondMessages = [row('b_game', 'contact', '最近正在玩王者游戏')]
  const second = friend(secondMessages, { id: 'v24_b', name: '虚拟朋友乙' })
  second.learning.conversationState = context(second).conversationState
  const untouched = structuredClone(second), storage = createMemoryStorage({ contacts: [first, second] }), ai = new AiService(storage)
  ai.inquiryCompletion = async (_messages, options) => ({ text: options.structuredJson ? jsonPlan() : '这个目标难归难，准备过程也挺关键', model: 'mock' })
  await draft(ai, first)
  const saved = storage.get().contacts
  assert.equal(saved[0].learning.conversationState.contactId, first.id)
  assert.ok(saved[0].learning.conversationMomentum)
  assert.deepEqual(saved[1], untouched)
  assert.deepEqual(storage.get().sendHistory, [])
})

test('repeated drafts do not add interaction turns, count focus as sent or erase an evidenced identity fact', async () => {
  const messages = [row('province', 'contact', '我是湖南人。'), ...beihang()]
  const contact = friend(messages), storage = createMemoryStorage({ contacts: [contact] }), ai = new AiService(storage)
  ai.inquiryCompletion = async (_messages, options) => ({ text: options.structuredJson ? jsonPlan() : '这个目标难归难，准备过程也挺关键', model: 'mock' })
  await draft(ai, contact)
  const first = storage.get().contacts[0]
  await draft(ai, first)
  const second = storage.get().contacts[0]
  assert.deepEqual(second.learning.messages, messages)
  assert.deepEqual(second.learning.conversationState.processedMessageIds, first.learning.conversationState.processedMessageIds)
  assert.deepEqual(second.learning.conversationMomentum.reciprocity, first.learning.conversationMomentum.reciprocity)
  assert.equal(second.learning.conversationMomentum.engagement.score, first.learning.conversationMomentum.engagement.score)
  assert.equal(second.socialBrain.profile.identity.province.value, '湖南')
  assert.equal(context(second).attention.selectedFocus.messageId, 'm2')
  assert.deepEqual(storage.get().sendHistory, [])
})

test('Writer failure preserves grounded memory and state without manufacturing an outgoing turn', async () => {
  const messages = [row('province', 'contact', '我是湖南人。'), ...beihang()]
  const contact = friend(messages), storage = createMemoryStorage({ contacts: [contact] }), ai = new AiService(storage)
  ai.inquiryCompletion = async (_messages, options) => { if (options.structuredJson) return { text: jsonPlan(), model: 'mock' }; throw new Error('mock Writer failure') }
  await assert.rejects(draft(ai, contact), /mock Writer failure/)
  const saved = storage.get().contacts[0]
  assert.ok(saved.learning.conversationState)
  assert.equal(saved.socialBrain.profile.identity.province.value, '湖南')
  assert.deepEqual(saved.learning.messages, messages)
  assert.equal(saved.learning.relationshipPlan.generatedReply, undefined)
  assert.equal(context(saved).attention.selectedFocus.messageId, 'm2')
  assert.deepEqual(storage.get().sendHistory, [])
})

test('event followup context is isolated from ordinary ending state and momentum', async () => {
  const ctx = buildContext({ contact: friend([row('end', 'contact', '睡了')]), incoming: '', opening: true, now })
  assert.equal(ctx.conversationState, null)
  assert.equal(ctx.momentum, null)
  assert.equal(ctx.payload.conversationState, undefined)
  assert.equal(ctx.payload.conversationMomentum, undefined)
  ctx.payload.proactiveCandidate = { type: 'event_followup', eventId: 'interview', reason: '对方昨天面试' }
  const { plan } = await planConversation(async () => ({ text: jsonPlan({ action: 'EVENT_FOLLOWUP', shouldInitiate: true }) }), ctx)
  assert.equal(plan.shouldReply, true)
  assert.equal(plan.action, 'EVENT_FOLLOWUP')
  assert.equal(plan.continuationStrategy, undefined)
})

test('legacy proactive opening remains on its existing path and does not overwrite new conversation state', async () => {
  const contact = friend(), state = context(contact).conversationState
  contact.learning.conversationState = state
  const storage = createMemoryStorage({ contacts: [contact] }), ai = new AiService(storage)
  let invoked = 0
  ai.draftRelationshipMessageLegacy = async args => { invoked++; assert.equal(args.opening, true); return { ok: true, text: '老开场流程' } }
  const result = await ai.draftRelationshipMessage({ contact, incoming: '', opening: true })
  assert.equal(invoked, 1)
  assert.equal(result.text, '老开场流程')
  assert.deepEqual(storage.get().contacts[0].learning.conversationState, state)
})

test('bounded long history keeps compact topic state and selected Beihang focus within the existing budget', () => {
  const oldRows = Array.from({ length: 60 }, (_, index) => row(`old${index}`, index % 2 ? 'me' : 'contact', `数学复习${'今天内容比较多'.repeat(70)}${index}`, { at: new Date(+now - (70 - index) * 60000).toISOString() }))
  const ctx = context(friend([...oldRows, ...beihang()]), { tokenBudget: 6000 })
  assert.ok(ctx.estimatedTokens <= ctx.tokenBudget)
  assert.equal(ctx.attention.selectedFocus.messageId, 'm2')
  assert.equal(ctx.payload.conversationState.topicTree, undefined)
  assert.ok(ctx.payload.conversationState.openPoints.length <= 8)
})

test('V2.3 unfinished Beihang focus survives latest haha with V2.4 state and Writer context', async () => {
  const ctx = context()
  assert.equal(ctx.attention.selectedFocus.messageId, 'm2')
  assert.equal(ctx.attention.recommendedMode, 'CONTINUE_TOPIC')
  assert.match(ctx.conversationState.activeTopic.summary, /考研|北航/)
  const plan = parsePlan(jsonPlan({ action: 'ACK' }), ctx)
  let payload
  const written = await writeReply(async messages => { payload = JSON.parse(messages[1].content); return { text: '难归难，目标定下来复习也有方向' } }, ctx, plan)
  assert.match(written.text, /目标/)
  assert.equal(payload.context.attentionContext.selectedFocus.messageId, 'm2')
  assert.match(payload.context.conversationState.activeTopic.summary, /北航/)
  assert.equal(payload.context.conversationMomentum.continuation.strategy, ctx.momentum.continuation.strategy)
})
