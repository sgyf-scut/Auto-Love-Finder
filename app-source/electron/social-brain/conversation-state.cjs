// Evidence-bound conversation threads. This module neither writes memory nor sends messages.
const { classifyMessage } = require('./conversation-attention.cjs')
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_TOPICS = 12
const GROUPS = [
  ['考研', ['考研', '保研', '备考', '研究生考试', '北航', '院校', '目标学校', '学校', '刷题']],
  ['学业', ['开题', '论文', '答辩', '导师', '课题', '教授']],
  ['求职', ['面试', '求职', '简历', '岗位', 'offer', '工作', '上班', '公司']],
  ['旅行', ['旅游', '旅行', '出发', '机票', '车票', '酒店', '景点', '上海', '票', '旅程']],
  ['游戏', ['游戏', '王者', '英雄联盟', '排位', '上分', '队友']],
  ['影视', ['电影', '电视剧', '追剧']],
  ['音乐', ['音乐', '演唱会', '歌手']],
  ['宠物', ['宠物', '仓鼠', '小猫', '小狗', '养猫', '养狗']],
  ['生活', ['北京生活', '租房', '房租', '搬家', '通勤']]
]
const clean = (v, max = 500) => typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : ''
const time = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null }
const uniq = values => [...new Set(values.filter(v => typeof v === 'string' && v))]
const iso = v => new Date(v).toISOString()
const clone = v => JSON.parse(JSON.stringify(v))
const ends = value => /(?:睡了|晚安|不聊了|不想聊|不要再聊|别再问|别问了|不用回复|先这样|下次聊|回头聊|拜拜|再见)[呀啊啦吧哦哈！!。\s]*$/.test(value)
const refusal = value => /不想聊|不聊这个|别(?:再)?(?:问|聊|联系)|不要再|不用回复|别回了/.test(value)
const naturalEnd = value => /^(?:这事就这样|这个先这样|这个话题先这样|说完了|没别的了|就这些|这个搞定了)[呀啊吧！!。\s]*$/.test(value)
const uncertainty = value => /还没(?:有)?(?:定|决定|确定|想好|买|订)|没(?:完全)?(?:定|确定|决定)|尚未|不知道|纠结|待定|考虑中|还在考虑/.test(value)
const resolved = value => !uncertainty(value) && /(?:确定了|决定了|定下来了|定了|决定(?:考|去|选|报|买)|选好了|买好了|买好票|票买了|订好了|解决了|搞定了|已经完成|面完了|考完了|答辩结束|回来了)/.test(value)
const cancelled = value => /(?:取消了|不考了|不去了|不面了|不参加了|不准备了|放弃了|算了不)/.test(value)
const contentPrefix = value => value.replace(/^(?:对了|另外|话说|说起来|换个话题|不说这个了?)[，,：:\s]*/, '')
function groupOf(value) {
  const found = GROUPS.map(([key, terms]) => ({ key, score: terms.reduce((n, term) => n + (value.includes(term) ? Math.min(term.length, 4) : 0), 0) })).filter(v => v.score)
  found.sort((a, b) => b.score - a.score)
  return found[0]?.key || ''
}
function captionOf(raw) {
  // Captions are evidence; image OCR, descriptions and quoted text are not autobiographical evidence.
  const value = clean(raw.text || raw.content, 1200).replace(/\[(?:图片|照片|相册|表情包?|动图|视频|image|album|sticker|gif|media)[^\]]*\]/gi, '').trim()
  if (/^(?:他说|她说|别人说|老师说|有人说|朋友说|同事说)/.test(value)
    || /^(?:别人问|老师问|引用|转发|文案|评论)[：:\s]/.test(value)) return ''
  return value.replace(/[“「『"].*?[”」』"]/g, '').trim()
}
function messagesFor(messages, contactId, now) {
  const seen = new Set()
  return (Array.isArray(messages) ? messages : []).slice(-240).flatMap(raw => {
    if (!raw || typeof raw !== 'object' || raw.contactId && clean(String(raw.contactId), 200) !== contactId) return []
    const role = raw.senderRole || raw.role
    if (!['contact', 'incoming', 'user', 'me', 'outgoing', 'assistant'].includes(role)) return []
    const messageId = clean(raw.messageId || raw.id, 200)
    if (!messageId || seen.has(messageId)) return []
    const at = time(raw.at || raw.timestamp || raw.createdAt)
    if (at !== null && (at > now + 60000 || now - at > TTL_MS)) return []
    seen.add(messageId)
    const caption = captionOf(raw)
    const type = clean(raw.type || raw.kind || 'text', 40)
    const isMedia = /image|album|sticker|gif|图片|照片|表情|动图/.test(type)
    const row = { messageId, senderRole: ['me', 'outgoing', 'assistant'].includes(role) ? 'me' : 'contact', caption, text: caption, at: iso(at ?? now), type, isMedia }
    row.classification = classifyMessage(row)
    return [row]
  })
}
function evidenceFor(message) {
  return { messageId: message.messageId, text: message.caption, at: message.at, kind: message.classification === 'QUESTION' ? 'contact_question' : 'contact_utterance' }
}
function initialState(contactId, now) {
  return { version: 1, contactId, activeTopic: null, topicTree: [], pausedTopics: [], returnCandidates: [], openPoints: [], lastTransition: null, updatedAt: iso(now), processedMessageIds: [] }
}
function validEvidence(evidence, now) {
  return (Array.isArray(evidence) ? evidence : []).filter(v => v && clean(v.messageId, 200) && clean(v.text, 500) && ['contact_utterance', 'contact_question'].includes(v.kind) && time(v.at) !== null && now - time(v.at) <= TTL_MS && time(v.at) <= now + 60000).slice(-12)
}
function restore(previous, contactId, now) {
  const state = initialState(contactId, now)
  if (!previous || previous.version !== 1 || previous.contactId !== contactId || time(previous.updatedAt) === null || now - time(previous.updatedAt) > TTL_MS || time(previous.updatedAt) > now + 60000) return state
  const ids = new Set()
  state.topicTree = (Array.isArray(previous.topicTree) ? previous.topicTree : []).slice(-MAX_TOPICS).flatMap(raw => {
    const evidence = validEvidence(raw?.evidence, now)
    const id = clean(raw?.id, 240)
    const lastActive = time(raw?.lastActiveAt)
    if (!id || ids.has(id) || !evidence.length || lastActive === null || now - lastActive > TTL_MS || lastActive > now + 60000) return []
    ids.add(id)
    return [{ id, parentId: clean(raw.parentId, 240) || null, key: clean(raw.key, 100), summary: clean(raw.summary, 600), status: ['active', 'paused', 'closed', 'resolved', 'cancelled'].includes(raw.status) ? raw.status : 'paused', startedAt: evidence[0].at, lastActiveAt: iso(lastActive), sourceMessageIds: evidence.map(v => v.messageId), evidence, subtopic: clean(raw.subtopic, 160), returnBlocked: raw.returnBlocked === true }]
  })
  for (const node of state.topicTree) if (!ids.has(node.parentId)) node.parentId = null
  const activeId = previous.activeTopic?.id
  state.activeTopic = state.topicTree.find(v => v.id === activeId && v.status === 'active') || null
  state.openPoints = (Array.isArray(previous.openPoints) ? previous.openPoints : []).slice(-8).flatMap(raw => {
    const evidence = validEvidence(raw?.evidence, now)
    if (!raw || !ids.has(raw.topicId) || !clean(raw.id, 240) || !evidence.length || !['open', 'resolved', 'cancelled', 'answered'].includes(raw.status)) return []
    return [{ id: clean(raw.id, 240), topicId: raw.topicId, key: clean(raw.key, 120), kind: clean(raw.kind, 40), summary: clean(raw.summary, 600), sourceMessageIds: evidence.map(v => v.messageId), evidence, status: raw.status, createdAt: evidence[0].at, updatedAt: clean(raw.updatedAt, 40) || evidence.at(-1).at, contextMessageIds: uniq(raw.contextMessageIds || []).slice(-4) }]
  })
  state.processedMessageIds = uniq(previous.processedMessageIds || []).slice(-240)
  if (previous.lastTransition && ids.has(previous.lastTransition.toTopicId || previous.lastTransition.fromTopicId)) state.lastTransition = clone(previous.lastTransition)
  return state
}
function appendEvidence(node, message) {
  if (node.sourceMessageIds.includes(message.messageId)) return
  node.evidence = [...node.evidence, evidenceFor(message)].slice(-12)
  node.sourceMessageIds = node.evidence.map(v => v.messageId)
  node.summary = uniq([...node.evidence.map(v => v.text)]).join('；').slice(0, 600)
  node.lastActiveAt = message.at
}
function pointKey(value, topic, previousMe) {
  const context = previousMe?.caption || ''
  if (/学校|院校|北航|报考|考哪/.test(value + context) && topic.key === '考研') return 'school_choice'
  if (/票|机票|车票/.test(value + context)) return 'tickets'
  if (/酒店|住宿/.test(value + context)) return 'accommodation'
  if (topic.key === '求职' && /面试/.test(value + context)) return 'interview'
  return `${topic.key || 'literal'}:${/时间|几点|哪天/.test(value + context) ? 'time' : 'unfinished'}`
}
function maintainPoints(state, message, topic, previousMe) {
  if (!topic || !message.caption) return
  const same = state.openPoints.filter(v => v.topicId === topic.id && v.status === 'open')
  const key = pointKey(message.caption, topic, previousMe)
  if (cancelled(message.caption)) {
    for (const point of same) { point.status = 'cancelled'; point.updatedAt = message.at; point.evidence = [...point.evidence, evidenceFor(message)].slice(-12); point.sourceMessageIds = point.evidence.map(v => v.messageId) }
    topic.status = 'cancelled'; topic.returnBlocked = true
    return
  }
  if (resolved(message.caption)) {
    for (const point of same.filter(v => v.key === key || key.endsWith(':unfinished') && v.kind !== 'question')) {
      point.status = 'resolved'; point.updatedAt = message.at; point.evidence = [...point.evidence, evidenceFor(message)].slice(-12); point.sourceMessageIds = point.evidence.map(v => v.messageId)
    }
  }
  // Plans and uncertainties must be stated by the contact. An owner question alone cannot open a point.
  const isUnknown = uncertainty(message.caption) || previousMe?.classification === 'QUESTION' && /^(?:还没|没有|没呢)[呀啊哦！!。\s]*$/.test(message.caption)
  const future = /(?:准备|打算|计划|下周|明天|后天|下个月).{0,30}(?:去|考|面试|考试|答辩|旅行|旅游|开题|出发)/.test(message.caption)
  const concern = /担心|纠结|焦虑|有点难|感觉挺难/.test(message.caption)
  const question = message.classification === 'QUESTION'
  if (!isUnknown && !future && !concern && !question || resolved(message.caption) || cancelled(message.caption)) return
  const kind = question ? 'question' : isUnknown ? 'decision' : future ? 'event' : 'concern'
  const existing = same.find(v => v.key === key && v.kind === kind)
  if (existing) {
    existing.evidence = [...existing.evidence, evidenceFor(message)].slice(-12); existing.sourceMessageIds = existing.evidence.map(v => v.messageId)
    existing.summary = message.caption; existing.updatedAt = message.at
    if (previousMe) existing.contextMessageIds = uniq([...existing.contextMessageIds, previousMe.messageId]).slice(-4)
  } else state.openPoints.push({ id: `open_${message.messageId}`, topicId: topic.id, key, kind, summary: message.caption, sourceMessageIds: [message.messageId], evidence: [evidenceFor(message)], status: 'open', createdAt: message.at, updatedAt: message.at, contextMessageIds: previousMe ? [previousMe.messageId] : [] })
}
function newNode(message, key, parentId = null) {
  return { id: `thread_${message.messageId}`, parentId, key, summary: message.caption, status: 'active', startedAt: message.at, lastActiveAt: message.at, sourceMessageIds: [message.messageId], evidence: [evidenceFor(message)], subtopic: '', returnBlocked: false }
}
function transition(state, kind, from, to, message, confidence = 0.9) {
  state.lastTransition = { kind, confidence, fromTopicId: from?.id || null, toTopicId: to?.id || null, sourceMessageIds: [message.messageId], at: message.at }
}
function closeFromOwner(state, message) {
  if (!message.caption || ['QUESTION', 'ACK', 'REACTION', 'CLOSING'].includes(message.classification)) return
  for (const point of state.openPoints) {
    if (point.kind !== 'question' || point.status !== 'open') continue
    const node = state.topicTree.find(v => v.id === point.topicId)
    const sourceAt = time(point.updatedAt)
    // Only answer an actual contact question with a nearby substantive owner reply.
    if (node && sourceAt !== null && time(message.at) >= sourceAt && time(message.at) - sourceAt <= 60 * 60 * 1000 && (state.activeTopic?.id === node.id || groupOf(message.caption) === node.key)) {
      point.status = 'answered'; point.updatedAt = message.at; point.answerMessageId = message.messageId
    }
  }
}
function restoreFromOwnerContext(state, message) {
  if (!message.caption || ['ACK', 'REACTION', 'CLOSING'].includes(message.classification)) return
  const groups = GROUPS.filter(([, terms]) => terms.some(term => message.caption.includes(term)))
  if (groups.length !== 1) return
  const key = groups[0][0]
  const node = state.topicTree.findLast(v => v.key === key && v.status === 'paused' && !v.returnBlocked
    && state.openPoints.some(p => p.topicId === v.id && p.status === 'open'))
  if (!node || node.id === state.activeTopic?.id) return
  const active = state.activeTopic
  if (active) active.status = 'paused'
  node.status = 'active'; node.lastActiveAt = message.at; state.activeTopic = node
  // An actually recorded owner message may restore an existing thread, but is never contact evidence.
  state.lastTransition = { kind: 'return', confidence: 0.9, fromTopicId: active?.id || null, toTopicId: node.id,
    sourceMessageIds: [...node.sourceMessageIds], contextMessageIds: [message.messageId], origin: 'owner_sent_context', at: message.at }
}
function finalize(state, now, latestMessageId) {
  const activeId = state.activeTopic?.id
  const active = state.topicTree.find(v => v.id === activeId)
  state.topicTree = state.topicTree.sort((a, b) => (a.id === activeId ? 1 : b.id === activeId ? -1 : time(a.lastActiveAt) - time(b.lastActiveAt))).slice(-MAX_TOPICS)
  const ids = new Set(state.topicTree.map(v => v.id))
  for (const node of state.topicTree) if (!ids.has(node.parentId)) node.parentId = null
  state.activeTopic = active?.status === 'active' ? active : null
  state.openPoints = state.openPoints.filter(v => ids.has(v.topicId)).sort((a, b) => (a.status === 'open' ? 1 : b.status === 'open' ? -1 : time(a.updatedAt) - time(b.updatedAt))).slice(-8)
  state.pausedTopics = state.topicTree.filter(v => v.status === 'paused' && !v.returnBlocked).sort((a, b) => time(b.lastActiveAt) - time(a.lastActiveAt)).slice(0, 5)
  const blocked = state.lastTransition?.kind === 'close' || state.lastTransition?.kind === 'refusal'
  state.returnCandidates = blocked ? [] : state.pausedTopics.flatMap(node => {
    const points = state.openPoints.filter(v => v.topicId === node.id && v.status === 'open')
    if (!points.length || node.returnBlocked) return []
    return [{ id: `return_${node.id}`, topicId: node.id, summary: uniq(points.map(v => v.summary)).join('；').slice(0, 600), sourceMessageIds: uniq(points.flatMap(v => v.sourceMessageIds)), openPointIds: points.map(v => v.id), confidence: 0.9, allowedNow: state.lastTransition?.kind === 'natural_end' && state.lastTransition.sourceMessageIds.includes(latestMessageId), reason: '对方曾明确提到的暂停线程仍有未完成点；仅回提或自然结束后候选' }]
  }).slice(0, 4)
  state.processedMessageIds = uniq(state.processedMessageIds).slice(-240)
  state.updatedAt = iso(now)
  return state
}

