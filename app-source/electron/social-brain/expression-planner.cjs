const { STICKER_INTENTS, stickerSlot } = require('./sticker-slots.cjs')
const EXPRESSION_MODES = Object.freeze(['TEXT_ONLY', 'STICKER_ONLY', 'TEXT_AND_STICKER', 'NO_REPLY'])
const STICKER_POSITIONS = Object.freeze(['before_text', 'after_text', 'only'])
const EXPRESSION_RULES = `\nplan增加expression:{mode,stickerIntent,stickerPosition}。mode只能TEXT_ONLY/STICKER_ONLY/TEXT_AND_STICKER/NO_REPLY，stickerIntent只能${STICKER_INTENTS.join('/')}，stickerPosition只能before_text/after_text/only。只选择语义，不输出slot、index、点击位置或数字槽位。表情是可选表达，并非TEASE或其他action的必选结果。TEXT_ONLY intent=NONE；STICKER_ONLY position=only且不写正文；NO_REPLY绝不变成发表情。TEXT_AND_STICKER默认after_text，只有先用表情接住情绪更自然时before_text。严肃痛苦不使用HAPPY/TEASE/SPEECHLESS；安慰对方用COMFORT，轻中度失落可SAD；替对方吐槽可ANNOYED，但不升级双方冲突。GOODNIGHT配合收尾。新朋友禁止FLIRT；只有已有明确双方暧昧语境与合适关系才可用，不能主动制造暧昧。遵守expressionConstraints频率与关系限制，最近两轮都用表情则不用，最近三轮两次显著抑制，同一intent不连续机械重复。主动开场与事件跟进默认TEXT_ONLY。`
function textExpression() { return { mode: 'TEXT_ONLY', stickerIntent: 'NONE', stickerPosition: 'after_text', slot: null } }
function noReplyExpression() { return { mode: 'NO_REPLY', stickerIntent: 'NONE', stickerPosition: 'only', slot: null } }
function validateExpression(value) {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('表情规划必须是对象')
  if (!EXPRESSION_MODES.includes(value.mode) || !STICKER_INTENTS.includes(value.stickerIntent) || !STICKER_POSITIONS.includes(value.stickerPosition)) throw new Error('表情规划枚举无效')
  // Reject numerical control data rather than accepting a model-selected slot.
  if (Object.keys(value).some(key => !['mode', 'stickerIntent', 'stickerPosition'].includes(key))) throw new Error('表情规划只能选择语义，禁止输出槽位或点击参数')
  if (['STICKER_ONLY', 'TEXT_AND_STICKER'].includes(value.mode) && value.stickerIntent === 'NONE') throw new Error('表情模式缺少有效语义')
  if (['TEXT_ONLY', 'NO_REPLY'].includes(value.mode) && value.stickerIntent !== 'NONE') throw new Error('文字或不回复模式不能附带表情')
  if (value.mode === 'STICKER_ONLY' && value.stickerPosition !== 'only' || value.mode === 'TEXT_AND_STICKER' && value.stickerPosition === 'only') throw new Error('表情规划顺序无效')
}
// Count confirmed outgoing turns, including partially delivered batches.
// A completed marker and its individual items represent the same turn.
function recentExpressionReplies(history, contact) {
  const name = typeof contact === 'string' ? contact : contact?.name
  const id = typeof contact === 'object' ? contact?.id : null
  const relevant = (Array.isArray(history) ? history : []).filter(row => row && row.name === name && (!id || !row.contactId || row.contactId === id))
  const turns = [], batches = new Map()
  for (const row of relevant) {
    if (['failed', 'unknown', 'pending', 'sending'].includes(row.status)) continue
    if (row.kind && !['expression_turn', 'text', 'sticker', 'emoji', 'ai', 'ai_draft', 'expression', 'expression_batch', 'reply', 'manual'].includes(row.kind)) continue
    const intent = row.expression?.stickerIntent || row.stickerIntent || 'NONE'
    const stickerIntent = STICKER_INTENTS.includes(intent) ? intent : 'NONE'
    const turn = { stickerIntent, usedSticker: stickerIntent !== 'NONE', row }
    if (row.expressionBatchId) {
      const existing = batches.get(row.expressionBatchId)
      if (existing) {
        if (turn.usedSticker) { existing.stickerIntent = stickerIntent; existing.usedSticker = true }
        existing.row = row
        turns.splice(turns.indexOf(existing), 1); turns.push(existing)
      } else { turns.push(turn); batches.set(row.expressionBatchId, turn) }
    } else {
      const previous = turns.at(-1)
      const gap = new Date(row.at).getTime() - new Date(previous?.row?.at).getTime()
      // Manual sends write a text ledger row followed by a marker. Merge that
      // adjacent pair without discarding other real manual text replies.
      if (row.kind === 'expression_turn' && previous?.row.kind === 'text' && !previous.row.expressionBatchId && gap >= 0 && gap <= 1000) previous.row = row
      else turns.push(turn)
    }
  }
  return turns.slice(-3).map(({ stickerIntent, usedSticker }) => ({ stickerIntent, usedSticker }))
}
function expressionConstraints({ enabled = true, recentReplies = [] } = {}) {
  const recent = recentReplies.slice(-3)
  return { enabled: enabled === true, recentReplies: recent, consecutiveStickerReplies: recent.slice(-2).filter(row => row.usedSticker).length === 2 && recent.length >= 2, highFrequency: recent.filter(row => row.usedSticker).length >= 2, lastStickerIntent: recent.at(-1)?.stickerIntent || 'NONE' }
}
function guardExpression(plan, context = {}) {
  validateExpression(plan.expression)
  if (!plan.shouldReply || plan.action === 'NO_REPLY') return noReplyExpression()
  const payload = context.payload || {}, constraints = payload.expressionConstraints || {}
  const proposed = plan.expression || textExpression()
  if (constraints.enabled === false || payload.proactiveCandidate || context.opening || proposed.mode === 'TEXT_ONLY') return textExpression()
  // The ordinary planner's NO_REPLY expression is a decision, not permission
  // to send a sticker. parsePlan also aligns shouldReply/messageCount with it.
  if (proposed.mode === 'NO_REPLY') return noReplyExpression()
  let intent = proposed.stickerIntent
  const stage = payload.socialBehaviorConstraints?.relationshipStage || 'new_friend'
  const intensity = Number(plan.relationshipIntensity) || 0
  const media = payload.currentMessageMedia
  const focus = payload.attentionContext?.selectedFocus
  const text = [payload.incoming, ...(payload.currentIncomingBurst?.messages || []).map(row => row.text), focus?.summary, payload.attentionContext?.activeTopic?.summary].filter(Boolean).join(' ')
  const emotion = [...(media?.understandingStatus === 'understood' ? media.emotion || [] : []), ...(focus?.emotion || [])].join(' ')
  const meaning = media?.understandingStatus === 'understood' && Number(media.confidence) >= 0.65 ? media.socialMeaning || '' : ''
  const serious = /去世|离世|重病|癌症|住院|葬礼|自杀|自残|崩溃|痛苦|绝望|家暴|分手|别开玩笑|认真(?:说|的)|真的.{0,3}(?:难过|生气)|serious|distressed/i.test(text + emotion + meaning)
  const negative = serious || /难过|伤心|失落|难受|心疼|烦|累|被骂|凉了|sad|angry|frustrated|悲伤|愤怒/i.test(text + emotion + meaning)
  const interpersonalConflict = /(?:你|我俩|我们).{0,8}(?:滚|讨厌|生气|吵架|绝交)|别再.{0,4}(?:找|联系)|拉黑|不想理你/.test(text)
  const engagement = payload.conversationMomentum?.engagement?.level || payload.attentionContext?.activeTopic?.engagement?.level || 'MEDIUM'
  let reason = ''
  if (constraints.consecutiveStickerReplies || constraints.highFrequency) reason = '近期表情使用较多，本轮留出文字或安静空间'
  else if (intent === constraints.lastStickerIntent && intent !== 'NONE') reason = '不连续使用相同表情语义'
  else if (engagement === 'LOW' || engagement === 'ENDING' && intent !== 'GOODNIGHT') reason = '当前参与度低或已在收尾，不追加表情'
  else if (context.constraints?.mediaUnderstandingFailed && !payload.incoming?.trim()) reason = '媒体理解失败，不能脑补表情回应'
  else if (intent === 'FLIRT' && (stage === 'new_friend' || intensity < 0.4 || !/想你|喜欢你|亲亲|亲你|抱抱你|想抱你|害羞|暧昧/.test(text + meaning) || serious || interpersonalConflict)) reason = '关系或明确暧昧语境不足，不能主动制造暧昧'
  else if (intent === 'TEASE' && (serious || negative || stage === 'new_friend' && (intensity > 0.25 || !['REACTION', 'TEASE', 'JOKE'].includes(plan.action)))) reason = '当前情绪或关系不允许调侃表情'
  else if (intent === 'HAPPY' && negative) reason = '负面情绪不发送庆祝表情'
  else if (intent === 'SPEECHLESS' && serious) reason = '严肃痛苦场景不发送无语表情'
  else if (intent === 'SAD' && serious) reason = '严重痛苦需要明确关心，不以自身失落表情代替'
  else if (intent === 'SAD' && !negative) reason = '没有轻中度失落语境'
  else if (intent === 'COMFORT' && !(negative || plan.action === 'EMPATHY' || /安慰|支持/.test(plan.goal || ''))) reason = '没有安慰对象的语境'
  else if (intent === 'ANNOYED' && (interpersonalConflict || serious || !/烦|生气|气死|离谱|老板|老师|被骂|不爽|吐槽|angry|frustrated/.test(text + emotion))) reason = '缺少共同吐槽语境或可能升级冲突'
  else if (intent === 'GOODNIGHT' && !(plan.action === 'CLOSE' || plan.shouldCloseTopic || engagement === 'ENDING' || /晚安|睡了|睡觉/.test(text))) reason = '当前还没有晚安或收尾语境'
  if (reason) return { ...textExpression(), reason }
  if (intent === 'SAD' && (plan.action === 'EMPATHY' || /安慰|支持/.test(plan.goal || ''))) intent = 'COMFORT'
  // Guard-controlled replacement must also respect the repetition limit.
  if (intent === constraints.lastStickerIntent) return { ...textExpression(), reason: '不重复安慰表情' }
  return { mode: proposed.mode, stickerIntent: intent, stickerPosition: proposed.mode === 'STICKER_ONLY' ? 'only' : proposed.stickerPosition, slot: stickerSlot(intent) }
}
module.exports = { EXPRESSION_MODES, STICKER_POSITIONS, EXPRESSION_RULES, textExpression, noReplyExpression, validateExpression, recentExpressionReplies, expressionConstraints, guardExpression }
