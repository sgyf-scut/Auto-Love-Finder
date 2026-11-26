// P2-17B.4 批次真实联系：意愿门槛、硬红线、真实执行与批次结束钩子。
const test = require('node:test')
const assert = require('node:assert')

const { preflight, contactOne, pickBatchTargets, intentAllowed, intentLevelOf } = require('../electron/discovery/batch-contact.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')

const base = (over = {}) => ({
  id: 'c1', nickname: '测试甲', profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_test',
  platformUserId: 'MS4wLjABAAAA_test', libraryIntent: 'SEEKING_FRIENDS', status: 'DISCOVERED', discoveryStatus: 'DISCOVERED',
  review: { draftOpening: '我也在找搭子，平时爱看展' }, ...over,
})

test('意愿门槛：any 包含语境意愿，explicit 只认明确表达', () => {
  assert.equal(intentAllowed('CONTEXTUAL_INTEREST', 'any'), true)
  assert.equal(intentAllowed('CONTEXTUAL_INTEREST', 'explicit'), false)
  assert.equal(intentAllowed('SEEKING_FRIENDS', 'explicit'), true)
  assert.equal(intentAllowed('ORDINARY', 'any'), false)
  assert.equal(intentAllowed('UNKNOWN', 'any'), false)
  assert.equal(intentLevelOf('explicit'), 'explicit')
  assert.equal(intentLevelOf(undefined), 'any')
})

test('硬红线一条都不放开', () => {
  assert.equal(preflight(base({ platformUserId: '' })).code, 'MISSING_AUTHOR_ID')
  assert.equal(preflight(base({ status: 'REJECTED' })).code, 'REJECTED_PROTECTED')
  assert.equal(preflight(base({ discoveryStatus: 'EXCLUDED' })).code, 'EXCLUDED')
  assert.equal(preflight(base(), { contactedIds: ['MS4wLjABAAAA_test'] }).code, 'ALREADY_CONTACT')
  assert.equal(preflight(base({ publicSignals: { genderText: '男' } })).code, 'GENDER_MISMATCH')
  assert.equal(preflight(base({ publicSignals: { age: 16 } })).code, 'MINOR_BLOCKED')
  assert.equal(preflight(base({ libraryIntent: 'ORDINARY' })).code, 'INTENT_NOT_FRIENDLY')
  assert.equal(preflight(base(), { minIntent: 'explicit' }).ok, true)
  assert.equal(preflight(base({ libraryIntent: 'CONTEXTUAL_INTEREST' }), { minIntent: 'explicit' }).code, 'INTENT_NOT_FRIENDLY')
})

test('真实执行调用 approach，发送编辑后的第一句', async () => {
  const calls = []
  const friendship = { approach: async (payload, options) => { calls.push({ payload, options }); return { ok: true, contactId: 'ct1' } } }
  const result = await contactOne(base(), { friendship, text: '这句话是手改的' })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.text, '这句话是手改的')
  assert.equal(calls[0].payload.name, '测试甲')
  assert.equal(calls[0].options.background, false)
  assert.equal(result.followPending, false)
})

test('没有第一句拒绝执行；关注验证按“申请中”返回成功但不谎称已私信', async () => {
  const friendship = { approach: async () => ({ ok: true }) }
  const empty = await contactOne(base({ review: {} }), { friendship })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'OPENING_EMPTY')

  const pending = { approach: async () => { throw Object.assign(new Error('已发送关注申请'), { followPending: true }) } }
  const result = await contactOne(base(), { friendship: pending })
  assert.equal(result.ok, true)
  assert.equal(result.followPending, true)
  assert.match(result.note, /关注申请/)
})

test('执行失败带上可判断的错误码', async () => {
  const friendship = { approach: async () => { throw new Error('检测到安全验证，请先完成验证') } }
  const result = await contactOne(base(), { friendship })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CHALLENGE_REQUIRED')
})

