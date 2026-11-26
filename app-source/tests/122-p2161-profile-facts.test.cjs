// P2-16.1 专项：评论/主页的明确自述提取、来源分级与冲突处理。
// 关键约束：只认自我指称；"想找个男生""找18-30岁"是择偶条件，不能当成本人资料。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  FACT_STATUS, extractSelfDeclaredFacts, buildFact, buildProfileFacts, factValue, describeFact,
} = require('../electron/discovery/profile-facts.cjs')

const NOW = new Date('2026-11-05T00:00:00+08:00')

test('评论里"本人女，26岁"被提取为本人自述', () => {
  const found = extractSelfDeclaredFacts('本人女，26岁，坐标杭州，想找个靠谱的', { now: NOW })
  assert.equal(found.gender.value, 'female')
  assert.equal(found.age.value, 26)
  assert.match(found.gender.quote, /本人女/)
})

test('"想找个高个男生"不推断本人性别', () => {
  const found = extractSelfDeclaredFacts('想找个高个男生，最好180以上', { now: NOW })
  assert.equal(found.gender, null)
  assert.equal(found.age, null)
})

test('"找18-30岁的女生"既不推性别也不推年龄', () => {
  const found = extractSelfDeclaredFacts('希望对方18-30岁，女生优先', { now: NOW })
  assert.equal(found.gender, null)
  assert.equal(found.age, null)
})

test('"96年女"按出生年换算年龄并保留原话', () => {
  const found = extractSelfDeclaredFacts('96年女，本科，脾气好', { now: NOW })
  assert.equal(found.gender.value, 'female')
  assert.equal(found.age.value, 2026 - 1996)
  assert.equal(found.age.derivedFrom, 'birth_year')
  assert.match(found.age.quote, /96年女/)
})

test('主页"174 英本英硕 想找个高个男生"不推断性别', () => {
  const found = extractSelfDeclaredFacts('174 英本英硕 想找个高个男生', { now: NOW })
  assert.equal(found.gender, null)
})

test('同一字段两个来源冲突时记 conflict 并保留两个值', () => {
  const fact = buildFact({
    field: 'gender',
    selfEntries: [{ field: 'gender', value: 'female', source: 'comment_text', quote: '本人女' }],
    publicEntries: [{ field: 'gender', value: 'male', source: 'profile_bio', quote: '主页资料：性别 男' }],
    attempted: true,
  })
  assert.equal(fact.status, FACT_STATUS.CONFLICT)
  assert.equal(fact.value, null)
  assert.equal(fact.conflictValues.length, 2)
  assert.deepEqual(fact.conflictValues.map(item => item.value).sort(), ['female', 'male'])
})

test('主页公开为男性时人工确认不能改写，记冲突并保留公开值作为阻断依据', () => {
  const fact = buildFact({
    field: 'gender',
    manual: { value: 'female', quote: '看过主页视频确认' },
    selfEntries: [{ field: 'gender', value: 'female', source: 'comment_text', quote: '本人女' }],
    publicEntries: [{ field: 'gender', value: 'male', source: 'profile_bio', quote: '主页资料：性别 男' }],
    attempted: true,
  })
  assert.equal(fact.status, FACT_STATUS.CONFLICT)
  assert.equal(fact.value, null)
  assert.equal(fact.blockingValue, 'male')
  assert.equal(fact.conflictValues.length, 2)
  assert.equal(fact.evidence.length, 3)
})

test('没有主页资料时人工核实优先于评论自述', () => {
  const fact = buildFact({
    field: 'gender',
    manual: { value: 'female', quote: '看过主页视频确认' },
    selfEntries: [{ field: 'gender', value: 'male', source: 'comment_text', quote: '我是男生' }],
    attempted: false,
  })
  assert.equal(fact.status, FACT_STATUS.MANUAL)
  assert.equal(fact.value, 'female')
  assert.equal(fact.manualOverrides, true)
  assert.equal(fact.evidence.length, 2)
})

test('无任何来源时为未知，且 attempted 区分是否读过主页', () => {
  const notRead = buildFact({ field: 'age', attempted: false })
  const readNoData = buildFact({ field: 'age', attempted: true })
  assert.equal(notRead.status, FACT_STATUS.UNKNOWN)
  assert.equal(notRead.attempted, false)
  assert.equal(readNoData.status, FACT_STATUS.UNKNOWN)
  assert.equal(readNoData.attempted, true)
  assert.match(describeFact(notRead, { unit: '岁' }), /尚未读取主页/)
  assert.match(describeFact(readNoData, { unit: '岁' }), /已读主页/)
  assert.notEqual(describeFact(notRead, { unit: '岁' }), describeFact(readNoData, { unit: '岁' }))
})

test('只有主页公开时不冒充本人自述', () => {
  const fact = buildFact({
    field: 'gender',
    publicEntries: [{ field: 'gender', value: 'female', source: 'profile_bio', quote: '主页资料：性别 女' }],
    attempted: true,
  })
  assert.equal(fact.status, FACT_STATUS.PUBLIC_PROFILE)
  assert.match(describeFact(fact), /主页公开/)
})

test('buildProfileFacts 从多条评论出处汇总，冲突能暴露', () => {
  const facts = buildProfileFacts({
    sources: [
      { type: 'comment', commentText: '本人女，25岁', videoId: '1', topic: 't', keyword: 'k' },
      { type: 'comment', commentText: '我是男生，别认错了', videoId: '2', topic: 't', keyword: 'k' },
    ],
    publicSignals: {},
  }, { now: NOW })
  assert.equal(facts.gender.status, FACT_STATUS.CONFLICT)
  assert.equal(facts.age.status, FACT_STATUS.SELF_DECLARED)
  assert.equal(facts.age.value, 25)
})

test('冲突与未知取值一律为 null，不替人做选择', () => {
  const conflict = buildFact({
    field: 'age',
    selfEntries: [{ field: 'age', value: 22, source: 'comment_text', quote: '22岁' }],
    publicEntries: [{ field: 'age', value: 30, source: 'profile_bio', quote: '主页资料：年龄 30' }],
    attempted: true,
  })
  assert.equal(factValue(conflict), null)
  assert.equal(factValue({ status: FACT_STATUS.UNKNOWN, value: null }), null)
  assert.equal(factValue({ status: FACT_STATUS.SELF_DECLARED, value: 22 }), 22)
})

test('主页资料里独立一行的性别字能被识别', () => {
  const found = extractSelfDeclaredFacts('孤高の稀饭\n粉丝\n142\nIP属地：日本\n男\n假如生活欺骗了你', { now: NOW })
  assert.equal(found.gender.value, 'male')
  assert.match(found.gender.quote, /^男$/)
})

test('主页简介里的自述归为主页公开，不混成评论自述', () => {
  const facts = buildProfileFacts({
    sources: [{ type: 'comment', commentText: '看起来不错', videoId: '1', topic: 't', keyword: 'k' }],
    publicProfile: { rawText: '年龄：28\n性别：女\n现居：成都' },
    publicSignals: { age: 28, genderText: '女' },
  }, { now: NOW })
  assert.equal(facts.age.status, FACT_STATUS.PUBLIC_PROFILE)
  assert.equal(facts.gender.status, FACT_STATUS.PUBLIC_PROFILE)
  assert.equal(facts.age.value, 28)
})
