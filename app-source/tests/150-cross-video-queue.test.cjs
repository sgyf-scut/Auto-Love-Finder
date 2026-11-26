const { test } = require('node:test'), assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const B = 'SEEKING_FRIENDS', O = 'ORDINARY'
function fixture(sizes, { cross = true, retain = false, classify, engine, intent, collector } = {}) {
  const ids = sizes.map((_, i) => '73000000000000000' + String(i).padStart(2, '0'))
  let data = { videos: ids.map(video_id => ({ video_id, title: '交友组队' })), comments: sizes.flatMap((n, v) => Array.from({ length: n }, (_, i) => ({
    key: ids[v] + ':' + i, comment_id: String(i), video_id: ids[v], text: '报名一起玩' + i,
    author_id: 'a-' + v + '-' + i, author_name: '本地' + v + '-' + i, ip_location: '广东', reply_count: 0,
    ...(intent ? { classification: { intent, confidence: .9 } } : {}),
  }))) }
  const library = { read: () => structuredClone(data), save: v => { data = structuredClone(v) }, addVideo() {}, addComments: () => ({ added: 0 }) }
  const storage = createMemoryStorage({ contacts: [] }), manager = new CandidateManager(storage), requests = [], reads = []
  const runner = new BatchRunner({ storage, manager, libraryStore: library, accountId: 'offline', crossVideoClassification: cross, retainIntentPool: retain,
    enableVideoRounds: true, engine, emit() {}, sourcesFactory: () => ({ async collectByTag() { return { ok: true, videos: ids.map(videoId => ({ videoId, videoUrl: 'https://www.douyin.com/video/' + videoId, commentCount: 300 })) } } }),
    collectorFactory: () => ({ transport: { async prepare({ videoId }) { reads.push(videoId); return { ok: true, videoId } } }, async readPageWithRetry() { return collector ? collector() : { ok: true, rows: [], empty: true } } }),
    classify: async (keys, maxCalls) => {
      requests.push(keys)
      if (classify) return classify(keys, library, runner)
      const d = library.read(); for (const c of d.comments) if (keys.includes(c.key)) c.classification = { intent: O, confidence: .8 }
      library.save(d); return { aiCalls: 1, tokens: 100 }
    },
  })
  const config = { target: 100, minVideoComments: 0, sources: { tags: ['搭子'] }, sampling: { first: 30, second: 40, later: 50 }, budgets: { maxVideos: 30, maxComments: 400, maxAiCalls: 30 } }
  return { runner, storage, manager, library, requests, reads, ids, config }
}

test('small groups from several videos are combined, then the final remainder is flushed', async () => {
  const h = fixture([4, 6, 5, 7, 3]); const out = await h.runner.start(h.config)
  assert.deepEqual(h.requests.map(x => x.length), [20, 5])
  assert.equal(new Set(h.requests[0].map(key => key.split(':')[0])).size, 4)
  assert.equal(out.batch.classificationQueue.length, 0)
  assert.equal(out.batch.progress.videosEvaluated, 5)
  assert.equal(out.batch.progress.aiCalls, 2)
  assert.equal(h.requests.flat().length, new Set(h.requests.flat()).size)
})

test('an incomplete final group is classified and returns to the correct profile after changing videos', async () => {
  const profiles = []
  const h = fixture([2, 3], { classify: async (keys, library) => {
    const d = library.read(); for (const c of d.comments) if (keys.includes(c.key)) c.classification = { intent: B, confidence: .8 }
    library.save(d); return { aiCalls: 1 }
  }, engine: { async readBatchGender(record) { profiles.push(record.platformUserId); return { status: 'not_present' } } } })
  const out = await h.runner.start({ ...h.config, filters: { gender: 'female' } })
  assert.deepEqual(h.requests.map(x => x.length), [5]); assert.equal(profiles.length, 5)
  assert.equal(new Set(profiles).size, 5); assert.ok(profiles.some(x => x.startsWith('a-0-'))); assert.ok(profiles.some(x => x.startsWith('a-1-')))
  assert.equal(out.batch.profileDeferred.length, 5); assert.equal(out.batch.added.length, 0)
})

