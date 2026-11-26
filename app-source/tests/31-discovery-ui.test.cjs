const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const candidate = (id = 'one', status = 'REVIEW_PENDING') => ({
  id, nickname: `朋友${id}`, profileUrl: `https://www.douyin.com/user/${id}`, status,
  sources: [{ topic: '社交', keyword: '交友', videoId: '123', videoTitle: '主题视频', commentId: 'c1', commentText: '想认识一起打球的人' }],
  review: { status: ({ APPROVED: 'approved', DEFERRED: 'deferred', REJECTED: 'rejected' })[status] || 'pending', note: '' }, score: 70,
})

function fixture() {
  const nodes = new Map(), listeners = new Map(), calls = []
  const element = (value = '') => ({ value, checked: true, disabled: false, dataset: {}, tagName: 'INPUT', innerHTML: '', outerHTML: '', scrollTop: 0, contains: () => false, matches(selector) { return selector === this.selector } })
  for (const id of ['app', 'topbar-notice', 'discovery-progress', 'discovery-candidates', 'discovery-detail', 'discovery-max-videos', 'discovery-comments', 'discovery-note']) nodes.set(id, element())
  nodes.get('discovery-max-videos').value = '3'
  nodes.get('discovery-comments').value = '20'
  const enabled = element()
  const keywords = element('交友，篮球、篮球'); keywords.selector = '#discovery-video-keywords'
  nodes.set('discovery-video-keywords', keywords)
  const tags = element(''); tags.selector = '#discovery-video-tags'; nodes.set('discovery-video-tags', tags)
  const config = { topics: [{ id: 'social', label: '社交', enabled: true, keywords: ['交友'] }], maxVideosPerRun: 3, commentsPerVideo: 20 }
  const state = { discovery: { config, candidates: [candidate(), candidate('two', 'APPROVED'), candidate('three', 'DEFERRED'), candidate('four', 'REJECTED')], runState: { status: 'idle', counts: {} } }, automation: {}, contacts: [] }
  let onEvent, onAccountChanged
  const discovery = Object.fromEntries(['parse', 'updateConfig', 'start', 'stop', 'open', 'inspect', 'review'].map(name => [name, async payload => { calls.push([name, payload]); return { ok: true } }]))
  const desktopApp = { discovery, onDouyinEvent: callback => { onEvent = callback }, accounts: { onChanged: callback => { onAccountChanged = callback } } }
  const document = {
    activeElement: null, documentElement: { dataset: {} }, getElementById: id => nodes.get(id) || null,
    querySelectorAll: selector => selector === '[data-discovery-topic]' ? [enabled] : selector === '[data-discovery-keywords]' ? [keywords] : [],
    querySelector: () => null, addEventListener: (event, callback) => listeners.set(event, callback),
  }
  const context = vm.createContext({ window: { desktopApp, matchMedia: () => ({ matches: false }) }, document, console, setInterval() {}, setTimeout() { return 1 }, clearTimeout() {} })
  const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/\nloadAll\(\)\s*$/, '\n')
  vm.runInContext(`${source}\nglobalThis.ui = { S, ACTIONS, discoveryView, advancedDiscoveryView, discoveryDetailView, discoveryListView, readDiscoveryConfig, refreshDynamic };`, context)
  const ui = context.ui
  ui.S.accounts = { active: 'account-a', accounts: [] }
  ui.S.section = 'discovery'; ui.S.data = state; ui.S.discovery.selected = 'one'; ui.S.discovery.toolsOpen = true
  return { ...ui, nodes, listeners, calls, discovery, enabled, keywords, tags, element, event: event => onEvent(event), document, onAccountChanged: () => onAccountChanged() }
}
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('AI requirement parsing previews conditions without saving settings or starting discovery', async () => {
  const f = fixture(); f.nodes.set('discovery-requirements', f.element('女生，粉丝少于150'))
  f.discovery.parse = async payload => { f.calls.push(['parse', payload]); return { ok: true, config: { ...f.S.data.discovery.config, targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 }, unsupported: [] } }
  await f.ACTIONS['discovery-parse']({}, f.element())
  assert.deepEqual(f.calls.map(c => c[0]), ['parse']); assert.equal(f.S.data.discovery.config.targetGender, 'female')
  assert.match(f.advancedDiscoveryView(), /粉丝数需少于/); assert.match(f.S.notice.message, /检查条件/)
})
test('unsupported requirements are reported and cannot silently replace the old settings', async () => {
  const f = fixture(); f.nodes.set('discovery-requirements', f.element('女生，20岁'))
  const old = plain(f.S.data.discovery.config)
  f.discovery.parse = async () => ({ ok: true, config: { targetGender: 'female' }, unsupported: ['年龄20岁'] })
  await f.ACTIONS['discovery-parse']({}, f.element())
  assert.deepEqual(plain(f.S.data.discovery.config), old); assert.match(f.S.notice.message, /年龄20岁/)
})

