const { executePageScript } = require('./page-readiness.cjs')
const { FavoritesOperation } = require('./favorites-operation.cjs')
const { requestManualVerification } = require('../manual-verification.cjs')
// P2-11A：读取用户指定名称的抖音收藏夹，把未收录的作品增量加入本地素材库。
// 只使用已登录窗口里页面已经渲染的内容：不构造签名接口、不绕过验证/限频，
// 也绝不把无法确认分类的全部收藏当成交友视频。本模块不关注、不发私信、不训练视频模型。
const { FriendshipService } = require('../friendship.cjs')
const { FAVORITES_URL, favoritesPageState, favoritesSubTabPoint, favoritesFolderEntry, readFavoriteVideos, advanceFavoritesViewport } = require('./favorites-snapshot.cjs')

const LOGIN_COOKIES = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss', 'passport_auth_status', 'passport_auth_status_ss']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const FALLBACK_IMPORT = '若平台限制页面读取，请在“高级管理 → 备用：手动收录视频”粘贴分享链接，或用导入文件方式收录视频与评论'
const RESUME_CODES = ['NETWORK_ERROR', 'SCROLL_FAILED', 'FOLDER_CLOSED', 'APP_RESTARTED']

// 作品 ID 规范化：只接受抖音页面上的纯数字作品 ID，其余一律丢弃，避免把跳转码当 ID。
function normalizeFavoriteId(value) {
  const id = String(value || '').trim()
  return /^\d{6,30}$/.test(id) ? id : ''
}

function failureStatus(code) {
  if (code === 'STOPPED') return 'interrupted'
  return ['LOGIN_REQUIRED', 'CHALLENGE', 'ACCESS_RESTRICTED', 'ACCESS_DENIED'].includes(code) ? 'blocked' : 'failed'
}

function failureAction(code, detail = {}) {
  if (code === 'STOPPED') return '同步已停止；已收录作品保留，重新寻找时可以继续'
  if (code === 'LOGIN_REQUIRED') return '请先在登录窗口重新登录抖音，再同步收藏夹'
  if (code === 'CHALLENGE') return '请在收藏夹窗口完成安全验证后重新同步'
  if (code === 'ACCESS_RESTRICTED' || code === 'ACCESS_DENIED') return FALLBACK_IMPORT
  if (code === 'FOLDER_NOT_FOUND') {
    const names = (detail.folders || []).filter(Boolean)
    return `${names.length ? `当前可见收藏夹：${names.join('、')}。` : ''}请填写与抖音里完全一致的收藏夹名称后重试；没有匹配到分类时不会收录任何视频`
  }
  if (code === 'FOLDER_AMBIGUOUS') return '存在多个同名收藏夹，已停止且没有收录视频；请先在抖音里改名，再重新同步'
  if (code === 'FOLDER_CLOSED') return '收藏夹列表被意外关闭，本次已停止；重新同步会从未收录的视频继续'
  if (code === 'SCROLL_FAILED') return '收藏夹列表无法继续滚动，本次已停止；已读到的作品已保存，可重新同步继续'
  return FALLBACK_IMPORT
}

class FavoritesSyncService extends FriendshipService {
  constructor(douyin, { accountId = '', store = null, onProgress = () => {}, operationTimeouts = {} } = {}) {
    super(douyin)
    this.accountId = accountId || douyin.accountId || ''
    this.store = store
    this.onProgress = onProgress
    this.running = false
    this.stopped = false
    this.operationTimeouts = operationTimeouts
    this.operation = null
  }

  ensureWindow() {
    const win = super.ensureWindow()
    win.setTitle?.('收藏夹同步 · 抖音')
    return win
  }

  hasLoginCookie(cookies) {
    return (cookies || []).some(({ name }) => LOGIN_COOKIES.includes(name))
  }

  presentWindow(win) {
    try {
      if (win.isDestroyed()) return
      if (!win.isVisible()) win.show()
      win.focus()
      win.moveTop?.()
    } catch { /* 窗口不可用时忽略 */ }
  }

