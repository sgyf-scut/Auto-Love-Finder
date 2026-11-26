const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
require('./setup.cjs')
const { createMemoryStorage } = require('./setup.cjs')
const { FriendshipService, profileUrl, profileSnapshot, strangerChatSnapshot, searchSnapshot, friendshipPrompt, normalizePersona } = require('../electron/friendship.cjs')
const { migrateLegacy } = require('../electron/storage.cjs')
const { AiService, buildChatPrompt } = require('../electron/ai-service.cjs')
const url = 'https://www.douyin.com/user/MS4w-test'

function button(label) {
  return { innerText: label, disabled: false, clicks: 0, getBoundingClientRect: () => ({ width: 100, height: 30, left: 10, top: 10 }), getAttribute: () => null, contains: () => false, scrollIntoView() {}, click() { this.clicks++ } }
}
function profileDom(controls, currentUrl = url) {
  const header = { innerText: '测试用户\n关注\n1234', getBoundingClientRect: () => ({ width: 100, height: 100 }), querySelector: () => ({ innerText: '测试用户' }), parentElement: { parentElement: { querySelectorAll: () => controls } } }
  return { document: { body: { innerText: header.innerText }, querySelector: () => header, querySelectorAll: selector => selector.includes('user-info-follow-btn') ? controls : [] }, location: new URL(currentUrl) }
}
function snap(controls, click = true, currentUrl = url) {
  return vm.runInNewContext(`(${profileSnapshot.toString()})(${JSON.stringify(url)}, ${click})`, profileDom(controls, currentUrl))
}

