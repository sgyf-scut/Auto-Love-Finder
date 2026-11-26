// P2-14A 候选资格审计：把「发现合格 / 联系资格 / 动作授权」拆成三个独立结论。
// 只有原始评论、当前分类、可核实资料和明确许可同时成立，才可能进入真实动作；
// 本模块只做只读审计，不抓取页面、不关注、不发送、不改写候选人状态。
const { evaluateCandidate, consentEvidenceOf, taskIdOf } = require('./auto-contact.cjs')
const { candidateAge, candidateGender, candidateProfileFacts } = require('./candidate-manager.cjs')
const { findCommentForCandidate, findVideoForComment } = require('../social-brain/library-candidates.cjs')
const { commentInputHash } = require('../social-brain/library-classifier.cjs')

const AUDIT_VERSION = 'P2-16.1'
const DISCOVERY = { QUALIFIED: 'DISCOVERY_QUALIFIED', NOT_QUALIFIED: 'DISCOVERY_NOT_QUALIFIED', INSUFFICIENT: 'DISCOVERY_INSUFFICIENT' }
const CONTACT = { ELIGIBLE: 'CONTACT_ELIGIBLE', NOT_ELIGIBLE: 'CONTACT_NOT_ELIGIBLE', INSUFFICIENT: 'CONTACT_INSUFFICIENT_INFO' }
const ACTION = { AUTHORIZED: 'ACTION_AUTHORIZED', NOT_AUTHORIZED: 'ACTION_NOT_AUTHORIZED', BLOCKED: 'ACTION_BLOCKED' }
const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

function layer(status, reasons = []) {
  return { status, allowed: status === DISCOVERY.QUALIFIED || status === CONTACT.ELIGIBLE || status === ACTION.AUTHORIZED, reasons }
}

function configNotes(config = {}) {
  const notes = []
  if (config.targetGender === 'any' || !config.targetGender) notes.push('目标性别为“不限”：性别条件没有参与任何过滤，不能声称候选人满足女性/男性要求')
  if (!config.requireAgeRange) notes.push('未启用年龄范围：年龄条件没有参与过滤，不能声称候选人满足年龄要求')
  if (config.requireAgeRange) notes.push(`年龄范围 ${config.ageMin ?? 18}-${config.ageMax ?? 45}：仅已核实年龄的人参与判断`)
  if (!config.requireFollowerLimit) notes.push('未启用粉丝数范围：粉丝数条件没有参与过滤')
  if (config.requireFollowerLimit) notes.push(`粉丝数范围 ${config.followerMin ?? 0}-${config.followerMax ?? 100000}`)
  if (!config.autoFollow) notes.push('未开启自动关注：只能生成计划，不能执行真实关注')
  if (!config.autoFirstMessage) notes.push('未开启自动首次联系：只能生成首次联系计划')
  return notes
}

// P2-15.1 三类证据分别记录，互不替代：
//   ① 平台自动化权限：账号能登录 ≠ 平台允许自动化操作；
//   ② 对方同意：操作者勾选确认 ≠ 对方已经同意；
//   ③ 操作者确认：只对指定对象、指定动作、有效期内生效，不是一次勾选永久解锁全部人。
// 只有布尔值、没有时间与依据的旧记录一律视为未记录（LEGACY_UNSCOPED），不能当成已核实。
const EVIDENCE_STATUS = { RECORDED: 'RECORDED', MISSING: 'MISSING', EXPIRED: 'EXPIRED', LEGACY_UNSCOPED: 'LEGACY_UNSCOPED' }
const EVIDENCE_KIND = { PLATFORM: 'platform', RECIPIENT: 'recipient', OPERATOR: 'operator', CONSENT: 'consent' }

function evidenceItem(kind, status, detail = {}, reason = null) {
  return { kind, status, ok: status === EVIDENCE_STATUS.RECORDED, reason, ...detail }
}

