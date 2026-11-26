// STABLE_CORE: external state ownership and Legacy execution-time compatibility.
const { buildChatContext, safeLegacyContext, jsonData } = require('./context-builder.cjs')
const { createChatEngineRouter } = require('./chat-engine-router.cjs')
const { createCoreEffectBoundary } = require('./core-effects.cjs')
const { createModelProviderPort } = require('./model-provider-port.cjs')
const { createLegacyEngine } = require('../chat-engines/legacy/engine.cjs')
const { createSimpleV3Engine } = require('../chat-engines/simple-v3/engine.cjs')
const { guardEngineResult } = require('./safety-guard.cjs')
const { parsePlan, selectedSharedMemories } = require('../social-brain/conversation-planner.cjs')
const { buildContext } = require('../social-brain/context-builder.cjs')
const { syncMemory, applyObservations, compatibilityFacts, summarizeMemory } = require('../social-brain/memory-manager.cjs')
const { isSelfProfileEnabled, approveSelfDisclosure } = require('../social-brain/disclosure-policy.cjs')
const { withIncomingBurst, assertGenerationFresh } = require('../social-brain/incoming-burst.cjs')
const { randomUUID } = require('node:crypto')

// Simple V3 parses its own JSON contract, so it needs the untouched model text
// rather than the Legacy-cleaned reply text.
function readModelText(out) {
  const message = out?.choices?.[0]?.message
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part?.text || '').join(' ')
  return ''
}


