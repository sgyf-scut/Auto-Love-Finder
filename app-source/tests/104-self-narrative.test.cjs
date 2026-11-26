const { createMemoryStorage } = require('./setup.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeSelfNarrative, selfStatementMessages } = require('../electron/social-brain/self-narrative.cjs')
const { SELF_TOPICS, buildSelfNarrativeCandidates, extractSelfNarratives } = require('../electron/social-brain/self-narrative-extractor.cjs')
const { retrieveSelfNarratives } = require('../electron/social-brain/self-narrative-retriever.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { buildChatContext } = require('../electron/chat-core/context-builder.cjs')
const { buildContextBlock } = require('../electron/chat-engines/simple-v3/prompt.cjs')
const { DEFAULT_SIMPLE_V3_CONFIG } = require('../electron/chat-engines/simple-v3/config.cjs')
const { AiService } = require('../electron/ai-service.cjs')

const at = (d = 1, m = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(m).padStart(2, '0')}:00+08:00`
const now = d => Date.parse(at(d, 59))
const person = (id = 'a', extra = {}) => ({ id, name: `联系人${id}`, profile: {}, ...extra })
const row = (id, role, text, { d = 1, m = 0, contactId = 'a', ...extra } = {}) => ({ id, contactId, role, text, at: at(d, m),
  source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}), ...extra })
function run(contact, messages, d = 1) { return extractSelfNarratives({ contact, messages, now: now(d) }) }

test('an empty contact normalizes to an empty revision-zero store', () => {
  const store = normalizeSelfNarrative(person('a'), { now: now(1) })
  assert.equal(store.contactId, 'a'); assert.deepEqual(store.narratives, []); assert.equal(store.revision, 0)
  assert.deepEqual(store.processedCandidateIds, [])
})

test('an AI statement about its own habit is stored verbatim under its topic key', () => {
  const output = run(person('a'), [row('m1', 'me', '我其实不怎么打排位')])
  assert.equal(output.changed, true); assert.equal(output.added, 1); assert.equal(output.updated, 0)
  assert.equal(output.selfNarrative.narratives.length, 1)
  const narrative = output.selfNarrative.narratives[0]
  assert.equal(narrative.key, 'lol_rank'); assert.equal(narrative.statement, '我其实不怎么打排位')
  assert.deepEqual(narrative.sourceMessageIds, ['m1']); assert.deepEqual(narrative.topics.includes('排位'), true)
  assert.equal(narrative.contactId, 'a'); assert.equal(narrative.status, 'active')
})

test('filler, questions, third-party claims and future plans are never stored', () => {
  const texts = ['笑死', '这个确实', '我感觉还行', '今天有点困', '我不怎么打排位吗',
    '我朋友也不打排位', '我明天建个号', '你打排位吗', '我这两天去健身']
  for (const text of texts) {
    const output = run(person('a'), [row('m1', 'me', text)])
    assert.equal(output.changed, false, text)
    assert.deepEqual(output.selfNarrative.narratives, [], text)
  }
})

test('only confirmed outgoing statements count, never drafts or contact messages', () => {
  const messages = [
    row('d1', 'me', '我其实不怎么打排位', { source: 'planner_draft', confirmedSent: false, status: 'draft' }),
    row('c1', 'contact', '我其实不怎么打排位'),
  ]
  const output = run(person('a'), messages)
  assert.deepEqual(output.selfNarrative.narratives, [])
})

test('paraphrases collapse onto one entry and a later statement overwrites it', () => {
  const first = run(person('a'), [row('m1', 'me', '我其实不怎么打排位')], 1)
  const contact = { ...person('a'), selfNarrative: first.selfNarrative }
  const messages = [row('m1', 'me', '我其实不怎么打排位', { d: 1 }), row('m2', 'me', '排位基本不碰', { d: 2 })]
  const second = run(contact, messages, 2)
  assert.equal(second.selfNarrative.narratives.length, 1)
  assert.equal(second.selfNarrative.narratives[0].key, 'lol_rank')
  assert.equal(second.selfNarrative.narratives[0].statement, '排位基本不碰')
  assert.equal(second.updated, 1); assert.equal(second.added, 0)
})

test('a re-run over unchanged evidence changes nothing', () => {
  const first = run(person('a'), [row('m1', 'me', '我平时周末起得比较晚')], 1)
  const contact = { ...person('a'), selfNarrative: first.selfNarrative }
  const second = run(contact, [row('m1', 'me', '我平时周末起得比较晚', { d: 1 })], 2)
  assert.equal(second.changed, false)
  assert.equal(second.selfNarrative.revision, first.selfNarrative.revision)
})

test('a self narrative stays scoped to one contact and never loads for another', () => {
  const stored = run(person('a'), [row('m1', 'me', '我其实不怎么打排位')]).selfNarrative
  const contactA = { ...person('a'), selfNarrative: stored }
  assert.equal(retrieveSelfNarratives({ contact: contactA, incoming: '你平时打排位吗', now: now(2) }).length, 1)
  assert.deepEqual(retrieveSelfNarratives({ contact: person('b'), incoming: '你平时打排位吗', now: now(2) }), [])
})

test('recall returns only topic-relevant narratives within the limit', () => {
  const messages = [row('m1', 'me', '我其实不怎么打排位'), row('m2', 'me', '我最近挺喜欢骑车'), row('m3', 'me', '我最近都没怎么游泳了')]
  const stored = run(person('a'), messages).selfNarrative
  const contact = { ...person('a'), selfNarrative: stored }
  const hits = retrieveSelfNarratives({ contact, incoming: '你现在还打排位吗', now: now(2) })
  assert.equal(hits.length, 1); assert.equal(hits[0].key, 'lol_rank')
  const all = retrieveSelfNarratives({ contact, incoming: '你打排位吗 骑车吗 游泳吗', limit: 2, now: now(2) })
  assert.equal(all.length, 2)
})

test('concrete first-person facts persist without a habit marker while filler still does not', () => {
  const cases = [['我在黑色玫瑰哎', 'lol_server'], ['我平时周末一般都有空', 'availability'], ['我菜得很', 'self_eval']]
  for (const [text, key] of cases) {
    const stored = run(person('a'), [row('m1', 'me', text)]).selfNarrative
    assert.equal(stored.narratives.length, 1, text)
    assert.equal(stored.narratives[0].key, key, text)
    assert.equal(stored.narratives[0].statement, text)
  }
  for (const text of ['我困了', '我笑死了', '我先去吃饭', '我没事']) {
    assert.deepEqual(run(person('a'), [row('m1', 'me', text)]).selfNarrative.narratives, [], text)
  }
})

test('an aliased question recalls the stored fact while an unrelated topic recalls nothing', () => {
  const stored = run(person('a'), [row('m1', 'me', '我在黑色玫瑰哎')]).selfNarrative
  const contact = { ...person('a', { learning: { messages: [] } }), sharedMemoryLedger: [row('m1', 'me', '我在黑色玫瑰哎')], selfNarrative: stored }
  const hits = retrieveSelfNarratives({ contact, incoming: '你是不是创到别的区了', now: now(2) })
  assert.equal(hits.length, 1); assert.equal(hits[0].key, 'lol_server')
  assert.equal(hits[0].statement, '我在黑色玫瑰哎')
  assert.deepEqual(retrieveSelfNarratives({ contact, incoming: '你今天吃饭了吗', now: now(2) }), [])

  const incoming = '你是不是创到别的区了'
  const context = buildContext({ contact, incoming, now: new Date(now(2)) })
  const chatContext = buildChatContext({ accountId: 'account-a', traceId: 'trace-a', contact, incoming, context, profile: null })
  assert.equal(chatContext.selfNarratives.length, 1)
  assert.equal(chatContext.selfNarratives[0].key, 'lol_server')
})

test('the V3 context carries recalled self narratives and the prompt renders them', () => {
  const stored = run(person('a'), [row('m1', 'me', '我其实不怎么打排位')]).selfNarrative
  const contact = { ...person('a', { learning: { messages: [] } }), sharedMemoryLedger: [row('m1', 'me', '我其实不怎么打排位')], selfNarrative: stored }
  const profile = null, incoming = '你现在还打排位吗'
  const oldContext = buildContext({ contact, incoming, now: new Date(now(2)) })
  const chatContext = buildChatContext({ accountId: 'account-a', traceId: 'trace-a', contact, incoming, context: oldContext, profile })
  assert.equal(chatContext.selfNarratives.length, 1)
  assert.equal(chatContext.selfNarratives[0].statement, '我其实不怎么打排位')
  const block = buildContextBlock(chatContext, DEFAULT_SIMPLE_V3_CONFIG)
  assert.ok(block.includes('我其实不怎么打排位'))
  assert.ok(block.includes('你之前在这个人面前说过的关于自己的话'))
})

test('a confirmed send queues extraction and writes the narrative onto the contact', async () => {
  const contact = { id: 'c-narr', name: '黑玫瑰', profile: {}, learning: { messages: [] },
    sharedMemoryLedger: [row('m1', 'me', '我这两天建个黑色玫瑰号', { contactId: 'c-narr' }), row('m2', 'me', '我其实不怎么打排位', { contactId: 'c-narr' })] }
  const storage = createMemoryStorage({ contacts: [contact], settings: { longTermMemory: true } })
  const ai = new AiService(storage)
  const queued = ai.queueSelfNarrativeExtraction({ contactId: 'c-narr', reason: 'confirmed_send' })
  assert.equal(queued.queued, true)
  await ai.flushSelfNarrativeExtractions()
  const saved = storage.get().contacts.find(item => item.id === 'c-narr').selfNarrative
  assert.equal(saved.narratives.length, 1)
  assert.equal(saved.narratives[0].statement, '我其实不怎么打排位')
  assert.equal(saved.narratives[0].key, 'lol_rank')
})

test('long-term memory disabled leaves self narrative untouched', async () => {
  const contact = { id: 'c-off', name: '关闭记忆', profile: {}, learning: { messages: [] },
    sharedMemoryLedger: [row('m1', 'me', '我其实不怎么打排位', { contactId: 'c-off' })] }
  const storage = createMemoryStorage({ contacts: [contact], settings: { longTermMemory: false } })
  const ai = new AiService(storage)
  assert.equal(ai.queueSelfNarrativeExtraction({ contactId: 'c-off' }).queued, false)
  await ai.flushSelfNarrativeExtractions()
  assert.equal(storage.get().contacts[0].selfNarrative, undefined)
})
