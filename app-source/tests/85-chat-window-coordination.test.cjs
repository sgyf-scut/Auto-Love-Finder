const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { ChatWindowCoordinator, chatWindowDeferred } = require('../electron/chat-window-coordinator.cjs')
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const contact = name => ({ id: name, name, preview: `hello ${name}`, fromMe: false, unread: true, profile: {}, learning: { messages: [] }, turn: {} })

function fixture({ visible = false, active = 'A', execute } = {}) {
  const contacts = [contact('A'), contact('B')]
  const storage = createMemoryStorage({ contacts })
  const ds = new DouyinService({ storage, emit() {}, ai: {} }), clicks = [], reads = [], sent = []
  const state = { visible, active, pendingTarget: '' }
  const win = { isDestroyed: () => false, isVisible: () => state.visible, webContents: {
    getURL: () => 'https://www.douyin.com/chat',
    sendInputEvent(event) { clicks.push(event); if (event.type === 'mouseUp') state.active = state.pendingTarget },
    async executeJavaScript(script) {
      reads.push(script)
      const target = script.match(/const target = ("(?:[^"\\]|\\.)*")/)?.[1] || script.match(/return readConversationIdentity\(document, ("(?:[^"\\]|\\.)*")/)?.[1]
      const name = target ? JSON.parse(target) : ''
      const override = await execute?.({ script, name, state, ds })
      if (override !== undefined) return override
      const identity = { isTargetMatch: state.active === name, activeName: state.active, headerNames: [state.active] }
      if (script.includes('isAlreadyTarget')) return { ...identity, isAlreadyTarget: identity.isTargetMatch }
      if (script.includes('return readConversationIdentity')) return identity
      if (script.includes('x: Math.round')) { state.pendingTarget = name; return { x: 40, y: 50 } }
      if (script.includes('ready: identity.isTargetMatch')) return { ...identity, ready: identity.isTargetMatch }
      return true
    },
  } }
  ds.window = win
  ds.waitForChatReady = async () => win
  ds.waitForEditor = async () => {}
  ds.assertCanSend = () => {}
  ds.recordSuccessfulSend = () => {}
  ds.recordConversationMessage = () => ({ id: 'fake-confirmed-contact' })
  ds.queueCompletedSharedInteraction = () => {}
  ds.recordExpressionTurn = () => {}
  ds.sendCurrentInput = async (_win, options) => { await ds.assertConversationTarget(win, options.name); await options.assertTarget?.(); sent.push(options.name) }
  // Exercise the real sender/lease/identity checks with deterministic editor IO.
  const source = DouyinService.prototype.sendMessage.toString().replace(/^async sendMessage/, 'async function')
  const send = vm.runInNewContext('(' + source + ')', { require, REPLY_FREQUENCY_SECONDS: {}, normalizeEditorText: x => x, sleep: async () => {},
    writeMessageInput: async (_win, text, opts) => { await opts.assertTarget(); await ds.afterWrite?.(); return text }, clearMatchingInput: async () => true })
  ds.sendMessage = send.bind(ds)
  const ctx = { contacts, autoReplyOn: true, canSend: () => true, blacklist: new Set(), aiDisabledContacts: new Set(), settings: {}, config: {}, today: '2026-10-14', factCandidates: [], topicCandidates: [] }
  return { ds, storage, win, state, contacts, clicks, reads, sent, ctx }
}

test('manual sender owns the entire select/write/submit sequence before polling', async () => {
  const f = fixture(), written = latch(), release = latch(), order = []
  f.ds.afterWrite = async () => { order.push('manual_write'); written.resolve(); await release.promise }
  f.ds.runAutomationInWindow = async () => { order.push('poll'); await f.ds.selectConversation('B') }
  const send = f.ds.sendMessage('A', 'synthetic manual')
  await written.promise
  const poll = f.ds.runAutomation(); await tick()
  assert.deepEqual(order, ['manual_write']); assert.equal(f.state.active, 'A')
  release.resolve(); await Promise.all([send, poll])
  assert.deepEqual(f.sent, ['A']); assert.deepEqual(order, ['manual_write', 'poll']); assert.equal(f.state.active, 'B')
})

