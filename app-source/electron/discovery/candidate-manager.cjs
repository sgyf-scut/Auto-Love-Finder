const { createHash } = require('node:crypto')
const { normalizeDiscoveryConfig } = require('./search-topics.cjs')
// P2-16.1：资料结论必须带来源，五态分别为 未知/本人自述/主页公开/人工核实/信息冲突。
const { FACT_STATUS, buildProfileFacts, factValue } = require('./profile-facts.cjs')

const MAX_CANDIDATES = 1000
const REVIEW_STATES = new Set(['REVIEW_PENDING', 'APPROVED', 'DEFERRED', 'REJECTED'])
const STORED_STATES = new Set([...REVIEW_STATES, 'DISCOVERED', 'APPROVED_PENDING_CONTACT', 'CONTACT_QUEUED', 'FOLLOW_PENDING', 'CONTACT_WAITLIST', 'SEND_UNKNOWN', 'PAUSED', 'FOLLOWING', 'FOLLOWED', 'FOLLOW_UNCERTAIN', 'OPENING_SENDING', 'OPENING_SENT', 'MESSAGE_UNCERTAIN', 'WAITING_REPLY', 'REPLIED', 'CONTACT', 'IDENTITY_MISMATCH', 'FOLLOW_FAILED', 'MESSAGE_FAILED', 'ACTIVE', 'FAILED'])
const reviewNames = { REVIEW_PENDING: 'pending', APPROVED: 'approved', DEFERRED: 'deferred', REJECTED: 'rejected' }
// P2-12C：发现等级/状态独立于联系人审核状态与消息发送状态。
const DISCOVERY_GRADES = new Set(['A', 'B', 'C', 'D'])
const DISCOVERY_STATUS = new Set(['DISCOVERED', 'QUALIFIED', 'INSUFFICIENT_INFO', 'EXCLUDED', 'REJECTED'])
const GRADE_OF_INTENT = { EXPLICIT_INVITATION: 'A', SEEKING_FRIENDS: 'B', CONTEXTUAL_INTEREST: 'C' }
const GRADE_LABELS = { A: '明确交友意愿', B: '一般交友意愿', C: '语境兴趣·证据不足', D: '普通评论/广告/拒绝联系' }
// P2-16.1：核实状态扩成五态，旧的 verified 继续兼容（等价于人工核实）。
const VERIFY_STATUS = new Set(['unknown', 'self_declared', 'public_profile', 'manual', 'conflict', 'verified'])
// P2-13：关注与首次联系是独立动作状态，不能塞进 status/contact/review 里。
const FOLLOW_STATUS = new Set(['not_started', 'pending', 'followed', 'failed', 'skipped', 'blocked'])
const FIRST_MESSAGE_STATUS = new Set(['not_eligible', 'pending', 'sent', 'failed', 'blocked', 'skipped'])
const gradeOfIntent = intent => GRADE_OF_INTENT[intent] || 'D'
const clean = (value, limit = 800) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
function genderValue(value) {
  return ({ '女': 'female', '女性': 'female', '女生': 'female', female: 'female', '男': 'male', '男性': 'male', '男生': 'male', male: 'male' })[String(value || '').trim().toLowerCase()] || 'unknown'
}
const isFactStatus = status => typeof status === 'string' && Object.values(FACT_STATUS).includes(status)

// 带来源的资料结论。旧记录没有 profileFacts 时现场补算，不写盘。
function candidateProfileFacts(candidate) {
  const stored = candidate?.profileFacts
  if (stored && stored.gender && stored.age) return stored
  return buildProfileFacts(candidate || {})
}

