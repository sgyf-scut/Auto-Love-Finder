// P2-13 正式模式自动联系引擎：只做筛选、资格判断、执行计划和队列管理。
// 真实关注 / 私信默认不执行（Dry Run）；只有用户显式授权、打开开关且关闭 Dry Run 才交给执行器。
// 本模块不抓取页面、不发送消息、不修改联系人聊天状态。
const { createHash } = require('node:crypto')
const { normalizeAutoContact } = require('../social-brain/library-store.cjs')
const { findCommentForCandidate, findVideoForComment } = require('../social-brain/library-candidates.cjs')
const { commentInputHash } = require('../social-brain/library-classifier.cjs')
const { candidateAge, candidateGender, candidateProfileFacts } = require('./candidate-manager.cjs')

const POLICY_VERSION = 'P2-16.1'
const HARD_STOP_CODES = new Set(['CHALLENGE_REQUIRED', 'LOGIN_REQUIRED', 'RATE_LIMITED', 'ACCESS_RESTRICTED', 'PERMISSION_DENIED'])
// P2-16：只认"确认平台没有执行"的失败；白名单以外一律按结果未知处理，宁可人工核对也不重复外发。
// 平台明确拒绝、目标不存在、前置门控拦下，这几种在执行前就已终止，重试是安全的。
const CONFIRMED_NOT_EXECUTED_CODES = new Set([
  'PREFLIGHT_BLOCKED', 'GATE_BLOCKED', 'BLOCKED_BY_GATE', 'TARGET_NOT_FOUND', 'TARGET_UNAVAILABLE',
  'INVALID_TARGET', 'MISSING_TARGET', 'ACTION_NOT_ALLOWED', 'BUDGET_EXCEEDED', 'CONFIG_INVALID',
])
const UNCERTAIN_DEFAULT_CODE = 'OUTCOME_UNCERTAIN'
const CONFIG_MISSING = 'AUTO_CONFIG_INVALID'
const clean = (value, limit = 800) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

// 失败归类：not_executed 可重试；uncertain / executed_but_failed 一律不自动重试。
function classifyFailure(outcome) {
  const code = clean(outcome?.reasonCode, 60)
  if (outcome?.executed === true) return 'executed_but_failed'
  if (outcome?.executed === false) return 'not_executed'
  if (CONFIRMED_NOT_EXECUTED_CODES.has(code)) return 'not_executed'
  return 'uncertain'
}

function dayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function taskIdOf(accountId, platformUserId, action) {
  const digest = createHash('sha256').update(`P2-13\u0000${accountId || ''}\u0000${platformUserId || ''}\u0000${action}`).digest('hex').slice(0, 20)
  return `${action === 'follow' ? 'p13f' : 'p13m'}-${digest}`
}

// 已执行记录的"真实性"：只有 realAction=true 才算真实完成；未标记的旧记录结果不明，不能当作真实完成。
function recordRealness(record) {
  if (!record || typeof record !== 'object') return 'none'
  if (record.realAction === true) return 'real'
  if (record.simulated === true) return 'simulated'
  if (record.dryRun === true) return 'simulated'
  return 'unknown'
}

// 首次联系资格只认“明确欢迎私信”的原始评论，并把该评论作为可追溯证据。
function consentEvidenceOf(candidate, library) {
  if (!candidate?.consentToDm || !candidate?.explicitInvitation) return { ok: false, reasonCode: 'CONSENT_NOT_EXPLICIT', reason: '评论只表达一般交友意愿，不等于允许私信' }
  const comment = findCommentForCandidate(candidate, library)
  if (!comment) return { ok: false, reasonCode: 'CONSENT_EVIDENCE_MISSING', reason: '本地库找不到同意私信的原始评论' }
  if (comment.author_id !== candidate.platformUserId) return { ok: false, reasonCode: 'CONSENT_AUTHOR_MISMATCH', reason: '原始评论作者与候选人身份不一致' }
  const intent = comment.classification?.intent
  if (intent !== 'EXPLICIT_INVITATION') return { ok: false, reasonCode: 'CONSENT_INTENT_MISMATCH', reason: `原始评论分类为 ${intent || 'UNKNOWN'}，不是明确邀请` }
  const video = findVideoForComment(comment, library)
  // 人工标签优先；模型结果必须与当前评论/视频语境一致，过期分类不能作为授权证据。
  if (!comment.classification?.reviewedByUser && comment.classification?.inputHash && comment.classification.inputHash !== commentInputHash(comment, video)) {
    return { ok: false, reasonCode: 'CONSENT_EVIDENCE_STALE', reason: '授权证据对应的分类已过期，需要重新确认' }
  }
  return { ok: true, evidenceId: comment.key || comment.comment_id || candidate.source?.commentId || null, comment, video }
}

