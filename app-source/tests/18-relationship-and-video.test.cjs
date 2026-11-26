const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { AiService, buildChatPrompt } = require('../electron/ai-service.cjs')
const { isFriendshipContact, factsConversationKey, shouldRefreshFacts } = require('../electron/conversation-modes.cjs')
const { VideoOpeningService, videoUrl, videoSearchSnapshot, composeVideoMessage } = require('../electron/video-openings.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { migrateLegacy } = require('../electron/storage.cjs')
const url = 'https://www.douyin.com/video/1234567890123456789'
const name = '朋友'
const friend = { name, profile: { chatMode: 'friendship', tone: 'PRIVATE_TONE', examples: ['OWNER_CATCHPHRASE'] }, learning: { messages: [{ role: 'contact', text: '我喜欢猫，最近养了一只小猫' }], facts: [] } }

test('explicit old-friend mode wins over legacy persona flag and excludes friendship skill', () => {
  const contact = { ...friend, profile: { ...friend.profile, chatMode: 'oldfriend', useSelfPersona: true } }
  assert.equal(isFriendshipContact(contact), false)
  assert.equal(isFriendshipContact({ profile: { useSelfPersona: true } }), true)
  const skills = [{ name: '军师', target: 'friendship', instruction: 'ADVISOR_SECRET', enabled: true }]
  assert.doesNotMatch(buildChatPrompt(contact, '你好', skills), /ADVISOR_SECRET/)
  assert.match(buildChatPrompt(contact, '你好', skills), /OWNER_CATCHPHRASE/)
})

test('friendship prompt uses factual experiences, contact facts and advisor, never tone examples', () => {
  const contact = { ...friend, _selfPersona: { identity: '大学生', experiences: '昨天去打篮球', examples: 'PRIVATE_EXAMPLE', tone: 'SELF_TONE' } }
  const prompt = buildChatPrompt(contact, '你好', [{ name: '军师', target: 'friendship', instruction: '先接住对方情绪', enabled: true }], { useAdvisor: true })
  assert.match(prompt, /昨天去打篮球/)
  assert.match(prompt, /先接住对方情绪/)
  assert.doesNotMatch(prompt, /PRIVATE_TONE|OWNER_CATCHPHRASE|PRIVATE_EXAMPLE|SELF_TONE/)
})

test('new contact messages trigger memory more than once a day; owner messages do not', () => {
  const today = '2026-10-10'
  const contact = structuredClone(friend)
  assert.equal(shouldRefreshFacts(contact, today), true)
  contact.learning.factsUpdatedAt = today
  contact.learning.factsConversationKey = factsConversationKey(contact)
  assert.equal(shouldRefreshFacts(contact, today), false)
  contact.learning.messages.push({ role: 'me', text: '我的经历不能当成对方事实' })
  assert.equal(shouldRefreshFacts(contact, today), false)
  contact.learning.messages.push({ role: 'contact', text: '我在广州上班' })
  assert.equal(shouldRefreshFacts(contact, today), true)
  assert.equal(shouldRefreshFacts(contact, today, false), false)
  contact.profile.chatMode = 'oldfriend'
  assert.equal(shouldRefreshFacts(contact, today), false)
})

test('relationship plan sends only final reply and preserves contact history', async () => {
  const storage = createMemoryStorage({ contacts: [structuredClone(friend)], selfPersona: { interests: '篮球' } })
  const ai = new AiService(storage)
  let prompts
  let calls = 0
  ai.inquiryCompletion = async (messages, options) => {
    calls++
    prompts = messages
    if (!options.structuredJson) return { text: '你家猫是啥品种呀', model: 'test', aiLabel: 'AI · test' }
    return { text: JSON.stringify({ plan: { shouldReply: true, action: 'FOLLOW_UP', goal: '延续对方明确提到的宠物话题', selectedTopic: '猫' }, learning: { enabled: false }, observations: {}, advisor: { needed: false } }), model: 'test', aiLabel: 'AI · test' }
  }
  const result = await ai.draftRelationshipMessage({ contact: friend, incoming: '我最近养了一只小猫' })
  assert.equal(result.text, '你家猫是啥品种呀')
  assert.equal(calls, 2)
  assert.doesNotMatch(result.labeledText, /topics|对方刚提到|喜欢宠物/)
  assert.match(JSON.stringify(prompts), /篮球/)
  assert.equal(storage.get().contacts[0].learning.messages.length, 1)
  assert.match(storage.get().contacts[0].learning.relationshipPlan.selectedTopic, /小猫/)
  assert.equal(storage.get().contacts[0].learning.relationshipPlan.focusMode, 'RESPOND_FOCUS')
  ai.inquiryCompletion = async () => ({ text: JSON.stringify({ plan: { shouldReply: false, action: 'NO_REPLY', goal: '尊重停止聊天的要求' }, learning: { enabled: false } }) })
  assert.equal((await ai.draftRelationshipMessage({ contact: friend, incoming: '不要再找我了' })).skipped, true)
  assert.equal(storage.get().contacts[0].learning.relationshipPlan.stop, true)
})

test('structured completion preserves long JSON and removes markdown fences', async () => {
  const ai = new AiService(createMemoryStorage({ providers: [{ name: 'test', model: 'test', baseUrl: 'https://example.com/v1' }] }))
  ai.keyFor = () => 'test-key'
  const payload = { topics: [{ reason: '有效依据'.repeat(220) }], reply: '你好' }
  ai.post = async () => ({ choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' } }] })
  const result = await ai.inquiryCompletion([], { structuredJson: true, maxTokens: 1000 })
  assert.deepEqual(JSON.parse(result.text), payload)
  assert.ok(result.text.length > 600)
})

test('new-friend memory rejects invented and owner-sourced evidence, supports explicit correction', async () => {
  const messages = [{ role: 'me', text: '我在北京上班' }, { role: 'contact', text: '我现在搬到广州上班了' }, { role: 'unknown', text: '我喜欢唱歌' }]
  const storage = createMemoryStorage({ contacts: [{ ...friend, learning: { messages, facts: ['在杭州上班', '喜欢猫'] } }] })
  const ai = new AiService(storage)
  ai.inquiryCompletion = async () => { throw new Error('Evidence refresh must not invoke an extra model') }
  const result = await ai.mineFacts({ name, friendship: true, messages, existing: ['在杭州上班', '喜欢猫'] })
  assert.deepEqual(result.facts.map(item => item.text), ['所在城市：广州'])
  assert.equal(result.facts[0].source, 'contact')
  assert.equal(result.facts[0].evidence, messages[1].text)
  assert.deepEqual(storage.get().contacts[0].socialBrain.legacyMemories.map(m => m.content), ['在杭州上班', '喜欢猫'])
})

test('video targets accept only canonical public Douyin URLs and one-line captions', () => {
  assert.equal(videoUrl(url + '?from=search'), url)
  assert.deepEqual(composeVideoMessage(url, '这只猫好可爱'), [url, '这只猫好可爱'])
  for (const bad of ['file:///video/1234567890', 'https://evil.com/video/1234567890', 'https://www.douyin.com/user/abc', 'https://user@www.douyin.com/video/1234567890', 'https://www.douyin.com:8443/video/1234567890']) assert.throws(() => videoUrl(bad))
  for (const caption of ['', 'a'.repeat(81), '第一句\n第二句', '看看 https://evil.com']) assert.throws(() => composeVideoMessage(url, caption))
})

test('video search deduplicates IDs and excludes advertising and other domains', () => {
  const anchors = [
    { href: url + '?from=search', title: '小猫打哈欠好可爱' }, { href: url, title: '重复结果' },
    { href: 'https://www.douyin.com/video/1234567890', title: '购买商品低价团购' },
    { href: 'https://evil.com/video/1234567890', title: '假视频' },
  ].map(item => ({ ...item, getBoundingClientRect: () => ({ width: 120, height: 120 }), closest: () => null, querySelector: () => null, getAttribute: () => item.title, innerText: item.title }))
  const result = vm.runInNewContext(`(${videoSearchSnapshot.toString()})()`, { URL, location: { href: 'https://www.douyin.com/search/猫?type=video' }, document: { body: { innerText: '' }, querySelectorAll: selector => selector.startsWith('a[') ? anchors : [] } })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].url, url)
})

test('video captions quote only captured comments; invalid indexes and unsupported sources fail', async () => {
  const ai = new AiService(createMemoryStorage())
  ai.inquiryCompletion = async () => ({ text: JSON.stringify({ source: 'comment', commentIndex: 0 }) })
  const args = { contact: friend, video: { title: '猫咪' }, context: { videoComments: ['这小家伙怎么这么可爱'] } }
  assert.equal((await ai.draftVideoOpening(args)).text, '评论说：这小家伙怎么这么可爱')
  ai.inquiryCompletion = async () => ({ text: JSON.stringify({ source: 'comment', commentIndex: 10 }) })
  await assert.rejects(ai.draftVideoOpening(args), /不在实际评论/)
  ai.inquiryCompletion = async () => ({ text: JSON.stringify({ source: 'made-up', text: '虚构' }) })
  await assert.rejects(ai.draftVideoOpening(args), /格式无效/)
})

test('search titles exclude duration, like counts and publication age from actual cards', () => {
  const anchor = { href: url, innerText: '合集\n00:25\n17.1万\n降温了，给我一只小猫暖被窝呗！ #萌宠\n@猫咪\n1天前', getBoundingClientRect: () => ({ width: 200, height: 200 }), closest: () => null, querySelector: () => null, getAttribute: () => null }
  const result = vm.runInNewContext(`(${videoSearchSnapshot.toString()})()`, { URL, location: { href: 'https://www.douyin.com/search/猫?type=video' }, document: { body: { innerText: '' }, querySelectorAll: selector => selector.startsWith('a[') ? [anchor] : [] } })
  assert.match(result.candidates[0].title, /^降温了/)
})

function videoService() {
  const item = { id: 'video-1', name, url, text: '这猫好可爱', title: '可爱小猫', category: 'pets' }
  const storage = createMemoryStorage({ contacts: [friend], videoGreetings: { pending: [item], sent: [] } })
  const sends = []
  const service = new VideoOpeningService({ storage, partition: 'test', log() {}, sendMessage: async (...args) => { sends.push(args) } })
  return { service, storage, sends, item }
}

test('video share uses two guarded sends, video first then caption, and records once', async () => {
  const { service, storage, sends, item } = videoService()
  storage.update({ pendingDrafts: [{ id: 'video-1', videoOpeningId: item.id }, { id: 'other' }] })
  assert.equal((await service.send({ id: item.id, text: '这猫挺可爱的' })).ok, true)
  assert.equal(sends.length, 2)
  assert.equal(sends[0][0], name)
  assert.equal(sends[0][1], url)
  assert.equal(sends[1][0], name)
  assert.equal(sends[1][1], '这猫挺可爱的')
  assert.equal(sends[1][2].source, 'video_opening_caption')
  assert.equal(storage.get().videoGreetings.sent.length, 1)
  assert.equal(storage.get().videoGreetings.pending.length, 0)
  assert.equal(storage.get().pendingDrafts.length, 1)
  await assert.rejects(service.send({ id: item.id }), /已发送或失效/)
})

test('paused, blocked, AI-disabled, duplicate and uncertain video shares never send', async () => {
  for (const patch of [{ automation: { paused: true } }, { automation: { blacklist: [name] } }, { automation: { aiDisabledContacts: [name] } }, { videoGreetings: { sent: [{ name, url }] } }, { videoGreetings: { pending: [{ id: 'video-1', name, url, text: '猫咪', status: 'uncertain' }] } }]) {
    const { service, storage, sends } = videoService()
    storage.update(patch)
    await assert.rejects(service.send({ id: 'video-1' }))
    assert.equal(sends.length, 0)
  }
})

test('failed send remains uncertain across restarts and cannot automatically repeat', async () => {
  const { service, storage, item } = videoService()
  let sends = 0
  service.douyin.sendMessage = async () => { sends++; throw new Error('发送确认超时') }
  await assert.rejects(service.send({ id: item.id }), /确认超时/)
  assert.equal(storage.get().videoGreetings.pending[0].status, 'uncertain')
  await assert.rejects(service.send({ id: item.id }), /尚未确认/)
  assert.equal(sends, 1)
  const state = migrateLegacy({ ...storage.get(), videoGreetings: { pending: [{ ...item, status: 'sending' }], sent: [] } })
  assert.equal(state.videoGreetings.pending[0].status, 'uncertain')
})

function createFixture() {
  const { service, storage, item } = videoService()
  storage.update({ videoGreetings: { pending: [], sent: [] } })
  let loaded = ''
  const win = { webContents: { executeJavaScript: async () => {}, getURL: () => loaded } }
  service.ensureWindow = () => win
  service.navigate = async (_win, destination) => { loaded = destination }
  service.wait = async () => ({ candidates: [{ url, title: '猫咪好可爱', summary: '温暖的宠物日常' }] })
  service.douyin.readVideoCommentContext = async () => ({ videoPageTitle: '猫咪好可爱', videoComments: ['猫猫可爱'] })
  service.douyin.ai = { planVideoSearch: async () => ({ category: 'pets' }), selectVideoOpening: async (_contact, candidates) => candidates[0], draftVideoOpening: async () => ({ text: '猫咪好可爱', source: 'reaction' }) }
  return { service, storage, item, win }
}

test('video discovery cannot accept a fabricated AI URL, redirected video or already-shared result', async () => {
  for (const fault of ['fabricated', 'redirect', 'duplicate']) {
    const { service, storage } = createFixture()
    if (fault === 'fabricated') service.douyin.ai.selectVideoOpening = async () => ({ url: 'https://www.douyin.com/video/9999999999' })
    if (fault === 'redirect') service.navigate = async () => {}
    if (fault === 'duplicate') storage.update({ videoGreetings: { sent: [{ name, url }] } })
    await assert.rejects(service.create(name))
    assert.equal(storage.get().videoGreetings.pending.length, 0)
    assert.equal(service.busy, false)
  }
})

test('pausing during generation stops new previews; valid previews retain queued drafts', async () => {
  const { service, storage, item } = createFixture()
  const queued = { ...item, url: 'https://www.douyin.com/video/1234567890' }
  storage.update({ videoGreetings: { pending: [queued] }, pendingDrafts: [{ id: queued.id, videoOpeningId: queued.id }] })
  await service.create(name)
  assert.equal(storage.get().videoGreetings.pending.length, 2)
  assert.equal(storage.get().videoGreetings.pending[1].id, queued.id)
  service.douyin.ai.draftVideoOpening = async () => { storage.update({ automation: { paused: true } }); return { text: '猫咪好可爱', source: 'reaction' } }
  service.wait = async () => ({ candidates: [{ url: 'https://www.douyin.com/video/12345678901234', title: '另外一只猫咪', summary: '宠物日常' }] })
  await assert.rejects(service.create(name), /暂停/)
  assert.equal(storage.get().videoGreetings.pending.length, 2)
})

test('new-friend proactive skips refusal or unanswered messages while old-friend behavior is kept', async () => {
  const settings = { proactiveChat: { enabled: true, windowStart: '00:00', windowEnd: '00:00', sendToDraft: true, openingType: 'text' } }
  for (const contact of [{ ...friend, learning: { relationshipPlan: { stop: true } } }, { ...friend, learning: { messages: [{ role: 'me', text: '你好呀' }] } }]) {
    const storage = createMemoryStorage({ contacts: [contact], settings })
    let calls = 0
    const douyin = new DouyinService({ storage, ai: { draftCompanionMessage: async () => { calls++; return { ok: true, text: '你好呀' } } } })
    await douyin.processProactiveChats(new Date(), new Set(), new Set())
    assert.equal(calls, 0)
  }
})

test('proactive video draft queues link and caption without sending; direct mode sends once', async () => {
  for (const sendToDraft of [true, false]) {
    const contact = { ...friend, profile: { chatMode: 'oldfriend' } }
    const storage = createMemoryStorage({ contacts: [contact], settings: { proactiveChat: { enabled: true, windowStart: '00:00', windowEnd: '00:00', sendToDraft, openingType: 'video' } } })
    let sends = 0, creates = 0
    const douyin = new DouyinService({ storage, ai: {} })
    douyin.videoOpenings = { create: async () => { creates++; return { video: { id: 'video-1', name, url, title: '宠物', text: '好可爱' } } }, send: async () => { sends++; return { ok: true } } }
    await douyin.processProactiveChats(new Date(), new Set(), new Set())
    assert.equal(creates, 1)
    assert.equal(sends, sendToDraft ? 0 : 1)
    assert.equal(storage.get().pendingDrafts.length, sendToDraft ? 1 : 0)
    if (sendToDraft) assert.equal(storage.get().pendingDrafts[0].videoUrl, url)
    assert.equal(storage.get().proactiveState.sentToday, 1)
    await douyin.processProactiveChats(new Date(), new Set(), new Set())
    assert.equal(creates, 1)
  }
})
