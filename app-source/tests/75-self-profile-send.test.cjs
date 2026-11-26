require('./setup.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { DouyinService } = require('../electron/automation.cjs')
const { createExpressionBatch, normalizeExpressionBatch, executeExpressionBatch } = require('../electron/expression-batch.cjs')
const { normalizeSelfProfile, updateSelfProfile, createSeedSelfProfile } = require('../electron/social-brain/self-profile.cjs')
const { assertApprovedSelfDisclosure, approveSelfDisclosure } = require('../electron/social-brain/disclosure-policy.cjs')
const { AutoFriendshipService, normalizeAutoFriendshipConfig } = require('../electron/auto-friendship.cjs')
const { JsonStorage } = require('../electron/storage.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
function diskStorage(t) {
  const root = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(root, 'self-profile-persist-'))
  assert.ok(path.resolve(dir).startsWith(root + path.sep))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, storage: new JsonStorage(dir) }
}
const secret = 'SYNTHETIC_SECRET_749'
const seeded = () => normalizeSelfProfile({ ...createSeedSelfProfile(), stableProfile: [...createSeedSelfProfile().stableProfile, { key: 'password', value: secret, shareLevel: 'PRIVATE' }] })
function sender({ afterWrite, beforeClick } = {}) {
  let state = { selfProfile: seeded(), contacts: [], pendingDrafts: [], expressionBatches: [] }, selected = 0, clicked = 0, recorded = 0
  const win = { webContents: { sendInputEvent() {}, async executeJavaScript() { return false } } }
  const service = { storage: { get: () => state, update: patch => (state = { ...state, ...patch }) }, assertAiSelfProfile: DouyinService.prototype.assertAiSelfProfile, assertSharedMemoryMetadata: DouyinService.prototype.assertSharedMemoryMetadata, markProfileDraftOutdated: DouyinService.prototype.markProfileDraftOutdated, assertCanSend() {}, confirmDraftFresh: async () => {}, selectConversation: async () => { selected++; return win }, waitForEditor: async () => {}, assertConversationTarget: async () => {}, lastReplyTime: new Map(), lastSeen: new Map(), lastSent: new Map(), emitEvent() {}, recordSuccessfulSend() { recorded++ }, recordConversationMessage() { return { id: 'fixture-contact' } }, queueCompletedSharedInteraction() {}, recordExpressionTurn() {}, log() {}, sendCurrentInput: async (_win, options) => { beforeClick?.(service); await options.assertTarget?.(); clicked++ } }
  const source = DouyinService.prototype.sendMessage.toString().replace(/^async sendMessage/, 'async function')
  const send = vm.runInNewContext('(' + source + ')', { require, REPLY_FREQUENCY_SECONDS: {}, normalizeEditorText: x => x, sleep: async () => {}, writeMessageInput: async (_win, text) => { afterWrite?.(service); return text }, clearMatchingInput: async () => true })
  return { service, state: () => state, selected: () => selected, clicked: () => clicked, recorded: () => recorded, send: (text, metadata = { ai: true }) => send.call(service, '虚构联系人', text, metadata) }
}
test('AI PRIVATE text stops before navigating to any real conversation', async () => { const f = sender(); await assert.rejects(f.send(secret)); assert.equal(f.selected(), 0); assert.equal(f.clicked(), 0) })
test('AI old profile version stops before selecting recipient', async () => { const f = sender(); await assert.rejects(f.send('安全短句', { ai: true, selfProfileRevision: 0 }), { code: 'SELF_PROFILE_STALE' }); assert.equal(f.selected(), 0) })
test('manual human text retains existing explicitly manual behavior', async () => { const f = sender(); assert.equal((await f.send(secret, { ai: false })).ok, true); assert.equal(f.clicked(), 1); assert.equal(f.recorded(), 1) })
test('latest PRIVATE edits during input preparation stop submit', async () => { const f = sender({ afterWrite: service => service.storage.update({ selfProfile: updateSelfProfile(service.storage.get().selfProfile, { item: { key: 'favorite_place', value: '已输入地点', shareLevel: 'PRIVATE' } }) }) }); await assert.rejects(f.send('已输入地点')); assert.equal(f.clicked(), 0); assert.equal(f.recorded(), 0) })
test('latest version changes at final click guard stop submit', async () => { const f = sender({ beforeClick: service => service.storage.update({ selfProfile: updateSelfProfile(service.storage.get().selfProfile, { item: { key: 'gaming', value: '新的游戏' } }) }) }); await assert.rejects(f.send('安全短句', { ai: true, selfProfileRevision: 1 }), { code: 'SELF_PROFILE_STALE' }); assert.equal(f.clicked(), 0); assert.equal(f.recorded(), 0) })
test('stale AI draft is marked outdated rather than sent or retryable', async () => { const f = sender(); f.service.storage.update({ pendingDrafts: [{ id: 'd', status: 'pending' }] }); await assert.rejects(f.send('安全短句', { ai: true, draftId: 'd', selfProfileRevision: 0 })); assert.equal(f.state().pendingDrafts[0].status, 'outdated'); assert.equal(f.recorded(), 0) })
test('disabled profile cannot turn off PRIVATE boundary', async () => { const f = sender(); f.service.storage.update({ selfProfile: { ...f.state().selfProfile, enabled: false } }); await assert.rejects(f.send(secret)); assert.equal(f.selected(), 0) })
test('expression revision survives persistence normalization', () => { const batch = createExpressionBatch('虚构联系人', { mode: 'TEXT_ONLY' }, '安全短句', { selfProfileRevision: 4 }); assert.equal(normalizeExpressionBatch(JSON.parse(JSON.stringify(batch))).selfProfileRevision, 4) })
test('pure sticker old revision becomes stale with zero submissions', async () => { const f = sender(), batch = createExpressionBatch('虚构联系人', { mode: 'STICKER_ONLY', stickerIntent: 'TEASE' }, '', { selfProfileRevision: 0 }); let submitted = 0; const result = await executeExpressionBatch(batch, { persist: async () => {}, beforeItem: () => f.service.assertAiSelfProfile('', { ai: true, selfProfileRevision: batch.selfProfileRevision }), sendSticker: async () => { submitted++; return { status: 'SUCCESS' } } }); assert.equal(result.ok, false); assert.equal(batch.status, 'stale'); assert.equal(submitted, 0) })
test('profile changing after first expression preserves sent item and blocks rest', async () => { const f = sender(), batch = createExpressionBatch('虚构联系人', { mode: 'TEXT_AND_STICKER', stickerIntent: 'TEASE', stickerPosition: 'after_text' }, '安全短句', { selfProfileRevision: 1 }); const result = await executeExpressionBatch(batch, { persist: async () => {}, beforeItem: () => f.service.assertAiSelfProfile('', { ai: true, selfProfileRevision: batch.selfProfileRevision }), sendText: async () => { f.service.storage.update({ selfProfile: updateSelfProfile(f.state().selfProfile, { item: { key: 'name', value: '新姓名' } }) }); return { status: 'SUCCESS' } }, sendSticker: async () => { throw Error('must not submit') } }); assert.equal(result.ok, false); assert.equal(batch.status, 'stale'); assert.equal(batch.items[0].status, 'sent'); assert.equal(batch.items[1].status, 'pending') })
test('approved education supports natural school wording', () => { const p = seeded(), education = p.stableProfile.find(x => x.key === 'education'); assert.equal(assertApprovedSelfDisclosure('我在示例理工大学读硕士', p, [education]), true) })
test('approval of school does not approve unknown grade with also', () => { const p = seeded(); assert.throws(() => assertApprovedSelfDisclosure('我也研一，咱们同级', p, p.stableProfile.filter(x => x.key === 'education')), /年级/) })
test('temporary running affinity cannot create current running routine', () => { const p = seeded(); assert.throws(() => assertApprovedSelfDisclosure('跑步还在慢慢练', p, p.stableProfile.filter(x => x.key === 'sports')), /跑步习惯/) })
test('unquantified regular running is still a factual habit requiring approval', () => { const p = seeded(); assert.throws(() => assertApprovedSelfDisclosure('平时跑得比较随性', p, p.stableProfile.filter(x => x.key === 'sports')), /跑步习惯/); assert.equal(assertApprovedSelfDisclosure('跑步这个我还蛮感兴趣的', p, []), true) })
test('approval keeps earlier burst destination when latest focus is an implicit question', () => {
  const context = { payload: { incoming: '你去过吗，有什么印象', attentionContext: { selectedFocus: { summary: '你去过吗，有什么印象' } }, currentIncomingBurst: { messages: [{ role: 'contact', text: '我最近想去西安' }, { role: 'contact', text: '你去过吗，有什么印象' }] } } }
  assert.deepEqual(approveSelfDisclosure(seeded(), context, { shouldReply: true, allowSelfDisclosure: true, selfDisclosureKeys: ['travel'] }).map(item => item.key), ['travel'])
})
test('new confirmed profile passes friendship prerequisite without legacy persona', () => { const state = { selfProfile: seeded(), selfPersona: {}, providers: [{}] }, config = normalizeAutoFriendshipConfig({ keywords: ['猫咪'] }); const fake = { storage: { get: () => state }, ai: { hasProvider: () => true }, automatic: () => config, keywords: AutoFriendshipService.prototype.keywords }; assert.equal(AutoFriendshipService.prototype.prerequisite.call(fake, config), ''); assert.deepEqual(fake.keywords(config), ['猫咪']) })

