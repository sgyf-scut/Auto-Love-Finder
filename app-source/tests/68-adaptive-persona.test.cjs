const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildPersonaLens } = require('../electron/social-brain/persona-lens.cjs')
const { buildRelationshipState, normalizeRelationshipState, DIMENSIONS, MAX_STEP, DAILY_LIMIT } = require('../electron/social-brain/relationship-state.cjs')
const now = Date.parse('2026-10-13T12:00:00+08:00')
const contact = (id = 'a', relation = '新朋友') => ({ id, name: id, profile: { relationship: relation }, learning: { messages: [] } })
const row = (id, role, text, extra = {}) => ({ id, role, text, at: new Date(now - 60000).toISOString(), ...extra })
const fact = (value, id = 'i', extra = {}) => ({ field: 'interest', value, status: 'fact', evidence: `我喜欢${value}`, sourceMessageIds: [id], ...extra })
const lens = (value, extra = {}) => buildPersonaLens({ contact: contact(), memory: { facts: [fact(value)] }, now, ...extra })

test('adaptive lens emphasizes verified gaming interest', () => {
  const result = lens('三角洲和英雄联盟')
  assert.ok(result.emphasis.includes('gaming')); assert.equal(result.kind, 'ADAPTIVE_PERSONA')
  assert.equal(result.adaptiveAffinities[0].factual, false)
})
test('running affinity is temporary and never becomes factual personal experience', () => {
  const result = lens('跑步')
  assert.equal(result.adaptiveAffinities[0].topic, 'running')
  assert.equal(result.adaptiveAffinities[0].kind, 'TEMPORARY_AFFINITY')
  assert.equal(result.adaptiveAffinities[0].mayCreateExperience, false)
  assert.equal(result.constraints.neverPromoteAffinityToFact, true)
})
test('lens separates genuine shared gaming from adaptive interest', () => {
  const result = lens('三角洲', { selfRelevantItems: [{ key: 'gaming', value: ['三角洲'], shareLevel: 'OPEN' }] })
  assert.equal(result.adaptiveAffinities[0].realCommonInterest, true)
})
test('private self interests cannot create factual common ground', () => {
  const result = lens('三角洲', { selfRelevantItems: [{ key: 'gaming', value: '三角洲', shareLevel: 'PRIVATE' }] })
  assert.equal(result.adaptiveAffinities[0].realCommonInterest, false)
})
test('contact inference or evidence-free fact cannot drive persona lens', () => {
  const result = lens('', { memory: { facts: [fact('跑步', 'i', { status: 'inference' }), fact('游戏', 'j', { evidence: '' }), fact('旅游', 'k', { sourceMessageIds: [] })] } })
  assert.deepEqual(result.emphasis, [])
})
test('avatar, public summary and draft alone never imply contact interests', () => {
  const c = contact(); c.avatar = 'running.jpg'; c.profile.personality = '爱跑步'; c.learning.generatedReply = '我喜欢跑步'
  const result = buildPersonaLens({ contact: c, now })
  assert.deepEqual(result.emphasis, [])
})
test('facts bound to another contact never influence lens', () => {
  assert.deepEqual(lens('跑步', { memory: { facts: [fact('跑步', 'i', { contactId: 'other' })] } }).emphasis, [])
})
test('active topic requires real message identity before affecting lens', () => {
  const result = lens('', { memory: { facts: [] }, activeTopic: { summary: '旅游', sourceMessageIds: ['invented'] } })
  assert.deepEqual(result.emphasis, [])
})
test('grounded current focus can emphasize travel without known stable interest', () => {
  const result = lens('', { memory: { facts: [] }, messages: [row('t', 'contact', '新疆风景好看')], selectedFocus: { messageId: 't', summary: '新疆风景' } })
  assert.ok(result.emphasis.includes('travel')); assert.equal(result.adaptiveAffinities[0].factual, false)
})
test('successful bilateral topic is available but generated topic cannot manufacture success', () => {
  const messages = [row('m', 'me', '这个游戏好玩'), row('c', 'contact', '我也喜欢这个游戏哈哈')]
  const good = lens('', { memory: { facts: [] }, messages, conversationState: { topicTree: [{ summary: '游戏', sourceMessageIds: ['m', 'c'] }] } })
  const bad = lens('', { memory: { facts: [] }, messages, conversationState: { topicTree: [{ summary: '跑步', sourceMessageIds: ['generated'] }] } })
  assert.ok(good.emphasis.includes('gaming')); assert.ok(!bad.emphasis.includes('running')); assert.deepEqual(bad.adaptiveAffinities, [])
})
test('different contacts produce independent gaming and sports facets', () => {
  const a = lens('游戏', { contact: contact('a') }), b = lens('健身', { contact: contact('b') })
  assert.notDeepEqual(a.emphasis, b.emphasis); assert.equal(a.contactId, 'a'); assert.equal(b.contactId, 'b')
})
test('quiet short replies reduce energy, humor and curiosity', () => {
  const quiet = lens('游戏', { messages: [row('q1', 'contact', '嗯'), row('q2', 'contact', '行')] })
  const lively = lens('游戏', { messages: [row('l1', 'contact', '哈哈哈这个真的笑死我了！！'), row('l2', 'contact', '我也觉得离谱哈哈！！')], momentum: { engagement: { level: 'HIGH' } } })
  for (const key of ['energy', 'humor', 'curiosity']) assert.ok(quiet.style[key] < lively.style[key])
})
test('new friends have bounded playfulness while old friends permit more', () => {
  const extra = { messages: [row('l1', 'contact', '哈哈哈笑死我了')], relationshipState: { playfulness: 0.9 } }
  const fresh = lens('游戏', extra), old = lens('游戏', { ...extra, contact: contact('a', '大学舍友') })
  assert.ok(fresh.style.playfulness <= 0.45); assert.ok(fresh.style.humor <= 0.55)
  assert.ok(old.style.playfulness > fresh.style.playfulness)
})
test('old unrelated persona affinity is not retained without current evidence', () => {
  const result = lens('游戏', { previousLens: { contactId: 'a', adaptiveAffinities: [{ topic: 'running', strength: 0.9 }] } })
  assert.ok(!result.emphasis.includes('running'))
})
test('an affinity change is bounded for the same contact and independent from others', () => {
  const previousLens = { contactId: 'a', adaptiveAffinities: [{ topic: 'gaming', strength: 0.2 }] }
  assert.equal(lens('游戏', { previousLens }).adaptiveAffinities[0].strength, 0.28)
  assert.equal(lens('游戏', { previousLens: { ...previousLens, contactId: 'b' } }).adaptiveAffinities[0].strength, 0.72)
})
test('persona lens is pure and does not rewrite self or contact factual memory', () => {
  const input = { contact: contact(), memory: { facts: [fact('跑步')] }, selfProfileRelevant: [{ key: 'sports', value: ['游泳'], shareLevel: 'OPEN' }], now }
  const before = structuredClone(input); buildPersonaLens(input); assert.deepEqual(input, before)
})
test('six relationship dimensions are bounded numeric values with no auto stage upgrade', () => {
  const result = normalizeRelationshipState({ warmth: 9, trust: -1, curiosity: 'bad' }, { contact: contact(), now })
  for (const key of DIMENSIONS) assert.ok(result[key] >= 0 && result[key] <= 1)
  assert.equal(result.flirt, 0); assert.equal(result.automaticStageUpgrade, false)
})
test('real positive bilateral exchange slowly updates relationship state', () => {
  const c = contact(), base = normalizeRelationshipState(null, { contact: c, now })
  const result = buildRelationshipState({ contact: c, previousState: base, messages: [row('m', 'me', '今天咋样'), row('c', 'contact', '我终于交了论文哈哈')], now })
  assert.ok(result.warmth > base.warmth); assert.ok(result.familiarity > base.familiarity)
  for (const key of DIMENSIONS) assert.ok(Math.abs(result[key] - base[key]) <= MAX_STEP + 0.0001)
})
test('duplicate source IDs cannot repeatedly increase relationship state', () => {
  const input = { contact: contact(), messages: [row('m', 'me', '今天咋样'), row('c', 'contact', '我今天开心哈哈')], now }
  const first = buildRelationshipState(input), second = buildRelationshipState({ ...input, previousState: first })
  assert.deepEqual(second, first)
})
test('drafts and model-generated output cannot increase relationship state', () => {
  const input = { contact: contact(), messages: [row('m', 'me', '哈哈', { source: 'writer' }), row('c', 'contact', '我今天开心', { isDraft: true })], now }
  const result = buildRelationshipState(input)
  assert.deepEqual(result.processedMessageIds, []); assert.equal(result.familiarity, 0.15)
})
test('unilateral owner spam cannot raise warmth or familiarity', () => {
  const result = buildRelationshipState({ contact: contact(), messages: [row('m1', 'me', '哈哈'), row('m2', 'me', '问你呢')], momentum: { engagement: { level: 'HIGH' } }, now })
  assert.equal(result.warmth, 0.5); assert.equal(result.familiarity, 0.15)
})
test('daily relationship movement is rate limited across many novel messages', () => {
  const c = contact(), base = normalizeRelationshipState(null, { contact: c, now }); let state = base
  for (let index = 0; index < 100; index++) state = buildRelationshipState({ contact: c, previousState: state, messages: [row(`m${index}`, 'me', '哈哈'), row(`c${index}`, 'contact', '哈哈我很开心')], now: now + index * 1000 })
  assert.ok(state.warmth - base.warmth <= DAILY_LIMIT + 0.0001)
  assert.equal(state.flirt, 0)
})
test('new day permits only a fresh bounded step without changing relationship stage', () => {
  const c = contact(), state = normalizeRelationshipState({ updateBudget: { day: '2026-10-13', used: DAILY_LIMIT } }, { contact: c, now })
  const same = buildRelationshipState({ contact: c, previousState: state, messages: [row('m', 'me', '哈哈'), row('c', 'contact', '哈哈开心')], now })
  const next = buildRelationshipState({ contact: c, previousState: same, messages: [row('m2', 'me', '哈哈'), row('c2', 'contact', '哈哈开心')], now: now + 86400000 })
  assert.equal(same.warmth, state.warmth); assert.ok(next.warmth > same.warmth); assert.equal(next.automaticStageUpgrade, false)
})
test('explicit rejection lowers interaction tendencies without romantic inference', () => {
  const result = buildRelationshipState({ contact: contact(), messages: [row('m', 'me', '喜欢我吗'), row('c', 'contact', '不想聊，别问了')], now })
  assert.ok(result.warmth < 0.5); assert.equal(result.flirt, 0)
})
test('quoted disclosure and avatar cannot establish trust or automatic flirt', () => {
  const c = contact(); c.avatar = 'girl.jpg'
  const result = buildRelationshipState({ contact: c, messages: [row('m', 'me', '看到了'), row('c', 'contact', '我非常信任你', { quote: { text: '我非常信任你' } })], now })
  assert.equal(result.trust, 0.15); assert.equal(result.flirt, 0)
})
test('state belonging to a different contact is discarded', () => {
  assert.equal(normalizeRelationshipState({ contactId: 'other', warmth: 1, familiarity: 1 }, { contact: contact(), now }).familiarity, 0.15)
})
test('actual rows bind contact IDs and future messages do not create evidence', () => {
  const result = buildRelationshipState({ contact: contact(), messages: [row('wrong', 'contact', '哈哈', { contactId: 'other' }), row('future', 'contact', '哈哈', { at: new Date(now + 3600000).toISOString() })], now })
  assert.deepEqual(result.processedMessageIds, [])
})
test('relationship state rejects invalid time instead of silently persisting bad dates', () => {
  assert.throws(() => buildRelationshipState({ contact: contact(), now: 'invalid' }), /valid timestamp/)
})
test('confirmed sent AI message participates in real bilateral interaction while unsent draft does not', () => {
  const messages = [row('sent', 'me', '今天咋样', { source: 'ai_draft', status: 'sent' }), row('pending', 'me', '第二条草稿', { source: 'ai_draft' }), row('reply', 'contact', '哈哈我很开心')]
  const result = buildRelationshipState({ contact: contact(), messages, now })
  assert.ok(result.familiarity > 0.15); assert.ok(result.processedMessageIds.includes('sent')); assert.ok(!result.processedMessageIds.includes('pending'))
})
test('null or empty corrupted relationship metrics use defaults instead of zero', () => {
  const result = normalizeRelationshipState({ curiosity: null, warmth: '' }, { contact: contact(), now })
  assert.equal(result.curiosity, 0.65); assert.equal(result.warmth, 0.5)
})
