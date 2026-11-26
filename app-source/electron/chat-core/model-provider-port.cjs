// Provider capabilities remain outside Chat Engine. Credentials, HTTP transport,
// cooldowns and provider diagnostics are held only by this closure.
function createModelProviderPort(ai, configuredProviders, { assertFresh = async () => {}, helpers = {} } = {}) {
  const {
    isWeakTextModel, isVisionCapable, apiBase, replyMaxTokens,
    isMaxTokensReject, isMultiImageLimitError, choiceText, isNoReplyDecision,
  } = helpers
  const providers = (configuredProviders || []).map(provider => ({ ...provider }))
  const labelFor = helpers.aiLabel || (provider => `AI · ${provider?.model || provider?.name || '当前模型'}`)
  const describe = provider => Object.freeze({ name: provider.name, model: provider.model, aiLabel: labelFor(provider) })
  const post = (provider, messages, temperature, maxTokens, retries, timeoutMs) => ai.postProfileChat(
    `${apiBase(provider.baseUrl)}/chat/completions`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.keyFor(provider)}` } },
    JSON.stringify({ model: provider.model, messages, temperature, max_tokens: maxTokens }),
    { retries, timeoutMs },
  )

  return Object.freeze({
    completion: (...args) => ai.profileChatCompletion(...args),
    createSession() {
      let actualProvider
      return Object.freeze({
        async generate(messages, genFrames, recordUsage) {
          let out
          let lastError
          actualProvider = undefined
          // Decide whether all configured models are weak before applying cooldowns.
          // A cooling strong model must never promote a weak model into text generation.
          const fullPool = ai.providerPool(providers)
          const strongPool = fullPool.filter(provider => !isWeakTextModel(provider))
          const configuredStrong = providers.filter(provider => !isWeakTextModel(provider))
          const allWeakConfigured = providers.length > 0 && configuredStrong.length === 0
          const generationPool = strongPool.length ? strongPool : (allWeakConfigured ? fullPool : [])
          for (const candidate of generationPool) {
            await assertFresh()
            try {
              const budget = replyMaxTokens(candidate.model)
              const candidateMessages = isVisionCapable(candidate) ? messages : messages.map(row => Array.isArray(row.content)
                ? { ...row, content: row.content.filter(part => part.type !== 'image_url') } : row)
              try {
                out = await post(candidate, candidateMessages, 0.85, budget, 1, 18000)
              } catch (budgetError) {
                if (budget > 1000 && isMaxTokensReject(budgetError)) {
                  out = await post(candidate, candidateMessages, 0.85, 1000, 1, 18000)
                } else {
                  throw budgetError
                }
              }
              if (!choiceText(out) && !isNoReplyDecision(String(out?.choices?.[0]?.message?.content || ''))) throw new Error('模型接口已响应，但没有返回有效的回复内容')
              actualProvider = candidate
              recordUsage(out)
              ai.noteProviderSuccess(candidate)
              break
            } catch (error) {
              if (isMultiImageLimitError(error) && genFrames.length > 1) {
                try {
                  const singleMessages = messages.map(row => Array.isArray(row.content)
                    ? { ...row, content: row.content.filter(part => part.type !== 'image_url').concat(row.content.filter(part => part.type === 'image_url').slice(0, 1)) } : row)
                  out = await post(candidate, singleMessages, 0.85, replyMaxTokens(candidate.model), 1, 18000)
                  if (!choiceText(out)) throw new Error('模型接口已响应，但没有返回有效的回复内容')
                  actualProvider = candidate
                  recordUsage(out)
                  ai.noteProviderSuccess(candidate)
                  break
                } catch (retryError) {
                  lastError = retryError
                  ai.noteProviderFailure(candidate, retryError)
                  continue
                }
              }
              lastError = error
              ai.noteProviderFailure(candidate, error)
              ai.storage.addLog?.({ type: 'ai_provider_failed', message: `${candidate.name || candidate.model} 生成失败，正在尝试备用模型`, detail: { model: candidate.model, provider: candidate.name, error: error.message } })
            }
          }
          await assertFresh()
          if (!actualProvider || !out) throw lastError || new Error('没有可用的 AI 模型')
          return { provider: describe(actualProvider), out }
        },
        rewrite(messages, { temperature, maxTokens, retries, timeoutMs } = {}) {
          if (!actualProvider) throw new Error('尚未选择生成回复的 AI 模型')
          return post(actualProvider, messages, temperature, maxTokens, retries, timeoutMs)
        },
      })
    },
  })
}

module.exports = { createModelProviderPort }
