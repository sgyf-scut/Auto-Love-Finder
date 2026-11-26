const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./setup.cjs')
const { messageList, syncMemory, applyObservations, memoryEvidenceAllowed } = require('../electron/social-brain/memory-manager.cjs')
const { buildContext, mediaSemantic } = require('../electron/social-brain/context-builder.cjs')
const { planConversation, parsePlan } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const now = new Date('2026-10-12T05:00:00Z')
const msg = (text = '[图片]', id = 'image1', extras = {}) => ({ id, messageId: id, role: 'contact', text, at: now.toISOString(), type: 'image', ...extras })
const contact = (messages = [msg()], semantics = []) => ({ id: 'current-contact', name: '测试对象', profile: { chatMode: 'friendship' }, learning: { messages, messageSemantics: semantics } })
const semantic = (id = 'image1', extras = {}) => ({ messageId: id, type: 'image', originalType: 'image', originalText: '[图片]', understandingStatus: 'understood', visualDescription: '猫翻白眼', textInImage: '无语', emotion: ['可能在开玩笑'], socialMeaning: '可能是玩笑式嫌弃', replyRole: 'reaction', confidence: 0.95, uncertainty: ['仅有一帧'], evidence: [{ kind: 'visual', text: '猫翻白眼', frameIndex: 0 }], sourceFrameCount: 1, frameCoverage: 'single_frame', observedAt: now.toISOString(), ...extras })
const context = (c = contact(), interpretation = semantic(), extras = {}) => buildContext({ contact: c, incoming: c.learning.messages.at(-1).text, media: { interpretation }, now, ...extras })
const rawPlan = action => JSON.stringify({ plan: { shouldReply: action !== 'NO_REPLY', action, goal: '接住当前消息' }, observations: {}, learning: { enabled: false }, advisor: { needed: false } })

test('current media ID distinguishes identical image placeholders without changing old text IDs', () => {
  const c = contact([msg('[图片]', 'older')])
  const ctx = context(c, semantic('newer'))
  assert.equal(ctx.messages.length, 2)
  assert.equal(ctx.messages.at(-1).id, 'newer')
  assert.equal(ctx.payload.currentMessageMedia.messageId, 'newer')
  assert.equal(ctx.payload.layers[7].data[0].mediaInterpretation, undefined)
  assert.equal(messageList(c, '[图片]', now).length, 1)
})

test('textless media history retains its message ID and short-term explanation', () => {
  const c = contact([msg('', 'bare-image'), msg('哈哈', 'current-text', { type: 'text' })], [semantic('bare-image')])
  const ctx = buildContext({ contact: c, incoming: '哈哈', now })
  assert.equal(ctx.messages.length, 2)
  assert.equal(ctx.payload.layers[7].data[0].mediaInterpretation.messageId, 'bare-image')
  assert.equal(ctx.memory.facts.length, 0)
  const updated = messageList(contact([msg('', 'bare-image')]), '[图片]', now, { messageId: 'bare-image', type: 'image' })
  assert.equal(updated.length, 1); assert.equal(updated[0].id, 'bare-image')
})
test('long image captions retain current semantic association after context truncation', () => {
  const caption = '这是截图的说明'.repeat(50)
  const ctx = buildContext({ contact: contact([msg(caption)]), incoming: caption, media: { interpretation: semantic('image1', { originalText: caption }) }, now })
  assert.equal(ctx.payload.currentMessageMedia.messageId, 'image1')
})
test('message metadata and quote evidence survive but media URLs and frames do not', () => {
  const quote = { sourceMessageId: 'other-msg', text: '我是湖南人', type: 'text', ownership: 'unknown' }
  const c = contact([msg('这是谁说的', 'quoted', { type: 'quote', mediaKind: 'quote', quote, imageUrl: 'https://private.invalid/image', frames: ['data:image/png;base64,SECRET'] })])
  const messages = messageList(c)
  assert.equal(messages[0].messageId, 'quoted')
  assert.equal(messages[0].mediaKind, 'quote')
  assert.equal(messages[0].quote.sourceMessageId, 'other-msg')
  assert.equal(messages[0].quote.ownership, 'unknown')
  assert.doesNotMatch(JSON.stringify(messages), /private\.invalid|SECRET|imageUrl|frames/)
})