function platformEvidence(auth = {}, now) {
  const source = auth?.platform && typeof auth.platform === 'object' ? auth.platform : {}
  const verifiedAt = clean(source.verifiedAt, 40) || null
  const basis = clean(source.basis || source.note, 300)
  const expiresAt = clean(source.expiresAt, 40) || null
  const legacy = source.allowed === true || auth?.platformAutomationAllowed === true
  if (!legacy) return evidenceItem(EVIDENCE_KIND.PLATFORM, EVIDENCE_STATUS.MISSING, { verifiedAt: null, basis: '', expiresAt: null }, 'PLATFORM_PERMISSION_UNVERIFIED')
  if (!verifiedAt || !basis) return evidenceItem(EVIDENCE_KIND.PLATFORM, EVIDENCE_STATUS.LEGACY_UNSCOPED, { verifiedAt, basis, expiresAt }, 'PLATFORM_PERMISSION_UNVERIFIED')
  if (expiresAt && Date.parse(expiresAt) <= now) return evidenceItem(EVIDENCE_KIND.PLATFORM, EVIDENCE_STATUS.EXPIRED, { verifiedAt, basis, expiresAt }, 'PLATFORM_PERMISSION_EXPIRED')
  return evidenceItem(EVIDENCE_KIND.PLATFORM, EVIDENCE_STATUS.RECORDED, { verifiedAt, basis, expiresAt }, null)
}

function recipientEvidence(auth = {}, platformUserId, now) {
  const table = auth?.recipientAiConsent && typeof auth.recipientAiConsent === 'object' ? auth.recipientAiConsent : {}
  const record = platformUserId && table[platformUserId] && typeof table[platformUserId] === 'object' ? table[platformUserId] : null
  const at = clean(record?.at || record?.acceptedAt, 40) || null
  const source = clean(record?.source, 200)
  if (!record || record.accepted !== true) return evidenceItem(EVIDENCE_KIND.RECIPIENT, EVIDENCE_STATUS.MISSING, { at: null, source: '' }, 'RECIPIENT_AI_CONSENT_MISSING')
  if (record.revokedAt) return evidenceItem(EVIDENCE_KIND.RECIPIENT, EVIDENCE_STATUS.EXPIRED, { at, source }, 'RECIPIENT_AI_CONSENT_REVOKED')
  if (!at) return evidenceItem(EVIDENCE_KIND.RECIPIENT, EVIDENCE_STATUS.LEGACY_UNSCOPED, { at: null, source }, 'RECIPIENT_AI_CONSENT_MISSING')
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return evidenceItem(EVIDENCE_KIND.RECIPIENT, EVIDENCE_STATUS.EXPIRED, { at, source }, 'RECIPIENT_AI_CONSENT_EXPIRED')
  return evidenceItem(EVIDENCE_KIND.RECIPIENT, EVIDENCE_STATUS.RECORDED, { at, source }, null)
}

function operatorEvidence(auth = {}, platformUserId, action, now) {
  const table = auth?.operator && typeof auth.operator === 'object' ? auth.operator : {}
  const record = platformUserId && table[platformUserId] && typeof table[platformUserId] === 'object' ? table[platformUserId] : null
  // 旧记录是一个全局时间戳：一次确认解锁所有人，无法追溯对象与动作范围，不再作为授权依据。
  if (!record) {
    const legacy = Boolean(auth?.operatorConfirmedAt)
    return evidenceItem(EVIDENCE_KIND.OPERATOR, legacy ? EVIDENCE_STATUS.LEGACY_UNSCOPED : EVIDENCE_STATUS.MISSING, { confirmedAt: null, actions: [], expiresAt: null }, legacy ? 'OPERATOR_CONFIRMATION_UNSCOPED' : 'OPERATOR_CONFIRMATION_MISSING')
  }
  const confirmedAt = clean(record.confirmedAt, 40) || null
  const actions = Array.isArray(record.actions) ? record.actions.map(item => clean(item, 20)).filter(Boolean) : []
  const expiresAt = clean(record.expiresAt, 40) || null
  if (!confirmedAt) return evidenceItem(EVIDENCE_KIND.OPERATOR, EVIDENCE_STATUS.LEGACY_UNSCOPED, { confirmedAt: null, actions, expiresAt }, 'OPERATOR_CONFIRMATION_UNSCOPED')
  if (!actions.includes(action)) return evidenceItem(EVIDENCE_KIND.OPERATOR, EVIDENCE_STATUS.MISSING, { confirmedAt, actions, expiresAt }, 'OPERATOR_CONFIRMATION_ACTION_MISMATCH')
  if (expiresAt && Date.parse(expiresAt) <= now) return evidenceItem(EVIDENCE_KIND.OPERATOR, EVIDENCE_STATUS.EXPIRED, { confirmedAt, actions, expiresAt }, 'OPERATOR_CONFIRMATION_EXPIRED')
  return evidenceItem(EVIDENCE_KIND.OPERATOR, EVIDENCE_STATUS.RECORDED, { confirmedAt, actions, expiresAt }, null)
}

