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
  discovery.syncIntentPool = async () => { calls.push(['syncIntentPool']); return { ok: true } }
  const desktopApp = { discovery, onDouyinEvent: callback => { onEvent = callback }, accounts: { onChanged: callback => { onAccountChanged = callback } } }
  const document = {
    activeElement: null, documentElement: { dataset: {} }, getElementById: id => nodes.get(id) || null,
    querySelectorAll: selector => selector === '[data-discovery-topic]' ? [enabled] : selector === '[data-discovery-keywords]' ? [keywords] : [],
    querySelector: () => null, addEventListener: (event, callback) => listeners.set(event, callback),
  }
  const context = vm.createContext({ window: { desktopApp, matchMedia: () => ({ matches: false }) }, document, console, setInterval() {}, setTimeout() { return 1 }, clearTimeout() {} })
  const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/\nloadAll\(\)\s*$/, '\n')
  vm.runInContext(`${source}\nglobalThis.ui = { S, ACTIONS, discoveryView, discoveryDetailView, discoveryListView, readDiscoveryConfig, refreshDynamic, batchState, readBatchConfig, discoveryWorkspaceTab, workspaceCandidateListView, workspaceToolsView, workspaceDeveloperView };`, context)
  const ui = context.ui
  ui.S.accounts = { active: 'account-a', accounts: [] }
  ui.S.section = 'discovery'; ui.S.data = state; ui.S.discovery.selected = 'one'; ui.S.discovery.toolsOpen = true
  return { ...ui, desktopApp, nodes, listeners, calls, discovery, enabled, keywords, tags, element, event: event => onEvent(event), document, onAccountChanged: () => onAccountChanged() }
}
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function workspaceFixture() {
  const f = fixture()
  f.S.discovery.workspaceTab = 'find'
  f.S.data.selfProfile = {}; f.S.data.selfPersona = {}; f.S.data.settings = {}
  f.S.library.data = { stats: {}, videos: [], comments: [], favorites: { folderName: 'fixture' }, autoContact: {} }
  f.S.library.autoContact = { mode: 'training', config: {} }
  f.desktopApp.automation = { getState: async () => { f.calls.push(['getState']); return f.S.data } }
  f.desktopApp.library = {
    get: async () => { f.calls.push(['getLibrary']); return { ok: true, library: f.S.library.data, scheduler: {} } },
    getAutoContact: async () => ({ ok: true, autoContact: f.S.library.autoContact }),
    getAutoAudit: async () => ({ ok: true, audit: {} }),
    getBenchmark: async () => ({ ok: true, benchmark: {} }),
    classify: async () => { f.calls.push(['classify']); return { ok: true, library: f.S.library.data } },
    candidates: async () => { f.calls.push(['candidates']); return { ok: true, added: 2, library: f.S.library.data } },
  }
  f.desktopApp.learning = { get: async () => ({ ok: true, learning: { stats: {}, pending: [], annotated: [], versions: [] } }) }
  for (const [id, value] of Object.entries({ 'batch-keywords': '保留关键词', 'batch-tags': '保留标签', 'batch-target': '5', 'batch-max-videos': '6', 'batch-max-comments': '60', 'batch-max-minutes': '20', 'batch-max-ai': '0', 'batch-gender': 'any', 'batch-age-required': 'off', 'batch-age-min': '18', 'batch-age-max': '45', 'batch-ip-required': 'on', 'batch-ip-values': '广东', 'batch-followers-required': 'off', 'batch-followers': '1000', 'batch-replies-required': 'on', 'batch-replies': '0', 'batch-requirements': '女生，粉丝少于150' })) f.nodes.set(id, f.element(value))
  f.nodes.set('batch-favorites', { checked: false })
  return f
}
const parseResult = (over = {}) => ({ ok: true, config: { targetGender: 'female', requireFollowerLimit: true, followerLimit: 150, requireAgeRange: true, ageMin: 22, ageMax: 30, ...over }, unsupported: [] })

