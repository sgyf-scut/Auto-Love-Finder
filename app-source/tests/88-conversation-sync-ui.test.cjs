const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function fixture() {
  const nodes = new Map(), calls = [], timers = []
  const element = value => ({ value: value || '', innerHTML: '', outerHTML: '', disabled: false, scrollTop: 0, contains: () => false })
  for (const id of ['app', 'topbar-notice', 'contact-conversation-sync', 'conversation-sync-overview', 'manual-text', 'profile-call']) nodes.set(id, element())
  nodes.get('manual-text').value = '未发送消息'; nodes.get('profile-call').value = '未保存称呼'
  let event, accountChanged
  const desktopApp = { douyin: { refreshConversationSync: async payload => { calls.push(payload); return { ok: true, conversationSync: { accountId: 'a', records: [{ contactId: 'c1', status: 'READY' }] } } } },
    onDouyinEvent(callback) { event = callback }, accounts: { onChanged(callback) { accountChanged = callback }, list: async () => ({ active: 'b', accounts: [] }) }, automation: { getState: async () => ({ contacts: [], settings: {}, automation: {}, appearance: {} }) } }
  const document = { activeElement: null, documentElement: { dataset: {} }, getElementById: id => nodes.get(id) || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} }
  const context = vm.createContext({ window: { desktopApp, matchMedia: () => ({ matches: false }) }, document, console, setInterval(fn, time) { timers.push(time) }, setTimeout() { return 1 }, clearTimeout() {} })
  const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/\nloadAll\(\)\s*$/, '\n')
  vm.runInContext(`${source}\nglobalThis.ui = { S, ACTIONS, conversationSyncView, conversationSyncOverview, contactDetail, refreshDynamic };`, context)
  const ui = context.ui
  ui.S.accounts = { active: 'a', accounts: [] }; ui.S.section = 'chat'; ui.S.selected = '同名联系人'
  ui.S.data = { contacts: [{ id: 'c1', name: '同名联系人', profile: {}, learning: {} }], automation: {}, settings: {}, appearance: {}, conversationSync: { version: 1, accounts: [{ accountId: 'a', records: [] }, { accountId: 'b', records: [{ contactId: 'c1', status: 'READY' }] }] } }
  return { ...ui, nodes, calls, timers, desktopApp, element, event: value => event(value), accountChanged: () => accountChanged() }
}
test('contact panel requires exact current-account contact binding and is independent of relationship journey', () => {
  const f = fixture(), contact = f.S.data.contacts[0]
  f.S.data.conversationSync.accounts[0].records = [{ contactId: 'other', name: contact.name, status: 'READY' }]
  assert.doesNotMatch(f.conversationSyncView(contact), />可自动聊天</)
  assert.match(f.conversationSyncView(contact), /身份待核验/)
  const html = f.contactDetail(contact)
  assert.match(html, /id="contact-conversation-sync"/)
  assert.doesNotMatch(html, /id="contact-relationship-journey"/)
  f.S.data.conversationSync.accounts[0].records = [{ contactIds: ['c1'], status: 'READY' }]
  assert.match(f.conversationSyncView(contact), />可自动聊天</)
})
test('all seven sync states, retry timestamps, missing values and escaped reasons are displayed', () => {
  const f = fixture(), labels = { WAITING_CONVERSATION: '等待会话出现', DISCOVERED: '已发现会话', IDENTITY_VERIFIED: '身份已核验', READY: '可自动聊天', TEMP_UNAVAILABLE: '暂时不可用', IDENTITY_PENDING: '身份待核验', NEEDS_REVIEW: '需要人工核对' }
  for (const [status, label] of Object.entries(labels)) {
    f.S.data.conversationSync.accounts[0].records = [{ contactId: 'c1', status, reason: '<img src=x onerror=evil()>', nextRetryAt: 1791799200000, lastObservedAt: '2026-10-10T12:00:00Z', lastVerifiedAt: null }]
    const html = f.conversationSyncView(f.S.data.contacts[0])
    assert.match(html, new RegExp(label)); assert.match(html, /下次重试：/); assert.match(html, /最近核验：暂无/)
    assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|Invalid Date/)
  }
  f.S.data.conversationSync.accounts[0].records.push({ contactId: 'c1', status: 'READY' })
  assert.match(f.conversationSyncView(f.S.data.contacts[0]), /需要人工核对/)
})
test('sync reasons explain identity failures in Chinese while preserving original actionable errors and legacy chat compatibility', () => {
  const f = fixture(), contact = f.S.data.contacts[0]
  const reasons = { identity_unverified: '尚未核验会话身份', identity_pending: '会话身份等待核验', identity_verified: '会话身份已核验',
    new_evidence: '收到新证据，等待同步核验', manual_window_visible: '抖音窗口正在由你操作，隐藏窗口后继续核验', identity_unknown: '尚未取得可靠的平台用户 ID',
    platform_identity_conflict: '平台用户 ID 与预期身份不一致，需要人工核对', same_name_different_id: '发现同名但平台用户 ID 不同的联系人，需要人工核对',
    retry: '等待下次重试', conversation_unavailable: '会话暂时无法定位，等待重试' }
  for (const [reason, expected] of Object.entries(reasons)) {
    f.S.data.conversationSync.accounts[0].records = [{ contactId: 'c1', status: 'IDENTITY_PENDING', reason }]
    const html = f.conversationSyncView(contact)
    assert.ok(html.includes(expected), reason); assert.ok(!html.includes(`>${reason}</p>`), reason)
  }
  f.S.data.conversationSync.accounts[0].records[0].reason = '无法定位会话：请先完成抖音登录 <核对>'
  const html = f.conversationSyncView(contact)
  assert.match(html, /无法定位会话：请先完成抖音登录 &lt;核对&gt;/)
  assert.match(html, /旧联系人保留兼容聊天定位/); assert.match(html, /新人自动接管需核验身份/)
  assert.match(html, /仍受 AI 开关/); assert.match(html, /发送额度限制/)
  assert.doesNotMatch(html, />可自动聊天</)
})
test('refresh replaces only account sync data and preserves edited fields, manual text and other account data', async () => {
  const f = fixture(), initial = f.S.data, other = plain(initial.conversationSync.accounts[1])
  await f.ACTIONS['conversation-sync-refresh']({ accountId: 'a', contactId: 'c1' }, f.element())
  assert.deepEqual(plain(f.calls), [{ accountId: 'a', contactId: 'c1' }]); assert.equal(f.S.data, initial)
  assert.deepEqual(plain(f.S.data.conversationSync.accounts.find(item => item.accountId === 'b')), other)
  assert.equal(f.nodes.get('manual-text').value, '未发送消息'); assert.equal(f.nodes.get('profile-call').value, '未保存称呼')
  assert.equal(f.nodes.get('app').innerHTML, ''); assert.match(f.nodes.get('contact-conversation-sync').innerHTML, /可自动聊天/)
})
test('full refresh state is reduced to current-account sync subtree', async () => {
  const f = fixture(), settings = f.S.data.settings
  f.desktopApp.douyin.refreshConversationSync = async () => ({ ok: true, state: { settings: { changed: true }, contacts: [], conversationSync: { accounts: [{ accountId: 'a', records: [{ contactId: 'c1', status: 'DISCOVERED' }] }] } } })
  await f.ACTIONS['conversation-sync-refresh']({ accountId: 'a', contactId: 'c1' }, f.element())
  assert.equal(f.S.data.settings, settings); assert.equal(f.S.data.contacts.length, 1)
  assert.match(f.conversationSyncView(f.S.data.contacts[0]), /已发现会话/)
})
test('account-scoped progress patches only sync panel and rejects mismatched nested accounts', () => {
  const f = fixture(), initial = plain(f.S.data.conversationSync)
  f.event({ type: 'conversation_sync', accountId: 'b', payload: { conversationSync: { accountId: 'b', records: [] } } })
  f.event({ type: 'conversation_sync', accountId: 'a', payload: { accountId: 'b', conversationSync: { accountId: 'a', records: [] } } })
  f.event({ type: 'conversation_sync', accountId: 'a', payload: { conversationSync: { accountId: 'b', records: [] } } })
  assert.deepEqual(plain(f.S.data.conversationSync), initial)
  f.event({ type: 'conversation_sync', accountId: 'a', payload: { accountId: 'a', conversationSync: { accountId: 'a', records: [{ contactId: 'c1', status: 'IDENTITY_PENDING' }] } } })
  f.refreshDynamic(); assert.match(f.nodes.get('contact-conversation-sync').innerHTML, /身份待核验/)
  assert.equal(f.nodes.get('app').innerHTML, ''); assert.equal(f.nodes.get('manual-text').value, '未发送消息')
})
test('duplicate requests, stale contact actions and failed refresh never report READY', async () => {
  const f = fixture(), wait = deferred()
  f.desktopApp.douyin.refreshConversationSync = payload => { f.calls.push(payload); return wait.promise }
  const pending = f.ACTIONS['conversation-sync-refresh']({ accountId: 'a', contactId: 'c1' }, f.element())
  await f.ACTIONS['conversation-sync-refresh']({ accountId: 'a', contactId: 'c1' }, f.element())
  await f.ACTIONS['conversation-sync-refresh']({ accountId: 'a', contactId: 'missing' }, f.element())
  assert.equal(f.calls.length, 1)
  wait.resolve({ ok: false, error: '无法核验身份' }); await pending
  assert.equal(f.S.notice.kind, 'err'); assert.match(f.S.notice.message, /无法核验身份/)
  assert.equal(f.S.conversationSyncUi.busyContactId, '')
  assert.doesNotMatch(f.conversationSyncView(f.S.data.contacts[0]), />可自动聊天</)
})
test('late refresh success and error after account change cannot alter new state or notices', async () => {
  for (const fail of [false, true]) {
    const f = fixture(), wait = deferred()
    f.desktopApp.douyin.refreshConversationSync = () => wait.promise
    const pending = f.ACTIONS['conversation-sync-refresh']({ accountId: 'a', contactId: 'c1' }, f.element())
    await f.accountChanged(); const latest = f.S.data
    if (fail) wait.reject(new Error('旧账号异常'))
    else wait.resolve({ ok: true, conversationSync: { accountId: 'a', records: [{ contactId: 'c1', status: 'READY' }] } })
    await pending; assert.equal(f.S.data, latest); assert.equal(f.S.notice, null)
  }
})
test('overview reuses dynamic refresh and existing timer without installing new polling', () => {
  const f = fixture(); assert.deepEqual(f.timers, [30000]); assert.match(f.conversationSyncOverview(), /每10分钟补齐会话/)
  f.S.section = 'settings'; f.refreshDynamic(); assert.match(f.nodes.get('conversation-sync-overview').innerHTML, /现有轮询轻量观察/)
})
test('preload bridge forwards explicit read and refresh payloads to the paired IPC channels', async () => {
  let api; const calls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld(name, value) { api = value } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }) } } }) })
  const payload = { accountId: 'a', contactId: 'c1' }; await api.douyin.getConversationSync(payload); await api.douyin.refreshConversationSync(payload)
  assert.deepEqual(calls, [['conversation-sync:get-state', payload], ['conversation-sync:refresh', payload]])
})
