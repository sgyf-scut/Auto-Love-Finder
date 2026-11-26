const { planConversation } = require('../../social-brain/conversation-planner.cjs')
const { writeReply } = require('../../social-brain/reply-writer.cjs')

// Preserve the existing proactive-event Planner/Writer contract. Event state
// is updated by the external send-confirmation path, never by generation.
async function generateEventReply(chatContext, { completion, effects, lifecycle, helpers }) {
  const { current } = chatContext.metadata.legacy
  const context = structuredClone(chatContext.metadata.legacy.context)
  const selfProfileRevision = context.selfProfile?.revision || 0
  const { stripTrailingPeriod, hasEthicsIssue, isReasoningLeak, isHollowOrMeta } = helpers
  const { plan: proposedPlan, result: planned } = await planConversation(completion, context)
  // The orchestrator performs disclosure approval against its trusted profile.
  // This boundary does not record a sent event or add relationship mutations.
  const accepted = await effects.dispatch({ phase: 'REPLY_DECIDED', type: 'EVENT_PLAN', plan: proposedPlan, plannerText: planned.text })
  const plan = structuredClone(accepted.plan)
  const writerContext = accepted.context
  lifecycle.assertSharedMemorySelection(current.id, plan.sharedMemoryIds, plan.sharedMemoryRevision)
  const written = await writeReply(completion, writerContext, plan)
  lifecycle.assertSharedMemorySelection(current.id, plan.sharedMemoryIds, plan.sharedMemoryRevision)
  lifecycle.assertProfileRevision(selfProfileRevision)
  lifecycle.assertProfileReply(written.text, plan.approvedSelfDisclosure || [])
  if (written.text && (hasEthicsIssue(written.text) || isReasoningLeak(written.text) || isHollowOrMeta(written.text))) throw new Error('事件跟进回复没有通过检查')
  const strategy = Object.fromEntries([
    'shouldReply', 'action', 'goal', 'messageCount', 'length', 'allowQuestion',
    'allowSelfDisclosure', 'conversationIntent', 'tone', 'relationshipIntensity',
    'shouldCloseTopic', 'avoid', 'expression', 'sharedMemoryIds', 'sharedMemoryRevision',
    ...(context.constraints.adaptiveProfileEnabled ? ['selfDisclosureKeys', 'approvedSelfDisclosure'] : []),
  ].map(key => [key, plan[key]]))
  return {
    ok: true,
    selfProfileRevision,
    text: stripTrailingPeriod(written.text),
    skipped: !written.text,
    expression: plan.expression,
    strategy: { ...strategy, shouldInitiate: plan.shouldReply },
    model: (written.result || planned).model,
    provider: (written.result || planned).provider,
  }
}

module.exports = { generateEventReply }
