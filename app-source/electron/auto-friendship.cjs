const { hasConfirmedSelfProfile } = require('./social-brain/self-profile.cjs')
const { getPublicInterestPersona } = require('./social-brain/disclosure-policy.cjs')
const { randomUUID } = require('node:crypto')
const { normalizePersona, profileUrl } = require('./friendship.cjs')
const { quietNow } = require('./social-brain/proactive-engine.cjs')

const MINUTE = 60000
const clean = (value, limit = 400) => String(value || '').trim().slice(0, limit)
const nameKey = value => clean(value, 100).replace(/[\s\u200b-\u200d\ufeff]/g, '')
const dayKey = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : '' }
const boundedInteger = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback
function normalizeAutoFriendshipConfig(value = {}) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const keywords = (Array.isArray(value.keywords) ? value.keywords : String(value.keywords || '').split(/[\n,，;；、]+/)).map(item => typeof item === 'string' ? clean(item, 80) : '').filter(Boolean)
  return { enabled: value.enabled === true, keywords: [...new Set(keywords)].slice(0, 20), dailyLimit: boundedInteger(value.dailyLimit ?? 3, 3, 1, 20), intervalMinutes: boundedInteger(value.intervalMinutes ?? 30, 30, 5, 1440), scanDailyLimit: boundedInteger(value.scanDailyLimit ?? 20, 20, 1, 100) }
}
function normalizedCandidate(value) {
  try {
    const url = profileUrl(value?.url), name = clean(value?.name, 100)
    if (!name || url.endsWith('/user/self')) return null
    return { url, name, summary: clean(value.summary, 600), keyword: clean(value.keyword, 80), followed: value.followed === true || value.alreadyFollowed === true }
  } catch { return null }
}
function stoppedError(reason, code = 'stopped') { return Object.assign(new Error(reason), { code, stopped: true }) }

