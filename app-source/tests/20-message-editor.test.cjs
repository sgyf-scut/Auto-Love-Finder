const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { VideoOpeningService } = require('../electron/video-openings.cjs')
const { writeMessageInput, clearMatchingInput } = require('../electron/message-editor.cjs')

const url = 'https://www.douyin.com/video/1234567890123456789'
const message = url + '\n这个小仓鼠也太逗了'
function fixture(text = '', { buttons = 1, clearOnSend = true, deliveredText } = {}) {
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
    sendInputEvent(event) { calls.keys.push(event.keyCode); if (event.type === 'keyDown' && event.keyCode === 'Backspace' && calls.selected) { editor.innerText = ''; calls.deletes++; calls.selected = false } },
    async insertText(value) { calls.inputs.push(value); editor.innerText += value },
    async executeJavaScript(script) { return vm.runInContext(script, context) },
  } }
  return { win, editor, calls }
}

test('video URL and newline caption use native insertion and submit exactly once', async () => {
  const { win, calls } = fixture()
  assert.equal(await writeMessageInput(win, message), message)
  await DouyinService.prototype.sendCurrentInput.call({}, win)
  assert.deepEqual(calls.inputs, [message])
  assert.equal(calls.clicks, 1)
  assert.equal(calls.deletes, 0)
  assert.deepEqual(calls.keys, [])
})
test('matching stale rich-editor draft is cleared natively and rewritten', async () => {
  const { win, calls } = fixture(message + '\u200b')
  await writeMessageInput(win, message)
  assert.equal(calls.deletes, 1)
  assert.deepEqual(calls.inputs, [message])
})
test('allowed spark draft is preserved in content and rewritten natively', async () => {
  const { win, calls } = fixture('早上好')
  assert.equal(await writeMessageInput(win, '早呀', { allowedDrafts: ['早上好'] }), '早上好')
  assert.deepEqual(calls.inputs, ['早上好'])
})
test('unrelated human draft is never replaced or cleared', async () => {
  const { win, calls, editor } = fixture('我还有没写完的消息')
  await assert.rejects(writeMessageInput(win, message), /已保留原草稿/)
  assert.equal(editor.innerText, '我还有没写完的消息')
  assert.equal(calls.inputs.length + calls.deletes + calls.clicks, 0)
  assert.equal(await clearMatchingInput(win, message), false)
  assert.equal(calls.deletes, 0)
})
test('recipient guard failure prevents insertion and cleanup', async () => {
  const { win, calls } = fixture(message)
  const assertTarget = async () => { throw new Error('联系人已变化') }
  await assert.rejects(writeMessageInput(win, message, { assertTarget }), /联系人已变化/)
  await assert.rejects(clearMatchingInput(win, message, assertTarget), /联系人已变化/)
  assert.equal(calls.inputs.length + calls.deletes, 0)
})
test('native editor rejection stops before submission', async () => {
  const { win, calls } = fixture()
  win.webContents.insertText = async () => {}
  await assert.rejects(writeMessageInput(win, message), /未正确接收/)
  assert.equal(calls.clicks, 0)
})
test('missing or ambiguous send control is a safe pre-submission failure', async () => {
  for (const buttons of [0, 2]) {
    const { win, calls } = fixture(message, { buttons })
    await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win), error => error.sendAttempted === false)
    assert.equal(calls.clicks, 0)
    assert.deepEqual(calls.keys, [])
  }
})
test('recipient change in the click renderer turn prevents dispatch', async () => {
  const { win, calls } = fixture(message)
  const original = win.webContents.executeJavaScript
  win.webContents.executeJavaScript = async script => script.includes('const identity =') ? { attempted: false, reason: 'recipient_changed' } : original(script)
  await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win, { name: '测试联系人甲' }), error => error.sendAttempted === false && /联系人已变化/.test(error.message))
  assert.equal(calls.clicks, 0)
})
test('unconfirmed send never repeats click or Return, and remains uncertain', async () => {
  const { win, calls } = fixture(message, { clearOnSend: false })
  await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win), error => error.sendAttempted === true && /停止自动重试/.test(error.message))
  assert.equal(calls.clicks, 1)
  assert.deepEqual(calls.keys, [])
})
test('empty input alone cannot confirm a message when the caption was dropped', async () => {
  const { win, calls } = fixture(message, { deliveredText: url })
  await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win), error => error.sendAttempted === true)
  assert.equal(calls.clicks, 1)
})
test('renderer failure around submission is uncertain, never marked safe to retry', async () => {
  const { win } = fixture(message)
  const original = win.webContents.executeJavaScript
  win.webContents.executeJavaScript = async script => { if (script.includes('clickMessageSend')) throw new Error('renderer disconnected'); return original(script) }
  await assert.rejects(DouyinService.prototype.sendCurrentInput.call({}, win), error => error.sendAttempted === true)
})
test('video pre-submission errors retain a retryable draft and log the failure', async () => {
  const storage = createMemoryStorage({ contacts: [{ name: '朋友' }], videoGreetings: { pending: [{ id: 'v', name: '朋友', url, text: '宠物真可爱' }], sent: [] } })
  const logs = []
  const service = new VideoOpeningService({ storage, partition: 'test', log: (...args) => logs.push(args), sendMessage: async () => { const e = new Error('输入框已有其他草稿'); e.sendAttempted = false; throw e } })
  await assert.rejects(service.send({ id: 'v' }), /其他草稿/)
  assert.equal(storage.get().videoGreetings.pending[0].status, 'retryable')
  assert.equal(logs[0][0], 'video_opening_error')
  assert.equal(logs[0][2].sendAttempted, false)
})
