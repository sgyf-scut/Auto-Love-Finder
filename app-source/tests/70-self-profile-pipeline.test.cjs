const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { createSeedSelfProfile, normalizeSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const now = new Date('2026-10-13T12:00:00+08:00')
const profile = () => normalizeSelfProfile({ ...createSeedSelfProfile({ now }), stableProfile: [...createSeedSelfProfile({ now }).stableProfile, { key: 'private_note', label: '私密资料', value: '专属私密测试值', shareLevel: 'PRIVATE' }] }, { now })
function contact(incoming = '最近晚上都在打三角洲', extra = {}) {
  return { id: 'fake_friend', name: '虚拟朋友', profile: { chatMode: 'friendship', relationship: '刚认识', examples: ['专属私密测试值是我收藏的东西'], ...extra.profile }, learning: { messages: [{ id: 'in1', role: 'contact', text: incoming, at: now.toISOString() }], ...extra.learning }, ...extra }
}
const context = (incoming, extra = {}) => buildContext({ contact: contact(incoming), incoming, selfProfile: profile(), persona: { identity: '专属私密测试值', city: '旧人设的无关城市' }, now, ...extra })
const planFor = (ctx, patch = {}, learning = {}) => parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '接住当前话题', allowQuestion: false, allowSelfDisclosure: true, selfDisclosureKeys: [], ...patch }, learning }), ctx)

