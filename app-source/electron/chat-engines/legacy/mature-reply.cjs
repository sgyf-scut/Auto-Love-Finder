// LEGACY_CHAT: original mature-friend Writer and quality/rewrite behavior.
async function generateMatureReply(chatContext, { session, lifecycle, effects, helpers }) {
  const { buildChatMessages, isFriendshipContact, textExpression, cleanGeneratedText, choiceText, isNoReplyDecision, stripTrailingPeriod, clampCasualText, isReasoningLeak, replyQualityIssues, emojiGuidance, normalizeLearnedMessages, stripAiPrefix, sharesLongSubstring, isHollowOrMeta } = helpers
  const { current: contactWithTone, config, incoming, genMedia, genFrames, mediaAnalysis, hasMediaContext, oldFriendPlan, usageTracker, started, showAiModelLabel, adaptiveProfileEnabled } = structuredClone(chatContext.metadata.legacy)
  const contact = contactWithTone
  const selfProfileRevision = chatContext.metadata.selfProfileRevision
  const recordUsage = res => { const u = res?.usage && ['prompt', 'completion', 'total'].some(key => key in res.usage) ? res.usage : helpers.extractUsage(res); if (u) { usageTracker.prompt += u.prompt || 0; usageTracker.completion += u.completion || 0; usageTracker.total += u.total || ((u.prompt || 0) + (u.completion || 0)) } }
  const log = entry => effects.dispatch({ phase: 'REPLY_DECIDED', type: 'LOG', entry })
    lifecycle.assertSharedMemorySelection(contactWithTone.id, oldFriendPlan?.sharedMemoryIds || [], oldFriendPlan?.sharedMemoryRevision)
    const messages = buildChatMessages(contactWithTone, incoming, genMedia, mediaAnalysis.text, config.aiSkills || [])
    if (messages[0]?.role === 'system') messages[0].content += `\n本轮仅可使用的已验证共同关系经历：${JSON.stringify(oldFriendPlan?.approvedSharedMemories || [])}。这是独立的共同关系记忆，不是Self Profile；未选中记忆不使用，不从历史本人消息或样例编造共同活动。双方都去过/都喜欢不等于一起去过/一起玩过。可自然回访也可不用，PRIVATE仍禁止。`
    if (adaptiveProfileEnabled && messages[0]?.role === 'system') messages[0].content += `\n本人资料只允许approvedSelfDisclosure：${JSON.stringify(oldFriendPlan?.approvedSelfDisclosure || [])}。历史me消息/样例仅参考表达，不能当真实经历来源，未批准的具体个人经历、年级、成绩不得编造。Persona Lens只影响表达倾向：${JSON.stringify(contactWithTone.personaLens || {})}`
    if (oldFriendPlan && messages[0]?.role === 'system') messages[0].content += `\n本轮社交行为许可：${JSON.stringify({ relationshipStage: oldFriendPlan.relationshipStage, relationshipEvidenceSummary: oldFriendPlan.relationshipEvidenceSummary, relationshipState: oldFriendPlan.relationshipState, action: oldFriendPlan.action, goal: oldFriendPlan.goal, allowQuestion: oldFriendPlan.allowQuestion, allowSelfDisclosure: oldFriendPlan.allowSelfDisclosure, shouldCloseTopic: oldFriendPlan.shouldCloseTopic, relationshipIntensity: oldFriendPlan.relationshipIntensity })}。遵守这些许可，仍按本人已有风格写文字，禁止写表情槽位或表情占位标记。`
    await lifecycle.assertFresh()
    lifecycle.stage('WRITING')

    const { provider, out } = await session.generate(messages, genFrames, recordUsage)
    await lifecycle.assertFresh()
    lifecycle.stage('READY_TO_SEND')
    await lifecycle.assertFresh()
    if (!provider || !out) throw new Error('没有可用的 AI 模型')

    const rawReply = choiceText(out) || ''
    // 模型输出"[不回复]"时 cleanGeneratedText 会返回空串，必须先按原始内容判断跳过决策，
    // 否则会掉进"没有生成有效回复"的异常分支（旧版缺陷：不回复决策被当成 AI 故障）
    const rawContent = String(out?.choices?.[0]?.message?.content || '')
    if (!rawReply && isNoReplyDecision(rawContent)) {
      await log({ type: 'ai_reply_skipped', message: `AI 判断当前不适合回复 ${contact?.name || '联系人'}`, detail: { elapsedMs: Date.now() - started, model: provider.model, tokens: usageTracker } })
      return { ok: true, text: '', labeledText: '', skipped: true, model: provider.model, provider: provider.name, aiLabel: provider.aiLabel, showAiModelLabel, elapsedMs: Date.now() - started, tokens: usageTracker }
    }
    if (isNoReplyDecision(rawReply)) {
      await log({ type: 'ai_reply_skipped', message: `AI 判断当前不适合回复 ${contact?.name || '联系人'}`, detail: { elapsedMs: Date.now() - started, model: provider.model, tokens: usageTracker } })
      return { ok: true, text: '', labeledText: '', skipped: true, model: provider.model, provider: provider.name, aiLabel: provider.aiLabel, showAiModelLabel, elapsedMs: Date.now() - started, tokens: usageTracker }
    }

    let text = cleanGeneratedText(rawReply)
    if (!text) throw new Error('模型没有生成有效回复')
    text = stripTrailingPeriod(clampCasualText(text, 40))
    if (isReasoningLeak(text)) {
      await log({ type: 'ai_reply_rejected', message: `${contact?.name || '联系人'} 的回复疑似模型思考过程，已拦截拒发`, detail: { rejectedText: text.slice(0, 120), model: provider.model, tokens: usageTracker } })
      return { ok: true, text: '', labeledText: '', skipped: true, rejected: true, model: provider.model, provider: provider.name, aiLabel: provider.aiLabel, showAiModelLabel, elapsedMs: Date.now() - started, tokens: usageTracker }
    }

    const initialQualityIssues = replyQualityIssues(text, hasMediaContext, contactWithTone._allowEmoji)
    let rewritten = false
    if (initialQualityIssues.length) {
      try {
        // 改写上下文轻量化：不重复发送整包长篇背景与视频评论，节省大量 Token
        const rewriteMessages = [
          { role: 'system', content: `你是一名在抖音私信聊天的真人。上一句候选回复有以下问题：${initialQualityIssues.join('、')}。请保留核心意思，改成更像${isFriendshipContact(contactWithTone) ? '刚认识的新朋友自然聊天' : '熟人随口说'}的一条自然短句（6到18个字）。不要解释，只输出改写正文。${emojiGuidance(contactWithTone)}` },
          { role: 'user', content: incoming ? `对方说：${incoming.slice(0, 60)}` : '对方发来了一个视频' },
          { role: 'assistant', content: text },
          { role: 'user', content: '改写为极简口语短句：' },
        ]
        const revised = await session.rewrite(rewriteMessages, { temperature: 0.65, maxTokens: 100, retries: 1, timeoutMs: 12000 })
        recordUsage(revised)
        const revisedText = cleanGeneratedText(choiceText(revised))
        if (revisedText && replyQualityIssues(revisedText, hasMediaContext, contactWithTone._allowEmoji).length < initialQualityIssues.length) {
          text = revisedText
          rewritten = true
        }
      } catch (error) {
        await log({ type: 'ai_natural_rewrite_failed', message: `${provider.name || provider.model} 自然化重写失败，保留原回复`, detail: { provider: provider.name, error: error.message } })
      }
    }
    // 终检：攻击性/刻薄/空壳/元话语/Markdown 残留 → 整条拒发（宁可不说）
    const finalIssues = replyQualityIssues(text, hasMediaContext, contactWithTone._allowEmoji).filter((issue) => /攻击性|刻薄评判|内容空洞|元话语|Markdown|残缺标签|未完结标点|缺少有效对话/.test(issue))
    if (finalIssues.length) {
      await log({ type: 'ai_reply_rejected', message: `${contact?.name || '联系人'} 的回复未通过终检被拦截拒发`, detail: { rejectedText: text, issues: finalIssues, rewritten, model: provider.model, tokens: usageTracker } })
      return { ok: true, text: '', labeledText: '', skipped: true, rejected: true, model: provider.model, provider: provider.name, aiLabel: provider.aiLabel, showAiModelLabel, elapsedMs: Date.now() - started, tokens: usageTracker }
    }
    // 软性问题兜底：客服腔针对性改写
    const softIssues = replyQualityIssues(text, hasMediaContext, contactWithTone._allowEmoji).filter((issue) => /AI 腔|说明性前缀/.test(issue))
    if (softIssues.length) {
      try {
        // 改写上下文轻量化
        const rewriteMessages = [
          { role: 'system', content: `你是一名在抖音聊私信的真人。上一句有说明文/客服腔（${softIssues.join('、')}）。请彻底重写成一句${isFriendshipContact(contactWithTone) ? '刚认识的新朋友自然聊天' : '熟人间随口说'}的话：1句、6到18字，禁止任何客服腔与总结说教，只输出纯文本。${emojiGuidance(contactWithTone)}` },
          { role: 'user', content: incoming ? `对方说：${incoming.slice(0, 60)}` : '对方发来了一个视频' },
          { role: 'assistant', content: text },
          { role: 'user', content: isFriendshipContact(contactWithTone) ? '改写为刚认识的人自然聊天的话：' : '改写为熟人随口话：' },
        ]
        const revised = await session.rewrite(rewriteMessages, { temperature: 0.7, maxTokens: 100, retries: 1, timeoutMs: 12000 })
        recordUsage(revised)
        const revisedText = cleanGeneratedText(choiceText(revised))
        if (revisedText && !replyQualityIssues(revisedText, hasMediaContext, contactWithTone._allowEmoji).some((issue) => /攻击性|刻薄评判|内容空洞|元话语|Markdown|AI 腔|说明性前缀|残缺标签|未完结标点|缺少有效对话/.test(issue))) {
          text = revisedText
          rewritten = true
        } else {
          await log({ type: 'ai_reply_rejected', message: `${contact?.name || '联系人'} 的回复重写后仍是客服腔，已拦截拒发`, detail: { rejectedText: text, issues: softIssues, model: provider.model, tokens: usageTracker } })
          return { ok: true, text: '', labeledText: '', skipped: true, rejected: true, model: provider.model, provider: provider.name, aiLabel: provider.aiLabel, showAiModelLabel, elapsedMs: Date.now() - started, tokens: usageTracker }
        }
      } catch (error) {
        await log({ type: 'ai_reply_rejected', message: `${contact?.name || '联系人'} 的回复为客服腔且改写调用失败，已拦截拒发`, detail: { rejectedText: text, issues: softIssues, error: error.message, model: provider.model, tokens: usageTracker } })
        return { ok: true, text: '', labeledText: '', skipped: true, rejected: true, model: provider.model, provider: provider.name, aiLabel: provider.aiLabel, showAiModelLabel, elapsedMs: Date.now() - started, tokens: usageTracker }
      }
    }
    // 连续复读守卫：轻量化重写
    const historyMsgs = normalizeLearnedMessages(contactWithTone.learning?.messages)
    const lastMine = stripAiPrefix(historyMsgs.filter((m) => m.role === 'me').at(-1)?.text || '')
    if (lastMine && (text === lastMine || sharesLongSubstring(text, lastMine, 5))) {
      try {
        const rewriteMessages = [
          { role: 'system', content: `你上一条已经发过「${lastMine.slice(0, 30)}」，这句和它重复了。换个角度重新随口回一句（6到18字），不要重复上一条的内容和句式；只输出改写后的正文。${emojiGuidance(contactWithTone)}` },
          { role: 'user', content: incoming ? `对方说：${incoming.slice(0, 60)}` : '对方发来了一个视频' },
          { role: 'assistant', content: text },
          { role: 'user', content: '换角度随口回一句（不要重复上一条）：' },
        ]
        const revised = await session.rewrite(rewriteMessages, { temperature: 0.9, maxTokens: 100, retries: 1, timeoutMs: 12000 })
        recordUsage(revised)
        const revisedText = cleanGeneratedText(choiceText(revised))
        if (revisedText && !(revisedText === lastMine || sharesLongSubstring(revisedText, lastMine, 5))) {
          text = revisedText
          rewritten = true
          await log({ type: 'ai_draft', message: `${contact?.name || '联系人'} 的回复与上一条重复，已自动换角度重写`, detail: { previous: lastMine.slice(0, 40), revised: text.slice(0, 40), tokens: usageTracker } })
        }
      } catch { /* 复读守卫重写失败不影响主流程 */ }
    }
    // 双消息（允许而非必须）：真人常连发两条。轻量化追发，极大减少重复 Token
    let text2 = ''
    // Legacy read this preference after quality checks, not at turn start.
    const writerSettings = await effects.dispatch({ phase: 'REPLY_DECIDED', type: 'WRITER_SETTINGS' })
    const twoChanceRaw = Number(writerSettings.twoMessageChance)
    const baseChance = Number.isFinite(twoChanceRaw) ? Math.min(1, Math.max(0, twoChanceRaw)) : 0.35
    const twoChance = hasMediaContext ? Math.max(baseChance, 0.65) : baseChance
    if (twoChance > 0 && Math.random() < twoChance) {
      try {
        // 极轻量级追发上下文：仅传入上一句简短对话，不带 3000 tokens 冗余长背景，单次追发立省 97% Token
        const followMessages = [
          { role: 'system', content: '你是刚才在抖音私信发消息的真人。现在紧跟着上一句随口追发第二条超短随口吐槽（半句话或一个词，3到8个字，如“太离谱了”、“笑死我了”、“真的假的”等）。绝不开新话题，绝不解释第一句，不要任何引号标点。只输出这句纯文本。' },
          { role: 'user', content: incoming ? `对方说：${incoming.slice(0, 50)}` : '对方发来了一个视频' },
          { role: 'assistant', content: text },
          { role: 'user', content: '再补一条更短的随口话（3~8字）：' },
        ]
        const revised2 = await session.rewrite(followMessages, { temperature: 1.0, maxTokens: 40, retries: 0, timeoutMs: 10000 })
        recordUsage(revised2)
        const t2 = cleanGeneratedText(choiceText(revised2))
        if (t2 && !isReasoningLeak(t2) && !isHollowOrMeta(t2) && !sharesLongSubstring(t2, text, 4) && replyQualityIssues(t2, hasMediaContext, contactWithTone._allowEmoji).length === 0) {
          text2 = stripTrailingPeriod(clampCasualText(t2, 16))
        }
      } catch { text2 = '' }
    }
    lifecycle.assertProfileRevision(selfProfileRevision)
    lifecycle.assertSharedMemorySelection(contactWithTone.id, oldFriendPlan?.sharedMemoryIds || [], oldFriendPlan?.sharedMemoryRevision)
    lifecycle.assertProfileReply(text, oldFriendPlan?.approvedSelfDisclosure || [])
    lifecycle.assertProfileReply(text2, oldFriendPlan?.approvedSelfDisclosure || [])
    const label = provider.aiLabel
    const tokenNotice = usageTracker.total > 0 ? ` (消耗 ${usageTracker.total} tokens: 输入${usageTracker.prompt}/输出${usageTracker.completion})` : ''
    await log({ type: 'ai_draft', message: `已为 ${contact?.name || '联系人'} 生成 AI 草稿${tokenNotice}`, detail: { elapsedMs: Date.now() - started, tokens: usageTracker, video: hasMediaContext, videoFrames: genFrames.length, mediaAnalysis: mediaAnalysis.text || '', model: provider.model, provider: provider.name, naturalRewrite: rewritten } })
    return { ok: true, selfProfileRevision: selfProfileRevision, text, text2, expression: oldFriendPlan?.expression || textExpression(), ...(oldFriendPlan ? { strategy: oldFriendPlan, relationshipJourney: contactWithTone.relationshipJourney, personaLens: contactWithTone.personaLens, relationshipState: contactWithTone.relationshipState } : {}), labeledText: showAiModelLabel ? `【${provider.aiLabel}】${text}` : text, model: provider.model, provider: provider.name, aiLabel: label, showAiModelLabel, elapsedMs: Date.now() - started, tokens: usageTracker }
}
module.exports = { generateMatureReply }