test('default page exposes one batch start and five workspace destinations', () => {
  const f = workspaceFixture(), html = f.discoveryView()
  assert.equal((html.match(/data-act="batch-start"/g) || []).length, 1)
  for (const label of ['寻找设置', '人工标注', '全部候选', '备用工具', '开发工具']) assert.ok(html.includes(label))
  for (const action of ['discovery-start', 'auto-run', 'auto-training-run', 'scheduler-run-now', 'contact-run']) assert.ok(!html.includes(`data-act="${action}"`))
  assert.ok(html.includes('batch-requirements')); assert.ok(!html.includes('目标人群'))
})
for (const tab of ['find', 'labels', 'candidates', 'tools', 'developer']) test(`${tab} view has no duplicate element IDs or hidden execution entrances`, () => {
  const f = workspaceFixture(); f.S.discovery.workspaceTab = tab
  const html = f.discoveryView(), ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
  assert.equal(new Set(ids).size, ids.length)
  for (const action of ['discovery-start', 'auto-run', 'auto-follow-now', 'scheduler-run-now', 'pipeline-run', 'contact-run', 'contact-enqueue']) assert.ok(!html.includes(`data-act="${action}"`), action)
})
test('tools contain one video collector, fallback import and material viewer', () => {
  const f = workspaceFixture(), html = f.workspaceToolsView()
  assert.equal((html.match(/id="library-collect-input"/g) || []).length, 1)
  assert.ok(!html.includes('id="discover-link"')); assert.ok(!html.includes('id="learning-panel"'))
  assert.ok(html.includes('library-file')); assert.ok(html.includes('workspace-analyze-imports')); assert.ok(html.includes('library-body'))
})
test('annotation owns learning while developer tools retain evaluation and legacy stop controls', () => {
  const f = workspaceFixture(), html = f.workspaceDeveloperView()
  assert.equal((html.match(/id="learning-panel"/g) || []).length, 0)
  f.S.discovery.workspaceTab = 'labels'
  assert.equal((f.discoveryView().match(/id="learning-panel"/g) || []).length, 1)
  assert.ok(html.includes('benchmark-panel')); assert.ok(html.includes('workspace-stop-scheduler')); assert.ok(html.includes('workspace-stop-contact'))
  assert.ok(!html.includes('data-act="scheduler-toggle-sync"')); assert.ok(!html.includes('data-act="contact-save"'))
})
test('natural-language preview updates batch filters while retaining search, location and zero limits', async () => {
  const f = workspaceFixture(); f.discovery.parse = async () => { f.calls.push(['parse']); return parseResult() }
  await f.ACTIONS['workspace-parse']({}, f.element())
  const config = plain(f.batchState().formConfig)
  assert.equal(config.filters.gender, 'female'); assert.equal(config.filters.followerLimit, 150); assert.equal(config.filters.ageMin, 22)
  assert.deepEqual(config.sources.keywords, ['保留关键词']); assert.deepEqual(config.sources.tags, ['保留标签'])
  assert.deepEqual(config.filters.ipValues, ['广东']); assert.equal(config.filters.replyLimit, 0); assert.equal(config.budgets.maxAiCalls, 0)
  assert.deepEqual(f.calls.map(c => c[0]), ['parse']); assert.equal(f.batchState().data, null)
})
for (const flag of ['preferLowerComments', 'preferLowReplies', 'includeReplies']) test(`unsupported ${flag} is visible and does not partly change batch filters`, async () => {
  const f = workspaceFixture(); f.discovery.parse = async () => parseResult({ [flag]: true })
  await f.ACTIONS['workspace-parse']({}, f.element())
  assert.equal(f.batchState().requirementsError, true); assert.equal(f.batchState().formConfig.filters.gender, 'any')
  assert.match(f.batchState().requirementsNotice, /没有应用条件/)
})
test('explicit unsupported parser conditions are not silently discarded', async () => {
  const f = workspaceFixture(); f.discovery.parse = async () => ({ ...parseResult(), unsupported: ['地区需手动填写'] })
  await f.ACTIONS['workspace-parse']({}, f.element()); assert.equal(f.batchState().requirementsError, true)
  assert.match(f.batchState().requirementsNotice, /地区需手动填写/); assert.equal(f.batchState().formConfig.filters.gender, 'any')
})
test('late AI preview does not contaminate another account', async () => {
  const f = workspaceFixture(), wait = deferred(); f.discovery.parse = () => wait.promise
  const run = f.ACTIONS['workspace-parse']({}, f.element())
  f.S.accounts.active = 'other'; f.S.discovery = { notes: {} }; wait.resolve(parseResult()); await run
  assert.equal(f.S.discovery.batch, undefined)
})
test('typing during parsing retains the latest form rather than applying stale AI output', async () => {
  const f = workspaceFixture(), wait = deferred(); f.discovery.parse = () => wait.promise
  const run = f.ACTIONS['workspace-parse']({}, f.element()); f.nodes.get('batch-keywords').value = '新关键词'; wait.resolve(parseResult()); await run
  assert.equal(f.batchState().formConfig.sources.keywords[0], '新关键词'); assert.equal(f.batchState().formConfig.filters.gender, 'any')
  assert.match(f.batchState().requirementsNotice, /解析期间/)
})
test('batch start cannot race an in-flight parser', async () => {
  const f = workspaceFixture(); f.batchState().parsing = true
  await f.ACTIONS['batch-start']({}, f.element()); assert.deepEqual(f.calls, [])
})
test('history lists cross-batch candidates without a twelve-person cap and supports pagination', () => {
  const f = workspaceFixture(); f.S.data.discovery.candidates = Array.from({ length: 45 }, (_, i) => candidate(String(i)))
  let html = f.workspaceCandidateListView(); assert.match(html, /匹配 45 人/); assert.equal((html.match(/data-act="workspace-select"/g) || []).length, 30)
  f.S.discovery.historyPage = 1; html = f.workspaceCandidateListView(); assert.equal((html.match(/data-act="workspace-select"/g) || []).length, 15)
  f.S.discovery.historyPage = 100; f.workspaceCandidateListView(); assert.equal(f.S.discovery.historyPage, 1)
})
test('history detail keeps manual review but never enqueues the old contact engine', () => {
  const f = workspaceFixture(); f.S.discovery.workspaceTab = 'candidates'
  const html = f.discoveryView(); assert.ok(html.includes('data-act="discovery-review"'))
  assert.ok(!html.includes('data-act="contact-enqueue"')); assert.ok(!html.includes('data-act="contact-resume"'))
})
test('history navigation synchronizes saved intent records locally without any contact action', async () => {
  const f = workspaceFixture(), before = plain(f.S.data.discovery.candidates)
  await f.ACTIONS['workspace-tab']({ tab: 'candidates' }); assert.deepEqual(f.calls.map(c => c[0]), ['syncIntentPool','getState'])
  assert.deepEqual(plain(f.S.data.discovery.candidates), before)
})
test('manual import processing classifies before creating candidates without a contact action', async () => {
  const f = workspaceFixture(); await f.ACTIONS['workspace-analyze-imports']({}, f.element())
  assert.ok(f.calls.findIndex(c => c[0] === 'classify') < f.calls.findIndex(c => c[0] === 'candidates'))
  assert.ok(!f.calls.some(c => /send|follow|start|run/i.test(c[0])))
})
test('reading the materials library cannot construct a scheduler and boot cannot start the old contact timer', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
  const get = main.slice(main.indexOf("ipcMain.handle('library:get'"), main.indexOf("ipcMain.handle('library:clear'"))
  assert.ok(!get.includes('ensureDiscoveryScheduler(')); assert.ok(get.includes('pipelineState().scheduler'))
  const start = main.slice(main.indexOf('function startContactService('), main.indexOf('function stopContactService('))
  assert.ok(!start.includes('contactEngine.start()')); assert.ok(start.includes('new ContactEngine('))
  const boot = main.slice(main.indexOf('bootDiscoveryScheduler = () =>'), main.indexOf("ipcMain.handle('library:scheduler-get'"))
  assert.ok(!boot.includes('scheduler.bootstrap(')); assert.ok(!boot.includes('scheduler.start(')); assert.ok(boot.includes('pipelineState().scheduler'))
})
test('switching accounts during import analysis stops candidate creation for the new account', async () => {
  const f = workspaceFixture(), wait = deferred()
  f.desktopApp.library.classify = async () => { f.calls.push(['classify']); return wait.promise }
  const run = f.ACTIONS['workspace-analyze-imports']({}, f.element())
  f.S.accounts.active = 'other'; wait.resolve({ ok: true }); await run
  assert.deepEqual(f.calls.map(c => c[0]), ['classify'])
})
test('history preserves uncertain receipt handling even if an older result lacks needsReview', () => {
  const f = workspaceFixture(); f.S.discovery.workspaceTab = 'candidates'
  f.S.data.discovery.candidates[0].review.realContact = { outcome: 'UNCERTAIN', messageStatus: 'unknown', followStatus: 'pending' }
  const html = f.discoveryView()
  assert.match(html, /发送结果待核实/); assert.match(html, /确认已发出/); assert.match(html, /确认未发出/)
  assert.doesNotMatch(html, /data-act="contact-retry"/)
})
test('legacy boot reads saved pipeline scheduler flags without starting or mutating them', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
  const start = main.indexOf('bootDiscoveryScheduler = () =>'), end = main.indexOf("ipcMain.handle('library:scheduler-get'", start)
  const saved = { autoSync: true, autoAnalyze: true, status: 'waiting', budget: { modelCalls: 7 } }
  const before = plain(saved)
  const ctx = vm.createContext({ activeAccount: 'fixture', libraryStore: () => ({ pipelineState: () => ({ scheduler: saved }), schedulerState: () => { throw Error('wrong scheduler namespace') } }) })
  vm.runInContext(main.slice(start, end), ctx)
  const result = ctx.bootDiscoveryScheduler()
  assert.equal(result.state, saved); assert.deepEqual(saved, before)
})


test('batch results are inline and a stale results tab falls back to the main page', () => {
  const f = workspaceFixture()
  for (const tab of ['find', 'results']) {
    f.S.discovery.workspaceTab = tab
    const html = f.discoveryView()
    assert.equal(f.discoveryWorkspaceTab(), 'find')
    assert.equal((html.match(/id="batch-cards"/g) || []).length, 1)
    assert.equal((html.match(/role="tab"/g) || []).length, 5)
    assert.ok(html.indexOf('id="batch-panel"') < html.indexOf('id="batch-cards"'))
    assert.ok(html.indexOf('id="batch-cards"') < html.indexOf('id="auto-mode-panel"'))
    assert.doesNotMatch(html, /&quot;tab&quot;:&quot;results&quot;/)
  }
})
