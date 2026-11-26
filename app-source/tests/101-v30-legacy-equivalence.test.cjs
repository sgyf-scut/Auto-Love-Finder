const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createMemoryStorage } = require('./setup.cjs')
const { normalizeSelfProfile } = require('../electron/social-brain/self-profile.cjs')

// Frozen pre-refactor traces, captured by output/generate-v30-traces.cjs from
// output/v30-baseline-ai-service.cjs. Never refresh them from the new Engine.
// All identities, profile facts, messages and provider URLs here are invented.
const FIXED_TIME = '2026-10-15T12:00:00.000Z'
const incomingRow = (id, text, at = FIXED_TIME, role = 'contact') => ({ id, role, text, type: 'text', at })
const scenarioDefinitions = [
  { id: 'ordinary-old-friend', mode: 'oldfriend', incoming: '今晚这顿烧烤挺香', reply: '看得我也想整点了' },
  { id: 'developing-friend-reply', mode: 'friendship', incoming: '我今天发现一家小吃店', reply: '这种店确实容易挖到宝' },
  { id: 'developing-no-reply', mode: 'friendship', incoming: '哈哈哈哈', noReply: true, reply: '' },
  { id: 'writer-failure-preserves-inbound-event', mode: 'friendship', incoming: '我明天下午面试', writerFailure: true, reply: '明天发挥顺利呀' },
  { id: 'burst-focus-with-afterthought', mode: 'friendship', incoming: '哈哈哈', reply: '那家烧烤我也想去试试', burst: [
    incomingRow('burst-main', '今天找到一家超香的烧烤店', '2026-10-15T11:59:56.000Z'),
    incomingRow('burst-detail', '烤茄子尤其好吃', '2026-10-15T11:59:58.000Z'),
    incomingRow('burst-reaction', '哈哈哈'),
  ] },
  { id: 'friend-stage-retains-mature-strategy', mode: 'friendship', stage: 'FRIEND', incoming: '今晚这顿烧烤挺香', reply: '看得我也想整点了' },
  { id: 'open-profile-gaming-selection', mode: 'friendship', incoming: '你平时玩三角洲吗', reply: '我也玩三角洲', profile: 'gaming', selfKeys: ['gaming'] },
  // CAUTIOUS is the only explicitly permitted request-shape difference: V3
  // keeps unapproved raw school values outside Engine input. This scenario is
  // assessed separately below, not by weakening the other trace checks.
  { id: 'cautious-school-explicit-selection', mode: 'friendship', incoming: '你在哪个学校读书', reply: '先不说那么细哈哈', profile: 'school', selfKeys: ['education'] },
  { id: 'mature-friend-second-message', mode: 'oldfriend', incoming: '今晚这顿烧烤挺香', reply: '看得我也想整点了', followup: '有点馋了', twoMessageChance: 1 },
  { id: 'mature-friend-quality-rewrite', mode: 'oldfriend', incoming: '今晚这顿烧烤挺香', initialText: '感谢你的分享，真想尝尝', reply: '看得我也想整点了' },
]

function withDeterministicClock(run) {
  const RealDate = global.Date, realRandom = Math.random
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED_TIME])) }
    static now() { return RealDate.parse(FIXED_TIME) }
  }
  global.Date = FixedDate
  Math.random = () => 0.99
  return Promise.resolve().then(run).finally(() => { global.Date = RealDate; Math.random = realRandom })
}

function stable(value) {
  // Only volatile diagnostics are discarded; semantic source IDs and every
  // persisted relationship/memory/attention field remain part of comparison.
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => !['elapsedMs', 'traceId'].includes(key) && child !== undefined)
    .map(([key, child]) => [key, stable(child)]))
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) {
      try { return stable(JSON.parse(value)) } catch { /* ordinary text stays byte-exact */ }
    }
    return value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<generated-uuid>')
  }
  return value
}

const LEGACY_RESULT_FIELDS = ['ok', 'selfProfileRevision', 'text', 'text2', 'expression', 'labeledText', 'skipped', 'rejected', 'model', 'provider', 'aiLabel', 'showAiModelLabel', 'strategy', 'tokens', 'relationshipJourney', 'personaLens', 'relationshipState', 'attention', 'socialState', 'understandingStatus', 'interpretation']
function legacyResult(result) { return Object.fromEntries(LEGACY_RESULT_FIELDS.filter(key => result?.[key] !== undefined).map(key => [key, result[key]])) }

