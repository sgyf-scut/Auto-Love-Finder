const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { classifyComments, buildGroupedMessages, parseCommentResponse } = require('../electron/social-brain/comment-classifier.cjs')
const { runCommentLearning } = require('../electron/social-brain/comment-learning-runner.cjs')
const { LearningStore } = require('../electron/social-brain/comment-learning.cjs')
const { writeBackClassification } = require('../electron/discovery/library-classify-bridge.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { createMemoryStorage } = require('./setup.cjs')
const B = 'SEEKING_FRIENDS', C = 'CONTEXTUAL_INTEREST', O = 'ORDINARY'
const item = i => ({ key: 'c:' + i, text: '晚上缺一个一起玩的' + i, video: { video_id: 'v1', title: '同城交友组队' } })
const response = (items, intent = C) => items.map(x => ({ id: x.key, intent_category: intent, evidence: [x.text], confidence: .8, needs_review: false, reason: '结合视频参与' }))
const payload = messages => JSON.parse(messages[1].content.split('\n')[0])
function learningFixture(t, samples) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-recall-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new LearningStore(dir)
  store.replace({ samples: samples.map((x, i) => ({ key: 's:' + i, videoId: 'v1', videoTitle: '同城交友组队', ...x })) })
  return store
}

test('50 ambiguous comments share one context and use one call with sufficient output budget', async () => {
  const items = Array.from({ length: 50 }, (_, i) => item(i)), requests = []
  const result = await classifyComments({ items, recallFirst: true, batchSize: 50, maxCalls: 1, ai: {
    async inquiryCompletion(messages, options) {
      requests.push({ messages, options }); const p = payload(messages)
      assert.equal(p.comments.length, 50); assert.equal(p.videos.length, 1)
      return { text: JSON.stringify(response(items).reverse()), usage: { total: 7654 } }
    },
  } })
  assert.equal(requests.length, 1); assert.ok(requests[0].options.maxTokens >= 7500)
  assert.equal(result.results.length, 50); assert.equal(result.errors.length, 0)
  assert.deepEqual(result.results.map(x => x.key), items.map(x => x.key)); assert.equal(result.tokens, 7654)
})

test('a short sampling round is classified immediately without waiting for 50', async () => {
  const items = [item(1), item(2), item(3)]; let calls = 0
  const out = await classifyComments({ items, recallFirst: true, batchSize: 50, maxCalls: 1, ai: { async inquiryCompletion(m) {
    calls++; assert.equal(payload(m).comments.length, 3); return { text: JSON.stringify(response(items)) }
  } } })
  assert.equal(calls, 1); assert.equal(out.results.length, 3)
})

