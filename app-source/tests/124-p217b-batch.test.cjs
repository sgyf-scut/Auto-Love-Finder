const test = require('node:test')
const assert = require('node:assert')
const { createMemoryStorage } = require('./setup.cjs')
const { normalizeBatchFilters, evaluateBatchCandidate } = require('../electron/discovery/batch-filter.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')

const candidate = (over = {}) => ({
  id: over.id || 'c1', platformUserId: over.platformUserId || 'SEC_A', nickname: '甲',
  profileUrl: `https://www.douyin.com/user/${over.platformUserId || 'SEC_A'}`,
  libraryIntent: over.libraryIntent || 'SEEKING_FRIENDS',
  publicSignals: over.publicSignals || {},
  sources: [{ type: 'comment', topic: 'manual_keywords', keyword: '找对象', videoId: '7704254886804399050',
    commentText: '想认识一下', replyCount: over.replyCount === undefined ? 1 : over.replyCount,
    commentIpLocation: over.ip === undefined ? null : over.ip, ...(over.source || {}) }],
  ...over,
})

test('关闭的条件遇未知不影响，启用的条件无依据则进待核实而不是审核名单', () => {
  const off = evaluateBatchCandidate(candidate({}), { gender: 'any' })
  assert.equal(off.status, 'qualified')

  const on = evaluateBatchCandidate(candidate({}), { gender: 'female' })
  assert.equal(on.status, 'pending')
  assert.ok(on.pendingReasons.includes('GENDER_UNVERIFIED'))

  const male = evaluateBatchCandidate(candidate({ publicSignals: { genderText: '男' } }), { gender: 'any' })
  assert.equal(male.status, 'excluded')
  assert.ok(male.excludedReasons.includes('GENDER_MISMATCH'))
})

test('回复数读取失败按未知处理，不当作 0 条', () => {
  const unknown = evaluateBatchCandidate(candidate({ replyCount: null }), { requireReplyLimit: true, replyLimit: 5 })
  assert.equal(unknown.status, 'pending')
  assert.ok(unknown.pendingReasons.includes('REPLIES_UNVERIFIED'))
  assert.equal(unknown.facts.replyCount, null)

  const zero = evaluateBatchCandidate(candidate({ replyCount: 0 }), { requireReplyLimit: true, replyLimit: 5 })
  assert.equal(zero.status, 'qualified')
  assert.equal(zero.facts.replyCount, 0)

  const over = evaluateBatchCandidate(candidate({ replyCount: 9 }), { requireReplyLimit: true, replyLimit: 5 })
  assert.equal(over.status, 'excluded')
  assert.ok(over.excludedReasons.includes('REPLIES_OUT_OF_RANGE'))
})

test('评论IP属地：启用且未读取进待核实，读到但不在允许地区则排除', () => {
  const unknown = evaluateBatchCandidate(candidate({ ip: null }), { requireIp: true, ipValues: ['广东'] })
  assert.equal(unknown.status, 'pending')
  const other = evaluateBatchCandidate(candidate({ ip: '江苏' }), { requireIp: true, ipValues: ['广东'] })
  assert.equal(other.status, 'excluded')
  const ok = evaluateBatchCandidate(candidate({ ip: '广东' }), { requireIp: true, ipValues: ['广东'] })
  assert.equal(ok.status, 'qualified')
  const anyIp = evaluateBatchCandidate(candidate({ ip: '江苏' }), { requireIp: true, ipValues: [] })
  assert.equal(anyIp.status, 'qualified')
})

test('只保留明确交友与一般交流两类意愿', () => {
  assert.equal(evaluateBatchCandidate(candidate({ libraryIntent: 'SEEKING_FRIENDS' }), {}).intentClass, 'explicit')
  assert.equal(evaluateBatchCandidate(candidate({ libraryIntent: 'EXPLICIT_INVITATION' }), {}).intentClass, 'explicit')
  assert.equal(evaluateBatchCandidate(candidate({ libraryIntent: 'CONTEXTUAL_INTEREST' }), {}).intentClass, 'general')
  const ordinary = evaluateBatchCandidate(candidate({ libraryIntent: 'ORDINARY' }), {})
  assert.equal(ordinary.status, 'excluded')
  assert.ok(ordinary.excludedReasons.includes('NOT_FRIENDLY_INTENT'))
})

