const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const profile = require('../electron/social-brain/self-profile.cjs')
const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8')
function fixture(extra = {}, extractor) {
  let state = { selfProfile: profile.emptySelfProfile(), pendingDrafts: [], ...structuredClone(extra) }
  let activeAccount = 'a', pauses = 0
  const handlers = new Map(), entry = { storage: { get: () => structuredClone(state), update: patch => (state = { ...state, ...structuredClone(patch) }) }, ai: { inquiryCompletion() {} }, douyin: { incomingBuffer: { pause() { pauses++ } }, burstQuietObserver: { stop() {} } } }
  const sandbox = { ...profile, extractSelfProfile: extractor || (async () => ({ id: 'pending-1', stableProfile: [{ key: 'gaming', value: '三角洲' }], currentLife: [], privacyPreferences: [] })), ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getActiveServices: () => entry }
  Object.defineProperty(sandbox, 'activeAccount', { get: () => activeAccount })
  vm.runInNewContext(main.slice(main.indexOf('function selfProfileEntry('), main.indexOf('// AI 服务 IPC：统一捕获异常')), sandbox)
  return { entry, get: () => state, pauses: () => pauses, switch: name => { activeAccount = name }, call: (method, payload = {}) => handlers.get('self-profile:' + method)(null, { accountId: activeAccount, revision: state.selfProfile.revision, ...payload }) }
}
test('profile reads are explicitly scoped to active account', async () => { const f = fixture(); assert.equal((await f.call('get', { accountId: 'b' })).ok, false) })
test('missing account scope cannot initialize or modify', async () => { const f = fixture(); assert.equal((await f.call('initialize', { accountId: '' })).ok, false); assert.equal(f.get().selfProfile.revision, 0) })
test('extract stages pending without making facts effective', async () => { const f = fixture(); assert.equal((await f.call('extract', { text: '我玩三角洲' })).ok, true); assert.equal(f.get().selfProfile.revision, 0); assert.equal(f.get().selfProfile.stableProfile.length, 0); assert.equal(f.pauses(), 0) })
test('confirm supports reviewed edits and increments formal revision', async () => { const f = fixture(); await f.call('extract'); assert.equal((await f.call('confirm', { pendingId: 'pending-1', stableProfile: [{ key: 'gaming', value: '单机游戏', shareLevel: 'NORMAL' }] })).ok, true); assert.equal(f.get().selfProfile.stableProfile[0].value, '单机游戏'); assert.equal(f.get().selfProfile.revision, 1); assert.equal(f.pauses(), 1) })
test('review can drop all extracted items', async () => { const f = fixture(); await f.call('extract'); await f.call('confirm', { pendingId: 'pending-1', stableProfile: [] }); assert.equal(f.get().selfProfile.stableProfile.length, 0) })
test('wrong pending id cannot promote data', async () => { const f = fixture(); await f.call('extract'); assert.equal((await f.call('confirm', { pendingId: 'wrong' })).ok, false); assert.equal(f.get().selfProfile.revision, 0) })
test('stale UI revision cannot overwrite newer profile', async () => { const f = fixture({ selfProfile: profile.createSeedSelfProfile() }); assert.equal((await f.call('update', { revision: 0, item: { key: 'name', value: '旧值' } })).ok, false); assert.equal(f.get().selfProfile.revision, 1) })
test('initialize uses fictional template facts without adding major or grade', async () => { const f = fixture(); await f.call('initialize'); assert.equal(f.get().selfProfile.revision, 1); assert.ok(f.get().selfProfile.stableProfile.some(x => x.value === '示例用户')); assert.ok(!f.get().selfProfile.stableProfile.some(x => ['grade', 'major'].includes(x.key))) })
test('initialize never overwrites existing confirmed profile', async () => { const f = fixture({ selfProfile: profile.createSeedSelfProfile() }); assert.equal((await f.call('initialize')).ok, false) })
test('initialize never overwrites pending review', async () => { const f = fixture(); await f.call('extract'); assert.equal((await f.call('initialize')).ok, false) })
test('initialize respects existing privacy preferences even revision zero', async () => { const f = fixture({ selfProfile: { ...profile.emptySelfProfile(), privacyPreferences: [{ key: 'school', value: '谨慎', shareLevel: 'CAUTIOUS' }] } }); assert.equal((await f.call('initialize')).ok, false) })
test('discard removes pending only and does not invalidate chat', async () => { const f = fixture(); await f.call('extract'); await f.call('discard', { pendingId: 'pending-1' }); assert.equal(f.get().selfProfile.pending, null); assert.equal(f.get().selfProfile.revision, 0); assert.equal(f.pauses(), 0) })
test('formal updates invalidate ordinary drafts while preserving independent event and video queues', async () => { const f = fixture({ pendingDrafts: [{ id: 1, status: 'pending' }, { id: 2, status: 'failed' }, { id: 3, source: 'event_followup', status: 'pending' }, { id: 4, videoOpeningId: 'v', status: 'pending' }, { id: 5, status: 'sent' }] }); await f.call('update', { item: { key: 'gaming', value: '单机' } }); assert.deepEqual(f.get().pendingDrafts.map(x => x.status), ['outdated', 'outdated', 'pending', 'pending', 'sent']); assert.match(f.get().pendingDrafts[0].outdatedReason, /本人信息库/); assert.equal(f.pauses(), 1) })
test('extract completing after account switch is discarded', async () => { let finish; const f = fixture({}, () => new Promise(r => { finish = r })); const pending = f.call('extract'); f.switch('b'); finish({ stableProfile: [{ key: 'name', value: '过期' }] }); assert.equal((await pending).ok, false); assert.equal(f.get().selfProfile.pending, null) })
test('latest extraction wins over earlier slow extraction', async () => { const finishes = []; const f = fixture({}, () => new Promise(r => finishes.push(r))); const one = f.call('extract'), two = f.call('extract'); finishes[1]({ id: 'new', stableProfile: [{ key: 'gaming', value: '新' }] }); assert.equal((await two).ok, true); finishes[0]({ id: 'old', stableProfile: [{ key: 'gaming', value: '旧' }] }); assert.equal((await one).ok, false); assert.equal(f.get().selfProfile.pending.id, 'new') })
test('profile changed during extraction cannot promote obsolete result', async () => { let finish; const f = fixture({}, () => new Promise(r => { finish = r })); const pending = f.call('extract'); await f.call('update', { item: { key: 'name', value: '新资料' } }); finish({ stableProfile: [{ key: 'name', value: '旧提取' }] }); assert.equal((await pending).ok, false); assert.equal(f.get().selfProfile.stableProfile[0].value, '新资料') })
test('mandatory secrets remain PRIVATE after manual OPEN edit', async () => { const f = fixture(); await f.call('update', { item: { key: 'password', value: 'fictional-secret', shareLevel: 'OPEN' } }); assert.equal(f.get().selfProfile.stableProfile[0].shareLevel, 'PRIVATE') })
test('generic automation IPC cannot bypass profile review API', () => { const handlers = new Map(); const start = main.indexOf("ipcMain.handle('automation:update'"); const stop = main.indexOf('function selfProfileEntry(', start); vm.runInNewContext(main.slice(start, stop), { ipcMain: { handle: (n, h) => handlers.set(n, h) }, getActiveServices: () => ({ storage: { update() { throw Error('must not persist') } } }) }); assert.throws(() => handlers.get('automation:update')(null, { selfProfile: {} }), /本人信息库/) })