class ConversationOrchestrator {
  constructor(ai, helpers) { this.ai = ai; this.helpers = helpers }
  async draft({ contact, incoming, videoFrames, incomingMeta, currentIncomingBurst, recentConversationContext, generationGuard, onGenerationStage, preparedJourneyContext }) {
    const { extractUsage, isVisionCapable, isSingleImageVisionModel, isFriendshipContact, normalizeSkills, journeyStage, relationshipStrategy } = this.helpers
    await assertGenerationFresh(generationGuard)
    const grouped = withIncomingBurst(contact, currentIncomingBurst, recentConversationContext)
    contact = grouped.contact
    const burst = grouped.burst
    if (burst) { const last = burst.messages.at(-1); incoming = last.text; incomingMeta = { ...incomingMeta, messageId: last.messageId, type: last.type, quote: last.quote } }
    onGenerationStage?.('PLANNING')
    const started = Date.now()
    const usageTracker = { prompt: 0, completion: 0, total: 0 }
    const recordUsage = (res) => {
      const u = res?.usage && ['prompt', 'completion', 'total'].some(key => key in res.usage) ? res.usage : extractUsage(res)
      if (u) {
        usageTracker.prompt += (u.prompt || 0)
        usageTracker.completion += (u.completion || 0)
        usageTracker.total += (u.total || ((u.prompt || 0) + (u.completion || 0)))
      }
    }
    if (preparedJourneyContext?.journeyEvaluation?.result) recordUsage(preparedJourneyContext.journeyEvaluation.result)
    const config = this.ai.storage.get()
    const configuredProviders = config.providers || []
    if (!configuredProviders.length) throw new Error('没有配置可用模型')
    const media = this.ai.normalizeMedia(videoFrames)
    const capturedFrames = media.frames
    const visionAvailable = configuredProviders.some((item) => isVisionCapable(item))
    const frames = capturedFrames.length && visionAvailable ? capturedFrames : []
    const hasMediaContext = Boolean(media.mediaKind || media.detectedVideo || frames.length || media.audioTranscript || media.videoPageTitle || media.videoPageDescription || media.videoComments.length)
    if (capturedFrames.length && !frames.length && !media.audioTranscript && !hasMediaContext) throw new Error('已收到图片或视频画面，但没有配置支持视觉识别的模型')

    const showAiModelLabel = config.settings?.showAiModelLabel !== false
    const contactWithTone = {
      ...contact,
      _selfPersona: isSelfProfileEnabled(config.selfProfile) ? {} : config.selfPersona || {},
      _globalDefaultTone: config.appearance?.defaultTone || '',
      _showAiModelLabel: showAiModelLabel,
      _incomingMeta: incomingMeta || contact?._incomingMeta || {},
      _allowEmoji: Math.random() < 0.28,
    }

    const imageKinds = ['image', 'sticker', 'gif', 'album']
    const semanticMedia = imageKinds.includes(media.mediaKind) || imageKinds.includes(incomingMeta?.type)
      || imageKinds.includes((incomingMeta?.quote || media.quote)?.type)
      || /^\s*\[(?:图片|照片|表情(?:包)?|动图|GIF)\]/i.test(String(incoming || ''))
    if (semanticMedia && !media.interpretation) {
      media.interpretation = await this.ai.interpretIncomingMessage({ contact: contactWithTone, incoming, incomingMeta, media })
      await assertGenerationFresh(generationGuard)
      this.ai.recordMessageSemantics(contact?.name, media.interpretation, contact?.id)
    }

    // 先理解再回复（smart 模式 + 有帧 + 开关开启）
    const recognitionMode = String(config.settings?.videoRecognitionMode || 'smart').toLowerCase()
    const smartMode = recognitionMode === 'smart'
    let mediaAnalysis = { text: '', topic: '' }
    if (!semanticMedia && smartMode && config.settings?.videoAnalysisFirst !== false && frames.length) {
      const singleImageVision = configuredProviders.some((p) => isSingleImageVisionModel(p))
      const analysisFrames = singleImageVision ? frames.slice(0, 1) : frames
      const visionProviders = configuredProviders.filter((item) => isVisionCapable(item))
      mediaAnalysis = await this.ai.analyzeMediaFrames({ contact: contactWithTone, incoming, media: { ...media, frames: analysisFrames }, providers: visionProviders })
      await assertGenerationFresh(generationGuard)
    }
    // 无画面分析但抓到了评论：浓缩成"视频内容与氛围"
    if (!semanticMedia && !mediaAnalysis.text && media.videoComments.length) {
      try {
        const summaryRes = await this.ai.summarizeComments(media.videoComments)
        if (summaryRes?.text) mediaAnalysis = { ...mediaAnalysis, text: `视频内容与氛围：${summaryRes.text}` }
        if (summaryRes?.usage) recordUsage(summaryRes)
      } catch (_) { /* 摘要失败则保持原文评论注入 */ }
    }
    await assertGenerationFresh(generationGuard)
    // 视频上下文落库：成为后续轮次的一等背景信息
    if (!semanticMedia && hasMediaContext && contact?.name && (mediaAnalysis.text || mediaAnalysis.topic || media.videoPageTitle)) {
      const summary = mediaAnalysis.text || (media.videoPageTitle ? `分享了视频：${String(media.videoPageTitle).slice(0, 40)}` : '')
      const topic = mediaAnalysis.topic || (media.videoPageTitle ? `对方分享了视频：${String(media.videoPageTitle).slice(0, 40)}` : '')
      this.ai.recordMediaContext(contact.name, { summary, topic }, contact.id)
    }

    // 生成阶段帧数与分析阶段对齐（单图模型降帧）
    const usedFrames = Number(mediaAnalysis.usedFrames || 0)
    const genFrames = semanticMedia ? [] : usedFrames > 0 ? frames.slice(0, usedFrames) : frames
    const genMedia = { ...media, frames: genFrames }
    if (isFriendshipContact(contactWithTone)) {
      let analysis = mediaAnalysis.text
      if (!semanticMedia && !analysis && frames.length && visionAvailable) analysis = (await this.ai.analyzeMediaFrames({ contact: contactWithTone, incoming, media, providers: configuredProviders.filter(isVisionCapable) })).text
      const reply = await this.ai.draftRelationshipMessage({ contact: contactWithTone, incoming, incomingMeta, media: { ...media, analysis }, currentIncomingBurst: currentIncomingBurst || burst, recentConversationContext, generationGuard, onGenerationStage, preparedJourneyContext })
      return semanticMedia ? { ...reply, understandingStatus: media.interpretation.understandingStatus, interpretation: media.interpretation } : reply
    }
    if (semanticMedia) mediaAnalysis.text = JSON.stringify(media.interpretation)
    let context = null
    if (config.settings?.favoriteStickerEnabled === true || isSelfProfileEnabled(config.selfProfile) || journeyStage(contactWithTone) || normalizeSkills(config.aiSkills).some(skill => skill.enabled && skill.invocation === 'always' && ['friendship', 'all'].includes(skill.target))) {
      const contextOptions = { incoming, media, currentIncomingBurst: burst, persona: config.selfPersona || {}, selfProfile: config.selfProfile, skills: config.aiSkills || [], memoryEnabled: Boolean(journeyStage(contactWithTone)) && config.settings?.longTermMemory !== false, attentionEnabled: Boolean(journeyStage(contactWithTone)), favoriteStickerEnabled: config.settings?.favoriteStickerEnabled === true, sendHistory: config.sendHistory || [] }
      context = preparedJourneyContext || buildContext({ ...contextOptions, contact: contactWithTone })
      const completion = async (...args) => { this.ai.assertProfileRevision(config.selfProfile?.revision || 0); await assertGenerationFresh(generationGuard); const value = await this.ai.profileChatCompletion(...args); await assertGenerationFresh(generationGuard); this.ai.assertProfileRevision(config.selfProfile?.revision || 0); recordUsage(value); return value }
      if (!preparedJourneyContext) context = await this.ai.prepareJourneyContext(context, contactWithTone, value => buildContext({ ...contextOptions, contact: value, now: context.now }), completion, generationGuard)
      contactWithTone.relationshipJourney = context.relationshipJourney
      if ((journeyStage(contact) || context.journeyEvaluation?.changed) && isFriendshipContact(contactWithTone)) return this.ai.draftRelationshipMessage({ contact: contactWithTone, incoming, incomingMeta, media, currentIncomingBurst: burst, recentConversationContext, generationGuard, onGenerationStage, preparedJourneyContext: context })
    }
    return this.run({ mode: 'mature', contact: contactWithTone, config, incoming, burst, context, generationGuard, onGenerationStage,
      legacy: { config: { settings: config.settings, aiSkills: config.aiSkills || [] }, incoming, genMedia, genFrames, mediaAnalysis, hasMediaContext, usageTracker, started, showAiModelLabel, adaptiveProfileEnabled: isSelfProfileEnabled(config.selfProfile) } })
  }

