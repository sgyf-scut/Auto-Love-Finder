const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
require('./setup.cjs')
const { migrateLegacy, defaults } = require('../electron/storage.cjs')
const renderer = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/loadAll\(\)\s*$/, '')
function ui(drafts = [], batches = []) {
  const calls = [], handlers = {}
  let state = { ...migrateLegacy({}), pendingDrafts: drafts, expressionBatches: batches }
  const api = { onDouyinEvent() {}, accounts: { onChanged() {} }, automation: { async getState() { return state } },
    douyin: { async sendMessage(...args) { calls.push(['send', ...args]); return { ok: true } }, async resumeExpression(id) { calls.push(['resume', id]); return { ok: true } } } }
  const context = vm.createContext({ window: { desktopApp: api }, document: { addEventListener(type, fn) { handlers[type] = fn }, getElementById() { return { outerHTML: '' } }, querySelector() { return null } }, setInterval() {}, setTimeout() {}, clearTimeout() {}, confirm: () => true, fixture: state })
  vm.runInContext(renderer + '\nS.data=fixture; S.accounts.active="a";queueDynamic=()=>{};globalThis.subject={S,ACTIONS,draftsList,settingsView};', context)
  return { ...context.subject, calls, handlers, api, set(patch) { state = { ...state, ...patch } } }
}
const sticker = { mode: 'STICKER_ONLY', stickerIntent: 'SPEECHLESS', stickerPosition: 'only' }
const combo = { mode: 'TEXT_AND_STICKER', stickerIntent: 'TEASE', stickerPosition: 'after_text' }
test('production enables fixed stickers and legacy migration preserves an explicit off', () => {
  assert.equal(defaults.settings.favoriteStickerEnabled, true)
  assert.equal(migrateLegacy({ settings: { favoriteStickerEnabled: false, unrelated: 123 } }).settings.favoriteStickerEnabled, false)
  assert.equal(migrateLegacy({ settings: { unrelated: 123 } }).settings.unrelated, 123)
})
test('storage persists partial expression items and converts an interrupted sending item to unknown', () => {
  const state = migrateLegacy({ expressionBatches: [{ id: 'batch', name: '虚拟朋友', status: 'sending', expression: combo, items: [{ type: 'text', content: '你是真行', status: 'sent' }, { type: 'sticker', intent: 'TEASE', slot: 1, status: 'sending' }] }] })
  assert.equal(state.expressionBatches[0].items[0].status, 'sent')
  assert.equal(state.expressionBatches[0].items[1].status, 'unknown')
  assert.equal(state.expressionBatches[0].status, 'unknown')
})
test('sticker-only draft has a semantic slot preview and no text editor or sending side effect', () => {
  const fixture = ui([{ id: 's', name: '虚拟朋友', expression: sticker, text: '' }])
  assert.match(fixture.draftsList(), /SPEECHLESS \/ 收藏第7个/)
  assert.match(fixture.draftsList(), /只发送表情/)
  assert.doesNotMatch(fixture.draftsList(), /data-draft-text=/)
  assert.equal(fixture.calls.length, 0)
})
test('text-and-sticker draft shows ordering and derives the slot locally', () => {
  const fixture = ui([{ id: 's', name: '虚拟朋友', expression: { ...combo, slot: 999 }, text: '你是真行' }])
  assert.match(fixture.draftsList(), /先文字，后表情/)
  assert.match(fixture.draftsList(), /TEASE \/ 收藏第1个/)
  assert.doesNotMatch(fixture.draftsList(), /收藏第999个/)
  fixture.S.data.pendingDrafts[0].expression.stickerPosition = 'before_text'
  assert.match(fixture.draftsList(), /先表情，后文字/)
})
test('outdated sticker-only drafts are blocked before IPC', async () => {
  const fixture = ui([{ id: 's', name: '虚拟朋友', expression: sticker, status: 'outdated' }])
  assert.match(fixture.draftsList(), /data-act="draft-send"[^>]+disabled/)
  await fixture.ACTIONS['draft-send']({ id: 's' })
  assert.equal(fixture.calls.length, 0)
})
test('already started drafts cannot start a second batch', async () => {
  const fixture = ui([{ id: 's', name: '虚拟朋友', expression: combo, expressionBatchId: 'batch', text: '已发文字' }])
  await fixture.ACTIONS['draft-send']({ id: 's' })
  assert.equal(fixture.calls.length, 0)
  assert.match(fixture.draftsList(), /已发送的项目不会重复发送/)
})
test('unknown batch hides resume even when a later text item is pending', async () => {
  const fixture = ui([], [{ id: 'b', name: '虚拟朋友', status: 'unknown', items: [{ type: 'sticker', intent: 'TEASE', slot: 1, status: 'unknown' }, { type: 'text', content: '不该发送', status: 'pending' }] }])
  assert.doesNotMatch(fixture.draftsList(), /data-act="expression-resume"/)
  assert.match(fixture.draftsList(), /程序不会再次点击/)
  await fixture.ACTIONS['expression-resume']({ id: 'b' })
  assert.equal(fixture.calls.length, 0)
})
test('partial confirmed failure exposes resume and keeps sent item visible', async () => {
  const fixture = ui([], [{ id: 'b', name: '虚拟朋友', status: 'failed', items: [{ type: 'text', content: '已发文字', status: 'sent' }, { type: 'sticker', intent: 'TEASE', slot: 1, status: 'failed' }] }])
  assert.match(fixture.draftsList(), /继续未发送项/)
  assert.match(fixture.draftsList(), /已发文字 · 已发送/)
  await fixture.ACTIONS['expression-resume']({ id: 'b' })
  assert.deepEqual(fixture.calls, [['resume', 'b']])
})
test('stale batches are not offered recovery and sent batches do not clutter the pending view', () => {
  const fixture = ui([], [{ id: 'a', name: '过期对象', status: 'stale', items: [{ type: 'text', content: '旧', status: 'pending' }] }, { id: 'b', name: '完成对象', status: 'sent', items: [] }])
  assert.doesNotMatch(fixture.draftsList(), /data-act="expression-resume"|完成对象/)
  assert.match(fixture.draftsList(), /已过期/)
})
test('unknown returned by approval refreshes state and reports paused instead of sent', async () => {
  const fixture = ui([{ id: 's', name: '虚拟朋友', expression: sticker, text: '' }])
  fixture.api.douyin.sendMessage = async () => ({ ok: false, status: 'UNKNOWN' })
  await fixture.ACTIONS['draft-send']({ id: 's' })
  assert.match(fixture.S.notice.message, /发送结果未确认/)
  assert.equal(fixture.S.notice.kind, 'err')
})
test('settings show fixed slot contract and preserve text-only off option', () => {
  const html = ui().settingsView()
  assert.match(html, /settings.favoriteStickerEnabled/)
  assert.match(html, /收藏不足 10 个时停止发送/)
  assert.match(html, /关闭（只回复文字）/)
})