test('我的介绍保存和提取一次完成，既有审核资料仍保留', async () => {
  const original = profile.updateSelfProfile(null, { item: { key: 'name', value: '原名字', shareLevel: 'CAUTIOUS' } })
  const f = fixture({ selfProfile: original }, async ({ text }) => ({
    sourceText: text,
    stableProfile: [{ key: 'name', value: '新称呼' }, { key: 'sports', value: '游泳' }],
    currentLife: [], privacyPreferences: [],
  }))
  const result = await f.call('save-introduction', { text: '新称呼，我爱游泳' })
  assert.equal(result.ok, true)
  assert.equal(f.get().selfProfile.introductionText, '新称呼，我爱游泳')
  assert.equal(f.get().selfProfile.stableProfile.find(row => row.key === 'name').value, '原名字')
  assert.equal(f.get().selfProfile.stableProfile.find(row => row.key === 'sports').value, '游泳')
  assert.equal(f.get().selfProfile.revision, 2)
})

test('模型整理失败时原文保存在原账号，正式资料不变', async () => {
  const f = fixture({}, async () => { throw new Error('模型暂不可用') })
  assert.equal((await f.call('save-introduction', { text: '我喜欢游泳' })).ok, false)
  const saved = (await f.call('get')).selfProfile
  assert.equal(saved.introductionText, '我喜欢游泳')
  assert.equal(saved.revision, 0)
})
