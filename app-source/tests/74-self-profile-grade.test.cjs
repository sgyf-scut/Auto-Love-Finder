const { test } = require('node:test')
const assert = require('node:assert/strict')
const { IDENTITY_FIELDS, emptyMemory, normalizeMemory, questionTopic, isQuestion, observedFacts, syncMemory, applyObservations, compatibilityFacts } = require('../electron/social-brain/memory-manager.cjs')
const now = new Date('2026-10-13T12:00:00+08:00')
const row = (text, extra = {}) => ({ id: 'grade_source', role: 'contact', text, at: now.toISOString(), ...extra })

test('grade extends contact identity and remains unknown without evidence', () => {
  assert.ok(IDENTITY_FIELDS.includes('grade'))
  assert.deepEqual(emptyMemory().profile.identity.grade, { value: null, status: 'unknown' })
  assert.ok(normalizeMemory({ profile: { identity: {} } }).unknowns.includes('grade'))
})
for (const [input, expected] of [['我研一', '研一'], ['我是研二', '研二'], ['我读大三', '大三'], ['我目前在读大四', '大四'], ['我现在是研三啊', '研三']]) {
  test(`contact explicit grade: ${input}`, () => {
    const facts = observedFacts(row(input))
    const grade = facts.find(item => item.field === 'grade')
    assert.equal(grade.value, expected)
    assert.equal(grade.status, 'fact'); assert.deepEqual(grade.sourceMessageIds, ['grade_source'])
    assert.equal(grade.evidence, input)
  })
}
for (const input of ['你研几', '研几', '你大几？', '几年级', '你现在读研几', '你什么年级？']) {
  test(`grade question is recognized: ${input}`, () => {
    assert.equal(isQuestion(input), true); assert.equal(questionTopic(input), 'grade')
    assert.equal(observedFacts(row(input)).some(item => item.field === 'grade'), false)
  })
}
for (const input of ['如果我研一', '假设我是研二', '要是我读大三', '我可能是研二', '我明年研二', '我以前研一', '他说我研一', '我朋友研一', '我室友说：我是研二', '“我研一”', '假装我研一', '我是研一吗']) {
  test(`grade cannot come from hypothetical, quote or third-party: ${input}`, () => {
    assert.equal(observedFacts(row(input)).some(item => item.field === 'grade'), false)
  })
}
test('owner message, OCR and quote metadata cannot become contact grade', () => {
  for (const extra of [{ role: 'me' }, { textSource: 'ocr' }, { textSource: 'visual' }, { quote: { text: '我研一', role: 'me' } }]) {
    assert.equal(observedFacts(row('我研一', extra)).some(item => item.field === 'grade'), false)
  }
})
test('standalone grade needs the immediately preceding grade question', () => {
  assert.equal(observedFacts(row('研一')).some(item => item.field === 'grade'), false)
  assert.equal(observedFacts(row('研一'), 'grade').find(item => item.field === 'grade').value, '研一')
})
test('grade persists with source evidence and compatibility label', () => {
  const contact = { id: 'synthetic', learning: { messages: [row('你研几', { id: 'question', role: 'me' }), row('研一')] } }
  const memory = syncMemory(contact, { now })
  assert.equal(memory.profile.identity.grade.value, '研一')
  assert.equal(memory.profile.identity.grade.status, 'fact')
  assert.equal(memory.unknowns.includes('grade'), false)
  assert.ok(compatibilityFacts(memory).some(item => item.text === '年级：研一'))
})
test('model grade must match independently observed current-contact evidence', () => {
  const message = row('我研一')
  const accepted = applyObservations(emptyMemory(), { facts: [{ field: 'grade', value: '研一', evidence: '我研一', evidenceMessageId: message.id }] }, [message], now)
  assert.equal(accepted.profile.identity.grade.value, '研一')
  const rejected = applyObservations(emptyMemory(), { facts: [{ field: 'grade', value: '研二', evidence: '我研一', evidenceMessageId: message.id }] }, [message], now)
  assert.equal(rejected.profile.identity.grade.status, 'unknown')
})
test('birth date and university never imply either contact or owner grade', () => {
  const memory = syncMemory({ id: 'synthetic', learning: { messages: [row('我2000年出生，我在示例理工大学读书')] } }, { now })
  assert.equal(memory.profile.identity.grade.status, 'unknown')
})
