// 素材分类器：先用确定性规则做安全类判断，再对剩余条目做批量模型标注。
// 只读文本，不推测作者性别/年龄/身份；每条结论必须带原文证据，证据不在原文即降权。
const { createHash } = require('node:crypto')

const CLASSIFIER_VERSION = 'v2'
const VIDEO_CATEGORIES = ['friend_general', 'friend_chat', 'friend_local', 'friend_interest', 'friend_romance', 'irrelevant', 'unknown']
const COMMENT_INTENTS = ['EXPLICIT_INVITATION', 'SEEKING_FRIENDS', 'CONTEXTUAL_INTEREST', 'ORDINARY', 'DO_NOT_CONTACT', 'ADVERTISEMENT', 'UNKNOWN']
// 前三类可进入候选审核队列，但意愿强度不同；只有 EXPLICIT_INVITATION 代表原话里存在接受私信的证据。
const CANDIDATE_INTENTS = ['EXPLICIT_INVITATION', 'SEEKING_FRIENDS', 'CONTEXTUAL_INTEREST']
const INTENT_RANK = { CONTEXTUAL_INTEREST: 1, SEEKING_FRIENDS: 2, EXPLICIT_INVITATION: 3 }

const LABELS = {
  friend_general: '交友综合', friend_chat: '交友聊天/找搭子', friend_local: '同城/本地交友',
  friend_interest: '兴趣同好', friend_romance: '相亲/恋爱倾向', irrelevant: '与交友无关', unknown: '不确定',
  EXPLICIT_INVITATION: '明确欢迎认识或私信', SEEKING_FRIENDS: '表达交友或找搭子意愿',
  CONTEXTUAL_INTEREST: '结合视频语境可能有交友意愿', ORDINARY: '普通或无关评论',
  DO_NOT_CONTACT: '明确拒绝联系', ADVERTISEMENT: '广告、重复或不适宜内容', UNKNOWN: '无法判断',
}

const RULES = {
  doNotContact: /(不要私信|别私信|勿扰|请勿打扰|不要打扰|别打扰|不加好友|不要加我|别加我|不想认识|别来找我|谢绝|不要联系我|别联系我)/,
  advertisement: /(加[vV微]|加微信|vx|VX|私信.{0,4}(领取|资料|购买|咨询)|代购|优惠|课程|返现|推广|引流|刷屏|复制粘贴)/,
  explicitInvitation: /(私信我|私我|dd我|滴滴我|加我|加个好友|留个?联系方式|想认识你|想认识一下|可以认识一下|认识一下|互关|交友dd|欢迎来聊|可以聊)/,
  seekingFriends: /(想找|找个|找朋友|想交朋友|想交个朋友|想认识新朋友|认识新朋友|找对象|找搭子|想脱单|求脱单|差.{0,4}(女朋友|男朋友|对象)|有没有人|求扩列|扩列|单身|有人一起|一起玩|组队)/,
  // 反向表述：说“不爱交朋友/不需要朋友”不是交友意愿，避免只按关键词误判。
  friendNegation: /(不爱交朋友|不想交朋友|不交朋友|不再交朋友|没必要交朋友|不需要.{0,8}朋友)/,
  contextualShort: /(dd|滴滴|蹲|蹲一个|有没有.{1,10}的|求带|带我一个|算我一个|报名|加一|\+1|举手|我也想|还有吗|怎么参加|怎么加|在哪|来了)/,
  videoGeneral: /(交友|扩列|认识新朋友|社交|脱单|单身)/,
  videoRomance: /(相亲|征婚|婚恋|找对象|恋爱|情侣|处对象|另一半)/,
  videoLocal: /(同城|附近|本地|老乡|周边|城市)/,
  videoInterest: /(兴趣|爱好|搭子|运动|旅行|摄影|音乐|游戏|读书|健身|宠物|美食|爬山|露营|徒步)/,
  videoIrrelevant: /(搞笑|段子|剧情|带货|广告|教程|穿搭|美妆|影视解说|新闻|萌宠|吃播|探店)/,
  lowInfo: /^[\s\p{Emoji_Presentation}\p{Emoji}\p{P}~～哈嘿嘻呵嗯哦啊呀额]{0,6}$/u,
}

