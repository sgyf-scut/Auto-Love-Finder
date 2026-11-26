const { createHash, randomUUID } = require('node:crypto')
const { clean, messageList, normalizeEvent, advanceEventLifecycle, relationMetrics, summarizeMemory } = require('./memory-manager.cjs')

const HOURS = 3600000
const TERMINAL = ['resolved', 'cancelled', 'stale', 'followed_up']
const revision = event => createHash('sha256').update(JSON.stringify([event.id, event.eventAt, event.description, event.followUpWindow, event.sourceMessageIds])).digest('hex').slice(0, 24)
function isInWindow(event, now = new Date()) {
  const at = new Date(now).getTime()
  return Boolean(!TERMINAL.includes(event.status) && event.followUp?.enabled && event.followUpWindow && at >= Date.parse(event.followUpWindow.startAt) && at <= Date.parse(event.followUpWindow.endAt))
}
function generateEventCandidate(contact, event) {
  return { id: `event_${createHash('sha256').update(`${contact.id || contact.name}|${event.id}|${revision(event)}`).digest('hex').slice(0, 24)}`, type: 'event_followup', contactId: contact.id || contact.name, name: contact.name, eventId: event.id, eventRevision: revision(event), reason: `对方明确提到的事件已进入跟进窗口：${event.description}`, priority: 0.9, naturalness: 0.94, event: { id: event.id, type: event.type, description: event.description, eventAt: event.eventAt, evidence: event.evidence, sourceMessageIds: event.sourceMessageIds, followUpWindow: event.followUpWindow } }
}
function scanDueEvents(contacts, now = new Date()) {
  return (contacts || []).flatMap(contact => advanceEventLifecycle(contact.socialBrain?.events, now).filter(event => isInWindow(event, now) && event.confidence >= 0.85 && event.evidence && event.sourceMessageIds.length && ['pending', 'failed', 'deferred'].includes(event.followUp.status)).map(event => generateEventCandidate(contact, event)))
}
function quietNow(settings, now) {
  if (!settings.quietHours) return false
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now)).map(p => [p.type, p.value]))
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  const clock = value => /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null
  const start = clock(settings.quietStart || '23:00'), end = clock(settings.quietEnd || '07:00')
  if (start === null || end === null) return true
  if (start === end) return true
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}
function checkDisturbance({ state, contact, now = new Date(), allowance = { ok: true }, lastReplyAt = 0, hasPendingIncoming = false }) {
  const settings = state.settings || {}, config = state.automation || {}
  const fail = (code, reason) => ({ ok: false, code, reason })
  if (settings.eventFollowup?.enabled === false || settings.longTermMemory === false) return fail('disabled', '事件跟进或记忆已关闭')
  if (config.paused) return fail('paused', '自动化已暂停')
  if ((config.blacklist || []).includes(contact.name)) return fail('blacklist', '联系人在黑名单中')
  if ((config.aiDisabledContacts || []).includes(contact.name) || contact.profile?.aiEnabled === false) return fail('ai_disabled', '联系人 AI 回复已关闭')
  if (quietNow(settings, now)) return fail('quiet', '当前为免打扰时段')
  if (!allowance.ok) return fail('quota', allowance.reason)
  const messages = messageList(contact), metrics = relationMetrics(messages, now)
  if (hasPendingIncoming || Number(contact.unread || 0) > 0) return fail('incoming', '对方有待处理消息，先接当前对话')
  if (metrics.unansweredOutgoing >= 2) return fail('unanswered', '我方已有两条消息未获回复')
  const incoming = messages.filter(m => m.role === 'contact').slice(-3)
  if (incoming.some(m => /(?:别|不要|不想|不愿).{0,5}(?:联系|找我|聊天|再聊)|别再发|到此为止/.test(m.text))) return fail('refusal', '对方明确表示不想继续聊天')
  const initiations = []
  for (let i = 0; i < messages.length; i++) {
    const at = Date.parse(messages[i].at), prior = Date.parse(messages[i - 1]?.at)
    if (Number.isFinite(at) && (!i || Number.isFinite(prior) && at - prior >= 6 * HOURS)) initiations.push(messages[i].role)
  }
  if (initiations.length >= 2 && initiations.slice(-2).every(role => role === 'me')) return fail('initiations', '最近两轮聊天均由我方主动，暂缓跟进')
  const historyAt = Math.max(0, ...messages.map(m => Date.parse(m.at) || 0), ...(state.sendHistory || []).filter(s => s.name === contact.name).map(s => Date.parse(s.at) || 0), Number(contact.turn?.lastOutgoingAt) || 0, Number(lastReplyAt) || 0)
  if (!historyAt && messages.length) return fail('unknown_time', '近期聊天时间未确认，暂缓主动跟进')
  if (historyAt && new Date(now).getTime() - historyAt < 6 * HOURS) return fail('recent_chat', '最近六小时刚聊过，暂缓主动跟进')
  const seconds = { instant: 0, '30s': 30, '60s': 60, '300s': 300, '3600s': 3600 }[contact.profile?.frequency] || 0
  if (new Date(now).getTime() - historyAt < seconds * 1000) return fail('frequency', '尚未达到联系人回复间隔')
  return { ok: true, disturbRisk: 0.12 }
}
function markFollowupResult(event, result, { now = new Date(), error = '', candidateId = '' } = {}) {
  const next = normalizeEvent(event)
  const followUp = { ...next.followUp }
  if (result === 'attempt') { followUp.status = 'sending'; followUp.attempts++; followUp.lastAttemptAt = new Date(now).toISOString() }
  else if (result === 'sent') { next.status = 'followed_up'; followUp.status = 'followed_up'; followUp.enabled = false; followUp.sentAt = new Date(now).toISOString() }
  else if (result === 'failed' || result === 'uncertain') { followUp.status = result; followUp.lastError = clean(error, 300) }
  else if (result === 'drafted') { followUp.status = 'drafted'; followUp.candidateId = candidateId }
  else if (result === 'skip') { followUp.status = 'skipped'; followUp.enabled = false }
  else if (result === 'defer') { followUp.status = 'deferred'; followUp.retryAfter = new Date(new Date(now).getTime() + 6 * HOURS).toISOString() }
  return normalizeEvent({ ...next, followUp })
}

