const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { journeyStage, relationshipStrategy, usesDevelopingStrategy, isFriendshipContact } = require('../electron/conversation-modes.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan, JOURNEY_RULES } = require('../electron/social-brain/conversation-planner.cjs')
const { normalizeJourney } = require('../electron/social-brain/relationship-journey.cjs')
const { createSeedSelfProfile, normalizeSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const now = new Date(), ago = days => new Date(+now - days * 86400000).toISOString()
function fixture(stage = 'STRANGER', { history = false, mode = 'friendship', id = 'journey-a', name = '合成朋友' } = {}) {
  const messages = history ? [
    { id: `${id}:m1`, role: 'me', text: '我喜欢三角洲游戏，晚上玩一局', at: ago(4) },
    { id: `${id}:c1`, role: 'contact', text: '我也喜欢三角洲游戏，喜欢那种配合', at: new Date(Date.parse(ago(4)) + 1000).toISOString() },
    { id: `${id}:c2`, role: 'contact', text: '上次那个三角洲游戏队友哈哈，我今天又想起来了', at: ago(3) },
    { id: `${id}:m2`, role: 'me', text: '那个三角洲游戏队友确实太离谱了哈哈', at: new Date(Date.parse(ago(3)) + 1000).toISOString() },
    { id: `${id}:m3`, role: 'me', text: '我今天健身挺开心的，游戏也玩了一会', at: ago(2) },
    { id: `${id}:c3`, role: 'contact', text: '我最近也喜欢健身，游戏结束以后放松一下', at: new Date(Date.parse(ago(2)) + 1000).toISOString() },
    { id: `${id}:c4`, role: 'contact', text: '我今天又打了三角洲游戏，这次配合顺多了哈哈', at: now.toISOString() },
  ] : [{ id: `${id}:hello`, role: 'contact', text: '你好呀', at: now.toISOString() }]
  const contact = { id, name, profile: { chatMode: mode }, learning: { messages } }
  contact.relationshipJourney = { ...normalizeJourney(contact, { now }), currentStage: stage, suggestedStage: stage, stageSince: ago(8) }
  return contact
}
function harness(contact, { target = contact.relationshipJourney.currentStage, profile = false, plannerAction = 'REACTION', evaluateError, evaluateHook } = {}) {
  const storage = createMemoryStorage({ contacts: [contact], providers: [{ id: 'fake', name: 'fake', model: 'fake', baseUrl: 'https://example.test' }], ...(profile ? { selfProfile: createSeedSelfProfile({ now }) } : {}), settings: { twoMessageChance: 0, longTermMemory: true } })
  const ai = new AiService(storage), calls = [], posts = []
  ai.inquiryCompletion = async (rows, options) => {
    const kind = rows[0].content.includes('关系上下文评估器') ? 'evaluation' : options.structuredJson ? 'planner' : 'writer'
    calls.push({ kind, rows, options })
    if (kind === 'evaluation') {
      if (evaluateHook) await evaluateHook(storage)
      if (evaluateError) throw evaluateError
      const payload = JSON.parse(rows[1].content)
      return { text: JSON.stringify({ currentStage: payload.currentStage, suggestedStage: target, confidence: 0.94, reasons: ['根据当前联系人实际双向交流建议'], evidenceIds: payload.relationshipEvidence.map(item => item.id) }), model: 'fake', provider: 'fake', usage: { total: 2 } }
    }
    if (kind === 'planner') return { text: JSON.stringify({ observations: {}, plan: { shouldReply: plannerAction !== 'NO_REPLY', action: plannerAction, goal: '轻松回应当前游戏话题', allowQuestion: false, allowSelfDisclosure: false, selfDisclosureKeys: [], relationshipIntensity: 0.2 }, learning: { enabled: false } }), model: 'fake', provider: 'fake', usage: { total: 3 } }
    return { text: '这局配合挺顺的哈哈', model: 'fake', provider: 'fake', usage: { total: 4 } }
  }
  ai.post = async (_url, _options, body) => { posts.push(JSON.parse(body)); return { choices: [{ message: { content: '这局配合挺顺的哈哈' } }], usage: { total_tokens: 4 } } }
  return { ai, storage, calls, posts, contact, incoming: contact.learning.messages.at(-1).text }
}

for (const stage of ['STRANGER', 'EXPLORING', 'ACQUAINTANCE', 'FAMILIAR', 'FRIEND', 'CLOSE_FRIEND']) {
  test(`canonical ${stage} reaches Planner with per-contact evidence and state`, () => {
    const c = fixture(stage), ctx = buildContext({ contact: c, incoming: '你好呀', now })
    assert.equal(ctx.payload.relationshipStage, stage)
    assert.equal(ctx.payload.socialBehaviorConstraints.relationshipStage, stage)
    assert.ok(Array.isArray(ctx.payload.relationshipEvidenceSummary))
    assert.equal(typeof ctx.payload.relationshipState.warmth, 'number')
    assert.equal(ctx.relationshipJourney.currentStage, stage)
    assert.equal(ctx.relationshipJourney.stageHistory.length, 0)
  })
}
test('Journey selects mature strategy without changing legacy automatic friendship safety classification', () => {
  const c = fixture('FRIEND')
  assert.equal(usesDevelopingStrategy(c), false); assert.equal(relationshipStrategy(c), 'mature_friend')
  assert.equal(isFriendshipContact(c), true)
  assert.equal(c.profile.chatMode, 'friendship')
})
test('low Journey stage chooses developing strategy even when legacy mode says oldfriend', () => {
  const c = fixture('EXPLORING', { mode: 'oldfriend' })
  assert.equal(usesDevelopingStrategy(c), true); assert.equal(isFriendshipContact(c), false)
})
test('another contact Journey cannot select strategy for this contact', () => {
  const c = fixture('CLOSE_FRIEND'); c.relationshipJourney.contactId = 'journey-b'
  assert.equal(journeyStage(c), ''); assert.equal(usesDevelopingStrategy(c), true)
  assert.equal(buildContext({ contact: c, incoming: '你好呀', now }).payload.relationshipStage, 'STRANGER')
})
test('stage preference does not force an action or override natural NO_REPLY', () => {
  const c = fixture('CLOSE_FRIEND'), ctx = buildContext({ contact: c, incoming: '睡了', now })
  const plan = parsePlan(JSON.stringify({ plan: { shouldReply: false, action: 'NO_REPLY', goal: '自然结束' } }), ctx)
  assert.equal(plan.action, 'NO_REPLY'); assert.equal(plan.messageCount, 0)
  assert.equal(plan.relationshipIntensity, 0)
  assert.match(JOURNEY_RULES, /软上下文/)
})
test('early-stage intensity hint remains soft despite suggested CLOSE_FRIEND', () => {
  const c = fixture('STRANGER'); c.relationshipJourney.suggestedStage = 'CLOSE_FRIEND'
  const ctx = buildContext({ contact: c, incoming: '哈哈这局离谱', now })
  const plan = parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'TEASE', goal: '轻调侃', relationshipIntensity: 1 } }), ctx)
  assert.equal(plan.relationshipIntensity, 1)
  assert.equal(ctx.payload.socialBehaviorConstraints.relationshipIntensityPreference, 0.25)
  assert.equal(ctx.payload.socialBehaviorConstraints.relationshipIntensityCap, undefined)
  assert.equal(ctx.payload.relationshipStage, 'STRANGER')
})
test('normal hello skips stage model and uses exactly one Planner and one Writer', async () => {
  const f = harness(fixture()); const result = await f.ai.draftRelationshipMessage(f)
  assert.deepEqual(f.calls.map(call => call.kind), ['planner', 'writer'])
  assert.equal(result.strategy.relationshipStage, 'STRANGER')
  assert.equal(result.relationshipJourney.currentStage, 'STRANGER')
})
test('actual evidence is evaluated before the single Planner and refreshed stage reaches Writer', async () => {
  const f = harness(fixture('STRANGER', { history: true }), { target: 'EXPLORING' })
  const result = await f.ai.draftRelationshipMessage(f)
  assert.deepEqual(f.calls.map(call => call.kind), ['evaluation', 'planner', 'writer'])
  assert.equal(result.strategy.relationshipStage, 'EXPLORING')
  assert.equal(JSON.parse(f.calls.find(call => call.kind === 'planner').rows[1].content).relationshipStage, 'EXPLORING')
  assert.equal(f.storage.get().contacts[0].relationshipJourney.currentStage, 'EXPLORING')
})
test('repeated generation on the same evidence does not re-evaluate or advance stages', async () => {
  const f = harness(fixture('STRANGER', { history: true }), { target: 'EXPLORING' })
  await f.ai.draftRelationshipMessage(f); await f.ai.draftRelationshipMessage(f)
  assert.equal(f.calls.filter(call => call.kind === 'evaluation').length, 1)
  assert.equal(f.storage.get().contacts[0].relationshipJourney.stageHistory.length, 1)
})
test('failed stage model logs evaluation failure and continues independent Planner without promotion', async () => {
  const f = harness(fixture('STRANGER', { history: true }), { evaluateError: new Error('synthetic unavailable') })
  const result = await f.ai.draftRelationshipMessage(f)
  assert.equal(result.relationshipJourney.currentStage, 'STRANGER')
  assert.equal(result.text, '这局配合挺顺的哈哈')
  assert.ok(f.storage.get().logs.some(row => row.type === 'relationship_journey_evaluation_failed'))
  assert.equal(f.calls.filter(call => call.kind === 'planner').length, 1)
})
test('profile revision change during stage evaluation is fatal and cannot write stage or Planner', async () => {
  const f = harness(fixture('STRANGER', { history: true }), { target: 'EXPLORING', profile: true, evaluateHook(storage) { const p = storage.get().selfProfile; storage.update({ selfProfile: { ...p, revision: p.revision + 1 } }) } })
  await assert.rejects(f.ai.draftRelationshipMessage(f), error => error.code === 'SELF_PROFILE_STALE')
  assert.equal(f.storage.get().contacts[0].relationshipJourney.currentStage, 'STRANGER')
  assert.equal(f.calls.filter(call => call.kind === 'planner').length, 0)
})
test('burst generation lease change during stage evaluation cannot persist stale relationship stage', async () => {
  let fresh = true
  const f = harness(fixture('STRANGER', { history: true }), { target: 'EXPLORING', evaluateHook() { fresh = false } })
  await assert.rejects(f.ai.draftRelationshipMessage({ ...f, generationGuard: () => fresh }), error => error.code === 'BURST_STALE')
  assert.equal(f.storage.get().contacts[0].relationshipJourney.currentStage, 'STRANGER')
  assert.equal(f.calls.filter(call => call.kind === 'planner').length, 0)
})
test('PRIVATE profile values are redacted from stage evaluation as well as Planner', async () => {
  const c = fixture('STRANGER', { history: true }); c.learning.messages.at(-1).text += ' 专属Journey私密值'
  const f = harness(c, { profile: true }); const p = f.storage.get().selfProfile
  f.storage.update({ selfProfile: normalizeSelfProfile({ ...p, stableProfile: [...p.stableProfile, { key: 'private_note', label: '私密备注', value: '专属Journey私密值', shareLevel: 'PRIVATE' }] }, { now }) })
  await f.ai.draftRelationshipMessage(f)
  assert.ok(f.calls.some(call => call.kind === 'evaluation'))
  assert.equal(JSON.stringify(f.calls).includes('专属Journey私密值'), false)
})
test('same-named contacts remain isolated by id across evidence, Lens, State and plan persistence', async () => {
  const a = fixture('STRANGER', { history: true, id: 'a', name: '同名' }), b = fixture('STRANGER', { id: 'b', name: '同名' })
  const f = harness(a, { target: 'EXPLORING' }); f.storage.update({ contacts: [a, b] })
  await f.ai.draftRelationshipMessage(f)
  assert.equal(f.storage.get().contacts[0].relationshipJourney.currentStage, 'EXPLORING')
  assert.deepEqual(f.storage.get().contacts[1], b)
  assert.ok(f.storage.get().contacts[0].relationshipJourney.relationshipEvidence.every(item => item.contactId === 'a'))
})
test('relation evaluation preserves simultaneous user switches and another contact changes', async () => {
  const a = fixture('STRANGER', { history: true }), b = fixture('STRANGER', { id: 'b' })
  const f = harness(a, { target: 'EXPLORING', evaluateHook(storage) { storage.update({ automation: { autoReply: false }, contacts: [storage.get().contacts[0], { ...b, profile: { ...b.profile, notes: '用户新备注' } }] }) } })
  f.storage.update({ contacts: [a, b] }); await f.ai.draftRelationshipMessage(f)
  assert.equal(f.storage.get().automation.autoReply, false)
  assert.equal(f.storage.get().contacts[1].profile.notes, '用户新备注')
})
test('concurrent newer Journey decision cannot be overwritten by an older model response', async () => {
  const c = fixture('STRANGER', { history: true })
  const f = harness(c, { target: 'EXPLORING', evaluateHook(storage) { const latest = storage.get().contacts[0]; storage.update({ contacts: [{ ...latest, relationshipJourney: { ...latest.relationshipJourney, currentStage: 'ACQUAINTANCE', suggestedStage: 'ACQUAINTANCE', reasons: ['更新的既有决定'] } }] }) } })
  const result = await f.ai.draftRelationshipMessage(f)
  assert.equal(result.relationshipJourney.currentStage, 'ACQUAINTANCE')
  assert.equal(f.storage.get().contacts[0].relationshipJourney.currentStage, 'ACQUAINTANCE')
})
for (const stage of ['FRIEND', 'CLOSE_FRIEND']) {
  test(`${stage} uses original old-friend text generator even with legacy friendship mode`, async () => {
    const f = harness(fixture(stage)); const result = await f.ai.draft(f)
    assert.equal(f.calls.filter(call => call.kind === 'planner').length, 1)
    assert.equal(f.calls.filter(call => call.kind === 'writer').length, 0)
    assert.equal(f.posts.length, 1)
    assert.equal(result.strategy.relationshipStrategy, 'mature_friend')
    assert.equal(result.strategy.relationshipStage, stage)
  })
}
test('FAMILIAR promotion routes to original mature Writer in the same turn without a second Planner', async () => {
  const f = harness(fixture('FAMILIAR', { history: true }), { target: 'FRIEND' })
  const result = await f.ai.draftRelationshipMessage(f)
  assert.equal(result.relationshipJourney.currentStage, 'FRIEND')
  assert.deepEqual(f.calls.map(call => call.kind), ['evaluation', 'planner'])
  assert.equal(f.posts.length, 1)
})
test('EXPLORING remains on social Writer when legacy mode is oldfriend', async () => {
  const f = harness(fixture('EXPLORING', { mode: 'oldfriend' })); const result = await f.ai.draft(f)
  assert.deepEqual(f.calls.map(call => call.kind), ['planner', 'writer']); assert.equal(f.posts.length, 0)
  assert.equal(result.strategy.relationshipStrategy, 'developing_connection')
})
test('normal stage history and evidence never appear in contact factual memory', async () => {
  const f = harness(fixture('STRANGER', { history: true }), { target: 'EXPLORING' }); await f.ai.draftRelationshipMessage(f)
  const saved = f.storage.get().contacts[0]
  assert.ok(saved.relationshipJourney.relationshipEvidence.length > 0)
  assert.equal(JSON.stringify(saved.socialBrain.facts).includes('MUTUAL_DISCLOSURE'), false)
  assert.equal(saved.learning.messages.filter(row => row.role === 'me').length, 3)
  assert.deepEqual(f.storage.get().sendHistory, [])
})
test('media semantic recording cannot annotate another same-named contact', () => {
  const a = fixture('STRANGER', { id: 'a', name: '同名' }), b = fixture('STRANGER', { id: 'b', name: '同名' }), f = harness(a)
  f.storage.update({ contacts: [a, b] }); f.ai.recordMessageSemantics('同名', { messageId: 'a:media', understandingStatus: 'understood', type: 'image' }, 'a')
  assert.equal(f.storage.get().contacts[0].learning.messageSemantics.length, 1)
  assert.equal(f.storage.get().contacts[1].learning.messageSemantics, undefined)
})
test('invalid model stage JSON is visible in logs and cannot block independent reply planning', async () => {
  const f = harness(fixture('STRANGER', { history: true })), original = f.ai.inquiryCompletion
  f.ai.inquiryCompletion = async (rows, options) => rows[0].content.includes('关系上下文评估器') ? { text: '{invalid' } : original(rows, options)
  const result = await f.ai.draftRelationshipMessage(f)
  assert.equal(result.relationshipJourney.currentStage, 'STRANGER')
  assert.equal(result.text, '这局配合挺顺的哈哈')
  assert.ok(f.storage.get().logs.some(row => row.type === 'relationship_journey_evaluation_failed' && /JSON/.test(row.detail.reason)))
})
test('six-stage context uses the existing verified expression corpus through a retrieval adapter', () => {
  for (const [stage, alias] of [['STRANGER', 'new_friend'], ['ACQUAINTANCE', 'established_friend'], ['FAMILIAR', 'established_friend'], ['FRIEND', 'old_friend']]) {
    const c = fixture(stage); c.learning.messages[0].text = '今天又迟到了哈哈'
    c.profile.examplesSource = 'owner'; c.profile.examples = [{ contextSummary: '今天又迟到了哈哈', targetMeaning: '今天又迟到了哈哈', myReply: '你是真稳定', action: 'TEASE', human: true, source: 'owner', relationshipStage: 'new_friend' }]
    const ctx = buildContext({ contact: c, incoming: c.learning.messages[0].text, now })
    assert.equal(ctx.payload.replyExampleStage, alias)
    assert.equal(ctx.replyExampleCandidates.length, 1)
    assert.equal(ctx.replyExampleCandidates[0].verifiedHuman, true)
  }
})
test('mature text provider receives the original Planner permissions and approved-disclosure contract', async () => {
  const f = harness(fixture('FRIEND'), { profile: true }); await f.ai.draft(f)
  const prompt = f.posts[0].messages[0].content
  assert.match(prompt, /本轮社交行为许可/); assert.match(prompt, /approvedSelfDisclosure/)
  assert.match(prompt, /"relationshipStage":"FRIEND"/)
  assert.match(prompt, /"allowQuestion":false/)
})
test('model evaluation usage is included in the returned social reply token count', async () => {
  const f = harness(fixture('STRANGER', { history: true }), { target: 'EXPLORING' }); const result = await f.ai.draftRelationshipMessage(f)
  assert.equal(result.tokens.total, 9)
})
test('same-turn mature transition retains stage-evaluation usage in original Writer accounting', async () => {
  const f = harness(fixture('FAMILIAR', { history: true }), { target: 'FRIEND' }); const result = await f.ai.draftRelationshipMessage(f)
  assert.equal(result.tokens.total, 9)
})
test('Journey and contextual Persona remain available without an enabled formal self-profile', async () => {
  const f = harness(fixture('EXPLORING')); const result = await f.ai.draftRelationshipMessage(f)
  const payload = JSON.parse(f.calls.find(call => call.kind === 'planner').rows[1].content)
  assert.equal(payload.selfProfileContext, undefined)
  assert.equal(payload.personaLens.contactId, f.contact.id)
  assert.equal(payload.newFriendContext.relationshipStage, 'EXPLORING')
  assert.equal(result.relationshipJourney.currentStage, 'EXPLORING')
})

