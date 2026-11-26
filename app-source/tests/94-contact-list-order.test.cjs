const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture(contacts) {
  let receive
  const nodes = new Map()
  const document = { activeElement: null, documentElement: { dataset: {} }, getElementById: id => nodes.get(id) || null,
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {} }
  const desktopApp = { onDouyinEvent: callback => { receive = callback }, accounts: { onChanged() {} } }
  const context = vm.createContext({ window: { desktopApp, matchMedia: () => ({ matches: false }) }, document,
    setInterval() {}, setTimeout() { return 1 }, clearTimeout() {}, console })
  const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/\nloadAll\(\)\s*$/, '\n')
  vm.runInContext(`${source}\nglobalThis.ui = { S, contactListItems, contactDisplayPreview, refreshDynamic };`, context)
  const { S } = context.ui
  S.accounts = { active: 'a', accounts: [] }; S.section = 'chat'; S.selected = ''
  S.data = { contacts, automation: {}, settings: {}, appearance: {} }
  return { ...context.ui, nodes, receive: event => receive(event) }
}

function names(html) { return [...html.matchAll(/class="ci-name">([^<]+)/g)].map(match => match[1].trim()) }
const position = (name, index, extra = {}) => ({ name, conversationListPosition: index,
  conversationListPositionSource: 'douyin_list_geometry', conversationListObservedAt: '2026-10-15T12:00:00.000Z', ...extra })

test('actual contact list follows verified platform positions without mutating saved order or profiles', () => {
  const older = position('旧朋友', 900, { id: 'old', profile: { call: '原称呼' }, preview: '旧快照' })
  const newer = position('新消息', 20, { id: 'new', preview: '刚收到' })
  const contacts = [older, { id: 'unknown', name: '未加载朋友', profile: { relationship: '舍友' } }, newer]
  const f = fixture(contacts)
  assert.deepEqual(names(f.contactListItems()), ['新消息', '旧朋友', '未加载朋友'])
  assert.equal(f.S.data.contacts, contacts); assert.equal(contacts[0], older)
  assert.deepEqual(older.profile, { call: '原称呼' }); assert.match(f.contactListItems(), /旧快照/)
})

test('equal and missing positions preserve stable order and same-name contacts remain separate', () => {
  const f = fixture([position('同名', 100, { id: 'a', preview: '甲' }),
    position('同名', 100, { id: 'b', preview: '乙' }),
    { id: 'c', name: '未加载甲' }, { id: 'd', name: '未加载乙' }])
  assert.deepEqual(names(f.contactListItems()), ['同名', '同名', '未加载甲', '未加载乙'])
  assert.ok(f.contactListItems().indexOf('>甲<') < f.contactListItems().indexOf('>乙<'))
})

test('observation timestamps and relative labels never promote old snapshots', () => {
  const f = fixture([{ name: '旧记录', sentAtLabel: '刚刚', sentAt: '2099-12-01T00:00:00.000Z', lastObservedAt: '2099-12-01T00:00:00.000Z', syncedAt: '2099-12-01T00:00:00.000Z' },
    position('真消息', 120), { name: '无效时间', sentAt: '刚刚' },
    { name: '坏日期', sentAt: '2026-99-99T12:00:00.000Z' }])
  assert.deepEqual(names(f.contactListItems()), ['真消息', '旧记录', '无效时间', '坏日期'])
  assert.deepEqual(names(f.contactListItems()), ['真消息', '旧记录', '无效时间', '坏日期'])
})

test('search, selected contact, unread marker and AI switches survive platform ordering', () => {
  const f = fixture([position('朋友甲', 300, { unread: true }), position('朋友乙', 0), { name: '他人' }])
  f.S.contactSearch = '朋友'; f.S.selected = '朋友甲'; f.S.data.automation.aiDisabledContacts = ['朋友甲']
  const html = f.contactListItems()
  assert.deepEqual(names(html), ['朋友乙', '朋友甲'])
  assert.match(html, /contact-item active/); assert.match(html, /ci-unread/); assert.match(html, /\(AI关\)/)
  assert.doesNotMatch(html, /他人/); assert.equal(f.S.selected, '朋友甲')
})

test('current-account contact events update preview and message ordering while late other-account events do not', () => {
  const f = fixture([position('甲', 10, { preview: '旧甲' }), position('乙', 100, { preview: '旧乙' })])
  f.receive({ type: 'contacts', accountId: 'b', payload: { contacts: [{ name: '错误账号' }] } })
  assert.deepEqual(names(f.contactListItems()), ['甲', '乙'])
  f.receive({ type: 'contacts', accountId: 'a', payload: { contacts: [position('甲', 100, { preview: '旧甲' }),
    position('乙', 10, { preview: '新乙' })] } })
  assert.deepEqual(names(f.contactListItems()), ['乙', '甲']); assert.match(f.contactListItems(), /新乙/)
})

test('dynamic list refresh preserves scroll and does not overwrite manual input or unsaved profile', () => {
  const f = fixture([position('最近', 10)])
  const list = { innerHTML: '', scrollTop: 120, contains: () => false }
  const manual = { value: '还没发' }, profile = { value: '还没保存' }
  f.nodes.set('contact-list-scroll', list); f.nodes.set('manual-text', manual); f.nodes.set('profile-call', profile)
  f.refreshDynamic()
  assert.deepEqual(names(list.innerHTML), ['最近']); assert.equal(list.scrollTop, 120)
  assert.equal(manual.value, '还没发'); assert.equal(profile.value, '还没保存')
})

