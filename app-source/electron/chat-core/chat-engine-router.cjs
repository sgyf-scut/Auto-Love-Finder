const { DEFAULT_CHAT_ENGINE_CONFIG, createReadonlyChatContext, normalizeChatEngineResult } = require('./chat-types.cjs')

// Engine implementations are injected; Provider, Storage and Sender are not router capabilities.
// `simple_v3` is the production chat engine. `legacy` is kept only as an explicit
// emergency rollback: it is still selectable, but it never runs unless it is
// selected or the configured primary engine is unusable.
// Shadow may only run an engine that has no external side effects, so it is
// restricted to `simple_v3`.
const SUPPORTED_PRIMARY_ENGINES = Object.freeze(['legacy', 'simple_v3'])
const SHADOW_SAFE_ENGINES = Object.freeze(['simple_v3'])
const PRIMARY_ENGINE_ROLES = Object.freeze({ simple_v3: 'primary', legacy: 'rollback_only' })

function createChatEngineRouter({ engines = {}, config = {}, onDiagnostic = () => {} } = {}) {
  if (typeof onDiagnostic !== 'function') throw new TypeError('onDiagnostic must be a function')
  const diagnostics = []
  const instances = new Map()
  function emit(item) { diagnostics.push(item); onDiagnostic(item) }
  function resolveConfig(override = {}) {
    const requested = { ...DEFAULT_CHAT_ENGINE_CONFIG, ...config, ...override }
    const issues = []
    const requestedPrimary = typeof requested.primaryChatEngine === 'string' ? requested.primaryChatEngine : null
    const primaryChatEngine = SUPPORTED_PRIMARY_ENGINES.includes(requestedPrimary) ? requestedPrimary : 'legacy'
    if (primaryChatEngine !== requestedPrimary) issues.push({ code: 'CHAT_ENGINE_CONFIG_FALLBACK', requestedEngine: requestedPrimary, engine: 'legacy' })
    let shadowChatEngine = null
    let shadowEnabled = false
    const requestedShadow = typeof requested.shadowChatEngine === 'string' ? requested.shadowChatEngine : null
    if (requested.shadowEnabled === true && requestedShadow) {
      if (!SHADOW_SAFE_ENGINES.includes(requestedShadow)) issues.push({ code: 'CHAT_ENGINE_SHADOW_UNSUPPORTED', requestedEngine: requestedShadow, engine: null })
      else if (requestedShadow === primaryChatEngine) issues.push({ code: 'CHAT_ENGINE_SHADOW_DUPLICATE', requestedEngine: requestedShadow, engine: null })
      else { shadowChatEngine = requestedShadow; shadowEnabled = true }
    } else if (requested.shadowEnabled === true || requestedShadow != null) {
      issues.push({ code: 'CHAT_ENGINE_SHADOW_INCOMPLETE', requestedEngine: requestedShadow, engine: null })
    }
    return { primaryChatEngine, shadowChatEngine, shadowEnabled, diagnostics: issues }
  }
  async function getEngine(name) {
    if (!instances.has(name)) {
      const definition = engines[name]
      if (!definition) throw new Error(`${name === 'legacy' ? 'Legacy' : name} Chat Engine is not registered`)
      // Cache the promise as well, preventing concurrent calls from creating two engines.
      const pending = Promise.resolve().then(() => typeof definition === 'function' ? definition() : definition).then(engine => {
        if (!engine || typeof engine.generateReply !== 'function') throw new TypeError(`${name} Chat Engine must implement generateReply(context)`)
        return engine
      })
      instances.set(name, pending)
      pending.catch(() => { if (instances.get(name) === pending) instances.delete(name) })
    }
    return instances.get(name)
  }
  // A Shadow observes the same frozen input but can never throw, send or mutate.
  // Its failures are reported in the comparison record, never to the primary path.
  async function runShadow(name, input) {
    const started = Date.now()
    try {
      const engine = await getEngine(name)
      const normalized = normalizeChatEngineResult(await engine.generateReply(input))
      return { engine: name, ok: true, action: normalized.action, messages: normalized.messages, handoff: normalized.handoff,
        reason: normalized.reason, model: normalized.metadata.model || '', provider: normalized.metadata.provider || '',
        latencyMs: Date.now() - started, error: null }
    } catch (error) {
      return { engine: name, ok: false, action: null, messages: [], handoff: false, reason: null, model: '', provider: '',
        latencyMs: Date.now() - started, error: typeof error?.code === 'string' ? error.code : 'SHADOW_GENERATION_FAILED' }
    }
  }
  async function generateReply(context, override = {}) {
    const routing = resolveConfig(override)
    for (const diagnostic of routing.diagnostics) emit(diagnostic)
    const input = createReadonlyChatContext(context)
    const engine = await getEngine(routing.primaryChatEngine)
    // A primary generation failure propagates. Retrying in another engine could repeat side effects.
    const result = normalizeChatEngineResult(await engine.generateReply(input))
    const shadow = routing.shadowEnabled ? await runShadow(routing.shadowChatEngine, input) : null
    return { ...result, metadata: { ...result.metadata, engine: routing.primaryChatEngine, shadow,
      routing: { primaryChatEngine: routing.primaryChatEngine, shadowEnabled: routing.shadowEnabled,
        primaryEngineRole: PRIMARY_ENGINE_ROLES[routing.primaryChatEngine] || null, diagnostics: routing.diagnostics } } }
  }
  return { generateReply, resolveConfig, getDiagnostics: () => diagnostics.map(item => ({ ...item })) }
}

module.exports = { createChatEngineRouter, DEFAULT_CHAT_ENGINE_CONFIG, SUPPORTED_PRIMARY_ENGINES, SHADOW_SAFE_ENGINES, PRIMARY_ENGINE_ROLES }
