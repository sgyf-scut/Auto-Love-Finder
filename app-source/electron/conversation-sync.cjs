const { createHash } = require('node:crypto')

const RECONCILE_INTERVAL_MS = 10 * 60 * 1000
const RETRY_DELAYS_MS = [10000, 30000, 90000]
const MAX_ACCOUNTS = 20, MAX_RECORDS = 500, MAX_PENDING = 500
const STATUSES = new Set(['WAITING_CONVERSATION', 'DISCOVERED', 'IDENTITY_VERIFIED', 'READY', 'TEMP_UNAVAILABLE', 'IDENTITY_PENDING', 'NEEDS_REVIEW'])
const clean = (value, limit = 160) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const id = value => clean(value, 256)
const platformId = value => /^[A-Za-z0-9_-]{1,256}$/.test(id(value)) ? id(value) : ''
const hash = value => createHash('sha256').update(value).digest('hex')
const timestamp = (value, fallback = 0) => {
  const n = value instanceof Date ? value.getTime() : typeof value === 'string' && !/^\d+$/.test(value) ? Date.parse(value) : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const unique = values => [...new Set(values.filter(Boolean))]
const list = value => Array.isArray(value) ? value : []
const clone = value => structuredClone(value)

const MAX_EVIDENCE = 512
const exactLedger = value => unique(list(value).filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))).slice(-MAX_EVIDENCE)
function remember(owner, key) {
  const digest = hash(key), keys = exactLedger(owner.eventLedger)
  if (keys.includes(digest)) return false
  owner.eventLedger = [...keys, digest].slice(-MAX_EVIDENCE)
  return true
}
function rememberIncoming(record, key, eventAt, now) {
  const digest = hash(String(key)), at = eventAt === undefined ? 0 : timestamp(eventAt)
  if (record.incomingEvents.some(event => event.key === digest)) return false
  // Once the exact history fills, only a genuinely newer dated observation can
  // advance its watermark. Undated hints cannot recycle an evicted old message.
  if (record.incomingEvents.length >= MAX_EVIDENCE && (!at || at <= record.lastIncomingAt)) return false
  if (at > now) return false
  record.incomingEvents = [...record.incomingEvents, { key: digest, at }].slice(-MAX_EVIDENCE)
  record.lastIncomingAt = Math.max(record.lastIncomingAt, at)
  return true
}
function normalizeRecord(value, accountId) {
  if (!value || typeof value !== 'object' || !id(value.contactId) || (value.accountId && id(value.accountId) !== accountId)) return null
  const verified = value.identityVerified === true && Boolean(platformId(value.platformUserId))
  const attempts = Math.min(4, Math.max(0, Math.floor(Number(value.attempts) || 0)))
  let status = STATUSES.has(value.status) ? value.status : 'WAITING_CONVERSATION'
  if (['READY', 'IDENTITY_VERIFIED'].includes(status) && !verified) status = 'IDENTITY_PENDING'
  if (attempts >= 4 && status !== 'IDENTITY_PENDING') status = 'NEEDS_REVIEW'
  return {
    accountId, contactId: id(value.contactId), contactIds: unique([id(value.contactId), ...list(value.contactIds).map(id)]).slice(0, 50),
    name: clean(value.name), aliases: unique(list(value.aliases).map(name => clean(name))).slice(-20),
    platformUserId: verified ? platformId(value.platformUserId) : '', expectedPlatformUserId: platformId(value.expectedPlatformUserId || (!verified && value.platformUserId)),
    identityVerified: verified, identityConflict: clean(value.identityConflict), status, reason: clean(value.reason), attempts,
    nextRetryAt: attempts >= 4 ? 0 : timestamp(value.nextRetryAt), lastObservedAt: timestamp(value.lastObservedAt), lastVerifiedAt: verified ? timestamp(value.lastVerifiedAt) : 0,
    evidenceVersion: Math.max(0, Math.floor(Number(value.evidenceVersion) || 0)), updatedAt: timestamp(value.updatedAt),
    eventLedger: exactLedger(value.eventLedger), lastFailureEvidence: clean(value.lastFailureEvidence, 64),
    incomingEvents: list(value.incomingEvents).filter(event => event && /^[a-f0-9]{64}$/.test(event.key)).map(event => ({ key: event.key, at: timestamp(event.at) })).slice(-MAX_EVIDENCE),
    lastIncomingAt: timestamp(value.lastIncomingAt),
  }
}
function newAccount(accountId, now) {
  return { accountId, records: [], pending: [], lastSyncedAt: 0, lastReconciledAt: 0, nextReconcileAt: now + RECONCILE_INTERVAL_MS, updatedAt: now, eventLedger: [] }
}
function normalizeConversationSync(value, options = {}) {
  const now = timestamp(options.now, Date.now()), source = value && typeof value === 'object' ? value : {}
  const accounts = [], seen = new Set()
  // A legacy unscoped value must never be copied into the currently active account.
  const savedAccounts = Array.isArray(source.accounts) ? source.accounts : source.accountId ? [source] : []
  for (const saved of savedAccounts) {
    const accountId = id(saved?.accountId)
    if (!accountId || seen.has(accountId)) continue
    seen.add(accountId)
    const records = list(saved.records).map(record => normalizeRecord(record, accountId)).filter(Boolean).slice(-MAX_RECORDS)
    const recordIds = new Set()
    const distinctRecords = records.filter(record => !recordIds.has(record.contactId) && recordIds.add(record.contactId))
    const pendingIds = new Set()
    const pending = list(saved.pending).filter(event => event && typeof event === 'object' && clean(event.reason)).map(event => ({
      id: clean(event.id, 64) || hash(JSON.stringify([accountId, event.contactId, event.platformUserId, event.reason, event.eventKey])),
      reason: clean(event.reason), contactId: id(event.contactId), name: clean(event.name), platformUserId: platformId(event.platformUserId),
      eventKey: clean(event.eventKey, 64), requestedAt: timestamp(event.requestedAt), reconcileAfter: timestamp(event.reconcileAfter),
    })).filter(event => !pendingIds.has(event.id) && pendingIds.add(event.id)).slice(-MAX_PENDING)
    accounts.push({ accountId, records: distinctRecords, pending, lastSyncedAt: timestamp(saved.lastSyncedAt), lastReconciledAt: timestamp(saved.lastReconciledAt),
      nextReconcileAt: timestamp(saved.nextReconcileAt, now + RECONCILE_INTERVAL_MS) || now + RECONCILE_INTERVAL_MS,
      updatedAt: timestamp(saved.updatedAt), eventLedger: exactLedger(saved.eventLedger) })
  }
  return { version: 1, accounts: accounts.slice(-MAX_ACCOUNTS) }
}

