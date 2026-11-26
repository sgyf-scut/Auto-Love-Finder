// LEGACY_CHAT ENGINE INTERNAL. No Storage, platform or sending capability.
// Synchronous Core Effects are a Legacy compatibility port only; future
// simple_v3 engines receive Context -> Result without this historical port.
const { planConversation } = require('../../social-brain/conversation-planner.cjs')
const { generateRelationshipReply } = require('./relationship-reply.cjs')
const { generateMatureReply } = require('./mature-reply.cjs')
const { generateEventReply } = require('./event-reply.cjs')

function createLegacyEngine({ completion, session, effects, lifecycle, helpers }) {
  return Object.freeze({ async generateReply(chatContext) {
    let result
    const bundle = chatContext.metadata.legacy
    if (bundle.mode === 'relationship') result = await generateRelationshipReply(chatContext, { completion, effects, lifecycle, helpers })
    else if (bundle.mode === 'event') result = await generateEventReply(chatContext, { completion, effects, lifecycle, helpers })
    else if (bundle.mode === 'mature') {
      const local = structuredClone(chatContext)
      const data = local.metadata.legacy
      let oldFriendPlan = null
      if (data.context) {
        const planned = await planConversation(completion, data.context)
        const usage = planned.result?.usage
        if (usage) for (const key of ['prompt', 'completion', 'total']) data.usageTracker[key] += Number(usage[key]) || 0
        const accepted = await effects.dispatch({ phase: 'INBOUND_OBSERVED', type: 'MATURE_PLAN', plan: planned.plan, plannerText: planned.result.text })
        oldFriendPlan = accepted.plan
        if (data.context.personaLens) { data.current.personaLens = data.context.personaLens; data.current.relationshipState = data.context.relationshipState }
        if (!oldFriendPlan.shouldReply || oldFriendPlan.expression.mode === 'STICKER_ONLY') {
          lifecycle.stage('READY_TO_SEND')
          await lifecycle.assertFresh()
          result = { ok: true, selfProfileRevision: chatContext.metadata.selfProfileRevision, text: '', text2: '', labeledText: '', skipped: !oldFriendPlan.shouldReply, expression: oldFriendPlan.expression, strategy: oldFriendPlan, relationshipJourney: data.context.relationshipJourney, personaLens: data.context.personaLens, relationshipState: data.context.relationshipState, model: planned.result.model, provider: planned.result.provider, tokens: data.usageTracker, showAiModelLabel: data.showAiModelLabel }
        }
      }
      if (!result) {
        data.oldFriendPlan = oldFriendPlan
        result = await generateMatureReply(local, { session, effects, lifecycle, helpers })
      }
    } else throw new Error(`Unsupported Legacy context mode: ${bundle.mode}`)
    const handoff = result.handoff === true
    const action = handoff ? 'HANDOFF' : result.skipped || result.rejected ? 'NO_REPLY' : 'REPLY'
    return JSON.parse(JSON.stringify({ action, messages: action === 'REPLY' ? [result.text, result.text2].filter(Boolean) : [], handoff,
      reason: result.reason || null, metadata: { legacyResult: result, ...(action === 'REPLY' && result.expression ? { expression: result.expression } : {}) } }))
  } })
}
module.exports = { createLegacyEngine }