test('手动模式（manual=true）跳过全部审核条件，直接执行', async () => {
  const calls = []
  const friendship = { approach: async (payload, options) => { calls.push({ payload, options }); return { ok: true, contactId: 'ct2' } } }
  // 每一个条件在自动路径都会被拦：意愿不足、已联系过、已排除、男性、未成年
  const cases = [
    base({ libraryIntent: 'ORDINARY' }),
    base({ status: 'REJECTED', discoveryStatus: 'REJECTED' }),
    base({ publicSignals: { genderText: '男' } }),
    base({ publicSignals: { age: 16 } }),
  ]
  for (const candidate of cases) {
    const result = await contactOne(candidate, { friendship, contactedIds: ['MS4wLjABAAAA_test'], manual: true })
    assert.equal(result.ok, true, `应直接执行：${candidate.status || candidate.libraryIntent}`)
    assert.equal(result.text, '我也在找搭子，平时爱看展')
  }
  assert.equal(calls.length, cases.length)
  // 自动路径同样条件仍然全拦（防回归）
  for (const candidate of cases) {
    const result = await contactOne(candidate, { friendship, contactedIds: ['MS4wLjABAAAA_test'] })
    assert.equal(result.ok, false)
  }
  assert.equal(calls.length, cases.length)
  // 手动模式仍保留的唯一物理前提：没有主页地址发不了
  const noUrl = await contactOne(base({ profileUrl: '' }), { friendship, manual: true })
  assert.equal(noUrl.ok, false)
  assert.equal(noUrl.code, 'MISSING_AUTHOR_ID')
})

test('批次挑人：只挑未联系过的，超出上限的记为 OVER_LIMIT', () => {
  const candidates = [base({ id: 'a', platformUserId: 'u1' }), base({ id: 'b', platformUserId: 'u2' }), base({ id: 'c', platformUserId: 'u3', status: 'REJECTED' })]
  const batch = { added: [{ candidateId: 'a' }, { candidateId: 'b' }, { candidateId: 'c' }] }
  const result = pickBatchTargets(batch, candidates, { limit: 1 })
  assert.equal(result.targets.length, 1)
  assert.equal(result.targets[0].id, 'a')
  const codes = result.skipped.map(item => item.code)
  assert.ok(codes.includes('OVER_LIMIT'))
  assert.ok(codes.includes('REJECTED_PROTECTED'))
})

test('批次只在正常结束时触发联系钩子，停止或失败不触发', async () => {
  const makeRunner = () => {
    const store = { batch: { id: 'b1', status: 'running', queue: [], added: [] }, candidates: [], batchExcluded: [] }
    const manager = { get: () => store, save: value => { Object.assign(store, value) } }
    const runner = new BatchRunner({ manager, emit: () => {} })
    return { runner, store }
  }
  let calls = 0
  const done = makeRunner()
  done.runner.loop = async () => { done.runner.save({ status: 'done' }) }
  done.runner.deps.onBatchDone = () => { calls++ }
  await done.runner.run('b1')
  assert.equal(calls, 1)

  const stopped = makeRunner()
  stopped.runner.loop = async () => { stopped.runner.save({ status: 'stopped' }) }
  stopped.runner.deps.onBatchDone = () => { calls++ }
  await stopped.runner.run('b1')
  assert.equal(calls, 1)
})

// 正式模式开关：用户只切一次模式，就应具备"批次结束自动关注 + 自动首句"的能力。
test('切到正式模式会打开自动关注与首句，并保底 1 人额度', () => {
  const { autoModeConfig } = require('../electron/social-brain/library-store.cjs')
  const opened = autoModeConfig({ autoFollow: false, autoFirstMessage: false, batchAutoLimit: 0, dailyFollowLimit: 0, dailyFirstMessageLimit: 0, autoMinIntent: 'any', targetGender: 'any' })
  assert.equal(opened.autoFollow, true)
  assert.equal(opened.autoFirstMessage, true)
  assert.equal(opened.batchAutoLimit, 1)
  assert.equal(opened.dailyFollowLimit, 1)
  assert.equal(opened.dailyFirstMessageLimit, 1)
  // 其它筛选口径保持原样，不被开关重置
  assert.equal(opened.autoMinIntent, 'any')
  assert.equal(opened.targetGender, 'any')
  // 用户已经设好的人数和额度不被压低
  const kept = autoModeConfig({ batchAutoLimit: 3, dailyFollowLimit: 8, dailyFirstMessageLimit: 5 })
  assert.equal(kept.batchAutoLimit, 3)
  assert.equal(kept.dailyFollowLimit, 8)
  assert.equal(kept.dailyFirstMessageLimit, 5)
})

