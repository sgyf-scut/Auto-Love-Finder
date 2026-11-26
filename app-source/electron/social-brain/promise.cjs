// Contact-scoped promises: commitments the AI made to this one contact, plus
// open loops the contact raised. They never merge into Core Self and never load
// for another contact. Every entry keeps its original confirmed evidence so a
// later real-world result can be traced back to the words that created it.
const { createHash } = require('node:crypto')
const { contactKey, actualMessages } = require('./relationship-state.cjs')
const { redactPrivateData } = require('./disclosure-policy.cjs')
const PROMISE_TYPES = Object.freeze(['OPEN_LOOP', 'AI_FOLLOWUP', 'HUMAN_ACTION', 'REAL_WORLD_PLAN'])
const PROMISE_STATUS = Object.freeze(['pending', 'done', 'cancelled'])
const list = value => Array.isArray(value) ? value : []
const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
function clock(now = Date.now()) { const at = now instanceof Date ? +now : typeof now === 'number' ? now : Date.parse(now); if (!Number.isFinite(at)) throw new TypeError('Promise now must be valid'); return at }
const privateProfile = value => value || { stableProfile: [], currentLife: [], privacyPreferences: [] }
const safe = (value, selfProfile) => redactPrivateData(value, privateProfile(selfProfile))
const snapshot = (row, key) => ({ id: row.id, contactId: key, role: row.role, text: row.text, at: row.at, source: row.source,
  ...(row.role === 'me' ? { status: 'sent', confirmedSent: true } : {}), provenance: 'promise_evidence' })
