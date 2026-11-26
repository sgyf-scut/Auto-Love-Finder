// Short-lived, evidence-bound conversation attention. No network, memory writes or sending.
const CLASSIFICATIONS = Object.freeze(['TOPIC_CONTENT', 'NEW_INFORMATION', 'QUESTION', 'REACTION', 'ACK', 'CLOSING', 'TOPIC_SHIFT'])
const MODES = Object.freeze(['RESPOND_FOCUS', 'CONTINUE_TOPIC', 'NO_REPLY', 'START_NEW_TOPIC'])
const DEFAULT_WEIGHTS = Object.freeze({ topicRelevance: 0.30, replyValue: 0.25, unresolvedValue: 0.20, emotionalWeight: 0.10, directQuestion: 0.10, recency: 0.05 })
const TTL_MS = 24 * 60 * 60 * 1000
const SOURCE_TYPES = new Set(['unfinished_topic', 'event', 'shared_interest', 'self_experience', 'open_point', 'followup', 'openPoint', 'follow_up'])
const clusters = [
  ['考研', '备考', '刷题', '数学', '学校', '北航', '北京', '研究生', '目标', '院校', '保研', '备选', '复习'],
  ['面试', '工作', '岗位', '公司', '上班', '求职', '简历', 'offer'],
  ['旅游', '旅行', '出发', '景点', '酒店', '机票', '到达'],
  ['考试', '复习', '成绩', '挂科', '答辩', '论文'],
  ['游戏', '上分', '排位', '队友', '王者', '英雄联盟'],
  ['宠物', '猫', '狗', '仓鼠'], ['音乐', '演唱会', '歌手'], ['电影', '电视剧', '追剧']
]
const text = (v, max = 1200) => typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : ''
const timestamp = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null }
const round = n => Math.round(n * 10000) / 10000
const unique = list => [...new Set(list.filter(Boolean))]

function normalizeWeights(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Attention weights must be an object')
  if (Object.keys(input).some(k => !Object.hasOwn(DEFAULT_WEIGHTS, k))) throw new TypeError('Unknown attention weight')
  const values = { ...DEFAULT_WEIGHTS, ...input }
  if (Object.values(values).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new TypeError('Attention weights must be finite nonnegative numbers')
  const total = Object.values(values).reduce((a, b) => a + b, 0)
  if (total <= 0) throw new TypeError('Attention weights cannot all be zero')
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value / total]))
}

function words(value) {
  const content = text(value)
  const terms = clusters.flat().filter(term => content.includes(term))
  const free = content.replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(v => v.length >= 2 && v.length <= 16)
  return unique([...terms, ...free])
}
function overlap(a, b) {
  const left = words(a), right = words(b)
  if (left.some(term => right.includes(term))) return 1
  if (clusters.some(group => group.some(v => a.includes(v)) && group.some(v => b.includes(v)))) return 0.7
  return 0
}
function plainCaption(value) { return text(value).replace(/\[(?:图片|照片|相册|表情包?|动图|视频|image|album|sticker|gif|media)[^\]]*\]/gi, '').trim() }
function isQuestion(value) {
  const s = text(value).replace(/[“「『"].*?[”」』"]/g, '')
  if (!s || /(?:谁不是|这谁顶得住|谁受得了|怎么可能|难道不是|还用问|谁知道|这还用说|这谁能|谁能想到|何必呢)/.test(s)) return false
  if (/^(?:他说|她说|别人问|老师问|有人问|引用|转发)[：:\s]/.test(s)) return false
  // First-person learning/uncertainty is information, not automatically a
  // question to the owner merely because it contains how/which.
  if (!/[?？]/.test(s) && !/(?:你|您).{0,30}(?:怎么|如何|哪|什么|觉得)|想问|请教|请问|能不能|帮我/.test(s) && /^我.{0,45}(?:了解|学习|研究|考虑|准备|不知道|没想好).*(?:怎么|如何|哪)/.test(s)) return false
  return /[?？]|(?:你|您).{0,30}(?:吗|么|呢|没|啥|什么|怎么|哪|几|谁)|(?:什么|怎么|为啥|为什么|几[点岁天]|哪[里个儿]|咋样|有没有)|(?:有|去|来|吃|睡|考|准备).{0,20}(?:没|吗)[呀啊呢吧]?$/.test(s)
}
function classifyMessage(message) {
  const s = message.text, caption = message.caption
  const shortStem = caption.replace(/(?:[哈嘿呵]{2,}|😂|🤣)+[！!。\s~～]*$/, '').trim()
  if (/^(?:不聊了|别再(?:问|聊|发)|别(?:问|发消息)|不要再|别联系|到此为止|不想聊|不用回复|别回了)|(?:我要睡了|我先睡了|睡了|晚安|先这样|回头聊|下次聊|拜拜|再见)[呀啊啦吧哦哈！!。\s]*$/.test(shortStem || caption)) return 'CLOSING'
  if (isQuestion(caption)) return 'QUESTION'
  if (/^(?:哈哈[哈啊嘿呵嗝]*|呵呵|嘿嘿|笑死(?:我了)?|笑死|哈哈还好|还好哈哈|😂|🤣|😅|🙄|🤭|[哈嘿呵]+)[！!。\s~～]*$/.test(caption)) return 'REACTION'
  if (/^(?:好[的吧呀啊哦]?|行[吧呀啊]?|嗯[嗯哼]?|哦[哦噢]?|ok|okay|收到|可以[呀啊]?|确实(?:挺卷)?|那挺卷|确实挺卷|是[的啊]|对[的啊]?|还好)[！!。\s~～]*$/i.test(shortStem || caption)) return 'ACK'
  if (!caption && message.isMedia) {
    if (message.hasMediaObservation && /^(?:image|album|图片|照片)$/i.test(message.type)) return 'TOPIC_CONTENT'
    return message.mediaUnderstood && message.socialMeaning ? 'REACTION' : 'ACK'
  }
  if (/^(?:对了|说起来|换个话题|不说这个|另外|话说)/.test(caption)) return 'TOPIC_SHIFT'
  if (/(?:刚刚|刚|今天|昨天|明天|下周|最近|正在|准备|打算|决定|开始|结束|完成|拿到|确定|推迟)/.test(s)) return 'NEW_INFORMATION'
  return 'TOPIC_CONTENT'
}