function makeScenario(definition) {
  const id = `fixture-${definition.id}`
  const rows = [incomingRow('prior-mine', '有好吃的记得分享呀', '2026-10-14T12:00:00.000Z', 'me'),
    incomingRow('prior-theirs', '可以呀我最近就在找吃的', '2026-10-14T12:01:00.000Z'),
    ...(definition.burst || [incomingRow('incoming-final', definition.incoming)])]
  const contact = { id, name: '虚构测试朋友', profile: { chatMode: definition.mode, aiEnabled: true }, learning: { messages: rows } }
  if (definition.stage) contact.relationshipJourney = { contactId: id, currentStage: definition.stage, stageSince: '2026-10-01T12:00:00.000Z', relationshipEvidence: [], stageHistory: [] }
  let selfProfile
  if (definition.profile) selfProfile = normalizeSelfProfile({ enabled: true, revision: 7, updatedAt: FIXED_TIME, stableProfile: [
    { key: 'gaming', label: '游戏', value: ['三角洲'], sourceText: '我平时会玩三角洲', shareLevel: 'OPEN', confidence: 1 },
    { key: 'education', label: '学校', value: '虚构北岸工业大学', sourceText: '我在虚构北岸工业大学读研', shareLevel: 'CAUTIOUS', confidence: 1 },
  ] }, { now: new Date(FIXED_TIME) })
  return { contact, selfProfile, options: { contact, incoming: definition.incoming,
    incomingMeta: { messageId: rows.at(-1).id, type: 'text' },
    ...(definition.burst ? { currentIncomingBurst: { burstId: 'fixture-burst', contactId: id, conversationRevision: 3, messages: definition.burst } } : {}) } }
}

async function captureScenario(AiService, definition) {
  return withDeterministicClock(async () => {
    const { contact, selfProfile, options } = makeScenario(definition)
    const storage = createMemoryStorage({ contacts: [contact], ...(selfProfile ? { selfProfile } : {}),
      ...(definition.twoMessageChance ? { settings: { twoMessageChance: definition.twoMessageChance, longTermMemory: true, showAiModelLabel: true } } : {}),
      providers: [{ id: 'fixture-provider', name: 'fixture-provider', model: 'gpt-4o-mini', baseUrl: 'https://fixture.invalid' }] })
    const timeline = [], requests = [], writes = []
    let stage = 'INITIAL'
    const snapshot = () => stable(storage.get().contacts)
    const update = storage.update.bind(storage)
    storage.update = patch => {
      const result = update(patch)
      if (patch.contacts) {
        const entry = { stage, contacts: snapshot() }
        writes.push(entry); timeline.push({ type: 'CONTACT_WRITE', writeIndex: writes.length - 1, stage })
      }
      return result
    }
    const ai = new AiService(storage)
    ai.setTransport(async (_url, _options, body) => {
      const request = JSON.parse(body)
      const system = String(request.messages?.[0]?.content || '')
      const kind = system.startsWith('你是关系上下文评估器') ? 'JOURNEY'
        : request.temperature === 0.2 ? 'PLANNER'
          : system.startsWith('你是聊天表达器') ? 'WRITER'
            : system.includes('现在紧跟着上一句随口追发第二条') ? 'MATURE_FOLLOWUP'
              : system.includes('上一句候选回复有以下问题') ? 'MATURE_REWRITE' : 'MATURE_WRITER'
      requests.push({ kind, stage, request: stable(request), contactsAtCall: snapshot() })
      timeline.push({ type: 'MODEL_REQUEST', requestIndex: requests.length - 1, kind, stage })
      let text = definition.reply
      if (kind === 'MATURE_WRITER' && definition.initialText) text = definition.initialText
      if (kind === 'MATURE_FOLLOWUP') text = definition.followup
      if (kind === 'JOURNEY') {
        const input = JSON.parse(request.messages[1].content)
        text = JSON.stringify({ currentStage: input.currentStage, suggestedStage: input.currentStage, confidence: 0.9,
          reasons: ['保留当前关系阶段'], evidenceIds: [] })
      } else if (kind === 'PLANNER') {
        const input = JSON.parse(request.messages[1].content), attention = input.attentionContext
        text = JSON.stringify({ plan: { shouldReply: !definition.noReply, action: definition.noReply ? 'NO_REPLY' : 'REACTION',
          goal: '自然接住当前话题', messageCount: definition.noReply ? 0 : 1, length: 'short', allowQuestion: false,
          allowSelfDisclosure: Boolean(definition.selfKeys?.length), selfDisclosureKeys: definition.selfKeys || [],
          ...(attention ? { focusMode: attention.recommendedMode, focusMessageId: attention.selectedFocus?.messageId || '' } : {}),
          expression: { mode: 'TEXT_ONLY', stickerIntent: 'NONE', stickerPosition: 'after_text' } },
          observations: {}, learning: { enabled: false } })
      } else if (definition.writerFailure) throw new Error('fixture-writer-transport-failure')
      return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }
    })
    let result, error
    try {
      result = legacyResult(await ai.draft({ ...options, onGenerationStage(value) { stage = value; timeline.push({ type: 'GENERATION_STAGE', stage }) } }))
    } catch (failure) { error = { message: failure.message, ...(failure.code ? { code: failure.code } : {}) } }
    return stable({ id: definition.id, requests, writes, timeline, ...(error ? { error } : { result }), contacts: snapshot() })
  })
}