const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
function ipc() {
  let state = { pendingDrafts: [{ id: 'd', name: '虚拟朋友', expression: sticker }] }
  const calls = [], handlers = {}, entry = { storage: { get: () => state, update: patch => state = { ...state, ...patch } }, douyin: {
    confirmDraftFresh: async () => state.pendingDrafts[0],
    async approveExpressionDraft(id, text, metadata) { calls.push(['approve', id, text]); await metadata.beforeSubmit(); return { ok: true, status: 'SUCCESS' } },
    async sendMessage() { throw Error('Unexpected text sender') },
    async resumeExpressionBatch(id, metadata) { calls.push(['resume', id]); await metadata.beforeSubmit(); return { ok: true } },
  } }
  const ctx = { ipcMain: { handle: (name, fn) => handlers[name] = fn }, activeAccount: 'a', getActiveServices: () => entry, getDouyinService: () => entry.douyin, Error }
  const start = main.indexOf("ipcMain.handle('douyin:send-message'"), end = main.indexOf('for (const [method, channel]', start)
  vm.runInNewContext(main.slice(start, end), ctx)
  return { ctx, calls, handlers, entry, get: () => state }
}
test('approval uses expression sender for sticker-only and removes only confirmed draft', async () => {
  const fixture = ipc()
  await fixture.handlers['douyin:send-message'](null, { name: '虚拟朋友', text: '', metadata: { draftId: 'd' } })
  assert.deepEqual(fixture.calls, [['approve', 'd', '']])
  assert.equal(fixture.get().pendingDrafts.length, 0)
})
test('text-only planned drafts also use a batch without changing manual message IPC', async () => {
  const fixture = ipc()
  fixture.get().pendingDrafts[0].expression = { mode: 'TEXT_ONLY', stickerIntent: 'NONE' }
  await fixture.handlers['douyin:send-message'](null, { name: '虚拟朋友', text: '文字', metadata: { draftId: 'd' } })
  assert.deepEqual(fixture.calls, [['approve', 'd', '文字']])
})
test('unknown expression approval retains its draft for inspection', async () => {
  const fixture = ipc()
  fixture.entry.douyin.approveExpressionDraft = async () => ({ ok: false, status: 'UNKNOWN' })
  const result = await fixture.handlers['douyin:send-message'](null, { name: '虚拟朋友', text: '', metadata: { draftId: 'd' } })
  assert.equal(result.status, 'UNKNOWN')
  assert.equal(fixture.get().pendingDrafts.length, 1)
})
test('switching accounts while an expression is being approved blocks final submission', async () => {
  const fixture = ipc()
  fixture.entry.douyin.approveExpressionDraft = async (id, text, metadata) => { fixture.ctx.activeAccount = 'b'; await metadata.beforeSubmit() }
  await assert.rejects(fixture.handlers['douyin:send-message'](null, { name: '虚拟朋友', text: '', metadata: { draftId: 'd' } }), /账号已经切换/)
})
test('resume IPC checks the account at each submit boundary', async () => {
  const fixture = ipc()
  fixture.entry.douyin.resumeExpressionBatch = async (id, metadata) => { fixture.ctx.activeAccount = 'b'; await metadata.beforeSubmit() }
  await assert.rejects(fixture.handlers['expression:resume'](null, 'batch'), /账号已经切换/)
})
test('preload resume bridge sends only the batch identity', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8')
  assert.match(bridge, /resumeExpression: \(batchId\) => ipcRenderer.invoke\('expression:resume', batchId\)/)
})
