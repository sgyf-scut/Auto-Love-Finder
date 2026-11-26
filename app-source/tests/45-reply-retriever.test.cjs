const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveReplyExamples, retrieveReplyExamples, retrieveReplyCandidatePool, rankReplyExamples } = require('../electron/social-brain/reply-retriever.cjs')
const contact = (reply = {}, prompt = {}) => ({ id: 'current', learning: { messages: [
  { id: 'question', role: 'contact', text: '最近熬夜准备考试', ...prompt },
  { id: 'reply', role: 'me', text: '你这作息是真无敌了', human: true, ...reply },
] } })
const options = more => ({ contact: contact(), focus: { messageId: 'focus', summary: '熬夜准备考试' }, relationshipStage: 'old_friend', ...more })
const globalExample = more => ({ sampleId: 'global', contextSummary: '朋友熬夜准备考试', targetMeaning: '熬夜准备考试', myReply: '还是得留点睡觉时间', action: 'EMPATHY', relationshipStage: 'old_friend', approved: true, sanitized: true, ownerVerified: true, verifiedHuman: true, ...more })

test('current owner reply carries proved authorship and matched context IDs', () => {
  const rows = retrieveReplyExamples(options())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].provenance, 'current_contact_human')
  assert.equal(rows[0].sourceContactId, 'current')
  assert.equal(rows[0].verifiedHuman, true)
  assert.deepEqual(rows[0].contextMessageIds, ['question', 'reply'])
  assert.equal(rows[0].action, 'TEASE')
})
test('role me alone cannot prove owner and unknown legacy style does not prove it', () => {
  const c = contact({ human: undefined })
  c.learning.styleMessages = [{ role: 'me', text: c.learning.messages[1].text }]
  assert.deepEqual(retrieveReplyExamples(options({ contact: c })), [])
})
test('AI records cannot enter even when style text or positive marker is present', () => {
  for (const source of [{ human: false }, { ai: true }, { source: 'ai' }, { source: 'ai_generated' }, { provenance: 'automatic' }, { verifiedHuman: false }]) {
    const c = contact(source)
    c.learning.styleMessages = [{ id: 'reply', role: 'me', text: c.learning.messages[1].text, human: true }]
    assert.deepEqual(retrieveReplyExamples(options({ contact: c })), [])
  }
})
test('explicit style owner proof joins only by exact unique message ID', () => {
  const c = contact({ human: undefined })
  c.learning.styleMessages = [{ id: 'reply', role: 'me', text: c.learning.messages[1].text, verifiedHuman: true }]
  assert.equal(retrieveReplyExamples(options({ contact: c })).length, 1)
  c.learning.styleMessages[0].id = 'another'
  assert.deepEqual(retrieveReplyExamples(options({ contact: c })), [])
})
test('duplicated text with uncertain occurrence never attributes a reply to owner', () => {
  const c = contact()
  c.learning.messages.push({ id: 'q2', role: 'contact', text: '最近熬夜准备考试' }, { id: 'a2', role: 'me', text: '你这作息是真无敌了', human: false })
  assert.deepEqual(retrieveReplyExamples(options({ contact: c })), [])
})
test('contact utterances are never owner examples', () => {
  assert.deepEqual(retrieveReplyExamples(options({ contact: contact({ role: 'contact' }) })), [])
})
test('context must be adjacent real text with evidence ID, not an own monologue or quote', () => {
  for (const prompt of [{ role: 'me' }, { id: undefined }, { quote: { text: '最近熬夜准备考试' } }, { mediaEvidence: { urls: ['x'] } }, { type: 'image' }, { text: '' }]) {
    assert.deepEqual(retrieveReplyExamples(options({ contact: contact({}, prompt) })), [])
  }
})
test('shared two-person manual excerpts and bare style strings are excluded', () => {
  const c = { id: 'current', profile: { examplesSource: 'shared-conversation', examples: [globalExample({ source: 'owner' })] } }
  assert.deepEqual(retrieveReplyExamples(options({ contact: c })), [])
  c.profile = { examplesSource: 'owner', examples: ['你这作息是真无敌了'] }
  assert.deepEqual(retrieveReplyExamples(options({ contact: c })), [])
})
test('manual owner examples require both explicit origin and scene', () => {
  const c = { id: 'current', profile: { examplesSource: 'owner', examples: [globalExample({ source: 'manual_owner' })] } }
  assert.equal(retrieveReplyExamples(options({ contact: c }))[0].provenance, 'manual_owner')
  c.profile.examples[0].contextSummary = ''
  assert.deepEqual(retrieveReplyExamples(options({ contact: c })), [])
})
test('unknown and unapproved global sources are excluded field by field', () => {
  for (const flag of ['approved', 'sanitized', 'ownerVerified', 'verifiedHuman']) {
    assert.deepEqual(retrieveReplyExamples(options({ contact: {}, globalExamples: [globalExample({ [flag]: false })] })), [])
  }
})
test('global output contains no prior-contact ID, private fields, dates or context IDs', () => {
  const example = globalExample({ sourceContactId: 'other', contextMessageIds: ['private'], contactName: 'Someone', event: 'private', at: '2026-01-01' })
  const row = retrieveReplyExamples(options({ contact: {}, globalExamples: [example] }))[0]
  assert.equal(row.sourceContactId, '')
  assert.deepEqual(row.contextMessageIds, [])
  for (const key of ['contactName', 'event', 'at']) assert.equal(row[key], undefined)
})
test('sensitive and commitment-bearing global examples are excluded', () => {
  for (const reply of ['我在清华大学准备考试', '我的工资一万', '我保证帮你准备考试', '我手机号13812345678', '小李准备考试', '我昨天也熬夜准备考试', '南昌大学准备考试', '考试花了500元']) {
    assert.deepEqual(retrieveReplyExamples(options({ contact: {}, globalExamples: [globalExample({ myReply: reply, sensitiveNames: ['小李'] })] })), [])
  }
})
test('global examples need explicit stage and action instead of invented defaults', () => {
  for (const field of ['relationshipStage', 'action']) {
    assert.deepEqual(retrieveReplyExamples(options({ contact: {}, globalExamples: [globalExample({ [field]: undefined })] })), [])
  }
})
test('current-contact owner examples outrank exact-focus global examples', () => {
  const rows = retrieveReplyExamples(options({ globalExamples: [globalExample()] }))
  assert.equal(rows[0].provenance, 'current_contact_human')
  assert.equal(rows[1].provenance, 'approved_global')
})
test('global duplicate cannot replace a current owner example', () => {
  const rows = retrieveReplyExamples(options({ globalExamples: [globalExample({ contextSummary: '最近熬夜准备考试', myReply: '你这作息是真无敌了' })] }))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].provenance, 'current_contact_human')
})
test('no topic overlap returns no samples rather than an invented scene', () => {
  assert.deepEqual(retrieveReplyExamples(options({ focus: { summary: '宠物吃零食' } })), [])
  assert.deepEqual(retrieveReplyExamples(options({ contact: {} })), [])
  assert.deepEqual(retrieveReplyExamples(options({ focus: null })), [])
})
test('unknown preplanning action remains eligible and actual action reranks same pool', () => {
  const globalExamples = [globalExample({ sampleId: 'empathy' }), globalExample({ sampleId: 'reaction', action: 'REACTION', myReply: '哈哈这考试备考有点猛' })]
  const pool = retrieveReplyCandidatePool(options({ contact: {}, globalExamples, action: 'unknown' }))
  assert.equal(pool.length, 2)
  assert.equal(rankReplyExamples(pool, { focus: '熬夜准备考试', relationshipStage: 'old_friend', action: 'REACTION' })[0].sampleId, 'reaction')
})
test('new friends cannot borrow stronger old-friend banter stages', () => {
  assert.deepEqual(retrieveReplyExamples(options({ contact: {}, relationshipStage: 'new_friend', globalExamples: [globalExample()] })), [])
  const c = contact({ relationshipStage: 'old_friend' })
  assert.deepEqual(retrieveReplyExamples(options({ contact: c, relationshipStage: 'new_friend' })), [])
})
test('same relationship stage ranks ahead of permitted earlier-stage expressions', () => {
  const rows = retrieveReplyExamples(options({ contact: {}, globalExamples: [globalExample({ sampleId: 'new', relationshipStage: 'new_friend' }), globalExample({ sampleId: 'old', myReply: '考试再忙也别熬太晚' })] }))
  assert.equal(rows[0].sampleId, 'old')
})
test('candidate pool capped at 20, selected examples capped at 3, maximum reply 80', () => {
  const globalExamples = Array.from({ length: 40 }, (_, n) => globalExample({ sampleId: `g${n}`, myReply: `准备考试也得休息${n}` }))
  assert.equal(retrieveReplyCandidatePool(options({ contact: {}, globalExamples })).length, 20)
  assert.equal(retrieveReplyExamples(options({ contact: {}, globalExamples })).length, 3)
  assert.deepEqual(deriveReplyExamples({ contact: contact({ text: '睡'.repeat(81) }), relationshipStage: 'old_friend' }), [])
})
test('retrieval never mutates focus, attention scores, source history or candidate pool', () => {
  const opts = options({ attention: { selectedFocus: { summary: '熬夜准备考试' }, rankedFocusCandidates: [{ score: 0.91 }] } })
  const before = JSON.stringify(opts)
  const pool = retrieveReplyCandidatePool(opts), poolBefore = JSON.stringify(pool)
  rankReplyExamples(pool, opts)
  assert.equal(JSON.stringify(opts), before)
  assert.equal(JSON.stringify(pool), poolBefore)
})
