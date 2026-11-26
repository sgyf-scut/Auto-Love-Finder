// Contact-scoped self narrative: what the AI has already said about itself to
// this one contact. It never merges into Core Self and never loads for another
// contact. Entries are verbatim AI statements confirmed as sent.
const { createHash } = require('node:crypto')
const { contactKey, actualMessages } = require('./relationship-state.cjs')
const { redactPrivateData } = require('./disclosure-policy.cjs')
const list = value => Array.isArray(value) ? value : []
const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
function clock(now = Date.now()) { const at = now instanceof Date ? +now : typeof now === 'number' ? now : Date.parse(now); if (!Number.isFinite(at)) throw new TypeError('Self narrative now must be valid'); return at }
const privateProfile = value => value || { stableProfile: [], currentLife: [], privacyPreferences: [] }
const safe = (value, selfProfile) => redactPrivateData(value, privateProfile(selfProfile))
const snapshot = (row, key) => ({ id: row.id, contactId: key, role: 'me', text: row.text, at: row.at, source: row.source,
  status: 'sent', confirmedSent: true, provenance: 'ai_self_statement' })
// Only confirmed outgoing text authored by the AI itself is eligible evidence.
function selfStatementMessages(messages, contact = {}, { now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), at = clock(now)
  const eligible = list(messages).filter(row => row && row.contactId === key
    && (row.role || row.senderRole) === 'me'
    && ['platform_send_confirmed', 'virtual_delivery'].includes(row.source)
    && (row.confirmedSent === true || row.status === 'sent')
    && !/^(?:image|video|sticker|gif|audio|media)$/i.test(row.type || row.kind || row.messageType || '')
    && !/public.?profile|public.?feed|comment.?scrape|ocr|visual.?interpretation|private|self.?profile/i.test(row.source || '')
    && row.shareLevel !== 'PRIVATE' && row.private !== true && row.privacy !== 'PRIVATE')
  const original = new Map(eligible.map(row => [clean(row.id || row.messageId), row]))
  return actualMessages(eligible, contact).filter(row => date(row.at) && Date.parse(row.at) <= at + 300000
    && row.text && !row.quote && !/ocr|visual|media|interpretation|caption/i.test(row.textSource || ''))
    .map(row => ({ ...row, source: original.get(row.id)?.source, at: date(row.at), text: safe(row.text, selfProfile) }))
    .filter(row => row.text && !row.text.includes('[私密信息]'))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
function fingerprint(narrative) { return hash([narrative.contactId, narrative.id, narrative.key, narrative.statement, narrative.topics, narrative.sourceMessageIds]) }
function normalizedNarrative(item, key, { selfProfile } = {}) {
  if (!item || item.contactId !== key || item.sourceContactId !== key || item.provenance !== 'ai_self_statement'
    || !clean(item.key) || item.id !== `sn_${hash([key, item.key])}`
    || !date(item.createdAt) || !date(item.updatedAt) || item.status !== 'active'
    || item.fingerprint !== fingerprint(item)) return null
  const statement = safe(clean(item.statement, 200), selfProfile)
  if (!statement || statement.includes('[私密信息]')) return null
  return { id: item.id, contactId: key, sourceContactId: key, provenance: 'ai_self_statement', key: clean(item.key, 60),
    fingerprint: item.fingerprint, status: 'active', statement,
    topics: list(item.topics).map(value => safe(clean(value, 40), selfProfile)).filter(Boolean).slice(0, 6),
    sourceMessages: list(item.sourceMessages).map(row => ({ ...row })), sourceMessageIds: list(item.sourceMessageIds).map(value => clean(value)).filter(Boolean).slice(-24),
    createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
    lastRecalledAt: date(item.lastRecalledAt), recallCount: Number.isSafeInteger(item.recallCount) && item.recallCount > 0 ? item.recallCount : 0,
    recalledOutgoingMessageIds: [...new Set(list(item.recalledOutgoingMessageIds).map(value => clean(value)).filter(Boolean))].slice(-64) }
}
function normalizeSelfNarrative(contact = {}, { now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), at = new Date(clock(now)).toISOString()
  const saved = contact.selfNarrative?.contactId === key ? contact.selfNarrative : {}
  const ledger = new Map(list(contact.sharedMemoryLedger).map(row => [row.id || row.messageId, row]))
  const validLedger = new Map(selfStatementMessages([...ledger.values()], contact, { now, selfProfile }).map(row => [row.id, row]))
  const stillOwned = item => item.sourceMessages.every(row => !ledger.has(row.id) || validLedger.has(row.id)
    && validLedger.get(row.id).text === row.text && validLedger.get(row.id).at === row.at)
  return { version: 1, contactId: key, revision: Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0,
    narratives: [...new Map(list(saved.narratives).map(item => normalizedNarrative(item, key, { selfProfile })).filter(item => item && stillOwned(item)).map(item => [item.id, item])).values()].slice(-60),
    processedCandidateIds: [...new Set(list(saved.processedCandidateIds).map(value => clean(value)).filter(Boolean))].slice(-256),
    updatedAt: date(saved.updatedAt) || at }
}
// Same key overwrites in place: dedup and time-change both land on one entry.
function upsertSelfNarrative(store, candidate, { now = Date.now() } = {}) {
  const at = new Date(clock(now)).toISOString(), id = `sn_${hash([store.contactId, candidate.key])}`
  const prior = store.narratives.find(item => item.id === id)
  const narrative = { id, contactId: store.contactId, sourceContactId: store.contactId, provenance: 'ai_self_statement', key: candidate.key,
    statement: candidate.statement, topics: [...candidate.topics], sourceMessages: candidate.sourceMessages.map(row => ({ ...row })),
    sourceMessageIds: [...candidate.sourceMessageIds], createdAt: prior?.createdAt || at, updatedAt: at,
    lastRecalledAt: prior?.lastRecalledAt || null, recallCount: prior?.recallCount || 0,
    recalledOutgoingMessageIds: [...(prior?.recalledOutgoingMessageIds || [])], status: 'active' }
  narrative.fingerprint = fingerprint(narrative)
  store.narratives = store.narratives.filter(item => item.id !== id); store.narratives.push(narrative)
  return narrative
}
function markSelfNarrativeRecalled(contact, ids, { now = Date.now(), confirmedSent = false, outgoingMessageId, expectedRevision } = {}) {
  const store = normalizeSelfNarrative(contact, { now }); checkRevision(store, expectedRevision)
  const sentId = clean(outgoingMessageId), chosen = new Set(list(ids)); let changed = false
  if (!confirmedSent || !sentId) return store
  for (const narrative of store.narratives) if (chosen.has(narrative.id) && narrative.status === 'active' && !narrative.recalledOutgoingMessageIds.includes(sentId)) {
    narrative.recallCount++; narrative.lastRecalledAt = new Date(clock(now)).toISOString(); narrative.recalledOutgoingMessageIds.push(sentId)
    narrative.recalledOutgoingMessageIds = narrative.recalledOutgoingMessageIds.slice(-64); changed = true
  }
  if (changed) { store.revision++; store.updatedAt = new Date(clock(now)).toISOString() }
  return store
}
function markSelfNarrativeRecalled(contact, ids, { now = Date.now(), confirmedSent = false, outgoingMessageId } = {}) {
  const store = normalizeSelfNarrative(contact, { now })
  const sentId = clean(outgoingMessageId), chosen = new Set(list(ids)); let changed = false
  if (!confirmedSent || !sentId) return store
  for (const narrative of store.narratives) if (chosen.has(narrative.id) && narrative.status === 'active' && !narrative.recalledOutgoingMessageIds.includes(sentId)) {
    narrative.recallCount++; narrative.lastRecalledAt = new Date(clock(now)).toISOString(); narrative.recalledOutgoingMessageIds.push(sentId)
    narrative.recalledOutgoingMessageIds = narrative.recalledOutgoingMessageIds.slice(-64); changed = true
  }
  if (changed) { store.revision++; store.updatedAt = new Date(clock(now)).toISOString() }
  return store
}
module.exports = { normalizeSelfNarrative, normalizeSelfNarrativeStore: normalizeSelfNarrative, upsertSelfNarrative, markSelfNarrativeRecalled,
  selfStatementMessages, contactKey, hash, date, clock, safe }
