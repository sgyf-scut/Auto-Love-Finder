// Public V3 boundary. These are transport contracts, not new Planner actions.
const CHAT_ENGINE_ACTIONS = Object.freeze(['REPLY', 'NO_REPLY', 'HANDOFF'])
const DEFAULT_CHAT_ENGINE_CONFIG = Object.freeze({ primaryChatEngine: 'simple_v3', shadowChatEngine: null, shadowEnabled: false })
const CONTEXT_LIMITS = Object.freeze({ maxDepth: 40, maxNodes: 150000, maxBytes: 8 * 1024 * 1024, maxMetadataBytes: 1024 * 1024 })

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function requireRecord(value, path) {
  if (!isRecord(value)) throw new TypeError(`${path} must be a plain object`)
}

// Copy without invoking getters or retaining references/capabilities from a caller.
// JSON.stringify alone would silently discard functions and execute toJSON hooks.
function copyData(value, limits = CONTEXT_LIMITS) {
  const ancestors = new Set()
  let nodes = 0
  function visit(item, path, depth) {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new TypeError(`${path} exceeds the chat data limits`)
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object') throw new TypeError(`${path} must contain only JSON data`)
    if (!Array.isArray(item) && !isRecord(item)) throw new TypeError(`${path} must contain plain JSON data`)
    if (ancestors.has(item)) throw new TypeError(`${path} contains a cycle`)
    ancestors.add(item)
    const result = Array.isArray(item) ? [] : {}
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError(`${path} contains an unsafe key`)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${path}.${key} must be an enumerable data property`)
      if (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) throw new TypeError(`${path} must be a JSON array`)
      result[key] = visit(descriptor.value, `${path}.${key}`, depth + 1)
    }
    if (Array.isArray(item) && Object.keys(result).length !== item.length) throw new TypeError(`${path} must not be a sparse array`)
    ancestors.delete(item)
    return result
  }
  const result = visit(value, 'chatData', 0)
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxBytes) throw new TypeError('Chat data exceeds the byte limit')
  return result
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}
function validateChatContext(context) {
  const data = copyData(context)
  requireRecord(data, 'ChatContext')
  for (const key of ['traceId', 'accountId', 'contactId']) {
    if (typeof data[key] !== 'string' || !data[key].trim()) throw new TypeError(`ChatContext.${key} must be a nonempty string`)
  }
  for (const key of ['incomingMessages', 'recentMessages', 'contactFacts', 'selfFacts', 'sharedMemories', 'interactionNotes']) {
    if (!Array.isArray(data[key])) throw new TypeError(`ChatContext.${key} must be an array`)
  }
  for (const key of ['relationship', 'conversation', 'constraints', 'metadata']) requireRecord(data[key], `ChatContext.${key}`)
  if (!(data.conversation.summary === null || typeof data.conversation.summary === 'string')) throw new TypeError('ChatContext.conversation.summary must be a string or null')
  if (!Array.isArray(data.conversation.openLoops)) throw new TypeError('ChatContext.conversation.openLoops must be an array')
  for (const key of ['privacy', 'handoffTopics']) if (!Array.isArray(data.constraints[key])) throw new TypeError(`ChatContext.constraints.${key} must be an array`)
  if (Buffer.byteLength(JSON.stringify(data.metadata), 'utf8') > CONTEXT_LIMITS.maxMetadataBytes) throw new TypeError('ChatContext.metadata exceeds the byte limit')
  return data
}
function createReadonlyChatContext(context) { return deepFreeze(validateChatContext(context)) }

function validateChatEngineResult(result) {
  const data = copyData(result)
  requireRecord(data, 'ChatEngineResult')
  if (!CHAT_ENGINE_ACTIONS.includes(data.action)) throw new TypeError('ChatEngineResult.action must be REPLY, NO_REPLY or HANDOFF')
  if (!Array.isArray(data.messages) || data.messages.some(message => typeof message !== 'string' || !message.trim())) throw new TypeError('ChatEngineResult.messages must contain nonempty strings')
  if (typeof data.handoff !== 'boolean' || data.handoff !== (data.action === 'HANDOFF')) throw new TypeError('ChatEngineResult.handoff must agree with action')
  if (!(data.reason === null || typeof data.reason === 'string')) throw new TypeError('ChatEngineResult.reason must be a string or null')
  requireRecord(data.metadata, 'ChatEngineResult.metadata')
  const expression = data.metadata.expression
  if (data.action === 'REPLY') {
    const stickerOnly = expression?.mode === 'STICKER_ONLY' && typeof expression.stickerIntent === 'string' && expression.stickerIntent !== 'NONE' && expression.stickerIntent.length > 0
    if (!data.messages.length && !stickerOnly) throw new TypeError('REPLY must include text or a STICKER_ONLY expression')
    if (stickerOnly && data.messages.length) throw new TypeError('STICKER_ONLY must not include text')
  } else {
    if (data.messages.length) throw new TypeError(`${data.action} must not include sendable messages`)
    if (expression && ['STICKER_ONLY', 'TEXT_AND_STICKER'].includes(expression.mode)) throw new TypeError(`${data.action} must not include a sendable expression`)
  }
  return data
}
function normalizeChatEngineResult(result) {
  requireRecord(result, 'ChatEngineResult')
  result = copyData(result)
  return validateChatEngineResult({
    ...result,
    messages: result.messages === undefined ? [] : result.messages,
    handoff: result.handoff === undefined ? result.action === 'HANDOFF' : result.handoff,
    reason: result.reason === undefined ? null : result.reason,
    metadata: result.metadata === undefined ? {} : result.metadata,
  })
}

module.exports = { CHAT_ENGINE_ACTIONS, DEFAULT_CHAT_ENGINE_CONFIG, CONTEXT_LIMITS, validateChatContext, createReadonlyChatContext, validateChatEngineResult, normalizeChatEngineResult }
