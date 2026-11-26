// Pure, bounded expression retrieval. Focus is an input, never a scoring target
// to be rewritten by this module. History with unknown authorship is not style.
const { createHash } = require('node:crypto')
const STAGES = Object.freeze(['new_friend', 'established_friend', 'old_friend'])
const ACTIONS = new Set(['ACK', 'REACTION', 'ANSWER', 'EMPATHY', 'TEASE', 'JOKE', 'FOLLOW_UP', 'DEEPEN', 'SHARE', 'SHARE_AND_ASK', 'SHIFT', 'CLOSE'])
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
const list = value => Array.isArray(value) ? value : []
const id = value => text(value?.messageId || value?.id)
const human = value => value && (value.human === true || value.verifiedHuman === true || value.ownerVerified === true)
const contaminated = value => value?.ai === true || value?.human === false || value?.verifiedHuman === false || /^(?:ai(?:_generated)?|generated|automatic(?:_task)?|shared-conversation)$/i.test(value?.source || value?.provenance || '')
const meaning = focus => text(typeof focus === 'string' ? focus : focus?.summary || focus?.targetMeaning || focus?.text)
const stageAllowed = (sample, stage) => STAGES.includes(sample) && STAGES.indexOf(sample) <= STAGES.indexOf(stage)
const sensitive = value => /(?:https?:\/\/|\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+|身份证|银行卡|密码|工资|薪资|月薪|年薪|保证|答应|承诺|一定帮|转(?:给你|账)|借你|还你|学校叫|[\u4e00-\u9fff]{2,10}(?:大学|学院)|北航|北大|清华|\d{2,}.{0,3}(?:元|块)|我(?:昨天|今天|前天|上周|之前|曾经|上次|去年|当时)|我在.{1,15}(?:工作|上班|读书|实习|住)|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i.test(value)
function inferAction(reply) {
  if (/晚安|睡吧|回头聊|下次聊|不打扰/.test(reply)) return 'CLOSE'
  if (/辛苦|别难过|抱抱|挺不容易|确实难受/.test(reply)) return 'EMPATHY'
  if (/你是真|真稳定|无敌了|服了你/.test(reply)) return 'TEASE'
  if (/[?？]|咋|怎么|哪个|什么时候/.test(reply)) return 'FOLLOW_UP'
  if (/哈哈|笑死|离谱|卧槽/.test(reply)) return 'REACTION'
  return 'ACK'
}
function normalizeSample(value, source, contactId, stage, proof, contextIds = []) {
  if (!value || typeof value !== 'object' || contaminated(value)) return null
  const fields = Object.fromEntries(['contextSummary', 'targetMeaning', 'myReply'].map(key => [key, text(value[key])]))
  if (Object.values(fields).some(value => !value || value.length > 80)) return null
  const relationshipStage = value.relationshipStage || stage
  if (!stageAllowed(relationshipStage, stage)) return null
  if (source === 'approved_global' && (sensitive(Object.values(fields).join(' ')) || list(value.sensitiveNames).some(name => text(name) && Object.values(fields).join(' ').includes(text(name))))) return null
  const action = ACTIONS.has(value.action) ? value.action : inferAction(fields.myReply)
  return { ...fields, action, relationshipStage,
    sampleId: text(value.sampleId) || `reply_${createHash('sha256').update(JSON.stringify([contactId, fields, contextIds])).digest('hex').slice(0, 18)}`,
    provenance: source, sourceContactId: source === 'approved_global' ? '' : contactId,
    contextMessageIds: contextIds.filter(Boolean).slice(0, 5), verifiedHuman: proof === true }
}
function deriveReplyExamples({ contact = {}, relationshipStage = 'new_friend', globalExamples = [] } = {}) {
  if (!STAGES.includes(relationshipStage)) return []
  const contactId = text(contact.id || contact.name), result = []
  const messages = list(contact.learning?.messages).slice(-80)
  const style = list(contact.learning?.styleMessages).slice(-80)
  for (let index = 1; index < messages.length; index += 1) {
    const reply = messages[index], context = messages[index - 1]
    if (reply?.role !== 'me' || contaminated(reply) || context?.role !== 'contact' || context.quote || context.mediaEvidence || context.type && context.type !== 'text') continue
    const myReply = text(reply.text), contextSummary = text(context.text)
    // A legacy style entry has no role provenance of its own. Only join it
    // when there is exactly one occurrence AND explicit human proof remains.
    const matches = messages.filter(row => row?.role === 'me' && text(row.text) === myReply)
    const markedStyle = style.filter(row => row?.role === 'me' && text(row.text) === myReply && !contaminated(row) && human(row)
      && id(row) && id(row) === id(reply))
    const verified = human(reply) || markedStyle.length === 1
    if (matches.length !== 1 || !verified || !id(context) || !id(reply)) continue
    const sample = normalizeSample({ contextSummary, targetMeaning: contextSummary, myReply,
      action: reply.action, relationshipStage: reply.relationshipStage }, 'current_contact_human', contactId, relationshipStage, true, [id(context), id(reply)])
    if (sample) result.push(sample)
  }
  if (contact.profile?.examplesSource === 'owner') for (const entry of list(contact.profile.examples).slice(-40)) {
    if (!entry || typeof entry !== 'object' || !human(entry) || !['manual_owner', 'owner'].includes(entry.source || entry.provenance)) continue
    const sample = normalizeSample(entry, 'manual_owner', contactId, relationshipStage, true, list(entry.contextMessageIds))
    if (sample) result.push(sample)
  }
  // Global examples are an explicit, approved, sanitized corpus. Do not scan
  // other contacts or carry their IDs, memories, and dates into this context.
  for (const entry of list(globalExamples).slice(0, 100)) {
    if (!entry || entry.approved !== true || entry.sanitized !== true || entry.ownerVerified !== true || entry.verifiedHuman !== true
      || !STAGES.includes(entry.relationshipStage) || !ACTIONS.has(entry.action) || contaminated(entry)) continue
    const sample = normalizeSample(entry, 'approved_global', '', relationshipStage, true)
    if (sample) result.push(sample)
  }
  const unique = new Map()
  for (const sample of result) {
    const key = `${sample.contextSummary}\n${sample.myReply}`
    if (!unique.has(key)) unique.set(key, sample)
  }
  return [...unique.values()]
}
function tokens(value) {
  const normalized = text(value).toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
  return new Set([...normalized].flatMap((_, index, chars) => index < chars.length - 1 ? [chars.slice(index, index + 2).join('')] : []))
}
function overlap(left, right) {
  const a = tokens(left), b = tokens(right)
  if (!a.size || !b.size) return left && right && left === right ? 1 : 0
  const common = [...a].filter(item => b.has(item)).length
  return common / Math.min(a.size, b.size)
}
function scoreExamples(pool, { focus, relationshipStage = 'new_friend', action = 'unknown' } = {}) {
  const target = meaning(focus)
  if (!target || !STAGES.includes(relationshipStage)) return []
  return list(pool).filter(sample => sample?.verifiedHuman === true && stageAllowed(sample.relationshipStage, relationshipStage)
    && ['current_contact_human', 'manual_owner', 'approved_global'].includes(sample.provenance))
    .map(sample => ({ sample, similarity: Math.max(overlap(target, sample.targetMeaning), overlap(target, sample.contextSummary)) }))
    .filter(item => item.similarity > 0)
    .map(item => ({ ...item.sample, relevance: Number((item.similarity * 0.7 + (item.sample.relationshipStage === relationshipStage ? 0.1 : 0)
      + (ACTIONS.has(action) && item.sample.action === action ? 0.2 : 0)).toFixed(4)) }))
    .sort((a, b) => Number(a.provenance === 'approved_global') - Number(b.provenance === 'approved_global') || b.relevance - a.relevance || a.sampleId.localeCompare(b.sampleId))
    .slice(0, 20)
}
function rankReplyExamples(pool, options = {}) { return scoreExamples(pool, options).slice(0, 3) }
function retrieveReplyExamples(options = {}) { return rankReplyExamples(deriveReplyExamples(options), options) }
function retrieveReplyCandidatePool(options = {}) { return scoreExamples(deriveReplyExamples(options), options) }
module.exports = { STAGES, deriveReplyExamples, retrieveReplyCandidatePool, retrieveReplyExamples, rankReplyExamples }
