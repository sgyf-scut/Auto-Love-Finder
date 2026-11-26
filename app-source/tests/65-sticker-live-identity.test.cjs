const { test } = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm')
const { activeChatIdentity } = require('../electron/friendship.cjs')
function title(className = 'RightPanelHeadertitle', text = '测试朋友', uid = 'verified_uid') {
  return { innerText: text, getAttribute: key => key === 'class' ? className : null, getBoundingClientRect: () => ({ width: 100, height: 24 }),
    __reactPropsFixture: { curConversation: uid ? { toParticipantSecUserId: uid } : {} }, parentElement: null }
}
function read(nodes, name = '测试朋友') {
  const context = { location: { hostname: 'www.douyin.com' }, document: { querySelectorAll(selector) { return nodes.filter(n => selector.includes(n.getAttribute('class')) || selector.includes('data-e2e') && n.e2e) } } }
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${activeChatIdentity.toString()})(${JSON.stringify(name)})`, context)))
}
test('current RightPanel title and independent React conversation ID verify the recipient', () => {
  assert.deepEqual(read([title()]), { verified: true, platformUserId: 'verified_uid' })
})
test('legacy StackLayout title identity remains compatible', () => {
  assert.deepEqual(read([title('StackLayoutStackChatHeadertitle')]), { verified: true, platformUserId: 'verified_uid' })
})
test('new header container and fire badge do not become a second identity title', () => {
  const real = title(), container = title('RightPanelHeadertitleContainer', '测试朋友 9')
  assert.equal(read([real, container]).verified, true)
})
test('matching nickname without a user ID cannot authorize a sticker', () => {
  assert.equal(read([title('RightPanelHeadertitle', '测试朋友', null)]).verified, false)
})
test('wrong nickname or multiple independent visible headers fail closed', () => {
  assert.equal(read([title()], '另一位朋友').verified, false)
  assert.equal(read([title(), title('StackLayoutStackChatHeadertitle')]).verified, false)
})
test('conflicting React profile IDs still block sending with the new title selector', () => {
  const node = title(); node.parentElement = { __reactPropsOther: { opponentUserProfile: { sec_uid: 'different_uid' } }, parentElement: null }
  assert.equal(read([node]).verified, false)
})