// 只使用已核实的公开资料与原始评论，不推测性别/年龄，也不编造用户个人经历。
function buildMessagePlan({ candidate, comment, video, selfProfile }) {
  const nickname = clean(candidate?.nickname, 60) || '你好'
  const topic = clean(video?.title || video?.topic, 80)
  const quote = clean(comment?.text, 80)
  const facts = []
  if (selfProfile && typeof selfProfile === 'object') {
    const age = Number.isSafeInteger(selfProfile.age) ? selfProfile.age : null
    const gender = ['female', 'male'].includes(selfProfile.gender) ? selfProfile.gender : null
    if (age) facts.push(`${age}岁`)
    if (gender) facts.push(gender === 'female' ? '女生' : '男生')
  }
  const selfText = facts.length ? `我${facts.join('、')}` : '我也在认真认识朋友'
  const context = topic ? `在「${topic}」的评论里` : '在你的评论里'
  const tail = quote ? `看到你说「${quote}」` : '看到你的留言'
  return {
    template: 'comment-context-v1',
    text: `${nickname}你好，${context}${tail}，感觉挺契合的。${selfText}，如果你愿意的话可以聊聊。`,
    usesVerifiedFactsOnly: true,
  }
}

function evaluateCandidate(candidate, { library, config, excludePlatformUserIds = [], policyVersion = POLICY_VERSION } = {}) {
  const accountId = clean(candidate?.accountId, 150)
  const platformUserId = clean(candidate?.platformUserId, 120)
  const base = {
    candidateId: clean(candidate?.id, 150),
    platformUserId,
    profileUrl: clean(candidate?.profileUrl, 200),
    nickname: clean(candidate?.nickname, 100),
    intent: clean(candidate?.libraryIntent, 40),
    grade: clean(candidate?.discoveryGrade, 1),
    policyVersion,
    taskIds: { follow: taskIdOf(accountId, platformUserId, 'follow'), firstMessage: taskIdOf(accountId, platformUserId, 'firstMessage') },
    follow: { eligible: false, status: 'blocked', reasonCode: 'UNKNOWN', reason: '' },
    firstMessage: { eligible: false, status: 'blocked', reasonCode: 'CONSENT_NOT_EXPLICIT', reason: '', consentEvidenceId: null, message: null },
  }
  const reject = reasonCode => ({ ...base, follow: { eligible: false, status: 'blocked', reasonCode, reason: reasonText(reasonCode, candidate) }, firstMessage: { ...base.firstMessage, eligible: false, status: 'blocked', reasonCode: 'BLOCKED_BY_DISCOVERY', reason: '候选人已被排除，禁止进入联系流程' } })
  if (candidate?.intentPoolOnly === true && candidate.batchScreening?.status !== 'qualified') return reject('BATCH_SCREENING_PENDING')
  if (!platformUserId || !candidate?.profileUrl) return reject('MISSING_AUTHOR_ID')
  if (candidate.status === 'REJECTED' || candidate.discoveryStatus === 'REJECTED' || candidate?.action?.firstMessageStatus === 'blocked') return reject('REJECTED_PROTECTED')
  if (excludePlatformUserIds.map(String).includes(platformUserId)) return reject('ALREADY_CONTACT')
  if (candidate.status === 'EXCLUDED' || candidate.discoveryStatus === 'EXCLUDED') return reject('EXCLUDED')
  if (candidate.discoveryStatus === 'INSUFFICIENT_INFO' || candidate.discoveryGrade === 'C') {
    return { ...base, follow: { eligible: false, status: 'skipped', reasonCode: 'INSUFFICIENT_INFO', reason: '证据不足，需人工确认后才能进入自动流程' }, firstMessage: { ...base.firstMessage, status: 'not_eligible', reasonCode: 'INSUFFICIENT_INFO', reason: '证据不足，不进入首次联系' } }
  }
  if (!['EXPLICIT_INVITATION', 'SEEKING_FRIENDS'].includes(candidate.libraryIntent) || candidate.discoveryGrade === 'D') return reject('NOT_FRIENDLY_INTENT')
  const facts = candidateProfileFacts(candidate)
  const gender = candidateGender(candidate)
  // 来源互相矛盾时留在待核实：不按任何一方判定，也不丢证据，交人工裁决。
  if ((config?.targetGender === 'female' || config?.targetGender === 'male') && gender === 'conflict') {
    return { ...base, follow: { eligible: false, status: 'skipped', reasonCode: 'GENDER_CONFLICT', reason: '性别来源互相矛盾（自述与主页不一致），需人工裁决' }, firstMessage: { ...base.firstMessage, status: 'not_eligible', reasonCode: 'GENDER_CONFLICT', reason: '性别信息冲突' } }
  }
  // 性别筛选只按已配置目标执行；未知一律留在人工核对，不根据头像或昵称猜测。
  if (config?.targetGender === 'female' && gender === 'male') return reject('GENDER_MISMATCH')
  if (config?.targetGender === 'male' && gender === 'female') return reject('GENDER_MISMATCH')
  if (config?.targetGender === 'female' && gender !== 'female') {
    return { ...base, follow: { eligible: false, status: 'skipped', reasonCode: 'GENDER_UNVERIFIED', reason: '性别未核实，不进入自动流程' }, firstMessage: { ...base.firstMessage, status: 'not_eligible', reasonCode: 'GENDER_UNVERIFIED', reason: '性别未核实' } }
  }
  const age = candidateAge(candidate)
  // 只有"没有任何可依据来源"的冲突才停在待核实；主页公开值构成冲突时按公开值继续判定。
  if (config?.requireAgeRange && facts.age && facts.age.status === 'conflict' && !Number.isSafeInteger(facts.age.blockingValue)) {
    return { ...base, follow: { eligible: false, status: 'skipped', reasonCode: 'AGE_CONFLICT', reason: '年龄来源互相矛盾（自述与主页不一致），需人工裁决' }, firstMessage: { ...base.firstMessage, status: 'not_eligible', reasonCode: 'AGE_CONFLICT', reason: '年龄信息冲突' } }
  }
  if (config?.requireAgeRange && age === null) {
    return { ...base, follow: { eligible: false, status: 'skipped', reasonCode: 'AGE_UNVERIFIED', reason: '年龄未核实，不能根据头像或昵称猜测' }, firstMessage: { ...base.firstMessage, status: 'not_eligible', reasonCode: 'AGE_UNVERIFIED', reason: '年龄未核实' } }
  }
  if (config?.requireAgeRange && (age < config.ageMin || age > config.ageMax)) return reject('AGE_OUT_OF_RANGE')
  const followers = candidate?.publicSignals?.followerCount
  if (config?.requireFollowerLimit) {
    if (!Number.isSafeInteger(followers)) {
      return { ...base, follow: { eligible: false, status: 'skipped', reasonCode: 'FOLLOWERS_UNVERIFIED', reason: '粉丝数未核实' }, firstMessage: { ...base.firstMessage, status: 'not_eligible', reasonCode: 'FOLLOWERS_UNVERIFIED', reason: '粉丝数未核实' } }
    }
    if (followers < config.followerMin || followers > config.followerMax) return reject('FOLLOWERS_OUT_OF_RANGE')
  }
  const alreadyFollowed = candidate?.action?.followStatus === 'followed' || candidate?.contact?.followStatus === 'followed'
  const follow = alreadyFollowed
    ? { eligible: false, status: 'skipped', reasonCode: 'ALREADY_FOLLOWED', reason: '已关注，不重复执行' }
    : { eligible: true, status: 'planned', reasonCode: 'OK', reason: '满足自动关注条件' }
  const consent = consentEvidenceOf(candidate, library)
  if (!consent.ok) {
    return { ...base, follow, firstMessage: { ...base.firstMessage, eligible: false, status: 'not_eligible', reasonCode: consent.reasonCode, reason: consent.reason } }
  }
  if (candidate?.action?.firstMessageStatus === 'sent') {
    return { ...base, follow, firstMessage: { ...base.firstMessage, eligible: false, status: 'skipped', reasonCode: 'ALREADY_SENT', reason: '已发送过首次消息，不重复发送', consentEvidenceId: consent.evidenceId } }
  }
  const message = buildMessagePlan({ candidate, comment: consent.comment, video: consent.video })
  return {
    ...base,
    follow,
    firstMessage: { eligible: true, status: 'planned', reasonCode: 'OK', reason: '存在明确欢迎私信的可追溯证据', consentEvidenceId: consent.evidenceId, message },
  }
}

