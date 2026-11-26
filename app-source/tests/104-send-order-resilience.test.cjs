// 发送链路顺序与容错：先检查再写、写完再检查、只清自己写的、清理失败不静默、
// 用户草稿永不覆盖、AI 残留能自愈。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { ConversationBuffer } = require('../electron/social-brain/conversation-buffer.cjs')
const { writeMessageInput, clearMatchingInput } = require('../electron/message-editor.cjs')

// ---- 输入框 IO 夹具（真实 message-editor 逻辑，可控清空行为） ----
function editorFixture(text = '', { buttons = 1, clearOnSend = true, stuckClear = false, deliveredText } = {}) {
  const calls = { inputs: [], deletes: 0, clicks: 0, keys: [] }
  const editor = { innerText: text, focus() {}, getAttribute() { return null } }
  const outgoing = []
  const controls = Array.from({ length: buttons }, () => ({
    getBoundingClientRect() { return { left: 1106, top: 729, width: 32, height: 32 } },
    getAttribute() { return null }, contains() { return false },
    dispatchEvent(event) {
      assert.equal(event.type, 'click'); calls.clicks++
      if (clearOnSend) {
        outgoing.push({ innerText: deliveredText === undefined ? editor.innerText : deliveredText, closest: () => ({ classList: { contains: () => true } }) })
        editor.innerText = ''
      }
    },
  }))
  const document = { querySelector() { return editor }, querySelectorAll(selector) { return selector.includes('MessageBoxContentrowBox') ? outgoing : controls }, defaultView: {} }
  const context = vm.createContext({ document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MouseEvent: class { constructor(type) { this.type = type } } })
  const win = { webContents: {
    focus() {}, selectAll() { calls.selected = true },
    sendInputEvent(event) {
      calls.keys.push(event.keyCode)
      if (event.type === 'keyDown' && event.keyCode === 'Backspace' && calls.selected) {
        calls.deletes++
        if (!stuckClear) editor.innerText = ''
        calls.selected = false
      }
    },
    async insertText(value) { calls.inputs.push(value); editor.innerText += value },
    async executeJavaScript(script) { return vm.runInContext(script, context) },
  } }
  return { win, editor, calls }
}

// ---- sendMessage 夹具（用真实 sendMessage 源码 + 可控的输入框/清理桩） ----
function sendFixture({ guard, clearResult = true, ownedText = '', box = { text: '' } } = {}) {
  const contacts = [{ id: 'contact-A', name: 'A', profile: {}, learning: { messages: [] } }]
  const storage = createMemoryStorage({ contacts, settings: {}, automation: {} })
  const ds = new DouyinService({ storage, emit() {}, ai: {} })
  const win = { isDestroyed: () => false, webContents: { sendInputEvent() {}, async executeJavaScript() { return true } } }
  ds.window = win
  ds.selectConversation = async () => win
  ds.waitForEditor = async () => {}
  ds.assertConversationTarget = async () => {}
  ds.assertCanSend = () => {}
  ds.recordSuccessfulSend = () => {}
  ds.recordConversationMessage = () => ({ id: 'contact-A' })
  ds.queueCompletedSharedInteraction = () => {}
  ds.recordExpressionTurn = () => {}
  ds.sendCurrentInput = async (_win, options) => { await options.assertTarget?.() }
  if (ownedText) ds.markAiOwnedEditorWrite('A', { text: ownedText })
  const calls = { writes: [], clears: [], guard: 0, sends: 0 }
  const source = DouyinService.prototype.sendMessage.toString().replace(/^async sendMessage/, 'async function')
  const send = vm.runInNewContext('(' + source + ')', { require, REPLY_FREQUENCY_SECONDS: {}, normalizeEditorText: x => x, sleep: async () => {},
    writeMessageInput: async (_win, text, opts) => { calls.writes.push({ text, ownedResiduals: opts?.ownedResiduals || [] }); box.text = text; return text },
    clearMatchingInput: async (_win, expected) => { calls.clears.push(expected); if (clearResult) box.text = ''; return clearResult } })
  ds.sendMessage = send.bind(ds)
  const beforeSubmit = async () => { calls.guard += 1; return guard?.(calls.guard) }
  return { ds, storage, calls, box, beforeSubmit }
}

