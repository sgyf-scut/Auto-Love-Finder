// Normalize actual inbound rows, keeping message boundaries and evidence IDs.
// Media frames remain transient inputs to the interpreter, never prompt data.
const { clean, messageQuote } = require('./memory-manager.cjs')
function normalizeIncomingBurst(value, contactId = '') {
  if (!value) return null
  const source = Array.isArray(value) ? { messages: value } : value
  if (!source || typeof source !== 'object' || source.contactId && contactId && source.contactId !== contactId) return null
  const seen = new Set()
  const messages = (Array.isArray(source.messages) ? source.messages : []).slice(-240).flatMap(raw => {
    const role = raw?.role || raw?.senderRole || raw?.sender
    if (!raw || !['contact', 'incoming', 'user'].includes(role)) return []
    const id = clean(raw.messageId || raw.id, 100)
    if (!id || seen.has(id) || raw.contactId && contactId && raw.contactId !== contactId) return []
    seen.add(id)
    const quote = messageQuote(raw.quote)
    const at = raw.at || raw.timestamp || raw.sentAt
    return [{ id, messageId: id, role: 'contact', text: clean(typeof raw.text === 'string' ? raw.text : typeof raw.content === 'string' ? raw.content : '', 500), type: clean(raw.type || raw.mediaKind || 'text', 30), at: Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : '', ...(raw.mediaKind ? { mediaKind: clean(raw.mediaKind, 30) } : {}), ...(raw.media || raw.mediaEvidence ? { mediaEvidence: true } : {}), ...(quote ? { quote } : {}) }]
  })
  return messages.length ? { burstId: clean(source.burstId, 120), contactId: contactId || clean(source.contactId, 120), conversationRevision: Number.isSafeInteger(source.conversationRevision) ? source.conversationRevision : 0, firstMessageAt: source.firstMessageAt, lastMessageAt: source.lastMessageAt, messageCount: messages.length, messages } : null
}
// The visible window is re-scraped on every read and carries no platform id, so a
// row that is already stored comes back as a fresh copy whose position-derived id
// has changed. Collapse by id and — for plain text — by content before appending,
// otherwise every read re-adds the whole window and stored history doubles each
// time. A real id outranks a fingerprint-only copy of the same text, and media rows
// keep their positional identity so two identical stickers stay two messages.
function dedupeHistory(rows) {
  const idOf = row => clean(row?.messageId || row?.id, 100)
  const stableIdOf = row => { const id = idOf(row); return id && !id.startsWith('msg-') ? id : '' }
  const contentOf = row => JSON.stringify([row?.role === 'me' ? 'me' : 'contact', clean(row?.text, 500), clean(row?.type || 'text', 30), row?.mediaEvidence ? true : null, clean(row?.quote?.text, 500) || null])
  const merged = []
  const indexByRawId = new Map()
  const indexByContent = new Map()
  for (const row of rows) {
    const raw = idOf(row)
    if (raw && indexByRawId.has(raw)) {
      // The same message re-read under the same id. A copy carrying a real
      // messageId is strictly richer than an id-only copy of that row, so it
      // replaces the stored one in place instead of being dropped.
      const at = indexByRawId.get(raw)
      if (row?.messageId && !merged[at]?.messageId) merged[at] = row
      continue
    }
    const stable = stableIdOf(row)
    const body = contentOf(row)
    const existing = indexByContent.get(body)
    if (existing === undefined) {
      if (raw) indexByRawId.set(raw, merged.length)
      indexByContent.set(body, merged.length)
      merged.push(row)
      continue
    }
    const kept = merged[existing]
    if (row?.mediaEvidence || kept?.mediaEvidence) { if (raw) indexByRawId.set(raw, merged.length); merged.push(row); continue }
    if (stable && !stableIdOf(kept)) { indexByRawId.set(stable, existing); merged[existing] = row; continue }
    if (!stable) continue
    indexByRawId.set(stable, merged.length)
    merged.push(row)
  }
  return merged
}
function withIncomingBurst(contact, value, recentConversationContext) {
  const burst = normalizeIncomingBurst(value, contact?.id || contact?.name)
  if (!burst) return { contact, burst: null }
  const stored = Array.isArray(contact?.learning?.messages) ? contact.learning.messages : []
  const window = Array.isArray(recentConversationContext) ? recentConversationContext : []
  const messages = dedupeHistory([...stored, ...window, ...burst.messages])
  return { burst, contact: { ...contact, learning: { ...contact?.learning, messages: messages.slice(-240) } } }
}
async function assertGenerationFresh(guard) {
  if (guard && await guard() === false) { const error = new Error('对方已补发新消息，此回复已过期'); error.code = 'BURST_STALE'; throw error }
}
module.exports = { normalizeIncomingBurst, withIncomingBurst, assertGenerationFresh, dedupeHistory }
