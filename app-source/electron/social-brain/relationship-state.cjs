// Observable interaction tendencies, not a psychological or romantic assessment.
const { journeyStage } = require('../conversation-modes.cjs')
const DIMENSIONS = Object.freeze(['warmth', 'familiarity', 'curiosity', 'playfulness', 'trust', 'flirt'])
const MAX_STEP = 0.015
const DAILY_LIMIT = 0.04
const list = value => Array.isArray(value) ? value : []
const clean = value => typeof value === 'string' ? value.trim().slice(0, 300) : ''
const clamp = (value, fallback) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback
const round = value => Math.round(value * 10000) / 10000
function timestamp(value) {
  const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(at)) throw new TypeError('Relationship state now must be a valid timestamp')
  return at
}
function contactKey(contact) { return clean(contact?.id || contact?.name) || 'current' }
function relationshipStage(contact, explicit) {
  const canonical = journeyStage(contact)
  if (canonical) return canonical
  if (/^(?:STRANGER|EXPLORING|ACQUAINTANCE|FAMILIAR|FRIEND|CLOSE_FRIEND)$/.test(explicit || '')) return explicit
  if (explicit && ['NEW_CONTACT', 'FRIEND', 'new_friend', 'established_friend', 'old_friend'].includes(explicit)) return ['NEW_CONTACT', 'new_friend'].includes(explicit) ? 'NEW_CONTACT' : 'FRIEND'
  const relation = clean(contact?.profile?.relationship || contact?.profile?.relation)
  if (/陌生|刚认识|新朋友|不熟/.test(relation)) return 'NEW_CONTACT'
  return /^(?:oldfriend|old_friend)$/.test(contact?.profile?.chatMode || '') || /舍友|室友|老朋友|好朋友|发小|闺蜜|多年|大学同学|老同学/.test(relation) ? 'FRIEND' : 'NEW_CONTACT'
}
function actualMessages(messages, contact) {
  const seen = new Set(), key = contactKey(contact)
  return list(messages).filter(row => {
    if (!row || !['me', 'contact'].includes(row.role || row.senderRole)) return false
    if (row.contactId && clean(row.contactId) !== key) return false
    const confirmedSent = row.status === 'sent' || row.sent === true || row.confirmedSent === true
    if (row.draft === true || row.isDraft === true || !confirmedSent && /draft|planner|writer|generated|preview/i.test(row.source || '') || ['pending', 'draft', 'outdated', 'failed'].includes(row.status)) return false
    const id = clean(row.id || row.messageId)
    if (!id || seen.has(id)) return false
    seen.add(id); return true
  }).slice(-240).map(row => ({ id: clean(row.id || row.messageId), role: row.role || row.senderRole, text: clean(row.text || row.caption), at: row.at || row.sentAt || null, quote: row.quote, textSource: row.textSource }))
}
const asserted = row => row.role === 'contact' && row.text && !row.quote && !/ocr|visual|media|interpretation/i.test(row.textSource || '') && !/他说|她说|听说|我朋友|转发|引用|[“「『"]/.test(row.text)

function normalizeRelationshipState(value, { contact = {}, now = Date.now() } = {}) {
  const at = timestamp(now), key = contactKey(contact)
  const stage = relationshipStage(contact), friend = ['FRIEND', 'CLOSE_FRIEND'].includes(stage)
  const saved = value && typeof value === 'object' && (!value.contactId || value.contactId === key) ? value : {}
  const defaults = { warmth: 0.5, familiarity: friend ? 0.5 : 0.15, curiosity: 0.65, playfulness: friend ? 0.5 : 0.25, trust: friend ? 0.4 : 0.15, flirt: 0 }
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
  return { version: 1, contactId: key, ...Object.fromEntries(DIMENSIONS.map(name => [name, clamp(saved[name], defaults[name])])),
    processedMessageIds: [...new Set(list(saved.processedMessageIds).filter(id => typeof id === 'string' && id).slice(-240))],
    sourceMessageIds: list(saved.sourceMessageIds).filter(id => typeof id === 'string' && id).slice(-24),
    updateBudget: { day, used: saved.updateBudget?.day === day ? clamp(saved.updateBudget.used, 0) : 0 },
    updatedAt: Number.isFinite(Date.parse(saved.updatedAt)) ? new Date(saved.updatedAt).toISOString() : new Date(at).toISOString(),
    provenance: 'observable_interaction_tendency', automaticStageUpgrade: false }
}

function buildRelationshipState({ contact = {}, previousState = contact.relationshipState, messages = contact?.learning?.messages || [], momentum, now = Date.now() } = {}) {
  const at = timestamp(now), state = normalizeRelationshipState(previousState, { contact, now: at })
  const rows = actualMessages(messages, contact).filter(row => !row.at || !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) <= at + 300000)
  const seen = new Set(state.processedMessageIds), novel = rows.filter(row => !seen.has(row.id))
  if (!novel.length) return state
  const inbound = novel.filter(row => row.role === 'contact'), outgoing = rows.filter(row => row.role === 'me')
  const bilateral = inbound.length > 0 && outgoing.length > 0
  const denied = inbound.some(row => /别再(?:问|聊|发)|别(?:问|联系)|不想聊|不要联系|不用回复/.test(row.text))
  const positive = inbound.some(row => /哈哈|嘿嘿|好耶|开心|谢谢|不错|终于|笑死/.test(row.text))
  const sharing = inbound.some(row => asserted(row) && /(?:^|[，。！! ])我(?!朋友|爸|妈|同学|室友)/.test(row.text))
  const asking = inbound.some(row => /[?？]|你呢|你.*(?:什么|哪|吗|咋)/.test(row.text))
  const humor = inbound.some(row => /哈哈|笑死|绷不住|离谱|笑不活|你是真/.test(row.text)) && bilateral
  // A high momentum score alone cannot manufacture evidence. Every update has
  // novel real-message IDs, and every dimension shares one bounded daily budget.
  const engaged = bilateral && momentum?.engagement?.level === 'HIGH'
  const directions = { warmth: denied ? -1 : positive || engaged ? 1 : 0, familiarity: bilateral && !denied ? 0.35 : 0,
    curiosity: denied ? -0.5 : asking ? 0.4 : 0, playfulness: denied ? -0.5 : humor ? 0.6 : 0,
    trust: sharing && bilateral && !denied ? 0.25 : 0, flirt: 0 }
  const available = Math.max(0, DAILY_LIMIT - state.updateBudget.used), step = Math.min(MAX_STEP, available)
  const changed = Object.values(directions).some(value => value !== 0) && step > 0
  for (const name of DIMENSIONS) state[name] = round(clamp(state[name] + step * directions[name], state[name]))
  state.processedMessageIds = [...new Set([...state.processedMessageIds, ...novel.map(row => row.id)])].slice(-240)
  state.sourceMessageIds = [...new Set([...state.sourceMessageIds, ...inbound.map(row => row.id)])].slice(-24)
  state.updateBudget.used = round(state.updateBudget.used + (changed ? step : 0))
  state.updatedAt = new Date(at).toISOString()
  return state
}

module.exports = { DIMENSIONS, MAX_STEP, DAILY_LIMIT, contactKey, relationshipStage, actualMessages, normalizeRelationshipState, buildRelationshipState, updateRelationshipState: buildRelationshipState }
