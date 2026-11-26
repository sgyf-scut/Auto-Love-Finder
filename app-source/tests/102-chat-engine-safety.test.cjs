const { test } = require('node:test')
const assert = require('node:assert/strict')
const { guardEngineResult } = require('../electron/chat-core/safety-guard.cjs')
const { normalizeSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const { assertApprovedSelfDisclosure } = require('../electron/social-brain/disclosure-policy.cjs')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')

const reply = patch => ({ action: 'REPLY', messages: ['第一句', '第二句'], handoff: false, reason: null, metadata: {}, ...patch })
function guardOptions(patch = {}) {
  return { assertFresh: async () => {}, assertProfileRevision() {}, assertProfileReply() {}, profileRevision: 4, approvedSelfDisclosure: [], ...patch }
}
function profile() {
  return normalizeSelfProfile({ enabled: true, revision: 4, stableProfile: [
    { key: 'gaming', label: '游戏', value: ['三角洲'], shareLevel: 'OPEN' },
    { key: 'education', label: '学校', value: '合成甲大学', shareLevel: 'CAUTIOUS' },
    { key: 'private_note', label: '私密资料', value: '合成绝不能公开资料', shareLevel: 'PRIVATE' },
  ] })
}

test('external guard validates the public schema before touching any lifecycle callback', async () => {
  let calls = 0
  const options = guardOptions({ assertFresh: async () => { calls++ }, assertProfileRevision: () => { calls++ }, assertProfileReply: () => { calls++ } })
  await assert.rejects(guardEngineResult(reply({ action: 'TEASE' }), options), /action/)
  assert.equal(calls, 0)
})
test('external guard awaits freshness before external revision and each message fact review', async () => {
  const order = [], approved = [{ key: 'gaming', value: ['三角洲'] }]
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const pending = guardEngineResult(reply(), guardOptions({
    approvedSelfDisclosure: approved,
    assertFresh: async () => { order.push('fresh-start'); await waiting; order.push('fresh-finish') },
    assertProfileRevision: revision => { assert.equal(revision, 4); order.push('revision') },
    assertProfileReply: (text, facts) => { assert.equal(facts, approved); order.push(`facts:${text}`) },
  }))
  assert.deepEqual(order, ['fresh-start'])
  release()
  const result = await pending
  assert.deepEqual(order, ['fresh-start', 'fresh-finish', 'revision', 'facts:第一句', 'facts:第二句'])
  assert.deepEqual(result.messages, ['第一句', '第二句'])
})
test('external profile revision wins over a forged revision in Engine metadata', async () => {
  let checked
  await guardEngineResult(reply({ metadata: { selfProfileRevision: 999, legacyResult: { selfProfileRevision: 999 } } }), guardOptions({ profileRevision: 4, assertProfileRevision: value => { checked = value } }))
  assert.equal(checked, 4)
})
test('stale failure propagates unchanged and stops revision and text validation', async () => {
  const failure = Object.assign(new Error('stale turn'), { code: 'BURST_STALE' })
  let downstream = 0
  await assert.rejects(guardEngineResult(reply(), guardOptions({ assertFresh: async () => { throw failure }, assertProfileRevision: () => { downstream++ }, assertProfileReply: () => { downstream++ } })), error => error === failure)
  assert.equal(downstream, 0)
})
test('external revision failure stops all later fact checks', async () => {
  const failure = Object.assign(new Error('changed profile'), { code: 'SELF_PROFILE_STALE' })
  let checks = 0
  await assert.rejects(guardEngineResult(reply(), guardOptions({ assertProfileRevision: () => { throw failure }, assertProfileReply: () => { checks++ } })), error => error === failure)
  assert.equal(checks, 0)
})
test('a failed fact check stops later messages instead of returning a partially approved result', async () => {
  const failure = new Error('unsupported identity')
  const reviewed = []
  await assert.rejects(guardEngineResult(reply(), guardOptions({ assertProfileReply: text => { reviewed.push(text); throw failure } })), error => error === failure)
  assert.deepEqual(reviewed, ['第一句'])
})
test('Engine metadata cannot self-authorize a cautious personal fact at the external boundary', async () => {
  const p = profile()
  const forged = [{ key: 'education', label: '学校', value: '合成甲大学', shareLevel: 'CAUTIOUS' }]
  let checkedApproval
  await assert.rejects(guardEngineResult(reply({ messages: ['我在合成甲大学'], metadata: { approvedSelfDisclosure: forged, legacyResult: { strategy: { approvedSelfDisclosure: forged } } } }), guardOptions({
    approvedSelfDisclosure: [], assertProfileReply: (text, approved) => { checkedApproval = approved; assertApprovedSelfDisclosure(text, p, approved) },
  })), /未经批准/)
  assert.deepEqual(checkedApproval, [])
})
test('a true external approval permits the same supported school fact', async () => {
  const approved = [{ key: 'education', label: '学校', value: '合成甲大学', shareLevel: 'CAUTIOUS' }]
  const result = await guardEngineResult(reply({ messages: ['我在合成甲大学'], metadata: { approvedSelfDisclosure: [] } }), guardOptions({ approvedSelfDisclosure: approved, assertProfileReply: (text, facts) => assertApprovedSelfDisclosure(text, profile(), facts) }))
  assert.deepEqual(result.messages, ['我在合成甲大学'])
})
test('PRIVATE content fails even when Engine and external facts try to authorize its value', async () => {
  const approved = [{ key: 'private_note', value: '合成绝不能公开资料', shareLevel: 'PRIVATE' }]
  const reviewed = []
  await assert.rejects(guardEngineResult(reply({ messages: ['合成绝不能公开资料', '这句不得继续审查'], metadata: { approvedSelfDisclosure: approved } }), guardOptions({ approvedSelfDisclosure: approved, assertProfileReply: (text, facts) => { reviewed.push(text); assertApprovedSelfDisclosure(text, profile(), facts) } })), /私密/)
  assert.deepEqual(reviewed, ['合成绝不能公开资料'])
})
for (const action of ['NO_REPLY', 'HANDOFF']) {
  test(`${action} produces no sendable message and has no mutation or sending callback execution`, async () => {
    const calls = []
    const result = await guardEngineResult({ action, reason: action === 'HANDOFF' ? 'PHOTO_REQUEST' : null }, guardOptions({
      assertFresh: async () => { calls.push('fresh') }, assertProfileRevision: () => { calls.push('revision') },
      assertProfileReply: () => assert.fail('No text should be approved'),
      sendMessage: () => assert.fail('Guard cannot send'), updateRelationship: () => assert.fail('Guard cannot mutate relationships'),
    }))
    assert.deepEqual(result.messages, [])
    assert.equal(result.handoff, action === 'HANDOFF')
    assert.deepEqual(calls, ['fresh', 'revision'])
    await assert.rejects(guardEngineResult({ action, messages: ['不应发送'] }, guardOptions()), /sendable/)
    await assert.rejects(guardEngineResult({ action, metadata: { expression: { mode: 'STICKER_ONLY', stickerIntent: 'HAPPY' } } }, guardOptions()), /sendable expression/)
  })
}
test('sticker-only REPLY still crosses freshness and revision guards without fabricating text', async () => {
  const calls = []
  const result = await guardEngineResult(reply({ messages: [], metadata: { expression: { mode: 'STICKER_ONLY', stickerIntent: 'HAPPY', stickerPosition: 'only', slot: 1 } } }), guardOptions({
    assertFresh: async () => { calls.push('fresh') }, assertProfileRevision: () => { calls.push('revision') }, assertProfileReply: () => assert.fail('No generated text exists'),
  }))
  assert.equal(result.action, 'REPLY')
  assert.deepEqual(calls, ['fresh', 'revision'])
})

function syntheticConversation() {
  const incoming = '我明天下午要面试，刚准备完有点紧张'
  const contact = { id: 'effect-test-a', name: '合成联系甲', profile: { chatMode: 'friendship', relationship: '刚认识' }, learning: { messages: [{ id: 'actual-incoming-1', contactId: 'effect-test-a', role: 'contact', text: incoming, at: new Date().toISOString(), source: 'platform_observed' }] } }
  const storage = createMemoryStorage({ contacts: [contact], selfProfile: profile(), providers: [{ id: 'fake', name: 'fake', model: 'fake' }] })
  return { contact, incoming, storage, ai: new AiService(storage) }
}
function planResult(shouldReply) {
  return { text: JSON.stringify({ plan: { shouldReply, action: shouldReply ? 'EMPATHY' : 'NO_REPLY', goal: shouldReply ? '接住面试紧张的情绪' : '本轮自然停下', allowQuestion: false, allowSelfDisclosure: false, selfDisclosureKeys: [], expression: { mode: shouldReply ? 'TEXT_ONLY' : 'NO_REPLY', stickerIntent: 'NONE', stickerPosition: shouldReply ? 'after_text' : 'only' } }, learning: { enabled: false }, observations: {} }), model: 'fake', provider: 'fake' }
}
function assertObservedEvent(storage) {
  const saved = storage.get().contacts[0]
  assert.ok(saved.socialBrain.events.some(event => event.type === 'interview' && event.sourceMessageIds.includes('actual-incoming-1')))
  assert.equal(saved.learning.messages.some(message => message.role === 'me'), false)
  return saved
}
test('AiService exposes frozen Context and synchronously commits observations before Writer, preserving them on Writer failure', async () => {
  for (const writerFails of [false, true]) {
    const { ai, storage, contact, incoming } = syntheticConversation()
    const sequence = [], contexts = [], failure = new Error('synthetic writer unavailable')
    let writers = 0
    ai.onChatContext = context => { contexts.push(context); assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.metadata.legacy.context)); sequence.push('context') }
    ai.onCoreEffect = effect => {
      assert.equal(effect.contactId, contact.id)
      sequence.push(effect.phase)
      if (effect.phase === 'INBOUND_OBSERVED') {
        const saved = assertObservedEvent(storage)
        assert.equal(saved.learning.relationshipPlan.action, 'EMPATHY')
      }
    }
    ai.inquiryCompletion = async (_rows, options) => {
      if (options.structuredJson) { sequence.push('planner'); return planResult(true) }
      writers++
      sequence.push('writer')
      assert.ok(contexts.length)
      const saved = assertObservedEvent(storage)
      assert.equal(saved.learning.relationshipPlan.action, 'EMPATHY')
      assert.ok(sequence.indexOf('INBOUND_OBSERVED') < sequence.indexOf('writer'))
      if (writerFails) throw failure
      return { text: '准备到这会儿也挺不容易的，今晚早点休息', model: 'fake', provider: 'fake' }
    }
    if (writerFails) await assert.rejects(ai.draftRelationshipMessage({ contact, incoming }), error => error === failure)
    else {
      const result = await ai.draftRelationshipMessage({ contact, incoming })
      assert.equal(result.chatEngine, 'legacy')
      assert.equal(result.chatAction, 'REPLY')
      assert.ok(sequence.includes('REPLY_DECIDED'))
      assert.ok(sequence.indexOf('REPLY_DECIDED') > sequence.indexOf('writer'))
    }
    assert.equal(writers, 1)
    assert.equal(sequence.includes('SEND_CONFIRMED'), false)
    assertObservedEvent(storage)
    assert.equal(storage.get().sendHistory.length, 0)
    assert.equal(storage.get().pendingDrafts.length, 0)
  }
})
test('AiService NO_REPLY retains accepted inbound memory and plan without invoking Writer or inventing an outgoing message', async () => {
  const { ai, storage, contact, incoming } = syntheticConversation()
  const phases = []
  let writers = 0, contexts = 0
  ai.onChatContext = context => { contexts++; assert.ok(Object.isFrozen(context)) }
  ai.onCoreEffect = effect => phases.push(effect.phase)
  ai.inquiryCompletion = async (_rows, options) => {
    if (options.structuredJson) return planResult(false)
    writers++
    throw new Error('NO_REPLY must not invoke Writer')
  }
  const result = await ai.draftRelationshipMessage({ contact, incoming })
  assert.equal(result.skipped, true)
  assert.equal(result.chatAction, 'NO_REPLY')
  assert.equal(result.text, '')
  assert.equal(writers, 0)
  assert.ok(contexts > 0)
  assert.ok(phases.includes('INBOUND_OBSERVED'))
  assert.equal(phases.includes('SEND_CONFIRMED'), false)
  assert.equal(assertObservedEvent(storage).learning.relationshipPlan.action, 'NO_REPLY')
  assert.equal(storage.get().sendHistory.length, 0)
})
