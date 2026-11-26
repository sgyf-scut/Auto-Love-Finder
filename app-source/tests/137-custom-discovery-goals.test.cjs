const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMemoryStorage } = require('./setup.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { CustomGoalStore, commentSample } = require('../electron/discovery/custom-goals.cjs')
const { executeBatchContact } = require('../electron/discovery/batch-contact-service.cjs')
const { LibraryStore } = require('../electron/social-brain/library-store.cjs')

const videoId = '7300000000000000101'
const work = { videoId, videoUrl: `https://www.douyin.com/video/${videoId}`, title: '游戏区今晚组队' }
const comment = (index, text = '晚上缺一，想一起组队') => ({
  video_id: videoId, comment_id: String(index), author_id: `MS4wLjABAAAA_GOALS_${index}`,
  author_name: `示例${index}`, text,
})

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-goal-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const goalStore = new CustomGoalStore(dir)
  const libraryStore = new LibraryStore(dir)
  libraryStore.addVideo({ key: `v:id:${videoId}`, video_id: videoId, title: work.title, video_url: work.videoUrl })
  const storage = createMemoryStorage()
  const manager = new CandidateManager(storage)
  const requests = []
  let finishes = 0
  const deps = {
    manager, storage, accountId: 'fixture', goalStore, libraryStore, enableVideoRounds: true,
    sourcesFactory: () => ({ collectByKeyword: async () => ({ ok: true, kind: 'OK', videos: [work], pages: 1, events: [] }) }),
    collectorFactory: () => ({
      transport: { prepare: async () => ({ ok: true, ...work }) },
      readPageWithRetry: async () => ({ ok: true, rows: [], empty: true }),
    }),
    ai: { async inquiryCompletion(messages) {
      const request = JSON.parse(messages[1].content)
      requests.push(request)
      const text = JSON.stringify(request.comments.map(row => ({
        key: row.key, label: request.goal.includes('游戏') ? 'match' : 'reject', reason: '测试判定', evidence: [row.text],
      })))
      return { text, usage: { total: 21 } }
    } },
    onBatchDone: async () => { finishes++ },
  }
  return { goalStore, libraryStore, manager, requests, deps, finishes: () => finishes }
}

const config = { target: 1, sources: { keywords: ['组队'] }, budgets: { maxAiCalls: 5 } }
const createGoal = (store, description) => {
  const view = store.setGoal({ name: description, description })
  return store.freeze(view.selectedId, 1)
}

test('renaming preserves the goal version; changing criteria isolates labels and preserves immutable old snapshots', t => {
  const { goalStore, libraryStore } = fixture(t)
  libraryStore.addComments([comment(1)])
  const sample = commentSample(libraryStore.read().comments[0], { title: work.title })
  const goal = createGoal(goalStore, '找游戏搭子')
  goalStore.recordSamples(goal, [sample])
  goalStore.review(goal, sample.key, 'match', '晚上能组队')
  const original = goalStore.freeze(goal.id, 1)
  goalStore.setGoal({ id: goal.id, name: '晚间游戏', description: goal.description })
  assert.equal(goalStore.freeze(goal.id, 1).snapshotId, original.snapshotId)
  goalStore.review(goal, sample.key, 'reject', '改了人工判断')
  const revised = goalStore.freeze(goal.id, 1)
  assert.notEqual(revised.snapshotId, original.snapshotId)
  assert.equal(goalStore.decisions(original, [sample]).get(sample.key).reason, '晚上能组队')
  assert.equal(goalStore.decisions(revised, [sample]).get(sample.key).label, 'reject')
  goalStore.setGoal({ id: goal.id, name: '晚间游戏', description: '只要晚上排位队友' })
  assert.throws(() => goalStore.freeze(goal.id, 1), /目标已修改/)
  const next = goalStore.freeze(goal.id, 2)
  assert.equal(goalStore.decisions(next, [sample]).size, 0)
  assert.equal(goalStore.samples(original).samples[0].human.intent, 'reject')
})

test('a new comment gets only cases from its frozen goal, and ungrounded matches cannot enter the pool', async t => {
  const { goalStore, libraryStore, requests, deps } = fixture(t)
  libraryStore.addComments([comment(1), comment(2, '晚上想一起组队')])
  const [sample, unseen] = libraryStore.read().comments.map(row => commentSample(row, { title: work.title }))
  const games = createGoal(goalStore, '找游戏搭子')
  const interview = createGoal(goalStore, '找复试学长')
  goalStore.recordSamples(games, [sample])
  goalStore.recordSamples(interview, [sample])
  goalStore.review(games, sample.key, 'match', '这是组队招募')
  goalStore.review(interview, sample.key, 'reject', '没有复试经验')
  const snapshot = goalStore.freeze(games.id, 1)
  await goalStore.classify(snapshot, [unseen], deps.ai)
  assert.equal(requests[0].comments[0].cases[0].reason, '这是组队招募')
  assert.equal(requests[0].comments[0].cases.length, 1)
  const decision = goalStore.decisions(snapshot, [unseen]).get(unseen.key)
  assert.equal(decision.cases[0].key, sample.key)
  assert.equal(decision.label, 'match')
  const output = { text: JSON.stringify([{ key: unseen.key, label: 'match', evidence: ['不存在的证据'] }]) }
  await goalStore.classify(interview, [unseen], { inquiryCompletion: async () => output })
  assert.equal(goalStore.decisions(interview, [unseen]).get(unseen.key).label, 'check')
  assert.equal(goalStore.decisions(snapshot, [unseen]).get(unseen.key).label, 'match')
})