test('unknown race experience cannot be converted to never participating', () => { const p = seeded(); assert.throws(() => assertApprovedSelfDisclosure('半马还没跑过', p, p.stableProfile.filter(x => x.key === 'sports')), /未知/); })
test('real disk restart preserves pending review without promoting it', t => {
  const { dir, storage } = diskStorage(t)
  storage.update({ selfProfile: { ...normalizeSelfProfile(null), pending: { id: 'p', status: 'pending', stableProfile: [{ key: 'gaming', value: '合成游戏' }], sourceText: '合成介绍' } }, selfPersona: { name: '旧称呼' }, settings: { quietHours: true }, automation: { autoReply: false } })
  const state = new JsonStorage(dir).get()
  assert.equal(state.selfProfile.pending.id, 'p'); assert.equal(state.selfProfile.revision, 0); assert.equal(state.selfProfile.stableProfile.length, 0)
  assert.equal(state.selfPersona.name, '旧称呼'); assert.equal(state.automation.autoReply, false); assert.equal(state.settings.quietHours, true)
})
test('real disk restart preserves formal facts and contact lens independently', t => {
  const { dir, storage } = diskStorage(t), selfProfile = seeded()
  storage.update({ selfProfile, contacts: [{ id: 'fictional', name: '虚构联系人', personaLens: { adaptiveAffinities: [{ topic: 'running', factual: false }] }, relationshipState: { trust: 0.2, flirt: 0 } }] })
  const state = new JsonStorage(dir).get()
  assert.equal(state.selfProfile.revision, 1); assert.equal(state.contacts[0].personaLens.adaptiveAffinities[0].topic, 'running'); assert.equal(state.contacts[0].relationshipState.flirt, 0)
  assert.ok(!state.selfProfile.stableProfile.some(item => /running|跑步/.test(JSON.stringify(item))))
})