const logsOf = (storage, type) => (storage.get().logs || []).filter(log => log.type === type)

// 1. stale 在写入前发生 → 输入框完全不变化
test('stale before write: the editor is never touched', async () => {
  const f = sendFixture({ guard: call => { if (call === 1) throw Object.assign(new Error('对方又发来了消息'), { code: 'BURST_STALE' }) } })
  await assert.rejects(f.ds.sendMessage('A', '新回复', { ai: true, beforeSubmit: f.beforeSubmit }), { code: 'BURST_STALE' })
  assert.equal(f.calls.writes.length, 0)
  assert.equal(f.box.text, '')
  assert.equal(f.calls.sends, 0)
})

// 2. stale 在写入后发生 → AI 自己的文本被清理
test('stale after write: the AI text is cleared back out of the editor', async () => {
  const f = sendFixture({ guard: call => { if (call === 2) throw Object.assign(new Error('对方又发来了消息'), { code: 'BURST_STALE' }) } })
  await assert.rejects(f.ds.sendMessage('A', '新回复', { ai: true, beforeSubmit: f.beforeSubmit }), { code: 'BURST_STALE' })
  assert.equal(f.calls.writes.length, 1)
  assert.deepEqual(f.calls.clears, ['新回复'])
  assert.equal(f.box.text, '')
  assert.equal(logsOf(f.storage, 'draft_clear_failed').length, 0)
  assert.equal(f.ds.aiOwnedEditorWrites.size, 0)
})

