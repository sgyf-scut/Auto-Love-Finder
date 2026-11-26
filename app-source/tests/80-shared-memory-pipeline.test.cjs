const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { buildContext } = require('../electron/social-brain/context-builder.cjs')
const { parsePlan, planConversation, ACTIONS } = require('../electron/social-brain/conversation-planner.cjs')
const { writeReply } = require('../electron/social-brain/reply-writer.cjs')
const { buildSharedMemoryCandidates } = require('../electron/social-brain/shared-memory-extractor.cjs')
const { applySharedMemoryOperations, normalizeSharedMemory, deleteSharedMemory } = require('../electron/social-brain/shared-memory.cjs')
const { createSeedSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const now = new Date(), before = offset => new Date(+now - offset * 1000).toISOString()
function row(id, role, text, offset = 60, contactId = 'shared-a') {
  return { id, messageId: id, contactId, accountId: 'test-account', role, text, at: before(offset), type: 'text',
    source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}) }
}
function contact(id = 'shared-a', stage = 'FRIEND') {
  const rows = [row(id + ':c1', 'contact', '我喜欢英雄联盟，晚上常玩一会', 90, id), row(id + ':m1', 'me', '我也喜欢英雄联盟，玩游戏挺放松的', 80, id)]
  return { id, name: id, profile: { chatMode: 'friendship' }, relationshipJourney: { currentStage: stage, contactId: id }, learning: { messages: rows }, sharedMemoryLedger: rows }
}
function savedContact(stage = 'FRIEND') {
  const c = contact('shared-a', stage), candidates = buildSharedMemoryCandidates({ contact: c, messages: c.sharedMemoryLedger, now })
  assert.ok(candidates.length)
  c.sharedMemory = applySharedMemoryOperations(c, candidates.map(candidate => ({ action: 'CREATE', candidateId: candidate.id })), { candidates, now })
  return c
}
function harness(c = contact()) {
  const storage = createMemoryStorage({ contacts: [c], settings: { longTermMemory: true }, selfProfile: { revision: 0 } })
  const ai = new AiService(storage); ai.accountId = 'test-account'
  let calls = 0
  ai.inquiryCompletion = async rows => { calls++; const input = JSON.parse(rows[1].content); return { text: JSON.stringify({ operations: input.candidates.map(c => ({ action: c.existingMemoryId ? 'UPDATE' : 'CREATE', candidateId: c.id, ...(c.existingMemoryId ? { memoryId: c.existingMemoryId } : {}) })) }) } }
  return { ai, storage, calls: () => calls }
}
function plan(ids = [], action = 'REACTION') { return JSON.stringify({ plan: { shouldReply: action !== 'NO_REPLY', action, goal: '自然接住当前话题', allowQuestion: false, allowSelfDisclosure: false, sharedMemoryIds: ids }, learning: { enabled: false } }) }
function ctx(c = savedContact(), incoming = '英雄联盟又开新模式了') { return buildContext({ contact: c, incoming, now, attentionEnabled: false }) }

test('completed interaction queue is non-blocking and writes after model resolves', async () => {
  const h = harness(); let unblock, entered
  const reached = new Promise(resolve => { entered = resolve })
  h.ai.inquiryCompletion = async rows => { entered(); await new Promise(resolve => { unblock = resolve }); const candidate = JSON.parse(rows[1].content).candidates[0]; return { text: JSON.stringify({ operations: [{ action: 'CREATE', candidateId: candidate.id }] }) } }
  assert.deepEqual(h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a', accountId: 'test-account' }), { queued: true })
  const flushed = h.ai.flushSharedMemoryExtractions(); await reached
  assert.equal(h.storage.get().contacts[0].sharedMemory, undefined)
  unblock(); await flushed
  assert.equal(h.storage.get().contacts[0].sharedMemory.memories.length, 1)
})

test('ordinary greetings do not invoke extraction model', async () => {
  const c = contact(); c.sharedMemoryLedger = [row('m', 'me', '你好'), row('c', 'contact', '哈哈哈哈')]
  const h = harness(c); h.ai.queueSharedMemoryExtraction({ contactId: c.id }); await h.ai.flushSharedMemoryExtractions()
  assert.equal(h.calls(), 0)
})

test('legacy training and draft rows cannot replace real delivery ledger', async () => {
  const c = contact(); c.sharedMemoryLedger = []
  c.learning.messages.push({ ...row('fake', 'me', '我也喜欢英雄联盟'), source: 'manual_owner', human: true })
  const h = harness(c); h.storage.update({ pendingDrafts: [{ name: c.name, text: '我也喜欢英雄联盟' }] })
  h.ai.queueSharedMemoryExtraction({ contactId: c.id }); await h.ai.flushSharedMemoryExtractions()
  assert.equal(h.calls(), 0); assert.equal(h.storage.get().contacts[0].sharedMemory, undefined)
})

test('multiple same-contact queue signals debounce into one extraction', async () => {
  const h = harness(); for (let i = 0; i < 4; i++) h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a' })
  await h.ai.flushSharedMemoryExtractions(); assert.equal(h.calls(), 1)
})

test('another extraction cannot overlap for the same contact', async () => {
  const h = harness(); let active = 0, maximum = 0, unblock
  const initial = h.ai.inquiryCompletion
  h.ai.inquiryCompletion = async rows => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => { unblock = resolve }); const result = await initial(rows); active--; return result }
  h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a' }); const flush = h.ai.flushSharedMemoryExtractions()
  await new Promise(resolve => setImmediate(resolve)); h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a' })
  unblock(); await flush; assert.equal(maximum, 1); assert.equal(h.calls(), 1)
})