const sha = value => createHash('sha256').update(String(value)).digest('hex')
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const similar = (haystack, needle) => {
  const a = text(haystack).toLowerCase()
  const b = text(needle).toLowerCase()
  return Boolean(b) && a.includes(b)
}

function videoText(video) {
  return [video.title, video.description, (video.hashtags || []).join(' '), video.topic].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}
function commentText(comment) { return text(comment.text) }

function videoInputHash(video) { return sha(`${CLASSIFIER_VERSION}|video|${videoText(video)}`) }
// 评论含义依赖所属视频语境，哈希必须带上视频文本，换了视频就要重新判断。
function commentInputHash(comment, video = null) {
  return sha(`${CLASSIFIER_VERSION}|comment|${commentText(comment)}|${comment.video_id || comment.video_url || ''}|${video ? videoText(video) : ''}`)
}

function isFriendVideo(video) {
  const category = video?.classification?.category
  if (category && category.startsWith('friend_')) return true
  if (category === 'irrelevant') return false
  return RULES.videoGeneral.test(videoText(video || {})) || RULES.videoLocal.test(videoText(video || {})) || RULES.videoInterest.test(videoText(video || {}))
}

// ── 规则层 ────────────────────────────────────────────────────────────────
function ruleVideo(video) {
  const body = videoText(video)
  if (!body) return null
  if (RULES.videoRomance.test(body)) return { category: 'friend_romance', confidence: 0.65, evidence: [matchOf(body, RULES.videoRomance)], reason: '标题/描述命中婚恋词' }
  if (RULES.videoGeneral.test(body)) return { category: 'friend_general', confidence: 0.6, evidence: [matchOf(body, RULES.videoGeneral)], reason: '标题/描述命中交友词' }
  if (RULES.videoLocal.test(body)) return { category: 'friend_local', confidence: 0.55, evidence: [matchOf(body, RULES.videoLocal)], reason: '标题/描述命中同城词' }
  if (RULES.videoInterest.test(body)) return { category: 'friend_interest', confidence: 0.55, evidence: [matchOf(body, RULES.videoInterest)], reason: '标题/描述命中兴趣词' }
  if (RULES.videoIrrelevant.test(body)) return { category: 'irrelevant', confidence: 0.6, evidence: [matchOf(body, RULES.videoIrrelevant)], reason: '标题/描述命中非交友主题' }
  return null
}

function matchOf(body, pattern) {
  const hit = String(body).match(pattern)
  return hit ? hit[0] : ''
}

function ruleComment(comment, video = null) {
  const body = commentText(comment)
  if (!body) return null
  // 安全优先：明确拒绝联系必须先于任何交友意愿判断。
  if (RULES.doNotContact.test(body)) return { intent: 'DO_NOT_CONTACT', confidence: 0.9, evidence: [matchOf(body, RULES.doNotContact)], reason: '命中拒绝联系表达' }
  if (RULES.advertisement.test(body)) return { intent: 'ADVERTISEMENT', confidence: 0.8, evidence: [matchOf(body, RULES.advertisement)], reason: '命中广告或引流表达' }
  if (RULES.lowInfo.test(body)) return { intent: 'ORDINARY', confidence: 0.7, evidence: [], reason: '极短或纯表情评论' }
  if (RULES.friendNegation.test(body)) return { intent: 'ORDINARY', confidence: 0.6, evidence: [matchOf(body, RULES.friendNegation)], reason: '明确表达不爱/不需要交友，不是交友意愿' }
  if (RULES.explicitInvitation.test(body)) return { intent: 'EXPLICIT_INVITATION', confidence: 0.65, evidence: [matchOf(body, RULES.explicitInvitation)], reason: '命中明确欢迎认识/私信表达' }
  if (RULES.seekingFriends.test(body)) return { intent: 'SEEKING_FRIENDS', confidence: 0.55, evidence: [matchOf(body, RULES.seekingFriends)], reason: '命中交友或找搭子意愿' }
  // 短评论（dd、蹲、有没有湖南的…）只有落在交友类视频里才按潜在意愿处理，不能只看关键词。
  if (body.length <= 24 && isFriendVideo(video) && RULES.contextualShort.test(body)) {
    return { intent: 'CONTEXTUAL_INTEREST', confidence: 0.5, evidence: [matchOf(body, RULES.contextualShort)], reason: '短评论 + 所属视频为交友主题' }
  }
  return null
}

