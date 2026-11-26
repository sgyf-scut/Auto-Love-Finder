const { executePageScript } = require('./discovery/page-readiness.cjs')
const EDITOR_SELECTOR = '[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder], [class*="chat" i] [contenteditable="true"], [class*="message" i] [contenteditable="true"], textarea[placeholder], [contenteditable="true"]'
const normalize = text => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function readEditorInput(doc, selector) {
  const node = doc.querySelector(selector)
  return { found: Boolean(node), text: node ? String('value' in node ? node.value : node.innerText || '') : '' }
}
function readMessageDelivery(doc, selector, expected) {
  const clean = text => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  const editor = doc.querySelector(selector)
  const outgoing = [...doc.querySelectorAll('[class*="MessageBoxContentrowBox"]')].filter(row =>
    row.closest('[class*="MessageBoxContentcolumnBox"]')?.classList.contains('MessageBoxContentisFromMe') && clean(row.innerText) === clean(expected))
  return { found: Boolean(editor), text: editor ? String('value' in editor ? editor.value : editor.innerText || '') : '', completeCopies: outgoing.length }
}
function prepareEditorInput(doc, selector, requested, allowedDrafts = [], ownedResiduals = []) {
  const node = doc.querySelector(selector)
  if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true') return { found: false }
  const clean = text => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  const current = String('value' in node ? node.value : node.innerText || '')
  const occupied = Boolean(clean(current))
  const same = clean(current) === clean(requested)
  // A known AI-owned leftover from an earlier turn is not a human draft: it may be
  // cleared and rewritten. Anything else that is non-empty must be preserved.
  const ownedResidual = occupied && !same && ownedResiduals.some(text => clean(text) === clean(current))
  if (occupied && !same && !ownedResidual && !allowedDrafts.some(text => clean(text) === clean(current))) {
    return { found: true, occupied: true, hasText: true, ownedResidual: false, current }
  }
  const value = occupied && !same && !ownedResidual ? current.replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : requested
  node.focus()
  return { found: true, occupied: false, hasText: occupied, ownedResidual, value }
}
function clickMessageSend(doc, selector, expected) {
  const clean = text => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  const editor = doc.querySelector(selector)
  const current = editor ? ('value' in editor ? editor.value : editor.innerText) : ''
  if (!editor || !clean(current) || clean(current) !== clean(expected)) return { attempted: false, reason: 'editor_changed' }
  const candidates = [...doc.querySelectorAll('.e2e-send-msg-btn, [class*="messageMsgInputpublishBtn"], [data-e2e="send-message"]')].filter(node => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
  })
  const controls = candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node)))
  if (controls.length !== 1) return { attempted: false, reason: 'send_button_ambiguous' }
  const button = controls[0]
  const rect = button.getBoundingClientRect()
  // SVG controls have no HTMLElement.click() on some Chromium versions. A single
  // bubbling click reaches Douyin's own handler even in a hidden chat window.
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }))
  return { attempted: true, point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } }
}
async function readInput(win) {
  return executePageScript(win, `(${readEditorInput.toString()})(document, ${JSON.stringify(EDITOR_SELECTOR)})`)
}
async function readDelivery(win, expected) {
  return executePageScript(win, `(${readMessageDelivery.toString()})(document, ${JSON.stringify(EDITOR_SELECTOR)}, ${JSON.stringify(expected)})`)
}
async function focusEditor(win) {
  win.webContents.focus?.()
  const focused = await executePageScript(win, `(() => { const node = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}); if (!node) return false; node.focus(); return true })()`)
  if (!focused) throw new Error('没有找到可用的私信输入框')
}
async function deleteInput(win) {
  await focusEditor(win)
  win.webContents.selectAll()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  await sleep(50)
}
// Delete, then read the box back to confirm it is really empty. A single delete
// event is not proof of success; retry a bounded number of times and report what
// the box still holds so callers can log a real draft_clear_failed.
async function clearInputVerified(win, assertTarget = async () => {}, { attempts = 3 } = {}) {
  let actualText = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await assertTarget()
    await deleteInput(win)
    await sleep(60)
    actualText = (await readInput(win)).text
    if (!normalize(actualText)) return { cleared: true, attempts: attempt, actualText: '' }
  }
  return { cleared: false, attempts, actualText }
}
async function writeMessageInput(win, requested, { allowedDrafts = [], ownedResiduals = [], assertTarget = async () => {} } = {}) {
  await assertTarget()
  const prepared = await executePageScript(win, `(${prepareEditorInput.toString()})(document, ${JSON.stringify(EDITOR_SELECTOR)}, ${JSON.stringify(requested)}, ${JSON.stringify(allowedDrafts)}, ${JSON.stringify(ownedResiduals)})`)
  if (!prepared?.found) throw new Error('没有找到可用的私信输入框')
  if (prepared.occupied) {
    const error = new Error('私信输入框已有其他未发送内容，已保留原草稿')
    error.code = 'USER_DRAFT_PRESENT'
    error.actualText = String(prepared.current || '')
    throw error
  }
  await assertTarget()
  await focusEditor(win)
  if (prepared.hasText) {
    const cleared = await clearInputVerified(win, assertTarget)
    if (!cleared.cleared) {
      const error = new Error('输入框原有内容未成功清除，已停止写入')
      error.code = 'DRAFT_CLEAR_FAILED'
      error.actualText = cleared.actualText
      error.retryCount = cleared.attempts
      throw error
    }
  }
  await assertTarget()
  await focusEditor(win)
  // Chromium's trusted beforeinput lets the rich editor update its document
  // model. Never substitute DOM text or execCommand insertion for this step.
  await win.webContents.insertText(prepared.value)
  await sleep(150)
  const after = await readInput(win)
  if (!after.found || normalize(after.text) !== normalize(prepared.value)) throw new Error('抖音编辑器未正确接收消息内容，已停止发送')
  return prepared.value
}
async function clearMatchingInput(win, expected, assertTarget = async () => {}) {
  const state = await readInput(win)
  if (!state.found) return false
  // 输入框已经是空的：没有需要清理的东西，这属于成功而非失败。否则对方插话导致抖音
  // 重渲染出新的空编辑器节点时，"空 != 期望文本"会被误判成清理失败并刷出假日志。
  if (!normalize(state.text)) return true
  if (normalize(state.text) !== normalize(expected)) return false
  const cleared = await clearInputVerified(win, assertTarget)
  return cleared.cleared
}
module.exports = { EDITOR_SELECTOR, readEditorInput, readMessageDelivery, prepareEditorInput, clickMessageSend, readInput, readDelivery, writeMessageInput, clearMatchingInput, clearInputVerified }
