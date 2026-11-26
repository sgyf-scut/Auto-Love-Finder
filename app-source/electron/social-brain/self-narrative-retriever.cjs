// Topic-matched recall of contact-scoped self narrative. Never loads another
// contact's narratives and never loads the full list, only a small relevant set.
const { normalizeSelfNarrative, clock } = require('./self-narrative.cjs')
const text = value => typeof value === 'string' ? value : value?.text || value?.summary || value?.topic || value?.label || value?.title || ''
// Literal topic overlap misses paraphrases: "你是不是创到别的区了" never contains
// "黑色玫瑰". Aliases normalize the common ways a contact refers to a topic back
// onto the narrative key, so a stored fact can still be recalled without a
// semantic model. No alias hit means no recall — never a fallback to recent items.
const TOPIC_ALIASES = Object.freeze({
  lol_server: ['区服', '大区', '服务器', '哪个区', '什么区', '别的区', '区'],
  availability: ['有空', '没空', '时间', '周末', '什么时候', '忙不忙', '方便', '约'],
  self_eval: ['菜', '厉害', '水平', '技术', '打得怎么样', '强不强'],
})
function aliasHits(key, focus) {
  return (TOPIC_ALIASES[key] || []).filter(alias => focus.includes(alias.toLowerCase()))
}
function retrieveSelfNarratives({ contact = {}, activeTopic, selectedFocus, incoming, currentIncomingBurst, now = Date.now(), selfProfile, limit = 4 } = {}) {
  const store = normalizeSelfNarrative(contact, { now, selfProfile }), at = clock(now)
  const focus = [activeTopic, selectedFocus, incoming, ...(Array.isArray(currentIncomingBurst?.messages) ? currentIncomingBurst.messages : []).map(row => row.text)].map(text).join(' ').slice(0, 3000)
  if (!focus.trim() || !store.narratives.length) return []
  const focusLower = focus.toLowerCase()
  const cap = Number.isInteger(limit) ? Math.max(0, Math.min(6, limit)) : 4
  return store.narratives.filter(narrative => narrative.status === 'active')
    .map(narrative => {
      const literal = (narrative.topics || []).filter(term => focusLower.includes(term.toLowerCase()))
      const matched = [...new Set([...literal, ...aliasHits(narrative.key, focusLower)])]
      if (!matched.length) return null
      const relevance = Math.min(1, 0.55 + Math.min(0.25, matched.length * 0.12) + (at - Date.parse(narrative.updatedAt) <= 7 * 86400000 ? 0.1 : 0))
      return { id: narrative.id, contactId: store.contactId, key: narrative.key, statement: narrative.statement, topics: [...narrative.topics],
        relevance, updatedAt: narrative.updatedAt, sourceMessageIds: [...narrative.sourceMessageIds], usageOptional: true }
    })
    .filter(Boolean).sort((a, b) => b.relevance - a.relevance).slice(0, cap)
}
module.exports = { retrieveSelfNarratives }
