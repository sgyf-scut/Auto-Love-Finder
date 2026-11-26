const { test } = require('node:test')
const assert = require('node:assert/strict')
const { TTL_MS, MAX_TOPICS, buildConversationState, compressConversationState } = require('../electron/social-brain/conversation-state.cjs')
const now = Date.parse('2026-10-12T12:00:00+08:00')
const msg = (id, role, text, at = now - 60000, patch = {}) => ({ id, role, text, at: new Date(at).toISOString(), ...patch })
const build = (messages, extra = {}) => buildConversationState({ contactId: 'friend_a', messages, now, ...extra })
const unknown = () => [msg('a', 'contact', '最近准备考研'), msg('b', 'me', '哪个学校'), msg('c', 'contact', '还没完全定')]
const switched = () => [...unknown(), msg('d', 'contact', '对了最近在玩王者游戏')]

test('state API requires an explicit contact identity', () => {
  assert.throws(() => buildConversationState({ messages: unknown(), now }), /contactId/)
  assert.equal(build([]).version, 1)
})
test('contact literal text creates evidence-bound topic and unknown school point', () => {
  const state = build(unknown())
  assert.equal(state.activeTopic.key, '考研')
  const point = state.openPoints.find(v => v.key === 'school_choice')
  assert.equal(point.status, 'open'); assert.deepEqual(point.sourceMessageIds, ['c']); assert.deepEqual(point.contextMessageIds, ['b'])
  assert.ok(state.topicTree.every(v => !v.sourceMessageIds.includes('b')))
})
test('explicit shift pauses the old topic with its unresolved candidate', () => {
  const state = build(switched())
  assert.equal(state.activeTopic.key, '游戏'); assert.equal(state.pausedTopics[0].key, '考研')
  assert.equal(state.lastTransition.kind, 'new_topic'); assert.equal(state.returnCandidates.length, 1)
  assert.ok(state.returnCandidates[0].sourceMessageIds.includes('c')); assert.equal(state.returnCandidates[0].allowedNow, false)
})
test('unmarked high-confidence domain change is a tangent', () => {
  const state = build([...unknown(), msg('d', 'contact', '最近在玩王者游戏')])
  assert.equal(state.lastTransition.kind, 'tangent'); assert.equal(state.activeTopic.key, '游戏')
})
test('explicit old-topic return restores the original node instead of duplicating', () => {
  const state = build([...switched(), msg('e', 'contact', '说回考研，我还在纠结学校')])
  assert.equal(state.lastTransition.kind, 'return'); assert.equal(state.activeTopic.id, 'thread_a')
  assert.equal(state.topicTree.filter(v => v.key === '考研').length, 1)
})
test('new information in same domain merges into current topic', () => {
  const state = build([...unknown(), msg('d', 'contact', '北航的题真的挺难')])
  assert.equal(state.topicTree.length, 1); assert.equal(state.lastTransition.kind, 'continuation')
  assert.match(state.activeTopic.summary, /北航/)
})
test('explicit grounded subtopic gets a parent link', () => {
  const state = build([msg('a', 'contact', '最近准备考研'), msg('b', 'contact', '关于考研学校我还没定好')])
  assert.equal(state.lastTransition.kind, 'subtopic'); assert.equal(state.activeTopic.parentId, 'thread_a')
  assert.equal(compressConversationState(state).ancestors.length, 1)
})
test('academic thread can progress from exam preparation to thesis', () => {
  const state = build([msg('a', 'contact', '最近准备考研'), msg('b', 'contact', '今天还在准备论文开题')])
  assert.equal(state.lastTransition.kind, 'progression'); assert.equal(state.activeTopic.key, '学业'); assert.equal(state.activeTopic.parentId, 'thread_a')
})
test('reaction text preserves current topic and transition', () => {
  const before = build(unknown()), after = build([msg('r', 'contact', '哈哈哈哈')], { previousState: before })
  assert.equal(after.activeTopic.id, before.activeTopic.id); assert.equal(after.activeTopic.summary, before.activeTopic.summary)
  assert.deepEqual(after.lastTransition, before.lastTransition)
})
test('sticker reaction cannot replace a literal topic', () => {
  const state = build([...unknown(), msg('s', 'contact', '[表情包]', now - 1000, { type: 'sticker', interpretation: { understandingStatus: 'understood', confidence: 0.99, socialMeaning: '去上海旅游了' } })])
  assert.equal(state.activeTopic.key, '考研'); assert.doesNotMatch(JSON.stringify(state), /上海/)
})
test('failed or low confidence media cannot create a topic from OCR', () => {
  for (const status of ['failed', 'understood']) {
    const state = build([msg('x', 'contact', '[图片]', now - 1000, { type: 'image', interpretation: { understandingStatus: status, confidence: 0.2, textInImage: '北京大学已录取', socialMeaning: '对方考研成功' } })])
    assert.equal(state.activeTopic, null); assert.deepEqual(state.openPoints, [])
  }
})
test('failed media still allows the contact actual caption', () => {
  const state = build([msg('x', 'contact', '准备去上海旅游 [图片]', now - 1000, { type: 'image', interpretation: { understandingStatus: 'failed' } })])
  assert.equal(state.activeTopic.key, '旅行'); assert.match(state.openPoints[0].summary, /上海/)
})
test('owner questions alone never create an unknown fact or thread', () => {
  const state = build([msg('x', 'me', '你学校还没定吗？'), msg('y', 'contact', '哈哈')])
  assert.equal(state.activeTopic, null); assert.deepEqual(state.openPoints, [])
})
test('quoted third party text is not contact autobiographical evidence', () => {
  const state = build([msg('x', 'contact', '他说：我准备考北航'), msg('y', 'contact', '“学校还没定”')])
  assert.equal(state.activeTopic, null); assert.deepEqual(state.openPoints, [])
})
test('state and unresolved points survive a cross-day analysis', () => {
  const first = build(switched()), later = now + 3 * 86400000
  const state = build([msg('e', 'contact', '说回考研，我学校还没定', later - 1000)], { previousState: first, now: later })
  assert.equal(state.activeTopic.id, 'thread_a'); assert.equal(state.lastTransition.kind, 'return')
  assert.ok(state.openPoints.find(v => v.key === 'school_choice' && v.status === 'open'))
})
test('later explicit school decision resolves the old cross-day uncertainty', () => {
  const first = build(switched()), later = now + 3 * 86400000
  const state = build([msg('e', 'contact', '学校决定考北航了', later - 1000)], { previousState: first, now: later })
  assert.ok(state.openPoints.find(v => v.key === 'school_choice' && v.status === 'resolved'))
  assert.ok(!state.openPoints.some(v => v.key === 'school_choice' && v.status === 'open'))
  const shifted = build([msg('f', 'contact', '对了最近在玩王者游戏', later)], { previousState: state, now: later })
  assert.ok(!shifted.returnCandidates.some(v => v.openPointIds.includes('open_c')))
})
test('explicit cancellation cancels pending points and prevents return', () => {
  const state = build([...unknown(), msg('e', 'contact', '考研不考了')])
  assert.equal(state.activeTopic, null); assert.ok(state.openPoints.every(v => v.status === 'cancelled'))
  assert.equal(state.returnCandidates.length, 0)
})
test('a substantive owner answer resolves a contact question but not a future event', () => {
  const state = build([msg('a', 'contact', '你也准备考研吗？'), msg('b', 'me', '我考研去年就结束了')])
  assert.equal(state.openPoints.find(v => v.kind === 'question').status, 'answered')
  const plan = build([msg('a', 'contact', '下周准备去上海旅游'), msg('b', 'me', '上海可以看看博物馆')])
  assert.equal(plan.openPoints.find(v => v.kind === 'event').status, 'open')
})
test('explicit sleep or refusal blocks all old topic returns', () => {
  for (const end of ['睡了', '别再问了', '不想聊了']) {
    const state = build([...switched(), msg('end', 'contact', end)])
    assert.equal(state.activeTopic, null); assert.deepEqual(state.returnCandidates, [])
    assert.ok(['close', 'refusal'].includes(state.lastTransition.kind))
  }
})
test('natural current-topic closure exposes a grounded return candidate', () => {
  const state = build([...switched(), msg('end', 'contact', '这事就这样')])
  assert.equal(state.lastTransition.kind, 'natural_end'); assert.equal(state.returnCandidates[0].allowedNow, true)
  assert.ok(state.returnCandidates[0].sourceMessageIds.includes('c'))
})
test('single exhausted ack after concrete owner response can close the current thread', () => {
  const state = build([...switched(), msg('me', 'me', '王者这个英雄的技能确实很好玩'), msg('end', 'contact', '好')], { attention: { selectedFocus: null, latestMessage: { messageId: 'end' } } })
  assert.equal(state.lastTransition.kind, 'natural_end'); assert.equal(state.returnCandidates[0].allowedNow, true)
})
test('repeated acks never force a topic return', () => {
  const state = build([...switched(), msg('r1', 'contact', '好'), msg('r2', 'contact', '好')], { attention: { selectedFocus: null, latestMessage: { messageId: 'r2' } } })
  assert.equal(state.lastTransition.kind, 'new_topic'); assert.equal(state.returnCandidates[0].allowedNow, false)
})
test('a subsequent repeated ack cannot reuse a prior natural-end return activation', () => {
  const first = build([...switched(), msg('end', 'contact', '这事就这样')])
  const next = build([msg('ack', 'contact', '好')], { previousState: first })
  assert.equal(next.returnCandidates[0].allowedNow, false)
})
test('prior state and messages from another contact are isolated', () => {
  const prior = build(unknown())
  const state = buildConversationState({ contactId: 'friend_b', messages: [msg('x', 'contact', '准备考北航', now - 1000, { contactId: 'friend_a' })], previousState: prior, now })
  assert.equal(state.activeTopic, null); assert.deepEqual(state.openPoints, [])
})
test('state expires after thirty days instead of reviving old unknowns', () => {
  const prior = build(unknown())
  const later = now + TTL_MS + 1000
  const state = build([msg('r', 'contact', '哈哈', later - 1)], { previousState: prior, now: later })
  assert.equal(state.activeTopic, null); assert.deepEqual(state.openPoints, [])
})
test('recent state update does not indefinitely keep an old untouched node alive', () => {
  const prior = build(switched()), later = now + TTL_MS + 1000
  prior.updatedAt = new Date(later - 1000).toISOString()
  const state = build([msg('r', 'contact', '哈哈', later - 1)], { previousState: prior, now: later })
  assert.equal(state.topicTree.length, 0)
})
test('restarts and duplicate message IDs are idempotent', () => {
  const first = build(switched()), again = build([...switched(), ...switched()], { previousState: first })
  assert.deepEqual(again.topicTree, first.topicTree); assert.deepEqual(again.openPoints, first.openPoints)
  assert.deepEqual(again.processedMessageIds, first.processedMessageIds)
})
test('unknown future time remains literal and never becomes a fabricated date', () => {
  const state = build([msg('a', 'contact', '最近可能准备去上海旅游')])
  const point = state.openPoints.find(v => v.kind === 'event')
  assert.ok(point); assert.equal(point.eventAt, undefined); assert.equal(point.followUpAt, undefined)
  assert.equal(point.summary, '最近可能准备去上海旅游')
})
test('tree and compressed model payload obey bounded limits', () => {
  const rows = []
  for (let i = 0; i < 20; i++) rows.push(msg(`t${i}`, 'contact', `对了新的议题编号${i}还没决定`))
  const state = build(rows), compact = compressConversationState(state)
  assert.ok(state.topicTree.length <= MAX_TOPICS); assert.ok(state.pausedTopics.length <= 5); assert.ok(state.openPoints.length <= 8)
  assert.ok(compact.ancestors.length <= 3); assert.ok(compact.returnCandidates.length <= 4); assert.ok(compact.openPoints.length <= 8)
  assert.equal(compact.topicTree, undefined); assert.equal(compact.processedMessageIds, undefined)
  assert.ok(!JSON.stringify(compact).includes('"evidence"'))
})
test('stale raw messages and future timestamps cannot establish topics', () => {
  const state = build([msg('a', 'contact', '准备考北航', now - TTL_MS - 1), msg('b', 'contact', '准备去上海旅游', now + 120000)])
  assert.equal(state.topicTree.length, 0)
})
test('low-confidence unrecognized filler leaves tree unchanged', () => {
  const first = build(unknown()), state = build([msg('x', 'contact', '这就很离谱啊')], { previousState: first })
  assert.deepEqual(state.topicTree, first.topicTree); assert.equal(state.activeTopic.id, first.activeTopic.id)
})
test('unpunctuated reported speech does not open an autobiographical event', () => {
  const state = build([msg('x', 'contact', '他说下周准备去上海旅游')])
  assert.equal(state.activeTopic, null); assert.deepEqual(state.openPoints, [])
})
test('actual owner return restores a known paused thread without adding owner facts', () => {
  const first = build([...switched(), msg('end', 'contact', '这事就这样')])
  const state = build([msg('owner_return', 'me', '你学校后来定了吗？')], { previousState: first })
  assert.equal(state.activeTopic.id, 'thread_a'); assert.equal(state.lastTransition.kind, 'return')
  assert.equal(state.lastTransition.origin, 'owner_sent_context'); assert.deepEqual(state.lastTransition.contextMessageIds, ['owner_return'])
  assert.ok(!state.activeTopic.sourceMessageIds.includes('owner_return')); assert.ok(!state.lastTransition.sourceMessageIds.includes('owner_return'))
  assert.ok(state.openPoints.every(v => !v.sourceMessageIds.includes('owner_return')))
})
test('short unknown answer after an actual owner return updates the existing open point', () => {
  const first = build([...switched(), msg('end', 'contact', '这事就这样')])
  const state = build([msg('owner_return', 'me', '你学校后来定了吗？'), msg('answer', 'contact', '还没')], { previousState: first })
  assert.equal(state.activeTopic.id, 'thread_a')
  const point = state.openPoints.find(v => v.key === 'school_choice')
  assert.equal(point.status, 'open'); assert.ok(point.sourceMessageIds.includes('answer')); assert.equal(point.summary, '还没')
})
test('owner drafts or model topicSource alone cannot reactivate paused topics', () => {
  const first = build([...switched(), msg('end', 'contact', '这事就这样')])
  const state = build([], { previousState: first, attention: { topicSource: { summary: '学校后来定了吗', sourceMessageIds: ['c'] } } })
  assert.equal(state.activeTopic, null); assert.equal(state.topicTree.find(v => v.id === 'thread_a').status, 'paused')
})
test('an owner message cannot recover a resolved paused unknown', () => {
  const first = build([msg('a', 'contact', '学校还没定'), msg('b', 'contact', '学校决定考北航了'), msg('c', 'contact', '对了最近玩王者游戏')])
  const state = build([msg('owner', 'me', '学校后来定了吗？')], { previousState: first })
  assert.equal(state.activeTopic.key, '游戏'); assert.ok(!state.returnCandidates.some(v => v.topicId === 'thread_a'))
})
test('return candidate summary excludes resolved uncertainty from older evidence', () => {
  const state = build([...unknown(), msg('d', 'contact', '学校决定考北航了'), msg('e', 'contact', '对了玩王者游戏')])
  const candidate = state.returnCandidates.find(v => v.topicId === 'thread_a')
  assert.ok(candidate); assert.doesNotMatch(candidate.summary, /还没完全定/)
})
