const { createMemoryStorage } = require('./setup.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { AiService } = require('../electron/ai-service.cjs')
const { normalizePromises, resolvePromise } = require('../electron/social-brain/promise.cjs')
const { extractPromiseResult } = require('../electron/social-brain/promise-result-extractor.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { buildChatContext } = require('../electron/chat-core/context-builder.cjs')
const { buildContextBlock } = require('../electron/chat-engines/simple-v3/prompt.cjs')
const { DEFAULT_SIMPLE_V3_CONFIG } = require('../electron/chat-engines/simple-v3/config.cjs')

const at = (d = 1, m = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(m).padStart(2, '0')}:00+08:00`
const now = d => Date.parse(at(d, 59))
const row = (id, role, text, { d = 1, m = 0, contactId = 'a' } = {}) => ({ id, contactId, role, text, at: at(d, m),
  source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}) })
function v3Prompt(contact, incoming, traceId, d = 2) {
  const context = buildContext({ contact, incoming, now: new Date(now(d)) })
  const chatContext = buildChatContext({ accountId: 'acc-a', traceId, contact, incoming, context, profile: null })
  return buildContextBlock(chatContext, DEFAULT_SIMPLE_V3_CONFIG)
}

// The V3.2 acceptance case: the AI promises a smurf account to one contact, the
// human later writes back the real result, and only that relationship can answer
// when the contact asks whether it is done.
test('the 黑色玫瑰 smurf account travels from promise to writeback to recall', async () => {
  const contactA = { id: 'c-a', name: '小美', profile: {}, learning: { messages: [] },
    sharedMemoryLedger: [row('m1', 'me', '我这两天建个号过去', { contactId: 'c-a' }), row('c1', 'contact', '好呀', { contactId: 'c-a' })] }
  const contactB = { id: 'c-b', name: '小丽', profile: {}, learning: { messages: [] },
    sharedMemoryLedger: [row('n1', 'me', '我这两天建个号过去', { contactId: 'c-b' })] }
  const storage = createMemoryStorage({ contacts: [contactA, contactB], settings: { longTermMemory: true } })
  const ai = new AiService(storage)
  ai.queuePromiseExtraction({ contactId: 'c-a', reason: 'confirmed_send' })
  ai.queuePromiseExtraction({ contactId: 'c-b', reason: 'confirmed_send' })
  await ai.flushPromiseExtractions()

  const savedA = storage.get().contacts.find(item => item.id === 'c-a')
  const savedB = storage.get().contacts.find(item => item.id === 'c-b')
  assert.equal(savedA.promises.items.length, 1)
  assert.equal(savedA.promises.items[0].status, 'pending')
  assert.equal(savedA.promises.items[0].type, 'HUMAN_ACTION')
  assert.equal(savedB.promises.items.length, 1)

  // Before the human fills anything in, the AI must not claim the account exists.
  const pending = v3Prompt({ ...contactA, promises: savedA.promises }, '在吗', 't-pending')
  assert.ok(pending.includes('[未完成] 我答应过：我这两天建个号过去'))
  assert.ok(!pending.includes('[已完成]'))
  assert.ok(!pending.includes('黑色玫瑰'))

  // The human completes it and confirms the writeback.
  const promise = savedA.promises.items[0]
  const result = '黑色玫瑰，ID 546124'
  const { fields } = extractPromiseResult(promise, result)
  assert.deepEqual(fields, [{ label: '账号', value: '546124' }, { label: '区服', value: '黑色玫瑰' }])
  const promises = resolvePromise({ ...contactA, promises: savedA.promises }, promise.id,
    { text: result, fields, now: now(3), expectedRevision: savedA.promises.revision })
  assert.equal(promises.items[0].status, 'done')
  assert.deepEqual(promises.items[0].resolution.fields, fields)
  assert.equal(normalizePromises({ ...contactA, promises }, { now: now(3) }).items[0].resolution.text, result)

  const resolvedA = { ...contactA, promises }
  const asked = v3Prompt(resolvedA, '你号建好没', 't-asked', 5)
  assert.ok(asked.includes('[已完成] 我答应过：我这两天建个号过去'))
  assert.ok(asked.includes('黑色玫瑰，ID 546124'))
  assert.ok(asked.includes('账号=546124'))

  // The other relationship only knows its own pending promise.
  const other = v3Prompt({ ...contactB, promises: savedB.promises }, '你号建好没', 't-other', 5)
  assert.ok(!other.includes('黑色玫瑰'))
  assert.ok(!other.includes('[已完成]'))
  assert.ok(other.includes('[未完成] 我答应过：我这两天建个号过去'))
})
