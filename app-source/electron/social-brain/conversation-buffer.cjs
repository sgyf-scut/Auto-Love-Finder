// Incoming message aggregation only. The consumer owns planning, drafts and sending.
const DEFAULT_QUIET_WINDOW_MS = 4000
const DEFAULT_MAX_BURST_WINDOW_MS = 15000
const STATES = Object.freeze(['IDLE', 'COLLECTING', 'PLANNING', 'WRITING', 'READY_TO_SEND', 'SENDING', 'STALE'])
const GENERATION_STATES = new Set(['PLANNING', 'WRITING', 'READY_TO_SEND', 'SENDING'])

function boundedDuration(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Buffer duration must be a non-negative finite number')
  return value
}

// Retain media references and interpretation metadata, never copy image payloads.
function metadata(value, depth = 0, key = '') {
  if (depth > 7 || value === undefined || typeof value === 'function') return undefined
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value) || /^(?:data|base64|imageBase64|bytes|buffer)$/i.test(key)) return undefined
    return value.slice(0, /^(?:text|content|originalText)$/.test(key) ? 12000 : 4096)
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined
  if (Array.isArray(value)) return value.slice(0, 100).map(item => metadata(item, depth + 1, key)).filter(item => item !== undefined)
  if (typeof value !== 'object') return undefined
  const output = {}
  for (const [field, item] of Object.entries(value)) {
    if (/^(?:base64|imageBase64|bytes|buffer|frameData)$/i.test(field)) continue
    const copied = metadata(item, depth + 1, field)
    if (copied !== undefined) output[field] = copied
  }
  return output
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

class ConversationBuffer {
  constructor({ clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    onReady = () => {}, onStale = () => {}, quietWindowMs, maxBurstWindowMs, namespace = '' } = {}) {
    this.clock = typeof clock === 'function' ? clock : () => clock.now()
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.onReady = onReady
    this.onStale = onStale
    this.quietWindowMs = boundedDuration(quietWindowMs, DEFAULT_QUIET_WINDOW_MS)
    this.maxBurstWindowMs = boundedDuration(maxBurstWindowMs, DEFAULT_MAX_BURST_WINDOW_MS)
    this.namespace = String(namespace)
    this.contacts = new Map()
    this.paused = false
    this.disposed = false
    this.sequence = 0
  }

  _id(contactId) {
    if ((typeof contactId !== 'string' && typeof contactId !== 'number') || !String(contactId).trim()) throw new TypeError('A stable contactId is required')
    return String(contactId)
  }

  _entry(contactId) {
    const id = this._id(contactId)
    if (!this.contacts.has(id)) this.contacts.set(id, {
      contactId: id, messages: [], seen: new Set(), conversationRevision: 0,
      burstId: null, firstMessageAt: null, lastMessageAt: null, windowStartedAt: null,
      status: 'IDLE', timer: null, timerToken: 0, ready: false, readyAt: null, readyReason: null, lease: null
    })
    return this.contacts.get(id)
  }

  _copy(entry) {
    return {
      namespace: this.namespace, contactId: entry.contactId, burstId: entry.burstId,
      messages: entry.messages.map(message => metadata(message)), firstMessageAt: entry.firstMessageAt, lastMessageAt: entry.lastMessageAt,
      status: entry.status, conversationRevision: entry.conversationRevision, revision: entry.conversationRevision,
      ready: entry.ready, readyAt: entry.readyAt, readyReason: entry.readyReason
    }
  }

  snapshot(contactId) { return this._copy(this._entry(contactId)) }

  _clear(entry) {
    entry.timerToken += 1
    if (entry.timer !== null) this.clearTimer(entry.timer)
    entry.timer = null
  }

  _stale(entry) {
    const lease = entry.lease
    entry.lease = null
    if (lease) {
      entry.status = 'STALE'
      this.onStale(lease, this._copy(entry))
    }
  }

  _collect(entry, restartWindow = false) {
    this._clear(entry)
    entry.ready = false; entry.readyAt = null; entry.readyReason = null
    entry.status = entry.messages.length ? 'COLLECTING' : 'IDLE'
    if (restartWindow && entry.messages.length) {
      entry.windowStartedAt = this.clock()
      entry.burstId = `${this.namespace}:${entry.contactId}:${++this.sequence}`
    }
    if (!entry.messages.length || this.paused || this.disposed) return
    const quietAt = entry.lastMessageAt + this.quietWindowMs
    const maxAt = entry.windowStartedAt + this.maxBurstWindowMs
    const deadline = Math.min(quietAt, maxAt)
    const revision = entry.conversationRevision
    const timerToken = entry.timerToken
    entry.timer = this.setTimer(() => {
      if (entry.timerToken !== timerToken) return
      entry.timer = null
      if (this.paused || this.disposed || entry.conversationRevision !== revision || entry.ready || entry.lease) return
      entry.ready = true
      entry.readyAt = this.clock()
      entry.readyReason = maxAt <= quietAt ? 'max_window' : 'quiet_window'
      this.onReady(this._copy(entry))
    }, Math.max(0, deadline - this.clock()))
  }