// 提速改造：首句生成后台化，不能阻塞视频主循环，且必须在自动联系钩子之前写回。
test('首句后台生成不阻塞主循环，批次收尾时已写回且早于联系钩子', async () => {
  const store = {
    batch: { id: 'b1', status: 'running', queue: [], added: [] },
    candidates: [{ id: 'c1', nickname: '甲', review: {} }],
    batchExcluded: [],
  }
  const manager = {
    get: () => store,
    save: value => { Object.assign(store, value); return store },
    patch: (id, patch) => {
      const c = store.candidates.find(x => x.id === id)
      c.review = { ...(c.review || {}), ...(patch.review || {}) }
    },
  }
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const runner = new BatchRunner({ manager, emit: () => {},
    draftOpening: async () => { calls.push('draft'); await gate; return { text: '后台首句' } } })
  runner.bumpProgress = () => {}
  runner.loop = async () => {
    calls.push('loop')
    runner.scheduleDraft(store.candidates[0], { config: { budgets: { maxAiCalls: 10 } } })
    calls.push('next') // 若首句仍在主循环里 await，这一行不会立刻执行
    runner.save({ status: 'done' })
  }
  runner.deps.onBatchDone = () => { calls.push('contact') }
  const running = runner.run('b1')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(calls.includes('next'), '首句不能阻塞视频循环')
  assert.ok(!calls.includes('contact'), '首句没写完不能触发真实联系')
  release()
  await running
  assert.deepEqual(calls, ['loop', 'next', 'draft', 'contact'])
  assert.equal(store.candidates[0].review.draftOpening, '后台首句')
})

// ===== 三态显示 + 结果待核实暂停自动重发 =====
const { actionStateOf } = require('../electron/discovery/batch-contact.cjs')
const { normalizeCandidateAction } = require('../electron/discovery/candidate-manager.cjs')

test('关注成功 + 第一句已发出：SENT，两段都确认为成功', async () => {
  const friendship = { approach: async () => ({ ok: true, contactId: 'ct1' }) }
  const r = await contactOne(base(), { friendship })
  assert.equal(r.ok, true)
  assert.equal(r.outcome, 'SENT')
  assert.equal(r.followStatus, 'confirmed')
  assert.equal(r.messageStatus, 'sent')
  assert.equal(r.needsReview, false)
})

test('关注成功但第一句明确没发出：FOLLOW_OK_DM_FAILED，两段分别显示', async () => {
  const friendship = { approach: async () => { throw Object.assign(new Error('私信面板没有打开'), { contactStage: 'greeting', followConfirmed: true, sendAttempted: false }) } }
  const r = await contactOne(base(), { friendship })
  assert.equal(r.ok, false)
  assert.equal(r.outcome, 'FOLLOW_OK_DM_FAILED')
  assert.equal(r.followStatus, 'confirmed')
  assert.equal(r.messageStatus, 'failed')
  assert.equal(r.needsReview, false)
  assert.match(r.reason, /关注已成功/)
  assert.match(r.reason, /第一句没有发出/)
})

