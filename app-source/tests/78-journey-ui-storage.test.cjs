const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm')
require('./setup.cjs')
const { JsonStorage, migrateLegacy, normalizeContact } = require('../electron/storage.cjs')
const { buildRelationshipJourney } = require('../electron/social-brain/relationship-journey.cjs')
const renderer = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8').replace(/loadAll\(\)\s*$/, '')
const now = new Date('2026-10-14T08:00:00Z').getTime()
const since = '2026-10-10T08:00:00.000Z'
const journey = (extra = {}) => ({ currentStage: 'FAMILIAR', previousStage: 'ACQUAINTANCE', stageSince: since, suggestedStage: 'FRIEND', confidence: 0.8, relationshipEvidence: [], stageHistory: [], ...extra })
const contact = (name = '虚拟联系人', extra = {}) => ({ id: name, name, profile: { chatMode: 'friendship' }, learning: { messages: [], facts: [] }, ...extra, relationshipJourney: { ...journey(), ...(extra.relationshipJourney || {}), contactId: name } })
function ui(contacts = [contact()]) {
  const nodes = {}, handlers = {}, api = { onDouyinEvent() {}, accounts: { onChanged() {} } }
  const document = { addEventListener(type, fn) { handlers[type] = fn }, getElementById(id) { return nodes[id] || null }, querySelector() { return null }, activeElement: null }
  const context = vm.createContext({ window: { desktopApp: api }, document, setTimeout() {}, clearTimeout() {}, setInterval() {}, fixture: migrateLegacy({ contacts }) })
  vm.runInContext(renderer + '\nS.data=fixture;S.section="chat";S.selected=fixture.contacts[0]?.name || "";applyTheme=()=>{};globalThis.subject={S,relationshipJourneyView,journeyDuration,journeyDate,contactDetail,refreshDynamic,patchContainer};', context)
  return { ...context.subject, context, nodes, document, handlers }
}