test('profile URL canonicalization rejects unrelated hosts, ports and credentials', () => {
  assert.equal(profileUrl(url + '?from=search#x'), url)
  assert.equal(profileUrl(url + '/'), url)
  for (const bad of ['file:///tmp/a', 'http://www.douyin.com/user/a', 'https://evil.com/user/a', 'https://www.douyin.com.evil.com/user/a', 'https://user@www.douyin.com/user/a', 'https://www.douyin.com:123/user/a', 'https://www.douyin.com/search/a']) assert.throws(() => profileUrl(bad))
})
test('clicks only the unique profile follow control', () => {
  const follow = button('关注')
  const result = snap([follow])
  // 脚本只取坐标，真正的鼠标事件由主进程发（isTrusted=true 才能打动 React 按钮）。
  assert.equal(result.point.x, 60)
  assert.equal(result.point.y, 25)
  assert.equal(follow.clicks, 0)
})
test('already-followed profiles are never clicked again', () => {
  for (const state of ['已关注', '互相关注', '相互关注']) {
    const follow = button(state)
    assert.equal(snap([follow]).followed, true)
    assert.equal(follow.clicks, 0)
  }
})
test('wrong profile URL, duplicate buttons and disabled controls cannot follow', () => {
  const first = button('关注'), second = button('关注')
  assert.equal(snap([first], true, url + 'other').wrongPage, true)
  assert.equal(snap([first, second]).canFollow, false)
  first.disabled = true
  assert.equal(snap([first]).canFollow, false)
  assert.equal(first.clicks + second.clicks, 0)
})
test('following-number labels are not follow controls', () => {
  assert.equal(snap([]).canFollow, false)
})
test('server error pages are identified separately from empty search results', () => {
  const result = vm.runInNewContext(`(${searchSnapshot.toString()})()`, { document: { body: { innerText: '502 Bad Gateway\nnginx' } } })
  assert.equal(result.serverError, '502 Bad Gateway')
  assert.equal(result.candidates.length, 0)
})
test('search excludes self and deduplicates profile URLs without query parameters', () => {
  const anchors = [
    { href: 'https://www.douyin.com/user/self', innerText: '本人' },
    { href: url + '?from=search', innerText: '测试用户\n抖音号: test\n篮球爱好者' },
    { href: url, innerText: '重复' },
  ].map(item => ({ ...item, getBoundingClientRect: () => ({ width: 100, height: 30 }), querySelector: () => null, getAttribute: () => null }))
  const result = vm.runInNewContext(`(${searchSnapshot.toString()})()`, { URL, document: { body: { innerText: '' }, querySelectorAll: selector => selector.includes('a[href') ? anchors : [] }, location: { href: 'https://www.douyin.com/search/test?type=user' } })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].name, '测试用户')
  assert.equal(result.candidates[0].url, url)
  assert.match(result.candidates[0].summary, /篮球爱好者/)
})
function service() {
  const storage = createMemoryStorage({ selfPersona: { name: '示例用户', interests: '篮球' }, friendship: { followed: [] } })
  const friend = new FriendshipService({ storage, partition: 'test', log() {}, ai: {} })
  friend.candidates.set(url, { url, name: '测试用户' })
  const events = []
  const win = { show() {}, focus() {}, isDestroyed: () => false, loadURL: async () => {}, webContents: {
    focus() {},
    sendInputEvent: event => events.push(event),
    executeJavaScript: async () => ({ ready: true, point: { x: 60, y: 25 }, hitSelf: true }),
  } }
  friend.ensureWindow = () => win
  return { friend, storage, win, events }
}
test('follow is persisted only after successful DOM confirmation', async () => {
  const { friend, storage, events } = service()
  let reads = 0
  friend.wait = async () => ++reads === 1 ? { ready: true, canFollow: true } : { ready: true, followed: true, name: '测试用户' }
  const result = await friend.follow(url)
  assert.equal(result.ok, true)
  // 真实鼠标事件三连：move → down → up，坐标来自页面元素。
  assert.deepEqual(events.map(item => item.type), ['mouseMove', 'mouseDown', 'mouseUp'])
  assert.equal(events[1].x, 60)
  assert.equal(storage.get().friendship.followed.length, 1)
  friend.wait = async () => ({ ready: true, followed: true })
  const repeated = await friend.follow(url)
  assert.equal(repeated.alreadyFollowed, true)
  assert.equal(storage.get().friendship.followed.length, 1)
})
test('failed confirmation never records a successful follow', async () => {
  const { friend, storage } = service()
  let reads = 0
  friend.wait = async () => { if (++reads === 1) return { ready: true, canFollow: true }; throw new Error('确认失败') }
  await assert.rejects(friend.follow(url), /确认失败/)
  assert.equal(storage.get().friendship.followed.length, 0)
  assert.equal(friend.busy, false)
})
test('blocked follow control is never clicked blindly', async () => {
  const { friend, events } = service()
  friend.wait = async () => ({ ready: true, canFollow: true })
  friend.ensureWindow().webContents.executeJavaScript = async () => ({ ready: true, point: { x: 60, y: 25 }, hitSelf: false })
  await assert.rejects(friend.follow(url), /遮挡/)
  assert.equal(events.length, 0)
})
test('a silent first click is retried once while the control still says 关注', async () => {
  const { friend, storage, events } = service()
  let waits = 0
  friend.wait = async () => {
    waits++
    if (waits === 1) return { ready: true, canFollow: true }
    if (waits === 2) throw new Error('页面未加载完成或页面结构已变化，请在交友窗口查看后重试')
    return { ready: true, followed: true, name: '测试用户' }
  }
  const result = await friend.follow(url)
  assert.equal(result.ok, true)
  assert.equal(events.filter(event => event.type === 'mouseUp').length, 2)
  assert.equal(storage.get().friendship.followed.length, 1)
})
test('a filled chat editor without data-placeholder still proves the recipient', () => {
  // 抖音的输入框只有为空时才带 data-placeholder；写完第一句后属性被移除。
  // 身份校验不能因此把"自己的输入"误判成"对象已改变"（P2-17B.4 实测）。
  const header = { innerText: '测试用户', getBoundingClientRect: () => ({ width: 100, height: 100 }), querySelector: () => ({ innerText: '测试用户' }) }
  const titleNode = { innerText: '测试用户', getBoundingClientRect: () => ({ width: 100, height: 30 }), getAttribute: () => '',
    __reactPropsTest: { curConversation: { toParticipantSecUserId: 'MS4w-test' } } }
  const editor = { getBoundingClientRect: () => ({ width: 200, height: 40 }) }
  const document = {
    body: { innerText: '' },
    querySelector: () => header,
    querySelectorAll(selector) {
      if (selector.includes('captcha')) return []
      if (selector.includes('StackLayoutStackChatHeadertitle')) return [titleNode]
      // 编辑器容器里的可编辑节点（与真实页面对齐）：即使 data-placeholder 已被移除也能命中。
      if (selector.includes('messageEditorimChatEditorContainer"] [contenteditable')) return [editor]
      if (selector.includes('data-placeholder')) return []
      if (selector.includes('messageEditorimChatEditorContainer')) return []
      return []
    },
  }
  const result = vm.runInNewContext(`(${strangerChatSnapshot.toString()})(${JSON.stringify(url)}, '测试用户')`, { document, location: new URL(url) })
  assert.equal(result.ready, true)
  assert.equal(result.platformUserId, 'MS4w-test')
})
test('pause, unknown candidates and concurrent operations block mutations', async () => {
  const { friend, storage } = service()
  await assert.rejects(friend.follow(url + 'unknown'), /先搜索/)
  storage.update({ automation: { paused: true } })
  await assert.rejects(friend.follow(url), /暂停/)
  friend.busy = true
  await assert.rejects(friend.open(url), /进行中/)
  assert.equal(storage.get().friendship.followed.length, 0)
})
test('pausing while a profile loads stops the follow click', async () => {
  const { friend, storage, win } = service()
  friend.navigate = async () => {} // This fixture targets the later profile-wait pause boundary.
  let clicked = false
  win.webContents.executeJavaScript = async () => { clicked = true; return { clicked: true } }
  friend.wait = async () => { storage.update({ automation: { paused: true } }); return { ready: true, canFollow: true } }
  await assert.rejects(friend.follow(url), /暂停/)
  assert.equal(clicked, false)
})
test('search retries a transient gateway failure once without following anyone', async () => {
  const { friend, win, storage } = service()
  let reads = 0, navigations = 0
  win.loadURL = async () => { navigations++ }
  friend.wait = async () => {
    if (++reads === 1) { const error = new Error('502'); error.transient = true; throw error }
    return { candidates: [{ url, name: '测试用户' }] }
  }
  const result = await friend.search('篮球')
  assert.equal(navigations, 2)
  assert.equal(result.candidates.length, 1)
  assert.equal(storage.get().friendship.followed.length, 0)
})
test('migration retains persona, follow records and existing contact data', () => {
  const input = { selfPersona: { name: '示例用户', interests: '篮球', city: '' }, friendship: { followed: [{ url, name: '测试用户' }, { url: 'file:///a' }] }, contacts: [{ name: '老朋友', profile: { examples: ['好嘞'] }, learning: { facts: ['爱喝茶'] } }], automation: { autoReply: true } }
  const state = migrateLegacy(input)
  assert.equal(state.selfPersona.name, '示例用户')
  assert.equal(state.selfPersona.city, '')
  assert.equal(state.friendship.followed.length, 1)
  assert.deepEqual(state.contacts[0].learning.facts, ['爱喝茶'])
  assert.equal(state.automation.autoReply, true)
})
test('new-friend prompts use only the self persona and avoid familiar-friend framing', () => {
  const prompt = buildChatPrompt({ name: '新人', profile: { useSelfPersona: true }, _selfPersona: { name: '示例用户', interests: '篮球' }, learning: {} }, '你好')
  assert.match(prompt, /示例用户/)
  assert.match(prompt, /篮球/)
  assert.match(prompt, /起初不认识/)
  assert.doesNotMatch(prompt, /正在和一位熟人/)
  assert.match(friendshipPrompt({}, { name: '新人' }, { opening: true }), /第一次主动打招呼/)
  assert.equal(normalizePersona({ name: ' x ', ignored: 'secret' }).name, 'x')
  assert.equal(normalizePersona({}).city, '')
})
test('AI opening uses the configured persona without importing other contacts', async () => {
  const storage = createMemoryStorage({ providers: [{}], contacts: [{ name: '旧友', profile: { notes: 'OTHER_CONTACT_SECRET' } }] })
  const ai = new AiService(storage)
  let messages
  ai.inquiryCompletion = async (items, options) => { messages = items; return { text: options.structuredJson ? JSON.stringify({ plan: { shouldReply: true, action: 'ACK', goal: '顺着篮球话题开场', selectedTopic: '篮球' }, learning: { enabled: false }, observations: {}, advisor: { needed: false } }) : '你也喜欢篮球呀', model: 'test' } }
  const result = await ai.draftFriendOpening({ persona: { interests: '篮球' }, candidate: { name: '新朋友' } })
  assert.equal(result.text, '你也喜欢篮球呀')
  assert.doesNotMatch(JSON.stringify(messages), /OTHER_CONTACT_SECRET/)
  ai.inquiryCompletion = async () => ({ text: '' })
  await assert.rejects(ai.draftFriendOpening({}), /没有返回有效/)
})