// ── 模型层 ────────────────────────────────────────────────────────────────
const SYSTEM = `你是内容标注器，不是聊天助手。
只能依据给定文本和所属视频主题判断，不得推测作者的性别、年龄、身份、动机或用意。
判断不了就选 unknown / UNKNOWN，不要为了给出答案而猜测。
评论标注以“少漏掉潜在交友意愿、但不把拒绝和广告算进来”为原则：
- 短评论（如 dd、蹲、有没有湖南的、算我一个、求带）必须结合所属视频主题理解；视频是交友/找搭子/同城/兴趣主题时，可以标 CONTEXTUAL_INTEREST，并说明依据是“结合视频语境”。
- 只有原话里明确欢迎认识、邀请私信或主动索要联系的评论，才能标 EXPLICIT_INVITATION。
- 表达想交朋友、想找聊天搭子、想认识人的，标 SEEKING_FRIENDS。
- 只表达对视频内容的普通评价，标 ORDINARY；明确不想被打扰标 DO_NOT_CONTACT；广告、刷屏、重复引流标 ADVERTISEMENT。
- CONTEXTUAL_INTEREST 只代表“可能有意愿”，不是“已经同意私信”，不要高估置信度。
evidence 必须是原文中逐字出现的片段，最多两条；找不到就留空数组。
只输出 JSON 数组，不要输出任何解释或 Markdown：
[{"id":"条目标识","label":"候选标签","confidence":0.0,"evidence":["原文片段"],"reason":"20字内依据"}]`

const INTENT_GUIDE = `意图标签说明：
EXPLICIT_INVITATION = 明确欢迎认识或私信（原话可直接作为接受私信的证据）
SEEKING_FRIENDS = 表达交友、找朋友或找聊天搭子的意愿
CONTEXTUAL_INTEREST = 结合视频主题可能是交友意愿的简短评论（不是已同意私信）
ORDINARY = 普通或与交友无关的评论
DO_NOT_CONTACT = 明确拒绝联系
ADVERTISEMENT = 广告、重复刷屏或其他不适宜内容
UNKNOWN = 无法判断`

function buildClassifyMessages(items, videoByKey = null) {
  const lines = items.map((item, index) => {
    if (item.type === 'video') return `${index + 1}. [视频] ${text(item.video.title || item.video.description || '').slice(0, 200)}`
    const video = item.video || (videoByKey && item.comment?.video_id ? videoByKey.get(item.comment.video_id) : null)
    const context = video ? text(videoText(video)).slice(0, 160) : ''
    const contextLine = context ? `（所属视频：${context}）` : '（所属视频信息缺失）'
    return `${index + 1}. [评论] ${text(item.comment.text).slice(0, 200)}${contextLine}`
  })
  const schema = items.map((item, index) => `${index + 1}${item.type === 'video' ? `（标签只能取：${VIDEO_CATEGORIES.join(' / ')}）` : `（标签只能取：${COMMENT_INTENTS.join(' / ')}）`}`).join('\n')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `待标注条目：\n${lines.join('\n')}\n\n${INTENT_GUIDE}\n\n可选用法：\n${schema}\n\n请输出 JSON 数组，顺序与条目一致。` },
  ]
}

