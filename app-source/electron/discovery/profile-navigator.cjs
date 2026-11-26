const { verificationSnapshot } = require('./verification-dom.cjs')
const { canonicalProfile } = require('./candidate-manager.cjs')
const { CommentCollectionService } = require('./comment-collection-service.cjs')
const { navigateReadable, executePageScript } = require('./page-readiness.cjs')
const { publicProfileSnapshot } = require('./comment-snapshot.cjs')
const { requestManualVerification } = require('../manual-verification.cjs')
const { profileUnavailableSnapshot, profileSearchQueries } = require('./profile-navigation-tools.cjs')
const { startProfileTrace } = require('./profile-trace.cjs')

const PROFILE_FAILURE_LIMIT = 3
const recoverable = new Set(['PROFILE_NOT_FOUND', 'PROFILE_NOT_READY', 'COMMENT_ENTRY_UNAVAILABLE', 'SEARCH_ENTRY_UNAVAILABLE', 'VIDEO_NOT_FOUND', 'TIMEOUT', 'PROFILE_ROUTE_TIMEOUT'])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function profileSearchEntry(expectedUrl) {
  const current = new URL(location.href)
  if (current.origin !== 'https://www.douyin.com' || !current.pathname.startsWith('/search/')) return null
  const links = [...document.querySelectorAll('a[href*="/user/"]')].filter(link => {
    const url = new URL(link.href, location.href)
    const rect = link.getBoundingClientRect()
    return url.origin + url.pathname.replace(/\/$/, '') === expectedUrl && rect.width > 0 && rect.height > 0
  })
  for (const link of links) {
    link.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = link.getBoundingClientRect()
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    const hit = document.elementFromPoint(point.x, point.y)
    if (hit && (hit === link || link.contains(hit))) return point
  }
  return null
}

function beforeProfileAction(code, message) {
  return Object.assign(new Error(message), {
    code, preActionFailure: true, followAttempted: false, sendAttempted: false,
    blocked: ['CHALLENGE', 'CHALLENGE_REQUIRED', 'LOGIN_REQUIRED', 'ACCESS_RESTRICTED', 'PROFILE_QUEUE_PAUSED'].includes(code),
  })
}

const messageOf = {
  CHALLENGE: '抖音要求安全验证，请完成后重试',
  LOGIN_REQUIRED: '请先在抖音窗口登录',
  ACCESS_RESTRICTED: '抖音当前提示访问受限，已停止后续尝试',
  PROFILE_NOT_FOUND: '抖音显示该用户不存在',
  PROFILE_NOT_READY: '目标主页未就绪',
}

class ProfileNavigator {
  constructor(douyin, { accountId, sourceFor, onVerified }) {
    this.douyin = douyin
    this.accountId = accountId
    this.sourceFor = sourceFor
    this.onVerified = onVerified
    this.failures = new Set()
    this.closed = false
  }

  destroy() {
    this.closed = true
    this.viewer?.destroy()
  }

  assertActive(automated = true) {
    if (this.closed || this.douyin._destroyed || (automated && this.douyin.storage.get().automation?.paused)) {
      throw beforeProfileAction('AUTO_PAUSED', '当前账号的交友操作已停止或暂停')
    }
    if (this.douyin.verificationActive) throw beforeProfileAction('CHALLENGE_REQUIRED', messageOf.CHALLENGE)
  }

