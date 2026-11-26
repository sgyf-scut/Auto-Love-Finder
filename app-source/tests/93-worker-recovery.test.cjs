const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { ChatWindowCoordinator } = require('../electron/chat-window-coordinator.cjs')
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const contact = (name, extra = {}) => ({ id: name, name, preview: `new ${name}`, unread: true, fromMe: false, profile: {}, learning: { messages: [] }, ...extra })
function fixture(t, contacts = []) {
  const storage = createMemoryStorage({ contacts, settings: { quietHours: false, incomingBurstEnabled: false } })
  const ds = new DouyinService({ storage, partition: 'persist:worker-recovery', emit() {} })
  ds.chatWindowCoordinator = new ChatWindowCoordinator({ timeoutMs: 15 })
  t.after(() => ds.destroy())
  return { ds, storage }
}
function readyRound(ds) {
  ds.getStatus = async () => ({ connected: true })
  ds.getConversationSyncManager = () => ({ due: () => ({ reconcile: false, targets: [] }) })
  ds.processConversationSync = async () => {}
  ds.processProactiveChats = async () => {}
  ds.window = { isDestroyed: () => false, destroy() {}, isVisible: () => false,
    webContents: { executeJavaScript: async () => false } }
  ds.syncContacts = async () => ({ contacts: [], visibleContacts: [] })
}