test('opening style rules: both ban template openings, only guided carries the examples', () => {
  const { openingStyleRules } = require('../electron/ai-service.cjs')
  const guided = openingStyleRules('guided'), free = openingStyleRules('free')
  for (const rules of [guided, free]) {
    assert.match(rules, /看到你/)
    assert.match(rules, /12到40/)
    assert.match(rules, /最多一个问题/)
  }
  assert.match(guided, /刷到半夜/)
  assert.doesNotMatch(free, /刷到半夜/)
})
test('approach preview skips the doomed V3 path and alternates guided/free styles', async () => {
  const { friend } = service()
  friend.douyin.ai.draftFriendOpening = async () => { throw new Error('V3 编排链不该再被首句调用') }
  const seen = []
  friend.douyin.ai.draftRelationshipMessageLegacy = async args => {
    assert.equal(args.opening, true)
    assert.ok(['guided', 'free'].includes(args.openingStyle))
    seen.push(args.openingStyle)
    return { ok: true, text: `草稿${seen.length}` }
  }
  const result = await friend.approachPreview({ url, name: '测试用户', commentText: '在找搭子' })
  assert.equal(result.text, '草稿1')
  assert.ok(['guided', 'free'].includes(result.style))
  await friend.approachPreview({ url, name: '测试用户', commentText: '在找搭子' })
  assert.equal(seen.length, 2)
})
test('approach preview retries once with the other style before surfacing the error', async () => {
  const { friend } = service()
  friend.douyin.ai.draftFriendOpening = async () => { throw new Error('V3 编排链不该再被首句调用') }
  const seen = []
  friend.douyin.ai.draftRelationshipMessageLegacy = async args => { seen.push(args.openingStyle); throw new Error('生成失败') }
  await assert.rejects(friend.approachPreview({ url, name: '测试用户' }), /生成失败/)
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
})
test('nickname comparison ignores emoji variation selectors and zero-width characters', () => {
  const follow = button('关注')
  const run = expected => vm.runInNewContext(`(${profileSnapshot.toString()})(${JSON.stringify(url)}, false, ${JSON.stringify(expected)})`, profileDom([follow]))
  assert.equal(run('测试\u200B用\uFEFF户').wrongPage, undefined)
  assert.equal(run('测试用户\uFE0F').ready, true)
  assert.equal(run('别人家的昵称').ready, false)
  assert.equal(run('别人家的昵称').reason, 'identity_loading')
  assert.equal(run('别人家的昵称').nameMismatch, true)
})

