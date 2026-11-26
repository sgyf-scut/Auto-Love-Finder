const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService, stableMessageFingerprint } = require('../electron/automation.cjs')
const { ConversationBuffer } = require('../electron/social-brain/conversation-buffer.cjs')

class FakeNode {
  constructor(tag = 'DIV', { classes = '', attrs = {}, text = '', rect, children = [] } = {}) {
    this.tagName = tag; this.className = classes; this.attrs = { ...attrs }; this.innerText = this.textContent = text
    this.children = children; this.rect = rect || { x: 260, y: 180, left: 260, top: 180, right: 460, bottom: 300, width: 200, height: 120 }
    for (const child of children) child.parentElement = this
    this.src = attrs.src || ''; this.currentSrc = this.src; this.poster = attrs.poster || ''; this.outerHTML = ''
  }
  getBoundingClientRect() { return this.rect }
  getAttribute(name) { return this.attrs[name] ?? null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  removeAttribute(name) { delete this.attrs[name] }
  scrollIntoView() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  matches(selector) {
    if (selector === '*') return true
    if (selector.startsWith('img:not')) return this.tagName === 'IMG' && !/avatar/i.test(this.className)
    if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase()
    const attr = selector.match(/^\[([^*\]=\s]+)(\*?=)?(?:"([^"]*)")?(?:\s+i)?\]$/)
    if (attr) { const value = attr[1] === 'class' ? this.className : this.attrs[attr[1]]; return value != null && (!attr[2] || (attr[2] === '*=' ? String(value).toLowerCase().includes(attr[3].toLowerCase()) : String(value) === attr[3])) }
    const tagged = selector.match(/^([a-z]+)(\[.*\])$/i)
    return tagged ? this.tagName === tagged[1].toUpperCase() && this.matches(tagged[2]) : false
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(s => s.trim())
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
    return all.filter(node => selectors.some(s => node.matches(s)))
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  closest(selector) { return selector.split(',').some(s => this.matches(s.trim())) ? this : this.parentElement?.closest(selector) || null }
}


function row(text, { id, role = 'contact', top = 180, children = [], classes = '' } = {}) {
  return new FakeNode('DIV', { text, classes: `MessageBoxContentrowBox ${role === 'me' ? 'right' : 'left'} ${classes}`,
    attrs: id ? { 'data-message-id': id } : {}, children,
    rect: { left: 260, top, width: 200, height: 60, bottom: top + 60 } })
}
function fixture(t, rows, { burst = false, draft } = {}) {
  const contact = { id: 'small-account', name: '测试联系人乙', preview: '你怎么不回话？', fromMe: false,
    profile: { chatMode: 'old_friend' }, learning: { messages: [] }, turn: {} }
  const storage = createMemoryStorage({ contacts: [contact], settings: { incomingBurstEnabled: burst,
    incomingBurstQuietWindowMs: 4000, incomingBurstMaxWindowMs: 15000, longTermMemory: false,
    showAiModelLabel: false, aiReplyDraftOnly: true, quietHours: false } })
  const calls = []
  const ds = new DouyinService({ storage, partition: 'persist:identity-test', emit() {}, ai: { hasProvider: () => true,
    analyzeConversation: messages => ({ messages }), async draft(input) { calls.push(input); return draft ? draft(input) : { ok: true, text: '刚忙完哈哈' } } } })
  const body = new FakeNode('BODY', { children: rows })
  const document = { querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s) }
  const context = { document, innerHeight: 900, window: { innerWidth: 1400 }, URL }
  const win = { isDestroyed: () => false, destroy() {}, webContents: { executeJavaScript: async script => vm.runInNewContext(script, context) } }
  ds.window = win
  ds.selectConversation = async () => win
  ds.waitForEditor = async () => true
  ds.assertConversationTarget = async () => true
  ds.isLastMessageFromMe = async () => (await ds.captureLatestIncomingMessageIdentity(contact.name, win))?.role === 'me'
  let now = Date.now()
  let timerId = 0
  const timers = new Map()
  ds.incomingBuffer = new ConversationBuffer({ namespace: ds.partition, clock: () => now,
    setTimer(fn, delay) { timers.set(++timerId, { fn, at: now + delay }); return timerId },
    clearTimer(id) { timers.delete(id) } })
  ds.bufferEpoch = 'identity-epoch'
  ds.burstObservedIds = new Map()
  const ctx = { settings: storage.get().settings, today: '2026-10-15', factCandidates: [], topicCandidates: [] }
  t.after(() => ds.destroy())
  return { ds, storage, calls, contact, win, rows, ctx,
    advance() { now += 5000; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } },
    append(message) { message.parentElement = body; body.children.push(message) },
    async pair() { return { history: await ds.captureVisibleMessages(win, { strict: true }), latest: await ds.captureLatestIncomingMessageIdentity(contact.name, win) } },
    async enqueue() { const latest = await ds.captureLatestIncomingMessageIdentity(contact.name, win); const item = { name: contact.name,
      key: latest.fingerprint, preview: latest.message.text, incomingIdentity: latest }; ds.enqueueIncoming(item); return item },
  }
}

