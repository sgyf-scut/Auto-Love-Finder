const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CLASSIFICATIONS, MODES, DEFAULT_WEIGHTS, TTL_MS, buildTopicState, scoreRecentMessages, selectFocus, recommendFocusMode, buildAttentionContext, normalizeWeights, normalizeSources } = require('../electron/social-brain/conversation-attention.cjs')
const now = Date.parse('2026-10-12T12:00:00+08:00')
const msg = (id, role, text, type = 'text') => ({ id, role, text, type, at: new Date(now - 60000).toISOString() })
const history = () => [msg('m1', 'contact', '最近准备考研'), msg('m2', 'me', '准备去哪'), msg('m3', 'contact', '想考北京'), msg('m4', 'me', '有目标学校没'), msg('m5', 'contact', '北航吧，不过感觉挺难'), msg('m6', 'me', '确实挺卷'), msg('m7', 'contact', '哈哈哈哈')]
const route = (messages, extra = {}) => buildAttentionContext({ messages, now, ...extra })
const media = (id, patch = {}) => ({ messageId: id, type: 'sticker', understandingStatus: 'understood', confidence: 0.8, socialMeaning: '可能是玩笑式嫌弃的轻量反应', emotion: ['playful'], ownership: 'unknown', ...patch })

test('attention classifications and modes are bounded and separate from sender roles', () => {
  assert.equal(CLASSIFICATIONS.length, 7); assert.equal(MODES.length, 4)
  const result = route(history())
  assert.equal(result.latestMessage.senderRole, 'contact'); assert.equal(result.latestMessage.classification, 'REACTION'); assert.equal(result.latestMessage.role, 'REACTION')
  assert.ok(result.rankedFocusCandidates.some(m => m.senderRole === 'me' && m.eligible === false))
})
test('latest haha continues the unfinished Beijing Beihang examination topic', () => {
  const result = route(history())
  assert.match(result.activeTopic.summary, /考研/); assert.match(result.activeTopic.summary, /北京/); assert.match(result.activeTopic.summary, /北航/)
  assert.equal(result.selectedFocus.messageId, 'm5'); assert.equal(result.recommendedMode, 'CONTINUE_TOPIC')
  assert.ok(result.rankedFocusCandidates.find(m => m.messageId === 'm5').score > result.rankedFocusCandidates.find(m => m.messageId === 'm7').score)
})
test('earlier important message wins over recency in the five-message window', () => {
  const result = route([msg('a', 'contact', '北航感觉挺难'), msg('b', 'me', '确实挺卷'), msg('c', 'contact', '哈哈'), msg('d', 'contact', '嗯嗯'), msg('e', 'contact', '哈哈哈哈')])
  assert.equal(result.selectedFocus.messageId, 'a'); assert.equal(result.rankedFocusCandidates.length, 5)
})
test('latest direct question has hard priority despite unrelated old topic', () => {
  const result = route([...history(), msg('m8', 'contact', '对了你研究生也是机械的吗？')])
  assert.equal(result.selectedFocus.messageId, 'm8'); assert.equal(result.recommendedMode, 'RESPOND_FOCUS')
  assert.equal(result.selectedFocus.directQuestion, 1)
})
test('reaction sticker does not replace topic and uses media social meaning', () => {
  const result = route([...history().slice(0, -1), msg('s', 'contact', '[表情包]', 'sticker')], { mediaInterpretations: [media('s')] })
  assert.match(result.activeTopic.summary, /考研/); assert.doesNotMatch(result.activeTopic.summary, /嫌弃|表情包/)
  assert.equal(result.latestMessage.classification, 'REACTION'); assert.equal(result.selectedFocus.messageId, 'm5')
  assert.equal(result.recommendedMode, 'CONTINUE_TOPIC')
})
test('standalone understood emotional sticker can be a lightweight focus', () => {
  const result = route([msg('s', 'contact', '[表情包]', 'sticker')], { mediaInterpretations: [media('s')] })
  assert.equal(result.activeTopic, null); assert.equal(result.selectedFocus.messageId, 's')
  assert.match(result.selectedFocus.socialMeaning, /玩笑/); assert.equal(result.recommendedMode, 'RESPOND_FOCUS')
})
test('negative image emotion is retained as an emotional focus, never fabricated as personal facts', () => {
  const result = route([msg('s', 'contact', '[图片]', 'image')], { mediaInterpretations: [media('s', { type: 'image', socialMeaning: '可能是在表达难过', emotion: ['sad'] })] })
  assert.equal(result.activeTopic, null); assert.equal(result.openPoints.length, 0); assert.equal(result.selectedFocus.emotionalWeight, 0.8)
})
test('failed media cannot manufacture focus or topic from guessed OCR or social meaning', () => {
  const result = route([msg('x', 'contact', '[图片]', 'image')], { mediaInterpretations: [media('x', { understandingStatus: 'failed', socialMeaning: '正在准备北航考研', textInImage: '北京大学录取通知书' })] })
  assert.equal(result.activeTopic, null); assert.equal(result.selectedFocus, null); assert.equal(result.recommendedMode, 'NO_REPLY')
})
test('failed media still permits explicit text caption as evidence', () => {
  const result = route([msg('x', 'contact', '我准备考北航 [图片]', 'image')], { mediaInterpretations: [media('x', { understandingStatus: 'failed' })] })
  assert.match(result.activeTopic.summary, /北航/); assert.equal(result.selectedFocus.messageId, 'x')
})
test('unknown ownership image OCR never becomes a personal topic or open point', () => {
  const result = route([msg('x', 'contact', '[图片]', 'image')], { mediaInterpretations: [media('x', { type: 'image', socialMeaning: '可能是分享通知书', textInImage: '22岁北京大学学生' })] })
  assert.equal(result.activeTopic, null); assert.equal(result.openPoints.length, 0)
  assert.doesNotMatch(JSON.stringify(result.state), /22岁|北京大学/)
})
test('reliably understood score report is a media focus without requiring strong emotion', () => {
  const result = route([msg('x', 'contact', '[图片]', 'image')], { mediaInterpretations: [media('x', { type: 'image', visualDescription: '一张考试成绩表', textInImage: '数学 92分', socialMeaning: '', emotion: ['neutral'] })] })
  assert.equal(result.selectedFocus.messageId, 'x'); assert.equal(result.recommendedMode, 'RESPOND_FOCUS')
  assert.match(result.selectedFocus.summary, /成绩表/); assert.match(result.selectedFocus.summary, /归属未确认/)
  assert.equal(result.activeTopic, null); assert.deepEqual(result.openPoints, [])
})
test('low-confidence ordinary image cannot produce a guessed visual focus', () => {
  const result = route([msg('x', 'contact', '[图片]', 'image')], { mediaInterpretations: [media('x', { type: 'image', confidence: 0.3, visualDescription: '可能是考试成绩表', textInImage: '数学 92分', socialMeaning: '可能成绩很好', emotion: ['neutral'] })] })
  assert.equal(result.selectedFocus, null); assert.equal(result.recommendedMode, 'NO_REPLY')
  assert.doesNotMatch(JSON.stringify(result), /92分|成绩表|成绩很好/)
})
test('understood album observations remain media context rather than personal topic facts', () => {
  const result = route([msg('album', 'contact', '[album]', 'album')], { mediaInterpretations: [media('album', { type: 'album', visualDescription: '两张风景照片', socialMeaning: '', emotion: ['neutral'] })] })
  assert.equal(result.selectedFocus.messageId, 'album'); assert.equal(result.selectedFocus.classification, 'TOPIC_CONTENT')
  assert.equal(result.activeTopic, null); assert.equal(result.recommendedMode, 'RESPOND_FOCUS')
})
test('concrete earlier answer closes focus and haha does not force another response', () => {
  const result = route([...history().slice(0, -2), msg('m6', 'me', '北航数学难度确实高，可以看看北理工作为备选'), msg('m7', 'contact', '哈哈哈哈')])
  assert.equal(result.selectedFocus, null); assert.equal(result.recommendedMode, 'NO_REPLY'); assert.equal(result.engagement, 'low')
})
test('explicit closure overrides unresolved points and legal new topic sources', () => {
  const source = { type: 'open_point', summary: '之前还没说完的旅行计划', sourceMessageIds: ['trip'] }
  for (const ending of ['睡了', '晚安', '不想聊了', '别再问了', '我先睡了']) {
    const result = route([...history(), msg('end', 'contact', ending)], { topicSources: [source] })
    assert.equal(result.recommendedMode, 'NO_REPLY', ending); assert.equal(result.selectedFocus, null, ending)
  }
})
test('naturally exhausted topic can start a legal old open point', () => {
  const result = route([msg('a', 'contact', '考研准备好了'), msg('b', 'me', '考研准备好了就按计划练习数学'), msg('c', 'contact', '行')], { topicSources: [{ type: 'open_point', summary: '之前没聊完的旅行计划', sourceMessageIds: ['trip'] }] })
  assert.equal(result.recommendedMode, 'START_NEW_TOPIC'); assert.equal(result.topicSource.type, 'open_point')
})
test('no evidence or unsupported new-topic source cannot manufacture interview questions', () => {
  for (const source of [{ type: 'profile_unknown', summary: '喜欢电影吗', id: 'unknown' }, { type: 'shared_interest', summary: '平时爱看什么电影' }, { type: 'self_experience', summary: '今天去北京玩了', id: 'fake', ownership: 'unknown' }]) {
    assert.equal(route([msg('a', 'contact', '好')], { topicSources: [source] }).recommendedMode, 'NO_REPLY')
  }
})
test('acknowledgment with laughter still naturally closes and allows a supported new topic', () => {
  const result = route([msg('a', 'contact', '行吧哈哈')], { topicSources: [{ type: 'open_point', summary: '此前的面试结果', sourceMessageIds: ['interview'] }] })
  assert.equal(result.latestMessage.classification, 'ACK'); assert.equal(result.recommendedMode, 'START_NEW_TOPIC')
  assert.equal(route([msg('a', 'contact', '睡了哈哈')]).recommendedMode, 'NO_REPLY')
})
test('topic state survives reaction-only next turn without replacing id or summary', () => {
  const before = route(history().slice(0, -1))
  const after = route([msg('m7', 'contact', '哈哈哈哈')], { previousState: before.state })
  assert.equal(after.activeTopic.id, before.activeTopic.id); assert.equal(after.activeTopic.summary, before.activeTopic.summary)
})
test('topic content before the five-message window remains available', () => {
  const result = route([...history(), msg('m8', 'contact', '嗯嗯')])
  assert.match(result.activeTopic.summary, /最近准备考研/); assert.equal(result.rankedFocusCandidates.length, 5)
})
test('concrete question followup counts as expansion so old focus is not repeated', () => {
  const result = route([msg('a', 'contact', '北航感觉难'), msg('b', 'me', '北航数学你准备先复习哪一块？'), msg('c', 'contact', '哈哈')])
  assert.equal(result.selectedFocus, null); assert.equal(result.recommendedMode, 'NO_REPLY')
})
test('an unrelated question from me does not falsely resolve the current topic', () => {
  const result = route([msg('a', 'contact', '北航感觉难'), msg('b', 'me', '今天吃啥？'), msg('c', 'contact', '哈哈')])
  assert.equal(result.selectedFocus.messageId, 'a'); assert.equal(result.recommendedMode, 'CONTINUE_TOPIC')
})
test('changing subject instead of answering does not dismiss a direct question', () => {
  const result = route([msg('a', 'contact', '你研究生也是机械的吗？'), msg('b', 'me', '对了今天吃啥？'), msg('c', 'contact', '哈哈')])
  assert.equal(result.selectedFocus.messageId, 'a'); assert.equal(result.recommendedMode, 'RESPOND_FOCUS')
})
test('already answered old direct question is not selected again', () => {
  const result = route([msg('a', 'contact', '你也是机械的吗？'), msg('b', 'me', '是的'), msg('c', 'contact', '哈哈')])
  assert.equal(result.rankedFocusCandidates.find(m => m.messageId === 'a').resolved, true)
  assert.equal(result.recommendedMode, 'NO_REPLY')
})
test('rhetorical and quoted third-party questions do not get hard priority', () => {
  for (const reaction of ['这谁顶得住？', '谁不是呢', '他说：“你研究生也是机械的吗？”', '别人问：你几点来？']) {
    const result = route([...history(), msg('r', 'contact', reaction)])
    assert.equal(result.rankedFocusCandidates.find(m => m.messageId === 'r').directQuestion, 0, reaction)
  }
})
test('processed focus prevents old information from restarting endlessly', () => {
  const result = route(history(), { processedFocusIds: ['m5'] })
  assert.equal(result.selectedFocus, null); assert.equal(result.recommendedMode, 'NO_REPLY')
  const old = route(history()).state
  old.lastDecision = { processed: true, focusMessageId: 'm5' }
  assert.equal(route(history(), { previousState: old }).selectedFocus, null)
})
test('reply examples never affect attention scoring or selected focus', () => {
  const base = route(history()), examples = route(history(), { replyExamples: [{ contextSummary: '哈哈', myReply: '哈哈你太好笑了' }] })
  assert.deepEqual(examples.rankedFocusCandidates, base.rankedFocusCandidates); assert.deepEqual(examples.selectedFocus, base.selectedFocus)
})
test('configurable weights normalize and reject invalid or unknown fields', () => {
  assert.deepEqual(normalizeWeights(), DEFAULT_WEIGHTS)
  assert.equal(Object.values(normalizeWeights({ recency: 2 })).reduce((a, b) => a + b, 0).toFixed(8), '1.00000000')
  for (const input of [{ recency: -1 }, { recency: NaN }, { template: 1 }, Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(k => [k, 0]))]) assert.throws(() => normalizeWeights(input))
})
test('topic and open points have message evidence and exclude unrelated unknown profile fields', () => {
  const result = route(history(), { unknowns: ['年龄', '学校', '出生地'] })
  assert.ok(result.activeTopic.sourceMessageIds.length); assert.ok(result.openPoints.every(point => point.sourceMessageIds.length))
  assert.doesNotMatch(JSON.stringify(result.openPoints), /年龄|出生地/)
})
test('expired state and expired history do not keep a stale topic alive', () => {
  const previousState = { activeTopic: { id: 'old', summary: '昨天还聊北航', sourceMessageIds: ['old'], lastActiveAt: new Date(now - TTL_MS - 1).toISOString() }, updatedAt: new Date(now - TTL_MS - 1).toISOString() }
  const result = route([msg('a', 'contact', '哈哈')], { previousState })
  assert.equal(result.activeTopic, null)
  assert.equal(route([{ ...msg('old', 'contact', '准备考研'), at: new Date(now - TTL_MS - 1).toISOString() }]).activeTopic, null)
})
test('event sources require a legal followup window and never mutate or schedule events', () => {
  const source = { type: 'event', eventId: 'exam', summary: '今天面试结果', followUpAt: new Date(now + 1000).toISOString() }
  assert.deepEqual(normalizeSources([source], now), [])
  const due = { ...source, followUpAt: new Date(now - 1000).toISOString(), windowEnd: new Date(now + 1000).toISOString() }
  const snapshot = JSON.stringify(due)
  assert.equal(route([msg('a', 'contact', '好')], { topicSources: [due] }).recommendedMode, 'START_NEW_TOPIC')
  assert.equal(JSON.stringify(due), snapshot)
  assert.deepEqual(normalizeSources([{ ...due, windowEnd: new Date(now - 1).toISOString() }], now), [])
})
test('root can use individual attention stages without changing results', () => {
  const options = { messages: history(), now }, state = buildTopicState(options)
  const scored = scoreRecentMessages({ ...options, state }), latestMessage = route(history()).latestMessage
  const selectedFocus = selectFocus(scored, { latestMessage })
  assert.equal(recommendFocusMode({ state, selectedFocus, latestMessage }).mode, 'CONTINUE_TOPIC')
})
test('normalization bounds history to eighty messages and never focuses my own last message', () => {
  const messages = Array.from({ length: 90 }, (_, i) => msg(`id${i}`, 'contact', `北京数学备考 ${i}`))
  assert.equal(route(messages).state.messagesAnalyzed, 80)
  assert.equal(route([...history(), msg('mine', 'me', '北航你准备怎么复习')]).recommendedMode, 'NO_REPLY')
})
