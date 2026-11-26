const { randomUUID } = require('node:crypto')
const { actionStateOf, contactOne, preflight } = require('./batch-contact.cjs')

const active = new WeakSet()
const failed = (code, reason) => ({ ok: false, code, reason })

function recordBudget(store, result) {
  const day = new Date().toISOString().slice(0, 10)
  if (result.at.slice(0, 10) !== day) return
  const current = store.autoContactState().budget
  const budget = current.day === day ? { ...current } : {
    day, follows: 0, messages: 0, realFollows: 0, realMessages: 0,
    simulatedFollows: 0, simulatedMessages: 0,
  }
  const receipts = budget.batchContactReceipts || {}
  const previous = receipts[result.attemptId] || {}
  const follow = previous.follow || (result.alreadyFollowed !== true && ['confirmed', 'pending'].includes(result.followStatus))
  const message = previous.message || result.messageStatus === 'sent'
  if (Boolean(previous.follow) === follow && Boolean(previous.message) === message) return
  budget.realFollows += Number(follow && !previous.follow)
  budget.realMessages += Number(message && !previous.message)
  budget.batchContactReceipts = { ...receipts, [result.attemptId]: { follow, message } }
  store.setAutoContact({ budget })
}

function saveResult(manager, id, result, { saveOpening = false } = {}) {
  const saved = manager.patch(id, {
    action: {
      ...actionStateOf(result), lastAttemptAt: result.at,
      lastActionReason: result.ok ? result.note : result.reason,
      reviewRequiredAt: result.needsReview ? result.at : null,
    },
    review: {
      realContact: result,
      ...(saveOpening && result.messageStatus === 'sent' ? { draftOpening: result.text } : {}),
    },
  })
  if (saved?.review?.realContact?.attemptId !== result.attemptId) throw new Error('首次联系结果保存失败')
}

async function executeBatchContact(options) {
  const account = options.manager.storage
  if (active.has(account)) return failed('CONTACT_BUSY', '当前账号正在执行首次联系')
  active.add(account)
  try {
    return await executeContact(options)
  } finally {
    active.delete(account)
  }
}

async function executeContact({ manager, store, candidate, friendship, text, contactedIds, minIntent, manual = false }) {
  const fresh = manager.get().candidates.find(item => item.id === candidate.id)
  if (!fresh) return failed('NOT_IN_POOL', '找不到候选人')
  const previous = fresh.review?.realContact || {}
  if (fresh.action?.firstMessageStatus === 'sent' || previous.messageStatus === 'sent') {
    return failed('ALREADY_SENT', '第一句已发送')
  }
  if (fresh.action?.needsReview || previous.needsReview) {
    return failed('OUTCOME_UNCERTAIN', '上一次发送结果待核实，请先核对')
  }
  if (!manual) {
    const check = preflight(fresh, { contactedIds, minIntent })
    if (!check.ok) return check
    const state = store.autoContactState()
    if (state.mode !== 'auto' || !state.riskAcceptedAt || !state.config.autoFollow) {
      return failed('AUTO_CONTACT_DISABLED', '自动联系当前未启用')
    }
    const budget = state.budget?.day === new Date().toISOString().slice(0, 10) ? state.budget : {}
    if ((budget.realFollows || 0) >= state.config.dailyFollowLimit || (budget.realMessages || 0) >= state.config.dailyFirstMessageLimit) {
      return failed('DAILY_LIMIT_REACHED', '今日真实额度已用尽')
    }
    if (manager.get().candidates.some(item => item.action?.needsReview || item.review?.realContact?.needsReview) || Object.values(manager.get().candidateContactHistory || {}).some(item => item.action?.needsReview || item.realContact?.needsReview)) {
      return failed('UNCERTAIN_NEEDS_REVIEW', '有发送结果待核实')
    }
  }
  const opening = String(text || '').trim() || String(fresh.review?.draftOpening || '').trim()
  if (!opening || opening.length > 80) return failed('INVALID_OPENING', '第一句须为1到80字')

  const attempt = { at: new Date().toISOString(), attemptId: randomUUID() }
  // 在可能发生外发之前持久化。进程中断后保留待核实记录。
  saveResult(manager, fresh.id, {
    ...attempt, text: opening, ok: false, outcome: 'UNCERTAIN', needsReview: true,
    autoRetryBlocked: true, followStatus: previous.followStatus === 'confirmed' ? 'confirmed' : 'unknown',
    messageStatus: 'unknown', reason: '首次联系执行中或执行结果待核实',
  })
  const result = { ...await contactOne(fresh, { friendship, text: opening, contactedIds, minIntent, manual }), ...attempt }
  recordBudget(store, result)
  saveResult(manager, fresh.id, result, { saveOpening: manual })
  return result
}

function reviewBatchContact({ manager, store, id, conclusion }) {
  if (active.has(manager.storage)) return { ok: false, error: '当前账号正在执行首次联系' }
  const candidate = manager.get().candidates.find(item => item.id === id)
  if (!candidate) return { ok: false, error: '找不到候选人' }
  const prior = candidate.review?.realContact || {}
  if (!prior.needsReview && !candidate.action?.needsReview) {
    return { ok: true, conclusion: prior.reviewConclusion || '已核对' }
  }
  const now = new Date().toISOString()
  if (conclusion !== 'sent' && conclusion !== 'not_sent') {
    return { ok: false, error: '请明确选择确认已发出或确认未发出' }
  }
  const sent = conclusion === 'sent'
  const kind = sent ? '已确认发出' : '确认未发出'
  const result = {
    ...prior, at: prior.at || now, attemptId: prior.attemptId || randomUUID(),
    outcome: sent ? 'SENT' : 'REVIEWED',
    ok: sent, messageStatus: sent ? 'sent' : 'not_sent',
    needsReview: false, autoRetryBlocked: false, reviewedAt: now, reviewConclusion: kind,
    lastActionReason: kind, note: kind, reason: kind,
  }
  // 旧记录没有逐次记账凭据。仅补记此次明确核对的首句，保留原关注账目。
  if (prior.attemptId) recordBudget(store, result)
  else if (sent) recordBudget(store, { ...result, alreadyFollowed: true })
  saveResult(manager, id, result)
  return { ok: true, at: now, conclusion: kind }
}

module.exports = { executeBatchContact, reviewBatchContact }
