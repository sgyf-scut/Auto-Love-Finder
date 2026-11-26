const { readPublicGender } = require('./profile-reader.cjs')
const { startProfileTrace } = require('./profile-trace.cjs')
const { checkVerification } = require('./verification-gate.cjs')
const { requestManualVerification } = require('../manual-verification.cjs')
const { FriendshipService } = require('../friendship.cjs')
const { videoSearchSnapshot, videoUrl } = require('../video-openings.cjs')
const { CandidateManager, canonicalProfile } = require('./candidate-manager.cjs')
const { commentAuthorSnapshot, openCommentPanel, advanceCommentViewport, prioritizeComments, publicProfileSnapshot, scoreCommentCandidate, summarizePublicProfile, parseFollowerCount } = require('./comment-snapshot.cjs')
const { parseRequirements } = require('./requirements-parser.cjs')
const { navigateReadable, executePageScript } = require('./page-readiness.cjs')
const { discoverySearches } = require('./search-topics.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class DiscoveryEngine extends FriendshipService {
  constructor(douyin, { accountId = '' } = {}) {
    super(douyin)
    this.accountId = accountId; this.manager = new CandidateManager(this.storage); this.generation = 0; this.running = false
    const old = this.manager.get().runState
    if (['running', 'searching', 'reading'].includes(old.status)) this.persistRun({ status: 'interrupted', phase: '上次发现已中断，请手动重新开始', finishedAt: new Date().toISOString() })
  }
  ensureWindow() { const win = super.ensureWindow(); win.setTitle?.('交友发现 · 抖音'); return win }
  async navigate(win, url) {
    try { await super.navigate(win, url) }
    catch (error) {
      // A public profile may render before an ancillary resource finishes. The
      // caller must still verify the exact URL and public DOM before saving it.
      if (!/加载超时/.test(error.message) || win.isDestroyed?.() || String(win.webContents.getURL?.() || '') !== url) throw error
    }
  }
  emit() { this.douyin.emitEvent?.('discovery_progress', { discovery: this.manager.get() }) }
  persistRun(patch) {
    if (this.destroyed) return
    const discovery = this.manager.get()
    this.manager.save({ ...discovery, runState: { ...discovery.runState, ...patch } }); this.emit()
  }
  assertActive(generation = this.generation) {
    if (this.destroyed || this.douyin._destroyed || generation !== this.generation) throw Object.assign(new Error('候选发现已停止'), { stopped: true })
    if (this.storage.get().automation?.paused) throw new Error('当前账号已暂停，请恢复后再发现候选')
    if (this.douyin.verificationActive) throw Object.assign(new Error('抖音需要安全验证，请完成后再发现候选'), { blocked: true })
  }
  updateConfig(config) { this.assertActive(); if (this.running) throw new Error('发现过程中不能修改搜索设置，请先停止'); const discovery = this.manager.updateConfig(config); this.emit(); return { ok: true, discovery } }
  setIntent(id, intent) { this.assertActive(); this.candidate(id); const result = this.manager.setIntent(id, intent); this.emit(); return result }
  review(id, options) { this.assertActive(); const result = this.manager.review(id, options); this.emit(); return result }
  async parseRequirements(text, ai) {
    this.assertActive(); if (this.running) throw new Error('请先停止发现再解析要求')
    const generation = this.generation
    const result = await parseRequirements(ai, text, this.manager.get().config)
    this.assertActive(generation)
    return result
  }
  candidate(id) {
    const c = this.manager.get().candidates.find(c => c.id === id)
    if (!c || !canonicalProfile(c.profileUrl) || (c.accountId && c.accountId !== this.accountId)) throw new Error('找不到当前账号的候选人，请刷新后操作')
    return c
  }
  async waitSnapshot(win, fn, args, generation, accept = r => r?.ready, { timeout = 18000, interval = 350 } = {}) {
    const deadline = Date.now() + Math.max(1, Math.min(18000, timeout))
    let lastScriptError = ''
    do {
      this.assertActive(generation)
      let r
      try { r = await executePageScript(win, `(${fn.toString()})(...${JSON.stringify(args)})`, Math.max(1, Math.min(3000, deadline - Date.now()))) }
      catch (error) {
        this.assertActive(generation)
        lastScriptError = String(error?.message || error).slice(0,160)
        if (Date.now() < deadline) await sleep(Math.min(interval, deadline - Date.now()))
        continue
      }
      this.assertActive(generation)
      if (r?.challenge || r?.loginRequired) { win.show(); if (r.challenge) requestManualVerification(this.douyin, win, { source: '交友发现窗口' }); throw Object.assign(new Error(r.challenge ? '请在交友发现窗口完成抖音安全验证' : '请先在交友发现窗口登录抖音'), { blocked: true }) }
      if (r?.wrongPage) throw new Error('页面已跳到其他视频或主页，已停止采集')
      if (r?.serverError) throw Object.assign(new Error(`抖音页面暂时不可用：${r.serverError}`), { transient: true })
      if (accept(r)) return r
      if (Date.now() < deadline) await sleep(Math.min(interval, deadline - Date.now()))
    } while (Date.now() < deadline)
    win.show()
    throw new Error(`未读到可靠的评论作者或页面尚未加载，请查看发现窗口后重试${lastScriptError ? '：'+lastScriptError : ''}`)
  }
  async searchTopicVideos(win, keyword, generation) {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertActive(generation)
      await this.navigate(win, `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`)
      this.assertActive(generation)
      try { return await this.waitSnapshot(win, videoSearchSnapshot, [], generation, r => r?.candidates?.length || r?.empty) }
      catch (e) { if (!e.transient || attempt) throw e }
    }
  }
  async readVideoComments(win, video, limit, generation) {
    this.assertActive(generation)
    const url = videoUrl(video.url), videoId = url.split('/').at(-1)
    await this.navigate(win, url); this.assertActive(generation)
    const opened = await win.webContents.executeJavaScript(`(${openCommentPanel.toString()})(${JSON.stringify(videoId)})`)
    if (opened?.wrongPage) throw new Error('打开的不是目标视频，已停止采集')
    const config = this.manager.get().config
    const first = await this.waitSnapshot(win, commentAuthorSnapshot, [videoId, 30], generation)
    if (!config.preferLowerComments && !config.includeReplies && !config.preferLowReplies) return { ...first, candidates: first.candidates?.slice(0, limit) }
    const pool = new Map(), retain = (snapshot, depth) => {
      for (const row of snapshot.candidates || []) {
        const key = `${row.platformUserId}|${row.commentId || row.commentText}`
        if (!pool.has(key)) pool.set(key, { ...row, scrollDepth: depth })
      }
    }
    retain(first, 0)
    const steps = config.preferLowerComments ? config.commentScrollSteps : 0
    for (let depth = 0; depth <= steps; depth++) {
      this.assertActive(generation)
      const moved = await win.webContents.executeJavaScript(`(${advanceCommentViewport.toString()})(${JSON.stringify(videoId)},${JSON.stringify({ initialize: depth === 0, expandReplies: config.includeReplies })})`)
      if (moved?.wrongPage) throw new Error('评论窗口已跳转，停止读取')
      await sleep(650); this.assertActive(generation)
      const snapshot = await this.waitSnapshot(win, commentAuthorSnapshot, [videoId, 30, { preferLower: config.preferLowerComments }], generation)
      retain(snapshot, depth)
    }
    return { ...first, candidates: prioritizeComments([...pool.values()], config).slice(0, limit) }
  }
  async start() {
    this.assertActive()
    if (this.running || this.busy) throw new Error('发现窗口正在操作，请稍后重试')
    const config = this.manager.get().config
    const searches = discoverySearches(config)
    if (!searches.length) throw new Error('请手动填写至少一个视频标签或搜索关键词')
    return this.exclusive(async () => {
      this.running = true; const generation = ++this.generation
      const counts = { videos: 0, comments: 0, added: 0, merged: 0, skipped: 0, invalid: 0 }
      try {
        const old = this.manager.get().runState, cursor = Math.max(0, Number(old.keywordCursor) || 0) % searches.length
        this.persistRun({ status: 'running', phase: '正在搜索主题视频', startedAt: new Date().toISOString(), finishedAt: null, lastError: '', counts })
        const win = this.ensureWindow(), seenVideos = new Set(), profileIds = new Set()
        for (let i = 0; i < Math.min(searches.length, 5) && counts.videos < config.maxVideosPerRun; i++) {
          this.assertActive(generation)
          const search = searches[(cursor + i) % searches.length]
          this.persistRun({ phase: `正在搜索：${search.keyword}`, keywordCursor: (cursor + i + 1) % searches.length })
          const result = await this.searchTopicVideos(win, search.keyword, generation)
          for (const video of result.candidates || []) {
            if (counts.videos >= config.maxVideosPerRun) break
            const url = videoUrl(video.url)
            if (seenVideos.has(url)) continue
            seenVideos.add(url); counts.videos++
            this.persistRun({ phase: `读取第${counts.videos}个视频的评论`, counts })
            const comments = await this.readVideoComments(win, video, config.commentsPerVideo, generation)
            this.assertActive(generation)
            const rows = (comments.candidates || []).slice(0, config.commentsPerVideo)
            const records = rows.map(c => ({ nickname: c.nickname, profileUrl: c.profileUrl, platformUserId: c.platformUserId, platformNumericUserId: c.platformNumericUserId, avatarUrl: c.avatarUrl,
              ...scoreCommentCandidate(c.commentText), source: { ...search, videoId: url.split('/').at(-1), videoTitle: video.title, commentId: c.commentId, commentText: c.commentText,
                isReply: c.isReply, parentCommentId: c.parentCommentId, replyCount: c.replyCount, scrollDepth: c.scrollDepth } }))
            const saved = this.manager.upsert(records, { accountId: this.accountId })
            counts.comments += rows.length; counts.added += saved.added; counts.merged += saved.merged; counts.skipped += saved.skipped + (Number(comments.skipped) || 0); counts.invalid += saved.invalid
            this.persistRun({ counts })
            if (config.targetGender === 'female' || config.requireFollowerLimit) {
              for (const row of rows) {
                if (profileIds.size >= config.profileChecksPerRun) break
                if (profileIds.has(row.platformUserId)) continue
                const candidate = this.manager.get().candidates.find(c => c.platformUserId === row.platformUserId)
                if (!candidate) continue
                profileIds.add(row.platformUserId)
                this.persistRun({ phase: `核验第${profileIds.size}位候选人的公开性别和粉丝数` })
                try { await this.captureProfile(win, candidate.id, generation, { automated: true }) }
                catch (error) {
                  this.assertActive(generation)
                  if (error.blocked || error.stopped) throw error
                  this.persistRun({ phase: '该主页未能核验，保留为待确认后继续' })
                }
              }
            }
          }
        }
        this.assertActive(generation)
        this.persistRun({ status: 'completed', phase: `发现完成，新增${counts.added}人，合并${counts.merged}条已有来源`, finishedAt: new Date().toISOString(), counts })
        this.douyin.log?.('discovery_completed', '评论候选发现完成，仅保存候选，未关注或发送消息', { counts })
        return { ok: true, discovery: this.manager.get() }
      } catch (error) {
        const stopped = error.stopped === true || this.destroyed || generation !== this.generation
        if (!this.destroyed && generation === this.generation) this.persistRun({ status: stopped ? 'stopped' : error.blocked ? 'blocked' : 'failed', phase: error.message, lastError: stopped ? '' : error.message, finishedAt: new Date().toISOString(), counts })
        return { ok: stopped, stopped, error: stopped ? undefined : error.message, discovery: this.manager.get() }
      } finally { this.running = false }
    })
  }
  stop() {
    this.generation++
    if (this.running) this.window?.webContents.stop?.()
    this.persistRun({ status: 'stopped', phase: '已停止发现，已保存的候选保留', finishedAt: new Date().toISOString() })
    return { ok: true, discovery: this.manager.get() }
  }
  async open(id) {
    this.assertActive(); const candidate = this.candidate(id), generation = this.generation
    return this.exclusive(async () => { const win = this.ensureWindow(); win.show(); win.focus?.(); const opened = await this.openProfilePage(win, candidate, { automated: false, assertActive: () => this.assertActive(generation) }); this.assertActive(generation); return { ok: true, candidate, method: opened.method } })
  }
  async checkBatchVerification(extraWindows = []) {
    return checkVerification(this.douyin, [{ win: this.douyin.window, source: '登录窗口' }, { win: this.window, source: '交友发现窗口' }, ...extraWindows])
  }
  async readBatchGender(candidate, isActive = () => true, { requiredFields = ['gender'] } = {}) {
    const identity = canonicalProfile(candidate.profileUrl)
    if (!identity || identity.platformUserId !== candidate.platformUserId) return { status: 'failed', code: 'PROFILE_IDENTITY_INVALID', reason: '候选主页地址与账号 ID 不一致', retryable: false }
    const generation = this.generation
    const current = () => !this.destroyed && !this.douyin._destroyed && generation === this.generation && !this.storage.get().automation?.paused && isActive()
    if (!current()) return { status: 'cancelled', code: 'READ_CANCELLED', reason: '核验任务已停止或账号已切换', retryable: false }
    try {
      return await this.exclusive(async () => {
        const gate = await this.checkBatchVerification()
        if (!gate.ok) return { status: 'blocked', code: gate.code, reason: gate.reason, source: gate.source, retryable: false }
        let win = this.ensureWindow(), profileMethod = 'direct'
        if (this.douyin.profileNavigator) {
          const opened = await this.openProfilePage(win, candidate, { automated: true, background: true, timeoutMs: 45000,
            assertActive: () => { if (!current()) throw Object.assign(new Error('核验已停止或账号已切换'), { code: 'READ_CANCELLED', stopped: true }) } })
          win = opened.page; profileMethod = opened.method
        }
        try { if (!win.isVisible?.()) { if (typeof win.showInactive === 'function') win.showInactive(); else win.show?.() } } catch {}
        let initialDocumentKey = ''
        if (!this.douyin.profileNavigator && win.webContents.getURL?.()) {
          try { const value = await executePageScript(win, 'String(performance.timeOrigin || "")', 500); if (typeof value === 'string') initialDocumentKey = value } catch {}
        }
        const trace = await startProfileTrace(win, identity)
        let result, initialImage, imageStarted = false
        try { result = await readPublicGender(win, identity, { requiredFields, isCurrent: current, initialDocumentKey,
          ...(this.douyin.profileNavigator ? { navigate: async (page, url, options) => {
            const deadline = Date.now() + options.timeout
            do {
              if (!current()) return { ok: false, code: 'READ_CANCELLED' }
              const state = await options.read(page, url, Math.max(1, deadline - Date.now()))
              if (state.code) return { ok: false, code: state.code }
              if (state.ready) return { ok: true }
              await sleep(250)
            } while (Date.now() < deadline)
            return { ok: false, code: 'TIMEOUT' }
          } } : {}),
          onObservation: snapshot => {
            if (!imageStarted && snapshot?.hasHeader && typeof win.webContents.capturePage === 'function') {
              imageStarted = true
              let timer
              initialImage = Promise.race([Promise.resolve().then(() => win.webContents.capturePage()).then(image => image?.isEmpty?.() ? null : image?.toPNG()), new Promise(resolve => { timer = setTimeout(() => resolve(null),500) })]).catch(() => null).finally(() => clearTimeout(timer))
            }
          },
          read: async (window, code, timeout) => {
            if (this.douyin.verificationActive) return { challenge: true }
            const snapshot = await executePageScript(window, code, timeout)
            const requests = trace.snapshot().requests
            const last = [...requests].reverse().find(row => row.kind === 'profile') || requests.at(-1)
            return { ...snapshot, networkStatus: last?.httpStatus || 0, networkFailed: !!last?.failure && !last.cancelled }
          },
        }) } finally { const network = await trace.stop(); if (result) result = { ...result, diagnostics: { ...result.diagnostics, profileMethod, network } } }
        if (!current()) return { status: 'cancelled', code: 'READ_CANCELLED', reason: '核验任务已停止或账号已切换', retryable: false }
        if (result.status === 'blocked') {
          win.show?.()
          if (result.code === 'CHALLENGE') requestManualVerification(this.douyin, win, { source: '交友发现窗口' })
        }
        if (result.status === 'failed' || result.status === 'blocked' || Object.values(result.fieldStatuses || {}).some(x => x === 'not_present' || x === 'conflict')) result = await this.captureBatchProfileFailure(win, result, current, initialImage ? await initialImage : null)
        return result
      })
    } catch (error) {
      if (!current() || error?.stopped) return { status: 'cancelled', code: 'READ_CANCELLED', reason: '核验任务已停止或账号已切换', retryable: false }
      if (error.code === 'PROFILE_QUEUE_PAUSED') return { status: 'failed', code: 'PROFILE_UNAVAILABLE', profileQueuePaused: true, reason: error.message, retryable: false, source: error.source || '交友主页', windowId: error.windowId || null, diagnostics: {profileNavigation:error.profileNavigation || this.douyin.profileNavigator?.lastAttempts || []} }
      if (error.code === 'ACCOUNT_ID_MISMATCH') return { status: 'blocked', code: 'READ_TARGET_MISMATCH', reason: error.message, retryable: false, source: error.source || '交友主页', windowId: error.windowId || null, diagnostics: {profileNavigation:error.profileNavigation || this.douyin.profileNavigator?.lastAttempts || []} }
      if (error.blocked) return { status: 'blocked', code: error.code === 'ACCESS_RESTRICTED' ? 'PROFILE_ACCESS_RESTRICTED' : error.code === 'CHALLENGE_REQUIRED' ? 'CHALLENGE' : error.code, reason: error.message, retryable: false, source: error.source || '交友主页', windowId: error.windowId || null, diagnostics: {profileNavigation:error.profileNavigation || this.douyin.profileNavigator?.lastAttempts || []} }
      if (['PAGE_NOT_READY','PROFILE_NOT_FOUND','PROFILE_NOT_READY','PROFILE_NAV_TIMEOUT','PROFILE_RESPONSE_EMPTY'].includes(error.code)) return { status: 'failed', code: 'PROFILE_UNAVAILABLE', reason: error.message, retryable: false, source: error.source || '交友主页', windowId: error.windowId || null, diagnostics: {...error.diagnostics, profileNavigation:error.profileNavigation || this.douyin.profileNavigator?.lastAttempts || []} }
      return { status: 'failed', code: /交友操作进行中/.test(String(error.message || error)) ? 'PROFILE_WINDOW_BUSY' : 'PROFILE_READ_ERROR', reason: String(error.message || error).slice(0,220), retryable: true,
        diagnostics: { stage: 'public_profile', expectedProfileUrl: identity.profileUrl, expectedPlatformUserId: identity.platformUserId } }
    }
  }
  async captureBatchProfileFailure(win, result, isCurrent = () => true, initialImage = null) {
    const diagnostics = { ...(result.diagnostics || {}) }
    try { diagnostics.currentPage = String(win.webContents.getURL?.() || '').split(/[?#]/)[0] } catch {}
    if (!isCurrent() || win.isDestroyed?.() || typeof win.webContents.capturePage !== 'function') return { ...result, diagnostics }
    try {
      const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto')
      const directory = path.join(require('electron').app.getPath('userData'), 'diagnostics', 'profile-reading')
      fs.mkdirSync(directory, { recursive: true })
      const stem = `${Date.now()}-${randomUUID()}`
      let timer, shot
      try { shot = await Promise.race([win.webContents.capturePage(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500) })]) }
      finally { clearTimeout(timer) }
      if (!isCurrent()) return { status: 'cancelled', code: 'READ_CANCELLED', reason: '核验任务已切换', retryable: false }
      if (shot && !shot.isEmpty?.()) { diagnostics.screenshotPath = path.join(directory, stem + '.png'); fs.writeFileSync(diagnostics.screenshotPath, shot.toPNG()) }
      if (Buffer.isBuffer(initialImage)) { diagnostics.initialScreenshotPath = path.join(directory, stem + '.initial.png'); fs.writeFileSync(diagnostics.initialScreenshotPath, initialImage) }
      diagnostics.recordPath = path.join(directory, stem + '.json')
      fs.writeFileSync(diagnostics.recordPath, JSON.stringify({ capturedAt: new Date().toISOString(), status: result.status, code: result.code, reason: result.reason || '', diagnostics }, null, 2))
      const records = fs.readdirSync(directory).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort()
      for (const name of records.slice(0, -20)) for (const ext of ['.json', '.png', '.initial.png']) { try { fs.unlinkSync(path.join(directory, name.replace(/\.json$/, ext))) } catch {} }
    } catch (error) { diagnostics.captureError = String(error.message || error).slice(0,180) }
    return { ...result, diagnostics }
  }
  async inspect(id, options = {}) {
    this.assertActive(); const candidate = this.candidate(id), generation = this.generation
    return this.exclusive(() => this.captureProfile(this.ensureWindow(), candidate.id, generation, options))
  }
  async captureProfile(win, id, generation, { automated = false } = {}) {
      this.assertActive(generation); const candidate = this.candidate(id)
      win = (await this.openProfilePage(win, candidate, { automated, assertActive: () => this.assertActive(generation) })).page
      // P2-17B.2：读取失败不能吞掉，也不能把"未读到"当成"没有限制"。
      // 记住失败原因与时间，保留已有结论（人工核实/上次公开资料），由界面提示重试。
      let profile
      try {
        profile = await this.waitSnapshot(win, publicProfileSnapshot, [candidate.profileUrl], generation,
          r => r?.ready && (!this.manager.get().config.requireFollowerLimit || parseFollowerCount(r.rawText) !== null))
      } catch (error) {
        const message = String(error?.message || error)
        // 生成号变化/账号切换属于流程中断，交给上层处理，不当成"主页读取失败"。
        if (error?.stopped || /已停止|已切换|已变化/.test(message)) throw error
        if (automated && error?.blocked) throw error
        const discovery = this.manager.get()
        const current = discovery.candidates.find(c => c.id === id)
        if (current) {
          const record = { ...current,
            publicProfile: { ...(current.publicProfile || {}), status: 'failed', lastError: message.slice(0, 200), lastAttemptAt: new Date().toISOString() },
            updatedAt: new Date().toISOString() }
          this.manager.save({ ...discovery, candidates: discovery.candidates.map(c => c.id === id ? record : c) })
          this.manager.appendEvent(id, 'public_profile_failed', { error: message.slice(0, 200), blocked: error?.blocked === true })
          this.emit()
        }
        const preset = error?.blocked
          ? (message.includes('登录') ? '需要先登录抖音：登录后重新读取主页' : '抖音要求安全验证：完成验证后重新读取主页')
          : '读取主页失败：页面未返回公开资料，已有性别/年龄结论没有改动'
        return { ok: false, error: `${preset}（${message}）`, blocked: error?.blocked === true, candidate: this.candidate(id), discovery: this.manager.get() }
      }
      this.assertActive(generation)
      const discovery = this.manager.get()
      const current = discovery.candidates.find(c => c.id === id)
      if (!current || current.platformUserId !== profile.platformUserId || current.profileUrl !== profile.profileUrl) throw new Error('候选身份已改变，已停止保存主页信息')
      const record = { ...current, publicProfile: { ...profile, capturedAt: new Date().toISOString() }, publicSignals: summarizePublicProfile(profile), updatedAt: new Date().toISOString() }
      this.manager.save({ ...discovery, candidates: discovery.candidates.map(c => c.id === id ? record : c) })
      this.manager.appendEvent(id, 'public_profile_updated', { gender: record.publicSignals?.genderText || null, age: record.publicSignals?.age || null, followers: record.publicSignals?.followerCount ?? null })
      this.emit()
      return { ok: true, candidate: this.candidate(id), discovery: this.manager.get() }
  }
  destroy() { if (this.destroyed) return; this.stop(); super.destroy() }
}
module.exports = { DiscoveryEngine }
