// Shared history is separate from contact facts and from future-event reminders.
const { createHash } = require('node:crypto')
const { contactKey, actualMessages } = require('./relationship-state.cjs')
const { redactPrivateData } = require('./disclosure-policy.cjs')
const SHARED_MEMORY_TYPES = Object.freeze(['SHARED_MOMENT', 'INSIDE_JOKE', 'MUTUAL_DISCOVERY', 'EMOTIONAL_MOMENT', 'SUPPORT_MOMENT', 'CELEBRATION', 'CONFLICT_AND_REPAIR', 'PROMISE', 'CALLBACK_CHAIN', 'MILESTONE'])
const list = value => Array.isArray(value) ? value : []
const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
const clamp = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
function clock(now = Date.now()) { const at = now instanceof Date ? +now : typeof now === 'number' ? now : Date.parse(now); if (!Number.isFinite(at)) throw new TypeError('Shared memory now must be valid'); return at }
const day = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10)
const privateProfile = value => value || { stableProfile: [], currentLife: [], privacyPreferences: [] }
function safe(value, selfProfile) { return redactPrivateData(value, privateProfile(selfProfile)) }
const snapshot = (row, key) => ({ id: row.id, contactId: key, role: row.role, text: row.text, at: row.at, source: row.source,
  ...(row.role === 'me' ? { status: 'sent', confirmedSent: true } : {}), provenance: 'actual_text_exchange' })