function reasonText(code) {
  return {
    MISSING_AUTHOR_ID: '缺少可唯一确认的作者 sec_uid，不能自动联系',
    REJECTED_PROTECTED: '该候选人已拒绝联系，拒绝保护优先级最高',
    ALREADY_CONTACT: '该用户已是现有联系人或被排除',
    EXCLUDED: '候选人已被排除',
    NOT_FRIENDLY_INTENT: '评论未确认有效的交友意愿',
    GENDER_MISMATCH: '公开资料或人工核验为男性，不主动联系',
    GENDER_CONFLICT: '性别来源互相矛盾，需人工裁决',
    AGE_CONFLICT: '年龄来源互相矛盾，需人工裁决',
    AGE_UNVERIFIED: '年龄未核实：评论与主页都没有明确自述',
    GENDER_UNVERIFIED: '性别未核实：评论与主页都没有明确自述',
    AGE_OUT_OF_RANGE: '年龄不在目标范围内',
    FOLLOWERS_OUT_OF_RANGE: '粉丝数不在目标范围内',
  }[code] || '不符合自动联系条件'
}

// 待核实：条件本身没问题，只是资料不足以判定，或来源互相矛盾无法裁决。
// 这两类都不能算合格，也不能算不合格。
const PENDING_VERIFICATION_CODES = ['INSUFFICIENT_INFO', 'AGE_UNVERIFIED', 'GENDER_UNVERIFIED', 'FOLLOWERS_UNVERIFIED', 'AGE_CONFLICT', 'GENDER_CONFLICT']