  async relationship({ contact, incoming = '', persona, candidate, opening = false, media = {}, incomingMeta = {}, currentIncomingBurst, recentConversationContext, generationGuard, onGenerationStage, preparedJourneyContext }) {
    const { journeyStage, isFriendshipContact, sameContact } = this.helpers
    // Existing proactive task scheduling/generation stays on its original
    // path in this first batch. New event follow-ups are stored, not scheduled.
    if (opening && contact && !journeyStage(contact) && !isSelfProfileEnabled(this.ai.storage.get().selfProfile)) return this.ai.draftRelationshipMessageLegacy({ contact, incoming, persona, candidate, opening, media })
    await assertGenerationFresh(generationGuard)
    const grouped = withIncomingBurst(contact, currentIncomingBurst, recentConversationContext)
    contact = grouped.contact
    const burst = grouped.burst
    if (burst) { const last = burst.messages.at(-1); incoming = last.text; incomingMeta = { ...incomingMeta, messageId: last.messageId, type: last.type, quote: last.quote } }
    const config = this.ai.storage.get()
    const stored = (config.contacts || []).find(item => sameContact(item, contact, config.contacts || []))
    const current = { ...(contact || { name: candidate?.name || '新朋友' }), ...(stored?.socialBrain ? { socialBrain: stored.socialBrain } : {}), ...(stored?.personaLens ? { personaLens: stored.personaLens } : {}), ...(stored?.relationshipState ? { relationshipState: stored.relationshipState } : {}), ...(stored?.relationshipJourney ? { relationshipJourney: stored.relationshipJourney } : {}), ...(stored?.sharedMemory ? { sharedMemory: stored.sharedMemory } : {}), ...(stored?.sharedMemoryLedger ? { sharedMemoryLedger: stored.sharedMemoryLedger } : {}), learning: { ...contact?.learning, ...Object.fromEntries(['conversationAttention', 'conversationState', 'conversationMomentum'].filter(key => stored?.learning?.[key]).map(key => [key, stored.learning[key]])) }, profile: { ...(contact?.profile || {}), chatMode: 'friendship' } }
    const now = new Date()
    if (burst) {
      await assertGenerationFresh(generationGuard)
      // Preserve actual inbound evidence, including earlier rows in this turn.
      // No generated reply or owner-style sample is appended here.
      const saved = this.ai.storage.get()
      this.ai.storage.update({ contacts: (saved.contacts || []).map(item => sameContact(item, current, saved.contacts || []) ? { ...item, learning: { ...item.learning, messages: current.learning.messages } } : item) })
    }
    if (burst) {
      const originalRows = (Array.isArray(currentIncomingBurst) ? currentIncomingBurst : currentIncomingBurst?.messages) || []
      for (const row of burst.messages) {
        if (row.id === media.interpretation?.messageId) continue
        const original = originalRows.find(item => (item.messageId || item.id) === row.id)
        const rowMedia = row.id === incomingMeta.messageId ? media : original?.media && typeof original.media === 'object' ? original.media : {}
        const interpretation = await this.ai.interpretIncomingMessage({ contact: current, incoming: row.text, incomingMeta: { messageId: row.id, type: row.type, quote: row.quote }, media: rowMedia })
        await assertGenerationFresh(generationGuard)
        this.ai.recordMessageSemantics(current.name, interpretation, current.id)
        if (interpretation.understandingStatus !== 'not_required') current.learning.messageSemantics = [...(current.learning.messageSemantics || []).filter(item => item.messageId !== row.id), { ...interpretation, observedAt: now.toISOString() }].slice(-12)
        if (row.id === incomingMeta.messageId) media = { ...media, interpretation }
      }
    }
    if (!media.interpretation) {
      media = { ...media, interpretation: await this.ai.interpretIncomingMessage({ contact: current, incoming, incomingMeta, media }) }
      await assertGenerationFresh(generationGuard)
      this.ai.recordMessageSemantics(current.name, media.interpretation, current.id)
    }
    onGenerationStage?.('PLANNING')
    const contextOptions = { incoming, persona: persona || config.selfPersona || {}, selfProfile: config.selfProfile, candidate, opening, media, currentIncomingBurst: burst, skills: config.aiSkills || [], memoryEnabled: config.settings?.longTermMemory !== false, favoriteStickerEnabled: config.settings?.favoriteStickerEnabled === true, sendHistory: config.sendHistory || [], now }
    let context = preparedJourneyContext || buildContext({ ...contextOptions, contact: current })
    const completion = async (...args) => { this.ai.assertProfileRevision(config.selfProfile?.revision || 0); await assertGenerationFresh(generationGuard); const result = await this.ai.profileChatCompletion(...args); await assertGenerationFresh(generationGuard); this.ai.assertProfileRevision(config.selfProfile?.revision || 0); return result }
    if (!preparedJourneyContext) context = await this.ai.prepareJourneyContext(context, current, value => buildContext({ ...contextOptions, contact: value }), completion, generationGuard)
    current.relationshipJourney = context.relationshipJourney
    if (!opening && (journeyStage(contact) || context.journeyEvaluation?.changed) && !isFriendshipContact(current)) return this.ai.draft({ contact: current, incoming, incomingMeta, videoFrames: media, currentIncomingBurst: burst, recentConversationContext, generationGuard, onGenerationStage, preparedJourneyContext: context })
    return this.run({ mode: 'relationship', contact: current, config, incoming, burst, context, generationGuard, onGenerationStage,
      observationScope: { current, incoming, persona, candidate, opening, media, burst, now, contextOptions },
      legacy: { config: { settings: config.settings }, incoming, opening } })
  }

