const { normalizeSharedMemory, clock } = require('./shared-memory.cjs')
const text = value => typeof value === 'string' ? value : value?.text || value?.summary || value?.topic || value?.label || value?.title || ''
function retrieveSharedMemories({ contact = {}, activeTopic, selectedFocus, relationshipStage = contact.relationshipJourney?.currentStage || 'STRANGER', action,
  incoming, currentIncomingBurst, now = Date.now(), selfProfile, limit = 3 } = {}) {
  const store = normalizeSharedMemory(contact, { now, selfProfile }), at = clock(now)
  const focus = [activeTopic, selectedFocus, incoming, ...(currentIncomingBurst?.messages || []).map(row => row.text)].map(text).join(' ').slice(0, 3000)
  if (!focus.trim()) return []
  const distress = /难过|崩溃|害怕|伤心|真的很烦|焦虑|失眠|不想聊|别联系|别再|不要.*(?:问|聊|开玩笑)|疼|痛苦|去世|生病/.test(focus)
  const early = ['STRANGER', 'EXPLORING', 'NEW_CONTACT', 'new_friend'].includes(relationshipStage)
  const preference = ['FRIEND', 'CLOSE_FRIEND'].includes(relationshipStage) ? 0.12 : relationshipStage === 'FAMILIAR' ? 0.07 : early ? -0.08 : 0
  const memories = store.memories.filter(memory => memory.status === 'active' && (!memory.lastRecalledAt || at - Date.parse(memory.lastRecalledAt) >= 24 * 3600000))
  return memories.map(memory => {
    if (memory.type === 'INSIDE_JOKE' && (early || distress || memory.strength < 0.65 || ['EMPATHY', 'CLOSE', 'NO_REPLY'].includes(action))) return null
    const matched = memory.topics.filter(topic => focus.toLowerCase().includes(topic.toLowerCase()) || topic === '英雄联盟' && /\bLOL\b/i.test(focus))
    if (!matched.length && !(memory.trigger && focus.includes(memory.trigger))) return null
    const relevance = Math.min(1, 0.5 + Math.min(0.2, matched.length * 0.1) + preference + memory.importance * 0.1 + (action === 'FOLLOW_UP' || action === 'DEEPEN' ? 0.05 : 0))
    return { id: memory.id, contactId: store.contactId, type: memory.type, summary: memory.summary, participants: ['self', 'contact'], topics: [...memory.topics], strength: memory.strength,
      relevance, lastRecalledAt: memory.lastRecalledAt, sourceMessageIds: [...memory.sourceMessageIds], usageOptional: true, trigger: memory.trigger || null }
  }).filter(Boolean).sort((a, b) => b.relevance - a.relevance).slice(0, Math.min(3, Math.max(0, Number.isInteger(limit) ? limit : 3)))
}
module.exports = { retrieveSharedMemories }
