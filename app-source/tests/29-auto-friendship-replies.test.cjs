const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService, shouldSleepChatWindow } = require('../electron/automation.cjs')

const managed = (extra = {}) => ({ id: 'managed-1', name: '新朋友', preview: '你也养猫呀', fromMe: false, profile: { chatMode: 'friendship', useSelfPersona: true, autoFriendship: true, autoFriendshipUrl: 'https://www.douyin.com/user/managed' }, learning: { messages: [] }, turn: {}, ...extra })
function setup({ contact = managed(), enabled = true, autoReply = false, draftOnly = true, draft, send } = {}) {
  const storage = createMemoryStorage({ contacts: [contact], friendship: { automatic: { enabled } }, automation: { autoReply, paused: false, dailyLimit: 30, blacklist: [], aiDisabledContacts: [] }, settings: { showAiModelLabel: false, aiReplyDraftOnly: draftOnly, quietHours: false, longTermMemory: false } })
  const calls = { drafts: 0, sends: [] }
  const ai = { hasProvider: () => true, async draft() { calls.drafts++; return draft ? draft(storage) : { ok: true, text: '是呀' } } }
  const ds = new DouyinService({ storage, ai, partition: 'persist:auto-reply-test', emit() {} })
  ds.selectConversation = async () => null
  ds.isLastMessageFromMe = async () => false
  ds.friendshipAutomatic = { session: 1 }
  ds.sendMessage = async (name, text, metadata) => {
    if (send) return send({ name, text, metadata, storage, calls })
    await metadata.beforeSubmit?.()
    calls.sends.push({ name, text, metadata })
  }
  const ctx = { settings: storage.get().settings, contacts: [contact], today: '2026-10-10', factCandidates: [], topicCandidates: [], autoReplyOn: autoReply, blacklist: new Set(), aiDisabledContacts: new Set(), canSend: () => true }
  const item = { name: contact.name, key: 'incoming-1', preview: contact.preview, incomingIdentity: { role: 'contact' }, enqueuedAt: Date.now() }
  ds.enqueueIncoming(item)
  return { ds, storage, calls, ctx, item, contact }
}

test('automatic friends collect new replies while global reply is off; ordinary friends do not', async () => {
  const fixture = setup()
  fixture.ds.incomingQueueMap().clear()
  fixture.ds.lastSeen.set('新朋友', 'older')
  const old = { ...managed(), id: 'old', name: '老朋友', profile: { chatMode: 'old_friend' } }
  fixture.storage.update({ contacts: [fixture.contact, old] })
  fixture.ds.lastSeen.set(old.name, 'older')
  await fixture.ds.collectIncoming([fixture.contact, old], fixture.ctx)
  assert.deepEqual([...fixture.ds.incomingQueueMap().keys()], ['新朋友'])
})

test('automatic friend bypasses global draft mode and sends through a fresh beforeSubmit gate', async () => {
  const { ds, calls, ctx, item, contact, storage } = setup()
  assert.equal(await ds.handleIncomingItem(item, contact, ctx), 'consumed')
  assert.equal(calls.sends.length, 1)
  assert.equal(typeof calls.sends[0].metadata.beforeSubmit, 'function')
  assert.equal(calls.sends[0].metadata.autoFriendship, true)
  assert.equal(storage.get().pendingDrafts.length, 0)
})

test('ordinary friend continues to use global draft mode', async () => {
  const { ds, calls, ctx, item, contact, storage } = setup({ contact: managed({ profile: { chatMode: 'old_friend' } }), autoReply: true })
  assert.equal(await ds.handleIncomingItem(item, contact, ctx), 'consumed')
  assert.equal(calls.sends.length, 0)
  assert.equal(storage.get().pendingDrafts.length, 1)
})

test('closed automatic switch holds existing queue even when global replies remain enabled', async () => {
  const { ds, ctx, item, contact, calls } = setup({ enabled: false, autoReply: true })
  assert.equal(ds.planIncomingQueue(ctx)[0].reason, 'auto_friendship_disabled')
  assert.equal(await ds.handleIncomingItem(item, contact, ctx), 'deferred')
  assert.equal(calls.drafts + calls.sends.length, 0)
  assert.equal(ds.incomingQueueMap().size, 1)
})

test('changing an automatic friend to old-friend mode restores the ordinary global reply switch', async () => {
  const contact = managed({ profile: { ...managed().profile, chatMode: 'old_friend' } })
  const fixture = setup({ contact, autoReply: false })
  assert.equal(fixture.ds.planIncomingQueue(fixture.ctx)[0].action, 'hold')
  fixture.storage.update({ automation: { autoReply: true } })
  assert.equal(fixture.ds.planIncomingQueue(fixture.ctx)[0].action, 'reply')
  assert.equal(await fixture.ds.handleIncomingItem(fixture.item, contact, fixture.ctx), 'consumed')
  assert.equal(fixture.calls.sends.length, 0)
  assert.equal(fixture.storage.get().pendingDrafts.length, 1)
})

test('switching automatic friendship off while AI is generating stops the reply without consuming it', async () => {
  const { ds, ctx, item, contact, storage, calls } = setup({ draft(storage) { storage.update({ friendship: { automatic: { enabled: false } } }); return { ok: true, text: '是呀' } } })
  assert.equal(await ds.handleIncomingItem(item, contact, ctx), 'deferred')
  assert.equal(calls.sends.length, 0)
  assert.equal(storage.get().pendingDrafts.length, 0)
  assert.equal(ds.incomingQueueMap().size, 1)
})

test('fresh submission gate catches switch changes after drafting and immediately before send', async () => {
  const { ds, ctx, item, contact, calls } = setup({ async send({ storage, metadata, calls }) { storage.update({ friendship: { automatic: { enabled: false } } }); await metadata.beforeSubmit(); calls.sends.push('sent') } })
  assert.equal(await ds.handleIncomingItem(item, contact, ctx), 'deferred')
  assert.equal(calls.sends.length, 0)
})