function verificationScope(config = {}) {
  const scope = []
  if (config?.targetGender === 'female' || config?.targetGender === 'male') scope.push('gender')
  if (config?.requireAgeRange === true) scope.push('age')
  if (config?.requireFollowerLimit === true) scope.push('followers')
  return scope
}

function summarize(plans) {
  const counts = { total: plans.length, follow: 0, firstMessage: 0, blocked: 0, insufficient: 0, already: 0, pendingVerification: {}, pendingVerificationTotal: 0, qualified: 0 }
  for (const plan of plans) {
    if (plan.follow.eligible) counts.follow++
    if (plan.firstMessage.eligible) counts.firstMessage++
    if (plan.follow.status === 'blocked') counts.blocked++
    if (PENDING_VERIFICATION_CODES.includes(plan.follow.reasonCode)) {
      counts.insufficient++
      counts.pendingVerification[plan.follow.reasonCode] = (counts.pendingVerification[plan.follow.reasonCode] || 0) + 1
      counts.pendingVerificationTotal++
    }
    if (['ALREADY_FOLLOWED', 'ALREADY_SENT'].includes(plan.follow.reasonCode) || plan.firstMessage.reasonCode === 'ALREADY_SENT') counts.already++
  }
  // qualified 与 follow 同源：这里只有一个含义——满足全部已启用必需条件。
  counts.qualified = counts.follow
  return counts
}

function planCandidates(candidates, options = {}) {
  const plans = (Array.isArray(candidates) ? candidates : []).map(candidate => evaluateCandidate(candidate, options))
  return { plans, summary: summarize(plans), scope: verificationScope(options.config || {}), policyVersion: options.policyVersion || POLICY_VERSION }
}

function normalizeQueueTask(task, action, { now = new Date().toISOString(), policyVersion = POLICY_VERSION } = {}) {
  return {
    taskId: clean(task.taskId, 120),
    action,
    candidateId: clean(task.candidateId, 150) || null,
    platformUserId: clean(task.platformUserId, 120) || null,
    nickname: clean(task.nickname, 100) || null,
    profileUrl: clean(task.profileUrl, 200) || null,
    status: 'pending',
    attempts: 0,
    reasonCode: clean(task.reasonCode, 60) || 'OK',
    reason: clean(task.reason, 300),
    dryRun: task.dryRun !== false,
    alreadyFollowed: task.alreadyFollowed === true,
    consentEvidenceId: clean(task.consentEvidenceId, 150) || null,
    messagePreview: clean(task.message?.text, 500) || null,
    policyVersion: clean(task.policyVersion, 40) || policyVersion,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  }
}

function ensureBudget(state, limits, nowIso) {
  const day = dayKey(nowIso)
  const current = state.budget && typeof state.budget === 'object' ? state.budget : {}
  if (current.day !== day) return { day, follows: 0, messages: 0, limits }
  return { ...current, limits }
}

// 同进程内正在执行的队列键：避免界面轮询新建实例时，把"正在执行"误判成"中断"。
const ACTIVE_RUNS = new Set()
function runKeyOf(store) {
  return String(store?.filePath || store?.dir || 'default')
}
// 中断判定的宽限：执行中的任务超过这个时间仍停在 running，才认为进程已经不在了。
const IN_FLIGHT_STALE_MS = 5 * 60 * 1000

class AutoContactQueue {
  constructor({ store, now = () => new Date().toISOString(), recover = true } = {}) {
    if (!store) throw new Error('自动联系队列需要 library store')
    this.store = store
    this.now = typeof now === 'function' ? now : () => new Date().toISOString()
    // P2-16：进程重启后先把上次的"执行中"任务落定为结果未知，绝不悄悄当没执行过。
    if (recover) this.inFlight = this.recoverInFlight()
  }

  state() { return normalizeAutoContact(this.store.autoContactState()) }
  save(patch) { return this.store.setAutoContact(patch) }

