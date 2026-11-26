const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { FriendshipService, strangerChatSnapshot, profileSnapshot } = require('../electron/friendship.cjs')
const { AiService } = require('../electron/ai-service.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { AutoFriendshipService } = require('../electron/auto-friendship.cjs')
const { quietNow } = require('../electron/social-brain/proactive-engine.cjs')
const { ContactEngine } = require('../electron/contact-engine.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const url = 'https://www.douyin.com/user/MS4w-test'
const name = '测试朋友'
function fixture({ id = 'MS4w-test', nickname = name, draft = '', privateButtons = 1 } = {}) {
  const calls = { clicks: 0, opened: 0, inserted: [], deleted: 0 }
  const visible = { getBoundingClientRect: () => ({ width: 100, height: 40, left: 10, top: 10 }), getAttribute: () => null }
  const privateControls = Array.from({ length: privateButtons }, () => ({ ...visible, innerText: '私信', contains: () => false, click: () => calls.opened++ }))
  const header = { ...visible, innerText: name, querySelector: () => ({ innerText: name }), parentElement: { parentElement: { querySelectorAll: () => privateControls } } }
  const title = { ...visible, innerText: nickname, __reactPropsTest: { curConversation: { toParticipantSecUserId: id } } }
  const editor = { ...visible, innerText: draft, focus() {} }
  const outgoing = []
  const send = { ...visible, contains: () => false, dispatchEvent() { calls.clicks++; outgoing.push({ innerText: editor.innerText, closest: () => ({ classList: { contains: () => true } }) }); editor.innerText = '' } }
  const document = {
    body: { innerText: '' }, defaultView: {},
    querySelector(selector) { return selector.includes('user-info') ? header : editor },
    querySelectorAll(selector) {
      if (selector.includes('captcha')) return []
      if (selector.includes('StackLayoutStackChatHeadertitle')) return [title]
      if (selector.includes('contenteditable')) return [editor]
      if (selector.includes('MessageBoxContentrowBox')) return outgoing
      return [send]
    },
  }
  const context = vm.createContext({ document, location: new URL(url), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MouseEvent: class {} })
  const win = { show() {}, isDestroyed: () => false, webContents: {
    focus() {}, selectAll() {}, sendInputEvent(event) {
      if (event.type === 'keyDown' && event.keyCode === 'Backspace') { editor.innerText = ''; calls.deleted++ }
      // 私信入口现在是主进程发真实鼠标事件（脚本只给坐标），用 mouseUp 统计"点过入口"。
      if (event.type === 'mouseUp' && event.button === 'left') calls.opened++
    },
    async insertText(text) { calls.inserted.push(text); editor.innerText += text },
    async executeJavaScript(script) { return vm.runInContext(script, context) },
  } }
  return { win, calls, title, editor, context }
}
function harness(options = {}) {
  const dom = fixture(options), storage = createMemoryStorage({ selfPersona: { name: '本人', interests: '宠物' }, providers: [{}], friendship: { followed: [], automatic: { enabled: true } } })
  const sends = [], records = []
  const douyin = { storage, polling: false, lastSent: new Map(), lastSeen: new Map(), lastReplyTime: new Map(),
    log() {}, emitEvent() {}, assertCanSend() {}, getSendAllowance: () => ({ ok: true }),
    sendCurrentInput: (...args) => DouyinService.prototype.sendCurrentInput.call({}, ...args),
    recordSuccessfulSend(n, kind) { sends.push({ n, kind }); storage.update({ sendHistory: [...storage.get().sendHistory, { name: n, at: new Date().toISOString() }] }) },
    recordConversationMessage(...args) { records.push(args) }, ai: {},
  }
  const friendship = new FriendshipService(douyin)
  friendship.candidates.set(url, { url, name, summary: '宠物爱好者' })
  friendship.ensureWindow = () => dom.win
  friendship.navigate = async () => {}
  friendship.wait = async (win, fn, args) => fn === profileSnapshot ? { ready: true, name, followed: true } : win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`)
  return { ...dom, friendship, storage, douyin, sends, records }
}
test('stranger recipient proof requires both actual profile and active conversation secUid', async () => {
  const h = fixture()
  assert.equal(await h.win.webContents.executeJavaScript(`(${strangerChatSnapshot.toString()})(${JSON.stringify(url)},${JSON.stringify(name)}).ready`), true)
  h.title.__reactPropsTest.curConversation.toParticipantSecUserId = 'someone-else'
  assert.equal(await h.win.webContents.executeJavaScript(`(${strangerChatSnapshot.toString()})(${JSON.stringify(url)},${JSON.stringify(name)}).wrongRecipient`), true)
  assert.equal(h.calls.clicks, 0)
})
test('a matching nickname without user ID cannot authorize stranger sending', async () => {
  const h = fixture({ id: '' })
  assert.equal(await h.win.webContents.executeJavaScript(`(${strangerChatSnapshot.toString()})(${JSON.stringify(url)},${JSON.stringify(name)}).ready`), false)
})
test('stranger private entry refuses ambiguous buttons and changed source profile', async () => {
  for (const privateButtons of [0, 2]) {
    const h = harness({ privateButtons })
    await assert.rejects(h.friendship.greeting(url, '你好'), /私信入口/)
    assert.equal(h.calls.opened + h.calls.clicks, 0)
    assert.equal(h.douyin.friendshipGreetingInProgress, false)
  }
  const h = fixture()
  h.context.location = new URL(url + '-other')
  assert.equal(await h.win.webContents.executeJavaScript(`(${strangerChatSnapshot.toString()})(${JSON.stringify(url)},${JSON.stringify(name)},true).wrongPage`), true)
  assert.equal(h.calls.opened, 0)
})
test('confirmed greeting creates managed friendship contact and records AI origin and quota exactly once', async () => {
  const h = harness()
  let gateChecks = 0
  const result = await h.friendship.greeting(url, '你好，也喜欢宠物呀', { background: true, beforeSubmit() { gateChecks++; assert.equal(h.storage.get().contacts.length, 0) } })
  assert.equal(result.ok, true)
  assert.equal(h.calls.clicks, 1)
  assert.equal(h.calls.opened, 1)
  assert.ok(gateChecks >= 5)
  assert.equal(h.sends.length, 1)
  assert.equal(h.records[0][4].human, false)
  const c = h.storage.get().contacts[0]
  assert.equal(c.profile.autoFriendship, true)
  assert.equal(c.profile.chatMode, 'friendship')
  assert.equal(c.profile.autoFriendshipUrl, url)
  assert.equal(h.douyin.lastSent.get(name), '你好，也喜欢宠物呀')
  assert.equal(h.douyin.friendshipGreetingInProgress, false)
})
test('already-followed candidate can receive the first greeting while background polling is still busy', { timeout: 5000 }, async () => {
  const h = harness()
  h.douyin.polling = true
  h.douyin.runTextSubmission = DouyinService.prototype.runTextSubmission
  const result = await h.friendship.approach({ url, name, text: '你好呀' }, { background: true })
  assert.equal(h.douyin.polling, true)
  assert.equal(result.alreadyFollowed, true)
  assert.equal(h.calls.clicks, 1)
  assert.equal(h.sends.length, 1)
})
test('existing unrelated editor draft is preserved without first greeting or contact creation', async () => {
  const h = harness({ draft: '我自己还没写完' })
  await assert.rejects(h.friendship.greeting(url, '你好'), e => e.sendAttempted === false && /草稿/.test(e.message))
  assert.equal(h.editor.innerText, '我自己还没写完')
  assert.equal(h.calls.inserted.length + h.calls.clicks + h.calls.deleted, 0)
  assert.equal(h.storage.get().contacts.length, 0)
})
test('switching off after native insertion prevents first greeting click and removes only own draft', async () => {
  const h = harness()
  await assert.rejects(h.friendship.greeting(url, '你好', { beforeSubmit() {
    if (h.calls.inserted.length) throw Object.assign(new Error('开关已关闭'), { stopped: true })
  } }), e => e.sendAttempted === false)
  assert.equal(h.calls.clicks, 0)
  assert.equal(h.editor.innerText, '')
  assert.equal(h.storage.get().contacts.length, 0)
})
test('unconfirmed first greeting is uncertain, never records success, and clears in-progress latch', async () => {
  const h = harness()
  h.douyin.sendCurrentInput = async () => { h.calls.clicks++; throw Object.assign(new Error('发送未确认'), { sendAttempted: true }) }
  await assert.rejects(h.friendship.greeting(url, '你好'), e => e.sendAttempted === true)
  assert.equal(h.calls.clicks, 1)
  assert.equal(h.sends.length, 0)
  assert.equal(h.storage.get().contacts.length, 0)
  assert.equal(h.douyin.friendshipGreetingInProgress, false)
})
test('real controller plus browser bridge completes once and never greets the same person again', async () => {
  const h = harness()
  h.storage.update({ friendship: { automatic: { enabled: true, keywords: ['宠物'] } } })
  h.friendship.search = async () => ({ ok: true, candidates: [...h.friendship.candidates.values()] })
  h.friendship.follow = async () => ({ ok: true, candidate: { url, name } })
  h.friendship.opening = async () => ({ ok: true, text: '你好，也喜欢宠物呀' })
  const engine = new AutoFriendshipService({ douyin: h.douyin, friendship: h.friendship, storage: h.storage,
    ai: { hasProvider: () => true, pickFriendCandidate: async () => ({ ok: true, index: 0 }) }, accountId: 'test', clock: () => new Date('2026-10-10T12:00:00+08:00') })
  assert.equal((await engine.runOnce()).greeted, true)
  assert.equal(h.storage.get().friendship.autoState.jobs[0].status, 'greeted')
  await engine.runOnce()
  assert.equal(h.calls.clicks, 1)
})

test('a silent private-entry click is retried once before giving up', async () => {
  const h = harness()
  const realWait = h.friendship.wait
  let panelWaits = 0
  h.friendship.wait = async (win, fn, args) => {
    if (fn === profileSnapshot) return { ready: true, name, followed: true }
    if (++panelWaits <= 2) throw new Error('页面未加载完成或页面结构已变化，请在交友窗口查看后重试')
    return realWait(win, fn, args)
  }
  const result = await h.friendship.greeting(url, '你好，也喜欢宠物呀')
  assert.equal(result.ok, true)
  // 第一次点完 12 秒没打开 → 补点一次，第二次打开后继续发。
  assert.equal(h.calls.opened, 2)
  assert.equal(h.sends.length, 1)
})
test('shared Contact Engine plus real browser greeting verifies identity, sends once, and binds its candidate', async () => {
  const h = harness(), manager = new CandidateManager(h.storage)
  const candidate = manager.upsertUserSearch([{ url, name, summary: '宠物爱好者' }], { accountId: 'test', keyword: '宠物' }).discovery.candidates[0]
  manager.review(candidate.id, { status: 'APPROVED' })
  h.friendship.follow = async (_, options) => { await options.beforeAction(); return { ok: true, candidate: { url, name } } }
  const engine = new ContactEngine({ douyin: h.douyin, friendship: h.friendship, storage: h.storage, accountId: 'test' })
  engine.update({ enabled: true, templates: { default: '你好，也喜欢宠物呀' } }); engine.enqueue(candidate.id)
  const result = await engine.runOnce()
  assert.equal(result.greeted, true, result.error); assert.equal(h.calls.clicks, 1); assert.equal(h.calls.opened, 1)
  assert.equal(manager.get().candidates[0].status, 'WAITING_REPLY')
  const contact = h.storage.get().contacts[0]
  assert.equal(contact.profile.candidateId, candidate.id); assert.equal(contact.profile.contactPipeline, true)
  assert.equal(contact.profile.platformUserId, 'MS4w-test'); assert.equal(contact.profile.dmIdentityVerified, true)
  await engine.runOnce(); assert.equal(h.calls.clicks, 1)
})

test('missing private entry is a known unsubmitted permission failure, ambiguity remains a separate error', async () => {
  const unavailable = harness({ privateButtons: 0 })
  await assert.rejects(unavailable.friendship.greeting(url, '你好'), error => error.code === 'dm_unavailable' && error.sendAttempted === false)
  const ambiguous = harness({ privateButtons: 2 })
  await assert.rejects(ambiguous.friendship.greeting(url, '你好'), error => error.code !== 'dm_unavailable' && error.sendAttempted === false)
  assert.equal(unavailable.calls.clicks + ambiguous.calls.clicks, 0)
})

test('explicit pending follow request is read without another click', async () => {
  const h = fixture(), pending = { innerText: '请求已发送', getBoundingClientRect: () => ({ width: 100, height: 40 }) }
  const original = h.context.document.querySelectorAll
  h.context.document.querySelectorAll = selector => selector.includes('user-info-follow-btn') ? [pending] : original(selector)
  const result = await h.win.webContents.executeJavaScript(`(${profileSnapshot.toString()})(${JSON.stringify(url)},true,${JSON.stringify(name)})`)
  assert.equal(result.followPending, true); assert.equal(result.followed, false); assert.equal(h.calls.clicks, 0)
})
test('model candidate chooser exposes only actual public candidates and rejects invented indexes', async () => {
  let prompt
  const ai = { storage: { get: () => ({}) }, profileChatCompletion: AiService.prototype.profileChatCompletion, assertProfileRevision: AiService.prototype.assertProfileRevision,
    inquiryCompletion: async messages => { prompt = JSON.parse(messages[1].content); return { text: '{"index":0,"reason":"共同宠物兴趣"}' } } }
  const picked = await AiService.prototype.pickFriendCandidate.call(ai, { persona: { interests: '宠物', experiences: '私密经历', examples: '私密话语' }, candidates: [{ url, name, summary: '宠物' }], keyword: '宠物' })
  assert.equal(picked.index, 0)
  assert.equal(JSON.stringify(prompt).includes('私密'), false)
  assert.equal(prompt.candidates[0].url, undefined)
  for (const text of ['{"index":1,"reason":"造一个"}', '{"index":"0","reason":"错误"}', 'not JSON']) {
    ai.inquiryCompletion = async () => ({ text })
    await assert.rejects(AiService.prototype.pickFriendCandidate.call(ai, { candidates: [{ name }] }))
  }
  ai.inquiryCompletion = async () => ({ text: '{"index":-1,"reason":"资料不足"}' })
  assert.equal((await AiService.prototype.pickFriendCandidate.call(ai, { candidates: [{ name }] })).index, -1)
})
test('matching quiet start/end means all-day quiet and blocks independent friendship engine', () => {
  const now = new Date('2026-10-10T12:00:00+08:00')
  assert.equal(quietNow({ quietHours: true, quietStart: '00:00', quietEnd: '00:00' }, now), true)
  const h = harness()
  h.storage.update({ settings: { quietHours: true, quietStart: '00:00', quietEnd: '00:00' } })
  const engine = new AutoFriendshipService({ douyin: h.douyin, friendship: h.friendship, storage: h.storage, ai: {}, clock: () => now })
  assert.equal(engine.gate().code, 'quiet')
})