for (const stage of ['STRANGER', 'EXPLORING', 'ACQUAINTANCE', 'FAMILIAR', 'FRIEND', 'CLOSE_FRIEND']) {
  test(`${stage} is a soft preference and cannot clamp a valid chosen intensity or action`, () => {
    const c = fixture(stage), ctx = buildContext({ contact: c, incoming: '这局也太离谱了哈哈', now })
    const plan = parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'TEASE', goal: '善意轻松接梗', allowQuestion: false, relationshipIntensity: 0.96 } }), ctx)
    assert.equal(plan.action, 'TEASE'); assert.equal(plan.relationshipIntensity, 0.96)
    assert.equal(ctx.payload.socialBehaviorConstraints.relationshipIntensityCap, undefined)
  })
  test(`${stage} still rejects intensity outside the global finite 0 to 1 contract`, () => {
    const ctx = buildContext({ contact: fixture(stage), incoming: '这局挺离谱哈哈', now })
    for (const intensity of [-0.1, 1.1, '0.5', null]) {
      assert.throws(() => parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '轻接话', relationshipIntensity: intensity } }), ctx), /关系强度/)
    }
  })
}
test('an explicit intensity constraint remains a hard boundary independent of Journey preference', () => {
  const ctx = buildContext({ contact: fixture('CLOSE_FRIEND'), incoming: '这局挺离谱哈哈', now })
  ctx.payload.socialBehaviorConstraints.relationshipIntensityCap = 0.2
  const plan = parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'TEASE', goal: '善意轻接话', relationshipIntensity: 0.9 } }), ctx)
  assert.equal(plan.relationshipIntensity, 0.2)
})