function normalizeMessages({ messages = [], mediaInterpretations = [], now = Date.now() } = {}) {
  const currentTime = timestamp(now) ?? Date.now()
  const mediaMap = new Map()
  const mediaEntries = Array.isArray(mediaInterpretations) ? mediaInterpretations : mediaInterpretations && typeof mediaInterpretations === 'object' ? Object.entries(mediaInterpretations).map(([id, value]) => ({ ...value, messageId: value?.messageId || id })) : []
  for (const media of mediaEntries) { if (media && (media.messageId || media.id)) mediaMap.set(text(media.messageId || media.id, 200), media) }
  return (Array.isArray(messages) ? messages : []).slice(-80).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []
    const senderRole = raw.senderRole || raw.role
    if (!['me', 'contact', 'incoming', 'outgoing', 'user', 'assistant'].includes(senderRole)) return []
    const at = timestamp(raw.at || raw.timestamp || raw.createdAt)
    if (at !== null && (at > currentTime + 60000 || currentTime - at > TTL_MS)) return []
    const messageId = text(raw.messageId || raw.id, 200) || `attention_${index}`
    const interpretation = mediaMap.get(messageId) || raw.interpretation || raw.mediaInterpretation || null
    const type = text(raw.type || raw.kind || interpretation?.type || 'text', 40)
    const isMedia = /image|album|sticker|gif|图片|照片|表情|动图/i.test(type) || /^\[(?:图片|照片|表情包?|动图|image|album|sticker|gif)\]$/i.test(text(raw.text))
    const caption = plainCaption(raw.text || raw.content || interpretation?.originalText)
    const mediaUnderstood = interpretation?.understandingStatus === 'understood'
    const reliableMedia = mediaUnderstood && typeof interpretation.confidence === 'number' && interpretation.confidence >= 0.5
    const socialMeaning = reliableMedia ? text(interpretation.socialMeaning, 800) : ''
    const visualDescription = reliableMedia ? text(interpretation.visualDescription, 700) : ''
    const textInImage = reliableMedia ? text(interpretation.textInImage, 700) : ''
    const hasMediaObservation = isMedia && Boolean(visualDescription || textInImage)
    const value = { messageId, senderRole: ['me', 'outgoing', 'assistant'].includes(senderRole) ? 'me' : 'contact', text: text(raw.text || raw.content || interpretation?.originalText), caption, at: at === null ? '' : new Date(at).toISOString(), type, isMedia, mediaUnderstood, hasMediaObservation, visualDescription, textInImage, socialMeaning, emotion: reliableMedia && Array.isArray(interpretation.emotion) ? interpretation.emotion.filter(v => typeof v === 'string') : [], sourceIndex: index }
    if (!value.text && !isMedia) return []
    value.classification = classifyMessage(value)
    value.role = value.classification // Legacy attention output alias, never sender semantics.
    value.directQuestion = value.senderRole === 'contact' && value.classification === 'QUESTION'
    return [value]
  })
}

