const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService, reconcileConversationContacts, extractPlatformIdentity, conversationIdentityScript } = require('../electron/automation.cjs')
const { ConversationSyncManager } = require('../electron/conversation-sync.cjs')
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const c = (over = {}) => ({ id: 'contact-a', name: '虚构朋友', preview: '你好呀', unread: true, sentAt: new Date().toISOString(),
  profile: {}, learning: { messages: [] }, turn: {}, ...over })

function fixture({ contacts = [c()], accountId = 'account-a', storage: savedStorage, visible = false, active, platformUserId = '', verified = false } = {}) {
  const storage = savedStorage || createMemoryStorage({ contacts })
  let now = 1_800_000_000_000
  const ds = new DouyinService({ storage, ai: {}, accountId, partition: `persist:${accountId}`, emit() {} })
  ds.conversationSyncManager = new ConversationSyncManager({ storage, accountId, clock: () => now })
  ds.conversationSyncManager.observe(storage.get().contacts)
  const state = { visible, active: active || contacts[0]?.name || '', platformUserId, verified, destroyed: false }
  const calls = { captures: 0, selects: 0, scans: 0, sends: 0, pageLoads: 0 }
  const win = { isVisible: () => state.visible, isDestroyed: () => state.destroyed, destroy() { state.destroyed = true },
    webContents: { getURL: () => 'https://www.douyin.com/chat', async executeJavaScript(script) {
      if (script.includes('isTargetMatch: platform.verified')) {
        const expected = script.match(/platform\.platformUserId === ("(?:[^"\\]|\\.)*")/)?.[1]
        return { isTargetMatch: state.verified && expected !== undefined && state.platformUserId === JSON.parse(expected), activeName: state.active, platformUserId: state.platformUserId }
      }
      if (script.includes('function activeChatIdentity')) return { verified: state.verified, platformUserId: state.platformUserId }
      if (script.includes('readConversationIdentity')) return { isTargetMatch: state.active === contacts[0]?.name, activeName: state.active }
      return true
    } } }
  ds.window = win
  ds.waitForChatReady = async () => win
  ds.waitForEditor = async () => {}
  ds.captureLatestIncomingMessageIdentity = async () => { calls.captures++; return { role: 'contact', fingerprint: 'real-inbound-1', messageId: 'real-inbound-1', message: { text: '你好呀', type: 'text', at: new Date().toISOString() } } }
  ds.sendMessage = async () => { calls.sends++; throw Error('test must never send') }
  const ctx = { contacts, settings: storage.get().settings, autoReplyOn: true, canSend: () => true, blacklist: new Set(), aiDisabledContacts: new Set(),
    today: '2026-10-14', factCandidates: [], topicCandidates: [], config: storage.get().automation }
  return { ds, storage, calls, state, win, ctx, manager: ds.conversationSyncManager, get now() { return now }, advance(ms) { now += ms } }
}

function unavailable(f) {
  f.ds.selectConversationCore = async () => { f.calls.selects++; const error = new Error('真实定位失败'); error.lookupFailure = true; throw error }
  f.ds.reconcileConversationList = async () => { f.calls.scans++; return { ok: true, steps: 0, contacts: [] } }
}

test('first unread recent ordinary text is queued only after confirming inbound role', async () => {
  const f = fixture(); await f.ds.collectIncoming(f.ctx.contacts, f.ctx)
  assert.equal(f.calls.captures, 1); assert.equal(f.ds.lastSeen.has('虚构朋友'), false)
  assert.equal(f.ds.incomingQueueMap().get('虚构朋友').incomingIdentity.role, 'contact')
})

test('first old ordinary history is only baselined, not opened or queued', async () => {
  const old = c({ unread: false, sentAt: '2025-01-01T00:00:00Z' }), f = fixture({ contacts: [old] })
  await f.ds.collectIncoming([old], f.ctx)
  assert.equal(f.calls.captures, 0); assert.ok(f.ds.lastSeen.has(old.name)); assert.equal(f.ds.incomingQueueMap().size, 0)
})

