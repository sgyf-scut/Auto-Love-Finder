const { test } = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { collectCommentRows } = require('../electron/discovery/comment-snapshot.cjs')
const { ProfileNavigator } = require('../electron/discovery/profile-navigator.cjs')
const { FriendshipService } = require('../electron/friendship.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const target = 'https://www.douyin.com/user/fixture_A'
function authorEntry({ id = 'fixture_A', comment = '456', video = '123', propsId = id } = {}) {
  let row
  const link = { href: 'https://www.douyin.com/user/' + id, innerText: '🌈同名昵称', closest: () => row,
    getBoundingClientRect: () => ({ width: 40, height: 20, left: 100, top: 10 }), scrollIntoView() {}, contains: () => false }
  const text = { innerText: '报名', closest: () => row }
  row = { getBoundingClientRect: () => ({ width: 200, height: 100 }), __reactPropsTest: { comment: { cid: comment, user: { secUid: propsId, nickname: '同名昵称' }, text: '报名' } },
    querySelector: selector => selector.startsWith('.comment-item-info') ? { querySelectorAll: () => [link] } : selector.includes('comment-content') ? text : null,
    querySelectorAll: selector => selector.includes('avatar') ? [link] : [] }
  return vm.runInNewContext('(' + collectCommentRows.toString() + ')("123",60,{authorTarget:{commentId:"456",platformUserId:"fixture_A"}})', {
    URL, location: new URL('https://www.douyin.com/video/' + video), document: { title: '评论', body: { innerText: '评论 报名' },
      querySelectorAll: selector => selector === '[data-e2e="comment-item"]' ? [row] : [], elementFromPoint: () => link } })
}
test('original comment entry requires the same video, comment and platform account, independent of nickname symbols', () => {
  assert.equal(authorEntry().authorPoint.x, 120)
  assert.equal(authorEntry({ id: 'fixture_B' }).authorMismatch, true)
  assert.equal(authorEntry({ propsId: 'fixture_B' }).authorMismatch, true)
  assert.equal(authorEntry({ video: '999' }).wrongPage, true)
  assert.equal(authorEntry({ comment: 'another' }).authorPoint, undefined)
})

test('a currently verified target page is reused before any direct navigation', async () => {
  const storage = createMemoryStorage(), douyin = { storage }, page = { webContents: { getURL: () => target }, show() {} }
  const events = [], navigator = new ProfileNavigator(douyin, { accountId: 'fixture', onVerified: e => events.push(e) })
  navigator.verified = { page, url: 'https://www.douyin.com/user/old_target', method: 'direct' }
  navigator.inspect = async () => ({ ready: true }); navigator.direct = () => assert.fail('Should reuse the current profile')
  const out = await navigator.open(page, { profileUrl: target, platformUserId: 'fixture_A' })
  assert.equal(out.method, 'current'); assert.equal(out.page, page); assert.equal(events[0].automated, false)
})

test('follow, contact probe and greeting read the child page returned by navigation', async () => {
  const original = { show() {}, webContents: { getURL: () => 'about:blank' } }, child = { webContents: { getURL: () => target } }
  const douyin = { storage: createMemoryStorage(), log() {}, assertCanSend() {}, profileNavigator: { async open() { return { page: child, method: 'comment' } } } }
  const service = new FriendshipService(douyin), candidate = { url: target, name: '本地测试' }
  service.ensureWindow = () => original; service.candidate = () => candidate
  service.wait = async page => { assert.equal(page, child); return { followed: true } }
  const follow = await service.followCandidate(candidate, { automated: true })
  assert.equal(follow.alreadyFollowed, true)
  await service.probeContact(target)
  service.wait = async page => { assert.equal(page, child); throw Object.assign(new Error('stop before any send'), { code: 'LOCAL_STOP' }) }
  await assert.rejects(service.greetingCandidate(candidate, '本地测试', { automated: true }), { code: 'LOCAL_STOP' })
})

test('an already-paused navigator degrades this batch immediately without spending three more profile checks', () => {
  const storage = createMemoryStorage(), manager = new CandidateManager(storage), runner = new BatchRunner({ storage, manager })
  runner.save({ id: 'local', crossVideoClassification: true, profileReadCircuit: null })
  runner.observeProfileAccess('fixture_A', { status: 'failed', code: 'PROFILE_UNAVAILABLE', profileQueuePaused: true, reason: 'local pause' })
  assert.equal(runner.state.profileReadCircuit.disabled, true)
})

test('account identity errors in shared navigation stop batch profile work with a distinct reason', async () => {
  const { DiscoveryEngine } = require('../electron/discovery/discovery-engine.cjs')
  const douyin = { storage: createMemoryStorage(), profileNavigator: { async open() { throw Object.assign(new Error('identity mismatch'), { code: 'ACCOUNT_ID_MISMATCH', preActionFailure: true }) } } }
  const engine = new DiscoveryEngine(douyin, { accountId: 'fixture' })
  engine.ensureWindow = () => ({})
  const out = await engine.readBatchGender({ platformUserId: 'fixture_A', profileUrl: target })
  assert.equal(out.status, 'blocked'); assert.equal(out.code, 'READ_TARGET_MISMATCH')
})