test('poll already in flight releases before a manual send can switch its window', async () => {
  const f = fixture(), entered = latch(), release = latch(), order = []
  f.ds.runAutomationInWindow = async () => { order.push('poll'); entered.resolve(); await release.promise; await f.ds.selectConversation('B'); order.push('poll_end') }
  f.ds.afterWrite = async () => { order.push('manual_write') }
  const poll = f.ds.runAutomation(); await entered.promise
  const send = f.ds.sendMessage('A', 'synthetic manual'); await tick()
  assert.deepEqual(order, ['poll']); release.resolve(); await Promise.all([send, poll])
  assert.deepEqual(order, ['poll', 'poll_end', 'manual_write']); assert.deepEqual(f.sent, ['A'])
})

test('automatic nested send reuses the poll lease without deadlocking', async () => {
  const f = fixture(); f.ds.runAutomationInWindow = () => f.ds.sendMessage('A', 'synthetic automatic', { ai: true })
  await f.ds.runAutomation(); assert.deepEqual(f.sent, ['A'])
})

test('text submissions from separate windows share quota only while sending', async () => {
  const { ds, sent } = fixture()
  const firstEntered = latch(), releaseFirst = latch(), secondWritten = latch()
  let quotaUsed = false
  ds.assertCanSend = () => { if (quotaUsed) throw new Error('daily limit reached') }
  ds.afterWrite = async () => { secondWritten.resolve() }

  const first = ds.runTextSubmission(async () => {
    firstEntered.resolve()
    await releaseFirst.promise
    quotaUsed = true
  })
  await firstEntered.promise
  const second = ds.sendMessage('A', 'synthetic automatic', { ai: true })
  const rejected = assert.rejects(second, error => error.sendAttempted === false && /daily limit/.test(error.message))
  try {
    await secondWritten.promise
    await tick()
    assert.deepEqual(sent, [])
  } finally {
    releaseFirst.resolve()
  }
  await Promise.all([first, rejected])
  assert.deepEqual(sent, [])
  assert.equal(ds.textSubmissionTail, null)
})

test('manual send exception releases the lease and subsequent polling proceeds', async () => {
  const f = fixture(); f.ds.afterWrite = async () => { throw Error('synthetic editor error') }
  await assert.rejects(f.ds.sendMessage('A', 'synthetic'), /editor error/)
  let polled = false; f.ds.runAutomationInWindow = async () => { polled = true }
  await f.ds.runAutomation(); assert.equal(polled, true); assert.equal(f.ds.getChatWindowCoordinator().current(), null)
})

test('poll exception releases the lease and subsequent manual sender proceeds', async () => {
  const f = fixture(); f.ds.runAutomationInWindow = async () => { throw Error('synthetic poll error') }
  await assert.rejects(f.ds.runAutomation(), /poll error/)
  await f.ds.sendMessage('A', 'synthetic'); assert.deepEqual(f.sent, ['A'])
})

test('two account/service instances do not share a window lease', async () => {
  const a = fixture(), b = fixture(), entered = latch(), release = latch()
  a.ds.afterWrite = async () => { entered.resolve(); await release.promise }
  const first = a.ds.sendMessage('A', 'synthetic'); await entered.promise
  await b.ds.sendMessage('A', 'synthetic'); assert.deepEqual(b.sent, ['A']); assert.deepEqual(a.sent, [])
  release.resolve(); await first
})

test('expired async owner cannot let a detached callback bypass a later lease', async () => {
  const c = new ChatWindowCoordinator(), fire = latch(), oldDone = latch(), entered = latch(), release = latch(), order = []
  await c.run('automation', async () => { void fire.promise.then(() => c.run('manual_send', () => order.push('detached'))).then(oldDone.resolve) })
  const active = c.run('manual_send', async () => { entered.resolve(); await release.promise; order.push('active') }); await entered.promise
  fire.resolve(); await tick(); assert.deepEqual(order, [])
  release.resolve(); await Promise.all([active, oldDone.promise]); assert.deepEqual(order, ['active', 'detached'])
})

