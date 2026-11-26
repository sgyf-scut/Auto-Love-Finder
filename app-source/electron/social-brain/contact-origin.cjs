// 联系人认识来源：字段规范化、按需判断与临时注入块生成。
//
// 设计原则：
//  - 每个联系人的来源独立保存在 contact.profile.contact_origin；没有该字段的旧联系人完全不受影响。
//  - 只有对方当前消息确实在问“我们怎么认识的/你在哪看到我的/是哪条视频”时才注入。
//  - 不调用任何模型做意图判断；宁可漏触发，也不误触发普通聊天。
//  - 未由本人确认（verified_by_user !== true）的来源一律不注入。
//  - 未记录的具体视频、作者、评论内容保持未知，注入文本明确说明“没有确认记录”。
const PLATFORM_LABELS = { douyin: '抖音', wechat: '微信', qq: 'QQ', xiaohongshu: '小红书', other: '其他平台' }
const SOURCE_TYPE_LABELS = {
  video_comments: '视频评论区',
  video_dm: '视频私信',
  search: '搜索',
  friend_referral: '朋友介绍',
  other: '其他方式',
}
const SOURCE_TYPES = Object.keys(SOURCE_TYPE_LABELS)
const ORIGIN_KEYS = ['platform', 'source_type', 'video_topic', 'video_id', 'video_url', 'video_title', 'comment_text', 'note', 'verified_by_user']

const textOrNull = value => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? text : null
}

// 兼容旧数据：字段缺失、类型错误或整体不是对象时返回 null，绝不抛错。
function normalizeOrigin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const platform = textOrNull(value.platform)
  const sourceType = textOrNull(value.source_type)
  const origin = {
    platform: platform && Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, platform) ? platform : (platform ? 'other' : null),
    source_type: sourceType && SOURCE_TYPES.includes(sourceType) ? sourceType : (sourceType ? 'other' : null),
    video_topic: textOrNull(value.video_topic),
    video_id: textOrNull(value.video_id),
    video_url: textOrNull(value.video_url),
    video_title: textOrNull(value.video_title),
    comment_text: textOrNull(value.comment_text),
    note: textOrNull(value.note),
    verified_by_user: value.verified_by_user === true,
  }
  return Object.values(origin).every(item => item === null || item === false) && !origin.platform && !origin.source_type ? null : origin
}

// 联系人资料里可能写在 profile.contact_origin，也可能被脚本写到联系人顶层；两者都兼容。
function originOf(contact) {
  return normalizeOrigin(contact?.profile?.contact_origin) || normalizeOrigin(contact?.contact_origin)
}

// 已确认事实的完整描述，用于注入；未确认返回 null。
function describeOrigin(origin) {
  if (!origin || origin.verified_by_user !== true) return null
  const platform = PLATFORM_LABELS[origin.platform] || null
  if (!platform) return null
  const topic = origin.video_topic ? `${origin.video_topic}主题视频` : '视频'
  if (origin.source_type === 'video_comments') return `本人是在${platform}一个${topic}的评论区看到对方的，之后主动发起了聊天。`
  if (origin.source_type === 'video_dm') return `本人是在${platform}一个${topic}下私信对方的，之后开始聊天。`
  if (origin.source_type === 'search') return `本人是在${platform}搜索时看到对方的，之后主动发起了聊天。`
  if (origin.source_type === 'friend_referral') return `本人是通过朋友介绍在${platform}认识对方的，之后主动发起了聊天。`
  if (origin.source_type === 'other') return `本人是在${platform}上认识对方的，之后主动发起了聊天。`
  return `本人是在${platform}上认识对方的，之后主动发起了聊天。`
}

const UNKNOWN_PART_LABELS = [
  ['video_title', '视频标题'],
  ['video_id', '视频 ID'],
  ['video_url', '视频链接'],
  ['comment_text', '当时的评论内容'],
]

// 生成只在本轮 User Context 中出现的临时块；无有效来源返回 null。
function buildOriginBlock(origin) {
  const description = describeOrigin(origin)
  if (!description) return null
  const missing = UNKNOWN_PART_LABELS.filter(([key]) => !origin[key]).map(([, label]) => label)
  const lines = [description]
  if (origin.note) lines.push(`本人补充：${origin.note}`)
  if (missing.length) {
    const readable = missing.length === UNKNOWN_PART_LABELS.length
      ? '具体视频、作者和评论内容'
      : missing.join('、')
    lines.push(`${readable}没有确认记录。`)
  }
  lines.push('对方追问具体是哪条视频或评论内容时，如实说没有记录，不要编造。')
  lines.push('仅用于回答认识来源相关问题，不得据此推断对方恋爱意愿或主动转移聊天话题。')
  return `【认识来源｜已确认事实】\n${lines.join('\n')}`
}

