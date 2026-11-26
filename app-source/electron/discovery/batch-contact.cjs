// P2-17B.4 批次真实联系：把「已入池的候选」变成「真实关注 + 真实发第一句」。
// 两条路径：
//   · 手动（manual）：用户在卡片上点了按钮并二次确认 = 用户本人已完成判断，
//     跳过全部审核条件（意愿/性别/年龄/已联系/已排除都不拦），只保留"有主页地址、有首句"两个物理前提。
//   · 自动（正式模式批次结束）：无人盯着，硬红线全部保留
//     （已排除 / 已联系 / 缺 sec_uid / 未成年 / 男性 / 意愿门槛 / 每日上限），
//     但不要求逐人的「对方同意」「操作者确认」授权记录——操作者确认由模式切换、风险确认与人数上限承担。
const { candidateGender, candidateAge } = require('./candidate-manager.cjs')
const { friendshipDebug: contactDebug } = require('../friendship.cjs')

const clean = (value, limit = 200) => (typeof value === 'string' ? value.trim().slice(0, limit) : '')

// 意愿门槛：explicit 只认原话明确表达；any 把"结合视频语境可能有意愿"也算进来（默认）。
const INTENT_LEVELS = {
  explicit: ['EXPLICIT_INVITATION', 'SEEKING_FRIENDS'],
  any: ['EXPLICIT_INVITATION', 'SEEKING_FRIENDS', 'CONTEXTUAL_INTEREST'],
}

function intentLevelOf(value) {
  return value === 'explicit' ? 'explicit' : 'any'
}

function intentAllowed(intent, level = 'any') {
  return INTENT_LEVELS[intentLevelOf(level)].includes(String(intent || ''))
}

// 只做判断，不产生任何副作用；界面可以先拿它说明"为什么不能发"。
function preflight(candidate, { contactedIds = [], minIntent = 'any' } = {}) {
  const platformUserId = clean(candidate?.platformUserId, 120)
  const url = clean(candidate?.profileUrl, 300)
  const name = clean(candidate?.nickname, 100)
  const block = (code, reason) => ({ ok: false, code, reason })
  if (!platformUserId || !url) return block('MISSING_AUTHOR_ID', '缺少可唯一确认的作者 ID 或主页地址，不能联系')
  if (candidate?.intentPoolOnly === true && candidate.batchScreening?.status !== 'qualified') return block('BATCH_SCREENING_PENDING', '尚未通过硬性筛选，只保留在全部候选中')
  if (!name) return block('MISSING_NAME', '缺少昵称，无法核对主页身份')
  if (candidate?.status === 'REJECTED' || candidate?.discoveryStatus === 'REJECTED') return block('REJECTED_PROTECTED', '已标记不感兴趣或已排除，禁止联系')
  if (candidate?.status === 'EXCLUDED' || candidate?.discoveryStatus === 'EXCLUDED') return block('EXCLUDED', '候选人已被排除')
  // 上一次执行结果待核实：人工核对之前自动路径不得再次外发，避免重复关注 / 重复发第一句。
  if (candidate?.review?.realContact?.needsReview === true || candidate?.action?.needsReview === true) {
    return block('OUTCOME_UNCERTAIN', '上一次发送结果待核实，已暂停自动重发，请先人工核对')
  }
  if (candidate?.action?.firstMessageStatus === 'sent' || candidate?.review?.realContact?.messageStatus === 'sent') {
    return block('ALREADY_SENT', '第一句已发送')
  }
  if (contactedIds.map(String).includes(platformUserId)) return block('ALREADY_CONTACT', '已经是现有联系人，不重复联系')
  if (!intentAllowed(candidate?.libraryIntent, minIntent)) {
    return block('INTENT_NOT_FRIENDLY', `评论意愿为 ${candidate?.libraryIntent || 'UNKNOWN'}，未达到自动联系门槛`)
  }
  // 性别：与批次筛选同一条硬规则——已确认男性一律不主动联系。
  if (candidateGender(candidate) === 'male') return block('GENDER_MISMATCH', '已确认为男性，不主动联系')
  const age = candidateAge(candidate)
  if (Number.isSafeInteger(age) && age < 18) return block('MINOR_BLOCKED', '年龄未满 18 岁，禁止联系')
  return { ok: true, platformUserId, url, name, intent: clean(candidate?.libraryIntent, 40), age }
}