test('manual search inputs survive AI preview, including edits while AI is pending', async () => {
  const f = fixture(), wait = deferred()
  f.nodes.set('discovery-requirements', f.element('女生'))
  f.tags.value = '#校园生活'; f.listeners.get('input')({ target: f.tags })
  f.discovery.parse = () => wait.promise
  const pending = f.ACTIONS['discovery-parse']({}, f.element())
  f.keywords.value = '猫咪日常\n周末徒步'; f.listeners.get('input')({ target: f.keywords })
  wait.resolve({ ok: true, config: { ...f.S.data.discovery.config, videoTags: ['AI覆盖'], videoKeywords: ['AI覆盖'], targetGender: 'female' }, unsupported: [] })
  await pending
  assert.deepEqual(plain(f.S.data.discovery.config.videoTags), ['校园生活'])
  assert.deepEqual(plain(f.S.data.discovery.config.videoKeywords), ['猫咪日常', '周末徒步'])
  assert.match(f.advancedDiscoveryView(), /#校园生活/); assert.match(f.advancedDiscoveryView(), /周末徒步/)
})

test('tags-only search saves without fixed topics, escapes input, and rejects oversized lists', async () => {
  const f = fixture(); f.keywords.value = ''; f.tags.value = '#摄影，＃摄影\n宠物'
  await f.ACTIONS['discovery-start']({}, f.element())
  assert.deepEqual(plain(f.calls[0][1].config.videoTags), ['摄影', '宠物']); assert.deepEqual(plain(f.calls[0][1].config.videoKeywords), [])
  f.S.discovery.videoTagsText = '</textarea><script>bad()</script>'
  assert.doesNotMatch(f.advancedDiscoveryView(), /<script>/); assert.match(f.advancedDiscoveryView(), /&lt;script&gt;/)
  assert.doesNotMatch(f.discoveryView(), /data-discovery-topic/)
  f.tags.value = Array.from({ length: 21 }, (_, i) => `标签${i}`).join(',')
  assert.throws(() => f.readDiscoveryConfig(), /最多20个/)
  f.tags.value = 'a'.repeat(81); assert.throws(() => f.readDiscoveryConfig(), /80字/)
})
test('a late requirements preview cannot change a newly selected account', async () => {
  const f = fixture(), wait = deferred(); f.nodes.set('discovery-requirements', f.element('女生'))
  f.discovery.parse = () => wait.promise
  const promise = f.ACTIONS['discovery-parse']({}, f.element()); const old = plain(f.S.data.discovery.config)
  f.S.accounts.active = 'account-b'; wait.resolve({ ok: true, config: { targetGender: 'female' }, unsupported: [] }); await promise
  assert.deepEqual(plain(f.S.data.discovery.config), old)
})
test('female follower filters hide known mismatches and keep unknown candidates pending', () => {
  const f = fixture(); Object.assign(f.S.data.discovery.config, { targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 })
  f.S.data.discovery.candidates[0].publicSignals = { genderText: '男', followerCount: 10 }
  assert.doesNotMatch(f.discoveryListView(), /朋友one/)
  f.S.discovery.filter = 'approved'; f.S.data.discovery.candidates[1].publicSignals = { genderText: '女', followerCount: 150 }
  assert.doesNotMatch(f.discoveryListView(), /朋友two/)
  f.S.data.discovery.candidates[1].publicSignals.followerCount = 149; assert.match(f.discoveryListView(), /朋友two/)
  f.S.discovery.filter = 'all'; assert.match(f.discoveryListView(), /不符合：男性/)
})
test('manual gender verification is submitted as review evidence for the selected candidate only', async () => {
  const f = fixture(), gender = f.element('female'); gender.dataset.candidateId = 'one'; f.nodes.set('discovery-gender-confirmation', gender)
  await f.ACTIONS['discovery-review']({ id: 'one', status: 'APPROVED' }, f.element())
  assert.equal(f.calls[0][1].genderConfirmation, 'female'); assert.equal(f.calls[0][1].accountId, 'account-a')
})

test('discovery page keeps inline batch results with separate history and optional tools', () => {
  const f = fixture(), html = f.discoveryView()
  assert.match(html, /批次寻找/)
  assert.match(html, /id="batch-cards"/)
  assert.match(html, /全部候选/)
  assert.match(html, /备用工具/)
  assert.match(html, /开发工具/)
  assert.match(html, /max="200"/)
  assert.match(html, /max="2000"/)
  assert.doesNotMatch(html, /data-act="discovery-start"|data-act="contact-enqueue"|data-act="auto-run"/)
})

test('candidate nickname, comment, biography, profile URL and notes are escaped', () => {
  const f = fixture(), c = f.S.data.discovery.candidates[0]
  c.nickname = '<img src=x onerror=bad()>'
  c.sources[0].commentText = '<script>alert(1)</script>'
  c.publicProfile = { signature: '<b>02</b>', ipLocation: '广东', city: '杭州' }
  c.profileUrl = '" onclick="bad()'
  f.S.discovery.notes.one = '</textarea><script>bad()</script>'
  f.S.discovery.workspaceTab = 'candidates'
  const html = f.discoveryView()
  assert.doesNotMatch(html, /<script>|<img src=x|<b>02<\/b>|onclick="bad/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /简介原文/)
  assert.match(html, /IP 属地/)
  assert.match(html, /自述城市/)
})

test('candidate filters map persisted statuses and preserve notes across user selection', () => {
  const f = fixture()
  for (const [filter, id] of [['pending', 'one'], ['approved', 'two'], ['deferred', 'three'], ['rejected', 'four']]) {
    f.S.discovery.filter = filter
    assert.match(f.discoveryListView(), new RegExp(`朋友${id}`))
    assert.equal((f.discoveryListView().match(/data-act="discovery-select"/g) || []).length, 1)
  }
  f.S.discovery.notes.one = '我的未保存判断'
  f.ACTIONS['discovery-select']({ id: 'two' })
  f.ACTIONS['discovery-select']({ id: 'one' })
  assert.match(f.nodes.get('discovery-detail').innerHTML, /我的未保存判断/)
})

test('start validates limits and selected keywords, and saves before discovery starts', async () => {
  const f = fixture()
  await f.ACTIONS['discovery-start']({}, f.element())
  assert.deepEqual(f.calls.map(call => call[0]), ['updateConfig', 'start'])
  assert.deepEqual(plain(f.calls[0][1]), { accountId: 'account-a', config: { topics: [{ id: 'social', label: '社交', enabled: true, keywords: ['交友'] }], videoTags: [], videoKeywords: ['交友', '篮球'], maxVideosPerRun: 3, commentsPerVideo: 20,
    targetGender: 'any', followerLimit: 150, profileChecksPerRun: 8, preferLowReplies: false, preferLowerComments: false, includeReplies: false, requireAgeRange: false, ageMin: 20, ageMax: 30, requireFollowerLimit: false, requirementsText: '' } })
  assert.equal(f.calls[1][1].accountId, 'account-a')
})

test('bad limits or absent enabled keywords prevent any search', async () => {
  for (const [id, value] of [['discovery-max-videos', '6'], ['discovery-comments', '31'], ['discovery-max-videos', '1.5']]) {
    const f = fixture(); f.nodes.get(id).value = value
    await f.ACTIONS['discovery-start']({}, f.element())
    assert.equal(f.calls.length, 0)
    assert.equal(f.S.notice.kind, 'err')
  }
  const f = fixture(); f.keywords.value = ''; f.tags.value = ''
  await f.ACTIONS['discovery-start']({}, f.element())
  assert.equal(f.calls.length, 0)
  await f.ACTIONS['discovery-config']({}, f.element())
  assert.equal(f.calls[0][0], 'updateConfig')
})

test('marking approved stores captured account, candidate ID and typed note without following or greeting', async () => {
  const f = fixture(), note = f.nodes.get('discovery-note')
  note.selector = '#discovery-note'; note.dataset.candidateId = 'one'; note.value = '评论看起来有共同兴趣'
  f.listeners.get('input')({ target: note })
  await f.ACTIONS['discovery-review']({ id: 'one', status: 'APPROVED' }, f.element())
  assert.deepEqual(plain(f.calls), [['review', { accountId: 'account-a', id: 'one', status: 'APPROVED', note: note.value }]])
  assert.match(f.S.notice.message, /未关注或发送消息/)
})

test('open and public inspect use discovery API and incorporate updated candidate', async () => {
  const f = fixture()
  await f.ACTIONS['discovery-open']({ id: 'one' }, f.element())
  f.discovery.inspect = async payload => { f.calls.push(['inspect', payload]); return { ok: true, candidate: { ...candidate(), publicProfile: { signature: '公开简介02' } } } }
  await f.ACTIONS['discovery-inspect']({ id: 'one' }, f.element())
  assert.deepEqual(f.calls.map(call => call[0]), ['open', 'inspect'])
  assert.match(f.discoveryDetailView(), /公开简介02/)
})

test('progress updates preserve settings and focused review text and reject other account events', () => {
  const f = fixture(), original = f.S.data.discovery
  f.event({ accountId: 'other', type: 'discovery_progress', payload: { discovery: { candidates: [], runState: { status: 'running' } } } })
  assert.equal(f.S.data.discovery, original)
  const note = f.nodes.get('discovery-note'); note.tagName = 'TEXTAREA'; note.value = '正在打字'
  f.document.activeElement = note
  const detail = f.nodes.get('discovery-detail'); detail.innerHTML = '原表单'; detail.contains = node => node === note
  f.nodes.get('discovery-max-videos').value = '4'; f.keywords.value = '未保存的搜索词'
  f.event({ accountId: 'account-a', type: 'discovery_progress', payload: { discovery: { ...original, runState: { status: 'running', phase: '读取评论', counts: { comments: 8 } } } } })
  f.refreshDynamic()
  assert.equal(detail.innerHTML, '原表单')
  assert.equal(note.value, '正在打字')
  assert.equal(f.nodes.get('discovery-max-videos').value, '4')
  assert.equal(f.keywords.value, '未保存的搜索词')
  assert.match(f.nodes.get('discovery-progress').innerHTML, /读取评论/)
})

test('switching accounts while config saves cancels the subsequent start', async () => {
  const f = fixture(), wait = deferred()
  f.discovery.updateConfig = async () => wait.promise
  const operation = f.ACTIONS['discovery-start']({}, f.element())
  f.S.accounts.active = 'account-b'
  wait.resolve({ ok: true })
  await operation
  assert.equal(f.calls.length, 0)
  assert.equal(f.S.notice, null)
})

test('replaced account-local state cancels stale start even when account ID matches again', async () => {
  const f = fixture(), wait = deferred()
  f.discovery.updateConfig = async () => wait.promise
  const operation = f.ACTIONS['discovery-start']({}, f.element())
  f.S.discovery = { selected: '', filter: 'pending', busy: false, notes: {} }
  wait.resolve({ ok: true })
  await operation
  assert.equal(f.calls.length, 0)
})

test('late results cannot overwrite another account discovery data or show a stale notice', async () => {
  const f = fixture(), wait = deferred()
  f.discovery.inspect = async () => wait.promise
  const operation = f.ACTIONS['discovery-inspect']({ id: 'one' }, f.element())
  const second = { candidates: [], runState: { status: 'idle' } }
  f.S.accounts.active = 'account-b'; f.S.data.discovery = second
  wait.resolve({ ok: true, discovery: { candidates: [candidate('old')] } })
  await operation
  assert.equal(f.S.data.discovery, second)
  assert.equal(f.S.notice, null)
})

test('stop remains callable while the start operation is awaiting the backend', async () => {
  const f = fixture(), wait = deferred()
  f.discovery.start = async payload => { f.calls.push(['start', payload]); return wait.promise }
  const operation = f.ACTIONS['discovery-start']({}, f.element())
  await new Promise(resolve => setImmediate(resolve))
  f.S.data.discovery.runState.status = 'running'
  await f.ACTIONS['discovery-stop']({}, f.element())
  assert.deepEqual(f.calls.map(call => call[0]), ['updateConfig', 'start', 'stop'])
  wait.resolve({ ok: true })
  await operation
})

test('backend failure preserves diagnostics and reports the real escaped error', async () => {
  const f = fixture()
  f.discovery.inspect = async () => ({ ok: false, error: '公开主页身份不一致<script>', discovery: { ...f.S.data.discovery, runState: { status: 'failed', lastError: '主页身份不一致' } } })
  await f.ACTIONS['discovery-inspect']({ id: 'one' }, f.element())
  assert.equal(f.S.notice.message, '公开主页身份不一致<script>')
  assert.equal(f.S.notice.kind, 'err')
  assert.match(f.nodes.get('topbar-notice').outerHTML, /&lt;script&gt;/)
  assert.equal(f.S.data.discovery.runState.status, 'failed')
})

test('发现页默认折叠时不构造旧搜索和诊断面板', () => {
  const f = fixture()
  f.S.discovery.toolsOpen = false
  const html = f.discoveryView()
  assert.match(html, /id="batch-panel"/)
  assert.match(html, /id="batch-cards"/)
  assert.doesNotMatch(html, /id="discovery-advanced"|id="learning-panel"|id="contact-queue"/)
})
