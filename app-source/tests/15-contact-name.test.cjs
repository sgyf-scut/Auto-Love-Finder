const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
require('./setup.cjs')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService, extractConversationName, isLegacyConversationName, resolveConversationName,
  reconcileConversationContacts, renameConversationReferences, isConversationTargetMatch, conversationIdentityScript } = require('../electron/automation.cjs')

const name = '测试联系人甲(๑• . •๑)'
const oldName = '测试联系人甲(๑•\u00a0.\u00a0•๑) 8 13:12哇塞这个可以啊'

function row({ nickname = name, preview = '最新消息已经变了', flat = true, active = false } = {}) {
  return {
    innerText: flat ? `${nickname} 8 14:21${preview}` : `${nickname}\n8\n14:21\n${preview}`,
    className: `conversationConversationItemwrapper${active ? ' active' : ''}`,
    children: [], getAttribute: () => null,
    querySelector(selector) {
      if (selector.includes('conversationConversationItemtitle')) return { textContent: nickname }
      if (selector === 'img') return { src: 'https://avatar.example/1' }
      if (selector.includes('ConversationItemHinttextBox')) return { textContent: preview }
      if (selector.includes('commonStreaknormalText')) return { textContent: '8' }
      if (selector.includes('[class*="time"')) return { textContent: '14:21' }
      return null
    },
    scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 10, y: 60, left: 10, top: 60, width: 180, height: 60 }),
  }
}

test('nickname element is stable when hidden row text flattens or preview changes', () => {
  for (const flat of [true, false]) {
    assert.equal(extractConversationName(row({ flat, nickname: name.replace(/ /g, '\u00a0') })), name)
    assert.equal(extractConversationName(row({ flat, preview: '13:12其他消息' })), name)
  }
})

test('fallback respects multiline nickname, but rejects flat metadata without a title', () => {
  assert.equal(extractConversationName({ innerText: `${name}\n8\n13:12\nhello`, querySelector: () => null }), name)
  assert.equal(extractConversationName({ innerText: `${name} 8 13:12hello`, querySelector: s => s.includes('ConversationItemHint') ? {} : null }), '')
  assert.equal(extractConversationName(row({ nickname: '朋友 8 👩‍💻 (๑• . •๑)' })), '朋友 8 👩‍💻 (๑• . •๑)')
})

test('legacy repair requires a metadata suffix, and refuses ambiguous nickname prefixes', () => {
  assert.equal(isLegacyConversationName(oldName, name), true)
  assert.equal(isLegacyConversationName(`${name}的姐姐`, name), false)
  assert.equal(isLegacyConversationName(`${name} 8号`, name), false)
  assert.equal(resolveConversationName(oldName, [{ name }]), name)
  assert.equal(resolveConversationName('测试联系人', [{ name: '测试联系人甲' }]), '测试联系人')
  assert.equal(resolveConversationName('朋友 8 13:12hello', [{ name: '朋友' }, { name: '朋友 8' }]), '朋友 8 13:12hello')
})

test('repair preserves profile, memory and hidden contacts without duplicate old records', () => {
  const old = { id: oldName, name: oldName, avatar: 'a', profile: { relationship: '好朋友' }, learning: { messages: [{ role: 'me', text: '你好' }], facts: [{ text: '喜欢猫' }] }, turn: { lastOutgoingAt: 20, lastHandledKey: 'handled' } }
  const current = { name, avatar: 'a', profile: { call: '测试联系人' }, learning: { messages: [{ role: 'contact', text: '在吗' }] } }
  const hidden = { name: '未加载朋友', profile: { notes: '不要丢失' } }
  const result = reconcileConversationContacts([old, current, hidden], [{ id: name, name, avatar: 'a', preview: '新消息' }])
  assert.equal(result.contacts.length, 2)
  assert.equal(result.renamed[oldName], name)
  const fixed = result.contacts[0]
  assert.equal(fixed.id, name)
  assert.deepEqual(fixed.profile, { relationship: '好朋友', call: '测试联系人' })
  assert.equal(fixed.learning.messages.length, 2)
  assert.equal(fixed.learning.facts[0].text, '喜欢猫')
  assert.equal(fixed.turn.lastHandledKey, 'handled')
  assert.deepEqual(result.contacts[1], hidden)
})

test('mismatching avatars do not silently merge contacts', () => {
  const result = reconcileConversationContacts([{ name: oldName, avatar: 'old' }], [{ name, avatar: 'different' }])
  assert.equal(result.contacts.length, 2)
  assert.deepEqual(result.renamed, {})
})

test('rotating CDN hosts and signatures for the same avatar do not block repair', () => {
  const result = reconcileConversationContacts([
    { name: oldName, avatar: 'https://cdn-a.example/avatar/asset.jpg?token=old', profile: { call: '测试联系人' } },
  ], [{ name, avatar: 'https://cdn-b.example/avatar/asset.jpg?token=new' }])
  assert.equal(result.contacts.length, 1)
  assert.equal(result.contacts[0].profile.call, '测试联系人')
  assert.equal(result.renamed[oldName], name)
})