  async run(scope) {
    const { config, contact, context, generationGuard, onGenerationStage } = scope
    const traceId = randomUUID()
    const revision = config.selfProfile?.revision || 0
    const ai = this.ai
    const lifecycle = Object.freeze({ assertFresh: () => assertGenerationFresh(generationGuard), stage: stage => onGenerationStage?.(stage),
      assertProfileRevision: value => ai.assertProfileRevision(value), assertProfileReply: (text, approved) => ai.assertProfileReply(text, approved),
      assertSharedMemorySelection: (...args) => ai.assertSharedMemorySelection(...args) })
    const completion = async (...args) => { ai.assertProfileRevision(revision); await lifecycle.assertFresh(); const value = await ai.profileChatCompletion(...args); await lifecycle.assertFresh(); ai.assertProfileRevision(revision); return value }
    const effects = createCoreEffectBoundary({ traceId, accountId: String(ai.accountId || 'local'), contactId: String(contact?.id || contact?.name || 'opening'),
      isCurrent: async () => { await lifecycle.assertFresh(); ai.assertProfileRevision(revision); return true },
      handlers: {
        [`${scope.legacy.opening ? 'REPLY_DECIDED' : 'INBOUND_OBSERVED'}:PLANNER_OBSERVATIONS`]: effect => this.observePlan(scope, effect.payload.plan, effect.payload.plannerText),
        'INBOUND_OBSERVED:MATURE_PLAN': effect => this.maturePlan(scope, effect.payload.plan, effect.payload.plannerText),
        'REPLY_DECIDED:EVENT_PLAN': effect => this.eventPlan(scope, effect.payload.plan, effect.payload.plannerText),
        'REPLY_DECIDED:GENERATED_FOCUS': effect => this.generatedFocus(scope, effect.payload),
        'REPLY_DECIDED:WRITER_SETTINGS': () => jsonData({ twoMessageChance: this.ai.storage.get().settings?.twoMessageChance }),
        'REPLY_DECIDED:LOG': effect => { ai.storage.addLog?.(effect.payload.entry) },
      }, onEffect: event => { ai.onCoreEffect?.(event) } })
    const port = createModelProviderPort(ai, config.providers || [], { assertFresh: lifecycle.assertFresh, helpers: this.helpers })
    const effectPort = Object.freeze({ dispatch: ({ phase, type, ...payload }) => effects.dispatch({ phase, type, payload: jsonData(payload) }) })
    const engine = createLegacyEngine({ completion, session: port.createSession(), effects: effectPort, lifecycle, helpers: this.helpers })
    const simpleV3 = this.buildSimpleV3Engine({ port, lifecycle })
    const input = buildChatContext({ accountId: ai.accountId, contact, incoming: scope.incoming, burst: scope.burst, context, profile: config.selfProfile, traceId,
      legacy: { mode: scope.mode, ...scope.legacy } })
    const router = createChatEngineRouter({ engines: { legacy: engine, simple_v3: simpleV3 }, config: config.settings || {}, onDiagnostic: diagnostic => ai.storage.addLog?.({ type: 'chat_engine_routing', message: '聊天引擎路由诊断', detail: diagnostic }) })
    ai.onChatContext?.(input)
    const generated = await router.generateReply(input)
    // Unified post-Engine guard. The actual Sender still performs all existing
    // DND/quota/identity/revision/idempotency/confirmation checks afterwards.
    const result = await guardEngineResult(generated, { ...lifecycle, profileRevision: revision, approvedSelfDisclosure: scope.approvedSelfDisclosure || [] })
    if (generated.metadata.shadow) this.recordShadowComparison({ ai, contact, traceId, primary: generated, shadow: generated.metadata.shadow, incomingMessages: input.incomingMessages })
    ai.onChatEngineResult?.(result)
    if (result.action === 'HANDOFF') return { ok: true, text: '', text2: '', skipped: true, handoff: true, reason: result.reason, chatEngine: result.metadata.engine, chatAction: result.action, chatTraceId: traceId }
    if (result.metadata.engine === 'simple_v3') return { ...this.buildSimpleV3CompatResult(result, config, revision), chatEngine: 'simple_v3', chatAction: result.action, chatTraceId: traceId }
    return { ...result.metadata.legacyResult, chatEngine: 'legacy', chatAction: result.action, chatTraceId: traceId }
  }