// 评论区的一般交友意愿不是私信许可；授权必须另有平台权限、对方 AI 参与同意和操作者确认记录。
function authorizationOf(candidate, consent, options = {}) {
  const auth = options.authorization || {}
  const action = options.action === 'firstMessage' ? 'firstMessage' : 'follow'
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const platformUserId = clean(candidate?.platformUserId, 120)
  const platform = platformEvidence(auth, now)
  const recipient = recipientEvidence(auth, platformUserId, now)
  const operator = operatorEvidence(auth, platformUserId, action, now)
  const consentItem = consent?.ok
    ? evidenceItem(EVIDENCE_KIND.CONSENT, EVIDENCE_STATUS.RECORDED, { evidenceId: consent?.evidenceId || null }, null)
    : evidenceItem(EVIDENCE_KIND.CONSENT, EVIDENCE_STATUS.MISSING, { evidenceId: consent?.evidenceId || null }, consent?.reasonCode || 'CONSENT_NOT_EXPLICIT')
  const evidence = { platform, recipient, operator, consent: consentItem }
  const reasons = [...new Set([platform, recipient, operator, consentItem].filter(item => !item.ok && item.reason).map(item => item.reason))]
  return {
    action,
    status: reasons.length ? ACTION.NOT_AUTHORIZED : ACTION.AUTHORIZED,
    allowed: reasons.length === 0,
    reasons,
    evidence,
  }
}

