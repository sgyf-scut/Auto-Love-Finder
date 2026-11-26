const { withVerificationTools } = require('./verification-dom.cjs')
// Browser DOM only. A loaded video is usable even if an unrelated resource never finishes.
function pageReadinessSnapshot({ url } = {}) {
  const visible = n => {
    if (!n) return false
    const r = n.getBoundingClientRect(), s = getComputedStyle(n)
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
  }
  const href = String(location.href), body = String(document.body?.innerText || '')
  const wanted = new URL(url), actual = new URL(href)
  const id = path => path.match(/^\/(?:video|note)\/(\d+)/)?.[1]
  const expectedId = id(wanted.pathname)
  const matches = actual.origin === wanted.origin && (expectedId
    ? (id(actual.pathname) || actual.searchParams.get('modal_id')) === expectedId
    : actual.pathname.replace(/\/$/, '') === wanted.pathname.replace(/\/$/, ''))
  const challenge = detectVerification().challenge
  if (challenge) return { ready: false, code: 'CHALLENGE', href }
  // loadURL starts asynchronously: error text can still belong to the previous video.
  // A visible verification remains account-wide; content/login errors need target identity.
  if (!matches) return { ready: false, matches: false, href, documentState: document.readyState }
  if (/^\s*(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)/i.test(body)) return { ready: false, code: 'NETWORK_ERROR', href }
  if (/作品不存在|作品已删除|视频不存在|你访问的页面不见了/.test(body)) return { ready: false, code: 'VIDEO_NOT_FOUND', href }
  if (/请先登录|登录后.{0,12}(?:评论|查看)/.test(body)) return { ready: false, code: 'LOGIN_REQUIRED', href }
  const content = body.trim().length > 60 || Boolean(document.querySelector('video, [data-e2e="comment-item"], [data-e2e="comment-list"], [data-e2e="video-player-comment"], [data-e2e="feed-comment-icon"], [data-e2e="comment-icon"], a[href*="/video/"], a[href*="/note/"]'))
  return { ready: matches && document.readyState !== 'loading' && content, matches, href, documentState: document.readyState }
}

async function executePageScript(win, code, timeout = 5000) {
  let timer
  try {
    const frame = win.webContents.mainFrame
    const executor = typeof frame?.executeJavaScript === 'function' ? frame : win.webContents
    return await Promise.race([
      executor.executeJavaScript(code),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('页面状态读取超时')), timeout) }),
    ])
  } finally { clearTimeout(timer) }
}

async function readPageState(win, url, timeout = 3000) {
  return executePageScript(win, `(${pageReadinessSnapshot.toString()})(${JSON.stringify({ url })})`, timeout)
}

// One current navigation owns a window. A previous load may still be pending
// after readable DOM was returned; stop and drain it before the next target.
const navigationOwners = new WeakMap()
function contentIdentity(value) {
  try {
    const u = new URL(value)
    return u.origin + '/' + (u.pathname.match(/^\/(?:video|note)\/(\d+)/)?.[1] || u.searchParams.get('modal_id') || u.pathname)
  } catch { return '' }
}
async function navigateReadable(win, url, { timeout = 16000, interval = 250, read = readPageState, isCurrent = () => true } = {}) {
  const previous = navigationOwners.get(win)
  const owner = { pending: true, target: contentIdentity(url), promise: null }
  navigationOwners.set(win, owner)
  let timer, navigationError = '', ignoredNavigationError = ''
  const sleep = ms => new Promise(resolve => { timer = setTimeout(resolve, ms) })
  const current = () => navigationOwners.get(win) === owner && isCurrent()
  const cancelled = () => ({ ok: false, code: 'READ_CANCELLED', reason: '读取任务已切换，旧页面结果已忽略' })
  try {
    if (previous?.pending) {
      try { win.webContents?.stop?.() } catch {}
      if (previous.promise) await Promise.race([previous.promise, sleep(500)])
      clearTimeout(timer)
    }
    if (!current()) return cancelled()
    if (win.isDestroyed?.()) return { ok: false, code: 'WINDOW_CLOSED', reason: '读取窗口已关闭' }
    try {
      owner.promise = Promise.resolve(win.loadURL(url)).catch(error => {
        if (!current()) return
        const failedUrl = error?.url || String(error?.message || '').match(/https?:\/\/[^'"\s]+/)?.[0]
        const message = String(error?.message || error).slice(0, 300)
        if (failedUrl && contentIdentity(failedUrl) !== owner.target) ignoredNavigationError = message
        else navigationError = message
      }).finally(() => { owner.pending = false })
    } catch (error) { owner.pending = false; navigationError = String(error?.message || error).slice(0, 300) }
    const deadline = Date.now() + timeout
    let state = null, lastError = ''
    do {
      if (!current()) return cancelled()
      if (win.isDestroyed?.()) return { ok: false, code: 'WINDOW_CLOSED', reason: '读取窗口已关闭' }
      try { state = await read(win, url, Math.min(3000, Math.max(1, deadline - Date.now()))) }
      catch (error) { lastError = String(error?.message || error).slice(0, 300) }
      if (!current()) return cancelled()
      // A late script result from another document cannot establish readiness.
      const matching = !state?.href || contentIdentity(state.href) === owner.target
      if (state?.code && (matching || state.code === 'CHALLENGE')) return { ok: false, code: state.code, reason: state.code === 'CHALLENGE' ? '请在收集窗口完成安全验证后重试' : '目标页面不可读取', href: state.href, navigationError }
      if (state?.ready && matching) return { ok: true, href: state.href, navigationError, readiness: 'dom' }
      if (Date.now() < deadline) await sleep(Math.min(interval, deadline - Date.now()))
    } while (Date.now() < deadline)
    if (!current()) return cancelled()
    try { win.webContents?.stop?.() } catch {}
    return { ok: false, code: 'TIMEOUT', reason: navigationError || lastError || '目标页面内容未在限定时间内就绪', href: state?.href || '', navigationError, ignoredNavigationError }
  } finally { clearTimeout(timer) }
}

pageReadinessSnapshot = withVerificationTools(pageReadinessSnapshot)
module.exports = { pageReadinessSnapshot, readPageState, navigateReadable, executePageScript }
