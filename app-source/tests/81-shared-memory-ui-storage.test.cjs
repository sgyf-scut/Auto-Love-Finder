const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm')
require('./setup.cjs')
const { JsonStorage, migrateLegacy, normalizeContact } = require('../electron/storage.cjs')
const shared = require('../electron/social-brain/shared-memory.cjs')
const { buildSharedMemoryCandidates } = require('../electron/social-brain/shared-memory-extractor.cjs')
const renderer = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/loadAll\(\)\s*$/, '')
const since = '2026-10-10T08:00:00.000Z'
const person = (id = 'A', extra = {}) => ({ id, name: '同名虚拟联系人', profile: { chatMode: 'friendship', call: '原称呼' }, learning: { messages: [], facts: ['原事实'] }, ...extra })
const uiMemory = (id = 'A', extra = {}) => ({ id: 'shared-ui', contactId: id, sourceContactId: id, type: 'MUTUAL_DISCOVERY', summary: '首次发现双方都玩英雄联盟', status: 'active', strength: 0.72, createdAt: since, updatedAt: since, sourceMessageIds: ['m1', 'm2'], recallCount: 2, lastRecalledAt: since, ...extra })
const withMemory = (id = 'A', extra = {}) => ({ ...person(id), sharedMemory: { contactId: id, memories: [uiMemory(id, extra)], tombstones: [] } })
function ui(contacts = [withMemory()], deleteOperation = async () => ({ contacts })) {
  const nodes = {}, calls = [], handlers = {}, api = { onDouyinEvent() {}, accounts: { onChanged() {} }, sharedMemory: { delete: payload => { calls.push(payload); return deleteOperation(payload) } }, douyin: { sendMessage() { throw new Error('must not send') }, sendTask() { throw new Error('must not send') } } }
  const document = { addEventListener(type, fn) { handlers[type] = fn }, getElementById(id) { return nodes[id] || null }, querySelector() { return null }, activeElement: null }
  const context = vm.createContext({ window: { desktopApp: api }, document, setTimeout() {}, clearTimeout() {}, setInterval() {}, confirm: () => true, fixture: { ...migrateLegacy({ contacts: contacts.map(person => ({ ...person, sharedMemory: undefined })) }), contacts } })
  vm.runInContext(renderer + '\nS.data=fixture;S.section="chat";S.accounts.active="account-a";S.selected=fixture.contacts[0]?.name || "";applyTheme=()=>{};globalThis.notices=[];showNotice=(message,kind)=>notices.push({message,kind});globalThis.subject={S,sharedMemoryView,contactDetail,refreshDynamic,patchContainer,ACTIONS};', context)
  return { ...context.subject, context, nodes, document, calls, handlers }
}
const payload = { accountId: 'account-a', contactId: 'A', memoryId: 'shared-ui' }
function actualMemory(id = 'A') {
  const messages = [
    { id: `${id}-m1`, contactId: id, role: 'contact', text: '我玩英雄联盟', at: since, source: 'platform_observed' },
    { id: `${id}-m2`, contactId: id, role: 'me', text: '我也玩英雄联盟', at: '2026-10-10T08:01:00.000Z', source: 'platform_send_confirmed', status: 'sent', confirmedSent: true },
  ]
  const contact = person(id, { learning: { messages, facts: ['原事实'] }, sharedMemoryLedger: messages })
  const candidates = buildSharedMemoryCandidates({ contact, messages, now: '2026-10-11T08:00:00.000Z' })
  assert.equal(candidates.length, 1)
  contact.sharedMemory = shared.applySharedMemoryOperations(contact, [{ action: 'CREATE', candidateId: candidates[0].id }], { candidates, now: '2026-10-11T08:00:00.000Z' })
  assert.equal(contact.sharedMemory.memories.length, 1)
  return contact
}
function disk(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('shared memory legacy migration creates an empty independent container, not inferred memories', () => {
  const contact = normalizeContact(person())
  assert.equal(contact.sharedMemory.version, 1); assert.equal(contact.sharedMemory.contactId, 'A')
  assert.deepEqual(contact.sharedMemory.memories, []); assert.deepEqual(contact.sharedMemory.tombstones, [])
  assert.deepEqual(contact.learning.facts, ['原事实'])
})
test('shared memory migration is idempotent and preserves stage clock and user switches', () => {
  const initial = migrateLegacy({ contacts: [person()], automation: { autoReply: true, aiDisabledContacts: ['同名虚拟联系人'] }, settings: { aiReplyDraftOnly: false } })
  const repeated = migrateLegacy(initial)
  assert.deepEqual(repeated.contacts[0].sharedMemory, initial.contacts[0].sharedMemory)
  assert.equal(repeated.contacts[0].relationshipJourney.stageSince, initial.contacts[0].relationshipJourney.stageSince)
  assert.equal(repeated.contacts[0].profile.call, '原称呼')
  assert.equal(repeated.automation.autoReply, true); assert.equal(repeated.settings.aiReplyDraftOnly, false)
  assert.deepEqual(repeated.automation.aiDisabledContacts, initial.automation.aiDisabledContacts)
})
test('shared memory normalization rejects a copied foreign contact container', () => {
  const a = normalizeContact(person('A'))
  const b = normalizeContact(person('B', { sharedMemory: a.sharedMemory }))
  assert.equal(b.sharedMemory.contactId, 'B'); assert.deepEqual(b.sharedMemory.memories, [])
})
test('empty shared memory containers remain separated for same-name contacts', () => {
  const migrated = migrateLegacy({ contacts: [person('A'), person('B')] })
  migrated.contacts[0].sharedMemory.tombstones.push({ id: 'test' })
  assert.deepEqual(migrated.contacts[1].sharedMemory.tombstones, [])
})
test('shared memory UI displays type summary sources time strength status and recall', () => {
  const html = ui().sharedMemoryView(withMemory())
  for (const expected of ['共同记忆', '发现共同点', '首次发现双方都玩英雄联盟', '来源消息：m1、m2', '强度：72%', '状态：有效', '回忆 2 次', '2026/10/10', '最近']) assert.ok(html.includes(expected), expected)
  assert.match(html, /data-act="shared-memory-delete"/)
})
test('shared memory UI supports only the ten fixed types', () => {
  const labels = { SHARED_MOMENT: '共同经历', INSIDE_JOKE: '共同梗', MUTUAL_DISCOVERY: '发现共同点', EMOTIONAL_MOMENT: '情绪互动', SUPPORT_MOMENT: '支持与陪伴', CELEBRATION: '共同庆祝', CONFLICT_AND_REPAIR: '冲突与和解', PROMISE: '双方约定', CALLBACK_CHAIN: '多次回访', MILESTONE: '关系节点' }
  const fixture = ui()
  for (const [type, label] of Object.entries(labels)) assert.ok(fixture.sharedMemoryView(withMemory('A', { type })).includes(`<strong>${label}</strong>`))
  assert.match(fixture.sharedMemoryView(withMemory('A', { type: 'CUSTOM', summary: '不展示未知类型' })), /暂无共同记忆/)
})
test('shared memory view refuses foreign containers and foreign source ownership', () => {
  const fixture = ui(), contact = withMemory()
  contact.sharedMemory.contactId = 'B'
  assert.match(fixture.sharedMemoryView(contact), /暂无共同记忆/)
  assert.match(fixture.sharedMemoryView(withMemory('A', { sourceContactId: 'B' })), /暂无共同记忆/)
  assert.match(fixture.sharedMemoryView(withMemory('A', { contactId: 'B' })), /暂无共同记忆/)
})
test('shared memory UI hides inactive records and deletion tombstones', () => {
  const fixture = ui()
  for (const status of ['deleted', 'archived', 'invalid', '']) assert.match(fixture.sharedMemoryView(withMemory('A', { status })), /暂无共同记忆/)
  const contact = withMemory(); contact.sharedMemory.tombstones = [{ id: 'shared-ui', contactId: 'A' }]
  assert.match(fixture.sharedMemoryView(contact), /暂无共同记忆/)
})
test('shared memory UI escapes summaries source ids and delete payload attributes', () => {
  const html = ui().sharedMemoryView(withMemory('A', { id: "' onclick='alert(1)", summary: '<img src=x onerror=alert(1)>', sourceMessageIds: ['<script>alert(2)</script>'] }))
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes("data-args='{\"accountId\""))
  assert.ok(html.includes('&lt;img')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&#39;'))
})
test('shared memory empty and malformed UI records have conservative placeholders', () => {
  assert.match(ui().sharedMemoryView(person()), /暂无共同记忆/)
  const contact = withMemory('A', { strength: NaN, recallCount: -2, createdAt: 'bad', updatedAt: null, sourceMessageIds: null })
  contact.sharedMemory.memories.unshift(null)
  const html = ui().sharedMemoryView(contact)
  assert.ok(html.includes('强度：待确认')); assert.ok(html.includes('回忆 0 次')); assert.ok(html.includes('时间待确认')); assert.ok(html.includes('来源消息：待确认'))
})
test('shared memory contact section has no editor or chat sending action', () => {
  const fixture = ui(), html = fixture.sharedMemoryView(withMemory())
  assert.ok(!/<input|<textarea|<select/.test(html)); assert.ok(!html.includes('manual-send'))
  assert.ok(fixture.contactDetail(withMemory()).includes('id="contact-shared-memory"'))
})
test('shared memory background update patches only its read-only container', () => {
  const fixture = ui()
  fixture.nodes['profile-dirty'] = { value: '未保存备注' }; fixture.nodes['manual-text'] = { value: '未发送消息' }
  vm.runInContext('globalThis.patches=[];patchContainer=id=>{patches.push(id);return true};contactListItems=()=>"";chatActions=()=>"";', fixture.context)
  fixture.refreshDynamic()
  assert.ok(fixture.context.patches.includes('contact-shared-memory'))
  assert.ok(!fixture.context.patches.some(id => ['contact-detail', 'manual-text', 'profile-dirty'].includes(id)))
  assert.equal(fixture.nodes['profile-dirty'].value, '未保存备注'); assert.equal(fixture.nodes['manual-text'].value, '未发送消息')
})
test('shared memory patch preserves scroll position', () => {
  const fixture = ui(), node = { innerHTML: '', scrollTop: 37, contains: () => false }
  fixture.nodes['contact-shared-memory'] = node
  fixture.patchContainer('contact-shared-memory', 'new')
  assert.equal(node.scrollTop, 37); assert.equal(node.innerHTML, 'new')
})
test('shared memory deletion calls only scoped IPC and preserves dirty fields', async () => {
  const state = { contacts: [person()], automation: {}, pendingDrafts: [] }
  const fixture = ui([withMemory()], async () => state)
  fixture.nodes['profile-dirty'] = { value: '不要重建表格' }; fixture.nodes['manual-text'] = { value: '不要发送' }
  vm.runInContext('globalThis.patches=[];globalThis.renders=0;render=()=>renders++;patchContainer=id=>{patches.push(id);return true};contactListItems=()=>"";chatActions=()=>"";', fixture.context)
  const btn = { disabled: false }
  await fixture.ACTIONS['shared-memory-delete'](payload, btn)
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls)), [payload]); assert.equal(btn.disabled, false)
  assert.equal(fixture.context.renders, 0); assert.equal(fixture.nodes['manual-text'].value, '不要发送'); assert.equal(fixture.nodes['profile-dirty'].value, '不要重建表格')
})
test('shared memory deletion rejects stale account or foreign contact without calling IPC', async () => {
  const fixture = ui()
  await assert.rejects(fixture.ACTIONS['shared-memory-delete']({ ...payload, accountId: 'other' }), /账号已变化/)
  await assert.rejects(fixture.ACTIONS['shared-memory-delete']({ ...payload, contactId: 'B' }), /联系人不存在/)
  assert.equal(fixture.calls.length, 0)
})
test('canceling shared memory deletion does not mutate local state or call IPC', async () => {
  const fixture = ui(); fixture.context.confirm = () => false
  const before = JSON.stringify(fixture.S.data)
  await fixture.ACTIONS['shared-memory-delete'](payload)
  assert.equal(fixture.calls.length, 0); assert.equal(JSON.stringify(fixture.S.data), before)
})
test('account switch during shared memory deletion cannot overwrite new-account state', async () => {
  let finish
  const fixture = ui([withMemory()], () => new Promise(resolve => { finish = resolve }))
  const task = fixture.ACTIONS['shared-memory-delete'](payload)
  const other = { contacts: [person('B')] }; fixture.S.accounts.active = 'account-b'; fixture.S.data = other
  finish({ contacts: [] }); await task
  assert.equal(fixture.S.data, other); assert.equal(fixture.context.notices.length, 0)
})
test('delete failure after account switch does not show an old-account error', async () => {
  let fail
  const fixture = ui([withMemory()], () => new Promise((_resolve, reject) => { fail = reject }))
  const task = fixture.ACTIONS['shared-memory-delete'](payload)
  fixture.S.accounts.active = 'account-b'; fail(new Error('旧账号删除失败')); await task
  assert.equal(fixture.context.notices.length, 0)
})
test('delete failure remains visible and cannot pretend success or erase current state', async () => {
  const fixture = ui([withMemory()], async () => { throw new Error('写盘失败') }), state = fixture.S.data
  await fixture.ACTIONS['shared-memory-delete'](payload)
  assert.equal(fixture.S.data, state); assert.equal(fixture.context.notices[0].kind, 'err'); assert.match(fixture.context.notices[0].message, /写盘失败/)
})
test('preload shared memory deletion forwards account contact and memory ids only', async () => {
  let exposed, call
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8')
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld(_name, api) { exposed = api } }, ipcRenderer: { invoke(channel, value) { call = { channel, value }; return Promise.resolve('ok') } } }) })
  assert.equal(await exposed.sharedMemory.delete(payload), 'ok')
  assert.deepEqual(call, { channel: 'shared-memory:delete', value: payload })
})
test('shared memory disk storage reload keeps actual provenance and sources per contact', t => {
  const dir = disk(t), storage = new JsonStorage(dir), a = actualMemory(), b = actualMemory('B')
  storage.update({ contacts: [a, b] })
  const contacts = new JsonStorage(dir).get().contacts
  assert.deepEqual(contacts[0].sharedMemory, a.sharedMemory)
  assert.deepEqual(contacts[1].sharedMemory, b.sharedMemory)
  assert.ok(contacts[0].sharedMemory.memories[0].sourceMessageIds.every(id => id.startsWith('A-')))
  assert.ok(contacts[1].sharedMemory.memories[0].sourceMessageIds.every(id => id.startsWith('B-')))
})
test('deletion persists a tombstone across reload and old-source extraction cannot recreate it', t => {
  const dir = disk(t), storage = new JsonStorage(dir), contact = actualMemory()
  storage.update({ contacts: [contact] })
  const loaded = storage.get().contacts[0], memory = loaded.sharedMemory.memories[0]
  loaded.sharedMemory = shared.deleteSharedMemory(loaded, memory.id)
  storage.update({ contacts: [loaded] })
  const persisted = new JsonStorage(dir).get().contacts[0]
  assert.deepEqual(persisted.sharedMemory.memories, [])
  assert.equal(persisted.sharedMemory.tombstones[0].id, memory.id)
  const candidates = buildSharedMemoryCandidates({ contact: persisted, messages: persisted.learning.messages })
  assert.equal(candidates.length, 0)
})
test('deleting a foreign memory id has no effect on local or other contact', t => {
  const dir = disk(t), storage = new JsonStorage(dir), a = actualMemory(), b = actualMemory('B')
  const before = structuredClone(a.sharedMemory)
  a.sharedMemory = shared.deleteSharedMemory(a, b.sharedMemory.memories[0].id)
  assert.deepEqual(a.sharedMemory, before)
  storage.update({ contacts: [a, b] })
  const state = new JsonStorage(dir).get()
  assert.deepEqual(state.contacts[0].sharedMemory, a.sharedMemory); assert.deepEqual(state.contacts[1].sharedMemory, b.sharedMemory)
})
test('shared memory accounts use separate durable stores even with equal contact ids', t => {
  const dir = disk(t), storeA = new JsonStorage(path.join(dir, 'account-a')), storeB = new JsonStorage(path.join(dir, 'account-b'))
  storeA.update({ contacts: [actualMemory()] }); storeB.update({ contacts: [person()] })
  assert.equal(new JsonStorage(path.join(dir, 'account-a')).get().contacts[0].sharedMemory.memories.length, 1)
  assert.equal(new JsonStorage(path.join(dir, 'account-b')).get().contacts[0].sharedMemory.memories.length, 0)
})
test('unrelated storage updates preserve shared ledger profile facts journey and stageSince', t => {
  const dir = disk(t), storage = new JsonStorage(dir), contact = actualMemory()
  storage.update({ contacts: [contact] })
  const before = storage.get().contacts[0]
  storage.addLog({ type: 'test', message: 'unrelated update' })
  const after = new JsonStorage(dir).get().contacts[0]
  assert.deepEqual(after.sharedMemoryLedger, before.sharedMemoryLedger)
  assert.deepEqual(after.sharedMemory, before.sharedMemory)
  assert.deepEqual(after.learning.facts, before.learning.facts); assert.deepEqual(after.profile, before.profile)
  assert.deepEqual(after.relationshipJourney, before.relationshipJourney)
})
test('valid shared memory migration does not promote a relationship or write factual memory', () => {
  const contact = actualMemory(), normalized = normalizeContact(contact)
  assert.equal(normalized.relationshipJourney.currentStage, 'STRANGER')
  assert.equal(normalized.sharedMemory.memories[0].type, 'MUTUAL_DISCOVERY')
  assert.deepEqual(normalized.learning.facts, ['原事实'])
})
test('durable valid shared memory is displayed with a scoped delete button after reload', t => {
  const dir = disk(t), storage = new JsonStorage(dir); storage.update({ contacts: [actualMemory()] })
  const contact = new JsonStorage(dir).get().contacts[0]
  const html = ui([contact]).sharedMemoryView(contact)
  assert.ok(html.includes('双方在聊天中发现')); assert.ok(html.includes('&quot;accountId&quot;:&quot;account-a&quot;'))
  assert.ok(html.includes('&quot;contactId&quot;:&quot;A&quot;')); assert.ok(html.includes(contact.sharedMemory.memories[0].id))
})
