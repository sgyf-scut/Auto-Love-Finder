const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { defaults, migrateLegacy, normalizeIncomingBurstSettings } = require('../electron/storage.cjs')
const renderer = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/loadAll\(\)\s*$/, '')

function ui(drafts = [], overrides = {}) {
  const calls = { sent: [], discarded: [], video: [], patches: [], events: [] }
  const handlers = {}
  let backendState = { ...migrateLegacy({}), pendingDrafts: drafts }
  const api = {
    onDouyinEvent() {}, accounts: { onChanged() {} },
    automation: { async getState() { return backendState } },
    douyin: { async sendMessage(name, text, metadata) { calls.sent.push({ name, text, metadata }); backendState = { ...backendState, pendingDrafts: [{ id: 'new', name: '新草稿', text: '后台刚生成' }] } } },
    ai: { async discardDraft(id) { calls.discarded.push(id); backendState = { ...backendState, pendingDrafts: [{ id: 'new', name: '新草稿', text: '后台刚生成' }] }; return { ok: true } } },
    videoOpenings: { async send(payload) { calls.video.push(['send', payload]); return { ok: true } }, async discard(id) { calls.video.push(['discard', id]); return { ok: true } } },
    ...overrides,
  }
  const context = vm.createContext({
    window: { desktopApp: api },
    document: { addEventListener(type, fn) { handlers[type] = fn }, getElementById() { return { outerHTML: '' } }, querySelector() { return null } },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, confirm() { return true },
    fixtureState: backendState, calls,
  })
  vm.runInContext(renderer + '\nS.data = fixtureState; S.accounts.active = "account"; queueDynamic = () => {}; saveState = async patch => { calls.patches.push(patch) }; ACTIONS["event-send"] = async args => calls.events.push(["send", args]); ACTIONS["event-skip"] = async args => calls.events.push(["skip", args]); globalThis.subject = { S, ACTIONS, draftsList, settingsView, incomingBurstSetting };', context)
  return { ...context.subject, calls, handlers, context }
}

test('legacy settings gain enabled 4-second quiet and 15-second max defaults without losing unrelated settings', () => {
  const settings = migrateLegacy({ settings: { refreshInterval: '9', quietStart: '22:30', customSetting: 'kept' } }).settings
  assert.equal(settings.incomingBurstEnabled, true)
  assert.equal(settings.incomingBurstQuietWindowMs, 4000)
  assert.equal(settings.incomingBurstMaxWindowMs, 15000)
  assert.equal(settings.refreshInterval, '9')
  assert.equal(settings.quietStart, '22:30')
  assert.equal(settings.customSetting, 'kept')
})

test('burst normalization preserves manual off and numeric strings, bounding invalid ranges', () => {
  const valid = normalizeIncomingBurstSettings({ incomingBurstEnabled: false, incomingBurstQuietWindowMs: '8000', incomingBurstMaxWindowMs: '20000' })
  assert.equal(valid.incomingBurstEnabled, false)
  assert.equal(valid.incomingBurstQuietWindowMs, 8000)
  assert.equal(valid.incomingBurstMaxWindowMs, 20000)
  const bounds = normalizeIncomingBurstSettings({ incomingBurstQuietWindowMs: 99000, incomingBurstMaxWindowMs: 1000 })
  assert.equal(bounds.incomingBurstQuietWindowMs, 15000)
  assert.equal(bounds.incomingBurstMaxWindowMs, 15000)
  assert.equal(normalizeIncomingBurstSettings({ incomingBurstQuietWindowMs: -9, incomingBurstMaxWindowMs: Infinity }).incomingBurstQuietWindowMs, 1000)
  assert.equal(normalizeIncomingBurstSettings({ incomingBurstMaxWindowMs: 999999 }).incomingBurstMaxWindowMs, 60000)
  for (const value of [undefined, null, '', 'not-a-number', NaN, Infinity]) {
    assert.equal(normalizeIncomingBurstSettings({ incomingBurstQuietWindowMs: value }).incomingBurstQuietWindowMs, 4000)
  }
})

test('settings display seconds and explain rolling waiting and collection delay', () => {
  const fixture = ui()
  fixture.S.data.settings = { ...defaults.settings, incomingBurstQuietWindowMs: 8500, incomingBurstMaxWindowMs: 25000 }
  const html = fixture.settingsView()
  assert.match(html, /等待对方说完/)
  assert.match(html, /data-path="settings.incomingBurstQuietWindowMs" value="8.5"/)
  assert.match(html, /data-path="settings.incomingBurstMaxWindowMs" value="25"/)
  assert.match(html, /每条新消息都会重新计时/)
  assert.match(html, /受轮询间隔影响/)
})

test('seconds input saves numeric milliseconds and switch saves boolean', async () => {
  const { handlers, calls } = ui()
  const element = (setting, value, tagName = 'INPUT') => ({ dataset: { path: `settings.${setting}` }, value, tagName, type: 'number', matches(selector) { return selector === '[data-path]' } })
  await handlers.change({ target: element('incomingBurstQuietWindowMs', '8.5') })
  await handlers.change({ target: element('incomingBurstMaxWindowMs', '23') })
  await handlers.change({ target: element('incomingBurstEnabled', 'off', 'SELECT') })
  assert.equal(calls.patches[0].settings.incomingBurstQuietWindowMs, 8500)
  assert.equal(calls.patches[1].settings.incomingBurstMaxWindowMs, 23000)
  assert.equal(calls.patches[2].settings.incomingBurstEnabled, false)
})