test('first unread with unknown timing remains unconsumed pending reliable context', async () => {
  const unknown = c({ sentAt: '', sentAtLabel: '' }), f = fixture({ contacts: [unknown] })
  await f.ds.collectIncoming([unknown], f.ctx)
  assert.equal(f.calls.captures, 0); assert.equal(f.ds.lastSeen.size, 0); assert.equal(f.ds.incomingQueueMap().size, 0)
})

test('unread old text is never promoted into a new first reply', async () => {
  const old = c({ sentAt: '2025-01-01T00:00:00Z' }), f = fixture({ contacts: [old] })
  await f.ds.collectIncoming([old], f.ctx)
  assert.equal(f.ds.lastSeen.size, 0); assert.equal(f.ds.incomingQueueMap().size, 0)
})

test('own first greeting cannot become an inbound first reply', async () => {
  const f = fixture(); f.ds.captureLatestIncomingMessageIdentity = async () => { f.calls.captures++; return { role: 'me', fingerprint: 'own-opening' } }
  await f.ds.collectIncoming(f.ctx.contacts, f.ctx)
  assert.equal(f.ds.incomingQueueMap().size, 0); assert.ok(f.ds.lastSeen.has('虚构朋友'))
})

test('first unread unknown sender remains unconsumed', async () => {
  const f = fixture(); f.ds.captureLatestIncomingMessageIdentity = async () => ({ role: null, fingerprint: 'unknown-role' })
  await f.ds.collectIncoming(f.ctx.contacts, f.ctx)
  assert.equal(f.ds.incomingQueueMap().size, 0); assert.equal(f.ds.lastSeen.size, 0)
})

for (const mode of ['global_off', 'blacklist', 'AI_disabled_list', 'AI_disabled_profile']) test(`${mode}: new text is neither captured nor consumed`, async () => {
  const f = fixture({ contacts: [c({ profile: mode === 'AI_disabled_profile' ? { aiEnabled: false } : {} })] })
  if (mode === 'global_off') f.ctx.autoReplyOn = false
  if (mode === 'blacklist') f.ctx.blacklist.add('虚构朋友')
  if (mode === 'AI_disabled_list') f.ctx.aiDisabledContacts.add('虚构朋友')
  await f.ds.collectIncoming(f.ctx.contacts, f.ctx)
  assert.equal(f.calls.captures, 0); assert.equal(f.ds.lastSeen.size, 0); assert.equal(f.ds.incomingQueueMap().size, 0)
})

test('one lookup attempt has at most one directed sync retry and one persisted failure', async () => {
  const f = fixture(); unavailable(f)
  await assert.rejects(f.ds.selectConversation('虚构朋友'), { code: 'CONVERSATION_SYNC_DEFERRED' })
  assert.equal(f.calls.selects, 2); assert.equal(f.calls.scans, 1)
  assert.equal(f.manager.getRecord('contact-a').attempts, 1); assert.equal(f.manager.getRecord('contact-a').nextRetryAt, f.now + 10000)
  await assert.rejects(f.ds.selectConversation('虚构朋友'), { code: 'CONVERSATION_SYNC_DEFERRED' })
  assert.equal(f.calls.selects, 2)
})

test('real repeated failures use 10s/30s/90s then NEEDS_REVIEW across restarts', async () => {
  const f = fixture(); unavailable(f)
  for (const delay of [10000, 30000, 90000]) {
    await assert.rejects(f.ds.selectConversation('虚构朋友'), { code: 'CONVERSATION_SYNC_DEFERRED' })
    assert.equal(f.manager.getRecord('contact-a').nextRetryAt - f.now, delay)
    f.advance(delay)
  }
  const restarted = fixture({ storage: f.storage }); restarted.manager.clock = () => f.now; unavailable(restarted)
  await assert.rejects(restarted.ds.selectConversation('虚构朋友'), { code: 'CONVERSATION_SYNC_DEFERRED' })
  assert.equal(restarted.manager.getRecord('contact-a').attempts, 4)
  assert.equal(restarted.manager.getRecord('contact-a').status, 'NEEDS_REVIEW')
  await assert.rejects(restarted.ds.selectConversation('虚构朋友'), { code: 'CONVERSATION_SYNC_DEFERRED' })
  assert.equal(restarted.calls.selects, 2)
})