class ProactiveEngine {
  constructor({ storage, ai, douyin, accountId = '', clock = () => new Date() }) { this.storage = storage; this.ai = ai; this.douyin = douyin; this.accountId = accountId; this.clock = clock; this.scanning = false; this.locks = new Set(); this.lastScanAt = 0; this.destroyed = false; this.recover() }
  recover() {
    const state = this.storage.get()
    const pendingDrafts = (state.pendingDrafts || []).map(d => d.source === 'event_followup' && d.status === 'sending' ? { ...d, status: 'uncertain', error: '上次发送中断，结果未确认，请先检查抖音聊天记录' } : d)
    const contacts = (state.contacts || []).map(c => !c.socialBrain ? c : { ...c, socialBrain: { ...c.socialBrain, events: (c.socialBrain.events || []).map(e => e.followUp?.status === 'sending' ? markFollowupResult(e, 'uncertain', { error: '上次发送中断，结果未确认' }) : e) } })
    if (JSON.stringify(pendingDrafts) !== JSON.stringify(state.pendingDrafts || []) || JSON.stringify(contacts) !== JSON.stringify(state.contacts || [])) this.storage.update({ pendingDrafts, contacts })
  }
  emit() { const state = this.storage.get(); this.douyin.emitEvent?.('drafts', { drafts: state.pendingDrafts || [] }); this.douyin.emitEvent?.('contacts', { contacts: state.contacts || [] }) }
  reconcile(now = this.clock()) {
    const state = this.storage.get()
    const contacts = (state.contacts || []).map(c => !c.socialBrain ? c : { ...c, socialBrain: { ...c.socialBrain, events: advanceEventLifecycle(c.socialBrain.events, now) } })
    const pendingDrafts = (state.pendingDrafts || []).filter(d => {
      if (d.source !== 'event_followup') return true
      const contact = contacts.find(c => (c.id || c.name) === d.contactId && c.name === d.name)
      const event = contact?.socialBrain?.events?.find(e => e.id === d.eventId)
      return event && !TERMINAL.includes(event.status) && event.followUp?.enabled && revision(event) === d.eventRevision
    })
    for (const contact of contacts) for (const event of contact.socialBrain?.events || []) {
      if (event.followUp.status === 'drafted' && !pendingDrafts.some(d => d.source === 'event_followup' && d.contactId === (contact.id || contact.name) && d.eventId === event.id)) event.followUp = { ...event.followUp, status: 'pending', candidateId: null }
    }
    if (JSON.stringify(contacts) !== JSON.stringify(state.contacts || []) || JSON.stringify(pendingDrafts) !== JSON.stringify(state.pendingDrafts || [])) { this.storage.update({ contacts, pendingDrafts }); this.emit() }
  }
  locate(id) {
    const state = this.storage.get(), draft = (state.pendingDrafts || []).find(d => d.id === id && d.source === 'event_followup')
    const contact = draft && (state.contacts || []).find(c => (c.id || c.name) === draft.contactId && c.name === draft.name)
    const event = contact?.socialBrain?.events?.find(e => e.id === draft.eventId)
    if (!draft || !contact || !event || revision(event) !== draft.eventRevision || TERMINAL.includes(event.status)) throw new Error('事件已更新、解决或过期，请刷新草稿')
    return { state, draft, contact, event }
  }
  gate(contact, now = this.clock()) {
    if (this.destroyed || this.douyin._destroyed) return { ok: false, reason: '账号服务已停止' }
    if (this.douyin.verificationActive) return { ok: false, reason: '抖音正在安全验证' }
    return checkDisturbance({ state: this.storage.get(), contact, now, allowance: this.douyin.getSendAllowance(contact.name, new Date(now).getTime()), lastReplyAt: this.douyin.lastReplyTime?.get(contact.name), hasPendingIncoming: this.douyin.incomingQueue?.has(contact.name) })
  }
  updateEvent(contactId, eventId, updater, draftUpdater) {
    const state = this.storage.get()
    const contacts = (state.contacts || []).map(c => (c.id || c.name) !== contactId ? c : { ...c, socialBrain: { ...c.socialBrain, events: c.socialBrain.events.map(e => e.id === eventId ? updater(e) : e) } })
    for (const contact of contacts.filter(c => (c.id || c.name) === contactId)) contact.socialBrain.summary = summarizeMemory(contact.socialBrain, messageList(contact))
    this.storage.update({ contacts, ...(draftUpdater ? { pendingDrafts: draftUpdater(state.pendingDrafts || []) } : {}) }); this.emit()
  }
  async scan({ force = false, now = this.clock() } = {}) {
    if (this.scanning || this.destroyed || !force && new Date(now).getTime() - this.lastScanAt < 60000) return { ok: true, generatedCount: 0, deferredCount: 0 }
    this.scanning = true; this.lastScanAt = new Date(now).getTime()
    let generatedCount = 0, deferredCount = 0
    try {
      this.reconcile(now)
      for (const candidate of scanDueEvents(this.storage.get().contacts, now)) {
        const state = this.storage.get(), contact = state.contacts.find(c => (c.id || c.name) === candidate.contactId), event = contact?.socialBrain?.events.find(e => e.id === candidate.eventId)
        if (!contact || !event || !isInWindow(event, now) || event.followUp.retryAfter && Date.parse(event.followUp.retryAfter) > new Date(now).getTime()) continue
        if ((state.pendingDrafts || []).some(d => d.source === 'event_followup' && d.contactId === candidate.contactId && d.eventId === candidate.eventId) || (state.pendingDrafts || []).length >= 50) continue
        const gate = this.gate(contact, now)
        if (!gate.ok) { deferredCount++; continue }
        try {
          const result = await this.ai.draftEventFollowup({ contact, candidate: { ...candidate, disturbRisk: gate.disturbRisk }, now })
          const latest = this.storage.get(), current = latest.contacts.find(c => (c.id || c.name) === candidate.contactId), updatedEvent = current?.socialBrain?.events.find(e => e.id === candidate.eventId)
          const checkedAt = this.clock()
          if (!updatedEvent || revision(updatedEvent) !== candidate.eventRevision || !isInWindow(updatedEvent, checkedAt) || !this.gate(current, checkedAt).ok || this.destroyed) continue
          if (!result.ok) throw new Error(result.error || '事件跟进生成失败')
          if (result.skipped || !result.text) { this.updateEvent(candidate.contactId, candidate.eventId, e => markFollowupResult(e, 'defer', { now })); deferredCount++; continue }
          const draft = { id: randomUUID(), source: 'event_followup', accountId: this.accountId, candidateId: candidate.id, contactId: candidate.contactId, eventId: candidate.eventId, eventRevision: candidate.eventRevision, at: new Date(now).toISOString(), name: current.name, reason: candidate.reason, eventDescription: updatedEvent.description, followUpWindow: updatedEvent.followUpWindow, text: clean(result.text, 80), strategy: result.strategy, model: result.model, provider: result.provider, status: 'pending' }
          this.updateEvent(candidate.contactId, candidate.eventId, e => markFollowupResult(e, 'drafted', { candidateId: candidate.id }), drafts => [...drafts, draft])
          generatedCount++; break // At most one model generation per round.
        } catch (error) {
          this.updateEvent(candidate.contactId, candidate.eventId, e => ({ ...e, followUp: { ...e.followUp, retryAfter: new Date(new Date(now).getTime() + 1800000).toISOString(), generationError: clean(error.message, 300) } }))
          this.douyin.log?.('event_followup_generation_failed', '事件跟进草稿生成失败，稍后重新检查', { name: contact.name, error: error.message })
        }
      }
      return { ok: true, generatedCount, deferredCount }
    } finally { this.scanning = false }
  }
  async send({ id, text }, { isActive = () => true } = {}) {
    if (this.locks.has(id)) throw new Error('这条事件草稿正在处理中')
    this.locks.add(id)
    try {
      this.reconcile()
      let current = this.locate(id)
      if (['sending', 'uncertain'].includes(current.draft.status)) throw new Error('发送结果未确认，请先检查抖音聊天记录，不能重复发送')
      if (!isActive()) throw new Error('当前账号已经切换，请刷新')
      const gate = this.gate(current.contact)
      if (!gate.ok) throw new Error(gate.reason)
      if (!isInWindow(current.event, this.clock())) throw new Error('尚未进入事件跟进窗口')
      const value = clean(text || current.draft.text, 1000)
      if (!value || value.length > 80) throw new Error('事件跟进消息应为1至80字')
      this.updateEvent(current.draft.contactId, current.event.id, e => markFollowupResult(e, 'attempt', { now: this.clock() }), drafts => drafts.map(d => d.id === id ? { ...d, text: value, status: 'sending', error: '' } : d))
      try {
        const result = await this.douyin.sendMessage(current.contact.name, value, { ai: true, source: 'event_followup', model: current.draft.model, provider: current.draft.provider,
          sharedMemoryIds: current.draft.strategy?.sharedMemoryIds || [], sharedMemoryRevision: current.draft.strategy?.sharedMemoryRevision,
          beforeSubmit: () => {
          const latest = this.locate(id)
          if (!isActive()) throw new Error('当前账号已经切换，已停止发送')
          const latestGate = this.gate(latest.contact)
          if (!latestGate.ok) throw new Error(latestGate.reason)
          if (!isInWindow(latest.event, this.clock()) || latest.draft.status !== 'sending') throw new Error('事件或草稿状态已改变，已停止发送')
        } })
        if (!result?.ok) throw Object.assign(new Error(result?.error || '发送失败'), { sendAttempted: Boolean(result?.uncertain) })
        this.updateEvent(current.draft.contactId, current.event.id, e => TERMINAL.includes(e.status) ? e : markFollowupResult(e, 'sent', { now: this.clock() }), drafts => drafts.filter(d => d.id !== id))
        return { ok: true }
      } catch (error) {
        const uncertain = error.sendAttempted === true || error.uncertain === true
        this.updateEvent(current.draft.contactId, current.event.id, e => TERMINAL.includes(e.status) ? e : markFollowupResult(e, uncertain ? 'uncertain' : 'failed', { error: error.message }), drafts => drafts.map(d => d.id === id ? { ...d, status: uncertain ? 'uncertain' : 'failed', error: error.message } : d))
        return { ok: false, error: error.message, uncertain }
      }
    } finally { this.locks.delete(id) }
  }
  skip({ id }) {
    if (this.locks.has(id)) throw new Error('草稿正在处理中，请稍后跳过')
    const { draft, event } = this.locate(id)
    this.updateEvent(draft.contactId, event.id, e => markFollowupResult(e, 'skip'), drafts => drafts.filter(d => d.id !== id))
    return { ok: true }
  }
  async rewrite({ id }) {
    if (this.locks.has(id)) throw new Error('草稿正在处理中')
    this.locks.add(id)
    try {
      this.reconcile(); const { draft, contact, event } = this.locate(id)
      if (['sending', 'uncertain'].includes(draft.status)) throw new Error('发送结果未确认，不能改写重发')
      const gate = this.gate(contact); if (!gate.ok) throw new Error(gate.reason)
      const result = await this.ai.draftEventFollowup({ contact, candidate: generateEventCandidate(contact, event), now: this.clock() })
      const current = this.locate(id)
      if (!isInWindow(current.event, this.clock()) || !this.gate(current.contact).ok || this.destroyed) throw new Error('事件或聊天状态已改变，请重新检查')
      if (!result.ok) throw new Error(result.error || '事件草稿改写失败')
      if (result.skipped || !result.text) { this.updateEvent(draft.contactId, event.id, e => markFollowupResult(e, 'defer', { now: this.clock() }), drafts => drafts.filter(d => d.id !== id)); return { ok: true, skipped: true } }
      this.storage.update({ pendingDrafts: (this.storage.get().pendingDrafts || []).map(d => d.id === id ? { ...d, text: clean(result.text, 80), strategy: result.strategy, model: result.model, provider: result.provider } : d) }); this.emit()
      return { ok: true }
    } finally { this.locks.delete(id) }
  }
  destroy() { this.destroyed = true }
}
module.exports = { ProactiveEngine, scanDueEvents, generateEventCandidate, checkDisturbance, markFollowupResult, isInWindow, eventRevision: revision, quietNow }