  // 执行前已落盘但没有结果的记录：平台可能已执行，只能交给人工裁决。
  recoverInFlight({ staleMs = IN_FLIGHT_STALE_MS } = {}) {
    if (ACTIVE_RUNS.has(runKeyOf(this.store))) return { recovered: [] }
    const state = this.state()
    const queues = { follow: [...state.queues.follow], firstMessage: [...state.queues.firstMessage] }
    const executed = { follow: { ...state.executed.follow }, firstMessage: { ...state.executed.firstMessage } }
    const recovered = []
    const nowMs = Date.parse(this.now())
    for (const action of ['follow', 'firstMessage']) {
      for (const task of queues[action]) {
        if (task.status !== 'running') continue
        const startedMs = Date.parse(task.startedAt || task.updatedAt || '')
        // 同进程内仍在执行的不动；时间戳不可解析时按中断处理（宁可拦下也不重发）。
        if (Number.isFinite(startedMs) && Number.isFinite(nowMs) && nowMs - startedMs < staleMs) continue
        task.status = 'uncertain'
        task.reasonCode = 'INTERRUPTED_IN_FLIGHT'
        task.reason = '执行过程中进程中断，无法确认平台是否已执行；禁止自动重试，需人工核对'
        task.finishedAt = this.now(); task.updatedAt = task.finishedAt
        task.outcome = 'UNCERTAIN'; task.simulated = false; task.realAction = true
        executed[action][task.taskId] = { ...task }
        recovered.push({ taskId: task.taskId, action, platformUserId: task.platformUserId })
      }
    }
    if (!recovered.length) return { recovered: [] }
    this.save({
      queues, executed, status: 'blocked', code: 'UNCERTAIN_NEEDS_REVIEW',
      lastError: `${recovered.length} 条任务在执行过程中中断，已标记为结果未知，禁止自动重试`,
    })
    return { recovered }
  }

  // 人工裁决结果未知任务：确认未执行才允许回到待执行；确认已执行则按完成记账。
  resolveUncertain({ taskId, action = 'follow', decision, note = '' } = {}) {
    const key = ['follow', 'firstMessage'].includes(action) ? action : 'follow'
    if (!['not_executed', 'executed'].includes(decision)) return { ok: false, error: 'INVALID_DECISION', detail: '裁决只能是 not_executed 或 executed' }
    const state = this.state()
    const queues = { follow: [...state.queues.follow], firstMessage: [...state.queues.firstMessage] }
    const executed = { follow: { ...state.executed.follow }, firstMessage: { ...state.executed.firstMessage } }
    const task = queues[key].find(item => item.taskId === taskId)
    if (!task) return { ok: false, error: 'TASK_NOT_FOUND', detail: '队列里没有这条任务' }
    if (task.status !== 'uncertain') return { ok: false, error: 'NOT_UNCERTAIN', detail: '只有结果未知的任务需要人工裁决' }
    const at = this.now()
    task.resolution = decision === 'not_executed' ? 'manual_not_executed' : 'manual_executed'
    task.resolvedAt = at; task.resolutionNote = clean(note, 200); task.updatedAt = at
    if (decision === 'not_executed') {
      task.status = 'pending'; task.reasonCode = 'OK'; task.reason = '人工确认平台未执行，允许重试'
      task.startedAt = null; task.finishedAt = null; task.attempts = 0
      task.outcome = null; task.realAction = false
      delete executed[key][taskId]
    } else {
      task.status = 'done'; task.reasonCode = 'MANUAL_CONFIRMED_EXECUTED'; task.reason = '人工确认平台已执行，按完成记账'
      task.finishedAt = at; task.outcome = 'CONFIRMED'; task.realAction = true
      executed[key][taskId] = { ...task }
    }
    this.save({ queues, executed })
    return { ok: true, taskId, action: key, decision, state: this.state() }
  }

  // 只生成计划，不入队、不执行；正式模式 UI 用它做 Dry Run 预览。
  plan({ candidates = [], excludePlatformUserIds = [], config = null } = {}) {
    const state = this.state()
    const library = this.store.read()
    const result = planCandidates(candidates, {
      library,
      config: config || state.config,
      excludePlatformUserIds,
      // 计划总是由当前代码生成，使用当前策略版本，不继承历史状态里的旧版本号。
      policyVersion: POLICY_VERSION,
    })
    const saved = this.save({ lastPlanAt: this.now() })
    return { ...result, state: saved }
  }