function openingOf(candidate, text = '') {
  return clean(text, 300) || clean(candidate?.review?.draftOpening, 300)
}

// 三态结果：关注与私信分别记账，界面要分别显示，不能用一个"失败"糊过去。
//   SENT                关注成功 + 第一句已确认发出
//   FOLLOW_PENDING      只发出关注申请，未发第一句
//   FOLLOW_OK_DM_FAILED 关注已成功，但第一句明确没发出（可人工重试发送，不能重复关注）
//   UNCERTAIN           动作已发出但结果无法确认 —— 暂停自动重发，必须人工核对
//   FAILED              关注之前就失败，什么都没执行
function outcomeOf(error, message) {
  const uncertain = error?.outcomeUncertain === true || error?.sendAttempted === true
    || error?.followAttempted === true || /destroyed|Object has been destroyed/i.test(String(error?.message || error))
  if (uncertain) {
    return {
      outcome: 'UNCERTAIN', needsReview: true, autoRetryBlocked: true,
      followStatus: error?.followPending === true ? 'pending' : error?.contactStage === 'greeting' ? 'confirmed' : 'unknown',
      messageStatus: error?.contactStage === 'greeting' ? 'unknown' : 'not_sent',
      code: 'OUTCOME_UNCERTAIN',
      reason: `发送结果待核实：${message}。无法确认关注或第一句是否已生效，已暂停自动重发，请在交友窗口人工核对后再决定。`,
    }
  }
  if (error?.preActionFailure === true && error.followAttempted === false && error.sendAttempted === false) {
    const followed = error.contactStage === 'greeting' || error.followConfirmed === true
    return { outcome: followed ? 'FOLLOW_OK_DM_FAILED' : 'FAILED', needsReview: false, autoRetryBlocked: false,
      followStatus: followed ? 'confirmed' : 'not_followed', messageStatus: 'not_sent', code: error.code || 'PAGE_NOT_READY',
      ...(error.code === 'PAGE_NOT_READY' ? { safeToContinue: true, navigationFailure: true } : {}),
      reason: `${followed ? '已关注，' : ''}页面内容未就绪，本次没有提交第一句：${message}` }
  }
  if (['PROFILE_NAME_MISMATCH', 'NICKNAME_UNREADABLE', 'ACCOUNT_ID_MISMATCH'].includes(error?.code)
    && ['follow', 'greeting'].includes(error?.contactStage)) {
    const followed = error.contactStage === 'greeting' || error.followConfirmed === true
    return { outcome: followed ? 'FOLLOW_OK_DM_FAILED' : 'FAILED', needsReview: false, autoRetryBlocked: false,
      followStatus: followed ? 'confirmed' : 'not_followed', messageStatus: followed ? 'failed' : 'not_sent',
      code: error.code, identityFailure: true, safeToContinue: true,
      reason: `${followed ? '关注已确认，' : ''}昵称或身份暂无法核实，第一句未提交，已跳过此人：${message}` }
  }
  if (error?.contactStage === 'greeting' || error?.followConfirmed === true) {
    return {
      outcome: 'FOLLOW_OK_DM_FAILED', needsReview: false, autoRetryBlocked: false,
      followStatus: 'confirmed', messageStatus: 'failed',
      code: /验证|安全/.test(message) ? 'CHALLENGE_REQUIRED'
        : /登录/.test(message) ? 'LOGIN_REQUIRED'
          : /私信入口|私信面板/.test(message) ? 'DM_UNAVAILABLE' : 'DM_FAILED',
      reason: `关注已成功，但第一句没有发出：${message}`,
    }
  }
  const code = /验证|安全/.test(message) ? 'CHALLENGE_REQUIRED'
    : /频繁|频率|限流/.test(message) ? 'RATE_LIMITED'
      : /登录/.test(message) ? 'LOGIN_REQUIRED'
        : /暂停/.test(message) ? 'AUTO_PAUSED'
          : /私信入口/.test(message) ? 'DM_UNAVAILABLE'
            : 'CONTACT_FAILED'
  // 没有阶段标记、也不是明确的前置拦截：宁可判为待核实，也不自动重发。
  if (code === 'CONTACT_FAILED') {
    return {
      outcome: 'UNCERTAIN', needsReview: true, autoRetryBlocked: true,
      followStatus: 'unknown', messageStatus: 'unknown', code: 'OUTCOME_UNCERTAIN',
      reason: `发送结果待核实：${message}。无法确认是否已执行，已暂停自动重发，请人工核对。`,
    }
  }
  return {
    outcome: 'FAILED', needsReview: false, autoRetryBlocked: false,
    followStatus: 'not_followed', messageStatus: 'not_sent', code,
    reason: message,
  }
}

