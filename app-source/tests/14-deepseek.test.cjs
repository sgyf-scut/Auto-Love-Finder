const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { createMemoryStorage } = require('./setup.cjs')

function capture() {
  const calls = []
  const ai = new AiService(createMemoryStorage(), {
    transport: async (url, options, body) => {
      calls.push({ url, options, body: body ? JSON.parse(body) : undefined })
      return { choices: [{ message: { content: '连接成功' } }] }
    },
  })
  return { ai, calls }
}

for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
  test(`${model}: official completions disable thinking by default`, async () => {
    const { ai, calls } = capture()
    await ai.post('https://api.deepseek.com/v1/chat/completions', { method: 'POST' }, JSON.stringify({ model, messages: [], max_tokens: 200 }))
    assert.deepEqual(calls[0].body.thinking, { type: 'disabled' })
    assert.equal(calls[0].body.max_tokens, 200)
  })
}

test('explicit thinking settings are preserved', async () => {
  const { ai, calls } = capture()
  for (const setting of [{ thinking: { type: 'enabled' } }, { reasoning_effort: 'high' }]) {
    const body = { model: 'deepseek-flash', messages: [], ...setting }
    await ai.post('https://api.deepseek.com/chat/completions', {}, JSON.stringify(body))
    assert.deepEqual(calls.at(-1).body, body)
  }
})

test('other providers, legacy models and model-list requests remain compatible', async () => {
  const { ai, calls } = capture()
  for (const [url, model] of [
    ['https://other.example/v1/chat/completions', 'deepseek-flash'],
    ['https://api.deepseek.com/chat/completions', 'deepseek-reasoner'],
    ['https://api.deepseek.com.evil.example/chat/completions', 'deepseek-flash'],
  ]) {
    const body = { model, messages: [] }
    await ai.post(url, {}, JSON.stringify(body))
    assert.deepEqual(calls.at(-1).body, body)
  }
  await ai.post('https://api.deepseek.com/v1/models', { method: 'GET' })
  assert.equal(calls.at(-1).body, undefined)
})

test('DeepSeek Flash recognizes video frames without manually declaring vision', async () => {
  const storage = createMemoryStorage({
    providers: [{ name: 'DeepSeek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', capabilities: [] }],
    contacts: [{ name: '测试朋友', profile: {}, learning: { messages: [], facts: [] } }],
  })
  const bodies = []
  const ai = new AiService(storage, { transport: async (url, options, body) => {
    const payload = JSON.parse(body)
    bodies.push(payload)
    return { choices: [{ message: { content: bodies.length === 1 ? '猫打翻水杯，主人笑了。\n话题记录：猫打翻水杯' : '这猫是故意的吧哈哈' } }] }
  } })
  const frame = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  const result = await ai.draft({ contact: storage.get().contacts[0], incoming: '[视频]', videoFrames: {
    frames: [frame], mediaKind: 'video', detectedVideo: true, videoReady: true, decodedVideoFrames: 1, confidence: 'high', frameDetail: 'low',
  } })
  assert.equal(result.ok, true)
  assert.ok(bodies[0].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')))
  assert.ok(bodies.every(body => body.thinking.type === 'disabled'))
  assert.ok(storage.get().contacts[0].learning.mediaLog.length > 0)
})