// ── 触发判断 ───────────────────────────────────────────────────────────────
// 强模式：本身就是“怎么认识 / 在哪看到 / 哪条视频”的问题，直接触发。
const STRONG_PATTERNS = [
  /(怎么|咋|如何)[^。！？\n]{0,8}(认识|找到我|看到我|加的我|联系上我)/,
  /(哪|哪儿|哪里|从哪|在哪|在哪儿|通过什么|什么方式|什么渠道)[^。！？\n]{0,8}(认识|找到我|看到我|加的我|联系上我)/,
  /(我们|咱俩|咱)[^。！？\n]{0,6}(怎么|咋|如何)[^。！？\n]{0,4}(认识|遇见|遇上)/,
  /(认识|相遇)(?:的)?(?:来着|经过|过程|来源|渠道)/,
  /(你|本人)[^。！？\n]{0,6}(之前|上次|上回|昨天|前天)[^。！？\n]{0,10}(说|提|讲)[^。！？\n]{0,10}(评论|视频|看到我|认识)/,
  /(是不是|难道)[^。！？\n]{0,6}(视频|评论区)[^。！？\n]{0,6}(看到我|认识)/,
  /(评论区|视频下面|视频底下)[^。！？\n]{0,6}(看到|找到|加)(?:了)?(?:我|你)/,
]
// 弱模式：单独出现不足以判断，必须同时提到“你说的/认识的”或上一轮正在聊来源。
const WEAK_PATTERNS = [/(那个|哪个|哪条|什么|这条|那条|哪一个)[^。！？\n]{0,6}(视频|评论区|评论|链接)/]
const FOLLOWUP_PATTERN = /^(哪个|哪条|哪个视频|哪条视频|什么视频|视频呢|链接呢|哪个评论区|哪条呢)[啊呀呢么吧？?！!。.~…]*$/
// 直接索要视频链接/原视频：只有结合上下文确认是在问双方认识来源时才触发。
const LINK_REQUEST = /(视频|作品|原视频)[^。！？\n]{0,4}(链接|地址|id|ID)|(链接|地址)[^。！？\n]{0,4}(发|给)|(发|给|甩)[^。！？\n]{0,4}链接/
const SOURCE_HINT = /(你说的|你之前说的|认识的|认识来源|在哪里看到我|看到我的)/
const CONTEXT_HINT = /(在哪里看到我|从哪里看到|怎么认识|认识来源|看到我的|交友.{0,3}视频|评论区的?视频|视频评论区)/

function normalizeText(value) {
  return String(value || '').replace(/[\s]/g, '').trim()
}

// 少量必要的近期上下文：只看最近 6 条（含本人），避免把很早的旧话题当上下文。
function recentContext(recentMessages = []) {
  return (Array.isArray(recentMessages) ? recentMessages : [])
    .filter(row => row && typeof row.text === 'string')
    .slice(-6)
    .map(row => row.text)
    .join('\n')
}

function shouldInjectOrigin({ incomingText = '', recentMessages = [] } = {}) {
  const text = String(incomingText || '')
  if (!text.trim()) return { trigger: false, reason: 'NO_INCOMING' }
  if (STRONG_PATTERNS.some(pattern => pattern.test(text))) return { trigger: true, reason: 'EXPLICIT_SOURCE_QUESTION' }
  const compact = normalizeText(text)
  if (FOLLOWUP_PATTERN.test(compact) && CONTEXT_HINT.test(recentContext(recentMessages))) {
    return { trigger: true, reason: 'CONTINUATION_SHORT_FOLLOWUP' }
  }
  if (WEAK_PATTERNS.some(pattern => pattern.test(text))) {
    if (SOURCE_HINT.test(text)) return { trigger: true, reason: 'SOURCE_MENTIONED' }
    if (CONTEXT_HINT.test(recentContext(recentMessages))) return { trigger: true, reason: 'CONTINUATION_VIDEO_QUESTION' }
  }
  // 索要链接本身不构成来源问题；必须同时处于“刚聊过认识来源”的语境。
  if (LINK_REQUEST.test(text) && CONTEXT_HINT.test(recentContext(recentMessages))) {
    return { trigger: true, reason: 'CONTINUATION_VIDEO_LINK' }
  }
  return { trigger: false, reason: 'ORDINARY_CHAT' }
}

module.exports = {
  PLATFORM_LABELS, SOURCE_TYPE_LABELS, SOURCE_TYPES, ORIGIN_KEYS,
  normalizeOrigin, originOf, describeOrigin, buildOriginBlock, shouldInjectOrigin, recentContext,
}
