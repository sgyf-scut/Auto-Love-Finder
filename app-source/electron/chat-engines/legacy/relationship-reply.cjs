const { planConversation } = require('../../social-brain/conversation-planner.cjs')
const { writeReply } = require('../../social-brain/reply-writer.cjs')

// This adapter preserves the original Planner -> observations -> Writer order.
// All accepted observations and generated-focus correlation remain owned by
// the external orchestrator, including observations on NO_REPLY and failures.
async function generateRelationshipReply(chatContext, { completion, effects, lifecycle, helpers }) {
  const { current, config } = chatContext.metadata.legacy
  // Legacy parsePlan refines attention in place. Keep that scratch state
  // local to the Engine, without mutating the read-only ChatContext input.
  const context = structuredClone(chatContext.metadata.legacy.context)
  const now = new Date(context.now)
  const selfProfileRevision = context.selfProfile?.revision || 0
  const { stripTrailingPeriod, hasEthicsIssue, isReasoningLeak, isHollowOrMeta } = helpers

  const { plan, result: plannerResult } = await planConversation(completion, context)
  // Legacy compatibility: validated observations were persisted before Writer,
  // and Writer immediately consumed the rebuilt context. Do not defer this
  // effect until the Engine returns or until a message is sent.
  const observed = await effects.dispatch({ phase: chatContext.metadata.legacy.opening ? 'REPLY_DECIDED' : 'INBOUND_OBSERVED', type: 'PLANNER_OBSERVATIONS', plan, plannerText: plannerResult.text })
  const refreshed = observed.context
  const strategy = structuredClone(observed.strategy)
  if (Array.isArray(observed.approvedSelfDisclosure)) plan.approvedSelfDisclosure = observed.approvedSelfDisclosure
  await lifecycle.assertFresh()
  lifecycle.assertSharedMemorySelection(current.id, plan.sharedMemoryIds, plan.sharedMemoryRevision)
  if (plan.shouldReply && plan.expression.mode !== 'STICKER_ONLY') lifecycle.stage('WRITING')
  const written = plan.expression.mode === 'STICKER_ONLY'
    ? { text: '', result: null }
    : await writeReply(completion, refreshed, plan)
  if (written.approvedSelfDisclosure) {
    plan.approvedSelfDisclosure = written.approvedSelfDisclosure
    strategy.approvedSelfDisclosure = written.approvedSelfDisclosure
  }
  await lifecycle.assertFresh()
  lifecycle.stage('READY_TO_SEND')
  await lifecycle.assertFresh()
  lifecycle.assertProfileRevision(selfProfileRevision)
  lifecycle.assertSharedMemorySelection(current.id, plan.sharedMemoryIds, plan.sharedMemoryRevision)
  const reply = written.text
  lifecycle.assertProfileReply(reply, plan.approvedSelfDisclosure || [])
  if (hasEthicsIssue(reply) || isReasoningLeak(reply) || (reply && isHollowOrMeta(reply))) throw new Error('交友回复没有通过检查，请重试')
  const result = written.result || plannerResult
  const text = stripTrailingPeriod(reply)
  // Legacy compatibility: this associates draft text with the chosen focus;
  // it does not claim that an outgoing message was confirmed.
  if (text && plan.focusMessageId) await effects.dispatch({ phase: 'REPLY_DECIDED', type: 'GENERATED_FOCUS', plan, text, at: now.toISOString() })
  const showAiModelLabel = config.settings?.showAiModelLabel !== false
  await effects.dispatch({ phase: 'REPLY_DECIDED', type: 'LOG', entry: { type: 'relationship_plan', message: `已为 ${current.name} 规划本轮交友回复`, detail: strategy } })
  const tokens = [context.journeyEvaluation?.result?.usage, plannerResult.usage, written.result?.usage].filter(Boolean).reduce((total, usage) => {
    for (const key of ['prompt', 'completion', 'total']) total[key] = (total[key] || 0) + (Number(usage[key]) || 0)
    return total
  }, {})
  return {
    ok: true,
    selfProfileRevision,
    text,
    text2: '',
    expression: plan.expression,
    labeledText: showAiModelLabel && text ? `【${result.aiLabel || 'AI'}】${text}` : text,
    skipped: !text && plan.expression.mode !== 'STICKER_ONLY',
    model: result.model,
    provider: result.provider,
    aiLabel: result.aiLabel,
    showAiModelLabel,
    strategy,
    tokens,
    relationshipJourney: context.relationshipJourney,
    personaLens: context.personaLens,
    relationshipState: context.relationshipState,
    attention: context.payload.attentionContext,
    socialState: {
      profile: refreshed.memory.profile,
      inferences: refreshed.memory.inferences,
      unknowns: refreshed.memory.unknowns,
      events: refreshed.memory.events,
      learningHistory: refreshed.memory.learningHistory,
      relationshipMetrics: refreshed.memory.relationshipMetrics,
    },
  }
}

module.exports = { generateRelationshipReply }
