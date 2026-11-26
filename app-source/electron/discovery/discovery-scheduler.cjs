// P2-12B 自动任务调度：收藏夹每日同步 + 自动分析队列 + 启动续跑 + 跨轮/跨日预算。
// 边界：
// 1) 只调用已验收的 favorites-sync / discovery-pipeline，不重新实现采集与分类；
// 2) 登录失效、验证码、访问受限、页面结构变化立即暂停，不绕过；
// 3) 限频/网络错误采用有限重试和退避，不做无限循环；
// 4) 预算按本地日期重置，计数持久化在 library.pipeline.scheduler，重启不清零；
// 5) 本模块不关注、不发私信、不触碰联系人数据。
const DAY_MS = 24 * 60 * 60 * 1000
const RETRY_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]
const HARD_STOP_CODES = ['LOGIN_REQUIRED', 'CHALLENGE', 'ACCESS_RESTRICTED', 'ACCESS_DENIED', 'NO_TRANSPORT', 'PAGE_STRUCTURE_CHANGED', 'STRUCTURE_CHANGED', 'MODEL_UNAVAILABLE', 'CONFIG_MISSING']
const TRANSIENT_CODES = ['RATE_LIMITED', 'NETWORK_ERROR', 'TIMEOUT', 'COMMENTS_UNAVAILABLE']

const nowIso = () => new Date().toISOString()
const toDate = value => {
  if (value instanceof Date) return value
  const parsed = value ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}