for (const invalidation of ['account', 'lifecycle', 'profile', 'contact_delete', 'store_revision', 'owner_guard', 'contact_identity']) {
  test(`late extraction cannot write after ${invalidation} changes`, async () => {
    const h = harness(); const initial = h.ai.inquiryCompletion
    h.ai.inquiryCompletion = async rows => {
      if (invalidation === 'account') h.ai.accountId = 'other-account'
      if (invalidation === 'lifecycle') h.ai.cancelSharedMemoryExtraction()
      if (invalidation === 'profile') h.storage.update({ selfProfile: { revision: 1 } })
      if (invalidation === 'contact_delete') h.storage.update({ contacts: [] })
      if (invalidation === 'store_revision') { const c = h.storage.get().contacts[0]; h.storage.update({ contacts: [{ ...c, sharedMemory: { ...normalizeSharedMemory(c), revision: 4 } }] }) }
      if (invalidation === 'owner_guard') h.ai.sharedMemoryIsCurrent = () => false
      if (invalidation === 'contact_identity') { const c = h.storage.get().contacts[0]; h.storage.update({ contacts: [{ ...c, profile: { platformUserId: 'replacement' } }] }) }
      return initial(rows)
    }
    h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a' }); await h.ai.flushSharedMemoryExtractions()
    assert.equal(h.storage.get().contacts[0]?.sharedMemory?.memories?.length || 0, 0)
  })
}

