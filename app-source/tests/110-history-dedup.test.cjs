const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./setup.cjs')
const { mergeMessageHistory } = require('../electron/automation.cjs')
const { withIncomingBurst } = require('../electron/social-brain/incoming-burst.cjs')
const { buildChatContext } = require('../electron/chat-core/context-builder.cjs')
const { normalizeSelfProfile } = require('../electron/social-brain/self-profile.cjs')

const now = new Date('2026-10-17T04:00:00Z')
const profile = () => normalizeSelfProfile({ enabled: true, revision: 1, stableProfile: [], currentLife: [], privacyPreferences: [] }, { now })
// A `msg-…` id is a position-derived DOM fingerprint, so re-reading the window
// issues the same bubble a new id. A real send id looks like `m_<uuid>`.
const fingerprint = tag => ({ role: 'contact', text: '在吗', messageId: `msg-${tag}` })
const sent = (text, id) => ({ role: 'me', text, messageId: id, at: now.toISOString(), source: 'ai_generated' })
const dom = (text, tag) => ({ role: 'me', text, messageId: `msg-${tag}` })

// ---- mergeMessageHistory -------------------------------------------------

test('a message stored with a real id and re-scraped without one is stored once', () => {
  const identified = sent('创好啦，黑色玫瑰的，id是62488', 'm_3bea48b1')
  const scraped = dom('创好啦，黑色玫瑰的，id是62488', 'e19791d20f7f0bcd')
  assert.equal(mergeMessageHistory([scraped], [identified]).length, 1)
  assert.equal(mergeMessageHistory([identified], [scraped]).length, 1)
  // The identified copy is the one that survives, so the timestamp is not lost.
  assert.equal(mergeMessageHistory([scraped], [identified])[0].messageId, 'm_3bea48b1')
  assert.equal(mergeMessageHistory([scraped], [identified])[0].at, now.toISOString())
})

test('the same short text re-scraped under a shifted fingerprint collapses to one', () => {
  assert.equal(mergeMessageHistory([fingerprint('b52fcfe996af5398f155')], [fingerprint('d5e9b0a4493883c9cd0f')]).length, 1)
  assert.equal(mergeMessageHistory([], [fingerprint('a1'), fingerprint('a2'), fingerprint('a3')]).length, 1)
})

test('repeated scrapes of one window never grow the stored history', () => {
  const window = [
    { role: 'contact', text: '在吗', messageId: 'msg-w1' },
    { role: 'me', text: '在的', messageId: 'msg-w2' },
    { role: 'contact', text: '晚上有空吗', messageId: 'msg-w3' },
  ]
  let stored = mergeMessageHistory([], window)
  assert.equal(stored.length, 3)
  for (const tag of ['x', 'y', 'z']) {
    stored = mergeMessageHistory(stored, window.map((row, index) => ({ ...row, messageId: `msg-${tag}${index}` })))
    assert.equal(stored.length, 3)
  }
  assert.deepEqual(stored.map(row => row.text), ['在吗', '在的', '晚上有空吗'])
})

test('a multi-bubble AI reply keeps each bubble exactly once', () => {
  const previous = [sent('第一句', 'm_1')]
  const visible = [dom('第一句', 'v1'), dom('第二句', 'v2'), dom('第三句', 'v3')]
  const merged = mergeMessageHistory(previous, visible)
  assert.deepEqual(merged.map(row => row.text), ['第一句', '第二句', '第三句'])
})

test('two genuine messages with distinct real ids and identical text both survive', () => {
  assert.equal(mergeMessageHistory([sent('哈哈', 'm_a')], [sent('哈哈', 'm_b')]).length, 2)
})

test('identical media without platform ids keeps its positional identity', () => {
  const media = { role: 'contact', text: '', type: 'sticker', mediaEvidence: { source: 'visible_message_dom', urls: ['https://cdn.test/same.webp'], alt: '狗头' } }
  assert.equal(mergeMessageHistory([{ ...media, messageId: 'msg-a' }], [{ ...media, messageId: 'msg-b' }]).length, 2)
  assert.equal(mergeMessageHistory([{ ...media, messageId: 'msg-a' }], [{ ...media, messageId: 'msg-a' }]).length, 1)
})

// ---- withIncomingBurst ---------------------------------------------------

test('reading the same DOM window three times leaves one copy of each bubble', () => {
  const burst = { contactId: 'a', burstId: 'b1', messages: [{ role: 'contact', messageId: 'in-1', text: '在吗' }] }
  const window = [
    { role: 'contact', messageId: 'msg-w0a', text: '在吗' },
    { role: 'me', messageId: 'msg-w0b', text: '在的' },
    { role: 'contact', messageId: 'msg-w0c', text: '晚上有空吗' },
  ]
  let contact = { id: 'a', name: '甲', learning: { messages: [] } }
  for (const tag of ['0', '1', '2']) {
    const shifted = window.map((row, index) => ({ ...row, messageId: `msg-${tag}-${index}` }))
    contact = withIncomingBurst(contact, burst, shifted).contact
    assert.deepEqual(contact.learning.messages.map(row => row.text), ['在吗', '在的', '晚上有空吗'])
  }
})