test('PRIVATE values are absent from Planner including legacy persona, examples, memory and history', () => {
  const c = contact('最近晚上都在打三角洲', { learning: { messages: [{ id: 'old', role: 'me', text: '专属私密测试值', at: now.toISOString() }, { id: 'in1', role: 'contact', text: '最近晚上都在打三角洲', at: now.toISOString() }], facts: [{ text: '专属私密测试值' }], ownerStyle: { summary: '专属私密测试值' } } })
  const ctx = context(c.learning.messages.at(-1).text, { contact: c })
  assert.equal(JSON.stringify(ctx.payload).includes('专属私密测试值'), false)
  assert.equal(JSON.stringify(ctx.payload).includes('旧人设的无关城市'), false)
})
test('gaming topic retrieves gaming without unrelated school, birthday or travel', () => {
  const ctx = context('最近晚上都在打三角洲')
  assert.ok(ctx.selfRelevant.some(item => item.key === 'gaming'))
  assert.equal(ctx.selfRelevant.some(item => ['education', 'birthDate', 'travel', 'currentWork'].includes(item.key)), false)
})
test('Writer sees only selected disclosures, not full relevant facts or source text', async () => {
  const ctx = context('最近晚上都在打三角洲'), plan = planFor(ctx, { action: 'SHARE', selfDisclosureKeys: ['gaming'] })
  let captured
  await writeReply(async rows => { captured = JSON.parse(rows[1].content); return { text: '我也玩三角洲' } }, ctx, plan)
  assert.equal(captured.context.selfProfileContext, undefined)
  assert.equal(captured.context.newFriendContext, undefined)
  assert.deepEqual(captured.context.approvedSelfDisclosure.map(item => item.key), ['gaming'])
  assert.equal(JSON.stringify(captured).includes('sourceText'), false)
  assert.equal(JSON.stringify(captured).includes('专属私密测试值'), false)
})
test('no selection cannot hand any available personal facts to Writer', async () => {
  const ctx = context('最近晚上都在打三角洲'), plan = planFor(ctx)
  let captured
  await writeReply(async rows => { captured = JSON.parse(rows[1].content); return { text: '晚上开一局确实舒服' } }, ctx, plan)
  assert.deepEqual(captured.context.approvedSelfDisclosure, [])
  assert.deepEqual(captured.context.layers.find(layer => layer.layer === 1).data, [])
})
test('forged irrelevant disclosure key is not approved', () => {
  const ctx = context('最近晚上都在打三角洲'), plan = planFor(ctx, { selfDisclosureKeys: ['education', 'private_note'] })
  assert.deepEqual(plan.approvedSelfDisclosure, [])
})
test('school CAUTIOUS can be selected in a direct school question', async () => {
  const ctx = context('你在哪个大学读书？'), plan = planFor(ctx, { action: 'ANSWER', selfDisclosureKeys: ['education'] })
  assert.ok(plan.approvedSelfDisclosure.some(item => item.key === 'education' && item.shareLevel === 'CAUTIOUS'))
  const written = await writeReply(async () => ({ text: '我在示例理工大学' }), ctx, plan)
  assert.ok(written.text.includes('示例理工大学'))
})
test('unknown graduate year cannot be fabricated in Writer', async () => {
  const ctx = context('你研几？'), plan = planFor(ctx, { action: 'ANSWER', allowQuestion: true, selfDisclosureKeys: ['education'] })
  await assert.rejects(writeReply(async () => ({ text: '研二，你呢' }), ctx, plan), /年级|身份/)
})
test('running affinity never permits a fabricated running achievement', async () => {
  const ctx = context('你跑过半马吗？'), plan = planFor(ctx, { action: 'ANSWER', selfDisclosureKeys: ['sports'] })
  await assert.rejects(writeReply(async () => ({ text: '我去年跑过半马' }), ctx, plan), /具体本人经历|身份/)
})
test('Writer refuses PRIVATE output even when model invents it independently', async () => {
  const ctx = context('最近晚上都在打三角洲'), plan = planFor(ctx)
  await assert.rejects(writeReply(async () => ({ text: '专属私密测试值' }), ctx, plan), /私密/)
})
test('NO_REPLY remains terminal and does not invoke Writer', async () => {
  const ctx = context('哈哈哈哈'), plan = planFor(ctx, { shouldReply: false, action: 'NO_REPLY', selfDisclosureKeys: ['gaming'] })
  let calls = 0
  const written = await writeReply(async () => { calls++; return { text: '不可发送' } }, ctx, plan)
  assert.equal(calls, 0); assert.equal(written.skipped, true); assert.deepEqual(plan.approvedSelfDisclosure, [])
})
test('profile updates are visible on the next context build', () => {
  const p = profile(), a = context('最近晚上都在打三角洲', { selfProfile: p })
  const b = context('最近晚上都在打三角洲', { selfProfile: { ...p, revision: p.revision + 1, stableProfile: p.stableProfile.map(item => item.key === 'gaming' ? { ...item, value: ['单机游戏'] } : item) } })
  assert.notDeepEqual(a.selfRelevant.find(item => item.key === 'gaming').value, b.selfRelevant.find(item => item.key === 'gaming').value)
})
test('expired current life is absent from Planner relevant self context', () => {
  const p = profile(); p.currentLife = [{ key: 'currentWork', value: '已过期的项目', expiresAt: '2026-10-01T00:00:00Z', shareLevel: 'NORMAL' }]
  const ctx = context('最近在忙什么项目？', { selfProfile: p })
  assert.equal(JSON.stringify(ctx.payload).includes('已过期的项目'), false)
})
test('contact lens and relationship state are stored separately from factual memory', async () => {
  const c = contact(), storage = createMemoryStorage({ contacts: [c], selfProfile: profile(), providers: [{ id: 'fake', model: 'fake' }] }), ai = new AiService(storage)
  ai.inquiryCompletion = async (_, opts) => ({ text: opts.structuredJson ? JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '接住三角洲', allowQuestion: false, selfDisclosureKeys: [] }, learning: { enabled: false } }) : '这局打得挺过瘾', model: 'fake', provider: 'fake' })
  await ai.draftRelationshipMessage({ contact: c, incoming: c.learning.messages[0].text })
  const saved = storage.get().contacts[0]
  assert.ok(saved.personaLens); assert.ok(saved.relationshipState)
  assert.equal(saved.socialBrain.personaLens, undefined)
  assert.equal(saved.socialBrain.relationshipState, undefined)
  assert.equal(saved.learning.messages.some(row => row.role === 'me'), false)
})
test('repeated generation on the same real messages does not grow relationship state', async () => {
  const c = contact(), storage = createMemoryStorage({ contacts: [c], selfProfile: profile(), providers: [{ id: 'fake', model: 'fake' }] }), ai = new AiService(storage)
  ai.inquiryCompletion = async (_, opts) => ({ text: opts.structuredJson ? JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '接住三角洲', allowQuestion: false }, learning: { enabled: false } }) : '这局打得挺过瘾', model: 'fake', provider: 'fake' })
  await ai.draftRelationshipMessage({ contact: c, incoming: c.learning.messages[0].text })
  const first = storage.get().contacts[0].relationshipState
  await ai.draftRelationshipMessage({ contact: c, incoming: c.learning.messages[0].text })
  const second = storage.get().contacts[0].relationshipState
  for (const name of ['warmth','familiarity','curiosity','playfulness','trust','flirt']) assert.equal(first[name], second[name])
})
test('legacy chat completion boundary redacts private history and rewrite payloads', async () => {
  const storage = createMemoryStorage({ selfProfile: profile() }), ai = new AiService(storage)
  let captured
  ai.setTransport(async (_url, _opts, body) => { captured = JSON.parse(body); return {} })
  await ai.postProfileChat('https://example.test/chat/completions', {}, JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: '专属私密测试值' }] }))
  assert.equal(JSON.stringify(captured).includes('专属私密测试值'), false)
})
test('legacy inquiry chat boundary redacts private video/history prompt values', async () => {
  const storage = createMemoryStorage({ selfProfile: profile() }), ai = new AiService(storage)
  let captured
  ai.inquiryCompletion = async rows => { captured = rows; return { text: 'ok' } }
  await ai.profileChatCompletion([{ role: 'user', content: '专属私密测试值' }])
  assert.equal(JSON.stringify(captured).includes('专属私密测试值'), false)
})
test('event follow-up bypasses ordinary NO_REPLY routing and receives adaptive context', () => {
  const ctx = context('', { opening: true })
  ctx.payload.proactiveCandidate = { eventId: 'evt', reason: '面试结束' }
  const plan = planFor(ctx, { action: 'EVENT_FOLLOWUP', shouldInitiate: true })
  assert.equal(plan.action, 'EVENT_FOLLOWUP'); assert.equal(plan.shouldReply, true)
  assert.ok(ctx.personaLens); assert.equal(ctx.payload.attentionContext, undefined)
})

