// P2-16 专项二：筛选口径。未知资料必须进入待核实，不能算合格，也不能算不合格。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { planCandidates, summarize, verificationScope } = require('../electron/discovery/auto-contact.cjs')

const library = { videos: [], comments: [] }
const baseConfig = {
  targetGender: 'female', requireAgeRange: true, ageMin: 18, ageMax: 30,
  requireFollowerLimit: true, followerMin: 0, followerMax: 10000,
}

function candidate(id, signals = {}, over = {}) {
  return {
    id: `cand_${id}`, accountId: 'acc', platformUserId: `sec_${id}`, profileUrl: `https://www.douyin.com/user/sec_${id}`,
    nickname: `用户${id}`, status: 'DISCOVERED', discoveryStatus: 'DISCOVERED', discoveryGrade: 'B',
    libraryIntent: 'SEEKING_FRIENDS', publicSignals: signals, ...over,
  }
}

const SAMPLES = [
  candidate('match', { genderText: '女', age: 24, followerCount: 120 }),
  candidate('male', { genderText: '男', age: 24, followerCount: 120 }),
  candidate('old', { genderText: '女', age: 45, followerCount: 120 }),
  candidate('fans', { genderText: '女', age: 24, followerCount: 50000 }),
  candidate('noGender', { age: 24, followerCount: 120 }, { nickname: '小美' }),
  candidate('noAge', { genderText: '女', followerCount: 120 }),
  candidate('noFans', { genderText: '女', age: 24 }),
]

const planOf = (config = baseConfig, candidates = SAMPLES) => planCandidates(candidates, { library, config, excludePlatformUserIds: [] })
const planFor = (result, id) => result.plans.find(item => item.platformUserId === `sec_${id}`)

test('P2-16-20 条件匹配、不匹配、未知三种样本分别落到合格、排除、待核实', () => {
  const result = planOf()
  assert.equal(planFor(result, 'match').follow.eligible, true)
  assert.equal(planFor(result, 'male').follow.reasonCode, 'GENDER_MISMATCH')
  assert.equal(planFor(result, 'old').follow.reasonCode, 'AGE_OUT_OF_RANGE')
  assert.equal(planFor(result, 'fans').follow.reasonCode, 'FOLLOWERS_OUT_OF_RANGE')
  assert.equal(planFor(result, 'noGender').follow.reasonCode, 'GENDER_UNVERIFIED')
  assert.equal(planFor(result, 'noAge').follow.reasonCode, 'AGE_UNVERIFIED')
  assert.equal(planFor(result, 'noFans').follow.reasonCode, 'FOLLOWERS_UNVERIFIED')
})

test('P2-16-21 未知资料既不算合格也不算不合格', () => {
  const result = planOf()
  for (const id of ['noGender', 'noAge', 'noFans']) {
    const plan = planFor(result, id)
    assert.equal(plan.follow.eligible, false, `${id} 不得计入合格`)
    assert.equal(plan.follow.status, 'skipped', `${id} 应为待核实，而不是被排除`)
  }
})

test('P2-16-22 统计口径：候选数、合格数、待核实、已排除分别计数', () => {
  const result = planOf()
  assert.equal(result.summary.total, 7)
  assert.equal(result.summary.qualified, 1)
  assert.equal(result.summary.follow, 1)
  assert.equal(result.summary.pendingVerificationTotal, 3)
  assert.equal(result.summary.blocked, 3)
  assert.deepEqual(result.summary.pendingVerification, { GENDER_UNVERIFIED: 1, AGE_UNVERIFIED: 1, FOLLOWERS_UNVERIFIED: 1 })
})

test('P2-16-23 不启用条件时，未知资料不再阻断', () => {
  const result = planOf({ ...baseConfig, targetGender: 'any', requireAgeRange: false, requireFollowerLimit: false })
  assert.equal(result.summary.qualified, 7)
  assert.equal(result.summary.pendingVerificationTotal, 0)
  assert.deepEqual(result.scope, [])
})

test('P2-16-24 只启用部分条件时，只按已启用的条件判定', () => {
  const onlyAge = planOf({ ...baseConfig, targetGender: 'any', requireFollowerLimit: false })
  assert.deepEqual(verificationScope({ targetGender: 'any', requireAgeRange: true, requireFollowerLimit: false }), ['age'])
  assert.equal(onlyAge.summary.qualified, 5, '性别与粉丝不再拦截，仅年龄超范围与年龄未知被处理')
  assert.equal(planFor(onlyAge, 'noAge').follow.reasonCode, 'AGE_UNVERIFIED')
  assert.equal(planFor(onlyAge, 'noGender').follow.eligible, true)
})

test('P2-16-25 不靠昵称或头像猜测性别年龄', () => {
  const result = planOf()
  const plan = planFor(result, 'noGender')
  assert.equal(plan.follow.eligible, false)
  assert.match(plan.follow.reason, /未核实|人工/)
})

test('P2-16-26 界面同时展示候选数与满足全部必需条件人数', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8')
  assert.ok(app.includes('发现候选数'), '必须展示候选数，避免把计划数当成合格数')
  assert.ok(app.includes('满足全部必需条件'), '必须展示满足全部必需条件人数')
  assert.ok(app.includes('待核实'), '必须把资料不足单独列出')
  assert.ok(app.includes('planSummary.pendingVerificationTotal'), '待核实数量应来自真实统计')
})

test('P2-16-27 summarize 对空计划不产生误导性结果', () => {
  const summary = summarize([])
  assert.equal(summary.total, 0)
  assert.equal(summary.qualified, 0)
  assert.equal(summary.pendingVerificationTotal, 0)
})