function auditCandidate(candidate, { library, config = {}, excludePlatformUserIds = [], duplicateIds = new Set(), authorization = {} } = {}) {
  const platformUserId = clean(candidate?.platformUserId, 120)
  const profileUrl = clean(candidate?.profileUrl, 200)
  const discoveryReasons = []
  const comment = findCommentForCandidate(candidate, library)
  const video = comment ? findVideoForComment(comment, library) : null
  if (!platformUserId || !profileUrl) discoveryReasons.push('MISSING_AUTHOR_ID')
  if (!comment) discoveryReasons.push('SOURCE_COMMENT_MISSING')
  else {
    if (String(comment.author_id || '') !== platformUserId) discoveryReasons.push('SOURCE_AUTHOR_MISMATCH')
    if (!comment.classification?.intent) discoveryReasons.push('CLASSIFICATION_MISSING')
    if (!comment.classification?.reviewedByUser && comment.classification?.inputHash && comment.classification.inputHash !== commentInputHash(comment, video)) discoveryReasons.push('CLASSIFICATION_STALE')
  }
  if (!video) discoveryReasons.push('SOURCE_VIDEO_MISSING')
  if (candidate?.status === 'REJECTED' || candidate?.discoveryStatus === 'REJECTED') discoveryReasons.push('REJECTED_PROTECTED')
  if (candidate?.status === 'EXCLUDED' || candidate?.discoveryStatus === 'EXCLUDED') discoveryReasons.push('EXCLUDED')
  if (excludePlatformUserIds.map(String).includes(platformUserId)) discoveryReasons.push('ALREADY_CONTACT')
  if (duplicateIds.has(platformUserId)) discoveryReasons.push('DUPLICATE_CANDIDATE')
  if (!['EXPLICIT_INVITATION', 'SEEKING_FRIENDS'].includes(candidate?.libraryIntent)) discoveryReasons.push('NOT_FRIENDLY_INTENT')
  if (candidate?.discoveryStatus === 'INSUFFICIENT_INFO' || candidate?.discoveryGrade === 'C') discoveryReasons.push('INSUFFICIENT_INFO')

  const hardBlock = ['MISSING_AUTHOR_ID', 'SOURCE_COMMENT_MISSING', 'SOURCE_AUTHOR_MISMATCH', 'CLASSIFICATION_MISSING', 'CLASSIFICATION_STALE', 'SOURCE_VIDEO_MISSING', 'REJECTED_PROTECTED', 'EXCLUDED', 'ALREADY_CONTACT', 'DUPLICATE_CANDIDATE'].some(code => discoveryReasons.includes(code))
  const discoveryLayer = discoveryReasons.length === 0
    ? layer(DISCOVERY.QUALIFIED)
    : (hardBlock || candidate?.discoveryGrade === 'D')
      ? layer(DISCOVERY.NOT_QUALIFIED, discoveryReasons)
      : layer(DISCOVERY.INSUFFICIENT, discoveryReasons)

  // 联系资格：在发现合格之上，额外要求成年身份可核实，并按配置核对性别与粉丝数。
  const profileFacts = candidateProfileFacts(candidate)
  const age = candidateAge(candidate)
  const gender = candidateGender(candidate)
  const contactReasons = []
  if (!discoveryLayer.allowed) contactReasons.push('DISCOVERY_NOT_QUALIFIED')
  // 冲突优先于"未核实"：但只有没有公开值可依据时才算"待核实"，否则按公开值继续判定。
  if (profileFacts.age && profileFacts.age.status === 'conflict' && !Number.isSafeInteger(profileFacts.age.blockingValue)) contactReasons.push('AGE_CONFLICT')
  else if (age === null) contactReasons.push('AGE_UNVERIFIED')
  else if (age < 18) contactReasons.push('MINOR_BLOCKED')
  else if (config.requireAgeRange && (age < config.ageMin || age > config.ageMax)) contactReasons.push('AGE_OUT_OF_RANGE')
  if (config.targetGender === 'female') {
    if (gender === 'conflict') contactReasons.push('GENDER_CONFLICT')
    else if (gender === 'male') contactReasons.push('GENDER_MISMATCH')
    else if (gender !== 'female') contactReasons.push('GENDER_UNVERIFIED')
  }
  if (config.targetGender === 'male') {
    if (gender === 'conflict') contactReasons.push('GENDER_CONFLICT')
    else if (gender === 'female') contactReasons.push('GENDER_MISMATCH')
    else if (gender !== 'male') contactReasons.push('GENDER_UNVERIFIED')
  }
  const followers = candidate?.publicSignals?.followerCount
  if (config.requireFollowerLimit) {
    if (!Number.isSafeInteger(followers)) contactReasons.push('FOLLOWERS_UNVERIFIED')
    else if (followers < config.followerMin || followers > config.followerMax) contactReasons.push('FOLLOWERS_OUT_OF_RANGE')
  }
  const contactLayer = contactReasons.length === 0
    ? layer(CONTACT.ELIGIBLE)
    : layer(contactReasons.every(code => ['AGE_UNVERIFIED', 'GENDER_UNVERIFIED', 'FOLLOWERS_UNVERIFIED', 'AGE_CONFLICT', 'GENDER_CONFLICT'].includes(code)) ? CONTACT.INSUFFICIENT : CONTACT.NOT_ELIGIBLE, contactReasons)

  const consent = consentEvidenceOf(candidate, library)
  // 关注与首次私信的动作范围不同（操作者可能只批准了关注），因此分别判定，不共用一个布尔。
  const followLayer = authorizationOf(candidate, consent, { authorization, action: 'follow' })
  const firstMessageLayer = authorizationOf(candidate, consent, { authorization, action: 'firstMessage' })
  const actionReasons = []
  if (!contactLayer.allowed) actionReasons.push('CONTACT_NOT_ELIGIBLE')
  actionReasons.push(...followLayer.reasons)
  const firstMessageReasons = []
  if (!contactLayer.allowed) firstMessageReasons.push('CONTACT_NOT_ELIGIBLE')
  firstMessageReasons.push(...firstMessageLayer.reasons)

  return {
    candidateId: clean(candidate?.id, 150),
    platformUserId,
    nickname: clean(candidate?.nickname, 100),
    intent: clean(candidate?.libraryIntent, 40),
    grade: clean(candidate?.discoveryGrade, 2),
    sourceCommentKey: comment?.key || null,
    sourceVideoId: comment?.video_id || video?.video_id || null,
    discovery: discoveryLayer,
    contact: contactLayer,
    action: { status: actionReasons.length ? ACTION.NOT_AUTHORIZED : ACTION.AUTHORIZED, allowed: actionReasons.length === 0, reasons: [...new Set(actionReasons)], evidence: followLayer.evidence },
    firstMessageAction: { status: firstMessageReasons.length ? ACTION.NOT_AUTHORIZED : ACTION.AUTHORIZED, allowed: firstMessageReasons.length === 0, reasons: [...new Set(firstMessageReasons)], evidence: firstMessageLayer.evidence },
    facts: {
      age, gender,
      // 五态来源：unknown / self_declared / public_profile / manual / conflict。
      // 界面必须按 status 展示，"有值"和"核实过"是两件事。
      ageStatus: profileFacts.age?.status || 'unknown',
      ageSource: profileFacts.age?.source || null,
      ageQuote: profileFacts.age?.quote || '',
      ageAttempted: profileFacts.age?.attempted === true,
      ageBirthYear: (profileFacts.age?.evidence || []).find(item => item.birthYear)?.birthYear || null,
      ageConflictValues: profileFacts.age?.conflictValues || [],
      genderStatus: profileFacts.gender?.status || 'unknown',
      genderSource: profileFacts.gender?.source || null,
      genderQuote: profileFacts.gender?.quote || '',
      genderAttempted: profileFacts.gender?.attempted === true,
      genderConflictValues: profileFacts.gender?.conflictValues || [],
      ageKnown: age !== null,
      genderKnown: gender === 'female' || gender === 'male',
      ageVerified: profileFacts.age?.status === 'manual',
      genderVerified: profileFacts.gender?.status === 'manual',
      adultVerified: age !== null && age >= 18,
      followerCount: Number.isSafeInteger(followers) ? followers : null,
      authorIdReliable: Boolean(platformUserId && profileUrl),
      commentPresent: Boolean(comment),
      classificationCurrent: Boolean(comment?.classification?.inputHash) ? (comment.classification?.reviewedByUser === true || comment.classification.inputHash === commentInputHash(comment, video)) : Boolean(comment?.classification?.intent),
      videoPresent: Boolean(video),
      explicitInvitation: consent.ok,
      consentEvidenceId: consent.evidenceId || null,
      rejected: candidate?.status === 'REJECTED' || candidate?.discoveryStatus === 'REJECTED',
    },
    taskIds: { follow: taskIdOf(candidate?.accountId || '', platformUserId, 'follow'), firstMessage: taskIdOf(candidate?.accountId || '', platformUserId, 'firstMessage') },
    policyVersion: AUDIT_VERSION,
  }
}

