const { test } = require('node:test')
const assert = require('node:assert/strict')
const { favoriteStickerDom, sendFavoriteSticker, SELECTORS } = require('../electron/sticker-sender.cjs')
function node({ attrs = {}, text = '', image, children = [] } = {}) {
  return { tagName: 'DIV', textContent: text, clicked: 0, disabled: false,
    getBoundingClientRect: () => ({ width: 20, height: 20 }), getAttribute: key => attrs[key] || null,
    contains: other => children.includes(other), click() { this.clicked++ },
    querySelector: selector => selector === 'img' ? image || null : null,
    querySelectorAll: () => children }
}
function domFixture(count = 10) {
  const stickers = Array.from({ length: count }, (_, index) => node({ attrs: { 'data-sticker-id': String(index + 1) }, image: node({ attrs: { src: `s${index + 1}.png` } }) }))
  const add = node({ text: '添加表情', image: node({ attrs: { src: 'add.png' } }) })
  const manage = node({ attrs: { 'aria-label': '管理' }, image: node({ attrs: { src: 'manage.png' } }) })
  const list = node({ children: [add, ...stickers, manage] })
  const tab = node({ text: '收藏', attrs: { 'aria-selected': 'true' } })
  const panel = node()
  panel.querySelectorAll = selector => selector === SELECTORS.favoritesTab ? [tab] : selector === SELECTORS.favorites ? [list] : []
  const toggle = node()
  const doc = { querySelectorAll: selector => selector === SELECTORS.panel ? [panel] : selector === SELECTORS.toggle ? [toggle] : [] }
  const run = (operation, slot = 1, baseline, identity = { verified: true, platformUserId: 'uid' }) => favoriteStickerDom(doc, operation, SELECTORS, slot, { name: '测试联系人', platformUserId: 'uid' }, () => identity, baseline)
  return { stickers, add, manage, doc, toggle, panel, run }
}
for (let slot = 1; slot <= 10; slot++) test(`favorite DOM slot ${slot} excludes add and manage`, () => {
  const f = domFixture(); const baseline = f.run('inspect', slot)
  assert.equal(baseline.count, 10); assert.equal(baseline.src, `s${slot}.png`)
  assert.equal(f.run('click', slot, baseline).attempted, true)
  assert.equal(f.stickers[slot - 1].clicked, 1); assert.equal(f.add.clicked, 0); assert.equal(f.manage.clicked, 0)
})
test('favorite DOM insufficient list never clicks', () => {
  const f = domFixture(9); assert.equal(f.run('click', 1).reason, 'favorite_slots_insufficient')
  assert.equal(f.stickers.reduce((n, row) => n + row.clicked, 0), 0)
})
test('favorite DOM changed contact never clicks', () => {
  const f = domFixture(); assert.equal(f.run('toggle', 1, null, { verified: true, platformUserId: 'other' }).reason, 'contact_changed')
  assert.equal(f.toggle.clicked, 0)
})
test('favorite DOM changed order never clicks', () => {
  const f = domFixture(); assert.equal(f.run('click', 1, { src: 'wrong', stickerId: '1', count: 10 }).reason, 'favorite_order_changed')
  assert.equal(f.stickers[0].clicked, 0)
})
test('favorite DOM loading earlier image keeps later fixed index', () => {
  const f = domFixture(); const first = f.stickers[0].querySelector('img'); first.complete = false; first.naturalWidth = 0
  assert.equal(f.run('inspect', 1).reason, 'target_image_not_loaded')
  assert.equal(f.run('inspect', 2).src, 's2.png'); assert.equal(f.run('inspect', 2).count, 10)
})
test('read-only slot list preserves loading placeholders without clicking or requiring first GIF decoded', () => {
  const f = domFixture(); f.stickers[0].querySelector('img').complete = false
  const result = f.run('list')
  assert.equal(result.ok, true); assert.equal(result.items.length, 10)
  assert.deepEqual(result.items.map(item => item.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(result.items[0].loaded, false); assert.equal(result.items[1].src, 's2.png')
  assert.equal(f.stickers.reduce((n, item) => n + item.clicked, 0), 0)
})
test('favorite DOM target loading image never clicks or shifts forward', () => {
  const f = domFixture(); f.stickers[3].querySelector('img').complete = false
  assert.equal(f.run('click', 4, { src: 's4.png', stickerId: '4', count: 10 }).reason, 'target_image_not_loaded')
  assert.equal(f.stickers.reduce((n, item) => n + item.clicked, 0), 0)
})
test('favorite DOM public tab not confirmed as favorites cannot click', () => {
  const f = domFixture(); const query = f.panel.querySelectorAll
  f.panel.querySelectorAll = selector => selector === SELECTORS.favoritesTab ? [node({ text: '收藏' })] : query(selector)
  assert.equal(f.run('inspect').reason, 'favorites_tab_not_selected')
})
test('favorite DOM missing panel does not fall back to page controls', () => {
  const f = domFixture(); f.doc.querySelectorAll = () => []
  assert.equal(f.run('favorites').reason, 'emoji_panel_missing')
})
function senderFixture({ confirmed = true, clickError = false, wrongIdentity = false } = {}) {
  const calls = []
  const win = { webContents: { async executeJavaScript(script) {
    calls.push(script)
    if (script.startsWith('(function activeChatIdentity')) return { verified: !wrongIdentity, platformUserId: 'uid' }
    if (script.startsWith('(function stickerDeliveryDom')) return { verified: true, copies: confirmed ? 1 : 0 }
    if (script.includes('document,"inspect"')) return { ok: true, count: 10, src: 's1.png', stickerId: '1', copies: 0 }
    if (script.includes('document,"click"')) { if (clickError) throw new Error('renderer closed'); return { ok: true, attempted: true } }
    return { ok: true }
  } } }
  return { calls, options: { win, name: '测试联系人', intent: 'TEASE', sleep: async () => {} } }
}
test('NONE never opens panel', async () => {
  const f = senderFixture(); const result = await sendFavoriteSticker({ ...f.options, intent: 'NONE' })
  assert.equal(result.status, 'FAILED'); assert.equal(f.calls.length, 0)
})
test('prototype key cannot become sticker slot', async () => {
  const f = senderFixture(); assert.equal((await sendFavoriteSticker({ ...f.options, intent: 'constructor' })).status, 'FAILED'); assert.equal(f.calls.length, 0)
})
test('sender verified delivery returns SUCCESS and exactly one sticker click', async () => {
  const f = senderFixture(); const result = await sendFavoriteSticker(f.options)
  assert.equal(result.status, 'SUCCESS'); assert.equal(f.calls.filter(s => s.includes('document,"click"')).length, 1)
})
test('sender waits for the chosen GIF then clicks that same slot once', async () => {
  const f = senderFixture(), execute = f.options.win.webContents.executeJavaScript
  let inspectCalls = 0
  f.options.win.webContents.executeJavaScript = async script => {
    if (script.includes('document,"inspect"') && ++inspectCalls <= 3) return { ok: false, reason: 'target_image_not_loaded', count: 10 }
    return execute(script)
  }
  const result = await sendFavoriteSticker(f.options)
  assert.equal(inspectCalls, 4); assert.equal(result.status, 'SUCCESS'); assert.equal(result.slot, 1)
  assert.equal(f.calls.filter(script => script.includes('document,"click"')).length, 1)
})
test('sender missing delivery returns UNKNOWN without retrying click', async () => {
  const f = senderFixture({ confirmed: false }); const result = await sendFavoriteSticker(f.options)
  assert.equal(result.status, 'UNKNOWN'); assert.equal(f.calls.filter(s => s.includes('document,"click"')).length, 1)
})
test('renderer error after possible click is UNKNOWN', async () => {
  const f = senderFixture({ clickError: true }); assert.equal((await sendFavoriteSticker(f.options)).status, 'UNKNOWN')
})
test('sender unverified identity stops before opening panel', async () => {
  const f = senderFixture({ wrongIdentity: true }); assert.equal((await sendFavoriteSticker(f.options)).status, 'FAILED')
  assert.equal(f.calls.length, 1)
})
test('sender final freshness rejection prevents sticker click', async () => {
  const f = senderFixture(); let guards = 0
  const result = await sendFavoriteSticker({ ...f.options, beforeSubmit: async () => { if (++guards === 3) throw new Error('new incoming') } })
  assert.equal(result.status, 'FAILED'); assert.equal(f.calls.filter(s => s.includes('document,"click"')).length, 0)
})
