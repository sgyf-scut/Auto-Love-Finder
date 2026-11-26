// P2-17B.2 离线集成：用真实业务模块串起
//   来源 → 采集器 → 素材库 → 分类回写 → candidateRecords → CandidateManager → 筛选 → 批次
// 只 mock 两件事：平台页面访问（fixture 页）与模型分类（确定性规则代替调用）。
// 夹具在 tests/fixtures/p217b2/，数据性质写在每个文件的 _fixture 字段里。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMemoryStorage } = require('./setup.cjs')
const { LibraryStore } = require('../electron/social-brain/library-store.cjs')
const { LearningStore } = require('../electron/social-brain/comment-learning.cjs')
const { CommentCollector, rowToComment } = require('../electron/social-brain/comment-collector.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { writeBackClassification } = require('../electron/discovery/library-classify-bridge.cjs')
const { classifyCollection, COLLECTION_CODES } = require('../electron/discovery/collection-outcome.cjs')
const { ReplyReader, ReplyCache, normalizeReplies } = require('../electron/discovery/reply-reader.cjs')

const FIXTURES = path.join(__dirname, 'fixtures', 'p217b2')
const readFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const replay = readFixture('library.replay.json')
const pageFixture = readFixture('pages.json')

const V = {
  keyword: '7300000000000000001',
  irrelevant: '7300000000000000002',
  favorites: '7300000000000000003',
  tag: '7300000000000000004',
  male: '7300000000000000005',
  panelNotLoaded: '7300000000000000006',
  notFound: '7300000000000000007',
}
const video = (videoId, title) => ({ videoId, videoUrl: `https://www.douyin.com/video/${videoId}`, title, authorName: '视频作者', commentCount: 10 })

// 模型分类的替身：只按固定规则给 intent，不联网。回写路径用真实模块。
function classifyByRule({ store, learning, calls }) {
  return async keys => {
    const library = store.read()
    learning.syncLibrary(library)
    const data = learning.read()
    let aiCalls = 0
    for (const sample of data.samples) {
      if (!keys.includes(sample.key) || sample.ai?.intent) continue
      const intent = /想认识|想找个?搭子|同城|聊天搭子|报名/.test(sample.text) ? 'SEEKING_FRIENDS' : 'ORDINARY'
      sample.ai = { intent, confidence: 0.8, reason: 'fixture 规则分类（模型调用替身）', model: 'fixture-rule' }
      aiCalls++
    }
    learning.save(data)
    calls?.push({ keys, aiCalls })
    const written = writeBackClassification({ libraryStore: store, learningStore: learning, keys })
    return { aiCalls, tokens: 0, written }
  }
}

function harness({ library = replay, pages = pageFixture.pages, unavailable = pageFixture.unavailable, keywords = {}, tags = {}, contacts = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p217b2-'))
  const store = new LibraryStore(dir)
  store.save(JSON.parse(JSON.stringify(library)))
  const learning = new LearningStore(dir)
  const storage = createMemoryStorage({ contacts })
  const manager = new CandidateManager(storage)
  const calls = []
  const transport = {
    async prepare({ videoId }) {
      if (unavailable[videoId]) return { ok: false, ...unavailable[videoId] }
      return { ok: true, videoId, videoUrl: `https://www.douyin.com/video/${videoId}`, title: 'fixture 视频页' }
    },
    async readPage({ videoId, page = 0 }) {
      const pagesOf = pages[videoId] || []
      const rows = pagesOf[page] || []
      return { ok: true, rows, empty: false, shown: rows.length }
    },
  }
  const runner = new BatchRunner({
    manager, storage, accountId: 'acc', libraryStore: store,
    sourcesFactory: () => ({
      async collectByKeyword(keyword) { return { ok: true, kind: 'OK', sourceType: 'keyword', query: keyword, videos: (keywords[keyword] || []).map(v => video(v.id, v.title)), pages: 1, events: [] } },
      async collectByTag(tag) { return { ok: true, kind: 'OK', sourceType: 'hashtag', query: tag, videos: (tags[tag] || []).map(v => video(v.id, v.title)), pages: 1, events: [] } },
    }),
    collectorFactory: () => new CommentCollector({ store, transport }),
    classify: classifyByRule({ store, learning, calls }),
    draftOpening: async candidate => ({ text: `你好，${candidate.nickname}` }),
    emit: () => {},
  })
  // This legacy replay isolates classification/profile/relationship behavior.
  // Its tiny fixture videos explicitly opt out of the new total-comment gate.
  const start = runner.start.bind(runner)
  runner.start = (config, ...rest) => start({ minVideoComments: 0, ...config }, ...rest)
  return { dir, store, learning, storage, manager, runner, calls }
}
const byId = (list, id) => list.find(item => item.platformUserId === id)

// —— 1. 主链路：新评论 + 已有已分类 + 已有未分类 ——
test('P2-17B.2-01 真实模块串联：新评论入库、旧评论补分类、候选入批且阶段计数可对账', async () => {
  const h = harness({ keywords: { 找对象: [{ id: V.keyword, title: '找对象搭子' }] }, tags: {} })
  const before = h.store.read().comments.length
  const result = await h.runner.start({ target: 3, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1, maxAiCalls: 10, sampleSize: 20, maxPages: 1 } })
  const batch = result.batch
  assert.equal(batch.status, 'done')
  assert.equal(batch.stopCode, 'TARGET_REACHED')

  const lib = h.store.read()
  assert.equal(lib.comments.length, before + 2, '两个新评论应写入真实素材库')
  const item = batch.queue.find(q => q.videoId === V.keyword)
  assert.equal(item.status, 'processed')
  assert.equal(item.stages.read, 4, '读取=2 条历史 + 2 条新增')
  assert.equal(item.stages.existing, 2)
  assert.equal(item.stages.fresh, 2)
  assert.equal(item.stages.classifyTargets, 3, '2 条新评论无分类 + 1 条旧评论缺 intent')
  assert.equal(item.stages.friendly, 3)
  assert.equal(item.stages.records, 3, '历史甲 + 合成甲 + 合成戊')
  assert.equal(item.stages.added, 3)
  assert.equal(item.stages.added, item.added)

  // 旧评论补分类后确实写回素材库，而不是只写在内存里
  const oldPlain = lib.comments.find(c => c.comment_id === '7490000000000000002')
  assert.equal(oldPlain.classification.intent, 'ORDINARY')

  // 卡片字段来自候选来源（IP 与回复数带来源）
  const card = result.cards.find(c => c.nickname === '合成-甲')
  assert.equal(card.replyCount, 2)
  assert.equal(card.commentIp, '广东')
  assert.equal(card.commentIpSource, 'footer_region')
  assert.ok(card.draftOpening, '首句应预生成')
  assert.equal(batch.diagnostics.byCode.COLLECTED_NEW, 1)
  assert.equal(batch.progress.commentsFetched, 2)
  assert.equal(batch.progress.commentsAdded, 2)
  assert.equal(batch.progress.candidatesSeen, 3)
  assert.ok(batch.perf.collectMs >= 0 && batch.perf.videos === 1, '阶段耗时应记录')
})

// —— 2. 收藏夹绕过视频价值判断，关键词仍走价值门 ——
test('P2-17B.2-02 收藏夹跳过视频价值门；关键词价值不足则明确跳过而不是当失败', async () => {
  const favoritesRun = harness({ keywords: {}, tags: {} })
  const fav = await favoritesRun.runner.start({ target: 1, sources: { favorites: true }, budgets: { valueThreshold: 3 } })
  const favItem = fav.batch.queue.find(q => q.videoId === V.favorites)
  assert.equal(favItem.status, 'processed')
  assert.equal(favItem.blockReason, null)
  assert.equal(fav.batch.added.length, 1)
  assert.equal(fav.batch.added[0].platformUserId, 'SEC_OLD_0003')
  assert.equal(fav.batch.stopCode, 'TARGET_REACHED')

  const keywordRun = harness({ keywords: { 同城: [{ id: V.favorites, title: '同城交友角' }] } })
  const low = await keywordRun.runner.start({ target: 1, sources: { keywords: ['同城'] }, budgets: { valueThreshold: 3 } })
  const lowItem = low.batch.queue.find(q => q.videoId === V.favorites)
  assert.equal(lowItem.status, 'skipped')
  assert.equal(lowItem.blockReason, 'LOW_VALUE')
  assert.match(lowItem.reason, /试采价值不足/)
  // 0 新增但库里有评论：仍是“读到评论”，不能算“没有评论”
  assert.equal(lowItem.stages.code, 'COLLECTED_NO_NEW')
})

// —— 3. 跨视频同作者合并 ——
test('P2-17B.2-03 同一作者跨两个视频出现时合并为一个候选并保留两条来源', async () => {
  const h = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] }, tags: { 搭子: [{ id: V.tag, title: 'b' }] } })
  const result = await h.runner.start({ target: 5, sources: { keywords: ['找对象'], tags: ['搭子'] }, budgets: { valueThreshold: 1 } })
  const candidates = h.manager.get().candidates.filter(c => c.platformUserId === 'SEC_SYN_0004')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].sources.length, 3, '同作者 3 条评论都应保留为来源')
  assert.deepEqual([...new Set(candidates[0].sources.map(s => s.videoId))].sort(), [V.keyword, V.tag].sort())
  // 入批列表里也只有一条
  assert.equal(result.batch.added.filter(x => x.platformUserId === 'SEC_SYN_0004').length, 1)
})