test('worker: expired operation releases the coordinator for already queued work', async () => {
  const coordinator = new ChatWindowCoordinator({ timeoutMs: 10 })
  const stuck = coordinator.run('automation', () => new Promise(() => {}))
  const failure = assert.rejects(stuck, { code: 'AUTOMATION_ROUND_TIMEOUT' })
  const after = coordinator.run('manual_send', async () => 'recovered')
  await failure
  assert.equal(await after, 'recovered')
  coordinator.close()
})
test('worker: late completion cannot release a newer active lease', async () => {
  const coordinator = new ChatWindowCoordinator({ timeoutMs: 15 }), old = latch(), release = latch(), entered = latch()
  const first = coordinator.run('automation', () => old.promise)
  await assert.rejects(first, { code: 'AUTOMATION_ROUND_TIMEOUT' })
  const next = coordinator.run('manual_send', async () => { entered.resolve(); await release.promise })
  await entered.promise
  old.resolve(); await tick()
  assert.equal(coordinator.owner.kind, 'manual_send')
  let thirdEntered = false
  const third = coordinator.run('manual_send', async () => { thirdEntered = true })
  await tick(); assert.equal(thirdEntered, false)
  release.resolve(); await Promise.all([next, third]); coordinator.close()
})
test('worker: revoked continuation cannot reacquire a nested lease', async () => {
  const coordinator = new ChatWindowCoordinator({ timeoutMs: 10 }), resume = latch(), done = latch()
  const old = coordinator.run('automation', async () => {
    await resume.promise
    try { await coordinator.run('manual_send', async () => assert.fail('old nested send')) }
    catch (error) { done.resolve(error.code) }
  })
  await assert.rejects(old, { code: 'AUTOMATION_ROUND_TIMEOUT' })
  resume.resolve(); assert.equal(await done.promise, 'AUTOMATION_ROUND_TIMEOUT'); coordinator.close()
})
test('worker: successful round deferred work remains allowed and uses a new lease', async t => {
  const f = fixture(t), resume = latch(), done = latch()
  await f.ds.getChatWindowCoordinator().run('automation', async () => {
    void (async () => { await resume.promise; f.ds.storage.update({ completedMemory: true }); await f.ds.getChatWindowCoordinator().run('memory', async () => done.resolve(true)) })()
  })
  resume.resolve(); assert.equal(await done.promise, true)
  assert.equal(f.storage.get().completedMemory, true)
})
test('worker: late old task cannot write storage, emit events, enqueue, or send', async t => {
  const f = fixture(t), resume = latch(), done = latch(), codes = [], events = []
  f.ds.emit = event => events.push(event.type)
  f.ds.runAutomationInWindow = async () => {
    await resume.promise
    for (const operation of [() => f.ds.storage.update({ staleWrite: true }), () => f.ds.emitEvent('stale', {}),
      () => f.ds.enqueueIncoming({ name: 'old', key: 'old' }), () => f.ds.sendMessage('old', 'stale reply')]) {
      try { await operation(); codes.push('unexpected success') } catch (error) { codes.push(error.code) }
    }
    done.resolve()
  }
  await assert.rejects(f.ds.runAutomation(), { code: 'AUTOMATION_ROUND_TIMEOUT' })
  resume.resolve(); await done.promise
  assert.deepEqual(codes, Array(4).fill('AUTOMATION_ROUND_TIMEOUT'))
  assert.equal(f.storage.get().staleWrite, undefined)
  assert.equal(events.includes('stale'), false)
  assert.equal(f.ds.incomingQueueMap().size, 0)
})
test('worker: timeout before polling=true recovers and another real round can scan', async t => {
  const f = fixture(t); readyRound(f.ds)
  f.ds.getStatus = () => new Promise(() => {})
  await assert.rejects(f.ds.runAutomation(), { code: 'AUTOMATION_ROUND_TIMEOUT' })
  assert.equal(f.ds.polling, false)
  assert.equal(f.storage.get().logs.find(log => log.type === 'worker_watchdog').detail.stage, 'login_status')
  readyRound(f.ds)
  let scans = 0; f.ds.syncContacts = async () => { scans++; return { contacts: [], visibleContacts: [] } }
  await f.ds.runAutomation(); assert.equal(scans, 1)
})
test('worker: concurrent triggers share one pending automation round', async t => {
  const f = fixture(t), entered = latch(), resume = latch(); let calls = 0
  f.ds.runAutomationInWindow = async () => { calls++; entered.resolve(); await resume.promise }
  const one = f.ds.runAutomation(); await entered.promise
  const two = f.ds.runAutomation(); await tick()
  assert.equal(calls, 1); resume.resolve(); await Promise.all([one, two])
})
test('worker: bounded page reads recycle an unresponsive window without consuming pending input', async t => {
  const f = fixture(t), pending = contact('pending'); f.ds.enqueueIncoming({ name: pending.name, key: 'new' })
  let destroyed = 0
  f.ds.window = { isDestroyed: () => false, destroy() { destroyed++ } }
  await assert.rejects(f.ds.getChatWindowCoordinator().run('automation', () => f.ds.withChatRead(() => new Promise(() => {}), 'test_read', 3)), { code: 'CHAT_READ_TIMEOUT' })
  assert.equal(destroyed, 1); assert.equal(f.ds.incomingQueueMap().size, 1)
  assert.equal(f.storage.get().logs[0].detail.stage, 'test_read')
})
test('worker: unknown security verification state blocks the round instead of allowing send', async t => {
  const f = fixture(t); readyRound(f.ds)
  f.ds.window.webContents.executeJavaScript = () => new Promise(() => {})
  const bounded = f.ds.withChatRead.bind(f.ds)
  f.ds.withChatRead = (operation, stage) => bounded(operation, stage, 3)
  let scans = 0; f.ds.syncContacts = async () => { scans++; return { contacts: [] } }
  await f.ds.runAutomation()
  assert.equal(scans, 0)
  assert.ok(f.storage.get().logs.some(log => log.type === 'verification_check_unavailable'))
})
test('worker: runAutomation collects only current DOM rows, not preserved contacts', async t => {
  const f = fixture(t); readyRound(f.ds)
  const fresh = contact('fresh'), old = contact('old', { conversationListCurrent: false })
  f.ds.syncContacts = async () => ({ contacts: [fresh, old], visibleContacts: [fresh] })
  let collected; f.ds.collectIncoming = async contacts => { collected = contacts }
  await f.ds.runAutomation(); assert.deepEqual(collected, [fresh])
})
test('worker: collecting unread contacts is bounded and rotates fairly', async t => {
  const rows = Array.from({ length: 20 }, (_, n) => contact(`p${n}`)), f = fixture(t, rows), visited = []
  f.ds.assertBackgroundChatTarget = async name => { visited.push(name); throw Object.assign(Error('manual'), { code: 'CHAT_WINDOW_MANUAL_CONTROL' }) }
  const ctx = { autoReplyOn: true, blacklist: new Set(), aiDisabledContacts: new Set() }
  await f.ds.collectIncoming(rows, ctx); assert.equal(visited.length, 8)
  await f.ds.collectIncoming(rows, ctx); assert.equal(visited.length, 16)
  await f.ds.collectIncoming(rows, ctx); assert.equal(new Set(visited).size, 20)
})
test('worker: preserved offscreen contacts cannot occupy the incoming scan budget', async t => {
  const rows = Array.from({ length: 20 }, (_, n) => contact(`old${n}`, { conversationListCurrent: false })), fresh = contact('fresh'), f = fixture(t, [...rows, fresh]), visited = []
  f.ds.assertBackgroundChatTarget = async name => { visited.push(name); throw Object.assign(Error('manual'), { code: 'CHAT_WINDOW_MANUAL_CONTROL' }) }
  await f.ds.collectIncoming([...rows, fresh], { autoReplyOn: true, blacklist: new Set(), aiDisabledContacts: new Set() })
  assert.deepEqual(visited, ['fresh'])
})
test('worker: fresh unread queue work is processed before preserved old contacts, at most two per round', async t => {
  const rows = [contact('old', { conversationListCurrent: false }), contact('new1'), contact('new2'), contact('new3')], f = fixture(t, rows), visited = []
  rows.forEach(row => f.ds.enqueueIncoming({ name: row.name, key: `new-${row.name}` }))
  f.ds.planIncomingQueue = () => rows.map(row => ({ action: 'reply', item: f.ds.incomingQueueMap().get(row.name) }))
  f.ds.assertBackgroundChatTarget = async () => true
  f.ds.handleIncomingItem = async item => { visited.push(item.name); return 'consumed' }
  await f.ds.drainIncomingQueue({ contacts: rows })
  assert.deepEqual(visited, ['new1', 'new2'])
})
test('worker: timeout after a possible submit suppresses automatic resubmission of that input', async t => {
  const f = fixture(t, [contact('target')])
  f.ds.enqueueIncoming({ name: 'target', key: 'incoming-one' })
  f.ds.runAutomationInWindow = async () => {
    f.ds.getChatWindowCoordinator().current().pendingSubmission = { name: 'target', incomingKey: 'incoming-one' }
    return new Promise(() => {})
  }
  await assert.rejects(f.ds.runAutomation(), { code: 'AUTOMATION_ROUND_TIMEOUT' })
  assert.equal(f.ds.incomingQueueMap().size, 0)
  assert.equal(f.storage.get().contacts[0].turn.lastHandledKey, 'incoming-one')
  assert.ok(f.storage.get().logs.some(log => log.type === 'auto_send_uncertain'))
})