test('default video skip does not suppress custom reevaluation; custom matching does not create contact consent', async t => {
  const f = fixture(t)
  f.libraryStore.addComments(Array.from({ length: 30 }, (_, index) => ({
    ...comment(index + 1), classification: { intent: 'ORDINARY', reviewedByUser: true },
  })))
  const runner = new BatchRunner(f.deps)
  const original = await runner.start(config)
  assert.equal(original.batch.queue[0].code, 'VIDEO_PASS')
  const defaultProgress = structuredClone(f.manager.get().videoRoundProgress)
  assert.deepEqual(f.requests, [])
  const target = createGoal(f.goalStore, '找游戏搭子')
  const run = await runner.start(config, { targetSnapshot: target })
  assert.equal(run.batch.stopCode, 'TARGET_REACHED')
  assert.equal(run.cards[0].goalMatch.id, target.id)
  assert.equal(run.cards[0].comment, '晚上缺一，想一起组队')
  const [candidate] = f.manager.get().candidates
  assert.equal(candidate.libraryIntent, 'UNKNOWN')
  assert.equal(candidate.consentToDm, false)
  assert.equal(f.libraryStore.read().comments.every(row => row.classification.intent === 'ORDINARY'), true)

  f.manager.patch(candidate.id, { review: { realContact: { messageStatus: 'sent' } } })
  const other = createGoal(f.goalStore, '找晚上开黑的游戏搭子')
  const afterSwitch = await runner.start(config, { targetSnapshot: other })
  assert.ok(afterSwitch.cards.every(card => card.id !== candidate.id))
  const [merged] = f.manager.get().candidates
  assert.equal(merged.id, candidate.id)
  assert.deepEqual(merged.goalMatches.map(result => result.id), [target.id, other.id])
  let contacts = 0
  const result = await executeBatchContact({
    manager: f.manager, store: f.libraryStore, candidate: merged, manual: true, text: '测试',
    friendship: { approach: async () => { contacts++; throw new Error('不得执行') } },
  })
  assert.equal(result.code, 'ALREADY_SENT')
  assert.equal(contacts, 0)
  assert.deepEqual(f.manager.get().videoRoundProgress, defaultProgress)
})

test('resuming a paused batch uses the frozen human conclusion even after an edit', async t => {
  const f = fixture(t)
  f.libraryStore.addComments([comment(1)])
  const sample = commentSample(f.libraryStore.read().comments[0], { title: work.title })
  const target = createGoal(f.goalStore, '找游戏搭子')
  f.goalStore.recordSamples(target, [sample])
  f.goalStore.review(target, sample.key, 'match', '批次启动前')
  const frozen = f.goalStore.freeze(target.id, 1)
  const runner = new BatchRunner(f.deps)
  const started = runner.start({ ...config, budgets: { maxAiCalls: 0 } }, { targetSnapshot: frozen })
  runner.pause()
  f.goalStore.review(target, sample.key, 'reject', '暂停后改标')
  await started
  const resumed = await new BatchRunner(f.deps).resume()
  assert.equal(resumed.cards[0].goalMatch.reason, '批次启动前')
  assert.equal(resumed.cards[0].goalMatch.source, 'human')
  assert.equal(f.requests.length, 0)
  const audit = f.goalStore.samples(target).decisions[0]
  assert.equal(audit.target.snapshotId, frozen.snapshotId)
  assert.equal(audit.label, 'match')
})

test('sample-only run has a separate checkpoint and never classifies, adds candidates or invokes contact', async t => {
  const f = fixture(t)
  f.libraryStore.addComments(Array.from({ length: 14 }, (_, index) => comment(index + 1)))
  const target = createGoal(f.goalStore, '找游戏搭子')
  const manager = f.manager
  manager.save({ ...manager.get(), batch: { id: 'previous', status: 'done', added: [] } })
  const sample = new BatchRunner({ ...f.deps, stateKey: 'goalSampling' })
  const result = await sample.start({ ...config, budgets: { maxAiCalls: 0 } }, { targetSnapshot: target, sampleOnly: true })
  assert.equal(result.batch.stopCode, 'LABEL_SAMPLES_READY')
  assert.equal(f.goalStore.samples(target).samples.length, 12)
  assert.equal(manager.get().batch.id, 'previous')
  assert.equal(manager.get().candidates.length, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.finishes(), 0)
  const extra = await sample.start(config, { targetSnapshot: target, sampleOnly: true })
  assert.equal(extra.batch.sampleKeys.length, 2)
  assert.equal(f.goalStore.samples(target).samples.length, 14)
  assert.equal(manager.get().batch.id, 'previous')
})