// —— 4. 三态筛选：不符合 / 待核实 / 匹配 ——
test('P2-17B.2-04 性别、年龄、IP 三条件分别产生 excluded / pending / qualified', async () => {
  const h = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] } })
  // 预先给“合成-己”写入主页公开男性（主页链路的产物），批次应直接排除
  h.manager.upsert([{ nickname: '合成-己', platformUserId: 'SEC_SYN_0006', profileUrl: 'https://www.douyin.com/user/SEC_SYN_0006',
    publicSignals: { genderText: '男' }, libraryIntent: 'SEEKING_FRIENDS',
    source: { type: 'comment', topic: '交友', keyword: 'x', videoId: V.male, commentText: '想认识，男生一枚' } }], { accountId: 'acc' })

  const h2 = harness({ keywords: {}, tags: { 交友: [{ id: V.male, title: '交友帖' }] } })
  h2.manager.upsert([{ nickname: '合成-己', platformUserId: 'SEC_SYN_0006', profileUrl: 'https://www.douyin.com/user/SEC_SYN_0006',
    publicSignals: { genderText: '男' }, libraryIntent: 'SEEKING_FRIENDS',
    source: { type: 'comment', topic: '交友', keyword: 'x', videoId: V.male, commentText: '想认识，男生一枚' } }], { accountId: 'acc' })
  const male = await h2.runner.start({ target: 5, sources: { tags: ['交友'] }, filters: { gender: 'any' }, budgets: { valueThreshold: 1 } })
  assert.equal(male.batch.progress.excluded, 1, '公开男性必须排除')
  assert.equal(male.batch.added.length, 0)

  // 女 + 年龄区间：合成-甲自述“本人女 28岁”应匹配；历史甲性别未知 → 待核实
  const h3 = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] } })
  const filtered = await h3.runner.start({ target: 5, sources: { keywords: ['找对象'] },
    filters: { gender: 'female', requireAgeRange: true, ageMin: 18, ageMax: 30 }, budgets: { valueThreshold: 1 } })
  const addedNames = filtered.batch.added.map(x => x.nickname)
  assert.ok(addedNames.includes('合成-甲'), '自述女 28 岁应入批')
  assert.ok(!addedNames.includes('历史甲'), '性别未核实不能进审核名单')
  assert.ok(filtered.batch.progress.pending >= 1)
  const queueItem = filtered.batch.queue.find(q => q.videoId === V.keyword)
  assert.ok((queueItem.stages.filterCounts.GENDER_UNVERIFIED || 0) >= 1, '性别未核实应记录在筛选原因里')

  // IP 筛选：读不到 IP 的候选进待核实；地区不符的排除
  const h4 = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] } })
  const ipRun = await h4.runner.start({ target: 5, sources: { keywords: ['找对象'] }, filters: { requireIp: true, ipValues: ['江苏'] }, budgets: { valueThreshold: 1 } })
  const names = ipRun.batch.added.map(x => x.nickname)
  assert.ok(!names.includes('合成-戊'), '没有 IP 依据的不进审核名单')
  assert.ok(!names.includes('合成-甲'), 'IP 广东 不在允许地区应排除')
  assert.equal(ipRun.batch.status, 'done')
})

