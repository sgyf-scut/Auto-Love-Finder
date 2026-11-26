const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')

const FRAME = 'data:image/png;base64,AAAA'
const PLAN = { plan: { shouldReply: true, action: 'ACK', goal: '自然回应当前分享' }, observations: {}, learning: { enabled: false }, advisor: { needed: false } }
const VISION = { visualDescription: '一张高数成绩截图', textInImage: '高等数学92分', emotion: ['neutral'], socialMeaning: '可能在分享考试信息', replyRole: 'acknowledge', confidence: 0.8, uncertainty: ['截图归属未知'], evidence: [{ kind: 'visual', text: '成绩截图', frameIndex: 0 }, { kind: 'ocr', text: '高等数学92分', frameIndex: 0 }] }

function harness({ type = 'image', incoming = '[图片]', quote, vision = VISION, plan = PLAN, providers, failed = false, mode = 'friendship' } = {}) {
  const friend = { id: 'friend', name: '测试对象', profile: { chatMode: mode }, learning: { messages: [
    { id: 'previous', role: 'me', text: '你肯定又睡到下午了', at: new Date(Date.now() - 60000).toISOString() },
    { id: 'current', messageId: 'current', role: 'contact', text: incoming, type, quote, at: new Date().toISOString() },
  ] } }
  const storage = createMemoryStorage({ contacts: [friend], providers: providers || [
    { name: 'text', model: 'text-model', baseUrl: 'https://text.test/v1', capabilities: [] },
    { name: 'vision', model: 'vision-model', baseUrl: 'https://vision.test/v1', capabilities: ['vision'] },
  ] })
  const calls = []
  const ai = new AiService(storage, { transport: async (url, options, body) => {
    const value = JSON.parse(body); calls.push({ url, ...value })
    let content
    if (value.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
      if (failed) throw new Error('mock vision unavailable')
      content = typeof vision === 'string' ? vision : JSON.stringify(vision)
    } else content = String(value.messages[0]?.content).includes('聊天规划器') ? JSON.stringify(plan) : '这分数可以啊'
    return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
  } })
  const media = { frames: [FRAME], mediaKind: type === 'text' ? quote?.type || '' : type, capturedMessageId: 'current', captureEvidence: { status: 'bound', source: 'visible_message_dom' }, quote }
  return { ai, storage, friend, calls, incoming, media, incomingMeta: { messageId: 'current', type, quote } }
}

test('image understanding uses a vision provider once then existing Planner and Writer', async () => {
  const h = harness(), result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.equal(result.understandingStatus, 'understood'); assert.equal(result.text, '这分数可以啊')
  assert.equal(h.calls.length, 3); assert.equal(h.calls[0].model, 'vision-model')
  assert.equal(h.calls[1].model, 'text-model'); assert.equal(h.calls[2].model, 'text-model')
  const planned = JSON.parse(h.calls[1].messages[1].content)
  assert.match(JSON.stringify(planned), /高等数学92分/)
  assert.doesNotMatch(JSON.stringify(planned), /data:image/)
  assert.equal(h.storage.get().contacts[0].learning.messageSemantics.length, 1)
  assert.equal(h.storage.get().contacts[0].learning.mediaLog, undefined)
  assert.equal(h.storage.get().contacts[0].socialBrain.facts.length, 0)
})

test('vision OCR cannot become a contact school fact even when Planner proposes it', async () => {
  const h = harness({ vision: { ...VISION, visualDescription: '录取通知截图', textInImage: 'XX大学硕士录取通知书' },
    plan: { ...PLAN, observations: { facts: [{ field: 'school', value: 'XX大学', evidence: 'XX大学', evidenceMessageId: 'current' }] } } })
  await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.equal(h.storage.get().contacts[0].socialBrain.profile.identity.school.status, 'unknown')
  assert.equal(h.storage.get().contacts[0].socialBrain.events.length, 0)
})
test('structured visual JSON longer than 600 characters is never chat-truncated', async () => {
  const vision = { ...VISION, visualDescription: '成绩单中有课程名称和分数。'.repeat(35), uncertainty: ['这只是图中信息，无法确认截图属于发送者'] }
  assert.ok(JSON.stringify(vision).length > 600)
  const h = harness({ vision })
  const result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.equal(result.understandingStatus, 'understood')
  assert.equal(result.interpretation.visualDescription, vision.visualDescription)
  assert.equal(h.calls.length, 3)
})

