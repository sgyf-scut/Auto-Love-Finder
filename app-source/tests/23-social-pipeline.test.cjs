const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { JsonStorage } = require('../electron/storage.cjs')
const { syncMemory } = require('../electron/social-brain/memory-manager.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { parsePlan } = require('../electron/social-brain/conversation-planner.cjs')

const basePlan = { plan: { shouldReply: true, action: 'EMPATHY', goal: '接住当前消息', selectedTopic: '工作' }, observations: {}, learning: { enabled: false }, advisor: { needed: false } }
function setup(incoming = '老板让我加班。', messages) {
  const friend = { id: 'target', name: '测试新朋友', profile: { chatMode: 'friendship' }, learning: { messages: messages || [{ role: 'contact', text: incoming }] } }
  const storage = createMemoryStorage({ contacts: [friend, { name: '另一个人', profile: { notes: 'OTHER_CONTACT_SECRET' } }], selfPersona: { identity: '大学生', experiences: '10月9日打了篮球', tone: 'STYLE_SECRET', examples: 'OWNER_EXAMPLE_SECRET' } })
  const ai = new AiService(storage)
  const calls = []
  ai.inquiryCompletion = async (messages, options) => { calls.push({ messages, options }); return { text: options.structuredJson ? JSON.stringify(basePlan) : '这一天够折腾的', model: 'test', provider: 'test', usage: { prompt: 100, completion: 20, total: 120 } } }
  return { ai, storage, friend, calls, incoming }
}
test('normal friendship uses exactly Planner and Writer; only the written reply leaves the pipeline', async () => {
  const { ai, storage, friend, calls, incoming } = setup()
  const result = await ai.draftRelationshipMessage({ contact: friend, incoming })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.structuredJson, true)
  assert.equal(Boolean(calls[1].options.structuredJson), false)
  assert.equal(result.text, '这一天够折腾的')
  assert.doesNotMatch(result.text, /goal|observations|学习|策略/)
  assert.deepEqual(result.tokens, { prompt: 200, completion: 40, total: 240 })
  assert.equal(result.socialState.profile.identity.occupation.status, 'unknown')
  assert.equal(storage.get().contacts[0].socialBrain.lastPlan.action, 'EMPATHY')
  assert.doesNotMatch(JSON.stringify(calls), /OTHER_CONTACT_SECRET|STYLE_SECRET|OWNER_EXAMPLE_SECRET/)
})
test('a generated question is a draft, not an actual learning attempt or outgoing message', async () => {
  const { ai, storage, friend, incoming } = setup('今天老师又让我们画结构图')
  ai.inquiryCompletion = async (_, options) => ({ text: options.structuredJson ? JSON.stringify({ ...basePlan, plan: { ...basePlan.plan, action: 'SHARE_AND_ASK' }, learning: { enabled: true, topic: 'major', shouldAsk: true, naturalness: 0.96 } }) : '你学什么专业的' })
  const result = await ai.draftRelationshipMessage({ contact: friend, incoming })
  assert.equal(result.strategy.learningOpportunity.shouldAsk, true)
  assert.equal(storage.get().contacts[0].socialBrain.learningHistory.length, 0)
  assert.equal(storage.get().contacts[0].learning.messages.length, 1)
  const douyin = new DouyinService({ storage, ai })
  douyin.recordConversationMessage(friend.name, 'me', result.text, {}, { human: false })
  assert.equal(storage.get().contacts[0].socialBrain.learningHistory.length, 1)
  assert.equal(storage.get().contacts[0].socialBrain.learningHistory[0].result, 'pending')
  douyin.recordConversationMessage(friend.name, 'contact', '机械啊', {}, { human: true })
  assert.equal(storage.get().contacts[0].socialBrain.profile.identity.major.value, '机械')
  assert.equal(storage.get().contacts[0].socialBrain.learningHistory[0].result, 'answered')
})
test('two real outgoing questions cannot be followed by a third exploratory reply', async () => {
  const messages = [{ role: 'me', text: '你在哪个城市？' }, { role: 'contact', text: '先不说' }, { role: 'me', text: '你喜欢什么？' }, { role: 'contact', text: '老师今天让画结构图' }]
  const { ai, friend, incoming } = setup(messages.at(-1).text, messages)
  ai.inquiryCompletion = async (_, options) => ({ text: options.structuredJson ? JSON.stringify({ ...basePlan, plan: { ...basePlan.plan, action: 'FOLLOW_UP' }, learning: { enabled: true, topic: 'major', shouldAsk: true, naturalness: 0.99 } }) : '你学什么专业呀？' })
  await assert.rejects(ai.draftRelationshipMessage({ contact: friend, incoming }), /提问过多/)
})
test('Writer rejects gap-driven questions even if the text sounds casual', async () => {
  const { friend } = setup('你好')
  const context = buildContext({ contact: friend, incoming: '你好' })
  const plan = parsePlan(JSON.stringify(basePlan), context)
  await assert.rejects(writeReply(async () => ({ text: '你做什么工作呀？' }), context, plan), /未经规划允许/)
})
test('explicit refusal skips Writer and preserves a no-reply decision', async () => {
  const { ai, friend, calls, incoming } = setup('别再发消息了')
  const result = await ai.draftRelationshipMessage({ contact: friend, incoming })
  assert.equal(calls.length, 1)
  assert.equal(result.skipped, true)
  assert.equal(result.text, '')
  assert.equal(result.strategy.action, 'NO_REPLY')
})
test('invalid JSON stops before Writer and does not create phantom facts', async () => {
  const { ai, storage, friend, incoming } = setup()
  ai.inquiryCompletion = async () => ({ text: '{bad json' })
  await assert.rejects(ai.draftRelationshipMessage({ contact: friend, incoming }), /有效 JSON/)
  assert.equal(storage.get().contacts[0].socialBrain, undefined)
})
test('evidence-managed facts and events stay recorded when Writer fails', async () => {
  const { ai, storage, friend, incoming } = setup('我下周一面试', [{ role: 'contact', text: '我下周一面试', at: new Date().toISOString() }])
  ai.inquiryCompletion = async (_, options) => { if (options.structuredJson) return { text: JSON.stringify(basePlan) }; throw new Error('writer timeout') }
  await assert.rejects(ai.draftRelationshipMessage({ contact: friend, incoming }), /writer timeout/)
  assert.equal(storage.get().contacts[0].socialBrain.events.length, 1)
  assert.equal(storage.get().contacts[0].socialBrain.events[0].followUp.status, 'pending')
})
test('memory disabled leaves stored memories untouched and omits them from prompts', async () => {
  const { ai, storage, friend, calls, incoming } = setup('我是湖南人')
  storage.update({ settings: { longTermMemory: false } })
  await ai.draftRelationshipMessage({ contact: friend, incoming })
  assert.equal(storage.get().contacts[0].socialBrain, undefined)
  assert.equal(storage.get().contacts[0].learning.facts, undefined)
  assert.equal(calls.length, 2)
})
test('old friend generation and proactive scheduling are not routed into the new event engine', async () => {
  const { ai, friend } = setup()
  let legacyCalled = false
  ai.draftRelationshipMessageLegacy = async () => { legacyCalled = true; return { text: '旧流程' } }
  assert.equal((await ai.draftRelationshipMessage({ contact: friend, opening: true })).text, '旧流程')
  assert.equal(legacyCalled, true)
  const old = { ...friend, profile: { chatMode: 'oldfriend', examples: ['好嘞'] } }
  const storage = createMemoryStorage({ contacts: [old] })
  new DouyinService({ storage, ai }).recordConversationMessage(old.name, 'contact', '我下周一面试')
  assert.equal(storage.get().contacts[0].socialBrain, undefined)
})
test('clearing learned memory empties the derived records while preserving manual profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-social-clear-'))
  try {
    const storage = new JsonStorage(dir)
    const friend = { name: '朋友', profile: { chatMode: 'friendship', relationship: '朋友' }, learning: { messages: [{ role: 'contact', text: '我是湖南人' }] } }
    friend.socialBrain = syncMemory(friend)
    storage.update({ contacts: [friend] })
    const folder = path.join(dir, 'social-brain', fs.readdirSync(path.join(dir, 'social-brain'))[0])
    storage.update({ contacts: [{ name: friend.name, profile: friend.profile }] })
    const data = JSON.parse(fs.readFileSync(path.join(folder, 'memories.json'), 'utf8'))
    assert.deepEqual(data.facts, [])
    assert.deepEqual(data.inferences, [])
    assert.equal(new JsonStorage(dir).get().contacts[0].profile.relationship, '朋友')
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('douyin-social-clear-')); fs.rmSync(dir, { recursive: true, force: true }) }
})
