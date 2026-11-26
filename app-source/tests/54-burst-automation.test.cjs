const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { ConversationBuffer } = require('../electron/social-brain/conversation-buffer.cjs')

function fixture(t, { draftOnly = true, draft } = {}) {
  let now = 1000
  let sequence = 0
  const timers = new Map()
  const contact = { id: 'test-contact', name: '测试联系人', preview: '我想去北航', profile: { chatMode: 'old_friend' }, fromMe: false, learning: { messages: [] }, turn: {} }
  const storage = createMemoryStorage({ contacts: [contact], providers: [{ model: 'mock' }], settings: {
    incomingBurstEnabled: true, incomingBurstQuietWindowMs: 4000, incomingBurstMaxWindowMs: 15000,
    showAiModelLabel: false, aiReplyDraftOnly: draftOnly, longTermMemory: false,
  } })
  const calls = { drafts: [], sends: [] }
  const ai = { hasProvider: () => true, async draft(options) {
    calls.drafts.push(options)
    return draft ? draft(options) : { ok: true, text: '目标挺明确呀' }
  } }
  const ds = new DouyinService({ storage, ai, partition: 'persist:burst-test', emit() {} })
  ds.incomingBuffer = new ConversationBuffer({ namespace: ds.partition, clock: () => now,
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id },
    clearTimer(id) { timers.delete(id) },
  })
  ds.bufferEpoch = 'test-epoch'
  ds.burstObservedIds = new Map()
  let visible = []
  let targetValid = true
  const win = { isDestroyed: () => false }
  ds.window = win
  ds.selectConversation = async () => win
  ds.assertConversationTarget = async () => { if (!targetValid) throw ds.staleBurstError('窗口联系人已改变') }
  ds.captureVisibleMessages = async () => structuredClone(visible)
  ds.captureLatestIncomingMessageIdentity = async () => {
    const message = visible.at(-1)
    return message ? { role: message.role, fingerprint: message.messageId, messageId: message.messageId, message } : null
  }
  ds.isLastMessageFromMe = async () => visible.at(-1)?.role === 'me'
  ds.sendMessage = async (name, text, metadata) => { await metadata.beforeSubmit?.(); calls.sends.push({ name, text, metadata }) }
  const ctx = { contacts: [contact], settings: storage.get().settings, today: '2026-10-12', factCandidates: [], topicCandidates: [],
    autoReplyOn: true, blacklist: new Set(), aiDisabledContacts: new Set(), canSend: () => true }
  function add(id, text, role = 'contact') {
    const message = { messageId: id, id, role, text, type: 'text' }
    visible.push(message)
    if (role === 'contact') {
      ds.enqueueIncoming({ name: contact.name, key: `burst:${id}`, preview: text, incomingIdentity: { role, messageId: id, fingerprint: id, message }, incomingMessages: [message], enqueuedAt: now })
      let seen = ds.burstObservedIds.get(contact.id)
      if (!seen) ds.burstObservedIds.set(contact.id, seen = new Set())
      seen.add(id)
    }
    return message
  }
  function advance(ms) {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
  }
  t.after(async () => { await ds.burstQuietObserver?.stop(); ds.incomingBuffer.dispose() })
  return { ds, storage, calls, contact, ctx, add, advance, win, get visible() { return visible }, setTarget(value) { targetValid = value },
    async handle() { return ds.handleIncomingItem(ds.incomingQueueMap().get(contact.name), contact, ctx) } }
}

test('burst: queue waits for four quiet seconds before planning', t => {
  const f = fixture(t); f.add('m1', '第一句')
  assert.equal(f.ds.planIncomingQueue(f.ctx)[0].reason, 'waiting_for_incoming_burst')
  f.advance(3999); assert.equal(f.ds.planIncomingQueue(f.ctx)[0].action, 'defer')
  f.advance(1); assert.equal(f.ds.planIncomingQueue(f.ctx)[0].action, 'reply')
})

test('burst: additional incoming line resets the quiet interval', t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(3000); f.add('m2', '第二句'); f.advance(1000)
  assert.equal(f.ds.planIncomingQueue(f.ctx)[0].action, 'defer')
  f.advance(3000); assert.equal(f.ds.planIncomingQueue(f.ctx)[0].action, 'reply')
})

test('burst: repeat poll of the same source ID does not reset quiet time', t => {
  const f = fixture(t); f.add('m1', '哈哈'); f.advance(3000); f.add('m1', '哈哈'); f.advance(1000)
  assert.equal(f.ds.planIncomingQueue(f.ctx)[0].action, 'reply')
  assert.equal(f.ds.incomingBuffer.snapshot(f.contact.id).conversationRevision, 1)
})

test('burst: identical text with different source IDs remains two messages', t => {
  const f = fixture(t); f.add('m1', '哈哈'); f.add('m2', '哈哈')
  assert.deepEqual(f.ds.incomingBuffer.snapshot(f.contact.id).messages.map(m => m.messageId), ['m1', 'm2'])
})