test('visible user-selected different target causes no click and explicit temporary defer', async () => {
  const f = fixture({ visible: true })
  await assert.rejects(f.ds.getChatWindowCoordinator().run('automation', () => f.ds.selectConversation('B')), { code: 'CHAT_WINDOW_MANUAL_CONTROL', sendAttempted: false })
  assert.equal(f.clicks.length, 0); assert.equal(f.state.active, 'A')
})

test('visible current target remains available to automatic sender', async () => {
  const f = fixture({ visible: true })
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.sendMessage('A', 'synthetic current reply', { ai: true }))
  assert.deepEqual(f.sent, ['A']); assert.equal(f.clicks.filter(x => x.type === 'mouseUp').length, 0)
})

test('window shown while an older selection awaits prevents the pending navigation', async () => {
  const f = fixture({ execute({ script, state }) { if (script.includes('x: Math.round')) { state.visible = true; return { x: 40, y: 50 } } } })
  await assert.rejects(f.ds.getChatWindowCoordinator().run('automation', () => f.ds.selectConversation('B')), { code: 'CHAT_WINDOW_MANUAL_CONTROL' })
  assert.equal(f.clicks.length, 0); assert.equal(f.state.active, 'A')
})

test('showing the window during a click check prevents DOM retry clicks', async () => {
  let retries = 0
  const f = fixture({ execute({ script, state }) { if (script.includes('ready: identity.isTargetMatch')) { state.visible = true; state.active = 'A'; return { ready: false } } if (script.includes('row.click()')) retries++ } })
  await assert.rejects(f.ds.getChatWindowCoordinator().run('automation', () => f.ds.selectConversation('B')), { code: 'CHAT_WINDOW_MANUAL_CONTROL' })
  assert.equal(retries, 0)
})

test('visible other-contact incoming is neither baselined nor consumed', async () => {
  const f = fixture({ visible: true }); f.ds.lastSeen.set('B', 'old-B')
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.collectIncoming([f.contacts[1]], f.ctx))
  assert.equal(f.ds.lastSeen.get('B'), 'old-B'); assert.equal(f.ds.incomingQueueMap().size, 0); assert.equal(f.clicks.length, 0)
})

test('visible other-contact existing queue retains attempts and no failure backoff', async () => {
  const f = fixture({ visible: true }), item = { name: 'B', key: 'new-B', preview: 'hello', enqueuedAt: Date.now(), attempts: 2 }
  f.ds.enqueueIncoming(item); f.ds.lastSeen.set('B', 'old-B')
  f.storage.update({ logs: [] })
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.drainIncomingQueue(f.ctx))
  assert.equal(f.ds.incomingQueueMap().get('B').attempts, 2); assert.equal(f.ds.lastSeen.get('B'), 'old-B'); assert.equal(f.ds.aiBackoff.size, 0)
  assert.ok(f.storage.get().logs.every(log => log.type === 'queue_deferred')); assert.equal(f.clicks.length, 0)
})

test('current visible queue still dispatches while another contact remains pending', async () => {
  const f = fixture({ visible: true }), dispatched = []
  for (const c of f.contacts) f.ds.enqueueIncoming({ name: c.name, key: `new-${c.name}`, enqueuedAt: Date.now() })
  f.ds.handleIncomingItemCore = async item => { dispatched.push(item.name); await f.ds.sendMessage(item.name, 'synthetic reply', { ai: true }); f.ds.markIncomingConsumed(item); return 'consumed' }
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.drainIncomingQueue(f.ctx))
  assert.deepEqual(dispatched, ['A']); assert.deepEqual(f.sent, ['A']); assert.ok(f.ds.incomingQueueMap().has('B')); assert.equal(f.state.active, 'A')
})