function buildConversationState({ contactId, messages = [], attention = null, previousState = null, now = Date.now() } = {}) {
  const current = time(now) ?? Date.now()
  const owner = clean(typeof contactId === 'number' ? String(contactId) : contactId, 200)
  if (!owner) throw new TypeError('Conversation state requires a contactId')
  const state = restore(previousState, owner, current)
  const rows = messagesFor(messages, owner, current)
  const done = new Set(state.processedMessageIds)
  let previousMe = null
  for (const message of rows) {
    if (message.senderRole === 'me') previousMe = message
    if (done.has(message.messageId)) continue
    state.processedMessageIds.push(message.messageId); done.add(message.messageId)
    if (message.senderRole === 'me') { restoreFromOwnerContext(state, message); closeFromOwner(state, message); continue }
    if (!message.caption) continue
    const active = state.activeTopic
    if (refusal(message.caption) || ends(message.caption)) {
      if (active) { active.status = 'closed'; active.returnBlocked = true }
      transition(state, refusal(message.caption) ? 'refusal' : 'close', active, null, message, 1)
      state.activeTopic = null
      continue
    }
    if (naturalEnd(message.caption)) {
      if (active) active.status = 'closed'
      transition(state, 'natural_end', active, null, message, 0.98); state.activeTopic = null
      continue
    }
    if (['ACK', 'REACTION', 'CLOSING'].includes(message.classification)) {
      const lastRow = rows[rows.indexOf(message) - 1]
      const exhausted = attention && attention.selectedFocus === null && attention.latestMessage?.messageId === message.messageId
        && message.classification === 'ACK' && lastRow?.senderRole === 'me'
        && !['ACK', 'REACTION', 'QUESTION', 'CLOSING'].includes(lastRow.classification)
        && active && !state.openPoints.some(v => v.topicId === active.id && v.status === 'open')
      if (exhausted) { active.status = 'closed'; state.activeTopic = null; transition(state, 'natural_end', active, null, message, 0.9) }
      continue
    }
    const value = contentPrefix(message.caption)
    const group = groupOf(value)
    const explicitShift = /^(?:对了|另外|话说|换个话题|不说这个)/.test(message.caption)
    const explicitReturn = /^(?:说回|回到|继续说|还是说|之前那个|上次那个)|(?:之前|上次).{0,12}(?:说的|那个)|(?:后来|现在).{0,12}(?:定了|决定|买好)/.test(message.caption)
    const safePreviousMe = previousMe && time(message.at) - time(previousMe.at) >= 0 && time(message.at) - time(previousMe.at) <= 60 * 60 * 1000 ? previousMe : null
    // A terse answer may continue a known thread, but cannot manufacture a new one from the owner's question.
    if (!group && value.length < 5 && !active) continue
    let matching = group ? state.topicTree.findLast(v => v.key === group && !['cancelled'].includes(v.status) && v.id !== active?.id && (!v.returnBlocked || explicitReturn)) : null
    let node = active
    if (matching && (group !== active?.key || explicitReturn)) {
      if (active) active.status = 'paused'
      matching.status = 'active'; matching.returnBlocked = false; state.activeTopic = matching; node = matching
      transition(state, 'return', active, node, message)
    } else if (!active) {
      node = newNode(message, group || `literal:${value.slice(0, 40)}`); state.topicTree.push(node); state.activeTopic = node
      transition(state, 'new_topic', null, node, message, group ? 0.92 : 0.8)
    } else if (group && group !== active.key || explicitShift && value.length >= 5 && (!group || group !== active.key)) {
      const evolution = !explicitShift && (active.key === '考研' && group === '学业' || active.key === '学业' && group === '求职')
      active.status = 'paused'
      node = newNode(message, group || `literal:${value.slice(0, 40)}`, evolution ? active.id : null)
      state.topicTree.push(node); state.activeTopic = node
      transition(state, evolution ? 'progression' : explicitShift ? 'new_topic' : 'tangent', active, node, message)
    } else {
      // Only lexical subtopic evidence changes the tree; vague fillers keep the current node intact.
      const sub = group === active.key && /^(?:那|说到|关于|具体|其中|至于)/.test(message.caption) && value.length >= 7
      if (sub && !active.parentId) {
        active.status = 'paused'; node = newNode(message, active.key, active.id); node.subtopic = value.slice(0, 160)
        state.topicTree.push(node); state.activeTopic = node
        transition(state, 'subtopic', active, node, message, 0.9)
      } else if (group || uncertainty(value) || resolved(value) || cancelled(value) || message.classification === 'QUESTION'
        || safePreviousMe?.classification === 'QUESTION' && /^(?:还没|没有|没呢)[呀啊哦！!。\s]*$/.test(value)) {
        appendEvidence(node, message); transition(state, 'continuation', active, node, message, 0.9)
      } else continue
    }
    appendEvidence(node, message)
    maintainPoints(state, message, node, safePreviousMe)
    // A decision made in a subthread resolves a same-key unfinished parent decision as well.
    if (node.parentId && resolved(message.caption)) {
      const parent = state.topicTree.find(v => v.id === node.parentId)
      if (parent) maintainPoints(state, message, parent, safePreviousMe)
    }
    if (node.status === 'cancelled') state.activeTopic = null
  }
  // Attention is intentionally advisory: its OCR/socialMeaning/owner history cannot become topic evidence.
  void attention
  return finalize(state, current, rows.at(-1)?.messageId)
}