test('verified new current inbound clears backoff; replay of the same ID cannot clear a later failure', async () => {
  const f = fixture(); f.manager.failure('contact-a', { reason: 'not_found' })
  await f.ds.collectIncoming(f.ctx.contacts, f.ctx)
  assert.equal(f.manager.getRecord('contact-a').attempts, 0); assert.ok(f.ds.incomingQueueMap().has('虚构朋友'))
  f.manager.failure('contact-a', { reason: 'not_found_again' }); await f.ds.collectIncoming(f.ctx.contacts, f.ctx)
  assert.equal(f.manager.getRecord('contact-a').attempts, 1)
})

test('changing unverified preview and relative time cannot reopen failed binding', async () => {
  const f = fixture({ active: '其他人' }); f.manager.failure('contact-a', { reason: 'not_found' })
  for (const preview of ['新预览', '又一个预览']) await f.ds.collectIncoming([c({ preview, sentAtLabel: '刚刚' })], f.ctx)
  assert.equal(f.manager.getRecord('contact-a').attempts, 1); assert.equal(f.calls.captures, 0)
})

test('visible different target remains in queue without consuming retry budget', async () => {
  const f = fixture({ visible: true, active: '本人正在看的其他人' })
  await assert.rejects(f.ds.getChatWindowCoordinator().run('automation', () => f.ds.selectConversation('虚构朋友')), { code: 'CHAT_WINDOW_MANUAL_CONTROL' })
  assert.equal(f.manager.getRecord('contact-a').attempts, 0); assert.equal(f.ds.lastSeen.size, 0)
})

test('unknown-ID ordinary contact can still chat during low-frequency identity sync deferral', async () => {
  const f = fixture(); f.manager.defer('contact-a', 'identity_unknown')
  assert.equal(f.manager.canAttempt('contact-a'), false)
  f.ds.selectConversationCore = async () => { f.calls.selects++; return f.win }
  assert.equal(await f.ds.selectConversation('虚构朋友'), f.win)
  await f.ds.collectIncoming(f.ctx.contacts, f.ctx)
  assert.ok(f.ds.incomingQueueMap().has('虚构朋友')); assert.equal(f.manager.getRecord('contact-a').status === 'READY', false)
})

test('candidate pipeline cannot use ordinary unique-name compatibility', async () => {
  const f = fixture({ contacts: [c({ profile: { contactPipeline: true, autoFriendship: true, platformUserId: 'candidate-id' } })] })
  f.manager.defer('contact-a', 'identity_unknown')
  await assert.rejects(f.ds.selectConversation('虚构朋友'), { code: 'CONVERSATION_SYNC_DEFERRED' }); assert.equal(f.calls.selects, 0)
})

test('verified ID rename keeps stable contact ID, profile and memory while recording alias', () => {
  const old = c({ name: '旧昵称', avatar: 'old-avatar', profile: { platformUserId: 'pid-A', dmIdentityVerified: true, notes: '保留' }, learning: { messages: [{ role: 'contact', text: '真实旧记录' }] } })
  const fresh = { id: 'douyin:pid-A', name: '新昵称', avatar: 'different-avatar', profile: { platformUserId: 'pid-A', dmIdentityVerified: true } }
  const result = reconcileConversationContacts([old], [fresh])
  assert.equal(result.contacts.length, 1); assert.equal(result.contacts[0].id, old.id); assert.equal(result.contacts[0].profile.notes, '保留')
  assert.equal(result.contacts[0].learning.messages[0].text, '真实旧记录'); assert.deepEqual(result.contacts[0].profile.conversationAliases, ['旧昵称'])
  assert.equal(result.renamed['旧昵称'], '新昵称')
})