// 三态显示的前提：approach 必须把「关注阶段」和「私信阶段」的失败分开标记，
// 且动作已发出但没确认时标成结果待核实，供上层暂停自动重发。
test('approach 按阶段分开标记关注失败与私信失败', async () => {
  const { friend } = service()
  const payload = { url, name: '测试用户', text: '你好，想认识一下' }
  friend.followCandidate = async () => { throw new Error('未找到唯一可用的关注按钮') }
  await assert.rejects(friend.approach(payload), error => {
    assert.equal(error.contactStage, 'follow')
    assert.equal(error.followConfirmed, false)
    assert.equal(error.outcomeUncertain, undefined)
    return true
  })
  friend.followCandidate = async () => ({ ok: true, followed: true, followPending: false })
  friend.greetingCandidate = async () => { throw new Error('私信面板没有打开') }
  await assert.rejects(friend.approach(payload), error => {
    assert.equal(error.contactStage, 'greeting')
    assert.equal(error.followConfirmed, true)
    return true
  })
})

test('approach 把「动作已发出但没确认」标成结果待核实', async () => {
  const { friend } = service()
  const payload = { url, name: '测试用户', text: '你好' }
  friend.followCandidate = async () => { throw Object.assign(new Error('关注状态没等到'), { followAttempted: true }) }
  await assert.rejects(friend.approach(payload), error => {
    assert.equal(error.contactStage, 'follow')
    assert.equal(error.outcomeUncertain, true)
    return true
  })
  friend.followCandidate = async () => ({ ok: true, followed: true, followPending: false })
  friend.greetingCandidate = async () => { throw Object.assign(new Error('发送确认超时'), { sendAttempted: true }) }
  await assert.rejects(friend.approach(payload), error => {
    assert.equal(error.contactStage, 'greeting')
    assert.equal(error.followConfirmed, true)
    assert.equal(error.outcomeUncertain, true)
    return true
  })
})

test('custom goal can draft without a persona and sends the matched comment and instructions to the model', async () => {
  const { friend, storage, events } = service()
  storage.update({ selfPersona: normalizePersona({}), selfProfile: { introductionText: '尚未整理的私密介绍' } })
  const ai = friend.douyin.ai = new AiService(storage)
  let request
  ai.inquiryCompletion = async messages => {
    request = JSON.parse(messages.at(-1).content)
    assert.doesNotMatch(JSON.stringify(messages), /尚未整理的私密介绍/)
    return { text: JSON.stringify({ reply: '我想找人一起开黑，你平时几点上线？' }) }
  }
  assert.ok((await friend.approachPreview({ url, name: '测试用户' })).text)
  const goal = { name: '找游戏搭子', description: '一起打无畏契约', instructions: '用一句话问上线时间' }
  const result = await friend.approachPreview({ url, name: '测试用户', commentText: '晚上缺一', videoTitle: '排位找队友', openingGoal: goal })
  assert.deepEqual(request.openingGoal, goal)
  assert.match(request.publicProfile.summary, /晚上缺一.*排位找队友/)
  assert.equal(result.text, '我想找人一起开黑，你平时几点上线？')
  assert.deepEqual(events, [])
  await ai.draftRelationshipMessageLegacy({ candidate: { name: '测试用户' }, openingGoal: goal })
  assert.equal(Object.hasOwn(request, 'openingGoal'), false)
})