// 真实执行：关注 → 发第一句。friendship.approach 内部已处理"关注需验证时只申请、不冒充已关注"。
// manual=true 表示用户已在界面上确认对象与内容，跳过全部审核条件，直接执行。
async function contactOne(candidate, { friendship, text = '', contactedIds = [], minIntent = 'any', manual = false } = {}) {
  const url = clean(candidate?.profileUrl, 300)
  const platformUserId = clean(candidate?.platformUserId, 120)
  const name = clean(candidate?.nickname, 100)
  if (!manual) {
    const check = preflight(candidate, { contactedIds, minIntent })
    if (!check.ok) return { ok: false, outcome: 'BLOCKED', needsReview: false, autoRetryBlocked: false, followStatus: 'not_followed', messageStatus: 'not_sent', ...check }
  } else if (!url) {
    return { ok: false, outcome: 'BLOCKED', needsReview: false, autoRetryBlocked: false, followStatus: 'not_followed', messageStatus: 'not_sent', code: 'MISSING_AUTHOR_ID', reason: '缺少主页地址，无法联系' }
  }
  if (!friendship?.approach) return { ok: false, outcome: 'BLOCKED', needsReview: false, autoRetryBlocked: false, followStatus: 'not_followed', messageStatus: 'not_sent', code: 'NO_SERVICE', reason: '交友服务尚未就绪' }
  const opening = openingOf(candidate, text)
  if (!opening) return { ok: false, outcome: 'BLOCKED', needsReview: false, autoRetryBlocked: false, followStatus: 'not_followed', messageStatus: 'not_sent', code: 'OPENING_EMPTY', reason: '没有可用的第一句，请先生成或填写' }
  const common = { candidateId: candidate?.id || null, platformUserId, name, text: opening }
  try {
    // background=false：交友窗口可见。抖音对隐藏窗口会延迟渲染，真实操作必须让页面正常
    // 加载，也让用户能看见每一步（P2-17B.4 实测隐藏窗口 20 秒等不到资料头导致失败）。
    // 这里刻意不做"窗口销毁 → 重建 → 整个流程重来"：那一次的关注/第一句可能已经生效，
    // 重来等于重复外发。结果无法确认时按 UNCERTAIN 停下，交给人工核对。
    contactDebug('contact_start', { name, url, manual })
    const result = await friendship.approach({ url, name, text: opening }, { background: false, automated: !manual })
    contactDebug('contact_done', { name, followPending: result?.followPending === true })
    const sent = result?.messageSent === true || !result?.followPending
    return {
      ok: true, ...common,
      outcome: sent ? 'SENT' : 'FOLLOW_PENDING',
      needsReview: false, autoRetryBlocked: false,
      followStatus: result?.followPending ? 'pending' : 'confirmed',
      messageStatus: sent ? 'sent' : 'not_sent',
      followPending: result?.followPending === true,
      ...(result?.alreadyFollowed === true ? { alreadyFollowed: true } : {}),
      contactId: result?.contactId || null,
      ...(result?.contactSyncPending ? { contactSyncPending: true, deliveryStatus: 'confirmed', warning: result.warning } : {}),
      note: result?.contactSyncPending ? result.warning : result?.followPending ? (sent ? '关注申请中，第一句已确认发送；等待对方回复' : '关注申请中；本次未发送第一句') : '已关注并发送第一句',
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300)
    contactDebug('contact_error', { name, message, stage: error?.contactStage || '', uncertain: error?.outcomeUncertain === true, stack: String(error?.stack || '').slice(0, 800) })
    if (error?.followPending && error.sendAttempted !== true && error.outcomeUncertain !== true && error.followAttempted !== true) {
      return { ok: true, ...common, ...(error.alreadyFollowed === true ? { alreadyFollowed: true } : {}), outcome: 'FOLLOW_PENDING', needsReview: false, autoRetryBlocked: false,
        followStatus: 'pending', messageStatus: 'not_sent', followPending: true,
        note: `关注申请中，第一句未提交：${message}` }
    }
    return { ok: false, ...common, ...(error.alreadyFollowed === true ? { alreadyFollowed: true } : {}), ...outcomeOf(error, message) }
  }
}