test('name-based limits, drafts and scheduled tasks migrate, while message text stays untouched', () => {
  const state = { automation: { autoReply: false, blacklist: [oldName], aiDisabledContacts: [oldName], sparks: [{ name: oldName, message: oldName }] }, pendingDrafts: [{ name: oldName, text: oldName }], sendHistory: [{ name: oldName, text: 'hi' }], lastSeenPairs: [{ name: oldName }], lastSentPairs: [{ name: oldName }], proactiveState: { sentContacts: [oldName] } }
  const patch = renameConversationReferences(state, { [oldName]: name })
  assert.equal(patch.automation.autoReply, false)
  assert.deepEqual(patch.automation.blacklist, [name])
  assert.deepEqual(patch.automation.aiDisabledContacts, [name])
  assert.equal(patch.automation.sparks[0].name, name)
  assert.equal(patch.automation.sparks[0].message, oldName)
  assert.equal(patch.pendingDrafts[0].name, name)
  assert.equal(patch.pendingDrafts[0].text, oldName)
  assert.deepEqual(patch.proactiveState.sentContacts, [name])
})

function fixture(rows, storage) {
  const editor = { getBoundingClientRect: () => ({ left: 300, width: 600 }) }
  const wrapper = { querySelectorAll: () => rows }
  const header = { textContent: name, getBoundingClientRect: () => ({ left: 400, top: 20, width: 200, height: 30 }) }
  const document = {
    querySelector(selector) {
      if (selector.includes('conversationConversationListwrapper')) return wrapper
      if (selector.includes('messageEditorimChatEditorContainer')) return editor
      return null
    },
    querySelectorAll: () => [header],
  }
  const win = { webContents: {
    executeJavaScript: async script => vm.runInNewContext(script, { document }),
    sendInputEvent: () => { throw new Error('Should already be in the exact selected conversation') },
  } }
  const ds = new DouyinService({ storage, emit: () => {}, ai: {} })
  ds.waitForChatReady = async () => win
  return { ds, win }
}

test('real injected sync script extracts nickname and migrates saved data', async () => {
  const storage = createMemoryStorage({ contacts: [{ name: oldName, avatar: 'https://avatar.example/1', profile: { relationship: '好朋友' } }] })
  const { ds } = fixture([row()], storage)
  const result = await ds.syncContacts()
  assert.equal(result.contacts.length, 1)
  assert.equal(result.contacts[0].name, name)
  assert.equal(result.contacts[0].profile.relationship, '好朋友')
  assert.equal(result.contacts[0].preview, '最新消息已经变了')
})

test('real injected selection recognizes exact active nickname despite flattened preview', async () => {
  const storage = createMemoryStorage({ contacts: [{ name }] })
  const { ds, win } = fixture([row({ active: true })], storage)
  assert.equal(await ds.selectConversation(oldName), win)
})

test('recipient matching normalizes NBSP but rejects partial names and missing identity', () => {
  assert.equal(isConversationTargetMatch(name, '', name.replace(/ /g, '\u00a0')), true)
  assert.equal(isConversationTargetMatch('测试联系人', '', '测试联系人甲'), false)
  assert.equal(isConversationTargetMatch(name, '', name + '的姐姐'), false)
  assert.equal(isConversationTargetMatch(name, '别人', [name]), false)
  assert.equal(isConversationTargetMatch(name, '', ''), false)
  assert.equal(isConversationTargetMatch(name, '', [name, '别人']), false)
})

test('actual send guard accepts the normalized nickname without including messages or streak', async () => {
  const { ds, win } = fixture([row({ active: true, nickname: name.replace(/ /g, '\u00a0') })], createMemoryStorage({ contacts: [{ name }] }))
  const identity = await ds.assertConversationTarget(win, name)
  assert.equal(identity.isTargetMatch, true)
  assert.equal(identity.activeName, name)
  assert.equal(identity.headerText, name)
})

test('send guard blocks other recipients, unknown pages and JavaScript failures', async () => {
  const { ds, win } = fixture([row({ active: true, nickname: '其他人' })], createMemoryStorage({ contacts: [{ name }] }))
  await assert.rejects(ds.assertConversationTarget(win, name), /阻止错发/)
  win.webContents.executeJavaScript = async () => ({ activeName: '', headerText: '', isTargetMatch: false })
  await assert.rejects(ds.assertConversationTarget(win, name), /无法识别当前联系人/)
  win.webContents.executeJavaScript = async () => { throw new Error('页面无法读取') }
  await assert.rejects(ds.assertConversationTarget(win, name), /无法核实联系人/)
})

test('chat-body containers are excluded even when their text contains the target nickname', () => {
  const body = { textContent: name + '\n8\n所有聊天内容', getBoundingClientRect: () => ({ left: 400, top: 50, width: 600, height: 500 }) }
  const title = { textContent: name.replace(/ /g, '\u00a0'), getBoundingClientRect: () => ({ left: 400, top: 20, width: 200, height: 30 }) }
  const document = { querySelector: () => null, querySelectorAll: selector => selector.includes('[class~="RightPanelHeadertitle"]') ? [title] : [body] }
  const identity = vm.runInNewContext(conversationIdentityScript(name), { document })
  assert.equal(identity.isTargetMatch, true)
  assert.equal(identity.headerText, name)
  document.querySelectorAll = () => []
  assert.equal(vm.runInNewContext(conversationIdentityScript(name), { document }).isTargetMatch, false)
})