// —— 5. 采集失败与诊断分类 ——
test('P2-17B.2-05 评论区未加载 / 内容不存在 记为失败原因，不当作视频无价值', async () => {
  const h = harness({ keywords: { 找对象: [{ id: V.panelNotLoaded, title: 'c' }, { id: V.notFound, title: 'd' }] } })
  const result = await h.runner.start({ target: 1, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  const notLoaded = result.batch.queue.find(q => q.videoId === V.panelNotLoaded)
  const notFound = result.batch.queue.find(q => q.videoId === V.notFound)
  assert.equal(notLoaded.status, 'failed')
  assert.equal(notLoaded.code, 'PANEL_NOT_LOADED')
  assert.equal(notFound.code, 'VIDEO_NOT_FOUND')
  assert.equal(notFound.status, 'skipped', '明确失效的作品单独跳过，保留原始原因')
  assert.equal(result.batch.progress.videosSkipped, 1)
  assert.equal(result.batch.progress.videosFailed, 1, '仅未加载的评论区计入读取失败')
  assert.equal(result.batch.diagnostics.byCode.PANEL_NOT_LOADED, 1)
  assert.equal(result.batch.diagnostics.byCode.VIDEO_NOT_FOUND, 1)
})

// —— 6. 目标 / 预算 / 暂停 / 停止 / 重启恢复 ——
test('P2-17B.2-06 目标达成即停、预算耗尽交付实际人数、暂停继续、停止与重启恢复', async () => {
  const targetRun = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] } })
  const reached = await targetRun.runner.start({ target: 1, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  assert.equal(reached.batch.status, 'done')
  assert.equal(reached.batch.added.length, 1)
  assert.equal(reached.batch.stopCode, 'TARGET_REACHED')

  const budgetRun = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] }, tags: { 搭子: [{ id: V.tag, title: 'b' }] } })
  const budget = await budgetRun.runner.start({ target: 50, sources: { keywords: ['找对象'], tags: ['搭子'] }, budgets: { valueThreshold: 1, maxVideos: 1 } })
  assert.equal(budget.batch.status, 'done')
  assert.equal(budget.batch.stopCode, 'BUDGET_VIDEOS')
  assert.ok(budget.batch.progress.qualified >= 1, '预算耗尽也要交付已入批的人')
  assert.match(budget.batch.reason, /未放宽条件/)

  const pauseRun = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] }, tags: { 搭子: [{ id: V.tag, title: 'b' }] } })
  let pausedBatch = null
  const originalPatch = pauseRun.runner.patchQueueItem.bind(pauseRun.runner)
  let once = false
  pauseRun.runner.patchQueueItem = (videoId, patch) => {
    originalPatch(videoId, patch)
    if (!once && patch.status === 'sampling') { once = true; pauseRun.runner.pause() }
  }
  const paused = await pauseRun.runner.start({ target: 50, sources: { keywords: ['找对象'], tags: ['搭子'] }, budgets: { valueThreshold: 1 } })
  pausedBatch = paused.batch
  assert.equal(pausedBatch.status, 'paused')
  assert.equal(pausedBatch.stopCode, 'USER_PAUSE')
  const resumed = await pauseRun.runner.resume()
  assert.equal(resumed.batch.status, 'done')
  const ids = resumed.batch.added.map(x => x.candidateId)
  assert.equal(new Set(ids).size, ids.length, '继续后不重复入批')

  const stopRun = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] }, tags: { 搭子: [{ id: V.tag, title: 'b' }] } })
  stopRun.runner.patchQueueItem = (videoId, patch) => {
    originalPatch.call(stopRun.runner, videoId, patch)
    if (patch.status === 'sampling') stopRun.runner.stop()
  }
  const stopped = await stopRun.runner.start({ target: 50, sources: { keywords: ['找对象'], tags: ['搭子'] }, budgets: { valueThreshold: 1 } })
  assert.equal(stopped.batch.status, 'stopped')
  assert.equal(stopped.batch.stopCode, 'USER_STOP')

  // 重启恢复：running → interrupted，可继续
  const recoverRun = harness({ keywords: { 找对象: [{ id: V.keyword }] } })
  recoverRun.manager.save({ ...recoverRun.manager.get(), batch: { id: 'b1', status: 'running', added: [], queue: [], config: {} } })
  recoverRun.runner.recoverOnBoot()
  assert.equal(recoverRun.runner.state.status, 'interrupted')
  assert.equal(recoverRun.runner.state.reason.includes('重启'), true)
})