test('same nickname with different IDs stays isolated and blocks name-based selection', async () => {
  const old = c({ profile: { platformUserId: 'pid-A', dmIdentityVerified: true }, learning: { messages: [{ role: 'contact', text: 'A私有记忆' }] } })
  const fresh = { id: 'douyin:pid-B', name: old.name, profile: { platformUserId: 'pid-B', dmIdentityVerified: true } }
  const result = reconcileConversationContacts([old], [fresh]), f = fixture({ contacts: result.contacts })
  assert.equal(result.contacts.length, 2); assert.ok(result.contacts.every(item => item.conversationIdentityAmbiguous))
  assert.equal(result.contacts.find(item => item.id === 'douyin:pid-B').learning, undefined)
  await assert.rejects(f.ds.selectConversation(old.name), { code: 'CONVERSATION_SYNC_DEFERRED' }); assert.equal(f.calls.selects, 0)
})

test('unverified same-name duplicates do not grow or merge old memories on every poll', () => {
  const fresh = [{ id: 'unknown-1', name: '同名' }, { id: 'unknown-2', name: '同名' }]
  const first = reconcileConversationContacts([], fresh)
  const again = reconcileConversationContacts(first.contacts, fresh)
  assert.equal(first.contacts.length, 2); assert.equal(again.contacts.length, 2); assert.ok(again.contacts.every(item => item.conversationIdentityAmbiguous))
})

test('row identity extraction rejects arbitrary numeric IDs and foreign profile links', () => {
  const fake = { 'data-id': '1234', innerText: '某昵称', querySelectorAll: () => [{ getAttribute: () => 'https://evil.test/user/pretend' }] }
  assert.equal(extractPlatformIdentity(fake).verified, false)
  const real = { querySelectorAll: () => [{ getAttribute: () => 'https://www.douyin.com/user/public-id' }] }
  assert.equal(extractPlatformIdentity(real).platformUserId, 'public-id')
})

test('row own React participant proof is accepted but unrelated ancestor current chat is ignored', () => {
  const row = { querySelectorAll: () => [], __reactProps$test: { conversation: { toParticipantSecUserId: 'participant-A' } } }
  assert.equal(extractPlatformIdentity(row).platformUserId, 'participant-A')
  const ancestor = { querySelectorAll: () => [], __reactFiber$test: { memoizedProps: {}, return: { memoizedProps: { curConversation: { toParticipantSecUserId: 'unrelated-active' } } } } }
  assert.equal(extractPlatformIdentity(ancestor).verified, false)
})

function scrollFixture(options = {}) {
  const f = fixture(options), container = { scrollTop: 35, scrollHeight: 10000, clientHeight: 100, querySelectorAll: () => [] }
  const document = { querySelector: () => container }
  let syncCalls = 0
  f.win.webContents.executeJavaScript = async script => vm.runInNewContext(script, { document })
  f.ds.syncContacts = async () => { syncCalls++; return { contacts: [], visibleContacts: Array.from({ length: 10 }, (_, n) => ({ id: `row-${syncCalls}-${n}`, name: `row-${syncCalls}-${n}` })) } }
  return { ...f, container, syncCalls: () => syncCalls }
}

test('idle reconciliation is capped at five scroll steps and restores hidden list position', async () => {
  const f = scrollFixture(), selected = f.ds.selectConversationCore
  f.ds.selectConversationCore = async () => { throw Error('scan must never select') }
  const result = await f.ds.reconcileConversationList({ maxSteps: 999, maxContacts: 999 })
  assert.ok(result.steps <= 5); assert.ok(result.contacts.length <= 100); assert.ok(f.syncCalls() <= 6); assert.equal(f.container.scrollTop, 35)
  assert.equal(f.calls.sends, 0); f.ds.selectConversationCore = selected
})

