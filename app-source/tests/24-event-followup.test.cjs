const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMemoryStorage } = require('./setup.cjs')
const { JsonStorage } = require('../electron/storage.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { syncMemory } = require('../electron/social-brain/memory-manager.cjs')
const { ProactiveEngine, checkDisturbance, generateEventCandidate } = require('../electron/social-brain/proactive-engine.cjs')

const now = new Date('2026-10-13T12:00:00+08:00')
const sourceAt = '2026-10-10T12:00:00+08:00'
const message = (text, id = 'event-source', at = sourceAt, role = 'contact') => ({ text, id, at, role })
function makeContact(name = '虚拟跟进朋友', id = 'contact-1') {
  const contact = { id, name, profile: { chatMode: 'friendship', aiEnabled: true }, learning: { messages: [message('我下周一面试')] } }
  contact.socialBrain = syncMemory(contact, { now })
  return contact
}
function setup(options = {}) {
  const storage = options.storage || createMemoryStorage({ contacts: [makeContact()], settings: { longTermMemory: true, eventFollowup: { enabled: true }, quietHours: false } })
  const calls = { drafts: 0, submissions: [], events: [] }
  const ai = { async draftEventFollowup(payload) { calls.drafts++; return options.draft ? options.draft(payload, storage) : { ok: true, text: '你昨天那个面试咋样呀', strategy: { action: 'EVENT_FOLLOWUP' }, model: 'test', provider: 'test' } } }
  const douyin = { storage, lastReplyTime: new Map(), incomingQueue: new Map(),
    getSendAllowance: DouyinService.prototype.getSendAllowance,
    emitEvent(type, payload) { calls.events.push({ type, payload }) }, log() {},
    async sendMessage(name, text, metadata) {
      if (options.beforeSubmit) await options.beforeSubmit(storage)
      await metadata.beforeSubmit?.()
      if (options.send) return options.send({ name, text, metadata }, calls, storage)
      calls.submissions.push({ name, text, metadata })
      return { ok: true }
    },
  }
  const engine = new ProactiveEngine({ storage, ai, douyin, accountId: 'test-account', clock: options.clock || (() => new Date(now)) })
  return { storage, ai, douyin, engine, calls }
}
const eventOf = storage => storage.get().contacts[0].socialBrain.events[0]
const draftOf = storage => storage.get().pendingDrafts.find(d => d.source === 'event_followup')
function patchContact(storage, updater) { storage.update({ contacts: storage.get().contacts.map((c, index) => index === 0 ? updater(c) : c) }) }
async function drafted(options) {
  const fixture = setup(options)
  assert.equal((await fixture.engine.scan({ force: true, now })).generatedCount, 1)
  return fixture
}

test('event drafts forward shared-memory selection and stale recall cannot mark an event followed up', async () => {
  const { storage, engine } = await drafted({
    draft: () => ({ ok: true, text: '你昨天那个面试咋样呀', strategy: { action: 'EVENT_FOLLOWUP', sharedMemoryIds: ['shared-verified'], sharedMemoryRevision: 4 } }),
    send: ({ metadata }) => {
      assert.deepEqual(metadata.sharedMemoryIds, ['shared-verified'])
      assert.equal(metadata.sharedMemoryRevision, 4)
      throw Object.assign(new Error('选中的共同记忆已删除'), { code: 'SHARED_MEMORY_STALE', sendAttempted: false })
    },
  })
  const result = await engine.send({ id: draftOf(storage).id })
  assert.equal(result.ok, false); assert.equal(result.uncertain, false)
  assert.notEqual(eventOf(storage).status, 'followed_up')
  assert.equal(eventOf(storage).followUp.attempts, 1)
  assert.equal(draftOf(storage).status, 'failed')
})

test('due scanning creates a persistent draft without sending and repeated scans do not duplicate it', async () => {
  const { storage, engine, calls } = await drafted()
  assert.equal(calls.submissions.length, 0)
  assert.equal(storage.get().pendingDrafts.length, 1)
  assert.equal(eventOf(storage).followUp.status, 'drafted')
  assert.equal(eventOf(storage).followUp.attempts, 0)
  assert.equal(eventOf(storage).status, 'due')
  assert.equal((await engine.scan({ force: true, now })).generatedCount, 0)
  assert.equal(calls.drafts, 1)
})
test('JsonStorage restart retains the existing draft and prevents duplicate generation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-event-loop-'))
  try {
    const storage = new JsonStorage(dir)
    storage.update({ contacts: [makeContact()], settings: { longTermMemory: true, eventFollowup: { enabled: true }, quietHours: false } })
    const first = await drafted({ storage })
    const id = draftOf(storage).id
    first.engine.destroy()
    const restarted = setup({ storage: new JsonStorage(dir) })
    assert.equal((await restarted.engine.scan({ force: true, now })).generatedCount, 0)
    assert.equal(draftOf(restarted.storage).id, id)
    assert.equal(restarted.calls.drafts, 0)
    assert.equal(restarted.calls.submissions.length, 0)
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('douyin-event-loop-'))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test('confirmed delivery alone marks the event followed up and removes its draft', async () => {
  const { storage, engine, calls } = await drafted()
  const result = await engine.send({ id: draftOf(storage).id })
  assert.equal(result.ok, true)
  assert.equal(calls.submissions.length, 1)
  assert.equal(calls.submissions[0].metadata.source, 'event_followup')
  assert.equal(eventOf(storage).status, 'followed_up')
  assert.equal(eventOf(storage).followUp.status, 'followed_up')
  assert.equal(eventOf(storage).followUp.attempts, 1)
  assert.equal(eventOf(storage).followUp.enabled, false)
  assert.equal(storage.get().pendingDrafts.length, 0)
})
test('a definite failure counts an attempt and permits retry without losing the event', async () => {
  let attempts = 0
  const { storage, engine } = await drafted({ send: async () => ++attempts === 1 ? { ok: false, error: '网络连接失败' } : { ok: true } })
  const id = draftOf(storage).id
  const failed = await engine.send({ id })
  assert.equal(failed.ok, false)
  assert.equal(failed.uncertain, false)
  assert.equal(eventOf(storage).followUp.attempts, 1)
  assert.equal(eventOf(storage).followUp.status, 'failed')
  assert.notEqual(eventOf(storage).status, 'followed_up')
  assert.equal(draftOf(storage).status, 'failed')
  assert.equal((await engine.send({ id })).ok, true)
  assert.equal(eventOf(storage).followUp.attempts, 2)
  assert.equal(eventOf(storage).status, 'followed_up')
})
test('uncertain submission blocks retry, rewrite and duplicate generation', async () => {
  const fixture = await drafted({ send: async () => { throw Object.assign(new Error('没有确认发送结果'), { sendAttempted: true }) } })
  const { storage, engine, calls } = fixture
  const id = draftOf(storage).id
  assert.equal((await engine.send({ id })).uncertain, true)
  assert.equal(eventOf(storage).followUp.status, 'uncertain')
  assert.equal(eventOf(storage).followUp.attempts, 1)
  assert.equal(draftOf(storage).status, 'uncertain')
  await assert.rejects(engine.send({ id }), /未确认|重复发送/)
  await assert.rejects(engine.rewrite({ id }), /未确认/)
  assert.equal((await engine.scan({ force: true, now })).generatedCount, 0)
  assert.equal(calls.drafts, 1)
})
test('restart converts interrupted sending to uncertain rather than retrying automatically', async () => {
  const { storage } = await drafted()
  storage.update({ pendingDrafts: storage.get().pendingDrafts.map(d => ({ ...d, status: 'sending' })) })
  patchContact(storage, c => ({ ...c, socialBrain: { ...c.socialBrain, events: c.socialBrain.events.map(e => ({ ...e, followUp: { ...e.followUp, status: 'sending', attempts: 1 } })) } }))
  const restarted = setup({ storage })
  assert.equal(draftOf(storage).status, 'uncertain')
  assert.equal(eventOf(storage).followUp.status, 'uncertain')
  await assert.rejects(restarted.engine.send({ id: draftOf(storage).id }), /未确认/)
  assert.equal(restarted.calls.submissions.length, 0)
})
for (const update of ['我刚面完，感觉凉了', '面试推迟到周五了']) {
  test(`new event evidence invalidates a pending draft: ${update}`, async () => {
    const { storage, engine, calls } = await drafted()
    const id = draftOf(storage).id
    patchContact(storage, c => {
      const updated = { ...c, learning: { ...c.learning, messages: [...c.learning.messages, message(update, 'update-source', now.toISOString())] } }
      return { ...updated, socialBrain: syncMemory(updated, { now }) }
    })
    await assert.rejects(engine.send({ id }), /更新|解决|过期/)
    assert.equal(storage.get().pendingDrafts.length, 0)
    assert.equal(calls.submissions.length, 0)
  })
}

