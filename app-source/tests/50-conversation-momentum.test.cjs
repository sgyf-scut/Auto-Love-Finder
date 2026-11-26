const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ATTENTION_WINDOW_MS, LEVELS, STRATEGIES, buildConversationMomentum } = require('../electron/social-brain/conversation-momentum.cjs')
const now = Date.parse('2026-10-12T12:00:00+08:00')
const rows = items => items.map(([role, text], index) => ({ id: `m${index}`, role, text, at: new Date(now - (items.length - index) * 10000).toISOString() }))
const focus = { recommendedMode: 'RESPOND_FOCUS', selectedFocus: { messageId: 'focus', directQuestion: 0 } }
const run = (messages, extra = {}) => buildConversationMomentum({ messages, attention: focus, now, ...extra })
const lively = () => rows([
  ['contact', '我最近一直在准备考研，每天学到十一点，还得找时间复习英语'],
  ['me', '我今天也忙了一天，不过晚饭后散步了一会'],
  ['contact', '我现在数学进展还不错，做题的时候终于能看到一点提升'],
  ['me', '这段进步也挺值得高兴，慢慢来就会有方向'],
  ['contact', '我这周打算把剩下的章节完成，再做两套模拟题试试效果'],
])
const returns = () => ({ returnCandidates: [{ id: 'r', topicId: 't', summary: '尚未说完的周末计划', sourceMessageIds: ['m0'], openPointIds: ['p0'], confidence: 0.9, allowedNow: true }] })