const pad = value => String(value).padStart(2, '0')
// 明确的本地日期规则：预算只在本地日历日变化时重置，避免 UTC 偏移和重启导致计数归零。
function localDayKey(date = new Date()) {
  const target = toDate(date) || new Date()
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`
}
function startOfNextLocalDay(date = new Date()) {
  const target = toDate(date) || new Date()
  return new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1, 0, 5, 0, 0)
}
const isDue = (time, now) => {
  const target = toDate(time)
  return !target || target.getTime() <= now.getTime()
}
const plus = (now, ms) => new Date(now.getTime() + ms).toISOString()
const safeInt = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback)

class DiscoveryScheduler {
  constructor({ store, syncFavorites = null, runPipeline = null, pendingCount = null, isBusy = null, now = () => new Date(), emit = () => {}, logger = () => {} } = {}) {
    if (!store) throw new Error('缺少素材库')
    this.store = store
    this.syncFavorites = syncFavorites
    this.runPipeline = runPipeline
    this.pendingCount = pendingCount
    this.isBusy = isBusy
    this.now = typeof now === 'function' ? now : () => new Date(now)
    this.emit = typeof emit === 'function' ? emit : () => {}
    this.logger = typeof logger === 'function' ? logger : () => {}
    this.inFlight = null
    this.timer = null
    this.accountId = ''
  }

  state() {
    return this.store.pipelineState().scheduler
  }

  save(patch = {}) {
    const current = this.state()
    const budgetPatch = patch.budget && typeof patch.budget === 'object' ? { ...current.budget, ...patch.budget } : current.budget
    const next = { ...current, ...patch, budget: budgetPatch, updatedAt: nowIso() }
    const state = this.store.setPipeline({ scheduler: next })
    try { this.emit(state.scheduler) } catch { /* 进度回调失败不影响调度 */ }
    return state.scheduler
  }

  // 跨日重置：只有本地日期变化才清零；程序重启当天继续累加，不会把已用预算重置为 0。
  ensureDay() {
    const today = localDayKey(this.now())
    const state = this.state()
    if (state.budget.day === today) return state
    const reset = {
      ...state.budget,
      day: today,
      modelCalls: 0, tokens: 0, tokensEstimated: 0, tokenSource: 'none',
      videos: 0, comments: 0, syncs: 0,
    }
    return this.save({ budget: reset })
  }

  configure({ autoSync, autoAnalyze, syncIntervalHours, analyzeIntervalMinutes, limits } = {}) {
    this.ensureDay()
    const state = this.state()
    const now = this.now()
    const patch = {}
    if (typeof autoSync === 'boolean') patch.autoSync = autoSync
    if (typeof autoAnalyze === 'boolean') patch.autoAnalyze = autoAnalyze
    if (syncIntervalHours !== undefined) patch.syncIntervalHours = Math.max(1, Math.min(168, safeInt(syncIntervalHours, state.syncIntervalHours)))
    if (analyzeIntervalMinutes !== undefined) patch.analyzeIntervalMinutes = Math.max(1, Math.min(1440, safeInt(analyzeIntervalMinutes, state.analyzeIntervalMinutes)))
    if (limits && typeof limits === 'object') {
      const base = state.budget.limits
      patch.budget = {
        limits: {
          dailyModelCalls: Math.max(0, Math.min(200, safeInt(limits.dailyModelCalls, base.dailyModelCalls))),
          dailySyncCount: Math.max(1, Math.min(24, safeInt(limits.dailySyncCount, base.dailySyncCount))),
          perRoundVideos: Math.max(1, Math.min(50, safeInt(limits.perRoundVideos, base.perRoundVideos))),
          perRoundModelCalls: Math.max(0, Math.min(50, safeInt(limits.perRoundModelCalls, base.perRoundModelCalls))),
          perVideoComments: Math.max(1, Math.min(100, safeInt(limits.perVideoComments, base.perVideoComments))),
        },
      }
    }
    // 开启时如果从未运行过，立即排入下一次；已有明确时间的不覆盖。
    if (patch.autoSync === true && !state.nextSyncAt) patch.nextSyncAt = now.toISOString()
    if (patch.autoAnalyze === true && !state.nextRunAt) patch.nextRunAt = now.toISOString()
    if (patch.autoAnalyze === true && state.status === 'completed') patch.status = 'waiting'
    if ((patch.autoSync === true || patch.autoAnalyze === true) && ['idle', 'completed'].includes(state.status)) patch.status = 'waiting'
    return this.save(patch)
  }

  pause(reason = '用户暂停自动任务') {
    const state = this.save({ status: 'paused', pausedReason: reason, code: 'USER_PAUSED', nextAction: '点击“继续”恢复自动任务' })
    return state
  }

  resume() {
    this.ensureDay()
    const now = this.now()
    const state = this.state()
    const patch = { status: 'waiting', code: null, lastError: '', pausedReason: '', nextAction: '', attempts: 0, nextAttemptAt: null }
    if (state.autoSync && !state.nextSyncAt) patch.nextSyncAt = now.toISOString()
    if (state.autoAnalyze) patch.nextRunAt = now.toISOString()
    return this.save(patch)
  }

  stop() {
    return this.save({ autoSync: false, autoAnalyze: false, status: 'idle', nextSyncAt: null, nextRunAt: null, code: null, lastError: '', nextAction: '自动任务已关闭' })
  }

  // 启动时恢复：把上次崩溃遗留的 running 变成可继续的等待状态，并检查是否还有未完成任务。
  bootstrap() {
    const state = this.ensureDay()
    const now = this.now()
    const pending = typeof this.pendingCount === 'function' ? safeInt(this.pendingCount(), 0) : null
    const patch = {}
    if (state.status === 'running') {
      patch.status = 'waiting'
      patch.code = 'APP_RESTARTED'
      patch.lastError = '上次运行被程序重启中断，已保留已完成进度'
      patch.nextAction = pending > 0 ? '将在登录状态正常且预算允许时自动继续' : '没有待处理视频'
    }
    if (state.autoSync && !state.nextSyncAt) patch.nextSyncAt = now.toISOString()
    if (state.autoAnalyze && !state.nextRunAt) patch.nextRunAt = now.toISOString()
    const next = Object.keys(patch).length ? this.save(patch) : state
    return { state: next, pending }
  }

  limits() {
    return this.state().budget.limits
  }

  remainingDailyCalls() {
    const state = this.ensureDay()
    return Math.max(0, state.budget.limits.dailyModelCalls - state.budget.modelCalls)
  }

  recordSync(result = {}, now = this.now()) {
    const state = this.state()
    const ok = result.ok === true || result.status === 'completed'
    const code = result.code || (ok ? null : 'SYNC_FAILED')
    if (ok) {
      const next = new Date(now.getTime() + state.syncIntervalHours * 60 * 60 * 1000)
      return this.save({
        lastSyncAt: now.toISOString(), nextSyncAt: next.toISOString(), status: 'waiting',
        code: null, lastError: '', attempts: 0, nextAttemptAt: null,
        budget: { syncs: state.budget.syncs + 1 },
        lastRound: { at: now.toISOString(), status: 'sync_ok', message: '收藏夹同步完成', sync: { found: safeInt(result.found), added: safeInt(result.added), ok: true }, analysis: this.state().lastRound?.analysis || null },
        log: [...state.log, { at: now.toISOString(), status: 'sync_ok', message: `同步完成：找到 ${safeInt(result.found)}，新增 ${safeInt(result.added)}`, sync: { found: safeInt(result.found), added: safeInt(result.added), ok: true }, analysis: null }].slice(-20),
      })
    }
    if (HARD_STOP_CODES.includes(code)) {
      return this.save({
        status: 'blocked', code, lastError: result.reason || result.message || '收藏夹同步被平台阻止',
        nextAction: '请先处理登录/验证/权限问题，再点击“继续”',
        lastRound: { at: now.toISOString(), status: 'sync_blocked', message: result.reason || result.message || code, sync: { found: 0, added: 0, ok: false }, analysis: null },
        log: [...state.log, { at: now.toISOString(), status: 'sync_blocked', message: String(result.reason || result.message || code).slice(0, 300), sync: { found: 0, added: 0, ok: false }, analysis: null }].slice(-20),
      })
    }
    const attempts = state.attempts + 1
    const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
    return this.save({
      status: attempts >= 3 ? 'blocked' : 'waiting',
      code, lastError: result.reason || result.message || '收藏夹同步失败',
      attempts,
      nextAttemptAt: plus(now, delay), nextSyncAt: plus(now, delay),
      nextAction: attempts >= 3 ? '连续失败已达上限，请检查页面后手动继续' : `将在 ${Math.round(delay / 60000)} 分钟后重试`,
      lastRound: { at: now.toISOString(), status: 'sync_failed', message: result.reason || result.message || code, sync: { found: 0, added: 0, ok: false }, analysis: null },
      log: [...state.log, { at: now.toISOString(), status: 'sync_failed', message: String(result.reason || result.message || code).slice(0, 300), sync: { found: 0, added: 0, ok: false }, analysis: null }].slice(-20),
    })
  }

  recordPipeline(result = {}, now = this.now()) {
    const state = this.state()
    const aiCalls = safeInt(result.aiCalls)
    const tokens = safeInt(result.tokens)
    const estimated = tokens > 0 ? 0 : aiCalls * 1600
    const budget = {
      modelCalls: state.budget.modelCalls + aiCalls,
      tokens: state.budget.tokens + tokens,
      tokensEstimated: state.budget.tokensEstimated + estimated,
      tokenSource: tokens > 0 ? 'model_returned' : (estimated > 0 ? 'estimated' : state.budget.tokenSource),
      videos: state.budget.videos + safeInt(result.processed ?? result.videosProcessed),
      comments: state.budget.comments,
    }
    const stoppedBy = result.stoppedBy || result.status || ''
    const code = result.code || result.pipeline?.code || (result.stoppedBy === 'budget' ? 'BUDGET_EXHAUSTED' : null)
    const remaining = safeInt(result.remaining)
    const videosProcessed = safeInt(result.processed ?? result.videosProcessed)
    const commentCount = safeInt(result.comments ?? result.commentsCollected)
    const dailyLeft = Math.max(0, state.budget.limits.dailyModelCalls - budget.modelCalls)
    budget.comments = state.budget.comments + commentCount
    const finishLog = (status, message, patch = {}) => this.save({
      status, ...patch,
      budget,
      lastRunAt: now.toISOString(),
      lastRound: {
        at: now.toISOString(), status, message,
        sync: state.lastRound?.sync || null,
        analysis: { processed: videosProcessed, aiCalls, tokens, remaining, message: String(message).slice(0, 300) },
      },
      log: [...state.log, { at: now.toISOString(), status, message: String(message).slice(0, 300), sync: null, analysis: { processed: videosProcessed, aiCalls, tokens, remaining, message: String(message).slice(0, 300) } }].slice(-20),
    })
    if (HARD_STOP_CODES.includes(code) || stoppedBy === 'blocked') {
      return finishLog('blocked', result.message || code || '自动分析被平台阻止', {
        code, lastError: result.message || '自动分析被平台阻止', nextAction: '请先处理登录/验证/权限问题，再点击“继续”',
      })
    }
    if (stoppedBy === 'paused') {
      return finishLog('paused', result.message || '流水线已被暂停', { code: 'PIPELINE_PAUSED', pausedReason: '流水线已被暂停', nextAction: '点击“继续”恢复' })
    }
    if (TRANSIENT_CODES.includes(code)) {
      const attempts = state.attempts + 1
      const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
      return finishLog(attempts >= 3 ? 'blocked' : 'waiting', result.message || code, {
        code, lastError: result.message || code, attempts,
        nextRunAt: plus(now, delay), nextAttemptAt: plus(now, delay),
        nextAction: attempts >= 3 ? '连续失败已达上限，请检查页面后手动继续' : `将在 ${Math.round(delay / 60000)} 分钟后重试`,
      })
    }
    if (stoppedBy === 'budget' || dailyLeft <= 0) {
      const nextDay = startOfNextLocalDay(now)
      return finishLog('budget_wait', `本轮预算已用完；已用模型调用 ${budget.modelCalls}/${state.budget.limits.dailyModelCalls}，等待下一天`, {
        code: 'BUDGET_EXHAUSTED', nextRunAt: nextDay.toISOString(), nextAttemptAt: null, attempts: 0,
        nextAction: '预算耗尽，已保存进度，下一次本地日期自动继续',
      })
    }
    if (remaining > 0) {
      // 本轮预算或视频数到达上限，但队列仍有任务：保存状态，间隔一段时间后继续下一轮。
      return finishLog('waiting', `本轮完成 ${safeInt(result.processed)} 个，剩余 ${remaining} 个视频待处理`, {
        code: null, nextRunAt: plus(now, state.analyzeIntervalMinutes * 60 * 1000), attempts: 0, nextAttemptAt: null,
        nextAction: '将在下一轮继续处理剩余视频',
      })
    }
    return finishLog('completed', result.message || '待分析队列已完成', {
      code: null, nextRunAt: null, nextAttemptAt: null, attempts: 0,
      nextAction: state.autoSync ? '等待下一次收藏夹同步' : '没有待处理任务',
    })
  }

  // 手动同步/分析也消耗同一份每日预算，但只记账，不改变自动任务的暂停/阻塞状态。
  accountManualSync(result = {}) {
    this.ensureDay()
    if (result.ok !== true && result.status !== 'completed') return this.state()
    const state = this.state()
    const now = this.now()
    const nextSyncAt = state.autoSync
      ? new Date(now.getTime() + state.syncIntervalHours * 60 * 60 * 1000).toISOString()
      : state.nextSyncAt
    return this.save({ lastSyncAt: now.toISOString(), nextSyncAt, budget: { syncs: state.budget.syncs + 1 } })
  }

  accountManualRun(result = {}) {
    this.ensureDay()
    const state = this.state()
    const aiCalls = safeInt(result.aiCalls)
    const tokens = safeInt(result.tokens)
    const estimated = tokens > 0 ? 0 : aiCalls * 1600
    return this.save({
      lastRunAt: this.now().toISOString(),
      budget: {
        modelCalls: state.budget.modelCalls + aiCalls,
        tokens: state.budget.tokens + tokens,
        tokensEstimated: state.budget.tokensEstimated + estimated,
        tokenSource: tokens > 0 ? 'model_returned' : (estimated > 0 ? 'estimated' : state.budget.tokenSource),
        videos: state.budget.videos + safeInt(result.processed ?? result.videosProcessed),
        comments: state.budget.comments + safeInt(result.comments ?? result.commentsCollected),
      },
    })
  }

  async tick({ forceSync = false, forceAnalyze = false } = {}) {
    if (this.inFlight) return { skipped: true, reason: 'ALREADY_RUNNING', state: this.state() }
    this.inFlight = this._tick({ forceSync, forceAnalyze })
    try { return await this.inFlight } finally { this.inFlight = null }
  }

  async _tick({ forceSync = false, forceAnalyze = false } = {}) {
    const now = this.now()
    const state = this.ensureDay()
    if (!state.autoSync && !state.autoAnalyze) return { skipped: true, reason: 'DISABLED', state }
    if (state.status === 'paused' || state.status === 'blocked') return { skipped: true, reason: state.status, state }
    if (typeof this.isBusy === 'function' && this.isBusy()) return { skipped: true, reason: 'BUSY', state }
    const limits = state.budget.limits
    let current = state
    let didWork = false

    // 收藏夹同步（每天默认一次，按本地日期计数；达到次数后等明天）。
    const syncDue = forceSync || isDue(current.nextSyncAt, now)
    if (current.autoSync && syncDue && typeof this.syncFavorites === 'function') {
      if (current.budget.syncs >= limits.dailySyncCount) {
        current = this.save({ nextSyncAt: startOfNextLocalDay(now).toISOString(), status: 'waiting', nextAction: '今日收藏夹同步次数已用完，明天继续' })
      } else {
        current = this.save({ status: 'running', code: null, lastError: '', lastRound: { at: now.toISOString(), status: 'sync_running', message: '正在同步收藏夹', sync: null, analysis: current.lastRound?.analysis || null } })
        didWork = true
        let result
        try { result = await this.syncFavorites() } catch (error) { result = { ok: false, code: 'SYNC_FAILED', reason: error?.message || '收藏夹同步失败' } }
        current = this.recordSync(result || {}, this.now())
        this.logger(`收藏夹同步：${current.lastRound?.status || ''} ${current.lastError || ''}`)
        if (current.status === 'blocked') return { stopped: true, reason: 'SYNC_BLOCKED', state: current }
        if (current.lastRound?.status === 'sync_failed') {
          // 同步失败已设置退避时间，本轮不再继续分析，避免在异常页面反复请求。
          return { syncFailed: true, state: current }
        }
        // 同步成功：新视频进入素材库，立刻允许分析。
        if (current.nextSyncAt) current = this.save({ nextRunAt: this.now().toISOString() })
      }
    }

    const dailyLeft = Math.max(0, limits.dailyModelCalls - current.budget.modelCalls)
    const runDue = forceAnalyze || isDue(current.nextRunAt, this.now())
    if (current.autoAnalyze && runDue && typeof this.runPipeline === 'function') {
      if (dailyLeft <= 0) {
        current = this.save({
          status: 'budget_wait', code: 'BUDGET_EXHAUSTED',
          nextRunAt: startOfNextLocalDay(now).toISOString(),
          nextAction: `今日模型调用已达上限 ${limits.dailyModelCalls} 次，已保存进度，等待下一天`,
        })
        return { budgetWait: true, state: current }
      }
      const pending = typeof this.pendingCount === 'function' ? safeInt(this.pendingCount(), 0) : null
      if (pending === 0) {
        // 队列为空时不空转：关闭下一轮时间，等新视频入库或下一次同步。
        current = this.save({ status: current.autoSync ? 'waiting' : 'completed', nextRunAt: null, nextAction: current.autoSync ? '等待下一次收藏夹同步' : '没有待处理任务' })
        return { done: true, state: current }
      }
      current = this.save({ status: 'running', code: null, lastError: '' })
      didWork = true
      const roundCalls = Math.min(limits.perRoundModelCalls, dailyLeft)
      let result
      try {
        result = await this.runPipeline({
          maxVideosPerRound: Math.min(limits.perRoundVideos, 20),
          maxAiCallsPerRound: roundCalls,
          maxCommentsPerVideo: limits.perVideoComments,
          taskLimits: { maxVideos: limits.perRoundVideos, maxAiCalls: roundCalls },
        })
      } catch (error) {
        result = { ok: false, status: 'blocked', code: 'PIPELINE_FAILED', message: error?.message || '自动分析失败', aiCalls: 0, tokens: 0, remaining: 1 }
      }
      current = this.recordPipeline(result || {}, this.now())
      this.logger(`自动分析：${current.lastRound?.status || ''} ${current.lastRound?.message || ''}`)
      if (current.status === 'blocked' || current.status === 'paused') return { stopped: true, reason: current.status, state: current }
    }

    if (!didWork) {
      // 没有到期任务：保持等待，不做无意义循环。
      const patch = {}
      if (current.status === 'running') patch.status = 'waiting'
      return { idle: true, state: Object.keys(patch).length ? this.save(patch) : current }
    }
    return { worked: true, state: this.state() }
  }

  start(intervalMs = 60 * 1000) {
    this.stopTimer()
    this.timer = setInterval(() => {
      this.tick().catch(error => this.logger(`调度检查失败：${error?.message || error}`))
    }, Math.max(10000, safeInt(intervalMs, 60000)))
    if (this.timer.unref) this.timer.unref()
    return this.timer
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // 供界面读取的摘要：包含预算剩余、下次时间、待处理数量。
  summary() {
    const state = this.ensureDay()
    const budget = state.budget
    const pending = typeof this.pendingCount === 'function' ? safeInt(this.pendingCount(), 0) : null
    const dailyLeft = Math.max(0, budget.limits.dailyModelCalls - budget.modelCalls)
    return {
      ...state,
      pending,
      dailyLeft,
      budget: { ...budget, dailyLeft },
      nextSyncLabel: state.nextSyncAt || null,
      nextRunLabel: state.nextRunAt || null,
    }
  }
}

module.exports = {
  DAY_MS, RETRY_DELAYS, HARD_STOP_CODES, TRANSIENT_CODES,
  localDayKey, startOfNextLocalDay, DiscoveryScheduler,
}
