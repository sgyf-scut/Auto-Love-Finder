const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CandidateManager, normalizeDiscovery, canonicalProfile, MAX_CANDIDATES } = require('../electron/discovery/candidate-manager.cjs')
const { normalizeDiscoveryConfig, discoverySearches } = require('../electron/discovery/search-topics.cjs')

test('legacy enabled keywords migrate while tags remain manually specified', () => {
  const config = normalizeDiscoveryConfig({ topics: [{ id: 'pet', label: '宠物', enabled: true, keywords: ['猫', '狗'] }, { id: 'off', label: '停用', enabled: false, keywords: ['忽略'] }] })
  assert.deepEqual(config.videoTags, []); assert.deepEqual(config.videoKeywords, ['猫', '狗'])
  assert.deepEqual(discoverySearches(config).map(item => item.keyword), ['猫', '狗'])
})

test('manual tags and keywords normalize separately and deduplicate effective queries', () => {
  const config = normalizeDiscoveryConfig({ videoTags: '#校园生活，＃宠物\n校园生活', videoKeywords: '大学日常、#宠物;大学日常' })
  assert.deepEqual(config.videoTags, ['校园生活', '宠物']); assert.deepEqual(config.videoKeywords, ['大学日常', '#宠物'])
  assert.deepEqual(discoverySearches(config), [{ topic: 'manual_tags', keyword: '#校园生活' }, { topic: 'manual_tags', keyword: '#宠物' }, { topic: 'manual_keywords', keyword: '大学日常' }])
  assert.deepEqual(discoverySearches({ videoTags: [], videoKeywords: [] }), [])
})

test('manual search settings persist per account without changing candidate decisions or unrelated state', () => {
  const first = harness({ selfPersona: { name: '本人' } }), second = harness()
  const id = first.manager.upsert([record()]).discovery.candidates[0].id
  first.manager.review(id, { status: 'REJECTED', note: '保留意见' })
  first.manager.updateConfig({ videoTags: ['摄影'], videoKeywords: ['夜景'] })
  const reloaded = new CandidateManager(first.storage).get()
  assert.deepEqual(reloaded.config.videoTags, ['摄影']); assert.deepEqual(reloaded.config.videoKeywords, ['夜景'])
  assert.equal(reloaded.candidates[0].review.note, '保留意见'); assert.equal(reloaded.candidates[0].status, 'REJECTED')
  assert.deepEqual(first.storage.get().selfPersona, { name: '本人' }); assert.deepEqual(second.manager.get().config.videoTags, [])
})

const record = (id = 'person-one', patch = {}) => ({ nickname: '同名朋友', profileUrl: `https://www.douyin.com/user/${id}`, source: { topic: 'social', keyword: '交友', videoId: '73123456', videoTitle: '认识朋友', commentId: 'comment-one', commentText: '我也喜欢骑行' }, ...patch })
function harness(initial = {}) {
  let data = structuredClone(initial), writes = 0
  const storage = { get: () => structuredClone(data), update: patch => { writes++; data = { ...data, ...structuredClone(patch) }; return storage.get() } }
  return { storage, manager: new CandidateManager(storage), writes: () => writes }
}