  // Simple V3 receives only a narrow generate dependency over the shared Provider
  // port. It gets no Storage, DOM, Sender, quota or Relationship capability.
  buildSimpleV3Engine({ port, lifecycle }) {
    const usage = { prompt: 0, completion: 0, total: 0 }
    const session = port.createSession()
    const recordUsage = result => {
      const u = result?.usage && ['prompt', 'completion', 'total'].some(key => key in result.usage) ? result.usage : this.helpers.extractUsage(result)
      if (!u) return
      usage.prompt += u.prompt || 0
      usage.completion += u.completion || 0
      usage.total += u.total || ((u.prompt || 0) + (u.completion || 0))
    }
    return createSimpleV3Engine({
      generate: async (messages, options) => {
        const { provider, out } = await session.generate(messages, [], recordUsage)
        return { text: readModelText(out), model: provider.model, provider: provider.name, aiLabel: provider.aiLabel, usage: { ...usage } }
      },
      lifecycle: { assertFresh: lifecycle.assertFresh, stage: lifecycle.stage },
      config: {},
    })
  }

  buildSimpleV3CompatResult(result, config, revision) {
    const showAiModelLabel = config.settings?.showAiModelLabel !== false
    const model = result.metadata.model || ''
    const label = result.metadata.aiLabel || `AI · ${model || '当前模型'}`
    const [first, second, third] = result.messages
    return {
      ok: true,
      selfProfileRevision: revision,
      text: first || '',
      text2: second || '',
      text3: third || '',
      texts: [...result.messages],
      labeledText: showAiModelLabel && first ? `【${label}】${first}` : (first || ''),
      skipped: result.action === 'NO_REPLY',
      model,
      provider: result.metadata.provider || '',
      aiLabel: label,
      showAiModelLabel,
      tokens: result.metadata.usage || {},
      strategy: { sharedMemoryIds: [], sharedMemoryRevision: 0 },
      engine: 'simple_v3',
    }
  }

