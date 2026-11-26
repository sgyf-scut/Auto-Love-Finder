const { test } = require('node:test')
const assert = require('node:assert/strict')
const { AutoFriendshipService, normalizeAutoFriendshipConfig } = require('../electron/auto-friendship.cjs')

const candidate = (id = 'one', name = `陌生人${id}`) => ({ url: `https://www.douyin.com/user/${id}`, name, summary: '喜欢宠物和摄影', keyword: '宠物' })
const clone = value => structuredClone(value)
function harness(extra = {}) {
  let now = new Date('2026-10-10T12:00:00+08:00')
  let data = { selfPersona: { name: '本人', interests: '宠物，摄影' }, providers: [{ name: 'mock' }], settings: {}, automation: { paused: false, blacklist: [], aiDisabledContacts: [] }, contacts: [], sendHistory: [], friendship: { followed: [], automatic: { enabled: true, keywords: ['宠物'], dailyLimit: 3, intervalMinutes: 30, scanDailyLimit: 20 }, autoState: {} }, ...extra }
  const calls = [], events = []
  const storage = { get: () => clone(data), update: patch => { data = { ...data, ...clone(patch) }; return storage.get() } }
  const douyin = { storage, verificationActive: false, getSendAllowance: () => ({ ok: true }), log: (...args) => calls.push(['log', ...args]), emitEvent: (...args) => events.push(args) }
  const friendship = {
    candidates: new Map(), destroyed: false,
    async search(keyword, options) { calls.push(['search', keyword]); options?.beforeAction?.(); const candidates = [candidate()]; this.candidates = new Map(candidates.map(c => [c.url, c])); return { ok: true, candidates } },
    async opening(url) { calls.push(['opening', url]); return { ok: true, text: '你好，看到你也喜欢宠物，想认识一下', model: 'mock', provider: 'mock' } },
    async follow(url, options) { options?.beforeAction?.(); calls.push(['follow', url]); const selected = this.candidates.get(url); storage.update({ friendship: { ...storage.get().friendship, followed: [...storage.get().friendship.followed, { ...selected, followedAt: now.toISOString() }] } }); return { ok: true, candidate: selected } },
    async greeting(url, text, options) { options?.beforeSubmit?.(); calls.push(['greeting', url, text]); const selected = this.candidates.get(url); storage.update({ contacts: [...storage.get().contacts, { id: url, name: selected.name, profile: { chatMode: 'friendship', autoFriendship: true, autoFriendshipUrl: url } }], sendHistory: [...storage.get().sendHistory, { name: selected.name, at: now.toISOString() }] }); return { ok: true, name: selected.name, profileUrl: url, contactId: url } },
  }
  const ai = { hasProvider: () => Boolean(storage.get().providers.length), async pickFriendCandidate(payload) { calls.push(['pick', clone(payload)]); return { ok: true, index: 0, reason: '共同兴趣' } } }
  const service = new AutoFriendshipService({ douyin, friendship, storage, ai, accountId: 'account-a', clock: () => new Date(now) })
  return { service, friendship, storage, ai, douyin, calls, events, advance: (minutes = 30) => { now = new Date(now.getTime() + minutes * 60000) }, now: () => new Date(now), job: () => storage.get().friendship.autoState.jobs?.[0], mutations: () => calls.filter(c => ['follow', 'greeting'].includes(c[0])) }
}
function setResults(h, candidates) { h.friendship.search = async (keyword, options) => { options?.beforeAction?.(); h.calls.push(['search', keyword]); h.friendship.candidates = new Map(candidates.map(c => [c.url, c])); return { ok: true, candidates: clone(candidates) } } }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('automatic friendship defaults off and bounds editable pacing and keywords', () => {
  assert.deepEqual(normalizeAutoFriendshipConfig(), { enabled: false, keywords: [], dailyLimit: 3, intervalMinutes: 30, scanDailyLimit: 20 })
  assert.equal(normalizeAutoFriendshipConfig(null).enabled, false)
  assert.deepEqual(normalizeAutoFriendshipConfig({ enabled: 1, keywords: '猫，风景\n猫', dailyLimit: 1000, intervalMinutes: 0, scanDailyLimit: -1 }), { enabled: false, keywords: ['猫', '风景'], dailyLimit: 20, intervalMinutes: 5, scanDailyLimit: 1 })
})
test('enabling requires persona, search interest and configured model; disabling always works', () => {
  for (const extra of [{ selfPersona: {} }, { selfPersona: { name: '本人' }, friendship: { followed: [], automatic: { enabled: false, keywords: [] } } }, { providers: [] }]) {
    const h = harness(extra)
    assert.throws(() => h.service.update({ enabled: true }))
    assert.equal(h.service.update({ enabled: false }).automatic.enabled, false)
    assert.equal(h.mutations().length, 0)
  }
  const h = harness({ friendship: { followed: [], automatic: { enabled: false, keywords: [] } } })
  assert.equal(h.service.update({ enabled: true }).automatic.enabled, true)
  assert.deepEqual(h.service.keywords(), ['宠物', '摄影'])
})
test('one round generates opening before following and confirms greeting with durable checkpoints', async () => {
  const h = harness(), result = await h.service.runOnce()
  assert.equal(result.greeted, true)
  assert.deepEqual(h.calls.filter(c => ['search', 'pick', 'opening', 'follow', 'greeting'].includes(c[0])).map(c => c[0]), ['search', 'pick', 'opening', 'follow', 'greeting'])
  const job = h.job()
  assert.equal(job.status, 'greeted'); assert.equal(job.accountId, 'account-a'); assert.equal(job.greetingAttempts, 1)
  assert.ok(job.followAttemptAt && job.followedAt && job.greetedAt && job.contactId)
  assert.equal(h.events.at(-1)[0], 'friendship_auto')
  assert.equal(h.events.at(-1)[1].autoState.jobs[0].status, 'greeted')
})
test('confirmed greetings cannot repeat after interval or controller restart', async () => {
  const h = harness(); await h.service.runOnce(); h.advance()
  await h.service.runOnce()
  const restarted = new AutoFriendshipService({ ...h, clock: h.now })
  h.advance(); await restarted.runOnce()
  assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 1)
})
test('cached authentic candidates allow three rounds while scanning once and respect daily cap', async () => {
  const h = harness(); setResults(h, [candidate('one'), candidate('two'), candidate('three'), candidate('four')])
  for (let i = 0; i < 4; i++) { await h.service.runOnce(); h.advance() }
  assert.equal(h.calls.filter(c => c[0] === 'search').length, 1)
  assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 3)
  assert.equal(h.storage.get().friendship.autoState.dailyScans, 4)
  assert.equal(h.service.dailyUsage(), 3)
})
test('search scan cap bounds result count and does not permit unlimited retries', async () => {
  const h = harness(); h.service.update({ scanDailyLimit: 1, dailyLimit: 10 })
  setResults(h, [candidate('one'), candidate('two'), candidate('three')])
  await h.service.runOnce(); h.advance(); await h.service.runOnce()
  assert.equal(h.calls.filter(c => c[0] === 'search').length, 1)
  assert.equal(h.calls.filter(c => c[0] === 'follow').length, 1)
  assert.equal(h.storage.get().friendship.autoState.dailyScans, 1)
})
test('known names, blacklist, disabled AI, existing follows, duplicate names and invalid URLs are filtered', async () => {
  const h = harness({ contacts: [{ name: '老朋友' }], sendHistory: [{ name: '聊过了' }], automation: { blacklist: ['拉黑'], aiDisabledContacts: ['AI关闭'] } })
  const followed = candidate('followed', '已经关注')
  h.storage.update({ friendship: { ...h.storage.get().friendship, followed: [followed] } })
  const good = candidate('valid', '可以认识')
  setResults(h, [candidate('old', '老朋友'), candidate('black', '拉黑'), candidate('off', 'AI关闭'), followed, candidate('chat', '聊过了'), candidate('a', '相同名字'), candidate('b', '相同名字'), { ...candidate('marked'), followed: true }, { ...candidate(), url: 'https://evil.com/user/not-real' }, candidate('self'), good, { ...good, url: good.url + '?from=search' }])
  assert.equal((await h.service.runOnce()).greeted, true)
  assert.deepEqual(h.calls.find(c => c[0] === 'pick')[1].candidates.map(c => c.url), [good.url])
})
test('AI invalid index and failed selection do not fallback to any stranger', async () => {
  for (const result of [{ ok: true, index: 30 }, { ok: true, index: '0' }, { ok: false, error: '模型失效' }]) {
    const h = harness(); h.ai.pickFriendCandidate = async () => result
    assert.equal((await h.service.runOnce()).ok, false)
    assert.equal(h.mutations().length, 0)
  }
})
test('AI can explicitly decline every candidate without following or sending', async () => {
  for (const index of [null, -1]) {
    const h = harness(); h.ai.pickFriendCandidate = async () => ({ ok: true, index, reason: '不合适' })
    assert.equal((await h.service.runOnce()).skipped, true)
    assert.equal(h.mutations().length, 0)
  }
})
test('opening failure prevents any attention mutation', async () => {
  const h = harness(); h.friendship.opening = async () => ({ ok: false, error: '生成失败' })
  assert.equal((await h.service.runOnce()).ok, false)
  assert.equal(h.mutations().length, 0); assert.equal(h.job().status, 'failed')
})
test('switching off while AI selects cancels follow and greeting', async () => {
  const h = harness(), wait = deferred(), entered = deferred()
  h.ai.pickFriendCandidate = async () => { entered.resolve(); return wait.promise }
  const running = h.service.runOnce(); await entered.promise; h.service.update({ enabled: false }); wait.resolve({ ok: true, index: 0 })
  assert.equal((await running).ok, false); assert.equal(h.mutations().length, 0)
})
test('switching off while opening is generated cancels the current candidate', async () => {
  const h = harness(), wait = deferred(), entered = deferred()
  h.friendship.opening = async () => { entered.resolve(); return wait.promise }
  const running = h.service.runOnce(); await entered.promise; h.service.update({ enabled: false }); wait.resolve({ ok: true, text: '你好' })
  await running; assert.equal(h.mutations().length, 0); assert.equal(h.job().status, 'selected')
})
test('follow checks latest switch immediately before click', async () => {
  const h = harness()
  h.friendship.follow = async (url, options) => { h.service.update({ enabled: false }); options.beforeAction(); throw new Error('unreachable') }
  await h.service.runOnce()
  assert.equal(h.mutations().length, 0); assert.equal(h.job().status, 'opening_ready')
})
test('greeting checks latest switch immediately before submit and resumes without refollow', async () => {
  const h = harness(), original = h.friendship.greeting.bind(h.friendship)
  h.friendship.greeting = async (url, text, options) => { h.service.update({ enabled: false }); options.beforeSubmit(); throw new Error('unreachable') }
  await h.service.runOnce(); assert.equal(h.job().status, 'followed'); assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 0)
  h.friendship.greeting = original; h.service.update({ enabled: true }); await h.service.runOnce()
  assert.equal(h.job().status, 'greeted'); assert.equal(h.calls.filter(c => c[0] === 'follow').length, 1)
})
test('shutdown during awaited model result prevents mutations', async () => {
  const h = harness(), wait = deferred(), entered = deferred()
  h.ai.pickFriendCandidate = async () => { entered.resolve(); return wait.promise }
  const running = h.service.runOnce(); await entered.promise; h.service.destroy(); wait.resolve({ ok: true, index: 0 })
  await running; assert.equal(h.mutations().length, 0)
})
test('restarting in sending or following marks uncertainty and never replays the remote action', async () => {
  for (const [status, expected] of [['sending', 'uncertain'], ['following', 'follow_uncertain']]) {
    const c = candidate(), h = harness({ friendship: { followed: [], automatic: { enabled: true, keywords: ['宠物'] }, autoState: { jobs: [{ ...c, status, openingText: '你好', followedAt: status === 'sending' ? '2026-10-10T03:00:00Z' : null }] } } })
    assert.equal(h.job().status, expected)
    await h.service.runOnce(); assert.equal(h.mutations().length, 0)
  }
})
test('unconfirmed submission is uncertain and cannot be retried automatically', async () => {
  const h = harness(); h.friendship.greeting = async () => ({ ok: false, uncertain: true, error: '没有确认消息已发出' })
  assert.equal((await h.service.runOnce()).ok, false); assert.equal(h.job().status, 'uncertain'); assert.equal(h.job().greetedAt, null)
  h.advance(); await h.service.runOnce(); assert.equal(h.job().greetingAttempts, 1)
})
test('confirmed pre-submit failure remains failed instead of greeted', async () => {
  const h = harness(); h.friendship.greeting = async () => ({ ok: false, error: '找不到编辑框', sendAttempted: false })
  await h.service.runOnce(); assert.equal(h.job().status, 'failed'); assert.equal(h.job().greetedAt, null)
})
test('verification and login block background work until explicit user resume', async () => {
  const h = harness(); h.friendship.search = async () => { throw Object.assign(new Error('需要验证'), { blocked: true, code: 'challenge' }) }
  assert.equal((await h.service.runOnce()).blocked, true)
  assert.equal(h.storage.get().friendship.autoState.blockedReason, '需要验证')
  const calls = h.calls.length; h.advance(); assert.equal((await h.service.runOnce()).skipped, true); assert.equal(h.calls.length, calls)
  setResults(h, [candidate()]); h.service.update({ enabled: true }); assert.equal((await h.service.runOnce()).greeted, true)
})
test('account pause, quiet hours, verification, and shared quota prevent discovery and mutations', async () => {
  for (const kind of ['paused', 'quiet', 'verification', 'quota']) {
    const h = harness()
    if (kind === 'paused') h.storage.update({ automation: { paused: true } })
    if (kind === 'quiet') h.storage.update({ settings: { quietHours: true, quietStart: '11:00', quietEnd: '13:00' } })
    if (kind === 'verification') h.douyin.verificationActive = true
    if (kind === 'quota') h.douyin.getSendAllowance = () => ({ ok: false, reason: '达到账号每日上限' })
    assert.equal((await h.service.runOnce()).skipped, true); assert.equal(h.calls.length, 0); assert.equal(h.mutations().length, 0)
  }
})
test('shared quota is checked after generation and before any following', async () => {
  const h = harness()
  h.friendship.opening = async () => { h.douyin.getSendAllowance = () => ({ ok: false, reason: '发送额度耗尽' }); return { ok: true, text: '你好' } }
  await h.service.runOnce(); assert.equal(h.mutations().length, 0)
})
test('follow identity mismatch prevents greeting and marks follow uncertain', async () => {
  const h = harness(); h.friendship.follow = async () => ({ ok: true, name: '完全不同的用户' })
  await h.service.runOnce(); assert.equal(h.job().status, 'follow_uncertain'); assert.equal(h.job().greetedAt, null)
})
test('already-followed confirmation skips greeting', async () => {
  const h = harness(); h.friendship.follow = async () => ({ ok: true, alreadyFollowed: true, candidate: candidate() })
  assert.equal((await h.service.runOnce()).skipped, true); assert.equal(h.job().status, 'skipped'); assert.equal(h.job().greetingAttempts, undefined)
})
test('contacts added during generation cannot receive a stranger greeting', async () => {
  const h = harness(); h.friendship.opening = async () => { h.storage.update({ contacts: [{ name: candidate().name }] }); return { ok: true, text: '你好' } }
  await h.service.runOnce(); assert.equal(h.mutations().length, 0)
})
test('concurrent rounds share one lock and do not race the same candidate', async () => {
  const h = harness(), wait = deferred(), entered = deferred()
  h.ai.pickFriendCandidate = async () => { entered.resolve(); return wait.promise }
  const first = h.service.runOnce(); await entered.promise
  assert.equal((await h.service.runOnce()).skipped, true)
  wait.resolve({ ok: true, index: 0 }); await first
  assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 1)
})
test('persisted search cache survives restart without inventing or re-searching candidates', async () => {
  const h = harness(); setResults(h, [candidate('one'), candidate('two')]); await h.service.runOnce(); h.advance()
  h.friendship.candidates.clear()
  const restarted = new AutoFriendshipService({ ...h, clock: h.now }); await restarted.runOnce()
  assert.equal(h.calls.filter(c => c[0] === 'search').length, 1)
  assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 2)
  assert.equal(h.storage.get().friendship.autoState.jobs[1].url, candidate('two').url)
})
test('search result must match public candidates cache, regardless of AI output', async () => {
  const h = harness(); h.friendship.search = async () => ({ ok: true, candidates: [candidate()] })
  assert.equal((await h.service.runOnce()).ok, false); assert.equal(h.mutations().length, 0)
})
test('timer starts once and destruction releases it without beginning a new action', () => {
  const h = harness(); h.service.start(); const timer = h.service.timer
  h.service.start(); assert.equal(h.service.timer, timer); assert.equal(h.calls.length, 0)
  h.service.destroy(); assert.equal(h.service.timer, null); assert.equal(h.service.destroyed, true)
  assert.throws(() => h.service.update({ enabled: true }))
})
test('a resumed previous-day follow counts toward today and cannot bypass its daily limit', async () => {
  const old = candidate('prior', '昨晚关注'), h = harness({ friendship: { followed: [old], automatic: { enabled: true, keywords: ['宠物'], dailyLimit: 1 }, autoState: { jobs: [{ ...old, status: 'followed', openingText: '你好', followAttemptAt: '2026-10-09T15:00:00Z', followedAt: '2026-10-09T15:00:00Z' }] } } })
  setResults(h, [candidate('new')])
  assert.equal((await h.service.runOnce()).greeted, true)
  assert.equal(h.service.dailyUsage(), 1)
  h.advance(); assert.equal((await h.service.runOnce()).skipped, true)
  assert.equal(h.calls.filter(c => c[0] === 'greeting').length, 1)
  assert.equal(h.calls.filter(c => c[0] === 'follow').length, 0)
})
test('AI-declined search batch is consumed instead of repeatedly asking about the same unsuitable users', async () => {
  const h = harness(); h.service.update({ scanDailyLimit: 2 }); setResults(h, [candidate('one'), candidate('two')])
  h.ai.pickFriendCandidate = async payload => { h.calls.push(['pick', payload]); return { ok: true, index: -1, reason: '公开资料没有共同兴趣' } }
  await h.service.runOnce(); h.advance(); await h.service.runOnce()
  assert.equal(h.calls.filter(c => c[0] === 'pick').length, 1)
  assert.equal(h.storage.get().friendship.autoState.lastSelectionReason, '公开资料没有共同兴趣')
  assert.equal(h.mutations().length, 0)
})
