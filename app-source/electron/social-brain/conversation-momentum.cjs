// Observable, short-lived conversation momentum. No model calls or relationship scoring.
const { normalizeMessages } = require('./conversation-attention.cjs')
const { isQuestion, relationMetrics } = require('./memory-manager.cjs')

const ATTENTION_WINDOW_MS = 5 * 60 * 1000
const LEVELS = Object.freeze(['HIGH', 'MEDIUM', 'LOW', 'ENDING'])
const STRATEGIES = Object.freeze(['DEEPEN', 'LIGHT_HOOK', 'SHARE', 'RETURN_TOPIC', 'CLOSE', 'NO_REPLY', 'ANSWER'])
const clamp = value => Math.max(0, Math.min(1, value))
const round = value => Math.round(value * 1000) / 1000
const time = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value ? Date.parse(value) : NaN
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null
const text = value => typeof value === 'string' ? value.trim() : ''
const meaningful = message => !['ACK', 'REACTION', 'CLOSING'].includes(message.classification) && Boolean(message.caption || message.hasMediaObservation)
const question = message => Boolean(message.caption) && (message.classification === 'QUESTION' || isQuestion(message.caption))
const disclosure = message => meaningful(message) && !question(message) && !/^(?:引用|转发|他说|她说|朋友说)|[“「『"]/.test(message.caption) && /(?:^|[，。！!\s])(?:最近|今天|昨天|刚刚)?我(?!朋友|同事|同学|室友|爸|妈|哥|姐|弟|妹)/.test(message.caption)
const refusal = message => /(?:别再(?:问|聊|发)|别(?:问|联系|发消息)|不要再|不想聊|不用回复|别回了|不要联系)/.test(message?.caption || '')

function recentTurns(messages) {
  const turns = []
  for (const message of messages) {
    const last = turns.at(-1)
    if (last?.senderRole === message.senderRole) last.messages.push(message)
    else turns.push({ senderRole: message.senderRole, messages: [message] })
  }
  return turns.slice(-5)
}

function trustedSelfInformation(persona) {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return false
  return ['identity', 'city', 'interests', 'experiences'].some(key => {
    const value = persona[key]
    if (typeof value === 'string') return Boolean(text(value))
    // Structured experiences must contain actual user-authored text, not an id/date alone.
    return Array.isArray(value) && value.some(item => typeof item === 'string' ? Boolean(text(item)) : item && item.verified !== false && Boolean(text(item.text || item.description || item.content)))
  })
}

function attentionWindow(messages, now, permitted) {
  let segmentStart = null, lastExchange = null, previous = null
  for (const message of messages.filter(meaningful)) {
    const at = time(message.at)
    if (!Number.isFinite(at) || at > now) { previous = null; continue }
    const previousAt = time(previous?.at)
    if (!previous || at < previousAt || at - previousAt > ATTENTION_WINDOW_MS) {
      segmentStart = at; lastExchange = null
    } else if (previous.senderRole !== message.senderRole) lastExchange = at
    // Consecutive owner messages do not extend a previous bilateral exchange.
    previous = message
  }
  const active = Boolean(permitted && lastExchange !== null && now >= lastExchange && now - lastExchange < ATTENTION_WINDOW_MS)
  return { active, startedAt: lastExchange === null ? null : iso(segmentStart), lastInteractionAt: iso(lastExchange), expiresAt: lastExchange === null ? null : iso(lastExchange + ATTENTION_WINDOW_MS), continuityBoost: active ? 0.08 : 0 }
}

function buildConversationMomentum({ messages = [], attention = null, state = null, previousMomentum = null, selfPersona = {}, now = Date.now() } = {}) {
  const currentTime = time(now instanceof Date ? now.toISOString() : now)
  if (!Number.isFinite(currentTime)) throw new TypeError('Momentum now must be a valid timestamp')
  // The router already bounds history to 80 rows/24 hours and rejects speculative media.
  const normalized = normalizeMessages({ messages, now: currentTime }).map(message => {
    const stem = message.caption.replace(/[，。！!~～\s]/g, '')
    if (/^(?:(?:嗯|哦|啊|哈|嘿)+|还行|还好|挺好|一般|好|行|好的|ok)+$/i.test(stem) && message.classification !== 'CLOSING') return { ...message, classification: 'ACK' }
    return message
  })
  const seen = new Set()
  const unique = normalized.filter(message => { if (seen.has(message.messageId)) return false; seen.add(message.messageId); return true })
  const turns = recentTurns(unique)
  const recent = turns.flatMap(turn => turn.messages)
  const incoming = recent.filter(message => message.senderRole === 'contact')
  const owner = recent.filter(message => message.senderRole === 'me')
  const latest = unique.at(-1)
  const metrics = relationMetrics(unique.map(message => ({ role: message.senderRole, text: message.caption, at: message.at })), new Date(currentTime))
  const reciprocity = {
    questionsByMe: owner.filter(question).length,
    questionsByOther: incoming.filter(question).length,
    selfDisclosureByMe: owner.filter(disclosure).length,
    selfDisclosureByOther: incoming.filter(disclosure).length,
    windowTurns: turns.length,
  }
  const reasons = []
  const contactTurns = turns.filter(turn => turn.senderRole === 'contact')
  const substantiveTurns = contactTurns.filter(turn => turn.messages.some(meaningful))
  const longReplies = contactTurns.filter(turn => turn.messages.reduce((total, message) => total + [...message.caption].length, 0) >= 24 && turn.messages.some(meaningful)).length
  let shortStreak = 0
  for (let index = incoming.length - 1; index >= 0 && ['ACK', 'REACTION'].includes(incoming[index].classification); index--) shortStreak++
  const ended = latest?.senderRole === 'contact' && latest.classification === 'CLOSING'
  const denied = latest?.senderRole === 'contact' && refusal(latest)
  let score = incoming.length ? 0.35 : 0.1
  if (substantiveTurns.length) { score += Math.min(0.28, substantiveTurns.length * 0.09); reasons.push('对方主动提供有内容的接话') }
  if (reciprocity.questionsByOther) { score += Math.min(0.16, reciprocity.questionsByOther * 0.08); reasons.push('对方提出直接问题') }
  if (reciprocity.selfDisclosureByOther) { score += Math.min(0.15, reciprocity.selfDisclosureByOther * 0.05); reasons.push('对方补充本人经历或感受') }
  if (longReplies) { score += Math.min(0.16, longReplies * 0.08); reasons.push('对方回复包含较多内容') }
  if (substantiveTurns.length >= 2 && turns.some(turn => turn.senderRole === 'me' && turn.messages.some(meaningful))) { score += 0.1; reasons.push('双方连续进行有意义的接话') }
  if (shortStreak) { score -= Math.min(0.5, shortStreak * (shortStreak >= 2 ? 0.16 : 0.04)); reasons.push(shortStreak >= 2 ? '对方连续简短确认或反应，降低介入' : '最新消息是轻量反应') }
  if (metrics.unansweredOutgoing) { score -= Math.min(0.5, metrics.unansweredOutgoing * 0.17); reasons.push('本人最近发言尚未获得回复') }
  const lastContactAt = time(incoming.at(-1)?.at)
  if (Number.isFinite(lastContactAt) && lastContactAt <= currentTime) {
    const elapsed = currentTime - lastContactAt
    if (elapsed > ATTENTION_WINDOW_MS) { score *= elapsed >= 60 * 60000 ? 0.4 : elapsed >= 15 * 60000 ? 0.65 : 0.85; reasons.push('最近互动随时间衰减，仅反映当前会话') }
  } else if (incoming.length) reasons.push('缺少可信互动时间，不建立热聊窗口')
  score = round(clamp(score))
  const level = ended || denied ? 'ENDING' : score >= 0.65 ? 'HIGH' : score >= 0.35 ? 'MEDIUM' : 'LOW'
  if (ended || denied) reasons.push(denied ? '对方明确要求停止交流' : '对方明确结束当前聊天')
  const routerSilent = attention?.recommendedMode === 'NO_REPLY'
  const selected = attention?.selectedFocus
  const naturalThreadEnd = attention?.naturalTopicEnd === true && latest && !question(latest) && latest.classification !== 'CLOSING' && !refusal(latest)
  const validReturn = !selected && latest?.senderRole === 'contact' && (latest.classification === 'ACK' && shortStreak === 1 || naturalThreadEnd) && ['HIGH', 'MEDIUM'].includes(level) && (Array.isArray(state?.returnCandidates) ? state.returnCandidates : []).some(candidate => candidate && candidate.allowedNow === true && text(candidate.summary) && Array.isArray(candidate.sourceMessageIds) && candidate.sourceMessageIds.some(id => typeof id === 'string' && id) && Array.isArray(candidate.openPointIds) && candidate.openPointIds.some(id => typeof id === 'string' && id) && !candidate.resolved && !['resolved', 'cancelled', 'closed'].includes(candidate.status))
  const window = attentionWindow(unique, currentTime, !routerSilent && !['LOW', 'ENDING'].includes(level) && metrics.unansweredOutgoing < 2)
  // Media meaning is accepted only from the router's prevalidated, unresolved
  // focus, never from arbitrary failed image text or guessed emotion fields.
  const semanticFocus = selected && selected.resolved !== true && selected.eligible !== false && latest?.senderRole === 'contact' && selected.messageId === latest.messageId && Boolean(selected.socialMeaning || Array.isArray(selected.emotion) && selected.emotion.length || /image|album|图片|照片/i.test(selected.type || '') && selected.summary)
  const directQuestion = !ended && !denied && latest?.senderRole === 'contact' && (question(latest) || selected?.messageId === latest.messageId && selected.directQuestion === 1)
  const pressure = metrics.consecutiveQuestions >= 2 || metrics.questionPressure > 0.55
  let allowQuestion = !pressure && !['LOW', 'ENDING'].includes(level) && !routerSilent
  let strategy, reason, preferSelfDisclosure = false
  const hasSelf = trustedSelfInformation(selfPersona)
  const imbalanced = reciprocity.questionsByMe >= 2 && reciprocity.selfDisclosureByMe === 0
  if (ended || denied) { strategy = denied ? 'NO_REPLY' : 'CLOSE'; allowQuestion = false; reason = '尊重明确结束，不恢复旧话题' }
  else if (directQuestion) { strategy = 'ANSWER'; reason = '直接回答对方问题，低参与度也不改为追问'; allowQuestion = allowQuestion && !pressure }
  else if (validReturn) { strategy = 'RETURN_TOPIC'; reason = '仅使用 State 提供的真实可返回话题'; allowQuestion = !pressure }
  else if (routerSilent || !latest || latest.senderRole === 'me' || level === 'LOW' && !meaningful(latest) && !semanticFocus) { strategy = 'NO_REPLY'; allowQuestion = false; reason = '不覆盖路由静默或连续轻反应保护，不追加单边消息' }
  else if (level === 'LOW') { strategy = 'LIGHT_HOOK'; allowQuestion = false; reason = '低参与度仍回应对方有意义的新内容，不继续提问' }
  else if (imbalanced && hasSelf) { strategy = 'SHARE'; preferSelfDisclosure = true; allowQuestion = false; reason = '提问偏多且未自述，优先分享已提供的真实本人资料' }
  else if (imbalanced) { strategy = 'LIGHT_HOOK'; allowQuestion = false; reason = '缺少真实本人资料，轻量接话且不编造经历' }
  else if (level === 'HIGH' && selected) { strategy = 'DEEPEN'; reason = '对方持续投入，围绕已选焦点展开' }
  else { strategy = 'LIGHT_HOOK'; reason = imbalanced && !hasSelf ? '缺少真实本人资料，轻量接话且不编造经历' : '保持轻量接话，避免过度深入'; if (imbalanced) allowQuestion = false }
  // Previous momentum is never a source of new personal facts or a reason to
  // keep a reaction-only conversation alive. Repeated input remains idempotent.
  void previousMomentum
  return { engagement: { score: ended || denied ? 0 : score, level, reasons }, reciprocity, attentionWindow: window, continuation: { strategy, allowQuestion, preferSelfDisclosure, reason }, updatedAt: iso(currentTime) }
}

module.exports = { ATTENTION_WINDOW_MS, LEVELS, STRATEGIES, buildConversationMomentum }