test('发送动作已发出但没确认：UNCERTAIN，标记待核实并禁止自动重发', async () => {
  const friendship = { approach: async () => { throw Object.assign(new Error('发送确认超时'), { contactStage: 'greeting', followConfirmed: true, sendAttempted: true, outcomeUncertain: true }) } }
  const r = await contactOne(base(), { friendship })
  assert.equal(r.ok, false)
  assert.equal(r.outcome, 'UNCERTAIN')
  assert.equal(r.code, 'OUTCOME_UNCERTAIN')
  assert.equal(r.needsReview, true)
  assert.equal(r.autoRetryBlocked, true)
  assert.equal(r.followStatus, 'confirmed')
  assert.equal(r.messageStatus, 'unknown')
  assert.match(r.reason, /暂停自动重发/)
})

test('无阶段标记的未知失败也按待核实处理，不冒险自动重发', async () => {
  const friendship = { approach: async () => { throw new Error('某处抛了个没分类的异常') } }
  const r = await contactOne(base(), { friendship })
  assert.equal(r.outcome, 'UNCERTAIN')
  assert.equal(r.needsReview, true)
})

test('关注之前的明确拦截（安全验证）不算待核实', async () => {
  const friendship = { approach: async () => { throw new Error('检测到安全验证，请先完成验证') } }
  const r = await contactOne(base(), { friendship })
  assert.equal(r.outcome, 'FAILED')
  assert.equal(r.code, 'CHALLENGE_REQUIRED')
  assert.equal(r.needsReview, false)
  assert.equal(r.followStatus, 'not_followed')
  assert.equal(r.messageStatus, 'not_sent')
})

test('窗口销毁不再整体重来：只调用一次 approach，结果按待核实返回', async () => {
  let calls = 0
  const friendship = {
    approach: async () => { calls++; throw new Error('Object has been destroyed') },
    resetWindow() { throw new Error('不应该被调用') },
  }
  const r = await contactOne(base(), { friendship })
  assert.equal(calls, 1, '销毁后不得重建窗口重跑整个流程')
  assert.equal(r.outcome, 'UNCERTAIN')
  assert.equal(r.needsReview, true)
})

test('关注申请中：FOLLOW_PENDING，不算已发第一句', async () => {
  const friendship = { approach: async () => { throw Object.assign(new Error('已发送关注申请'), { followPending: true }) } }
  const r = await contactOne(base(), { friendship })
  assert.equal(r.ok, true)
  assert.equal(r.outcome, 'FOLLOW_PENDING')
  assert.equal(r.followStatus, 'pending')
  assert.equal(r.messageStatus, 'not_sent')
  assert.equal(r.needsReview, false)
})

test('待核实标记是硬红线：自动路径不得再联系这个人', () => {
  const flagged = base({ action: { needsReview: true, autoRetryBlocked: true } })
  const r = preflight(flagged)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'OUTCOME_UNCERTAIN')
  assert.match(r.reason, /暂停自动重发/)
  const flagged2 = base({ review: { draftOpening: '你好', realContact: { needsReview: true } } })
  assert.equal(preflight(flagged2).code, 'OUTCOME_UNCERTAIN')
})

test('待核实的人不会被批次挑中，且自动路径 contactOne 也拦住', () => {
  const candidates = [base({ id: 'a', platformUserId: 'u1', action: { needsReview: true } }), base({ id: 'b', platformUserId: 'u2' })]
  const picked = pickBatchTargets({ added: [{ candidateId: 'a' }, { candidateId: 'b' }] }, candidates, { limit: 2 })
  assert.equal(picked.targets.length, 1)
  assert.equal(picked.targets[0].id, 'b')
  assert.equal(picked.skipped[0].code, 'OUTCOME_UNCERTAIN')
})

test('人工核对后标记可解除，自动路径恢复', () => {
  const cleared = normalizeCandidateAction({ ...normalizeCandidateAction({ needsReview: true, autoRetryBlocked: true, reviewRequiredAt: 'x' }, {}), needsReview: false, autoRetryBlocked: false, reviewRequiredAt: null }, {})
  assert.equal(cleared.needsReview, undefined)
  assert.equal(cleared.autoRetryBlocked, undefined)
  assert.equal(preflight(base({ action: cleared })).ok, true)
})

