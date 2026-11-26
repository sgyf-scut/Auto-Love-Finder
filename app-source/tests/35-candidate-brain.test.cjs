const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { CandidateManager, normalizeDiscovery } = require('../electron/discovery/candidate-manager.cjs')
const { normalizeDiscoveryConfig } = require('../electron/discovery/search-topics.cjs')
const { parseRequirements } = require('../electron/discovery/requirements-parser.cjs')
const { summarizePublicProfile } = require('../electron/discovery/comment-snapshot.cjs')
const { evaluateCandidate } = require('../electron/discovery/candidate-brain.cjs')

const config = { targetGender: 'female', requireFollowerLimit: true, followerLimit: 150, requireAgeRange: true, ageMin: 20, ageMax: 30 }
const comment = id => ({ nickname: '同名朋友', profileUrl: `https://www.douyin.com/user/${id}`, source: { topic: 'social', keyword: '交友', videoId: '123456', commentId: 'first', commentText: '我在读研究生研二，想找摄影搭子一起拍照认识朋友' } })
function harness() { const storage = createMemoryStorage(); return { storage, manager: new CandidateManager(storage) } }
function candidate(patch = {}) { return { id: 'candidate_one', platformUserId: 'one', profileUrl: 'https://www.douyin.com/user/one', nickname: '同名朋友', publicSignals: { genderText: '女', followerCount: 100, age: 25 }, sources: [], ...patch } }

test('legacy candidates migrate with identity, review, source and brain metadata intact', () => {
  const h = harness(); h.manager.upsert(Array.from({ length: 17 }, (_, i) => comment(`person_${i}`)), { accountId: 'default' })
  const discovery = h.manager.get(); discovery.candidates.forEach(candidate => { delete candidate.timeline }); discovery.candidates[0].status = 'REJECTED'; discovery.candidates[0].review.note = '人工决定'; discovery.candidates[0].brain = { score: 55 }
  const migrated = normalizeDiscovery(discovery)
  assert.equal(migrated.candidates.length, 17); assert.deepEqual(migrated.candidates[0].sources, discovery.candidates[0].sources)
  assert.equal(migrated.candidates[0].review.note, '人工决定'); assert.deepEqual(migrated.candidates[0].brain, { score: 55 })
  assert.deepEqual(migrated.candidates[0].timeline, []); assert.equal(migrated.config.requireAgeRange, false)
})

test('user search records merge with comment authors by sec uid while preserving approvals and first evidence', () => {
  const h = harness(); const first = h.manager.upsert([comment('one')], { accountId: 'a' }).discovery.candidates[0]
  h.manager.review(first.id, { status: 'APPROVED', note: '已看过' })
  const result = h.manager.upsertUserSearch([{ url: 'https://www.douyin.com/user/one?source=search', name: '新昵称', summary: '摄影爱好者', keyword: '摄影' }], { accountId: 'a' })
  assert.equal(result.merged, 1); assert.equal(result.added, 0)
  const record = result.discovery.candidates[0]
  assert.equal(record.id, first.id); assert.equal(record.nickname, first.nickname); assert.equal(record.firstComment, first.firstComment)
  assert.equal(record.status, 'APPROVED'); assert.equal(record.review.note, '已看过'); assert.equal(record.sources[1].type, 'user_search')
  assert.equal(h.manager.upsertUserSearch([{ url: record.profileUrl, name: record.nickname, summary: '摄影爱好者', keyword: '摄影' }], { accountId: 'a' }).discovery.candidates[0].sources.length, 2)
})

test('search first candidates retain search summaries and acquire actual comments without inventing comments', () => {
  const h = harness()
  const first = h.manager.upsertUserSearch([{ url: 'https://www.douyin.com/user/one', name: '同名朋友', summary: '在读研二' }], { keyword: '研究生', accountId: 'a' }).discovery.candidates[0]
  assert.equal(first.firstComment, ''); assert.equal(first.source.type, 'user_search'); assert.equal(first.source.keyword, '研究生')
  const record = h.manager.upsert([comment('one')], { accountId: 'a' }).discovery.candidates[0]
  assert.equal(record.sources.length, 2); assert.equal(record.firstComment, comment('one').source.commentText); assert.equal(record.source.type, 'user_search')
})

test('user search rejects conflicting identity, cross-account writes and arbitrary source injection', () => {
  const h = harness(); h.manager.upsertUserSearch([{ url: 'https://www.douyin.com/user/one', name: '人', summary: '公开信息', keyword: '摄影' }], { accountId: 'a' })
  const result = h.manager.upsertUserSearch([{ url: 'https://www.douyin.com/user/one', name: '人', keyword: '摄影' }, { url: 'https://www.douyin.com/user/two', platformUserId: 'conflict', name: '人', keyword: '摄影' }, { url: 'https://evil.com/user/three', name: '人', keyword: '摄影' }], { accountId: 'b' })
  assert.equal(result.invalid, 3); assert.equal(result.discovery.candidates.length, 1)
})

