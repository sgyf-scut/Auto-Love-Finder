// 首条开场白与拒绝联系保护。
// 开场白只允许使用来源里已确认的部分；任何具体视频、链接、评论原文都不得凭空出现。
// 拒绝保护作用于生产消息入口：对方明确表示不想再聊，立即停用该联系人的自动回复。

const INTRO_TEMPLATES = {
  library_comment: '嗨，之前在一个交友话题的视频评论区看到你留言，感觉你挺真诚的，就想认识一下，方便聊聊吗？',
  library_comment_short: '嗨，刷到一个交友视频的评论区看到你留言，想认识一下，方便聊两句吗？',
  // 只表达交友意愿、但没有邀请私信：不写“你留言邀请我”，也不暗示已同意私信。
  library_seeking: '嗨，在一个交友视频的评论区看到你说想找朋友，感觉挺真诚的，就想认识一下，方便聊聊吗？',
  // 结合视频语境推断的潜在意愿：只描述“看到你”，不替对方表态。
  library_contextual: '嗨，在一个交友视频的评论区看到你，感觉挺有意思，想认识一下，方便聊聊吗？',
}

function templateForIntent(intent) {
  return intent === 'EXPLICIT_INVITATION' ? 'library_comment'
    : intent === 'SEEKING_FRIENDS' ? 'library_seeking'
      : intent === 'CONTEXTUAL_INTEREST' ? 'library_contextual' : 'library_comment'
}

const FORBIDDEN = {
  contact: /(https?:\/\/|www\.|加微信|微信号|vx|VX|QQ号|手机号|电话|抖音号|视频号)/,
  escalation: /(做我女朋友|做我对象|谈恋爱|我喜欢你|处对象|相亲对象|嫁给我)/,
  linkClaim: /(链接|作品号|BV号|av\d|视频号)/,
  titleClaim: /(《[^》]{1,30}》)/,
}

const sha = value => require('node:crypto').createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim()

function topicOf(origin) {
  const topic = text(origin?.video_topic)
  return topic || ''
}

// 只描述已确认的层级：平台 + 主题 + 评论区 + 主动发起聊天；缺失项如实标注。
function describeOriginForIntro(origin) {
  const platform = origin?.platform === 'douyin' ? '抖音' : (text(origin?.platform) || '某个平台')
  const topic = topicOf(origin)
  const where = origin?.source_type === 'video_comments' ? `${topic ? `一个${topic}话题的` : ''}视频评论区` : '私信/其他入口'
  return { platform, topic, where, hasVideo: Boolean(origin?.video_id || origin?.video_url), hasComment: Boolean(text(origin?.comment_text)) }
}

function buildIntroDraft({ origin, template = null, variant = null, intent = null } = {}) {
  const variantKey = variant || templateForIntent(intent)
  const base = text(template) || INTRO_TEMPLATES[variantKey] || INTRO_TEMPLATES.library_comment
  const info = describeOriginForIntro(origin)
  const warnings = []
  if (!origin) warnings.push('没有来源资料：开场白不能声称任何具体来源')
  if (origin && !topicOf(origin)) warnings.push('视频主题未知：开场白只说“评论区”，不说主题')
  if (intent === 'CONTEXTUAL_INTEREST') warnings.push('该类评论只是结合语境推断的潜在意愿，开场白不得声称对方邀请私信')
  let body = base
  // 未确认主题时，把“交友话题的”弱化为“一个”
  if (!info.topic) body = body.replace(/交友话题的?/g, '')
  const draft = { text: body, template: base, variant: variantKey, intent: intent || '', originFingerprint: sha(JSON.stringify([origin?.platform, origin?.source_type, origin?.video_topic, origin?.video_id, text(origin?.comment_text)])), warnings }
  const audit = assertNoFabrication(draft.text, origin)
  draft.violations = audit.violations
  draft.ok = audit.ok
  return draft
}

