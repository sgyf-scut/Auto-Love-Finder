const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService, normalizeSkills, parseSkillsImport } = require('../electron/ai-service.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan, PLANNER_RULES } = require('../electron/social-brain/conversation-planner.cjs')
const { normalizeJourney } = require('../electron/social-brain/relationship-journey.cjs')
const { normalizeSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const now = new Date(), incoming = '今天吃的面挺好吃的'
const skill = (extra = {}) => ({ id: 'advisor', name: '狗头军师', target: 'friendship', instruction: '先回应当前话题，适度分享真实信息，不连续追问；尊重边界，可以自然结束。', enabled: true, invocation: 'always', ...extra })
function contact(stage = 'STRANGER') {
  const c = { id: 'advisor-contact', name: '虚构顾问测试', profile: { chatMode: stage === 'STRANGER' ? 'friendship' : 'oldfriend' }, learning: { messages: [{ id: 'incoming-1', role: 'contact', text: incoming, at: now.toISOString() }] } }
  c.relationshipJourney = { ...normalizeJourney(c, { now }), currentStage: stage, suggestedStage: stage }
  return c
}
const advisorLayer = context => context.payload.layers[6].data
const context = (skills = [skill()], extra = {}) => buildContext({ contact: contact(), incoming, skills, now, ...extra })
function harness(skills = [skill()], stage = 'STRANGER', action = 'REACTION', legacy = false) {
  const c = contact(stage); if (legacy) delete c.relationshipJourney
  const storage = createMemoryStorage({ contacts: [c], aiSkills: skills, providers: [{ id: 'test', name: 'fake', model: 'fake', baseUrl: 'https://example.test' }] })
  const ai = new AiService(storage), calls = [], posts = []
  ai.inquiryCompletion = async (rows, opts) => {
    calls.push({ rows, opts })
    if (opts.structuredJson) return { text: JSON.stringify({ plan: { shouldReply: action !== 'NO_REPLY', action, goal: '自然接住当前话题', allowQuestion: false, allowSelfDisclosure: false }, advisor: { needed: false } }), model: 'fake', provider: 'fake', usage: { total: 1 } }
    return { text: '这碗面看着就香', model: 'fake', provider: 'fake', usage: { total: 1 } }
  }
  ai.post = async (_url, _opts, body) => { posts.push(JSON.parse(body)); return { choices: [{ message: { content: '这碗面看着就香' } }], usage: { total_tokens: 1 } } }
  return { ai, storage, contact: c, calls, posts }
}

test('always strategy reaches ordinary small-talk context without keyword trigger', () => {
  const ctx = context()
  assert.equal(ctx.constraints.advisorAlways, true)
  assert.equal(ctx.constraints.requiresAdvisor, true)
  assert.equal(advisorLayer(ctx)[0].invocation, 'always')
  assert.equal(advisorLayer(ctx)[0].instruction, skill().instruction)
})
test('needed strategy stays absent in ordinary small talk', () => {
  const ctx = context([skill({ invocation: 'needed' })])
  assert.deepEqual(advisorLayer(ctx), []); assert.equal(ctx.constraints.advisorAlways, false)
})
test('needed strategy still appears for conflict or distress', () => {
  const ctx = context([skill({ invocation: 'needed' })], { incoming: '今天和朋友吵架了，挺难过的' })
  assert.equal(advisorLayer(ctx)[0].invocation, 'needed'); assert.equal(ctx.constraints.requiresAdvisor, true)
})
test('disabled always strategy cannot be loaded even during conflict', () => {
  const ctx = context([skill({ enabled: false })], { incoming: '我很难过' })
  assert.deepEqual(advisorLayer(ctx), []); assert.equal(ctx.constraints.advisorAlways, false)
})
test('blank and unrelated target strategies cannot become an always advisor', () => {
  const ctx = context([skill({ instruction: '  ' }), skill({ target: 'video' })])
  assert.deepEqual(advisorLayer(ctx), []); assert.equal(ctx.constraints.advisorAlways, false)
})
test('all-target strategy supports always and always takes priority over needed', () => {
  const ctx = context([skill({ invocation: 'needed', id: 'one' }), skill({ invocation: 'needed', id: 'two' }), skill({ target: 'all', id: 'three' })], { incoming: '我很难过' })
  assert.equal(advisorLayer(ctx).length, 2); assert.equal(advisorLayer(ctx)[0].invocation, 'always')
})
test('legacy or unknown invocation normalizes to needed without changing enabled state', () => {
  for (const invocation of [undefined, 'invalid', '', null]) {
    const row = normalizeSkills([skill({ invocation, enabled: false })])[0]
    assert.equal(row.invocation, 'needed'); assert.equal(row.enabled, false)
  }
  assert.equal(normalizeSkills([skill()])[0].invocation, 'always')
})
test('legacy enabled strategy remains needed and does not load during ordinary talk', () => {
  const legacy = skill(); delete legacy.invocation
  assert.deepEqual(advisorLayer(context([legacy])), [])
})
test('save and JSON import retain invocation and preserve other strategies', () => {
  const f = harness([]), rows = [skill(), skill({ id: 'other', target: 'chat', invocation: 'needed' })]
  const saved = f.ai.saveSkills(rows)
  assert.equal(saved.skills[0].invocation, 'always')
  assert.deepEqual(f.storage.get().aiSkills, saved.skills)
  assert.equal(parseSkillsImport(JSON.stringify(rows))[0].invocation, 'always')
  assert.equal(f.storage.get().aiSkills[1].id, 'other')
})
test('each strategy remains bounded to 900 characters at normal budget', () => {
  const ctx = context([skill({ instruction: '策'.repeat(1200) })])
  assert.equal(advisorLayer(ctx)[0].instruction.length, 900)
})
test('tight budget retains shortened always advice and current incoming evidence', () => {
  const ctx = context([skill({ instruction: '先回应'.repeat(400) })], { tokenBudget: 2200, attentionEnabled: false, persona: { experiences: '有日期的本人经历'.repeat(90) } })
  assert.ok(Array.isArray(advisorLayer(ctx)))
  assert.ok(advisorLayer(ctx)[0].instruction.length > 0)
  assert.ok(advisorLayer(ctx)[0].instruction.length <= 240)
  assert.equal(advisorLayer(ctx)[0].truncatedForBudget, true)
  assert.equal(ctx.payload.incoming, incoming)
  assert.equal(ctx.payload.layers[7].data.at(-1).text, incoming)
  assert.ok(ctx.estimatedTokens <= ctx.tokenBudget)
})
test('PRIVATE values are still redacted from an always strategy', () => {
  const secret = '顾问专属私密标记'
  const selfProfile = normalizeSelfProfile({ enabled: true, stableProfile: [{ key: 'private_note', label: '秘密', value: secret, shareLevel: 'PRIVATE' }] }, { now })
  const ctx = context([skill({ instruction: `先回应，秘密是${secret}，不要追问` })], { selfProfile })
  assert.equal(JSON.stringify(ctx.payload).includes(secret), false)
  assert.equal(ctx.constraints.advisorAlways, true)
})
test('always diagnostics do not depend on model asking for a second advisor', () => {
  const ctx = context(), plan = parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '轻松接话' }, advisor: { needed: false } }), ctx)
  assert.equal(plan.needAdvisor, true)
  assert.match(PLANNER_RULES, /不额外请求顾问模型/)
  assert.doesNotMatch(PLANNER_RULES, /普通聊天不请求军师/)
})
test('needed diagnostics retain the model decision', () => {
  const ctx = context([skill({ invocation: 'needed' })], { incoming: '我很难过' })
  const model = needed => JSON.stringify({ plan: { shouldReply: true, action: 'EMPATHY', goal: '回应情绪' }, advisor: { needed } })
  assert.equal(parsePlan(model(false), ctx).needAdvisor, false)
  assert.equal(parsePlan(model(true), ctx).needAdvisor, true)
})
test('always never overrides NO_REPLY or starts Writer for a closing turn', async () => {
  const f = harness([skill()], 'STRANGER', 'NO_REPLY')
  const result = await f.ai.draft({ contact: f.contact, incoming })
  assert.equal(result.skipped, true); assert.equal(result.strategy.action, 'NO_REPLY')
  assert.equal(result.strategy.needAdvisor, true)
  assert.equal(f.calls.length, 1); assert.equal(f.posts.length, 0)
  assert.deepEqual(f.storage.get().sendHistory, [])
})
test('automatic developing conversation uses one Planner with advice and one Writer', async () => {
  const f = harness(), result = await f.ai.draft({ contact: f.contact, incoming })
  assert.equal(f.calls.filter(call => call.opts.structuredJson).length, 1)
  assert.equal(f.calls.filter(call => !call.opts.structuredJson).length, 1)
  assert.equal(JSON.parse(f.calls[0].rows[1].content).layers[6].data[0].invocation, 'always')
  assert.equal(result.strategy.needAdvisor, true)
  assert.deepEqual(f.storage.get().sendHistory, [])
})
for (const stage of ['FRIEND', 'CLOSE_FRIEND']) test(`${stage} loads always advice in its existing Planner and retains mature Writer`, async () => {
  const f = harness([skill()], stage), result = await f.ai.draft({ contact: f.contact, incoming })
  assert.equal(f.calls.length, 1); assert.equal(f.posts.length, 1)
  assert.equal(JSON.parse(f.calls[0].rows[1].content).layers[6].data[0].invocation, 'always')
  assert.equal(result.strategy.needAdvisor, true)
  assert.equal(result.strategy.relationshipStrategy, 'mature_friend')
})
test('legacy mature contact without Journey still uses one Planner when advisor is always', async () => {
  const f = harness([skill()], 'FRIEND', 'REACTION', true), result = await f.ai.draft({ contact: f.contact, incoming })
  assert.equal(f.calls.length, 1); assert.equal(f.posts.length, 1)
  assert.equal(result.strategy.needAdvisor, true)
})

const renderer = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/loadAll\(\)\s*$/, '')
test('account runtime retires the old advisor and preserves other skills', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
  const config = {
    providers: ['fixture'],
    aiSkills: [skill(), skill({ id: 'friendship-advisor', target: 'all' }), skill({ id: 'generic', target: 'chat' })],
  }
  const wrapped = vm.runInNewContext(main.slice(main.indexOf('function makeSharedProvidersView('), main.indexOf('function startAccountServices('))
    + '\nmakeSharedProvidersView(baseStorage)', { baseStorage: { get: () => config }, providersStore: null })
  assert.deepEqual(wrapped.get().aiSkills.map(row => row.id), ['generic'])
  assert.equal(config.aiSkills.length, 3)
})