test('position ties favor more recent platform evidence while unknown positions keep their stored order', () => {
  const f = fixture([position('旧位置', 10, { conversationListObservedAt: '2026-10-14T12:00:00.000Z' }),
    { name: '未知甲', conversationListObservedAt: '2099-01-01T00:00:00.000Z' }, position('新位置', 10), { name: '未知乙' }])
  assert.deepEqual(names(f.contactListItems()), ['新位置', '旧位置', '未知甲', '未知乙'])
})

test('unverified, negative, string and infinite positions cannot promote a contact', () => {
  const f = fixture([{ name: '无来源', conversationListPosition: 0 }, position('负数', -1),
    position('字符串', '0'), position('无限', Infinity), position('可信', 100)])
  assert.deepEqual(names(f.contactListItems()), ['可信', '无来源', '负数', '字符串', '无限'])
})

test('only explicit last-snapshot absence displays historical-cache marker without clearing unread', () => {
  const f = fixture([position('缓存', 20, { conversationListCurrent: false, unread: true, preview: '上次消息' }),
    position('新鲜', 0, { conversationListCurrent: true }), { name: '旧版本无状态' }])
  assert.doesNotMatch(f.contactListItems(), /上次消息/)
  assert.match(f.contactListItems(), /新鲜/)
  f.S.showCachedConversations = true
  const html = f.contactListItems()
  assert.equal([...html.matchAll(/>历史缓存</g)].length, 1)
  assert.match(html, /本轮抖音列表未加载此会话，保留资料与上次消息/)
  assert.match(html, /ci-unread/); assert.match(html, /上次消息/)
})

function panePreviewContact() {
  return position('小号', 0, { id: 'local', preview: '[尬笑]', messageKey: '[尬笑]␟unread', profile: { platformUserId: 'peer', dmIdentityVerified: true },
    observedChatPreview: { source: 'verified_chat_dom', messageId: 'msg-real', text: 'xx是什么鬼', role: 'contact', platformUserId: 'peer',
      observedAt: '2026-10-15T14:00:00.000Z', baseListMessageKey: '[尬笑]␟unread' } })
}

test('verified matching pane text renders without replacing stale platform-list preview', () => {
  const contact = panePreviewContact(), f = fixture([contact])
  assert.equal(f.contactDisplayPreview(contact), 'xx是什么鬼')
  assert.match(f.contactListItems(), /xx是什么鬼/); assert.doesNotMatch(f.contactListItems(), /\[尬笑\]/)
  assert.equal(contact.preview, '[尬笑]'); assert.equal(contact.messageKey, '[尬笑]␟unread')
  contact.observedChatPreview.text = '<img src=x onerror=bad()>'
  assert.match(f.contactListItems(), /&lt;img/); assert.doesNotMatch(f.contactListItems(), /<img/)
})

test('new list message invalidates pane override immediately rather than comparing observation times', () => {
  const contact = panePreviewContact(), f = fixture([contact])
  contact.messageKey = '新消息␟unread'; contact.preview = '新消息'
  contact.observedChatPreview.observedAt = '2099-12-01T00:00:00.000Z'
  assert.equal(f.contactDisplayPreview(contact), '新消息')
  assert.match(f.contactListItems(), /新消息/); assert.doesNotMatch(f.contactListItems(), /xx是什么鬼/)
})

test('unverified, conflicting or cross-contact pane identity never overrides list preview', () => {
  const changes = [contact => { contact.observedChatPreview.platformUserId = 'other' },
    contact => { contact.platformUserId = 'other'; contact.identityVerified = true },
    contact => { contact.profile.dmIdentityVerified = false }, contact => { contact.conversationIdentityAmbiguous = true },
    contact => { contact.observedChatPreview.source = 'unverified_dom' }, contact => { contact.observedChatPreview.messageId = '' },
    contact => { contact.observedChatPreview.role = 'unknown' }, contact => { contact.observedChatPreview.text = ' ' }]
  for (const change of changes) {
    const contact = panePreviewContact(); change(contact)
    const f = fixture([contact]); assert.equal(f.contactDisplayPreview(contact), '[尬笑]')
  }
})

test('legacy list key fallback can match preview while blank media and absent list evidence stay untouched', () => {
  const contact = panePreviewContact(), f = fixture([contact])
  delete contact.messageKey; contact.observedChatPreview.baseListMessageKey = contact.preview
  assert.equal(f.contactDisplayPreview(contact), 'xx是什么鬼')
  contact.observedChatPreview.text = ''; assert.equal(f.contactDisplayPreview(contact), '[尬笑]')
  contact.observedChatPreview.text = 'xx是什么鬼'; contact.preview = ''
  contact.observedChatPreview.baseListMessageKey = ''; assert.equal(f.contactDisplayPreview(contact), '')
})

test('dynamic manual hint uses the same verified display preview without altering original list evidence', () => {
  const contact = panePreviewContact(), f = fixture([contact]), hint = { textContent: '' }
  f.S.selected = contact.name; f.nodes.set('manual-hint', hint)
  f.refreshDynamic(); assert.equal(hint.textContent, '对方最近：xx是什么鬼'); assert.equal(contact.preview, '[尬笑]')
})
