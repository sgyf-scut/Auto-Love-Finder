const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./setup.cjs')
const { buildChatPrompt } = require('../electron/ai-service.cjs')

test('shared conversation examples are not attributed entirely to the owner', () => {
  const prompt = buildChatPrompt({ name: '朋友', profile: { examplesSource: 'shared-conversation', examples: ['军师上线了吗', '我给你拼个蛋'] } }, '在吗')
  assert.match(prompt, /双方聊天语气参考/)
  assert.match(prompt, /不代表全部由账号本人说过/)
  assert.match(prompt, /不用于认定任何人的经历、状态或承诺/)
  assert.doesNotMatch(prompt, /人工提供的账号本人说话样例/)
})

test('unmarked owner examples keep their existing source attribution', () => {
  const prompt = buildChatPrompt({ name: '朋友', profile: { examples: ['好嘞'] } }, '在吗')
  assert.match(prompt, /人工提供的账号本人说话样例/)
  assert.doesNotMatch(prompt, /双方聊天语气参考/)
})
