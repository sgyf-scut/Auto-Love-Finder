const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan, planConversation } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { createSeedSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const now = new Date('2026-10-13T12:00:00+08:00')
const row = (id, role, text) => ({ id, role, text, at: now.toISOString() })
function setup(incoming, rows = [], extra = {}) {
  const contact = { id: 'synthetic', name: '合成联系人', profile: { chatMode: 'friendship', relationship: '刚认识' }, learning: { messages: [...rows, row('latest', 'contact', incoming)] }, ...extra }
  return buildContext({ contact, incoming, selfProfile: createSeedSelfProfile({ now }), now })
}
function plan(ctx, patch = {}, learning = { enabled: false }) {
  return parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '自然接当前表达', allowQuestion: false, selfDisclosureKeys: [], ...patch }, learning }), ctx)
}

test('new friend continues gaming instead of forcing an unknown city question', () => {
  const ctx = setup('最近晚上都在打三角洲'), p = plan(ctx)
  assert.ok(ctx.newFriendContext.opportunities.some(item => item.type === 'CONTINUE_TOPIC'))
  assert.equal(p.learningOpportunity.shouldAsk, false)
  assert.equal(p.action, 'REACTION')
  assert.equal(ctx.newFriendContext.preferences.factCollection, 'low')
})
test('current mutual game topic offers real common ground and optional disclosure', () => {
  const ctx = setup('最近晚上都在打三角洲')
  assert.ok(ctx.newFriendContext.opportunities.some(item => item.type === 'COMMON_GROUND'))
  assert.ok(ctx.newFriendContext.opportunities.some(item => item.type === 'SELF_DISCLOSURE' && item.profileKey === 'gaming'))
})
test('Planner can choose SHARE rather than a fixed new-friend interview', () => {
  const ctx = setup('最近晚上都在打三角洲'), p = plan(ctx, { action: 'SHARE', allowSelfDisclosure: true, selfDisclosureKeys: ['gaming'] })
  assert.equal(p.action, 'SHARE'); assert.equal(p.learningOpportunity.shouldAsk, false)
  assert.deepEqual(p.approvedSelfDisclosure.map(item => item.key), ['gaming'])
})
test('many questions become a preference and do not forcibly replace Planner action', () => {
  const ctx = setup('我的专业是计算机', [row('q1', 'me', '你哪里人？'), row('a1', 'contact', '我是福建人'), row('q2', 'me', '你什么专业？')])
  const p = plan(ctx, { action: 'FOLLOW_UP', allowQuestion: true })
  assert.equal(ctx.constraints.noQuestions, false)
  assert.ok(ctx.payload.questionPreference.consecutiveQuestions >= 2)
  assert.equal(p.allowQuestion, true); assert.equal(p.action, 'FOLLOW_UP')
})
test('new friend can naturally explore a topic-relevant unknown city when Planner selects it', () => {
  const ctx = setup('这边周末有不少地方能逛'), p = plan(ctx, { action: 'FOLLOW_UP', allowQuestion: true }, { enabled: true, topic: 'city', shouldAsk: true, naturalness: 0.7 })
  assert.equal(p.learningOpportunity.topic, 'city'); assert.equal(p.learningOpportunity.shouldAsk, true)
})
test('explicitly refused city remains a hard restriction despite soft question pressure', async () => {
  const ctx = setup('最近在玩三角洲', [row('q1', 'me', '你在哪个城市？'), row('a1', 'contact', '不方便说城市，别问了')])
  const p = plan(ctx, { action: 'FOLLOW_UP', allowQuestion: true }, { enabled: true, topic: 'city', shouldAsk: true, naturalness: 0.99 })
  assert.equal(p.learningOpportunity.shouldAsk, false)
  await assert.rejects(writeReply(async () => ({ text: '你在哪个城市？' }), ctx, p), /拒绝|未经规划/)
})
test('known contact identity does not create reciprocal question opportunity', () => {
  const ctx = setup('你是哪里人？', [row('fact1', 'contact', '我是福建人')])
  assert.ok(ctx.newFriendContext.knownAreas.includes('hometown'))
  assert.equal(ctx.newFriendContext.opportunities.some(item => item.type === 'RECIPROCAL_ASK' && item.area === 'hometown'), false)
})
test('Writer cannot repeat an already known contact city', async () => {
  const ctx = setup('你在哪个城市？', [row('fact1', 'contact', '我在广州工作')]), p = plan(ctx, { action: 'ANSWER', allowQuestion: true })
  await assert.rejects(writeReply(async () => ({ text: '你在哪个城市？' }), ctx, p), /已经提供/)
})
test('good news creates emotional-value opportunity without mandatory knowledge collection', () => {
  const ctx = setup('我今天终于把论文交了'), p = plan(ctx, { action: 'REACTION' })
  assert.ok(ctx.newFriendContext.emotionalValue.cues.includes('celebrate'))
  assert.equal(p.action, 'REACTION'); assert.equal(p.learningOpportunity.shouldAsk, false)
})
test('negative complaint may use EMPATHY without forcing a major interview', () => {
  const ctx = setup('老师又让我补实验，累死了'), p = plan(ctx, { action: 'EMPATHY' })
  assert.ok(ctx.newFriendContext.emotionalValue.cues.includes('empathy_or_shared_complaint'))
  assert.equal(p.action, 'EMPATHY'); assert.equal(p.learningOpportunity.shouldAsk, false)
})
test('playful new-friend exchange can learn nothing and retain light TEASE', () => {
  const ctx = setup('我今天又迟到了哈哈'), p = plan(ctx, { action: 'TEASE', relationshipIntensity: 0.9 })
  assert.equal(p.action, 'TEASE'); assert.equal(p.relationshipIntensity, 0.25)
  assert.equal(p.learningOpportunity.shouldAsk, false)
})
test('explicit contact refusal still forces terminal NO_REPLY', () => {
  const ctx = setup('不要再联系我了'), p = plan(ctx, { action: 'FOLLOW_UP', allowQuestion: true })
  assert.equal(p.action, 'NO_REPLY'); assert.equal(p.shouldReply, false); assert.equal(p.messageCount, 0)
})
test('friend mode keeps greater daily and video sharing preference', () => {
  const ctx = setup('今天下班想吃点好的', [], { profile: { chatMode: 'oldfriend', relationship: '大学舍友' } })
  assert.equal(ctx.newFriendContext.relationshipStage, 'FRIEND')
  assert.equal(ctx.newFriendContext.preferences.dailySharing, 'high')
  assert.equal(ctx.newFriendContext.preferences.videoSharing, 'high')
})
test('Planner prompt includes adaptive soft opportunities and approved fact selection contract', async () => {
  const ctx = setup('最近晚上都在打三角洲')
  let rules
  await planConversation(async rows => { rules = rows[0].content; return { text: JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '接话', allowQuestion: false, selfDisclosureKeys: [] }, learning: { enabled: false } }) } }, ctx)
  assert.ok(rules.includes('selfDisclosureKeys')); assert.ok(rules.includes('未知字段不强迫提问'))
  assert.ok(rules.includes('情绪价值')); assert.ok(rules.includes('具体经历'))
})
test('malformed self-disclosure selection is rejected instead of silently accepting data', () => {
  const ctx = setup('最近晚上都在打三角洲')
  assert.throws(() => plan(ctx, { selfDisclosureKeys: 'gaming' }), /key\/id/)
  assert.throws(() => plan(ctx, { selfDisclosureKeys: [{}] }), /key\/id/)
})


