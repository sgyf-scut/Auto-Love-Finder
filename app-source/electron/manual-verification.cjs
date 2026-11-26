// Manual verification is a user action. Never solve, dismiss or retry a captcha.
const notices = new WeakMap()
function requestManualVerification(douyin, win, { source = '抖音窗口', now = Date.now(), dialog } = {}) {
  if (!douyin || (typeof douyin !== 'object' && typeof douyin !== 'function')) return false
  try { if (!win?.isDestroyed?.()) { win?.show?.(); win?.focus?.(); win?.moveTop?.() } } catch {}
  const previous = notices.get(douyin)
  if (previous && (previous.open || now - previous.at < 60000)) return false
  const notice = { at: now, open: true }
  notices.set(douyin, notice)
  const message = `抖音要求安全验证，请在“${source}”手动完成滑块或验证码。当前操作已停止或正在等待验证；完成后请回到助手继续或重新开始，不要重复发送已发出的消息。`
  try { douyin.log?.('verification_required', message, { source, manual: true }) } catch {}
  try {
    const api = dialog || require('electron').dialog
    if (typeof api?.showMessageBox !== 'function') { notice.open = false; return true }
    const options = { type: 'warning', title: '抖音需要你手动验证', message: '请手动完成抖音安全验证', detail: message, buttons: ['知道了'], noLink: true }
    const pending = win && !win.isDestroyed?.() ? api.showMessageBox(win, options) : api.showMessageBox(options)
    Promise.resolve(pending).catch(() => {}).finally(() => { notice.open = false })
  } catch { notice.open = false }
  return true
}
module.exports = { requestManualVerification }
