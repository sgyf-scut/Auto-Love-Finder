// Conversation Orchestrator owns this executor and its storage-aware handlers.
// Legacy receives only the frozen dispatch port; it never receives a store.
const CORE_EFFECT_PHASES = Object.freeze(['INBOUND_OBSERVED', 'REPLY_DECIDED', 'SEND_CONFIRMED'])
const REQUEST_KEYS = new Set(['phase', 'type', 'payload', 'traceId', 'accountId', 'contactId'])
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) }
function effectError(code, message) { return Object.assign(new Error(message), { code }) }

function readonlyData(value) {
  let nodes = 0
  const seen = new Set()
  function copy(item, depth) {
    if (++nodes > 50000 || depth > 40) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect data exceeds structural limits')
    if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || !Array.isArray(item) && !isRecord(item)) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect payload must contain plain JSON data')
    if (seen.has(item)) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect payload must not contain cycles')
    seen.add(item)
    const result = Array.isArray(item) ? [] : {}
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect payload contains an unsafe key')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect payload must contain data properties')
      if (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect payload must contain JSON arrays')
      result[key] = copy(descriptor.value, depth + 1)
    }
    if (Array.isArray(item) && Object.keys(result).length !== item.length) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect payload must not contain sparse arrays')
    seen.delete(item)
    return Object.freeze(result)
  }
  const result = copy(value, 0)
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect data exceeds the byte limit')
  return result
}

function createCoreEffectBoundary({ traceId, accountId, contactId, handlers = {}, isCurrent = () => true, onEffect = () => {}, confirmationProof } = {}) {
  const scope = { traceId, accountId, contactId }
  for (const [key, value] of Object.entries(scope)) if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Core Effect ${key} must be a nonempty string`)
  if (!isRecord(handlers)) throw new TypeError('Core Effect handlers must be an explicit handler registry')
  if (typeof isCurrent !== 'function' || typeof onEffect !== 'function') throw new TypeError('Core Effect observers and freshness checks must be functions')
  const registry = new Map()
  for (const [key, handler] of Object.entries(handlers)) {
    const separator = key.indexOf(':')
    if (!CORE_EFFECT_PHASES.includes(key.slice(0, separator)) || !/^[A-Z][A-Z0-9_]*$/.test(key.slice(separator + 1)) || typeof handler !== 'function') throw new TypeError(`Invalid Core Effect handler registration: ${key}`)
    registry.set(key, handler)
  }
  function observe(effect, status, code) {
    // Observability has no authority over the business operation. Never expose
    // payload, handler results, generated text, or arbitrary error messages.
    const diagnostic = Object.freeze({ ...scope, phase: effect.phase, type: effect.type, status, ...(code ? { code } : {}) })
    try { Promise.resolve(onEffect(diagnostic)).catch(() => {}) } catch { /* A diagnostic sink cannot veto or retry an effect. */ }
  }
  async function dispatch(request) {
    const data = readonlyData(request)
    if (!isRecord(data) || Object.keys(data).some(key => !REQUEST_KEYS.has(key))) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect request contains unsupported fields')
    if (!CORE_EFFECT_PHASES.includes(data.phase) || typeof data.type !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(data.type)) throw effectError('CHAT_EFFECT_INVALID', 'Core Effect phase or type is invalid')
    for (const key of Object.keys(scope)) if (Object.hasOwn(data, key) && data[key] !== scope[key]) throw effectError('CHAT_EFFECT_SCOPE_MISMATCH', `Core Effect cannot override ${key}`)
    const effect = Object.freeze({ ...scope, phase: data.phase, type: data.type, payload: Object.hasOwn(data, 'payload') ? data.payload : null })
    const handler = registry.get(`${effect.phase}:${effect.type}`)
    if (!handler) throw effectError('CHAT_EFFECT_UNREGISTERED', 'Core Effect has no registered external handler')
    try {
      if (effect.phase === 'SEND_CONFIRMED' && (!confirmationProof || typeof confirmationProof.valid !== 'function' || await confirmationProof.valid() !== true)) throw effectError('CHAT_EFFECT_SEND_UNCONFIRMED', 'SEND_CONFIRMED requires an external confirmed-send proof')
      // Check immediately before mutation. If cancellation happens after the
      // handler starts, the already-performed effect is not rolled back.
      if (await isCurrent() !== true) throw effectError('CHAT_EFFECT_STALE', 'Core Effect conversation is no longer current')
      const result = await handler(effect)
      const output = result === undefined ? undefined : readonlyData(result)
      observe(effect, 'completed')
      return output
    } catch (error) {
      observe(effect, 'failed', ['CHAT_EFFECT_STALE', 'CHAT_EFFECT_SEND_UNCONFIRMED'].includes(error?.code) ? error.code : 'CHAT_EFFECT_HANDLER_FAILED')
      throw error
    }
  }
  return Object.freeze({ dispatch })
}

module.exports = { CORE_EFFECT_PHASES, createCoreEffectBoundary }