// 把三态结果映射成候选池 action 的合法枚举（candidate-manager 的 normalizeCandidateAction
// 只接受固定集合，直接写 confirmed / not_sent 会被静默改成默认值）。
function actionStateOf(result) {
  const followStatus = ({ confirmed: 'followed', pending: 'pending', unknown: 'pending', not_followed: 'not_started' })[result?.followStatus] || 'not_started'
  const firstMessageStatus = ({ sent: 'sent', failed: 'failed', unknown: 'pending', not_sent: 'not_eligible' })[result?.messageStatus] || 'not_eligible'
  return { followStatus, firstMessageStatus,
    ...(result?.needsReview ? { needsReview: true, autoRetryBlocked: true } : { needsReview: false }) }
}

// 批次结束后按本批新增顺序挑人：只挑还没联系过的，最多 limit 个。
function pickBatchTargets(batch, candidates, { limit = 1, contactedIds = [], minIntent = 'any' } = {}) {
  const added = Array.isArray(batch?.added) ? batch.added : []
  const byId = new Map((Array.isArray(candidates) ? candidates : []).map(item => [item.id, item]))
  const skipped = []
  const targets = []
  for (const entry of added) {
    const candidate = byId.get(entry.candidateId) || null
    if (!candidate) { skipped.push({ candidateId: entry.candidateId, nickname: entry.nickname || '', code: 'NOT_IN_POOL', reason: '候选已不在候选池' }); continue }
    const check = preflight(candidate, { contactedIds, minIntent })
    if (!check.ok) { skipped.push({ candidateId: candidate.id, nickname: candidate.nickname || '', code: check.code, reason: check.reason }); continue }
    if (targets.length >= Math.max(0, limit)) { skipped.push({ candidateId: candidate.id, nickname: candidate.nickname || '', code: 'OVER_LIMIT', reason: '超出本轮试水上限' }); continue }
    targets.push(candidate)
  }
  return { targets, skipped }
}

function skippableIdentityFailure(result) {
  return result?.safeToContinue === true && (result.identityFailure === true || result.navigationFailure === true) && !result.ok
    && !result.needsReview && !result.autoRetryBlocked && result.outcome !== 'UNCERTAIN'
    && ['PROFILE_NAME_MISMATCH', 'NICKNAME_UNREADABLE', 'ACCOUNT_ID_MISMATCH', 'PAGE_NOT_READY'].includes(result.code)
    && ['not_sent', 'failed'].includes(result.messageStatus)
}

module.exports = { skippableIdentityFailure, preflight, contactOne, pickBatchTargets, actionStateOf, intentAllowed, intentLevelOf, INTENT_LEVELS }