test('vision failure carries failed semantics to Planner and respects NO_REPLY', async () => {
  const h = harness({ failed: true, plan: { ...PLAN, plan: { ...PLAN.plan, shouldReply: false, action: 'NO_REPLY' } } })
  const result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.equal(result.understandingStatus, 'failed'); assert.equal(result.skipped, true)
  const planned = JSON.parse(h.calls.at(-1).messages[1].content)
  assert.match(JSON.stringify(planned), /failed/); assert.doesNotMatch(JSON.stringify(planned), /高等数学92分/)
  assert.equal(h.calls.filter(call => call.model === 'text-model').length, 1)
})

test('unbound screenshot never reaches any vision provider', async () => {
  const h = harness(); h.media.capturedMessageId = 'older-image'
  const result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.equal(result.understandingStatus, 'failed')
  assert.equal(h.calls.length, 1); assert.ok(h.calls.every(call => call.model === 'text-model'))
  assert.equal(result.strategy.action, 'NO_REPLY'); assert.equal(result.attention.selectedFocus, null)
})

test('no configured visual provider keeps picture unknown and does not send image to a text model', async () => {
  const h = harness({ providers: [{ name: 'text-only', model: 'test-text', baseUrl: 'https://text.test/v1', capabilities: [] }] })
  const result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.equal(result.understandingStatus, 'failed'); assert.equal(h.calls.length, 1)
  assert.equal(result.skipped, true); assert.equal(result.attention.selectedFocus, null)
  assert.doesNotMatch(JSON.stringify(h.calls), /image_url/)
})

test('ordinary text keeps the two-call Social Brain path and does not persist media annotations', async () => {
  const h = harness({ type: 'text', incoming: '今天有点累' })
  const result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta })
  assert.equal(result.text, '这分数可以啊'); assert.equal(h.calls.length, 2)
  assert.equal(h.storage.get().contacts[0].learning.messageSemantics, undefined)
})

test('quoted picture interpretation preserves current reply text and keeps quoted words out of personal facts', async () => {
  const h = harness({ type: 'text', incoming: '看看这个', quote: { type: 'image', text: '我是XX大学研究生', sourceMessageId: 'quoted' } })
  const result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.equal(result.understandingStatus, 'understood'); assert.equal(result.interpretation.originalText, '看看这个')
  assert.equal(result.interpretation.quote.sourceMessageId, 'quoted')
  assert.equal(h.storage.get().contacts[0].socialBrain.profile.identity.school.status, 'unknown')
})

test('old friend image generation uses interpretation without changing old friend chat mode', async () => {
  const h = harness({ mode: 'oldfriend' })
  const result = await h.ai.draft({ contact: h.friend, incoming: h.incoming, incomingMeta: h.incomingMeta, videoFrames: h.media })
  assert.ok(result.text); assert.equal(h.storage.get().contacts[0].profile.chatMode, 'oldfriend')
  assert.equal(h.storage.get().contacts[0].socialBrain, undefined)
  assert.equal(h.calls.filter(call => call.model === 'vision-model').length, 1)
})

test('message annotations are bounded, expire and never contain image payloads', () => {
  const h = harness()
  for (let i = 0; i < 20; i++) h.ai.recordMessageSemantics(h.friend.name, { messageId: `img-${i}`, type: 'image', understandingStatus: 'failed', visualDescription: '' })
  assert.equal(h.storage.get().contacts[0].learning.messageSemantics.length, 12)
  assert.doesNotMatch(JSON.stringify(h.storage.get().contacts[0].learning.messageSemantics), /data:image|image_url/)
})