module.exports = { FIXED_TIME, scenarioDefinitions, captureScenario, stable }

if (process.env.V30_CAPTURE_BASELINE !== '1') {
  const { test } = require('node:test')
  const { AiService } = require('../electron/ai-service.cjs')
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/v30-legacy-traces.json'), 'utf8'))
  test('V3.0 trace provenance uses the frozen old source, not the new implementation', () => {
    assert.equal(fixture.provenance.source, 'output/v30-baseline-ai-service.cjs')
    assert.match(fixture.provenance.sha256, /^[a-f0-9]{64}$/)
    assert.equal(fixture.provenance.fixedTime, FIXED_TIME)
    assert.deepEqual(fixture.scenarios.map(item => item.id), scenarioDefinitions.map(item => item.id))
  })
  for (const definition of scenarioDefinitions.filter(item => item.profile !== 'school')) test(`V3.0 Legacy trace equivalence: ${definition.id}`, async () => {
    const expected = fixture.scenarios.find(item => item.id === definition.id)
    const actual = await captureScenario(AiService, definition)
    assert.deepEqual(actual, expected, 'Model requests, results, state writes and their timing must match the pre-refactor Legacy trace')
    if (definition.noReply) {
      assert.equal(actual.result.skipped, true)
      assert.equal(actual.requests.some(request => request.kind === 'WRITER'), false)
      assert.ok(actual.writes.length > 0, 'NO_REPLY must retain its pre-send observations')
    }
    if (definition.writerFailure) {
      assert.match(actual.error.message, /fixture-writer-transport-failure/)
      assert.ok(actual.contacts[0].socialBrain.events.length > 0, 'Writer failure must not discard the incoming event')
    }
  })
  test('V3.0 CAUTIOUS school changes only two unapproved Planner value fields', async () => {
    const definition = scenarioDefinitions.find(item => item.profile === 'school')
    const expected = structuredClone(fixture.scenarios.find(item => item.id === definition.id))
    const actual = await captureScenario(AiService, definition)
    // The only observed V3 disclosure delta is removing the raw school from
    // these two pre-approval Planner fields. Keep every other byte/field,
    // including approved Writer facts and all stored records, under deep equality.
    const planner = expected.requests.find(request => request.kind === 'PLANNER').request.messages[1].content
    const schoolLayer = planner.layers.find(layer => layer.layer === 1).data.items.find(item => item.key === 'education')
    const schoolRelevant = planner.selfProfileContext.selfRelevant.find(item => item.key === 'education')
    assert.equal(schoolLayer.value, '虚构北岸工业大学')
    assert.equal(schoolRelevant.value, '虚构北岸工业大学')
    delete schoolLayer.value
    delete schoolRelevant.value
    assert.deepEqual(actual, expected)
    const actualPlanner = actual.requests.find(request => request.kind === 'PLANNER')
    assert.equal(JSON.stringify(actualPlanner.request).includes('虚构北岸工业大学'), false)
    assert.ok(actual.result.strategy.approvedSelfDisclosure.some(item => item.key === 'education' && item.value === '虚构北岸工业大学'), 'External compatibility approval must still resolve the selected original fact')
  })
}
