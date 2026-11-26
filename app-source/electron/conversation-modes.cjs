const { createHash } = require('node:crypto')
function journeyStage(contact) {
  const journey = contact?.relationshipJourney
  if (!journey || journey.contactId && journey.contactId !== String(contact?.id || contact?.name || 'current')) return ''
  return /^(?:STRANGER|EXPLORING|ACQUAINTANCE|FAMILIAR|FRIEND|CLOSE_FRIEND)$/.test(journey.currentStage || '') ? journey.currentStage : ''
}
function relationshipStrategy(contact) {
  const stage = journeyStage(contact)
  if (stage) return ['FRIEND', 'CLOSE_FRIEND'].includes(stage) ? 'mature_friend' : 'developing_connection'
  return usesDevelopingStrategy(contact) ? 'developing_connection' : 'mature_friend'
}
function usesDevelopingStrategy(contact) {
  const stage = journeyStage(contact)
  return stage ? !['FRIEND', 'CLOSE_FRIEND'].includes(stage) : isFriendshipContact(contact)
}
// Existing automation safety classification remains independent from strategy.
function isFriendshipContact(contact) {
  const mode = contact?.profile?.chatMode
  return mode === 'friendship' || (!mode && contact?.profile?.useSelfPersona === true)
}
function factsConversationKey(contact) {
  const messages = (contact?.learning?.messages || []).filter(m => m?.role === 'contact' && m.text).slice(-30).map(m => String(m.text))
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}
function shouldRefreshFacts(contact, today, enabled = true) {
  if (!enabled) return false
  if (!isFriendshipContact(contact)) return contact?.learning?.factsUpdatedAt !== today
  return Boolean(contact?.learning?.messages?.some(m => m.role === 'contact' && m.text)) && contact.learning.factsConversationKey !== factsConversationKey(contact)
}
module.exports = { journeyStage, relationshipStrategy, usesDevelopingStrategy, isFriendshipContact, factsConversationKey, shouldRefreshFacts }
