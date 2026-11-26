// P2-16.1 界面契约：资料五态必须区分显示，"未核实"不能被写成"未知"。
// 这里是源码级契约测试，防止界面回退到两态口径。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createMemoryStorage } = require('./setup.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { auditCandidates } = require('../electron/discovery/candidate-audit.cjs')

const appSource = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8')

test('界面同时存在五态标签，缺一不可', () => {
  for (const label of ["unknown: '未知'", "self_declared: '本人自述'", "public_profile: '主页公开'", "manual: '人工核实'", "conflict: '信息冲突'"]) {
    assert.ok(appSource.includes(label), `缺少状态标签：${label}`)
  }
})

test('"未核实"与"未知"在界面文案上分开表达', () => {
  assert.ok(appSource.includes('未核实（尚未读取主页）'), '未读取主页时必须写"未核实"，不能写"未知"')
  assert.ok(appSource.includes('未知（已读主页，未找到公开资料）'), '读过主页但无资料时才写"未知"')
})

test('旧的"年龄未知/性别未知"待核实映射已移除', () => {
  assert.ok(!appSource.includes("AGE_UNVERIFIED: '年龄未知'"), 'AGE_UNVERIFIED 不得再显示为"年龄未知"')
  assert.ok(!appSource.includes("GENDER_UNVERIFIED: '性别未知'"), 'GENDER_UNVERIFIED 不得再显示为"性别未知"')
  assert.ok(appSource.includes("AGE_UNVERIFIED: '年龄未核实'"))
  assert.ok(appSource.includes("GENDER_UNVERIFIED: '性别未核实'"))
})

test('界面为冲突状态提供独立文案与原因码', () => {
  assert.ok(appSource.includes("AGE_CONFLICT: '年龄信息冲突'"))
  assert.ok(appSource.includes("GENDER_CONFLICT: '性别信息冲突'"))
  assert.ok(appSource.includes('待人工裁决'))
})

test('性别值以中文展示，不把 female/male 直接暴露给界面', () => {
  assert.ok(appSource.includes('function factValueText'), '需要统一的取值翻译函数')
  assert.ok(appSource.includes("({ female: '女性', male: '男性' })[value]"), '性别必须翻译成中文')
})

test('候选卡片与详情都展示来源证据，而不是只给一个裸值', () => {
  assert.ok(appSource.includes('资料结论与来源'), '详情页需要独立区块展示资料结论')
  assert.ok(appSource.includes('FACT_SOURCE_LABELS'), '需要把来源翻译成中文文案')
  assert.ok(appSource.includes("comment_text: '评论原话'") && appSource.includes("profile_bio: '主页简介'"))
})

test('归一化后的候选带上 profileFacts，审计输出五态与来源', () => {
  const storage = createMemoryStorage()
  const manager = new CandidateManager(storage)
  manager.upsert([{
    nickname: '小美',
    profileUrl: 'https://www.douyin.com/user/sec_a',
    platformUserId: 'sec_a', platformUserIdType: 'sec_uid',
    libraryIntent: 'SEEKING_FRIENDS', discoveryGrade: 'B', discoveryStatus: 'DISCOVERED',
    source: { topic: 't', keyword: 'k', videoId: 'v1', commentId: 'c1', commentText: '本人女，26岁，想认识新朋友' },
  }], { accountId: 'acc' })
  const candidate = manager.get().candidates[0]
  assert.ok(candidate.profileFacts, '候选档案必须写入 profileFacts')
  assert.equal(candidate.profileFacts.gender.status, 'self_declared')
  assert.equal(candidate.profileFacts.gender.value, 'female')
  assert.equal(candidate.profileFacts.gender.source, 'comment_text')
  assert.match(candidate.profileFacts.gender.quote, /本人女/)
  assert.equal(candidate.profileFacts.age.value, 26)
  assert.equal(candidate.ageVerification, 'self_declared')
  assert.equal(candidate.genderVerification, 'self_declared')

  const audit = auditCandidates([candidate], { library: { videos: [], comments: [] }, config: {} }).audits[0]
  assert.equal(audit.facts.genderStatus, 'self_declared')
  assert.equal(audit.facts.genderSource, 'comment_text')
  assert.match(audit.facts.genderQuote, /本人女/)
  assert.equal(audit.facts.ageKnown, true)
  assert.equal(audit.facts.ageVerified, false, '自述不等于人工核实')
})

test('没有读取过主页时审计标为未核实，读过但无资料标为未知', () => {
  const storage = createMemoryStorage()
  const manager = new CandidateManager(storage)
  manager.upsert([{
    nickname: '路人', profileUrl: 'https://www.douyin.com/user/sec_b',
    platformUserId: 'sec_b', platformUserIdType: 'sec_uid',
    libraryIntent: 'SEEKING_FRIENDS', discoveryGrade: 'B', discoveryStatus: 'DISCOVERED',
    source: { topic: 't', keyword: 'k', videoId: 'v1', commentId: 'c2', commentText: '看着不错' },
  }], { accountId: 'acc' })
  const notRead = manager.get().candidates[0]
  assert.equal(notRead.profileFacts.age.status, 'unknown')
  assert.equal(notRead.profileFacts.age.attempted, false, '没读主页 = 未核实')

  const state = manager.get()
  state.candidates[0].publicProfile = { rawText: '昵称\n粉丝\n10\nIP属地：福建' }
  state.candidates[0].publicSignals = { ipLocation: '福建' }
  manager.save(state)
  const readNoData = manager.get().candidates[0]
  assert.equal(readNoData.profileFacts.age.status, 'unknown')
  assert.equal(readNoData.profileFacts.age.attempted, true, '读过主页但没有年龄 = 未知，不再是未核实')
})
