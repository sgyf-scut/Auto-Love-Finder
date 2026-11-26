// P2-17B.2 主页资料链路：页面文本 → 结构化信号 → 事实分级 → 候选判定。
// 覆盖：公开男/女、有年龄、未公开、读取失败（不写结论）、来源冲突（不强行判合格）。
// 全程不使用头像/昵称猜测；主页 IP 也不作为评论 IP 依据。
const test = require('node:test')
const assert = require('node:assert')
const { createMemoryStorage } = require('./setup.cjs')
const { summarizePublicProfile, parseFollowerCount } = require('../electron/discovery/comment-snapshot.cjs')
const { buildProfileFacts, FACT_STATUS, describeFact } = require('../electron/discovery/profile-facts.cjs')
const { CandidateManager, candidateGender, candidateAge } = require('../electron/discovery/candidate-manager.cjs')
const { evaluateBatchCandidate } = require('../electron/discovery/batch-filter.cjs')

const record = (over = {}) => ({
  nickname: over.nickname || '合成-测试',
  platformUserId: over.platformUserId || 'SEC_T_0001',
  profileUrl: `https://www.douyin.com/user/${over.platformUserId || 'SEC_T_0001'}`,
  libraryIntent: 'SEEKING_FRIENDS',
  publicSignals: over.publicSignals || {},
  sources: [{ type: 'comment', topic: '交友', keyword: 'k', videoId: '7300000000000000001', commentText: over.commentText || '想认识一下', replyCount: 1 }],
  // CandidateManager.upsert 读的是 source（单数）；sources 用于断言来源合并。
  source: { type: 'comment', topic: '交友', keyword: 'k', videoId: '7300000000000000001', commentText: over.commentText || '想认识一下', replyCount: 1 },
  ...over,
})

test('P2-17B.2-13 主页文本：公开女/男、年龄、粉丝数、IP属地都能结构化，未公开则字段为 null', () => {
  const female = summarizePublicProfile({ rawText: '合成-甲\n抖音号：syn_0001\nIP属地：广东\n女\n24岁\n粉丝 328\n学校：某某大学' })
  assert.equal(female.genderText, '女')
  assert.equal(female.age, 24)
  assert.equal(female.followerCount, 328)
  assert.equal(female.ipLocation, '广东')
  assert.ok(female.evidence.some(e => e.field === 'ipLocation' && e.source === 'public_profile_text'))

  const male = summarizePublicProfile({ rawText: '合成-乙\nIP属地：江苏\n男\n粉丝 12' })
  assert.equal(male.genderText, '男')
  assert.equal(male.age, null, '没有年龄就必须是 null')

  const hidden = summarizePublicProfile({ rawText: '合成-丙\n这个人很神秘，什么都没有留下' })
  assert.equal(hidden.genderText, null)
  assert.equal(hidden.age, null)
  assert.equal(hidden.followerCount, null)

  // 简介里出现"想找个男朋友"不能被当成主页性别
  const partnerTalk = summarizePublicProfile({ rawText: '合成-丁\n想找个男朋友，最好180' })
  assert.equal(partnerTalk.genderText, null)

  assert.equal(parseFollowerCount('粉丝 1.2万'), 12000)
  assert.equal(parseFollowerCount('粉丝 0万'), null, '缩写 0 不能证明没有粉丝')
})

test('P2-17B.2-14 事实分级：主页公开优先、评论自述作补充、冲突不猜', () => {
  const publicFemale = buildProfileFacts({ publicSignals: { genderText: '女', age: 25 } })
  assert.equal(publicFemale.gender.status, FACT_STATUS.PUBLIC_PROFILE)
  assert.equal(publicFemale.gender.value, 'female')
  assert.equal(publicFemale.age.value, 25)

  const selfOnly = buildProfileFacts({ sources: [{ commentText: '本人女 28岁 广州，想认识朋友' }] })
  assert.equal(selfOnly.gender.status, FACT_STATUS.SELF_DECLARED)
  assert.equal(selfOnly.age.value, 28)

  const conflict = buildProfileFacts({ sources: [{ commentText: '本人女 28岁' }], publicSignals: { genderText: '男' } })
  assert.equal(conflict.gender.status, FACT_STATUS.CONFLICT)
  assert.equal(conflict.gender.value, null)
  assert.match(describeFact(conflict.gender), /信息冲突/)

  const notAttempted = buildProfileFacts({})
  assert.equal(notAttempted.gender.attempted, false)
  assert.match(describeFact(notAttempted.gender), /尚未读取主页/)
})