// —— 7. 不感兴趣 / 清空后不再推荐 ——
test('P2-17B.2-07 不感兴趣与清空本批都写入去重记录，下一批不再推荐同一账号', async () => {
  const h = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] } })
  const first = await h.runner.start({ target: 5, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  const target = first.cards.find(c => c.nickname === '合成-甲')
  h.runner.skipAccount(target.platformUserId, 'not_interested')
  // 与 discovery:batch-not-interested 主进程一致：同时记为审核排除，候选池「待审核」里不再出现。
  const reviewed = h.manager.review(target.id, { status: 'REJECTED', note: '不感兴趣（批次内人工排除）' })
  assert.equal(reviewed.candidate.discoveryStatus, 'REJECTED', '不感兴趣应把候选移出待审核')
  assert.equal(reviewed.candidate.review.status, 'rejected')
  const cleared = h.runner.state.added.filter(x => x.candidateId !== target.id)
  h.runner.save({ added: cleared, status: 'done' })

  const poolBefore = h.manager.get().candidates.length
  const second = await h.runner.start({ target: 5, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  assert.ok(!second.batch.added.some(x => x.platformUserId === target.platformUserId), '不感兴趣的人不能再次推荐')
  // P2-17B.3 语义收紧：上一批已在池里的人不占新批次名额（目标 N 人 = N 个新面孔），
  // 但仍会参与评估并合并资料（来源刷新），所以池不膨胀。
  assert.equal(second.batch.added.length, 0, '池内已有人不应再次进本批名单')
  assert.ok(second.batch.progress.poolExisting >= 1, '池内已有人应被识别并计数')
  assert.equal(h.manager.get().candidates.length, poolBefore, '重复评估不应让候选池膨胀')
})

// —— 8. 重复执行不重复生成候选 ——
test('P2-17B.2-08 同一视频重复执行不重复生成候选、不重复入批', async () => {
  const h = harness({ keywords: { 找对象: [{ id: V.keyword, title: 'a' }] } })
  const first = await h.runner.start({ target: 5, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  const countAfterFirst = h.manager.get().candidates.length
  const second = await h.runner.start({ target: 5, sources: { keywords: ['找对象'] }, budgets: { valueThreshold: 1 } })
  assert.equal(h.manager.get().candidates.length, countAfterFirst, '候选池不应因重复执行膨胀')
  const ids = second.batch.added.map(x => x.candidateId)
  assert.equal(new Set(ids).size, ids.length)
  // 第二次是“读到但无新增评论”，不能报成“没有评论”
  const item = second.batch.queue.find(q => q.videoId === V.keyword)
  assert.equal(item.stages.code, 'COLLECTED_NO_NEW')
  assert.equal(item.stages.fresh, 0)
  assert.equal(item.stages.existing, 4)
})

// —— 9. 采集结果分类契约 ——
test('P2-17B.2-09 采集结果分类：每种结果都有明确含义，失败类不可用于价值判断', () => {
  const cases = [
    [{ ok: true, added: 2, fetched: 5 }, { added: 2, fetched: 5 }, 'COLLECTED_NEW'],
    [{ ok: true, added: 0, fetched: 5 }, {}, 'COLLECTED_NO_NEW'],
    [{ ok: true, added: 0, fetched: 0, empty: true }, {}, 'NO_COMMENTS'],
    [{ ok: true, added: 0, fetched: 0 }, {}, 'PANEL_NOT_LOADED'],
    [{ ok: false, code: 'COMMENTS_UNAVAILABLE' }, {}, 'PANEL_NOT_LOADED'],
    [{ ok: false, code: 'COMMENTS_CLOSED' }, {}, 'COMMENTS_CLOSED'],
    [{ ok: false, code: 'VIDEO_NOT_FOUND' }, {}, 'VIDEO_NOT_FOUND'],
    [{ ok: false, code: 'CONTENT_UNSUPPORTED' }, {}, 'CONTENT_UNSUPPORTED'],
    [{ ok: false, code: 'LOGIN_REQUIRED' }, {}, 'LOGIN_REQUIRED'],
    [{ ok: false, code: 'CHALLENGE' }, {}, 'VERIFICATION_REQUIRED'],
    [{ ok: false, code: 'RATE_LIMITED' }, {}, 'RATE_LIMITED'],
    [{ ok: false, code: 'NETWORK_ERROR', reason: 'timeout of 18000ms exceeded' }, {}, 'TIMEOUT'],
    [{ ok: false, code: 'NETWORK_ERROR' }, {}, 'NETWORK_ERROR'],
    [{ ok: false }, {}, 'ERROR'],
  ]
  for (const [result, extra, code] of cases) {
    const diagnosis = classifyCollection(result, extra)
    assert.equal(diagnosis.code, code, `${JSON.stringify(result)} 应归为 ${code}`)
    assert.ok(diagnosis.label)
    if (['PANEL_NOT_LOADED', 'COMMENTS_CLOSED', 'VIDEO_NOT_FOUND', 'CONTENT_UNSUPPORTED', 'LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'ERROR'].includes(code)) {
      assert.equal(diagnosis.judgeable, false, `${code} 不能用于判断视频价值`)
    }
  }
  // “0 新增但有历史评论”是读取成功
  assert.equal(classifyCollection({ ok: true, added: 0, fetched: 0 }, { existing: 3 }).code, 'COLLECTED_NO_NEW')
  assert.equal(COLLECTION_CODES.NO_COMMENTS.judgeable, true)
})

// —— 10. 按需读取回复的状态机与缓存 ——
test('P2-17B.2-10 回复读取：参数校验、空/失败/部分加载、缓存去重', async () => {
  const calls = []
  const transport = {
    async readReplies({ videoId, commentId }) {
      calls.push({ videoId, commentId })
      return { ok: true, videoId, commentId, total: 12, loaded: 12, hasMore: false,
        replies: [{ replyId: 'r1', author: 'A', text: '同问' }, { replyId: 'r1', author: 'A', text: '同问' }, { replyId: 'r2', author: 'B', text: '我也在广东' }] }
    },
  }
  const cache = new ReplyCache(null)
  const reader = new ReplyReader({ transport, cache })
  const first = await reader.read({ videoId: '7300000000000000001', commentId: '7490000000000000101' })
  assert.equal(first.ok, true)
  assert.equal(first.state, 'complete')
  assert.equal(first.replies.length, 2, '同一 replyId 应去重')
  const second = await reader.read({ videoId: '7300000000000000001', commentId: '7490000000000000101' })
  assert.equal(second.cached, true)
  assert.equal(calls.length, 1, '第二次点开应命中缓存，不再读页面')
  const page = await reader.read({ videoId: '7300000000000000001', commentId: '7490000000000000101' }, { cursor: 1 })
  assert.equal(page.replies.length, 1)
  assert.equal(page.state, 'complete')

  const wrongVideo = await reader.read({ videoId: 'abc', commentId: '1' })
  assert.equal(wrongVideo.code, 'VIDEO_ID_INVALID')
  const noComment = await reader.read({ videoId: '7300000000000000001', commentId: '' })
  assert.equal(noComment.code, 'COMMENT_ID_MISSING')

  const failing = new ReplyReader({ transport: { async readReplies() { return { ok: false, code: 'CHALLENGE' } } }, cache: new ReplyCache(null) })
  const failed = await failing.read({ videoId: '7300000000000000001', commentId: '7490000000000000009' })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.retryable, false)

  const empty = new ReplyReader({ transport: { async readReplies() { return { ok: true, videoId: '7300000000000000001', commentId: '7490000000000000008', replies: [], total: 0, hasMore: false } } }, cache: new ReplyCache(null) })
  assert.equal((await empty.read({ videoId: '7300000000000000001', commentId: '7490000000000000008' })).state, 'empty')

  const partial = new ReplyReader({ transport: { async readReplies() { return { ok: true, videoId: '7300000000000000001', commentId: '7490000000000000007', total: 30, hasMore: true,
    replies: Array.from({ length: 10 }, (_, i) => ({ replyId: `p${i}`, text: `回复${i}` })) } } }, cache: new ReplyCache(null) })
  const p = await partial.read({ videoId: '7300000000000000001', commentId: '7490000000000000007' })
  assert.equal(p.state, 'partial')
  assert.equal(p.partial, true)
  assert.match(p.note, /可继续加载/)
})

// —— 11. 评论字段契约：IP / 回复数 入库、缺失为 null ——
test('P2-17B.2-11 评论 IP 与回复数：有则保存并带来源，无则 null + not_present，不用主页顶替', () => {
  const withIp = rowToComment({ commentId: '1', platformUserId: 'S1', nickname: '甲', commentText: '你好', replyCount: 3, ipLocation: '广东', ipLocationSource: 'footer_region' }, { videoId: V.keyword })
  assert.equal(withIp.ip_location, '广东')
  assert.equal(withIp.ip_location_source, 'footer_region')
  assert.equal(withIp.reply_count, 3)
  const noIp = rowToComment({ commentId: '2', platformUserId: 'S2', nickname: '乙', commentText: '在吗', replyCount: null, ipLocation: null, ipLocationSource: 'not_present' }, { videoId: V.keyword })
  assert.equal(noIp.ip_location, null)
  assert.equal(noIp.ip_location_source, 'not_present')
  assert.equal(noIp.reply_count, null)
  // 0 条回复是“确认 0”，不能和未知混为一谈
  const zero = rowToComment({ commentId: '3', platformUserId: 'S3', nickname: '丙', commentText: '顶', replyCount: 0 }, { videoId: V.keyword })
  assert.equal(zero.reply_count, 0)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p217b2-contract-'))
  const store = new LibraryStore(dir)
  store.addComments([withIp, noIp, zero])
  const saved = store.read().comments
  assert.equal(saved.find(c => c.comment_id === '1').ip_location, '广东')
  assert.equal(saved.find(c => c.comment_id === '2').ip_location, null)
  assert.equal(saved.find(c => c.comment_id === '3').reply_count, 0)
})

test('P2-17B.2-12 回复归一化：缺正文丢弃、同人去重、长文本截断', () => {
  const list = normalizeReplies([
    { replyId: 'a', author: '甲', text: '  第一句  ' },
    { replyId: 'a', author: '甲', text: '第一句' },
    { replyId: 'b', author: '乙', text: '' },
    { replyId: 'c', author: '丙', text: 'x'.repeat(900) },
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].text, '第一句')
  assert.ok(list[1].text.length <= 500)
})

// —— 10. 收藏夹来源：自动进用户收藏夹读取，未配置/失败不静默 0 视频（P2-17B.3）——
test('P2-17B.3-10 收藏夹来源先同步再取视频；未设置收藏夹名称时明确停止原因', async () => {
  const emptyLibrary = { ...replay, videos: [] }
  const h = harness({ library: emptyLibrary, keywords: {}, tags: {} })
  h.runner.deps.syncFavorites = async () => ({ ok: false, code: 'CONFIG_MISSING', nextAction: '请设置收藏夹名称' })
  const r = await h.runner.start({ target: 1, sources: { favorites: true }, budgets: { valueThreshold: 1 } })
  assert.equal(r.batch.stopCode, 'FAVORITES_EMPTY', '收藏夹为空不能报成普通候选不足')
  assert.match(r.batch.reason, /收藏夹同步失败|收藏夹名称/)
  assert.ok((r.batch.warnings || []).some(w => /收藏视频/.test(w)), '启动时就应提示收藏夹未同步')
  const run = r.batch.sourceRuns.find(x => x.sourceType === 'favorites')
  assert.equal(run.ok, false)
  assert.equal(run.events[0].sync.code, 'CONFIG_MISSING')

  // 同步成功后按素材库收藏视频入队，并保留同步结果作为来源证据
  const h2 = harness({ keywords: {}, tags: {} })
  let synced = 0
  h2.runner.deps.syncFavorites = async () => { synced++; return { ok: true, found: 1, added: 1 } }
  const ok = await h2.runner.start({ target: 1, sources: { favorites: true }, budgets: { valueThreshold: 3 } })
  assert.equal(synced, 1, '收藏夹来源必须先同步一次')
  const favRun = ok.batch.sourceRuns.find(x => x.sourceType === 'favorites')
  assert.equal(favRun.ok, true)
  assert.equal(favRun.events[0].sync.ok, true)
  assert.ok(favRun.videos >= 1)
})

function roundsHarness(t, { friendly, pages, favorites = false }) {
  const target = V.keyword
  const h = harness({ library: {}, keywords: { 找对象: [{ id: target, title: '找对象搭子' }] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  const rows = Array.from({ length: pages }, (_, index) => ({
    commentId: String(index + 1), platformUserId: `MS4wLjABAAAA_rounds_${String(index).padStart(4, '0')}`,
    nickname: `测试${index}`, commentText: friendly.includes(index) ? '我想找个搭子' : '普通评论',
  }))
  const reads = [], opens = []
  h.runner.deps.enableVideoRounds = true
  h.runner.deps.draftOpening = null
  h.runner.deps.collectorFactory = () => new CommentCollector({
    store: h.store,
    transport: {
      async prepare({ videoId }) { opens.push(videoId); return { ok: true, videoId } },
      async readPage({ page }) {
        reads.push(page)
        const visible = rows.slice(page * 60, (page + 1) * 60)
        return { ok: true, rows: visible, empty: visible.length === 0 }
      },
    },
  })
  h.runner.deps.classify = async keys => {
    const data = h.store.read()
    for (const comment of data.comments.filter(item => keys.includes(item.key))) {
      comment.classification = { intent: comment.text.includes('搭子') ? 'SEEKING_FRIENDS' : 'ORDINARY', confidence: 0.9, evidence: [] }
    }
    h.store.save(data)
    return { aiCalls: 1 }
  }
  if (favorites) h.store.addVideo({ key: `v:id:${target}`, video_id: target, video_url: video(target).videoUrl, title: '找对象搭子', source: 'favorites' })
  const run = (count, useFavorites = false, budgets = {}) => h.runner.start({
    target: count, sources: { keywords: ['找对象'], favorites: useFavorites }, budgets: { maxComments: 150, maxAiCalls: 30, ...budgets },
  })
  const state = () => h.runner.videoProgress({ videoId: target })
  return { ...h, reads, opens, run, state }
}

test('同页连续试采 30、40、50，本轮有一条意愿即可深挖并保留合格候选', async t => {
  const h = roundsHarness(t, { friendly: [0, 1, 20, 21, 22, 53, 55], pages: 130 })
  const { batch } = await h.run(20)
  assert.equal(batch.stopCode, 'QUEUE_EXHAUSTED')
  assert.equal(batch.added.length, 7)
  assert.equal(h.state().status, 'pass')
  assert.equal(h.state().round, 2)
  assert.equal(h.state().count, 50)
  assert.equal(h.state().interested, 0)
  assert.equal(batch.progress.commentBudgetUsed, 120)
  assert.equal(h.opens.length, 1)
  assert.deepEqual(h.reads, [0, 1])
})

test('达标保留未完成轮次，跨批从已读素材继续并避免打开 PASS 视频', async t => {
  const h = roundsHarness(t, { friendly: [0, 1, 21], pages: 90 })
  const first = await h.run(1)
  assert.equal(first.batch.stopCode, 'TARGET_REACHED')
  assert.equal(h.state().count, 1)
  assert.equal(h.state().interested, 1)
  const second = await h.run(20)
  assert.equal(second.batch.added.length, 2)
  assert.equal(h.state().status, 'pass')
  assert.equal(h.state().round, 1)
  assert.equal(h.state().count, 40)
  const opened = h.opens.length
  assert.equal((await h.run(20)).batch.queue[0].code, 'VIDEO_PASS')
  assert.equal(h.opens.length, opened)
})

test('收藏夹覆盖自动搜索的 PASS 并继续读取未处理的评论', async t => {
  const h = roundsHarness(t, { friendly: [1, 75], pages: 100, favorites: true })
  assert.equal((await h.run(20)).batch.added.length, 1)
  assert.equal(h.state().status, 'pass')
  const second = await h.run(20, true)
  assert.equal(second.batch.queue[0].sourceType, 'favorites')
  assert.equal(second.batch.added.length, 1)
  assert.equal(h.state().status, 'exhausted')
})

test('分类无法继续时保留采样进度，低样本不会误判为 PASS', async t => {
  const h = roundsHarness(t, { friendly: [], pages: 30 })
  h.runner.deps.classify = async () => ({ aiCalls: 1 })
  const { batch } = await h.run(20)
  assert.equal(batch.queue[0].code, 'CLASSIFICATION_PENDING')
  assert.equal(h.state().count, 0)
  assert.equal(h.state().status, 'open')
})

test('单关键词队列读完时用原词的下一页游标继续寻找', async t => {
  const h = roundsHarness(t, { friendly: [], pages: 20 })
  const offsets = []
  h.runner.sourcesFactory = () => ({
    async collectByKeyword(query, { startOffset = 0 } = {}) {
      assert.equal(query, '找对象')
      offsets.push(startOffset)
      return { ok: true, videos: [video(startOffset ? V.tag : V.keyword, query)], pages: 1,
        nextOffset: startOffset ? null : 10, events: [] }
    },
  })
  const result = await h.run(20)
  assert.deepEqual(offsets, [0, 10])
  assert.equal(result.batch.queue.length, 2)
  assert.equal(result.batch.stopCode, 'QUEUE_EXHAUSTED')
})

test('batch confirms public gender only after comment filters and uses that comment in the card', async t => {
  const requested = []
  const rows = [
    ['ordinary', '普通评论', '湖南'],
    ['wrong_region', '想找个搭子', '湖北'],
    ['missing_region', '想找个搭子', null],
    ['missing_gender', '想找个聊天搭子', '湖南'],
    ['eligible', '想认识一起聊天', '湖南省'],
    ['after_target', '想找个搭子', '湖南'],
  ].map(([id, text, ip], index) => ({
    commentId: String(index + 1), platformUserId: `MS4wLjABAAAA_screening_${id}`,
    nickname: `合成${index}`, commentText: text, replyCount: index, ipLocation: ip,
  }))
  const h = harness({ library: {}, pages: { [V.keyword]: [rows.slice()] }, keywords: { 找对象: [{ id: V.keyword, title: '找对象搭子' }] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  h.runner.deps.enableVideoRounds = true
  h.runner.deps.draftOpening = null
  h.runner.deps.engine = { async readBatchGender(record) {
    requested.push(record.platformUserId)
    if (record.platformUserId === rows[3].platformUserId) return { status: 'not_present' }
    return { status: 'found', publicSignals: { genderText: '女' }, publicProfile: { rawText: '性别：女' } }
  } }
  const result = await h.runner.start({
    target: 1, sources: { keywords: ['找对象'] }, filters: { gender: 'female', requireIp: true, ipValues: ['湖南'] },
  })
  assert.deepEqual(requested, [rows[3].platformUserId, rows[4].platformUserId])
  assert.equal(result.batch.stopCode, 'TARGET_REACHED')
  assert.equal(result.batch.progress.genderFound, 1)
  assert.equal(result.batch.progress.genderMissing, 1)
  const [card] = h.runner.status().cards
  assert.equal(card.gender, 'female')
  assert.equal(card.comment, rows[4].commentText)
  assert.equal(card.commentIp, rows[4].ipLocation)
  assert.equal(card.commentId, rows[4].commentId)
  assert.equal(card.replyCount, rows[4].replyCount)
})

test('reading an existing comment through the video round refreshes metadata without replacing its classification', async t => {
  const stored = { ...replay.comments[0], ip_location: null, ip_location_source: 'not_present', reply_count: null }
  const h = harness({ library: { ...replay, comments: [stored] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  const { createVideoReader } = require('../electron/discovery/video-rounds.cjs')
  const reader = createVideoReader({
    transport: { prepare: async () => ({ ok: true, videoId: stored.video_id }) },
    readPageWithRetry: async ({ page }) => page === 0 ? { ok: true, rows: [{
      commentId: stored.comment_id, commentText: stored.text, platformUserId: stored.author_id,
      nickname: stored.author_name, ipLocation: '湖南', ipLocationSource: 'footer_region', replyCount: 0,
    }] } : { ok: true, rows: [], empty: true },
  }, h.store, { videoId: stored.video_id, videoUrl: stored.video_url })
  const before = h.store.read().comments[0]
  const result = await reader({ limit: 1, alive: () => true })
  const [after] = h.store.read().comments
  assert.equal(result.added, 0)
  assert.deepEqual(after.classification, before.classification)
  assert.equal(after.ip_location, '湖南')
  assert.equal(after.reply_count, 0)
})

test('unknown public genders are bounded to twice the target and never enter the batch', async t => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ commentId: `gender_limit_${i}`, platformUserId: `MS4wLjABAAAA_gender_limit_${i}`, nickname: `合成${i}`, commentText: '想找个聊天搭子', replyCount: 0 }))
  const h = harness({ library: {}, pages: { [V.keyword]: [rows] }, keywords: { 找对象: [{ id: V.keyword, title: '聊天搭子' }] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  let checks = 0
  h.runner.deps.enableVideoRounds = true; h.runner.deps.draftOpening = null
  h.runner.deps.engine = { async readBatchGender() { checks++; return { status: 'not_present' } } }
  const result = await h.runner.start({ target: 1, sources: { keywords: ['找对象'] }, filters: { gender: 'female' } })
  assert.equal(checks, 2); assert.equal(result.batch.progress.genderChecks, 2)
  assert.equal(result.batch.progress.genderMissing, 2); assert.equal(result.batch.added.length, 0)
})

test('unrestricted gender filtering does not open author profiles', async t => {
  const rows = [{ commentId: 'gender_any_1', platformUserId: 'MS4wLjABAAAA_gender_any', nickname: '合成作者', commentText: '想找个聊天搭子', replyCount: 0 }]
  const h = harness({ library: {}, pages: { [V.keyword]: [rows] }, keywords: { 找对象: [{ id: V.keyword, title: '聊天搭子' }] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  h.runner.deps.enableVideoRounds = true; h.runner.deps.draftOpening = null
  h.runner.deps.engine = { async readBatchGender() { throw Error('Gender is unrestricted: profile navigation is forbidden') } }
  const result = await h.runner.start({ target: 1, sources: { keywords: ['找对象'] }, filters: { gender: 'any' } })
  assert.equal(result.batch.progress.genderChecks, 0); assert.equal(result.batch.added.length, 1)
})

test('the same unverified author in two videos is checked only once within an account batch', async t => {
  const row = { platformUserId: 'MS4wLjABAAAA_gender_dedup', nickname: '合成作者', commentText: '想找个聊天搭子', replyCount: 0 }
  const h = harness({ library: {}, pages: { [V.keyword]: [[{ ...row, commentId: 'gender_dedup_1' }]], [V.tag]: [[{ ...row, commentId: 'gender_dedup_2' }]] }, keywords: { 找对象: [{ id: V.keyword, title: '聊天搭子' }, { id: V.tag, title: '交友搭子' }] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  let checks = 0
  h.runner.deps.enableVideoRounds = true; h.runner.deps.draftOpening = null
  h.runner.deps.engine = { async readBatchGender() { checks++; return { status: 'not_present' } } }
  const result = await h.runner.start({ target: 3, sources: { keywords: ['找对象'] }, filters: { gender: 'female' } })
  assert.equal(result.batch.queue.length, 2); assert.equal(checks, 1)
  assert.equal(result.batch.progress.genderChecks, 1); assert.equal(result.batch.added.length, 0)
})

test('a profile verification challenge stops the batch before checking the next author', async t => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ commentId: `gender_challenge_${i}`, platformUserId: `MS4wLjABAAAA_gender_challenge_${i}`, nickname: '合成作者', commentText: '想找个聊天搭子', replyCount: 0 }))
  const h = harness({ library: {}, pages: { [V.keyword]: [rows] }, keywords: { 找对象: [{ id: V.keyword, title: '聊天搭子' }] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  let checks = 0
  h.runner.deps.enableVideoRounds = true; h.runner.deps.draftOpening = null
  h.runner.deps.engine = { async readBatchGender() { checks++; return { status: 'blocked', code: 'CHALLENGE' } } }
  const result = await h.runner.start({ target: 3, sources: { keywords: ['找对象'] }, filters: { gender: 'female' } })
  assert.equal(checks, 1); assert.equal(result.batch.status, 'paused'); assert.equal(result.batch.stopCode, 'CHALLENGE')
  assert.equal(result.batch.queue[0].failureStage, 'profile_read'); assert.equal(result.batch.added.length, 0)
})

test('comment opening diagnostics survive the video reader and are stored with the failed queue item', async t => {
  const h = harness({ library: {}, keywords: { 找对象: [{ id: V.keyword, title: '聊天搭子' }] } })
  t.after(() => fs.rmSync(h.dir, { recursive: true, force: true }))
  h.runner.deps.enableVideoRounds = true
  const diagnostics = { stage: 'comment_open', attempts: 0, clicks: 0, lastErrorPhase: 'state_read', lastScriptError: 'Execution context was destroyed' }
  h.runner.deps.collectorFactory = () => ({
    transport: { prepare: async () => ({ ok: true, videoId: V.keyword }) },
    readPageWithRetry: async () => ({ ok: false, code: 'COMMENTS_UNAVAILABLE', reason: '评论页面状态读取失败，尚未执行展开点击', diagnostics }),
  })
  const result = await h.runner.start({ target: 1, sources: { keywords: ['找对象'] } })
  assert.equal(result.batch.queue[0].code, 'COMMENTS_UNAVAILABLE')
  assert.deepEqual(result.batch.queue[0].readDiagnostics, diagnostics)
  assert.equal(result.batch.added.length, 0)
})

test('a retryable profile failure can recover on a later video within the original quota', async t => {
  const author='MS4wLjABAAAA_profile_retry',row={platformUserId:author,nickname:'本地重试样本',commentText:'想找个聊天搭子',replyCount:0}
  const h=harness({library:{},pages:{[V.keyword]:[[{...row,commentId:'retry-a'}]],[V.tag]:[[{...row,commentId:'retry-b'}]]},keywords:{找对象:[{id:V.keyword,title:'交友'},{id:V.tag,title:'聊天搭子'}]}})
  const originalNow=Date.now;let clock=originalNow(),checks=0;t.after(()=>{Date.now=originalNow})
  const make=h.runner.deps.collectorFactory
  h.runner.deps.collectorFactory=()=>{const c=make(),prepare=c.transport.prepare.bind(c.transport);c.transport={...c.transport,prepare:async input=>{if(input.videoId===V.tag)clock+=31000;return prepare(input)}};return c}
  Date.now=()=>clock;h.runner.deps.enableVideoRounds=true;h.runner.deps.draftOpening=null
  h.runner.deps.engine={async readBatchGender(){checks++;return checks===1?{status:'failed',code:'PROFILE_HEADER_TIMEOUT',reason:'公开资料区未就绪',retryable:true,diagnostics:{elapsedMs:18000}}:{status:'found',code:'PROFILE_GENDER_FOUND',publicSignals:{genderText:'女'},publicProfile:{rawText:'性别：女'}}}}
  const result=await h.runner.start({target:3,sources:{keywords:['找对象']},filters:{gender:'female'}})
  assert.equal(checks,2);assert.equal(result.batch.progress.genderChecks,2);assert.equal(result.batch.progress.genderErrors,1);assert.equal(result.batch.progress.genderFound,1)
  assert.equal(result.batch.genderReadResults.length,2);assert.equal(result.batch.genderReadResults[0].code,'PROFILE_HEADER_TIMEOUT');assert.equal(result.batch.genderReadResults[1].readAttempts,2)
  assert.equal(result.batch.added.length,1)
})
test('retryable failures remain bounded to two author attempts and the account batch quota', async t => {
  const author='MS4wLjABAAAA_profile_retry_cap',row={platformUserId:author,nickname:'本地上限样本',commentText:'想找个聊天搭子',replyCount:0},videos=[V.keyword,V.tag,V.favorites]
  const pages=Object.fromEntries(videos.map((id,i)=>[id,[[{...row,commentId:'cap-'+i}]]]))
  const h=harness({library:{},pages,keywords:{找对象:videos.map(id=>({id,title:'聊天搭子'}))}})
  const originalNow=Date.now;let clock=originalNow(),checks=0;t.after(()=>{Date.now=originalNow})
  const make=h.runner.deps.collectorFactory
  h.runner.deps.collectorFactory=()=>{const c=make(),prepare=c.transport.prepare.bind(c.transport);c.transport={...c.transport,prepare:async input=>{clock+=31000;return prepare(input)}};return c}
  Date.now=()=>clock;h.runner.deps.enableVideoRounds=true;h.runner.deps.draftOpening=null
  h.runner.deps.engine={async readBatchGender(){checks++;return {status:'failed',code:'PROFILE_SCRIPT_TIMEOUT',reason:'页面状态读取超时',retryable:true,diagnostics:{lastScriptError:'页面状态读取超时'}}}}
  const result=await h.runner.start({target:1,sources:{keywords:['找对象']},filters:{gender:'female'}})
  assert.equal(checks,2);assert.equal(result.batch.progress.genderChecks,2);assert.equal(result.batch.genderReadResults.length,2);assert.equal(result.batch.added.length,0)
  assert.equal(result.batch.genderReadResults[1].readAttempts,2);assert.match(result.batch.genderReadResults[0].diagnostics.lastScriptError,/读取超时/)
})

test('unavailable profiles are skipped per batch, retain source evidence, and do not block another candidate',async t=>{
 const missing='MS4wLjABAAAA_offline_unavailable',available='MS4wLjABAAAA_offline_available'
 const row={platformUserId:missing,nickname:'本地错误页',commentText:'想找个聊天搭子',replyCount:0}
 const h=harness({library:{},pages:{[V.keyword]:[[{...row,commentId:'unavailable-first'}]],[V.tag]:[[{...row,commentId:'unavailable-second'},{...row,platformUserId:available,nickname:'本地正常页',commentId:'available-next'}]]},keywords:{找对象:[{id:V.keyword,title:'聊天搭子'},{id:V.tag,title:'交友搭子'}]}})
 t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}))
 const originalNow=Date.now;let clock=originalNow();t.after(()=>{Date.now=originalNow})
 const make=h.runner.deps.collectorFactory
 h.runner.deps.collectorFactory=()=>{const c=make(),prepare=c.transport.prepare.bind(c.transport);c.transport={...c.transport,prepare:async input=>{clock+=31000;return prepare(input)}};return c}
 Date.now=()=>clock;h.runner.deps.enableVideoRounds=true;h.runner.deps.draftOpening=null
 const checked=[];h.runner.deps.engine={async readBatchGender(c){checked.push(c.platformUserId);return c.platformUserId===missing?{status:'failed',code:'PROFILE_UNAVAILABLE',reason:'页面提示用户不存在',retryable:false}:{status:'found',publicSignals:{genderText:'女'},publicProfile:{rawText:'性别：女'}}}}
 const {batch}=await h.runner.start({target:3,sources:{keywords:['找对象']},filters:{gender:'female'}})
 assert.deepEqual(checked,[missing,available]);assert.equal(batch.progress.genderChecks,2);assert.equal(batch.progress.genderErrors,1);assert.equal(batch.progress.genderUnavailable,1);assert.equal(batch.progress.genderMissing,0)
 assert.equal(batch.added.length,1);assert.equal(batch.added[0].platformUserId,available)
 const failure=batch.genderReadResults[0];assert.equal(failure.nextRetryAt,null);assert.equal(failure.sourceVideoId,V.keyword);assert.equal(failure.sourceCommentId,'unavailable-first');assert.equal(failure.sourceCommentText,row.commentText)
 assert.equal(batch.status,'done')
})

test('profile verification pause resumes the same batch and interrupted author without duplicating completed work',async t=>{
 const rows=Array.from({length:3},(_,i)=>({platformUserId:`offline-resume-${i}`,nickname:`本地样本${i}`,commentId:`resume-${i}`,commentText:'想找个聊天搭子',replyCount:0}))
 const h=harness({library:{},pages:{[V.keyword]:[rows]},keywords:{找对象:[{id:V.keyword,title:'聊天搭子'}]}});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}))
 h.runner.deps.enableVideoRounds=true;h.runner.deps.draftOpening=null
 let block=true,contacts=0;const checked=[];h.runner.deps.onBatchDone=async()=>{contacts++}
 h.runner.deps.engine={async readBatchGender(c){checked.push(c.platformUserId);return block&&c.platformUserId==='offline-resume-1'?{status:'blocked',code:'CHALLENGE',source:'登录窗口',reason:'请手动完成安全验证'}:{status:'found',publicSignals:{genderText:'女'},publicProfile:{rawText:'性别：女'}}}}
 const paused=await h.runner.start({target:3,sources:{keywords:['找对象']},filters:{gender:'female'},budgets:{maxMinutes:1}})
 const id=paused.batch.id;assert.equal(paused.batch.status,'paused');assert.equal(paused.batch.added.length,1);assert.equal(paused.batch.progress.videosFailed,0);assert.equal(paused.batch.progress.videosEvaluated,0);assert.equal(contacts,0)
 const originalNow=Date.now,clock=originalNow()+120000;Date.now=()=>clock;t.after(()=>{Date.now=originalNow})
 h.runner.deps.checkVerification=async()=>block?{ok:false,code:'CHALLENGE',source:'登录窗口',reason:'请手动完成安全验证'}:{ok:true}
 const still=await h.runner.resume();assert.equal(still.batch.status,'paused');assert.equal(checked.length,2);assert.equal(still.batch.id,id)
 block=false
 const result=await h.runner.resume();assert.equal(result.batch.id,id);assert.equal(result.batch.stopCode,'TARGET_REACHED');assert.equal(result.batch.added.length,3);assert.equal(contacts,1)
 assert.deepEqual(checked,['offline-resume-0','offline-resume-1','offline-resume-1','offline-resume-2']);assert.equal(new Set(result.batch.added.map(x=>x.platformUserId)).size,3)
 assert.ok(result.batch.verificationWaitMs>=120000);assert.equal(result.batch.progress.videosEvaluated,1);assert.equal(result.batch.progress.genderChecks,4)
})

test('source verification preserves planned sources and resumes only unfinished searches',async t=>{
 const rows=Object.fromEntries([V.keyword,V.tag].map((id,i)=>[id,[[{platformUserId:`offline-source-${i}`,nickname:'本地来源',commentId:`source-${i}`,commentText:'想找个聊天搭子',replyCount:0}]]]))
 const h=harness({library:{},pages:rows});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));let keywords=0,tags=0
 h.runner.deps.enableVideoRounds=true;h.runner.deps.draftOpening=null
 h.runner.sourcesFactory=()=>({collectByKeyword:async()=>{keywords++;return {ok:true,kind:'OK',videos:[video(V.keyword,'聊天搭子')],events:[]}},collectByTag:async()=>{tags++;return tags===1?{ok:false,kind:'CHALLENGE',videos:[],events:[]}:{ok:true,kind:'OK',videos:[video(V.tag,'交友搭子')],events:[]}}})
 // This legacy replay isolates unfinished-source resume; multi-term planning has dedicated tests.
 const first=await h.runner.start({target:2,sources:{keywords:['甲'],tags:['乙'],combinedSearch:false}});assert.equal(first.batch.status,'paused');assert.equal(first.batch.queue.length,1);assert.equal(first.batch.sourcePlanningPending,true)
 const result=await h.runner.resume();assert.equal(result.batch.id,first.batch.id);assert.equal(keywords,1);assert.equal(tags,2);assert.equal(result.batch.queue.length,2);assert.equal(result.batch.added.length,2);assert.equal(result.batch.sourcePlanningPending,false);assert.ok(result.batch.sourceRuns.every(x=>x.ok))
})

test('verification during search refill preserves the exact cursor for explicit continuation',async t=>{
 const rows=Object.fromEntries([V.keyword,V.tag].map((id,i)=>[id,[[{platformUserId:`offline-refill-${i}`,nickname:'本地翻页',commentId:`refill-${i}`,commentText:'想找个聊天搭子',replyCount:0}]]]))
 const h=harness({library:{},pages:rows});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));const offsets=[]
 h.runner.deps.enableVideoRounds=true;h.runner.deps.draftOpening=null
 h.runner.sourcesFactory=()=>({collectByKeyword:async(q,options)=>{offsets.push(options.startOffset??0);return offsets.length===1?{ok:true,kind:'OK',videos:[video(V.keyword,'聊天搭子')],events:[],nextOffset:10}:offsets.length===2?{ok:false,kind:'CHALLENGE',videos:[],events:[]}:{ok:true,kind:'OK',videos:[video(V.tag,'交友搭子')],events:[],nextOffset:null}}})
 const first=await h.runner.start({target:2,sources:{keywords:['翻页']}});assert.equal(first.batch.status,'paused');assert.equal(first.batch.added.length,1)
 const next=await h.runner.resume();assert.equal(next.batch.id,first.batch.id);assert.equal(next.batch.added.length,2);assert.deepEqual(offsets,[0,10,10])
})

test('an existing verification pauses before searching and continuation retains the original configuration',async t=>{
 const h=harness({library:{}});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));let blocked=true,calls=0
 h.runner.deps.checkVerification=async()=>blocked?{ok:false,code:'CHALLENGE',source:'收集评论窗口',reason:'请手动完成安全验证'}:{ok:true}
 h.runner.sourcesFactory=()=>({collectByKeyword:async q=>{calls++;assert.equal(q,'原目标');return {ok:true,kind:'OK',videos:[],events:[]}}})
 const first=await h.runner.start({target:2,sources:{keywords:['原目标']}});assert.equal(first.batch.status,'paused');assert.equal(calls,0);assert.equal(first.batch.verification.source,'收集评论窗口')
 blocked=false;const result=await h.runner.resume();assert.equal(result.batch.id,first.batch.id);assert.equal(calls,1);assert.equal(result.batch.config.target,2)
})

test('legacy collection interrupted by verification stays resumable without recording a failed video',async t=>{
 const h=harness({keywords:{找对象:[{id:V.keyword,title:'聊天搭子'}]}});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));let first=true;const make=h.runner.deps.collectorFactory
 h.runner.deps.collectorFactory=()=>{const c=make(),run=c.run.bind(c);c.run=async args=>{if(first){first=false;return {ok:false,code:'CHALLENGE',reason:'请手动完成安全验证'}}return run(args)};return c}
 const paused=await h.runner.start({target:1,sources:{keywords:['找对象']},budgets:{valueThreshold:1}});assert.equal(paused.batch.status,'paused');assert.equal(paused.batch.progress.videosFailed,0)
 const result=await h.runner.resume();assert.equal(result.batch.id,paused.batch.id);assert.equal(result.batch.added.length,1);assert.equal(result.batch.stopCode,'TARGET_REACHED')
})

test('an older CHALLENGE failure can resume and its blocked cache cannot suppress verification',async t=>{
 const row={platformUserId:'offline-old-challenge',nickname:'旧批次本地样本',commentId:'old-challenge',commentText:'想找个聊天搭子',replyCount:0}
 const h=harness({library:{},pages:{[V.keyword]:[[row]]},keywords:{找对象:[{id:V.keyword,title:'聊天搭子'}]}});t.after(()=>fs.rmSync(h.dir,{recursive:true,force:true}));let blocked=true,checks=0
 h.runner.deps.enableVideoRounds=true;h.runner.deps.draftOpening=null;h.runner.deps.engine={async readBatchGender(){checks++;return blocked?{status:'blocked',code:'CHALLENGE'}:{status:'found',publicSignals:{genderText:'女'}}}}
 const first=await h.runner.start({target:2,sources:{keywords:['找对象']},filters:{gender:'female'}})
 h.runner.save({status:'failed',finishedAt:new Date().toISOString(),progress:{...first.batch.progress,videosEvaluated:1,videosFailed:1},queue:first.batch.queue.map(x=>({...x,status:'failed'}))})
 blocked=false;const result=await h.runner.resume();assert.equal(result.batch.id,first.batch.id);assert.equal(checks,2);assert.equal(result.batch.added.length,1);assert.equal(result.batch.progress.videosFailed,0);assert.equal(result.batch.progress.videosEvaluated,1)
})