test('the burst copy with a real id outranks the fingerprint-only copy in the window', () => {
  const burst = { contactId: 'a', burstId: 'b1', messages: [{ role: 'contact', messageId: 'observed-in-1', text: '你是不是创到别的区了' }] }
  const window = [{ role: 'contact', messageId: 'msg-window-9', text: '你是不是创到别的区了' }]
  const { contact } = withIncomingBurst({ id: 'a', name: '甲', learning: { messages: [] } }, burst, window)
  assert.equal(contact.learning.messages.length, 1)
  assert.equal(contact.learning.messages[0].messageId, 'observed-in-1')
})

test('an unusable burst leaves the contact untouched', () => {
  const contact = { id: 'a', name: '甲', learning: { messages: [{ role: 'contact', text: '在吗' }] } }
  const grouped = withIncomingBurst(contact, { contactId: 'b', messages: [{ role: 'contact', messageId: 'x', text: '别的联系人' }] })
  assert.equal(grouped.burst, null)
  assert.equal(grouped.contact, contact)
})

// ---- buildChatContext ----------------------------------------------------

test('the newest inbound appears only in its own section, not in recent history', () => {
  const contact = { id: 'a', name: '甲', profile: {}, learning: { messages: [
    { role: 'contact', text: '你好', messageId: 'msg-1' },
    { role: 'me', text: '好呀', messageId: 'm_1' },
    { role: 'contact', text: '你是不是创到别的区了', messageId: 'msg-2' },
  ] } }
  const chatContext = buildChatContext({ accountId: 'a', contact, incoming: '你是不是创到别的区了', profile: profile() })
  assert.deepEqual(chatContext.incomingMessages.map(row => row.text), ['你是不是创到别的区了'])
  assert.deepEqual(chatContext.recentMessages.map(row => row.text), ['你好', '好呀'])
})

test('a whole burst is stripped from recent history while older turns stay', () => {
  const contact = { id: 'a', name: '甲', profile: {}, learning: { messages: [
    { role: 'contact', text: '你好', messageId: 'msg-1' },
    { role: 'contact', text: '在吗', messageId: 'msg-2' },
    { role: 'contact', text: '晚上来一把吗', messageId: 'msg-3' },
  ] } }
  const burst = { contactId: 'a', burstId: 'b1', messages: [
    { role: 'contact', messageId: 'msg-2', text: '在吗' },
    { role: 'contact', messageId: 'msg-3', text: '晚上来一把吗' },
  ] }
  const chatContext = buildChatContext({ accountId: 'a', contact, incoming: '晚上来一把吗', burst, profile: profile() })
  assert.deepEqual(chatContext.incomingMessages.map(row => row.text), ['在吗', '晚上来一把吗'])
  assert.deepEqual(chatContext.recentMessages.map(row => row.text), ['你好'])
})

test('a text that legitimately repeats earlier in the history is not over-stripped', () => {
  // Distinct real ids keep both repeats as separate messages; only the newest
  // occurrence (the incoming copy) may be stripped.
  const contact = { id: 'a', name: '甲', profile: {}, learning: { messages: [
    { role: 'contact', text: '在吗', messageId: 'm_a' },
    { role: 'me', text: '在的', messageId: 'm_1' },
    { role: 'contact', text: '在吗', messageId: 'm_b' },
  ] } }
  const chatContext = buildChatContext({ accountId: 'a', contact, incoming: '在吗', profile: profile() })
  assert.deepEqual(chatContext.recentMessages.map(row => row.text), ['在吗', '在的'])
})

test('a stored burst copy that dedup relocated ahead of a later reply is still stripped', () => {
  // The inbound was already stored under a DOM fingerprint, and the AI reply that
  // followed it was recorded after (out-of-order storage). Dedup collapses the
  // incoming row onto the fingerprint copy in place, so it no longer sits at the
  // tail — the tail-only strip used to leave it duplicated in recent history.
  const contact = { id: 'a', name: '甲', profile: {}, learning: { messages: [
    { role: 'contact', text: '你好', messageId: 'msg-1' },
    { role: 'me', text: '好呀', messageId: 'm_1' },
    { role: 'contact', text: '你是不是创到别的区了', messageId: 'msg-2' },
    { role: 'me', text: '会不会是我输错区了', messageId: 'm_2' },
  ] } }
  const chatContext = buildChatContext({ accountId: 'a', contact, incoming: '你是不是创到别的区了', profile: profile() })
  assert.deepEqual(chatContext.incomingMessages.map(row => row.text), ['你是不是创到别的区了'])
  assert.deepEqual(chatContext.recentMessages.map(row => row.text), ['你好', '好呀', '会不会是我输错区了'])
})