// 返回 female / male / unknown / conflict。
// 主页公开为男性而人工确认不同时记 conflict，但判定沿用公开值（不能靠人工把男性放进来）。
function candidateGender(candidate) {
  const fact = candidateProfileFacts(candidate).gender
  if (fact && isFactStatus(fact.status)) {
    if (fact.status === FACT_STATUS.CONFLICT) return fact.blockingValue || 'conflict'
    return factValue(fact) || 'unknown'
  }
  const published = genderValue(candidate?.publicSignals?.genderText)
  return published !== 'unknown' ? published : candidate?.review?.genderConfirmation?.source === 'manual' ? genderValue(candidate.review.genderConfirmation.value) : 'unknown'
}
function candidateEligibility(candidate, config) {
  const facts = candidateProfileFacts(candidate)
  const gender = candidateGender(candidate), followers = candidate?.publicSignals?.followerCount
  // 来源互相矛盾时不猜：没有可依据的公开值时留在待核实；有公开值时按公开值继续判定。
  if (gender === 'conflict') return { matches: false, pending: true, reason: '性别来源互相矛盾（评论自述与主页公开不一致），需人工裁决' }
  if (facts.age && facts.age.status === FACT_STATUS.CONFLICT) {
    const blocked = Number.isSafeInteger(facts.age.blockingValue) ? facts.age.blockingValue : null
    if (blocked === null) return { matches: false, pending: true, reason: '年龄来源互相矛盾（评论自述与主页公开不一致），需人工裁决' }
    if (config.requireAgeRange && (blocked < config.ageMin || blocked > config.ageMax)) return { matches: false, pending: false, reason: `年龄须在${config.ageMin}至${config.ageMax}岁之间` }
  }
  if (gender === 'male') return { matches: false, pending: false, reason: '公开资料或人工核验为男性，不主动联系' }
  if (config.requireFollowerLimit && Number.isSafeInteger(followers) && followers >= config.followerLimit) return { matches: false, pending: false, reason: `粉丝数须少于${config.followerLimit}` }
  if (config.targetGender === 'female' && gender !== 'female') return { matches: false, pending: true, reason: '请读取公开资料或查看主页后人工确认女性' }
  if (config.requireFollowerLimit && (!Number.isSafeInteger(followers) || followers < 0)) return { matches: false, pending: true, reason: '尚未读到可靠的公开粉丝数，请重新读取主页' }
  const age = candidateAge(candidate)
  if (config.requireAgeRange && age === null) return { matches: false, pending: true, reason: '年龄未核实：评论未提及、主页也无公开年龄；请人工确认，不能根据头像推断' }
  if (config.requireAgeRange && (age < config.ageMin || age > config.ageMax)) return { matches: false, pending: false, reason: `年龄须在${config.ageMin}至${config.ageMax}岁之间` }
  return { matches: true, pending: false, reason: '符合已设置的筛选条件' }
}
// 年龄：冲突与未知都返回 null；若冲突源于"主页公开值与人工不同"，判定沿用公开值。
function candidateAge(candidate) {
  const ageFact = candidateProfileFacts(candidate).age
  if (ageFact && isFactStatus(ageFact.status)) {
    const value = ageFact.status === FACT_STATUS.CONFLICT ? ageFact.blockingValue : factValue(ageFact)
    return Number.isSafeInteger(value) && value >= 1 && value <= 120 ? value : null
  }
  const signals = candidate?.publicSignals || {}
  const published = Number.isSafeInteger(signals.age) ? signals.age : /^\d{1,3}(?:岁)?$/.test(String(signals.ageText || '').trim()) ? Number(String(signals.ageText).replace('岁', '').trim()) : null
  if (published !== null && published >= 1 && published <= 120) return published
  const manual = candidate?.review?.ageConfirmation
  return manual?.source === 'manual' && Number.isSafeInteger(manual.value) && manual.value >= 1 && manual.value <= 120 ? manual.value : null
}
// 拒绝联系永远最高优先级：无论重新跑模型、换分类器还是迁移旧数据，
// action 都不得让 REJECTED 候选人重新进入关注/私信队列。
function normalizeCandidateAction(value, candidate) {
  const source = plain(value)
  const rejected = candidate?.status === 'REJECTED' || candidate?.discoveryStatus === 'REJECTED'
  const followStatus = rejected ? 'blocked' : FOLLOW_STATUS.has(source.followStatus) ? source.followStatus : plain(candidate?.contact).followStatus === 'followed' ? 'followed' : 'not_started'
  const firstMessageStatus = rejected ? 'blocked' : FIRST_MESSAGE_STATUS.has(source.firstMessageStatus) ? source.firstMessageStatus : 'not_eligible'
  return {
    followStatus,
    firstMessageStatus,
    consentEvidenceId: clean(source.consentEvidenceId, 150) || null,
    lastAttemptAt: typeof source.lastAttemptAt === 'string' ? clean(source.lastAttemptAt, 80) : null,
    lastActionReason: clean(source.lastActionReason, 300),
    policyVersion: clean(source.policyVersion, 40) || null,
    followTaskId: clean(source.followTaskId, 120) || null,
    firstMessageTaskId: clean(source.firstMessageTaskId, 120) || null,
    // 结果待核实门禁：人工核对前禁止自动重发。必须持久化，否则下一批会重复外发。
    ...(source.needsReview === true ? { needsReview: true, autoRetryBlocked: true, reviewRequiredAt: typeof source.reviewRequiredAt === 'string' ? clean(source.reviewRequiredAt, 80) : null } : {}),
  }
}
function canonicalProfile(value) {
  let url
  try { url = new URL(clean(value, 1000)) } catch { return null }
  const match = /^\/user\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
  if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || !match || match[1].toLowerCase() === 'self') return null
  return { profileUrl: `https://www.douyin.com/user/${match[1]}`, platformUserId: match[1] }
}
function publicImage(value) {
  try { const url = new URL(clean(value, 2000)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' } catch { return '' }
}
function normalizedSource(value) {
  value = plain(value)
  if (value.type === 'user_search') {
    const keyword = clean(value.keyword, 100)
    return keyword ? { type: 'user_search', topic: 'user_search', keyword, summary: clean(value.summary, 1800), ...(typeof value.observedAt === 'string' ? { observedAt: clean(value.observedAt, 80) } : {}) } : null
  }
  const source = { type: 'comment', topic: clean(value.topic, 100), keyword: clean(value.keyword, 100), videoId: clean(value.videoId, 100), videoTitle: clean(value.videoTitle, 500), commentId: clean(value.commentId, 100), commentText: clean(value.commentText, 4000) }
  if (typeof value.observedAt === 'string') source.observedAt = clean(value.observedAt, 80)
  if (value.activitySource === 'public_comment' && typeof value.publishedAt === 'string') { source.activitySource = 'public_comment'; source.publishedAt = clean(value.publishedAt, 80) }
  if (typeof value.isReply === 'boolean') source.isReply = value.isReply
  if (Number.isSafeInteger(value.replyCount) && value.replyCount >= 0) source.replyCount = value.replyCount
  // P2-17B：评论级依据（IP 属地、评论时间）随来源保存，供批次筛选与卡片展示。
  if (typeof value.commentIpLocation === 'string' && value.commentIpLocation.trim()) source.commentIpLocation = clean(value.commentIpLocation, 40)
  // 证据来源随字段一起保存：界面要能说明"这条 IP 是页面明写的还是元信息地区段"。
  if (typeof value.commentIpLocationSource === 'string' && value.commentIpLocationSource.trim()) source.commentIpLocationSource = clean(value.commentIpLocationSource, 30)
  if (typeof value.commentTime === 'string' && value.commentTime.trim()) source.commentTime = clean(value.commentTime, 60)
  if (value.parentCommentId) source.parentCommentId = clean(value.parentCommentId, 100)
  if (Number.isSafeInteger(value.scrollDepth)) source.scrollDepth = Math.max(0, value.scrollDepth)
  if (!source.topic || !source.keyword || !/^[A-Za-z0-9_-]+$/.test(source.videoId) || !source.commentText) return null
  return source
}
function sourceKey(source) { return source.type === 'user_search' ? `user_search\u0000${source.keyword}\u0000${source.summary}` : `${source.videoId}\u0000${source.commentId ? `id:${source.commentId}` : `text:${source.commentText}`}` }
function mergeSources(oldSources, newSources) {
  const merged = [], seen = new Set()
  for (const source of [...oldSources, ...newSources]) {
    const valid = normalizedSource(source)
    if (!valid || seen.has(sourceKey(valid))) continue
    seen.add(sourceKey(valid)); merged.push(valid)
  }
  return merged
}
function recordEvent(candidate, type, detail, at) {
  candidate.timeline = [...(candidate.timeline || []), { type, at, detail }].slice(-200)
}
function recordIdentity(value) {
  const identity = canonicalProfile(value?.profileUrl), nickname = clean(value?.nickname, 100)
  if (!identity || !nickname) return null
  // sec_uid is the public profile identity. A numeric uid is a different field.
  if (value.platformUserId != null && value.platformUserId !== '' && value.platformUserId !== identity.platformUserId) return null
  if (value.platformUserIdType && value.platformUserIdType !== 'sec_uid') return null
  return { ...identity, nickname }
}
function candidateId(identity, accountId) { return `candidate_${createHash('sha256').update(`${accountId}\u0000${identity.platformUserId}`).digest('hex').slice(0, 24)}` }
function normalizedStoredCandidate(value) {
  value = plain(value)
  const identity = recordIdentity(value)
  if (!identity) return null
  const sources = mergeSources(value.source ? [value.source] : [], Array.isArray(value.sources) ? value.sources : [])
  if (!sources.length) return null
  const status = STORED_STATES.has(value.status) ? value.status : ({ approved: 'APPROVED', deferred: 'DEFERRED', rejected: 'REJECTED' }[value.review?.status] || 'REVIEW_PENDING')
  const accountId = clean(value.accountId, 150)
  const storedReview = { ...plain(value.review), status: reviewNames[status] || clean(value.review?.status, 30) || (status === 'DISCOVERED' ? 'pending' : 'approved'), note: clean(value.review?.note, 2000) }
  // 每次归一化都按当前来源重算资料结论；人工核验值来自 review，不会被覆盖。
  const profileFacts = buildProfileFacts({ sources, publicSignals: value.publicSignals, publicProfile: value.publicProfile, review: storedReview })
  const verifyOf = fact => (fact && fact.status === 'verified' ? 'manual' : fact && isFactStatus(fact.status) ? fact.status : 'unknown')
  return {
    ...value, ...identity, id: clean(value.id, 150) || candidateId(identity, accountId), accountId, platform: 'douyin', platformUserIdType: 'sec_uid',
    source: sources[0], firstComment: clean(value.firstComment, 4000) || sources.find(source => source.commentText)?.commentText || '', sources,
    timeline: Array.isArray(value.timeline) ? value.timeline.filter(event => event && typeof event.type === 'string' && typeof event.at === 'string').slice(-200) : [],
    review: storedReview,
    profileFacts,
    contact: { status: 'not_started', followStatus: 'not_started', openingStatus: 'not_started', ...plain(value.contact) }, status,
    action: normalizeCandidateAction(value.action, { status, discoveryStatus: value.discoveryStatus, contact: value.contact }),
    // 发现等级/状态与 status 分离；拒绝联系优先级最高。
    discoveryGrade: status === 'REJECTED' ? 'D' : DISCOVERY_GRADES.has(value.discoveryGrade) ? value.discoveryGrade : gradeOfIntent(value.libraryIntent),
    discoveryGradeLabel: GRADE_LABELS[status === 'REJECTED' ? 'D' : DISCOVERY_GRADES.has(value.discoveryGrade) ? value.discoveryGrade : gradeOfIntent(value.libraryIntent)],
    discoveryStatus: status === 'REJECTED' ? 'REJECTED' : DISCOVERY_STATUS.has(value.discoveryStatus) ? value.discoveryStatus : (gradeOfIntent(value.libraryIntent) === 'C' ? 'INSUFFICIENT_INFO' : 'DISCOVERED'),
    libraryEvidence: Array.isArray(value.libraryEvidence) ? value.libraryEvidence.filter(item => typeof item === 'string').slice(0, 6) : [],
    intentConfidence: Number.isFinite(value.intentConfidence) ? Math.max(0, Math.min(1, value.intentConfidence)) : null,
    explicitInvitation: value.explicitInvitation === true || (value.libraryIntent === 'EXPLICIT_INVITATION' && value.consentToDm === true),
    // 资料核实状态直接来自 profileFacts，界面上不再出现"只有已核实/未知"两态的说法。
    ageVerification: verifyOf(profileFacts.age),
    genderVerification: verifyOf(profileFacts.gender),
    commentTime: clean(value.commentTime, 80) || '',
  }
}
function normalizeDiscovery(value = {}) {
  value = plain(value)
  const candidates = [], identities = new Map()
  for (const input of Array.isArray(value.candidates) ? value.candidates : []) {
    const candidate = normalizedStoredCandidate(input)
    if (!candidate) continue
    const identityKey = `${candidate.accountId}\u0000${candidate.platformUserId}`
    const existing = identities.get(identityKey)
    if (existing) {
      existing.sources = mergeSources(existing.sources, candidate.sources)
      const seenEvents = new Set(existing.timeline.map(event => JSON.stringify(event)))
      existing.timeline = [...existing.timeline, ...candidate.timeline.filter(event => !seenEvents.has(JSON.stringify(event)))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-200)
      // Never lose an explicit review on migration when duplicate records exist.
      if (existing.status === 'REVIEW_PENDING' && candidate.status !== 'REVIEW_PENDING') {
        existing.status = candidate.status; existing.review = candidate.review; existing.contact = candidate.contact
      }
      continue
    }
    identities.set(identityKey, candidate); candidates.push(candidate)
  }
  // Existing records are retained even if an older version exceeded the cap.
  return { ...value, config: normalizeDiscoveryConfig(value.config), candidates, runState: { ...plain(value.runState) } }
}
class CandidateManager {
  constructor(storage) { this.storage = storage }
  get() { return normalizeDiscovery(this.storage.get().discovery) }
  save(discovery) { this.storage.update({ discovery }); return this.get() }
  updateConfig(patch = {}) {
    const discovery = this.get()
    discovery.config = normalizeDiscoveryConfig({ ...discovery.config, ...plain(patch) })
    return this.save(discovery)
  }
  upsert(records, { accountId = '' } = {}) {
    if (!Array.isArray(records)) throw new Error('候选发现结果必须是数组')
    const discovery = this.get(), identities = new Map()
    // A normally isolated account store can still contain legacy mixed owners.
    // Prefer this account's record, while rejecting writes into another owner.
    for (const item of discovery.candidates) {
      if (!identities.has(item.platformUserId) || item.accountId === accountId) identities.set(item.platformUserId, item)
    }
    const now = new Date().toISOString(), counts = { added: 0, merged: 0, skipped: 0, invalid: 0 }
    for (const input of records) {
      const identity = recordIdentity(input), source = normalizedSource(input?.source)
      if (!identity || !source) { counts.invalid++; continue }
      const candidate = identities.get(identity.platformUserId)
      if (candidate) {
        if (candidate.accountId && accountId && candidate.accountId !== accountId) { counts.invalid++; continue }
        const promotingToDefault = candidate.customOnly === true && !input.goalMatch && Boolean(input.libraryIntent)
        const newSource = { ...source, observedAt: now }
        const merged = promotingToDefault ? mergeSources([newSource], candidate.sources) : mergeSources(candidate.sources, [newSource])
        if (merged.length > candidate.sources.length) recordEvent(candidate, 'source_added', { sourceType: source.type, topic: source.topic, keyword: source.keyword, ...(source.videoId ? { videoId: source.videoId, commentId: source.commentId } : {}) }, now)
        candidate.sources = merged; candidate.updatedAt = now
        if (input.goalMatch) {
          const matches = candidate.goalMatches || []
          const same = item => item.snapshotId === input.goalMatch.snapshotId && item.key === input.goalMatch.key
          candidate.goalMatches = [...matches.filter(item => !same(item)), input.goalMatch]
        }
        if (promotingToDefault) {
          candidate.customOnly = false
          candidate.source = merged[0]
          candidate.firstComment = merged[0].commentText
        }
        // 同一人多次出现时保留最强意愿标签；只有明确邀请+证据才算“同意私信”。
        const rank = value => ({ CONTEXTUAL_INTEREST: 1, SEEKING_FRIENDS: 2, EXPLICIT_INVITATION: 3 })[value] || 0
        // 拒绝联系优先：即便后来出现积极评论，也不把拒绝者重新放回可联系候选。
        if (!candidate.review?.intentConfirmation && candidate.status !== 'REJECTED' && rank(input.libraryIntent) > rank(candidate.libraryIntent)) {
          candidate.libraryIntent = input.libraryIntent
          candidate.discoveryGrade = DISCOVERY_GRADES.has(input.discoveryGrade) ? input.discoveryGrade : gradeOfIntent(input.libraryIntent)
          candidate.discoveryGradeLabel = GRADE_LABELS[candidate.discoveryGrade]
          candidate.discoveryStatus = DISCOVERY_STATUS.has(input.discoveryStatus) ? input.discoveryStatus : (candidate.discoveryGrade === 'C' ? 'INSUFFICIENT_INFO' : 'DISCOVERED')
          candidate.consentToDm = input.consentToDm === true
          candidate.explicitInvitation = input.explicitInvitation === true
          candidate.libraryEvidence = Array.isArray(input.libraryEvidence) ? input.libraryEvidence.filter(item => typeof item === 'string').slice(0, 6) : []
          candidate.intentConfidence = Number.isFinite(input.intentConfidence) ? input.intentConfidence : null
          candidate.commentTime = clean(input.commentTime, 80) || candidate.commentTime || ''
        } else if (!candidate.review?.intentConfirmation && candidate.status !== 'REJECTED' && rank(input.libraryIntent) === rank(candidate.libraryIntent)) {
          // 同级新证据只补充证据文本，不覆盖人工确认的年龄/性别和审核状态。
          const evidence = Array.isArray(input.libraryEvidence) ? input.libraryEvidence.filter(item => typeof item === 'string' && !candidate.libraryEvidence.includes(item)) : []
          if (evidence.length) candidate.libraryEvidence = [...candidate.libraryEvidence, ...evidence].slice(0, 6)
        }
        if (input.publicSignals || input.publicProfile) {
          if (input.publicSignals) candidate.publicSignals = { ...candidate.publicSignals, ...Object.fromEntries(Object.entries(input.publicSignals).filter(([,v]) => v !== null && v !== undefined && v !== '')) }
          if (input.publicProfile) candidate.publicProfile = input.publicProfile
          candidate.profileFacts = buildProfileFacts(candidate)
        }
        // Preserve the first nickname, comment and review for human decisions.
        counts.merged++; continue
      }
      if (discovery.candidates.length >= MAX_CANDIDATES) { counts.skipped++; continue }
      const numericId = Number.isSafeInteger(input.platformNumericUserId) && input.platformNumericUserId >= 0 ? String(input.platformNumericUserId) : clean(input.platformNumericUserId, 50)
      source.observedAt = now
      const record = {
        id: candidateId(identity, clean(accountId, 150)), ...identity, accountId: clean(accountId, 150), platform: 'douyin', platformUserIdType: 'sec_uid',
        platformNumericUserId: /^\d+$/.test(numericId) ? numericId : '', avatarUrl: publicImage(input.avatarUrl),
        source, sources: [source], firstComment: source.commentText || '', timeline: [],
        score: typeof input.score === 'number' && Number.isFinite(input.score) ? Math.max(0, Math.min(100, input.score)) : null,
        signals: Array.isArray(input.signals) ? input.signals.filter(item => typeof item === 'string').map(item => clean(item, 500)).slice(0, 30) : [],
        libraryIntent: clean(input.libraryIntent, 40) || '',
        ...(input.goalMatch ? { goalMatches: [input.goalMatch], customOnly: true } : {}),
        consentToDm: input.consentToDm === true,
        discoveryGrade: DISCOVERY_GRADES.has(input.discoveryGrade) ? input.discoveryGrade : gradeOfIntent(input.libraryIntent),
        discoveryGradeLabel: GRADE_LABELS[DISCOVERY_GRADES.has(input.discoveryGrade) ? input.discoveryGrade : gradeOfIntent(input.libraryIntent)],
        discoveryStatus: DISCOVERY_STATUS.has(input.discoveryStatus) ? input.discoveryStatus : (gradeOfIntent(input.libraryIntent) === 'C' ? 'INSUFFICIENT_INFO' : 'DISCOVERED'),
        discoveryStatusNote: clean(input.discoveryStatusNote, 300),
        libraryEvidence: Array.isArray(input.libraryEvidence) ? input.libraryEvidence.filter(item => typeof item === 'string').slice(0, 6) : [],
        intentConfidence: Number.isFinite(input.intentConfidence) ? Math.max(0, Math.min(1, input.intentConfidence)) : null,
        explicitInvitation: input.explicitInvitation === true,
        commentTime: clean(input.commentTime, 80),
        // 年龄/性别只从本人公开自述或人工确认读取；默认未知，绝不根据头像/昵称推测。
        ageVerification: VERIFY_STATUS.has(input.ageVerification) ? input.ageVerification : 'unknown',
        genderVerification: VERIFY_STATUS.has(input.genderVerification) ? input.genderVerification : 'unknown',
        // P2-17B.2：主页公开资料与资料结论必须随候选一起落盘。
        // 之前新候选只写 verification 状态、丢掉 publicSignals/profileFacts，
        // 导致"先写候选、后读主页"或"带着公开资料入池"的资料在下次读取时消失。
        ...(input.publicSignals && typeof input.publicSignals === 'object' ? { publicSignals: plain(input.publicSignals) } : {}),
        ...(input.publicProfile && typeof input.publicProfile === 'object' ? { publicProfile: plain(input.publicProfile) } : {}),
        profileFacts: input.profileFacts && typeof input.profileFacts === 'object'
          ? plain(input.profileFacts)
          : buildProfileFacts({ sources: [source], publicSignals: input.publicSignals, publicProfile: input.publicProfile, review: {} }),
        intentPoolOnly: input.intentPoolOnly === true,
        status: 'REVIEW_PENDING', review: { status: 'pending', note: '', approvedAt: null, rejectedAt: null, reviewedAt: null },
        contact: { status: 'not_started', followStatus: 'not_started', openingStatus: 'not_started', openingMessage: null, followedAt: null, openingSentAt: null },
        action: normalizeCandidateAction({}, { status: 'REVIEW_PENDING', discoveryStatus: 'DISCOVERED', contact: {} }),
        createdAt: now, updatedAt: now,
      }
      const history = discovery.candidateContactHistory?.[identity.platformUserId]
      if (history && (!history.accountId || history.accountId === accountId)) {
        record.status = history.status || record.status
        record.contact = { ...record.contact, ...history.contact }
        record.action = normalizeCandidateAction(history.action, record)
        if (history.realContact) record.review.realContact = history.realContact
        if (record.status === 'REJECTED') record.review.status = 'rejected'
      }
      recordEvent(record, 'first_discovered', { sourceType: source.type, topic: source.topic, keyword: source.keyword }, now)
      discovery.candidates.push(record); identities.set(record.platformUserId, record); counts.added++
    }
    return { ...counts, discovery: this.save(discovery) }
  }
  upsertUserSearch(records, { accountId = '', keyword = '' } = {}) {
    if (!Array.isArray(records)) throw new Error('候选搜索结果必须是数组')
    return this.upsert(records.map(record => ({ nickname: record?.name, profileUrl: record?.url,
      platformUserId: record?.platformUserId, platformUserIdType: record?.platformUserIdType,
      source: { type: 'user_search', keyword: keyword || record?.keyword, summary: record?.summary } })), { accountId })
  }
  patch(id, patch = {}) {
    patch = plain(patch)
    const protectedKeys = ['id', 'accountId', 'platform', 'platformUserId', 'platformUserIdType', 'profileUrl', 'nickname', 'platformNumericUserId', 'createdAt', 'source', 'sources', 'firstComment']
    if (protectedKeys.some(key => Object.hasOwn(patch, key))) throw new Error('候选身份和原始来源不能通过状态更新修改')
    if (patch.status !== undefined && !STORED_STATES.has(patch.status)) throw new Error('不支持的候选状态')
    const discovery = this.get(), index = discovery.candidates.findIndex(candidate => candidate.id === id)
    if (index < 0) throw new Error('找不到此候选人，请刷新候选池')
    const previous = discovery.candidates[index]
    const nextStatus = patch.status !== undefined ? patch.status : previous.status
    discovery.candidates[index] = { ...previous, ...patch,
      ...(patch.contact ? { contact: { ...previous.contact, ...plain(patch.contact) } } : {}),
      ...(patch.review ? { review: { ...previous.review, ...plain(patch.review) } } : {}),
      // 动作状态只能合并，且拒绝联系时强制阻断，避免旧队列把 REJECTED 拉回执行。
      ...(patch.action || nextStatus === 'REJECTED' ? { action: normalizeCandidateAction({ ...previous.action, ...plain(patch.action) }, { status: nextStatus, discoveryStatus: nextStatus === 'REJECTED' ? 'REJECTED' : previous.discoveryStatus }) } : {}),
      updatedAt: new Date().toISOString() }
    const saved = this.save(discovery)
    return saved.candidates.find(candidate => candidate.id === id)
  }
  appendEvent(id, type, detail = {}) {
    if (!clean(type, 100)) throw new Error('候选时间线事件类型不能为空')
    const candidate = this.get().candidates.find(item => item.id === id)
    if (!candidate) throw new Error('找不到此候选人，请刷新候选池')
    const event = { type: clean(type, 100), at: new Date().toISOString(), detail: typeof detail === 'string' ? clean(detail, 2000) : plain(detail) }
    return this.patch(id, { timeline: [...candidate.timeline, event].slice(-200) })
  }
  setIntent(id, intent) {
    if (!['EXPLICIT_INVITATION','SEEKING_FRIENDS','CONTEXTUAL_INTEREST','ORDINARY','DO_NOT_CONTACT','ADVERTISEMENT','UNKNOWN'].includes(intent)) throw new Error('意愿等级无效')
    const discovery = this.get(), candidate = discovery.candidates.find(item => item.id === id)
    if (!candidate) throw new Error('找不到此候选人，请刷新候选池')
    const now = new Date().toISOString(), previous = candidate.libraryIntent || 'UNKNOWN'
    candidate.review = { ...candidate.review, intentConfirmation: { value: intent, source: 'manual', confirmedAt: now, previous } }
    candidate.libraryIntent = intent
    candidate.discoveryGrade = candidate.status === 'REJECTED' ? 'D' : gradeOfIntent(intent)
    candidate.discoveryGradeLabel = GRADE_LABELS[candidate.discoveryGrade]
    if (candidate.status !== 'REJECTED' && !['REJECTED', 'EXCLUDED'].includes(candidate.discoveryStatus)) candidate.discoveryStatus = candidate.discoveryGrade === 'C' ? 'INSUFFICIENT_INFO' : 'DISCOVERED'
    // An intent correction never manufactures a platform invitation or clears send receipts.
    candidate.consentToDm = false; candidate.explicitInvitation = false
    candidate.updatedAt = now
    recordEvent(candidate, 'manual_intent', { previous, intent }, now)
    this.save(discovery)
    return { ok: true, candidate, discovery: this.get() }
  }
  review(id, { status, note = '', genderConfirmation, ageConfirmation } = {}) {
    if (!REVIEW_STATES.has(status)) throw new Error('不支持的候选审核状态')
    const discovery = this.get(), candidate = discovery.candidates.find(item => item.id === id)
    if (!candidate) throw new Error('找不到此候选人，请刷新候选池')
    if (!REVIEW_STATES.has(candidate.status) && candidate.status !== 'DISCOVERED') throw new Error('候选人已进入联系流程，不能通过审核操作重置')
    const now = new Date().toISOString()
    const review = { ...candidate.review }
    if (genderConfirmation !== undefined) {
      if (!['female', 'male', 'unknown'].includes(genderConfirmation)) throw new Error('性别核验结果无效')
      review.genderConfirmation = { value: genderConfirmation, source: 'manual', confirmedAt: now }
    }
    if (ageConfirmation !== undefined) {
      if (ageConfirmation === 'unknown') ageConfirmation = null
      if (ageConfirmation !== null && (!Number.isSafeInteger(ageConfirmation) || ageConfirmation < 1 || ageConfirmation > 120)) throw new Error('年龄核验结果无效')
      review.ageConfirmation = ageConfirmation === null ? null : { value: ageConfirmation, source: 'manual', confirmedAt: now }
    }
    // 人工结论要参与本次判定：传入的新 review 必须重算资料事实，否则会沿用旧的 unknown/conflict。
    const nextFacts = buildProfileFacts({ ...candidate, review })
    const eligibility = candidateEligibility({ ...candidate, review, profileFacts: nextFacts }, discovery.config)
    if (status === 'APPROVED' && !eligibility.matches) throw new Error(eligibility.reason)
    candidate.status = status; candidate.updatedAt = now
    candidate.review = { ...review, status: reviewNames[status], note: clean(note, 2000), reviewedAt: now }
    if (status === 'APPROVED') candidate.review.approvedAt = now
    if (status === 'REJECTED') {
      candidate.review.rejectedAt = now
      // 拒绝联系优先：发现等级/状态同步为 D/REJECTED，并撤销私信同意。
      candidate.discoveryGrade = 'D'
      candidate.discoveryGradeLabel = GRADE_LABELS.D
      candidate.discoveryStatus = 'REJECTED'
      candidate.explicitInvitation = false
      candidate.consentToDm = false
      // 动作层同样阻断，历史队列任务不得绕过人工拒绝。
      candidate.action = normalizeCandidateAction({ ...candidate.action }, { status: 'REJECTED', discoveryStatus: 'REJECTED' })
    }
    // 人工核验是五态里的 manual；不再写回笼统的 verified/unknown 两态。
    if (genderConfirmation !== undefined) candidate.genderVerification = review.genderConfirmation?.source === 'manual' ? 'manual' : 'unknown'
    if (ageConfirmation !== undefined) candidate.ageVerification = review.ageConfirmation?.source === 'manual' ? 'manual' : 'unknown'
    candidate.profileFacts = nextFacts
    recordEvent(candidate, 'manual_review', { status, note: candidate.review.note,
      ...(genderConfirmation !== undefined ? { genderConfirmation } : {}), ...(ageConfirmation !== undefined ? { ageConfirmation } : {}) }, now)
    this.save(discovery)
    return { ok: true, candidate, discovery: this.get() }
  }
}
module.exports = { CandidateManager, normalizeDiscovery, canonicalProfile, normalizeDiscoveryConfig, MAX_CANDIDATES, candidateGender, candidateAge, candidateEligibility, candidateProfileFacts, STORED_STATES, DISCOVERY_GRADES, DISCOVERY_STATUS, GRADE_LABELS, gradeOfIntent, normalizeCandidateAction, FOLLOW_STATUS, FIRST_MESSAGE_STATUS }