// This controller only acts on public search results. A durable checkpoint is
// written before each remote mutation, so restarting cannot repeat a greeting.
class AutoFriendshipService {
  constructor({ douyin, friendship, storage, ai, accountId = '', clock = () => new Date(), contactEngine = null, poolCheck = null }) {
    this.douyin = douyin; this.friendship = friendship; this.storage = storage; this.ai = ai; this.accountId = accountId; this.clock = clock
    this.destroyed = false; this.running = false; this.timer = null; this.session = 0
    this.contactEngine = contactEngine
    // P2-15.1：关键词搜索出来的陌生人默认不能直接关注，必须先经过候选池审核。
    // 由 main 注入，保持本模块不直接依赖候选池存储。
    this.poolCheck = typeof poolCheck === 'function' ? poolCheck : null
    this.recover()
    if (this.contactEngine) this.migrateContactJobs()
  }
  migrateContactJobs() {
    const { CandidateManager } = require('./discovery/candidate-manager.cjs')
    const manager = new CandidateManager(this.storage)
    const states = { followed: 'FOLLOWED', greeted: 'WAITING_REPLY', sending: 'SEND_UNKNOWN', uncertain: 'SEND_UNKNOWN', following: 'FOLLOW_UNCERTAIN', follow_uncertain: 'FOLLOW_UNCERTAIN', failed: 'FAILED' }
    for (const job of this.autoState().jobs) {
      const value = normalizedCandidate(job)
      if (!value) continue
      manager.upsertUserSearch([value], { accountId: this.accountId, keyword: value.keyword || '历史用户搜索' })
      const candidate = manager.get().candidates.find(item => item.profileUrl === value.url)
      if (!candidate || candidate.contact?.legacyJobId || candidate.contact?.status !== 'not_started') continue
      const status = states[job.status] || 'REVIEW_PENDING'
      manager.patch(candidate.id, { status,
        review: { ...candidate.review, ...(status !== 'REVIEW_PENDING' ? { status: 'approved', approvedAt: job.createdAt || null } : {}) },
        contact: { ...candidate.contact, status, legacyJobId: job.id || value.url, followedAt: job.followedAt || null,
          openingSentAt: job.greetedAt || null, openingMessage: job.greetedAt ? job.openingText || '' : '',
          contactId: job.contactId || null, firstAttemptAt: job.followAttemptAt || job.lastAttemptAt || job.greetedAt || null,
          followAttemptAt: job.followAttemptAt || job.followedAt || null, openingAttemptAt: job.lastAttemptAt || job.greetedAt || null,
          openingStatus: job.greetedAt ? 'sent' : ['sending', 'uncertain'].includes(job.status) ? 'unknown' : 'not_started',
          reason: job.lastError || '', legacyOpeningText: job.openingText || '' } })
      manager.appendEvent(candidate.id, 'legacy_imported', { status, jobId: job.id || '' })
    }
  }
  automatic() { return normalizeAutoFriendshipConfig(this.storage.get().friendship?.automatic) }
  autoState() { const value = this.storage.get().friendship?.autoState || {}; return { ...value, jobs: Array.isArray(value.jobs) ? value.jobs.filter(job => job && typeof job === 'object') : [], candidates: Array.isArray(value.candidates) ? value.candidates : [] } }
  emit() { this.douyin.emitEvent?.('friendship_auto', { automatic: this.automatic(), autoState: this.autoState() }) }
  save(patch) {
    const state = this.storage.get(), current = state.friendship || {}
    this.storage.update({ friendship: { ...current, autoState: { ...this.autoState(), ...patch } } }); this.emit()
  }
  patchJob(url, patch) { this.save({ jobs: this.autoState().jobs.map(job => job.url === url ? { ...job, ...patch, updatedAt: new Date(this.clock()).toISOString() } : job) }) }
  recover() {
    const current = this.autoState()
    const jobs = current.jobs.map(job => job.status === 'sending' ? { ...job, status: 'uncertain', lastError: '上次打招呼中断，发送结果未确认，请检查抖音，不能自动重发' } : job.status === 'following' ? { ...job, status: 'follow_uncertain', lastError: '上次关注中断，关注结果未确认，请先检查抖音' } : job)
    if (JSON.stringify(jobs) !== JSON.stringify(current.jobs)) this.save({ jobs })
  }
  keywords(config = this.automatic()) { const state = this.storage.get(); return config.keywords.length ? config.keywords : normalizeAutoFriendshipConfig({ keywords: hasConfirmedSelfProfile(state.selfProfile) ? getPublicInterestPersona(state.selfProfile).interests : state.selfPersona?.interests }).keywords }
  prerequisite(config = this.automatic()) {
    const persona = normalizePersona(this.storage.get().selfPersona)
    if (!hasConfirmedSelfProfile(this.storage.get().selfProfile) && !persona.name && !persona.identity && !persona.interests) return '请先保存自己的人设，至少填写称呼、身份或兴趣'
    if (!this.keywords(config).length) return '请填写搜索兴趣关键词，或在本人画像中填写兴趣'
    if (!(typeof this.ai.hasProvider === 'function' ? this.ai.hasProvider() : this.storage.get().providers?.length)) return '请先配置可用的大模型'
    return ''
  }
  update(patch = {}) {
    if (this.destroyed) throw new Error('此账号的自动交友服务已关闭')
    const config = normalizeAutoFriendshipConfig({ ...this.automatic(), ...patch })
    if (config.enabled) { const error = this.prerequisite(config); if (error) throw new Error(error) }
    this.session++
    const state = this.storage.get(), current = state.friendship || {}
    const reset = patch.enabled === true ? { blockedReason: '', lastError: '', nextRunAt: null } : {}
    this.storage.update({ friendship: { ...current, automatic: config, autoState: { ...this.autoState(), ...reset } } }); this.emit()
    return { ok: true, automatic: config, autoState: this.autoState() }
  }
  gate(candidate, session) {
    if (this.destroyed || this.douyin._destroyed || this.friendship.destroyed) return { ok: false, code: 'destroyed', reason: '账号服务已停止' }
    if (session !== undefined && session !== this.session) return { ok: false, code: 'changed', reason: '自动交友设置已改变，已停止当前操作' }
    const state = this.storage.get(), config = this.automatic(), now = this.clock()
    if (!config.enabled) return { ok: false, code: 'disabled', reason: '自动交友已关闭' }
    if (this.autoState().blockedReason) return { ok: false, code: 'blocked', reason: this.autoState().blockedReason }
    if (state.automation?.paused) return { ok: false, code: 'paused', reason: '当前账号已暂停' }
    if (this.douyin.verificationActive) return { ok: false, code: 'verification', reason: '抖音需要安全验证', blocked: true }
    if (quietNow(state.settings || {}, now)) return { ok: false, code: 'quiet', reason: '当前为免打扰时段' }
    const prerequisite = this.prerequisite(config)
    if (prerequisite) return { ok: false, code: 'configuration', reason: prerequisite }
    if (candidate) {
      const key = nameKey(candidate.name)
      if ((state.automation?.blacklist || []).some(name => nameKey(name) === key)) return { ok: false, code: 'blacklist', reason: '该用户在黑名单中' }
      if ((state.automation?.aiDisabledContacts || []).some(name => nameKey(name) === key)) return { ok: false, code: 'ai_disabled', reason: '该用户的 AI 回复已关闭' }
      if ((state.contacts || []).some(c => nameKey(c.name) === key)) return { ok: false, code: 'known_contact', reason: '相同昵称已在联系人列表中，不能自动当成陌生人' }
      if ((state.sendHistory || []).some(record => nameKey(record.name) === key)) return { ok: false, code: 'already_chatted', reason: '已与相同昵称用户聊天，不能重复打招呼' }
      // P2-15.1：关注/打招呼属于真实动作，必须来自已入池并人工批准的候选人。
      if (this.poolCheck) {
        const pool = this.poolCheck(candidate)
        if (pool && pool.ok !== true) return { ok: false, code: pool.code || 'candidate_pool', reason: pool.reason || '该用户未通过候选池审计，不能自动关注' }
      }
    }
    const allowance = this.douyin.getSendAllowance?.(candidate?.name || '', new Date(now).getTime())
    if (!allowance?.ok) return { ok: false, code: 'quota', reason: allowance?.reason || '无法确认当前发送额度' }
    return { ok: true }
  }
  assertActive(candidate, session) { const gate = this.gate(candidate, session); if (!gate.ok) throw Object.assign(stoppedError(gate.reason, gate.code), { blocked: gate.blocked === true }); return true }
  eligible(candidates, { resume = false } = {}) {
    const state = this.storage.get(), jobs = this.autoState().jobs
    const unique = new Map()
    for (const value of candidates) { const candidate = normalizedCandidate(value); if (candidate && !unique.has(candidate.url)) unique.set(candidate.url, candidate) }
    const normalized = [...unique.values()], counts = new Map()
    for (const candidate of normalized) counts.set(nameKey(candidate.name), (counts.get(nameKey(candidate.name)) || 0) + 1)
    const seen = new Set()
    return normalized.filter(candidate => {
      if (seen.has(candidate.url) || candidate.followed || counts.get(nameKey(candidate.name)) !== 1) return false
      seen.add(candidate.url)
      if (!resume && jobs.some(job => job.url === candidate.url || nameKey(job.name) === nameKey(candidate.name))) return false
      if (!resume && (state.friendship?.followed || []).some(item => item.url === candidate.url || nameKey(item.name) === nameKey(candidate.name))) return false
      return this.gate(candidate).ok
    })
  }
  restoreCandidate(candidate) {
    // Only persisted, validated search results or a durable job can reach here.
    if (!(this.friendship.candidates instanceof Map)) throw new Error('交友候选缓存不可用')
    const actual = this.friendship.candidates.get(candidate.url)
    if (actual && nameKey(actual.name) !== nameKey(candidate.name)) throw new Error('候选用户身份已改变，请重新搜索')
    this.friendship.candidates.set(candidate.url, { ...candidate })
  }
  dailyUsage(now = this.clock()) {
    const day = dayKey(now)
    return this.autoState().jobs.filter(job => [job.followAttemptAt, job.lastAttemptAt, job.greetedAt].some(at => at && dayKey(at) === day)).length
  }
  async discover(session, now) {
    const config = this.automatic(), day = dayKey(now), current = this.autoState()
    let cached = current.candidatesDay === day ? this.eligible(current.candidates) : []
    if (cached.length) return cached
    const scanned = current.scanDay === day ? Number(current.dailyScans) || 0 : 0
    if (scanned >= config.scanDailyLimit) return []
    const keywords = this.keywords(config), index = (Number(current.keywordIndex) || 0) % keywords.length, keyword = keywords[index]
    this.assertActive(null, session)
    // Reserve a search round before awaiting navigation, including interrupted searches.
    this.save({ scanDay: day, dailyScans: scanned + 1, keywordIndex: index + 1 })
    const result = await this.friendship.search(keyword, { background: true, beforeAction: () => this.assertActive(null, session) })
    this.assertActive(null, session)
    if (!result?.ok || !Array.isArray(result.candidates)) throw new Error(result?.error || '搜索陌生人失败')
    const remaining = config.scanDailyLimit - scanned
    const candidates = result.candidates.slice(0, remaining).map(normalizedCandidate).filter(Boolean)
    for (const candidate of candidates) {
      const actual = this.friendship.candidates?.get(candidate.url)
      if (!actual || nameKey(actual.name) !== nameKey(candidate.name)) throw new Error('搜索结果与真实候选缓存不一致，已停止自动选择')
    }
    this.save({ candidates, candidatesDay: day, dailyScans: scanned + Math.max(1, Math.min(result.candidates.length, remaining)), keyword })
    cached = this.eligible(candidates)
    return cached
  }
  async process(candidate, session, existingJob) {
    const url = candidate.url
    this.restoreCandidate(candidate); this.assertActive(candidate, session)
    if (!existingJob) {
      this.save({ jobs: [...this.autoState().jobs, { id: randomUUID(), accountId: this.accountId, ...candidate, status: 'selected', createdAt: new Date(this.clock()).toISOString(), lastAttemptAt: null, openingText: '', followedAt: null, greetedAt: null, lastError: '' }] })
    }
    let job = this.autoState().jobs.find(item => item.url === url)
    try {
      if (!job.openingText) {
        const opening = await this.friendship.opening(url)
        this.assertActive(candidate, session)
        const openingText = clean(opening?.text, 1000)
        if (!opening?.ok || !openingText || openingText.length > 80) throw new Error(opening?.error || '首次打招呼内容无效，已停止关注')
        this.patchJob(url, { status: 'opening_ready', openingText, model: opening.model, provider: opening.provider })
        job = this.autoState().jobs.find(item => item.url === url)
      }
      if (!job.followedAt) {
        this.assertActive(candidate, session)
        if (this.dailyUsage() >= this.automatic().dailyLimit) throw stoppedError('今天自动结识人数已达上限', 'daily_limit')
        const at = new Date(this.clock()).toISOString()
        this.patchJob(url, { status: 'following', followAttemptAt: at, lastAttemptAt: at })
        const followed = await this.friendship.follow(url, { background: true, beforeAction: () => this.assertActive(candidate, session) })
        if (!followed?.ok) throw Object.assign(new Error(followed?.error || '关注未确认成功'), { followAttempted: followed?.followAttempted === true })
        const verifiedName = clean(followed.name || followed.candidate?.name || candidate.name, 100)
        if (nameKey(verifiedName) !== nameKey(candidate.name)) throw Object.assign(new Error('关注时昵称已改变，停止自动打招呼'), { followAttempted: true })
        if (followed.alreadyFollowed) { this.patchJob(url, { status: 'skipped', followedAt: new Date(this.clock()).toISOString(), lastError: '对方已经关注，跳过陌生人开场' }); return { ok: true, skipped: true } }
        this.patchJob(url, { status: 'followed', followedAt: new Date(this.clock()).toISOString() })
        this.assertActive(candidate, session)
      }
      this.assertActive(candidate, session)
      job = this.autoState().jobs.find(item => item.url === url)
      const today = dayKey(this.clock())
      const alreadyCounted = [job.followAttemptAt, job.lastAttemptAt, job.greetedAt].some(at => at && dayKey(at) === today)
      if (!alreadyCounted && this.dailyUsage() >= this.automatic().dailyLimit) throw stoppedError('今天自动结识人数已达上限', 'daily_limit')
      this.patchJob(url, { status: 'sending', greetingAttempts: (Number(job.greetingAttempts) || 0) + 1, lastAttemptAt: new Date(this.clock()).toISOString() })
      const sent = await this.friendship.greeting(url, job.openingText, { background: true, model: job.model, provider: job.provider, beforeSubmit: () => this.assertActive(candidate, session) })
      if (!sent?.ok) throw Object.assign(new Error(sent?.error || '首次私信发送失败'), { sendAttempted: sent?.sendAttempted === true || sent?.uncertain === true })
      // Persist remote confirmation even if the user switched off during confirmation.
      this.patchJob(url, { status: 'greeted', greetedAt: new Date(this.clock()).toISOString(), contactId: sent.contactId || null, lastError: '' })
      this.douyin.log?.('auto_friend_greeted', `自动交友：已关注并向 ${candidate.name} 打招呼`, { url })
      return { ok: true, greeted: true, name: candidate.name }
    } catch (error) {
      job = this.autoState().jobs.find(item => item.url === url)
      let status = job.status
      if (status === 'sending') status = error.sendAttempted === true || error.uncertain === true ? 'uncertain' : error.stopped ? 'followed' : 'failed'
      else if (status === 'following') status = error.followAttempted === true || !error.stopped ? 'follow_uncertain' : 'opening_ready'
      else if (!error.stopped) status = 'failed'
      this.patchJob(url, { status, lastError: clean(error.message, 300) })
      throw error
    }
  }
  async runOnce() {
    if (this.contactEngine) return this.runSharedDiscovery()
    if (this.running || this.destroyed) return { ok: true, skipped: true }
    const initialGate = this.gate(), now = this.clock()
    if (!initialGate.ok) {
      if (initialGate.blocked) this.save({ blockedReason: initialGate.reason, lastError: initialGate.reason })
      return { ok: true, skipped: true, reason: initialGate.reason }
    }
    const config = this.automatic(), current = this.autoState()
    if (Date.parse(current.nextRunAt) > new Date(now).getTime()) return { ok: true, skipped: true, reason: '尚未到下一轮自动交友时间' }
    this.running = true; const session = this.session
    try {
      this.save({ lastRunAt: new Date(now).toISOString(), nextRunAt: new Date(new Date(now).getTime() + config.intervalMinutes * MINUTE).toISOString(), lastError: '' })
      const resumable = this.autoState().jobs.find(job => ['selected', 'opening_ready', 'followed'].includes(job.status))
      if (resumable) {
        const candidate = normalizedCandidate(resumable)
        if (!candidate || !this.gate(candidate, session).ok) { this.patchJob(resumable.url, { status: 'skipped', lastError: '联系人状态已改变，停止首次打招呼' }); return { ok: true, skipped: true } }
        return await this.process(candidate, session, resumable)
      }
      if (this.dailyUsage(now) >= config.dailyLimit) return { ok: true, skipped: true, reason: '今天自动结识人数已达上限' }
      const candidates = await this.discover(session, now)
      this.assertActive(null, session)
      if (!candidates.length) return { ok: true, skipped: true, reason: '当前没有可自动结识的陌生人，或今日搜索额度已用完' }
      const keyword = this.autoState().keyword || candidates[0].keyword
      const state = this.storage.get()
      const picked = await this.ai.pickFriendCandidate({ persona: hasConfirmedSelfProfile(state.selfProfile) ? getPublicInterestPersona(state.selfProfile) : normalizePersona(state.selfPersona), candidates, keyword })
      this.assertActive(null, session)
      if (!picked?.ok) throw new Error(picked?.error || 'AI 选择候选人失败')
      if (picked.index === null || picked.index === -1 || picked.skipped === true) {
        const reason = clean(picked.reason, 300) || 'AI 判断当前候选人不合适'
        this.save({ candidates: [], lastSelectionReason: reason })
        return { ok: true, skipped: true, reason }
      }
      if (!Number.isInteger(picked.index) || picked.index < 0 || picked.index >= candidates.length) throw new Error('AI 返回了无效候选编号，未关注任何用户')
      const candidate = candidates[picked.index]
      const actual = this.friendship.candidates?.get(candidate.url)
      if (actual && nameKey(actual.name) !== nameKey(candidate.name)) throw new Error('候选用户身份已改变，停止自动交友')
      return await this.process(candidate, session)
    } catch (error) {
      const blocked = error.blocked === true || ['challenge', 'verification', 'login_required'].includes(error.code)
      this.save({ lastError: clean(error.message, 300), ...(blocked ? { blockedReason: clean(error.message, 300) } : {}) })
      this.douyin.log?.('auto_friend_error', '自动交友本轮已停止', { error: error.message, code: error.code, blocked })
      return { ok: false, error: error.message, blocked }
    } finally { this.running = false }
  }
  async runSharedDiscovery() {
    if (this.running || this.destroyed || this.contactEngine.destroyed) return { ok: true, skipped: true, reason: '候选发现正在操作或联系服务已停止' }
    const config = this.automatic(), state = this.storage.get(), now = this.clock()
    if (!config.enabled || state.automation?.paused || quietNow(state.settings || {}, now)) return { ok: true, skipped: true, reason: '自动用户搜索未开启、账号暂停或处于免打扰时段' }
    if (this.douyin.verificationActive || this.autoState().blockedReason) return { ok: true, skipped: true, reason: this.autoState().blockedReason || '抖音需要安全验证' }
    if (Date.parse(this.autoState().nextRunAt) > new Date(now).getTime()) return { ok: true, skipped: true, reason: '尚未到下一轮用户搜索时间' }
    const prerequisite = this.prerequisite(config)
    if (prerequisite) return { ok: false, error: prerequisite }
    const day = dayKey(now), current = this.autoState(), scanned = current.scanDay === day ? Number(current.dailyScans) || 0 : 0
    if (scanned >= config.scanDailyLimit) return { ok: true, skipped: true, reason: '今日候选搜索额度已用完' }
    const keywords = this.keywords(config), index = (Number(current.keywordIndex) || 0) % keywords.length
    const keyword = keywords[index], session = this.session, contactEngine = this.contactEngine
    const assertCurrent = () => {
      if (this.destroyed || session !== this.session || contactEngine.destroyed || contactEngine !== this.contactEngine || !this.automatic().enabled || this.storage.get().automation?.paused || this.douyin.verificationActive) throw stoppedError('自动用户搜索已停止')
    }
    this.running = true
    try {
      this.save({ scanDay: day, dailyScans: scanned + 1, keywordIndex: index + 1, keyword, lastRunAt: new Date(now).toISOString(), nextRunAt: new Date(new Date(now).getTime() + config.intervalMinutes * MINUTE).toISOString() })
      const result = await this.friendship.search(keyword, { background: true, beforeAction: assertCurrent })
      assertCurrent()
      if (!result?.ok || !Array.isArray(result.candidates)) throw new Error(result?.error || '搜索用户失败')
      for (const value of result.candidates) {
        const normalized = normalizedCandidate(value), actual = normalized && this.friendship.candidates.get(normalized.url)
        if (!actual || nameKey(actual.name) !== nameKey(normalized.name)) throw new Error('搜索结果身份未能与真实页面缓存对应')
      }
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const imported = new CandidateManager(this.storage).upsertUserSearch(result.candidates, { accountId: this.accountId, keyword })
      contactEngine.refresh()
      this.save({ candidates: [], lastError: '', lastSelectionReason: '用户搜索结果已进入统一候选池，关注与首句由联系队列处理' })
      return { ok: true, discovered: imported.added, merged: imported.merged, discovery: imported.discovery }
    } catch (error) {
      const blocked = error.blocked === true || ['challenge', 'verification', 'login_required'].includes(error.code)
      this.save({ lastError: clean(error.message, 300), ...(blocked ? { blockedReason: clean(error.message, 300) } : {}) })
      return { ok: false, error: error.message, blocked }
    } finally { this.running = false }
  }
  start() { if (this.destroyed || this.timer) return; this.timer = setInterval(() => { this.runOnce().catch(error => this.douyin.log?.('auto_friend_error', '自动交友检查失败', { error: error.message })) }, MINUTE); this.timer.unref?.() }
  destroy() { this.destroyed = true; this.session++; clearInterval(this.timer); this.timer = null }
}
module.exports = { AutoFriendshipService, normalizeAutoFriendshipConfig }