  // Shadow produces a comparison record only. It never sends, never updates
  // Memory or Relationship and never consumes a send quota.
  recordShadowComparison({ ai, contact, traceId, primary, shadow, incomingMessages }) {
    const record = {
      at: new Date().toISOString(),
      traceId,
      accountId: String(ai.accountId || 'local'),
      contactId: String(contact?.id || contact?.name || 'opening'),
      incomingMessages: (incomingMessages || []).map(row => ({ id: String(row.id || row.messageId || ''), role: row.role || 'contact', text: String(row.text || '') })),
      primary: { engine: primary.metadata.engine, action: primary.action, messages: primary.messages, handoff: primary.handoff },
      shadow: { engine: shadow.engine, ok: shadow.ok, action: shadow.action, messages: shadow.messages, handoff: shadow.handoff, error: shadow.error, model: shadow.model, provider: shadow.provider, latencyMs: shadow.latencyMs },
    }
    const latest = ai.storage.get()
    ai.storage.update({ shadowComparisons: [...(latest.shadowComparisons || []), record].slice(-200) })
    ai.storage.addLog?.({ type: 'chat_shadow_compare', message: 'Simple V3 Shadow 已生成对照结果（未发送、未改动记忆或关系）', detail: { traceId, contactId: record.contactId, ok: shadow.ok, action: shadow.action, latencyMs: shadow.latencyMs, model: shadow.model } })
    return record
  }