test('formal profile change during Planner discards generation without persisting an old plan', async () => {
  const c = contact(), storage = createMemoryStorage({ contacts: [c], selfProfile: profile(), providers: [{ id: 'fake', model: 'fake' }] }), ai = new AiService(storage)
  ai.inquiryCompletion = async () => {
    const p = storage.get().selfProfile
    storage.update({ selfProfile: { ...p, revision: p.revision + 1 } })
    return { text: JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '旧规划', allowQuestion: false }, learning: { enabled: false } }), model: 'fake' }
  }
  await assert.rejects(ai.draftRelationshipMessage({ contact: c, incoming: c.learning.messages[0].text }), error => error.code === 'SELF_PROFILE_STALE')
  assert.equal(storage.get().contacts[0].learning.relationshipPlan, undefined)
})
test('PRIVATE values remain redacted when adaptive profile is disabled', async () => {
  const p = { ...profile(), enabled: false }, ctx = context('最近晚上都在打三角洲', { selfProfile: p })
  assert.equal(ctx.constraints.adaptiveProfileEnabled, false)
  assert.equal(JSON.stringify(ctx.payload).includes('专属私密测试值'), false)
  const ai = new AiService(createMemoryStorage({ selfProfile: p }))
  let captured
  ai.inquiryCompletion = async rows => { captured = rows; return { text: 'ok' } }
  await ai.profileChatCompletion([{ role: 'user', content: '专属私密测试值' }])
  assert.equal(JSON.stringify(captured).includes('专属私密测试值'), false)
  assert.throws(() => ai.assertProfileReply('专属私密测试值'), /私密/)
})
test('draft output exposes formal revision for send-time freshness validation', async () => {
  const c = contact(), storage = createMemoryStorage({ contacts: [c], selfProfile: profile(), providers: [{ id: 'fake', model: 'fake' }] }), ai = new AiService(storage)
  ai.inquiryCompletion = async (_, opts) => ({ text: opts.structuredJson ? JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '接住三角洲', allowQuestion: false }, learning: { enabled: false } }) : '这局打得挺过瘾', model: 'fake', provider: 'fake' })
  const result = await ai.draftRelationshipMessage({ contact: c, incoming: c.learning.messages[0].text })
  assert.equal(result.selfProfileRevision, storage.get().selfProfile.revision)
})
test('candidate picker receives new public interests and cannot leak legacy private persona', async () => {
  const ai = new AiService(createMemoryStorage({ selfProfile: profile() }))
  let captured
  ai.inquiryCompletion = async rows => { captured = JSON.parse(rows[1].content); return { text: JSON.stringify({ index: 0, reason: '真实共同兴趣' }), model: 'fake' } }
  await ai.pickFriendCandidate({ persona: { interests: '专属私密测试值', goal: '私密资料' }, keyword: '游戏', candidates: [{ name: '合成用户', summary: '三角洲玩家' }] })
  assert.ok(captured.persona.interests.includes('三角洲'))
  assert.equal(JSON.stringify(captured).includes('专属私密测试值'), false)
})


test('burst travel facts remain approved after Planner memory refresh and are traceable in strategy', async () => {
  const c = contact('', { learning: { messages: [] } })
  const storage = createMemoryStorage({ contacts: [c], selfProfile: profile(), providers: [{ id: 'fake', model: 'fake' }] }), ai = new AiService(storage)
  let writerPayload
  ai.inquiryCompletion = async (rows, options) => {
    if (options.structuredJson) return { text: JSON.stringify({ plan: { shouldReply: true, action: 'ANSWER', goal: '回答真实西安旅行经历', allowQuestion: false, allowSelfDisclosure: true, selfDisclosureKeys: ['travel'] }, learning: { enabled: false } }), model: 'fake', provider: 'fake' }
    writerPayload = JSON.parse(rows[1].content)
    return { text: '我去过西安，具体细节有点记不清了', model: 'fake', provider: 'fake' }
  }
  const messages = [
    { id: 'trip0', messageId: 'trip0', role: 'contact', type: 'text', text: '我最近想去西安', at: new Date().toISOString() },
    { id: 'trip1', messageId: 'trip1', role: 'contact', type: 'text', text: '你去过吗，有什么印象', at: new Date().toISOString() },
  ]
  const result = await ai.draftRelationshipMessage({ contact: c, incoming: messages[1].text, currentIncomingBurst: { burstId: 'travel-burst', contactId: c.id, conversationRevision: 2, messages } })
  assert.deepEqual(result.strategy.selfDisclosureKeys, ['travel'])
  assert.ok(result.strategy.approvedSelfDisclosure.some(item => item.key === 'travel' && item.value.includes('西安')))
  assert.deepEqual(result.strategy.approvedSelfDisclosure, writerPayload.context.approvedSelfDisclosure)
  const saved = storage.get().contacts[0].learning.relationshipPlan
  assert.deepEqual(saved.selfDisclosureKeys, ['travel'])
  assert.deepEqual(saved.approvedSelfDisclosure, result.strategy.approvedSelfDisclosure)
})