function answered(message, messages, processedIds) {
  if (processedIds.has(message.messageId)) return true
  const following = messages.filter(item => item.sourceIndex > message.sourceIndex)
  // A reaction or vague agreement is not a specific answer or topic expansion.
  return following.some(item => item.senderRole === 'me' && item.caption && (
    message.directQuestion && /^(?:是的|对的|对啊|不是|不是的|没有|有|是|对)[呀啊哦！!。\s]*$/.test(item.caption)
    || !['ACK', 'REACTION', 'CLOSING'].includes(item.classification) && (message.directQuestion && item.classification !== 'QUESTION' && !/^(?:对了|另外|换个话题|话说)/.test(item.caption) || overlap(message.caption, item.caption) > 0)
  ))
}

function processedIds(options, previous) {
  const ids = [...(Array.isArray(options.processedFocusIds) ? options.processedFocusIds : []), ...(Array.isArray(previous?.processedFocusIds) ? previous.processedFocusIds : [])]
  const decision = previous?.lastDecision
  if (decision?.processed === true || decision?.sent === true || decision?.status === 'sent' || decision?.status === 'no_reply') ids.push(decision.focusMessageId || decision.selectedFocus?.messageId)
  return new Set(ids.filter(v => typeof v === 'string').slice(-80))
}

function validPrevious(options, now) {
  const old = options.previousState
  if (!old || typeof old !== 'object' || Array.isArray(old)) return null
  const updated = timestamp(old.updatedAt || old.activeTopic?.lastActiveAt)
  return updated !== null && now - updated >= 0 && now - updated <= TTL_MS ? old : null
}

function normalizeSources(sources, now, processed = new Set()) {
  return (Array.isArray(sources) ? sources : []).slice(0, 30).flatMap(source => {
    if (!source || typeof source !== 'object' || !SOURCE_TYPES.has(source.type) || source.resolved || source.status === 'resolved' || source.status === 'cancelled' || source.enabled === false) return []
    const summary = text(source.summary || source.description || source.text, 500)
    const ids = unique((Array.isArray(source.sourceMessageIds) ? source.sourceMessageIds : []).map(v => text(v, 200)))
    const evidenceId = text(source.evidenceId || source.eventId || source.id, 200)
    if (!summary || (!ids.length && !evidenceId) || source.ownership === 'unknown' || source.confidence !== undefined && (!Number.isFinite(source.confidence) || source.confidence < 0.5)) return []
    if (ids.length && ids.every(id => processed.has(id))) return []
    if (source.type === 'event') {
      const start = timestamp(source.windowStart || source.followUpWindow?.start || source.followUpAt)
      const end = timestamp(source.windowEnd || source.followUpWindow?.end || source.expiresAt)
      if (start === null || now < start || end !== null && now > end || source.windowEligible === false) return []
    }
    return [{ type: source.type, summary, sourceMessageIds: ids, evidenceId }]
  })
}

