const { hasConfirmedSelfProfile } = require('./social-brain/self-profile.cjs')
const { getPublicInterestPersona } = require('./social-brain/disclosure-policy.cjs')
const { CandidateManager, canonicalProfile, normalizeDiscovery } = require('./discovery/candidate-manager.cjs')
const { evaluateCandidate } = require('./discovery/candidate-brain.cjs')
const { quietNow } = require('./social-brain/proactive-engine.cjs')

const MINUTE = 60000
const clean = (v, limit = 300) => typeof v === 'string' ? v.trim().slice(0, limit) : ''
const plain = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const bounded = (v, fallback, min, max) => v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : fallback
const nameKey = v => clean(v, 100).replace(/[\s\u200b-\u200d\ufeff]/g, '')
const dayKey = at => { const d = new Date(at); return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : '' }
const UNSAFE = new Set(['FOLLOW_UNCERTAIN', 'SEND_UNKNOWN', 'MESSAGE_UNCERTAIN', 'OPENING_SENDING', 'FOLLOWING'])
const DELIVERED = new Set(['OPENING_SENT', 'WAITING_REPLY', 'REPLIED', 'CONTACT', 'ACTIVE'])
const RETRYABLE = new Set(['FAILED', 'FOLLOW_FAILED', 'MESSAGE_FAILED', 'FOLLOWED', 'CONTACT_QUEUED'])
const stop = (reason, code = 'stopped') => Object.assign(new Error(reason), { code, stopped: true, sendAttempted: false, followAttempted: false })

function normalizeContactConfig(value = {}) {
  value = plain(value)
  const templates = plain(value.templates)
  return { enabled: value.enabled === true, mode: ['automatic', 'auto'].includes(value.mode) ? 'automatic' : 'review',
    dailyLimit: bounded(value.dailyLimit, 3, 1, 20), intervalMinutes: bounded(value.intervalMinutes, 30, 5, 1440),
    waitlistCheckMinutes: bounded(value.waitlistCheckMinutes, 60, 10, 1440),
    templates: Object.fromEntries(['graduate', 'dating', 'social', 'interest', 'default'].map(k => [k, clean(templates[k], 80)])),
    autoScoreThreshold: bounded(value.autoScoreThreshold, 70, 0, 100) }
}

function templateFor(candidate, config) {
  const sources = candidate.sources || [candidate.source || {}]
  const value = sources.map(s => `${s.topic || ''} ${s.keyword || ''}`).join(' ')
  const signals = candidate.brain?.signals || candidate.signals || []
  const evidence = `${value} ${signals.map(s => typeof s === 'string' ? s : s?.label || s?.name || '').join(' ')}`
  const key = /graduate|研究生|研[一二三]|硕士|博士/i.test(evidence) ? 'graduate'
    : /dating|恋爱|脱单|找对象/i.test(evidence) ? 'dating'
      : /social|交友|认识新朋友/i.test(evidence) ? 'social' : /interest|共同兴趣|兴趣重合/i.test(evidence) ? 'interest' : 'default'
  const text = clean(config.templates[key]) || clean(config.templates.default)
  return { key: config.templates[key] ? key : 'default', text }
}