test('reconciliation stops and does not restore scroll after window becomes visible', async () => {
  const f = scrollFixture()
  f.ds.syncContacts = async () => { f.state.visible = true; return { contacts: [], visibleContacts: [] } }
  const result = await f.ds.reconcileConversationList()
  assert.equal(result.deferred, true); assert.equal(f.container.scrollTop, 0); assert.equal(result.steps, 1)
})

test('visible window reconciliation does not touch the DOM or select a contact', async () => {
  const f = scrollFixture({ visible: true }); f.win.webContents.executeJavaScript = async () => { throw Error('visible scan must not touch DOM') }
  const result = await f.ds.reconcileConversationList(); assert.equal(result.deferred, true); assert.equal(f.container.scrollTop, 35)
})

test('reconciliation never reloads a non-chat page', async () => {
  const f = scrollFixture(); f.win.webContents.getURL = () => 'https://www.douyin.com/user/somebody'
  const result = await f.ds.reconcileConversationList(); assert.equal(result.reason, 'chat_page_not_ready'); assert.equal(f.syncCalls(), 0)
})

test('follow without a conversation remains pending and only requests low-frequency reconciliation', async () => {
  const f = fixture(); f.ds.requestConversationSync({ reason: 'follow_confirmed', platformUserId: 'no-conversation', eventKey: 'confirmed-follow' })
  f.ds.reconcileConversationList = async () => { f.calls.scans++; return { ok: true } }
  await f.ds.processConversationSync(); await f.ds.processConversationSync()
  assert.equal(f.calls.scans, 1); assert.ok(f.manager.state().pending.some(item => item.platformUserId === 'no-conversation' && !item.contactId))
  assert.equal(f.calls.sends, 0); assert.ok(f.manager.state().records.every(item => !item.attempts))
})

test('event requests deduplicate and reject another account without writes', () => {
  const f = fixture(), payload = { reason: 'opening_confirmed', contactId: 'contact-a', eventKey: 'same-opening' }
  f.ds.requestConversationSync(payload); f.ds.requestConversationSync(payload)
  assert.equal(f.manager.state().pending.filter(item => item.reason === 'opening_confirmed').length, 1)
  const before = JSON.stringify(f.storage.get().conversationSync)
  assert.equal(f.ds.requestConversationSync({ ...payload, accountId: 'other-account' }).ok, false)
  assert.equal(JSON.stringify(f.storage.get().conversationSync), before)
})

test('two instances preserve fully separate pending events and retry budgets', () => {
  const storage = createMemoryStorage({ contacts: [c()] }), a = fixture({ storage, accountId: 'a' }), b = fixture({ storage, accountId: 'b' })
  a.ds.requestConversationSync({ reason: 'opening_confirmed', contactId: 'contact-a', eventKey: 'a-opening' }); a.manager.failure('contact-a')
  assert.equal(a.manager.getRecord('contact-a').attempts, 1); assert.equal(b.manager.getRecord('contact-a').attempts, 0)
  assert.equal(b.manager.state().pending.some(item => item.reason === 'opening_confirmed'), false)
})

test('manual visible refresh restores NEEDS_REVIEW only after real matching ID proof', async () => {
  const contact = c({ profile: { platformUserId: 'pid-A', dmIdentityVerified: true } }), f = fixture({ contacts: [contact], visible: true, platformUserId: 'pid-A', verified: true })
  for (let n = 0; n < 4; n++) { f.manager.failure(contact.id, { evidenceKey: `real-attempt-${n}` }); f.advance(100000) }
  assert.equal(f.manager.getRecord(contact.id).status, 'NEEDS_REVIEW')
  f.ds.syncContacts = async () => ({ contacts: [contact] })
  await f.ds.refreshConversationBinding(contact.id)
  assert.equal(f.manager.getRecord(contact.id).status, 'READY'); assert.equal(f.manager.getRecord(contact.id).attempts, 0); assert.equal(f.calls.sends, 0)
})