// —— 批次状态机（注入假来源/假采集器，不触网） ——
function harness({ videos = [], commentsByVideo = {}, recordsByVideo = {}, target = 1, budgets = {}, contacts = [], batchExcluded = [] } = {}) {
  const storage = createMemoryStorage({ contacts })
  const manager = new CandidateManager(storage)
  const comments = []
  const collector = { async run({ videoId }) { const rows = commentsByVideo[videoId] || []; for (const row of rows) comments.push({ ...row, video_id: videoId }); return { ok: true, added: rows.length } } }
  const library = { read: () => ({ videos: [], comments }) }
  const runner = new BatchRunner({
    manager, storage, accountId: 'acc', libraryStore: library,
    sourcesFactory: () => ({
      async collectByKeyword(keyword) { return { ok: true, kind: 'OK', sourceType: 'keyword', query: keyword, videos, pages: 1, events: [] } },
      async collectByTag(tag) { return { ok: true, kind: 'OK', sourceType: 'hashtag', query: tag, videos, pages: 1, events: [] } },
    }),
    collectorFactory: () => collector,
    classify: async () => ({ aiCalls: 1, tokens: 100 }),
    buildRecords: () => ({ records: Object.values(recordsByVideo).flat() }),
    draftOpening: null,
    emit: () => {},
  })
  if (batchExcluded.length) {
    const d = manager.get()
    manager.save({ ...d, batchExcluded })
  }
  return { runner, manager, storage, comments }
}

const video = (id, type = 'keyword') => ({ videoId: id, videoUrl: `https://www.douyin.com/video/${id}`, title: 't', sourceType: type, query: '找对象' })
const record = (videoId, userId, intent = 'SEEKING_FRIENDS', over = {}) => ({
  platformUserId: userId, profileUrl: `https://www.douyin.com/user/${userId}`, nickname: `用户${userId.slice(-2)}`,
  libraryIntent: intent, source: { type: 'comment', topic: 'manual_keywords', keyword: '找对象', videoId, commentText: '想认识', replyCount: 0 },
  sources: [{ type: 'comment', topic: 'manual_keywords', keyword: '找对象', videoId, commentText: '想认识', replyCount: 0 }],
  ...over,
})

test('关键词来源先试采：交友意愿不足的视频不再继续采集', async () => {
  const { runner } = harness({
    videos: [video('7700000000000000001')],
    commentsByVideo: { '7700000000000000001': [{ key: 'k1', text: '好看', author_id: 'S1', author_name: '甲', classification: { intent: 'ORDINARY' } }] },
    recordsByVideo: { '7700000000000000001': [record('7700000000000000001', 'S1')] },
  })
  const result = await runner.start({ target: 1, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 2 } })
  assert.equal(result.batch.status, 'done')
  assert.equal(result.batch.added.length, 0)
  assert.equal(result.batch.queue[0].status, 'skipped')
  assert.match(result.batch.reason, /候选不足/)
})

test('收藏夹来源跳过视频价值评价，直接入池；达到目标即停不补人', async () => {
  const { runner } = harness({
    videos: [video('7700000000000000002', 'favorites'), video('7700000000000000003', 'favorites')],
    commentsByVideo: { '7700000000000000002': [{ key: 'k2', text: '你好', author_id: 'S2', author_name: '乙', classification: { intent: 'ORDINARY' } }] },
    recordsByVideo: {
      '7700000000000000002': [record('7700000000000000002', 'S2')],
      '7700000000000000003': [record('7700000000000000003', 'S3')],
    },
  })
  // 收藏夹来源的视频来自素材库，这里用 keywords 走同一路径会先试采，因此用 favorites 视频 + 关闭阈值
  const result = await runner.start({ target: 1, sources: { keywords: ['收藏夹'] }, budgets: { valueThreshold: 0 } })
  assert.equal(result.batch.status, 'done')
  assert.equal(result.batch.added.length, 1)
  assert.equal(result.batch.queue.filter(q => q.status === 'pending').length, 1)
})

test('预算耗尽时交付实际人数并说明原因，不放宽条件', async () => {
  const { runner } = harness({
    videos: [video('7700000000000000011'), video('7700000000000000012')],
    commentsByVideo: { '7700000000000000011': [{ key: 'a', text: '想认识', author_id: 'S11', author_name: '丙', classification: { intent: 'SEEKING_FRIENDS' } }] },
    recordsByVideo: { '7700000000000000011': [record('7700000000000000011', 'S11')] },
  })
  const result = await runner.start({ target: 5, sources: { keywords: ['找对象'] }, budgets: { maxVideos: 1, valueThreshold: 1 } })
  assert.equal(result.batch.status, 'done')
  assert.match(result.batch.reason, /视频处理上限/)
  assert.equal(result.batch.added.length, 1)
})

