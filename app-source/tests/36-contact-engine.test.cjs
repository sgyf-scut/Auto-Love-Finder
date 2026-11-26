const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ContactEngine, normalizeContactConfig, templateFor } = require('../electron/contact-engine.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')

const clone = v => structuredClone(v)
function harness(extra = {}) {
  let now = new Date('2026-10-10T12:00:00+08:00')
  let data = { selfPersona: { name: '本人', interests: '宠物，摄影' }, settings: {}, automation: { paused: false, blacklist: [], aiDisabledContacts: [] },
    contacts: [], sendHistory: [], friendship: { followed: [], automatic: { enabled: false }, contactConfig: { enabled: true, templates: { default: '你好，想认识一下' } } },
    discovery: { config: { targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 }, candidates: [] }, ...extra }
  const calls = [], events = []
  const storage = { get: () => clone(data), update: patch => { data = { ...data, ...clone(patch) }; return storage.get() } }
  const manager = new CandidateManager(storage)
  const douyin = { storage, getSendAllowance: () => ({ ok: true }), emitEvent: (...args) => events.push(args), log: (...args) => calls.push(['log', ...args]) }
  const friendship = {
    candidates: new Map(),
    async follow(url, options) {
      await options?.beforeAction?.(); calls.push(['follow', url]); const candidate = this.candidates.get(url)
      storage.update({ friendship: { ...storage.get().friendship, followed: [...storage.get().friendship.followed, { ...candidate, followedAt: now.toISOString() }] } })
      return { ok: true, candidate }
    },
    async probeContact(url, options) { await options?.beforeAction?.(); calls.push(['probe', url]); return { ok: true, identityVerified: true, platformUserId: url.split('/').at(-1), followed: true, dmAvailable: true } },
    async greeting(url, text, options) {
      await options?.beforeSubmit?.(); calls.push(['greeting', url, text]); const candidate = this.candidates.get(url)
      storage.update({ contacts: [...storage.get().contacts, { id: `contact_${candidate.platformUserId}`, name: candidate.name,
        profile: { autoFriendshipUrl: url, platformUserId: candidate.platformUserId, dmIdentityVerified: true }, learning: { messages: [] } }],
        sendHistory: [...storage.get().sendHistory, { name: candidate.name, at: now.toISOString() }] })
      return { ok: true, profileUrl: url, contactId: `contact_${candidate.platformUserId}` }
    },
  }
  const engine = new ContactEngine({ storage, douyin, friendship, accountId: 'account-a', clock: () => new Date(now) })
  const add = (id = 'one', fields = {}) => {
    const { source, sources: _sources, ...patch } = fields
    manager.upsert([{ profileUrl: `https://www.douyin.com/user/${id}`, nickname: `陌生人${id}`, source: source || { topic: 'social', keyword: '交友', videoId: '123', commentId: id,
      commentText: '研二想交朋友，喜欢宠物和摄影，希望认识一起交流日常的朋友' } }], { accountId: 'account-a' })
    const candidate = manager.get().candidates.find(c => c.platformUserId === id)
    manager.patch(candidate.id, { publicSignals: { genderText: '女', followerCount: 10 }, ...patch })
    return candidate.id
  }
  const approve = id => manager.review(id, { status: 'APPROVED' })
  const queue = (id = add()) => { approve(id); engine.enqueue(id); return id }
  return { engine, storage, douyin, friendship, manager, calls, events, add, approve, queue,
    advance: (minutes = 30) => { now = new Date(now.getTime() + minutes * 60000) }, now: () => new Date(now), c: id => manager.get().candidates.find(c => c.id === id), mutations: () => calls.filter(c => ['follow', 'greeting'].includes(c[0])) }
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('contact config starts disabled in review mode with empty hand-written templates', () => {
  assert.deepEqual(normalizeContactConfig(), { enabled: false, mode: 'review', dailyLimit: 3, intervalMinutes: 30, waitlistCheckMinutes: 60,
    templates: { graduate: '', dating: '', social: '', interest: '', default: '' }, autoScoreThreshold: 70 })
  assert.equal(normalizeContactConfig({ mode: 'automatic' }).mode, 'automatic')
  assert.equal(normalizeContactConfig({ mode: 'auto' }).mode, 'automatic')
  assert.equal(normalizeContactConfig(null).enabled, false)
  const c = normalizeContactConfig({ dailyLimit: 100, intervalMinutes: 1, waitlistCheckMinutes: -1, autoScoreThreshold: 200 })
  assert.deepEqual([c.dailyLimit, c.intervalMinutes, c.waitlistCheckMinutes, c.autoScoreThreshold], [20, 5, 10, 100])
})
test('config update preserves old followed, automatic and partial manual templates', () => {
  const h = harness(); h.engine.update({ templates: { social: '同样爱宠物，想认识一下' }, dailyLimit: 2 })
  assert.equal(h.engine.config().templates.default, '你好，想认识一下')
  assert.equal(h.engine.config().templates.social, '同样爱宠物，想认识一下')
  assert.deepEqual(h.storage.get().friendship.automatic, { enabled: false })
  assert.throws(() => h.engine.update({ templates: { default: '很'.repeat(81) } }), /80/)
  assert.equal(h.mutations().length, 0)
})
test('manual template categorization uses graduate, dating, social and default sources', () => {
  const config = normalizeContactConfig({ templates: { graduate: 'A', dating: 'B', social: 'C', interest: 'D', default: 'E' } })
  for (const [keyword, expected] of [['研究生', 'A'], ['脱单', 'B'], ['交友', 'C'], ['共同兴趣', 'D'], ['猫', 'E']]) {
    assert.equal(templateFor({ source: { keyword } }, config).text, expected)
  }
})
test('empty templates block queueing before any follow, AI opening or browser action', async () => {
  const h = harness(); const id = h.add(); h.approve(id); h.engine.update({ templates: { default: '' } })
  assert.throws(() => h.engine.enqueue(id), /手动填写/)
  await h.engine.runOnce(); assert.equal(h.calls.length, 0); assert.equal(h.c(id).status, 'APPROVED')
})
test('manual enqueue requires explicit approval, current hard conditions and matching account identity', () => {
  const h = harness(); const id = h.add()
  assert.throws(() => h.engine.enqueue(id), /批准/)
  h.approve(id); h.manager.patch(id, { publicSignals: { genderText: '男', followerCount: 10 } })
  assert.throws(() => h.engine.enqueue(id))
  h.manager.patch(id, { publicSignals: { genderText: '女', followerCount: 10 } })
  const wrongAccount = new ContactEngine({ ...h, accountId: 'other-account', clock: h.now })
  assert.throws(() => wrongAccount.enqueue(id), /账号/); assert.equal(h.mutations().length, 0)
})
test('disabled contact engine permits manual queueing but never performs remote actions', async () => {
  const h = harness(); h.engine.update({ enabled: false }); const id = h.queue()
  assert.equal(h.c(id).status, 'CONTACT_QUEUED'); await h.engine.runOnce(); assert.equal(h.calls.length, 0)
})
test('one finite round follows and sends exactly the manual text with durable matching statuses', async () => {
  const h = harness(), id = h.queue(); const result = await h.engine.runOnce()
  assert.equal(result.greeted, true); assert.equal(h.c(id).status, 'WAITING_REPLY'); assert.equal(h.c(id).contact.status, 'WAITING_REPLY')
  assert.deepEqual(h.mutations().map(c => c[0]), ['follow', 'greeting']); assert.equal(h.mutations()[1][2], '你好，想认识一下')
  assert.equal(h.friendship.candidates.get(h.c(id).profileUrl).candidateId, id)
  assert.ok(h.c(id).contact.followedAt && h.c(id).contact.openingSentAt)
  assert.equal(h.c(id).contact.openingAttempts, 1); assert.ok(h.c(id).timeline.some(e => e.type === 'opening_confirmed'))
  assert.equal(h.events.at(-1)[0], 'contact_progress')
})
test('submitted or uncertain candidates cannot requeue or retry after restart', async () => {
  const h = harness(), id = h.queue(); await h.engine.runOnce(); h.advance()
  await h.engine.runOnce(); assert.throws(() => h.engine.enqueue(id), /已经联系/); assert.throws(() => h.engine.retry(id), /不得重复/)
  const restarted = new ContactEngine({ ...h, storage: h.storage, douyin: h.douyin, friendship: h.friendship, accountId: 'account-a', clock: h.now })
  await restarted.runOnce(); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 1)
})
test('follow and opening checkpoint recovery never blindly repeats a remote submission', () => {
  for (const [stage, expected] of [['FOLLOWING', 'FOLLOW_UNCERTAIN'], ['OPENING_SENDING', 'SEND_UNKNOWN']]) {
    const h = harness(), id = h.queue(); h.manager.patch(id, { status: stage, contact: { ...h.c(id).contact, status: stage } })
    const restarted = new ContactEngine({ ...h, storage: h.storage, douyin: h.douyin, friendship: h.friendship, accountId: 'account-a', clock: h.now })
    assert.equal(h.c(id).status, expected); assert.equal(h.c(id).contact.status, expected)
    assert.throws(() => restarted.retry(id)); assert.throws(() => restarted.enqueue(id)); assert.equal(h.mutations().length, 0)
  }
})
test('uncertain opening remains SEND_UNKNOWN even if an error fails to expose submission details', async () => {
  const h = harness(), id = h.queue()
  h.friendship.greeting = async () => { throw new Error('network dropped after click') }
  assert.equal((await h.engine.runOnce()).ok, false); assert.equal(h.c(id).status, 'SEND_UNKNOWN')
  assert.throws(() => h.engine.retry(id)); h.advance(); await h.engine.runOnce(); assert.equal(h.c(id).contact.openingAttempts, 1)
})
test('explicitly unsubmitted failure is manually retryable without following again', async () => {
  const h = harness(), id = h.queue(), greeting = h.friendship.greeting
  h.friendship.greeting = async () => { throw Object.assign(new Error('editor unavailable before submit'), { sendAttempted: false }) }
  await h.engine.runOnce(); assert.equal(h.c(id).status, 'FAILED'); assert.equal(h.c(id).contact.retrySafe, true)
  h.friendship.greeting = greeting; h.engine.retry(id); h.advance(); await h.engine.runOnce()
  assert.equal(h.c(id).status, 'WAITING_REPLY'); assert.equal(h.calls.filter(c => c[0] === 'follow').length, 1)
})
test('existing external follow does not authorize blind first-contact retry', async () => {
  const h = harness(), id = h.queue(); h.friendship.follow = async () => ({ ok: true, alreadyFollowed: true })
  await h.engine.runOnce(); assert.equal(h.c(id).status, 'FAILED'); assert.equal(h.c(id).contact.retrySafe, false)
  assert.throws(() => h.engine.retry(id), /没有提交/); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 0)
})
test('review mode never automatically approves an unreviewed high-score candidate', async () => {
  const h = harness(), id = h.add(); await h.engine.runOnce()
  assert.equal(h.c(id).status, 'REVIEW_PENDING'); assert.equal(h.mutations().length, 0)
})
test('automatic mode ranks evidence and queues only a candidate over the threshold', async () => {
  const h = harness(), low = h.add('low', { source: { topic: 'social', keyword: '交友', videoId: '123', commentId: 'low', commentText: '哈哈' }, sources: [] }), high = h.add('high')
  h.engine.update({ mode: 'automatic' }); const result = await h.engine.runOnce()
  assert.equal(result.greeted, true); assert.equal(h.c(high).contact.automatic, true); assert.equal(h.c(low).status, 'REVIEW_PENDING')
  assert.equal(h.c(high).review.approvalMode, 'auto'); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 1)
})
test('automatic mode cannot approve male or unknown public-filter candidates', async () => {
  const h = harness(); h.add('male', { publicSignals: { genderText: '男', followerCount: 10 } }); h.add('unknown', { publicSignals: { followerCount: 10 } })
  h.engine.update({ mode: 'automatic' }); await h.engine.runOnce(); assert.equal(h.mutations().length, 0)
})
test('live public reinspection changing followers blocks both follow and greeting', async () => {
  const h = harness(), id = h.queue(); h.engine.inspectCandidate = async c => h.manager.patch(c.id, { publicSignals: { genderText: '女', followerCount: 200 } })
  await h.engine.runOnce(); assert.equal(h.mutations().length, 0); assert.equal(h.c(id).status, 'CONTACT_QUEUED')
})
test('global pause, blacklist, AI-off, quota and quiet hours prevent remote contact', async () => {
  for (const block of ['pause', 'blacklist', 'ai', 'quota', 'quiet']) {
    const h = harness(), id = h.queue(), state = h.storage.get()
    if (block === 'pause') h.storage.update({ automation: { ...state.automation, paused: true } })
    if (block === 'blacklist') h.storage.update({ automation: { ...state.automation, blacklist: [h.c(id).nickname] } })
    if (block === 'ai') h.storage.update({ automation: { ...state.automation, aiDisabledContacts: [h.c(id).nickname] } })
    if (block === 'quota') h.douyin.getSendAllowance = () => ({ ok: false, reason: 'daily quota' })
    if (block === 'quiet') h.storage.update({ settings: { quietHours: true, quietStart: '00:00', quietEnd: '23:59' } })
    await h.engine.runOnce(); assert.equal(h.calls.length, 0, block)
  }
})
test('interval and daily limits count unique durable attempts, not repeated messages', async () => {
  const h = harness(); h.engine.update({ dailyLimit: 2 }); const first = h.queue(), second = h.queue(h.add('two')), third = h.queue(h.add('three'))
  await h.engine.runOnce(); await h.engine.runOnce(); assert.equal(h.c(second).status, 'CONTACT_QUEUED')
  h.advance(); await h.engine.runOnce(); h.advance(); await h.engine.runOnce()
  assert.equal(h.c(first).status, 'WAITING_REPLY'); assert.equal(h.c(second).status, 'WAITING_REPLY'); assert.equal(h.c(third).status, 'CONTACT_QUEUED')
  assert.equal(h.engine.usage(), 2); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 2)
})
test('pause during an already submitted follow records confirmation but does not send', async () => {
  const h = harness(), id = h.queue(), pending = deferred()
  h.friendship.follow = async (url, options) => { await options.beforeAction(); h.calls.push(['follow', url]); await pending.promise; return { ok: true } }
  const run = h.engine.runOnce(); await new Promise(r => setImmediate(r)); h.engine.pause(); pending.resolve(); await run
  assert.equal(h.c(id).status, 'FOLLOWED'); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 0)
  h.engine.resume(); h.advance(); await h.engine.runOnce(); assert.equal(h.c(id).status, 'WAITING_REPLY')
  assert.equal(h.calls.filter(c => c[0] === 'follow').length, 1)
})
test('destroy during profile inspection cannot follow or send after account switch', async () => {
  const h = harness(), id = h.queue(), pending = deferred()
  h.engine.inspectCandidate = async () => pending.promise
  const run = h.engine.runOnce(); await new Promise(r => setImmediate(r)); h.engine.destroy(); pending.resolve(); await run
  assert.equal(h.mutations().length, 0); assert.equal(h.c(id).status, 'CONTACT_QUEUED')
})
test('running lock prevents two overlapping rounds for the same candidate', async () => {
  const h = harness(), pending = deferred(); h.queue(); const follow = h.friendship.follow
  h.friendship.follow = async (...args) => { await pending.promise; return follow.apply(h.friendship, args) }
  const first = h.engine.runOnce(); await new Promise(r => setImmediate(r)); assert.equal((await h.engine.runOnce()).skipped, true)
  pending.resolve(); await first; assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 1)
})
test('pending follow gets only read-only periodic checks until success and permission are confirmed', async () => {
  const h = harness(), id = h.queue(); h.friendship.follow = async () => ({ ok: true, followPending: true })
  await h.engine.runOnce(); assert.equal(h.c(id).status, 'FOLLOW_PENDING')
  h.friendship.probeContact = async url => { h.calls.push(['probe', url]); return { ok: true, identityVerified: true, platformUserId: 'one', followed: false, followPending: true, dmAvailable: false } }
  await h.engine.runOnce(); assert.equal(h.calls.length, 0)
  h.advance(60); await h.engine.runOnce(); assert.equal(h.c(id).status, 'FOLLOW_PENDING'); assert.equal(h.mutations().length, 0)
  h.friendship.probeContact = async () => ({ ok: true, identityVerified: true, platformUserId: 'one', followed: true, dmAvailable: true })
  h.advance(60); await h.engine.runOnce(); assert.equal(h.c(id).status, 'FOLLOWED'); assert.ok(h.c(id).contact.followedAt)
  await h.engine.runOnce(); assert.equal(h.c(id).status, 'WAITING_REPLY')
})
test('explicitly unavailable private messaging enters waitlist and sends only once when available', async () => {
  const h = harness(), id = h.queue(), normalProbe = h.friendship.probeContact
  h.friendship.probeContact = async url => ({ ok: true, identityVerified: true, platformUserId: 'one', followed: true, dmAvailable: false })
  await h.engine.runOnce(); assert.equal(h.c(id).status, 'CONTACT_WAITLIST'); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 0)
  h.advance(60); h.friendship.probeContact = normalProbe; await h.engine.runOnce(); await h.engine.runOnce()
  assert.equal(h.c(id).status, 'WAITING_REPLY'); assert.equal(h.calls.filter(c => c[0] === 'follow').length, 1); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 1)
})
test('dm_unavailable before submit is waitlisted, but unconfirmed submission never is', async () => {
  for (const submitted of [false, true]) {
    const h = harness(), id = h.queue()
    h.friendship.greeting = async () => { throw Object.assign(new Error('private messaging unavailable'), { code: 'dm_unavailable', sendAttempted: submitted }) }
    await h.engine.runOnce(); assert.equal(h.c(id).status, submitted ? 'SEND_UNKNOWN' : 'CONTACT_WAITLIST')
  }
})
test('read-only probe rejects mismatched user identity and never sends', async () => {
  const h = harness(), id = h.queue(); h.friendship.probeContact = async () => ({ ok: true, identityVerified: true, platformUserId: 'wrong-user', dmAvailable: true })
  await h.engine.runOnce(); assert.equal(h.c(id).status, 'FOLLOWED'); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 0)
})
test('safe first reply requires verified user ID and cannot be inferred from a nickname alone', async () => {
  const h = harness(), id = h.queue(); await h.engine.runOnce(); h.advance(1)
  const state = h.storage.get(), contact = state.contacts[0], message = { id: 'first', role: 'contact', text: '你好呀', at: h.now().toISOString() }
  contact.learning.messages.push(message); h.storage.update({ contacts: [contact] })
  assert.equal(h.engine.reconcileReplies().count, 0); assert.equal(h.c(id).status, 'WAITING_REPLY')
  assert.equal(h.engine.onIncoming(contact, message, { platformUserId: 'wrong-id' }).skipped, true)
  const result = h.engine.onIncoming(contact, message, { platformUserId: 'one' })
  assert.equal(result.replied, true); assert.equal(h.c(id).status, 'CONTACT'); assert.equal(h.c(id).contact.status, 'CONTACT')
  const updated = h.storage.get().contacts[0]; assert.equal(updated.profile.chatMode, 'friendship'); assert.equal(updated.profile.candidateId, id)
  assert.equal(updated.profile.source, 'discovery'); assert.equal(updated.profile.contactPipeline, true); assert.ok(updated.socialBrain); assert.equal(h.engine.onIncoming(updated, message, { platformUserId: 'one' }).skipped, true)
})
test('reconciliation uses timestamped reliable incoming evidence and ignores old or outgoing messages', async () => {
  const h = harness(), id = h.queue(); await h.engine.runOnce(); h.advance(1)
  const contact = h.storage.get().contacts[0]
  contact.learning.messages = [
    { role: 'me', platformUserId: 'one', at: h.now().toISOString(), text: '我发的' },
    { role: 'contact', platformUserId: 'one', at: '2026-01-01T00:00:00Z', text: '旧聊天' },
    { role: 'contact', platformUserId: 'wrong-id', at: h.now().toISOString(), text: '同名别人' },
    { role: 'contact', platformUserId: 'one', identityVerified: true, at: '', observedAt: h.now().toISOString(), text: '新回复' },
  ]
  h.storage.update({ contacts: [contact] }); assert.equal(h.engine.reconcileReplies().count, 1); assert.equal(h.c(id).status, 'CONTACT')
  assert.equal(h.storage.get().contacts[0].learning.messages.at(-1).at, '')
})
test('funnel metrics reflect observed exchanges and seven-day incoming interactions, not contact age', async () => {
  const h = harness(), id = h.queue(); await h.engine.runOnce(); h.advance(1)
  const contact = h.storage.get().contacts[0], first = { id: 'm0', role: 'contact', platformUserId: 'one', at: h.now().toISOString(), text: 'hi' }
  contact.learning.messages.push(first); h.storage.update({ contacts: [contact] }); h.engine.reconcileReplies()
  h.advance(8 * 1440); let metrics = h.engine.metrics()
  assert.equal(metrics.replied, 1); assert.equal(metrics.fiveRounds, 0); assert.equal(metrics.sevenDays, 0)
  const current = h.storage.get().contacts[0]
  for (let i = 0; i < 5; i++) { current.learning.messages.push({ role: 'contact', at: new Date(h.now().getTime() + i * 2000).toISOString(), text: 'hi' }, { role: 'me', at: new Date(h.now().getTime() + i * 2000 + 1000).toISOString(), text: 'hey' }) }
  h.storage.update({ contacts: [current] }); metrics = h.engine.metrics()
  assert.deepEqual(Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'bySource')), { discovered: 1, eligible: 1, approved: 1, followed: 1, openingSent: 1, replied: 1, fiveRounds: 1, sevenDays: 1 })
  assert.equal(metrics.bySource['comment：交友'].sevenDays, 1); assert.equal(h.c(id).status, 'CONTACT')
})
test('funnel accepts verified observation times while excluding undated unverified messages', async () => {
  const h = harness(), id = h.queue(); await h.engine.runOnce(); h.advance(1)
  const contact = h.storage.get().contacts[0]
  contact.learning.messages.push({ role: 'contact', platformUserId: 'one', identityVerified: true, at: '', observedAt: h.now().toISOString(), text: 'hi' })
  h.storage.update({ contacts: [contact] }); assert.equal(h.engine.reconcileReplies().count, 1)
  h.advance(8 * 1440)
  const current = h.storage.get().contacts[0]
  for (let i = 0; i < 5; i++) current.learning.messages.push(
    { role: 'contact', at: '', observedAt: new Date(h.now().getTime() + i * 2000).toISOString(), text: 'hi' },
    { role: 'me', at: new Date(h.now().getTime() + i * 2000 + 1000).toISOString(), text: 'hey' })
  h.storage.update({ contacts: [current] })
  assert.equal(h.engine.metrics().fiveRounds, 0) // Only the reliable first reply can form a round.
  assert.equal(h.engine.metrics().sevenDays, 0)
  for (const message of current.learning.messages) if (message.role === 'contact') message.identityVerified = true
  h.storage.update({ contacts: [current] })
  assert.equal(h.engine.metrics().fiveRounds, 1); assert.equal(h.engine.metrics().sevenDays, 1)
  assert.equal(h.c(id).status, 'CONTACT')
})
test('finite profile refresh can fill unknown evidence without auto inventing it', async () => {
  const h = harness(), id = h.add('one', { publicSignals: {} }); let refreshes = 0
  h.engine.inspectCandidate = async c => { refreshes++; h.manager.patch(c.id, { publicSignals: { genderText: '女', followerCount: 10 } }) }
  h.engine.update({ mode: 'automatic' }); await h.engine.runOnce()
  assert.equal(h.c(id).status, 'WAITING_REPLY'); assert.ok(refreshes <= 2)
})
test('contact timer is idempotent, unrefed and cancelled by destruction', () => {
  const h = harness(); h.engine.start(); const timer = h.engine.timer; h.engine.start(); assert.equal(h.engine.timer, timer)
  assert.equal(timer.hasRef(), false); h.engine.destroy(); assert.equal(h.engine.timer, null); assert.equal(h.engine.session, h.engine.generation)
})
test('individual pause and resume affect only that queued candidate', async () => {
  const h = harness(), first = h.queue(), second = h.queue(h.add('two'))
  h.engine.pause(first); assert.equal(h.c(first).status, 'PAUSED'); assert.equal(h.engine.control().paused, undefined)
  await h.engine.runOnce(); assert.equal(h.c(second).status, 'WAITING_REPLY'); assert.equal(h.c(first).status, 'PAUSED')
  h.engine.resume(first); h.advance(); await h.engine.runOnce(); assert.equal(h.c(first).status, 'WAITING_REPLY')
})
test('individual pause during submitted follow preserves confirmation before entering PAUSED', async () => {
  const h = harness(), id = h.queue(), pending = deferred()
  h.friendship.follow = async (url, options) => { await options.beforeAction(); await pending.promise; return { ok: true } }
  const run = h.engine.runOnce(); await new Promise(r => setImmediate(r)); h.engine.pause(id)
  assert.equal(h.c(id).status, 'FOLLOWING'); pending.resolve(); await run
  assert.equal(h.c(id).status, 'PAUSED'); assert.equal(h.c(id).contact.resumeStatus, 'FOLLOWED'); assert.ok(h.c(id).contact.followedAt)
  h.engine.resume(id); h.advance(); await h.engine.runOnce(); assert.equal(h.c(id).status, 'WAITING_REPLY')
})
test('individual pause never converts an uncertain send into a resumable task', async () => {
  const h = harness(), id = h.queue(); h.friendship.greeting = async () => { throw Object.assign(new Error('unknown'), { sendAttempted: true }) }
  await h.engine.runOnce(); assert.equal(h.c(id).status, 'SEND_UNKNOWN'); assert.throws(() => h.engine.pause(id)); assert.throws(() => h.engine.resume(id))
})
test('local refresh updates candidate scores without remote actions or changing manual decisions', async () => {
  const h = harness(), id = h.add(); h.approve(id)
  const result = h.engine.refresh(); assert.equal(result.ok, true); assert.equal(h.c(id).status, 'APPROVED'); assert.equal(h.c(id).brain.score, 80)
  const timeline = clone(h.c(id).timeline); h.engine.refresh(); assert.deepEqual(h.c(id).timeline, timeline); assert.equal(h.calls.length, 0)
  h.engine.enqueue(id); await h.engine.runOnce(); const brain = clone(h.c(id).brain)
  h.engine.refresh(); assert.deepEqual(h.c(id).brain, brain); assert.equal(h.engine.metrics().eligible, 1)
})