test('worker: revoked round resuming from an await cannot submit the editor', async t => {
  const f = fixture(t, [contact('target')]), resume = latch(), done = latch(); let guards = 0, clicks = 0
  const win = { isDestroyed: () => false, destroy() {}, webContents: { async executeJavaScript(script) {
    if (script.includes('function clickMessageSend')) { clicks++; return { attempted: true } }
    return { found: true, text: 'stale reply', completeCopies: 0 }
  } } }
  f.ds.window = win
  f.ds.runAutomationInWindow = async () => {
    try { await f.ds.sendCurrentInput(win, { name: 'target', assertTarget: async () => { if (++guards === 2) await resume.promise } }) }
    finally { done.resolve() }
  }
  await assert.rejects(f.ds.runAutomation(), { code: 'AUTOMATION_ROUND_TIMEOUT' })
  resume.resolve(); await done.promise; assert.equal(clicks, 0)
})
test('worker: revoked old finally cannot clear the new round polling flag', async t => {
  const f = fixture(t), oldResume = latch(), newEntered = latch(), newResume = latch(); readyRound(f.ds)
  f.ds.syncContacts = () => oldResume.promise
  await assert.rejects(f.ds.runAutomation(), { code: 'AUTOMATION_ROUND_TIMEOUT' })
  f.ds.chatWindowCoordinator.timeoutMs = 1000
  readyRound(f.ds)
  f.ds.collectIncoming = async () => { newEntered.resolve(); await newResume.promise }
  const next = f.ds.runAutomation(); await newEntered.promise
  assert.equal(f.ds.polling, true)
  oldResume.resolve({ contacts: [], visibleContacts: [] }); await tick(); assert.equal(f.ds.polling, true)
  newResume.resolve(); await next; assert.equal(f.ds.polling, false)
})
test('worker: scan time budget advances cursor only past rows actually visited', async t => {
  const rows = Array.from({ length: 8 }, (_, n) => contact(`p${n}`)), f = fixture(t, rows), visited = []
  const originalNow = Date.now; let now = originalNow()
  Date.now = () => now
  try {
    f.ds.assertBackgroundChatTarget = async name => { visited.push(name); now += 13000; throw Object.assign(Error('manual'), { code: 'CHAT_WINDOW_MANUAL_CONTROL' }) }
    const ctx = { autoReplyOn: true, blacklist: new Set(), aiDisabledContacts: new Set() }
    await f.ds.collectIncoming(rows, ctx)
    await f.ds.collectIncoming(rows, ctx)
    assert.deepEqual(visited, ['p0', 'p1'])
  } finally { Date.now = originalNow }
})
function syncFixture(t, previous, fresh) {
  const f = fixture(t, previous)
  f.ds.window = { isDestroyed: () => false, destroy() {}, webContents: { executeJavaScript: async () => structuredClone(fresh) } }
  f.ds.waitForChatReady = async () => f.ds.window
  return f
}
test('sync: same message and label preserve the first reliable relative timestamp', async t => {
  const firstTime = '2026-10-15T01:01:00.000Z', old = contact('friend', { messageKey: 'same', sentAtLabel: '刚刚',
    sentAt: firstTime, sentAtSource: 'platform_label', sentAtObservedAt: firstTime })
  const fresh = { ...old, sentAt: undefined, sentAtSource: undefined, sentAtObservedAt: undefined }
  const f = syncFixture(t, [old], [fresh])
  const one = await f.ds.syncContacts(), two = await f.ds.syncContacts()
  assert.equal(one.contacts[0].sentAt, firstTime)
  assert.equal(two.contacts[0].sentAt, firstTime)
  assert.equal(two.contacts[0].sentAtObservedAt, firstTime)
})
test('sync: legacy unsourced sentAt does not survive a fresh unknown-time row', async t => {
  const old = contact('friend', { sentAt: new Date().toISOString(), messageKey: 'same' })
  const fresh = { id: old.id, name: old.name, preview: old.preview, messageKey: 'same', unread: true, sentAtLabel: '' }
  const f = syncFixture(t, [old], [fresh]), result = await f.ds.syncContacts()
  assert.equal(result.contacts[0].sentAt, '')
  assert.equal(result.contacts[0].sentAtSource, '')
  assert.equal(result.visibleContacts.length, 1)
})
test('sync: current rows carry reliable geometry while preserved contacts are explicitly cached', async t => {
  const old = contact('old'), fresh = contact('fresh', { sentAtLabel: '刚刚', conversationListPosition: 840,
    conversationListPositionSource: 'douyin_list_geometry' }), f = syncFixture(t, [old], [fresh])
  const result = await f.ds.syncContacts()
  assert.equal(result.contacts.find(row => row.name === 'old').conversationListCurrent, false)
  assert.equal(result.contacts.find(row => row.name === 'fresh').conversationListCurrent, true)
  assert.equal(result.visibleContacts[0].conversationListPosition, 840)
  assert.equal(result.visibleContacts[0].conversationListPositionSource, 'douyin_list_geometry')
  assert.ok(Number.isFinite(Date.parse(result.visibleContacts[0].conversationListObservedAt)))
})
test('sync: invalid current geometry is not relabelled as a fresh observation of old position', async t => {
  const old = contact('friend', { conversationListPosition: 123, conversationListPositionSource: 'douyin_list_geometry' })
  const fresh = contact('friend', { conversationListPosition: -100, sentAtLabel: '' }), f = syncFixture(t, [old], [fresh])
  const result = await f.ds.syncContacts()
  assert.equal(result.contacts[0].conversationListPosition, null)
  assert.equal(result.contacts[0].conversationListPositionSource, '')
})


