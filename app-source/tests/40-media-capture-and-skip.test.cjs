const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService, mergeMessageHistory, normalizeCapturedMedia, normalizeHistoryMessage, readVisibleMessageEvidence } = require('../electron/automation.cjs')

function incomingFixture({ preview = '行', draft = { ok: true, skipped: true, reason: 'conversation_finished', text: '不应发送' }, media } = {}) {
  const contact = { id: 'friend', name: '朋友', preview, fromMe: false, profile: { chatMode: 'old_friend' }, learning: { messages: [] }, turn: {} }
  const storage = createMemoryStorage({ contacts: [contact], settings: { showAiModelLabel: false, aiReplyDraftOnly: true, quietHours: false, longTermMemory: false } })
  const calls = { draft: [], sends: [] }
  const ds = new DouyinService({ storage, ai: { hasProvider: () => true, async draft(input) { calls.draft.push(input); return draft } }, partition: 'media-skip-test', emit() {} })
  ds.selectConversation = async () => null
  ds.isLastMessageFromMe = async () => false
  ds.sendMessage = async (...args) => calls.sends.push(args)
  if (media) ds.captureLatestIncomingMedia = async () => media
  const item = { name: contact.name, key: 'incoming-key', preview, incomingIdentity: { role: 'contact', messageId: 'current-id', fingerprint: 'current-id' } }
  ds.enqueueIncoming(item)
  const ctx = { settings: storage.get().settings, today: '2026-10-12', factCandidates: [], topicCandidates: [] }
  return { ds, contact, storage, calls, item, ctx }
}

test('NO_REPLY consumes its message, ignores any text, clears backoff and records a reason', async () => {
  const f = incomingFixture()
  f.ds.aiBackoff.set('朋友', { step: 1, retryAt: 0 })
  assert.equal(await f.ds.handleIncomingItem(f.item, f.contact, f.ctx), 'consumed')
  assert.equal(f.ds.incomingQueueMap().size, 0)
  assert.equal(f.ds.lastSeen.get('朋友'), 'incoming-key')
  assert.equal(f.storage.get().contacts[0].turn.lastHandledKey, 'incoming-key')
  assert.equal(f.ds.aiBackoff.has('朋友'), false)
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.storage.get().pendingDrafts.length, 0)
  assert.equal(f.storage.get().logs.find(log => log.type === 'ai_reply_skipped')?.detail?.reason, 'conversation_finished')
  // Re-discovery of the same consumed input is suppressed before another AI call.
  assert.equal(await f.ds.handleIncomingItem(f.item, f.contact, f.ctx), 'consumed')
  assert.equal(f.calls.draft.length, 1)
  f.ds.destroy()
})

test('an ordinary empty AI response remains queued for retry', async () => {
  const f = incomingFixture({ draft: { ok: false, text: '' } })
  assert.equal(await f.ds.handleIncomingItem(f.item, f.contact, f.ctx), 'deferred')
  assert.equal(f.ds.incomingQueueMap().size, 1)
  assert.ok(f.ds.incomingQueueMap().get('朋友').deferUntil > Date.now())
  assert.notEqual(f.ds.lastSeen.get('朋友'), 'incoming-key')
  f.ds.destroy()
})

test('failed media evidence reaches the draft even when only text fallback is usable', async () => {
  const f = incomingFixture({ preview: '[图片] 这是啥呀', media: { frames: [], mediaKind: 'image', capturedMessageId: 'current-id',
    captureEvidence: { source: 'visible_message_dom', status: 'failed', reason: 'current_message_changed' }, reason: 'current_message_changed' } })
  await f.ds.handleIncomingItem(f.item, f.contact, f.ctx)
  assert.equal(f.calls.draft[0].incomingMeta.messageId, 'current-id')
  assert.equal(f.calls.draft[0].videoFrames.captureEvidence.status, 'failed')
  assert.equal(f.calls.draft[0].videoFrames.capturedMessageId, 'current-id')
  f.ds.destroy()
})

test('text messages keep the ordinary draft contract without fabricated media', async () => {
  const f = incomingFixture({ draft: { ok: true, text: '行呀' } })
  await f.ds.handleIncomingItem(f.item, f.contact, f.ctx)
  assert.equal(f.calls.draft[0].videoFrames, undefined)
  assert.equal(f.calls.draft[0].incomingMeta.type, 'text')
  assert.equal(f.storage.get().pendingDrafts[0].text, '行呀')
  f.ds.destroy()
})