test('structured semantics separate social inference from observations and retain evidence frame index', () => {
  const ctx = context(contact(), semantic('image1', { frames: ['SECRET'], url: 'https://private.invalid/', visualDescription: '猫 data:image/png;base64,SECRET https://private.invalid/image' }))
  const media = ctx.payload.currentMessageMedia
  assert.equal(media.socialMeaningStatus, 'inference')
  assert.equal(media.confidence, 0.95)
  assert.equal(media.sourceFrameCount, 1)
  assert.equal(media.evidence[0].kind, 'visual')
  assert.equal(media.evidence[0].frameIndex, 0)
  assert.doesNotMatch(JSON.stringify(ctx.payload), /SECRET|private\.invalid|"url"|"frames"/)
  assert.match(ctx.payload.layers[0].data, /单帧GIF不代表完整动画/)
})

test('recent semantics must belong to a matching current contact message and stay within 24 hours', () => {
  const c = contact([msg('[图片]', 'known'), msg('行', 'latest', { type: 'text' })], [
    semantic('known', { visualDescription: 'MATCHED' }),
    semantic('foreign', { visualDescription: 'FOREIGN_ID' }),
    semantic('known', { visualDescription: 'FOREIGN_CONTACT', contactId: 'other' }),
    semantic('known', { visualDescription: 'EXPIRED', observedAt: '2026-10-10T05:00:00Z' }),
  ])
  const ctx = buildContext({ contact: c, incoming: '行', now })
  const payload = JSON.stringify(ctx.payload)
  assert.match(payload, /MATCHED/)
  assert.doesNotMatch(payload, /FOREIGN_ID|FOREIGN_CONTACT|EXPIRED/)
  assert.equal(ctx.payload.currentMessageMedia, undefined)
})

test('semantics cannot refresh an old historical image or an owner message', () => {
  const c = contact([msg('[图片]', 'old', { at: '2026-10-10T05:00:00Z' }), msg('[图片]', 'owner', { role: 'me' }), msg('行', 'last')], [semantic('old', { visualDescription: 'OLD_IMAGE' }), semantic('owner', { visualDescription: 'OWNER_IMAGE' })])
  const serialized = JSON.stringify(buildContext({ contact: c, incoming: '行', now }).payload)
  assert.doesNotMatch(serialized, /OLD_IMAGE|OWNER_IMAGE/)
})

test('mismatched original text prevents semantics attaching even when the ID matches', () => {
  const ctx = context(contact(), semantic('image1', { originalText: '[动画表情]', visualDescription: 'WRONG_KIND' }))
  assert.equal(ctx.payload.currentMessageMedia, undefined)
  assert.doesNotMatch(JSON.stringify(ctx.payload), /WRONG_KIND/)
})

test('failed media clears all guessed contents and overrides the legacy analysis field', () => {
  const ctx = context(contact(), semantic('image1', { understandingStatus: 'failed', errorCode: 'vision_timeout' }), { media: { interpretation: semantic('image1', { understandingStatus: 'failed' }), analysis: 'UNTRUSTED_OLD_CAPTION' } })
  const media = ctx.payload.currentMessageMedia
  assert.equal(media.visualDescription, '')
  assert.equal(media.textInImage, '')
  assert.equal(media.socialMeaning, '')
  assert.equal(media.confidence, 0)
  assert.deepEqual(media.evidence, [])
  assert.equal(ctx.constraints.mediaUnderstandingFailed, true)
  assert.doesNotMatch(JSON.stringify(ctx.payload), /UNTRUSTED_OLD_CAPTION|猫翻白眼|玩笑式嫌弃/)
})

test('image OCR, emotions and social interpretations cannot write facts, guesses or events', () => {
  const c = contact()
  const ctx = context(c, semantic('image1', { textInImage: '我在清华大学读书，我明天面试' }))
  const memory = applyObservations(ctx.memory, {
    facts: [{ field: 'school', value: '清华大学', evidence: '我在清华大学读书', evidenceMessageId: 'image1' }],
    inferences: [{ content: '对方正在面试', evidence: '[图片]', evidenceMessageId: 'image1' }],
    events: [{ operation: 'CREATE', evidence: '我明天面试', evidenceMessageId: 'image1' }],
  }, ctx.messages, now)
  assert.equal(memory.facts.length, 0)
  assert.equal(memory.inferences.length, 0)
  assert.equal(memory.events.length, 0)
  assert.equal(memory.profile.identity.school.status, 'unknown')
})

test('OCR text mistakenly stored as message text is explicitly refused as long-term evidence', () => {
  const c = contact([msg('我在清华大学读书，我明天面试', 'ocr-msg', { textSource: 'ocr' })])
  const memory = syncMemory(c, { now })
  assert.equal(memory.facts.length, 0)
  assert.equal(memory.events.length, 0)
  assert.equal(memoryEvidenceAllowed(c.learning.messages[0]), false)
})