test('burst: owner bubbles do not increment the incoming revision', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.add('mine', '我刚回的', 'me')
  await f.ds.observeIncomingBurst(f.contact.name, f.win)
  assert.equal(f.ds.incomingBuffer.snapshot(f.contact.id).conversationRevision, 1)
})

test('burst: three independent messages reach AI and the latest stays an actual message', async t => {
  const f = fixture(t); f.add('m1', '想考研'); f.add('m2', '北航吧'); f.add('m3', '哈哈'); f.advance(4000)
  assert.equal(await f.handle(), 'consumed')
  assert.equal(f.calls.drafts[0].incoming, '哈哈')
  assert.deepEqual(f.calls.drafts[0].currentIncomingBurst.messages.map(m => m.messageId), ['m1', 'm2', 'm3'])
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.storage.get().pendingDrafts[0].conversationRevision, 3)
})

test('burst: new message during AI await invalidates the old output without error backoff', async t => {
  let f
  f = fixture(t, { draft() { f.visible.push({ role: 'contact', text: '等等还有一句', messageId: 'm2' }); return { ok: true, text: '旧回复' } } })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.storage.get().pendingDrafts.length, 0)
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.ds.aiBackoff.size, 0)
  assert.equal(f.ds.lastSeen.has(f.contact.name), false)
  assert.equal(f.ds.incomingQueueMap().get(f.contact.name).key, 'burst:m2')
})

test('burst: stale NO_REPLY does not consume the new message', async t => {
  let f
  f = fixture(t, { draft() { f.add('m2', '新问题呢'); return { ok: true, skipped: true, reason: 'NO_REPLY' } } })
  f.add('m1', '哈哈'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.ds.incomingQueueMap().get(f.contact.name).key, 'burst:m2')
  assert.equal(f.storage.get().contacts[0].turn.lastHandledKey, undefined)
})

test('burst: fresh NO_REPLY is consumed once without sending or retrying', async t => {
  const f = fixture(t, { draft: () => ({ ok: true, skipped: true, reason: 'NO_REPLY' }) })
  f.add('m1', '哈哈'); f.advance(4000)
  assert.equal(await f.handle(), 'consumed')
  assert.equal(f.ds.incomingQueueMap().size, 0)
  assert.equal(f.ds.incomingBuffer.snapshot(f.contact.id).status, 'IDLE')
  assert.equal(f.calls.sends.length, 0)
})

test('burst: Planner/Writer stage hooks expose freshness checks', async t => {
  let f
  f = fixture(t, { async draft(options) {
    assert.equal(options.onGenerationStage('PLANNING'), true)
    await options.generationGuard()
    assert.equal(options.onGenerationStage('WRITING'), true)
    f.add('m2', '新补充')
    await options.generationGuard()
    assert.fail('stale Writer should not continue')
  } })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.ds.aiBackoff.size, 0)
})

test('burst: a new revision marks an existing draft outdated', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(4000); await f.handle(); f.add('m2', '第二句')
  const draft = f.storage.get().pendingDrafts[0]
  assert.equal(draft.status, 'outdated')
  await assert.rejects(f.ds.confirmDraftFresh(draft.id), { code: 'BURST_STALE' })
})

test('burst: a fresh pending draft can be confirmed without generating another reply', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(4000); await f.handle()
  const draft = f.storage.get().pendingDrafts[0]
  assert.equal((await f.ds.confirmDraftFresh(draft.id)).id, draft.id)
  assert.equal(f.calls.drafts.length, 1)
})

test('burst: approval catches unseen DOM messages before accepting the draft', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(4000); await f.handle()
  f.visible.push({ role: 'contact', messageId: 'm2', text: '新来一句' })
  await assert.rejects(f.ds.confirmDraftFresh(f.storage.get().pendingDrafts[0].id), { code: 'BURST_STALE' })
  assert.equal(f.storage.get().pendingDrafts[0].status, 'outdated')
})

test('burst: drafts from an earlier buffer lifetime cannot be confirmed', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(4000); await f.handle(); f.ds.bufferEpoch = 'new-epoch'
  await assert.rejects(f.ds.confirmDraftFresh(f.storage.get().pendingDrafts[0].id), { code: 'BURST_STALE' })
})

test('burst: ordinary legacy drafts without revision require regeneration', async t => {
  const f = fixture(t); f.storage.update({ pendingDrafts: [{ id: 1, name: f.contact.name, status: 'pending', text: '旧草稿' }] })
  await assert.rejects(f.ds.confirmDraftFresh(1), { code: 'BURST_STALE' })
  assert.equal(f.storage.get().pendingDrafts[0].status, 'outdated')
})

test('burst: event follow-up drafts keep their independent confirmation path', async t => {
  const f = fixture(t); f.storage.update({ pendingDrafts: [{ id: 1, name: f.contact.name, source: 'event_followup', eventId: 'evt', status: 'pending' }] })
  assert.equal((await f.ds.confirmDraftFresh(1)).eventId, 'evt')
})