test('approved real travel fact may answer without invented impressions', async () => {
  const ctx = setup('你去过西安吗？'), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['travel'] })
  assert.ok(p.approvedSelfDisclosure.some(item => item.key === 'travel'))
  const result = await writeReply(async () => ({ text: '我去过西安，具体细节一下想不起来了' }), ctx, p)
  assert.ok(result.text.includes('去过西安'))
})
test('Writer cannot deny a confirmed travel place even when selected facts are empty', async () => {
  const ctx = setup('你去过西安吗？'), p = plan(ctx, { action: 'ANSWER' })
  assert.deepEqual(p.approvedSelfDisclosure, [])
  await assert.rejects(writeReply(async () => ({ text: '还没去过西安，不过挺想去的' }), ctx, p), /否定.*旅行经历/)
})
test('bare travel denial cannot contradict the current place with approved travel evidence', async () => {
  const ctx = setup('你去过西安吗？'), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['travel'] })
  await assert.rejects(writeReply(async () => ({ text: '我还没去过，不过挺想去的' }), ctx, p), /否定.*旅行经历/)
})
test('unknown grade can use a short uncertainty answer without a database explanation', async () => {
  const ctx = setup('你研几呀'), p = plan(ctx, { action: 'ANSWER' })
  const result = await writeReply(async () => ({ text: '这个我得确认下，先不乱说' }), ctx, p)
  assert.equal(result.text, '这个我得确认下，先不乱说')
})
test('unknown grade does not expose self-profile implementation to the contact', async () => {
  const ctx = setup('你研几呀'), p = plan(ctx, { action: 'ANSWER' })
  await assert.rejects(writeReply(async () => ({ text: '本人资料没有提供年级' }), ctx, p), /实现细节/)
})
test('contact graduate grade must not become the owner same-grade identity', async () => {
  const ctx = setup('你研几呀', [row('fact1', 'contact', '我研一')]), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['education'] })
  assert.equal(ctx.memory.profile.identity.grade.value, '研一')
  await assert.rejects(writeReply(async () => ({ text: '我也研一，看来自家同级' }), ctx, p), /年级|身份/)
})
test('approved CAUTIOUS fictional university answers do not require the full education sentence', async () => {
  const profile = createSeedSelfProfile({ now })
  profile.stableProfile = profile.stableProfile.map(item => item.key === 'education' ? { ...item, value: '本科、硕士均在星河虚构大学' } : item)
  const contact = { id: 'synthetic', name: '合成联系人', profile: { chatMode: 'friendship', relationship: '刚认识' }, learning: { messages: [row('latest', 'contact', '你在哪所大学读书呀')] } }
  const ctx = buildContext({ contact, incoming: '你在哪所大学读书呀', selfProfile: profile, now }), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['education'] })
  const result = await writeReply(async () => ({ text: '我在星河虚构大学' }), ctx, p)
  assert.equal(result.text, '我在星河虚构大学')
})
test('Planner facts contract includes contact grade and explicit real disclosure selection', async () => {
  const ctx = setup('你去过西安吗？')
  let system
  await planConversation(async rows => { system = rows[0].content; return { text: JSON.stringify({ plan: { shouldReply: true, action: 'ANSWER', goal: '按真实旅行回答', allowQuestion: false, selfDisclosureKeys: ['travel'] }, learning: { enabled: false } }) } }, ctx)
  assert.ok(system.includes('major/grade/interest'))
  assert.ok(system.includes('不能否定已有真实经历'))
})


