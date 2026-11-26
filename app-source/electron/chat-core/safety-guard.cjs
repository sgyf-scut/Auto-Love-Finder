// STABLE_CORE: every Engine result crosses this boundary before the platform.
// Sending permissions/identity/quotas and actual confirmation remain in Sender.
const { normalizeChatEngineResult } = require('./chat-types.cjs')

async function guardEngineResult(result, { assertFresh, assertProfileRevision, assertProfileReply, profileRevision, approvedSelfDisclosure = [] }) {
  const normalized = normalizeChatEngineResult(result)
  await assertFresh()
  assertProfileRevision(profileRevision)
  // Approval is supplied by the external relationship/disclosure owner, never
  // trusted merely because an Engine echoed it in its result metadata.
  for (const text of normalized.messages) assertProfileReply(text, approvedSelfDisclosure)
  return normalized
}

module.exports = { guardEngineResult }
