const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { createExpressionBatch } = require('../electron/expression-batch.cjs')
const { ConversationBuffer } = require('../electron/social-brain/conversation-buffer.cjs')
const sticker = { mode: 'STICKER_ONLY', stickerIntent: 'TEASE', stickerPosition: 'only' }
const combo = { mode: 'TEXT_AND_STICKER', stickerIntent: 'SPEECHLESS', stickerPosition: 'after_text' }
test('manual expression waits for a busy automatic reply instead of navigating away from it', async t => {
  const f = service(t); f.ds.polling = true
  f.ds.selectConversation = async () => assert.fail('must not interrupt active reply')
  await assert.rejects(f.ds.sendExpression(f.contact.name, sticker), /自动回复正在处理/)
  assert.equal((f.storage.get().expressionBatches || []).length, 0)
})
test('background polling cannot change conversation while a manual expression owns preparation or sending', async t => {
  const f = service(t)
  f.ds.getStatus = async () => assert.fail('must not navigate or inspect another conversation')
  f.ds.expressionPreparing.add('manual-preparation')
  await f.ds.runAutomation()
  f.ds.expressionPreparing.clear(); f.ds.expressionSending.add('manual-sending')
  await f.ds.runAutomation()
})
function service(t, initial = {}) {
  const contact = { id: 'c1', name: '测试联系人', preview: '你又迟到了吧', profile: { chatMode: 'old_friend' }, learning: { messages: [] }, turn: {} }
  const storage = createMemoryStorage({ contacts: [contact], ...initial })
  storage.update({ settings: { favoriteStickerEnabled: true } })
  const ds = new DouyinService({ storage, emit() {}, partition: 'test-expression' })
  const win = { isDestroyed: () => false, webContents: { async executeJavaScript(script) {
    if (script.startsWith('(function activeChatIdentity')) return { verified: true, platformUserId: 'uid' }
    return { ok: false, reason: 'emoji_panel_missing' }
  } } }
  ds.window = win; ds.selectConversation = async () => win
  ds.assertConversationTarget = async () => ({ isTargetMatch: true })
  ds.captureVisibleMessages = async () => [{ role: 'contact', text: contact.preview, type: 'text', messageId: 'm1' }]
  ds.captureLatestIncomingMessageIdentity = async () => ({ role: 'contact', fingerprint: 'm1', messageId: 'm1', message: { role: 'contact', text: contact.preview, type: 'text', messageId: 'm1' } })
  ds.isLastMessageFromMe = async () => false
  t.after(async () => { await ds.burstQuietObserver?.stop(); ds.incomingBuffer?.dispose() })
  return { ds, storage, contact, win }
}
test('automation STICKER_ONLY enters preview draft without sending or empty retry', async t => {
  const f = service(t, { settings: { aiReplyDraftOnly: true, longTermMemory: false, showAiModelLabel: false } })
  f.ds.ai = { hasProvider: () => true, draft: async () => ({ ok: true, text: '', expression: sticker }) }
  f.ds.sendExpression = async () => assert.fail('draft must not send')
  const item = { name: f.contact.name, key: 'm1', preview: f.contact.preview }
  f.ds.enqueueIncoming(item)
  const ctx = { contacts: [f.contact], settings: f.storage.get().settings, today: '2026-10-13', factCandidates: [], topicCandidates: [], autoReplyOn: true, blacklist: new Set(), aiDisabledContacts: new Set(), canSend: () => true }
  assert.equal(await f.ds.handleIncomingItem(item, f.contact, ctx), 'consumed')
  const draft = f.storage.get().pendingDrafts[0]
  assert.equal(draft.text, ''); assert.deepEqual(draft.expression, sticker); assert.equal((f.storage.get().expressionBatches || []).length, 0)
})
test('automation combined expression preview stores text and semantic intent', async t => {
  const f = service(t, { settings: { aiReplyDraftOnly: true, longTermMemory: false, showAiModelLabel: false } })
  f.ds.ai = { hasProvider: () => true, draft: async () => ({ ok: true, text: '你是真行', expression: combo }) }
  const item = { name: f.contact.name, key: 'm1', preview: f.contact.preview }; f.ds.enqueueIncoming(item)
  const ctx = { contacts: [f.contact], settings: f.storage.get().settings, today: '2026-10-13', factCandidates: [], topicCandidates: [], autoReplyOn: true, blacklist: new Set(), aiDisabledContacts: new Set(), canSend: () => true }
  await f.ds.handleIncomingItem(item, f.contact, ctx)
  assert.equal(f.storage.get().pendingDrafts[0].text, '你是真行'); assert.deepEqual(f.storage.get().pendingDrafts[0].expression, combo)
})
test('expression sender respects pause, blacklist and contact AI switch', t => {
  for (const patch of [{ automation: { paused: true } }, { automation: { blacklist: ['测试联系人'] } }, { contacts: [{ id: 'c1', name: '测试联系人', profile: { aiEnabled: false } }] }, { settings: { favoriteStickerEnabled: false } }]) {
    const f = service(t); f.storage.update(patch); assert.throws(() => f.ds.assertExpressionAllowed(f.contact.name))
  }
})
test('expression sender reserves daily quota for both items', async t => {
  const f = service(t, { automation: { dailyLimit: 1 } })
  await assert.rejects(f.ds.sendExpression(f.contact.name, combo, { text: '你是真行' }), /额度/)
  assert.equal((f.storage.get().expressionBatches || []).length, 0)
})
test('expression turn ledger does not consume daily message quota', t => {
  const f = service(t, { automation: { dailyLimit: 2 } })
  f.ds.recordSuccessfulSend(f.contact.name, 'text'); f.ds.recordExpressionTurn(f.contact.name, { mode: 'TEXT_ONLY', stickerIntent: 'NONE' }, 'batch-1')
  f.ds.recordExpressionTurn(f.contact.name, combo, 'batch-1')
  assert.equal(f.storage.get().sendHistory.length, 2); assert.equal(f.ds.getSendAllowance(f.contact.name).sentToday, 1)
})
test('expression first text delivered second panel failed persists recovery and does not count completed turn', async t => {
  const f = service(t); const sent = []
  f.ds.sendMessage = async (name, text, metadata) => { await metadata.beforeSubmit?.(); sent.push(text); return { ok: true } }
  const result = await f.ds.sendExpression(f.contact.name, combo, { text: '你是真行' })
  assert.equal(result.status, 'FAILED'); assert.deepEqual(sent, ['你是真行'])
  assert.equal(result.batch.items[0].status, 'sent'); assert.equal(result.batch.items[1].status, 'failed')
  assert.equal((f.storage.get().sendHistory || []).filter(item => item.kind === 'expression_turn').length, 0)
  await f.ds.resumeExpressionBatch(result.batchId)
  assert.deepEqual(sent, ['你是真行'])
})
test('expression UNKNOWN batch never calls text or opens DOM on resume', async t => {
  const f = service(t); const batch = createExpressionBatch(f.contact.name, combo, '你是真行')
  batch.items[0].status = 'sent'; batch.items[1].status = 'unknown'; batch.status = 'unknown'; f.ds.persistExpressionBatch(batch)
  f.ds.selectConversation = async () => assert.fail('unknown must not navigate')
  assert.equal((await f.ds.resumeExpressionBatch(batch.id)).status, 'UNKNOWN')
})
test('expression resume rejects changed inbound before remaining sticker', async t => {
  const f = service(t); const batch = createExpressionBatch(f.contact.name, combo, '你是真行')
  Object.assign(batch, { platformUserId: 'uid', contactId: 'c1', latestIncomingMessageId: 'old-m0' }); batch.items[0].status = 'sent'; f.ds.persistExpressionBatch(batch)
  const result = await f.ds.resumeExpressionBatch(batch.id)
  assert.equal(result.status, 'FAILED'); assert.equal(result.batch.status, 'stale'); assert.equal(result.batch.items[1].status, 'pending')
})
test('expression approval stale draft never creates sending ledger', async t => {
  const f = service(t); f.storage.update({ pendingDrafts: [{ id: 1, name: f.contact.name, text: '', expression: sticker, status: 'outdated' }] })
  await assert.rejects(f.ds.approveExpressionDraft(1)); assert.equal((f.storage.get().expressionBatches || []).length, 0)
})
test('expression approval failing second item binds draft to same batch for recovery', async t => {
  const f = service(t); f.storage.update({ pendingDrafts: [{ id: 1, name: f.contact.name, text: '你是真行', expression: combo, status: 'pending' }] })
  const sent = []; f.ds.sendMessage = async (name, text, metadata) => { await metadata.beforeSubmit?.(); sent.push(text); return { ok: true } }
  const result = await f.ds.approveExpressionDraft(1)
  assert.equal(f.storage.get().pendingDrafts[0].expressionBatchId, result.batchId)
  await f.ds.approveExpressionDraft(1, '修改后不应重发第一条')
  assert.deepEqual(sent, ['你是真行'])
})
test('expression continuation skips interval but still checks limits', t => {
  const f = service(t); f.storage.update({ contacts: [{ ...f.contact, profile: { frequency: '60s' } }] }); f.ds.lastReplyTime.set(f.contact.name, Date.now())
  assert.throws(() => f.ds.assertExpressionAllowed(f.contact.name), /间隔/)
  assert.doesNotThrow(() => f.ds.assertExpressionAllowed(f.contact.name, { continuation: true }))
  f.storage.update({ automation: { dailyLimit: 1 } }); f.ds.recordSuccessfulSend(f.contact.name, 'text')
  assert.throws(() => f.ds.assertExpressionAllowed(f.contact.name, { continuation: true }), /上限/)
})
test('known outgoing sticker echo does not invalidate burst but unrecognized self reply does', async t => {
  const f = service(t, { settings: { incomingBurstEnabled: true } })
  f.ds.incomingBuffer = new ConversationBuffer({ namespace: f.ds.partition, quietWindowMs: 0, maxBurstWindowMs: 1 })
  f.ds.burstObservedIds = new Map([['c1', new Set(['m1'])]])
  f.ds.incomingBuffer.append('c1', { role: 'contact', messageId: 'm1', text: 'hi' })
  let invalidations = 0; const original = f.ds.incomingBuffer.invalidate.bind(f.ds.incomingBuffer)
  f.ds.incomingBuffer.invalidate = id => { invalidations++; return original(id) }
  f.ds._burstExpectedOutgoing = { contactId: 'c1', expressions: [{ src: 'expected.png' }] }
  f.ds.captureVisibleMessages = async () => [{ role: 'me', messageId: 's1', text: '', mediaEvidence: { urls: ['expected.png'] } }]
  await f.ds.observeIncomingBurst(f.contact.name, f.win); assert.equal(invalidations, 0)
  f.ds.captureVisibleMessages = async () => [{ role: 'me', messageId: 's2', text: '本人手动插话' }]
  await f.ds.observeIncomingBurst(f.contact.name, f.win); assert.equal(invalidations, 1)
})
test('expression discarded while first item sends cannot continue or resurrect cancelled batch', async t => {
  const f = service(t)
  f.ds.sendMessage = async () => {
    const batch = f.storage.get().expressionBatches[0]; batch.status = 'cancelled'; f.storage.update({ expressionBatches: [batch] }); return { ok: true }
  }
  const result = await f.ds.sendExpression(f.contact.name, combo, { text: '你是真行' })
  assert.equal(result.status, 'FAILED'); assert.equal(f.storage.get().expressionBatches[0].status, 'cancelled')
  assert.equal(f.storage.get().expressionBatches[0].items[0].status, 'sent'); assert.equal(f.storage.get().expressionBatches[0].items[1].status, 'pending')
  assert.equal((await f.ds.resumeExpressionBatch(result.batchId)).status, 'FAILED')
})
test('expression preparation reserves contact before asynchronous work', async t => {
  const f = service(t); let release
  const wait = new Promise(resolve => { release = resolve })
  const first = f.ds.sendExpression(f.contact.name, sticker, { beforeSubmit: () => wait })
  await assert.rejects(f.ds.sendExpression(f.contact.name, sticker), /正在进行/)
  release(); await first
  assert.equal(f.storage.get().expressionBatches.length, 1)
})
test('automatic expression rechecks automatic reply switch, manual approval remains usable', t => {
  const f = service(t); f.storage.update({ automation: { autoReply: false } })
  assert.throws(() => f.ds.assertExpressionAllowed(f.contact.name, { automaticReply: true }), /自动回复已关闭/)
  assert.doesNotThrow(() => f.ds.assertExpressionAllowed(f.contact.name))
})