test('three distinct unavailable profiles disable only profile reading; later candidates remain pending', async () => {
  let profiles = 0
  const h = fixture([8], { intent: B, engine: { async readBatchGender() { profiles++; return { status: 'failed', code: 'PROFILE_UNAVAILABLE', retryable: false } } } })
  const out = await h.runner.start({ ...h.config, filters: { gender: 'female' }, maxProfileChecks: 4 })
  assert.equal(profiles, 3); assert.equal(out.batch.profileReadCircuit.disabled, true)
  assert.equal(out.batch.status, 'done'); assert.equal(out.batch.profileDeferred.length, 8)
  assert.equal(out.batch.progress.pending, 8); assert.equal(out.batch.added.length, 0)
  assert.equal(h.manager.get().candidates.length, 0)
})

test('after profile degradation classification still runs on subsequent videos and saves evidence', async () => {
  let profiles = 0
  const h = fixture([3, 3], { classify: async (keys, library) => {
    const d = library.read(); for (const c of d.comments) if (keys.includes(c.key)) c.classification = { intent: B }; library.save(d); return { aiCalls: 1 }
  }, engine: { async readBatchGender() { profiles++; return { status: 'failed', code: 'PROFILE_UNAVAILABLE' } } } })
  const out = await h.runner.start({ ...h.config, filters: { gender: 'female' } })
  assert.equal(profiles, 3); assert.equal(out.batch.profileDeferred.length, 6)
  assert.ok(out.batch.profileDeferred.every(row => row.profileUrl && row.source.videoId && row.source.commentText && row.record))
  assert.equal(out.batch.status, 'done')
})

test('same author cannot trip the circuit repeatedly and a successful profile breaks the failure streak', () => {
  const h = fixture([]); h.runner.save({ id: 'fixture', crossVideoClassification: true, queue: [], progress: {}, profileReadCircuit: null })
  const failed = { status: 'failed', code: 'PROFILE_UNAVAILABLE' }
  h.runner.observeProfileAccess('a', failed); h.runner.observeProfileAccess('a', failed); h.runner.observeProfileAccess('b', failed)
  assert.equal(h.runner.state.profileReadCircuit.disabled, false)
  h.runner.observeProfileAccess('c', { status: 'not_present' })
  h.runner.observeProfileAccess('d', failed); assert.deepEqual(h.runner.state.profileReadCircuit.failures, ['d'])
})

for (const code of ['CHALLENGE', 'PROFILE_ACCESS_RESTRICTED', 'LOGIN_REQUIRED']) test(code + ' still stops platform work immediately', async () => {
  let profiles = 0
  const h = fixture([5], { intent: B, engine: { async readBatchGender() { profiles++; return { status: 'blocked', code, reason: '本地夹具阻断' } } } })
  const out = await h.runner.start({ ...h.config, filters: { gender: 'female' } })
  assert.equal(profiles, 1); assert.notEqual(out.batch.status, 'done')
  assert.equal(out.batch.stopCode, code); assert.equal(out.batch.added.length, 0)
})

test('failed classifications use groups of at most 12 on retry with two attempts per comment', async () => {
  const h = fixture([20], { classify: async () => ({ aiCalls: 1 }) }); const out = await h.runner.start(h.config)
  assert.equal(h.requests[0].length, 20); assert.ok(h.requests.slice(1).every(keys => keys.length <= 12))
  assert.ok(Object.values(out.batch.classificationRetryCounts).every(n => n === 2))
  assert.equal(out.batch.classificationQueue.length, 0); assert.equal(out.batch.progress.aiCalls, 3)
})

test('AI budget of one still delivers classifications already completed without another model call', async () => {
  const h = fixture([4, 6]); const out = await h.runner.start({ ...h.config, budgets: { ...h.config.budgets, maxAiCalls: 1 } })
  assert.deepEqual(h.requests.map(x => x.length), [10]); assert.equal(out.batch.progress.videosEvaluated, 2)
  assert.equal(out.batch.classificationQueue.length, 0)
})