test('manual refresh wrong or unknown ID cannot restore exhausted binding', async () => {
  for (const proof of [{ verified: true, platformUserId: 'wrong-id' }, { verified: false, platformUserId: '' }]) {
    const contact = c({ profile: { platformUserId: 'pid-A', dmIdentityVerified: true } }), f = fixture({ contacts: [contact], visible: true, ...proof })
    for (let n = 0; n < 4; n++) { f.manager.failure(contact.id, { evidenceKey: `attempt-${n}` }); f.advance(100000) }
    f.ds.syncContacts = async () => ({ contacts: [contact] })
    await f.ds.refreshConversationBinding(contact.id)
    assert.equal(f.manager.getRecord(contact.id).status, 'NEEDS_REVIEW'); assert.equal(f.manager.getRecord(contact.id).attempts, 4)
  }
})

test('late identity response after destruction cannot bind or write a profile', async () => {
  const contact = c({ profile: { platformUserId: 'pid-A' } }), f = fixture({ contacts: [contact] }), started = latch(), finish = latch()
  f.win.webContents.executeJavaScript = async () => { started.resolve(); await finish.promise; return { verified: true, platformUserId: 'pid-A' } }
  const before = JSON.stringify(f.storage.get().contacts)
  const binding = f.ds.verifyConversationBinding(contact, f.win); await started.promise
  f.ds.destroy(); finish.resolve()
  await assert.rejects(binding, { code: 'CONVERSATION_SYNC_DEFERRED' }); assert.equal(JSON.stringify(f.storage.get().contacts), before)
})

test('failed/backoff queued items do not starve low-frequency reconciliation', async () => {
  const f = fixture(); f.ds.enqueueIncoming({ name: '虚构朋友', key: 'pending', enqueuedAt: Date.now() }); f.manager.failure('contact-a')
  f.ds.requestConversationSync({ reason: 'startup' }); f.ds.reconcileConversationList = async () => { f.calls.scans++; return { ok: true } }
  assert.equal(f.ds.conversationSyncIdle(f.ctx), true)
  await f.ds.processConversationSync({ idle: f.ds.conversationSyncIdle(f.ctx) })
  assert.equal(f.calls.scans, 1); assert.ok(f.ds.incomingQueueMap().has('虚构朋友'))
})

test('actionable new incoming or active burst quiet window postpones reconciliation', async () => {
  const f = fixture(); f.ds.enqueueIncoming({ name: '虚构朋友', key: 'pending', enqueuedAt: Date.now() })
  assert.equal(f.ds.conversationSyncIdle(f.ctx), false)
  f.ds.planIncomingQueue = () => [{ action: 'defer', reason: 'waiting_for_incoming_burst' }]
  assert.equal(f.ds.conversationSyncIdle(f.ctx), false)
  f.ds.requestConversationSync({ reason: 'startup' }); f.ds.reconcileConversationList = async () => { throw Error('active burst must win') }
  await f.ds.processConversationSync({ idle: f.ds.conversationSyncIdle(f.ctx) })
})

test('idle sync processes at most one target per round and leaves others pending', async () => {
  const contacts = ['a', 'b', 'c'].map(id => c({ id, name: id, profile: { platformUserId: `pid-${id}`, dmIdentityVerified: true } })), f = fixture({ contacts })
  f.ds.selectConversation = async () => { f.calls.selects++ }
  await f.ds.processConversationSync()
  assert.equal(f.calls.selects, 1); assert.ok(f.manager.state().pending.length >= 2)
})

test('name and platform identity are jointly checked in final same-renderer send script', () => {
  const script = conversationIdentityScript('虚构朋友', 'expected-id')
  assert.match(script, /activeChatIdentity/); assert.match(script, /platform\.platformUserId === "expected-id"/)
})
