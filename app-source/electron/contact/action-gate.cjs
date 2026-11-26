// P2-15 统一动作门控：所有真实关注 / 首次私信入口共用同一套判定，避免各入口各写一份检查。
// 本模块是纯函数，不读写磁盘、不抓页面、不发消息；调用方拿到 allowed=false 时必须放弃真实动作。
const GATE_VERSION = 'P2-15.1'

const ACTIONS = { FOLLOW: 'follow', FIRST_MESSAGE: 'firstMessage' }
const SOURCES = { MANUAL: 'manual', AUTO_CONTACT: 'autoContact', CONTACT_ENGINE: 'contactEngine', AUTO_FRIENDSHIP: 'autoFriendship' }
const STATUS = { ALLOWED: 'allowed', BLOCKED: 'blocked', NEEDS_CONFIRMATION: 'needs_confirmation' }

// 每种入口的授权来源不同：人工点击=操作者确认；自动联系队列=三层资格审计；联系引擎=人工批准+手写首句。
const POLICY = {
  [SOURCES.MANUAL]: {
    label: '人工点击（本次确认）',
    follow: { requireAutoMode: false, requireContactEligible: false, requireActionAuthorization: false, requireOperatorConfirm: true, requireIdentity: true },
    firstMessage: { requireAutoMode: false, requireContactEligible: false, requireActionAuthorization: false, requireOperatorConfirm: true, requireIdentity: true, requireExplicitInvitation: true },
  },
  [SOURCES.AUTO_CONTACT]: {
    label: '自动联系队列',
    follow: { requireAutoMode: true, requireContactEligible: true, requireActionAuthorization: true, requireOperatorConfirm: false, requireIdentity: true },
    firstMessage: { requireAutoMode: true, requireContactEligible: true, requireActionAuthorization: true, requireOperatorConfirm: false, requireIdentity: true, requireExplicitInvitation: true },
  },
  [SOURCES.CONTACT_ENGINE]: {
    label: '统一联系引擎（人工批准 + 手写首句）',
    follow: { requireAutoMode: false, requireContactEligible: false, requireActionAuthorization: false, requireOperatorConfirm: false, requireIdentity: true, requireApprovedCandidate: true },
    firstMessage: { requireAutoMode: false, requireContactEligible: false, requireActionAuthorization: false, requireOperatorConfirm: false, requireIdentity: true, requireApprovedCandidate: true, requireOpeningMessage: true },
  },
  [SOURCES.AUTO_FRIENDSHIP]: {
    label: '主动结识（关键词搜索，无邀请证据）',
    follow: { requireAutoMode: true, requireContactEligible: false, requireActionAuthorization: false, requireOperatorConfirm: false, requireIdentity: true },
    firstMessage: { requireAutoMode: true, requireContactEligible: false, requireActionAuthorization: false, requireOperatorConfirm: false, requireIdentity: true },
  },
}

const REASONS = {
  ACCOUNT_PAUSED: '账号自动化已暂停',
  CHALLENGE_REQUIRED: '账号需要安全验证，已停止真实动作',
  EMERGENCY_STOPPED: '关注与首次联系队列已紧急停止',
  TRAINING_MODE: '训练模式不执行真实关注或私信',
  REJECTED_PROTECTED: '该候选人已拒绝联系，拒绝保护优先级最高',
  EXCLUDED: '候选人已被排除',
  BLACKLISTED: '该用户在黑名单中',
  ALREADY_CONTACT: '该用户已是联系人或被排除',
  MISSING_AUTHOR_ID: '缺少可唯一确认的作者 ID 或主页地址',
  CANDIDATE_NOT_APPROVED: '候选人尚未人工批准',
  OPENING_MESSAGE_MISSING: '缺少已确认的首句文本',
  CONTACT_NOT_ELIGIBLE: '联系资格未通过（年龄、性别或资料未核实）',
  ACTION_NOT_AUTHORIZED: '动作授权未通过（平台权限 / 对方同意 / 操作者确认）',
  CONSENT_NOT_EXPLICIT: '评论只表达一般交友意愿，不等于允许私信',
  INVITATION_NOT_EXPLICIT: '该评论未明确邀请私信，需要操作者单独确认',
  OPERATOR_CONFIRMATION_REQUIRED: '需要本次操作的明确确认',
  DAILY_LIMIT_REACHED: '今日动作已达上限',
  UNKNOWN_SOURCE: '未识别的动作入口',
}

const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

function reasonOf(code, detail = '') {
  return { code, detail: detail || REASONS[code] || '动作被阻断' }
}

function policyFor(source, action) {
  const policy = POLICY[source]
  if (!policy) return null
  const rule = policy[action]
  return rule ? { ...rule, source, action, label: policy.label } : null
}

function candidateIdOf(candidate) {
  return clean(candidate?.platformUserId, 120)
}

function isRejected(candidate) {
  return candidate?.status === 'REJECTED' || candidate?.discoveryStatus === 'REJECTED'
}

