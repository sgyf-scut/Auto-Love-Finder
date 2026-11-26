const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { CandidateManager, candidateEligibility } = require('../electron/discovery/candidate-manager.cjs')
const { parseRequirements } = require('../electron/discovery/requirements-parser.cjs')
const { parseFollowerCount, summarizePublicProfile, prioritizeComments, commentAuthorSnapshot, advanceCommentViewport } = require('../electron/discovery/comment-snapshot.cjs')
const { DiscoveryEngine } = require('../electron/discovery/discovery-engine.cjs')
const parsed = patch => ({ targetGender: 'female', requireFollowerLimit: true, followerLimit: 150, requireAgeRange: false, ageMin: 20, ageMax: 30, preferLowerComments: true, preferLowReplies: true, includeReplies: true, keywords: [], unsupported: [], ...patch })
const ai = value => ({ inquiryCompletion: async () => ({ text: JSON.stringify(value), model: 'test' }) })
const record = id => ({ nickname: '候选', profileUrl: `https://www.douyin.com/user/${id}`, source: { topic: 'social', keyword: '交友', videoId: '1234', commentId: id, commentText: '一起聊天' } })

test('free text requirements parse into a preview without saving or inventing search keywords', async () => {
  const storage = createMemoryStorage({ discovery: { config: { topics: [{ id: 'pet', label: '宠物', enabled: true, keywords: ['猫'] }] }, candidates: [] } })
  const before = storage.get(), result = await parseRequirements(ai(parsed()), '女生，粉丝少于150，评论往下找，少回复或楼中楼', before.discovery.config)
  assert.equal(result.config.targetGender, 'female'); assert.equal(result.config.followerLimit, 150)
  assert.equal(result.config.includeReplies, true); assert.equal(result.config.preferLowerComments, true)
  assert.deepEqual(result.config.topics[0].keywords, ['猫']); assert.deepEqual(storage.get(), before)
})
test('AI search suggestions cannot replace manual tags or keywords, and unsupported restrictions stay visible', async () => {
  const result = await parseRequirements(ai(parsed({ keywords: ['广州摄影', '广州摄影'], unsupported: ['年龄20至25岁'] })), '广州摄影，20至25岁女生', { videoTags: ['宠物'], videoKeywords: ['猫咪日常'] })
  assert.deepEqual(result.config.videoTags, ['宠物']); assert.deepEqual(result.config.videoKeywords, ['猫咪日常']); assert.deepEqual(result.unsupported, ['年龄20至25岁'])
})
test('invalid AI JSON, unsafe bounds and incomplete conditions cannot relax requirements', async () => {
  for (const value of [null, [], parsed({ followerLimit: -1 }), parsed({ followerLimit: 150.5 }), parsed({ includeReplies: 'yes' }), parsed({ targetGender: 'guessed' }), parsed({ keywords: ['宠物', 123] })]) {
    await assert.rejects(() => parseRequirements(ai(value), '女生少粉丝'), /不完整|越界/)
  }
  await assert.rejects(() => parseRequirements({ inquiryCompletion: async () => ({ text: 'not json' }) }, '女生'), /JSON/)
  await assert.rejects(() => parseRequirements(ai(parsed()), ''), /填写/)
})
test('late AI requirements after service stop do not mutate the current configuration', async () => {
  let done; const pending = new Promise(resolve => { done = resolve })
  const storage = createMemoryStorage(), engine = new DiscoveryEngine({ storage }, { accountId: 'test' })
  const promise = engine.parseRequirements('女生', { inquiryCompletion: () => pending })
  engine.stop(); done({ text: JSON.stringify(parsed()) })
  await assert.rejects(promise, /停止/); assert.equal(engine.manager.get().config.targetGender, 'any')
})
test('followers are taken from the public follower label, including zero and comma separated counts', () => {
  assert.equal(parseFollowerCount('关注\n999\n粉丝\n149\n获赞\n2000'), 149)
  assert.equal(parseFollowerCount('粉丝：0\n'), 0); assert.equal(parseFollowerCount('粉丝\n1,234\n'), 1234)
  assert.equal(parseFollowerCount('粉丝\n1.2万\n'), 12000); assert.equal(parseFollowerCount('粉丝\n0万\n'), null)
  assert.equal(parseFollowerCount('粉丝\n获赞\n123'), null); assert.equal(parseFollowerCount('关注150\n昵称149'), null)
  const summary = summarizePublicProfile({ rawText: '昵称\n性别：女\n粉丝\n16\n获赞\n1900' })
  assert.equal(summary.genderText, '女'); assert.equal(summary.followerCount, 16)
})
test('female and fewer than 150 are strict requirements; unknowns never become matches', () => {
  const config = { targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 }
  const c = (genderText, followerCount) => ({ publicSignals: { genderText, followerCount } })
  assert.equal(candidateEligibility(c('女', 149), config).matches, true)
  assert.equal(candidateEligibility(c('女', 150), config).matches, false)
  assert.equal(candidateEligibility(c('男', 10), config).pending, false)
  assert.equal(candidateEligibility(c(null, 10), config).pending, true)
  assert.equal(candidateEligibility(c('女', null), config).pending, true)
  assert.equal(candidateEligibility(c('女', -1), config).matches, false)
})
test('approval requires verified filters; manual gender stays review evidence and does not become a public fact', () => {
  const storage = createMemoryStorage(), manager = new CandidateManager(storage)
  manager.updateConfig({ targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 })
  const candidate = manager.upsert([record('one')]).discovery.candidates[0]
  assert.throws(() => manager.review(candidate.id, { status: 'APPROVED' }), /女性/)
  assert.throws(() => manager.review(candidate.id, { status: 'APPROVED', genderConfirmation: 'female' }), /粉丝数/)
  assert.equal(manager.get().candidates[0].review.genderConfirmation, undefined)
  const state = manager.get(); state.candidates[0].publicSignals = { followerCount: 149 }; manager.save(state)
  const result = manager.review(candidate.id, { status: 'APPROVED', genderConfirmation: 'female' })
  assert.equal(result.candidate.status, 'APPROVED'); assert.equal(result.candidate.publicSignals.genderText, undefined)
  assert.equal(result.candidate.review.genderConfirmation.source, 'manual'); assert.equal(result.candidate.contact.followStatus, 'not_started')
  assert.equal(manager.upsert([record('one')]).discovery.candidates[0].review.genderConfirmation.value, 'female')
})
test('manual approval cannot override explicit male public data or a 150 follower count', () => {
  const storage = createMemoryStorage(), manager = new CandidateManager(storage)
  manager.updateConfig({ targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 }); const candidate = manager.upsert([record('one')]).discovery.candidates[0]
  for (const publicSignals of [{ genderText: '男', followerCount: 20 }, { genderText: '女', followerCount: 150 }]) {
    const state = manager.get(); state.candidates[0].publicSignals = publicSignals; manager.save(state)
    assert.throws(() => manager.review(candidate.id, { status: 'APPROVED', genderConfirmation: 'female' }), /男性|150/)
  }
})
test('reply and low response priority preserves unknown counts instead of treating them as zero', () => {
  const rows = [{ id: 'popular', replyCount: 200 }, { id: 'unknown', replyCount: null }, { id: 'quiet', replyCount: 0 }, { id: 'reply', isReply: true, replyCount: 0, scrollDepth: 3 }]
  assert.deepEqual(prioritizeComments(rows, { includeReplies: true, preferLowReplies: true, preferLowerComments: true }).map(c => c.id), ['reply', 'quiet', 'unknown', 'popular'])
  assert.equal(prioritizeComments(rows, { includeReplies: false }).some(c => c.isReply), false)
})
test('bounded profile verification records real public facts and keeps all candidates uncontacted', async () => {
  const storage = createMemoryStorage(), engine = new DiscoveryEngine({ storage }, { accountId: 'test' }), visited = []
  engine.updateConfig({ maxVideosPerRun: 1, profileChecksPerRun: 1, targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 })
  engine.ensureWindow = () => ({}); engine.searchTopicVideos = async () => ({ candidates: [{ url: 'https://www.douyin.com/video/1234567890123456789' }] })
  engine.readVideoComments = async () => ({ candidates: ['one', 'two'].map(id => ({ ...record(id), platformUserId: id, commentId: id, commentText: '聊天' })) })
  engine.captureProfile = async (_, id) => { visited.push(id); const state = engine.manager.get(); state.candidates.find(c => c.id === id).publicSignals = { genderText: '女', followerCount: 149 }; engine.manager.save(state) }
  const result = await engine.start()
  assert.equal(result.ok, true); assert.equal(visited.length, 1); assert.equal(result.discovery.candidates.length, 2)
  assert.ok(result.discovery.candidates.every(c => c.status === 'REVIEW_PENDING' && c.contact.followStatus === 'not_started'))
})
test('stop during automatic profile verification cancels later checks and never counts an approval', async () => {
  const storage = createMemoryStorage(), engine = new DiscoveryEngine({ storage }, { accountId: 'test' })
  engine.updateConfig({ maxVideosPerRun: 1, targetGender: 'female' }); engine.ensureWindow = () => ({})
  engine.searchTopicVideos = async () => ({ candidates: [{ url: 'https://www.douyin.com/video/1234567890123456789' }] })
  engine.readVideoComments = async () => ({ candidates: [{ ...record('one'), platformUserId: 'one', commentText: '聊天', commentId: 'one' }] })
  engine.captureProfile = async () => { engine.stop(); throw new Error('ERR_ABORTED') }
  const result = await engine.start(); assert.equal(result.stopped, true); assert.equal(result.discovery.candidates[0].status, 'REVIEW_PENDING')
})
test('comment movement uses only visible expansion buttons and bounds them to two; it never clicks reply or follow controls', () => {
  let clicks = 0, scrolls = 0
  const buttons = Array.from({ length: 4 }, (_, i) => ({ innerText: i === 3 ? '回复' : `展开${i + 1}条回复`, dataset: {}, getBoundingClientRect: () => ({ width: 20, height: 20, top: 20, bottom: 40 }), click: () => { clicks++ } }))
  const list = { querySelectorAll: () => buttons, scrollIntoView() {}, parentElement: null, getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, bottom: 600 }) }
  const result = vm.runInNewContext(`(${advanceCommentViewport.toString()})('1234',{expandReplies:true})`, { location: new URL('https://www.douyin.com/video/1234'), document: { body: {}, querySelector: () => list, querySelectorAll: () => [list] }, window: { innerHeight: 700, scrollBy: () => { scrolls++ } }, getComputedStyle: () => ({ overflowY: 'visible' }) })
  assert.equal(result.expanded, 2); assert.equal(clicks, 2); assert.equal(scrolls, 1)
})

test('reply expansion targets the rendered expansion text because the outside button has no reply handler', () => {
  let opened = 0
  const button = { innerText: '展开1条回复', dataset: {}, getBoundingClientRect: () => ({ width: 80, height: 20, top: 30, bottom: 50 }),
    click() { throw new Error('outside button does not expand replies') }, querySelector: () => ({ click: () => { opened++ } }) }
  const list = { querySelectorAll: () => [button], scrollIntoView() {}, parentElement: null, getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, bottom: 600 }) }
  vm.runInNewContext(`(${advanceCommentViewport.toString()})('1234',{initialize:true,expandReplies:true})`, { location: new URL('https://www.douyin.com/video/1234'), document: { body: {}, querySelector: () => list, querySelectorAll: () => [list] }, window: { innerHeight: 700 }, getComputedStyle: () => ({ overflowY: 'visible' }) })
  assert.equal(opened, 1)
})
