const { test } = require('node:test')
const assert = require('node:assert/strict')
const { JOURNEY_STAGES, EVIDENCE_TYPES, normalizeJourney, buildRelationshipJourney, evaluateRelationshipJourney, relationshipEvidenceSummary, isMatureStage } = require('../electron/social-brain/relationship-journey.cjs')
const at = (d = 1, minute = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(minute).padStart(2, '0')}:00+08:00`
const contact = (id = 'a', extra = {}) => ({ id, name: '同名联系人', profile: {}, ...extra })
const row = (id, role, text, d = 1, minute = 0, extra = {}) => ({ id, role, text, at: at(d, minute), contactId: 'a', ...extra })
const exchanges = d => [row(`m${d}`, 'me', d === 1 ? '我喜欢三角洲游戏' : '我昨天又玩了三角洲游戏哈哈', d, 1), row(`c${d}`, 'contact', d === 1 ? '我也喜欢三角洲游戏哈哈' : '上次你聊的三角洲游戏我又玩了哈哈', d, 2)]
function build(messages = exchanges(1), saved, d = 1, extra = {}) { return buildRelationshipJourney({ contact: contact('a', { relationshipJourney: saved }), messages, now: Date.parse(at(d, 10)), ...extra }) }
function evaluator(target, extra = {}, inspect) {
  return async prompts => {
    const payload = JSON.parse(prompts[1].content)
    inspect?.(payload, prompts)
    return { text: JSON.stringify({ currentStage: payload.currentStage, suggestedStage: target, confidence: 0.91, reasons: ['双向共同交流带来更自然的熟悉感'], evidenceIds: payload.relationshipEvidence.map(item => item.id), ...extra }) }
  }
}
const evaluate = (journey, messages, target, d = 1, extra = {}) => evaluateRelationshipJourney(evaluator(target, extra), { contact: contact(), journey, messages, now: Date.parse(at(d, 10)) })

test('six fixed stages describe context without numeric level or points', () => {
  assert.deepEqual(JOURNEY_STAGES, ['STRANGER', 'EXPLORING', 'ACQUAINTANCE', 'FAMILIAR', 'FRIEND', 'CLOSE_FRIEND'])
  assert.equal(Object.hasOwn(normalizeJourney(contact()), 'score'), false)
  assert.equal(EVIDENCE_TYPES.length, 10)
})
test('first contact and default old contact remain stranger', () => {
  for (const value of [contact(), contact('a', { profile: { chatMode: 'friend' } }), contact('a', { profile: { relationship: '普通联系人' } })]) assert.equal(normalizeJourney(value).currentStage, 'STRANGER')
})
test('explicit legacy old friend and longstanding relationship migrate friend', () => {
  for (const profile of [{ chatMode: 'oldfriend' }, { chatMode: 'old_friend' }, { relationship: '大学舍友' }, { relationship: '多年好朋友' }]) assert.equal(normalizeJourney(contact('a', { profile })).currentStage, 'FRIEND')
})
test('explicit stranger description overrides old friend legacy guess', () => assert.equal(normalizeJourney(contact('a', { profile: { chatMode: 'oldfriend', relationship: '刚认识的新朋友' } })).currentStage, 'STRANGER'))
test('normalization preserves stage date and current stage instead of using current chat mode', () => {
  const saved = { ...normalizeJourney(contact(), { now: Date.parse(at()) }), currentStage: 'ACQUAINTANCE' }
  const result = normalizeJourney(contact('a', { relationshipJourney: saved, profile: { chatMode: 'oldfriend' } }), { now: Date.parse(at(9)) })
  assert.equal(result.currentStage, 'ACQUAINTANCE'); assert.equal(result.stageSince, new Date(at()).toISOString())
})
test('foreign journey cannot import stage or evidence even for same display name', () => {
  const saved = { ...build(), currentStage: 'FRIEND' }
  const result = normalizeJourney(contact('b', { relationshipJourney: saved }))
  assert.equal(result.currentStage, 'STRANGER'); assert.deepEqual(result.relationshipEvidence, [])
})
test('relabelled foreign evidence fails contact-bound source fingerprint', () => {
  const saved = build(), swapped = { ...saved, contactId: 'b', relationshipEvidence: saved.relationshipEvidence.map(item => ({ ...item, contactId: 'b', sourceContactId: 'b' })) }
  assert.equal(normalizeJourney(contact('b', { relationshipJourney: swapped })).relationshipEvidence.length, 0)
})
test('invalid stages and out of range confidence cannot corrupt persisted context', () => {
  const saved = { ...normalizeJourney(contact()), currentStage: 'SOULMATE', confidence: 9, stageSince: 'invalid', stageHistory: [{ fromStage: 'STRANGER', toStage: 'FRIEND', timestamp: at() }] }
  const result = normalizeJourney(contact('a', { relationshipJourney: saved }))
  assert.equal(result.currentStage, 'STRANGER'); assert.equal(result.confidence, 1); assert.deepEqual(result.stageHistory, [])
})
test('pure builder records real evidence but never changes stage', () => {
  const result = build([...exchanges(1), ...exchanges(2)], undefined, 2)
  assert.equal(result.currentStage, 'STRANGER'); assert.deepEqual(result.stageHistory, [])
  assert.ok(result.relationshipEvidence.some(item => item.type === 'MUTUAL_DISCLOSURE'))
  assert.ok(result.relationshipEvidence.some(item => item.type === 'COMMON_GROUND'))
})
test('lots of arbitrary chat has no automatic friend upgrade', async () => {
  const messages = Array.from({ length: 220 }, (_, i) => row(`a${i}`, i % 2 ? 'contact' : 'me', '嗯', 1))
  const journey = build(messages)
  let calls = 0
  const result = await evaluateRelationshipJourney(async () => { calls++; throw new Error('unexpected') }, { contact: contact(), journey, messages, now: Date.parse(at(1, 10)) })
  assert.equal(result.journey.currentStage, 'STRANGER'); assert.equal(calls, 0)
})
test('hello and one sided interview skip extra model evaluation', async () => {
  for (const messages of [[row('hello', 'contact', '你好')], [row('q', 'me', '你喜欢什么游戏？'), row('a', 'contact', '三角洲')], [row('q1', 'me', '你在哪？'), row('q2', 'me', '你研几？')]]) {
    let calls = 0
    const result = await evaluateRelationshipJourney(async () => { calls++ }, { contact: contact(), journey: build(messages), messages, now: Date.parse(at(1, 10)) })
    assert.equal(result.evaluated, false); assert.equal(calls, 0); assert.equal(result.journey.currentStage, 'STRANGER')
  }
})
test('high engagement alone cannot trigger evaluation or jump stage', async () => {
  const result = await evaluateRelationshipJourney(evaluator('FRIEND'), { contact: contact(), messages: [row('h', 'contact', '哈哈哈哈')], momentum: { engagement: { level: 'HIGH' } }, now: Date.parse(at(1, 10)) })
  assert.equal(result.journey.currentStage, 'STRANGER'); assert.equal(result.evaluated, false)
})
test('bilateral sharing can support model proposed exploring', async () => {
  const result = await evaluate(build(), exchanges(1), 'EXPLORING')
  assert.equal(result.journey.currentStage, 'EXPLORING'); assert.equal(result.changed, true); assert.equal(result.journey.previousStage, 'STRANGER')
  assert.equal(result.journey.stageHistory[0].fromStage, 'STRANGER'); assert.equal(result.journey.stageHistory[0].toStage, 'EXPLORING')
})
test('model stranger to close friend request changes at most one stage', async () => {
  const result = await evaluate(build(), exchanges(1), 'CLOSE_FRIEND')
  assert.equal(result.journey.currentStage, 'EXPLORING'); assert.equal(result.journey.suggestedStage, 'EXPLORING')
})
test('no provided evidence references keeps stage while displaying adjacent suggestion', async () => {
  const result = await evaluate(build(), exchanges(1), 'FRIEND', 1, { evidenceIds: [] })
  assert.equal(result.changed, false); assert.equal(result.journey.currentStage, 'STRANGER'); assert.equal(result.journey.suggestedStage, 'EXPLORING')
})
test('low confidence remains observation instead of promotion', async () => {
  const result = await evaluate(build(), exchanges(1), 'EXPLORING', 1, { confidence: 0.3 })
  assert.equal(result.journey.currentStage, 'STRANGER'); assert.equal(result.journey.confidence, 0.3)
})
test('model cannot overwrite currentStage with its invented starting point', async () => {
  const result = await evaluate(build(), exchanges(1), 'FRIEND', 1, { currentStage: 'FAMILIAR' })
  assert.equal(result.journey.currentStage, 'STRANGER'); assert.match(result.journey.reasons.join(' '), /已保存阶段/)
})
test('assessment prompt distinguishes saved current stage from proposed stage', async () => {
  await evaluateRelationshipJourney(evaluator('EXPLORING', {}, (payload, prompts) => {
    assert.equal(payload.currentStage, 'STRANGER')
    assert.match(prompts[0].content, /currentStage必须原样复制输入中已保存的currentStage/)
    assert.match(prompts[0].content, /现阶段是否仍合理写在reasons中/)
    assert.match(prompts[0].content, /任何升级或降级建议只能写在suggestedStage中/)
  }), { contact: contact(), journey: build(), messages: exchanges(1), now: Date.parse(at(1, 10)) })
})
test('invalid json, invalid stage, and foreign evidence are explicit errors', async () => {
  const input = { contact: contact(), journey: build(), messages: exchanges(1), now: Date.parse(at(1, 10)) }
  await assert.rejects(evaluateRelationshipJourney(async () => ({ text: 'not JSON' }), input), /JSON/)
  await assert.rejects(evaluateRelationshipJourney(evaluator('ROMANTIC'), input), /字段无效/)
  await assert.rejects(evaluateRelationshipJourney(evaluator('FRIEND', { evidenceIds: ['foreign-id'] }), input), /未知或其他联系人/)
})
test('completion errors propagate without silently treating them as successful evaluation', async () => {
  await assert.rejects(evaluateRelationshipJourney(async () => { throw new Error('provider unavailable') }, { contact: contact(), journey: build(), messages: exchanges(1), now: Date.parse(at(1, 10)) }), /provider unavailable/)
})
test('newly imported older verified evidence is assessed once rather than dropped by evaluatedAt', async () => {
  const first = await evaluate(build(), exchanges(1), 'STRANGER', 10)
  const messages = [...exchanges(1), row('olderm', 'me', '我喜欢火锅美食', 2), row('olderc', 'contact', '我也喜欢火锅美食', 2, 1)]
  const result = await evaluate(build(messages, first.journey, 10), messages, 'EXPLORING', 10)
  assert.equal(result.evaluated, true); assert.equal(result.journey.currentStage, 'EXPLORING')
})
test('reprocessing the same real messages has no repeated evidence or model call', async () => {
  const first = await evaluate(build(), exchanges(1), 'EXPLORING')
  const rebuilt = build(exchanges(1), first.journey)
  assert.equal(rebuilt.relationshipEvidence.length, first.journey.relationshipEvidence.length)
  let calls = 0
  const result = await evaluateRelationshipJourney(async () => { calls++ }, { contact: contact(), journey: rebuilt, messages: exchanges(1), now: Date.parse(at(1, 15)) })
  assert.equal(calls, 0); assert.equal(result.evaluated, false); assert.equal(result.journey.stageHistory.length, 1)
})
test('new same day exchanges cannot rapidly move exploring to familiar', async () => {
  const first = await evaluate(build(), exchanges(1), 'EXPLORING')
  const messages = [...exchanges(1), row('laterme', 'me', '我也喜欢火锅美食', 1, 20), row('laterc', 'contact', '我今天吃了火锅美食', 1, 21)]
  const journey = build(messages, first.journey, 1, { now: Date.parse(at(1, 25)) })
  const result = await evaluateRelationshipJourney(evaluator('FAMILIAR'), { contact: contact(), journey, messages, now: Date.parse(at(1, 25)) })
  assert.equal(result.journey.currentStage, 'EXPLORING'); assert.match(result.journey.reasons.join(' '), /跨日/)
})
test('multi day actual shared topic and callbacks progress gradually to friend', async () => {
  let journey, messages = []
  const seen = []
  for (let d = 1; d <= 4; d++) {
    messages.push(...exchanges(d)); journey = build(messages, journey, d)
    const result = await evaluate(journey, messages, JOURNEY_STAGES[d], d); journey = result.journey; seen.push(journey.currentStage)
  }
  assert.deepEqual(seen, ['EXPLORING', 'ACQUAINTANCE', 'FAMILIAR', 'FRIEND'])
  assert.equal(journey.stageHistory.length, 4); assert.equal(isMatureStage(journey.currentStage), true)
})
test('model may keep acquaintance across many high quality days', async () => {
  let journey = { ...normalizeJourney(contact(), { now: Date.parse(at()) }), currentStage: 'ACQUAINTANCE' }
  const messages = [...exchanges(1), ...exchanges(2), ...exchanges(3)]
  journey = (await evaluate(build(messages, journey, 3), messages, 'ACQUAINTANCE', 3)).journey
  assert.equal(journey.currentStage, 'ACQUAINTANCE'); assert.deepEqual(journey.stageHistory, [])
})
test('stage transition does not require gathering specific trophy evidence types', async () => {
  const messages = [row('m1', 'me', '我喜欢三角洲游戏'), row('c1', 'contact', '我也喜欢三角洲游戏', 1, 1), row('m2', 'me', '我最近喜欢火锅美食', 2), row('c2', 'contact', '我也喜欢火锅美食', 2, 1), row('m3', 'me', '我在听电音音乐', 3), row('c3', 'contact', '我也喜欢电音音乐', 3, 1)]
  const saved = { ...normalizeJourney(contact(), { now: Date.parse(at()) }), currentStage: 'FAMILIAR' }
  const journey = build(messages, saved, 3)
  assert.ok(!journey.relationshipEvidence.some(item => item.type === 'MUTUAL_INITIATION'))
  assert.equal((await evaluate(journey, messages, 'FRIEND', 3)).journey.currentStage, 'FRIEND')
})
test('cold responses do not mechanically continue relationship upgrade', async () => {
  const messages = [...exchanges(1), row('cold1', 'contact', '嗯', 2), row('cold2', 'contact', '不知道', 3), row('cold3', 'contact', '没什么', 4), row('me', 'me', '我最近喜欢咖啡美食', 4, 1)]
  const journey = build(messages, undefined, 4)
  const result = await evaluate(journey, messages, 'EXPLORING', 4)
  assert.equal(result.journey.currentStage, 'STRANGER')
})
test('single anomalous response does not downgrade established relationship', async () => {
  const saved = { ...build(exchanges(1)), currentStage: 'FRIEND' }
  const messages = [...exchanges(1), ...exchanges(2), row('bad', 'contact', '不聊了', 2, 5)]
  const result = await evaluate(build(messages, saved, 2), messages, 'STRANGER', 2)
  assert.equal(result.journey.currentStage, 'FRIEND'); assert.equal(result.changed, false)
})
test('sustained cross day cooling can downgrade once and only adjacent stage', async () => {
  const saved = { ...normalizeJourney(contact(), { now: Date.parse(at()) }), currentStage: 'FRIEND' }
  const messages = [1, 5, 10].flatMap(d => [row(`mq${d}`, 'me', '最近忙什么呀？', d), row(`cc${d}`, 'contact', '嗯', d, 1)])
  const journey = build(messages, saved, 10)
  const result = await evaluate(journey, messages, 'STRANGER', 10)
  assert.equal(result.journey.currentStage, 'FAMILIAR'); assert.equal(result.changed, true)
})
test('positive interaction resets cooling run instead of inheriting old cold days', async () => {
  const saved = { ...normalizeJourney(contact(), { now: Date.parse(at()) }), currentStage: 'FRIEND' }
  const messages = [1, 5, 10].flatMap(d => [row(`mq${d}`, 'me', '最近忙什么呀？', d), row(`cc${d}`, 'contact', '嗯', d, 1)])
  messages.push(...exchanges(11), row('bad1', 'contact', '嗯', 12), row('bad2', 'contact', '嗯', 12, 1), row('bad3', 'contact', '嗯', 12, 2))
  const result = await evaluate(build(messages, saved, 12), messages, 'STRANGER', 12)
  assert.equal(result.journey.currentStage, 'FRIEND')
})
test('callback needs actual earlier bilateral topic and a current response', () => {
  const messages = [...exchanges(1), row('callback', 'contact', '上次三角洲游戏我又玩了', 2), row('cbresponse', 'me', '我昨晚也玩游戏了', 2, 1)]
  assert.ok(build(messages, undefined, 2).relationshipEvidence.some(item => item.type === 'CALLBACK'))
  assert.ok(!build(messages.slice(2), undefined, 2).relationshipEvidence.some(item => item.type === 'CALLBACK'))
})
test('future plans never count as actual shared moment', () => {
  const planned = [row('m', 'me', '我们以后一起去吃火锅'), row('c', 'contact', '我们明天去吃火锅', 1, 1)]
  assert.ok(!build(planned).relationshipEvidence.some(item => item.type === 'SHARED_MOMENT'))
})
test('matching recalled shared activity records shared moment without inventing details', () => {
  const messages = [row('m', 'me', '我们昨天去吃火锅哈哈'), row('c', 'contact', '我们昨天吃火锅太爽了哈哈', 1, 1)]
  const evidence = build(messages).relationshipEvidence.find(item => item.type === 'SHARED_MOMENT')
  assert.ok(evidence); assert.deepEqual(evidence.sourceMessageIds, ['m', 'c'])
})
test('different independently mentioned activities cannot invent shared moment', () => {
  const messages = [row('m', 'me', '我们昨天去吃火锅'), row('c', 'contact', '我们昨天玩三角洲游戏', 1, 1)]
  assert.ok(!build(messages).relationshipEvidence.some(item => item.type === 'SHARED_MOMENT'))
})
test('support, trust and explicit inside joke have linked bilateral provenance', () => {
  const messages = [row('a', 'contact', '我最近论文焦虑，跟你说我放心'), row('b', 'me', '我在，慢慢来，放心听你说', 1, 1), row('c', 'contact', '又是那个老梗哈哈', 1, 2), row('d', 'me', '哈哈这个老梗', 1, 3)]
  const types = build(messages).relationshipEvidence.map(item => item.type)
  for (const type of ['EMOTIONAL_SUPPORT', 'TRUST_SIGNAL', 'INSIDE_JOKE', 'PLAYFUL_INTERACTION']) assert.ok(types.includes(type), type)
})
test('mutual initiation needs actual differing initiators across sessions', () => {
  const messages = [...exchanges(1), row('ic', 'contact', '我最近爱听电音音乐', 2), row('im', 'me', '我也喜欢电音音乐', 2, 1)]
  assert.ok(build(messages, undefined, 2).relationshipEvidence.some(item => item.type === 'MUTUAL_INITIATION'))
  assert.ok(!build([...exchanges(1), ...exchanges(2)], undefined, 2).relationshipEvidence.some(item => item.type === 'MUTUAL_INITIATION'))
})
test('all evidence types are observed with explicit source records', () => {
  const messages = [...exchanges(1), row('ic', 'contact', '上次三角洲游戏我又玩了', 2), row('im', 'me', '我又玩游戏了哈哈', 2, 1), row('sharedm', 'me', '我们昨天去吃火锅哈哈', 2, 2), row('sharedc', 'contact', '我们昨天吃火锅太爽了哈哈', 2, 3), row('sad', 'contact', '我最近论文焦虑，只跟你说', 2, 4), row('sup', 'me', '我在慢慢来放心听你说', 2, 5), row('jc', 'contact', '又是那个老梗哈哈', 2, 6), row('jm', 'me', '哈哈这个老梗', 2, 7)]
  const evidence = build(messages, undefined, 2).relationshipEvidence
  assert.deepEqual([...new Set(evidence.map(item => item.type))].sort(), [...EVIDENCE_TYPES].sort())
  for (const item of evidence) { assert.equal(item.contactId, 'a'); assert.ok(item.sourceMessageIds.every(id => messages.some(row => row.id === id))); assert.ok(Number.isFinite(Date.parse(item.timestamp))) }
})
test('drafts failed outgoing foreign contacts quotes media and OCR cannot produce evidence', () => {
  for (const extra of [{ draft: true }, { status: 'failed' }, { source: 'writer' }, { contactId: 'b' }, { quote: { text: 'quoted' } }, { textSource: 'ocr' }, { kind: 'image' }, { source: 'public_profile' }]) {
    const messages = [row('m', 'me', '我喜欢三角洲游戏'), row('c', 'contact', '我也喜欢三角洲游戏', 1, 1, extra)]
    assert.equal(build(messages).relationshipEvidence.length, 0, JSON.stringify(extra))
  }
})
test('future and undated messages cannot manufacture cross day continuity', () => {
  assert.equal(build([row('m', 'me', '我喜欢游戏', 9), row('c', 'contact', '我也喜欢游戏', 9, 1)]).relationshipEvidence.length, 0)
  assert.equal(build(exchanges(1).map(row => ({ ...row, at: null }))).relationshipEvidence.length, 0)
})
test('archived own verified evidence survives bounded message history', () => {
  const saved = build()
  const rebuilt = build([row('new', 'contact', '今天没什么事', 2)], saved, 2)
  assert.ok(rebuilt.relationshipEvidence.some(item => item.id === saved.relationshipEvidence[0].id))
})
test('visible source changed to foreign or draft invalidates its stored evidence', () => {
  const saved = build()
  const messages = exchanges(1).map(value => value.role === 'contact' ? { ...value, contactId: 'b' } : value)
  assert.equal(build(messages, saved).relationshipEvidence.length, 0)
})
test('building one contact cannot mutate another or original inputs', () => {
  const saved = build(), snapshot = JSON.stringify(saved), rows = exchanges(1), rowSnapshot = JSON.stringify(rows)
  build(rows, saved); assert.equal(JSON.stringify(saved), snapshot); assert.equal(JSON.stringify(rows), rowSnapshot)
  const b = buildRelationshipJourney({ contact: contact('b'), messages: rows, now: Date.parse(at(1, 10)) })
  assert.equal(b.currentStage, 'STRANGER'); assert.deepEqual(b.relationshipEvidence, [])
})
test('evaluation receives only current contact safe facts and matching lens/state', async () => {
  let payload
  await evaluateRelationshipJourney(evaluator('STRANGER', {}, value => { payload = value }), { contact: contact(), journey: build(), messages: exchanges(1), now: Date.parse(at(1, 10)),
    relationshipState: { contactId: 'b', warmth: 1 }, personaLens: { contactId: 'b', emphasis: ['foreignprivate'], style: { humor: 1 } },
    memory: { facts: [{ status: 'fact', contactId: 'b', field: 'secret', value: 'other contact', sourceMessageIds: ['c1'] }] }, selfProfile: { privateCanary: 'never-in-prompt' } })
  assert.deepEqual(payload.relationshipState, {}); assert.deepEqual(payload.personaLens.emphasis, []); assert.deepEqual(payload.contactMemory, [])
  assert.ok(!JSON.stringify(payload).includes('never-in-prompt')); assert.ok(!JSON.stringify(payload).includes('other contact'))
})
test('raw phone secret is masked in model evaluation context', async () => {
  const messages = [...exchanges(1), row('secret', 'contact', '我的手机号13812345678', 1, 3)]
  let payload
  await evaluateRelationshipJourney(evaluator('STRANGER', {}, value => { payload = value }), { contact: contact(), journey: build(messages), messages, now: Date.parse(at(1, 10)) })
  assert.ok(!JSON.stringify(payload).includes('13812345678'))
})
test('history and evidence are bounded without carrying whole private messages', () => {
  const messages = Array.from({ length: 30 }, (_, i) => exchanges(i + 1)).flat()
  const result = build(messages, undefined, 30)
  assert.ok(result.relationshipEvidence.length <= 80); assert.ok(relationshipEvidenceSummary(result).length <= 12)
  assert.ok(result.relationshipEvidence.every(item => !Object.hasOwn(item, 'rawMessage')))
})
test('journey is serializable and mature strategy includes only friend and close friend', () => {
  const value = build()
  assert.deepEqual(normalizeJourney(contact('a', { relationshipJourney: JSON.parse(JSON.stringify(value)) }), { now: Date.parse(at(1, 10)) }), value)
  assert.equal(isMatureStage('FRIEND'), true); assert.equal(isMatureStage('CLOSE_FRIEND'), true); assert.equal(isMatureStage('FAMILIAR'), false)
})
