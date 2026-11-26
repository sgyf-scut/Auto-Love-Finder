const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { buildChatContext } = require('../electron/chat-core/context-builder.cjs')
const { normalizeSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const { approveSelfDisclosure } = require('../electron/social-brain/disclosure-policy.cjs')
const { validateChatContext } = require('../electron/chat-core/chat-types.cjs')

const now = new Date('2026-10-15T04:00:00Z')
const SECRET = '合成绝不披露资料甲'
const CURRENT_SECRET = '合成近期保密计划乙'
const SCHOOL = '合成谨慎甲大学'
const FAMILY = '合成谨慎乙家庭行业'
const OTHER_CONTACT = '其他联系人独有的合成记忆'
const CREDENTIAL = 'synthetic-provider-credential-value'
function selfProfile() {
  return normalizeSelfProfile({ enabled: true, revision: 7, stableProfile: [
    { key: 'name', label: '姓名', value: '合成本人', shareLevel: 'OPEN' },
    { key: 'gaming', label: '游戏', value: ['三角洲', '星露谷'], shareLevel: 'OPEN' },
    { key: 'education', label: '学校', value: SCHOOL, shareLevel: 'CAUTIOUS' },
    { key: 'family', label: '家庭', value: FAMILY, shareLevel: 'CAUTIOUS' },
    { key: 'secret_hobby', label: '私人收藏', value: SECRET, shareLevel: 'PRIVATE', sourceText: `本人保密内容：${SECRET}` },
  ], currentLife: [
    { key: 'private_plan', label: '近期私人计划', value: CURRENT_SECRET, shareLevel: 'PRIVATE', sourceText: `私人计划为${CURRENT_SECRET}` },
  ], privacyPreferences: [] }, { now })
}
function row(id, role, text, extra = {}) { return { id, contactId: 'contact-a', role, text, at: now.toISOString(), ...extra } }
function person(patch = {}) {
  return { id: 'contact-a', name: '合成朋友甲', profile: { chatMode: 'oldfriend', relationship: '大学朋友', examples: [] }, learning: { messages: [] }, ...patch }
}
function setup({ incoming = '你玩三角洲吗？', contact = person(), profile = selfProfile(), media = {}, burst, approved = [], legacy = {}, accountId = 'account-a', traceId = 'trace-a' } = {}) {
  const oldContext = buildContext({ contact, incoming, selfProfile: profile, media, currentIncomingBurst: burst, now })
  const chatContext = buildChatContext({ accountId, traceId, contact, incoming, burst, context: oldContext, profile, approved, legacy })
  return { oldContext, chatContext, contact, profile }
}
function assertAbsent(context, values) {
  const encoded = JSON.stringify(context)
  for (const value of values) assert.equal(encoded.includes(value), false, `Engine context leaked ${value}`)
}
function assertPrivateAbsent(context) { assertAbsent(context, [SECRET, CURRENT_SECRET, '[私密信息]']) }

test('real Legacy context is converted into complete immutable public JSON context', () => {
  const { chatContext } = setup()
  assert.deepEqual(validateChatContext(chatContext), JSON.parse(JSON.stringify(chatContext)))
  assert.equal(chatContext.accountId, 'account-a')
  assert.equal(chatContext.contactId, 'contact-a')
  assert.equal(chatContext.traceId, 'trace-a')
  assert.ok(Object.isFrozen(chatContext))
  assert.ok(Object.isFrozen(chatContext.metadata.legacy.context.payload))
  assert.throws(() => chatContext.selfFacts.push({ key: 'injected', value: 'wrong' }), TypeError)
})
test('scopes have stable fallbacks when old contact records lack an id or account', () => {
  const contact = person({ id: undefined, name: '无平台id合成联系人' })
  const first = setup({ contact, accountId: undefined }).chatContext
  const second = setup({ contact, accountId: undefined }).chatContext
  assert.ok(first.accountId.trim())
  assert.ok(first.contactId.trim())
  assert.equal(first.accountId, second.accountId)
  assert.equal(first.contactId, second.contactId)
})
test('context creation retains caller state and does not freeze or sanitize stored originals', () => {
  const contact = person({ profile: { chatMode: 'oldfriend', relationship: '老朋友', notes: SECRET, examples: [`以前提过${SECRET}`] }, learning: { messages: [row('past', 'me', SECRET)] } })
  const original = JSON.stringify(contact)
  const { chatContext } = setup({ contact })
  assert.equal(JSON.stringify(contact), original)
  assert.equal(Object.isFrozen(contact), false)
  contact.profile.notes = '修改原对象'
  assertPrivateAbsent(chatContext)
})

const privateSources = {
  'recent raw history': () => ({ contact: person({ learning: { messages: [row('old-private', 'me', SECRET)] } }) }),
  'manual notes and legacy speaking examples': () => ({ contact: person({ profile: { chatMode: 'oldfriend', relationship: '老朋友', notes: SECRET, examples: [SECRET], personality: SECRET, boundary: CURRENT_SECRET } }) }),
  'legacy memory facts and style summary': () => ({ contact: person({ learning: { messages: [], facts: [{ text: SECRET }], ownerStyle: { summary: CURRENT_SECRET } } }) }),
  'quoted text and quoted author': () => ({ contact: person({ learning: { messages: [row('quote-1', 'contact', '这个怎么说', { quote: { messageId: 'old-me', role: 'me', text: SECRET, author: CURRENT_SECRET } })] } }) }),
  'video title description comments and audio': () => ({ media: { videoPageTitle: SECRET, videoPageDescription: CURRENT_SECRET, videoComments: [SECRET], audioTranscript: CURRENT_SECRET, analysis: SECRET } }),
  'understood media OCR and social meaning': () => ({ incoming: '[图片]', contact: person({ learning: { messages: [row('image-current', 'contact', '[图片]', { type: 'image' })] } }), media: { interpretation: { messageId: 'image-current', originalText: '[图片]', type: 'image', originalType: 'image', understandingStatus: 'understood', visualDescription: SECRET, textInImage: CURRENT_SECRET, socialMeaning: SECRET, emotion: [], confidence: 0.9, sourceFrameCount: 1, evidence: [{ text: CURRENT_SECRET }] } } }),
  'incoming actual text': () => ({ incoming: `这个是${SECRET}` }),
  'incoming burst actual text': () => ({ incoming: '补充说一句', burst: { contactId: 'contact-a', burstId: 'burst-private', messages: [row('private-b1', 'contact', SECRET), row('private-b2', 'contact', '补充说一句')] } }),
}
for (const [source, fixture] of Object.entries(privateSources)) {
  test(`PRIVATE raw values and redaction substitutes are absent from ${source}`, () => {
    const { chatContext } = setup(fixture())
    assertPrivateAbsent(chatContext)
  })
}
test('PRIVATE facts never enter public selfFacts or a hidden raw Self Profile copy', () => {
  const { chatContext } = setup({ incoming: '你平时什么兴趣，最近在忙啥？' })
  assertPrivateAbsent(chatContext)
  assert.equal(chatContext.selfFacts.some(item => item.shareLevel === 'PRIVATE'), false)
  assert.equal(chatContext.metadata.legacy.context.selfProfile.pending, undefined)
  assert.equal(chatContext.metadata.legacy.context.selfProfile.currentLife.length, 0)
})
test('an unapproved relevant CAUTIOUS value is absent from all layers but retains a selectable key and label', () => {
  const { chatContext } = setup({ incoming: '你在哪个学校读书？', contact: person({ profile: { chatMode: 'oldfriend', notes: `读的是${SCHOOL}`, examples: [`我在${SCHOOL}`] }, learning: { messages: [row('school-past', 'me', SCHOOL)] } }) })
  assertAbsent(chatContext, [SCHOOL, FAMILY])
  const options = chatContext.metadata.legacy.context.payload.selfProfileContext.selfRelevant
  const descriptor = options.find(item => item.key === 'education')
  assert.ok(descriptor)
  assert.equal(descriptor.label, '学校')
  assert.equal(Object.hasOwn(descriptor, 'value'), false)
})
test('unapproved CAUTIOUS values are removed from history and notes even when unrelated to current gaming topic', () => {
  const { chatContext } = setup({ contact: person({ profile: { chatMode: 'oldfriend', notes: `学校${SCHOOL}，家庭${FAMILY}`, examples: [`之前在${SCHOOL}`] }, learning: { messages: [row('old-school', 'me', SCHOOL), row('old-family', 'me', FAMILY)] } }) })
  assertAbsent(chatContext, [SCHOOL, FAMILY])
  assert.deepEqual(chatContext.selfFacts.map(item => item.key), ['gaming'])
})
test('a real Planner-approved related CAUTIOUS field can enter without disclosing unrelated cautious facts', () => {
  const profile = selfProfile(), incoming = '你在哪个学校读书？'
  const contact = person({ profile: { chatMode: 'oldfriend', notes: FAMILY, examples: [FAMILY] }, learning: { messages: [row('old-family', 'me', FAMILY)] } })
  const oldContext = buildContext({ contact, incoming, selfProfile: profile, now })
  const approved = approveSelfDisclosure(profile, oldContext, { shouldReply: true, allowSelfDisclosure: true, selfDisclosureKeys: ['education', 'family'] })
  assert.deepEqual(approved.map(item => item.key), ['education'])
  const chatContext = buildChatContext({ accountId: 'account-a', traceId: 'approved-trace', contact, incoming, context: oldContext, profile, approved })
  assert.equal(chatContext.selfFacts.find(item => item.key === 'education')?.value, SCHOOL)
  assertAbsent(chatContext, [FAMILY, SECRET, CURRENT_SECRET])
})
test('approval cannot inject a forged fact or revive an unrelated cautious field', () => {
  const { chatContext } = setup({ incoming: '你玩三角洲吗？', approved: [{ key: 'education', value: '伪造大学值' }, { key: 'private_plan', value: CURRENT_SECRET }], contact: person({ profile: { chatMode: 'oldfriend', notes: SCHOOL }, learning: { messages: [] } }) })
  assertAbsent(chatContext, [SCHOOL, '伪造大学值', SECRET, CURRENT_SECRET])
  assert.deepEqual(chatContext.selfFacts.map(item => item.key), ['gaming'])
})
test('metadata legacy is allowlisted and cannot transport credentials complete state or other contacts', () => {
  const legacy = { mode: 'friendship', incoming: '你玩三角洲吗？', config: { settings: { showAiModelLabel: false, twoMessageChance: 0, apiKey: CREDENTIAL }, apiKey: CREDENTIAL, aiSkills: [], contacts: [{ id: 'contact-b', memory: OTHER_CONTACT }] }, apiKey: CREDENTIAL, credentials: { key: CREDENTIAL }, state: { contacts: [{ id: 'contact-b', memory: OTHER_CONTACT }] }, contacts: [{ id: 'contact-b', memory: OTHER_CONTACT }] }
  const { chatContext } = setup({ legacy })
  assert.equal(chatContext.metadata.legacy.mode, 'friendship')
  assertAbsent(chatContext, [CREDENTIAL, OTHER_CONTACT])
  assert.equal(chatContext.metadata.legacy.apiKey, undefined)
  assert.equal(chatContext.metadata.legacy.state, undefined)
  assert.equal(chatContext.metadata.legacy.config.settings.twoMessageChance, 0)
})
test('contact and old-context extra properties cannot smuggle a different contact or credentials', () => {
  const contact = person({ credentials: { apiKey: CREDENTIAL }, otherContacts: [{ id: 'contact-b', notes: OTHER_CONTACT }] })
  contact.profile.otherContacts = [{ notes: OTHER_CONTACT }]
  contact.learning.credentials = { apiKey: CREDENTIAL }
  const profile = selfProfile(), incoming = '你玩三角洲吗？'
  const oldContext = buildContext({ contact, incoming, selfProfile: profile, now })
  oldContext.state = { contacts: [{ id: 'contact-b', notes: OTHER_CONTACT }], apiKey: CREDENTIAL }
  const chatContext = buildChatContext({ accountId: 'account-a', traceId: 'isolation', contact, incoming, context: oldContext, profile })
  assertAbsent(chatContext, [CREDENTIAL, OTHER_CONTACT])
  assert.equal(chatContext.contactId, 'contact-a')
})
test('explicitly foreign contact history cannot contaminate current recent messages or hidden Legacy context', () => {
  const contact = person({ learning: { messages: [row('foreign-history', 'contact', OTHER_CONTACT, { contactId: 'contact-b' }), row('owned-history', 'contact', '一起打三角洲吗')] } })
  const { chatContext } = setup({ incoming: '一起打三角洲吗', contact })
  assertAbsent(chatContext, [OTHER_CONTACT])
  assert.equal(chatContext.recentMessages.some(item => item.id === 'foreign-history'), false)
  assert.equal(chatContext.metadata.legacy.current.learning.messages.some(item => item.id === 'foreign-history'), false)
})
test('foreign contact rows are excluded from incoming burst rather than accepted by their text', () => {
  const burst = { contactId: 'contact-a', burstId: 'mixed', messages: [row('mine-1', 'contact', '我在玩三角洲'), row('foreign-1', 'contact', OTHER_CONTACT, { contactId: 'contact-b' }), row('mine-2', 'contact', '晚上来一把吗')] }
  const { chatContext } = setup({ incoming: '晚上来一把吗', burst })
  assert.deepEqual(chatContext.incomingMessages.map(item => item.id || item.messageId), ['mine-1', 'mine-2'])
  assertAbsent(chatContext, [OTHER_CONTACT])
})
test('a whole foreign burst cannot enter the current contact Engine context', () => {
  const burst = { contactId: 'contact-b', burstId: 'foreign', messages: [row('foreign-1', 'contact', OTHER_CONTACT, { contactId: 'contact-b' })] }
  const { chatContext } = setup({ incoming: '你玩三角洲吗？', burst })
  assertAbsent(chatContext, [OTHER_CONTACT])
  assert.equal(chatContext.incomingMessages.some(item => item.id === 'foreign-1'), false)
})
test('actual burst boundaries retain platform evidence IDs and original message order', () => {
  const burst = { contactId: 'contact-a', burstId: 'burst-ordered', conversationRevision: 5, messages: [row('z-first', 'contact', '先说一件事'), row('a-second', 'contact', '[表情]', { type: 'sticker' }), row('m-third', 'contact', '再补充一句')] }
  const { chatContext } = setup({ incoming: '再补充一句', burst })
  assert.deepEqual(chatContext.incomingMessages.map(item => item.id || item.messageId), ['z-first', 'a-second', 'm-third'])
  assert.deepEqual(chatContext.incomingMessages.map(item => item.text), ['先说一件事', '[表情]', '再补充一句'])
  assert.equal(chatContext.incomingMessages[1].type, 'sticker')
  assert.deepEqual(chatContext.metadata.legacy.context.payload.currentIncomingBurst.messages.map(item => item.messageId), ['z-first', 'a-second', 'm-third'])
})
