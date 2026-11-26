const { test } = require('node:test')
const assert = require('node:assert/strict')
const { extractPromises } = require('../electron/social-brain/promise-extractor.cjs')
const { resolvePromise } = require('../electron/social-brain/promise.cjs')
const { extractPromiseResult } = require('../electron/social-brain/promise-result-extractor.cjs')
const { retrievePromises, relevance } = require('../electron/social-brain/promise-retriever.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { buildChatContext } = require('../electron/chat-core/context-builder.cjs')
const { buildContextBlock } = require('../electron/chat-engines/simple-v3/prompt.cjs')
const { DEFAULT_SIMPLE_V3_CONFIG } = require('../electron/chat-engines/simple-v3/config.cjs')

const at = (d = 1, m = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(m).padStart(2, '0')}:00+08:00`
const now = d => Date.parse(at(d, 59))
const person = (id = 'a', extra = {}) => ({ id, name: `联系人${id}`, profile: {}, ...extra })
const row = (id, role, text, { d = 1, m = 0, contactId = 'a', ...extra } = {}) => ({ id, contactId, role, text, at: at(d, m),
  source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}), ...extra })
const withPromises = (contact, messages, d = 1) => ({ ...contact, promises: extractPromises({ contact, messages, now: now(d) }).promises })
function resolvedAccount(contactId = 'a') {
  const base = person(contactId)
  const contact = withPromises(base, [row('m1', 'me', '我这两天建个号过去', { contactId })], 1)
  const promise = contact.promises.items[0]
  const text = '黑色玫瑰，ID 546124'
  const { fields } = extractPromiseResult(promise, text)
  return { ...contact, promises: resolvePromise(contact, promise.id, { text, fields, now: now(3) }) }
}

test('a contact with no promises recalls nothing', () => {
  assert.deepEqual(retrievePromises({ contact: person('a'), incoming: '在吗', now: now(2) }), [])
})

test('a pending promise is recalled even when the current message says nothing about it', () => {
  const contact = withPromises(person('a'), [row('m1', 'me', '我这两天建个号过去')])
  const hits = retrievePromises({ contact, incoming: '在吗', now: now(2) })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].status, 'pending')
  assert.equal(hits[0].summary, '我这两天建个号过去')
  assert.equal(hits[0].resolution, null)
})

test('the completed account promise comes back when the contact asks about it', () => {
  const hits = retrievePromises({ contact: resolvedAccount(), incoming: '你号建好没', now: now(5) })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].status, 'done')
  assert.equal(hits[0].summary, '我这两天建个号过去')
  assert.equal(hits[0].resolution.text, '黑色玫瑰，ID 546124')
  assert.deepEqual(hits[0].resolution.fields, [{ label: '账号', value: '546124' }, { label: '区服', value: '黑色玫瑰' }])
})

test('a promise never loads for another contact', () => {
  const settled = resolvedAccount('a')
  assert.equal(retrievePromises({ contact: settled, incoming: '你号建好没', now: now(5) }).length, 1)
  assert.deepEqual(retrievePromises({ contact: person('b'), incoming: '你号建好没', now: now(5) }), [])
})

test('an old completed promise on an unrelated topic stays out of context', () => {
  const contact = resolvedAccount()
  assert.equal(retrievePromises({ contact, incoming: '今天天气不错', now: now(20) }).length, 0)
})

test('recall never exceeds the configured limit and keeps pending first', () => {
  const messages = [row('m1', 'me', '我这两天建个号过去'), row('m2', 'me', '改天一起吃饭'), row('m3', 'me', '我回头告诉你')]
  const contact = withPromises(person('a'), messages)
  assert.equal(contact.promises.items.length, 3)
  const hits = retrievePromises({ contact, incoming: '在吗', limit: 2, now: now(2) })
  assert.equal(hits.length, 2)
  assert.ok(hits.every(hit => hit.status === 'pending'))
})

test('a single shared character is not a shared topic', () => {
  const promise = { summary: '我这两天建个号过去', topics: ['建号', '账号'], resolution: null }
  assert.ok(relevance(promise, '你号建好没') >= 0.4)
  assert.ok(relevance(promise, '今天天气不错') < 0.4)
})

test('the V3 context carries recalled promises and the prompt renders the real result', () => {
  const contact = { ...resolvedAccount(), learning: { messages: [] }, sharedMemoryLedger: [row('m1', 'me', '我这两天建个号过去')] }
  const incoming = '你号建好没', profile = null
  const oldContext = buildContext({ contact, incoming, now: new Date(now(5)) })
  const chatContext = buildChatContext({ accountId: 'account-a', traceId: 'trace-a', contact, incoming, context: oldContext, profile })
  assert.equal(chatContext.promises.length, 1)
  assert.equal(chatContext.promises[0].resolution.text, '黑色玫瑰，ID 546124')
  const block = buildContextBlock(chatContext, DEFAULT_SIMPLE_V3_CONFIG)
  assert.ok(block.includes('你在这个人面前答应过的事'))
  assert.ok(block.includes('[已完成] 我答应过：我这两天建个号过去'))
  assert.ok(block.includes('黑色玫瑰，ID 546124'))
})

test('an unfinished promise is rendered as not done so the AI never claims it finished', () => {
  const contact = withPromises(person('a'), [row('m1', 'me', '我这两天建个号过去')])
  const block = buildContextBlock({ promises: retrievePromises({ contact, incoming: '在吗', now: now(2) }) }, DEFAULT_SIMPLE_V3_CONFIG)
  assert.ok(block.includes('[未完成] 我答应过：我这两天建个号过去'))
  assert.ok(!block.includes('[已完成]'))
})
