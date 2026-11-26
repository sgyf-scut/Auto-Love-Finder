const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildNewFriendContext } = require('../electron/social-brain/new-friend-context.cjs')
const contact = { id: 'new', profile: { relationship: '新朋友' }, learning: { messages: [] } }
const base = { contact, memory: { facts: [], profile: { identity: { city: { status: 'unknown' } } } }, incoming: '最近晚上都在打三角洲', activeTopic: { summary: '三角洲游戏', sourceMessageIds: ['c'] }, momentum: { engagement: { level: 'HIGH' }, reciprocity: { questionsByMe: 0 } } }
const run = extra => buildNewFriendContext({ ...base, ...extra })
const fact = (field, value, extra = {}) => ({ field, value, evidence: `我${value}`, status: 'fact', sourceMessageIds: ['known'], ...extra })
const self = [{ key: 'gaming', value: ['三角洲'], shareLevel: 'OPEN' }]

test('new friend prioritizes continuity and emotional value above fact collection', () => {
  const result = run()
  assert.equal(result.preferences.conversationContinuity, 'very_high'); assert.equal(result.preferences.factCollection, 'low')
  assert.equal(result.socialGoal, 'BUILD_CONNECTION'); assert.equal(result.learning.allowNone, true)
})
test('good game topic never introduces an unrelated city question just because unknown', () => {
  const result = run()
  assert.ok(result.opportunities.some(item => item.type === 'CONTINUE_TOPIC' && item.score > 0.9))
  assert.ok(!result.opportunities.some(item => item.area === 'city'))
})
test('current game topic permits one optional reciprocal learning direction', () => {
  const result = run(), ask = result.opportunities.find(item => item.type === 'RECIPROCAL_ASK')
  assert.equal(ask.area, 'gamePreference'); assert.equal(ask.neverRequired, true)
  assert.equal(result.learning.priority, 'low')
})
test('real relevant self information creates disclosure and genuine common ground', () => {
  const result = run({ selfRelevantItems: self })
  assert.ok(result.opportunities.some(item => item.type === 'COMMON_GROUND' && item.basis === 'approved_self_fact'))
  assert.ok(result.opportunities.some(item => item.type === 'SELF_DISCLOSURE' && item.profileKey === 'gaming'))
})
test('running affinity offers attitude common ground without personal running achievements', () => {
  const result = run({ incoming: '我喜欢跑步', activeTopic: { summary: '跑步', sourceMessageIds: ['r'] }, personaLens: { adaptiveAffinities: [{ topic: 'running', factual: false }] } })
  const ground = result.opportunities.find(item => item.type === 'COMMON_GROUND')
  assert.equal(ground.basis, 'temporary_affinity'); assert.ok(ground.reason.includes('不声称'))
  assert.equal(result.hardGuards.noFabricatedExperience, true)
})
test('swimming and fitness offer related sports commonality without claiming running history', () => {
  const result = run({ incoming: '跑步很爽', activeTopic: { summary: '跑步', sourceMessageIds: ['r'] }, selfRelevantItems: [{ key: 'sports', value: ['健身', '游泳'], shareLevel: 'OPEN' }] })
  assert.ok(result.opportunities.some(item => item.type === 'COMMON_GROUND' && item.basis === 'related_approved_self_fact'))
})
test('contact asks grade and optional reciprocal question arises if grade unknown', () => {
  const result = run({ incoming: '你研几呀', activeTopic: { summary: '研究生日常' } })
  assert.ok(result.opportunities.some(item => item.type === 'RECIPROCAL_ASK' && item.area === 'grade'))
})
test('verified known grade prevents repetitive reciprocal grade question', () => {
  const result = run({ incoming: '你研几呀', activeTopic: { summary: '研究生日常' }, memory: { facts: [fact('grade', '研一')] } })
  assert.ok(!result.opportunities.some(item => item.type === 'RECIPROCAL_ASK' && item.area === 'grade'))
  assert.equal(result.knownIdentity.grade.value, '研一')
})
test('known city suppresses question while inference does not count as confirmed identity', () => {
  const known = run({ incoming: '你在哪个城市', activeTopic: { summary: '城市' }, memory: { facts: [fact('city', '广州')] } })
  const guessed = run({ incoming: '你在哪个城市', activeTopic: { summary: '城市' }, memory: { facts: [fact('city', '广州', { status: 'inference' })] } })
  assert.ok(!known.opportunities.some(item => item.area === 'city'))
  assert.ok(guessed.opportunities.some(item => item.area === 'city'))
})
test('already expressed gaming preference is not asked again', () => {
  const result = run({ memory: { facts: [fact('interest', '三角洲')] } })
  assert.ok(!result.opportunities.some(item => item.type === 'RECIPROCAL_ASK' && item.area === 'gamePreference'))
})
test('high question pressure favors disclosure while leaving final planner free', () => {
  const result = run({ selfRelevantItems: self, momentum: { engagement: { level: 'HIGH' }, reciprocity: { questionsByMe: 3 } } })
  const ask = result.opportunities.find(item => item.type === 'RECIPROCAL_ASK'), share = result.opportunities.find(item => item.type === 'SELF_DISCLOSURE')
  assert.ok(share.score > ask.score); assert.equal(result.action, undefined); assert.equal(result.shouldReply, undefined)
})
test('new contacts allow pure joking and no learning on every turn', () => {
  const result = run({ incoming: '哈哈哈哈笑死', activeTopic: null })
  assert.equal(result.preferences.meaninglessChat, 'allowed'); assert.equal(result.learning.allowNone, true)
  assert.ok(result.emotionalValue.cues.includes('light_playfulness'))
})
test('good news encourages emotional reaction without immediate fact interview', () => {
  const result = run({ incoming: '我今天终于把论文交了', activeTopic: { summary: '论文终于交了' } })
  assert.ok(result.emotionalValue.cues.includes('celebrate')); assert.equal(result.learning.optional, true)
  assert.ok(result.opportunities.find(item => item.type === 'CONTINUE_TOPIC').score > result.opportunities.find(item => item.type === 'RECIPROCAL_ASK').score)
})
test('negative complaints expose emotional empathy opportunity', () => {
  const result = run({ incoming: '加班累死了，真烦', activeTopic: { summary: '加班吐槽' } })
  assert.ok(result.emotionalValue.cues.includes('empathy_or_shared_complaint'))
})
test('friend mode increases daily video and callback preferences without separate planner', () => {
  const result = run({ contact: { ...contact, profile: { relationship: '大学舍友' } } })
  assert.equal(result.relationshipStage, 'FRIEND'); assert.equal(result.socialGoal, 'MAINTAIN_CONNECTION')
  for (const key of ['dailySharing', 'videoSharing', 'callback']) assert.equal(result.preferences[key], 'high')
})
test('explicit refusal protects scoped question but does not block unrelated playful opportunities', () => {
  const messages = [{ id: 'q', role: 'me', text: '你哪个城市呀？' }, { id: 'r', role: 'contact', text: '这个不想说，别问了' }]
  const result = run({ messages, incoming: '游戏可以聊哈哈' })
  assert.ok(result.refusedAreas.includes('city')); assert.ok(!result.explorationDirections.includes('city'))
  assert.ok(result.opportunities.some(item => item.type === 'CONTINUE_TOPIC'))
})
test('explicit stored refusal blocks reciprocal repeat despite current question cue', () => {
  const result = run({ incoming: '你什么专业', memory: { facts: [], learningHistory: [{ topic: 'major', result: 'refused' }] }, activeTopic: { summary: '专业' } })
  assert.ok(!result.opportunities.some(item => item.area === 'major')); assert.ok(result.refusedAreas.includes('major'))
})
test('mere delayed answer does not become permanent refusal hard guard', () => {
  const result = run({ incoming: '你在哪个城市', memory: { facts: [], learningHistory: [{ topic: 'city', result: 'pending' }] }, activeTopic: { summary: '城市' } })
  assert.deepEqual(result.refusedAreas, [])
})
test('private and unverified self info cannot enter self disclosure opportunities', () => {
  const result = run({ selfRelevantItems: [{ key: 'private_school', value: '秘密', shareLevel: 'PRIVATE' }, { key: 'fake_experience', value: '跑马', verified: false }] })
  assert.ok(!result.opportunities.some(item => item.type === 'SELF_DISCLOSURE'))
})
test('refusal to chat preserves silence guard and does not issue forced response action', () => {
  const result = run({ incoming: '不要联系，不用回复' })
  assert.equal(result.hardGuards.stopConversation, true); assert.equal(result.hardGuards.preserveNoReply, true)
  assert.equal(result.action, undefined)
})
test('new friend context is pure and never promotes affinity into memory', () => {
  const input = { ...base, selfRelevantItems: self, personaLens: { adaptiveAffinities: [{ topic: 'running', factual: false }] } }
  const before = structuredClone(input); buildNewFriendContext(input); assert.deepEqual(input, before)
})
test('known hometown does not falsely imply current city is already known', () => {
  const result = run({ incoming: '你在哪个城市', activeTopic: { summary: '城市' }, memory: { facts: [fact('province', '福建')] } })
  assert.ok(result.knownAreas.includes('hometown')); assert.ok(!result.knownAreas.includes('city'))
  assert.ok(result.opportunities.some(item => item.area === 'city'))
})