test('burst: pausing during generation invalidates the result and keeps input queued', async t => {
  let f
  f = fixture(t, { draft() { f.storage.update({ automation: { paused: true } }); return { ok: true, text: '旧回复' } } })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.ds.incomingQueueMap().size, 1)
  assert.equal(f.calls.sends.length, 0)
})

test('burst: account namespace changes invalidate an in-flight generation', async t => {
  let f
  f = fixture(t, { draft() { f.ds.partition = 'persist:other'; return { ok: true, text: '旧回复' } } })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.storage.get().pendingDrafts.length, 0)
})

test('burst: contact identity changes stop the watcher and reject the result', async t => {
  let f
  f = fixture(t, { draft() { f.setTarget(false); return { ok: true, text: '旧回复' } } })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.ds.aiBackoff.size, 0)
})

test('burst: messages received during typing prevent submitting an old reply', async t => {
  let f
  f = fixture(t, { draftOnly: false, draft() {
    setTimeout(() => f.visible.push({ role: 'contact', messageId: 'm2', text: '还没说完' }), 50)
    return { ok: true, text: '旧回复' }
  } })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.ds.incomingQueueMap().get(f.contact.name).key, 'burst:m2')
})

test('burst: fifteen-second maximum releases a continuously growing batch', t => {
  const f = fixture(t); f.add('m1', '第一句')
  for (let i = 2; i <= 6; i++) { f.advance(2500); f.add(`m${i}`, `第${i}句`) }
  f.advance(2500)
  assert.equal(f.ds.planIncomingQueue(f.ctx)[0].action, 'reply')
  assert.equal(f.ds.incomingBuffer.snapshot(f.contact.id).readyReason, 'max_window')
})

test('burst: ordinary incoming revisions never invalidate event or video-opening drafts', t => {
  const f = fixture(t)
  f.storage.update({ pendingDrafts: [
    { id: 1, name: f.contact.name, contactId: f.contact.id, status: 'pending', source: 'event_followup', eventId: 'event' },
    { id: 2, name: f.contact.name, contactId: f.contact.id, status: 'pending', source: 'video_opening', videoOpeningId: 'video' },
  ] })
  f.add('m1', '新来一句')
  assert.deepEqual(f.storage.get().pendingDrafts.map(draft => draft.status), ['pending', 'pending'])
})

test('burst: confirmation at submit time uses its bound window without navigating', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(4000); await f.handle()
  f.ds.selectConversation = () => assert.fail('submit-time confirmation must not navigate')
  assert.equal((await f.ds.confirmDraftFresh(f.storage.get().pendingDrafts[0].id, f.win)).status, 'pending')
})

test('burst: manual owner reply during AI generation invalidates the lease without adding an incoming revision', async t => {
  let f
  f = fixture(t, { draft() { f.visible.push({ role: 'me', messageId: 'manual-1', text: '本人手动回复了' }); return { ok: true, text: '旧回复' } } })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'deferred')
  assert.equal(f.ds.incomingBuffer.snapshot(f.contact.id).conversationRevision, 1)
  assert.equal(f.storage.get().pendingDrafts.length, 0)
  assert.equal(f.calls.sends.length, 0)
})

test('burst: manual owner reply after draft creation rejects approval', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(4000); await f.handle()
  f.visible.push({ role: 'me', messageId: 'manual-1', text: '我自己已经回了' })
  await assert.rejects(f.ds.confirmDraftFresh(f.storage.get().pendingDrafts[0].id, f.win), { code: 'BURST_STALE' })
  assert.equal(f.storage.get().pendingDrafts[0].status, 'outdated')
})

test('burst: a consumed source ID is not re-enqueued by a refreshed text preview', async t => {
  const f = fixture(t); f.add('m1', '第一句'); f.advance(4000); await f.handle()
  await f.ds.collectIncoming([{ ...f.contact, preview: '第一句', unread: false }], f.ctx)
  assert.equal(f.ds.incomingQueueMap().size, 0)
  assert.equal(f.ds.incomingBuffer.snapshot(f.contact.id).status, 'IDLE')
})

test('burst: changed settings rebuild the window while preserving unconsumed original IDs', t => {
  const f = fixture(t); f.add('m1', '第一句')
  f.ds.incomingBufferSettings = JSON.stringify({ quietWindowMs: 4000, maxBurstWindowMs: 15000 })
  const oldBuffer = f.ds.incomingBuffer
  f.storage.update({ settings: { incomingBurstQuietWindowMs: 8000 } })
  const buffer = f.ds.ensureIncomingBuffer()
  assert.notEqual(buffer, oldBuffer)
  assert.equal(oldBuffer.disposed, true)
  assert.equal(buffer.quietWindowMs, 8000)
  assert.deepEqual(buffer.snapshot(f.contact.id).messages.map(message => message.messageId), ['m1'])
})
