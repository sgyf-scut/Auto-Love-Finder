const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SHARED_MEMORY_TYPES, normalizeSharedMemory, applySharedMemoryOperations, deleteSharedMemory, markSharedMemoryRecalled, sharedMemoryMessages } = require('../electron/social-brain/shared-memory.cjs')
const { buildSharedMemoryCandidates, extractSharedMemories } = require('../electron/social-brain/shared-memory-extractor.cjs')
const { retrieveSharedMemories } = require('../electron/social-brain/shared-memory-retriever.cjs')
const { buildRelationshipJourney, normalizeJourney, evaluateRelationshipJourney } = require('../electron/social-brain/relationship-journey.cjs')
const at = (d = 1, m = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(m).padStart(2, '0')}:00+08:00`
const now = d => Date.parse(at(d, 59))
const person = (id = 'a', extra = {}) => ({ id, name: '同名联系人', profile: {}, ...extra })
const row = (id, role, text, d = 1, m = 0, extra = {}) => ({ id, contactId: 'a', role, text, at: at(d, m), source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}), ...extra })
const discovery = (d = 1) => [row(`c${d}`, 'contact', '我玩英雄联盟，主要打辅助', d, 1), row(`m${d}`, 'me', '我也玩英雄联盟，我爱玩打野', d, 2)]
const support = [row('s1', 'contact', '明天答辩，好紧张啊', 1, 1), row('s2', 'me', '别慌，论文准备那么久了，加油', 1, 2)]
const result = [row('r1', 'contact', '过了哈哈哈哈', 2, 1), row('r2', 'me', '牛啊，恭喜你终于过了', 2, 2)]
const joke = d => [row(`j${d}c`, 'contact', '我又去实验室坐牢了哈哈', d, 1), row(`j${d}m`, 'me', '哈哈实验室坐牢排队入场', d, 2)]
function create(contact, messages, d = 1, types) {
  const candidates = buildSharedMemoryCandidates({ contact, messages, now: now(d) })
  const operations = candidates.filter(item => !types || types.includes(item.type)).map(item => ({ action: item.existingMemoryId ? 'UPDATE' : 'CREATE', candidateId: item.id, ...(item.existingMemoryId ? { memoryId: item.existingMemoryId } : {}) }))
  return applySharedMemoryOperations(contact, operations, { candidates, now: now(d) })
}
const selectAll = async prompts => {
  const payload = JSON.parse(prompts[1].content)
  return { text: JSON.stringify({ operations: payload.candidates.map(candidate => ({ action: candidate.existingMemoryId ? 'UPDATE' : 'CREATE', candidateId: candidate.id, ...(candidate.existingMemoryId ? { memoryId: candidate.existingMemoryId } : {}) })) }) }
}

test('ten shared types are fixed and distinct from facts/profile/events', () => {
  assert.equal(SHARED_MEMORY_TYPES.length, 10)
  const contact = person('a', { memory: { facts: ['likes LOL'], events: ['exam'] }, selfProfile: { interests: 'LOL' } })
  const store = normalizeSharedMemory(contact, { now: now(1) })
  assert.equal(store.contactId, 'a'); assert.deepEqual(store.memories, []); assert.equal(store.revision, 0)
})
test('ordinary greetings and simple acknowledgements do not create shared memory or call a model', async () => {
  for (const text of ['哈哈哈哈', '今天吃饭了', '在干嘛', '嗯嗯', '好的', '你好']) {
    let calls = 0
    const output = await extractSharedMemories(async () => { calls++ }, { contact: person(), messages: [row('x', 'contact', text), row('y', 'me', '嗯嗯', 1, 1)], now: now(1) })
    assert.equal(calls, 0); assert.equal(output.evaluated, false); assert.deepEqual(output.sharedMemory.memories, [])
  }
})
test('first actual mutual gaming discovery creates shared interaction not an invented activity', () => {
  const store = create(person(), discovery())
  assert.equal(store.memories.length, 1)
  const item = store.memories[0]
  assert.equal(item.type, 'MUTUAL_DISCOVERY'); assert.deepEqual(item.participants, ['self', 'contact'])
  assert.match(item.summary, /不代表曾一起/); assert.deepEqual(item.sourceMessageIds, ['c1', 'm1'])
  assert.equal(item.sourceContactId, 'a'); assert.equal(item.recallCount, 0); assert.equal(item.status, 'active')
})
test('single sided interest and contact facts are not shared experiences', () => {
  for (const rows of [[discovery()[0]], [discovery()[0], row('ok', 'me', '嗯')], [discovery()[0], row('q', 'me', '你玩哪个游戏？')]]) assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: rows, now: now(1) }), [])
})
test('negative preferences are not positive common ground', () => {
  for (const text of ['我不玩英雄联盟', '我不喜欢英雄联盟', '我讨厌英雄联盟', '我没玩英雄联盟']) {
    assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: [discovery()[1], row('n', 'contact', text)], now: now(1) }), [])
  }
})
test('future intent does not become a completed activity or factual mutual discovery', () => {
  const rows = [row('p1', 'contact', '我准备玩英雄联盟'), row('p2', 'me', '我明天准备玩英雄联盟', 1, 1)]
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: rows, now: now(1) }), [])
})
test('both visited Xian independently remains discovery rather than shared travel', () => {
  const store = create(person(), [row('x1', 'contact', '我去过西安，城墙很不错'), row('x2', 'me', '我也去过西安，挺喜欢城墙', 1, 1)])
  assert.ok(store.memories.length > 0); assert.ok(store.memories.every(item => item.type !== 'SHARED_MOMENT'))
  assert.match(store.memories[0].summary, /不代表曾一起/)
})
test('actual bilateral confirmation of a shared activity is preserved', () => {
  const store = create(person(), [row('a1', 'contact', '昨天我们一起玩英雄联盟挺开心'), row('a2', 'me', '昨天我们一起玩英雄联盟确实开心', 1, 1)])
  assert.ok(store.memories.some(item => item.type === 'SHARED_MOMENT'))
})
test('third party activities and negative or conflicting participation cannot become shared activity', () => {
  for (const texts of [['昨天我和小王一起玩英雄联盟', '昨天我和小李一起玩英雄联盟'], ['昨天我们没有一起玩英雄联盟', '昨天我们一起玩英雄联盟'], ['昨天我们一起玩英雄联盟', '今天我们一起玩英雄联盟']]) {
    const items = buildSharedMemoryCandidates({ contact: person(), messages: [row('a1', 'contact', texts[0]), row('a2', 'me', texts[1], 1, 1)], now: now(1) })
    assert.ok(items.every(item => item.type !== 'SHARED_MOMENT'))
  }
})
test('a future agreement is saved as a promise, never as an accomplished moment', () => {
  const store = create(person(), [row('p1', 'contact', '周末一起玩英雄联盟吧'), row('p2', 'me', '好，周末一起打', 1, 1)])
  assert.equal(store.memories.length, 1); assert.equal(store.memories[0].type, 'PROMISE'); assert.match(store.memories[0].summary, /尚未发生/)
})
test('unaccepted and rejected invitations are not mutual promises', () => {
  for (const text of ['看情况吧', '不想一起', '再说吧']) assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: [row('i', 'contact', '周末一起玩英雄联盟吧'), row('r', 'me', text, 1, 1)], now: now(1) }), [])
})
test('defense support becomes one complete updated episode across days', () => {
  const initial = create(person(), support, 1)
  const original = initial.memories[0]
  const updated = create(person('a', { sharedMemory: initial }), result, 2)
  assert.equal(updated.memories.length, 1); assert.equal(updated.memories[0].id, original.id)
  assert.equal(updated.memories[0].createdAt, original.createdAt); assert.equal(updated.memories[0].type, 'SUPPORT_MOMENT')
  assert.equal(updated.memories[0].sourceMessageIds.length, 4); assert.match(updated.memories[0].summary, /之后/)
  assert.ok(updated.memories[0].strength > original.strength)
})
test('event resolve alone cannot fabricate a shared episode and does not mutate events', () => {
  const events = [{ id: 'e', type: 'exam', status: 'resolved', eventAt: '2026-10-02', followUpAt: at(2), sourceMessageIds: ['s1'] }]
  const previous = JSON.stringify(events)
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: [], events, now: now(2) }), [])
  create(person(), [...support, ...result], 2)
  assert.equal(JSON.stringify(events), previous)
})
test('resolved event plus actual bilateral support and result can yield a shared memory', async () => {
  const events = [{ status: 'resolved', type: 'presentation', sourceMessageIds: ['s1', 'r1'] }]
  const out = await extractSharedMemories(selectAll, { contact: person(), messages: [...support, ...result], events, now: now(2) })
  assert.equal(out.sharedMemory.memories.length, 1); assert.match(out.sharedMemory.memories[0].summary, /结果/)
})
test('a result explicitly about another event cannot resolve the defense shared episode', () => {
  const store = create(person(), [...support, row('e1', 'contact', '今天考试通过了', 2, 1), row('e2', 'me', '恭喜考试过了', 2, 2)], 2)
  const defense = store.memories.find(item => item.type === 'SUPPORT_MOMENT')
  assert.equal(defense.sourceMessageIds.length, 2); assert.match(defense.summary, /尚未推断/)
})
test('different defense episodes separated by weeks are not merged', () => {
  const rows = [...support, ...result, row('late1', 'contact', '第二场答辩好紧张', 15, 1), row('late2', 'me', '第二场也加油', 15, 2)]
  const store = create(person(), rows, 15)
  assert.equal(store.memories.filter(item => item.type === 'SUPPORT_MOMENT').length, 2)
})
test('same event repeated without new sources is idempotent', () => {
  const first = create(person(), [...support, ...result], 2)
  const second = create(person('a', { sharedMemory: first }), [...support, ...result], 2)
  assert.equal(second.revision, first.revision); assert.equal(second.memories.length, 1)
})
test('a fact with a date but no response remains contact memory, not shared history', () => {
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: [row('d', 'contact', '我明天答辩'), row('k', 'me', '好的', 1, 1)], now: now(1) }), [])
})
test('first playful laboratory phrase is not an inside joke', () => {
  assert.ok(buildSharedMemoryCandidates({ contact: person(), messages: joke(1), now: now(1) }).every(item => item.type !== 'INSIDE_JOKE'))
})
test('repeated unilateral jokes cannot fabricate mutual adoption', () => {
  const messages = [joke(1)[0], row('m1', 'me', '辛苦了', 1, 2), joke(2)[0], row('m2', 'me', '早点休息', 2, 2)]
  assert.ok(buildSharedMemoryCandidates({ contact: person(), messages, now: now(2) }).every(item => item.type !== 'INSIDE_JOKE'))
})
test('repeated real bilateral uses form and gradually strengthen one inside joke', () => {
  const first = create(person(), [...joke(1), ...joke(2)], 2, ['INSIDE_JOKE'])
  const initial = first.memories.find(item => item.type === 'INSIDE_JOKE')
  assert.ok(initial); assert.equal(initial.strength, 0.68)
  const later = create(person('a', { sharedMemory: first }), joke(3), 3, ['INSIDE_JOKE'])
  assert.equal(later.memories.filter(item => item.type === 'INSIDE_JOKE').length, 1)
  assert.equal(later.memories[0].id, initial.id); assert.equal(later.memories[0].strength, 0.78)
})
test('repeating a phrase many times within one day does not make a mature joke', () => {
  const messages = [...joke(1), ...joke(1).map((item, i) => ({ ...item, id: `again${i}`, at: at(1, 10 + i) }))]
  assert.ok(buildSharedMemoryCandidates({ contact: person(), messages, now: now(1) }).every(item => item.type !== 'INSIDE_JOKE'))
})
test('literal prison statements are not classified as playful laboratory jokes', () => {
  const messages = [...joke(1), ...joke(2)].map(item => ({ ...item, text: `真的被抓了 ${item.text}` }))
  assert.ok(buildSharedMemoryCandidates({ contact: person(), messages, now: now(2) }).every(item => item.type !== 'INSIDE_JOKE'))
})
test('emotional moment requires explicit comfort and acknowledgement of relief', () => {
  const rows = [row('em1', 'contact', '今天好难过，工作搞砸了'), row('em2', 'me', '我在，想说就听你说', 1, 1), row('em3', 'contact', '谢谢，聊完好多了', 1, 2)]
  const store = create(person(), rows)
  assert.ok(store.memories.some(item => item.type === 'EMOTIONAL_MOMENT'))
  assert.ok(buildSharedMemoryCandidates({ contact: person(), messages: rows.slice(0, 2), now: now(1) }).every(item => item.type !== 'EMOTIONAL_MOMENT'))
})
test('celebration is an actual supportive conversation, not imaginary joint attendance', () => {
  const store = create(person(), [row('cc1', 'contact', '我今天终于录取了'), row('cc2', 'me', '恭喜啊太好了', 1, 1)])
  assert.equal(store.memories[0].type, 'CELEBRATION'); assert.match(store.memories[0].summary, /不推断线下/)
})
test('conflict and repair requires explicit apology accepted by the other person', () => {
  const rows = [row('co1', 'contact', '你这样开玩笑让我很不舒服'), row('co2', 'me', '对不起，我不该这么说', 1, 1), row('co3', 'contact', '没关系，不生气了', 1, 2)]
  assert.ok(create(person(), rows).memories.some(item => item.type === 'CONFLICT_AND_REPAIR'))
  assert.ok(buildSharedMemoryCandidates({ contact: person(), messages: rows.slice(0, 2), now: now(1) }).every(item => item.type !== 'CONFLICT_AND_REPAIR'))
})
test('cross-day actual topic callback is distinct from topic state', () => {
  const messages = [...discovery(), row('cb1', 'contact', '上次你说英雄联盟打野，我昨天也练了', 3, 1), row('cb2', 'me', '哈哈那英雄联盟打野真有意思', 3, 2)]
  const contact = person('a', { conversationState: { activeTopic: 'LOL' } })
  const old = JSON.stringify(contact.conversationState)
  const store = create(contact, messages, 3)
  assert.ok(store.memories.some(item => item.type === 'CALLBACK_CHAIN')); assert.equal(JSON.stringify(contact.conversationState), old)
})
test('model selects verified candidates and cannot rewrite shared summary or participants', async () => {
  const output = await extractSharedMemories(async prompts => {
    const payload = JSON.parse(prompts[1].content)
    return { text: JSON.stringify({ operations: [{ action: 'CREATE', candidateId: payload.candidates[0].id, summary: '我们一起去过西安', participants: ['self', 'contact', 'other'] }] }) }
  }, { contact: person(), messages: discovery(), now: now(1) })
  assert.match(output.sharedMemory.memories[0].summary, /不代表曾一起/); assert.deepEqual(output.sharedMemory.memories[0].participants, ['self', 'contact'])
})
test('model cannot invent candidate IDs or new memory types', async () => {
  await assert.rejects(extractSharedMemories(async () => ({ text: JSON.stringify({ operations: [{ action: 'CREATE', candidateId: 'foreign', type: 'ROMANCE' }] }) }), { contact: person(), messages: discovery(), now: now(1) }), /未知或其他/)
  await assert.rejects(extractSharedMemories(async () => ({ text: '{"operations":[{"action":"SCORE_UP"}]}' }), { contact: person(), messages: discovery(), now: now(1) }), /操作无效/)
})
test('model malformed JSON remains an explicit extraction error', async () => {
  await assert.rejects(extractSharedMemories(async () => ({ text: 'not json' }), { contact: person(), messages: discovery(), now: now(1) }), /有效JSON/)
})
test('NO_MEMORY consumes a checked batch but creates no memory, preventing repeated calls', async () => {
  let calls = 0
  const completion = async () => { calls++; return { text: '{"operations":[{"action":"NO_MEMORY"}]}' } }
  const first = await extractSharedMemories(completion, { contact: person(), messages: discovery(), now: now(1) })
  assert.equal(first.sharedMemory.memories.length, 0); assert.equal(first.sharedMemory.revision, 1)
  await extractSharedMemories(completion, { contact: person('a', { sharedMemory: first.sharedMemory }), messages: discovery(), now: now(1) })
  assert.equal(calls, 1)
})
test('UPDATE requires the matching episode ID and preserves previous record identity', () => {
  const first = create(person(), support)
  const contact = person('a', { sharedMemory: first }), candidates = buildSharedMemoryCandidates({ contact, messages: result, now: now(2) })
  assert.throws(() => applySharedMemoryOperations(contact, [{ action: 'UPDATE', candidateId: candidates[0].id, memoryId: 'wrong' }], { candidates, now: now(2) }), /更新目标/)
})
test('MERGE accepts checked celebration sources within a fuller support episode', () => {
  const celebration = [row('z1', 'contact', '我今天终于通过了', 2, 1), row('z2', 'me', '恭喜啊牛', 2, 2)]
  const first = create(person(), celebration, 2)
  assert.equal(first.memories[0].type, 'CELEBRATION')
  const contact = person('a', { sharedMemory: first }), candidates = buildSharedMemoryCandidates({ contact, messages: [...support, ...celebration], now: now(2) })
  const candidate = candidates.find(item => item.type === 'SUPPORT_MOMENT')
  const merged = applySharedMemoryOperations(contact, [{ action: 'MERGE', candidateId: candidate.id, memoryIds: [first.memories[0].id] }], { candidates, now: now(2) })
  assert.equal(merged.memories.length, 1); assert.equal(merged.memories[0].type, 'SUPPORT_MOMENT')
  assert.ok(merged.tombstones.some(item => item.id === first.memories[0].id))
})
test('MERGE rejects unrelated experiences and foreign IDs', () => {
  const first = create(person(), discovery()), contact = person('a', { sharedMemory: first }), candidates = buildSharedMemoryCandidates({ contact, messages: support, now: now(1) })
  const candidate = candidates.find(item => item.type === 'SUPPORT_MOMENT')
  for (const id of [first.memories[0].id, 'foreign']) assert.throws(() => applySharedMemoryOperations(contact, [{ action: 'MERGE', candidateId: candidate.id, memoryIds: [id] }], { candidates, now: now(1) }), /不能合并/)
})
test('raw copied candidate objects cannot bypass provenance certification', () => {
  const candidates = buildSharedMemoryCandidates({ contact: person(), messages: discovery(), now: now(1) })
  const copied = JSON.parse(JSON.stringify(candidates))
  assert.throws(() => applySharedMemoryOperations(person(), [{ action: 'CREATE', candidateId: copied[0].id }], { candidates: copied, now: now(1) }), /未知或其他/)
})
test('candidate sources and topics are immutable throughout an asynchronous model call', () => {
  const candidate = buildSharedMemoryCandidates({ contact: person(), messages: discovery(), now: now(1) })[0]
  assert.ok(Object.isFrozen(candidate)); assert.ok(Object.isFrozen(candidate.sourceMessages[0])); assert.ok(Object.isFrozen(candidate.relationshipImpact))
})
test('contact shared memory is isolated even for the same display name', () => {
  const store = create(person(), discovery())
  assert.equal(normalizeSharedMemory(person('b', { sharedMemory: store }), { now: now(1) }).memories.length, 0)
  assert.deepEqual(retrieveSharedMemories({ contact: person('b', { sharedMemory: store }), activeTopic: '英雄联盟', relationshipStage: 'FRIEND', now: now(3) }), [])
})
test('relabelled foreign memory fails its contact-bound ID and fingerprint', () => {
  const store = create(person(), discovery())
  const swapped = JSON.parse(JSON.stringify(store)); swapped.contactId = 'b'
  for (const memory of swapped.memories) { memory.contactId = 'b'; memory.sourceContactId = 'b'; for (const source of memory.sourceMessages) source.contactId = 'b' }
  assert.equal(normalizeSharedMemory(person('b', { sharedMemory: swapped }), { now: now(1) }).memories.length, 0)
})
test('sources from two contacts are never joined into one memory', () => {
  const rows = discovery(); rows[1].contactId = 'b'
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: rows, now: now(1) }), [])
})
test('drafts failed messages and training synthetic human labels are excluded', () => {
  const original = discovery()
  for (const extra of [{ status: 'draft' }, { status: 'failed' }, { source: 'manual_owner', human: true, verifiedHuman: true }, { source: 'contact_human', human: true }, { source: 'training_synthetic', status: 'sent' }]) {
    const rows = [original[0], { ...original[1], ...extra }]
    assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: rows, now: now(1) }), [])
  }
})
test('unconfirmed platform outgoing and legacy source-free learned rows cannot establish shared history', () => {
  const rows = discovery().map(item => ({ ...item, source: undefined, status: undefined, confirmedSent: undefined }))
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person('a', { learning: { messages: rows } }), now: now(1) }), [])
  const unconfirmed = discovery(); delete unconfirmed[1].status; delete unconfirmed[1].confirmedSent
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: unconfirmed, now: now(1) }), [])
})
test('invalid dates future dates OCR media and quoted third-party speech cannot supply evidence', () => {
  for (const extra of [{ at: 'unknown' }, { at: at(9) }, { type: 'image' }, { textSource: 'ocr' }, { source: 'visual_interpretation' }, { quote: { text: 'other' } }, { text: '她说我玩英雄联盟' }]) {
    const rows = [discovery()[0], { ...discovery()[1], ...extra }]
    assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: rows, now: now(1) }), [])
  }
})
test('private-source and private-profile values cannot enter candidates', () => {
  const rows = discovery()
  assert.deepEqual(sharedMemoryMessages([{ ...rows[0], private: true }, rows[1]], person(), { now: now(1) }).map(item => item.role), ['me'])
  const selfProfile = { enabled: true, stableProfile: [{ id: 'p', key: 'secret', value: '英雄联盟', sourceText: '英雄联盟', shareLevel: 'PRIVATE', status: 'confirmed' }], currentLife: [], privacyPreferences: [] }
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person(), messages: rows, selfProfile, now: now(1) }), [])
})
test('visible ledger corrections invalidate stored shared sources', () => {
  const store = create(person(), discovery())
  const ledger = discovery().map(item => item.role === 'me' ? { ...item, status: 'failed' } : item)
  assert.equal(normalizeSharedMemory(person('a', { sharedMemory: store, sharedMemoryLedger: ledger }), { now: now(1) }).memories.length, 0)
})
test('metadata and summary edits invalidate a stored source fingerprint', () => {
  const store = create(person(), discovery())
  for (const modify of [item => { item.summary = '我们一起去过西安' }, item => { item.topics = ['实验室坐牢'] }, item => { item.strength = 1 }]) {
    const altered = JSON.parse(JSON.stringify(store)); modify(altered.memories[0])
    assert.equal(normalizeSharedMemory(person('a', { sharedMemory: altered }), { now: now(1) }).memories.length, 0)
  }
})
test('manual deletion records a tombstone and never resurrects the old episode', () => {
  const store = create(person(), discovery()), id = store.memories[0].id
  const deleted = deleteSharedMemory(person('a', { sharedMemory: store }), id, { now: now(2) })
  assert.equal(deleted.memories.length, 0); assert.equal(deleted.tombstones.length, 1); assert.equal(deleted.revision, store.revision + 1)
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person('a', { sharedMemory: deleted }), messages: discovery(), now: now(3) }), [])
})
test('a pending extraction cannot re-create a deleted episode even with previously certified candidates', () => {
  const store = create(person(), discovery()), contact = person('a', { sharedMemory: store }), candidates = buildSharedMemoryCandidates({ contact, messages: [...discovery(), ...joke(2)], now: now(2) })
  const deleted = deleteSharedMemory(contact, store.memories[0].id, { now: now(2) })
  assert.throws(() => applySharedMemoryOperations(person('a', { sharedMemory: deleted }), [], { candidates, expectedRevision: store.revision, now: now(2) }), error => error.code === 'SHARED_MEMORY_STALE')
})
test('delete is contact-scoped and idempotent for missing IDs', () => {
  const store = create(person(), discovery())
  assert.equal(deleteSharedMemory(person('a', { sharedMemory: store }), 'missing', { now: now(1) }).revision, store.revision)
  assert.equal(deleteSharedMemory(person('b', { sharedMemory: store }), store.memories[0].id, { now: now(1) }).memories.length, 0)
})
test('recall is updated only for confirmed sends and is idempotent per outgoing ID', () => {
  const store = create(person(), discovery()), id = store.memories[0].id, contact = person('a', { sharedMemory: store })
  for (const options of [{ confirmedSent: false, outgoingMessageId: 'o' }, { confirmedSent: true }]) assert.equal(markSharedMemoryRecalled(contact, [id], { now: now(2), ...options }).memories[0].recallCount, 0)
  const marked = markSharedMemoryRecalled(contact, [id], { now: now(2), confirmedSent: true, outgoingMessageId: 'o' })
  assert.equal(marked.memories[0].recallCount, 1); assert.equal(marked.memories[0].lastRecalledAt, new Date(now(2)).toISOString())
  assert.equal(markSharedMemoryRecalled(person('a', { sharedMemory: marked }), [id], { now: now(2), confirmedSent: true, outgoingMessageId: 'o' }).memories[0].recallCount, 1)
})
test('recall counts cannot affect another contact or deleted memory', () => {
  const store = create(person(), discovery()), id = store.memories[0].id
  assert.equal(markSharedMemoryRecalled(person('b', { sharedMemory: store }), [id], { confirmedSent: true, outgoingMessageId: 'x', now: now(2) }).memories.length, 0)
  const deleted = deleteSharedMemory(person('a', { sharedMemory: store }), id, { now: now(2) })
  assert.equal(markSharedMemoryRecalled(person('a', { sharedMemory: deleted }), [id], { confirmedSent: true, outgoingMessageId: 'x', now: now(2) }).memories.length, 0)
})
test('retriever returns relevant optional history, never the whole store', () => {
  const store = create(person(), [...discovery(), ...support, ...result, ...joke(1), ...joke(2)], 2)
  const contact = person('a', { sharedMemory: store })
  const gaming = retrieveSharedMemories({ contact, activeTopic: '英雄联盟', relationshipStage: 'FRIEND', now: now(3) })
  assert.ok(gaming.length > 0); assert.ok(gaming.every(item => item.topics.includes('英雄联盟')))
  assert.ok(gaming.every(item => item.usageOptional && !item.sourceMessages)); assert.ok(gaming.length <= 3)
  assert.deepEqual(retrieveSharedMemories({ contact, activeTopic: '天气', relationshipStage: 'FRIEND', now: now(3) }), [])
})
test('paper topic retrieves the earlier complete defense-support episode', () => {
  const store = create(person(), [...support, ...result], 2)
  const recalled = retrieveSharedMemories({ contact: person('a', { sharedMemory: store }), activeTopic: '论文', relationshipStage: 'FAMILIAR', now: now(5) })
  assert.equal(recalled[0].type, 'SUPPORT_MOMENT'); assert.match(recalled[0].summary, /之后/)
})
test('friend stages increase callback preference without forcing use', () => {
  const contact = person('a', { sharedMemory: create(person(), discovery()) })
  const early = retrieveSharedMemories({ contact, activeTopic: '英雄联盟', relationshipStage: 'EXPLORING', now: now(3) })
  const friend = retrieveSharedMemories({ contact, activeTopic: '英雄联盟', relationshipStage: 'FRIEND', now: now(3) })
  assert.ok(friend[0].relevance > early[0].relevance); assert.equal(friend[0].usageOptional, true)
})
test('stranger and exploring stages never recall a familiar inside joke', () => {
  const contact = person('a', { sharedMemory: create(person(), [...joke(1), ...joke(2)], 2, ['INSIDE_JOKE']) })
  for (const stage of ['STRANGER', 'EXPLORING']) assert.deepEqual(retrieveSharedMemories({ contact, activeTopic: '实验室', relationshipStage: stage, now: now(3) }), [])
  assert.equal(retrieveSharedMemories({ contact, activeTopic: '实验室', relationshipStage: 'FRIEND', now: now(3) })[0].type, 'INSIDE_JOKE')
})
test('distress refusal and serious empathy prevent teasing callbacks even for friends', () => {
  const contact = person('a', { sharedMemory: create(person(), [...joke(1), ...joke(2)], 2, ['INSIDE_JOKE']) })
  for (const focus of ['实验室真的很烦，我很痛苦', '实验室论文让我焦虑失眠', '别再拿实验室开玩笑']) assert.deepEqual(retrieveSharedMemories({ contact, selectedFocus: focus, relationshipStage: 'FRIEND', now: now(3) }), [])
  assert.deepEqual(retrieveSharedMemories({ contact, activeTopic: '实验室', relationshipStage: 'FRIEND', action: 'EMPATHY', now: now(3) }), [])
})
test('recent actual recall cools down for 24 hours; mere retrieval does not consume it', () => {
  const original = create(person(), discovery()), id = original.memories[0].id
  const marked = markSharedMemoryRecalled(person('a', { sharedMemory: original }), [id], { now: now(2), confirmedSent: true, outgoingMessageId: 'actual' })
  assert.deepEqual(retrieveSharedMemories({ contact: person('a', { sharedMemory: marked }), activeTopic: '英雄联盟', relationshipStage: 'FRIEND', now: now(2) + 3600000 }), [])
  assert.ok(retrieveSharedMemories({ contact: person('a', { sharedMemory: marked }), activeTopic: '英雄联盟', relationshipStage: 'FRIEND', now: now(4) }).length > 0)
})
test('retrieval limit is hard bounded at three and zero is supported', () => {
  const store = create(person(), [...discovery(), ...support, ...result, ...joke(1), ...joke(2)], 2)
  const input = { contact: person('a', { sharedMemory: store }), activeTopic: '英雄联盟 实验室 论文 答辩', relationshipStage: 'FRIEND', now: now(3) }
  assert.ok(retrieveSharedMemories({ ...input, limit: 100 }).length <= 3); assert.deepEqual(retrieveSharedMemories({ ...input, limit: 0 }), [])
})
test('Journey reads verified shared history as qualitative evidence without changing its stage', () => {
  const store = create(person(), [...joke(1), ...joke(2)], 2, ['INSIDE_JOKE'])
  const contact = person('a', { sharedMemory: store, sharedMemoryLedger: [...joke(1), ...joke(2)] })
  const journey = buildRelationshipJourney({ contact, messages: [], now: now(2) })
  assert.equal(journey.currentStage, 'STRANGER')
  const evidence = journey.relationshipEvidence.find(item => item.sharedMemoryId === store.memories[0].id)
  assert.equal(evidence.type, 'INSIDE_JOKE'); assert.deepEqual(evidence.sourceMessageIds, store.memories[0].sourceMessageIds)
  assert.equal(Object.hasOwn(journey, 'points'), false)
})
test('Journey does not double count the same actual source and type', () => {
  const messages = discovery(), store = create(person(), messages)
  const journey = buildRelationshipJourney({ contact: person('a', { sharedMemory: store, sharedMemoryLedger: messages }), messages, now: now(1) })
  assert.equal(journey.relationshipEvidence.filter(item => item.type === 'COMMON_GROUND').length, 1)
})
test('deleting shared history withdraws that derived Journey evidence without forcing downgrade', () => {
  const store = create(person(), [...joke(1), ...joke(2)], 2, ['INSIDE_JOKE'])
  let contact = person('a', { sharedMemory: store })
  const journey = { ...buildRelationshipJourney({ contact, messages: [], now: now(2) }), currentStage: 'FRIEND' }
  contact = { ...contact, relationshipJourney: journey, sharedMemory: deleteSharedMemory(contact, store.memories[0].id, { now: now(3) }) }
  const next = buildRelationshipJourney({ contact, messages: [], now: now(3) })
  assert.equal(next.currentStage, 'FRIEND'); assert.ok(next.relationshipEvidence.every(item => !item.sharedMemoryId))
})
test('foreign shared evidence cannot affect another Journey and milestone cannot score its own stage', () => {
  const store = create(person(), discovery()), contact = person('b', { sharedMemory: store })
  assert.deepEqual(buildRelationshipJourney({ contact, messages: [], now: now(1) }).relationshipEvidence, [])
  assert.equal(normalizeJourney(contact, { now: now(1) }).currentStage, 'STRANGER')
})
test('extractor prompt excludes full self profile and snapshots while retaining canonical bounded provenance', async () => {
  const selfProfile = { stableProfile: [{ id: 'p', key: 'occupation', value: '虚构特别职业', shareLevel: 'NORMAL', status: 'active' }], currentLife: [], privacyPreferences: [] }
  await extractSharedMemories(async prompts => {
    const json = prompts[1].content, payload = JSON.parse(json)
    assert.ok(!json.includes('虚构特别职业')); assert.ok(payload.candidates.every(item => !item.sourceMessages && item.sourceMessageIds.length <= 24))
    return selectAll(prompts)
  }, { contact: person(), messages: discovery(), selfProfile, now: now(1) })
})
test('shared archived source snapshots can support qualitative evaluation after the ordinary history rolls out', async () => {
  const store = create(person(), [...joke(1), ...joke(2)], 2, ['INSIDE_JOKE'])
  let contact = person('a', { sharedMemory: store })
  const initial = { ...normalizeJourney(contact, { now: now(1) }), currentStage: 'FAMILIAR' }
  contact.relationshipJourney = initial
  const journey = buildRelationshipJourney({ contact, messages: [], now: now(3) })
  const result = await evaluateRelationshipJourney(async prompts => {
    const payload = JSON.parse(prompts[1].content)
    assert.ok(payload.recentActualMessages.some(item => item.id === 'j1m'))
    return { text: JSON.stringify({ currentStage: 'FAMILIAR', suggestedStage: 'FRIEND', confidence: 0.9, reasons: ['跨日双方持续使用共同表达'], evidenceIds: payload.relationshipEvidence.map(item => item.id) }) }
  }, { contact, journey, messages: [], now: now(3) })
  assert.equal(result.evaluated, true); assert.equal(result.changed, true); assert.equal(result.journey.currentStage, 'FRIEND')
})
test('updating one shared episode replaces obsolete derived evidence instead of retaining stale summaries', () => {
  const initial = create(person(), support)
  let contact = person('a', { sharedMemory: initial })
  const journey = buildRelationshipJourney({ contact, messages: [], now: now(1) })
  contact = { ...contact, relationshipJourney: journey, sharedMemory: create(contact, result, 2) }
  const next = buildRelationshipJourney({ contact, messages: [], now: now(2) })
  const evidence = next.relationshipEvidence.filter(item => item.sharedMemoryId === initial.memories[0].id && item.type === 'EMOTIONAL_SUPPORT')
  assert.equal(evidence.length, 1); assert.match(evidence[0].summary, /之后/); assert.equal(evidence[0].sourceMessageIds.length, 4)
})
test('unchanged active episodes remain idle even after old processed candidate IDs roll out', () => {
  const store = create(person(), discovery()); store.processedCandidateIds = []
  assert.deepEqual(buildSharedMemoryCandidates({ contact: person('a', { sharedMemory: store }), messages: discovery(), now: now(3) }), [])
})
test('a real adjacent stage change backed by actual sources can be a milestone but is not upgrade points', () => {
  const messages = discovery(), contact = person(), journey = buildRelationshipJourney({ contact, messages, now: now(1) })
  journey.stageHistory = [{ contactId: 'a', fromStage: 'STRANGER', toStage: 'EXPLORING', timestamp: at(1, 5), evidenceIds: journey.relationshipEvidence.map(item => item.id) }]
  const candidates = buildSharedMemoryCandidates({ contact, messages, journey, now: now(1) })
  assert.ok(candidates.some(item => item.type === 'MILESTONE'))
  const store = applySharedMemoryOperations(contact, candidates.filter(item => item.type === 'MILESTONE').map(item => ({ action: 'CREATE', candidateId: item.id })), { candidates, now: now(1) })
  assert.deepEqual(buildRelationshipJourney({ contact: { ...contact, sharedMemory: store }, messages: [], now: now(2) }).relationshipEvidence, [])
})
test('foreign nonadjacent unknown and source-free stage changes cannot invent milestones', () => {
  const contact = person(), messages = discovery(), journey = buildRelationshipJourney({ contact, messages, now: now(1) })
  const valid = { contactId: 'a', fromStage: 'STRANGER', toStage: 'EXPLORING', timestamp: at(1, 5), evidenceIds: journey.relationshipEvidence.map(item => item.id) }
  for (const extra of [{ contactId: 'b' }, { toStage: 'FRIEND' }, { toStage: 'ROMANCE' }, { evidenceIds: [] }]) {
    const candidates = buildSharedMemoryCandidates({ contact, messages, journey: { ...journey, stageHistory: [{ ...valid, ...extra }] }, now: now(1) })
    assert.ok(candidates.every(item => item.type !== 'MILESTONE'))
  }
})