test('fresh submission gate rejects pause, AI off, blacklist, quiet hours, frequency, limits and changed identity', () => {
  const alterations = [
    f => f.storage.update({ automation: { paused: true } }),
    f => f.storage.update({ automation: { aiDisabledContacts: ['新朋友'] } }),
    f => f.storage.update({ automation: { blacklist: ['新朋友'] } }),
    f => f.storage.update({ settings: { quietHours: true, quietStart: '00:00', quietEnd: '00:00' } }),
    f => f.storage.update({ contacts: [{ ...f.contact, profile: { ...f.contact.profile, aiEnabled: false } }] }),
    f => f.storage.update({ contacts: [{ ...f.contact, id: 'changed' }] }),
    f => { f.ds.friendshipAutomatic.session++; },
    f => { f.storage.update({ contacts: [{ ...f.contact, profile: { ...f.contact.profile, frequency: '60s' } }] }); f.ds.lastReplyTime.set('新朋友', Date.now()) },
    f => f.storage.update({ sendHistory: Array.from({ length: 30 }, () => ({ name: '其他人', at: new Date().toISOString() })) }),
  ]
  for (const alter of alterations) {
    const f = setup()
    alter(f)
    assert.throws(() => f.ds.assertAutoFriendshipReply('新朋友', f.contact, 1), error => error.stopped === true)
  }
})

test('uncertain automatic send consumes the input and durably suspends that contact instead of retrying', async () => {
  const { ds, storage, ctx, item, contact, calls } = setup({ async send() { const error = new Error('delivery uncertain'); error.sendAttempted = true; throw error } })
  assert.equal(await ds.handleIncomingItem(item, contact, ctx), 'consumed')
  assert.equal(storage.get().contacts[0].profile.autoFriendshipSuspended, true)
  assert.equal(ds.incomingQueueMap().size, 0)
  assert.equal(storage.get().contacts[0].turn.lastHandledKey, item.key)
  assert.equal(storage.get().logs.some(log => log.type === 'auto_friendship_reply_uncertain'), true)
  ds.enqueueIncoming({ ...item, key: 'another-input' })
  assert.equal(ds.planIncomingQueue(ctx)[0].action, 'hold')
  assert.equal(calls.sends.length, 0)
})

test('safe failure before submission leaves automatic reply queued without suspension', async () => {
  const { ds, storage, ctx, item, contact } = setup({ async send() { const error = new Error('missing editor'); error.sendAttempted = false; throw error } })
  assert.equal(await ds.handleIncomingItem(item, contact, ctx), 'deferred')
  assert.notEqual(storage.get().contacts[0].profile.autoFriendshipSuspended, true)
  assert.equal(ds.incomingQueueMap().size, 1)
})

test('automatic friendship reply work keeps the chat window awake with global reply disabled', () => {
  assert.equal(shouldSleepChatWindow({ config: { autoReply: false }, settings: { autoFriendshipReplies: true } }), false)
  assert.equal(shouldSleepChatWindow({ config: { autoReply: false }, settings: {} }), true)
})

test('first stranger greeting suppresses native contact discovery until its send is confirmed', async () => {
  const { ds } = setup()
  ds.friendshipGreetingInProgress = true
  ds.getStatus = async () => { throw new Error('must not inspect or discover contacts during first greeting') }
  await ds.runAutomation()
})

function editorFixture() {
  const editor = { innerText: '你好呀' }
  const calls = { clicks: 0 }
  const outgoing = []
  const button = { getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 40 }), getAttribute: () => null, contains: () => false, dispatchEvent() { calls.clicks++; outgoing.push({ innerText: editor.innerText, closest: () => ({ classList: { contains: () => true } }) }); editor.innerText = '' } }
  const document = { querySelector: () => editor, querySelectorAll: selector => selector.includes('MessageBoxContentrowBox') ? outgoing : [button], defaultView: {} }
  const context = vm.createContext({ document, recipientVerified: true, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MouseEvent: class { constructor(type) { this.type = type } } })
  const win = { webContents: { executeJavaScript: async script => vm.runInContext(script, context) } }
  return { win, context, calls }
}

test('custom recipient proof shares single-click delivery confirmation and main-process rechecks', async () => {
  const { win, calls } = editorFixture()
  let verified = 0
  await DouyinService.prototype.sendCurrentInput.call({}, win, { targetCheckScript: 'recipientVerified === true', assertTarget: async () => { verified++ } })
  assert.equal(calls.clicks, 1)
  assert.equal(verified >= 3, true)
})

test('custom renderer recipient proof rejects a changed stranger before the only send click', async () => {
  const { win, calls, context } = editorFixture()
  context.recipientVerified = false
  await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win, { targetCheckScript: 'recipientVerified === true', assertTarget: async () => {} }), error => error.sendAttempted === false)
  assert.equal(calls.clicks, 0)
})

test('custom main-process recipient assertion prevents submission', async () => {
  const { win, calls } = editorFixture()
  await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win, { targetCheckScript: 'true', assertTarget: async () => { throw new Error('recipient changed') } }), error => error.sendAttempted === false)
  assert.equal(calls.clicks, 0)
})

test('changing the automatic gate after reading the input still prevents the final click', async () => {
  const { win, calls } = editorFixture()
  let assertions = 0
  await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win, { targetCheckScript: 'true', assertTarget: async () => {
    if (++assertions === 2) throw new Error('automatic friendship switched off during input inspection')
  } }), error => error.sendAttempted === false)
  assert.equal(assertions, 2)
  assert.equal(calls.clicks, 0)
})