test('one bounded Writer correction can recover a fabricated grade without adding approved facts', async () => {
  const ctx = setup('你研几呀'), p = plan(ctx, { action: 'ANSWER' }), calls = []
  const result = await writeReply(async (rows, options) => {
    calls.push({ rows, options })
    return { text: calls.length === 1 ? '我也研一' : '这个我得确认下，先不乱说', usage: { prompt: 10, completion: 4, total: 14 } }
  }, ctx, p)
  assert.equal(calls.length, 2); assert.equal(result.correctionAttempts, 1)
  assert.equal(result.text, '这个我得确认下，先不乱说')
  assert.deepEqual(result.result.usage, { prompt: 20, completion: 8, total: 28 })
  assert.deepEqual(JSON.parse(calls[1].rows[1].content).context.approvedSelfDisclosure, JSON.parse(calls[0].rows[1].content).context.approvedSelfDisclosure)
  assert.deepEqual(JSON.parse(calls[1].rows[2].content).sameApprovedSelfDisclosure, [])
  assert.equal(calls[1].options.temperature, 0.3)
})
test('two bad Writer outputs stop instead of a third correction or relaxed guard', async () => {
  const ctx = setup('你研几呀'), p = plan(ctx, { action: 'ANSWER' })
  let count = 0
  await assert.rejects(writeReply(async () => { count++; return { text: '我也研一' } }, ctx, p), error => error.code === 'WRITER_VALIDATION_FAILED')
  assert.equal(count, 2)
})
test('NO_REPLY never invokes Writer or its correction path', async () => {
  const ctx = setup('睡了'), p = plan(ctx, { shouldReply: false, action: 'NO_REPLY' })
  let count = 0
  const result = await writeReply(async () => { count++; throw new Error('cannot run') }, ctx, p)
  assert.equal(count, 0); assert.equal(result.skipped, true)
})
test('transport failure cannot be retried as an expression correction', async () => {
  const ctx = setup('你研几呀'), p = plan(ctx, { action: 'ANSWER' })
  let count = 0
  const error = new Error('provider is unavailable')
  await assert.rejects(writeReply(async () => { count++; throw error }, ctx, p), thrown => thrown === error)
  assert.equal(count, 1)
})
test('stale generation failure cannot enter Writer correction', async () => {
  const ctx = setup('你研几呀'), p = plan(ctx, { action: 'ANSWER' })
  let count = 0
  const error = Object.assign(new Error('new incoming message'), { code: 'BURST_STALE' })
  await assert.rejects(writeReply(async () => { count++; throw error }, ctx, p), thrown => thrown === error)
  assert.equal(count, 1)
})
test('unexpected programming failure inside validation cannot enter Writer correction', async () => {
  const ctx = setup('我在玩游戏'), p = plan(ctx, { action: 'FOLLOW_UP', allowQuestion: true })
  ctx.memory = null
  let count = 0
  await assert.rejects(writeReply(async () => { count++; return { text: '你在哪个城市？' } }, ctx, p), TypeError)
  assert.equal(count, 1)
})
test('PRIVATE text is removed before the failed reply enters correction prompt', async () => {
  const ctx = setup('你研几呀'), p = plan(ctx, { action: 'ANSWER' })
  ctx.selfProfile = { ...ctx.selfProfile, stableProfile: [...ctx.selfProfile.stableProfile, { key: 'secret_test', label: '合成私密标记', value: '虚拟私密金丝雀', shareLevel: 'PRIVATE' }] }
  const calls = []
  const result = await writeReply(async rows => {
    calls.push(rows)
    return { text: calls.length === 1 ? '虚拟私密金丝雀' : '这个先不说了' }
  }, ctx, p)
  assert.equal(calls.length, 2); assert.equal(result.text, '这个先不说了')
  assert.equal(JSON.stringify(calls[1]).includes('虚拟私密金丝雀'), false)
  assert.equal(JSON.parse(calls[1][2].content).invalidReply, '[私密信息]')
})
test('travel correction retains approved travel facts and rejects its first contradictory denial', async () => {
  const ctx = setup('你去过西安吗？'), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['travel'] })
  const calls = []
  const result = await writeReply(async rows => {
    calls.push(rows)
    return { text: calls.length === 1 ? '还没去过西安' : '我去过西安，具体细节有点记不清了' }
  }, ctx, p)
  assert.equal(calls.length, 2); assert.ok(result.text.includes('去过西安'))
  assert.deepEqual(JSON.parse(calls[0][1].content).context.approvedSelfDisclosure, JSON.parse(calls[1][1].content).context.approvedSelfDisclosure)
})
test('unknown race denial correction is supported without fabricating a race history', async () => {
  const ctx = setup('你跑过半马吗？'), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['sports'] })
  let count = 0
  const result = await writeReply(async () => {
    count++
    return { text: count === 1 ? '半马还没跑过' : '这个记不太清了，我平时更喜欢游泳' }
  }, ctx, p)
  assert.equal(count, 2); assert.equal(result.correctionAttempts, 1)
  assert.equal(result.text, '这个记不太清了，我平时更喜欢游泳')
})


for (const denial of ['西安我还没去过', '西安我没去过，挺想去的', '西安还没有去过呢']) {
  test(`place-first travel denial is rejected in both bounded attempts: ${denial}`, async () => {
    const ctx = setup('你去过西安吗？'), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['travel'] })
    let count = 0
    await assert.rejects(writeReply(async () => { count++; return { text: denial } }, ctx, p), /否定.*旅行经历/)
    assert.equal(count, 2)
  })
}
test('place-first travel denial can correct once using the same approved place', async () => {
  const ctx = setup('你去过西安吗？'), p = plan(ctx, { action: 'ANSWER', allowSelfDisclosure: true, selfDisclosureKeys: ['travel'] })
  let count = 0
  const result = await writeReply(async () => { count++; return { text: count === 1 ? '西安我还没去过' : '我去过西安，具体细节有点记不清' } }, ctx, p)
  assert.equal(count, 2); assert.equal(result.correctionAttempts, 1)
  assert.deepEqual(result.approvedSelfDisclosure, p.approvedSelfDisclosure)
})