  observePlan(scope, rawPlan, plannerText) {
    const plan = structuredClone(rawPlan)
    const { context, config } = scope
    // parsePlan's accepted focus/opportunity refinements historically affected
    // the persisted context too. Replay the same pure validation externally.
    if (plannerText) parsePlan(plannerText, context)
    const { current, incoming, persona, candidate, opening, media, burst, now } = scope.observationScope
    const { sameContact, relationshipStrategy } = this.helpers
    context.memory = applyObservations(context.memory, plan.observations, context.messages, now)
    // Let Writer see the accepted, validated evidence only; raw model guesses
    // never become identity facts or flow into the final chat as instructions.
    const refreshed = buildContext({ contact: { ...current, socialBrain: context.memory }, incoming, persona: persona || config.selfPersona || {}, selfProfile: config.selfProfile, candidate, opening, media, currentIncomingBurst: burst, focusMessageId: plan.focusMessageId, skills: config.aiSkills || [], memoryEnabled: config.settings?.longTermMemory !== false, now })
    if (refreshed.constraints.adaptiveProfileEnabled) plan.approvedSelfDisclosure = approveSelfDisclosure(config.selfProfile, refreshed, plan)
    scope.approvedSelfDisclosure = plan.approvedSelfDisclosure || []
    const behavior = Object.fromEntries(['shouldReply', 'messageCount', 'length', 'allowQuestion', 'allowSelfDisclosure', 'conversationIntent', 'tone', 'relationshipIntensity', 'shouldCloseTopic', 'avoid', 'expression', 'sharedMemoryIds', 'sharedMemoryRevision', ...(context.constraints.adaptiveProfileEnabled ? ['selfDisclosureKeys', 'approvedSelfDisclosure'] : [])].map(key => [key, plan[key]]))
    const strategy = { ...behavior, relationshipStage: context.relationshipJourney.currentStage, relationshipEvidenceSummary: context.payload.relationshipEvidenceSummary, relationshipState: context.payload.relationshipState, relationshipStrategy: relationshipStrategy(current), action: plan.action, goal: plan.goal, focusMode: plan.focusMode, focusMessageId: plan.focusMessageId, focusSummary: plan.focusSummary, continuationStrategy: plan.continuationStrategy, engagementLevel: context.momentum?.engagement.level, selectedTopic: plan.selectedTopic, reason: plan.goal, stop: !plan.shouldReply, learningOpportunity: plan.learningOpportunity, needAdvisor: plan.needAdvisor, questionPressure: context.memory.relationshipMetrics.questionPressure, topics: [{ topic: plan.selectedTopic, reason: plan.goal }] }
    // Persist observations and plan even if generation later fails. No asking
    // attempt is recorded here: only actual outgoing history counts as asked.
    const latest = this.ai.storage.get()
    const contacts = (latest.contacts || []).map(item => {
      if (!sameContact(item, current, latest.contacts || [])) return item
      const memory = applyObservations(syncMemory(item, { incoming, now }), plan.observations, context.messages, now)
      memory.lastPlan = { ...strategy, at: now.toISOString() }
      memory.planHistory = [...memory.planHistory, memory.lastPlan].slice(-20)
      memory.summary = summarizeMemory(memory, context.messages)
      const learning = { ...item.learning, relationshipPlan: memory.lastPlan, ...(context.attention ? { conversationAttention: context.attention.state, conversationState: context.conversationState, conversationMomentum: context.momentum } : {}) }
      if (config.settings?.longTermMemory !== false) { learning.facts = compatibilityFacts(memory); learning.factsUpdatedAt = now.toISOString().slice(0, 10) }
      return { ...item, learning, ...(context.personaLens ? { personaLens: context.personaLens, relationshipState: context.relationshipState } : {}), ...(config.settings?.longTermMemory !== false ? { socialBrain: memory } : {}) }
    })
    if (contacts.some(item => sameContact(item, current, contacts))) this.ai.storage.update({ contacts })
    return { context: safeLegacyContext(refreshed, config.selfProfile, { approved: plan.approvedSelfDisclosure || [] }), strategy: jsonData(strategy), approvedSelfDisclosure: plan.approvedSelfDisclosure || [] }
  }