function auditCandidates(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const seen = new Map()
  for (const candidate of list) {
    const id = String(candidate?.platformUserId || '')
    if (id) seen.set(id, (seen.get(id) || 0) + 1)
  }
  const duplicateIds = new Set([...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id))
  const audits = list.map(candidate => auditCandidate(candidate, { ...options, duplicateIds }))
  const plan = options.plan || null
  return { audits, summary: summarizeAudit(audits, { config: options.config, plan, duplicateIds }), policyVersion: AUDIT_VERSION }
}

function summarizeAudit(audits, { config = {}, plan = null, duplicateIds = new Set() } = {}) {
  const counts = {
    total: audits.length,
    discoveryQualified: 0, discoveryNotQualified: 0, discoveryInsufficient: 0,
    friendlyIntent: 0, ageVerified: 0, genderVerified: 0, ageAndGenderVerified: 0,
    adultVerified: 0, insufficientInfo: 0, explicitInvitationEvidence: 0,
    contactEligible: 0, contactInsufficient: 0, contactNotEligible: 0,
    actionAuthorized: 0, actionBlocked: 0, firstMessageAuthorized: 0,
    platformEvidenceRecorded: 0, recipientConsentRecorded: 0, operatorConfirmationRecorded: 0,
    rejectedProtected: 0, missingAuthorId: 0, alreadyContact: 0, duplicateMerged: duplicateIds.size,
  }
  for (const audit of audits) {
    if (audit.discovery.allowed) counts.discoveryQualified++
    if (audit.discovery.status === DISCOVERY.INSUFFICIENT) counts.discoveryInsufficient++
    if (!audit.discovery.allowed && audit.discovery.status !== DISCOVERY.INSUFFICIENT) counts.discoveryNotQualified++
    if (['EXPLICIT_INVITATION', 'SEEKING_FRIENDS'].includes(audit.intent)) counts.friendlyIntent++
    if (audit.facts.ageVerified) counts.ageVerified++
    if (audit.facts.genderVerified) counts.genderVerified++
    if (audit.facts.ageVerified && audit.facts.genderVerified) counts.ageAndGenderVerified++
    if (audit.facts.adultVerified) counts.adultVerified++
    if (audit.discovery.status === DISCOVERY.INSUFFICIENT) counts.insufficientInfo++
    if (audit.facts.explicitInvitation) counts.explicitInvitationEvidence++
    if (audit.contact.allowed) counts.contactEligible++
    else if (audit.contact.status === CONTACT.INSUFFICIENT) counts.contactInsufficient++
    else counts.contactNotEligible++
    if (audit.action.allowed) counts.actionAuthorized++
    else counts.actionBlocked++
    if (audit.firstMessageAction?.allowed) counts.firstMessageAuthorized++
    // 三类证据分别计数：任何一项为 0 都说明真实执行缺对应依据。
    if (audit.action?.evidence?.platform?.ok) counts.platformEvidenceRecorded++
    if (audit.action?.evidence?.recipient?.ok) counts.recipientConsentRecorded++
    if (audit.action?.evidence?.operator?.ok) counts.operatorConfirmationRecorded++
    if (audit.facts.rejected) counts.rejectedProtected++
    if (audit.discovery.reasons.includes('MISSING_AUTHOR_ID')) counts.missingAuthorId++
    if (audit.discovery.reasons.includes('ALREADY_CONTACT')) counts.alreadyContact++
  }
  const followReasons = {}, firstMessageReasons = {}, actionReasons = {}, firstMessageActionReasons = {}
  if (plan?.plans) {
    for (const item of plan.plans) {
      followReasons[item.follow.reasonCode] = (followReasons[item.follow.reasonCode] || 0) + 1
      firstMessageReasons[item.firstMessage.reasonCode] = (firstMessageReasons[item.firstMessage.reasonCode] || 0) + 1
    }
    counts.followPlans = plan.summary?.follow ?? plan.plans.filter(item => item.follow.eligible).length
    counts.firstMessagePlans = plan.summary?.firstMessage ?? plan.plans.filter(item => item.firstMessage.eligible).length
  }
  for (const audit of audits) for (const reason of audit.action.reasons) actionReasons[reason] = (actionReasons[reason] || 0) + 1
  for (const audit of audits) for (const reason of audit.firstMessageAction?.reasons || []) firstMessageActionReasons[reason] = (firstMessageActionReasons[reason] || 0) + 1
  return {
    version: AUDIT_VERSION,
    config,
    configNotes: configNotes(config),
    counts,
    followPlanReasons: followReasons,
    firstMessagePlanReasons: firstMessageReasons,
    actionReasons,
    firstMessageActionReasons,
    evidenceStatus: EVIDENCE_STATUS,
    layers: { discovery: DISCOVERY, contact: CONTACT, action: ACTION },
  }
}