test('已不感兴趣/清空过的账号在新批次被排除', async () => {
  const { runner } = harness({
    videos: [video('7700000000000000021')],
    commentsByVideo: { '7700000000000000021': [{ key: 'b', text: '想认识', author_id: 'S21', author_name: '丁', classification: { intent: 'SEEKING_FRIENDS' } }] },
    recordsByVideo: { '7700000000000000021': [record('7700000000000000021', 'S21')] },
    batchExcluded: [{ platformUserId: 'S21', reason: 'not_interested' }],
  })
  const result = await runner.start({ target: 1, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  assert.equal(result.batch.added.length, 0)
})

test('暂停后已入批候选保留，继续不重复入池', async () => {
  const storage = createMemoryStorage({})
  const manager = new CandidateManager(storage)
  const comments = []
  const videos = [video('7700000000000000031'), video('7700000000000000032')]
  const records = [record('7700000000000000031', 'S31'), record('7700000000000000032', 'S32')]
  let calls = 0
  const runner = new BatchRunner({
    manager, storage, accountId: 'acc',
    libraryStore: { read: () => ({ videos: [], comments }) },
    sourcesFactory: () => ({ async collectByKeyword(k) { return { ok: true, kind: 'OK', sourceType: 'keyword', query: k, videos, pages: 1, events: [] } } }),
    collectorFactory: () => ({ async run({ videoId }) {
      calls++
      comments.push({ key: `c${calls}`, video_id: videoId, text: '想认识', author_id: videoId.endsWith('1') ? 'S31' : 'S32', author_name: '戊', classification: { intent: 'SEEKING_FRIENDS' } })
      if (calls === 1) runner.pause()
      return { ok: true }
    } }),
    classify: async () => ({ aiCalls: 0, tokens: 0 }),
    buildRecords: () => ({ records }),
    emit: () => {},
  })
  const first = await runner.start({ target: 5, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  assert.equal(first.batch.status, 'paused')
  assert.equal(first.batch.added.length, 1)
  const resumed = await runner.resume()
  assert.equal(resumed.batch.added.length, 2)
  assert.equal(new Set(resumed.batch.added.map(x => x.candidateId)).size, 2)
})

// —— P2-17B.1 零候选根因回归 ——
// 真实 candidateRecords 产出的记录只有 source（单数）；旧代码按 r.sources 过滤导致候选恒为 0。
test('记录只有 source 单数字段时仍能按视频匹配并入池（零候选主根因回归）', async () => {
  const storage = createMemoryStorage({})
  const manager = new CandidateManager(storage)
  const comments = [{ key: 'c41', video_id: '7700000000000000041', text: '想认识', author_id: 'S41', author_name: '己', classification: { intent: 'SEEKING_FRIENDS' } }]
  const onlySource = {
    platformUserId: 'S41', profileUrl: 'https://www.douyin.com/user/S41', nickname: '用户41', libraryIntent: 'SEEKING_FRIENDS',
    source: { type: 'comment', topic: 'manual_keywords', keyword: '找对象', videoId: '7700000000000000041', commentText: '想认识', replyCount: 0 },
  }
  const runner = new BatchRunner({
    manager, storage, accountId: 'acc',
    libraryStore: { read: () => ({ videos: [], comments }) },
    sourcesFactory: () => ({ async collectByKeyword(k) { return { ok: true, kind: 'OK', sourceType: 'keyword', query: k, videos: [video('7700000000000000041')], pages: 1, events: [] } } }),
    collectorFactory: () => ({ async run() { return { ok: true, added: 0 } } }),
    classify: async () => ({ aiCalls: 0, tokens: 0 }),
    buildRecords: () => ({ records: [onlySource] }),
    emit: () => {},
  })
  const result = await runner.start({ target: 1, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  assert.equal(result.batch.status, 'done')
  assert.equal(result.batch.added.length, 1, '只有 source 的记录也必须能入池')
  assert.equal(result.batch.queue[0].status, 'processed')
  assert.equal(result.batch.queue[0].stages.records, 1)
})

// 启用地区筛选但素材库没有任何 IP 数据时，批次要给出明确警告，不能静默全员待核实。
test('地区筛选启用但 IP 不可用时，批次状态带明确警告', async () => {
  const storage = createMemoryStorage({})
  const manager = new CandidateManager(storage)
  const comments = [{ key: 'c61', video_id: '7700000000000000061', text: '想认识', author_id: 'S61', author_name: '辛', classification: { intent: 'SEEKING_FRIENDS' } }]
  const runner = new BatchRunner({
    manager, storage, accountId: 'acc',
    libraryStore: { read: () => ({ videos: [], comments }) },
    sourcesFactory: () => ({ async collectByKeyword(k) { return { ok: true, kind: 'OK', sourceType: 'keyword', query: k, videos: [], pages: 1, events: [] } } }),
    collectorFactory: () => ({ async run() { return { ok: true, added: 0 } } }),
    classify: async () => ({ aiCalls: 0, tokens: 0 }),
    buildRecords: () => ({ records: [] }),
    emit: () => {},
  })
  const withIp = await runner.start({ target: 1, sources: { keywords: ['找对象'] }, filters: { requireIp: true, ipValues: ['广东'] }, budgets: { valueThreshold: 0 } })
  // 首句按要求生成；没有本人资料不会阻断，地区提示仍必须保留。
  const ipWarnings = withIp.batch.warnings.filter(w => /地区筛选/.test(w))
  assert.equal(ipWarnings.length, 1)
  assert.match(ipWarnings[0], /地区筛选/)
  assert.equal(withIp.batch.warnings.some(w => /可用本人资料/.test(w)), false)

  // 素材库里有 IP 数据时不告警
  comments.push({ key: 'c62', video_id: '7700000000000000061', text: '你好', author_id: 'S62', author_name: '壬', ip_location: '广东', classification: { intent: 'SEEKING_FRIENDS' } })
  const withoutWarning = await runner.start({ target: 1, sources: { keywords: ['找对象'] }, filters: { requireIp: true, ipValues: ['广东'] }, budgets: { valueThreshold: 0 } })
  assert.equal(withoutWarning.batch.warnings.filter(w => /地区筛选/.test(w)).length, 0)
  // 未启用地区筛选时也不告警
  const off = await runner.start({ target: 1, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 0 } })
  assert.equal(off.batch.warnings.filter(w => /地区筛选/.test(w)).length, 0)
})
// 复跑同一视频：评论已采过（0 新增）且缺 intent 时，仍要补分类，不能把视频当"无价值"跳过。
test('复跑 0 新增：旧评论缺 intent 仍被补分类并产生候选', async () => {
  const storage = createMemoryStorage({})
  const manager = new CandidateManager(storage)
  const comment = { key: 'old51', video_id: '7700000000000000051', text: '想找搭子', author_id: 'S51', author_name: '庚', classification: null }
  const library = { read: () => ({ videos: [], comments: [comment] }) }
  const classifyKeys = []
  const onlySource = {
    platformUserId: 'S51', profileUrl: 'https://www.douyin.com/user/S51', nickname: '用户51', libraryIntent: 'SEEKING_FRIENDS',
    source: { type: 'comment', topic: 'manual_keywords', keyword: '搭子', videoId: '7700000000000000051', commentText: '想找搭子', replyCount: 0 },
  }
  const runner = new BatchRunner({
    manager, storage, accountId: 'acc', libraryStore: library,
    sourcesFactory: () => ({ async collectByKeyword(k) { return { ok: true, kind: 'OK', sourceType: 'keyword', query: k, videos: [video('7700000000000000051')], pages: 1, events: [] } } }),
    collectorFactory: () => ({ async run() { return { ok: true, added: 0 } } }),
    classify: async (keys) => { classifyKeys.push(keys); comment.classification = { intent: 'SEEKING_FRIENDS', confidence: 0.6 }; return { aiCalls: 1, tokens: 50 } },
    buildRecords: () => ({ records: [onlySource] }),
    emit: () => {},
  })
  const result = await runner.start({ target: 1, sources: { keywords: ['搭子'] }, budgets: { valueThreshold: 1 } })
  assert.equal(classifyKeys.length, 1)
  assert.ok(classifyKeys[0].includes('old51'), '旧评论的 key 也要送分类')
  assert.equal(result.batch.added.length, 1, '补分类后视频价值达标，候选要入池')
  assert.equal(result.batch.queue[0].stages.fresh, 0)
  assert.equal(result.batch.queue[0].stages.existing, 1)
  assert.equal(result.batch.queue[0].stages.friendly, 1)
})

test('obsolete persona warnings are removed while unrelated batch warnings remain', () => {
  const storage = createMemoryStorage({ selfProfile: { introductionText: '我喜欢羽毛球' } })
  const manager = new CandidateManager(storage)
  manager.save({ ...manager.get(), batch: {
    warnings: ['还没有设置人设（称呼/身份/兴趣至少填一项）', '地区筛选警告'],
  } })
  const runner = new BatchRunner({ manager, storage })
  assert.deepEqual(runner.status().batch.warnings, ['地区筛选警告'])
  const { updateSelfProfile } = require('../electron/social-brain/self-profile.cjs')
  storage.update({ selfProfile: updateSelfProfile(storage.get().selfProfile, {
    section: 'stableProfile', item: { key: 'interests', label: '兴趣', value: '羽毛球', shareLevel: 'NORMAL' },
  }) })
  assert.deepEqual(runner.status().batch.warnings, ['地区筛选警告'])
})