  maturePlan(scope, rawPlan, plannerText) {
    const plan = structuredClone(rawPlan)
    const { context, contact, config } = scope
    if (plannerText) parsePlan(plannerText, context)
    if (context.constraints.adaptiveProfileEnabled) plan.approvedSelfDisclosure = approveSelfDisclosure(config.selfProfile, context, plan)
    scope.approvedSelfDisclosure = plan.approvedSelfDisclosure || []
    if (context.personaLens) this.ai.storage.update({ contacts: (this.ai.storage.get().contacts || []).map(item => this.helpers.sameContact(item, contact, this.ai.storage.get().contacts || []) ? { ...item, personaLens: context.personaLens, relationshipState: context.relationshipState } : item) })
    return { plan: { ...plan, approvedSharedMemories: selectedSharedMemories(context, plan), relationshipStage: context.relationshipJourney.currentStage, relationshipEvidenceSummary: context.payload.relationshipEvidenceSummary, relationshipState: context.payload.relationshipState, relationshipStrategy: this.helpers.relationshipStrategy(contact) } }
  }

  generatedFocus(scope, { plan, text, at }) {
    const { contact: current, context } = scope
    const now = new Date(at)
    const { sameContact } = this.helpers
    if (text && plan.focusMessageId) this.ai.storage.update({ contacts: (this.ai.storage.get().contacts || []).map(item => {
      if (!sameContact(item, current, this.ai.storage.get().contacts || []) || item.learning?.relationshipPlan?.at !== now.toISOString()) return item
      const lastPlan = { ...item.learning.relationshipPlan, ...(context.constraints.adaptiveProfileEnabled ? { selfDisclosureKeys: plan.selfDisclosureKeys, approvedSelfDisclosure: plan.approvedSelfDisclosure } : {}), generatedReply: text }
      return { ...item, learning: { ...item.learning, relationshipPlan: lastPlan }, ...(item.socialBrain ? { socialBrain: { ...item.socialBrain, lastPlan, planHistory: item.socialBrain.planHistory.map(p => p.at === now.toISOString() ? lastPlan : p) } } : {}) }
    }) })
    return true
  }

  async eventFollowup({ contact, candidate, now = new Date() }) {
    const config = this.ai.storage.get()
    const context = buildContext({ contact, persona: config.selfPersona || {}, selfProfile: config.selfProfile, incoming: '', opening: true, skills: config.aiSkills || [], now })
    context.payload.task = '事件驱动的主动跟进'
    context.payload.proactiveCandidate = candidate
    return this.run({ mode: 'event', contact, config, context, incoming: '', legacy: {} })
  }

  eventPlan(scope, rawPlan, plannerText) {
    const plan = structuredClone(rawPlan)
    if (plannerText) parsePlan(plannerText, scope.context)
    if (scope.context.constraints.adaptiveProfileEnabled) plan.approvedSelfDisclosure = approveSelfDisclosure(scope.config.selfProfile, scope.context, plan)
    scope.approvedSelfDisclosure = plan.approvedSelfDisclosure || []
    return { plan: jsonData(plan), context: safeLegacyContext(scope.context, scope.config.selfProfile, { approved: plan.approvedSelfDisclosure || [] }) }
  }
}
module.exports = { ConversationOrchestrator }
