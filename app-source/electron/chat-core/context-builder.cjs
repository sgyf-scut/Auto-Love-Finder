// STABLE_CORE: the only production boundary that assembles Engine input.
const { randomUUID } = require('node:crypto')
const { createReadonlyChatContext } = require('./chat-types.cjs')
const { redactPrivateData, getRelevantSelfProfile, collectPrivateValues } = require('../social-brain/disclosure-policy.cjs')
const { normalizeSelfProfile, inferShareLevel } = require('../social-brain/self-profile.cjs')
const { normalizeIncomingBurst, dedupeHistory } = require('../social-brain/incoming-burst.cjs')
const { retrieveSelfNarratives } = require('../social-brain/self-narrative-retriever.cjs')
const { retrievePromises } = require('../social-brain/promise-retriever.cjs')

const jsonData = value => JSON.parse(JSON.stringify(value))
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
function cautiousValues(profile, approved = []) {
  const normalized = normalizeSelfProfile(profile)
  const allowed = new Set(approved.flatMap(item => [item.id, item.key]))
  return [...normalized.stableProfile, ...normalized.currentLife].filter(item => {
    const cautiousPreference = normalized.privacyPreferences.some(pref => (pref.key === item.key || /school|education/i.test(item.key) && /school|education/i.test(pref.key)) && ['CAUTIOUS', 'PRIVATE'].includes(inferShareLevel(pref)))
    return (['CAUTIOUS', 'PRIVATE'].includes(inferShareLevel(item)) || cautiousPreference) && !allowed.has(item.id) && !allowed.has(item.key)
  }).flatMap(item => [item.sourceText, ...(Array.isArray(item.value) ? item.value : [item.value])]).filter(value => value !== null && value !== undefined && String(value).length >= 2).map(String)
}
function validatedApprovals(profile, context, approved) {
  const relevant = getRelevantSelfProfile(profile, context, { now: context?.now || new Date() })
  return relevant.filter(item => approved.some(value => (value.id === item.id || value.key === item.key) && JSON.stringify(value.value) === JSON.stringify(item.value)))
}
function scopeContactData(value, contact) {
  const contactId = contact?.id || contact?.name
  const foreign = (contact?.learning?.messages || []).filter(row => row.contactId && row.contactId !== contactId)
  const ids = new Set(foreign.flatMap(row => [row.id, row.messageId]).filter(Boolean))
  const texts = foreign.map(row => row.text).filter(text => typeof text === 'string' && text.length >= 2)
  const clean = item => {
    if (typeof item === 'string') return texts.some(text => item.includes(text)) ? undefined : item
    if (Array.isArray(item)) return item.map(clean).filter(child => child !== undefined)
    if (item && typeof item === 'object') {
      if (item.contactId && item.contactId !== contactId || ids.has(item.id) || ids.has(item.messageId) || item.sourceMessageIds?.some(id => ids.has(id))) return undefined
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, clean(child)]).filter(([, child]) => child !== undefined))
    }
    return item
  }
  return clean(value)
}
// Omit a contaminated value, never replace a fact with an XX/redaction token.
// Filtering applies equally to notes, examples, quoted messages and media text.
function omitSensitive(value, profile, forbidden = []) {
  const marker = /\[私密信息\]/
  function clean(item) {
    if (typeof item === 'string') {
      if (marker.test(item) || forbidden.some(secret => secret && item.includes(secret))) return undefined
      if (redactPrivateData(item, profile) !== item) return undefined
      return item
    }
    if (typeof item === 'number' && forbidden.includes(String(item))) return undefined
    if (Array.isArray(item)) return item.map(clean).filter(child => child !== undefined)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => clean(key) !== undefined).map(([key, child]) => [key, clean(child)]).filter(([, child]) => child !== undefined))
    return item
  }
  return clean(value)
}

function safeLegacyContext(context, profile, { approved = [] } = {}) {
  if (!context) return null
  approved = validatedApprovals(profile, context, approved)
  const normalized = normalizeSelfProfile(profile, { now: context.now })
  const allowed = new Set(approved.map(item => item.id || item.key))
  const candidates = getRelevantSelfProfile(profile, context, { now: context.now })
  const cautious = candidates.filter(item => item.shareLevel === 'CAUTIOUS' && !allowed.has(item.id) && !allowed.has(item.key))
  const forbidden = [...collectPrivateValues(profile), ...cautiousValues(profile, approved)]
  const safeItems = candidates.filter(item => !cautious.some(blocked => blocked.id === item.id))
  const safeProfile = profile ? { enabled: profile.enabled, revision: profile.revision || 0, stableProfile: safeItems, currentLife: [], privacyPreferences: [] } : null
  const selected = pick(context, ['payload', 'relationshipJourney', 'selfRelevant', 'personaLens', 'relationshipState', 'newFriendContext', 'memory', 'messages', 'attention', 'conversationState', 'momentum', 'replyExampleCandidates', 'opportunity', 'constraints', 'estimatedTokens', 'tokenBudget', 'opening', 'now', 'journeyEvaluation'])
  selected.contact = safeContact(context.contact)
  selected.selfProfile = safeProfile
  selected.selfRelevant = safeItems
  const safe = omitSensitive(jsonData(selected), normalized, forbidden)
  // Preserve field identities for Planner selection without passing unapproved values.
  const descriptors = cautious.map(({ id, key, label, shareLevel, disclosurePreference, score }) => ({ id, key, label, shareLevel, disclosurePreference, score }))
  if (safe.payload.selfProfileContext) safe.payload.selfProfileContext.selfRelevant = [...safeItems, ...descriptors]
  const selfLayer = safe.payload.layers?.find(layer => layer.layer === 1)
  if (selfLayer?.data?.items) selfLayer.data.items = [...safeItems, ...descriptors]
  return scopeContactData(safe, context.contact)
}