function buildTopicState(options = {}) {
  const now = timestamp(options.now ?? Date.now()) ?? Date.now()
  const messages = normalizeMessages({ ...options, now })
  const previous = validPrevious(options, now)
  const done = processedIds(options, previous)
  const content = messages.filter(m => m.caption && !['ACK', 'REACTION', 'CLOSING'].includes(m.classification))
  let evidence = [], activeTopic = null
  const lastShift = content.findLast(m => m.classification === 'TOPIC_SHIFT' && !m.directQuestion)
  const topicContent = lastShift ? content.filter(m => m.sourceIndex >= lastShift.sourceIndex) : content
  if (previous?.activeTopic?.summary && Array.isArray(previous.activeTopic.sourceMessageIds) && previous.activeTopic.sourceMessageIds.length && !lastShift) {
    activeTopic = { ...previous.activeTopic, sourceMessageIds: unique(previous.activeTopic.sourceMessageIds.map(v => text(v, 200))) }
    evidence = topicContent.filter(m => overlap(activeTopic.summary, m.caption) > 0 && !m.directQuestion)
  } else {
    const first = topicContent.find(m => m.senderRole === 'contact' && !m.directQuestion) || topicContent.find(m => !m.directQuestion)
    if (first) evidence = topicContent.filter(m => !m.directQuestion && (m === first || overlap(first.caption, m.caption) > 0))
    if (evidence.length) activeTopic = { id: `topic_${evidence[0].messageId}`, summary: unique(evidence.map(m => m.caption)).join('；').slice(0, 600), sourceMessageIds: evidence.map(m => m.messageId), startedAt: evidence[0].at || new Date(now).toISOString(), lastActiveAt: evidence.at(-1).at || new Date(now).toISOString(), status: 'active', engagement: 'medium' }
  }
  if (activeTopic && evidence.length) {
    const additions = evidence.filter(m => !activeTopic.sourceMessageIds.includes(m.messageId))
    if (additions.length) activeTopic.summary = unique([activeTopic.summary, ...additions.map(m => m.caption)]).join('；').slice(0, 600)
    activeTopic.sourceMessageIds = unique([...activeTopic.sourceMessageIds, ...evidence.map(m => m.messageId)]).slice(-40)
    activeTopic.lastActiveAt = evidence.at(-1).at || activeTopic.lastActiveAt
  }
  const latest = messages.at(-1) || null
  const unanswered = messages.filter(m => m.senderRole === 'contact' && m.caption && !['ACK', 'REACTION', 'CLOSING'].includes(m.classification) && !answered(m, messages, done))
  const openPoints = unanswered.filter(m => m.directQuestion || /(?:难|担心|纠结|没(?:想|定|决定|确定)|还没|不知道|考虑|备选|目标|准备|打算|决定)/.test(m.caption)).map(m => ({ id: `point_${m.messageId}`, summary: m.caption, sourceMessageIds: [m.messageId] })).slice(-8)
  const closed = latest?.classification === 'CLOSING'
  const engagement = closed || !unanswered.length ? 'low' : unanswered.some(m => m.directQuestion) ? 'high' : 'medium'
  if (activeTopic) { activeTopic.engagement = engagement; activeTopic.status = closed || !unanswered.length ? 'closed' : 'active' }
  const subTopics = unique(evidence.flatMap(m => words(m.caption))).slice(0, 12)
  return { version: 1, activeTopic, subTopics, openPoints, engagement, latestMessageRole: latest?.classification || 'ACK', updatedAt: new Date(now).toISOString(), processedFocusIds: [...done], messagesAnalyzed: messages.length }
}

function scoreRecentMessages(options = {}) {
  const messages = normalizeMessages(options)
  const state = options.state || buildTopicState(options)
  const now = timestamp(options.now ?? Date.now()) ?? Date.now()
  const done = processedIds(options, validPrevious(options, now))
  const weights = normalizeWeights(options.weights)
  const limit = Number.isInteger(options.recentLimit) ? Math.max(1, Math.min(20, options.recentLimit)) : 5
  const recent = messages.slice(-limit)
  return recent.map((m, index) => {
    const resolved = m.senderRole === 'me' || answered(m, messages, done)
    const light = ['ACK', 'REACTION', 'CLOSING'].includes(m.classification)
    const directQuestion = m.directQuestion && !resolved ? 1 : 0
    const emotionalWeight = /难|担心|难过|伤心|崩溃|害怕|焦虑|累|开心|激动|生气|难受/.test(m.caption) || m.emotion.some(e => ['sad', 'angry', 'frustrated'].includes(e)) ? 0.8 : m.emotion.some(e => ['amused', 'playful', 'surprised'].includes(e)) ? 0.25 : 0.05
    const components = {
      topicRelevance: light ? 0.08 : state.activeTopic ? 0.25 + 0.7 * overlap(state.activeTopic.summary, m.caption) : 0.5,
      replyValue: m.classification === 'QUESTION' ? 0.98 : m.classification === 'CLOSING' ? 0 : m.classification === 'ACK' ? 0.03 : m.classification === 'REACTION' ? 0.10 : /难|担心|纠结|准备|目标|打算/.test(m.caption) ? 0.9 : 0.7,
      unresolvedValue: resolved ? 0 : light ? 0 : m.directQuestion ? 1 : /难|担心|纠结|准备|目标|打算/.test(m.caption) ? 0.9 : 0.65,
      emotionalWeight, directQuestion, recency: recent.length === 1 ? 1 : (index + 1) / recent.length
    }
    const eligible = m.senderRole === 'contact' && !resolved && m.classification !== 'CLOSING' && (Boolean(m.caption) || m.mediaUnderstood && Boolean(m.socialMeaning) || m.hasMediaObservation)
    const score = eligible ? Object.entries(weights).reduce((sum, [key, weight]) => sum + components[key] * weight, 0) : 0
    const mediaSummary = unique([m.visualDescription && `当前画面观察：${m.visualDescription}`, m.textInImage && `图中文字（归属未确认）：${m.textInImage}`, m.socialMeaning]).join('；').slice(0, 1200)
    return { messageId: m.messageId, senderRole: m.senderRole, classification: m.classification, role: m.classification, text: m.text, summary: m.caption || mediaSummary, socialMeaning: m.socialMeaning, emotion: m.emotion, type: m.type, sourceIndex: m.sourceIndex, resolved, eligible, ...Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round(v)])), score: round(score), reason: resolved ? '已具体回应或已处理，不重复接话' : !eligible ? '本人消息或媒体语义未知，不作为对方焦点' : directQuestion ? '对方明确直接提问，优先回答' : light ? '轻量反应不替换主话题' : m.hasMediaObservation && !m.caption ? '只回应当前媒体观察，画面与OCR归属未确认' : '尚未具体展开的信息' }
  }).sort((a, b) => b.score - a.score || b.sourceIndex - a.sourceIndex)
}