  append(contactId, message) {
    if (this.disposed) throw new Error('ConversationBuffer is disposed')
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('An incoming message object is required')
    const messageId = String(message.messageId ?? message.id ?? '').trim()
    if (!messageId) throw new TypeError('An incoming messageId is required')
    if (message.type === 'event_followup' || message.kind === 'event_followup') throw new TypeError('Event follow-ups do not enter incoming buffers')
    const entry = this._entry(contactId)
    if (entry.seen.has(messageId)) return this._copy(entry)
    const wasGenerating = Boolean(entry.lease)
    const wasReady = entry.ready
    const now = this.clock()
    const copied = metadata(message)
    copied.messageId = messageId
    if (copied.timestamp === undefined) copied.timestamp = copied.at === undefined ? now : copied.at
    entry.messages.push(copied)
    entry.seen.add(messageId)
    entry.conversationRevision += 1
    if (entry.firstMessageAt === null) entry.firstMessageAt = now
    entry.lastMessageAt = now
    // Invalidate before notifying consumers. No model result can consume the newer revision.
    this._stale(entry)
    this._collect(entry, entry.windowStartedAt === null || wasGenerating || wasReady)
    return this._copy(entry)
  }

  startGeneration(contactId) {
    const entry = this._entry(contactId)
    if (this.paused || this.disposed || !entry.ready || entry.lease || !entry.messages.length) return null
    this._clear(entry)
    entry.status = 'PLANNING'
    const lease = freeze({ ...this._copy(entry), generationRevision: entry.conversationRevision,
      leaseId: `${entry.burstId}:generation:${++this.sequence}` })
    entry.lease = lease
    return lease
  }

  isFresh(lease) {
    if (!lease || this.paused || this.disposed || lease.namespace !== this.namespace) return false
    const entry = this.contacts.get(String(lease.contactId))
    return Boolean(entry && entry.lease === lease && entry.conversationRevision === lease.generationRevision)
  }

  setStage(lease, state) {
    if (!GENERATION_STATES.has(state)) throw new TypeError(`Invalid generation stage: ${state}`)
    if (!this.isFresh(lease)) return false
    this.contacts.get(lease.contactId).status = state
    return true
  }

  finish(lease) {
    if (!this.isFresh(lease)) return false
    const entry = this.contacts.get(lease.contactId)
    this._clear(entry)
    entry.lease = null
    entry.messages = []
    entry.firstMessageAt = null; entry.lastMessageAt = null; entry.windowStartedAt = null
    entry.status = 'IDLE'; entry.ready = false; entry.readyAt = null; entry.readyReason = null
    return true
  }

  invalidate(contactId) {
    const entry = this._entry(contactId)
    this._clear(entry)
    this._stale(entry)
    this._collect(entry, true)
    return this._copy(entry)
  }

  pause() {
    if (this.disposed) return
    this.paused = true
    for (const entry of this.contacts.values()) {
      this._clear(entry); this._stale(entry)
      entry.ready = false; entry.readyAt = null; entry.readyReason = null
      entry.status = entry.messages.length ? 'STALE' : 'IDLE'
    }
  }

  resume() {
    if (this.disposed) throw new Error('ConversationBuffer is disposed')
    if (!this.paused) return
    this.paused = false
    // Rebuild retained input, granting a fresh quiet window after resuming.
    for (const entry of this.contacts.values()) {
      if (entry.messages.length) entry.lastMessageAt = this.clock()
      this._collect(entry, true)
    }
  }

  hydrate(contactId, { messages = [], processedMessageIds = [], conversationRevision = 0 } = {}) {
    if (this.disposed) throw new Error('ConversationBuffer is disposed')
    const entry = this._entry(contactId)
    if (entry.messages.length || entry.lease) throw new Error('Cannot hydrate a live contact buffer')
    if (!Array.isArray(messages) || !Array.isArray(processedMessageIds)) throw new TypeError('Hydration requires message arrays')
    entry.conversationRevision = Math.max(entry.conversationRevision, Number.isSafeInteger(conversationRevision) && conversationRevision >= 0 ? conversationRevision : 0)
    for (const id of processedMessageIds) entry.seen.add(String(id))
    for (const message of messages) this.append(contactId, message)
    return this._copy(entry)
  }

  dispose() {
    if (this.disposed) return
    this.pause()
    this.disposed = true
  }
}

module.exports = { ConversationBuffer, STATES, DEFAULT_QUIET_WINDOW_MS, DEFAULT_MAX_BURST_WINDOW_MS }