  // 幂等入队：同一 account+用户+动作只保留一个任务 ID，重复计划不会重复执行。
  enqueue(plans, { dryRun = null } = {}) {
    const state = this.state(), now = this.now()
    // 训练模式绝不产生关注/私信队列，即使调用方忽略了模式检查。
    if (state.mode !== 'auto') return { followAdded: 0, firstMessageAdded: 0, duplicated: 0, skipped: 'TRAINING_MODE', state }
    const queues = { follow: [...state.queues.follow], firstMessage: [...state.queues.firstMessage] }
    const counts = { followAdded: 0, firstMessageAdded: 0, duplicated: 0, replacedSimulated: 0 }
    const wantDryRun = dryRun ?? state.dryRun
    for (const plan of Array.isArray(plans) ? plans : []) {
      for (const key of ['follow', 'firstMessage']) {
        if (!plan?.[key]?.eligible) continue
        const taskId = plan.taskIds?.[key]
        if (!taskId) continue
        const previousTask = queues[key].find(task => task.taskId === taskId)
        const realness = recordRealness(state.executed?.[key]?.[taskId])
        // 未完成/已完成真实任务、结果不明的旧记录都算重复；模拟完成不阻止真实任务入队。
        const pendingOrReal = previousTask && (previousTask.status !== 'done' || previousTask.simulated !== true)
        const blocked = pendingOrReal || realness === 'real' || realness === 'unknown' || (realness === 'simulated' && wantDryRun !== false)
        if (blocked) { counts.duplicated++; continue }
        if (previousTask) { queues[key] = queues[key].filter(task => task.taskId !== taskId); counts.replacedSimulated++ }
        const payload = key === 'follow'
          ? { ...plan, ...plan.follow, profileUrl: plan.profileUrl, taskId, dryRun: wantDryRun, policyVersion: plan.policyVersion }
          : { ...plan, ...plan.firstMessage, alreadyFollowed: plan.follow.reasonCode === 'ALREADY_FOLLOWED', taskId, dryRun: wantDryRun, policyVersion: plan.policyVersion }
        queues[key].push(normalizeQueueTask(payload, key, { now }))
        counts[`${key}Added`]++
      }
    }
    const saved = this.save({ queues, lastPlanAt: state.lastPlanAt || now, status: queues.follow.length || queues.firstMessage.length ? 'planned' : 'idle' })
    return { ...counts, state: saved }
  }

  pause(reason = '用户暂停') { return this.save({ status: 'paused', stoppedReason: clean(reason, 300) }) }
  // 从暂停/停止状态恢复到可运行；停止原因保留在日志，不再作为运行阻断。
  recover() { return this.save({ status: 'running', stoppedAt: null, stoppedReason: '', code: null, lastError: '' }) }
  resume() { return this.save({ status: 'running', stoppedReason: '', stoppedAt: null }) }
  stop(reason = '紧急停止') { return this.save({ status: 'stopped', stoppedAt: this.now(), stoppedReason: clean(reason, 300) }) }
  reset() { return this.save({ queues: { follow: [], firstMessage: [] }, executed: { follow: {}, firstMessage: {} }, status: 'idle', stoppedReason: '', stoppedAt: null }) }

