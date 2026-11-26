// Topic-matched recall of contact-scoped promises. Never loads another contact's
// promises and never loads the whole list. Pending promises are always worth
// surfacing (they are few and actionable); a resolved promise only comes back
// while it is fresh or when the current topic still points at it.
const { normalizePromises, clock } = require('./promise.cjs')
const text = value => typeof value === 'string' ? value : value?.text || value?.summary || value?.topic || value?.label || value?.title || ''
const FRESH = 7 * 86400000
// Single characters that carry no topic on their own; they must never make a
// promise look relevant just because everyday Chinese uses them everywhere.
const EMPTY_CHAR = new Set([...'我你他她它的了是在有和与就都也还要会能个这那吗呢吧啊呀哦嗯把被给对从到很太更最不没得好么们啥怎如何让说想去做过来去跟同'])

// A topic counts as pointing at this promise only when a whole phrase matches,
// or when two content characters do — a single shared character is how everyday
// Chinese looks, not a shared topic.
const MIN_RELEVANCE = 0.4
function relevance(item, focus) {
  if (!focus) return 0
  const terms = [item.summary, item.resolution?.text, ...(item.topics || []),
    ...(item.resolution?.fields || []).flatMap(field => [field.label, field.value])].filter(Boolean).map(value => String(value).toLowerCase())
  let score = 0
  for (const term of terms) {
    if (term.length >= 2 && focus.includes(term)) { score += 0.5; continue }
    const shared = new Set([...term].filter(ch => /[\u4e00-\u9fff]/.test(ch) && !EMPTY_CHAR.has(ch) && focus.includes(ch)))
    if (shared.size >= 2) score += 0.4
    else if (shared.size === 1) score += 0.15
  }
  return Math.min(1, score)
}

function retrievePromises({ contact = {}, activeTopic, selectedFocus, incoming, currentIncomingBurst, now = Date.now(), selfProfile, limit = 4 } = {}) {
  const store = normalizePromises(contact, { now, selfProfile })
  if (!store.items.length) return []
  const at = clock(now), cap = Number.isInteger(limit) ? Math.max(0, Math.min(6, limit)) : 4
  const focus = [activeTopic, selectedFocus, incoming,
    ...(Array.isArray(currentIncomingBurst?.messages) ? currentIncomingBurst.messages : []).map(row => text(row))].map(text).join(' ').slice(0, 3000).toLowerCase()
  const rank = (a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)
  const pending = store.items.filter(item => item.status === 'pending').sort(rank)
  const settled = store.items.filter(item => item.status === 'done')
    .filter(item => at - Date.parse(item.resolvedAt || item.updatedAt) <= FRESH || relevance(item, focus) >= MIN_RELEVANCE)
    .sort(rank)
  return [...pending, ...settled].slice(0, cap).map(item => ({
    id: item.id, contactId: store.contactId, type: item.type, key: item.key, status: item.status,
    summary: item.summary, dueHint: item.dueHint, topics: [...item.topics], updatedAt: item.updatedAt,
    resolution: item.resolution ? { text: item.resolution.text, at: item.resolution.at, fields: item.resolution.fields.map(field => ({ ...field })) } : null,
  }))
}
module.exports = { retrievePromises, relevance, MIN_RELEVANCE }
