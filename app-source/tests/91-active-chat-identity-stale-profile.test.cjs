const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { activeChatIdentity } = require('../electron/friendship.cjs')
const name = '测试联系人乙'
const node = (text = name, props = {}, visible = true) => ({ innerText: text, getAttribute: () => 'RightPanelHeadertitle',
  getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: visible ? 24 : 0 }), __reactPropsFixture: props, parentElement: null })
function read(titles, expectedName = name, hostname = 'www.douyin.com') {
  // The production helper is string-injected into the page; no module scope
  // helpers or saved recipient IDs may be needed to establish DOM evidence.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${activeChatIdentity.toString()})(${JSON.stringify(expectedName)})`, {
    document: { querySelectorAll: () => titles }, location: { hostname },
  })))
}
test('current visible conversation peer survives a differently named stale ancestor profile', () => {
  const title = node()
  title.parentElement = { __reactFiberFixture: { memoizedProps: {}, return: { memoizedProps: {
    curConversation: { toParticipantSecUserId: 'current-peer-5af1fae23997' },
    opponentUserProfile: { nickname: '测试联系人戊', sec_uid: 'cached-peer-eb37553bfec2' },
  } } }, parentElement: null }
  assert.deepEqual(read([title]), { verified: true, platformUserId: 'current-peer-5af1fae23997' })
})
test('genuinely conflicting current conversation peer IDs are rejected across structures and fields', () => {
  for (const props of [
    { curConversation: { toParticipantSecUserId: 'one' }, conversation: { _toParticipantSecUserId: 'two' } },
    { curConversation: { toParticipantSecUserId: 'one', _toParticipantSecUserId: 'two' } },
  ]) assert.deepEqual(read([node(name, props)]), { verified: false })
  const title = node(name, { curConversation: { toParticipantSecUserId: 'one' } })
  title.parentElement = { __reactPropsOther: { conversation: { toParticipantSecUserId: 'two' } }, parentElement: null }
  assert.deepEqual(read([title]), { verified: false })
})
test('same-name profile with a different platform identity blocks current peer proof', () => {
  const props = { curConversation: { toParticipantSecUserId: 'one' }, opponentUserProfile: { nickname: name, sec_uid: 'two' } }
  assert.deepEqual(read([node(name, props)]), { verified: false })
})
test('current peer is corroborated by a matching profile and an unnamed same-ID cache adds no conflict', () => {
  for (const profile of [{ nickname: name, secUid: 'one' }, { sec_uid: 'one' }]) {
    assert.deepEqual(read([node(name, { conversation: { _toParticipantSecUserId: 'one' }, opponentUserProfile: profile })]), { verified: true, platformUserId: 'one' })
  }
})
test('an unnamed conflicting profile cannot be proven unrelated and blocks current or named-profile proof', () => {
  assert.deepEqual(read([node(name, { curConversation: { toParticipantSecUserId: 'one' }, opponentUserProfile: { sec_uid: 'other' } })]), { verified: false })
  const title = node(name, { opponentUserProfile: { nickname: name, secUid: 'one' } })
  title.parentElement = { __reactPropsOther: { opponentUserProfile: { sec_uid: 'other' } }, parentElement: null }
  assert.deepEqual(read([title]), { verified: false })
})
test('without current peer IDs only a profile matching the visible title can establish proof', () => {
  assert.deepEqual(read([node(name, { opponentUserProfile: { nickname: name, sec_uid: 'matching-user' } })]), { verified: true, platformUserId: 'matching-user' })
  for (const profile of [{ nickname: '测试联系人戊', sec_uid: 'old-profile-id' }, { secUid: 'old-profile-id' }, { nickname: name }, { nickname: name, sec_uid: 'invalid ID' }]) {
    assert.deepEqual(read([node(name, { opponentUserProfile: profile })]), { verified: false })
  }
  assert.deepEqual(read([node(name, { curConversation: { sec_uid: 'arbitrary-profile-id' } })]), { verified: false })
})
test('matching profile fallback rejects multiple IDs rather than guessing the current user', () => {
  assert.deepEqual(read([node(name, { opponentUserProfile: { nickname: name, sec_uid: 'one', secUid: 'two' } })]), { verified: false })
  const title = node(name, { opponentUserProfile: { nickname: name, secUid: 'one' } })
  title.parentElement = { __reactPropsOther: { opponentUserProfile: { nickname: name, sec_uid: 'two' } }, parentElement: null }
  assert.deepEqual(read([title]), { verified: false })
})
test('domain, visible unique title and nonempty matching expected name remain mandatory', () => {
  const title = node(name, { curConversation: { toParticipantSecUserId: 'correct-user' } })
  for (const [titles, expected, host] of [
    [[title], name, 'douyin.com'], [[title], name, 'www.douyin.com.evil.test'], [[title], '别人', 'www.douyin.com'],
    [[node('', { curConversation: { toParticipantSecUserId: 'correct-user' } })], '', 'www.douyin.com'],
    [[], name, 'www.douyin.com'], [[title, node(name)], name, 'www.douyin.com'], [[node(name, {}, false)], name, 'www.douyin.com'],
  ]) assert.deepEqual(read(titles, expected, host), { verified: false })
  assert.deepEqual(read([title, node('旧会话', {}, false)]), { verified: true, platformUserId: 'correct-user' })
})