  // 执行队列。默认 Dry Run：只标记计划和结果，不调用任何平台接口。
  // executor 只会在 dryRun=false 且 realActionsAuthorized=true 时被调用。
  async run({ dryRun = true, executor = null, limit = 50, blockedPlatformUserIds = [], onlyAction = null } = {}) {
    const blockedUsers = new Set((Array.isArray(blockedPlatformUserIds) ? blockedPlatformUserIds : []).map(String).filter(Boolean))
    const state = this.state()
    if (state.mode !== 'auto') return { ok: false, error: 'NOT_AUTO_MODE', detail: '训练模式绝不执行关注或私信' }
    if (state.status === 'stopped') return { ok: false, error: 'EMERGENCY_STOPPED', detail: state.stoppedReason || '任务已紧急停止' }
    if (state.status === 'paused') return { ok: false, error: 'PAUSED', detail: '任务已暂停，请继续后再运行' }
    const now = this.now()
    const limits = { dailyFollowLimit: state.config.dailyFollowLimit, dailyFirstMessageLimit: state.config.dailyFirstMessageLimit }
    const budget = ensureBudget(state, limits, now)
    const queues = { follow: [...state.queues.follow].map(task => ({ ...task })), firstMessage: [...state.queues.firstMessage].map(task => ({ ...task })) }
    const executed = { follow: { ...state.executed.follow }, firstMessage: { ...state.executed.firstMessage } }
    const useDryRun = dryRun !== false || !state.realActionsAuthorized
    // 真实执行必须显式提供执行器；缺失时返回阻塞，绝不把"没有执行"记为完成。
    if (!useDryRun && typeof executor !== 'function') {
      return { ok: false, error: 'EXECUTOR_MISSING', detail: '未提供真实执行器，已拒绝把任务标记为完成', dryRun: false, results: [], state }
    }
    // 模拟完成的任务在真实执行时回到待执行：模拟记录不占用真实去重，也不占用真实额度。
    if (!useDryRun) {
      for (const key of ['follow', 'firstMessage']) {
        for (const task of queues[key]) {
          if (task.status === 'done' && task.simulated === true) {
            task.status = 'pending'; task.simulated = false; task.outcome = null; task.reasonCode = 'OK'; task.finishedAt = null
          }
        }
      }
    }
    const counters = {
      follows: budget.follows, messages: budget.messages,
      realFollows: Number.isFinite(budget.realFollows) ? budget.realFollows : 0,
      realMessages: Number.isFinite(budget.realMessages) ? budget.realMessages : 0,
      simulatedFollows: Number.isFinite(budget.simulatedFollows) ? budget.simulatedFollows : 0,
      simulatedMessages: Number.isFinite(budget.simulatedMessages) ? budget.simulatedMessages : 0,
    }
    const results = []
    let stopped = null
    // 同进程内的执行标记：界面轮询新建实例时不会把正在执行的任务误判为中断。
    const runKey = runKeyOf(this.store)
    ACTIVE_RUNS.add(runKey)
    try {
    const actionState = {
      follow: { queue: queues.follow, cap: budget.limits.dailyFollowLimit, used: useDryRun ? counters.follows : counters.realFollows, action: 'follow' },
      firstMessage: { queue: queues.firstMessage, cap: budget.limits.dailyFirstMessageLimit, used: useDryRun ? counters.messages : counters.realMessages, action: 'firstMessage' },
    }
    for (const key of ['follow', 'firstMessage']) {
      const bucket = actionState[key]
      if (onlyAction && key !== onlyAction) continue
      if (stopped) break
      if (key === 'follow' && !state.config.autoFollow) { results.push({ action: key, status: 'skipped', reasonCode: 'AUTO_FOLLOW_DISABLED' }); continue }
      if (key === 'firstMessage' && !state.config.autoFirstMessage) { results.push({ action: key, status: 'skipped', reasonCode: 'AUTO_FIRST_MESSAGE_DISABLED' }); continue }
      if (bucket.cap <= 0) { results.push({ action: key, status: 'skipped', reasonCode: 'DAILY_LIMIT_ZERO' }); continue }
      for (const task of bucket.queue) {
        if (stopped) break
        if (results.length >= limit) break
        // 结果未知的任务不会被自动重试，但每次运行都要显式报出来，避免"悄悄消失"。
        if (task.status === 'uncertain') {
          results.push({ taskId: task.taskId, action: key, status: 'blocked', reasonCode: 'UNCERTAIN_NEEDS_REVIEW', simulated: false })
          continue
        }
        if (task.status !== 'pending') continue
        // 队列生成后才被拒绝/加入联系人的人，执行前再兜底拦截一次。
        if (blockedUsers.has(String(task.platformUserId))) {
          task.status = 'blocked'; task.reasonCode = 'REJECTED_PROTECTED'; task.reason = '该用户已被拒绝联系或已是联系人，禁止执行'; task.finishedAt = now
          results.push({ taskId: task.taskId, action: key, status: 'blocked', reasonCode: 'REJECTED_PROTECTED' })
          continue
        }
        // 只有真实完成才阻断真实重试；模拟完成只阻断模拟重跑。
        const realness = recordRealness(executed[key][task.taskId])
        if (realness === 'real' || (realness === 'simulated' && useDryRun)) {
          task.status = 'skipped'; task.reasonCode = 'DUPLICATE_TASK'; task.reason = '该任务已执行过，跳过'; task.finishedAt = now
          results.push({ taskId: task.taskId, action: key, status: 'skipped', reasonCode: 'DUPLICATE_TASK', simulated: realness === 'simulated' })
          continue
        }
        if (realness === 'unknown') {
          // 旧记录没有明确的模拟/真实标记：既不能当成已完成，也不能盲目重发。
          task.status = 'blocked'; task.reasonCode = 'LEGACY_RECORD_UNCONFIRMED'; task.reason = '历史执行记录未标记模拟或真实，需人工核对后再执行'; task.finishedAt = now
          results.push({ taskId: task.taskId, action: key, status: 'blocked', reasonCode: 'LEGACY_RECORD_UNCONFIRMED' })
          continue
        }
        if (bucket.used >= bucket.cap) { results.push({ action: key, status: 'skipped', reasonCode: 'DAILY_LIMIT_REACHED' }); break }
        // 首次联系必须在该用户已经关注成功后执行，避免先私信后关注。
        if (key === 'firstMessage') {
          const candidateFollowed = task.alreadyFollowed === true || Object.values(executed.follow).some(record => {
            if (record.platformUserId !== task.platformUserId || record.status !== 'done') return false
            // 真实私信必须在真实关注之后；Dry Run 只要求同一轮的模拟关注。
            return useDryRun ? true : record.realAction === true
          })
          if (!candidateFollowed) {
            task.status = 'blocked'; task.reasonCode = 'FOLLOW_NOT_DONE'; task.reason = '尚未确认关注成功，不发送首次消息'; task.finishedAt = now
            results.push({ taskId: task.taskId, action: key, status: 'blocked', reasonCode: 'FOLLOW_NOT_DONE' })
            continue
          }
        }
        if (task.attempts >= state.config.maxAttempts) {
          task.status = 'failed'; task.reasonCode = 'MAX_ATTEMPTS'; task.reason = '超过失败重试上限，停止重试'; task.finishedAt = now
          results.push({ taskId: task.taskId, action: key, status: 'failed', reasonCode: 'MAX_ATTEMPTS' })
          continue
        }
        task.status = 'running'; task.updatedAt = now; task.attempts++
        let outcome = null
        if (useDryRun) outcome = { ok: true, simulated: true }
        else {
          // P2-16：调平台之前先把"已领取"落盘。此处若进程中断，重启后只能判定为结果未知，不会重发。
          task.startedAt = now
          this.save({ queues, executed, budget: { day: budget.day, ...counters, limits }, dryRun: false, status: 'running' })
          try { outcome = await executor({ action: key, taskId: task.taskId, candidateId: task.candidateId, platformUserId: task.platformUserId, nickname: task.nickname, profileUrl: task.profileUrl, message: task.messagePreview, consentEvidenceId: task.consentEvidenceId }) }
          catch (error) { outcome = { ok: false, reasonCode: 'EXECUTOR_ERROR', reason: clean(error?.message, 300) } }
        }
        if (!outcome || typeof outcome !== 'object') outcome = { ok: false, reasonCode: 'EXECUTOR_INVALID_RESULT', reason: '执行器没有返回可判定的结果' }
        if (outcome.ok !== true) {
          const code = clean(outcome.reasonCode, 60) || UNCERTAIN_DEFAULT_CODE
          const detail = clean(outcome.reason, 300) || reasonText(code)
          // 平台明确拒绝或受安全验证拦截：一定没执行，可以安全地终止本轮。
          if (HARD_STOP_CODES.has(code)) { stopped = { code, reason: detail }; task.status = 'failed'; task.reasonCode = code; task.reason = stopped.reason; task.finishedAt = this.now(); break }
          const classification = useDryRun ? 'not_executed' : classifyFailure(outcome)
          // 结果未知（超时、连接中断、异常、核实失败）：保留记录并停止重试，宁可人工核对也不重复外发。
          if (classification !== 'not_executed') {
            task.status = 'uncertain'; task.reasonCode = code; task.reason = detail; task.finishedAt = this.now(); task.updatedAt = task.finishedAt
            task.simulated = false; task.realAction = true; task.outcome = 'UNCERTAIN'
            executed[key][task.taskId] = { ...task }
            results.push({ taskId: task.taskId, action: key, status: 'uncertain', reasonCode: code, simulated: false })
            continue
          }
          task.status = task.attempts >= state.config.maxAttempts ? 'failed' : 'pending'
          task.reasonCode = code; task.reason = detail
          task.finishedAt = task.status === 'failed' ? this.now() : null
          if (task.status === 'pending') task.startedAt = null
          results.push({ taskId: task.taskId, action: key, status: task.status, reasonCode: code })
          continue
        }
        const finished = this.now()
        task.status = 'done'; task.finishedAt = finished; task.updatedAt = finished; task.reasonCode = 'OK'
        task.simulated = useDryRun; task.realAction = !useDryRun; task.outcome = useDryRun ? 'SIMULATED' : 'CONFIRMED'
        task.reason = useDryRun ? 'Dry Run：仅生成执行计划，未做真实操作' : '执行成功'
        executed[key][task.taskId] = { ...task }
        bucket.used++
        if (key === 'follow') { counters.follows++; useDryRun ? counters.simulatedFollows++ : counters.realFollows++ }
        else { counters.messages++; useDryRun ? counters.simulatedMessages++ : counters.realMessages++ }
        results.push({ taskId: task.taskId, action: key, status: task.status, reasonCode: 'OK', dryRun: useDryRun, simulated: useDryRun })
      }
    }

    const pendingLeft = queues.follow.some(task => task.status === 'pending') || queues.firstMessage.some(task => task.status === 'pending')
    const saved = this.save({
      queues,
      executed,
      budget: { day: budget.day, ...counters, limits },
      dryRun: useDryRun,
      status: stopped ? 'stopped' : pendingLeft ? 'running' : 'planned',
      code: stopped ? stopped.code : null,
      lastError: stopped ? stopped.reason : '',
      stoppedAt: stopped ? this.now() : state.stoppedAt,
      stoppedReason: stopped ? stopped.reason : state.stoppedReason,
      lastRunAt: now,
    })
    return {
      ok: true, dryRun: useDryRun, results, stopped, state: saved,
      counts: {
        simulated: results.filter(item => item.simulated === true).length,
        real: results.filter(item => item.status === 'done' && item.simulated !== true).length,
        uncertain: results.filter(item => item.status === 'uncertain').length,
      },
    }
    } finally {
      ACTIVE_RUNS.delete(runKey)
    }
  }
}

module.exports = {
  POLICY_VERSION, HARD_STOP_CODES, CONFIRMED_NOT_EXECUTED_CODES, PENDING_VERIFICATION_CODES, CONFIG_MISSING,
  AUTO_ACTIONS: ['follow', 'firstMessage'],
  dayKey, taskIdOf, recordRealness, classifyFailure, verificationScope, consentEvidenceOf, buildMessagePlan,
  evaluateCandidate, planCandidates, summarize,
  normalizeQueueTask, AutoContactQueue,
}