test('extraction transport errors only log and cannot fail the delivered turn', async () => {
  const h = harness(); h.ai.inquiryCompletion = async () => { throw new Error('synthetic transport failed') }
  assert.equal(h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a' }).queued, true)
  await assert.doesNotReject(h.ai.flushSharedMemoryExtractions())
  assert.ok(h.storage.get().logs.some(log => log.type === 'shared_memory_extraction_failed'))
})

test('two contacts extract their own evidence without overwriting each other', async () => {
  const h = harness(); const b = contact('shared-b'); h.storage.update({ contacts: [h.storage.get().contacts[0], b] })
  for (const c of h.storage.get().contacts) h.ai.queueSharedMemoryExtraction({ contactId: c.id })
  await h.ai.flushSharedMemoryExtractions()
  const [a, savedB] = h.storage.get().contacts
  assert.equal(a.sharedMemory.contactId, a.id); assert.equal(savedB.sharedMemory.contactId, savedB.id)
  assert.ok(savedB.sharedMemory.memories.every(m => m.sourceMessageIds.every(id => id.startsWith('shared-b:'))))
})

test('context exposes bounded relevant memory projections, separate from facts/profile', () => {
  const c = savedContact(), context = ctx(c)
  assert.ok(context.payload.relevantSharedMemories.length > 0 && context.payload.relevantSharedMemories.length <= 3)
  assert.equal(context.payload.relevantSharedMemories[0].contactId, c.id)
  assert.equal(context.memory.facts.some(f => f.value?.includes('双方在聊天中')), false)
  assert.equal(c.sharedMemory.memories[0].recallCount, 0)
})

test('Planner can ignore retrieved memories and keeps the existing action enum', () => {
  const context = ctx(); assert.ok(context.payload.relevantSharedMemories.length)
  const parsed = parsePlan(plan([]), context)
  assert.deepEqual(parsed.sharedMemoryIds, []); assert.deepEqual(parsed.approvedSharedMemories, [])
  assert.equal(ACTIONS.length, 13); assert.equal(ACTIONS.includes('CALLBACK'), false)
})

test('unknown/cross-contact memory IDs cannot enter a plan', () => {
  assert.throws(() => parsePlan(plan(['shared-other']), ctx()), /共同记忆/)
  assert.throws(() => parsePlan(plan(['a', 'b', 'c', 'd']), ctx()), /共同记忆/)
})

for (const action of ['NO_REPLY', 'CLOSE']) {
  test(`${action} cannot force recall despite selected memory IDs`, () => {
    const context = ctx(), id = context.payload.relevantSharedMemories[0].id
    const parsed = parsePlan(plan([id], action), context)
    assert.deepEqual(parsed.sharedMemoryIds, [])
  })
}

test('Writer receives only selected memories, and selection does not increment recall', async () => {
  const context = ctx(), chosen = context.payload.relevantSharedMemories[0]
  context.payload.relevantSharedMemories.push({ id: 'unselected', contactId: 'shared-a', type: 'SHARED_MOMENT', summary: 'UNSELECTED_MEMORY_SECRET' })
  const parsed = parsePlan(plan([chosen.id]), context); let sent
  await writeReply(async rows => { sent = JSON.parse(rows[1].content); return { text: '上次聊那个英雄联盟模式还挺有意思的' } }, context, parsed)
  assert.equal(sent.context.relevantSharedMemories, undefined)
  assert.deepEqual(sent.context.approvedSharedMemories.map(m => m.id), [chosen.id])
  assert.equal(JSON.stringify(sent).includes('UNSELECTED_MEMORY_SECRET'), false)
  assert.equal(context.contact.sharedMemory.memories[0].recallCount, 0)
})

test('Planner prompt declares recall optional and shared interest is not a shared activity', async () => {
  let system; const context = ctx()
  await planConversation(async rows => { system = rows[0].content; return { text: plan() } }, context)
  assert.match(system, /不代表必须回忆/); assert.match(system, /不等于一起玩/)
})

test('actual recall requires selected memory, confirmed ledger delivery, and textual callback use', () => {
  const c = savedContact(), h = harness(c), id = c.sharedMemory.memories[0].id
  assert.equal(h.ai.markSharedMemoryRecall({ contactId: c.id, sharedMemoryIds: [id], confirmedSent: false, outgoingMessageId: 'sent', text: '上次英雄联盟' }), false)
  assert.equal(h.ai.markSharedMemoryRecall({ contactId: c.id, sharedMemoryIds: [id], confirmedSent: true, outgoingMessageId: 'no-ledger', text: '上次英雄联盟' }), false)
  c.sharedMemoryLedger.push(row('sent-generic', 'me', '哈哈挺好的'), row('sent-callback', 'me', '上次聊的英雄联盟那个模式呀'))
  h.storage.update({ contacts: [c] })
  assert.equal(h.ai.markSharedMemoryRecall({ contactId: c.id, sharedMemoryIds: [id], confirmedSent: true, outgoingMessageId: 'sent-generic', text: '哈哈挺好的' }), false)
  assert.equal(h.ai.markSharedMemoryRecall({ contactId: c.id, sharedMemoryIds: [id], confirmedSent: true, outgoingMessageId: 'sent-callback', text: '上次聊的英雄联盟那个模式呀' }), true)
  assert.equal(h.ai.markSharedMemoryRecall({ contactId: c.id, sharedMemoryIds: [id], confirmedSent: true, outgoingMessageId: 'sent-callback', text: '上次聊的英雄联盟那个模式呀' }), false)
  assert.equal(h.storage.get().contacts[0].sharedMemory.memories[0].recallCount, 1)
})

test('training recorder remains outside shared ledger while actual observed burst is retained', () => {
  const h = harness(), ds = new DouyinService({ storage: h.storage, ai: h.ai, emit: () => {} }); ds.accountId = 'test-account'
  h.storage.update({ contacts: [{ ...contact(), sharedMemoryLedger: [] }] })
  ds.recordConversationMessage('shared-a', 'me', '我也喜欢英雄联盟', {}, { human: true, synthetic: true })
  assert.equal(h.storage.get().contacts[0].sharedMemoryLedger.length, 0)
  ds.recordSharedMemoryLedger('shared-a', [row('burst1', 'contact', '我喜欢英雄联盟'), row('burst2', 'contact', '我也喜欢健身'), { ...row('unsent', 'me', '我喜欢英雄联盟'), confirmedSent: false }])
  assert.deepEqual(h.storage.get().contacts[0].sharedMemoryLedger.map(row => row.id), ['burst1', 'burst2'])
  ds.recordConversationMessage('shared-a', 'me', '我也喜欢英雄联盟', {}, { human: false, confirmedSent: true, messageId: 'delivered' })
  const sent = h.storage.get().contacts[0].sharedMemoryLedger.at(-1)
  assert.equal(sent.source, 'platform_send_confirmed'); assert.equal(sent.contactId, 'shared-a'); assert.equal(sent.accountId, 'test-account')
})

test('deleted memory cannot be revived by a late extraction or next old-episode scan', async () => {
  const c = savedContact(), h = harness(c), initial = h.ai.inquiryCompletion
  const fresh = row('c2', 'contact', '我也喜欢游泳，经常放松一下', 30), response = row('m2', 'me', '我喜欢游泳，水里挺放松的', 20)
  c.sharedMemoryLedger.push(fresh, response); h.storage.update({ contacts: [c] })
  h.ai.inquiryCompletion = async rows => { const current = h.storage.get().contacts[0]; current.sharedMemory = deleteSharedMemory(current, current.sharedMemory.memories[0].id); h.storage.update({ contacts: [current] }); return initial(rows) }
  h.ai.queueSharedMemoryExtraction({ contactId: c.id }); await h.ai.flushSharedMemoryExtractions()
  assert.equal(h.storage.get().contacts[0].sharedMemory.memories.some(m => m.id === c.sharedMemory.memories[0].id), false)
})

test('memory disabled respects existing setting and wrong-account queue cannot run', async () => {
  const h = harness(); h.storage.update({ settings: { longTermMemory: false } })
  assert.equal(h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a' }).queued, false)
  h.storage.update({ settings: { longTermMemory: true } })
  assert.equal(h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a', accountId: 'other' }).queued, false)
  assert.equal(h.calls(), 0)
})

test('cancel before debounce stops scheduled extraction without touching stored data', async () => {
  const h = harness(); h.ai.queueSharedMemoryExtraction({ contactId: 'shared-a' }); h.ai.cancelSharedMemoryExtraction()
  await h.ai.flushSharedMemoryExtractions(); assert.equal(h.calls(), 0); assert.equal(h.storage.get().contacts[0].sharedMemory, undefined)
})

test('selected-memory deletion guard blocks sender before any editor action', async () => {
  const c = savedContact(), h = harness(c), id = c.sharedMemory.memories[0].id
  const ds = new DouyinService({ storage: h.storage, ai: h.ai, emit: () => {} }); let opened = 0
  ds.selectConversation = async () => { opened++; throw new Error('must not open') }
  h.storage.update({ contacts: [{ ...c, sharedMemory: deleteSharedMemory(c, id) }] })
  await assert.rejects(ds.sendMessage(c.name, '上次那个英雄联盟呀', { ai: true, sharedMemoryIds: [id], selfProfileRevision: 0 }), error => error.code === 'SHARED_MEMORY_STALE' && error.sendAttempted === false)
  assert.equal(opened, 0)
})

test('unrelated new shared memory revision does not invalidate a still-active selection', () => {
  const c = savedContact(), h = harness(c), id = c.sharedMemory.memories[0].id
  c.sharedMemory.revision++
  h.storage.update({ contacts: [c] }); assert.equal(h.ai.assertSharedMemorySelection(c.id, [id], 0), true)
})

for (const stage of ['ACQUAINTANCE', 'FRIEND']) {
  test(`${stage} existing Writer receives selected shared memory and late deletion stops reply`, async () => {
    const c = savedContact(stage), h = harness(c), id = c.sharedMemory.memories[0].id
    c.learning.messages.push(row('c-current', 'contact', '英雄联盟新模式开了', 0)); h.storage.update({ contacts: [c], providers: [{ id: 'fake', name: 'fake', model: 'test-model', baseUrl: 'https://example.test' }], selfProfile: undefined,
      settings: { longTermMemory: true, twoMessageChance: 0, favoriteStickerEnabled: false } })
    const calls = []; let writerPayload
    h.ai.inquiryCompletion = async (rows, options) => {
      if (rows[0].content.includes('关系上下文评估器')) { const input = JSON.parse(rows[1].content); return { text: JSON.stringify({ currentStage: input.currentStage, suggestedStage: input.currentStage, confidence: 0.95, reasons: ['保持当前状态'], evidenceIds: input.relationshipEvidence.map(item => item.id) }) } }
      if (options.structuredJson) { calls.push('planner'); return { text: plan([id]) } }
      calls.push('writer'); writerPayload = JSON.parse(rows[1].content); const current = h.storage.get().contacts[0]; h.storage.update({ contacts: [{ ...current, sharedMemory: deleteSharedMemory(current, id) }] }); return { text: '上次那个英雄联盟模式挺好玩的' }
    }
    h.ai.post = async (_url, _options, body) => {
      calls.push('mature_writer'); writerPayload = JSON.parse(body)
      const current = h.storage.get().contacts[0]; h.storage.update({ contacts: [{ ...current, sharedMemory: deleteSharedMemory(current, id) }] })
      return { choices: [{ message: { content: '上次那个英雄联盟模式挺好玩的' } }] }
    }
    await assert.rejects(h.ai.draft({ contact: c, incoming: '英雄联盟新模式开了' }), error => error.code === 'SHARED_MEMORY_STALE')
    assert.equal(calls.filter(kind => kind === 'planner').length, 1)
    assert.equal(calls.filter(kind => /writer/.test(kind)).length, 1)
    assert.ok(JSON.stringify(writerPayload).includes(id))
    assert.equal(h.storage.get().contacts[0].sharedMemory.memories.length, 0)
  })
}

test('PRIVATE self-profile value remains excluded from extraction and recall contexts', async () => {
  const h = harness(); const profile = createSeedSelfProfile({ now }); profile.revision = 9
  const privateItem = profile.stableProfile.find(item => item.shareLevel === 'PRIVATE')
  if (privateItem) privateItem.value = 'PRIVATE_SHARED_FIXTURE'
  else profile.stableProfile.push({ id: 'private-qa', key: 'contactSecret', label: '秘密', value: 'PRIVATE_SHARED_FIXTURE', status: 'confirmed', shareLevel: 'PRIVATE' })
  h.storage.update({ selfProfile: profile })
  const current = h.storage.get().contacts[0]; current.sharedMemoryLedger.push(row('private-c', 'contact', 'PRIVATE_SHARED_FIXTURE')); h.storage.update({ contacts: [current] })
  let prompt = ''
  const initial = h.ai.inquiryCompletion
  h.ai.inquiryCompletion = async rows => { prompt = JSON.stringify(rows); return initial(rows) }
  h.ai.queueSharedMemoryExtraction({ contactId: current.id }); await h.ai.flushSharedMemoryExtractions()
  assert.equal(prompt.includes('PRIVATE_SHARED_FIXTURE'), false)
  const context = buildContext({ contact: h.storage.get().contacts[0], selfProfile: profile, incoming: '英雄联盟那个模式', now, attentionEnabled: false })
  assert.equal(JSON.stringify(context.payload).includes('PRIVATE_SHARED_FIXTURE'), false)
})

test('new live burst can use observed time without inventing historical message date', () => {
  const h = harness(), ds = new DouyinService({ storage: h.storage, ai: h.ai, emit: () => {} }); ds.accountId = 'test-account'
  h.storage.update({ contacts: [{ ...contact(), sharedMemoryLedger: [] }] })
  ds.recordSharedMemoryLedger('shared-a', [
    { id: 'observed-live', role: 'contact', text: '我喜欢游泳', receivedAt: +now },
    { id: 'preview', role: 'contact', text: '预览不是完整原话', receivedAt: +now, previewOnly: true },
    { id: 'old-undated', role: 'contact', text: '旧历史没有日期' },
  ])
  const ledger = h.storage.get().contacts[0].sharedMemoryLedger
  assert.equal(ledger.length, 1); assert.equal(ledger[0].id, 'observed-live')
  assert.equal(ledger[0].timestampSource, 'observed_at')
})

test('shared topic mention without callback is not counted as recalled', () => {
  const c = savedContact(), h = harness(c), id = c.sharedMemory.memories[0].id
  c.sharedMemoryLedger.push(row('topic-only', 'me', '英雄联盟又更新新角色了'))
  h.storage.update({ contacts: [c] })
  assert.equal(h.ai.markSharedMemoryRecall({ contactId: c.id, sharedMemoryIds: [id], outgoingMessageId: 'topic-only', confirmedSent: true, text: '英雄联盟又更新新角色了' }), false)
})