test('Journey UI renders all six fixed stages with Chinese labels', () => {
  const fixture = ui()
  for (const [stage, label] of Object.entries({ STRANGER: '陌生人', EXPLORING: '相互了解', ACQUAINTANCE: '认识的人', FAMILIAR: '熟悉的人', FRIEND: '朋友', CLOSE_FRIEND: '亲近的朋友' })) {
    assert.match(fixture.relationshipJourneyView(contact('测试', { relationshipJourney: journey({ currentStage: stage }) }), now), new RegExp(`当前关系阶段：${label}`))
  }
})
test('contact detail keeps controls and notes without the relationship editor', () => {
  const html = ui().contactDetail(contact())
  assert.match(html, /data-cf="notes"/)
  assert.match(html, /data-act="toggle-contact-ai"/)
  assert.match(html, /data-act="toggle-contact-black"/)
  assert.doesNotMatch(html, /id="contact-relationship-journey"|data-cf="relationship"|data-mode-name=/)
})
test('stage duration measures preserved stageSince rather than message count', () => {
  const fixture = ui()
  assert.equal(fixture.journeyDuration(since, now), '4 天')
  assert.equal(fixture.journeyDuration(now - 2 * 3600000, now), '2 小时')
  assert.equal(fixture.journeyDuration(now - 10, now), '不足 1 小时')
  assert.match(fixture.relationshipJourneyView(contact(), now), /阶段持续时间：4 天/)
})
test('absent, stale invalid and future stage times cannot produce NaN or negative duration', () => {
  const fixture = ui()
  for (const date of [null, undefined, '', 'not-a-date', Infinity, now + 10000]) assert.equal(fixture.journeyDuration(date, now), '待确认')
  const html = fixture.relationshipJourneyView(contact('测试', { relationshipJourney: journey({ stageSince: 'broken' }) }), now)
  assert.doesNotMatch(html, /Invalid Date|NaN|-\d+ 天/)
})
test('stage timestamps use Asia Shanghai even when UTC falls on previous day', () => {
  assert.match(ui().journeyDate('2026-10-13T20:00:00Z'), /2026\/10\/14.*04:00:00/)
})
test('canonical stage takes precedence over existing oldfriend mode', () => {
  const html = ui().relationshipJourneyView(contact('测试', { profile: { chatMode: 'oldfriend' }, relationshipJourney: journey({ currentStage: 'EXPLORING' }) }), now)
  assert.match(html, /当前关系阶段：相互了解/)
})
test('legacy oldfriend data displays friend while unconfigured data displays stranger', () => {
  const fixture = ui()
  assert.match(fixture.relationshipJourneyView({ profile: { chatMode: 'oldfriend' } }), /当前关系阶段：朋友/)
  assert.match(fixture.relationshipJourneyView({ profile: {} }), /当前关系阶段：陌生人/)
  assert.match(fixture.relationshipJourneyView({ profile: { relationship: '大学室友' } }), /当前关系阶段：朋友/)
})
test('unknown stage names are never rendered as executable or misleading labels', () => {
  const html = ui().relationshipJourneyView(contact('测试', { relationshipJourney: journey({ currentStage: '<img onerror=bad>', suggestedStage: 'constructor', evaluatedAt: since }) }), now)
  assert.match(html, /当前关系阶段：陌生人/); assert.match(html, /暂无阶段变化建议/); assert.doesNotMatch(html, /<img|constructor/)
})
test('initial migrated stage is not mislabelled as an AI recommendation before evaluation', () => {
  const fixture = ui()
  assert.match(fixture.relationshipJourneyView(contact('测试', { relationshipJourney: journey({ suggestedStage: 'FAMILIAR', evaluatedAt: null }) }), now), /AI 建议阶段：尚未评估/)
  assert.match(fixture.relationshipJourneyView(contact('测试', { relationshipJourney: journey({ evaluatedAt: since }) }), now), /AI 建议阶段：朋友/)
  assert.match(fixture.relationshipJourneyView(contact('测试', { relationshipJourney: journey({ evaluatedAt: 'broken' }) }), now), /AI 建议阶段：尚未评估/)
  assert.match(fixture.relationshipJourneyView(contact(), now), /阶段记录起点，并非认识日期/)
})
test('evidence and history content escape markup from conversations and model output', () => {
  const html = ui().relationshipJourneyView(contact('测试', { relationshipJourney: journey({ relationshipEvidence: [{ type: 'CALLBACK', summary: '<img src=x onerror=bad>', timestamp: since }], stageHistory: [{ fromStage: 'EXPLORING', toStage: 'ACQUAINTANCE', timestamp: since, reasons: ['<script>bad</script>'] }] }) }), now)
  assert.match(html, /回访旧话题/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<img src=x/)
})
test('all supported evidence types have understandable labels without a points total', () => {
  const evidence = Object.keys({ MUTUAL_DISCLOSURE: 1, COMMON_GROUND: 1, MUTUAL_INITIATION: 1, CALLBACK: 1, SHARED_MOMENT: 1, EMOTIONAL_SUPPORT: 1, PLAYFUL_INTERACTION: 1, TRUST_SIGNAL: 1, CONTINUITY: 1, INSIDE_JOKE: 1 })
  for (const type of evidence) {
    const html = ui().relationshipJourneyView(contact('测试', { relationshipJourney: journey({ relationshipEvidence: [{ type, summary: '真实对话证据', timestamp: since }] }) }), now)
    assert.match(html, /真实对话证据/); assert.doesNotMatch(html, new RegExp(`${type}：`)); assert.doesNotMatch(html, /总积分|升级进度/)
  }
})
test('Journey observer has no writable stage controls or automatic send action', () => {
  const html = ui().relationshipJourneyView(contact(), now)
  assert.doesNotMatch(html, /<input|<select|<button|data-act=|progress|等级/)
  assert.match(html, /不代表必须升级/)
})
test('recent changes retain chronological evidence while UI limits the observation list', () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ fromStage: 'STRANGER', toStage: 'EXPLORING', timestamp: since, reasons: [`变化-${i}`] }))
  const evidence = Array.from({ length: 8 }, (_, i) => ({ type: 'COMMON_GROUND', summary: `证据-${i}`, timestamp: since }))
  const html = ui().relationshipJourneyView(contact('测试', { relationshipJourney: journey({ stageHistory: history, relationshipEvidence: evidence }) }), now)
  assert.ok(html.indexOf('变化-4') < html.indexOf('变化-3')); assert.doesNotMatch(html, /变化-0|证据-0|证据-1/)
  assert.match(html, /证据-7/); assert.equal(history.length, 5); assert.equal(evidence.length, 8)
})
test('malformed arrays and null observations safely produce empty read-only view', () => {
  const html = ui().relationshipJourneyView(contact('测试', { relationshipJourney: journey({ stageHistory: [null], relationshipEvidence: [null, { type: 'UNKNOWN' }] }) }), now)
  assert.match(html, /暂无阶段变化记录/); assert.match(html, /不会按消息条数升级/)
})
test('background journey patch leaves dirty profile fields and unsent manual text untouched', () => {
  const fixture = ui()
  fixture.nodes['profile-dirty'] = { value: '尚未保存的个人备注' }; fixture.nodes['manual-text'] = { value: '还没发送的草稿' }
  vm.runInContext('globalThis.patched=[];patchContainer=(id)=>{patched.push(id);return true};contactListItems=()=>"";chatActions=()=>"";', fixture.context)
  fixture.refreshDynamic()
  assert.ok(fixture.context.patched.includes('contact-relationship-journey'))
  assert.ok(!fixture.context.patched.some(id => ['contact-detail', 'manual-text', 'profile-dirty'].includes(id)))
  assert.equal(fixture.nodes['profile-dirty'].value, '尚未保存的个人备注'); assert.equal(fixture.nodes['manual-text'].value, '还没发送的草稿')
})
test('existing focus guard still prevents replacing a focused input container', () => {
  const fixture = ui(), input = { tagName: 'INPUT', value: '正在编辑' }
  fixture.document.activeElement = input
  fixture.nodes['contact-relationship-journey'] = { contains: node => node === input, innerHTML: '原内容', scrollTop: 9 }
  assert.equal(fixture.patchContainer('contact-relationship-journey', '新内容'), false)
  assert.equal(fixture.nodes['contact-relationship-journey'].innerHTML, '原内容')
})
test('migration preserves canonical journey and unrelated existing profile memory and lens', () => {
  const input = contact('A', { profile: { chatMode: 'oldfriend', call: '旧称呼' }, personaLens: { emphasis: ['gaming'] }, relationshipState: { warmth: 0.7 }, learning: { facts: ['现有事实'], messages: [{ id: 'm1', text: '原消息' }] } })
  const migrated = migrateLegacy({ contacts: [input] }).contacts[0]
  assert.equal(migrated.relationshipJourney.currentStage, 'FAMILIAR'); assert.equal(migrated.relationshipJourney.stageSince, since)
  assert.equal(migrated.profile.call, '旧称呼'); assert.equal(migrated.relationshipState.warmth, 0.7); assert.deepEqual(migrated.personaLens, input.personaLens); assert.deepEqual(migrated.learning.messages, input.learning.messages)
})
test('old contacts explicitly labelled oldfriend migrate without changing settings mode', () => {
  const old = normalizeContact({ id: 'old', name: '旧舍友', profile: { chatMode: 'oldfriend' } })
  assert.equal(old.relationshipJourney.currentStage, 'FRIEND'); assert.equal(old.profile.chatMode, 'oldfriend')
  const stranger = normalizeContact({ id: 'new', name: '新联系人', profile: { chatMode: 'friendship' } })
  assert.equal(stranger.relationshipJourney.currentStage, 'STRANGER')
})
test('contact journey migration is idempotent and unrelated logs cannot restart the stage clock', () => {
  const first = normalizeContact({ id: 'new', name: '新联系人', profile: { chatMode: 'friendship' } })
  const second = normalizeContact(first)
  assert.equal(second.relationshipJourney.stageSince, first.relationshipJourney.stageSince)
  assert.deepEqual(second.relationshipJourney.stageHistory, first.relationshipJourney.stageHistory)
})
test('foreign contact journey cannot be migrated as local relationship evidence', () => {
  const foreign = contact('A'); foreign.relationshipJourney.contactId = 'B'
  const normalized = normalizeContact(foreign)
  assert.equal(normalized.relationshipJourney.currentStage, 'STRANGER')
  assert.equal(normalized.relationshipJourney.contactId, 'A')
  assert.deepEqual(normalized.relationshipJourney.relationshipEvidence, [])
})
test('Journey data is saved and reloaded per contact without evidence crossing accounts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const storage = new JsonStorage(path.join(dir, 'account-a'))
  const messages = [
    { id: 'a1', contactId: 'A', role: 'me', text: '我喜欢三角洲游戏', at: since },
    { id: 'a2', contactId: 'A', role: 'contact', text: '我也喜欢三角洲', at: '2026-10-10T08:01:00.000Z' },
    { id: 'a3', contactId: 'A', role: 'contact', text: '上次三角洲打得咋样', at: '2026-10-11T08:00:00.000Z' },
    { id: 'a4', contactId: 'A', role: 'me', text: '昨天打三角洲挺开心哈哈', at: '2026-10-11T08:01:00.000Z' },
  ]
  const personA = contact('A', { learning: { messages } })
  personA.relationshipJourney = buildRelationshipJourney({ contact: personA, messages, now })
  const callback = personA.relationshipJourney.relationshipEvidence.find(item => item.type === 'CALLBACK')
  assert.ok(callback, 'actual cross-day exchanges must produce callback evidence')
  storage.update({ contacts: [personA, contact('B', { relationshipJourney: journey({ currentStage: 'STRANGER', suggestedStage: null }) })] })
  storage.addLog({ type: 'unrelated', message: '不会改变关系' })
  const reload = new JsonStorage(path.join(dir, 'account-a')).get()
  assert.equal(reload.contacts[0].relationshipJourney.stageSince, since)
  assert.deepEqual(reload.contacts[0].relationshipJourney.relationshipEvidence.find(item => item.type === 'CALLBACK'), callback)
  assert.equal(reload.contacts[1].relationshipJourney.currentStage, 'STRANGER')
  assert.equal(reload.contacts[1].relationshipJourney.relationshipEvidence.length, 0)
  assert.equal(new JsonStorage(path.join(dir, 'account-b')).get().contacts.length, 0)
})
test('disk update of one journey preserves other contact and historical stage records', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const storage = new JsonStorage(dir)
  const history = [{ fromStage: 'EXPLORING', toStage: 'ACQUAINTANCE', timestamp: since, reasons: ['共同兴趣'], evidenceIds: [] }]
  storage.update({ contacts: [contact('A', { relationshipJourney: journey({ stageHistory: history }) }), contact('B')] })
  const state = storage.get(); state.contacts[0].relationshipJourney.suggestedStage = 'CLOSE_FRIEND'
  storage.update({ contacts: state.contacts })
  const reloaded = new JsonStorage(dir).get()
  assert.equal(reloaded.contacts[0].relationshipJourney.stageHistory.length, 1)
  assert.equal(reloaded.contacts[1].relationshipJourney.currentStage, 'FAMILIAR')
  assert.equal(reloaded.contacts[1].relationshipJourney.suggestedStage, 'FRIEND')
})