test('invalid seconds and max shorter than quiet do not save', async () => {
  const fixture = ui()
  for (const [key, value] of [['incomingBurstQuietWindowMs', ''], ['incomingBurstQuietWindowMs', '0'], ['incomingBurstQuietWindowMs', '16'], ['incomingBurstMaxWindowMs', '3'], ['incomingBurstMaxWindowMs', '61']]) {
    await fixture.handlers.change({ target: { dataset: { path: `settings.${key}` }, value, type: 'number', tagName: 'INPUT', matches(selector) { return selector === '[data-path]' } } })
  }
  assert.equal(fixture.calls.patches.length, 0)
  assert.equal(fixture.S.notice.kind, 'err')
})

test('outdated draft explains new messages and disables both send and edit', () => {
  const fixture = ui([{ id: 'old', name: '朋友', text: '旧回复', status: 'outdated', outdatedMessageCount: 3 }])
  const html = fixture.draftsList()
  assert.match(html, /对方在该草稿生成后发送了新消息，草稿已过期。新增 3 条消息。/)
  assert.match(html, /data-act="draft-send"[^>]+disabled/)
  assert.match(html, /textarea data-draft-text="old" disabled/)
})

test('programmatic send of outdated draft is blocked before every transport', async () => {
  const fixture = ui([{ id: 'old', name: '朋友', text: '旧回复', status: 'outdated' }])
  await fixture.ACTIONS['draft-send']({ id: 'old' }, null)
  assert.equal(fixture.calls.sent.length, 0)
  assert.equal(fixture.calls.video.length, 0)
  assert.match(fixture.S.notice.message, /草稿已过期/)
})

test('ordinary draft sends ID metadata and fetches newest state without overwriting new drafts', async () => {
  const fixture = ui([{ id: 'draft', name: '朋友', text: '好的' }])
  await fixture.ACTIONS['draft-send']({ id: 'draft' }, null)
  assert.equal(fixture.calls.sent[0].metadata.draftId, 'draft')
  assert.equal(fixture.calls.sent[0].text, '好的')
  assert.equal(fixture.S.data.pendingDrafts[0].id, 'new')
  assert.equal(fixture.calls.patches.length, 0)
})

test('ordinary discard uses atomic ID endpoint and keeps newly generated draft', async () => {
  const fixture = ui([{ id: 'draft', name: '朋友', text: '好的' }])
  await fixture.ACTIONS['draft-discard']({ id: 'draft' }, null)
  assert.deepEqual(fixture.calls.discarded, ['draft'])
  assert.equal(fixture.S.data.pendingDrafts[0].id, 'new')
  assert.equal(fixture.calls.patches.length, 0)
})

test('event drafts retain their own card and lifecycle endpoints', async () => {
  const fixture = ui([{ id: 'evt', source: 'event_followup', name: '朋友', text: '面试如何' }])
  assert.match(fixture.draftsList(), /data-act="event-send"/)
  assert.doesNotMatch(fixture.draftsList(), /data-act="draft-send"/)
  await fixture.ACTIONS['draft-send']({ id: 'evt' }, null)
  await fixture.ACTIONS['draft-discard']({ id: 'evt' }, null)
  assert.equal(fixture.calls.events[0][0], 'send')
  assert.equal(fixture.calls.events[1][0], 'skip')
  assert.equal(fixture.calls.sent.length + fixture.calls.discarded.length, 0)
})

test('video opening send and discard retain independent endpoints', async () => {
  const fixture = ui([{ id: 'video', name: '朋友', text: '看看这个', videoOpeningId: 'opening' }])
  await fixture.ACTIONS['draft-send']({ id: 'video' }, null)
  await fixture.ACTIONS['draft-discard']({ id: 'video' }, null)
  assert.equal(fixture.calls.video[0][0], 'send')
  assert.equal(fixture.calls.video[0][1].id, 'opening')
  assert.equal(fixture.calls.video[1][0], 'discard')
  assert.equal(fixture.calls.sent.length + fixture.calls.discarded.length, 0)
  assert.equal(fixture.calls.patches.length, 0)
})

test('preload preserves optional sending metadata and exports atomic draft discard', async () => {
  const calls = []
  let bridge
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8')
  vm.runInNewContext(source, { require(name) {
    assert.equal(name, 'electron')
    return { contextBridge: { exposeInMainWorld(_key, value) { bridge = value } }, ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve() } } }
  } })
  await bridge.douyin.sendMessage('朋友', '你好', { draftId: 'id' })
  assert.equal(calls[0][0], 'douyin:send-message')
  assert.equal(calls[0][1].metadata.draftId, 'id')
  await bridge.ai.discardDraft('id')
  assert.deepEqual(calls[1], ['drafts:discard', 'id'])
})