test('hiding the window resumes deferred queue without persistent setting changes', async () => {
  const f = fixture({ visible: true }), before = f.storage.get()
  f.ds.enqueueIncoming({ name: 'B', key: 'new-B', enqueuedAt: Date.now() })
  f.ds.handleIncomingItemCore = async item => { await f.ds.selectConversation(item.name); f.ds.markIncomingConsumed(item); return 'consumed' }
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.drainIncomingQueue(f.ctx))
  assert.ok(f.ds.incomingQueueMap().has('B')); f.state.visible = false
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.drainIncomingQueue(f.ctx))
  assert.equal(f.ds.incomingQueueMap().size, 0); assert.equal(f.state.active, 'B')
  assert.deepEqual(f.storage.get().automation, before.automation); assert.deepEqual(f.storage.get().settings, before.settings)
})

test('temporary manual-window notices are throttled per contact', async () => {
  const f = fixture({ visible: true }); f.ds.enqueueIncoming({ name: 'B', key: 'new-B', enqueuedAt: Date.now() })
  f.storage.update({ logs: [] })
  for (let i = 0; i < 4; i++) await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.drainIncomingQueue(f.ctx))
  assert.equal(f.storage.get().logs.length, 1); assert.equal(f.storage.get().logs[0].detail.reason, 'chat_window_manual_control')
})

test('user switches visible target during model await: no stale send or queue consumption', async () => {
  const f = fixture({ visible: true }), item = { name: 'A', key: 'new-A', enqueuedAt: Date.now() }
  f.ds.enqueueIncoming(item)
  f.ds.handleIncomingItemCore = async item => { await Promise.resolve(); f.state.active = 'B'; await f.ds.assertBurstFresh(item); throw Error('must not continue') }
  assert.equal(await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.handleIncomingItem(item, f.contacts[0], f.ctx)), 'deferred')
  assert.ok(f.ds.incomingQueueMap().has('A')); assert.equal(f.sent.length, 0); assert.equal(f.ds.aiBackoff.size, 0)
})

test('manual sender still rejects wrong final recipient instead of bypassing identity guard', async () => {
  const f = fixture(); f.ds.afterWrite = async () => { f.state.active = 'B' }
  await assert.rejects(f.ds.sendMessage('A', 'synthetic'), /安全拦截/); assert.equal(f.sent.length, 0)
})

test('background visible identity mismatch is a defer with no submit attempt', async () => {
  const f = fixture({ visible: true }); f.ds.afterWrite = async () => { f.state.active = 'B' }
  await assert.rejects(f.ds.getChatWindowCoordinator().run('automation', () => f.ds.sendMessage('A', 'synthetic', { ai: true })), { code: 'CHAT_WINDOW_MANUAL_CONTROL', sendAttempted: false })
  assert.equal(f.sent.length, 0)
})

test('lease does not swallow unrelated errors', async () => {
  const f = fixture(); f.ds.runAutomationInWindow = async () => { throw Object.assign(Error('real error'), { code: 'UNRELATED_ERROR' }) }
  await assert.rejects(f.ds.runAutomation(), { code: 'UNRELATED_ERROR' }); assert.equal(chatWindowDeferred('B').sendAttempted, false)
})

test('deferred other contact leaves the current quiet burst observer running', async () => {
  const f = fixture({ visible: true }); let stopped = 0
  f.ds.burstQuietObserver = { stop: async () => { stopped++ } }
  f.ds.incomingBurstEnabled = () => true
  f.ds.lastSeen.set('B', 'old-B')
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.collectIncoming([f.contacts[1]], f.ctx))
  assert.equal(stopped, 0); assert.equal(f.ds.lastSeen.get('B'), 'old-B'); assert.equal(f.clicks.length, 0)
})

test('window shown after scan started is rechecked before stopping the current observer', async () => {
  const f = fixture(); let stopped = 0
  f.ds.burstQuietObserver = { stop: async () => { stopped++ } }
  f.ds.incomingBurstEnabled = () => { f.state.visible = true; return true }
  f.ds.lastSeen.set('B', 'old-B')
  await f.ds.getChatWindowCoordinator().run('automation', () => f.ds.collectIncoming([f.contacts[1]], f.ctx))
  assert.equal(stopped, 0); assert.equal(f.ds.lastSeen.get('B'), 'old-B'); assert.equal(f.clicks.length, 0)
})