// 3. 用户在 AI 写入后修改了草稿 → 不允许自动清空
test('human edits after the AI write: the draft is never force-cleared', async () => {
  const f = sendFixture({ guard: call => { if (call === 2) throw Object.assign(new Error('对方又发来了消息'), { code: 'BURST_STALE' }) }, clearResult: false })
  await assert.rejects(f.ds.sendMessage('A', '新回复', { ai: true, beforeSubmit: f.beforeSubmit }), { code: 'BURST_STALE' })
  assert.deepEqual(f.calls.clears, ['新回复'])
  assert.equal(f.box.text, '新回复')
  const failed = logsOf(f.storage, 'draft_clear_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].detail.expectedText, '新回复')
})

// 4. 上一轮 AI 残留存在 → 下一轮自动识别并恢复（写入时作为可清理内容传入 + 真实清空重写）
test('previous AI leftover: the next turn recognises and recovers it', async () => {
  const f = sendFixture({ ownedText: '上一轮的旧回复' })
  await f.ds.sendMessage('A', '新回复', { ai: true })
  assert.deepEqual(f.calls.writes[0].ownedResiduals, ['上一轮的旧回复'])

  const { win, editor, calls } = editorFixture('上一轮的旧回复')
  assert.equal(await writeMessageInput(win, '新回复', { ownedResiduals: ['上一轮的旧回复'] }), '新回复')
  assert.equal(editor.innerText, '新回复')
  assert.deepEqual(calls.inputs, ['新回复'])
  assert.ok(calls.deletes >= 1)
})

// 5. 真人原有草稿存在 → 保留，不覆盖
test('real human draft: preserved, never overwritten or deleted', async () => {
  const { win, editor, calls } = editorFixture('我还有没写完的消息')
  await assert.rejects(writeMessageInput(win, '新回复', { ownedResiduals: ['上一轮的旧回复'] }), error => error.code === 'USER_DRAFT_PRESENT')
  assert.equal(editor.innerText, '我还有没写完的消息')
  assert.equal(calls.inputs.length + calls.deletes + calls.clicks, 0)
  assert.equal(await clearMatchingInput(win, '新回复'), false)
  assert.equal(calls.deletes, 0)
})

// 6. clear 失败 → 产生 draft_clear_failed（编辑器报错码 + 发送层明确日志）
test('clear failure: DRAFT_CLEAR_FAILED and an explicit draft_clear_failed log', async () => {
  const { win, editor, calls } = editorFixture('上一轮的旧回复', { stuckClear: true })
  await assert.rejects(writeMessageInput(win, '新回复', { ownedResiduals: ['上一轮的旧回复'] }), error => error.code === 'DRAFT_CLEAR_FAILED' && error.retryCount === 3 && error.actualText === '上一轮的旧回复')
  assert.equal(calls.deletes, 3)
  assert.equal(editor.innerText, '上一轮的旧回复')

  const f = sendFixture({ guard: call => { if (call === 2) throw Object.assign(new Error('对方又发来了消息'), { code: 'BURST_STALE' }) }, clearResult: false })
  await assert.rejects(f.ds.sendMessage('A', '新回复', { ai: true, beforeSubmit: f.beforeSubmit }), { code: 'BURST_STALE' })
  const failed = logsOf(f.storage, 'draft_clear_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].detail.name, 'A')
  // 日志字段必须来自真实的清理结果，而不是抛出的 stale 错误：后者没有这些字段，
  // 会让 actualText 恒为空、retryCount 恒为 3，无法定位问题。
  assert.equal(failed[0].detail.reason, 'editor_text_changed')
  assert.equal(failed[0].detail.retryCount, 0)
  assert.equal(failed[0].detail.expectedText, '新回复')
})

// ---- 多气泡：每个 bubble 独立检查 ----
function bubbleFixture(t, { draft, sendImpl } = {}) {
  let now = 1000, sequence = 0
  const timers = new Map()
  const contact = { id: 'test-contact', name: '测试联系人', preview: '你好', profile: {}, fromMe: false, learning: { messages: [] }, turn: {} }
  const storage = createMemoryStorage({ contacts: [contact], providers: [{ model: 'mock' }], settings: {
    incomingBurstEnabled: true, incomingBurstQuietWindowMs: 4000, incomingBurstMaxWindowMs: 15000,
    showAiModelLabel: false, aiReplyDraftOnly: false, longTermMemory: false,
  } })
  const calls = { attempts: [], sends: [] }
  const ai = { hasProvider: () => true, async draft() { return draft || { ok: true, text: '第一条', text2: '第二条' } } }
  const ds = new DouyinService({ storage, ai, partition: 'persist:bubble-order-test', emit() {} })
  ds.incomingBuffer = new ConversationBuffer({ namespace: ds.partition, clock: () => now,
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id },
    clearTimer(id) { timers.delete(id) } })
  ds.bufferEpoch = 'test-epoch'
  ds.burstObservedIds = new Map()
  const visible = []
  const win = { isDestroyed: () => false }
  ds.window = win
  ds.selectConversation = async () => win
  ds.assertConversationTarget = async () => {}
  ds.captureVisibleMessages = async () => structuredClone(visible)
  ds.captureLatestIncomingMessageIdentity = async () => { const message = visible.at(-1); return message ? { role: message.role, fingerprint: message.messageId, messageId: message.messageId, message } : null }
  ds.isLastMessageFromMe = async () => visible.at(-1)?.role === 'me'
  ds.sendMessage = async (name, text) => {
    calls.attempts.push(text)
    const failure = sendImpl?.(text, calls.attempts.length)
    if (failure) throw failure
    calls.sends.push(text)
  }
  const ctx = { contacts: [contact], settings: storage.get().settings, today: '2026-10-16', factCandidates: [], topicCandidates: [],
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
  function advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } }
  const originalRandom = Math.random
  Math.random = () => 0 // 打字延迟取最小值，保持测试快速且确定
  t.after(async () => { Math.random = originalRandom; await ds.burstQuietObserver?.stop(); ds.incomingBuffer.dispose() })
  return { ds, storage, calls, contact, ctx, add, advance, async handle() { return ds.handleIncomingItem(ds.incomingQueueMap().get(contact.name), contact, ctx) } }
}

const staleError = () => Object.assign(new Error('对方又发来了消息，旧回复已作废'), { code: 'BURST_STALE', stale: true })