test('pure media rows survive history normalization and different IDs avoid text deduplication', () => {
  const media = { text: '', role: 'contact', type: 'sticker', mediaKind: 'sticker', mediaEvidence: { source: 'visible_message_dom', urls: ['https://cdn.test/same.webp'], alt: '狗头' } }
  const first = { ...media, messageId: 'sticker-one' }, second = { ...media, messageId: 'sticker-two' }
  assert.equal(mergeMessageHistory([first], [second]).length, 2)
  assert.equal(mergeMessageHistory([first], [first]).length, 1)
  assert.equal(normalizeHistoryMessage(first).type, 'sticker')
  assert.equal(normalizeHistoryMessage({ ...media, mediaEvidence: { urls: ['https://cdn.test/same.webp'] } }).mediaEvidence, undefined)
})

test('recordConversationMessage retains quote separately and pure-media evidence', () => {
  const f = incomingFixture()
  f.ds.recordConversationMessage('朋友', 'contact', '', {}, { type: 'image', messageId: 'img-one', mediaEvidence: { source: 'visible_message_dom', urls: ['https://cdn.test/a.jpg'] }, human: true })
  f.ds.recordConversationMessage('朋友', 'contact', '这不是我的', {}, { type: 'text', messageId: 'quote-one', quote: { source: 'visible_quote_dom', type: 'text', text: '我明天面试' }, human: true })
  const messages = f.storage.get().contacts[0].learning.messages
  assert.equal(messages[0].text, '')
  assert.equal(messages[0].messageId, 'img-one')
  assert.equal(messages[1].text, '这不是我的')
  assert.equal(messages[1].quote.text, '我明天面试')
  f.ds.destroy()
})

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

function browserFixture({ quote = false, gif = false, currentMedia = true, oldMedia = true } = {}) {
  const image = new FakeNode('IMG', { classes: gif ? 'gif' : 'imageMsg', attrs: { src: gif ? 'https://cdn.test/current.gif' : 'https://cdn.test/current.jpg', alt: '当前图' } })
  const quoteNode = quote ? new FakeNode('DIV', { classes: 'quotedMessage', text: '引用图片', children: [image] }) : null
  const avatar = new FakeNode('IMG', { classes: 'avatar', attrs: { src: 'https://cdn.test/avatar.jpg' } })
  const current = new FakeNode('DIV', { classes: 'MessageBoxContentrowBox left', attrs: { 'data-message-id': 'current-row', 'data-xusheng-latest-message': 'contact' }, text: quote ? '引用图片\n这是别人的' : '', children: [avatar, ...(currentMedia ? quote ? [quoteNode] : [image] : [])] })
  const old = new FakeNode('DIV', { classes: 'MessageBoxContentrowBox left', attrs: { 'data-message-id': 'old-row' }, children: oldMedia ? [new FakeNode('IMG', { classes: 'imageMsg', attrs: { src: 'https://cdn.test/old.jpg' } })] : [] })
  const body = new FakeNode('BODY', { children: [old, current] })
  const document = { body, querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s) }
  const context = { document, location: { href: 'https://www.douyin.com/chat', hostname: 'www.douyin.com' }, innerWidth: 1400, innerHeight: 900, window: { innerWidth: 1400 }, getComputedStyle: () => ({ backgroundImage: 'none' }), URL, console }
  const storage = createMemoryStorage()
  const captures = []
  const win = { isDestroyed: () => false, webContents: {
    executeJavaScript: async script => vm.runInNewContext(script, context),
    capturePage: async rect => { captures.push(rect); return { isEmpty: () => false, getSize: () => ({ width: 200, height: 120 }), toJPEG: () => Buffer.from('real-visible-frame') } },
  } }
  const ds = new DouyinService({ storage, partition: 'media-dom-test', emit() {} })
  ds.selectConversation = async () => win; ds.waitForEditor = async () => true; ds.injectMessageCaptureHook = async () => {}
  ds.captureLatestIncomingMessageIdentity = async () => ({ role: 'contact', fingerprint: 'current-fingerprint', messageId: 'current-fingerprint', message: readVisibleMessageEvidence(current) })
  ds.transcribeCapturedMediaAudio = async () => ({}); ds.readVideoCommentContext = async () => ({})
  return { ds, win, current, old, image, captures }
}

