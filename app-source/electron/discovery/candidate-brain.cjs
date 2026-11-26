const { candidateEligibility, candidateAge, candidateGender, candidateProfileFacts, canonicalProfile } = require('./candidate-manager.cjs')
const { normalizeDiscoveryConfig } = require('./search-topics.cjs')

const list = value => value instanceof Set ? [...value] : Array.isArray(value) ? value : []
function sameIdentity(candidate, record, { allowName = false } = {}) {
  if (typeof record === 'string') return record === candidate.platformUserId || record === candidate.id || record === candidate.profileUrl || (allowName && record === candidate.nickname)
  if (!record || typeof record !== 'object') return false
  if (candidate.accountId && record.accountId && candidate.accountId !== record.accountId) return false
  const id = record.platformUserId || record.secUid || record.sec_uid
  const url = record.profileUrl || record.url || record.profile?.autoFriendshipUrl
  if (id || url) return id === candidate.platformUserId || canonicalProfile(url)?.platformUserId === candidate.platformUserId
  return allowName && (record.name === candidate.nickname || record.contactId === candidate.id)
}
// Pure evidence-based assessment. A search keyword or video topic is never an
// author's interest, and discovery time is never evidence of recent activity.
function evaluateCandidate(candidate, { config = {}, persona = {}, contacts = [], sendHistory = [], blacklist = [], aiDisabledContacts = [], followed = [], now = Date.now() } = {}) {
  candidate = candidate || {}
  config = normalizeDiscoveryConfig(config)
  const signals = [], unknowns = [], evidence = [], checks = []
  let score = 0
  const add = (key, points, label, text) => { score += points; signals.push(label); evidence.push({ key, points, text }) }
  const sources = list(candidate.sources).length ? candidate.sources : candidate.source ? [candidate.source] : []
  const comments = sources.filter(source => source.type !== 'user_search').map(source => String(source.commentText || '').trim()).filter(Boolean)
  const summaries = sources.filter(source => source.type === 'user_search').map(source => String(source.summary || '').trim()).filter(Boolean)
  const profileText = String(candidate.publicProfile?.rawText || candidate.publicProfile?.summary || '')
  const texts = [...comments, ...summaries, profileText].filter(Boolean)
  const social = texts.find(text => /认识.{0,5}朋友|(?:想|希望|欢迎|一起|寻找|找|求|蹲).{0,6}(?:交友|交朋友|认识朋友|搭子|对象)|脱单|扩列/.test(text) && !/不(?:想|要|愿|需要).{0,6}(?:交友|交朋友|认识朋友|搭子|对象|脱单|扩列)|拒绝.{0,4}(?:交友|私信)/.test(text))
  if (social) add('social_willingness', 30, '公开表达交友或寻找搭子的意愿', social.slice(0, 300))
  const student = texts.find(text => /研[一二三]|(?:我是|本人|在读|目前是).{0,5}(?:研究生|本科生|大学生)|(?:研究生|本科生|大学生).{0,3}在读|(?:^|\n)\s*(?:研究生|本科生|大学生)\s*(?:\n|$)/.test(text) && !/不是.{0,4}(?:研[一二三]|研究生|本科生|大学生)|不在读|已毕业/.test(text))
  if (student) add('student', 15, '公开自述学生身份，仍需核实', student.slice(0, 300))
  const interests = (Array.isArray(persona.interests) ? persona.interests : String(persona.interests || '').split(/[\n,，;；、\/\s]+/)).map(item => String(item).trim()).filter(item => item.length >= 2).slice(0, 30)
  const shared = interests.filter(interest => texts.some(text => text.includes(interest) && !text.includes(`不喜欢${interest}`) && !text.includes(`讨厌${interest}`)))
  if (shared.length) add('shared_interests', 20, `公开内容与本人兴趣重合：${shared.join('、')}`, shared.join('、'))
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now)
  const activity = [...sources.filter(source => source.activitySource === 'public_comment').map(source => ({ at: source.publishedAt })),
    ...(candidate.publicSignals?.recentActivity && ['public_profile_text', 'public_comment'].includes(candidate.publicSignals.recentActivity.source) ? [candidate.publicSignals.recentActivity] : [])]
    .find(record => Number.isFinite(Date.parse(record.at)) && Number.isFinite(nowMs) && nowMs >= Date.parse(record.at) && nowMs - Date.parse(record.at) <= 14 * 86400000)
  if (activity) add('recent_activity', 10, '有可核实的近14天公开活动', activity.at)
  const content = candidate.publicSignals?.contentCount
  if (content?.source === 'public_profile_text' && Number.isSafeInteger(content.value) && content.value >= 3) add('profile_content', 10, '公开主页显示至少3条作品', String(content.value))
  const quality = comments.find(text => text.length >= 12 && /[\p{Script=Han}A-Za-z]/u.test(text) && !/^(?:哈+|[6啊呀哦\s]+)$/u.test(text))
  if (quality) add('comment_quality', 15, '来源评论提供具体交流内容', quality.slice(0, 300))
  // "未知"与"来源冲突"要分开说：前者是没资料，后者是有资料但互相矛盾。
  const facts = candidateProfileFacts(candidate)
  if (facts.age.status === 'conflict') unknowns.push('年龄（来源冲突）')
  else if (candidateAge(candidate) === null) unknowns.push('年龄')
  if (facts.gender.status === 'conflict') unknowns.push('性别（来源冲突）')
  else if (candidateGender(candidate) === 'unknown') unknowns.push('性别')
  if (!Number.isSafeInteger(candidate.publicSignals?.followerCount) || candidate.publicSignals.followerCount < 0) unknowns.push('粉丝数')
  if (!activity) unknowns.push('近期活跃')
  if (!candidate.publicSignals?.city) unknowns.push('城市')
  const gate = candidateEligibility(candidate, config)
  checks.push({ key: 'configured_filters', passed: gate.matches, pending: gate.pending, reason: gate.reason })
  let exclusion = ''
  if (!canonicalProfile(candidate.profileUrl) || canonicalProfile(candidate.profileUrl)?.platformUserId !== candidate.platformUserId) exclusion = '候选身份未核验或主页身份冲突'
  else if (candidate.status === 'REJECTED' || candidate.review?.status === 'rejected') exclusion = '候选已被人工排除'
  else if (list(blacklist).some(record => sameIdentity(candidate, record, { allowName: true }))) exclusion = '候选在黑名单中'
  else if (list(aiDisabledContacts).some(record => sameIdentity(candidate, record, { allowName: true }))) exclusion = '联系人AI开关已关闭'
  else if (list(contacts).some(record => sameIdentity(candidate, record, { allowName: true }))) exclusion = '已存在联系人，禁止重复首次联系'
  else if (list(sendHistory).some(record => sameIdentity(candidate, record, { allowName: true }))) exclusion = '已有发送历史，禁止重复首次联系'
  else if (['sent', 'uncertain', 'sending'].includes(candidate.contact?.openingStatus) || ['OPENING_SENT', 'OPENING_SENDING', 'SEND_UNKNOWN', 'MESSAGE_UNCERTAIN', 'WAITING_REPLY', 'REPLIED', 'CONTACT', 'ACTIVE'].includes(candidate.status)) exclusion = '已联系或发送结果未确定，禁止重复首次联系'
  // Already following is useful context, not proof that an opening was sent.
  if (list(followed).some(record => sameIdentity(candidate, record))) signals.push('已经关注，首次联系前需核对发送记录')
  checks.push({ key: 'duplicate_and_exclusion', passed: !exclusion, pending: false, reason: exclusion || '未发现重复联系或排除记录' })
  const passed = !exclusion && gate.matches
  const pending = !exclusion && gate.pending
  return { eligibility: exclusion || (!gate.matches && !gate.pending) ? 'reject' : pending ? 'uncertain' : score >= config.automaticContactThreshold ? 'high_priority' : 'worth_reviewing',
    hardGate: { passed, pending, reason: exclusion || gate.reason, checks }, score: Math.min(100, score), signals, unknowns, evidence }
}
module.exports = { evaluateCandidate, sameIdentity }