test('real AI service sends the requested 50-item budget; ordinary structured tasks retain their old cap', async () => {
  const { AiService } = require('../electron/ai-service.cjs')
  const storage = createMemoryStorage({ providers: [{ name: 'fixture', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only' }] })
  const bodies = [], items = Array.from({ length: 50 }, (_, i) => item(i))
  const ai = new AiService(storage, { transport: async (_url, _options, body) => {
    bodies.push(JSON.parse(body)); return { choices: [{ message: { content: JSON.stringify(response(items)) } }] }
  } })
  const out = await classifyComments({ ai, items, recallFirst: true, batchSize: 50, maxCalls: 1 })
  assert.equal(out.errors.length, 0); assert.equal(bodies[0].max_tokens, 7800)
  await ai.inquiryCompletion([{ role: 'user', content: 'local fixture' }], { structuredJson: true, maxTokens: 7800 })
  assert.equal(bodies[1].max_tokens, 1500)
})

for (const [name, corrupt] of [
  ['missing', xs => xs.slice(1)], ['duplicate', xs => [xs[0], xs[0]]],
  ['foreign', xs => [{ ...xs[0], id: 'other-person' }, xs[1]]],
  ['invalid intent', xs => [{ ...xs[0], intent_category: 'YES' }, xs[1]]],
]) test('strict response rejects ' + name + ' instead of assigning by position', () => {
  const items = [item(1), item(2)]
  assert.throws(() => parseCommentResponse(JSON.stringify(corrupt(response(items))), items, true))
})

test('shared human cases are deduplicated, have video context and preserve per-comment references', () => {
  const example = { key: 'example', text: '这枪真准', intent: O, reason: '只是评价', videoTitle: '游戏组队' }
  const items = [item(1), item(2)].map(x => ({ ...x, cases: [example] }))
  const p = payload(buildGroupedMessages(items, 'model_cases'))
  assert.equal(p.examples.length, 1); assert.equal(p.examples[0].videoTitle, '游戏组队')
  assert.deepEqual(p.comments.map(x => x.cases), [['e0'], ['e0']])
  assert.equal(payload(buildGroupedMessages(items, 'model')).examples.length, 0)
})

test('human correction beats positive rules; ambiguous ordinary and contextual rules go to model with training cases', async t => {
  const store = learningFixture(t, [
    { text: '私信我', human: { intent: O, reason: '人工已核对为引用', at: '2026-11-01T00:00:00Z' } },
    { text: '哈哈' }, { text: '报名' }, { text: '不要私信' }, { text: '私信领取优惠资料' }, { text: '想交朋友' },
    { text: '报名一起玩', human: { intent: B, reason: '明确参与', at: '2026-11-01T00:00:00Z' }, useForTraining: true },
    { text: '报名', human: { intent: O }, independentEval: true },
  ])
  let seen; let writes = 0; const save = store.save.bind(store); store.save = v => { writes++; return save(v) }
  const result = await runCommentLearning({ learningStore: store, recallFirst: true, mode: 'model_cases', scope: 'keys',
    keys: ['s:0', 's:1', 's:2', 's:3', 's:4', 's:5'], batchSize: 50, maxCalls: 1,
    ai: { async inquiryCompletion(m) {
      seen = payload(m)
      return { text: JSON.stringify(seen.comments.map(x => ({ id: x.id, intent_category: C, evidence: [x.text], confidence: .8 }))) }
    } },
  })
  assert.equal(result.task.aiCalls, 1); assert.deepEqual(seen.comments.map(x => x.id), ['s:1', 's:2'])
  assert.ok(seen.examples.some(x => x.text === '报名一起玩')); assert.ok(!seen.examples.some(x => x.text === '报名'))
  const rows = store.read().samples
  assert.equal(rows[0].ai.intent, O); assert.equal(rows[0].human.intent, O)
  assert.equal(rows[3].ai.intent, 'DO_NOT_CONTACT'); assert.equal(rows[4].ai.intent, 'ADVERTISEMENT'); assert.equal(rows[5].ai.intent, B)
  assert.deepEqual(rows[2].ai.caseKeys, ['s:6']); assert.ok(writes <= 2, 'batch results and task status each saved once')
})

test('quoted refusal, ordinary reactions and contact terms without commercial evidence are retained for model judgment', async t => {
  const texts = ['她说不要私信然后就笑了', '哈哈', '有一起加微信聊天的吗', '谢绝广告欢迎交友']
  const store = learningFixture(t, texts.map(text => ({ text }))); let seen
  await runCommentLearning({ learningStore: store, recallFirst: true, mode: 'model_cases', scope: 'keys', keys: store.read().samples.map(x => x.key), batchSize: 50, maxCalls: 1,
    ai: { async inquiryCompletion(m) { seen = payload(m).comments; return { text: JSON.stringify(seen.map(x => ({ id: x.id, intent_category: O, evidence: [x.text], confidence: .8 }))) } } } })
  assert.deepEqual(seen.map(x => x.text), texts)
})

test('batch persistence rejects attempts to mutate human annotations atomically', t => {
  const store = learningFixture(t, [{ text: '原文', human: { intent: B } }])
  assert.throws(() => store.recordPredictions([{ key: 's:0', prediction: { intent: O } }, { key: 's:0', prediction: { human: { intent: O } } }]))
  assert.equal(store.read().samples[0].human.intent, B); assert.equal(store.read().samples[0].ai, null)
})

test('a truncated batch remains retryable UNKNOWN and respects call budget', async () => {
  const items = Array.from({ length: 51 }, (_, i) => item(i)); let calls = 0
  const out = await classifyComments({ items, recallFirst: true, batchSize: 50, maxCalls: 1, ai: { async inquiryCompletion() { calls++; return { text: '[{"id":' } } } })
  assert.equal(calls, 1); assert.equal(out.results.length, 51)
  assert.ok(out.results.every(x => x.intent === 'UNKNOWN' && x.needsReview))
  assert.match(out.results[0].reason, /等待重试/); assert.match(out.results[50].reason, /超出调用预算/)
})

test('current human correction updates an older cached manual decision only with explicit preference', () => {
  let library = { comments: [{ key: 'k', classification: { intent: C, reviewedByUser: true, classifiedAt: '2026-11-01T00:00:00Z' } }] }
  const learningStore = { read: () => ({ samples: [{ key: 'k', human: { intent: O, at: '2026-11-02T00:00:00Z', reason: '改正' } }] }) }
  const libraryStore = { read: () => structuredClone(library), save: v => { library = v } }
  assert.equal(writeBackClassification({ libraryStore, learningStore, keys: ['k'] }).skipped, 1)
  assert.equal(writeBackClassification({ libraryStore, learningStore, keys: ['k'], preferHuman: true }).changed, 1)
  assert.equal(library.comments[0].classification.intent, O)
  assert.equal(writeBackClassification({ libraryStore, learningStore, keys: ['k'], preferHuman: true }).skipped, 1)
})

function batchFixture(count) {
  const vid = '7300000000000000001'
  let data = { videos: [{ video_id: vid, title: '交友' }], comments: Array.from({ length: count }, (_, i) => ({ key: 'k' + i, video_id: vid, text: '报名' + i, author_id: 'author' + i, author_name: '本地' + i })) }
  const library = { read: () => structuredClone(data), save: v => { data = structuredClone(v) }, addVideo() {}, addComments: () => ({ added: 0 }) }
  const storage = createMemoryStorage({ contacts: [] }), manager = new CandidateManager(storage)
  const runner = new BatchRunner({ storage, manager, libraryStore: library, accountId: 'fixture', enableVideoRounds: true, emit() {},
    sourcesFactory: () => ({ async collectByTag() { return { ok: true, videos: [{ videoId: vid, videoUrl: `https://www.douyin.com/video/${vid}`, commentCount: 500 }] } } }),
    collectorFactory: () => ({ transport: { async prepare() { return { ok: true, videoId: vid } } }, async readPageWithRetry() { return { ok: true, rows: [], empty: true } } }),
  })
  return { runner, library, config: { target: 10, minVideoComments: 0, sources: { tags: ['搭子'] }, sampling: { first: 50, second: 50, later: 50 } } }
}

test('a failed 50-comment batch retries in groups of at most 12 and no comment exceeds two attempts', async () => {
  const h = batchFixture(50), requests = []
  h.runner.deps.classify = async keys => {
    requests.push(keys)
    if (requests.length > 1) { const d = h.library.read(); for (const x of d.comments) if (keys.includes(x.key)) x.classification = { intent: O }; h.library.save(d) }
    return { aiCalls: 1 }
  }
  await h.runner.start(h.config)
  assert.equal(requests[0].length, 50); assert.ok(requests.slice(1).every(xs => xs.length <= 12))
  const counts = requests.flat().reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {})
  assert.equal(Object.keys(counts).length, 50); assert.ok(Object.values(counts).every(n => n === 2))
})

test('human label preparation runs before cached model results are consumed; hard gender filtering still applies', async () => {
  const h = batchFixture(1); let prepared = false
  let d = h.library.read(); d.comments[0].classification = { intent: O }; h.library.save(d)
  h.runner.deps.prepareClassification = () => { prepared = true; d = h.library.read(); d.comments[0].classification = { intent: B, reviewedByUser: true }; h.library.save(d) }
  const out = await h.runner.start({ ...h.config, filters: { gender: 'female' } })
  assert.ok(prepared); assert.equal(out.batch.added.length, 0)
  assert.ok(out.batch.progress.pending >= 1)
})