test('momentum API restricts levels and strategies with five minute window', () => {
  assert.deepEqual(LEVELS, ['HIGH', 'MEDIUM', 'LOW', 'ENDING'])
  assert.equal(STRATEGIES.length, 7); assert.equal(ATTENTION_WINDOW_MS, 300000)
  const result = run(lively())
  assert.ok(LEVELS.includes(result.engagement.level)); assert.ok(STRATEGIES.includes(result.continuation.strategy))
  assert.equal(result.updatedAt, new Date(now).toISOString())
})
test('substantive bilateral exchanges result in HIGH engagement and deepen selected focus', () => {
  const result = run(lively())
  assert.equal(result.engagement.level, 'HIGH'); assert.equal(result.continuation.strategy, 'DEEPEN')
  assert.ok(result.engagement.reasons.some(reason => reason.includes('双方')))
})
test('consecutive acknowledgements and laughter reduce engagement to LOW', () => {
  const result = run(rows([['me', '今天做题感觉怎么样'], ['contact', '嗯'], ['me', '看看答案慢慢来'], ['contact', '哈哈'], ['contact', '还行']]))
  assert.equal(result.engagement.level, 'LOW'); assert.equal(result.continuation.strategy, 'NO_REPLY'); assert.equal(result.continuation.allowQuestion, false)
})
test('mixed short acknowledgement tokens are not counted as substantive content', () => {
  const result = run(rows([['contact', '嗯哈哈还行'], ['contact', '还行哈哈'], ['contact', '嗯嗯']]))
  assert.equal(result.engagement.level, 'LOW'); assert.equal(result.reciprocity.selfDisclosureByOther, 0)
})
test('one reaction after rich exchanges does not automatically imply low engagement', () => {
  const result = run([...lively(), ...rows([['contact', '哈哈']]).map(message => ({ ...message, id: 'ack' }))])
  assert.notEqual(result.engagement.level, 'LOW'); assert.equal(result.continuation.strategy, 'DEEPEN')
})
test('explicit sleeping message is ENDING and never reopens previous topic', () => {
  const messages = [...lively(), { id: 'sleep', role: 'contact', text: '我先睡了', at: new Date(now).toISOString() }]
  const result = run(messages, { state: returns() })
  assert.equal(result.engagement.level, 'ENDING'); assert.equal(result.continuation.strategy, 'CLOSE'); assert.equal(result.continuation.allowQuestion, false)
  assert.equal(result.attentionWindow.active, false)
})
test('explicit refusal prefers silence even during a previously lively exchange', () => {
  const result = run([...lively(), { id: 'stop', role: 'contact', text: '别再发消息了', at: new Date(now).toISOString() }], { state: returns() })
  assert.equal(result.engagement.level, 'ENDING'); assert.equal(result.continuation.strategy, 'NO_REPLY')
})
test('elapsed time reduces current conversation score without changing prior input', () => {
  const messages = lively(); const before = JSON.stringify(messages)
  const recent = run(messages), old = run(messages, { now: now + 3600000 })
  assert.ok(old.engagement.score < recent.engagement.score); assert.equal(JSON.stringify(messages), before)
})
test('two unilateral owner messages reduce engagement and do not trigger another outgoing message', () => {
  const result = run([...lively(), ...rows([['me', '你现在怎么样？'], ['me', '还在准备吗？']]).map((message, index) => ({ ...message, id: `unanswered${index}` }))])
  assert.equal(result.continuation.strategy, 'NO_REPLY'); assert.equal(result.continuation.allowQuestion, false); assert.equal(result.attentionWindow.active, false)
})
test('observable disclosures and questions are counted independently for both sides', () => {
  const result = run(rows([['contact', '我今天去看了展'], ['me', '我昨天在家看书'], ['contact', '你喜欢哪类书？'], ['me', '你喜欢看展吗？'], ['contact', '我也喜欢历史书']]))
  assert.deepEqual(result.reciprocity, { questionsByMe: 1, questionsByOther: 1, selfDisclosureByMe: 1, selfDisclosureByOther: 2, windowTurns: 5 })
})
test('an owner question mentioning me is not a self disclosure', () => {
  const result = run(rows([['me', '我也去过吗？'], ['contact', '我今天去公园了']]))
  assert.equal(result.reciprocity.selfDisclosureByMe, 0)
})
test('quoted owner first person statements are not treated as owner self disclosures', () => {
  const result = run(rows([['me', '他说：“我最近去了北京”'], ['contact', '我昨天去了上海']]))
  assert.equal(result.reciprocity.selfDisclosureByMe, 0)
})
test('AI outgoing history measures actual reciprocity but never becomes persona evidence', () => {
  const messages = rows([['me', '我昨天去过北京'], ['contact', '我最近想考研']])
  messages[0].origin = 'ai'; const result = run(messages)
  assert.equal(result.reciprocity.selfDisclosureByMe, 1); assert.equal(result.continuation.preferSelfDisclosure, false)
})
const interrogating = () => rows([['me', '你准备去哪？'], ['contact', '我想去北京'], ['me', '你有目标学校吗？'], ['contact', '北航吧，不过感觉挺难'], ['me', '你数学复习怎么样？'], ['contact', '我最近天天刷题，基础部分已经完成了']])
test('repeated questions with no real persona do not recommend fabricated personal sharing', () => {
  const result = run(interrogating())
  assert.equal(result.continuation.strategy, 'LIGHT_HOOK'); assert.equal(result.continuation.preferSelfDisclosure, false); assert.equal(result.continuation.allowQuestion, false)
})
test('repeated questions with explicit owner experiences prefer SHARE with no extra question', () => {
  const result = run(interrogating(), { selfPersona: { experiences: '我去年准备过研究生考试' } })
  assert.equal(result.continuation.strategy, 'SHARE'); assert.equal(result.continuation.preferSelfDisclosure, true); assert.equal(result.continuation.allowQuestion, false)
})
test('persona fields containing only ids or dates cannot authorize self disclosure', () => {
  const result = run(interrogating(), { selfPersona: { experiences: [{ id: 'experience', at: '2026-10-12' }] } })
  assert.notEqual(result.continuation.strategy, 'SHARE'); assert.equal(result.continuation.preferSelfDisclosure, false)
})
test('explicit structured user experience is accepted while unverified experience is not', () => {
  const trusted = run(interrogating(), { selfPersona: { experiences: [{ text: '去年考过研究生', verified: true }] } })
  const unknown = run(interrogating(), { selfPersona: { experiences: [{ text: '去年考过研究生', verified: false }] } })
  assert.equal(trusted.continuation.strategy, 'SHARE'); assert.notEqual(unknown.continuation.strategy, 'SHARE')
})
test('two owner question turns prohibit another question even when directly answering', () => {
  const result = run([...interrogating().slice(0, -1), { id: 'q', role: 'contact', text: '你觉得北航怎么样？', at: new Date(now).toISOString() }])
  assert.equal(result.continuation.strategy, 'ANSWER'); assert.equal(result.continuation.allowQuestion, false)
})
test('low engagement still answers an explicit contact question without asking back', () => {
  const messages = rows([['contact', '嗯'], ['contact', '哈哈'], ['contact', '还行'], ['contact', '你在哪个城市？']])
  const result = run(messages, { now: now + 3600000 })
  assert.equal(result.engagement.level, 'LOW'); assert.equal(result.continuation.strategy, 'ANSWER'); assert.equal(result.continuation.allowQuestion, false)
})
test('low engagement may respond lightly to substantive new content rather than ignore it', () => {
  const result = run(rows([['contact', '我最近养了一只小猫']]), { now: now + 3600000 })
  assert.equal(result.engagement.level, 'LOW'); assert.equal(result.continuation.strategy, 'LIGHT_HOOK'); assert.equal(result.continuation.allowQuestion, false)
})
test('recent meaningful bilateral exchange establishes a five minute window', () => {
  const result = run(lively())
  assert.equal(result.attentionWindow.active, true); assert.equal(result.attentionWindow.continuityBoost, 0.08)
  assert.equal(Date.parse(result.attentionWindow.expiresAt) - Date.parse(result.attentionWindow.lastInteractionAt), ATTENTION_WINDOW_MS)
})
test('attention window expires exactly five minutes after last meaningful exchange', () => {
  const messages = lively(), last = Date.parse(messages.at(-1).at)
  const result = run(messages, { now: last + ATTENTION_WINDOW_MS })
  assert.equal(result.attentionWindow.active, false); assert.equal(result.attentionWindow.continuityBoost, 0)
})
test('fresh reactions do not extend a window established by substantive exchanges', () => {
  const messages = lively(), prior = run(messages)
  const result = run([...messages, { id: 'newReaction', role: 'contact', text: '哈哈', at: new Date(now + 240000).toISOString() }], { now: now + 300000 })
  assert.equal(result.attentionWindow.lastInteractionAt, prior.attentionWindow.lastInteractionAt)
  assert.equal(result.attentionWindow.expiresAt, prior.attentionWindow.expiresAt); assert.equal(result.attentionWindow.active, false)
})
test('single sided content cannot establish bilateral attention window', () => {
  assert.equal(run(rows([['contact', '我今天去看展了'], ['contact', '我喜欢那幅画']])).attentionWindow.active, false)
})
test('missing timestamps do not manufacture a recent attention window', () => {
  const result = run(lively().map(({ at, ...message }) => message))
  assert.equal(result.attentionWindow.active, false); assert.equal(result.attentionWindow.lastInteractionAt, null)
})
test('future timestamps cannot establish a current attention window', () => {
  const result = run(lively().map(message => ({ ...message, at: new Date(now + 30000).toISOString() })))
  assert.equal(result.attentionWindow.active, false)
})
test('duplicate message identifiers do not accumulate score or continuity boost', () => {
  const messages = lively(), result = run(messages)
  const duplicate = run(messages.flatMap(message => [message, { ...message }]), { previousMomentum: result })
  assert.deepEqual(duplicate, result)
})
test('previous momentum does not keep an acknowledgement-only history active', () => {
  const result = run(rows([['contact', '嗯'], ['contact', '哈哈']]), { previousMomentum: run(lively()) })
  assert.equal(result.attentionWindow.active, false); assert.equal(result.continuation.strategy, 'NO_REPLY')
})
test('failed media cannot add emotional engagement or social meaning', () => {
  const result = run([{ id: 'image', role: 'contact', type: 'image', text: '[图片]', at: new Date(now).toISOString(), interpretation: { understandingStatus: 'failed', confidence: 0.99, socialMeaning: '表达强烈的聊天兴趣', visualDescription: '我正在北京备考', emotion: ['excited'] } }])
  assert.equal(result.engagement.level, 'LOW'); assert.equal(result.continuation.strategy, 'NO_REPLY'); assert.equal(result.reciprocity.selfDisclosureByOther, 0)
})
test('return strategy requires genuine supplied open point and no competing selected focus', () => {
  const messages = [...lively(), { id: 'ack', role: 'contact', text: '好', at: new Date(now).toISOString() }]
  const result = run(messages, { attention: { recommendedMode: 'START_NEW_TOPIC', selectedFocus: null }, state: returns() })
  assert.equal(result.continuation.strategy, 'RETURN_TOPIC')
  assert.notEqual(run(messages, { state: returns() }).continuation.strategy, 'RETURN_TOPIC')
})
test('invalid, disallowed or resolved return candidates cannot authorize return', () => {
  const messages = [...lively(), { id: 'ack', role: 'contact', text: '好', at: new Date(now).toISOString() }]
  for (const patch of [{ allowedNow: false }, { openPointIds: [] }, { sourceMessageIds: [] }, { status: 'resolved' }, { resolved: true }]) {
    const state = returns(); Object.assign(state.returnCandidates[0], patch)
    assert.notEqual(run(messages, { attention: { recommendedMode: 'START_NEW_TOPIC', selectedFocus: null }, state }).continuation.strategy, 'RETURN_TOPIC')
  }
})
test('repeated acknowledgements do not repeatedly return to an unfinished topic', () => {
  const messages = [...lively(), ...rows([['contact', '好'], ['contact', '行']]).map((message, index) => ({ ...message, id: `ack${index}` }))]
  assert.notEqual(run(messages, { attention: { recommendedMode: 'START_NEW_TOPIC', selectedFocus: null }, state: returns() }).continuation.strategy, 'RETURN_TOPIC')
})
test('router silence wins over high engagement and existing return candidates', () => {
  const result = run(lively(), { attention: { recommendedMode: 'NO_REPLY', selectedFocus: null }, state: returns() })
  assert.equal(result.continuation.strategy, 'NO_REPLY'); assert.equal(result.attentionWindow.active, false)
})
test('State can recommend a grounded return after natural ACK when router has no focus', () => {
  const messages = [...lively(), { id: 'ack', role: 'contact', text: '好', at: new Date(now).toISOString() }]
  const result = run(messages, { attention: { recommendedMode: 'NO_REPLY', selectedFocus: null }, state: returns() })
  assert.equal(result.continuation.strategy, 'RETURN_TOPIC')
})
test('confirmed natural topic end allows grounded return without rewriting original classification', () => {
  const messages = [...lively(), { id: 'done', role: 'contact', text: '这个搞定了', at: new Date(now).toISOString() }]
  const attention = { recommendedMode: 'NO_REPLY', selectedFocus: null, naturalTopicEnd: true }
  const result = run(messages, { attention, state: returns() })
  assert.equal(result.continuation.strategy, 'RETURN_TOPIC'); assert.equal(result.continuation.allowQuestion, true)
  assert.equal(result.attentionWindow.active, false)
  assert.equal(messages.at(-1).text, '这个搞定了')
})
test('natural topic end without a genuine return candidate cannot bypass router silence', () => {
  const messages = [...lively(), { id: 'done', role: 'contact', text: '这个搞定了', at: new Date(now).toISOString() }]
  const result = run(messages, { attention: { recommendedMode: 'NO_REPLY', selectedFocus: null, naturalTopicEnd: true }, state: { returnCandidates: [] } })
  assert.equal(result.continuation.strategy, 'NO_REPLY'); assert.equal(result.continuation.allowQuestion, false)
})
test('whole conversation closing beats natural thread end flag and genuine return candidate', () => {
  const messages = [...lively(), { id: 'sleep', role: 'contact', text: '睡了', at: new Date(now).toISOString() }]
  const result = run(messages, { attention: { recommendedMode: 'NO_REPLY', selectedFocus: null, naturalTopicEnd: true }, state: returns() })
  assert.equal(result.engagement.level, 'ENDING'); assert.equal(result.continuation.strategy, 'CLOSE')
})
test('single reliable media reaction focus can receive a light response at LOW without questions', () => {
  for (const [socialMeaning, emotion] of [['轻量玩笑式嫌弃', ['playful']], ['可能在表达难过', ['sad']]]) {
    const messages = [{ id: 'image', role: 'contact', type: 'sticker', text: '[表情包]', at: new Date(now).toISOString() }]
    const result = run(messages, { attention: { recommendedMode: 'RESPOND_FOCUS', selectedFocus: { messageId: 'image', eligible: true, resolved: false, socialMeaning, emotion, type: 'sticker' } } })
    assert.equal(result.engagement.level, 'LOW'); assert.equal(result.continuation.strategy, 'LIGHT_HOOK'); assert.equal(result.continuation.allowQuestion, false)
  }
})
test('resolved or ineligible media meaning cannot authorize continuation', () => {
  const messages = [{ id: 'image', role: 'contact', type: 'sticker', text: '[表情包]', at: new Date(now).toISOString() }]
  for (const patch of [{ resolved: true }, { eligible: false }]) {
    assert.equal(run(messages, { attention: { recommendedMode: 'RESPOND_FOCUS', selectedFocus: { messageId: 'image', socialMeaning: '猜测', ...patch } } }).continuation.strategy, 'NO_REPLY')
  }
})
test('old events in state are never interpreted as current conversation exchanges', () => {
  const result = run([], { state: { events: [{ description: '昨天面试', followUpAt: new Date(now).toISOString() }], returnCandidates: [] } })
  assert.equal(result.continuation.strategy, 'NO_REPLY'); assert.equal(result.attentionWindow.active, false); assert.equal(result.reciprocity.windowTurns, 0)
})
test('invalid current time is a visible error rather than a fabricated current timestamp', () => {
  assert.throws(() => run([], { now: 'not-a-date' }), /valid timestamp/)
})
