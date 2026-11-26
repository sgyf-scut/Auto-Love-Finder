// SIMPLE_V3_CHAT: model text -> public ChatEngineResult payload.
// Pure function. Never sends, mutates or authorizes disclosure.
const { DEFAULT_SIMPLE_V3_CONFIG } = require('./config.cjs')

const VALID_ACTIONS = Object.freeze(['REPLY', 'NO_REPLY', 'HANDOFF'])
const NO_REPLY_MARKER = /^(?:\[?不回复\]?|不需要回复|无需回复|不回|no_reply|no reply)$/i

function stripFence(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*/gi, '')
    .trim()
}

function extractJsonObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)) } catch { return null }
      }
    }
  }
  return null
}

function cleanMessage(value, maxChars) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  let text = String(value)
    .replace(/^【\s*AI\s*[·•\-:][^】]*】\s*/i, '')
    .replace(/^\[\s*AI\s*[·•\-:][^\]]*\]\s*/i, '')
    .replace(/^\s*(?:回复|答复|assistant|AI)\s*[:：]\s*/i, '')
    .replace(/^[\s"'“”‘’`]+/, '')
    .replace(/[\s"'“”‘’`]+$/, '')
    .trim()
  if (maxChars > 0) text = text.slice(0, maxChars)
  return text
}

function normalizeMessages(value, maxMessages, maxChars) {
  const list = Array.isArray(value) ? value : (value === null || value === undefined || value === '' ? [] : [value])
  const seen = []
  for (const item of list) {
    const text = cleanMessage(item, maxChars)
    if (!text) continue
    if (seen.at(-1) === text) continue
    seen.push(text)
    if (seen.length >= maxMessages) break
  }
  return seen
}

function parseSimpleV3Output(raw, options = {}) {
  const maxMessages = Math.max(1, Number(options.maxMessages) || DEFAULT_SIMPLE_V3_CONFIG.maxMessages)
  const maxChars = Number(options.maxMessageChars) || DEFAULT_SIMPLE_V3_CONFIG.maxMessageChars
  const text = stripFence(raw)
  if (!text) return { action: 'NO_REPLY', messages: [], handoff: false, reason: null }

  const parsed = extractJsonObject(text)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rawAction = typeof parsed.action === 'string' ? parsed.action.trim().toUpperCase() : ''
    const messages = normalizeMessages(parsed.messages, maxMessages, maxChars)
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 60) : null
    // An explicit handoff wins over a mislabelled action; messages are dropped.
    if (parsed.handoff === true || rawAction === 'HANDOFF') {
      return { action: 'HANDOFF', messages: [], handoff: true, reason: reason || 'HANDOFF' }
    }
    if (rawAction === 'NO_REPLY') return { action: 'NO_REPLY', messages: [], handoff: false, reason }
    if (rawAction === 'REPLY' || !rawAction) {
      if (!messages.length) return { action: 'NO_REPLY', messages: [], handoff: false, reason }
      return { action: 'REPLY', messages, handoff: false, reason: null }
    }
    // Unknown action but usable text: keep the natural conversation rather than dropping it.
    if (messages.length) return { action: 'REPLY', messages, handoff: false, reason: null }
    return { action: 'NO_REPLY', messages: [], handoff: false, reason }
  }

  // No JSON object at all: a plain-text answer is still a valid single message.
  if (NO_REPLY_MARKER.test(text)) return { action: 'NO_REPLY', messages: [], handoff: false, reason: null }
  const messages = normalizeMessages(text, maxMessages, maxChars)
  if (!messages.length) return { action: 'NO_REPLY', messages: [], handoff: false, reason: null }
  return { action: 'REPLY', messages, handoff: false, reason: null }
}

module.exports = { parseSimpleV3Output, VALID_ACTIONS, NO_REPLY_MARKER }