test('capture rejects a stale expected message before screenshotting the older picture', async () => {
  const f = browserFixture()
  const result = await f.ds.captureLatestIncomingMedia('朋友', { expectedMessageId: 'older-fingerprint', publicPageOnly: true })
  assert.equal(result.captureEvidence.status, 'failed')
  assert.equal(result.reason, 'current_message_changed')
  assert.equal(f.captures.length, 0)
  f.ds.destroy()
})

test('a current text row without media does not fall back to a historical image or avatar', async () => {
  const f = browserFixture({ currentMedia: false })
  const result = await f.ds.captureLatestIncomingMedia('朋友', { expectedMessageId: 'current-fingerprint', publicPageOnly: true })
  assert.equal(result.captureEvidence.status, 'failed')
  assert.equal(f.captures.length, 0)
  f.ds.destroy()
})

test('image captures only its visible rectangle in public-page video mode', async () => {
  const f = browserFixture()
  const result = await f.ds.captureLatestIncomingMedia('朋友', { expectedMessageId: 'current-fingerprint', publicPageOnly: true, maxFrames: 1 })
  assert.equal(result.frames.length, 1)
  assert.equal(result.mediaKind, 'image')
  assert.equal(result.capturedMessageId, 'current-fingerprint')
  assert.equal(result.captureEvidence.status, 'bound')
  assert.deepEqual(JSON.parse(JSON.stringify(f.captures[0])), { x: 260, y: 180, width: 200, height: 120 })
  assert.deepEqual(result.mediaEvidence.urls, ['https://cdn.test/current.jpg'])
  f.ds.destroy()
})

test('quoted image capture preserves the current utterance and labels the quote target', async () => {
  const f = browserFixture({ quote: true })
  const result = await f.ds.captureLatestIncomingMedia('朋友', { expectedMessageId: 'current-fingerprint', publicPageOnly: true, maxFrames: 1 })
  assert.equal(result.frames.length, 1)
  assert.equal(result.originalText, '这是别人的')
  assert.equal(result.quote.type, 'image')
  assert.equal(result.captureEvidence.target, 'quote_media')
  assert.equal(readVisibleMessageEvidence(f.current).type, 'text')
  assert.equal(readVisibleMessageEvidence(f.current).mediaEvidence, undefined)
  f.ds.destroy()
})

test('GIF visible-frame fallback honestly reports current_frame_only', async () => {
  const f = browserFixture({ gif: true })
  const result = await f.ds.captureLatestIncomingMedia('朋友', { expectedMessageId: 'current-fingerprint', publicPageOnly: true, maxFrames: 3 })
  assert.equal(result.mediaKind, 'gif')
  assert.equal(result.frames.length, 1)
  assert.equal(result.frameCoverage, 'current_frame_only')
  f.ds.destroy()
})

test('visible history includes textless image rows with stable and distinct DOM IDs', async () => {
  const f = browserFixture()
  const first = await f.ds.captureVisibleMessages(f.win)
  const second = await f.ds.captureVisibleMessages(f.win)
  assert.equal(first.length, 2)
  assert.equal(first[0].text, '')
  assert.equal(first[1].type, 'image')
  assert.notEqual(first[0].messageId, first[1].messageId)
  assert.equal(first[1].messageId, second[1].messageId)
  assert.deepEqual(first[1].mediaEvidence.urls, ['https://cdn.test/current.jpg'])
  f.ds.destroy()
})

test('repeated identical media without platform IDs remain distinct visible messages', async () => {
  const f = browserFixture()
  f.current.removeAttribute('data-message-id'); f.old.removeAttribute('data-message-id')
  const oldImage = f.old.querySelector('img')
  oldImage.src = oldImage.currentSrc = f.image.src
  const messages = await f.ds.captureVisibleMessages(f.win)
  assert.equal(messages.length, 2)
  assert.notEqual(messages[0].messageId, messages[1].messageId)
  assert.equal(mergeMessageHistory([messages[0]], [messages[1]]).length, 2)
  f.ds.destroy()
})