  async inspect(win, url, timeout = 1500) {
    const script = `(() => {
      const body = document.body?.innerText || ''
      if ((${verificationSnapshot.toString()})().challenge) return { code: 'CHALLENGE' }
      const code = (${profileUnavailableSnapshot.toString()})()
      if (code === 'ACCESS_RESTRICTED') return { code }
      if (location.origin + location.pathname.replace(/\\/$/, '') !== ${JSON.stringify(url)}) return { ready: false }
      if (/请先登录|登录后查看/.test(body)) return { code: 'LOGIN_REQUIRED' }
      const profile = (${publicProfileSnapshot.toString()})(${JSON.stringify(url)})
      if (profile.challenge) return { code: 'CHALLENGE' }
      if (profile.loginRequired) return { code: 'LOGIN_REQUIRED' }
      if (profile.unavailable) return { code: 'PROFILE_NOT_FOUND' }
      if (profile.ready && (profile.identityStatus !== 'verified' || profile.platformUserId !== ${JSON.stringify(canonicalProfile(url)?.platformUserId)})) return { ready: false }
      return code ? { code } : profile
    })()`
    try { return await executePageScript(win, script, timeout) } catch { return { ready: false } }
  }

  async direct(win, url, alive) {
    let stableSince = 0
    const trace = await startProfileTrace(win, canonicalProfile(url))
    let result, network
    try { result = await navigateReadable(win, url, { timeout: Math.min(8000, alive.remainingMs?.() ?? 8000), read: async (window, target, timeout) => {
      try { alive() } catch (error) { return { code: error.code || 'AUTO_PAUSED' } }
      const state = await this.inspect(window, target, timeout)
      alive()
      if (state.ready) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince < 700) return { ...state, ready: false }
      } else stableSince = 0
      return state
    } }) } finally { network = await trace.stop() }
    alive()
    if (!result.ok) {
      const empty = ['PROFILE_NOT_FOUND','PROFILE_NOT_READY','TIMEOUT'].includes(result.code) && network.requests.some(row => row.kind === 'profile' && row.httpStatus === 200 && row.responseBodyState === 'empty')
      const error = beforeProfileAction(empty ? 'PROFILE_RESPONSE_EMPTY' : result.code || 'PROFILE_NOT_READY',
        empty ? '抖音资料接口返回空正文，尚未核实用户资料；请检查网页登录会话，必要时重新登录' : messageOf[result.code] || '直开的主页未能核验')
      error.diagnostics = { network }
      throw error
    }
    return win
  }

  async fromSearch(viewer, { url, name }, alive, { onAttempt = () => {} } = {}) {
    const queries = profileSearchQueries(name)
    if (!queries.length) throw beforeProfileAction('SEARCH_ENTRY_UNAVAILABLE', '缺少可用于搜索的昵称')
    const win = viewer.ensureWindow()
    const script = `(() => {
      const body = document.body?.innerText || ''
      if ((${verificationSnapshot.toString()})().challenge) return { code: 'CHALLENGE' }
      if (/请先登录|登录后查看|登录后搜索/.test(body)) return { code: 'LOGIN_REQUIRED' }
      const code = (${profileUnavailableSnapshot.toString()})()
      return code ? { code } : { point: (${profileSearchEntry.toString()})(${JSON.stringify(url)}) }
    })()`
    const deadline = Date.now() + Math.min(18000, alive.remainingMs?.() ?? 18000)
    let lastError
    for (let index = 0; index < queries.length; index++) {
      alive()
      const query = queries[index], started = Date.now()
      // Reserve a fair share for the plain-name retry; loading and clicking are included.
      const queryDeadline = Math.min(deadline, started + Math.max(1, Math.floor((deadline - started) / (queries.length - index))))
      const current = () => {
        alive()
        if (Date.now() >= queryDeadline) throw beforeProfileAction('SEARCH_QUERY_TIMEOUT', '本次昵称搜索已达到时限')
      }
      current.remainingMs = () => Math.max(1, Math.min(queryDeadline - Date.now(), alive.remainingMs?.() ?? Infinity))
      try {
        current()
        await viewer.navigate(win, `https://www.douyin.com/search/${encodeURIComponent(query.text)}?type=user`,
          { profileEntry: true, assertActive: current, timeoutMs: current.remainingMs() })
        while (Date.now() < queryDeadline) {
          current()
          const state = await executePageScript(win, script, Math.min(1000, current.remainingMs())).catch(() => null)
          current()
          if (state?.code) throw beforeProfileAction(state.code, messageOf[state.code])
          if (state?.point) {
            const result = await viewer.clickProfileEntry(win, state.point, url, current)
            current()
            onAttempt({ method: query.mode === 'full' ? '搜索·完整昵称' : '搜索·去装饰昵称', status: 'verified', query: query.text,
              elapsedMs: Date.now() - started, budgetMs: queryDeadline - started })
            return result
          }
          await sleep(Math.min(300, current.remainingMs()))
        }
        throw beforeProfileAction('SEARCH_QUERY_TIMEOUT', '本次昵称搜索没有核验到目标账号')
      } catch (error) {
        onAttempt({ method: query.mode === 'full' ? '搜索·完整昵称' : '搜索·去装饰昵称', status: 'failed', query: query.text,
          code: error.code || 'SEARCH_ENTRY_UNAVAILABLE', reason: error.message, elapsedMs: Date.now() - started, budgetMs: queryDeadline - started })
        if (!recoverable.has(error.code) && error.code !== 'SEARCH_QUERY_TIMEOUT') throw error
        lastError = error
      }
    }
    throw beforeProfileAction('SEARCH_ENTRY_UNAVAILABLE', `搜索未找到可核验的同一账号${lastError?.code ? '：' + lastError.code : ''}`)
  }

  async open(win, candidate, { background = false, automated = background, assertActive, timeoutMs = 45000 } = {}) {
    const identity = canonicalProfile(candidate.url || candidate.profileUrl)
    if (!identity || (candidate.platformUserId && candidate.platformUserId !== identity.platformUserId)) {
      throw beforeProfileAction('ACCOUNT_ID_MISMATCH', '目标主页身份不一致')
    }
    if (this.opening) throw beforeProfileAction('PROFILE_QUEUE_BUSY', '正在验证另一个主页，请稍后操作')
    const url = identity.profileUrl
    const totalBudget = Math.max(1000, Math.min(45000, Number(timeoutMs) || 45000))
    const deadline = Date.now() + totalBudget
    const alive = () => {
      this.assertActive(automated); assertActive?.()
      if (Date.now() >= deadline) throw beforeProfileAction('PROFILE_NAV_TIMEOUT', '本次主页多入口尝试已达到时间上限')
    }
    const attempts = []
    this.lastAttempts = []
    let activeRoute = null
    const scoped = (method, budgetMs) => {
      const started = Date.now(), routeDeadline = Math.min(deadline, started + Math.max(1, budgetMs))
      activeRoute = { method, started, budgetMs: routeDeadline - started }
      const current = () => {
        alive()
        if (Date.now() >= routeDeadline) throw beforeProfileAction('PROFILE_ROUTE_TIMEOUT', `${method}已达到本入口时限，尝试下一可用入口`)
      }
      current.remainingMs = () => Math.max(1, routeDeadline - Date.now())
      return current
    }
    const recordAttempt = (method, status, code = '', extra = {}) => {
      attempts.push({ method, status, code, ...(activeRoute ? { elapsedMs: Date.now() - activeRoute.started, budgetMs: activeRoute.budgetMs } : {}), ...extra })
      this.lastAttempts = [...attempts]
    }
    const success = (page, method) => {
      recordAttempt(method, 'verified')
      this.failures.clear()
      this.verified = { page, url, method }
      try { this.onVerified?.({ automated, profileUrl: url, page, method }) } catch {}
      if (!background) { page.show(); page.focus?.() }
      return { page, method }
    }
    const failed = (error, method, page) => {
      recordAttempt(method, 'failed', error.code || 'PROFILE_OPEN_FAILED', {reason:String(error.message || '').slice(0,220)})
      error.profileNavigation = [...attempts]
      error.windowId = page?.id || null
      error.source = method === '原评论' ? '原评论作者主页' : method === '搜索' ? '用户搜索窗口' : '交友主页'
      if (error.code === 'CHALLENGE') requestManualVerification(this.douyin, page, { source: '交友主页' })
      if (['LOGIN_REQUIRED', 'ACCESS_RESTRICTED'].includes(error.code)) page.show()
      if (!recoverable.has(error.code)) {
        if (error.preActionFailure) throw error
        throw Object.assign(beforeProfileAction(error.code || 'PROFILE_OPEN_FAILED', error.message), {diagnostics:error.diagnostics})
      }
      // Structured attempts are retained for diagnosis and the batch result.
    }
    this.opening = true
    try {
      alive()
      const verified = this.verified
      if (verified?.url === url && !verified.page.isDestroyed?.() && canonicalProfile(verified.page.webContents.getURL?.())?.profileUrl === url) {
        const state = await this.inspect(verified.page, url)
        alive()
        if (state.ready) return success(verified.page, verified.method)
        if (state.code) failed(beforeProfileAction(state.code, messageOf[state.code]), '当前主页', verified.page)
      }
      if ((verified?.page !== win || verified?.url !== url) && !win.isDestroyed?.() && canonicalProfile(win.webContents.getURL?.())?.profileUrl === url) {
        const state = await this.inspect(win, url)
        alive()
        if (state.ready) return success(win, 'current')
        if (state.code) failed(beforeProfileAction(state.code, messageOf[state.code]), '当前主页', win)
      }
      if (automated && this.failures.size >= PROFILE_FAILURE_LIMIT) {
        throw beforeProfileAction('PROFILE_QUEUE_PAUSED', '多个不同账号的主页未能核验，已暂停自动打开，请先手动验证一个候选')
      }
      try { return success(await this.direct(win, url, scoped('直开', Math.min(6000, totalBudget * .15))), 'direct') } catch (error) { failed(error, '直开', win) }
      const source = this.sourceFor?.(identity.platformUserId, candidate)
      this.viewer ||= new CommentCollectionService(this.douyin, { accountId: this.accountId })
      if (source) {
        try {
          const result = await this.viewer.openCommentAuthor({ ...source, ...identity }, scoped('原评论', Math.min(20000, totalBudget * .44)))
          alive()
          return success(result.page, 'comment')
        } catch (error) { failed(error, '原评论', this.viewer.window || win) }
      } else recordAttempt('comment', 'unavailable', 'MISSING_SOURCE_COMMENT')
      try {
        const result = await this.fromSearch(this.viewer, { url, name: candidate.nickname || candidate.name }, scoped('搜索', Math.min(18000, deadline - Date.now())),
          {onAttempt: row => recordAttempt(row.method, row.status, row.code || '', row)})
        alive()
        return success(result.page, 'search')
      } catch (error) { failed(error, '搜索', this.viewer.window || win) }
      this.failures.add(identity.platformUserId)
      if (automated && this.failures.size >= PROFILE_FAILURE_LIMIT) {
        throw beforeProfileAction('PROFILE_QUEUE_PAUSED', `多个不同账号的主页未能核验，已暂停自动打开。 ${attempts.map(x=>`${x.method}:${x.status}:${x.code}`).join('；')}`)
      }
      throw Object.assign(beforeProfileAction('PAGE_NOT_READY', attempts.map(x=>`${x.method}:${x.status}:${x.code}`).join('；')), { profileNavigation: [...attempts] })
    } catch (error) {
      if (error.code === 'PROFILE_NAV_TIMEOUT') {
        this.failures.add(identity.platformUserId)
        if (automated && this.failures.size >= PROFILE_FAILURE_LIMIT) throw beforeProfileAction('PROFILE_QUEUE_PAUSED', '连续不同主页的可用入口未能核验，已暂停自动打开')
      }
      error.profileNavigation ||= [...attempts]
      throw error
    } finally {
      this.opening = false
    }
  }
}

module.exports = { ProfileNavigator }