test('migration does not merge same sec uid owned by different accounts', () => {
  const h = harness(); const first = h.manager.upsert([comment('one')], { accountId: 'a' }).discovery.candidates[0]
  const result = normalizeDiscovery({ candidates: [first, { ...first, id: 'other_id', accountId: 'b', review: { status: 'rejected' }, status: 'REJECTED' }] })
  assert.equal(result.candidates.length, 2); assert.equal(result.candidates[0].status, 'REVIEW_PENDING'); assert.equal(result.candidates[1].status, 'REJECTED')
})

test('patch preserves identity and merges contact metadata while accepting new states', () => {
  const h = harness(), first = h.manager.upsert([comment('one')]).discovery.candidates[0]
  for (const key of ['id', 'accountId', 'platformUserId', 'profileUrl', 'nickname', 'sources', 'createdAt']) assert.throws(() => h.manager.patch(first.id, { [key]: 'change' }), /身份|来源/)
  assert.throws(() => h.manager.patch(first.id, { status: 'BOGUS' }), /状态/)
  for (const status of ['CONTACT_QUEUED', 'FOLLOW_PENDING', 'CONTACT_WAITLIST', 'SEND_UNKNOWN', 'PAUSED']) assert.equal(h.manager.patch(first.id, { status, contact: { checkpoint: 'saved' } }).status, status)
  assert.equal(h.manager.get().candidates[0].contact.followStatus, 'not_started'); assert.equal(h.manager.get().candidates[0].contact.checkpoint, 'saved')
})

test('candidate event ledger persists most recent 200 events without resetting lifecycle', () => {
  const h = harness(), first = h.manager.upsert([comment('one')]).discovery.candidates[0]
  h.manager.patch(first.id, { status: 'SEND_UNKNOWN' })
  for (let i = 0; i < 205; i++) h.manager.appendEvent(first.id, 'state', { index: i })
  const record = new CandidateManager(h.storage).get().candidates[0]
  assert.equal(record.timeline.length, 200); assert.equal(record.timeline[0].detail.index, 5); assert.equal(record.timeline.at(-1).detail.index, 204); assert.equal(record.status, 'SEND_UNKNOWN')
  assert.throws(() => h.manager.appendEvent(first.id, ''), /不能为空/)
})

test('discovery and review create truthful timeline events while duplicate sources do not add events', () => {
  const h = harness(), first = h.manager.upsert([comment('one')], { accountId: 'a' }).discovery.candidates[0]
  assert.equal(first.timeline.length, 1); assert.equal(first.timeline[0].type, 'first_discovered')
  assert.deepEqual(first.timeline[0].detail, { sourceType: 'comment', topic: 'social', keyword: '交友' })
  assert.equal(first.timeline[0].at, first.createdAt); assert.equal(first.source.observedAt, first.createdAt)
  h.manager.upsert([comment('one'), comment('one')], { accountId: 'a' })
  assert.equal(h.manager.get().candidates[0].timeline.length, 1)
  h.manager.upsertUserSearch([{ url: first.profileUrl, name: '修改昵称', summary: '真实简介' }], { accountId: 'a', keyword: '摄影' })
  const merged = h.manager.get().candidates[0]
  assert.equal(merged.timeline.length, 2); assert.equal(merged.timeline[1].type, 'source_added')
  assert.equal(merged.sources[1].observedAt, merged.timeline[1].at); assert.equal(merged.source.commentText, first.source.commentText); assert.equal(merged.sources[1].publishedAt, undefined)
  h.manager.review(first.id, { status: 'APPROVED', note: '已确认身份', genderConfirmation: 'female', ageConfirmation: 25 })
  const reviewed = h.manager.get().candidates[0]
  assert.equal(reviewed.timeline.at(-1).type, 'manual_review'); assert.equal(reviewed.timeline.at(-1).detail.status, 'APPROVED')
  assert.equal(reviewed.timeline.at(-1).detail.note, '已确认身份'); assert.equal(reviewed.timeline.at(-1).detail.ageConfirmation, 25)
})