test('quoted-image handler sends text and quote separately with the same captured ID', async () => {
  const f = browserFixture({ quote: true })
  const contact = { id: 'friend', name: '朋友', preview: '这是别人的', fromMe: false, profile: { chatMode: 'old_friend' }, learning: { messages: [] }, turn: {} }
  f.ds.storage.update({ contacts: [contact], settings: { quietHours: false, longTermMemory: false, showAiModelLabel: false, aiReplyDraftOnly: true } })
  let draftInput
  f.ds.ai = { hasProvider: () => true, analyzeConversation: messages => ({ messages }), draft: async input => { draftInput = input; return { ok: true, skipped: true } } }
  const item = { name: '朋友', key: 'quoted-key', preview: contact.preview, incomingIdentity: { role: 'contact', messageId: 'current-fingerprint', fingerprint: 'current-fingerprint', message: readVisibleMessageEvidence(f.current) } }
  f.ds.enqueueIncoming(item)
  assert.equal(await f.ds.handleIncomingItem(item, contact, { settings: f.ds.storage.get().settings, today: '2026-10-12', factCandidates: [], topicCandidates: [] }), 'consumed')
  assert.equal(draftInput.incoming, '这是别人的')
  assert.equal(draftInput.incomingMeta.type, 'text')
  assert.equal(draftInput.incomingMeta.quote.type, 'image')
  assert.equal(draftInput.incomingMeta.messageId, draftInput.videoFrames.capturedMessageId)
  assert.equal(draftInput.videoFrames.captureEvidence.target, 'quote_media')
  f.ds.destroy()
})

test('video card in public-page mode keeps public context and never captures its poster', async () => {
  const f = browserFixture()
  f.image.className = 'ShareAwemeCover'
  f.image.setAttribute('data-aweme-id', '7694341619104976182')
  f.ds.readVideoCommentContext = async () => ({ videoPageDescription: '视频真实文案', videoComments: ['公开评论'] })
  const result = await f.ds.captureLatestIncomingMedia('朋友', { expectedMessageId: 'current-fingerprint', publicPageOnly: true, maxFrames: 3 })
  assert.equal(result.detectedVideo, true)
  assert.equal(result.frames.length, 0)
  assert.equal(f.captures.length, 0)
  assert.equal(result.videoPageDescription, '视频真实文案')
  f.ds.destroy()
})

test('a row that changes before screenshot fails provenance without returning a frame', async () => {
  const f = browserFixture()
  const execute = f.win.webContents.executeJavaScript
  f.win.webContents.executeJavaScript = async script => {
    if (script.includes('const row = document.querySelector(\'[data-xusheng-media-capture="latest"]\')')) f.image.src = f.image.currentSrc = 'https://cdn.test/replaced.jpg'
    return execute(script)
  }
  const result = await f.ds.captureLatestIncomingMedia('朋友', { expectedMessageId: 'current-fingerprint', publicPageOnly: true, maxFrames: 1 })
  assert.equal(result.captureEvidence.status, 'failed')
  assert.equal(result.reason, 'current_message_changed')
  assert.equal(result.frames.length, 0)
  assert.equal(f.captures.length, 0)
  f.ds.destroy()
})

test('quote-only incoming uses a neutral placeholder instead of the quoted preview as a self-statement', async () => {
  const f = incomingFixture({ preview: '我明天面试' })
  f.item.incomingIdentity.message = { text: '', type: 'text', quote: { source: 'visible_quote_dom', type: 'text', text: '我明天面试' } }
  assert.equal(await f.ds.handleIncomingItem(f.item, f.contact, f.ctx), 'consumed')
  assert.equal(f.calls.draft[0].incoming, '[引用消息]')
  assert.equal(f.calls.draft[0].incomingMeta.quote.text, '我明天面试')
  assert.equal(f.storage.get().contacts[0].learning.messages[0].text, '')
  f.ds.destroy()
})

test('normalization retains real decoded-video metadata and quote provenance', () => {
  const result = normalizeCapturedMedia({ frames: ['data:image/jpeg;base64,YQ=='], mediaKind: 'video', decodedVideoFrames: 1, capturedMessageId: 'video-current', captureEvidence: { source: 'visible_message_dom', status: 'bound' }, frameCoverage: 'representative_frames' })
  assert.equal(result.detectedVideo, true)
  assert.equal(result.videoReady, true)
  assert.equal(result.frameCoverage, 'representative_frames')
  assert.equal(result.capturedMessageId, 'video-current')
})