const gateCases = [
  ['AI off', (s, c) => { s.automation.aiDisabledContacts = [c.name] }, 'ai_disabled'],
  ['profile AI off', (_s, c) => { c.profile.aiEnabled = false }, 'ai_disabled'],
  ['blacklist', (s, c) => { s.automation.blacklist = [c.name] }, 'blacklist'],
  ['DND', s => { s.settings.quietHours = true; s.settings.quietStart = '11:00'; s.settings.quietEnd = '13:00' }, 'quiet'],
  ['paused', s => { s.automation.paused = true }, 'paused'],
  ['daily quota', (s, c) => { s.automation.dailyLimit = 1; s.sendHistory = [{ name: c.name, at: now.toISOString() }] }, 'quota'],
  ['contact quota', (s, c) => { s.automation.dailyLimit = 30; s.automation.maxPerContactDailyEnabled = true; s.automation.maxPerContactDaily = 1; s.sendHistory = [{ name: c.name, at: now.toISOString() }] }, 'quota'],
  ['two unanswered messages', (_s, c) => { c.learning.messages.push(message('好呀', 'out1', '2026-10-11T12:00:00+08:00', 'me'), message('对了', 'out2', '2026-10-11T12:01:00+08:00', 'me')) }, 'unanswered'],
  ['two consecutive owner initiations', (_s, c) => { c.learning.messages = [message('在不在', 'o1', '2026-10-10T12:00:00+08:00', 'me'), message('在', 'c1', '2026-10-10T12:01:00+08:00'), message('今天咋样', 'o2', '2026-10-11T12:00:00+08:00', 'me'), message('挺好', 'c2', '2026-10-11T12:01:00+08:00')] }, 'initiations'],
  ['recent six hours', (_s, c) => { c.learning.messages.push(message('刚忙完', 'recent', '2026-10-13T11:00:00+08:00')) }, 'recent_chat'],
  ['pending incoming', (_s, c) => { c.unread = 1 }, 'incoming'],
]
for (const [label, alter, code] of gateCases) {
  test(`disturbance gate defers before any model call: ${label}`, async () => {
    const { storage, douyin, engine, calls } = setup()
    const state = storage.get(), contact = state.contacts[0]
    alter(state, contact); storage.update(state)
    const gate = checkDisturbance({ state: storage.get(), contact, now, allowance: douyin.getSendAllowance(contact.name, now.getTime()) })
    assert.equal(gate.code, code)
    const result = await engine.scan({ force: true, now })
    assert.equal(result.generatedCount, 0)
    assert.equal(calls.drafts, 0)
    assert.equal(calls.submissions.length, 0)
    assert.equal(storage.get().pendingDrafts.length, 0)
  })
}
test('Planner refusal defers the event without creating or sending a draft', async () => {
  const { storage, engine, calls } = setup({ draft: async () => ({ ok: true, skipped: true, text: '' }) })
  assert.equal((await engine.scan({ force: true, now })).deferredCount, 1)
  assert.equal(eventOf(storage).followUp.status, 'deferred')
  assert.equal(storage.get().pendingDrafts.length, 0)
  assert.equal(calls.submissions.length, 0)
  assert.equal((await engine.scan({ force: true, now })).generatedCount, 0)
  assert.equal(calls.drafts, 1)
})
for (const mutation of ['chat', 'event']) {
  test(`generation discards its result when ${mutation} changes during model processing`, async () => {
    const fixture = setup({ draft: async (_payload, storage) => {
      patchContact(storage, c => mutation === 'chat'
        ? { ...c, learning: { ...c.learning, messages: [...c.learning.messages, message('刚忙完，来聊聊', 'racing-chat', now.toISOString())] } }
        : { ...c, socialBrain: { ...c.socialBrain, events: c.socialBrain.events.map(e => ({ ...e, description: '面试改期了' })) } })
      return { ok: true, text: '你面试咋样呀' }
    } })
    assert.equal((await fixture.engine.scan({ force: true, now })).generatedCount, 0)
    assert.equal(fixture.storage.get().pendingDrafts.length, 0)
    assert.equal(fixture.calls.submissions.length, 0)
  })
}
test('inactive account prevents sending, including a switch immediately before submission', async () => {
  const first = await drafted()
  await assert.rejects(first.engine.send({ id: draftOf(first.storage).id }, { isActive: () => false }), /账号.*切换/)
  assert.equal(eventOf(first.storage).followUp.attempts, 0)
  assert.equal(first.calls.submissions.length, 0)
  let active = true
  const second = await drafted({ beforeSubmit: async () => { active = false } })
  const result = await second.engine.send({ id: draftOf(second.storage).id }, { isActive: () => active })
  assert.equal(result.ok, false)
  assert.equal(second.calls.submissions.length, 0)
  assert.notEqual(eventOf(second.storage).status, 'followed_up')
})
test('event changes at the browser submission hook stop stale content from being sent', async () => {
  const fixture = await drafted({ beforeSubmit: async storage => patchContact(storage, c => ({ ...c, socialBrain: { ...c.socialBrain, events: c.socialBrain.events.map(e => ({ ...e, status: 'resolved', followUp: { ...e.followUp, enabled: false, status: 'resolved_in_chat' } })) } })) })
  const result = await fixture.engine.send({ id: draftOf(fixture.storage).id })
  assert.equal(result.ok, false)
  assert.equal(fixture.calls.submissions.length, 0)
  assert.equal(eventOf(fixture.storage).status, 'resolved')
})
test('rewriting and skipping only update the selected draft and its event', async () => {
  const fixture = await drafted()
  const id = draftOf(fixture.storage).id
  const unrelated = { id: 'unrelated', name: '其他朋友', text: '原有普通草稿', status: 'pending' }
  fixture.storage.update({ pendingDrafts: [...fixture.storage.get().pendingDrafts, unrelated] })
  fixture.ai.draftEventFollowup = async () => ({ ok: true, text: '昨天面试还顺利不', strategy: { action: 'EVENT_FOLLOWUP' } })
  assert.equal((await fixture.engine.rewrite({ id })).ok, true)
  assert.equal(draftOf(fixture.storage).text, '昨天面试还顺利不')
  assert.deepEqual(fixture.storage.get().pendingDrafts.find(d => d.id === unrelated.id), unrelated)
  assert.equal(fixture.engine.skip({ id }).ok, true)
  assert.deepEqual(fixture.storage.get().pendingDrafts, [unrelated])
  assert.equal(eventOf(fixture.storage).followUp.status, 'skipped')
  assert.equal(eventOf(fixture.storage).followUp.attempts, 0)
})
test('rewrite invalidated while awaiting AI preserves unrelated drafts', async () => {
  const fixture = await drafted()
  const id = draftOf(fixture.storage).id
  const unrelated = { id: 'unrelated', name: '其他朋友', text: '原有普通草稿' }
  fixture.storage.update({ pendingDrafts: [...fixture.storage.get().pendingDrafts, unrelated] })
  fixture.ai.draftEventFollowup = async () => {
    patchContact(fixture.storage, c => ({ ...c, socialBrain: { ...c.socialBrain, events: c.socialBrain.events.map(e => ({ ...e, description: '已变更面试时间' })) } }))
    return { ok: true, text: '错误旧事件内容' }
  }
  await assert.rejects(fixture.engine.rewrite({ id }), /更新|解决|过期/)
  assert.deepEqual(fixture.storage.get().pendingDrafts.find(d => d.id === unrelated.id), unrelated)
  assert.notEqual(draftOf(fixture.storage)?.text, '错误旧事件内容')
})
test('AiService reuses strict event Planner and Writer with exactly two calls', async () => {
  const fixture = setup(), ai = new AiService(fixture.storage), calls = []
  ai.inquiryCompletion = async (messages, options) => {
    calls.push({ messages, options })
    return { text: options.structuredJson ? JSON.stringify({ observations: {}, plan: { shouldInitiate: true, action: 'EVENT_FOLLOWUP', goal: '自然询问昨天面试结果', tone: 'casual', length: 'short' }, learning: { enabled: false }, advisor: { needed: false } }) : '你昨天那个面试咋样呀', model: 'test', provider: 'test' }
  }
  const contact = fixture.storage.get().contacts[0]
  const result = await ai.draftEventFollowup({ contact, candidate: generateEventCandidate(contact, contact.socialBrain.events[0]), now })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.structuredJson, true)
  assert.equal(Boolean(calls[1].options.structuredJson), false)
  assert.match(JSON.stringify(calls[0].messages), /shouldInitiate|EVENT_FOLLOWUP/)
  assert.equal(result.text, '你昨天那个面试咋样呀')
  assert.equal(result.strategy.shouldInitiate, true)
  assert.equal(result.strategy.action, 'EVENT_FOLLOWUP')
  assert.equal(fixture.calls.submissions.length, 0)
})
test('AiService respects event Planner rejection and skips Writer', async () => {
  const fixture = setup(), ai = new AiService(fixture.storage)
  let calls = 0
  ai.inquiryCompletion = async () => { calls++; return { text: JSON.stringify({ plan: { shouldInitiate: false, action: 'NO_REPLY', goal: '对方可能在忙，暂缓主动' }, observations: {}, learning: { enabled: false }, advisor: { needed: false } }), model: 'test', provider: 'test' } }
  const contact = fixture.storage.get().contacts[0]
  const result = await ai.draftEventFollowup({ contact, candidate: generateEventCandidate(contact, contact.socialBrain.events[0]), now })
  assert.equal(calls, 1)
  assert.equal(result.skipped, true)
  assert.equal(result.text, '')
  assert.equal(result.strategy.shouldInitiate, false)
})
test('concurrent send, rewrite and skip are locked while a send is pending', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const fixture = await drafted({ send: async () => { entered(); await blocked; return { ok: true } } })
  const id = draftOf(fixture.storage).id
  const sending = fixture.engine.send({ id })
  await started
  await assert.rejects(fixture.engine.send({ id }), /正在处理/)
  await assert.rejects(fixture.engine.rewrite({ id }), /正在处理/)
  assert.throws(() => fixture.engine.skip({ id }), /正在处理/)
  assert.equal(eventOf(fixture.storage).followUp.attempts, 1)
  release()
  assert.equal((await sending).ok, true)
  assert.equal(fixture.storage.get().pendingDrafts.length, 0)
})
test('a pause introduced immediately before browser submission prevents sending', async () => {
  const fixture = await drafted({ beforeSubmit: async storage => storage.update({ automation: { paused: true } }) })
  const result = await fixture.engine.send({ id: draftOf(fixture.storage).id })
  assert.equal(result.ok, false)
  assert.match(result.error, /暂停/)
  assert.equal(fixture.calls.submissions.length, 0)
  assert.equal(eventOf(fixture.storage).followUp.status, 'failed')
})
test('a window expiring while the model runs prevents a late draft from being committed', async () => {
  let current = new Date(now)
  const fixture = setup({ clock: () => new Date(current), draft: async () => {
    current = new Date('2026-10-15T12:00:00+08:00')
    return { ok: true, text: '你昨天面试咋样呀' }
  } })
  assert.equal((await fixture.engine.scan({ force: true, now })).generatedCount, 0)
  assert.equal(fixture.storage.get().pendingDrafts.length, 0)
  assert.equal(fixture.calls.submissions.length, 0)
})
test('a window expiring after drafting prevents submission and reconciles the stale event', async () => {
  let current = new Date(now)
  const fixture = await drafted({ clock: () => new Date(current) })
  const id = draftOf(fixture.storage).id
  current = new Date('2026-10-15T12:00:00+08:00')
  await assert.rejects(fixture.engine.send({ id }), /更新|解决|过期/)
  assert.equal(eventOf(fixture.storage).status, 'stale')
  assert.equal(fixture.storage.get().pendingDrafts.length, 0)
  assert.equal(fixture.calls.submissions.length, 0)
})
test('rewrite Planner rejection withdraws its draft and defers only its event', async () => {
  const fixture = await drafted()
  const id = draftOf(fixture.storage).id
  const unrelated = { id: 'unrelated', name: '其他朋友', text: '普通草稿' }
  fixture.storage.update({ pendingDrafts: [...fixture.storage.get().pendingDrafts, unrelated] })
  fixture.ai.draftEventFollowup = async () => ({ ok: true, skipped: true, text: '' })
  assert.equal((await fixture.engine.rewrite({ id })).skipped, true)
  assert.equal(eventOf(fixture.storage).followUp.status, 'deferred')
  assert.deepEqual(fixture.storage.get().pendingDrafts, [unrelated])
  assert.equal((await fixture.engine.scan({ force: true, now })).generatedCount, 0)
})
test('reconciliation recovers an orphan drafted event when another queue writer removed its draft', async () => {
  const fixture = await drafted()
  fixture.storage.update({ pendingDrafts: [] })
  assert.equal(eventOf(fixture.storage).followUp.status, 'drafted')
  assert.equal((await fixture.engine.scan({ force: true, now })).generatedCount, 1)
  assert.equal(fixture.storage.get().pendingDrafts.length, 1)
  assert.equal(fixture.calls.submissions.length, 0)
})