  async readScript(win, code) {
    const task = () => executePageScript(win, code, this.operationTimeouts.script || 3000)
    try { return await (this.operation ? this.operation.run(task, { timeoutMs: (this.operationTimeouts.script || 3000) + 100, code: 'FAVORITES_SCRIPT_TIMEOUT' }) : task()) }
    catch (error) { if (!error.code && /页面状态读取超时/.test(String(error.message))) error.code = 'FAVORITES_SCRIPT_TIMEOUT'; throw error }
  }
  readSnapshot(win, fn, args = []) {
    // Check manual verification/login/restriction in the same DOM turn as the read.
    return this.readScript(win, `(() => { const guard = (${favoritesPageState.toString()})(); if (!guard.ready) return guard; return (${fn.toString()})(...${JSON.stringify(args)}) })()`)
  }
  wait(ms) { return this.operation ? this.operation.wait(ms) : sleep(ms) }
  pageFailure(value) {
    let code, reason
    if (value?.challenge) { code = 'CHALLENGE'; reason = '请在收藏夹窗口手动完成安全验证'; requestManualVerification(this.douyin, this.window, { source: '收藏夹窗口' }); this.presentWindow(this.window) }
    else if (value?.loginRequired) { code = 'LOGIN_REQUIRED'; reason = '抖音登录已失效' }
    else if (value?.blocked) { code = 'ACCESS_RESTRICTED'; reason = value.reason || '平台限制访问' }
    else if (value?.serverError) { code = 'NETWORK_ERROR'; reason = '抖音页面暂时不可用' }
    else if (value?.wrongPage) { code = 'ACCESS_DENIED'; reason = '页面身份不符合预期，已停止' }
    return code ? { ok: false, code, reason } : null
  }
  async navigateForSync(win, url) {
    return this.operation ? this.operation.run(() => this.navigate(win, url), { timeoutMs: this.operationTimeouts.navigation || 26000, code: 'FAVORITES_NAVIGATION_TIMEOUT' }) : this.navigate(win, url)
  }
  async clickPoint(win, point) {
    this.operation?.assertCurrent()
    const x = Number(point?.x), y = Number(point?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return true
  }

  async waitForState(win, { timeout = 15000, interval = 400 } = {}) {
    const deadline = Date.now() + timeout
    let last = null
    do {
      last = await this.readScript(win, `(${favoritesPageState.toString()})()`)
      if (last?.ready || last?.challenge || last?.loginRequired || last?.blocked || last?.serverError || last?.wrongPage) return last
      await this.wait(interval)
    } while (Date.now() < deadline)
    return last || { ready: false }
  }

  async waitForVerification(win, { timeout = 120000, interval = 1200 } = {}) {
    requestManualVerification(this.douyin, win, { source: '收藏夹窗口' })
    this.presentWindow(win)
    const deadline = Date.now() + timeout
    let last = null
    do {
      last = await this.readScript(win, `(${favoritesPageState.toString()})()`)
      if (last?.ready) return last
      await this.wait(interval)
    } while (Date.now() < deadline)
    return last || { challenge: true }
  }

  async waitForFolderEntry(win, folderName, { timeout = 20000, interval = 500 } = {}) {
    const deadline = Date.now() + timeout
    let last = null
    do {
      last = await this.readSnapshot(win, favoritesFolderEntry, [String(folderName)])
      if (last?.ok) return last
      if (last?.wrongPage || last?.loginRequired || last?.challenge || last?.blocked || last?.serverError) return last
      // 列表已经渲染但没有该收藏夹时，继续等一小会儿可能只是名称还没渲染完。
      if (last && last.code !== 'FOLDER_LIST_NOT_READY') {
        await this.wait(interval)
        const again = await this.readSnapshot(win, favoritesFolderEntry, [String(folderName)])
        if (again?.ok || (again && again.code !== 'FOLDER_LIST_NOT_READY')) return again
      }
      await this.wait(interval)
    } while (Date.now() < deadline)
    return last || { ok: false, code: 'FOLDER_LIST_NOT_READY', reason: '收藏夹列表没有渲染完成' }
  }

  async waitForFolderOpen(win, { timeout = 25000, interval = 600, minVideos = 1 } = {}) {
    const deadline = Date.now() + timeout
    let last = null
    do {
      last = await this.readSnapshot(win, readFavoriteVideos)
      if (last?.wrongPage || last?.challenge || last?.loginRequired || last?.blocked || last?.serverError) return last
      // 已进入收藏夹但作品网格还没渲染：继续等，避免在网格加载前就开始滚动而漏掉第一页。
      if (last?.ok && ((last.videos?.length || 0) >= minVideos || last.done === true)) return last
      await this.wait(interval)
    } while (Date.now() < deadline)
    return { ok: false, code: 'FOLDER_NOT_OPENED', reason: '打开收藏夹后没有看到已加载的作品列表' }
  }

  createTransport({ onPhase = () => {} } = {}) {
    const operation = this.operation
    const emitPhase = phase => {
      operation?.assertCurrent()
      if (operation && this.operation !== operation) throw Object.assign(new Error('收藏夹任务已切换'), { code: 'STOPPED' })
      onPhase(phase)
    }
    const win = this.ensureWindow()
    return {
      prepare: async ({ folderName } = {}) => {
        const name = String(folderName || '').trim()
        if (!name) return { ok: false, code: 'CONFIG_MISSING', reason: '请先填写并保存抖音收藏夹名称' }
        emitPhase('正在检查抖音登录态')
        // 延迟到真实运行时才加载 electron，自动化测试可以不依赖桌面环境。
        const { session } = require('electron')
        let cookies = []
        try { cookies = await session.fromPartition(this.douyin.partition).cookies.get({ url: 'https://www.douyin.com' }) } catch { cookies = [] }
        operation?.assertCurrent()
        if (!this.hasLoginCookie(cookies)) return { ok: false, code: 'LOGIN_REQUIRED', reason: '抖音登录已失效' }
        // 点击收藏夹卡片需要真实可见窗口；登录态可用后才显示，避免无权限时弹出空白页。
        if (!win.isDestroyed() && !win.isVisible()) win.show()
        emitPhase('正在打开收藏夹页面')
        try { await this.navigateForSync(win, FAVORITES_URL) } catch (error) {
          throw error
        }
        emitPhase('正在等待收藏夹页面内容')
        let state = await this.waitForState(win)
        if (state?.wrongPage) return { ok: false, code: 'ACCESS_DENIED', reason: '抖音页面跳到了其他站点，已停止' }
        if (state?.loginRequired) return { ok: false, code: 'LOGIN_REQUIRED', reason: '抖音登录已失效' }
        if (state?.serverError) return { ok: false, code: 'NETWORK_ERROR', reason: `抖音页面暂时不可用：${state.serverError}`, transient: true }
        if (state?.blocked) return { ok: false, code: 'ACCESS_RESTRICTED', reason: state.reason || '平台限制访问' }
        const stateFailure = this.pageFailure(state)
        if (stateFailure) return stateFailure
        if (!state?.ready) return { ok: false, code: 'FAVORITES_PAGE_TIMEOUT', reason: '收藏夹页面内容未在等待上限内就绪' }

        emitPhase('正在切换到收藏夹分类')
        // 页面刚打开时子分类可能还没渲染，先等它出现再判断是否已选中。
        let sub = null
        for (let attempt = 0; attempt < 16; attempt += 1) {
          sub = await this.readSnapshot(win, favoritesSubTabPoint)
          const subFailure = this.pageFailure(sub); if (subFailure) return subFailure
          if (sub?.wrongPage) return { ok: false, code: 'ACCESS_DENIED', reason: '抖音页面跳到了其他站点，已停止' }
          if (sub?.found) break
          await this.wait(400)
        }
        if (sub?.found && !sub.selected && sub.point) {
          await this.clickPoint(win, sub.point)
          await this.wait(900)
        }

        emitPhase('正在查找收藏夹')
        const entry = await this.waitForFolderEntry(win, name, { timeout: 30000 })
        const entryFailure = this.pageFailure(entry); if (entryFailure) return entryFailure
        if (!entry?.ok) {
          return {
            ok: false,
            code: entry?.code || 'FOLDER_NOT_FOUND',
            reason: entry?.reason || '没有找到指定收藏夹',
            folders: entry?.folders || [],
          }
        }

        emitPhase(`正在打开收藏夹「${entry.name}」`)
        await this.clickPoint(win, entry.point)
        let opened = await this.waitForFolderOpen(win)
        const openedFailure = this.pageFailure(opened); if (openedFailure) return openedFailure
        // 偶发情况：鼠标点击落在卡片空白处，页面没有进入收藏夹。重新加载列表页后再点一次，
        // 只做一次恢复，避免无限重试触发平台限频。
        if (!opened?.ok) {
          emitPhase(`正在重新打开收藏夹「${entry.name}」`)
          await this.navigateForSync(win, FAVORITES_URL)
          const retryState = await this.waitForState(win)
          const retryFailure = this.pageFailure(retryState); if (retryFailure) return retryFailure
          const retry = await this.waitForFolderEntry(win, entry.name || name, { timeout: 20000 })
          const retryEntryFailure = this.pageFailure(retry); if (retryEntryFailure) return retryEntryFailure
          if (retry?.ok) {
            await this.clickPoint(win, retry.point)
            opened = await this.waitForFolderOpen(win)
            const retryOpenFailure = this.pageFailure(opened); if (retryOpenFailure) return retryOpenFailure
          }
        }
        if (!opened?.ok) {
          return {
            ok: false,
            code: opened?.code || 'FOLDER_NOT_OPENED',
            reason: opened?.reason || '打开收藏夹后没有看到作品列表',
          }
        }
        return { ok: true, folderName: entry.name, declaredCount: Number(entry.count) || 0 }
      },
      readPage: async () => {
        const page = await this.readSnapshot(win, readFavoriteVideos)
        if (!page) return { ok: false, code: 'NETWORK_ERROR', reason: '读取收藏夹页面失败', transient: true }
        const pageFailure = this.pageFailure(page); if (pageFailure) return pageFailure
        if (page.wrongPage) return { ok: false, code: 'ACCESS_DENIED', reason: '抖音页面跳到了其他站点，已停止' }
        if (page.code === 'FOLDER_NOT_OPENED') return { ok: false, code: 'FOLDER_CLOSED', reason: page.reason }
        return { ok: true, videos: page.videos || [], done: page.done === true }
      },
      advance: async () => {
        const moved = await this.readSnapshot(win, advanceFavoritesViewport)
        if (!moved) return { ok: false, code: 'SCROLL_FAILED', reason: '收藏夹列表无法继续滚动' }
        const moveFailure = this.pageFailure(moved); if (moveFailure) return moveFailure
        if (moved.wrongPage) return { ok: false, code: 'ACCESS_DENIED', reason: '抖音页面跳到了其他站点，已停止' }
        return { ok: true, ...moved }
      },
    }
  }

  // 应用重启时把遗留的“同步中”标记为中断，避免界面一直显示正在运行。
  markInterrupted() {
    if (!this.store) return null
    try {
      const state = this.store.favoritesState()
      if (state.status !== 'running') return state
      return this.store.setFavorites({
        status: 'interrupted', code: 'APP_RESTARTED', phase: '',
        lastError: '应用重启，上次收藏夹同步中断',
        nextAction: '重新同步会按作品 ID 去重，不会重复收录已读到的视频',
        finishedAt: new Date().toISOString(),
      })
    } catch { return null }
  }

  stop(ownerToken) {
    if (!this.running || ownerToken !== undefined && ownerToken !== this.ownerToken) return false
    this.stopped = true
    this.operation?.cancel()
    try { this.window?.webContents?.stop?.() } catch {}
    return true
  }

  recordFailure(failure, counts) {
    if (!this.store) return { ok: false, code: failure.code, reason: failure.reason, counts }
    const state = this.store.setFavorites({
      ...this.operation?.diagnostics(),
      status: failureStatus(failure.code), code: failure.code, phase: '',
      lastError: failure.reason || '收藏夹同步失败',
      nextAction: failureAction(failure.code, failure),
      finishedAt: new Date().toISOString(),
      found: counts.found, added: counts.added, duplicates: counts.duplicates, scrolls: counts.scrolls,
    })
    this.onProgress(state)
    this.runProgress?.(state)
    return { ok: false, code: failure.code, reason: failure.reason, nextAction: failureAction(failure.code, failure), resumable: failure.code === 'STOPPED' || /TIMEOUT$/.test(failure.code || '') || RESUME_CODES.includes(failure.code) || failure.transient === true, favorites: state, ...counts }
  }

  async run({ folderName = '', maxScrolls = 120, maxVideos = 500, resume = false, ownerToken, onProgress = () => {} } = {}) {
    if (this.running) return { ok: false, error: '收藏夹同步正在进行，请稍后再试' }
    if (!this.store) return { ok: false, error: '素材库尚未就绪' }
    const name = String(folderName || '').trim().slice(0, 80)
    if (!name) return { ok: false, code: 'CONFIG_MISSING', reason: '请先填写并保存抖音收藏夹名称' }
    const store = this.store
    const counts = { found: 0, added: 0, duplicates: 0, scrolls: 0 }
    this.running = true
    this.stopped = false
    const operation = this.operation = new FavoritesOperation()
    this.ownerToken = ownerToken
    this.runProgress = onProgress
    const progress = patch => {
      if (this.operation !== operation || operation.controller.signal.aborted) return null
      if (patch.phase) operation.setPhase(patch.phase)
      try { const state = store.setFavorites({ folderName: name, ...operation.diagnostics(), ...patch }); this.onProgress(state); onProgress(state); return state } catch { return null }
    }
    progress({
      status: 'running', phase: '正在准备收藏夹同步', code: null, lastError: '', nextAction: '',
      startedAt: new Date().toISOString(), finishedAt: null, declaredCount: 0,
      found: 0, added: 0, duplicates: 0, scrolls: 0, reachedCap: false, resumed: resume === true,
    })
    try {
      const transport = this.createTransport({ onPhase: phase => progress({ phase }) })
      const prepared = await operation.run(() => transport.prepare({ folderName: name }), { timeoutMs: this.operationTimeouts.prepare || 90000, code: 'FAVORITES_PREPARE_TIMEOUT' })
      operation.assertCurrent()
      if (!prepared?.ok) return this.recordFailure(prepared || { code: 'PREPARE_FAILED', reason: '无法打开收藏夹' }, counts)
      const declaredCount = Number(prepared.declaredCount) || 0
      progress({ declaredCount, phase: `收藏夹「${prepared.folderName || name}」已打开` })

      const seen = new Set()
      const videoLimit = Math.max(1, Math.min(1000, Number(maxVideos) || 500))
      const scrollLimit = Math.max(1, Math.min(500, Number(maxScrolls) || 120))
      let stable = 0
      let reachedCap = false
      let stoppedBy = 'completed'
      let done = false

      while (!done) {
        if (this.stopped) { stoppedBy = 'stopped'; break }
        const page = await operation.run(() => transport.readPage(), { timeoutMs: this.operationTimeouts.page || 6000, code: 'FAVORITES_READ_TIMEOUT' })
        operation.assertCurrent()
        if (!page?.ok) return this.recordFailure(page || { code: 'READ_FAILED', reason: '读取收藏夹页面失败' }, counts)

        const fresh = []
        for (const video of page.videos || []) {
          const id = normalizeFavoriteId(video.videoId)
          if (!id || seen.has(id)) continue
          seen.add(id)
          fresh.push({
            video_id: id,
            video_url: video.video_url || `https://www.douyin.com/video/${id}`,
            title: video.title || null,
          })
          counts.found += 1
        }
        if (fresh.length) {
          // 增量入库：每读到一页就保存，应用重启后已读到的作品不会丢失。
          const write = store.addFavoriteVideos(fresh, { folderName: prepared.folderName || name })
          counts.added += write.added
          counts.duplicates += write.duplicates
          stable = 0
        } else {
          stable += 1
        }
        progress({ found: counts.found, added: counts.added, duplicates: counts.duplicates, scrolls: counts.scrolls, declaredCount, phase: `已识别 ${counts.found} 个作品（本页 ${(page.videos || []).length} 个）` })

        done = page.done === true
        if (done) break
        if (counts.found >= videoLimit || counts.scrolls >= scrollLimit) { reachedCap = true; stoppedBy = 'cap'; break }
        // 连续多次滚动都没有新作品：虚拟列表已经到底或不再加载，停止而不是无限滚动。
        if (stable >= 4) { stoppedBy = 'stable'; break }

        const advanced = await operation.run(() => transport.advance(), { timeoutMs: this.operationTimeouts.page || 6000, code: 'FAVORITES_SCROLL_TIMEOUT' })
        operation.assertCurrent()
        if (!advanced?.ok) return this.recordFailure(advanced || { code: 'SCROLL_FAILED', reason: '收藏夹列表无法继续滚动' }, counts)
        counts.scrolls += 1
        progress({ scrolls: counts.scrolls })
        // 作品网格是虚拟列表，滚动后需要时间加载下一批卡片。
        await this.wait(1000)
      }

      const finishedAt = new Date().toISOString()
      const code = stoppedBy === 'cap' ? 'REACHED_CAP' : (stoppedBy === 'stable' ? 'NO_NEW_RESULTS' : (stoppedBy === 'stopped' ? 'STOPPED' : null))
      const status = stoppedBy === 'stopped' ? 'interrupted' : 'completed'
      const nextAction = stoppedBy === 'cap'
        ? '已达到本轮读取上限，可再次同步继续读取后面的作品'
        : stoppedBy === 'stable' ? '页面没有继续加载新作品，可能已经到底' : ''
      const state = store.setFavorites({
        ...operation.diagnostics(),
        status, code: code || null, lastError: '', nextAction, phase: '同步完成',
        finishedAt, lastSyncAt: status === 'completed' ? finishedAt : null,
        declaredCount, found: counts.found, added: counts.added, duplicates: counts.duplicates,
        scrolls: counts.scrolls, reachedCap,
      })
      this.onProgress(state)
      onProgress(state)
      const shortNote = declaredCount && counts.found < declaredCount
        ? `（收藏夹声明 ${declaredCount} 个作品，页面实际可读 ${counts.found} 个；未读到的未计入）`
        : ''
      return {
        ok: true, code: code || null,
        folderName: prepared.folderName || name, declaredCount,
        found: counts.found, added: counts.added, duplicates: counts.duplicates,
        scrolls: counts.scrolls, reachedCap, status, favorites: state,
        message: `收藏夹「${prepared.folderName || name}」：识别 ${counts.found} 个作品，新增 ${counts.added} 个，去重 ${counts.duplicates} 个${shortNote}`,
      }
    } catch (error) {
      return this.recordFailure({ code: error?.code || 'NETWORK_ERROR', reason: String(error?.message || error), transient: error?.code !== 'STOPPED' }, counts)
    } finally {
      operation.cancel() // Fence late completions after timeout as well as explicit stop.
      if (this.operation === operation) { this.running = false; this.operation = null; this.runProgress = null; this.ownerToken = undefined }
    }
  }
}

module.exports = { FavoritesSyncService, normalizeFavoriteId, failureStatus, failureAction, FALLBACK_IMPORT }