test('video collection budget flushes its remainder without opening further sources', async () => {
  const h = fixture([5, 5, 5]); const out = await h.runner.start({ ...h.config, budgets: { ...h.config.budgets, maxVideos: 1 } })
  assert.deepEqual(h.requests.map(x => x.length), [5]); assert.equal(out.batch.classificationQueue.length, 0)
  assert.ok(h.requests.flat().every(key => key.startsWith(h.ids[0])))
  assert.equal(out.batch.progress.videosEvaluated, 1)
})

test('flushing at end of the source list preserves deeper rounds on a promising video', async () => {
  const h = fixture([35], { classify: async (keys, library) => {
    const d = library.read(); for (const c of d.comments) if (keys.includes(c.key)) c.classification = { intent: B }; library.save(d); return { aiCalls: 1 }
  } })
  const out = await h.runner.start(h.config)
  assert.equal(new Set(h.requests.flat()).size, 35)
  assert.equal(out.batch.added.length, 35)
  assert.ok(h.runner.videoProgress({ videoId: h.ids[0] }).round >= 1)
})

test('pausing retains the cross-video queue; resuming uses saved keys and does not reclassify old results', async () => {
  const h = fixture([3, 3]); const real = h.runner.processVideoRounds.bind(h.runner); let interrupted = false
  h.runner.processVideoRounds = async (...args) => { await real(...args); if (!interrupted) { interrupted = true; h.runner.pause() } }
  const first = await h.runner.start(h.config)
  assert.equal(first.batch.status, 'paused'); assert.equal(first.batch.classificationQueue.length, 3); assert.equal(h.requests.length, 0)
  h.runner.processVideoRounds = real
  const second = await h.runner.resume()
  assert.equal(second.batch.classificationQueue.length, 0); assert.deepEqual(h.requests.map(x => x.length), [6])
})

test('a new runner restores the persisted queue after an application restart', async () => {
  const h = fixture([3, 3]); const real = h.runner.processVideoRounds.bind(h.runner)
  h.runner.processVideoRounds = async (...args) => { await real(...args); h.runner.pause() }
  await h.runner.start(h.config)
  const restarted = new BatchRunner({ ...h.runner.deps })
  const out = await restarted.resume()
  assert.equal(out.batch.status, 'done'); assert.equal(out.batch.classificationQueue.length, 0)
  assert.deepEqual(h.requests.map(x => x.length), [6])
})

test('resuming a verification interruption continues its reserved video without exceeding the video budget', async () => {
  let calls = 0
  const h = fixture([1, 1], { intent: B, engine: { async readBatchGender() {
    return ++calls === 1 ? { status: 'blocked', code: 'CHALLENGE' } : { status: 'not_present' }
  } } })
  const first = await h.runner.start({ ...h.config, filters: { gender: 'female' }, budgets: { ...h.config.budgets, maxVideos: 1 } })
  assert.equal(first.batch.status, 'paused')
  const out = await h.runner.resume()
  assert.equal(calls, 2); assert.equal(out.batch.progress.videosEvaluated, 1)
  assert.equal(out.batch.profileDeferred.length, 1)
})


test('intent pool persists candidates even when a profile read is interrupted by user stop', async () => {
  let h
  h = fixture([4], { intent: B, retain: true, engine: { async readBatchGender() { h.runner.stop(); return {status:'cancelled'} } } })
  const out = await h.runner.start({...h.config,filters:{gender:'female'}})
  assert.equal(out.batch.status,'stopped'); assert.equal(out.batch.added.length,0)
  assert.equal(h.manager.get().candidates.length,4)
  assert.ok(h.manager.get().candidates.every(c=>c.intentPoolOnly))
})

test('unknown gender leaves positive authors in all candidates while qualified authors enter the batch', async () => {
  const h=fixture([2],{intent:B,retain:true,engine:{async readBatchGender(){return {status:'not_present'}}}})
  const out=await h.runner.start({...h.config,filters:{gender:'female'}})
  assert.equal(out.batch.added.length,0);assert.equal(h.manager.get().candidates.length,2)
  assert.ok(h.manager.get().candidates.every(c=>c.batchScreening.status==='pending'))
  const free=fixture([2],{intent:B,retain:true})
  const done=await free.runner.start({...free.config,target:2})
  assert.equal(done.batch.added.length,2);assert.ok(free.manager.get().candidates.every(c=>!c.intentPoolOnly))
})