// These tests execute BOTH production renderer readers against the same DOM.
// They deliberately do not stub the two readers with identical synthetic IDs.
test('identity: simple text has identical discovery and freshness fingerprints', async t => {
  const f = fixture(t, [row('你怎么不回话？')])
  const { history, latest } = await f.pair()
  assert.equal(history.at(-1).messageId, latest.fingerprint)
  assert.equal(latest.role, 'contact')
})
test('identity: same short text sent by owner does not change incoming ordinal', async t => {
  const f = fixture(t, [row('哈哈', { role: 'me', top: 80 }), row('哈哈')])
  const { history, latest } = await f.pair()
  assert.equal(history.at(-1).messageId, latest.fingerprint)
  assert.equal(latest.fallbackOrdinal, 0)
})
test('identity: offscreen historical repeated text contributes the same ordinal', async t => {
  const f = fixture(t, [row('你怎么不回话？', { top: -120 }), row('你怎么不回话？')])
  const { history, latest } = await f.pair()
  assert.notEqual(history[0].messageId, history[1].messageId)
  assert.equal(latest.fallbackOrdinal, 1)
  assert.equal(history.at(-1).messageId, latest.fingerprint)
})
test('identity: nested row wrappers do not create a second occurrence of one bubble', async t => {
  const child = row('哈哈', { top: 180 })
  const parent = row('哈哈', { top: 180, children: [child] })
  parent.className = 'MessageBoxContentcolumnBox left'
  const f = fixture(t, [parent])
  const { history, latest } = await f.pair()
  assert.equal(history.length, 1)
  assert.equal(latest.fallbackOrdinal, 0)
  assert.equal(history[0].messageId, latest.fingerprint)
})
test('identity: native message IDs keep repeated same-text sources distinct', async t => {
  const f = fixture(t, [row('哈哈', { id: 'native-one', top: 80 }), row('哈哈', { id: 'native-two' })])
  const { history, latest } = await f.pair()
  assert.notEqual(history[0].messageId, history[1].messageId)
  assert.equal(history[1].messageId, latest.fingerprint)
})
test('identity: quoted media and text keep the same row-bound identity', async t => {
  const image = new FakeNode('IMG', { classes: 'imageMsg', attrs: { src: 'https://cdn.test/a.jpg' } })
  const quote = new FakeNode('DIV', { classes: 'quotedMessage', text: '引用图片', children: [image] })
  const f = fixture(t, [row('引用图片\n这个怎么样', { children: [quote] })])
  const { history, latest } = await f.pair()
  assert.equal(history[0].messageId, latest.fingerprint)
  assert.equal(latest.message.text, '这个怎么样')
  assert.equal(latest.message.quote.mediaEvidence.urls[0], 'https://cdn.test/a.jpg')
})
test('identity: old repeated quote wording does not alter occurrence rules between readers', async t => {
  const quote = text => new FakeNode('DIV', { classes: 'quotedMessage', text })
  const f = fixture(t, [row('旧引用\n哈哈', { top: 80, children: [quote('旧引用')] }), row('新引用\n哈哈', { children: [quote('新引用')] })])
  const { history, latest } = await f.pair()
  assert.equal(history[1].messageId, latest.fingerprint)
  assert.notEqual(history[0].messageId, history[1].messageId)
})
test('identity: media captures use the same ID as the burst reader', async t => {
  const image = new FakeNode('IMG', { classes: 'sticker', attrs: { src: 'https://cdn.test/a.webp' } })
  const f = fixture(t, [row('', { children: [image] })])
  const { history, latest } = await f.pair()
  assert.equal(history[0].messageId, latest.fingerprint)
  assert.equal(latest.message.type, 'sticker')
  const rejected = await f.ds.captureLatestIncomingMedia(f.contact.name, { expectedMessageId: 'different-message' })
  assert.equal(rejected.reason, 'current_message_changed')
})
test('identity: latest owner bubble is consistently outgoing', async t => {
  const f = fixture(t, [row('我回完了', { role: 'me' })])
  const { history, latest } = await f.pair()
  assert.equal(history[0].role, 'me')
  assert.equal(latest.role, 'me')
  assert.equal(history[0].messageId, latest.fingerprint)
})
test('identity: conversation target checks still surround the latest DOM read', async t => {
  const f = fixture(t, [row('你好')])
  let checks = 0
  f.ds.assertConversationTarget = async () => { if (++checks === 2) throw Error('wrong recipient') }
  await assert.rejects(f.ds.captureLatestIncomingMessageIdentity(f.contact.name, f.win), /wrong recipient/)
})
test('identity: ordinary single-message path reaches AI exactly once', async t => {
  const f = fixture(t, [row('你怎么不回话？')])
  const item = await f.enqueue()
  assert.equal(await f.ds.handleIncomingItem(item, f.contact, f.ctx), 'consumed')
  assert.equal(f.calls.length, 1)
  assert.equal(f.storage.get().pendingDrafts.length, 1)
})
test('identity: unchanged repeated text burst reaches AI instead of deferring forever', async t => {
  const f = fixture(t, [row('你怎么不回话？', { top: -120 }), row('你怎么不回话？')], { burst: true })
  await f.ds.observeIncomingBurst(f.contact.name, f.win, { initial: true })
  f.advance()
  assert.equal(await f.ds.handleIncomingItem(f.ds.incomingQueueMap().get(f.contact.name), f.contact, f.ctx), 'consumed')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].currentIncomingBurst.messages.length, 2)
  assert.equal(f.storage.get().pendingDrafts.length, 1)
  assert.equal(f.storage.get().logs.some(log => log.detail?.reason === 'current_message_changed'), false)
})
test('identity: a genuinely different newest message keeps old single-message work deferred', async t => {
  const f = fixture(t, [row('第一句', { id: 'one' })])
  const item = await f.enqueue()
  f.append(row('第二句', { id: 'two', top: 260 }))
  assert.equal(await f.ds.handleIncomingItem(item, f.contact, f.ctx), 'deferred')
  assert.equal(f.calls.length, 0)
  assert.equal(f.storage.get().pendingDrafts.length, 0)
  assert.equal(f.storage.get().logs[0].detail.reason, 'current_message_changed')
})
test('identity: new DOM message during burst generation invalidates the reply', async t => {
  let f
  f = fixture(t, [row('第一句', { id: 'one' })], { burst: true, draft() {
    f.append(row('第二句', { id: 'two', top: 260 })); return { ok: true, text: '过时回复' }
  } })
  await f.ds.observeIncomingBurst(f.contact.name, f.win, { initial: true })
  f.advance()
  assert.equal(await f.ds.handleIncomingItem(f.ds.incomingQueueMap().get(f.contact.name), f.contact, f.ctx), 'deferred')
  assert.equal(f.storage.get().pendingDrafts.length, 0)
  assert.equal(f.ds.aiBackoff.size, 0)
  const newId = stableMessageFingerprint({ role: 'contact', text: '第二句', ids: ['two'] })
  assert.equal(f.ds.incomingQueueMap().get(f.contact.name).incomingIdentity.messageId, newId)
})