function selectFocus(scored = [], { latestMessage } = {}) {
  if (latestMessage?.classification === 'CLOSING') return null
  const eligible = scored.filter(m => m.eligible && !m.resolved)
  const direct = eligible.filter(m => m.directQuestion > 0).sort((a, b) => b.sourceIndex - a.sourceIndex)[0]
  if (direct) return direct
  return eligible.find(m => m.score >= 0.32 && !['ACK', 'REACTION'].includes(m.classification)) || eligible.find(m => m.classification === 'REACTION' && m.socialMeaning && m.emotionalWeight >= 0.25) || null
}

function recommendFocusMode({ state, selectedFocus, latestMessage, topicSources = [], now = Date.now() } = {}) {
  if (latestMessage?.classification === 'CLOSING') return { mode: 'NO_REPLY', reason: '对方明确结束或拒绝继续，尊重结束信号' }
  if (latestMessage?.senderRole === 'me') return { mode: 'NO_REPLY', reason: '最近是本人消息，等待对方回复' }
  if (selectedFocus?.directQuestion > 0) return { mode: 'RESPOND_FOCUS', reason: '优先回应对方尚未回答的直接问题' }
  if (selectedFocus) {
    const continuing = state?.activeTopic?.status === 'active' && selectedFocus.classification !== 'REACTION' && ['ACK', 'REACTION'].includes(latestMessage?.classification) && selectedFocus.messageId !== latestMessage?.messageId
    return { mode: continuing ? 'CONTINUE_TOPIC' : 'RESPOND_FOCUS', reason: continuing ? '最新只是轻量反应，继续前文尚未展开的主话题' : '回应最近消息中的有效信息或情绪' }
  }
  const sources = normalizeSources(topicSources, timestamp(now) ?? Date.now(), new Set(state?.processedFocusIds || []))
  // Starting another subject requires a naturally exhausted thread; an unknown image is not closure.
  if (['ACK', 'REACTION'].includes(latestMessage?.classification) && (!state?.activeTopic || state.activeTopic.status === 'closed') && sources.length && (latestMessage?.caption || latestMessage?.mediaUnderstood)) return { mode: 'START_NEW_TOPIC', reason: '原话题已自然结束，使用已有证据的新话题', topicSource: sources[0] }
  return { mode: 'NO_REPLY', reason: '没有未回应的有效焦点或适合继续的话题' }
}

function buildAttentionContext(options = {}) {
  const state = buildTopicState(options)
  const messages = normalizeMessages(options)
  const latestMessage = messages.at(-1) || null
  const scored = scoreRecentMessages({ ...options, state })
  const selectedFocus = selectFocus(scored, { latestMessage })
  const recommendation = recommendFocusMode({ ...options, state, scored, selectedFocus, latestMessage })
  return { activeTopic: state.activeTopic, subTopics: state.subTopics, openPoints: state.openPoints, engagement: state.engagement, latestMessage, latestMessageRole: state.latestMessageRole, rankedFocusCandidates: scored, selectedFocus, recommendedMode: recommendation.mode, reason: recommendation.reason, topicSource: recommendation.topicSource || null, weights: normalizeWeights(options.weights), state }
}

module.exports = { CLASSIFICATIONS, MODES, DEFAULT_WEIGHTS, TTL_MS, normalizeWeights, classifyMessage, normalizeMessages, normalizeSources, buildTopicState, scoreRecentMessages, selectFocus, recommendFocusMode, buildAttentionContext }