/**
 * 统一判定：返回 allowed 时调用方才可以执行真实关注 / 私信。
 * confirmation: { confirmed, invitationAcknowledged, operatorApproved }
 * audit: candidate-audit 的 auditCandidate 结果（自动联系队列必须提供）
 */
function evaluateActionGate({
  action,
  source = SOURCES.MANUAL,
  candidate = null,
  audit = null,
  automation = {},
  autoState = null,
  platform = {},
  confirmation = {},
  excludes = [],
  blacklist = [],
  remaining = null,
} = {}) {
  const rule = policyFor(source, action)
  if (!rule) return { version: GATE_VERSION, action, source, allowed: false, status: STATUS.BLOCKED, code: 'UNKNOWN_SOURCE', reason: REASONS.UNKNOWN_SOURCE, checks: [], policy: null, requires: [] }

  const checks = []
  const push = (code, ok, detail = '', applies = true) => { checks.push({ code, ok: Boolean(ok), detail, applies }); return Boolean(ok) }
  const blocked = []
  const needsConfirmation = []

  // 1. 全局暂停与安全验证：任何入口一致阻断。
  push('ACCOUNT_PAUSED', !automation.paused, REASONS.ACCOUNT_PAUSED) || blocked.push(reasonOf('ACCOUNT_PAUSED'))
  push('CHALLENGE_REQUIRED', !platform.verificationActive, REASONS.CHALLENGE_REQUIRED) || blocked.push(reasonOf('CHALLENGE_REQUIRED'))

  // 2. 紧急停止只针对系统发起的入口；人工单次点击由操作者当次确认。
  const stopApplies = source !== SOURCES.MANUAL
  if (!push('EMERGENCY_STOPPED', !stopApplies || autoState?.status !== 'stopped', REASONS.EMERGENCY_STOPPED, stopApplies)) blocked.push(reasonOf('EMERGENCY_STOPPED'))

  // 3. 训练模式：只约束系统自动发起的外部动作，不阻断人工单次操作。
  if (rule.requireAutoMode) {
    const autoMode = autoState?.mode === 'auto'
    push('TRAINING_MODE', autoMode, REASONS.TRAINING_MODE, true) || blocked.push(reasonOf('TRAINING_MODE'))
  } else {
    push('TRAINING_MODE', true, '人工操作不受模式限制', false)
  }

  const platformUserId = candidateIdOf(candidate)
  const knownContact = platformUserId && excludes.map(String).includes(platformUserId)
  const nicknameKey = clean(candidate?.nickname, 100)
  const blacklisted = (Array.isArray(blacklist) ? blacklist : []).some(item =>
    (typeof item === 'string' && nicknameKey && item.trim() === nicknameKey) || (item && typeof item === 'object' && String(item.platformUserId || '') === platformUserId))

  // 4. 拒绝与排除保护：所有入口最高优先级。
  push('REJECTED_PROTECTED', !isRejected(candidate), REASONS.REJECTED_PROTECTED) || blocked.push(reasonOf('REJECTED_PROTECTED'))
  push('EXCLUDED', candidate?.status !== 'EXCLUDED' && candidate?.discoveryStatus !== 'EXCLUDED', REASONS.EXCLUDED) || blocked.push(reasonOf('EXCLUDED'))
  push('BLACKLISTED', !blacklisted, REASONS.BLACKLISTED) || blocked.push(reasonOf('BLACKLISTED'))
  push('ALREADY_CONTACT', !knownContact, REASONS.ALREADY_CONTACT) || blocked.push(reasonOf('ALREADY_CONTACT'))

  // 5. 身份：没有可核对的主页就没有可靠动作。账号级预检（未指定候选人）不适用。
  if (rule.requireIdentity && candidate) {
    const identityOk = Boolean(platformUserId && clean(candidate?.profileUrl, 200))
    push('MISSING_AUTHOR_ID', identityOk, REASONS.MISSING_AUTHOR_ID) || blocked.push(reasonOf('MISSING_AUTHOR_ID'))
  } else if (rule.requireIdentity) push('MISSING_AUTHOR_ID', true, '账号级预检，未指定候选人', false)

  // 6. 资格与授权：自动联系队列沿用三层审计结论，不另立标准；账号级预检不指定候选人时跳过。
  if (rule.requireContactEligible && candidate) {
    const ok = audit?.contact?.allowed === true
    push('CONTACT_NOT_ELIGIBLE', ok, (audit?.contact?.reasons || []).join(', ')) || blocked.push(reasonOf('CONTACT_NOT_ELIGIBLE', (audit?.contact?.reasons || []).join(',')))
  } else if (rule.requireContactEligible) push('CONTACT_NOT_ELIGIBLE', true, '账号级预检，未指定候选人', false)
  if (rule.requireActionAuthorization && candidate) {
    // 关注与首次私信的动作范围不同，分别取对应的审计结论，不共用一个布尔。
    const authorization = action === ACTIONS.FIRST_MESSAGE ? (audit?.firstMessageAction || audit?.action) : audit?.action
    const ok = authorization?.allowed === true
    push('ACTION_NOT_AUTHORIZED', ok, (authorization?.reasons || []).join(', ')) || blocked.push(reasonOf('ACTION_NOT_AUTHORIZED', (authorization?.reasons || []).join(',')))
  } else if (rule.requireActionAuthorization) push('ACTION_NOT_AUTHORIZED', true, '账号级预检，未指定候选人', false)
  if (rule.requireApprovedCandidate) {
    const approved = candidate?.review?.status === 'approved' || candidate?.status === 'APPROVED' || candidate?.status === 'APPROVED_PENDING_CONTACT'
    push('CANDIDATE_NOT_APPROVED', approved, REASONS.CANDIDATE_NOT_APPROVED) || blocked.push(reasonOf('CANDIDATE_NOT_APPROVED'))
  }

  // 7. 首次私信的证据与确认：一般交友意愿不得自动升级为私信。
  if (action === ACTIONS.FIRST_MESSAGE) {
    if (rule.requireExplicitInvitation) {
      const intent = clean(candidate?.libraryIntent, 40) || clean(audit?.intent, 40)
      const explicit = audit ? audit?.facts?.explicitInvitation === true : intent === 'EXPLICIT_INVITATION'
      if (explicit) {
        push('CONSENT_NOT_EXPLICIT', true, '存在明确邀请证据')
      } else if (confirmation.invitationAcknowledged === true) {
        push('INVITATION_NOT_EXPLICIT', true, '操作者已单独确认为主动私信', true)
      } else {
        push('INVITATION_NOT_EXPLICIT', false, REASONS.INVITATION_NOT_EXPLICIT)
        needsConfirmation.push(reasonOf('INVITATION_NOT_EXPLICIT'))
      }
    }
    if (rule.requireOperatorConfirm && confirmation.confirmed !== true) {
      push('OPERATOR_CONFIRMATION_REQUIRED', false, REASONS.OPERATOR_CONFIRMATION_REQUIRED)
      needsConfirmation.push(reasonOf('OPERATOR_CONFIRMATION_REQUIRED'))
    } else if (rule.requireOperatorConfirm) push('OPERATOR_CONFIRMATION_REQUIRED', true, '本次操作已确认')
    if (rule.requireOpeningMessage) {
      const hasText = Boolean(clean(confirmation.openingMessage || candidate?.contact?.openingMessage, 200))
      push('OPENING_MESSAGE_MISSING', hasText, REASONS.OPENING_MESSAGE_MISSING) || blocked.push(reasonOf('OPENING_MESSAGE_MISSING'))
    }
  }

  // 8. 人工单次操作也要求"本次确认"，但确认不是自动动作的替代品。
  if (action === ACTIONS.FOLLOW && rule.requireOperatorConfirm && confirmation.confirmed !== true) {
    push('OPERATOR_CONFIRMATION_REQUIRED', false, REASONS.OPERATOR_CONFIRMATION_REQUIRED)
    needsConfirmation.push(reasonOf('OPERATOR_CONFIRMATION_REQUIRED'))
  } else if (action === ACTIONS.FOLLOW && rule.requireOperatorConfirm) push('OPERATOR_CONFIRMATION_REQUIRED', true, '本次操作已确认')

  // 9. 预算由调用方计算后传入；没有传入表示该入口不参与每日预算。
  if (remaining && typeof remaining === 'object') {
    const left = Number.isFinite(remaining.left) ? remaining.left : null
    if (left !== null) push('DAILY_LIMIT_REACHED', left > 0, REASONS.DAILY_LIMIT_REACHED) || blocked.push(reasonOf('DAILY_LIMIT_REACHED'))
  }

  const first = blocked[0] || needsConfirmation[0] || null
  return {
    version: GATE_VERSION,
    action,
    source,
    allowed: blocked.length === 0 && needsConfirmation.length === 0,
    status: blocked.length ? STATUS.BLOCKED : needsConfirmation.length ? STATUS.NEEDS_CONFIRMATION : STATUS.ALLOWED,
    code: first ? first.code : 'OK',
    reason: first ? first.detail : '通过统一动作门控',
    blockedBy: blocked.map(item => item.code),
    requires: needsConfirmation.map(item => item.code),
    checks,
    policy: rule,
    facts: { platformUserId, nickname: nicknameKey, intent: clean(candidate?.libraryIntent || audit?.intent, 40), knownContact: Boolean(knownContact), blacklisted },
  }
}

// 供 UI / 报告使用：把四种入口的检查项摊平，避免"某个入口漏检查"只能靠读代码发现。
function describePolicy() {
  return Object.entries(POLICY).map(([source, value]) => ({
    source,
    label: value.label,
    follow: { ...value.follow },
    firstMessage: { ...value.firstMessage },
  }))
}

module.exports = {
  GATE_VERSION, ACTIONS, SOURCES, STATUS, POLICY, REASONS,
  evaluateActionGate, describePolicy, policyFor,
}
