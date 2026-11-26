const { executePageScript } = require('./discovery/page-readiness.cjs')
const { SLOT_MAP } = require('./expression-batch.cjs')
const { activeChatIdentity } = require('./friendship.cjs')
const SELECTORS = Object.freeze({
  toggle: '.messageMsgInputiconAction, [data-e2e="chat-emoji-button"], [data-e2e="emoji-button"], [aria-label="表情"], [title="表情"], [class*="messageMsgInput"] [class*="emoji" i]',
  panel: '.componentsemojiim-saas-modal, [data-e2e="emoji-panel"], [class*="emojiPanel" i], [class*="stickerPanel" i], [class*="emoticonPanel" i]',
  favoritesTab: '[data-e2e="favorite-stickers-tab"], [aria-label="收藏表情"], [title="收藏表情"], [data-tab="favorite"]',
  favorites: '.componentsemojitabPanel, [data-e2e="favorite-stickers"], [class*="favorite" i], [class*="collect" i]',
  item: '.emojiEmojiItememojiItem, [data-e2e="favorite-sticker"], [data-sticker-id], [class*="stickerItem" i], [class*="emojiItem" i]',
  outgoing: '[class*="MessageBoxContentisFromMe"], [data-e2e="message-item"][data-from-me="true"]',
})
function favoriteStickerDom(doc, operation, selectors, slot, expected, identityFn, baseline) {
  const visible = node => { const r = node?.getBoundingClientRect?.(); return r && r.width > 4 && r.height > 4 && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' }
  const unique = nodes => nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)))
  const identity = identityFn(expected.name, expected.platformUserId)
  if (!identity?.verified || identity.platformUserId !== expected.platformUserId) return { ok: false, reason: 'contact_changed' }
  const all = (scope, selector) => [...scope.querySelectorAll(selector)].filter(visible)
  const click = node => {
    if (typeof node.click === 'function') node.click()
    else node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }))
  }
  if (operation === 'toggle') {
    const controls = unique(all(doc, selectors.toggle))
    if (controls.length !== 1) return { ok: false, reason: 'emoji_toggle_ambiguous' }
    if (all(doc, selectors.panel).length === 1) return { ok: true, alreadyOpen: true }
    click(controls[0]); return { ok: true }
  }
  const panels = unique(all(doc, selectors.panel))
  if (panels.length !== 1) return { ok: false, reason: 'emoji_panel_missing' }
  const panel = panels[0]
  const favoriteTabs = () => {
    let tabs = unique(all(panel, selectors.favoritesTab))
    if (!tabs.length) tabs = all(panel, '.emojiEmojisModalTabsubTab').filter(node => [...node.querySelectorAll('svg path')].some(path => (path.getAttribute('d') || '').startsWith('m12.52 5.65')))
    if (!tabs.length) tabs = unique(all(panel, 'button,[role="tab"],[title]')).filter(node => /^(收藏|收藏表情|我的收藏)$/.test((node.textContent || node.getAttribute('title') || '').trim()))
    return tabs
  }
  if (operation === 'favorites') {
    const tabs = favoriteTabs()
    if (tabs.length !== 1) return { ok: false, reason: 'favorites_tab_ambiguous' }
    click(tabs[0]); return { ok: true }
  }
  const selectedTabs = favoriteTabs()
  if (selectedTabs.length !== 1 || !(selectedTabs[0].getAttribute('aria-selected') === 'true' || /emojiEmojisModalTabactiveDark/.test(selectedTabs[0].getAttribute('class') || ''))) return { ok: false, reason: 'favorites_tab_not_selected' }
  const lists = unique(all(panel, selectors.favorites))
  if (lists.length !== 1) return { ok: false, reason: 'favorites_list_missing' }
  let nodes = unique(all(lists[0], selectors.item)).filter(node => {
    const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent].filter(Boolean).join(' ')
    if (/添加|管理|删除|编辑|上传|add|manage|delete|upload/i.test(label)) return false
    const image = node.querySelector('img') || (node.tagName === 'IMG' ? node : null)
    // Loading images keep their original slot. Never compact the list around
    // placeholders or the fixed 1..10 order would shift to another sticker.
    return Boolean(image)
  })
  if (nodes.length < 10 || !nodes[slot - 1]) return { ok: false, reason: 'favorite_slots_insufficient', count: nodes.length }
  if (operation === 'list') return { ok: true, count: nodes.length, items: nodes.slice(0, 10).map((node, index) => {
    const image = node.querySelector('img') || node
    return { slot: index + 1, src: image.getAttribute('src') || image.getAttribute('data-src') || '', loaded: image.complete !== false && (typeof image.naturalWidth !== 'number' || image.naturalWidth > 0) }
  }) }
  const target = nodes[slot - 1]
  const image = target.querySelector('img') || target
  const src = image.getAttribute('src') || image.getAttribute('data-src')
  if (!src || src.startsWith('data:') || image.complete === false || (typeof image.naturalWidth === 'number' && image.naturalWidth === 0)) return { ok: false, reason: 'target_image_not_loaded', count: nodes.length }
  const stickerId = target.getAttribute('data-sticker-id') || image.getAttribute('data-sticker-id') || ''
  const countCopies = () => all(doc, selectors.outgoing).filter(row => [...row.querySelectorAll('img')].some(img => (stickerId && img.getAttribute('data-sticker-id') === stickerId) || img.getAttribute('src') === src)).length
  if (operation === 'inspect') return { ok: true, count: nodes.length, src, stickerId, copies: countCopies(), items: nodes.slice(0, 10).map((node, index) => ({ slot: index + 1, src: (node.querySelector('img') || node).getAttribute('src') })) }
  if (operation === 'click') {
    if (!baseline || baseline.src !== src || baseline.stickerId !== stickerId || baseline.count !== nodes.length) return { ok: false, reason: 'favorite_order_changed' }
    click(target.querySelector('.emojiEmojiItemimgBox[data-apm-action="EmojiItem"]') || target); return { ok: true, attempted: true }
  }
  return { ok: false, reason: 'unknown_operation' }
}
function stickerDeliveryDom(doc, selectors, target, expected, identityFn) {
  const identity = identityFn(expected.name, expected.platformUserId)
  if (!identity?.verified || identity.platformUserId !== expected.platformUserId) return { verified: false }
  const rows = [...doc.querySelectorAll(selectors.outgoing)]
  const matches = rows.filter(row => [...row.querySelectorAll('img')].some(img => (target.stickerId && img.getAttribute('data-sticker-id') === target.stickerId) || img.getAttribute('src') === target.src))
  const unsettled = row => Boolean(row.querySelector('[data-e2e="message-send-error"], [data-e2e="message-sending"], [class*="sendFail" i], [class*="sendError" i], [class*="sendLoading" i], [class*="sending" i]')) || /发送失败|重新发送/.test(row.textContent || '')
  const copies = matches.filter(row => !unsettled(row)).length
  return { verified: true, copies }
}
async function sendFavoriteSticker({ win, name, intent, expectedPlatformUserId, selectors = {}, assertTarget = async () => {}, beforeSubmit = async () => {}, onTargetSelected = async () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!Object.hasOwn(SLOT_MAP, intent)) return { status: 'FAILED', reason: 'unsupported_sticker_intent', sendAttempted: false }
  let attempted = false
  const selected = { ...SELECTORS, ...selectors }
  try {
    await assertTarget()
    const identity = await executePageScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(name)}, ${JSON.stringify(expectedPlatformUserId || '')})`)
    if (!identity?.verified || !identity.platformUserId || (expectedPlatformUserId && expectedPlatformUserId !== identity.platformUserId)) return { status: 'FAILED', reason: 'contact_identity_unverified', sendAttempted: false }
    const expected = { name, platformUserId: identity.platformUserId }
    const run = (operation, baseline) => executePageScript(win, `(${favoriteStickerDom.toString()})(document,${JSON.stringify(operation)},${JSON.stringify(selected)},${SLOT_MAP[intent]},${JSON.stringify(expected)},${activeChatIdentity.toString()},${JSON.stringify(baseline || null)})`)
    for (const operation of ['toggle', 'favorites']) {
      await assertTarget(); await beforeSubmit(win)
      const result = await run(operation)
      if (!result?.ok) return { status: 'FAILED', reason: result?.reason || 'panel_not_open', sendAttempted: false }
      await sleep(120)
    }
    let target = await run('inspect')
    for (let attempt = 0; !target?.ok && target?.reason === 'target_image_not_loaded' && attempt < 40; attempt++) {
      await sleep(200); await assertTarget(); await beforeSubmit(win); target = await run('inspect')
    }
    if (!target?.ok) return { status: 'FAILED', reason: target?.reason || 'target_missing', sendAttempted: false }
    await assertTarget(); await beforeSubmit(win)
    await onTargetSelected(target)
    attempted = true // Renderer errors can occur after the click was already delivered.
    const clicked = await run('click', target)
    if (!clicked?.attempted) { attempted = false; return { status: 'FAILED', reason: clicked?.reason || 'target_not_clicked', sendAttempted: false } }
    for (let index = 0; index < 20; index++) {
      await sleep(250)
      await assertTarget()
      const delivery = await executePageScript(win, `(${stickerDeliveryDom.toString()})(document,${JSON.stringify(selected)},${JSON.stringify(target)},${JSON.stringify(expected)},${activeChatIdentity.toString()})`)
      if (!delivery?.verified) return { status: 'UNKNOWN', reason: 'contact_changed_after_click', sendAttempted: true }
      if (delivery.copies > target.copies) return { status: 'SUCCESS', slot: SLOT_MAP[intent], intent, sendAttempted: true }
    }
    return { status: 'UNKNOWN', reason: 'sticker_delivery_not_confirmed', sendAttempted: true }
  } catch (error) { return { status: attempted ? 'UNKNOWN' : 'FAILED', reason: error.message, error, sendAttempted: attempted } }
}
module.exports = { SELECTORS, favoriteStickerDom, stickerDeliveryDom, sendFavoriteSticker }