function sharedMemoryMessages(messages, contact = {}, { now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), at = clock(now)
  const eligible = list(messages).filter(row => row && row.contactId === key
    && ((row.role || row.senderRole) === 'contact' && ['platform_observed', 'virtual_delivery'].includes(row.source)
      || (row.role || row.senderRole) === 'me' && ['platform_send_confirmed', 'virtual_delivery'].includes(row.source) && (row.confirmedSent === true || row.status === 'sent'))
    && !/^(?:image|video|sticker|gif|audio|media)$/i.test(row.type || row.kind || row.messageType || '')
    && !/public.?profile|public.?feed|comment.?scrape|ocr|visual.?interpretation|private|self.?profile/i.test(row.source || '')
    && row.shareLevel !== 'PRIVATE' && row.private !== true && row.privacy !== 'PRIVATE')
  const original = new Map(eligible.map(row => [clean(row.id || row.messageId), row]))
  return actualMessages(eligible, contact).filter(row => date(row.at) && Date.parse(row.at) <= at + 300000
    && row.text && !row.quote && !/ocr|visual|media|interpretation|caption/i.test(row.textSource || '')
    && !/他说|她说|我朋友|我同学|转发|引用|[“「『"]/.test(row.text))
    .map(row => ({ ...row, source: original.get(row.id)?.source, at: date(row.at), text: safe(row.text, selfProfile) }))
    .filter(row => !row.text.includes('[私密信息]')).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
function fingerprint(memory) { return hash([memory.contactId, memory.id, memory.type, memory.episodeKey, memory.summary, memory.topics,
  memory.participants, memory.strength, memory.importance, memory.emotion, memory.relationshipImpact, memory.trigger, memory.sourceMessages]) }
function normalizedMemory(item, key, { now, selfProfile } = {}) {
  if (!item || item.contactId !== key || item.sourceContactId !== key || item.provenance !== 'actual_bilateral_exchange'
    || !SHARED_MEMORY_TYPES.includes(item.type) || !clean(item.episodeKey) || item.id !== `shared_${hash([key, item.episodeKey])}`
    || !date(item.createdAt) || !date(item.updatedAt) || !['active', 'archived'].includes(item.status)
    || item.fingerprint !== fingerprint(item)) return null
  const sources = list(item.sourceMessages)
  const rows = sharedMemoryMessages(sources, { id: key }, { now, selfProfile })
  if (!rows.some(row => row.role === 'me') || !rows.some(row => row.role === 'contact') || rows.length !== sources.length) return null
  if (item.sourceMessageIds?.length !== rows.length || item.sourceMessageIds.some((id, index) => id !== rows[index]?.id)) return null
  const summary = safe(clean(item.summary, 650), selfProfile)
  if (!summary || summary.includes('[私密信息]')) return null
  return { id: item.id, contactId: key, sourceContactId: key, provenance: 'actual_bilateral_exchange', type: item.type, episodeKey: item.episodeKey,
    fingerprint: item.fingerprint, status: item.status, trigger: safe(clean(item.trigger, 100), selfProfile) || null,
    participants: ['self', 'contact'], summary, topics: list(item.topics).map(value => safe(clean(value, 60), selfProfile)).filter(Boolean).slice(0, 6),
    importance: clamp(item.importance), strength: clamp(item.strength), emotion: ['positive', 'mixed', 'negative', 'neutral'].includes(item.emotion) ? item.emotion : 'neutral',
    relationshipImpact: { familiarity: item.relationshipImpact?.familiarity === 'up' ? 'up' : 'neutral', warmth: item.relationshipImpact?.warmth === 'up' ? 'up' : 'neutral' },
    sourceMessages: rows.map(row => snapshot(row, key)), sourceMessageIds: rows.map(row => row.id), createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
    lastRecalledAt: date(item.lastRecalledAt), recallCount: Number.isSafeInteger(item.recallCount) && item.recallCount > 0 ? item.recallCount : 0,
    recalledOutgoingMessageIds: [...new Set(list(item.recalledOutgoingMessageIds).map(value => clean(value)).filter(Boolean))].slice(-64) }
}
function normalizeSharedMemory(contact = {}, { now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), at = new Date(clock(now)).toISOString(), saved = contact.sharedMemory?.contactId === key ? contact.sharedMemory : {}
  const tombstones = list(saved.tombstones).filter(item => item?.contactId === key && clean(item.id) && clean(item.episodeKey) && date(item.deletedAt))
    .map(item => ({ id: clean(item.id), contactId: key, episodeKey: clean(item.episodeKey), sourceMessageIds: list(item.sourceMessageIds).map(value => clean(value)).filter(Boolean).slice(0, 24), deletedAt: date(item.deletedAt) }))
  const blocked = new Set(tombstones.map(item => item.episodeKey))
  const ledger = new Map(list(contact.sharedMemoryLedger).map(row => [row.id || row.messageId, row]))
  const validLedger = new Map(sharedMemoryMessages([...ledger.values()], contact, { now, selfProfile }).map(row => [row.id, row]))
  const stillOwned = item => item.sourceMessages.every(row => !ledger.has(row.id) || validLedger.has(row.id)
    && validLedger.get(row.id).role === row.role && validLedger.get(row.id).text === row.text && validLedger.get(row.id).at === row.at)
  return { version: 1, contactId: key, revision: Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0,
    memories: [...new Map(list(saved.memories).map(item => normalizedMemory(item, key, { now, selfProfile })).filter(item => item && !blocked.has(item.episodeKey) && stillOwned(item)).map(item => [item.id, item])).values()].slice(-100),
    tombstones, processedCandidateIds: [...new Set(list(saved.processedCandidateIds).map(value => clean(value)).filter(Boolean))].slice(-256), updatedAt: date(saved.updatedAt) || at }
}
function checkRevision(store, expectedRevision) { if (expectedRevision !== undefined && store.revision !== expectedRevision) { const error = new Error('共同记忆已变化，请重新读取后处理'); error.code = 'SHARED_MEMORY_STALE'; throw error } }
// Candidates are immutable products of the local provenance checker. Model output
// selects these objects; it cannot invent a new summary or participants.
const verifiedCandidates = new WeakSet()
function certifyCandidate(candidate) {
  const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } }
  freeze(candidate); verifiedCandidates.add(candidate); return candidate
}
function applySharedMemoryOperations(contact, operations, { candidates = [], now = Date.now(), expectedRevision, selfProfile } = {}) {
  const store = normalizeSharedMemory(contact, { now, selfProfile }); checkRevision(store, expectedRevision)
  const known = new Map(candidates.filter(item => verifiedCandidates.has(item) && item.contactId === store.contactId).map(item => [item.id, item]))
  const blocked = new Set(store.tombstones.map(item => item.episodeKey)), at = new Date(clock(now)).toISOString()
  let changed = false
  for (const operation of list(operations).slice(0, 8)) {
    if (operation?.action === 'NO_MEMORY') continue
    if (!['CREATE', 'UPDATE', 'MERGE'].includes(operation?.action)) throw new Error('共同记忆操作无效')
    const candidate = known.get(operation.candidateId)
    if (!candidate) throw new Error('共同记忆引用了未知或其他联系人的候选')
    if (blocked.has(candidate.episodeKey) || store.processedCandidateIds.includes(candidate.id)) continue
    const prior = store.memories.find(item => item.episodeKey === candidate.episodeKey)
    if (operation.action === 'UPDATE' && (!prior || operation.memoryId !== prior.id)) throw new Error('共同记忆更新目标与当前经历不一致')
    if (operation.action === 'MERGE') {
      const mergeIds = [...new Set(list(operation.memoryIds))]
      if (!mergeIds.length || mergeIds.some(id => !list(candidate.mergeableMemoryIds).includes(id) || !store.memories.some(item => item.id === id))) throw new Error('不能合并不同参与关系或不同事件的共同记忆')
      for (const former of store.memories.filter(item => mergeIds.includes(item.id) && item.episodeKey !== candidate.episodeKey)) {
        store.tombstones.push({ id: former.id, contactId: store.contactId, episodeKey: former.episodeKey, sourceMessageIds: [...former.sourceMessageIds], deletedAt: at })
        blocked.add(former.episodeKey)
      }
      store.memories = store.memories.filter(item => !mergeIds.includes(item.id))
    }
    const memory = { id: `shared_${hash([store.contactId, candidate.episodeKey])}`, contactId: store.contactId, sourceContactId: store.contactId,
      provenance: 'actual_bilateral_exchange', type: candidate.type, episodeKey: candidate.episodeKey, summary: candidate.summary,
      participants: ['self', 'contact'], topics: [...candidate.topics], emotion: candidate.emotion, importance: candidate.importance,
      strength: candidate.strength, relationshipImpact: { ...candidate.relationshipImpact }, trigger: candidate.trigger || null,
      sourceMessages: candidate.sourceMessages.map(row => ({ ...row })), sourceMessageIds: [...candidate.sourceMessageIds],
      createdAt: prior?.createdAt || at, updatedAt: at, lastRecalledAt: prior?.lastRecalledAt || null, recallCount: prior?.recallCount || 0,
      recalledOutgoingMessageIds: [...(prior?.recalledOutgoingMessageIds || [])], status: 'active' }
    memory.fingerprint = fingerprint(memory)
    store.memories = store.memories.filter(item => item.id !== memory.id); store.memories.push(memory)
    store.processedCandidateIds.push(candidate.id); changed = true
  }
  // An explicit no-memory decision also consumes this exact checked batch.
  // New evidence gets a different candidate ID and can be considered later.
  for (const candidate of known.values()) if (!blocked.has(candidate.episodeKey) && !store.processedCandidateIds.includes(candidate.id)) { store.processedCandidateIds.push(candidate.id); changed = true }
  if (changed) { store.revision++; store.updatedAt = at; store.memories = store.memories.slice(-100); store.processedCandidateIds = [...new Set(store.processedCandidateIds)].slice(-256) }
  return store
}
function deleteSharedMemory(contact, id, { now = Date.now(), expectedRevision } = {}) {
  const store = normalizeSharedMemory(contact, { now }); checkRevision(store, expectedRevision)
  const memory = store.memories.find(item => item.id === id)
  if (!memory) return store
  const at = new Date(clock(now)).toISOString()
  store.tombstones.push({ id: memory.id, contactId: store.contactId, episodeKey: memory.episodeKey, sourceMessageIds: [...memory.sourceMessageIds], deletedAt: at })
  store.memories = store.memories.filter(item => item.id !== id); store.revision++; store.updatedAt = at
  return store
}
function markSharedMemoryRecalled(contact, ids, { now = Date.now(), confirmedSent = false, outgoingMessageId, expectedRevision } = {}) {
  const store = normalizeSharedMemory(contact, { now }); checkRevision(store, expectedRevision)
  const sentId = clean(outgoingMessageId), chosen = new Set(list(ids)); let changed = false
  if (!confirmedSent || !sentId) return store
  for (const memory of store.memories) if (chosen.has(memory.id) && memory.status === 'active' && !memory.recalledOutgoingMessageIds.includes(sentId)) {
    memory.recallCount++; memory.lastRecalledAt = new Date(clock(now)).toISOString(); memory.recalledOutgoingMessageIds.push(sentId); memory.recalledOutgoingMessageIds = memory.recalledOutgoingMessageIds.slice(-64); changed = true
  }
  if (changed) { store.revision++; store.updatedAt = new Date(clock(now)).toISOString() }
  return store
}
module.exports = { SHARED_MEMORY_TYPES, normalizeSharedMemory, normalizeSharedMemoryStore: normalizeSharedMemory, applySharedMemoryOperations, deleteSharedMemory,
  markSharedMemoryRecalled, sharedMemoryMessages, certifyCandidate, contactKey, hash, date, clock, day, safe }
