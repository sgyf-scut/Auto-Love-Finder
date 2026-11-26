const { videoCommentCountSnapshot } = require('./video-comment-count.cjs')
const { requestManualVerification } = require('../manual-verification.cjs')
// P2-10 页面读取通道：复用应用已登录的抖音会话，用独立隐藏窗口打开视频页，
// 只读取页面已经渲染出来的公开评论，不构造签名接口、不绕过反爬。
const { session, net } = require('electron')
const { FriendshipService } = require('../friendship.cjs')
const { collectCommentRows, videoCommentsState, openCommentPanel, advanceCommentViewport, readCommentReplies, publicProfileSnapshot } = require('./comment-snapshot.cjs')
const { navigationUrl } = require('../navigation-policy.cjs')
const { canonicalProfile } = require('./candidate-manager.cjs')
const { resolveDouyinTarget } = require('./douyin-link.cjs')
const { navigateReadable, executePageScript, readPageState } = require('./page-readiness.cjs')
const { profileUnavailableSnapshot } = require('./profile-navigation-tools.cjs')

const LOGIN_COOKIES = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss', 'passport_auth_status', 'passport_auth_status_ss']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const accessCheck = '/访问过于频繁|访问受限|操作频繁|请求过于频繁/.test(document.body?.innerText || "")'
// 分享页域名：短链只在这里跳一次，随后由平台 302 到 www.douyin.com 作品页。
const SHARE_HOST = /^https:\/\/(?:v\.douyin\.com|www\.iesdouyin\.com)(?:\/|$)/i
const CONTENT_URL = /(?:\/(?:video|note)\/|modal_id=)\d+/
// 浏览器 UA 兜底：窗口未就绪时 getUserAgent() 可能为空，空的 UA 会被抖音当作异常客户端。
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const dropBody = response => { try { response?.body?.cancel?.() } catch { /* 忽略取消失败 */ } return response }

class CommentCollectionService extends FriendshipService {
  constructor(douyin, { accountId = '' } = {}) {
    super(douyin)
    this.accountId = accountId || douyin.accountId || ''
    this.running = false
  }

  // 收集窗口额外放行分享短链：否则 v.douyin.com 会被导航策略拦成 ERR_FAILED。
  allowNavigation(url) {
    return super.allowNavigation(url) || SHARE_HOST.test(String(url || ''))
  }

  ensureWindow() {
    const win = super.ensureWindow()
    win.setTitle?.('收集评论 · 抖音')
    return win
  }

  hasLoginCookie(cookies) {
    return (cookies || []).some(({ name }) => LOGIN_COOKIES.includes(name))
  }

