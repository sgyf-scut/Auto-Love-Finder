// P2-17B 批次筛选：性别 / 年龄 / 评论IP属地 / 粉丝数 / 评论回复数，各自可限制或不限。
// 规则：启用的条件没有可靠依据 → pending（不进审核名单）；未启用的字段未知 → 不影响。
// 读取失败与"确认为 0"必须区分：replyCount=null 表示未知，不等于 0 条回复。
const { candidateGender, candidateAge } = require('./candidate-manager.cjs')
const { intentFloor, meetsIntent } = require('./selection-policy.cjs')

const INTENT_CLASSES = {
  EXPLICIT_INVITATION: 'explicit',
  SEEKING_FRIENDS: 'explicit',
  CONTEXTUAL_INTEREST: 'general',
}

function intentClassOf(intent) {
  return INTENT_CLASSES[String(intent || '')] || null
}

function normalizeRegion(value) {
  return String(value || '').trim().replace(/^IP\s*属地\s*[:：]?\s*/, '')
    .replace(/(?:壮族|回族|维吾尔)?自治区$|特别行政区$|省$|市$/, '')
}

function normalizeBatchFilters(value = {}) {
  const v = value && typeof value === 'object' ? value : {}
  const ips = (Array.isArray(v.ipValues) ? v.ipValues : String(v.ipValues || '').split(/[,，\s]+/))
    .map(normalizeRegion).filter(Boolean).slice(0, 20)
  const bounded = (n, def, min, max) => (Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Math.floor(Number(n)))) : def)
  return {
    minIntent: intentFloor(v.minIntent),
    gender: ['any', 'female', 'male'].includes(v.gender) ? v.gender : 'any',
    requireAgeRange: v.requireAgeRange === true,
    ageMin: bounded(v.ageMin, 18, 18, 100),
    ageMax: Math.max(bounded(v.ageMin, 18, 18, 100), bounded(v.ageMax, 45, 18, 100)),
    requireIp: v.requireIp === true,
    ipValues: ips,
    requireFollowerLimit: v.requireFollowerLimit === true,
    followerLimit: bounded(v.followerLimit, 1000, 1, 10000000),
    requireReplyLimit: v.requireReplyLimit === true,
    replyLimit: bounded(v.replyLimit, 5, 0, 1000),
  }
}

// 从候选的来源里取"评论级"依据：IP 属地与回复数。读不到一律 null。
function commentEvidenceOf(candidate, selectedSource) {
  const sources = Array.isArray(candidate?.sources) ? candidate.sources : []
  const source = selectedSource || sources[0] || candidate?.source || {}
  const reply = Number.isSafeInteger(source.replyCount) && source.replyCount >= 0 ? source.replyCount : null
  const ip = typeof source.commentIpLocation === 'string' && source.commentIpLocation.trim() ? source.commentIpLocation.trim() : null
  return {
    replyCount: reply, ipLocation: ip, ipLocationSource: source.commentIpLocationSource || (ip ? 'unknown' : 'not_present'),
    commentId: source.commentId || null, commentText: source.commentText || candidate?.firstComment || '',
    commentTime: source.commentTime || source.publishedAt || (!selectedSource ? candidate?.commentTime : null) || null,
    videoId: source.videoId || null,
  }
}

function evaluateBatchCandidate(candidate, filters, selectedSource, goalMatch = null) {
  const f = normalizeBatchFilters(filters)
  const reasons = []
  const pendingReasons = []
  const facts = { gender: 'unknown', age: null, ipLocation: null, followerCount: null, replyCount: null }
  const evidence = commentEvidenceOf(candidate, selectedSource)

  // 意愿：只保留明确交友与一般交流两类
  const intentClass = intentClassOf(candidate?.libraryIntent) || null
  if (goalMatch?.label !== 'match') {
    if (!intentClass) reasons.push('NOT_FRIENDLY_INTENT')
    else if (!meetsIntent(candidate.libraryIntent, f.minIntent)) reasons.push('INTENT_BELOW_MINIMUM')
  }

  // 性别
  const gender = candidateGender(candidate)
  facts.gender = gender
  if (goalMatch?.label === 'match') {
    // A custom task such as gaming applies the operator's selected gender filter.
    // The legacy dating path below deliberately keeps its existing behavior.
    if (f.gender !== 'any') {
      if (gender === 'conflict') pendingReasons.push('GENDER_CONFLICT')
      else if (['female', 'male'].includes(gender) && gender !== f.gender) reasons.push('GENDER_MISMATCH')
      else if (gender !== f.gender) pendingReasons.push('GENDER_UNVERIFIED')
    }
  } else if (gender === 'male') reasons.push('GENDER_MISMATCH')
  else if (f.gender !== 'any') {
    if (gender === 'conflict') pendingReasons.push('GENDER_CONFLICT')
    else if (gender !== f.gender) pendingReasons.push('GENDER_UNVERIFIED')
  }

  // 年龄
  const age = candidateAge(candidate)
  facts.age = Number.isSafeInteger(age) ? age : null
  if (f.requireAgeRange) {
    if (age === null) pendingReasons.push('AGE_UNVERIFIED')
    else if (age < f.ageMin || age > f.ageMax) reasons.push('AGE_OUT_OF_RANGE')
  }

  // 评论 IP 属地
  facts.ipLocation = evidence.ipLocation
  if (f.requireIp) {
    if (!evidence.ipLocation) pendingReasons.push('IP_UNVERIFIED')
    else if (f.ipValues.length && !f.ipValues.includes(normalizeRegion(evidence.ipLocation))) reasons.push('IP_MISMATCH')
  }

  // 粉丝数
  const followers = candidate?.publicSignals?.followerCount
  facts.followerCount = Number.isSafeInteger(followers) && followers >= 0 ? followers : null
  if (f.requireFollowerLimit) {
    if (facts.followerCount === null) pendingReasons.push('FOLLOWERS_UNVERIFIED')
    else if (facts.followerCount >= f.followerLimit) reasons.push('FOLLOWERS_OUT_OF_RANGE')
  }

  // 评论回复数（读取失败=未知，不能当 0）
  facts.replyCount = evidence.replyCount
  if (f.requireReplyLimit) {
    if (evidence.replyCount === null) pendingReasons.push('REPLIES_UNVERIFIED')
    else if (evidence.replyCount > f.replyLimit) reasons.push('REPLIES_OUT_OF_RANGE')
  }

  const status = reasons.length ? 'excluded' : (pendingReasons.length ? 'pending' : 'qualified')
  return { status, reasons: [...reasons, ...pendingReasons], excludedReasons: reasons, pendingReasons, facts, intentClass, evidence }
}

// 批次内排序：回复数升序；回复数未知排最后（不当作 0）。
function replySortKey(candidate) {
  const value = commentEvidenceOf(candidate).replyCount
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY
}

module.exports = { normalizeBatchFilters, evaluateBatchCandidate, commentEvidenceOf, intentClassOf, replySortKey, INTENT_CLASSES }