test('custom goal match keeps the selected comment evidence through automatic public gender verification', async t => {
  const f = fixture(t)
  f.libraryStore.addComments([{ ...comment(1), ip_location: '湖南省', ip_location_source: 'footer_region', reply_count: 0,
    classification: { intent: 'ORDINARY', reviewedByUser: true } }])
  const checked = []
  f.deps.engine = { async readBatchGender(candidate) {
    checked.push(candidate.platformUserId)
    return { status: 'found', publicSignals: { genderText: '女' }, publicProfile: { rawText: '性别：女' } }
  } }
  const frozen = createGoal(f.goalStore, '找游戏搭子')
  const result = await new BatchRunner(f.deps).start({ ...config, filters: { gender: 'female', requireIp: true, ipValues: ['湖南'], requireReplyLimit: true, replyLimit: 0 } }, { targetSnapshot: frozen })
  assert.equal(result.batch.stopCode, 'TARGET_REACHED')
  assert.deepEqual(checked, [comment(1).author_id])
  const [card] = result.cards
  assert.equal(card.goalMatch.id, frozen.id); assert.equal(card.gender, 'female')
  assert.equal(card.commentIp, '湖南省'); assert.equal(card.commentId, '1'); assert.equal(card.replyCount, 0)
  assert.equal(card.comment, comment(1).text); assert.deepEqual(card.filterBasis, [])
  assert.equal(result.batch.progress.genderChecks, 1)
  assert.equal(result.batch.progress.aiCalls, f.requests.length)
  assert.equal(f.libraryStore.read().comments[0].classification.intent, 'ORDINARY')
})

test('custom sampling keeps its own returned status and does not overwrite ordinary batch progress', async t => {
  const f = fixture(t)
  f.libraryStore.addComments([comment(1)])
  f.manager.save({ ...f.manager.get(), batch: { id: 'ordinary', status: 'done', added: [], progress: { qualified: 7 } } })
  const target = createGoal(f.goalStore, '找游戏搭子')
  const sampler = new BatchRunner({ ...f.deps, stateKey: 'goalSampling' })
  const result = await sampler.start(config, { targetSnapshot: target, sampleOnly: true })
  assert.equal(result.batch.sampleOnly, true); assert.equal(result.batch.stopCode, 'LABEL_SAMPLES_READY')
  assert.equal(result.batch.progress.qualified, 0); assert.equal(result.cards.length, 0)
  assert.equal(f.manager.get().batch.id, 'ordinary'); assert.equal(f.manager.get().batch.progress.qualified, 7)
  assert.equal(f.requests.length, 0); assert.equal(f.finishes(), 0)
})


test('opening preferences are frozen per batch, without replacing the classification snapshot or the default draft', async t => {
  const f = fixture(t)
  f.libraryStore.addComments([comment(1, '晚上九点缺一')])
  const sample = commentSample(f.libraryStore.read().comments[0], { title: work.title })
  const description = '找游戏搭子'
  const { selectedId } = f.goalStore.setGoal({ name: description, description, openingInstructions: '先问区服' })
  const initial = f.goalStore.freeze(selectedId, 1)
  f.goalStore.recordSamples(initial, [sample])
  f.goalStore.review(initial, sample.key, 'match', '明确招募')
  const frozen = f.goalStore.freeze(selectedId, 1)
  f.goalStore.setGoal({ id: selectedId, name: description, description, openingInstructions: '先问几点上线' })
  const next = f.goalStore.freeze(selectedId, 1)
  assert.equal(next.snapshotId, frozen.snapshotId)
  assert.equal(next.openingInstructions, '先问几点上线')
  f.deps.draftOpening = async (_candidate, input) => {
    assert.equal(input.openingGoal.instructions, '先问区服')
    assert.equal(input.commentText, '晚上九点缺一')
    assert.equal(input.videoTitle, work.title)
    return { text: '你们在哪个区服呀？' }
  }
  const runner = new BatchRunner(f.deps)
  const run = await runner.start(config, { targetSnapshot: frozen })
  const [card] = run.cards
  assert.equal(card.draftOpening, '你们在哪个区服呀？')
  assert.equal(f.manager.get().candidates[0].review.draftOpening, undefined)
  assert.equal(run.batch.warnings.some(text => /本人资料/.test(text)), false)
  const { batchOpeningInput } = require('../electron/discovery/batch-runner.cjs')
  const regenerated = batchOpeningInput(f.manager.get().candidates[0], runner.state, runner.state.added[0])
  assert.equal(regenerated.openingGoal.instructions, '先问区服')
  assert.equal(runner.saveGoalDraft(run.batch.id, card.id, '手动重新生成', { replace: true }), true)
  assert.equal(runner.saveGoalDraft(run.batch.id, card.id, '迟到的自动生成'), false)
  assert.equal(runner.status().cards[0].draftOpening, '手动重新生成')
  assert.equal(runner.saveGoalDraft('other-batch', card.id, '不属于本批的草稿', { replace: true }), false)
})