function safeContact(contact) {
  if (!contact) return null
  return { ...pick(contact, ['id', 'name', 'relationshipJourney', 'relationshipState', 'personaLens', '_selfPersona', '_globalDefaultTone', '_showAiModelLabel', '_incomingMeta', '_allowEmoji']),
    profile: pick(contact.profile, ['chatMode', 'relationship', 'relation', 'call', 'personality', 'preferences', 'boundary', 'notes', 'tone', 'examples', 'examplesSource', 'useSelfPersona']),
    learning: pick(contact.learning, ['messages', 'facts', 'topicLog', 'mediaLog', 'ownerStyle', 'contactStyle', 'styleMessages', 'relationshipPlan', 'messageSemantics']) }
}

function buildChatContext({ accountId, contact, incoming = '', burst, context, profile, legacy, approved = [], traceId = randomUUID() }) {
  approved = validatedApprovals(profile, context || { incoming }, approved)
  const safe = safeLegacyContext(context, profile, { approved })
  const relevant = getRelevantSelfProfile(profile, context || { incoming }, { now: context?.now || new Date() })
  const approvedKeys = new Set(approved.flatMap(item => [item.id, item.key]))
  const cautious = relevant.filter(item => item.shareLevel === 'CAUTIOUS' && !approvedKeys.has(item.id) && !approvedKeys.has(item.key))
  const forbidden = [...collectPrivateValues(profile), ...cautiousValues(profile, approved)]
  const normalizedBurst = normalizeIncomingBurst(burst, contact?.id || contact?.name)
  const rows = normalizedBurst?.messages || (incoming ? [{ role: 'contact', text: incoming }] : [])
  const safeLegacy = pick(legacy, ['mode', 'incoming', 'genMedia', 'genFrames', 'mediaAnalysis', 'hasMediaContext', 'usageTracker', 'started', 'showAiModelLabel', 'adaptiveProfileEnabled', 'opening'])
  if (legacy?.config) safeLegacy.config = { settings: pick(legacy.config.settings, ['showAiModelLabel', 'twoMessageChance']), aiSkills: (legacy.config.aiSkills || []).map(skill => pick(skill, ['id', 'name', 'enabled', 'target', 'invocation', 'instruction', 'content', 'description'])) }
  // A stored history row can already be duplicated: every re-read of the DOM
  // window used to append the window again, and a real send id never matched its
  // position fingerprint. Collapse id-only and fingerprint copies before the
  // Engine sees them, so recent history carries distinct messages only.
  const history = dedupeHistory([...(safe?.messages || contact?.learning?.messages || [])])
  // The newest inbound is already rendered in full as its own section, so its
  // copies must not also occupy recent-history slots. Dedup can relocate a burst
  // row to an earlier position (a fingerprint copy collapses onto the real-id copy
  // in place), so matching only the tail would leave the newest message duplicated.
  // Walk backwards from the tail and drop the latest occurrence of each burst row.
  const dropIndexes = new Set()
  let cursor = history.length - 1
  for (const row of [...rows].reverse()) {
    const id = row?.messageId || row?.id
    const text = typeof row?.text === 'string' ? row.text : ''
    if (!id && !text) continue
    let found = -1
    for (let index = cursor; index >= 0; index -= 1) {
      if (dropIndexes.has(index)) continue
      const candidate = history[index]
      if (id ? [candidate?.messageId, candidate?.id].includes(id) : candidate?.text === text) { found = index; break }
    }
    if (found >= 0) { dropIndexes.add(found); cursor = found - 1 }
  }
  const recentMessages = history.filter((_, index) => !dropIndexes.has(index))
  const data = { traceId, accountId: String(accountId || 'local'), contactId: String(contact?.id || contact?.name || 'opening'),
    incomingMessages: rows, recentMessages,
    contactFacts: safe?.payload.layers?.find(layer => layer.layer === 3)?.data?.facts || [],
    selfFacts: safe?.selfRelevant || relevant.filter(item => !cautious.some(blocked => blocked.id === item.id)),
    sharedMemories: safe?.payload.relevantSharedMemories || [],
    selfNarratives: retrieveSelfNarratives({ contact, incoming,
      activeTopic: safe?.payload?.attentionContext?.activeTopic, selectedFocus: safe?.payload?.attentionContext?.selectedFocus,
      now: context?.now || new Date(), selfProfile: profile }),
    promises: retrievePromises({ contact, incoming, currentIncomingBurst: normalizedBurst,
      activeTopic: safe?.payload?.attentionContext?.activeTopic, selectedFocus: safe?.payload?.attentionContext?.selectedFocus,
      now: context?.now || new Date(), selfProfile: profile }),
    relationship: { stage: safe?.relationshipJourney?.currentStage || contact?.relationshipJourney?.currentStage || 'STRANGER', description: contact?.profile?.relationship || '' },
    interactionNotes: [contact?.profile?.notes].filter(Boolean),
    conversation: { summary: safe?.conversationState?.activeTopic?.summary || null, openLoops: safe?.conversationState?.openPoints || [] },
    constraints: { privacy: ['PRIVATE_EXCLUDED', 'UNAPPROVED_SENSITIVE_EXCLUDED'], handoffTopics: [] },
    metadata: { legacy: { ...safeLegacy, context: safe, current: safeContact(contact) }, selfProfileRevision: profile?.revision || 0 } }
  return createReadonlyChatContext(jsonData(omitSensitive(scopeContactData(data, contact), profile, forbidden)))
}

module.exports = { buildChatContext, safeLegacyContext, omitSensitive, safeContact, jsonData }