// 7. 第二个 bubble 准备发送时对方插话 → bubble2 不发，且不留残余
test('bubble 2 goes stale: it is not sent and no residual state is left', async t => {
  const f = bubbleFixture(t, { sendImpl: (_text, attempt) => attempt === 2 ? staleError() : null })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'consumed')
  assert.deepEqual(f.calls.attempts, ['第一条', '第二条'])
  assert.deepEqual(f.calls.sends, ['第一条'])
  assert.equal(logsOf(f.storage, 'followup_cancelled').length, 1)
  assert.equal(f.ds.aiOwnedEditorWrites.size, 0)
  assert.equal(f.ds.userDraftBlocks.size, 0)
})

// 8. 三气泡中第二条后对方插话 → 后续全部停止
test('interjection after bubble 2 stops every later bubble', async t => {
  const f = bubbleFixture(t, { draft: { ok: true, text: '第一条', text2: '第二条', text3: '第三条' }, sendImpl: (_text, attempt) => attempt === 3 ? staleError() : null })
  f.add('m1', '第一句'); f.advance(4000)
  assert.equal(await f.handle(), 'consumed')
  assert.deepEqual(f.calls.attempts, ['第一条', '第二条', '第三条'])
  assert.deepEqual(f.calls.sends, ['第一条', '第二条'])
  const cancelled = logsOf(f.storage, 'followup_cancelled')
  assert.equal(cancelled.length, 1)
  assert.ok(/第3条/.test(cancelled[0].message))
  assert.equal(f.ds.aiOwnedEditorWrites.size, 0)
})

// 9. 一个联系人被 USER_DRAFT_PRESENT 阻塞 → 不影响其他联系人发送
test('a contact blocked by a human draft does not block other contacts', () => {
  const contacts = [{ id: 'A', name: 'A', profile: {}, learning: { messages: [] } }, { id: 'B', name: 'B', profile: {}, learning: { messages: [] } }]
  const storage = createMemoryStorage({ contacts, settings: { incomingBurstEnabled: false } })
  const ds = new DouyinService({ storage, emit() {}, ai: {} })
  ds.enqueueIncoming({ name: 'A', key: 'a1', preview: '你好', enqueuedAt: Date.now() })
  ds.enqueueIncoming({ name: 'B', key: 'b1', preview: '你好', enqueuedAt: Date.now() })
  ds.blockUserDraftContact('A', { code: 'USER_DRAFT_PRESENT', actualText: '我的草稿' })
  const ctx = { contacts, settings: storage.get().settings, canSend: () => true }
  const plans = () => new Map(ds.planIncomingQueue(ctx).map(plan => [plan.item.name, plan]))
  assert.deepEqual({ action: plans().get('A').action, reason: plans().get('A').reason }, { action: 'hold', reason: 'user_draft_present' })
  assert.equal(plans().get('B').action, 'reply')
  assert.equal(logsOf(storage, 'user_draft_present').length, 1)
  // 用户手动发送即视为重新触发，解除阻塞
  ds.releaseUserDraftBlock('A')
  assert.equal(plans().get('A').action, 'reply')
  // 对方又发来新消息（key 变化）也会自动恢复
  ds.blockUserDraftContact('A', { code: 'USER_DRAFT_PRESENT' })
  assert.equal(plans().get('A').action, 'hold')
  ds.enqueueIncoming({ name: 'A', key: 'a2', preview: '在吗', enqueuedAt: Date.now() })
  assert.equal(plans().get('A').action, 'reply')
})

// 10. 对方插话导致抖音重渲染出空编辑器 → 视为"已清空"，绝不误报 draft_clear_failed
test('re-rendered empty editor counts as cleared, never a false draft_clear_failed', async () => {
  const { win, calls } = editorFixture('')
  assert.equal(await clearMatchingInput(win, '上一轮的旧回复'), true)
  assert.equal(calls.deletes, 0)
  const f = sendFixture({ guard: call => { if (call === 2) throw Object.assign(new Error('对方又发来了消息'), { code: 'BURST_STALE' }) }, clearResult: true })
  await assert.rejects(f.ds.sendMessage('A', '新回复', { ai: true, beforeSubmit: f.beforeSubmit }), { code: 'BURST_STALE' })
  assert.equal(logsOf(f.storage, 'draft_clear_failed').length, 0)
  assert.equal(f.ds.aiOwnedEditorWrites.size, 0)
})
