const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function candidate(id = 'one', contactStatus) {
  return { id, nickname: `候选${id}`, profileUrl: `https://www.douyin.com/user/${id}`, status: contactStatus || 'REVIEW_PENDING', review: { status: 'pending' }, sources: [{ type: 'user_search', keyword: '篮球' }], brain: { eligibility: 'high_priority', score: 85, hardGate: { passed: true }, signals: ['公开兴趣：篮球'], unknowns: ['所在城市'] }, ...(contactStatus ? { contact: { status: contactStatus, reason: '测试状态', nextCheckAt: '2026-10-11T10:00:00Z' } } : {}) }
}
function fixture() {
  const nodes = new Map(), listeners = new Map(), calls = []
  const element = (value = '', selector = '') => ({ value, selector, disabled: false, checked: false, dataset: {}, tagName: 'INPUT', innerHTML: '', outerHTML: '', scrollTop: 0, contains: () => false, matches(selector) { return selector === this.selector } })
  for (const id of ['app', 'topbar-notice', 'discovery-progress', 'discovery-candidates', 'discovery-detail', 'contact-queue']) nodes.set(id, element())
  const templates = Object.keys({ graduate: 1, dating: 1, social: 1, interest: 1, default: 1 }).map(key => { const node = element('', '[data-contact-template]'); node.dataset.contactTemplate = key; return node })
  const state = { discovery: { config: {}, candidates: [candidate()], runState: {} }, automation: {}, contacts: [] }
  const contact = Object.fromEntries(['update', 'enqueue', 'run', 'pause', 'resume', 'retry', 'refresh'].map(method => [method, async payload => { calls.push([method, payload]); return { ok: true } }]))
  contact.getState = async payload => { calls.push(['getState', payload]); return { config: { enabled: false }, discovery: state.discovery, metrics: {}, running: false } }
  const discovery = { review: async payload => { calls.push(['review', payload]); return { ok: true } } }
  let event, accountChanged
  const desktopApp = { contact, discovery, onDouyinEvent(callback) { event = callback }, accounts: { onChanged(callback) { accountChanged = callback } }, friendship: { search: async () => ({ ok: true, candidates: [] }) } }
  const document = { activeElement: null, documentElement: { dataset: {} }, getElementById: id => nodes.get(id) || null, querySelectorAll: selector => selector === '[data-contact-template]' ? templates : [], querySelector: () => null, addEventListener: (type, callback) => listeners.set(type, callback) }
  const context = vm.createContext({ window: { desktopApp, matchMedia: () => ({ matches: false }) }, document, console, setInterval() {}, setTimeout() { return 1 }, clearTimeout() {} })
  const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/\nloadAll\(\)\s*$/, '\n')
  vm.runInContext(`${source}\nglobalThis.ui = { S, ACTIONS, discoveryView, advancedDiscoveryView, discoveryListView, discoveryDetailView, contactSettingsView, contactQueueView, contactMetricsView, readContactConfig, readDiscoveryConfig, refreshContactState, refreshDynamic };`, context)
  const ui = context.ui
  ui.S.accounts = { active: 'a', accounts: [] }; ui.S.data = state; ui.S.section = 'discovery'; ui.S.discovery.selected = 'one'; ui.S.discovery.toolsOpen = true
  return { ...ui, nodes, templates, listeners, calls, contact, discovery, desktopApp, document, element, event: value => event(value), accountChanged: () => accountChanged() }
}
test('contact settings default disabled and review mode with every greeting template empty', () => {
  const f = fixture(), config = plain(f.readContactConfig())
  assert.equal(config.enabled, false); assert.equal(config.mode, 'review')
  assert.equal(config.dailyLimit, 3); assert.equal(config.intervalMinutes, 30); assert.equal(config.waitlistCheckMinutes, 60); assert.equal(config.autoScoreThreshold, 70)
  assert.deepEqual(config.templates, { graduate: '', dating: '', social: '', interest: '', default: '' })
  assert.match(f.contactSettingsView(), /模板留空时不会联系/)
  assert.doesNotMatch(f.contactSettingsView(), /data-act="friend-opening"/)
})
test('saving an empty template config calls only update with the captured account and never AI or run', async () => {
  const f = fixture()
  await f.ACTIONS['contact-save']({}, f.element())
  assert.deepEqual(f.calls.map(call => call[0]), ['update'])
  assert.equal(f.calls[0][1].accountId, 'a'); assert.equal(f.calls[0][1].config.templates.default, '')
  assert.match(f.S.notice.message, /空模板不会发送首句/)
})
test('automatic mode, limits and explicitly entered template are sent unchanged', async () => {
  const f = fixture()
  f.nodes.set('contact-enabled', f.element('on')); f.nodes.set('contact-mode', f.element('automatic'))
  f.templates[4].value = '你好，看到你也喜欢篮球'
  await f.ACTIONS['contact-save']({}, f.element())
  const config = f.calls[0][1].config
  assert.equal(config.enabled, true); assert.equal(config.mode, 'automatic'); assert.equal(config.templates.default, f.templates[4].value)
})
test('invalid limits and modes reject before contacting the backend', async () => {
  for (const [id, value] of [['contact-dailyLimit', '0'], ['contact-intervalMinutes', '0'], ['contact-autoScoreThreshold', '101'], ['contact-mode', 'auto']]) {
    const f = fixture(); f.nodes.set(id, f.element(value))
    await f.ACTIONS['contact-save']({}, f.element()); assert.equal(f.calls.length, 0); assert.equal(f.S.notice.kind, 'err')
  }
})
test('enqueue approves first with manual gender/age evidence, then enqueues without running or sending', async () => {
  const f = fixture(), gender = f.element('female'), age = f.element('23')
  gender.dataset.candidateId = age.dataset.candidateId = 'one'
  f.nodes.set('discovery-gender-confirmation', gender); f.nodes.set('discovery-age-confirmation', age)
  f.S.discovery.notes.one = '资料年龄明确'
  await f.ACTIONS['contact-enqueue']({ id: 'one' }, f.element())
  assert.deepEqual(plain(f.calls), [['review', { accountId: 'a', id: 'one', status: 'APPROVED', note: '资料年龄明确', genderConfirmation: 'female', ageConfirmation: 23 }], ['enqueue', { accountId: 'a', id: 'one' }]])
  assert.match(f.S.notice.message, /只有开关开启、模板已填/)
})
test('failed approval and invalid manually entered age cannot enqueue', async () => {
  const f = fixture(); f.discovery.review = async () => ({ ok: false, error: '年龄未知，不符合硬条件' })
  await f.ACTIONS['contact-enqueue']({ id: 'one' }, f.element()); assert.equal(f.calls.length, 0); assert.match(f.S.notice.message, /年龄未知/)
  const age = f.element('02'); age.dataset.candidateId = 'one'; f.nodes.set('discovery-age-confirmation', age)
  await f.ACTIONS['contact-enqueue']({ id: 'one' }, f.element()); assert.equal(f.calls.length, 0); assert.match(f.S.notice.message, /18～120/)
})
test('blank greeting template backend rejection is visible and is never replaced with an AI greeting', async () => {
  const f = fixture()
  f.contact.enqueue = async payload => { f.calls.push(['enqueue', payload]); return { ok: false, error: '请先手动填写该来源的首句模板或默认首句，程序不会临时生成开场白' } }
  await f.ACTIONS['contact-enqueue']({ id: 'one' }, f.element())
  assert.deepEqual(f.calls.map(call => call[0]), ['review', 'enqueue'])
  assert.match(f.S.notice.message, /手动填写/); assert.equal(f.S.notice.kind, 'err')
})
test('clearing a manual age explicitly removes old confirmation and conditional age range is validated', async () => {
  const f = fixture(), age = f.element(''); age.dataset.candidateId = 'one'
  f.nodes.set('discovery-age-confirmation', age)
  await f.ACTIONS['discovery-review']({ id: 'one', status: 'DEFERRED' }, f.element())
  assert.equal(f.calls[0][1].ageConfirmation, 'unknown')
  f.nodes.set('discovery-max-videos', f.element('3')); f.nodes.set('discovery-comments', f.element('20'))
  f.nodes.set('discovery-age-required', f.element('on')); f.nodes.set('discovery-age-min', f.element('20')); f.nodes.set('discovery-age-max', f.element('30'))
  let config = f.readDiscoveryConfig(); assert.equal(config.requireAgeRange, true); assert.equal(config.ageMin, 20); assert.equal(config.ageMax, 30)
  f.nodes.get('discovery-age-max').value = '19'; assert.throws(() => f.readDiscoveryConfig(), /最低年龄/)
})
test('late approval after account switch cannot enqueue or replace the new account', async () => {
  const f = fixture(), wait = deferred()
  f.discovery.review = payload => { f.calls.push(['review', payload]); return wait.promise }
  const pending = f.ACTIONS['contact-enqueue']({ id: 'one' }, f.element())
  f.S.accounts.active = 'b'; const old = plain(f.S.data.discovery)
  wait.resolve({ ok: true, discovery: { candidates: [] } }); await pending
  assert.deepEqual(f.calls.map(call => call[0]), ['review']); assert.deepEqual(plain(f.S.data.discovery), old)
})
test('late contact state results do not overwrite another account or a reset local state', async () => {
  const f = fixture(), wait = deferred(); f.contact.getState = () => wait.promise
  const pending = f.refreshContactState('a'); f.S.contact = { busy: false, config: null, metrics: {}, drafts: {} }
  wait.resolve({ config: { enabled: true }, discovery: { candidates: [] }, metrics: { openingSent: 99 } })
  assert.equal(await pending, false); assert.equal(f.S.contact.config, null); assert.equal(f.S.data.discovery.candidates.length, 1)
})
test('unknown send/follow states show no retry and cannot invoke retry from a stale action', async () => {
  for (const status of ['SEND_UNKNOWN', 'FOLLOW_UNCERTAIN', 'WAITING_REPLY', 'CONTACT_WAITLIST']) {
    const f = fixture(); f.S.data.discovery.candidates[0] = candidate('one', status)
    assert.doesNotMatch(f.discoveryDetailView(), /data-act="contact-retry"/)
    await f.ACTIONS['contact-retry']({ id: 'one' }, f.element()); assert.equal(f.calls.length, 0)
  }
})
test('pause resume retry controls depend on persisted contact state', async () => {
  const f = fixture(); f.S.data.discovery.candidates[0] = candidate('one', 'CONTACT_WAITLIST')
  assert.match(f.discoveryDetailView(), /data-act="contact-pause"/)
  await f.ACTIONS['contact-pause']({ id: 'one' }, f.element()); assert.deepEqual(plain(f.calls[0]), ['pause', { accountId: 'a', id: 'one' }])
  f.S.data.discovery.candidates[0].contact.status = 'PAUSED'
  f.S.data.discovery.candidates[0].contact.resumeStatus = 'CONTACT_WAITLIST'
  assert.match(f.discoveryDetailView(), /data-act="contact-resume"/); assert.doesNotMatch(f.discoveryDetailView(), /data-act="contact-pause"/)
  await f.ACTIONS['contact-resume']({ id: 'one' }, f.element()); assert.equal(f.calls[1][0], 'resume')
  f.S.data.discovery.candidates[0].contact.status = 'FAILED'
  f.S.data.discovery.candidates[0].contact.retrySafe = true
  assert.match(f.discoveryDetailView(), /data-act="contact-retry"/)
  await f.ACTIONS['contact-retry']({ id: 'one' }, f.element()); assert.equal(f.calls[2][0], 'retry')
})
test('disabled contact engine cannot run; refresh remains available', async () => {
  const f = fixture(); await f.ACTIONS['contact-run']({}, f.element()); assert.equal(f.calls.length, 0)
  await f.ACTIONS['contact-refresh']({}, f.element()); assert.deepEqual(plain(f.calls[0]), ['refresh', { accountId: 'a' }])
  f.S.contact.config = { enabled: true }; await f.ACTIONS['contact-run']({}, f.element()); assert.equal(f.calls[1][0], 'run')
})
test('global pause and resume omit candidate IDs and reflect backend queue state', async () => {
  const f = fixture()
  f.contact.pause = async payload => { f.calls.push(['pause', payload]); return { ok: true, paused: true, contactState: { paused: true, reason: '联系队列已暂停' } } }
  f.contact.resume = async payload => { f.calls.push(['resume', payload]); return { ok: true, paused: false, contactState: { paused: false, reason: '' } } }
  await f.ACTIONS['contact-global-pause']({}, f.element())
  assert.equal(f.S.contact.paused, true); assert.match(f.contactQueueView(), /恢复全队列/); assert.match(f.contactQueueView(), /联系队列已暂停/)
  await f.ACTIONS['contact-global-resume']({}, f.element())
  assert.deepEqual(plain(f.calls), [['pause', { accountId: 'a' }], ['resume', { accountId: 'a' }]])
  assert.equal(f.S.contact.paused, false); assert.match(f.contactQueueView(), /暂停全队列/); assert.doesNotMatch(f.contactQueueView(), /恢复全队列|联系队列已暂停/)
})
test('skipped checks expose actual template, quota or interval reason rather than success language', async () => {
  for (const reason of ['请先手动填写首句模板', '今天结识人数已达联系队列上限', '尚未到下一次联系时间']) {
    const f = fixture(); f.S.contact.config = { enabled: true }
    f.contact.run = async () => ({ ok: true, skipped: true, reason })
    await f.ACTIONS['contact-run']({}, f.element())
    assert.equal(f.S.notice.message, `本次未执行联系：${reason}`)
    assert.match(f.contactQueueView(), new RegExp(reason)); assert.doesNotMatch(f.S.notice.message, /检查完成/)
  }
})
test('account-scoped progress preserves global pause and control reason without changing drafts', () => {
  const f = fixture(); f.S.contact.drafts.templates = { default: '未保存的首句' }
  f.event({ type: 'contact_progress', accountId: 'a', payload: { paused: true, contactState: { reason: '<script>验证码检查</script>' } } })
  assert.equal(f.S.contact.paused, true); assert.match(f.contactQueueView(), /恢复全队列/)
  assert.match(f.contactQueueView(), /&lt;script&gt;/); assert.doesNotMatch(f.contactQueueView(), /<script>/)
  assert.equal(f.S.contact.drafts.templates.default, '未保存的首句')
})
test('Brain score sorts both sources, preserving independent manual and eligibility filters', () => {
  const f = fixture(), low = candidate('low'), high = candidate('high')
  low.brain = { eligibility: 'worth_reviewing', score: 50 }; low.sources[0].type = 'comment'
  high.brain.score = 99
  f.S.data.discovery.candidates = [low, high]
  let html = f.discoveryListView(); assert.ok(html.indexOf('候选high') < html.indexOf('候选low')); assert.match(html, /用户搜索/); assert.match(html, /视频评论/)
  f.S.discovery.brainFilter = 'worth_reviewing'; html = f.discoveryListView(); assert.match(html, /候选low/); assert.doesNotMatch(html, /候选high/)
  f.S.discovery.filter = 'approved'; assert.doesNotMatch(f.discoveryListView(), /候选low/)
})
test('excluded candidates remain accessible in either the manual rejection or Brain rejection view', () => {
  const f = fixture(), c = f.S.data.discovery.candidates[0]
  f.S.data.discovery.config.targetGender = 'female'; c.publicSignals = { genderText: '男' }
  c.brain = { eligibility: 'reject', score: 0, hardGate: { passed: false, reason: '不符合性别要求' } }
  assert.doesNotMatch(f.discoveryListView(), /候选one/)
  f.S.discovery.brainFilter = 'reject'; assert.match(f.discoveryListView(), /候选one/)
  c.review.status = 'rejected'; f.S.discovery.filter = 'rejected'; f.S.discovery.brainFilter = 'all'
  assert.match(f.discoveryListView(), /候选one/)
})
test('detail displays actual Brain evidence unknowns and contact history with HTML escaping', () => {
  const f = fixture(), c = candidate('one', 'WAITING_REPLY')
  c.timeline = [{ type: 'OPENING_SENT', at: '2026-10-10T10:00:00Z', detail: '<script>bad()</script>' }]
  f.S.data.discovery.candidates = [c]
  const html = f.discoveryDetailView()
  assert.match(html, /公开兴趣：篮球/); assert.match(html, /所在城市/); assert.match(html, /等待对方回复/); assert.match(html, /首句已发送/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|OPENING_SENT/)
})
test('funnel only renders backend metrics and absent outcomes remain zero', () => {
  const f = fixture(); f.S.contact.metrics = { discovered: 17, eligible: 4, approved: 2, followed: 1 }
  const html = f.contactMetricsView(); assert.match(html, /发现 17/); assert.match(html, /首句 0/); assert.match(html, /回复 0/); assert.match(html, /5轮 0/); assert.match(html, /7天 0/)
})
test('per-source metrics use actual keyword counts, correctly define rates and show no-sample dash', () => {
  const f = fixture(); f.S.contact.metrics = { bySource: { 'user_search：篮球': { discovered: 10, openingSent: 4, replied: 1 }, 'comment：摄影': { discovered: 0, openingSent: 0, replied: 0 } } }
  const html = f.contactMetricsView()
  assert.match(html, /用户搜索：篮球/); assert.match(html, /视频评论：摄影/)
  assert.match(html, /40\.0%/); assert.match(html, /25\.0%/); assert.match(html, /<td>—<\/td>/)
})
test('delivered and unknown candidates have no per-candidate pause or retry that could reset contact history', async () => {
  for (const status of ['SEND_UNKNOWN', 'FOLLOW_UNCERTAIN', 'MESSAGE_UNCERTAIN', 'OPENING_SENDING', 'FOLLOWING', 'WAITING_REPLY', 'OPENING_SENT', 'REPLIED', 'CONTACT', 'ACTIVE']) {
    const f = fixture(); f.S.data.discovery.candidates[0] = candidate('one', status)
    assert.doesNotMatch(f.discoveryDetailView(), /data-act="contact-pause"|data-act="contact-retry"/)
    await f.ACTIONS['contact-pause']({ id: 'one' }, f.element()); assert.equal(f.calls.length, 0)
  }
})
test('unsafe paused resume history and failed steps without proof never offer resend controls', async () => {
  const f = fixture(), c = candidate('one', 'PAUSED'); c.contact.resumeStatus = 'SEND_UNKNOWN'; f.S.data.discovery.candidates = [c]
  assert.doesNotMatch(f.discoveryDetailView(), /data-act="contact-resume"/)
  await f.ACTIONS['contact-resume']({ id: 'one' }, f.element()); assert.equal(f.calls.length, 0)
  c.contact.status = 'FAILED'; c.contact.retrySafe = false
  assert.doesNotMatch(f.discoveryDetailView(), /data-act="contact-retry"/)
  await f.ACTIONS['contact-retry']({ id: 'one' }, f.element()); assert.equal(f.calls.length, 0)
})
test('history maps event and state labels to Chinese and omits raw technical JSON', () => {
  const f = fixture(), c = f.S.data.discovery.candidates[0]
  c.timeline = [{ type: 'follow_confirmed', at: '2026-10-10T10:00:00Z', detail: { status: 'FOLLOWED', reason: '页面确认已关注', platformUserId: 'PRIVATE_INTERNAL_ID' } }, { type: 'new_unknown_event', at: '2026-10-10T11:00:00Z', detail: { sourceType: 'comment', sourceKeyword: '宠物', debugSnapshot: 'DO_NOT_RENDER' } }]
  const html = f.discoveryDetailView()
  assert.match(html, /关注成功|页面确认已关注/); assert.match(html, /状态更新/); assert.match(html, /关键词：宠物/)
  assert.doesNotMatch(html, /follow_confirmed|FOLLOWED|new_unknown_event|platformUserId|PRIVATE_INTERNAL_ID|debugSnapshot|DO_NOT_RENDER/)
})
test('manual configured age range cannot exceed backend maximum 100', () => {
  const f = fixture(); f.nodes.set('discovery-max-videos', f.element('3')); f.nodes.set('discovery-comments', f.element('20'))
  f.nodes.set('discovery-age-max', f.element('101'))
  assert.throws(() => f.readDiscoveryConfig(), /18～100/)
  assert.match(f.advancedDiscoveryView(), /id="discovery-age-max" type="number" min="18" max="100"/)
})
test('account-scoped progress updates never overwrite focused manual search or templates', () => {
  const f = fixture(), key = f.element('手动关键词'), queue = f.nodes.get('contact-queue')
  f.nodes.set('discovery-video-keywords', key); f.document.activeElement = key
  f.templates[0].value = '我的研究生首句'; f.listeners.get('input')({ target: f.templates[0] })
  f.event({ type: 'contact_progress', accountId: 'wrong', payload: { config: { enabled: true }, metrics: { openingSent: 88 } } })
  assert.equal(f.S.contact.config, null)
  f.event({ type: 'contact_progress', accountId: 'a', payload: { config: { enabled: true, templates: {} }, metrics: { openingSent: 1 } } }); f.refreshDynamic()
  assert.equal(key.value, '手动关键词'); assert.equal(f.templates[0].value, '我的研究生首句'); assert.match(f.contactSettingsView(), /我的研究生首句/); assert.match(queue.innerHTML, /首句 1/)
})
test('account switching clears contact drafts and loads the new account contact config', async () => {
  const f = fixture(); f.S.contact.drafts.templates = { default: '旧账号模板' }
  f.desktopApp.accounts.switch = async id => ({ state: { discovery: { config: {}, candidates: [], runState: {} }, contacts: [], automation: {} } })
  f.desktopApp.accounts.list = async () => ({ active: 'b', accounts: [] })
  f.contact.getState = async payload => { f.calls.push(['getState', payload]); return { config: { enabled: false, templates: {} }, metrics: {}, discovery: f.S.data.discovery, running: false } }
  await f.ACTIONS['account-switch']({ id: 'b' })
  assert.deepEqual(plain(f.S.contact.drafts), {}); assert.equal(f.S.contact.config.enabled, false)
  assert.deepEqual(plain(f.calls[0]), ['getState', { accountId: 'b' }]); assert.doesNotMatch(f.contactSettingsView(), /旧账号模板/)
})

test('retired people-search buttons have no renderer action while candidate pool remains usable', () => {
  const f = fixture()
  for (const action of ['friend-search', 'friend-auto-run', 'friend-persona', 'friend-follow', 'friend-opening']) {
    assert.equal(f.ACTIONS[action], undefined)
  }
  assert.match(f.discoveryListView(), /候选one/)
})