// 77 条关注计划逐条解释：计划为什么生成 + 为什么仍不能真实执行。
function explainFollowPlans(plan, audits) {
  const byId = new Map((audits || []).map(audit => [audit.platformUserId, audit]))
  return (plan?.plans || []).map(item => {
    const audit = byId.get(item.platformUserId) || null
    return {
      candidateId: item.candidateId,
      platformUserId: item.platformUserId,
      nickname: item.nickname,
      planned: item.follow.eligible === true,
      planReasonCode: item.follow.reasonCode,
      planReason: item.follow.reason,
      contactStatus: audit?.contact.status || 'UNKNOWN',
      contactReasons: audit?.contact.reasons || [],
      actionStatus: audit?.action.status || 'UNKNOWN',
      actionReasons: audit?.action.reasons || [],
      actionEvidence: audit?.action?.evidence || null,
      firstMessageActionStatus: audit?.firstMessageAction?.status || 'UNKNOWN',
      firstMessageActionReasons: audit?.firstMessageAction?.reasons || [],
      firstMessageEvidence: audit?.firstMessageAction?.evidence || null,
      facts: audit?.facts || null,
    }
  })
}

module.exports = {
  AUDIT_VERSION, DISCOVERY, CONTACT, ACTION, EVIDENCE_STATUS, EVIDENCE_KIND,
  configNotes, authorizationOf, auditCandidate, auditCandidates, summarizeAudit, explainFollowPlans,
}