test('P2-17B.2-15 主页读取失败不写结论：已有判定保持未知/待核实，不会因为失败变成合格', () => {
  const dir = createMemoryStorage({})
  const manager = new CandidateManager(dir)
  const saved = manager.upsert([record({ nickname: '合成-失败' , platformUserId: 'SEC_T_FAIL' })], { accountId: 'acc' })
  const candidate = saved.discovery.candidates[0]
  // 模拟 captureProfile 失败后写入的标记（真实引擎走同一结构）
  candidate.publicProfile = { status: 'failed', lastError: '未读到可靠的公开资料', lastAttemptAt: new Date().toISOString() }
  manager.save(manager.get().candidates ? { ...manager.get(), candidates: manager.get().candidates.map(c => c.id === candidate.id ? candidate : c) } : manager.get())
  const stored = manager.get().candidates.find(c => c.id === candidate.id)
  assert.equal(candidateGender(stored), 'unknown')
  assert.equal(candidateAge(stored), null)
  const evaluation = evaluateBatchCandidate(stored, { gender: 'female', requireAgeRange: true, ageMin: 18, ageMax: 30 })
  assert.equal(evaluation.status, 'pending', '读取失败只能进待核实')
  assert.ok(evaluation.pendingReasons.includes('GENDER_UNVERIFIED'))
  assert.ok(evaluation.pendingReasons.includes('AGE_UNVERIFIED'))
})

test('P2-17B.2-16 主页公开男性一律排除；公开女性 + 年龄符合才合格', () => {
  const dir = createMemoryStorage({})
  const manager = new CandidateManager(dir)
  const saved = manager.upsert([
    record({ nickname: '合成-男', platformUserId: 'SEC_T_M', publicSignals: { genderText: '男', age: 26, followerCount: 20 } }),
    record({ nickname: '合成-女', platformUserId: 'SEC_T_F', publicSignals: { genderText: '女', age: 26, followerCount: 20 } }),
  ], { accountId: 'acc' })
  const male = saved.discovery.candidates.find(c => c.platformUserId === 'SEC_T_M')
  const female = saved.discovery.candidates.find(c => c.platformUserId === 'SEC_T_F')
  assert.equal(candidateGender(male), 'male')
  assert.equal(candidateGender(female), 'female')
  assert.equal(candidateAge(female), 26)
  assert.equal(evaluateBatchCandidate(male, { gender: 'any' }).status, 'excluded')
  assert.equal(evaluateBatchCandidate(male, { gender: 'female' }).status, 'excluded', '公开男性即使限制女性也必须直接排除，而不是待核实')
  const ok = evaluateBatchCandidate(female, { gender: 'female', requireAgeRange: true, ageMin: 20, ageMax: 30 })
  assert.equal(ok.status, 'qualified')
  const outOfRange = evaluateBatchCandidate(female, { requireAgeRange: true, ageMin: 18, ageMax: 20 })
  assert.equal(outOfRange.status, 'excluded')
})

test('P2-17B.2-17 来源冲突必须停在待核实，不能强行改成合格', () => {
  const dir = createMemoryStorage({})
  const manager = new CandidateManager(dir)
  const saved = manager.upsert([record({ nickname: '合成-冲突', platformUserId: 'SEC_T_C', commentText: '本人女，想认识', publicSignals: { genderText: '男' } })], { accountId: 'acc' })
  const candidate = saved.discovery.candidates[0]
  assert.equal(candidateGender(candidate), 'male', '冲突时判定沿用公开值，避免把公开男性放进来')
  const evaluation = evaluateBatchCandidate(candidate, { gender: 'female' })
  assert.equal(evaluation.status, 'excluded')
  assert.equal(candidate.profileFacts.gender.status, FACT_STATUS.CONFLICT)
  assert.equal(candidate.profileFacts.gender.value, null, '冲突时不能产出单一值')
  assert.equal(evaluation.facts.gender, 'male')
})

test('P2-17B.2-18 主页 IP 不当作评论 IP：地区筛选只认评论来源的字段', () => {
  const dir = createMemoryStorage({})
  const manager = new CandidateManager(dir)
  const saved = manager.upsert([record({ nickname: '合成-地区', platformUserId: 'SEC_T_IP', publicSignals: { genderText: '女', ipLocation: '广东' } })], { accountId: 'acc' })
  const candidate = saved.discovery.candidates[0]
  // 候选来源没有 commentIpLocation（评论页没给），即使主页有 IP属地 也必须待核实
  const evaluation = evaluateBatchCandidate(candidate, { requireIp: true, ipValues: ['广东'] })
  assert.equal(evaluation.status, 'pending')
  assert.ok(evaluation.pendingReasons.includes('IP_UNVERIFIED'))
  assert.equal(evaluation.facts.ipLocation, null)
})
