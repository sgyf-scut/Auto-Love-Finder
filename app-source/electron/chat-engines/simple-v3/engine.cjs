// SIMPLE_V3_CHAT: Context -> single model call -> public ChatEngineResult.
// No Storage, DOM, Sender, quota, Memory, Relationship or Planner capability.
// The injected `generate` dependency is the only way this engine reaches a model.
const { DEFAULT_SIMPLE_V3_CONFIG } = require('./config.cjs')
const { buildSimpleV3Messages } = require('./prompt.cjs')
const { parseSimpleV3Output } = require('./parser.cjs')

function createSimpleV3Engine({ generate, lifecycle = {}, config = {} } = {}) {
  if (typeof generate !== 'function') throw new TypeError('Simple V3 requires an injected generate(messages, options) dependency')
  const settings = { ...DEFAULT_SIMPLE_V3_CONFIG, ...config }
  const assertFresh = typeof lifecycle.assertFresh === 'function' ? lifecycle.assertFresh : async () => {}
  const stage = typeof lifecycle.stage === 'function' ? lifecycle.stage : () => {}

  return Object.freeze({
    async generateReply(chatContext) {
      if (!chatContext || typeof chatContext !== 'object') throw new TypeError('Simple V3 requires a ChatContext')
      const messages = buildSimpleV3Messages(chatContext, settings)
      const started = Date.now()
      await assertFresh()
      stage('WRITING')
      // One model call produces the final conversation content directly.
      const generated = await generate(messages, { temperature: settings.temperature, maxTokens: settings.maxTokens })
      await assertFresh()
      stage('READY_TO_SEND')
      const parsed = parseSimpleV3Output(generated?.text, { maxMessages: settings.maxMessages, maxMessageChars: settings.maxMessageChars })
      return {
        action: parsed.action,
        messages: parsed.messages,
        handoff: parsed.handoff,
        reason: parsed.reason,
        metadata: {
          engine: 'simple_v3',
          version: settings.version,
          model: generated?.model || '',
          provider: generated?.provider || '',
          aiLabel: generated?.aiLabel || '',
          usage: generated?.usage || null,
          latencyMs: Date.now() - started,
        },
      }
    },
  })
}

module.exports = { createSimpleV3Engine }