for (const [label, goalFields] of [['empty', { goal: '' }], ['missing', {}]]) {
  test(`valid NO_REPLY accepts ${label} goal and supplies a local no-send purpose`, () => {
    const ctx = buildContext({ contact: fixture('EXPLORING'), incoming: '哈哈挺巧', attentionEnabled: false, now })
    const plan = parsePlan(JSON.stringify({ plan: { shouldReply: false, action: 'NO_REPLY', ...goalFields } }), ctx)
    assert.equal(plan.goal, '自然结束本轮，不回复')
    assert.equal(plan.shouldReply, false); assert.equal(plan.action, 'NO_REPLY')
    assert.equal(plan.messageCount, 0); assert.equal(plan.expression.mode, 'NO_REPLY')
    assert.equal(plan.allowQuestion, false); assert.equal(plan.allowSelfDisclosure, false)
  })
}
test('replying with an empty goal remains invalid even for a contradictory NO_REPLY action', () => {
  const ctx = buildContext({ contact: fixture('EXPLORING'), incoming: '这局挺顺', now })
  for (const action of ['REACTION', 'ANSWER', 'NO_REPLY']) {
    assert.throws(() => parsePlan(JSON.stringify({ plan: { shouldReply: true, action, goal: '' } }), ctx), /字段或动作无效/)
  }
})
test('the empty-goal exception does not accept other actions or malformed NO_REPLY goal values', () => {
  const ctx = buildContext({ contact: fixture('EXPLORING'), incoming: '哈哈挺巧', now })
  assert.throws(() => parsePlan(JSON.stringify({ plan: { shouldReply: false, action: 'ACK', goal: '' } }), ctx), /字段或动作无效/)
  assert.throws(() => parsePlan(JSON.stringify({ plan: { shouldReply: false, action: 'NO_REPLY', goal: null } }), ctx), /字段或动作无效/)
})
test('an empty-goal NO_REPLY remains terminal in AiService without invoking Writer or a second Planner', async () => {
  const f = harness(fixture('STRANGER')); let calls = 0
  f.ai.inquiryCompletion = async () => { calls++; return { text: JSON.stringify({ plan: { shouldReply: false, action: 'NO_REPLY', goal: '' } }), model: 'fake', provider: 'fake' } }
  const result = await f.ai.draftRelationshipMessage(f)
  assert.equal(calls, 1); assert.equal(result.skipped, true); assert.equal(result.text, '')
  assert.equal(result.strategy.messageCount, 0); assert.deepEqual(f.storage.get().sendHistory, [])
})

test('attention modes cannot become social actions while continuing a topic with REACTION remains valid', () => {
  const ctx = buildContext({ contact: fixture('EXPLORING'), incoming: '我也喜欢电影，之后可以聊聊', now })
  for (const action of ['CONTINUE_TOPIC', 'RESPOND_FOCUS', 'START_NEW_TOPIC']) {
    assert.throws(() => parsePlan(JSON.stringify({ plan: { shouldReply: true, action, goal: '接住共同话题' } }), ctx), /字段或动作无效/)
  }
  ctx.payload.attentionContext.recommendedMode = 'CONTINUE_TOPIC'
  const plan = parsePlan(JSON.stringify({ plan: { shouldReply: true, action: 'REACTION', goal: '接住共同话题', allowQuestion: false, focusMode: 'CONTINUE_TOPIC', focusMessageId: ctx.payload.attentionContext.selectedFocus?.messageId || '' } }), ctx)
  assert.equal(plan.action, 'REACTION'); assert.equal(plan.focusMode, 'CONTINUE_TOPIC'); assert.equal(plan.allowQuestion, false)
})