test('quoted self-statements are never attributed to the sender; genuine caption remains valid', () => {
  const quoted = contact([msg('我是湖南人', 'quote1', { type: 'quote', quote: { sourceMessageId: 'someone-else', text: '我是湖南人' } })])
  const memory = syncMemory(quoted, { now })
  assert.equal(memory.profile.identity.province.status, 'unknown')
  const observations = applyObservations(memory, { facts: [{ field: 'province', value: '湖南', evidence: '我是湖南人', evidenceMessageId: 'quote1' }], inferences: [{ content: '湖南人', evidence: '我是湖南人', evidenceMessageId: 'quote1' }] }, messageList(quoted), now)
  assert.equal(observations.facts.length, 0)
  assert.equal(observations.inferences.length, 0)
  const genuine = contact([msg('我在清华大学读书', 'caption')])
  assert.equal(syncMemory(genuine, { now }).profile.identity.school.value, '清华大学')
})

test('third-party and forwarded media captions keep attribution unknown', () => {
  for (const text of ['我朋友在清华大学读书', '转发：我在清华大学读书', '她说我明天面试']) {
    const memory = syncMemory(contact([msg(text)]), { now })
    assert.equal(memory.profile.identity.school.status, 'unknown')
    assert.equal(memory.events.length, 0)
  }
})

test('media quote structure preserves its source and never promotes ownership', () => {
  const result = mediaSemantic(semantic('image1', { quote: { sourceMessageId: 'original', text: '我是程序员', type: 'text', ownership: 'sender' } }))
  assert.equal(result.quote.sourceMessageId, 'original')
  assert.equal(result.quote.ownership, 'unknown')
})

test('Planner receives failure and uncertainty rules without expanding action schema', async () => {
  // Exercise Writer's independent last-line guard even when routing is bypassed.
  const ctx = context(contact(), semantic('image1', { understandingStatus: 'failed' }), { attentionEnabled: false })
  let system
  const result = await planConversation(async messages => { system = messages[0].content; return { text: rawPlan('NO_REPLY') } }, ctx)
  assert.match(system, /OCR、表情、社交含义不得写入/)
  assert.match(system, /必要时NO_REPLY/)
  assert.equal(result.plan.shouldReply, false)
  assert.ok(result.plan.avoid.some(t => t.includes('理解失败')))
})

test('Writer explicitly refuses a visual assertion after media understanding failed', async () => {
  const ctx = context(contact(), semantic('image1', { understandingStatus: 'failed' }), { attentionEnabled: false })
  const plan = parsePlan(rawPlan('ACK'), ctx)
  let system
  await assert.rejects(() => writeReply(async messages => { system = messages[0].content; return { text: '图片里有一只猫哈哈' } }, ctx, plan), /理解失败/)
  assert.match(system, /不能猜猫狗人物/)
  const fallback = await writeReply(async () => ({ text: '这张我没看清' }), ctx, plan)
  assert.equal(fallback.text, '这张我没看清')
})

test('NO_REPLY media plan never invokes Writer', async () => {
  const ctx = context()
  const plan = parsePlan(rawPlan('NO_REPLY'), ctx)
  const result = await writeReply(() => { throw new Error('must not call') }, ctx, plan)
  assert.equal(result.skipped, true)
  assert.equal(result.text, '')
})

test('text-only contexts retain unchanged facts, events and incoming plaintext', () => {
  const c = contact([msg('我在杭州上班', 'text1', { type: 'text' }), msg('我明天面试', 'text2', { type: 'text' })])
  const ctx = buildContext({ contact: c, incoming: '我明天面试', now })
  assert.equal(ctx.payload.incoming, '我明天面试')
  assert.equal(ctx.payload.currentMessageMedia, undefined)
  assert.equal(ctx.memory.profile.identity.city.value, '杭州')
  assert.equal(ctx.memory.events[0].dueDate, '2026-10-13')
})

test('not-required video interpretation keeps the existing video analysis and audio', () => {
  const c = contact([msg('[视频]', 'video1', { type: 'video' })])
  const ctx = context(c, null, { media: { interpretation: semantic('video1', { type: 'video', originalType: 'video', originalText: '[视频]', understandingStatus: 'not_required' }), analysis: '旧视频分析', audioTranscript: '视频原音' } })
  assert.equal(ctx.payload.layers[3].data.media.analysis, '旧视频分析')
  assert.equal(ctx.payload.layers[3].data.media.audio, '视频原音')
})

test('album and quoted visual interpretations replace unsourced legacy captions', () => {
  for (const originalType of ['album', 'quoted-visual']) {
    const c = contact([msg('[图片]', 'image1', { type: originalType })])
    const ctx = context(c, null, { media: { interpretation: semantic('image1', { originalType }), analysis: '旧图注' } })
    assert.equal(ctx.payload.layers[3].data.media.analysis, '')
  }
})