function assertNoFabrication(body, origin) {
  const value = text(body)
  const violations = []
  const originText = [
    origin?.video_title, origin?.comment_text, origin?.video_id, origin?.video_url, origin?.video_topic,
  ].filter(Boolean).map(text).join(' ')
  if (FORBIDDEN.contact.test(value)) violations.push('包含联系方式或链接')
  if (FORBIDDEN.escalation.test(value)) violations.push('包含恋爱推进或表白表达')
  if (FORBIDDEN.linkClaim.test(value) && !origin?.video_id && !origin?.video_url) violations.push('声称有视频链接/作品号，但来源里没有')
  if (FORBIDDEN.titleClaim.test(value) && !text(origin?.video_title)) violations.push('声称具体视频标题，但来源里没有')
  if (!text(origin?.comment_text) && /(你|她|对方)[^，。！？\n]{0,6}(说|表示|留言|评论|写|留)/.test(value)) violations.push('暗示记得评论原文，但来源里没有')
  const numbers = value.match(/[0-9]{4,}/g) || []
  for (const number of numbers) if (!originText.includes(number)) violations.push(`出现未确认的数字 ${number}`)
  return { ok: violations.length === 0, violations: [...new Set(violations)] }
}

// ── 拒绝联系保护 ──────────────────────────────────────────────────────────
const STRONG_REFUSAL = /(不要再?联系我|别再?联系我|停止联系我|拉黑|删了吧|别发消息了|不要再发消息|不想再收到你的消息)/u
const WEAK_REFUSAL = /(别发了|不要再发|不用再发|别回我|不用回我|不用回了|不想聊了|不想继续聊|有点烦|别烦我|不喜欢闲聊|不想认识|别加我|不想聊天|别再发|不用理我)/u
const JOKE_CONTEXT = /(开玩笑|哈哈|不是说你|逗你|别当真|玩梗)/u
const TOPIC_CONTEXT = /(这个话题|这件事|这个事|比赛|游戏)/u

function detectRefusal(value) {
  const body = text(value)
  if (!body || body.length > 80) return { refused: false, level: null, matched: '' }
  if (JOKE_CONTEXT.test(body)) return { refused: false, level: null, matched: '' }
  const strong = body.match(STRONG_REFUSAL)
  if (strong) return { refused: true, level: 'strong', matched: strong[0] }
  if (TOPIC_CONTEXT.test(body)) return { refused: false, level: null, matched: '' }
  const weak = body.match(WEAK_REFUSAL)
  if (weak && body.length <= 30 && !/[?？]/.test(body)) return { refused: true, level: 'weak', matched: weak[0] }
  return { refused: false, level: null, matched: '' }
}

// 写入既有 aiDisabledContacts：该字段在自动回复、主动搭话、消息消费三处都被检查。
function applyRefusal({ storage, name, incoming = '', at = new Date().toISOString() }) {
  if (!name) throw new Error('拒绝保护缺少联系人名称')
  const state = storage.get()
  const list = Array.isArray(state.automation?.aiDisabledContacts) ? state.automation.aiDisabledContacts.map(String) : []
  if (list.includes(String(name))) return { stopped: true, already: true, list }
  const next = [...list, String(name)]
  storage.update({ automation: { ...(state.automation || {}), aiDisabledContacts: next } })
  storage.addLog?.({ type: 'contact_refused_stop', message: `${name} 明确表示不想继续聊，已停止自动回复`, detail: { incoming: text(incoming).slice(0, 120), at, source: 'refusal_guard' } })
  return { stopped: true, already: false, list: next }
}

function refusalShouldStop({ storage, name, incoming }) {
  const detection = detectRefusal(incoming)
  if (!detection.refused || !name) return { stop: false, detection }
  return { stop: true, detection, ...applyRefusal({ storage, name, incoming }) }
}

module.exports = {
  INTRO_TEMPLATES, FORBIDDEN, STRONG_REFUSAL, WEAK_REFUSAL,
  topicOf, describeOriginForIntro, templateForIntent, buildIntroDraft, assertNoFabrication,
  detectRefusal, applyRefusal, refusalShouldStop,
}