  // Loading a target page and opening its comments have separate bounded waits.
  // A slow first navigation must not be mistaken for a missing comment panel.
  async navigate(win, url, { isCurrent = () => true, profileEntry = false, assertActive, timeoutMs = 30000 } = {}) {
    const read = profileEntry ? async (page, target, timeout) => {
      assertActive?.()
      const restricted = await executePageScript(page, accessCheck, Math.min(timeout, 1000)).catch(() => false)
      assertActive?.()
      return restricted ? { code: 'ACCESS_RESTRICTED' } : readPageState(page, target, timeout)
    } : undefined
    const result = await navigateReadable(win, url, { timeout: Math.max(1, Math.min(30000, timeoutMs, assertActive?.remainingMs?.() ?? Infinity)), isCurrent: () => { try { assertActive?.(); return isCurrent() } catch { return false } }, read })
    assertActive?.()
    if (!result.ok) {
      const error = new Error(result.reason || result.code)
      error.code = result.code
      error.diagnostics = { stage: 'navigation', expectedUrl: url.split(/[?#]/)[0], currentPage: result.href || '', navigationError: result.navigationError || '', ignoredNavigationError: result.ignoredNavigationError || '' }
      if (result.code === 'CHALLENGE') requestManualVerification(this.douyin, win, { source: '收集评论窗口' })
      throw error
    }
  }

  // 风控验证页必须由用户手动完成：把窗口显示到最前，避免用户不知道要验证。
  presentWindow(win) {
    try {
      if (win.isDestroyed()) return
      if (!win.isVisible()) win.show()
      win.focus()
      win.moveTop?.()
    } catch { /* 窗口不可用时忽略 */ }
  }

  // 等用户完成滑块/验证码。验证通过后页面会自己跳回作品页，这里轮询到“可读”为止。
  async waitForVerification(win, { timeout = 120000, interval = 1000 } = {}) {
    requestManualVerification(this.douyin, win, { source: '收集评论窗口' })
    const deadline = Date.now() + timeout
    let last = null
    let clearedAt = 0
    do {
      last = await executePageScript(win, `(${videoCommentsState.toString()})()`).catch(() => null)
      if (last && !last.wrongPage) {
        if (last.removed || last.commentsClosed || last.loginRequired || last.serverError) return last
        if (!last.challenge) {
          if (last.ready || last.totalRows > 0) return last
          // 验证通过后页面可能还在重载：再给 15 秒渲染作品页。
          clearedAt = clearedAt || Date.now()
          if (Date.now() - clearedAt > 15000) return last
        }
      }
      await sleep(interval)
    } while (Date.now() < deadline)
    return last || { challenge: true }
  }

  // Shared by first-page and resumed-page reads. Opening is bounded separately
  // from reading rows, so a missing/hydrating entry is not blindly clicked once.
  async ensureCommentPanel(win, videoId, { timeout = 10000, interval = 250, clickInterval = 2000, maxClicks = 3, loadingTimeout = 30000, onPhase = () => {}, isCurrent = () => true, assertActive, deadlineAt = Infinity } = {}) {
    const started = Date.now(), hardDeadline = Math.min(started + timeout + loadingTimeout, deadlineAt)
    let deadline = hardDeadline, activeMs = 0, loadingMs = 0, previousAt = started, wasLoading = false, phase = null
    let loadingProbe = false, firstEntryAt = null, entryKey = null, stableSince = null
    const limit = Math.max(0, Math.min(3, Math.floor(Number(maxClicks) || 0)))
    // Keep a trusted click near the end of the opening window. Previously the
    // three attempts were exhausted while the visible page was still hydrating.
    const spacing = Math.max(clickInterval, timeout / Math.max(1, limit - 0.5))
    let last = null, lastEntry = null, clicks = 0, attempts = 0, nextClickAt = 0
    let scriptErrors = 0, entryReads = 0, lastScriptError = '', lastErrorPhase = ''
    let clickErrors = 0, lastClickError = ''
    const events = []
    const record = event => { events.push({ atMs: Date.now() - started, ...event }); if (events.length > 12) events.shift() }
    const message = error => String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240)
    const updateTime = () => {
      const at = Date.now(), elapsed = at - previousAt
      if (wasLoading) loadingMs += elapsed
      else activeMs += elapsed
      previousAt = at
      return at
    }
    const finish = result => {
      updateTime()
      let currentPage = ''
      try { currentPage = String(win.webContents.getURL?.() || '').split(/[?#]/)[0].slice(0, 240) } catch {}
      return { ...(last || {}), ...result, openClicks: clicks, openDiagnostics: {
        attempts, clicks, scriptErrors, lastScriptError, lastErrorPhase, clickErrors, lastClickError,
        entrySource: lastEntry?.source || null, entryPoint: lastEntry?.point || null,
        entryFailure: lastEntry?.reason || null, elapsedMs: Date.now() - started, loadingWaitMs: loadingMs, openingWaitMs: activeMs,
        pageLoading: last?.pageLoading === true, mediaBuffering: last?.mediaBuffering === true, currentPage, events,
      } }
    }
    const read = async (phase, code) => {
      try {
        const value = await executePageScript(win, code, Math.min(3000, Math.max(1, deadline - Date.now())))
        if (!value || typeof value !== 'object') throw new Error('页面脚本未返回有效状态')
        if (phase === 'entry_read') entryReads++
        return value
      } catch (error) {
        scriptErrors++; lastScriptError = message(error); lastErrorPhase = phase
        record({ phase, error: lastScriptError })
        return null
      }
    }
    const blocked = state => state?.wrongPage || state?.challenge || state?.loginRequired || state?.serverError || state?.commentsClosed || state?.removed
    this.presentWindow(win)
    do {
      await assertActive?.()
      if (!isCurrent()) return finish({ cancelled: true, panelOpened: false })
      if (win.isDestroyed?.() || win.webContents.isDestroyed?.()) return finish({ windowClosed: true, panelOpened: false })
      last = await read('state_read', `(${videoCommentsState.toString()})(${JSON.stringify(String(videoId))})`)
      if (!isCurrent()) return finish({ cancelled: true, panelOpened: false })
      if (blocked(last)) return finish(last)
      if (last?.ready || last?.panelVisible) return finish({ panelOpened: true })
      let observedEntry = null
      if (last) observedEntry = await read('entry_read', `(${openCommentPanel.toString()})(${JSON.stringify(String(videoId))},${JSON.stringify({ activate: false })})`)
      if (!isCurrent()) return finish({ cancelled: true, panelOpened: false })
      if (observedEntry) lastEntry = observedEntry
      if (blocked(observedEntry)) return finish(observedEntry)
      if (observedEntry?.ready || observedEntry?.panelVisible) return finish({ ...observedEntry, panelOpened: true })
      const at = updateTime()
      const key = observedEntry?.point ? `${observedEntry.source}:${observedEntry.point.x}:${observedEntry.point.y}` : null
      if (key !== entryKey) {
        if (entryKey && last?.documentState) activeMs = 0
        entryKey = key; stableSince = at
      }
      const settling = Boolean(key && last?.documentState && at - stableSince < 600)
      wasLoading = last?.pageLoading === true || observedEntry?.reason === 'entry_not_ready' || settling
      const nextPhase = wasLoading ? 'loading' : 'opening'
      if (phase !== nextPhase) {
        phase = nextPhase
        try { onPhase(wasLoading ? '作品仍在加载，正在等待页面就绪（最多30秒）' : '正在展开评论区') } catch {}
        record({ phase: nextPhase, loadingWaitMs: loadingMs, openingWaitMs: activeMs })
      }
      deadline = Math.min(hardDeadline, at + Math.max(0, wasLoading ? loadingTimeout - loadingMs : timeout - activeMs))
      if (activeMs >= timeout || wasLoading && loadingMs >= loadingTimeout || at >= hardDeadline) break
      // Buffering is not proof that comments are unusable. Space trusted probes
      // across the loading window, preserving the normal opening budget once
      // rendering clears. The total click budget is still capped at three.
      const mayProbe = !settling && (!wasLoading || !loadingProbe || attempts === 1 && loadingMs >= 10000 || attempts === 2 && loadingMs >= loadingTimeout - 2000)
      // A failed state read is not permission to click a possibly changed page.
      if (last && mayProbe && attempts < limit && Date.now() < deadline && (wasLoading || activeMs >= nextClickAt)) {
        const entry = observedEntry
        if (entry) lastEntry = entry
        if (blocked(entry)) return finish(entry)
        if (entry?.ready || entry?.panelVisible) return finish({ ...entry, panelOpened: true })
        const x = Number(entry?.point?.x), y = Number(entry?.point?.y)
        if (Number.isFinite(x) && Number.isFinite(y) && Date.now() < deadline) {
          firstEntryAt ??= Date.now()
          // Do not probe a just-mounted entry until its first second has passed.
          if (wasLoading && Date.now() - firstEntryAt < 1000) {
            await sleep(Math.min(interval, Math.max(0, deadline - Date.now())))
            continue
          }
          if (wasLoading) loadingProbe = true
          await assertActive?.()
        const scripted = !wasLoading && limit >= 3 && attempts === 1
          const preferDebugger = attempts >= 2
          attempts++
          nextClickAt = Math.max(activeMs + clickInterval, attempts * spacing)
          this.presentWindow(win)
          if (scripted) {
            const activated = await read('script_activation', `(${openCommentPanel.toString()})(${JSON.stringify(String(videoId))},${JSON.stringify({ activate: true })})`)
            if (blocked(activated)) return finish(activated)
            if (activated?.ready || activated?.panelVisible) return finish({ ...activated, panelOpened: true })
            if (activated?.activated) clicks++
            record({ phase: 'script_activation', dispatched: activated?.activated === true, source: entry.source, point: { x, y } })
          } else {
            let sent = false, pressed = false
            if (preferDebugger && win.webContents.debugger) {
              const debug = win.webContents.debugger
              let owned = false
              try {
                owned = !debug.isAttached()
                if (owned) debug.attach('1.3')
                try { win.focus(); win.webContents.focus() } catch {}
                await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
                await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
                pressed = true
                await sleep(Math.min(100, Math.max(0, deadline - Date.now())))
                await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
                sent = true
              } catch (error) { clickErrors++; lastClickError = message(error); record({ phase: 'debugger_activation', error: lastClickError }) }
              finally {
                // Do not issue a second click if a debugger click was partially delivered.
                if (pressed && !sent) { try { await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }) } catch {} }
                try { if (owned && debug.isAttached()) debug.detach() } catch {}
              }
            }
            if (!sent && !pressed && Date.now() < deadline) {
              try { await this.realClick(win, { x, y }); sent = true }
              catch (error) { clickErrors++; lastClickError = message(error); record({ phase: 'native_activation', error: lastClickError }) }
            }
            if (sent || pressed) clicks++
            record({ phase: preferDebugger ? 'late_native_activation' : 'native_activation', dispatched: sent || pressed, source: entry.source, point: { x, y } })
          }
        }
      }
      if (Date.now() < deadline) await sleep(Math.min(interval, deadline - Date.now()))
    } while (Date.now() < deadline)
    updateTime()
    const openFailure = wasLoading && (loadingMs >= loadingTimeout || Date.now() >= hardDeadline) ? (lastEntry?.reason === 'entry_not_ready' ? 'entry_render_timeout' : 'page_load_timeout')
      : clicks ? 'panel_open_timeout' : !entryReads && scriptErrors ? 'script_execution_failed'
      : clickErrors ? 'click_dispatch_failed' : lastEntry?.reason || 'entry_not_ready'
    return finish({ panelOpened: false, openFailure })
  }

  async openCommentAuthor({ videoId, videoUrl, commentId, platformUserId, profileUrl }, assertActive) {
    const failure = (code, message) => Object.assign(new Error(message), { code })
    return this.exclusive(async () => {
      const win = this.ensureWindow()
      this.presentWindow(win)
      const remaining = () => Math.max(1, assertActive.remainingMs?.() ?? 30000)
      await this.navigate(win, videoUrl, { profileEntry: true, assertActive, timeoutMs: remaining() })
      assertActive()
      const checkAccess = async () => {
        assertActive()
        const restricted = await executePageScript(win, accessCheck, Math.min(1000, remaining()))
        assertActive()
        if (restricted) throw failure('ACCESS_RESTRICTED', '抖音当前提示访问受限')
      }
      const panel = await this.ensureCommentPanel(win, videoId, { assertActive: checkAccess, deadlineAt: Date.now() + remaining() })
      assertActive()
      if (panel?.challenge) {
        requestManualVerification(this.douyin, win, { source: '原评论窗口' })
        throw failure('CHALLENGE_REQUIRED', '抖音要求安全验证，请完成后再操作')
      }
      if (panel?.loginRequired) throw failure('LOGIN_REQUIRED', '请先在抖音窗口登录')
      if (!panel?.panelOpened) throw failure('COMMENT_ENTRY_UNAVAILABLE', '无法打开原作品的评论区')
      const script = `(${collectCommentRows.toString()})(${JSON.stringify(videoId)}, 60, ${JSON.stringify({ authorTarget: { commentId, platformUserId } })})`
      let target
      for (let page = 0; page < 7; page++) {
        assertActive()
        target = await executePageScript(win, script, Math.min(3000, remaining()))
        if (target.authorPoint || target.authorMismatch || target.authorEntryMissing || target.authorEntryObscured || target.challenge
          || target.accessRestricted || target.wrongPage || target.loginRequired || target.removed || target.commentsClosed || target.empty || page === 6) break
        assertActive()
        await executePageScript(win, `(${advanceCommentViewport.toString()})(${JSON.stringify(videoId)})`, Math.min(3000, remaining()))
        assertActive()
        await sleep(Math.min(600, remaining()))
      }
      assertActive()
      if (target.challenge) {
        requestManualVerification(this.douyin, win, { source: '原评论窗口' })
        throw failure('CHALLENGE_REQUIRED', '抖音要求安全验证，请完成后再操作')
      }
      if (target.authorMismatch) throw failure('ACCOUNT_ID_MISMATCH', '原评论作者与候选账号不一致，已停止打开')
      if (target.authorEntryObscured) throw failure('COMMENT_ENTRY_UNAVAILABLE', '作者入口被页面遮挡')
      if (target.loginRequired) throw failure('LOGIN_REQUIRED', '请先在抖音窗口登录')
      if (target.accessRestricted) throw failure('ACCESS_RESTRICTED', '抖音当前提示访问受限')
      if (!target.authorPoint) throw failure('COMMENT_ENTRY_UNAVAILABLE', '在本次读取的评论范围内没有找到原评论或作者入口')
      return this.clickProfileEntry(win, target.authorPoint, profileUrl, assertActive)
    })
  }

  async clickProfileEntry(win, point, profileUrl, assertActive) {
    const failure = (code, message) => Object.assign(new Error(message), { code })
    const contents = win.webContents
    let popup = null, allowed = false, opened = false, stableSince = 0
    const matches = url => canonicalProfile(url)?.profileUrl === profileUrl
    const onPopup = child => {
      popup = child
      const restrict = (event, url) => { if (!this.allowNavigation(navigationUrl(event, url))) event.preventDefault() }
      child.webContents.on('will-navigate', restrict)
      child.webContents.on('will-redirect', restrict)
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    }
    contents.on('did-create-window', onPopup)
    contents.setWindowOpenHandler(({ url }) => {
      if (allowed || !matches(url)) return { action: 'deny' }
      allowed = true
      return { action: 'allow', overrideBrowserWindowOptions: { show: false,
        webPreferences: { partition: this.douyin.partition, contextIsolation: true, nodeIntegration: false, sandbox: true } } }
    })
    try {
      assertActive()
      await this.realClick(win, point)
      const deadline = Date.now() + Math.min(10000, assertActive.remainingMs?.() ?? 10000)
      const remaining = () => Math.max(1, Math.min(deadline - Date.now(), assertActive.remainingMs?.() ?? Infinity))
      const script = `(${publicProfileSnapshot.toString()})(${JSON.stringify(profileUrl)})`
      while (Date.now() < deadline) {
        assertActive()
        const current = popup || win
        if (current.isDestroyed()) throw new Error('抖音窗口已关闭')
        const href = current.webContents.getURL()
        const state = await readPageState(current, profileUrl, Math.min(1000, remaining())).catch(() => null)
        assertActive()
        if (state?.code === 'CHALLENGE') {
          this.presentWindow(current)
          opened = true
          requestManualVerification(this.douyin, current, { source: '原评论作者主页' })
          throw failure('CHALLENGE_REQUIRED', '抖音要求安全验证，请完成后再操作')
        }
        if (state?.code === 'LOGIN_REQUIRED') {
          this.presentWindow(current)
          opened = true
          throw failure('LOGIN_REQUIRED', '请先在抖音窗口登录')
        }
        const restricted = await executePageScript(current, accessCheck, Math.min(1000, remaining())).catch(() => false)
        assertActive()
        if (restricted) {
          this.presentWindow(current)
          opened = true
          throw failure('ACCESS_RESTRICTED', '抖音当前提示访问受限')
        }
        const identity = canonicalProfile(href)
        if (identity && !matches(href)) throw failure('ACCOUNT_ID_MISMATCH', '打开的主页与候选账号不一致')
        if (matches(href)) {
          const profile = await executePageScript(current, script, Math.min(1000, remaining())).catch(() => null)
          assertActive()
          const missing = await executePageScript(current, `(${profileUnavailableSnapshot.toString()})()`, Math.min(1000, remaining())).catch(() => '')
          assertActive()
          if (missing === 'ACCESS_RESTRICTED') {
            this.presentWindow(current); opened = true
            throw failure('ACCESS_RESTRICTED', '抖音当前提示访问受限')
          }
          if (profile?.unavailable || missing === 'PROFILE_NOT_FOUND') throw failure('PROFILE_NOT_FOUND', '点击后，抖音仍显示用户不存在')
          if (profile?.ready && profile.platformUserId === canonicalProfile(profileUrl)?.platformUserId && matches(current.webContents.getURL())) {
            if (!stableSince) stableSince = Date.now()
            if (Date.now() - stableSince < 700) { await sleep(Math.min(200, remaining())); continue }
            this.presentWindow(current)
            opened = true
            return { page: current }
          }
        }
        stableSince = 0
        await sleep(Math.min(250, remaining()))
      }
      throw failure('PROFILE_NOT_READY', '已点击站内入口，但预期主页未能加载')
    } finally {
      if (!contents.isDestroyed()) {
        contents.removeListener('did-create-window', onPopup)
        contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      }
      if (popup && !opened && !popup.isDestroyed()) popup.destroy()
      if (popup && opened && !popup.isDestroyed()) {
        if (this.profilePopup && !this.profilePopup.isDestroyed()) this.profilePopup.destroy()
        this.profilePopup = popup
      }
    }
  }

  async readSnapshot(win, args, accept, { timeout = 18000, interval = 400, isCurrent = () => true } = {}) {
    const deadline = Date.now() + timeout
    let last = null
    do {
      if (!isCurrent()) return { cancelled: true }
      last = await executePageScript(win, `(${collectCommentRows.toString()})(...${JSON.stringify(args)})`, Math.min(3000, Math.max(1, deadline - Date.now())))
      if (!isCurrent()) return { cancelled: true }
      if (last?.wrongPage || last?.challenge || last?.loginRequired || last?.serverError) return last
      if (accept(last)) return last
      await sleep(interval)
    } while (Date.now() < deadline)
    return last
  }

  // 真实页面读取通道：prepare 负责登录态与页面可用性判断，readPage 负责逐页滚动读取。
  createTransport({ onPhase = () => {} } = {}) {
    let win = this.ensureWindow()
    let lease = null, executingLease = null, boundVideoId = null, latestDiagnostics = null
    const isCurrent = () => executingLease !== null && this._currentReadLease === executingLease && !this.destroyed
    // 记录上一页最后一条评论，用来判断滚动后是否真的出现了新内容。
    let tail = ''
    // 评论列表是虚拟滚动的：恢复收集时必须先滚到上次读到的位置，
    // 否则每次“继续收集”都从顶部重读同一批评论，永远无法看到后面的评论。
    let cursor = -1
    const transport = {
      prepare: async ({ videoId, videoUrl } = {}) => {
        // 新打开的页面评论区停在顶部，从第 0 页开始计。
        cursor = 0
        onPhase('正在检查抖音登录态')
        let cookies = []
        try { cookies = await session.fromPartition(this.douyin.partition).cookies.get({ url: 'https://www.douyin.com' }) } catch { cookies = [] }
        if (!this.hasLoginCookie(cookies)) return { ok: false, code: 'LOGIN_REQUIRED' }
        // 登录态可用才显示窗口：无权限时不要弹出空白抖音页干扰用户。
        if (!win.isDestroyed() && !win.isVisible()) win.show()
        const target = videoId && !videoUrl
          ? `https://www.douyin.com/video/${encodeURIComponent(videoId)}`
          : (videoUrl || '')
        if (!target) return { ok: false, code: 'VIDEO_ID_UNRESOLVED' }
        // 分享短链不能直接 loadURL（历史上会被导航策略拦成 ERR_FAILED）。
        // 优先用带登录态的分区 session 走一次普通 GET 解析落地地址；解析不出来时退回“窗口直接打开短链”，
        // 让平台自己完成 302，不带任何自造参数。
        let targetUrl = target
        onPhase('正在解析视频链接')
        const resolved = await resolveDouyinTarget(target, {
          fetchImpl: async url => {
            const ua = String(win.webContents.getUserAgent?.() || '') || FALLBACK_UA
            const options = { redirect: 'follow', headers: { 'user-agent': ua } }
            const sess = session.fromPartition(this.douyin.partition)
            // 先带登录态的分区会话请求；拿不到作品页时再换默认会话重试一次（有些网络下两者结果不同）。
            const attempts = []
            if (typeof sess.fetch === 'function') attempts.push(() => sess.fetch(url, options))
            attempts.push(() => net.fetch(url, options))
            let last = null
            for (const attempt of attempts) {
              try {
                const response = await attempt()
                if (CONTENT_URL.test(String(response?.url || ''))) { dropBody(last); return response }
                last = dropBody(response)
              } catch { /* 换下一种请求方式 */ }
            }
            return last || { url: '' }
          },
        })
        if (resolved.ok) targetUrl = resolved.url
        else if (['VIDEO_NOT_FOUND', 'LINK_RESOLVE_UNAVAILABLE'].includes(resolved.code)) {
          // 短链可能被平台跳到验证页/首页，也可能根本不落地到作品页；交给窗口再试一次。
          onPhase('无法预解析落地地址，正在直接打开链接')
          targetUrl = target
        } else return { ok: false, code: resolved.code, reason: resolved.reason, transient: resolved.transient === true }
        onPhase('正在打开视频页')
        try { await this.navigate(win, targetUrl, { isCurrent }) } catch (error) { return { ok: false, code: error?.code || 'NETWORK_ERROR', reason: String(error?.message || error), transient: true, diagnostics: error.diagnostics } }
        // 短链经平台跳转后的最终地址才是判断依据：/video/、/note/，或 modal_id 查询参数。
        // 跳转有时比 loadURL 完成得晚，这里轮询等一小会儿再判定。
        const href = await this.waitForContentUrl(win)
        let finalHref = href
        const urlId = href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] || resolved.videoId || ''
        const wantedId = videoId || resolved.videoId || ''
        if (wantedId && urlId && urlId !== String(wantedId)) return { ok: false, code: 'READ_TARGET_MISMATCH', reason: '页面打开的不是目标作品，已停止读取并保留诊断' }
        if (!urlId) return { ok: false, code: 'VIDEO_NOT_FOUND', reason: '分享短链没有跳转到作品页，可能已失效或不是作品链接' }
        // Navigation already established readable target content. readPage() opens the comments;
        // do not wait 15 seconds for rows that cannot exist until that click.
        let state = await executePageScript(win, `(${videoCommentsState.toString()})(${JSON.stringify(String(urlId))})`).catch(() => null)
        if (state?.wrongPage) return { ok: false, code: 'READ_TARGET_MISMATCH', reason: '作品在读取前已切换，已暂停' }
        if (state?.challenge) {
          requestManualVerification(this.douyin, win, { source: '收集评论窗口' })
          return { ok: false, code: 'CHALLENGE', reason: '请在收集评论窗口手动完成安全验证，然后重新开始' }
        }
        if (state?.removed) return { ok: false, code: 'VIDEO_NOT_FOUND', reason: state.reason }
        if (state?.commentsClosed) return { ok: false, code: 'COMMENTS_CLOSED', reason: state.reason }
        if (state?.loginRequired) return { ok: false, code: 'LOGIN_REQUIRED' }
        if (state?.serverError) return { ok: false, code: 'NETWORK_ERROR', reason: `抖音页面暂时不可用：${state.serverError}`, transient: true }
        if (!state?.ready && !urlId) return { ok: false, code: 'VIDEO_ID_UNRESOLVED' }
        const title = await executePageScript(win, 'String(document.title || "").replace(/\\s*-\\s*抖音.*$/, "").trim()').catch(() => '')
        return {
          ok: true,
          videoId: urlId || videoId || null,
          // 保留实际打开的页面（图文作品是 /note/），短链要记录平台跳转后的最终地址。
          videoUrl: /^https:\/\/www\.douyin\.com\//i.test(finalHref)
            ? finalHref.replace(/[?#].*$/, '')
            : (resolved.ok ? resolved.url : targetUrl),
          title: title || null,
        }
      },
      readPage: async ({ videoId, page = 0, minVideoComments = 0 } = {}) => {
        onPhase(page === 0 ? '正在展开评论区' : `正在读取第 ${page + 1} 页评论`)
        let opened = await this.ensureCommentPanel(win, videoId, { onPhase, isCurrent })
        if (opened?.cancelled) return { ok: false, code: 'READ_CANCELLED', reason: '读取任务已切换' }
        if (opened?.windowClosed) return { ok: false, code: 'WINDOW_CLOSED', reason: '评论读取窗口已关闭', diagnostics: { stage: 'comment_open', ...opened.openDiagnostics } }
        if (opened?.wrongPage) return { ok: false, code: 'READ_TARGET_MISMATCH', reason: '评论窗口已跳转到其他作品，已停止读取' }
        if (opened?.removed) return { ok: false, code: 'VIDEO_NOT_FOUND', reason: opened.reason || '目标作品已删除' }
        if (opened?.loginRequired) return { ok: false, code: 'LOGIN_REQUIRED' }
        if (opened?.commentsClosed) return { ok: false, code: 'COMMENTS_CLOSED' }
        if (opened?.serverError) return { ok: false, code: 'NETWORK_ERROR', reason: opened.serverError, transient: true }
        if (opened?.challenge) {
          requestManualVerification(this.douyin, win, { source: '收集评论窗口' })
          return { ok: false, code: 'CHALLENGE', reason: '请在收集评论窗口手动完成安全验证，然后重新开始' }
        }
        if (!opened?.challenge && !opened?.panelOpened) {
          const failure = opened?.openFailure
          const reasons = { entry_render_timeout: '评论入口在页面渲染等待时间内仍未出现，已保留现场诊断', page_load_timeout: '作品页持续加载，已用完加载等待时间；尚未判定为空评论', entry_not_ready: '作品页已打开，但评论入口未在时限内就绪', entry_obscured: '评论入口被页面浮层遮挡', ambiguous_entry: '页面出现多个评论入口，无法唯一确认', script_execution_failed: '评论页面状态读取失败，尚未执行展开点击', click_dispatch_failed: '评论入口已定位，但点击发送失败' }
          let reason = reasons[failure] || (opened?.openClicks ? `已尝试展开评论 ${opened.openClicks} 次，但面板未出现` : '未完成评论展开操作，请查看逐视频诊断')
          const detail = failure === 'script_execution_failed' ? opened?.openDiagnostics?.lastScriptError : failure === 'click_dispatch_failed' ? opened?.openDiagnostics?.lastClickError : ''
          if (detail) reason += `：${detail}`
          return { ok: false, code: ['page_load_timeout', 'entry_render_timeout'].includes(failure) ? 'TIMEOUT' : 'COMMENTS_UNAVAILABLE', reason, diagnostics: { stage: 'comment_open', failure, attempts: opened?.openClicks || 0, ...opened?.openDiagnostics } }
        }
        const scrollPageDown = async () => {
          const moved = await executePageScript(win, 
            `(${advanceCommentViewport.toString()})(${JSON.stringify(String(videoId))},${JSON.stringify({ initialize: false })} )`).catch(() => ({ ready: false }))
          if (moved?.wrongPage) throw new Error('WRONG_PAGE')
          await sleep(900)
        }
        if (page === 0) { tail = ''; cursor = 0 }
        // 先从顶部滚到目标页位置：恢复收集时 page 可能大于 0，必须补足之前读过的滚动次数。
        while (cursor < page) {
          try { await scrollPageDown() } catch (error) {
            if (String(error?.message) === 'WRONG_PAGE') return { ok: false, code: 'READ_TARGET_MISMATCH', reason: '评论窗口已跳转到其他页面，已停止读取' }
            return { ok: false, code: error?.code || 'NETWORK_ERROR', reason: String(error?.message || error), transient: true }
          }
          cursor += 1
        }
        const readOnce = async () => {
          const snapshot = await this.readSnapshot(win, [String(videoId), 60, { preferLower: page > 0 }], value => Boolean(value?.ready), { timeout: 6000, isCurrent })
          const rows = (snapshot?.rows || []).map(item => ({
            commentId: item.commentId,
            platformUserId: item.platformUserId,
            nickname: item.nickname,
            commentText: item.commentText,
            isReply: item.isReply,
            parentCommentId: item.parentCommentId,
            replyCount: item.replyCount,
            ipLocation: item.ipLocation,
            ipLocationSource: item.ipLocationSource,
          }))
          return { snapshot, rows }
        }
        // 滚动后评论区可能还在加载：最多再等 3 轮，直到出现新的末条评论或真正到底。
        // 第 0 页额外给 3 次机会重新展开评论区：图文作品的评论区点开后要几百毫秒才渲染。
        let last = null
        for (let attempt = 0; attempt < (page > 0 ? 4 : 3); attempt += 1) {
          if (attempt > 0) {
            const current = await this.ensureCommentPanel(win, videoId, { timeout: 4000, onPhase, isCurrent })
            if (current?.wrongPage) return { ok: false, code: 'READ_TARGET_MISMATCH', reason: '评论页已跳转到其他作品' }
            if (current?.challenge) { requestManualVerification(this.douyin, win, { source: '收集评论窗口' }); return { ok: false, code: 'CHALLENGE' } }
          }
          // 同一页的重试再向下滚一小段，等新一批评论渲染出来。
          if (page > 0 && attempt > 0 && last?.snapshot?.ready) {
            try { await scrollPageDown() } catch (error) {
              if (String(error?.message) === 'WRONG_PAGE') return { ok: false, code: 'READ_TARGET_MISMATCH', reason: '评论窗口已跳转到其他页面，已停止读取' }
              return { ok: false, code: error?.code || 'NETWORK_ERROR', reason: String(error?.message || error), transient: true }
            }
            cursor += 1
          }
          last = await readOnce()
          const failure = last.snapshot
          if (!isCurrent() || failure?.cancelled) return { ok: false, code: 'READ_CANCELLED', reason: '读取任务已切换' }
          if (failure?.challenge) { requestManualVerification(this.douyin, win, { source: '收集评论窗口' }); return { ok: false, code: 'CHALLENGE' } }
          if (failure?.loginRequired) return { ok: false, code: 'LOGIN_REQUIRED' }
          if (failure?.serverError) return { ok: false, code: 'NETWORK_ERROR', reason: `抖音页面暂时不可用：${failure.serverError}`, transient: true }
          if (failure?.wrongPage) return { ok: false, code: 'READ_TARGET_MISMATCH', reason: '评论窗口已跳转到其他页面，已停止读取' }
          if (!failure?.ready) {
            if (attempt < (page > 0 ? 3 : 2)) continue
            return { ok: false, code: 'COMMENTS_UNAVAILABLE', reason: '评论面板已打开，但未读到可解析的评论或明确的空列表', diagnostics: { stage: 'comment_read', panelVisible: failure?.panelVisible === true } }
          }
          const rows = last.rows
          const currentTail = rows.length ? (rows.at(-1).commentId || rows.at(-1).commentText) : ''
          if (page === 0 || last.snapshot.empty || currentTail !== tail) { tail = currentTail; break }
        }
        let videoCommentCount = null
        if (page === 0 && minVideoComments > 0) videoCommentCount = await executePageScript(win, `(${videoCommentCountSnapshot.toString()})(${JSON.stringify(String(videoId))})`, 1500).catch(() => null)
        return { ok: true, rows: last.rows, empty: last.snapshot?.empty === true, shown: last.snapshot?.shown || last.rows.length, videoCommentCount }
      },
      // P2-17B.2 按需读取回复：只在用户点击时调用，读取当前页面已渲染的回复。
      // 页面还在别的视频上时先回到目标作品页，避免把 A 视频的回复挂到 B 视频的评论上。
      readReplies: async ({ videoId, commentId, cursor = 0 } = {}) => {
        onPhase('正在读取该评论的回复')
        const currentUrl = () => { try { return String(win.webContents.getURL?.() || '') } catch { return '' } }
        const urlId = currentUrl().match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] || ''
        if (String(urlId) !== String(videoId)) {
          try { await this.navigate(win, `https://www.douyin.com/video/${encodeURIComponent(videoId)}`, { isCurrent }) }
          catch (error) { return { ok: false, code: 'NETWORK_ERROR', reason: String(error?.message || error) } }
          await this.waitForContentUrl(win)
          await sleep(800)
        }
        const readOnce = async () => executePageScript(win, 
          `(${readCommentReplies.toString()})(${JSON.stringify(String(videoId))},${JSON.stringify(String(commentId))},${JSON.stringify({ cursor: Number(cursor) || 0 })})`
        ).catch(error => ({ ok: false, code: 'SCRIPT_ERROR', reason: String(error?.message || error) }))
        let last = await readOnce()
        if (last?.code === 'NEED_EXPAND') {
          const x = Number(last.point?.x), y = Number(last.point?.y)
          if (Number.isFinite(x) && Number.isFinite(y)) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
            win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
            win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
            await sleep(1200)
            last = await readOnce()
            if (last?.code === 'NEED_EXPAND') { await sleep(1600); last = await readOnce() }
          }
        }
        if (last?.code === 'COMMENTS_NOT_LOADED') {
          // 评论区还没展开：复用批次里的展开逻辑后再读一次。
          await this.waitState(win).catch(() => null)
          await sleep(600)
          last = await readOnce()
        }
        return last
      },
    }
    // One page operation at a time; a new prepare invalidates old results before
    // waiting for the previous bounded operation to release the shared window.
    const invoke = (method, payload = {}) => {
      if (method === 'readPage' && boundVideoId && String(payload.videoId) !== boundVideoId) return Promise.resolve({ ok: false, code: 'READ_CANCELLED', reason: '作品与当前读取任务不一致' })
      if (method === 'prepare') { boundVideoId = payload.videoId ? String(payload.videoId) : null; latestDiagnostics = null }
      if (method === 'prepare' || lease === null) lease = this._currentReadLease = (this._readLeaseCounter = (this._readLeaseCounter || 0) + 1)
      const requestId = lease
      const task = (this._pageQueue || Promise.resolve()).catch(() => {}).then(async () => {
        if (this.destroyed || this._currentReadLease !== requestId || lease !== requestId) return { ok: false, code: 'READ_CANCELLED', reason: '读取任务已切换' }
        executingLease = requestId
        if (method === 'prepare') win = this.ensureWindow()
        let result
        for (let attempt = 0; attempt < 2; attempt++) {
          try { result = await transport[method](payload) }
          catch (error) { result = { ok: false, code: error.code || 'NETWORK_ERROR', reason: String(error.message || error), transient: true, diagnostics: error.diagnostics } }
          const retry = method === 'prepare' && attempt === 0 && result?.transient === true && ['NETWORK_ERROR', 'TIMEOUT'].includes(result.code)
          if (!retry || !isCurrent()) break
          const captured = await this.captureReadFailure(win, payload.videoId, result, { requestId, isCurrent })
          latestDiagnostics = captured.diagnostics || null
          await sleep(900)
          if (!isCurrent()) break
        }
        if (!isCurrent() || lease !== requestId) return { ok: false, code: 'READ_CANCELLED', reason: '读取任务已切换' }
        if (result?.ok && payload.videoId && typeof win.webContents.getURL === 'function') {
          const actualId = String(win.webContents.getURL()).match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1]
          if (actualId !== String(payload.videoId)) result = { ok: false, code: 'READ_TARGET_MISMATCH', reason: '作品在返回读取结果前已切换，旧页面结果未采用' }
        }
        if (result?.ok === false && result.code !== 'READ_CANCELLED') {
          result = await this.captureReadFailure(win, payload.videoId, result, { requestId, isCurrent })
          latestDiagnostics = result.diagnostics || latestDiagnostics
        }
        return result
      })
      this._pageQueue = task.catch(() => {})
      return task
    }
    return {
      diagnostics: () => latestDiagnostics,
      prepare: payload => invoke('prepare', payload), readPage: payload => invoke('readPage', payload), readReplies: payload => invoke('readReplies', payload),
      cancel: () => { if (lease === null || this._currentReadLease !== lease) return; this._currentReadLease = null; if (!win.isDestroyed()) win.destroy() },
    }
  }

  async captureReadFailure(win, videoId, result, { requestId, isCurrent = () => true } = {}) {
    if (!isCurrent()) return { ok: false, code: 'READ_CANCELLED', reason: '读取任务已切换' }
    const diagnostics = { ...(result.diagnostics || {}), requestId, expectedVideoId: String(videoId || '') }
    try { diagnostics.currentPage = String(win.webContents.getURL?.() || '').split(/[?#]/)[0] } catch {}
    // Unit stubs and closed windows cannot capture a scene. Diagnostics must
    // never turn the original read failure into a second fatal error.
    if (win.isDestroyed?.() || typeof win.webContents.capturePage !== 'function') return { ...result, diagnostics }
    try {
      const fs = require('node:fs'), path = require('node:path')
      const directory = path.join(require('electron').app.getPath('userData'), 'diagnostics', 'comment-reading')
      fs.mkdirSync(directory, { recursive: true })
      const stem = `${Date.now()}-${requestId}-${String(videoId || 'unknown').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40)}`
      let timer, shot
      try { shot = await Promise.race([win.webContents.capturePage(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500) })]) }
      finally { clearTimeout(timer) }
      if (!isCurrent()) return { ok: false, code: 'READ_CANCELLED', reason: '读取任务已切换' }
      if (shot && !shot.isEmpty?.()) { diagnostics.screenshotPath = path.join(directory, stem + '.png'); fs.writeFileSync(diagnostics.screenshotPath, shot.toPNG()) }
      diagnostics.recordPath = path.join(directory, stem + '.json')
      fs.writeFileSync(diagnostics.recordPath, JSON.stringify({ capturedAt: new Date().toISOString(), code: result.code, diagnostics }, null, 2))
      const records = fs.readdirSync(directory).filter(name => /^\d+-\d+-[A-Za-z0-9_-]+\.json$/.test(name)).sort()
      for (const name of records.slice(0, -20)) for (const ext of ['.json', '.png']) {
        try { fs.unlinkSync(path.join(directory, name.replace(/\.json$/, ext))) } catch {}
      }
    } catch (error) { diagnostics.captureError = String(error.message || error).slice(0, 160) }
    return { ...result, diagnostics }
  }

  // 等待页面地址变成作品页（短链跳转可能晚于 loadURL 完成）。
  async waitForContentUrl(win, { timeout = 15000, interval = 500 } = {}) {
    const current = () => { try { return String(win.webContents.getURL?.() || '') } catch { return '' } }
    const hit = url => CONTENT_URL.test(url)
    const deadline = Date.now() + timeout
    let href = current()
    while (!hit(href) && Date.now() < deadline) {
      await sleep(interval)
      href = current()
    }
    return href
  }

  async waitState(win, { timeout = 15000, interval = 400 } = {}) {
    const deadline = Date.now() + timeout
    let last = null
    do {
      last = await executePageScript(win, `(${videoCommentsState.toString()})()`).catch(() => null)
      // 页面已渲染出评论结构（即使评论区还没展开、暂时不可见）就视为可用；
      // 图文作品的评论是点开后才有可见元素的，不能在这里把 0 条可见评论当失败。
      if (last?.ready || last?.totalRows > 0 || last?.removed || last?.commentsClosed || last?.challenge || last?.loginRequired || last?.serverError) return last
      await sleep(interval)
    } while (Date.now() < deadline)
    return last || { ready: false }
  }

  destroy() {
    this.running = false
    if (this.profilePopup && !this.profilePopup.isDestroyed()) this.profilePopup.destroy()
    this.profilePopup = null
    super.destroy()
  }
}

module.exports = { CommentCollectionService, LOGIN_COOKIES }