test('actionStateOf 映射到候选池合法枚举，并保留待核实标记', () => {
  const sent = actionStateOf({ followStatus: 'confirmed', messageStatus: 'sent', needsReview: false })
  assert.deepEqual(sent, { followStatus: 'followed', firstMessageStatus: 'sent', needsReview: false })
  assert.equal(normalizeCandidateAction(sent, {}).followStatus, 'followed')
  assert.equal(normalizeCandidateAction(sent, {}).firstMessageStatus, 'sent')
  const uncertain = actionStateOf({ followStatus: 'unknown', messageStatus: 'unknown', needsReview: true })
  assert.equal(uncertain.followStatus, 'pending')
  assert.equal(uncertain.firstMessageStatus, 'pending')
  assert.equal(normalizeCandidateAction(uncertain, {}).needsReview, true)
  assert.equal(normalizeCandidateAction(uncertain, {}).autoRetryBlocked, true)
})

const { executeBatchContact, reviewBatchContact } = require('../electron/discovery/batch-contact-service.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { LibraryStore } = require('../electron/social-brain/library-store.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function contactFixture(t, approach) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-execution-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let data = {}
  const manager = new CandidateManager({
    get: () => data,
    update: patch => { data = { ...data, ...structuredClone(patch) } },
  })
  manager.save({ candidates: [base({ source: { type: 'user_search', keyword: '测试' } })] })
  const candidate = manager.get().candidates[0]
  return { manager, store: new LibraryStore(dir), candidate, friendship: { approach }, manual: true }
}

test('统一入口按已发生动作记账，首句失败仍计关注', async t => {
  const ctx = contactFixture(t, async () => {
    throw Object.assign(new Error('打不开私信入口'), { contactStage: 'greeting' })
  })
  const result = await executeBatchContact(ctx)
  assert.equal(result.outcome, 'FOLLOW_OK_DM_FAILED')
  const budget = ctx.store.autoContactState().budget
  assert.equal(budget.realFollows, 1)
  assert.equal(budget.realMessages, 0)
  assert.equal(ctx.manager.get().candidates[0].action.followStatus, 'followed')
})

test('待核实时阻止重发，确认已发后只补记一次首句', async t => {
  let calls = 0
  const ctx = contactFixture(t, async () => {
    calls += 1
    throw Object.assign(new Error('未收到发送回执'), { contactStage: 'greeting', sendAttempted: true })
  })
  assert.equal((await executeBatchContact(ctx)).outcome, 'UNCERTAIN')
  assert.equal((await executeBatchContact(ctx)).code, 'OUTCOME_UNCERTAIN')
  const review = { ...ctx, id: ctx.candidate.id, conclusion: 'sent' }
  assert.equal(reviewBatchContact(review).ok, true)
  assert.equal(reviewBatchContact(review).ok, true)
  assert.equal((await executeBatchContact(ctx)).code, 'ALREADY_SENT')
  assert.equal(calls, 1)
  assert.equal(ctx.store.autoContactState().budget.realFollows, 1)
  assert.equal(ctx.store.autoContactState().budget.realMessages, 1)
  assert.equal(ctx.manager.get().candidates[0].action.firstMessageStatus, 'sent')
})

test('同一账号执行期间阻止再次执行和人工裁决', async t => {
  let finish
  const ctx = contactFixture(t, () => new Promise(resolve => { finish = resolve }))
  const pending = executeBatchContact(ctx)
  assert.equal(ctx.manager.get().candidates[0].action.needsReview, true)
  assert.equal((await executeBatchContact(ctx)).code, 'CONTACT_BUSY')
  assert.equal(reviewBatchContact({ ...ctx, id: ctx.candidate.id, conclusion: 'sent' }).ok, false)
  finish({ alreadyFollowed: true })
  assert.equal((await pending).outcome, 'SENT')
  assert.equal(ctx.store.autoContactState().budget.realFollows, 0)
  assert.equal(ctx.store.autoContactState().budget.realMessages, 1)
})