test('failed approval does not create a review event and reads never fabricate legacy discovery timestamps', () => {
  const h = harness(), first = h.manager.upsert([comment('one')]).discovery.candidates[0]
  h.manager.updateConfig({ requireAgeRange: true, ageMin: 20, ageMax: 30 })
  assert.throws(() => h.manager.review(first.id, { status: 'APPROVED' }), /年龄未核实/)
  assert.equal(h.manager.get().candidates[0].timeline.length, 1)
  const legacy = h.manager.get(); delete legacy.candidates[0].timeline; delete legacy.candidates[0].source.observedAt
  legacy.candidates[0].sources.forEach(source => { delete source.observedAt })
  h.storage.update({ discovery: legacy })
  const migrated = h.manager.get().candidates[0]
  assert.deepEqual(migrated.timeline, []); assert.equal(migrated.source.observedAt, undefined)
  assert.deepEqual(h.manager.get().candidates[0].timeline, [])
})

test('brain rejects gender, follower and age limits and keeps missing demographics uncertain', () => {
  for (const publicSignals of [{ genderText: '男', followerCount: 2, age: 25 }, { genderText: '女', followerCount: 150, age: 25 }, { genderText: '女', followerCount: 2, age: 19 }, { genderText: '女', followerCount: 2, age: 31 }]) {
    const result = evaluateCandidate(candidate({ publicSignals }), { config })
    assert.equal(result.eligibility, 'reject'); assert.equal(result.hardGate.passed, false)
  }
  for (const publicSignals of [{ genderText: '女', followerCount: 2 }, { followerCount: 2, age: 25 }, { genderText: '女', age: 25 }]) {
    const result = evaluateCandidate(candidate({ publicSignals }), { config }); assert.equal(result.eligibility, 'uncertain'); assert.equal(result.hardGate.pending, true)
  }
  for (const age of [20, 30]) assert.equal(evaluateCandidate(candidate({ publicSignals: { genderText: '女', followerCount: 149, age } }), { config }).hardGate.passed, true)
})

test('public demographics override conflicting manual confirmations without using pictures', () => {
  const record = candidate({ publicSignals: { genderText: '男', age: 35, followerCount: 10 }, review: { genderConfirmation: { value: 'female', source: 'manual' }, ageConfirmation: { value: 25, source: 'manual' } }, avatarUrl: 'https://images.example/female.jpg' })
  assert.equal(evaluateCandidate(record, { config }).eligibility, 'reject')
  record.publicSignals = { followerCount: 10 }
  assert.equal(evaluateCandidate(record, { config }).hardGate.passed, true)
  record.review = {}; assert.equal(evaluateCandidate(record, { config }).eligibility, 'uncertain')
})

test('manual age approval requires real number and never overwrites public age facts', () => {
  const h = harness(); h.manager.updateConfig({ requireAgeRange: true, ageMin: 20, ageMax: 30 })
  const first = h.manager.upsert([comment('one')]).discovery.candidates[0]
  assert.throws(() => h.manager.review(first.id, { status: 'APPROVED' }), /年龄未核实/)
  assert.throws(() => h.manager.review(first.id, { status: 'APPROVED', ageConfirmation: '25' }), /无效/)
  assert.equal(h.manager.review(first.id, { status: 'APPROVED', ageConfirmation: 25 }).candidate.review.ageConfirmation.value, 25)
  h.manager.patch(first.id, { publicSignals: { age: 31 } })
  assert.throws(() => h.manager.review(first.id, { status: 'APPROVED', ageConfirmation: 25 }), /20至30/)
})

test('age extractor accepts explicit age only and never infers birth year, location or followers', () => {
  assert.equal(summarizePublicProfile({ rawText: '年龄：23岁\n粉丝\n120' }).age, 23)
  assert.equal(summarizePublicProfile({ rawText: '25岁\n女' }).age, 25)
  for (const rawText of ['出生年份：2001\nIP属地：广东', '粉丝\n25', '2001年出生', '年龄：二十多岁', '年龄：2026']) assert.equal(summarizePublicProfile({ rawText }).age, null)
})

test('score only uses actual author evidence and matching persona interests, not search or discovery metadata', () => {
  const record = candidate({ sources: [{ ...comment('one').source, keyword: '摄影', videoTitle: '研二交友', commentText: '哈哈哈' }], createdAt: '2026-10-10T10:00:00Z', publicProfile: { capturedAt: '2026-10-10T10:00:00Z' } })
  const result = evaluateCandidate(record, { config, persona: { interests: '摄影' }, now: '2026-10-10T11:00:00Z' })
  assert.equal(result.score, 0); assert.equal(result.eligibility, 'worth_reviewing'); assert.deepEqual(result.evidence, [])
})