function parseClassifyResponse(raw, items) {
  const body = String(raw || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = body.indexOf('['), end = body.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 数组')
  const parsed = JSON.parse(body.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('模型返回不是数组')
  return items.map((item, index) => {
    const entry = parsed[index] || {}
    const allowed = item.type === 'video' ? VIDEO_CATEGORIES : COMMENT_INTENTS
    const label = allowed.includes(entry.label) ? entry.label : 'unknown'
    const source = text(item.type === 'video' ? videoText(item.video) : commentText(item.comment))
    const evidence = (Array.isArray(entry.evidence) ? entry.evidence : []).map(text).filter(item => similar(source, item)).slice(0, 2)
    const confidence = Number.isFinite(Number(entry.confidence)) ? Math.max(0, Math.min(1, Number(entry.confidence))) : null
    const claimed = (Array.isArray(entry.evidence) ? entry.evidence : []).map(text).filter(Boolean)
    return {
      label, evidence,
      confidence: evidence.length === 0 && claimed.length > 0 ? Math.min(confidence ?? 0.3, 0.3) : confidence,
      reason: text(entry.reason).slice(0, 60) + (evidence.length === 0 && claimed.length > 0 ? '（证据未在原文出现，已降权）' : ''),
    }
  })
}

// ── 运行 ──────────────────────────────────────────────────────────────────
async function classifyLibrary({ store, ai, options = {}, onProgress = null } = {}) {
  const library = store.read()
  const settings = { ...library.settings, ...(options.settings || {}) }
  const batchSize = Math.max(1, Math.min(20, Number(settings.aiBatchSize) || 12))
  // 未显式指定时沿用库设置；缺省 24 次，避免一次分析把额度耗光。
  const requestedCalls = Number(options.maxAiCalls ?? settings.maxAiCallsPerRun ?? 24)
  const maxCalls = Math.max(0, Math.min(200, Number.isFinite(requestedCalls) ? requestedCalls : 24))
  // 可选作用域：P2-11B 自动流水线按单个视频/一批评论调用，避免占用其他视频的模型预算。
  // 不传时行为与原来完全一致（全库范围）。
  const onlyCommentKeys = Array.isArray(options.commentKeys) ? new Set(options.commentKeys.filter(Boolean).map(String)) : null
  const onlyVideoKeys = Array.isArray(options.videoKeys) ? new Set(options.videoKeys.filter(Boolean).map(String)) : null
  const inVideoScope = video => !onlyVideoKeys || onlyVideoKeys.has(video.key)
  const inCommentScope = comment => !onlyCommentKeys || onlyCommentKeys.has(comment.key)
  const task = {
    status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, processed: 0, aiCalls: 0, tokens: 0, errors: [],
  }

  // 1) 规则层：安全类判断（拒绝联系、广告、低信息量）必须先落地。
  for (const video of library.videos) {
    if (!inVideoScope(video)) continue
    if (video.classification?.reviewedByUser) continue
    const hash = videoInputHash(video)
    if (video.classification?.category && video.classification?.inputHash === hash) continue
    const rule = ruleVideo(video)
    if (!rule) continue
    video.classification = { ...video.classification, ...rule, model: 'rule', inputHash: hash, classifiedAt: new Date().toISOString(), needsRetry: false }
    task.processed += 1
  }
  // 评论按所属视频取语境；视频未收录时也能在缺上下文时继续标注。
  const videoByKey = new Map()
  for (const video of library.videos) {
    if (video.video_id) videoByKey.set(`id:${video.video_id}`, video)
    if (video.video_url) videoByKey.set(`url:${video.video_url}`, video)
  }
  const videoOf = comment => (comment.video_id && videoByKey.get(`id:${comment.video_id}`))
    || (comment.video_url && videoByKey.get(`url:${comment.video_url}`)) || null

  for (const comment of library.comments) {
    if (!inCommentScope(comment)) continue
    if (comment.classification?.reviewedByUser) continue
    const video = videoOf(comment)
    const hash = commentInputHash(comment, video)
    if (comment.classification?.intent && comment.classification?.inputHash === hash) continue
    const rule = ruleComment(comment, video)
    if (!rule) continue
    comment.classification = { ...comment.classification, ...rule, model: 'rule', inputHash: hash, classifiedAt: new Date().toISOString(), needsRetry: false }
    task.processed += 1
  }

  // 2) 收集仍需标注的条目
  const pendingVideos = library.videos.filter(video => inVideoScope(video) && !video.classification?.reviewedByUser && video.classification?.inputHash !== videoInputHash(video))
  const pendingComments = library.comments.filter(comment => inCommentScope(comment) && !comment.classification?.reviewedByUser && comment.classification?.inputHash !== commentInputHash(comment, videoOf(comment)))
  const pending = [
    ...pendingVideos.map(video => ({ type: 'video', video, ref: video })).map(item => ({ ...item, hash: videoInputHash(item.video) })),
    ...pendingComments.map(comment => ({ type: 'comment', comment, video: videoOf(comment), ref: comment })).map(item => ({ ...item, hash: commentInputHash(item.comment, item.video) })),
  ]
  task.total = pending.length

  if (!pending.length) {
    library.task = { ...task, status: 'done', finishedAt: new Date().toISOString() }
    store.replace(library)
    return { ok: true, result: { processed: task.processed, aiCalls: 0, tokens: 0, pending: 0, errors: [] }, library }
  }
  if (settings.classificationEnabled === false) {
    library.task = { ...task, status: 'partial', finishedAt: new Date().toISOString(), errors: [{ reason: '分类已关闭，剩余条目未标注' }] }
    store.replace(library)
    return { ok: true, result: { processed: task.processed, aiCalls: 0, tokens: 0, pending: pending.length, errors: library.task.errors }, library }
  }
  if (!ai) {
    library.task = { ...task, status: 'partial', finishedAt: new Date().toISOString(), errors: [{ reason: '没有可用模型，剩余条目保持不确定' }] }
    store.replace(library)
    return { ok: true, result: { processed: task.processed, aiCalls: 0, tokens: 0, pending: pending.length, errors: library.task.errors }, library }
  }

  // 3) 模型层：按批次标注，受调用上限约束；任何失败都不影响已有结论。
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    if (task.aiCalls >= maxCalls) { task.errors.push({ reason: `达到本次调用上限（${maxCalls} 次），剩余条目留待下次` }); break }
    const batch = pending.slice(offset, offset + batchSize)
    task.aiCalls += 1
    if (onProgress) onProgress({ aiCalls: task.aiCalls, processed: task.processed, total: pending.length })
    try {
      const out = await ai.inquiryCompletion(buildClassifyMessages(batch), { temperature: 0.2, maxTokens: 800, structuredJson: true })
      // usage 由 AiService 归一化成 prompt/completion/total；早期只读 total_tokens 会把豆包用量记成 0。
      task.tokens += Number(out?.usage?.total ?? out?.usage?.total_tokens) || 0
      const labels = parseClassifyResponse(out?.text, batch)
      batch.forEach((item, index) => {
        const label = labels[index]
        const target = item.ref
        if (item.type === 'video') {
          target.classification = { ...target.classification, category: label.label, confidence: label.confidence, evidence: label.evidence, reason: label.reason, model: out?.model || null, inputHash: item.hash, classifiedAt: new Date().toISOString(), needsRetry: label.label === 'unknown' }
        } else {
          target.classification = { ...target.classification, intent: label.label, confidence: label.confidence, evidence: label.evidence, reason: label.reason, model: out?.model || null, inputHash: item.hash, classifiedAt: new Date().toISOString(), needsRetry: label.label === 'UNKNOWN' }
        }
        task.processed += 1
      })
    } catch (error) {
      task.errors.push({ batch: Math.floor(offset / batchSize) + 1, reason: String(error?.message || error).slice(0, 200) })
      for (const item of batch) {
        item.ref.classification = { ...item.ref.classification, needsRetry: true, reason: '模型标注失败，等待重试' }
      }
    }
  }

  const remaining = library.videos.filter(video => inVideoScope(video) && !video.classification?.reviewedByUser && video.classification?.inputHash !== videoInputHash(video)).length
    + library.comments.filter(comment => inCommentScope(comment) && !comment.classification?.reviewedByUser && comment.classification?.inputHash !== commentInputHash(comment, videoOf(comment))).length
  library.task = { ...task, status: remaining ? 'partial' : 'done', finishedAt: new Date().toISOString(), errors: task.errors.slice(0, 20) }
  store.replace(library)
  return { ok: true, result: { processed: task.processed, aiCalls: task.aiCalls, tokens: task.tokens, pending: remaining, errors: task.errors }, library }
}

module.exports = {
  CLASSIFIER_VERSION, VIDEO_CATEGORIES, COMMENT_INTENTS, CANDIDATE_INTENTS, INTENT_RANK, LABELS, RULES, SYSTEM, INTENT_GUIDE,
  ruleVideo, ruleComment, isFriendVideo, videoText, commentText, videoInputHash, commentInputHash,
  buildClassifyMessages, parseClassifyResponse, classifyLibrary,
}