function selectedFixture(t, learned = [{ messageId: 'anchor', role: 'contact', text: '之前的话' }]) {
  const target = contact('target', { unread: false, preview: '[尬笑]', messageKey: 'stale-list-key',
    profile: { platformUserId: 'verified-target', dmIdentityVerified: true }, learning: { messages: learned } })
  const f = fixture(t, [target])
  f.storage.update({ settings: { incomingBurstEnabled: true } })
  f.ds.window = { isDestroyed: () => false, destroy() {}, webContents: { executeJavaScript: async () => ({ activeName: target.name, headerNames: [target.name], ambiguous: false }) } }
  let rows = [{ messageId: 'anchor', role: 'contact', text: '之前的话', type: 'text' },
    { messageId: 'owner-reply', role: 'me', text: '哈哈', type: 'text' }, { messageId: 'new-xx', role: 'contact', text: 'xx是什么鬼', type: 'text' }]
  f.ds.readBoundIncomingMessages = async () => structuredClone(rows)
  f.ds.lastSeen.set(target.name, require('../electron/conversation-engine.cjs').dailyMessageKey(target.messageKey))
  f.ds.incomingBuffer = new (require('../electron/social-brain/conversation-buffer.cjs').ConversationBuffer)({ namespace: f.ds.partition, setTimer: () => 1, clearTimer() {} })
  f.ds.burstObservedIds = new Map()
  const ctx = { contacts: [target], autoReplyOn: true, blacklist: new Set(), aiDisabledContacts: new Set() }
  return { ...f, target, ctx, setRows(value) { rows = value } }
}
test('selected: current verified pane discovers text after sticker even when list key is unchanged', async t => {
  const f = selectedFixture(t)
  await f.ds.collectIncoming([f.target], f.ctx)
  const queued = f.ds.incomingQueueMap().get(f.target.name)
  assert.equal(queued.incomingIdentity.messageId, 'new-xx')
  assert.equal(queued.preview, 'xx是什么鬼')
  const saved = f.storage.get().contacts[0]
  assert.equal(saved.preview, '[尬笑]')
  assert.equal(saved.observedChatPreview.text, 'xx是什么鬼')
  assert.equal(saved.observedChatPreview.source, 'verified_chat_dom')
  assert.equal(saved.observedChatPreview.platformUserId, 'verified-target')
  assert.equal(saved.observedChatPreview.baseListMessageKey, 'stale-list-key')
})
test('selected: unknown old pane is baselined, later new bubble is discovered without a list change', async t => {
  const f = selectedFixture(t, [])
  await f.ds.collectIncoming([f.target], f.ctx)
  assert.equal(f.ds.incomingQueueMap().size, 0)
  f.setRows([{ messageId: 'new-xx', role: 'contact', text: 'xx是什么鬼', type: 'text' },
    { messageId: 'actually-new', role: 'contact', text: '又有新话', type: 'text' }])
  await f.ds.collectIncoming([f.target], f.ctx)
  assert.equal(f.ds.incomingQueueMap().get(f.target.name).incomingIdentity.messageId, 'actually-new')
})
test('selected: latest owner bubble is observed but never enqueued as an incoming turn', async t => {
  const f = selectedFixture(t)
  f.setRows([{ messageId: 'anchor', role: 'contact', text: '之前的话' }, { messageId: 'mine-latest', role: 'me', text: '我回复完了' }])
  await f.ds.collectIncoming([f.target], f.ctx)
  assert.equal(f.ds.incomingQueueMap().size, 0)
  assert.equal(f.storage.get().contacts[0].observedChatPreview.role, 'me')
})
test('selected: failed contact identity read cannot publish a derived preview or enqueue', async t => {
  const f = selectedFixture(t)
  f.ds.readBoundIncomingMessages = async () => { throw f.ds.staleBurstError('identity changed') }
  await f.ds.collectIncoming([f.target], f.ctx)
  assert.equal(f.ds.incomingQueueMap().size, 0)
  assert.equal(f.storage.get().contacts[0].observedChatPreview, undefined)
})
test('selected: a new list key does not revalidate an unchanged old pane bubble', async t => {
  const f = selectedFixture(t)
  await f.ds.collectIncoming([f.target], f.ctx)
  f.storage.update({ contacts: f.storage.get().contacts.map(row => ({ ...row, messageKey: 'actually-new-list-key', preview: '平台更新了' })) })
  await f.ds.observeSelectedConversation(f.storage.get().contacts)
  const saved = f.storage.get().contacts[0]
  assert.equal(saved.observedChatPreview.baseListMessageKey, 'stale-list-key')
  assert.equal(saved.messageKey, 'actually-new-list-key')
})