class ConversationSyncManager {
  constructor({ storage, accountId, clock = () => new Date() } = {}) {
    if (!storage?.get || !storage?.update) throw new TypeError('Conversation sync requires storage.get/update')
    if (!id(accountId)) throw new TypeError('Conversation sync requires an accountId')
    this.storage = storage; this.accountId = id(accountId); this.clock = clock; this.destroyed = false
    this._change(() => {})
  }
  _now(value) { return timestamp(value === undefined ? this.clock() : value, Date.now()) }
  _change(action, value) {
    if (this.destroyed) throw new Error('Conversation sync manager is destroyed')
    const now = this._now(value), saved = this.storage.get().conversationSync
    const root = normalizeConversationSync(saved, { now })
    let account = root.accounts.find(item => item.accountId === this.accountId)
    if (!account) { account = newAccount(this.accountId, now); root.accounts.push(account) }
    const before = JSON.stringify(root)
    const result = action(account, now)
    account.records = account.records.slice(-MAX_RECORDS); account.pending = account.pending.slice(-MAX_PENDING)
    if (before !== JSON.stringify(root)) account.updatedAt = now
    root.accounts = root.accounts.slice(-MAX_ACCOUNTS)
    if (JSON.stringify(saved) !== JSON.stringify(root)) this.storage.update({ conversationSync: root })
    return result === undefined ? clone(account) : clone(result)
  }
  state() {
    const now = this._now()
    return clone(normalizeConversationSync(this.storage.get().conversationSync, { now }).accounts.find(item => item.accountId === this.accountId) || newAccount(this.accountId, now))
  }
  _record(account, contactId) { return account.records.find(record => record.contactIds.includes(id(contactId))) || null }
  getRecord(contactId) { return this._record(this.state(), contactId) }
  _ensure(account, contactId, name, now) {
    let record = this._record(account, contactId)
    if (!record && id(contactId)) {
      record = normalizeRecord({ contactId: id(contactId), name: clean(name), updatedAt: now }, this.accountId)
      account.records.push(record)
    }
    return record
  }
  _name(record, name) {
    if (!clean(name)) return
    record.aliases = unique([...record.aliases, record.name, clean(name)]).slice(-20)
    record.name = clean(name)
  }
  _queue(account, event, now) {
    const contactId = this._record(account, event.contactId)?.contactId || id(event.contactId)
    const key = hash(JSON.stringify([this.accountId, contactId, platformId(event.platformUserId), clean(event.reason), event.eventKey || '']))
    if (account.pending.some(item => item.id === key)) return
    account.pending.push({ id: key, reason: clean(event.reason) || 'contact_changed', contactId, name: clean(event.name), platformUserId: platformId(event.platformUserId),
      eventKey: event.eventKey ? hash(String(event.eventKey)) : '', requestedAt: now, reconcileAfter: 0 })
  }
  _newEvidence(record, now) {
    record.attempts = 0; record.nextRetryAt = 0; record.lastFailureEvidence = ''; record.evidenceVersion++; record.updatedAt = now
    if (!record.identityConflict) { record.status = record.identityVerified ? 'IDENTITY_VERIFIED' : 'WAITING_CONVERSATION'; record.reason = 'new_evidence' }
  }
  request({ reason = 'contact_changed', contactId, name, platformUserId: expectedId, eventKey, eventAt } = {}) {
    return this._change((account, now) => {
      const record = this._ensure(account, contactId, name, now)
      const event = { reason, contactId: record?.contactId || '', name: name || record?.name, platformUserId: expectedId, eventKey }
      const key = eventKey ? JSON.stringify([reason, record?.contactId || '', platformId(expectedId), String(eventKey)]) : ''
      if (reason === 'new_incoming' && record && eventKey) {
        if (!rememberIncoming(record, eventKey, eventAt, now)) return record
        this._newEvidence(record, now)
      } else if (key && !remember(account, key)) return record
      if (record) {
        if (expectedId && !record.expectedPlatformUserId) record.expectedPlatformUserId = platformId(expectedId)
        if (!record.reason) record.reason = clean(reason)
        record.updatedAt = now
      }
      this._queue(account, event, now)
      return record
    })
  }
  _bind(account, input, now) {
    const record = this._ensure(account, input.contactId, input.name, now), verifiedId = platformId(input.platformUserId)
    if (!record || input.verified !== true || !verifiedId || !clean(input.source)) return record
    if ((record.platformUserId && record.platformUserId !== verifiedId) || (record.expectedPlatformUserId && record.expectedPlatformUserId !== verifiedId)) {
      record.identityConflict = 'platform_identity_conflict'; record.status = 'IDENTITY_PENDING'; record.reason = record.identityConflict; record.updatedAt = now
      return record
    }
    const existing = account.records.find(item => item !== record && item.identityVerified && item.platformUserId === verifiedId)
    let target = record
    if (existing) {
      existing.contactIds = unique([...existing.contactIds, ...record.contactIds]).slice(0, 50)
      existing.aliases = unique([...existing.aliases, existing.name, ...record.aliases, record.name]).slice(-20)
      existing.eventLedger = exactLedger([...existing.eventLedger, ...record.eventLedger])
      existing.incomingEvents = [...new Map([...existing.incomingEvents, ...record.incomingEvents].map(event => [event.key, event])).values()].sort((a, b) => a.at - b.at).slice(-MAX_EVIDENCE)
      existing.lastIncomingAt = Math.max(existing.lastIncomingAt, record.lastIncomingAt)
      for (const event of account.pending) if (record.contactIds.includes(event.contactId)) event.contactId = existing.contactId
      account.records = account.records.filter(item => item !== record)
      target = existing
    }
    const freshIdentity = !target.identityVerified
    this._name(target, input.name)
    target.identityVerified = true; target.platformUserId = verifiedId; target.expectedPlatformUserId = verifiedId
    target.lastVerifiedAt = now; target.updatedAt = now
    if (freshIdentity) this._newEvidence(target, now)
    // Binding the same ID in every snapshot preserves READY and retry backoff.
    for (const event of account.pending) if (!event.contactId && event.platformUserId === verifiedId) event.contactId = target.contactId
    return target
  }
  _collisions(account, now) {
    for (const record of account.records) {
      if (record.identityConflict === 'same_name_different_id') {
        record.identityConflict = ''; record.reason = 'identity_pending'; record.status = record.attempts >= 4 ? 'NEEDS_REVIEW' : record.identityVerified ? 'IDENTITY_VERIFIED' : 'DISCOVERED'
      }
    }
    for (const record of account.records) {
      const pid = record.platformUserId || record.expectedPlatformUserId
      if (!record.name || !pid) continue
      if (account.records.some(other => other !== record && other.name === record.name && (other.platformUserId || other.expectedPlatformUserId) && (other.platformUserId || other.expectedPlatformUserId) !== pid)) {
        if (record.identityConflict && record.identityConflict !== 'same_name_different_id') continue
        record.identityConflict = 'same_name_different_id'; record.status = 'IDENTITY_PENDING'; record.reason = record.identityConflict; record.updatedAt = now
      }
    }
  }
  bind(input = {}) { return this._change((account, now) => { const record = this._bind(account, input, now); this._collisions(account, now); return record }) }
  observe(contacts, { now, complete = false } = {}) {
    return this._change((account, at) => {
      for (const contact of list(contacts)) {
        if (!contact || (contact.accountId && id(contact.accountId) !== this.accountId)) continue
        const contactId = id(contact.id || contact.contactId)
        if (!contactId) continue
        const existed = this._record(account, contactId)
        let record = this._ensure(account, contactId, contact.name, at)
        this._name(record, contact.name); record.lastObservedAt = at; record.updatedAt = at
        const profile = contact.profile || {}, observedId = platformId(profile.platformUserId || contact.platformUserId)
        const profileId = profile.dmIdentityVerified === true || profile.identityVerified === true ? platformId(profile.platformUserId) : ''
        const directId = contact.identityVerified === true ? platformId(contact.platformUserId) : ''
        const proof = Boolean(profileId || directId)
        if (proof) {
          record = this._bind(account, { contactId, name: contact.name, platformUserId: profileId || directId, verified: true, source: 'verified_contact' }, at)
          if (profileId && directId && profileId !== directId) record = this._bind(account, { contactId, name: contact.name, platformUserId: directId, verified: true, source: 'verified_contact' }, at)
        }
        else if (record.status === 'WAITING_CONVERSATION') { record.status = observedId ? 'IDENTITY_PENDING' : 'DISCOVERED'; record.reason = 'identity_unverified' }
        if (!existed && proof) this._queue(account, { reason: 'contact_discovered', contactId: record.contactId, name: record.name }, at)
      }
      this._collisions(account, at)
      account.lastSyncedAt = at
      if (complete) this._complete(account, at)
    }, now)
  }
  canAttempt(contactId) {
    if (this.destroyed) return false
    const record = this.getRecord(contactId)
    return Boolean(record && !record.identityConflict && record.attempts < 4 && record.status !== 'NEEDS_REVIEW' && record.nextRetryAt <= this._now())
  }
  due({ idle = true, manualVisible = false } = {}) {
    if (this.destroyed || !idle || manualVisible) return { targets: [], events: [], reconcile: false }
    const account = this.state(), now = this._now(), targetIds = new Set(account.pending.map(event => event.contactId).filter(Boolean))
    const priority = record => Math.min(...account.pending.filter(event => event.contactId === record.contactId).map(event => event.reason === 'contact_discovered' ? 2 : event.reason === 'retry' ? 1 : 0))
    const targets = account.records.filter(record => targetIds.has(record.contactId) && this.canAttempt(record.contactId)).sort((a, b) => priority(a) - priority(b)).slice(0, 4)
    const events = account.pending.filter(event => event.contactId ? targets.some(record => record.contactId === event.contactId) : event.reconcileAfter <= now)
    return { targets, events, reconcile: account.nextReconcileAt <= now || events.some(event => !event.contactId) }
  }
  failure(contactId, { reason = 'conversation_unavailable', evidenceKey } = {}) {
    return this._change((account, now) => {
      const record = this._record(account, contactId)
      if (!record || record.attempts >= 4 || record.identityConflict || record.nextRetryAt > now) return record
      const key = evidenceKey ? hash(String(evidenceKey)) : ''
      if (key && !remember(record, `failure:${key}`)) return record
      record.lastFailureEvidence = key; record.attempts++; record.reason = clean(reason); record.updatedAt = now
      record.status = record.attempts >= 4 ? 'NEEDS_REVIEW' : 'TEMP_UNAVAILABLE'
      record.nextRetryAt = record.attempts >= 4 ? 0 : now + RETRY_DELAYS_MS[record.attempts - 1]
      this._queue(account, { reason: 'retry', contactId: record.contactId, name: record.name }, now)
      return record
    })
  }
  defer(contactId, reason = 'manual_window_visible') {
    return this._change((account, now) => {
      const record = this._record(account, contactId)
      if (record) {
        if (!record.identityConflict) record.reason = clean(reason)
        if (reason === 'identity_unknown' && !record.attempts) record.nextRetryAt = now + RECONCILE_INTERVAL_MS
        record.updatedAt = now
      }
      return record
    })
  }
  markReady(contactId) {
    return this._change((account, now) => {
      const record = this._record(account, contactId)
      if (!record || !record.identityVerified || !record.platformUserId || record.identityConflict || record.attempts >= 4 || record.nextRetryAt > now) return record
      record.status = 'READY'; record.reason = 'identity_verified'; record.nextRetryAt = 0; record.updatedAt = now
      account.pending = account.pending.filter(event => !record.contactIds.includes(event.contactId))
      return record
    })
  }
  // The caller invokes this only after a real, successful pane identity check.
  // Passive snapshots and scheduling hints use bind/markReady instead.
  success(contactId, { manualVerified = false, verifiedPlatformUserId } = {}) {
    return this._change((account, now) => {
      const record = this._record(account, contactId)
      if (!record || !record.identityVerified || !record.platformUserId || record.identityConflict) return record
      const manualProof = manualVerified === true && platformId(verifiedPlatformUserId) === record.platformUserId
      if ((record.attempts >= 4 || record.nextRetryAt > now) && !manualProof) return record
      if (manualVerified && !manualProof) return record
      record.attempts = 0; record.nextRetryAt = 0; record.lastFailureEvidence = ''; record.status = 'READY'; record.reason = 'identity_verified'
      record.lastVerifiedAt = now; record.updatedAt = now
      account.pending = account.pending.filter(event => !record.contactIds.includes(event.contactId))
      return record
    })
  }
  _complete(account, now) {
    account.lastReconciledAt = now; account.nextReconcileAt = now + RECONCILE_INTERVAL_MS
    account.pending = account.pending.filter(event => event.contactId || event.platformUserId)
    for (const event of account.pending) if (!event.contactId) event.reconcileAfter = account.nextReconcileAt
  }
  completeReconcile() { return this._change((account, now) => this._complete(account, now)) }
  resetForReconnect() {
    return this._change((account, now) => {
      this._queue(account, { reason: 'reconnect' }, now)
      for (const record of account.records) this._queue(account, { reason: 'reconnect', contactId: record.contactId, name: record.name }, now)
    })
  }
  destroy() { this.destroyed = true }
}

module.exports = { ConversationSyncManager, normalizeConversationSync, RECONCILE_INTERVAL_MS, RETRY_DELAYS_MS }
