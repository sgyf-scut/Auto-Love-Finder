const test = require('node:test')
const assert = require('node:assert/strict')
require('./setup.cjs')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService, normalizeHistoryMessage } = require('../electron/automation.cjs')
const { AiService, normalizeLearnedMessages } = require('../electron/ai-service.cjs')
const { retrieveReplyExamples } = require('../electron/social-brain/reply-retriever.cjs')
function fixture(initial = {}) {
  const storage = createMemoryStorage(initial)
  const ai = new AiService(storage, { transport: async () => { throw new Error('No model call expected') } })
  const ds = new DouyinService({ storage, ai, partition: 'persist:provenance', emit: () => {} })
  return { ds, get: () => storage.get().contacts.find(row => row.name === '朋友') }
}
const retrieval = contact => retrieveReplyExamples({ contact, focus: '最近熬夜准备考试', relationshipStage: 'old_friend' })

test('human history and style share durable ID/date/source and survive actual AiService learning', () => {
  const f = fixture()
  f.ds.recordConversationMessage('朋友', 'contact', '最近熬夜准备考试', {}, { human: true, messageId: 'q', at: '2026-10-12T03:00:00Z' })
  f.ds.recordConversationMessage('朋友', 'me', '你这作息是真无敌了', {}, { human: true, messageId: 'a', at: '2026-10-12T03:01:00Z' })
  const c = f.get(), reply = c.learning.messages.at(-1), style = c.learning.styleMessages.at(-1)
  for (const row of [reply, style]) {
    assert.equal(row.human, true)
    assert.equal(row.verifiedHuman, true)
    assert.equal(row.source, 'manual_owner')
    assert.equal(row.id, 'a')
    assert.equal(row.messageId, 'a')
    assert.equal(row.at, '2026-10-12T03:01:00.000Z')
  }
  assert.equal(retrieval(c).length, 1)
})
test('AI reply preserves explicit false evidence and never enters owner style', () => {
  const f = fixture()
  f.ds.recordConversationMessage('朋友', 'contact', '最近熬夜准备考试', {}, { human: true })
  f.ds.recordConversationMessage('朋友', 'me', '你这作息是真无敌了', {}, { human: false })
  const c = f.get(), reply = c.learning.messages.at(-1)
  assert.equal(reply.human, false)
  assert.equal(reply.verifiedHuman, false)
  assert.equal(reply.source, 'ai_generated')
  assert.equal(c.learning.styleMessages.filter(row => row.role === 'me').length, 0)
  assert.deepEqual(retrieval(c), [])
})
test('missing human option remains unknown, never retrospectively inferred from me role', () => {
  const f = fixture()
  f.ds.recordConversationMessage('朋友', 'contact', '最近熬夜准备考试')
  f.ds.recordConversationMessage('朋友', 'me', '你这作息是真无敌了')
  const c = f.get()
  assert.equal(c.learning.messages.at(-1).human, undefined)
  assert.equal(c.learning.messages.at(-1).verifiedHuman, undefined)
  assert.deepEqual(c.learning.styleMessages, [])
  assert.deepEqual(retrieval(c), [])
})
test('missing styleMessages never falls back to legacy history which may include AI', () => {
  const f = fixture({ contacts: [{ id: '朋友', name: '朋友', learning: { messages: [{ id: 'old', role: 'me', text: '你这作息是真无敌了' }] } }] })
  f.ds.recordConversationMessage('朋友', 'contact', '最近熬夜准备考试', {}, { human: true })
  const c = f.get()
  assert.equal(c.learning.styleMessages.length, 1)
  assert.equal(c.learning.styleMessages[0].role, 'contact')
  assert.equal(c.learning.messages[0].human, undefined)
  assert.equal(c.learning.ownerStyle.sampleCount, 0)
})
test('existing unmarked style text remains unmarked, cannot establish reply authorship', () => {
  const f = fixture({ contacts: [{ id: '朋友', name: '朋友', learning: { messages: [
    { id: 'old-q', role: 'contact', text: '最近熬夜准备考试' }, { id: 'old-a', role: 'me', text: '你这作息是真无敌了' },
  ], styleMessages: [{ role: 'me', text: '你这作息是真无敌了' }] } }] })
  f.ds.recordConversationMessage('朋友', 'contact', '明天继续吧', {}, { human: true })
  const c = f.get()
  assert.equal(c.learning.styleMessages[0].verifiedHuman, undefined)
  assert.deepEqual(retrieval(c), [])
})
test('same-text human and AI recordings retain distinct IDs and ambiguous sample is excluded', () => {
  const f = fixture()
  f.ds.recordConversationMessage('朋友', 'contact', '最近熬夜准备考试', {}, { human: true })
  f.ds.recordConversationMessage('朋友', 'me', '你这作息是真无敌了', {}, { human: true })
  f.ds.recordConversationMessage('朋友', 'me', '你这作息是真无敌了', {}, { human: false })
  const c = f.get(), rows = c.learning.messages.filter(row => row.role === 'me')
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].id, rows[1].id)
  assert.deepEqual(rows.map(row => row.human), [true, false])
  assert.deepEqual(retrieval(c), [])
})
test('both normalizers preserve explicit booleans but do not promote unknown legacy rows', () => {
  for (const normalize of [row => normalizeHistoryMessage(row), row => normalizeLearnedMessages([row])[0]]) {
    const marked = normalize({ role: 'me', text: '睡觉', human: false, verifiedHuman: false, source: 'ai_generated' })
    assert.equal(marked.human, false)
    assert.equal(marked.verifiedHuman, false)
    assert.equal(marked.source, 'ai_generated')
    assert.equal(normalize({ role: 'me', text: '睡觉' }).human, undefined)
  }
})