function compressConversationState(state) {
  if (!state || typeof state !== 'object') return null
  const nodes = Array.isArray(state.topicTree) ? state.topicTree : []
  const compact = node => node ? { id: node.id, parentId: node.parentId || null, summary: clean(node.summary, 600), status: node.status, sourceMessageIds: uniq(node.sourceMessageIds || []).slice(-12), lastActiveAt: node.lastActiveAt } : null
  const ancestors = [], seen = new Set()
  let parentId = state.activeTopic?.parentId
  while (parentId && ancestors.length < 3 && !seen.has(parentId)) {
    seen.add(parentId); const parent = nodes.find(v => v.id === parentId)
    if (!parent) break
    ancestors.push(compact(parent)); parentId = parent.parentId
  }
  return { version: 1, contactId: state.contactId, activeTopic: compact(state.activeTopic), ancestors, pausedTopics: (state.pausedTopics || []).slice(0, 5).map(compact), returnCandidates: (state.returnCandidates || []).slice(0, 4).map(v => ({ id: v.id, topicId: v.topicId, summary: clean(v.summary, 500), sourceMessageIds: uniq(v.sourceMessageIds || []).slice(-12), openPointIds: uniq(v.openPointIds || []).slice(0, 8), allowedNow: v.allowedNow === true, reason: clean(v.reason, 160) })), openPoints: (state.openPoints || []).filter(v => v.status === 'open').slice(-8).map(v => ({ id: v.id, topicId: v.topicId, kind: v.kind, summary: clean(v.summary, 500), sourceMessageIds: uniq(v.sourceMessageIds || []).slice(-12), contextMessageIds: uniq(v.contextMessageIds || []).slice(-4), status: v.status })), lastTransition: state.lastTransition ? clone(state.lastTransition) : null, updatedAt: state.updatedAt }
}

module.exports = { TTL_MS, MAX_TOPICS, buildConversationState, compressConversationState }