// Both discovery paths use the same durable candidate ledger. A checkpoint is
// saved before every remote mutation; unconfirmed submissions are never retried.
class ContactEngine {
  constructor({ douyin, friendship, storage, accountId = '', clock = () => new Date(), inspectCandidate }) {
    this.douyin = douyin; this.friendship = friendship; this.storage = storage; this.accountId = accountId
    this.clock = clock; this.inspectCandidate = inspectCandidate; this.manager = new CandidateManager(storage)
    this.running = false; this.destroyed = false; this.generation = 0; this.timer = null; this.locks = new Set()
    this.recover()
  }
  config() { return normalizeContactConfig(this.storage.get().friendship?.contactConfig) }
  get session() { return this.generation }
  control() { return plain(this.storage.get().friendship?.contactState) }
  now() { return new Date(this.clock()) }
  at() { return this.now().toISOString() }
  candidate(id) { const c = this.manager.get().candidates.find(c => c.id === id); if (!c) throw new Error('找不到此候选人，请刷新候选池'); return c }
  // A request-scoped read view, never retained across remote actions or requests.
  readContext() {
    const state = this.storage.get()
    return { state, discovery: normalizeDiscovery(state.discovery), now: this.now(),
      config: normalizeContactConfig(state.friendship?.contactConfig), control: plain(state.friendship?.contactState),
      persona: hasConfirmedSelfProfile(state.selfProfile) ? getPublicInterestPersona(state.selfProfile) : state.selfPersona || {} }
  }
  state() {
    const context = this.readContext()
    return { config: context.config, discovery: context.discovery, metrics: this.metrics(context), running: this.running,
      paused: context.control.paused === true, contactState: context.control }
  }
  refresh() {
    if (this.destroyed) throw new Error('此账号的联系服务已关闭')
    this.reconcileReplies()
    const context = this.readContext()
    let changed = false
    for (const candidate of context.discovery.candidates) {
      if (candidate.accountId !== this.accountId || DELIVERED.has(candidate.status) || UNSAFE.has(candidate.status)) continue
      const brain = this.evaluate(candidate, context)
      if (JSON.stringify(brain) !== JSON.stringify(candidate.brain)) {
        candidate.brain = brain; candidate.updatedAt = new Date().toISOString(); changed = true
      }
    }
    // Only derived brains changed; one synchronous write keeps all action ledgers intact.
    if (changed) this.manager.save(context.discovery)
    const snapshot = this.state(); this.emit(snapshot); return { ok: true, ...snapshot }
  }
  emit(snapshot) { this.douyin.emitEvent?.('contact_progress', snapshot || this.state()) }
  requestConversationSync(candidate, reason, { contact, at, messageId } = {}) {
    if (typeof this.douyin.requestConversationSync !== 'function') return
    const linked = contact || this.linkedContact(candidate)
    const eventAt = at || candidate.contact?.[reason === 'follow_confirmed' ? 'followedAt' : 'openingSentAt'] || this.at()
    const payload = { accountId: this.accountId, candidateId: candidate.id, name: linked?.name || candidate.nickname,
      platformUserId: candidate.platformUserId, reason, eventKey: `${candidate.id}:${reason}:${eventAt}:${messageId || ''}`,
      ...(linked?.id || candidate.contact?.contactId ? { contactId: linked?.id || candidate.contact.contactId } : {}) }
    // Queue local work only. A queue failure must not change a confirmed remote
    // checkpoint or prevent the normal handoff; surface it in the runtime log.
    const failed = error => this.douyin.log?.('conversation_sync_error', '定向会话同步请求失败', { reason, candidateId: candidate.id, error: error.message })
    try {
      Promise.resolve(this.douyin.requestConversationSync(payload)).then(result => {
        if (result?.ok === false) failed(new Error(result.error || result.reason || '会话同步请求未入队'))
      }).catch(failed)
    } catch (error) { failed(error) }
  }
  saveControl(patch) {
    const friendship = this.storage.get().friendship || {}
    this.storage.update({ friendship: { ...friendship, contactState: { ...plain(friendship.contactState), ...patch } } })
  }
  patch(id, patch, event) {
    const current = this.candidate(id)
    const contact = { ...current.contact, ...plain(patch.contact), ...(patch.status ? { status: patch.status } : {}) }
    this.manager.patch(id, { ...patch, contact, updatedAt: this.at() })
    if (event) this.manager.appendEvent(id, event, { status: patch.status || current.status, reason: contact.reason || '' })
    this.emit(); return this.candidate(id)
  }
  recover() {
    for (const c of this.manager.get().candidates) {
      if (c.accountId !== this.accountId) continue
      if (c.status === 'FOLLOWING') this.patch(c.id, { status: 'FOLLOW_UNCERTAIN', contact: { reason: '上次关注过程被中断，结果未确认；请人工核对，禁止自动重试' } }, 'follow_interrupted')
      if (c.status === 'OPENING_SENDING') this.patch(c.id, { status: 'SEND_UNKNOWN', contact: { reason: '上次首句发送过程被中断，投递结果未确认；请人工核对，禁止自动重发' } }, 'opening_interrupted')
    }
  }
  update(patch = {}) {
    if (this.destroyed) throw new Error('此账号的联系服务已关闭')
    patch = plain(patch)
    if (patch.templates !== undefined) {
      if (Object.values(plain(patch.templates)).some(v => typeof v !== 'string' || v.trim().length > 80)) throw new Error('首次打招呼模板须为80字以内的手动文本')
    }
    const current = this.config(), config = normalizeContactConfig({ ...current, ...patch, templates: { ...current.templates, ...plain(patch.templates) } })
    this.generation++
    const friendship = this.storage.get().friendship || {}
    this.storage.update({ friendship: { ...friendship, contactConfig: config } }); this.emit()
    return { ok: true, ...this.state() }
  }
  pause(id) {
    if (this.destroyed) throw new Error('此账号的联系服务已关闭')
    if (id) {
      const candidate = this.candidate(id)
      if (DELIVERED.has(candidate.status) || UNSAFE.has(candidate.status) && !this.locks.has(id)) throw new Error('已投递或结果不明的候选不能通过暂停重置')
      if (candidate.status === 'PAUSED') return { ok: true, candidate, ...this.state() }
      if (this.locks.has(id)) {
        this.generation++
        this.patch(id, { contact: { pauseRequested: true, reason: '已请求暂停；正在确认已提交的操作' } }, 'pause_requested')
      } else this.patch(id, { status: 'PAUSED', contact: { resumeStatus: candidate.status, reason: '此候选联系流程已暂停' } }, 'candidate_paused')
    } else { this.generation++; this.saveControl({ paused: true, reason: '联系队列已暂停' }); this.emit() }
    return { ok: true, ...this.state() }
  }
  resume(id) {
    if (this.destroyed) throw new Error('此账号的联系服务已关闭')
    if (id) {
      const candidate = this.candidate(id), status = candidate.contact?.resumeStatus
      if (candidate.status !== 'PAUSED' || !status || UNSAFE.has(status) || DELIVERED.has(status)) throw new Error('此候选不能安全恢复；未知投递结果不能再次提交')
      this.patch(id, { status, contact: { pauseRequested: false, resumeStatus: null, reason: '' } }, 'candidate_resumed')
      return { ok: true, candidate: this.candidate(id), ...this.state() }
    }
    this.generation++; this.saveControl({ paused: false, reason: '', blockedReason: '' }); this.emit(); return { ok: true, ...this.state() }
  }
  evaluate(candidate, context = this.readContext()) {
    const state = context.state, ownFollow = Boolean(candidate.contact?.followedAt)
    // The service calls its guard again immediately before submitting. Only our
    // current locked checkpoint may bypass its own in-flight duplicate marker.
    const current = this.locks.has(candidate.id) && candidate.status === 'OPENING_SENDING' && !candidate.contact?.openingSentAt
      ? { ...candidate, status: 'FOLLOWED', contact: { ...candidate.contact, openingStatus: 'not_started' } } : candidate
    const evaluation = evaluateCandidate(current, { config: context.discovery.config, persona: context.persona, contacts: state.contacts || [],
      sendHistory: state.sendHistory || [], blacklist: state.automation?.blacklist || [], aiDisabledContacts: state.automation?.aiDisabledContacts || [],
      followed: ownFollow ? (state.friendship?.followed || []).filter(f => (f.url || f.profileUrl) !== candidate.profileUrl) : state.friendship?.followed || [], now: context.now })
    return evaluation
  }
  hard(candidate, context) {
    const identity = canonicalProfile(candidate.profileUrl)
    if (!identity || identity.platformUserId !== candidate.platformUserId || candidate.accountId !== this.accountId) return { ok: false, code: 'identity', reason: '候选用户 ID 或所属账号未核验' }
    if (candidate.intentPoolOnly === true && candidate.batchScreening?.status !== 'qualified') return { ok: false, code: 'batch_screening', reason: '尚未通过硬性筛选，请先核实资料并筛选' }
    const evaluation = this.evaluate(candidate, context)
    if (!evaluation.hardGate?.passed) return { ok: false, code: 'hard_gate', reason: evaluation.hardGate?.reason || evaluation.hardGate?.reasons?.join('；') || evaluation.unknowns?.join('；') || '候选硬条件尚未全部通过', evaluation }
    return { ok: true, evaluation }
  }
  enqueue(id, { automatic = false } = {}) {
    if (this.destroyed) throw new Error('此账号的联系服务已关闭')
    const candidate = this.candidate(id), config = this.config()
    if (UNSAFE.has(candidate.status) || DELIVERED.has(candidate.status) || candidate.contact?.openingSentAt || candidate.contact?.openingStatus === 'sent') throw new Error('此候选已经联系或投递结果不明，不能重复入队')
    if (candidate.status === 'CONTACT_QUEUED') return { ok: true, candidate, ...this.state() }
    if (!['APPROVED', 'APPROVED_PENDING_CONTACT', 'REVIEW_PENDING', 'DISCOVERED'].includes(candidate.status)) throw new Error('候选状态不能加入联系队列，请先审核或明确安全重试')
    const gate = this.hard(candidate)
    if (!gate.ok) throw new Error(gate.reason)
    if (automatic) {
      if (!config.enabled || config.mode !== 'automatic' || this.control().paused) throw new Error('自动批准需要已开启的自动联系模式')
      if (!['APPROVED', 'APPROVED_PENDING_CONTACT', 'REVIEW_PENDING', 'DISCOVERED'].includes(candidate.status) || gate.evaluation.score < config.autoScoreThreshold) throw new Error('此候选尚未达到自动联系分数')
    } else if (!['APPROVED', 'APPROVED_PENDING_CONTACT'].includes(candidate.status) || candidate.review?.status !== 'approved') throw new Error('请先批准此候选人再加入联系队列')
    const template = templateFor({ ...candidate, brain: gate.evaluation }, config)
    if (!template.text) throw new Error('请先手动填写该来源的首句模板或默认首句，程序不会临时生成开场白')
    const at = this.at()
    const next = this.patch(id, { status: 'CONTACT_QUEUED', brain: gate.evaluation,
      review: automatic ? { ...candidate.review, status: 'approved', approvedAt: candidate.review?.approvedAt || at, approvalMode: 'auto' } : candidate.review,
      contact: { reason: '', queuedAt: at, automatic, openingTemplate: template.key, openingMessage: template.text } }, automatic ? 'automatically_queued' : 'contact_queued')
    return { ok: true, candidate: next, ...this.state() }
  }
  usage(now = this.now()) {
    const day = dayKey(now)
    return this.manager.get().candidates.filter(c => c.accountId === this.accountId && [c.contact?.followAttemptAt, c.contact?.openingAttemptAt, c.contact?.openingSentAt].some(at => at && dayKey(at) === day)).length
  }
  gate(candidate, generation, { beforeMutation = false, interval = false } = {}) {
    if (this.destroyed || this.douyin._destroyed || this.friendship.destroyed) return { ok: false, code: 'destroyed', reason: '账号服务已停止' }
    if (generation !== undefined && generation !== this.generation) return { ok: false, code: 'changed', reason: '联系设置已改变，已停止当前操作' }
    const state = this.storage.get(), config = this.config(), control = this.control()
    if (!config.enabled) return { ok: false, code: 'disabled', reason: '联系队列开关已关闭' }
    if (control.paused || state.automation?.paused) return { ok: false, code: 'paused', reason: '当前账号或联系队列已暂停' }
    if (control.blockedReason || this.douyin.verificationActive) return { ok: false, code: 'verification', reason: control.blockedReason || '抖音需要安全验证' }
    if (quietNow(state.settings || {}, this.now())) return { ok: false, code: 'quiet', reason: '当前为免打扰时段' }
    if (interval && Date.parse(control.lastContactAttemptAt) + config.intervalMinutes * MINUTE > this.now().getTime()) return { ok: false, code: 'interval', reason: '尚未到下一次联系时间' }
    if (candidate) {
      const hard = this.hard(candidate); if (!hard.ok) return hard
      const key = nameKey(candidate.nickname)
      if ((state.automation?.blacklist || []).some(v => nameKey(v) === key)) return { ok: false, code: 'blacklist', reason: '该用户在黑名单中' }
      if ((state.automation?.aiDisabledContacts || []).some(v => nameKey(v) === key)) return { ok: false, code: 'ai_disabled', reason: '该用户的 AI 已关闭' }
      if (candidate.contact?.automatic && (config.mode !== 'automatic' || hard.evaluation.score < config.autoScoreThreshold)) return { ok: false, code: 'mode', reason: '自动联系模式或候选评分已改变，请重新审核' }
      if (candidate.review?.status !== 'approved') return { ok: false, code: 'review', reason: '候选人尚未批准' }
    }
    if (beforeMutation) {
      const at = candidate?.contact || {}, counted = [at.followAttemptAt, at.openingAttemptAt, at.openingSentAt].some(at => at && dayKey(at) === dayKey(this.now()))
      if (!counted && this.usage() >= config.dailyLimit) return { ok: false, code: 'daily_limit', reason: '今天结识人数已达联系队列上限' }
      const allowance = this.douyin.getSendAllowance?.(candidate?.nickname || '', this.now().getTime())
      if (!allowance?.ok) return { ok: false, code: 'quota', reason: allowance?.reason || '无法确认账号发送额度' }
      const persona = plain(state.selfPersona)
      if (!hasConfirmedSelfProfile(state.selfProfile) && ![persona.name, persona.identity, persona.interests].some(v => clean(v))) return { ok: false, code: 'persona', reason: '请先填写并保存本人的称呼、身份或兴趣' }
      if (!candidate?.contact?.openingMessage?.trim()) return { ok: false, code: 'template', reason: '请先手动填写首句模板' }
    }
    return { ok: true }
  }
  assert(candidate, generation, options) { const result = this.gate(candidate, generation, options); if (!result.ok) throw stop(result.reason, result.code) }
  restore(candidate) {
    if (!(this.friendship.candidates instanceof Map)) throw new Error('交友候选缓存不可用')
    const cached = this.friendship.candidates.get(candidate.profileUrl)
    if (cached && nameKey(cached.name) !== nameKey(candidate.nickname)) throw stop('缓存候选昵称已改变，请重新核验身份', 'identity')
    this.friendship.candidates.set(candidate.profileUrl, { url: candidate.profileUrl, name: candidate.nickname, platformUserId: candidate.platformUserId, candidateId: candidate.id,
      summary: clean(candidate.profileSummary || candidate.publicSignals?.bio || candidate.summary, 800), keyword: candidate.source?.keyword || '' })
  }
  async refreshCandidate(id, generation) {
    let candidate = this.candidate(id)
    this.assert(null, generation)
    const identity = canonicalProfile(candidate.profileUrl)
    if (!identity || identity.platformUserId !== candidate.platformUserId || candidate.accountId !== this.accountId) throw stop('候选用户 ID 或所属账号未核验', 'identity')
    if (this.inspectCandidate) {
      await this.inspectCandidate(candidate)
      candidate = this.candidate(id); this.assert(null, generation)
    }
    const hard = this.hard(candidate)
    if (!hard.ok) throw stop(hard.reason, hard.code)
    this.patch(id, { brain: hard.evaluation }, 'candidate_rechecked')
    return this.candidate(id)
  }
  async probe(candidate, generation) {
    if (typeof this.friendship.probeContact !== 'function') return null
    this.restore(candidate)
    const result = await this.friendship.probeContact(candidate.profileUrl, { background: true, beforeAction: () => this.assert(this.candidate(candidate.id), generation) })
    this.assert(this.candidate(candidate.id), generation)
    if (!result?.ok || result.identityVerified !== true || result.platformUserId !== candidate.platformUserId) throw stop('主页或私信对象 ID 未通过核验', 'identity')
    return result
  }
  defer(id, status, reason) {
    return this.patch(id, { status, contact: { reason, nextCheckAt: new Date(this.now().getTime() + this.config().waitlistCheckMinutes * MINUTE).toISOString() } }, status === 'FOLLOW_PENDING' ? 'follow_pending' : 'contact_waitlisted')
  }
  async checkWaiting(candidate, generation) {
    this.assert(candidate, generation)
    const probe = await this.probe(candidate, generation)
    if (!probe) return { ok: true, skipped: true, reason: '暂不支持可靠的只读权限核验，等待人工检查' }
    if (candidate.status === 'FOLLOW_PENDING' && !probe.followed) {
      this.defer(candidate.id, 'FOLLOW_PENDING', probe.reason || '关注尚未明确成功，继续等待'); return { ok: true, pending: true }
    }
    if (probe.followed && !candidate.contact?.followedAt) {
      candidate = this.patch(candidate.id, { contact: { followedAt: this.at(), followStatus: 'followed' } }, 'follow_confirmed')
      this.requestConversationSync(candidate, 'follow_confirmed')
    }
    if (probe.dmAvailable !== true) {
      this.defer(candidate.id, 'CONTACT_WAITLIST', probe.reason || '私信权限尚未明确可用，继续等待'); return { ok: true, waitlisted: true }
    }
    this.patch(candidate.id, { status: 'FOLLOWED', contact: { followedAt: candidate.contact?.followedAt || this.at(), followStatus: 'followed', nextCheckAt: null, reason: '' } }, 'waitlist_ready')
    return { ok: true, ready: true }
  }
  async process(id, generation) {
    let candidate = this.candidate(id)
    if (this.locks.has(id)) return { ok: true, skipped: true }
    this.locks.add(id)
    try {
      candidate = await this.refreshCandidate(id, generation)
      this.restore(candidate)
      this.assert(candidate, generation, { beforeMutation: true, interval: true })
      if (!candidate.contact?.followedAt) {
        // Commit before entering the follow service. A crash after this point is
        // uncertain, even if the process never got as far as clicking the button.
        this.saveControl({ lastContactAttemptAt: this.at() })
        candidate = this.patch(id, { status: 'FOLLOWING', contact: { followAttemptAt: this.at(), followStatus: 'following', reason: '' } }, 'follow_started')
        const result = await this.friendship.follow(candidate.profileUrl, { background: true, beforeAction: () => this.assert(this.candidate(id), generation, { beforeMutation: true }) })
        if (!result?.ok) throw Object.assign(new Error(result?.error || '关注结果未确认'), { followAttempted: result?.followAttempted !== false })
        if (result.pending || result.followPending) { this.defer(id, 'FOLLOW_PENDING', result.reason || '关注请求已提交，等待确认'); return { ok: true, pending: true } }
        const confirmedName = result.name || result.candidate?.name
        if ((confirmedName && nameKey(confirmedName) !== nameKey(candidate.nickname)) || (result.platformUserId && result.platformUserId !== candidate.platformUserId)) throw Object.assign(new Error('关注后用户身份已改变，停止首句发送'), { followAttempted: true })
        // An external previous follow is not evidence that no greeting was sent.
        if (result.alreadyFollowed) { this.patch(id, { status: 'FAILED', contact: { followStatus: 'followed', reason: '对方此前已关注，无法证明没有联系过；请人工核对', retrySafe: false } }, 'previous_follow_detected'); return { ok: true, skipped: true } }
        candidate = this.patch(id, { status: 'FOLLOWED', contact: { followedAt: this.at(), followStatus: 'followed' } }, 'follow_confirmed')
        this.requestConversationSync(candidate, 'follow_confirmed')
      }
      this.assert(candidate, generation, { beforeMutation: true })
      const probe = await this.probe(candidate, generation)
      if (probe?.followPending) { this.defer(id, 'FOLLOW_PENDING', probe.reason || '关注状态待确认'); return { ok: true, pending: true } }
      if (probe && probe.dmAvailable !== true) {
        this.defer(id, 'CONTACT_WAITLIST', probe.reason || '目前不能明确确认私信权限'); return { ok: true, waitlisted: true }
      }
      candidate = this.candidate(id)
      this.assert(candidate, generation, { beforeMutation: true })
      this.saveControl({ lastContactAttemptAt: this.at() })
      candidate = this.patch(id, { status: 'OPENING_SENDING', contact: { openingAttemptAt: this.at(), openingStatus: 'sending', openingAttempts: (Number(candidate.contact?.openingAttempts) || 0) + 1, retrySafe: false, reason: '' } }, 'opening_started')
      const result = await this.friendship.greeting(candidate.profileUrl, candidate.contact.openingMessage, { background: true,
        beforeSubmit: () => this.assert(this.candidate(id), generation, { beforeMutation: true }) })
      if (!result?.ok) throw Object.assign(new Error(result?.error || '首句发送结果未确认'), { sendAttempted: result?.sendAttempted !== false || result?.uncertain === true })
      if (result.profileUrl && result.profileUrl !== candidate.profileUrl) throw Object.assign(new Error('首句已提交，但返回联系人 ID 不一致，请人工核对'), { sendAttempted: true })
      this.patch(id, { status: 'OPENING_SENT', contact: { openingSentAt: this.at(), openingStatus: 'sent', contactId: result.contactId || null, reason: '', nextCheckAt: null } }, 'opening_confirmed')
      this.requestConversationSync(this.candidate(id), 'opening_confirmed')
      this.patch(id, { status: 'WAITING_REPLY' }, 'waiting_reply')
      this.saveControl({ lastError: '', reason: '' })
      return { ok: true, greeted: true, candidate: this.candidate(id), ...this.state() }
    } catch (error) {
      candidate = this.candidate(id)
      if (candidate.status === 'FOLLOWING') {
        const safe = error.followAttempted === false
        this.patch(id, { status: safe ? 'FAILED' : 'FOLLOW_UNCERTAIN', contact: { followStatus: safe ? 'failed' : 'unknown', reason: clean(error.message), retrySafe: safe, retryStage: 'follow' } }, safe ? 'follow_failed' : 'follow_unknown')
      } else if (candidate.status === 'OPENING_SENDING') {
        const safe = error.sendAttempted === false && error.uncertain !== true
        if (safe && error.code === 'dm_unavailable') this.defer(id, 'CONTACT_WAITLIST', error.message)
        else this.patch(id, { status: safe ? 'FAILED' : 'SEND_UNKNOWN', contact: { openingStatus: safe ? 'failed' : 'unknown', reason: clean(error.message), retrySafe: safe, retryStage: 'opening' } }, safe ? 'opening_failed' : 'opening_unknown')
      } else if (!DELIVERED.has(candidate.status)) {
        this.patch(id, { contact: { reason: clean(error.message) } }, 'contact_stopped')
      }
      const blocked = error.blocked === true || ['challenge', 'verification', 'login_required'].includes(error.code)
      this.saveControl({ lastError: clean(error.message), ...(blocked ? { blockedReason: clean(error.message) } : {}) }); this.emit()
      return { ok: false, error: error.message, blocked, stopped: error.stopped === true, candidate: this.candidate(id) }
    } finally {
      const latest = this.candidate(id)
      if (latest.contact?.pauseRequested && !UNSAFE.has(latest.status) && !DELIVERED.has(latest.status)) {
        this.patch(id, { status: 'PAUSED', contact: { resumeStatus: latest.status, reason: '此候选联系流程已暂停', pauseRequested: false } }, 'candidate_paused')
      }
      this.locks.delete(id)
    }
  }
  retry(id) {
    if (this.destroyed) throw new Error('此账号的联系服务已关闭')
    const candidate = this.candidate(id)
    if (UNSAFE.has(candidate.status) || DELIVERED.has(candidate.status) || candidate.contact?.openingSentAt || !RETRYABLE.has(candidate.status)) throw new Error('此状态不能重试；投递不明或已发送的首句不得重复发送')
    if (!['FOLLOWED', 'CONTACT_QUEUED'].includes(candidate.status) && candidate.contact?.retrySafe !== true) throw new Error('尚未证明操作没有提交，不能安全重试')
    const gate = this.hard(candidate); if (!gate.ok) throw new Error(gate.reason)
    const template = templateFor({ ...candidate, brain: gate.evaluation }, this.config())
    if (!template.text) throw new Error('请先手动填写首句模板')
    const next = this.patch(id, { status: candidate.contact?.followedAt ? 'FOLLOWED' : 'CONTACT_QUEUED', contact: { reason: '', retrySafe: true, openingTemplate: template.key, openingMessage: template.text, nextCheckAt: null } }, 'safe_retry_queued')
    return { ok: true, candidate: next, ...this.state() }
  }
  async runOnce() {
    if (this.running || this.destroyed) return { ok: true, skipped: true }
    this.reconcileReplies()
    const gate = this.gate()
    if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason, ...this.state() }
    this.running = true; const generation = this.generation
    try {
      const waiting = this.manager.get().candidates.find(c => c.accountId === this.accountId && ['FOLLOW_PENDING', 'CONTACT_WAITLIST'].includes(c.status) && Date.parse(c.contact?.nextCheckAt || 0) <= this.now().getTime())
      if (waiting) return await this.checkWaiting(waiting, generation)
      const config = this.config()
      // Profile refresh is finite and read only; it can turn unknown public
      // facts into evidence but never guesses missing gender, age or followers.
      if (this.inspectCandidate && Object.values(config.templates).some(v => v.trim())) {
        const refreshable = this.manager.get().candidates.filter(c => c.accountId === this.accountId && ['REVIEW_PENDING', 'DISCOVERED', 'APPROVED', 'APPROVED_PENDING_CONTACT'].includes(c.status)).slice(0, 8)
        for (const item of refreshable) {
          this.assert(null, generation)
          await this.inspectCandidate(item)
          this.assert(null, generation)
          const current = this.candidate(item.id)
          this.patch(item.id, { brain: this.evaluate(current) }, 'candidate_scored')
        }
      }
      let queued = this.manager.get().candidates.filter(c => c.accountId === this.accountId && ['CONTACT_QUEUED', 'FOLLOWED'].includes(c.status))
      for (const item of queued.filter(c => !c.contact?.openingMessage)) {
        const template = templateFor(item, config)
        if (template.text) this.patch(item.id, { contact: { openingTemplate: template.key, openingMessage: template.text } }, 'manual_template_selected')
      }
      queued = queued.map(c => this.candidate(c.id))
      if (!queued.length && config.mode === 'automatic') {
        const ranked = this.manager.get().candidates.filter(c => c.accountId === this.accountId && ['REVIEW_PENDING', 'DISCOVERED', 'APPROVED', 'APPROVED_PENDING_CONTACT'].includes(c.status))
          .map(c => ({ c, result: this.hard(c) })).filter(({ result }) => result.ok && result.evaluation.score >= config.autoScoreThreshold)
          .sort((a, b) => b.result.evaluation.score - a.result.evaluation.score)
        if (ranked.length) { this.enqueue(ranked[0].c.id, { automatic: true }); queued = [this.candidate(ranked[0].c.id)] }
      }
      queued.sort((a, b) => (b.brain?.score || 0) - (a.brain?.score || 0))
      if (!queued.length) return { ok: true, skipped: true, reason: '没有已批准且可安全处理的联系候选' }
      const candidate = queued.find(c => this.gate(c, generation, { beforeMutation: true, interval: true }).ok) || queued[0], gate = this.gate(candidate, generation, { beforeMutation: true, interval: true })
      if (!gate.ok) return { ok: true, skipped: true, reason: gate.reason }
      return await this.process(candidate.id, generation)
    } catch (error) {
      const blocked = error.blocked === true || ['challenge', 'verification', 'login_required'].includes(error.code)
      this.saveControl({ lastError: clean(error.message), ...(blocked ? { blockedReason: clean(error.message) } : {}) }); this.emit()
      return { ok: false, error: error.message, blocked }
    } finally { this.running = false; this.emit() }
  }
  linkedContact(candidate, contacts = this.storage.get().contacts || []) {
    const matches = contacts.filter(c => {
      const profile = c.profile || {}, id = profile.platformUserId || profile.secUid || c.platformUserId
      const url = profile.autoFriendshipUrl || profile.profileUrl || c.profileUrl
      return (id === candidate.platformUserId || canonicalProfile(url)?.platformUserId === candidate.platformUserId)
        && (!candidate.contact?.contactId || c.id === candidate.contact.contactId)
    })
    return matches.length === 1 ? matches[0] : null
  }
  onIncoming(contact, message, proof = {}) {
    if (this.destroyed || this.douyin._destroyed || message?.role !== 'contact') return { ok: true, skipped: true }
    const identity = clean(proof.platformUserId || message.platformUserId || message.senderSecUid || message.secUid, 150)
    if (!identity) return { ok: true, skipped: true, reason: '没有可靠的对方用户 ID' }
    const candidate = this.manager.get().candidates.find(c => c.accountId === this.accountId && c.platformUserId === identity && c.status === 'WAITING_REPLY')
    const messageAt = message.at || (message.identityVerified === true ? message.observedAt : '')
    if (!candidate || !candidate.contact?.openingSentAt || !Number.isFinite(Date.parse(messageAt)) || Date.parse(messageAt) < Date.parse(candidate.contact.openingSentAt)) return { ok: true, skipped: true }
    const current = this.linkedContact(candidate)
    if (!current || current.id !== contact.id) return { ok: true, skipped: true, reason: '联系人与候选用户 ID 绑定不一致' }
    const { normalizeContact } = require('./storage.cjs')
    const updated = normalizeContact({ ...current, profile: { ...current.profile, chatMode: 'friendship', useSelfPersona: true, autoFriendship: true, contactPipeline: true,
      source: 'discovery', candidateId: candidate.id, discoverySource: candidate.source, autoFriendshipUrl: candidate.profileUrl,
      platformUserId: candidate.platformUserId, dmIdentityVerified: true }, source: 'discovery', candidateId: candidate.id })
    this.storage.update({ contacts: this.storage.get().contacts.map(c => c.id === current.id ? updated : c) })
    this.patch(candidate.id, { status: 'REPLIED', contact: { repliedAt: messageAt, firstReplyMessageId: message.id || null, contactId: current.id } }, 'first_reply_received')
    this.patch(candidate.id, { status: 'CONTACT', contact: { contactCreatedAt: this.at() } }, 'friendship_handoff')
    this.requestConversationSync(this.candidate(candidate.id), 'first_reply', { contact: updated, at: messageAt, messageId: message.id })
    this.douyin.emitEvent?.('contacts', { contacts: this.storage.get().contacts })
    return { ok: true, replied: true, candidate: this.candidate(candidate.id), contact: updated }
  }
  reconcileReplies() {
    if (this.destroyed) return { ok: true, count: 0 }
    let count = 0
    for (const candidate of this.manager.get().candidates.filter(c => c.accountId === this.accountId && c.status === 'WAITING_REPLY')) {
      const contact = this.linkedContact(candidate)
      if (!contact) continue
      const messages = contact.learning?.messages || []
      const incoming = messages.find(m => m.role === 'contact' && Date.parse(m.at || (m.identityVerified === true ? m.observedAt : '')) >= Date.parse(candidate.contact?.openingSentAt)
        && (m.platformUserId || m.senderSecUid || m.secUid) === candidate.platformUserId)
      if (incoming && this.onIncoming(contact, incoming, { platformUserId: incoming.platformUserId || incoming.senderSecUid || incoming.secUid }).replied) count++
    }
    return { ok: true, count }
  }
  metrics(context = this.readContext()) {
    const candidates = context.discovery.candidates.filter(c => c.accountId === this.accountId), bySource = {}
    const empty = () => ({ discovered: 0, eligible: 0, approved: 0, followed: 0, openingSent: 0, replied: 0, fiveRounds: 0, sevenDays: 0 })
    const total = empty()
    for (const candidate of candidates) {
      const count = empty(); count.discovered = 1
      count.eligible = this.hard(candidate, context).ok ? 1 : candidate.brain?.hardGate?.passed && candidate.contact?.openingSentAt ? 1 : 0
      count.approved = candidate.review?.status === 'approved' ? 1 : 0
      count.followed = candidate.contact?.followedAt ? 1 : 0
      count.openingSent = candidate.contact?.openingSentAt ? 1 : 0
      count.replied = candidate.contact?.repliedAt ? 1 : 0
      const contact = this.linkedContact(candidate, context.state.contacts || []), start = Date.parse(candidate.contact?.repliedAt)
      const messageTime = m => Date.parse(m.at || (m.identityVerified === true ? m.observedAt : ''))
      const messages = (contact?.learning?.messages || []).filter(m => ['me', 'contact'].includes(m.role) && Number.isFinite(messageTime(m)) && messageTime(m) >= start).sort((a, b) => messageTime(a) - messageTime(b))
      let rounds = 0, incoming = false
      for (const m of messages) { if (m.role === 'contact') incoming = true; else if (incoming) { rounds++; incoming = false } }
      count.fiveRounds = rounds >= 5 ? 1 : 0
      const incomingTimes = messages.filter(m => m.role === 'contact').map(messageTime)
      count.sevenDays = incomingTimes.length > 1 && incomingTimes.at(-1) - incomingTimes[0] >= 7 * 24 * 60 * MINUTE && rounds > 0 ? 1 : 0
      const source = `${candidate.source?.type || 'comment'}：${candidate.source?.keyword || candidate.source?.topic || 'unknown'}`
      bySource[source] ||= empty()
      for (const key of Object.keys(total)) { total[key] += count[key]; bySource[source][key] += count[key] }
    }
    return { ...total, bySource }
  }
  start() {
    if (this.destroyed || this.timer) return
    this.timer = setInterval(() => this.runOnce().catch(error => this.douyin.log?.('contact_error', '联系队列检查失败', { error: error.message })), MINUTE)
    this.timer.unref?.()
  }
  destroy() { this.destroyed = true; this.generation++; clearInterval(this.timer); this.timer = null }
}
module.exports = { ContactEngine, normalizeContactConfig, templateFor }