test('full verified evidence awards exact weighted score and remains pure', () => {
  const record = candidate({ sources: [{ ...comment('one').source, activitySource: 'public_comment', publishedAt: '2026-10-09T10:00:00Z' }], publicSignals: { genderText: '女', age: 25, followerCount: 4, contentCount: { value: 3, source: 'public_profile_text' } } })
  const before = structuredClone(record), result = evaluateCandidate(record, { config, persona: { interests: '摄影、徒步' }, now: '2026-10-10T11:00:00Z' })
  assert.equal(result.score, 100); assert.equal(result.eligibility, 'high_priority'); assert.equal(result.evidence.length, 6)
  assert.deepEqual(record, before); assert.deepEqual(result.evidence.map(item => item.points), [30, 15, 20, 10, 10, 15])
})

test('unverified, old and future timestamps or arbitrary post counts cannot award evidence points', () => {
  for (const recentActivity of [{ at: '2026-10-10', source: 'discovery' }, { at: '2026-09-01', source: 'public_profile_text' }, { at: '2026-11-01', source: 'public_comment' }]) {
    const result = evaluateCandidate(candidate({ publicSignals: { ...candidate().publicSignals, recentActivity, contentCount: { value: 10, source: 'AI_guess' } } }), { config, now: '2026-10-10T11:00:00Z' })
    assert.equal(result.score, 0)
  }
})

test('negated social or interest statements do not increase priority', () => {
  const record = candidate({ sources: [{ ...comment('one').source, commentText: '不想交朋友，我不喜欢摄影，只是看看这个视频' }] })
  const result = evaluateCandidate(record, { config, persona: { interests: '摄影' } })
  assert.equal(result.evidence.some(item => ['social_willingness', 'shared_interests'].includes(item.key)), false)
})

test('blacklist, disabled, existing contacts, send history and uncertain prior sends exclude repeats', () => {
  for (const options of [{ blacklist: ['同名朋友'] }, { aiDisabledContacts: ['one'] }, { contacts: [{ profile: { autoFriendshipUrl: candidate().profileUrl }, name: '改名' }] }, { sendHistory: [{ name: '同名朋友', at: '2025-01-01' }] }]) {
    assert.equal(evaluateCandidate(candidate(), { config, ...options }).eligibility, 'reject')
  }
  for (const status of ['SEND_UNKNOWN', 'OPENING_SENDING', 'WAITING_REPLY', 'CONTACT', 'REJECTED']) assert.equal(evaluateCandidate(candidate({ status }), { config }).eligibility, 'reject')
  const sameNameDifferentId = { contacts: [{ name: '同名朋友', profile: { autoFriendshipUrl: 'https://www.douyin.com/user/another' } }] }
  assert.equal(evaluateCandidate(candidate(), { config, ...sameNameDifferentId }).hardGate.passed, true)
})

test('already followed does not invent opening history and conflicting candidate identity is rejected', () => {
  const result = evaluateCandidate(candidate(), { config, followed: [{ url: candidate().profileUrl }] })
  assert.equal(result.hardGate.passed, true); assert.ok(result.signals.some(signal => signal.includes('已经关注')))
  assert.equal(evaluateCandidate(candidate({ platformUserId: 'wrong' }), { config }).eligibility, 'reject')
})

test('age filter defaults off and explicit adult requirements preserve manual search settings', async () => {
  const defaults = normalizeDiscoveryConfig({}); assert.equal(defaults.requireAgeRange, false); assert.equal(defaults.ageMin, 20); assert.equal(defaults.ageMax, 30); assert.equal(defaults.automaticContactThreshold, 70)
  const value = { targetGender: 'female', requireFollowerLimit: true, followerLimit: 150, requireAgeRange: true, ageMin: 20, ageMax: 30, preferLowerComments: true, preferLowReplies: true, includeReplies: true, keywords: [], unsupported: [] }
  const ai = { inquiryCompletion: async () => ({ text: JSON.stringify(value), model: 'test' }) }
  const result = await parseRequirements(ai, '20至30岁女生，粉丝少于150', { videoTags: ['校园'], videoKeywords: ['摄影'] })
  assert.equal(result.config.requireAgeRange, true); assert.equal(result.config.ageMin, 20); assert.deepEqual(result.config.videoTags, ['校园']); assert.deepEqual(result.config.videoKeywords, ['摄影'])
  for (const patch of [{ ageMin: 17 }, { ageMin: 31, ageMax: 20 }, { ageMax: 101 }, { ageMin: 20.5 }]) {
    await assert.rejects(() => parseRequirements({ inquiryCompletion: async () => ({ text: JSON.stringify({ ...value, ...patch }) }) }, '年龄要求'), /不完整|越界/)
  }
  const { requireAgeRange: _missing, ...incomplete } = value
  await assert.rejects(() => parseRequirements({ inquiryCompletion: async () => ({ text: JSON.stringify(incomplete) }) }, '20到30岁女生'), /不完整|越界/)
})