// Evidence for a promise is the real exchange: a confirmed AI send that made the
// commitment, or an observed contact message that opened the loop.
function promiseMessages(messages, contact = {}, { now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), at = clock(now)
  const eligible = list(messages).filter(row => row && row.contactId === key
    && ((row.role || row.senderRole) === 'contact' && ['platform_observed', 'virtual_delivery'].includes(row.source)
      || (row.role || row.senderRole) === 'me' && ['platform_send_confirmed', 'virtual_delivery'].includes(row.source) && (row.confirmedSent === true || row.status === 'sent'))
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
function fingerprint(promise) { return hash([promise.contactId, promise.id, promise.type, promise.key, promise.summary,
  promise.sourceMessageIds, promise.status, promise.resolution?.text || null]) }
function normalizedResolution(value, selfProfile) {
  if (!value || typeof value !== 'object') return null
  const text = safe(clean(value.text, 400), selfProfile)
  if (!text || text.includes('[私密信息]') || !date(value.at)) return null
  return { text, at: date(value.at), source: clean(value.source, 40) || 'human_writeback',
    fields: list(value.fields).map(field => ({ label: safe(clean(field?.label, 40), selfProfile), value: safe(clean(field?.value, 200), selfProfile) })).filter(field => field.label && field.value).slice(0, 8) }
}
function normalizedPromise(item, key, { selfProfile } = {}) {
  if (!item || item.contactId !== key || item.sourceContactId !== key || item.provenance !== 'ai_commitment'
    || !PROMISE_TYPES.includes(item.type) || !clean(item.key) || item.id !== `pm_${hash([key, item.key])}`
    || !date(item.createdAt) || !date(item.updatedAt) || !PROMISE_STATUS.includes(item.status)
    || item.fingerprint !== fingerprint(item)) return null
  const summary = safe(clean(item.summary, 300), selfProfile)
  if (!summary || summary.includes('[私密信息]')) return null
  return { id: item.id, contactId: key, sourceContactId: key, provenance: 'ai_commitment', type: item.type, key: clean(item.key, 80),
    fingerprint: item.fingerprint, status: item.status, summary,
    topics: list(item.topics).map(value => safe(clean(value, 40), selfProfile)).filter(Boolean).slice(0, 6),
    dueHint: safe(clean(item.dueHint, 40), selfProfile) || null,
    sourceMessages: list(item.sourceMessages).map(row => ({ ...row })), sourceMessageIds: list(item.sourceMessageIds).map(value => clean(value)).filter(Boolean).slice(-24),
    createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
    resolution: normalizedResolution(item.resolution, selfProfile), resolvedAt: date(item.resolvedAt), cancelledAt: date(item.cancelledAt),
    lastRecalledAt: date(item.lastRecalledAt), recallCount: Number.isSafeInteger(item.recallCount) && item.recallCount > 0 ? item.recallCount : 0,
    recalledOutgoingMessageIds: [...new Set(list(item.recalledOutgoingMessageIds).map(value => clean(value)).filter(Boolean))].slice(-64) }
}
function normalizePromises(contact = {}, { now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), at = new Date(clock(now)).toISOString()
  const saved = contact.promises?.contactId === key ? contact.promises : {}
  const ledger = new Map(list(contact.sharedMemoryLedger).map(row => [row.id || row.messageId, row]))
  const validLedger = new Map(promiseMessages([...ledger.values()], contact, { now, selfProfile }).map(row => [row.id, row]))
  const stillOwned = item => item.sourceMessages.every(row => !ledger.has(row.id) || validLedger.has(row.id)
    && validLedger.get(row.id).text === row.text && validLedger.get(row.id).at === row.at)
  return { version: 1, contactId: key, revision: Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0,
    items: [...new Map(list(saved.items).map(item => normalizedPromise(item, key, { selfProfile })).filter(item => item && stillOwned(item)).map(item => [item.id, item])).values()].slice(-80),
    processedCandidateIds: [...new Set(list(saved.processedCandidateIds).map(value => clean(value)).filter(Boolean))].slice(-256),
    updatedAt: date(saved.updatedAt) || at }
}
function checkRevision(store, expectedRevision) { if (expectedRevision !== undefined && store.revision !== expectedRevision) { const error = new Error('承诺列表已变化，请重新读取后处理'); error.code = 'PROMISE_STALE'; throw error } }
// Same key overwrites in place: repeated statements of one commitment land on a
// single entry and only the newest wording survives. A resolved promise stays
// resolved unless new evidence reopens it as a fresh pending promise.
function upsertPromise(store, candidate, { now = Date.now() } = {}) {
  const at = new Date(clock(now)).toISOString(), id = `pm_${hash([store.contactId, candidate.key])}`
  const prior = store.items.find(item => item.id === id)
  const keepResolution = prior?.status === 'done' && candidate.keepResolution === true
  const promise = { id, contactId: store.contactId, sourceContactId: store.contactId, provenance: 'ai_commitment', type: candidate.type,
    key: candidate.key, summary: candidate.summary, topics: [...candidate.topics], dueHint: candidate.dueHint || null,
    sourceMessages: candidate.sourceMessages.map(row => ({ ...row })), sourceMessageIds: [...candidate.sourceMessageIds],
    createdAt: prior?.createdAt || at, updatedAt: at, status: keepResolution ? 'done' : 'pending',
    resolution: keepResolution ? prior.resolution : null, resolvedAt: keepResolution ? prior.resolvedAt : null, cancelledAt: null,
    lastRecalledAt: prior?.lastRecalledAt || null, recallCount: prior?.recallCount || 0,
    recalledOutgoingMessageIds: [...(prior?.recalledOutgoingMessageIds || [])] }
  promise.fingerprint = fingerprint(promise)
  store.items = store.items.filter(item => item.id !== id); store.items.push(promise)
  return promise
}
function resolvePromise(contact, id, { text, fields = [], now = Date.now(), expectedRevision, selfProfile, source = 'human_writeback' } = {}) {
  const store = normalizePromises(contact, { now, selfProfile }); checkRevision(store, expectedRevision)
  const promise = store.items.find(item => item.id === id && item.status === 'pending')
  if (!promise) return store
  const at = new Date(clock(now)).toISOString()
  // A result that cannot survive redaction is never written: keeping the promise
  // pending is safer than persisting a raw secret or a fingerprint that would
  // drop the entry on the next normalization.
  const resolution = normalizedResolution({ text, fields, at, source }, selfProfile)
  if (!resolution) return store
  promise.status = 'done'; promise.resolvedAt = at; promise.updatedAt = at
  promise.resolution = resolution
  promise.fingerprint = fingerprint(promise)
  store.revision++; store.updatedAt = at
  return store
}
function cancelPromise(contact, id, { now = Date.now(), expectedRevision } = {}) {
  const store = normalizePromises(contact, { now }); checkRevision(store, expectedRevision)
  const promise = store.items.find(item => item.id === id && item.status === 'pending')
  if (!promise) return store
  const at = new Date(clock(now)).toISOString()
  promise.status = 'cancelled'; promise.cancelledAt = at; promise.updatedAt = at
  promise.fingerprint = fingerprint(promise)
  store.revision++; store.updatedAt = at
  return store
}
function reschedulePromise(contact, id, { dueHint, now = Date.now(), expectedRevision } = {}) {
  const store = normalizePromises(contact, { now }); checkRevision(store, expectedRevision)
  const promise = store.items.find(item => item.id === id && item.status === 'pending')
  if (!promise) return store
  const at = new Date(clock(now)).toISOString()
  promise.dueHint = clean(dueHint, 40) || null; promise.updatedAt = at
  promise.fingerprint = fingerprint(promise)
  store.revision++; store.updatedAt = at
  return store
}
function markPromiseRecalled(contact, ids, { now = Date.now(), confirmedSent = false, outgoingMessageId } = {}) {
  const store = normalizePromises(contact, { now })
  const sentId = clean(outgoingMessageId), chosen = new Set(list(ids)); let changed = false
  if (!confirmedSent || !sentId) return store
  for (const promise of store.items) if (chosen.has(promise.id) && promise.status === 'pending' && !promise.recalledOutgoingMessageIds.includes(sentId)) {
    promise.recallCount++; promise.lastRecalledAt = new Date(clock(now)).toISOString(); promise.recalledOutgoingMessageIds.push(sentId)
    promise.recalledOutgoingMessageIds = promise.recalledOutgoingMessageIds.slice(-64); changed = true
  }
  if (changed) { store.revision++; store.updatedAt = new Date(clock(now)).toISOString() }
  return store
}
module.exports = { PROMISE_TYPES, PROMISE_STATUS, normalizePromises, normalizePromiseStore: normalizePromises, upsertPromise,
  resolvePromise, cancelPromise, reschedulePromise, markPromiseRecalled, promiseMessages, checkRevision, contactKey, hash, date, clock, safe }