test('discovery defaults enable only social topic and use finite discovery bounds', () => {
  const value = normalizeDiscovery(null)
  assert.equal(value.config.maxVideosPerRun, 3); assert.equal(value.config.commentsPerVideo, 20)
  assert.deepEqual(value.config.topics.filter(item => item.enabled).map(item => item.id), ['social'])
  assert.deepEqual(value.config.topics.map(item => item.label), ['恋爱', '交友', '研究生', '本科生', '脱单'])
  assert.deepEqual(value.candidates, []); assert.deepEqual(value.runState, {})
})
test('config updates preserve pool and unrelated state while users edit keywords and topics', () => {
  const h = harness({ settings: { oldFriendEnabled: true }, providers: ['private'] })
  h.manager.upsert([record()], { accountId: 'account-a' })
  const next = h.manager.updateConfig({ commentsPerVideo: 100, maxVideosPerRun: -3, topics: [{ id: 'custom', label: '宠物', enabled: true, keywords: '猫，狗\n猫' }] })
  assert.equal(next.candidates.length, 1)
  assert.equal(next.config.maxVideosPerRun, 1); assert.equal(next.config.commentsPerVideo, 30)
  assert.deepEqual(next.config.topics[0].keywords, ['猫', '狗'])
  assert.deepEqual(h.storage.get().settings, { oldFriendEnabled: true }); assert.deepEqual(h.storage.get().providers, ['private'])
})
test('config drops invalid and duplicate topics, accepts explicit empty keywords and defaults invalid bounds', () => {
  const config = normalizeDiscoveryConfig({ maxVideosPerRun: null, commentsPerVideo: true, topics: [{ id: 'one', label: '一', enabled: true, keywords: [] }, { id: 'one', label: '重复', enabled: true }, { id: '../oops', label: '无效' }, { id: 'blank', label: '' }] })
  assert.deepEqual(config.topics, [{ id: 'one', label: '一', enabled: true, keywords: [] }])
  assert.equal(config.maxVideosPerRun, 3); assert.equal(config.commentsPerVideo, 20)
})
test('first discovery stores verified sec uid, numeric uid separately and immutable first comment evidence', () => {
  const h = harness(), result = h.manager.upsert([record('MS4w_Test', { platformUserId: 'MS4w_Test', platformNumericUserId: '123456789', profileUrl: 'https://www.douyin.com/user/MS4w_Test/?from=comment#top', avatarUrl: 'https://images.example/avatar.png' })], { accountId: 'account-a' })
  const candidate = result.discovery.candidates[0]
  assert.equal(result.added, 1); assert.equal(candidate.platformUserId, 'MS4w_Test'); assert.equal(candidate.platformUserIdType, 'sec_uid')
  assert.equal(candidate.platformNumericUserId, '123456789'); assert.equal(candidate.profileUrl, 'https://www.douyin.com/user/MS4w_Test')
  assert.equal(candidate.accountId, 'account-a'); assert.equal(candidate.status, 'REVIEW_PENDING'); assert.equal(candidate.review.status, 'pending')
  assert.equal(candidate.contact.status, 'not_started'); assert.equal(candidate.firstComment, '我也喜欢骑行')
  assert.ok(candidate.createdAt && candidate.id)
})
test('same author from different comments and videos merges sources without replacing original evidence', () => {
  const h = harness(); h.manager.upsert([record()])
  const result = h.manager.upsert([record('person-one', { nickname: '改过昵称', source: { topic: 'graduate', keyword: '研究生', videoId: '999999', commentId: 'another', commentText: '最近在准备答辩' } })])
  assert.equal(result.added, 0); assert.equal(result.merged, 1)
  const candidate = result.discovery.candidates[0]
  assert.equal(candidate.nickname, '同名朋友'); assert.equal(candidate.sources.length, 2)
  assert.equal(candidate.source.videoId, '73123456'); assert.equal(candidate.firstComment, '我也喜欢骑行')
})
test('repeated source deduplicates by video/comment id and anonymous comment text within same author', () => {
  const h = harness(), input = record()
  const noCommentId = record('person-one', { source: { ...input.source, commentId: '', commentText: '没有评论ID的原文' } })
  const result = h.manager.upsert([input, input, noCommentId, noCommentId, record('person-one', { source: { ...noCommentId.source, videoId: 'another-video' } })])
  assert.equal(result.added, 1); assert.equal(result.merged, 4)
  assert.equal(result.discovery.candidates[0].sources.length, 3)
})
test('same nickname with different sec uids always remains two independent candidates', () => {
  const h = harness(), result = h.manager.upsert([record('one'), record('two')])
  assert.equal(result.added, 2); assert.equal(result.discovery.candidates.length, 2)
  assert.notEqual(result.discovery.candidates[0].id, result.discovery.candidates[1].id)
})
test('invalid URLs, self profiles, conflicting sec uid and blank evidence do not enter pool', () => {
  const h = harness(), bad = ['https://evil.com/user/a', 'http://www.douyin.com/user/a', 'https://www.douyin.com:8443/user/a', 'https://user:pass@www.douyin.com/user/a', 'https://www.douyin.com/user/self', 'https://www.douyin.com/user/a/more', 'https://www.douyin.com/user/a%2Fb'].map(profileUrl => record('unused', { profileUrl }))
  bad.push(record('one', { platformUserId: 'different' }), record('one', { platformUserIdType: 'uid' }), record('one', { nickname: ' ' }), record('one', { source: {} }), record('one', { source: { ...record().source, commentText: '' } }))
  const result = h.manager.upsert(bad)
  assert.equal(result.invalid, bad.length); assert.equal(result.added, 0); assert.equal(result.discovery.candidates.length, 0)
  assert.equal(canonicalProfile('https://www.douyin.com/user/self'), null)
})
test('untrusted discovered fields cannot overwrite identity, review or contact status', () => {
  const h = harness(), result = h.manager.upsert([record('one', { id: 'fake', status: 'ACTIVE', accountId: 'another', review: { status: 'approved' }, contact: { status: 'sent' }, score: Infinity, signals: ['兴趣来自公开评论', { secret: 'ignored' }], avatarUrl: 'javascript:alert(1)' })], { accountId: 'account-a' })
  const candidate = result.discovery.candidates[0]
  assert.notEqual(candidate.id, 'fake'); assert.equal(candidate.accountId, 'account-a'); assert.equal(candidate.status, 'REVIEW_PENDING')
  assert.equal(candidate.review.status, 'pending'); assert.equal(candidate.contact.status, 'not_started'); assert.equal(candidate.score, null)
  assert.deepEqual(candidate.signals, ['兴趣来自公开评论']); assert.equal(candidate.avatarUrl, '')
})
test('human approvals and rejections remain unchanged on rediscovery and service reload', () => {
  for (const status of ['APPROVED', 'REJECTED']) {
    const h = harness(); const initial = h.manager.upsert([record()]).discovery.candidates[0]
    const decision = h.manager.review(initial.id, { status, note: '已人工看过主页' })
    assert.equal(decision.candidate.status, status)
    const reloaded = new CandidateManager(h.storage), result = reloaded.upsert([record('person-one', { source: { ...record().source, commentId: 'new', commentText: '第二次公开评论' } })])
    assert.equal(result.discovery.candidates[0].status, status); assert.equal(result.discovery.candidates[0].review.note, '已人工看过主页')
    assert.equal(result.discovery.candidates[0].contact.openingStatus, 'not_started')
  }
})
test('review permits deferral and returning to review without performing follow or messaging actions', () => {
  const h = harness(), candidate = h.manager.upsert([record()]).discovery.candidates[0]
  assert.equal(h.manager.review(candidate.id, { status: 'DEFERRED', note: '再看看' }).candidate.review.status, 'deferred')
  const result = h.manager.review(candidate.id, { status: 'REVIEW_PENDING' })
  assert.equal(result.candidate.review.status, 'pending'); assert.equal(result.candidate.contact.followStatus, 'not_started')
  assert.deepEqual(Object.keys(h.storage.get()), ['discovery'])
})
test('unknown review states, nonexistent ids and active contacts cannot reset sending lifecycle', () => {
  const h = harness(), candidate = h.manager.upsert([record()]).discovery.candidates[0]
  assert.throws(() => h.manager.review(candidate.id, { status: 'FOLLOWING' }), /状态/)
  assert.throws(() => h.manager.review('missing', { status: 'APPROVED' }), /找不到/)
  const discovery = h.manager.get(); discovery.candidates[0].status = 'OPENING_SENT'; h.storage.update({ discovery })
  assert.throws(() => h.manager.review(candidate.id, { status: 'REVIEW_PENDING' }), /联系流程/)
  assert.equal(h.manager.get().candidates[0].status, 'OPENING_SENT')
})
test('pool cap stops new identities while retaining reviewed records and merging existing source evidence', () => {
  const h = harness(), many = Array.from({ length: MAX_CANDIDATES }, (_, index) => record(`person-${index}`))
  h.manager.upsert(many)
  const first = h.manager.get().candidates[0]; h.manager.review(first.id, { status: 'REJECTED' })
  const result = h.manager.upsert([record('new-person'), record('person-0', { source: { ...record().source, commentId: 'new-source' } })])
  assert.equal(result.skipped, 1); assert.equal(result.merged, 1); assert.equal(result.discovery.candidates.length, MAX_CANDIDATES)
  assert.equal(result.discovery.candidates[0].status, 'REJECTED'); assert.equal(result.discovery.candidates[0].sources.length, 2)
})
test('pure migration preserves run state, reviewed records and future discovery/contact metadata', () => {
  const h = harness(); h.manager.upsert([record()]); const value = h.manager.get()
  value.extraVersion = 3; value.config.openingMessage = '你好'; value.runState = { status: 'running', accountId: 'account-a', videosVisited: 1 }; value.candidates[0].publicSignals = { city: { raw: '人在杭州', source: 'profile' } }
  value.candidates[0].status = 'MESSAGE_UNCERTAIN'; value.candidates[0].contact = { status: 'uncertain', openingStatus: 'uncertain', token: 'checkpoint' }
  const normalized = normalizeDiscovery(value)
  assert.equal(normalized.extraVersion, 3); assert.deepEqual(normalized.runState, value.runState)
  assert.equal(normalized.config.openingMessage, '你好')
  assert.deepEqual(normalized.candidates[0].publicSignals, value.candidates[0].publicSignals)
  assert.equal(normalized.candidates[0].status, 'MESSAGE_UNCERTAIN'); assert.equal(normalized.candidates[0].contact.token, 'checkpoint')
  assert.equal(normalized.candidates[0].id, value.candidates[0].id)
})
test('safe numeric uid is preserved separately without coercing unsafe numeric identifiers', () => {
  const h = harness(), result = h.manager.upsert([record('one', { platformNumericUserId: 1234567 }), record('two', { platformNumericUserId: Number.MAX_SAFE_INTEGER + 1 })])
  assert.equal(result.discovery.candidates[0].platformNumericUserId, '1234567')
  assert.equal(result.discovery.candidates[1].platformNumericUserId, '')
})
test('legacy duplicate migration combines source history without discarding an explicit rejection', () => {
  const h = harness(); h.manager.upsert([record()]); const first = h.manager.get().candidates[0]
  const second = { ...first, status: 'REJECTED', review: { status: 'rejected', note: '已经拒绝' }, source: { ...first.source, commentId: 'second' }, sources: [] }
  const value = normalizeDiscovery({ candidates: [first, second] })
  assert.equal(value.candidates.length, 1); assert.equal(value.candidates[0].sources.length, 2)
  assert.equal(value.candidates[0].status, 'REJECTED'); assert.equal(value.candidates[0].review.note, '已经拒绝')
})
test('different account ownership is rejected even if a caller reuses a candidate identity', () => {
  const h = harness(); h.manager.upsert([record()], { accountId: 'account-a' })
  const result = h.manager.upsert([record()], { accountId: 'account-b' })
  assert.equal(result.invalid, 1); assert.equal(result.merged, 0); assert.equal(result.discovery.candidates[0].accountId, 'account-a')
})
