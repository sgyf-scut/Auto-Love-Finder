// 本地交友素材库：视频与评论的导入、去重、持久化、人工复核。
// 只读写 accounts/<id>/library/library.json，绝不写入 state.json，也不触发任何抖音操作。
const fs = require('node:fs')
const { writeFileAtomicSync, readJsonWithRecoverySync, copyFileRobustSync } = require('../atomic-write.cjs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { CANDIDATE_INTENTS } = require('./library-classifier.cjs')

const VERSION = 1
const MAX_VIDEOS = 5000
const MAX_COMMENTS = 20000
const LIMITS = { title: 300, description: 2000, text: 2000, author: 80, id: 100, url: 500, topic: 60, note: 500, folder: 80 }

const sha = value => createHash('sha256').update(String(value)).digest('hex')
const clean = (value, limit) => String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, limit)
const nullable = (value, limit) => { const text = clean(value, limit); return text || null }

function defaults() {
  return {
    version: VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    videos: [],
    comments: [],
    importLogs: [],
    task: { status: 'idle', startedAt: null, finishedAt: null, total: 0, processed: 0, aiCalls: 0, tokens: 0, errors: [] },
    // P2-10 一键收集任务：保存中断点，重启后可按页恢复，不丢已收集评论。
    collector: {
      status: 'idle', videoKey: null, videoId: null, videoUrl: null, title: null,
      targetLimit: 50, maxPages: 8, fetched: 0, collected: 0, duplicates: 0, pages: 0,
      code: null, lastError: '', phase: '', startedAt: null, updatedAt: null, finishedAt: null,
    },
    // P2-11A 收藏夹同步状态：保存同步时间、结果和失败原因，重启后可以继续同步。
    favorites: {
      status: 'idle', folderName: null, code: null, lastError: '', nextAction: '', phase: '',
      declaredCount: 0, found: 0, added: 0, duplicates: 0, scrolls: 0, reachedCap: false, resumed: false,
      startedAt: null, updatedAt: null, finishedAt: null, lastSyncAt: null,
    },
    // P2-11B 自动评论处理流水线：逐视频状态持久化，重启后可继续；只处理收藏夹来源视频。
    pipeline: {
      status: 'idle', phase: '', code: null, lastError: '', nextAction: '',
      startedAt: null, updatedAt: null, finishedAt: null,
      limits: { maxVideosPerRound: 5, maxCommentsPerVideo: 40, maxPagesPerVideo: 4, maxAiCallsPerRound: 12, firstBatchComments: 12, secondBatchComments: 10, task: { maxVideos: 10, maxAiCalls: 12 } },
      // 整次“同步并自动分析”任务的预算与进度；达到预算后持久化，下一次任务继续。
      task: { status: 'idle', maxVideos: 10, maxAiCalls: 12, videosProcessed: 0, aiCalls: 0, tokens: 0, startedAt: null, finishedAt: null },
      round: { videos: 0, comments: 0, aiCalls: 0, tokens: 0, evidence: 0 },
      counters: { videosCompleted: 0, videosFailed: 0, videosBlocked: 0, commentsCollected: 0, commentsSkipped: 0, commentsClassified: 0, aiCalls: 0, tokens: 0 },
      items: [],
      // P2-12B 定时调度：开关、上次/下次时间、跨轮/跨日预算全部持久化，重启后不会归零。
      scheduler: {
        autoSync: false, autoAnalyze: false,
        syncIntervalHours: 24, analyzeIntervalMinutes: 10,
        status: 'idle', code: null, lastError: '', nextAction: '', pausedReason: '',
        lastSyncAt: null, nextSyncAt: null, lastRunAt: null, nextRunAt: null,
        attempts: 0, nextAttemptAt: null,
        budget: {
          // day 使用本地日期（YYYY-MM-DD），只有日期真正跨天时才重置，程序重启不会清零。
          day: '',
          limits: { dailyModelCalls: 24, dailySyncCount: 1, perRoundVideos: 10, perRoundModelCalls: 12, perVideoComments: 40 },
          modelCalls: 0, tokens: 0, tokensEstimated: 0, tokenSource: 'none',
          videos: 0, comments: 0, syncs: 0,
        },
        lastRound: null, log: [], updatedAt: null,
      },
    },
    // P2-13 双模式与自动联系：训练/正式模式、联系授权、关注与首条消息队列独立持久化，
    // 绝不与发现状态、人工审核状态或聊天状态混用。
    autoContact: {
      mode: 'training', policyVersion: 'P2-16.1',
      riskAcceptedAt: null,
      status: 'idle', code: null, lastError: '', nextAction: '', phase: '',
      // 正式模式默认 Dry Run：只生成执行计划，不做任何真实关注或私信。
      dryRun: true, realActionsAuthorized: false,
      config: {
        targetGender: 'any', requireAgeRange: false, ageMin: 18, ageMax: 45,
        requireFollowerLimit: false, followerMin: 0, followerMax: 100000,
        friendType: 'any', keywords: [], extra: '',
        // 真实外发能力默认关闭，必须由用户显式打开并按每日上限执行。
        autoFollow: false, autoFirstMessage: false,
        // 自动联系的意愿门槛：explicit 只认原话明确表达；any 连"结合语境可能有意愿"也算。
        autoMinIntent: 'any',
        // 单批自动联系人数上限：默认 1，先确认链路正常再放宽。
        batchAutoLimit: 1,
        dailyFollowLimit: 5, dailyFirstMessageLimit: 3,
        maxAttempts: 2, perPersonCooldownMinutes: 1440,
      },
      budget: { day: '', follows: 0, messages: 0, realFollows: 0, realMessages: 0, simulatedFollows: 0, simulatedMessages: 0, limits: { dailyFollowLimit: 5, dailyFirstMessageLimit: 3 } },
      queues: { follow: [], firstMessage: [] },
      executed: { follow: {}, firstMessage: {} },
      // P2-15.1 三类授权证据分开存：平台自动化权限（账号级）、对方同意（按人）、操作者确认（按人 + 按动作 + 有效期）。
      // 三者互不替代：登录成功不代表平台允许自动化，操作者勾选也不代表对方同意。
      authorization: {
        platform: { allowed: false, verifiedAt: null, basis: '', note: '', expiresAt: null },
        recipientAiConsent: {},
        operator: {},
      },
      lastPlanAt: null, lastRunAt: null, stoppedAt: null, stoppedReason: '',
      log: [], updatedAt: null,
    },
    settings: { classificationEnabled: true, aiBatchSize: 12, maxAiCallsPerRun: 24 },
  }
}

function emptyCollector() {
  return defaults().collector
}

function emptyFavorites() {
  return defaults().favorites
}

function normalizeFavorites(value) {
  const source = value && typeof value === 'object' ? value : {}
  const base = emptyFavorites()
  const status = ['idle', 'running', 'completed', 'interrupted', 'failed', 'blocked'].includes(source.status) ? source.status : 'idle'
  const num = (input, fallback = 0) => (Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : fallback)
  return {
    ...base,
    status,
    phaseStartedAt: nullable(source.phaseStartedAt, 40),
    elapsedMs: num(source.elapsedMs),
    stageTimings: (Array.isArray(source.stageTimings) ? source.stageTimings : []).slice(-20).map(x => ({ phase: clean(x?.phase, 100), ms: num(x?.ms) })),
    folderName: nullable(source.folderName, LIMITS.folder),
    code: nullable(source.code, 40),
    lastError: clean(source.lastError, 300),
    nextAction: clean(source.nextAction, 300),
    phase: clean(source.phase, 200),
    declaredCount: num(source.declaredCount),
    found: num(source.found),
    added: num(source.added),
    duplicates: num(source.duplicates),
    scrolls: num(source.scrolls),
    reachedCap: source.reachedCap === true,
    resumed: source.resumed === true,
    startedAt: nullable(source.startedAt, 40),
    updatedAt: nullable(source.updatedAt, 40),
    finishedAt: nullable(source.finishedAt, 40),
    lastSyncAt: nullable(source.lastSyncAt, 40),
  }
}

// ── P2-13 自动联系状态 ────────────────────────────────────────────────────
const AUTO_MODES = ['training', 'auto']
const ACTION_TASK_STATUS = ['pending', 'running', 'done', 'skipped', 'failed', 'blocked', 'uncertain']
const AUTO_ACTIONS = ['follow', 'firstMessage']

function emptyAutoContact() {
  return defaults().autoContact
}

function normalizeAutoTask(value, action) {
  const source = value && typeof value === 'object' ? value : {}
  const taskId = clean(source.taskId, 120)
  if (!taskId) return null
  const num = (input, fallback = 0) => (Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : fallback)
  return {
    taskId,
    action,
    candidateId: clean(source.candidateId, 150) || null,
    platformUserId: clean(source.platformUserId, 120) || null,
    nickname: clean(source.nickname, 100) || null,
    profileUrl: clean(source.profileUrl, 200) || null,
    status: ACTION_TASK_STATUS.includes(source.status) ? source.status : 'pending',
    attempts: num(source.attempts),
    reasonCode: clean(source.reasonCode, 60) || null,
    reason: clean(source.reason, 300),
    dryRun: source.dryRun === true,
    // P2-15：明确区分"模拟完成"与"真实执行完成"；旧记录两者都为 false，读取时按未确认处理。
    simulated: source.simulated === true,
    realAction: source.realAction === true,
    outcome: clean(source.outcome, 24) || null,
    // P2-16：执行前先落盘"已领取"，进程中断后据此判定为结果未知，绝不当作没执行过重试。
    startedAt: nullable(source.startedAt, 40),
    resolution: clean(source.resolution, 40) || null,
    resolvedAt: nullable(source.resolvedAt, 40),
    resolutionNote: clean(source.resolutionNote, 200),
    alreadyFollowed: source.alreadyFollowed === true,
    consentEvidenceId: clean(source.consentEvidenceId, 150) || null,
    messagePreview: clean(source.messagePreview, 500),
    policyVersion: clean(source.policyVersion, 40) || null,
    createdAt: nullable(source.createdAt, 40),
    updatedAt: nullable(source.updatedAt, 40),
    finishedAt: nullable(source.finishedAt, 40),
  }
}

// P2-15.1 授权证据归一化：只保留可追溯的记录（时间 + 依据 + 范围），不保留无法追溯的"已同意"布尔值。
function normalizeAuthorization(value) {
  const source = value && typeof value === 'object' ? value : {}
  const platformSource = source.platform && typeof source.platform === 'object' ? source.platform : {}
  const platform = {
    allowed: platformSource.allowed === true,
    verifiedAt: nullable(platformSource.verifiedAt, 40),
    basis: clean(platformSource.basis, 300),
    note: clean(platformSource.note, 300),
    expiresAt: nullable(platformSource.expiresAt, 40),
  }
  const recipientAiConsent = {}
  const recipientSource = source.recipientAiConsent && typeof source.recipientAiConsent === 'object' ? source.recipientAiConsent : {}
  for (const [id, item] of Object.entries(recipientSource).slice(0, 5000)) {
    const key = clean(id, 120)
    if (!key || !item || typeof item !== 'object') continue
    recipientAiConsent[key] = {
      accepted: item.accepted === true,
      at: nullable(item.at || item.acceptedAt, 40),
      source: clean(item.source, 200),
      note: clean(item.note, 300),
      revokedAt: nullable(item.revokedAt, 40),
      expiresAt: nullable(item.expiresAt, 40),
    }
  }
  const operator = {}
  const operatorSource = source.operator && typeof source.operator === 'object' ? source.operator : {}
  for (const [id, item] of Object.entries(operatorSource).slice(0, 5000)) {
    const key = clean(id, 120)
    if (!key || !item || typeof item !== 'object') continue
    const actions = Array.isArray(item.actions) ? [...new Set(item.actions.map(action => clean(action, 20)).filter(action => AUTO_ACTIONS.includes(action)))] : []
    operator[key] = {
      confirmedAt: nullable(item.confirmedAt, 40),
      actions,
      expiresAt: nullable(item.expiresAt, 40),
      channel: clean(item.channel, 60),
      note: clean(item.note, 200),
    }
  }
  return { platform, recipientAiConsent, operator }
}

// 切到正式模式时的一次性配置：正式模式 = 用户已确认"无人值守全自动"，
// 直接打开真实外发开关，单批人数与每日额度至少保留 1，避免切成正式后仍被旧开关挡住。
function autoModeConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback
  }
  return {
    ...source,
    autoFollow: true,
    autoFirstMessage: true,
    batchAutoLimit: num(source.batchAutoLimit, 1),
    dailyFollowLimit: num(source.dailyFollowLimit, 1),
    dailyFirstMessageLimit: num(source.dailyFirstMessageLimit, 1),
  }
}

function normalizeAutoContact(value) {
  const source = value && typeof value === 'object' ? value : {}
  const base = emptyAutoContact()
  const num = (input, fallback = 0) => (Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : fallback)
  const configSource = source.config && typeof source.config === 'object' ? source.config : {}
  const budgetSource = source.budget && typeof source.budget === 'object' ? source.budget : {}
  const limitsSource = budgetSource.limits && typeof budgetSource.limits === 'object' ? budgetSource.limits : {}
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(budgetSource.day || '')) ? String(budgetSource.day) : ''
  const config = {
    ...base.config,
    targetGender: ['any', 'female', 'male'].includes(configSource.targetGender) ? configSource.targetGender : 'any',
    requireAgeRange: configSource.requireAgeRange === true,
    ageMin: Math.max(18, Math.min(100, num(configSource.ageMin, base.config.ageMin))),
    ageMax: Math.max(18, Math.min(100, num(configSource.ageMax, base.config.ageMax))),
    requireFollowerLimit: configSource.requireFollowerLimit === true,
    followerMin: Math.max(0, Math.min(1000000, num(configSource.followerMin, base.config.followerMin))),
    followerMax: Math.max(0, Math.min(1000000, num(configSource.followerMax, base.config.followerMax))),
    friendType: clean(configSource.friendType, 40) || 'any',
    keywords: Array.isArray(configSource.keywords) ? configSource.keywords.map(item => clean(item, 40)).filter(Boolean).slice(0, 20) : [],
    extra: clean(configSource.extra, 500),
    autoFollow: configSource.autoFollow === true,
    autoFirstMessage: configSource.autoFirstMessage === true,
    autoMinIntent: configSource.autoMinIntent === 'explicit' ? 'explicit' : 'any',
    batchAutoLimit: Math.max(0, Math.min(20, num(configSource.batchAutoLimit, base.config.batchAutoLimit))),
    dailyFollowLimit: Math.max(0, Math.min(100, num(configSource.dailyFollowLimit, base.config.dailyFollowLimit))),
    dailyFirstMessageLimit: Math.max(0, Math.min(100, num(configSource.dailyFirstMessageLimit, base.config.dailyFirstMessageLimit))),
    maxAttempts: Math.max(1, Math.min(5, num(configSource.maxAttempts, base.config.maxAttempts))),
    perPersonCooldownMinutes: Math.max(0, Math.min(10080, num(configSource.perPersonCooldownMinutes, base.config.perPersonCooldownMinutes))),
  }
  const queues = { follow: [], firstMessage: [] }
  for (const action of AUTO_ACTIONS) {
    const seen = new Set()
    for (const item of Array.isArray(source.queues?.[action]) ? source.queues[action] : []) {
      const task = normalizeAutoTask(item, action)
      if (task && !seen.has(task.taskId)) { seen.add(task.taskId); queues[action].push(task) }
    }
    queues[action] = queues[action].slice(-500)
  }
  const executed = { follow: {}, firstMessage: {} }
  for (const action of AUTO_ACTIONS) {
    for (const [key, item] of Object.entries(source.executed?.[action] && typeof source.executed[action] === 'object' ? source.executed[action] : {})) {
      const record = normalizeAutoTask({ ...item, taskId: item?.taskId || key }, action)
      if (record) executed[action][record.taskId] = record
    }
  }
  let mode = AUTO_MODES.includes(source.mode) ? source.mode : 'training'
  // 正式模式需要用户显式完成风险确认；未确认时回落到训练模式，绝不隐式开启真实外发。
  const riskAcceptedAt = nullable(source.riskAcceptedAt, 40)
  if (mode === 'auto' && !riskAcceptedAt) mode = 'training'
  const authorization = normalizeAuthorization(source.authorization)
  return {
    ...base,
    mode,
    riskAcceptedAt,
    policyVersion: clean(source.policyVersion, 40) || base.policyVersion,
    status: ['idle', 'planned', 'running', 'paused', 'stopped', 'completed', 'blocked'].includes(source.status) ? source.status : 'idle',
    code: clean(source.code, 40) || null,
    lastError: clean(source.lastError, 300),
    nextAction: clean(source.nextAction, 300),
    phase: clean(source.phase, 200),
    dryRun: source.dryRun !== false,
    realActionsAuthorized: source.realActionsAuthorized === true,
    authorization,
    config,
    budget: {
      day,
      follows: num(budgetSource.follows),
      messages: num(budgetSource.messages),
      // 真实额度与模拟额度分开累计：Dry Run 不得占用真实每日上限。
      realFollows: num(budgetSource.realFollows),
      realMessages: num(budgetSource.realMessages),
      ...(budgetSource.batchContactReceipts && typeof budgetSource.batchContactReceipts === 'object' && !Array.isArray(budgetSource.batchContactReceipts)
        ? { batchContactReceipts: budgetSource.batchContactReceipts } : {}),
      simulatedFollows: num(budgetSource.simulatedFollows),
      simulatedMessages: num(budgetSource.simulatedMessages),
      limits: {
        dailyFollowLimit: Math.max(0, Math.min(100, num(limitsSource.dailyFollowLimit, config.dailyFollowLimit))),
        dailyFirstMessageLimit: Math.max(0, Math.min(100, num(limitsSource.dailyFirstMessageLimit, config.dailyFirstMessageLimit))),
      },
    },
    queues,
    executed,
    lastPlanAt: nullable(source.lastPlanAt, 40),
    lastRunAt: nullable(source.lastRunAt, 40),
    stoppedAt: nullable(source.stoppedAt, 40),
    stoppedReason: clean(source.stoppedReason, 300),
    log: Array.isArray(source.log) ? source.log.filter(item => item && typeof item === 'object').slice(-50) : [],
    updatedAt: nullable(source.updatedAt, 40),
  }
}

function emptyPipeline() {
  return defaults().pipeline
}

function emptyScheduler() {
  return defaults().pipeline.scheduler
}

// 调度的持久化状态：只保存配置、时间和预算计数，不保存任何页面内容。
function normalizeScheduler(value) {
  const source = value && typeof value === 'object' ? value : {}
  const base = emptyScheduler()
  const num = (input, fallback = 0) => (Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : fallback)
  const text = (input, limit = 300) => clean(input, limit)
  const time = input => nullable(input, 40)
  const budgetSource = source.budget && typeof source.budget === 'object' ? source.budget : {}
  const limitsSource = budgetSource.limits && typeof budgetSource.limits === 'object' ? budgetSource.limits : {}
  const limit = (input, fallback, min, max) => Math.max(min, Math.min(max, num(input, fallback)))
  const status = ['idle', 'waiting', 'running', 'paused', 'blocked', 'budget_wait', 'completed'].includes(source.status) ? source.status : 'idle'
  const log = (Array.isArray(source.log) ? source.log : []).filter(item => item && typeof item === 'object').slice(-20).map(item => ({
    at: time(item.at), status: text(item.status, 40), message: text(item.message, 300),
    sync: item.sync && typeof item.sync === 'object' ? { added: num(item.sync.added), found: num(item.sync.found), ok: item.sync.ok === true } : null,
    analysis: item.analysis && typeof item.analysis === 'object' ? { processed: num(item.analysis.processed), aiCalls: num(item.analysis.aiCalls), tokens: num(item.analysis.tokens), remaining: num(item.analysis.remaining), message: text(item.analysis.message, 300) } : null,
  }))
  return {
    ...base,
    autoSync: source.autoSync === true,
    autoAnalyze: source.autoAnalyze === true,
    syncIntervalHours: limit(source.syncIntervalHours, base.syncIntervalHours, 1, 168),
    analyzeIntervalMinutes: limit(source.analyzeIntervalMinutes, base.analyzeIntervalMinutes, 1, 1440),
    status,
    code: nullable(source.code, 40),
    lastError: text(source.lastError),
    nextAction: text(source.nextAction),
    pausedReason: text(source.pausedReason),
    lastSyncAt: time(source.lastSyncAt),
    nextSyncAt: time(source.nextSyncAt),
    lastRunAt: time(source.lastRunAt),
    nextRunAt: time(source.nextRunAt),
    attempts: num(source.attempts),
    nextAttemptAt: time(source.nextAttemptAt),
    budget: {
      day: text(budgetSource.day, 10),
      limits: {
        dailyModelCalls: limit(limitsSource.dailyModelCalls, base.budget.limits.dailyModelCalls, 0, 200),
        dailySyncCount: limit(limitsSource.dailySyncCount, base.budget.limits.dailySyncCount, 1, 24),
        perRoundVideos: limit(limitsSource.perRoundVideos, base.budget.limits.perRoundVideos, 1, 50),
        perRoundModelCalls: limit(limitsSource.perRoundModelCalls, base.budget.limits.perRoundModelCalls, 0, 50),
        perVideoComments: limit(limitsSource.perVideoComments, base.budget.limits.perVideoComments, 1, 100),
      },
      modelCalls: num(budgetSource.modelCalls),
      tokens: num(budgetSource.tokens),
      tokensEstimated: num(budgetSource.tokensEstimated),
      tokenSource: ['none', 'model_returned', 'estimated'].includes(budgetSource.tokenSource) ? budgetSource.tokenSource : 'none',
      videos: num(budgetSource.videos),
      comments: num(budgetSource.comments),
      syncs: num(budgetSource.syncs),
    },
    lastRound: source.lastRound && typeof source.lastRound === 'object' ? {
      at: time(source.lastRound.at), status: text(source.lastRound.status, 40), message: text(source.lastRound.message, 300),
      sync: source.lastRound.sync && typeof source.lastRound.sync === 'object' ? { found: num(source.lastRound.sync.found), added: num(source.lastRound.sync.added), ok: source.lastRound.sync.ok === true } : null,
      analysis: source.lastRound.analysis && typeof source.lastRound.analysis === 'object' ? { processed: num(source.lastRound.analysis.processed), aiCalls: num(source.lastRound.analysis.aiCalls), tokens: num(source.lastRound.analysis.tokens), remaining: num(source.lastRound.analysis.remaining), message: text(source.lastRound.analysis.message, 300) } : null,
    } : null,
    log,
    updatedAt: time(source.updatedAt),
  }
}

// 流水线逐视频状态：key 用素材库 video.key，保证同一作品跨轮次只保留一条记录。
const PIPELINE_ITEM_STATUS = ['pending', 'running', 'completed', 'failed', 'interrupted', 'blocked', 'skipped']

function normalizePipelineItem(value) {
  const source = value && typeof value === 'object' ? value : {}
  const num = (input, fallback = 0) => (Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : fallback)
  const videoKey = nullable(source.videoKey, 120)
  if (!videoKey) return null
  return {
    videoKey,
    videoId: nullable(source.videoId, LIMITS.id),
    videoUrl: normalizeUrl(source.videoUrl),
    title: nullable(source.title, LIMITS.title),
    folder: nullable(source.folder, LIMITS.folder),
    status: PIPELINE_ITEM_STATUS.includes(source.status) ? source.status : 'pending',
    code: nullable(source.code, 40),
    reason: clean(source.reason, 300),
    phase: clean(source.phase, 200),
    attempts: num(source.attempts),
    pages: num(source.pages),
    // 采集进度绑定的作品键：续读页数只对同一 videoKey 生效。
    collectorKey: nullable(source.collectorKey, 120),
    commentsAdded: num(source.commentsAdded),
    commentsTotal: num(source.commentsTotal),
    classifiedCount: num(source.classifiedCount),
    candidateEvidence: num(source.candidateEvidence),
    explicitInvitations: num(source.explicitInvitations),
    seekingFriends: num(source.seekingFriends),
    contextualInterest: num(source.contextualInterest),
    rejectCount: num(source.rejectCount),
    unknownCount: num(source.unknownCount),
    ruleClassified: num(source.ruleClassified),
    aiClassified: num(source.aiClassified),
    // 抽样阶段：0 未抽样，1 首批，2 第二批/深入，3 命中后继续深入剩余评论。
    samplingStage: num(source.samplingStage),
    sampleMissReason: clean(source.sampleMissReason, 80),
    modelCalls: num(source.modelCalls),
    tokens: num(source.tokens),
    earlyStop: source.earlyStop === true,
    // 没读到评论时标记 unknown，不能据此判定视频质量。
    quality: ['unknown_no_comments', 'no_evidence', 'evidence_found', 'unavailable'].includes(source.quality) ? source.quality : null,
    startedAt: nullable(source.startedAt, 40),
    updatedAt: nullable(source.updatedAt, 40),
    finishedAt: nullable(source.finishedAt, 40),
  }
}

function normalizePipeline(value) {
  // 旧数据没有 scheduler 时由 normalizeScheduler 补默认值，不影响已有流水线状态。
  const source = value && typeof value === 'object' ? value : {}
  const base = emptyPipeline()
  const num = (input, fallback = 0) => (Number.isFinite(Number(input)) ? Math.max(0, Math.floor(Number(input))) : fallback)
  const limit = (input, fallback, min, max) => Math.max(min, Math.min(max, num(input, fallback)))
  const limitsSource = source.limits && typeof source.limits === 'object' ? source.limits : {}
  const taskLimitsSource = limitsSource.task && typeof limitsSource.task === 'object' ? limitsSource.task : {}
  const taskSource = source.task && typeof source.task === 'object' ? source.task : {}
  const roundSource = source.round && typeof source.round === 'object' ? source.round : {}
  const countersSource = source.counters && typeof source.counters === 'object' ? source.counters : {}
  const items = [], seen = new Set()
  for (const item of Array.isArray(source.items) ? source.items : []) {
    const normalized = normalizePipelineItem(item)
    if (normalized && !seen.has(normalized.videoKey)) { seen.add(normalized.videoKey); items.push(normalized) }
  }
  return {
    ...base,
    status: ['idle', 'running', 'paused', 'completed', 'interrupted', 'failed', 'blocked'].includes(source.status) ? source.status : 'idle',
    phase: clean(source.phase, 200),
    code: nullable(source.code, 40),
    lastError: clean(source.lastError, 300),
    nextAction: clean(source.nextAction, 300),
    startedAt: nullable(source.startedAt, 40),
    updatedAt: nullable(source.updatedAt, 40),
    finishedAt: nullable(source.finishedAt, 40),
    limits: {
      maxVideosPerRound: limit(limitsSource.maxVideosPerRound, base.limits.maxVideosPerRound, 1, 20),
      maxCommentsPerVideo: limit(limitsSource.maxCommentsPerVideo, base.limits.maxCommentsPerVideo, 1, 100),
      maxPagesPerVideo: limit(limitsSource.maxPagesPerVideo, base.limits.maxPagesPerVideo, 1, 8),
      maxAiCallsPerRound: limit(limitsSource.maxAiCallsPerRound, base.limits.maxAiCallsPerRound, 0, 30),
      firstBatchComments: limit(limitsSource.firstBatchComments, base.limits.firstBatchComments, 1, 50),
      secondBatchComments: limit(limitsSource.secondBatchComments, base.limits.secondBatchComments, 1, 20),
      task: {
        maxVideos: limit(taskLimitsSource.maxVideos, base.limits.task.maxVideos, 1, 50),
        maxAiCalls: limit(taskLimitsSource.maxAiCalls, base.limits.task.maxAiCalls, 0, 50),
      },
    },
    task: {
      status: ['idle', 'running', 'paused', 'completed', 'interrupted', 'failed', 'blocked'].includes(taskSource.status) ? taskSource.status : base.task.status,
      maxVideos: limit(taskSource.maxVideos, base.task.maxVideos, 1, 50),
      maxAiCalls: limit(taskSource.maxAiCalls, base.task.maxAiCalls, 0, 50),
      videosProcessed: num(taskSource.videosProcessed),
      aiCalls: num(taskSource.aiCalls),
      tokens: num(taskSource.tokens),
      startedAt: nullable(taskSource.startedAt, 40),
      finishedAt: nullable(taskSource.finishedAt, 40),
    },
    round: {
      videos: num(roundSource.videos),
      comments: num(roundSource.comments),
      aiCalls: num(roundSource.aiCalls),
      tokens: num(roundSource.tokens),
      evidence: num(roundSource.evidence),
    },
    counters: {
      videosCompleted: num(countersSource.videosCompleted),
      videosFailed: num(countersSource.videosFailed),
      videosBlocked: num(countersSource.videosBlocked),
      commentsCollected: num(countersSource.commentsCollected),
      // P2-16：采集时被判为重复的评论单列计数，便于验收核对“新增 / 跳过”。
      commentsSkipped: num(countersSource.commentsSkipped),
      commentsClassified: num(countersSource.commentsClassified),
      aiCalls: num(countersSource.aiCalls),
      tokens: num(countersSource.tokens),
    },
    items: items.slice(0, MAX_VIDEOS),
    scheduler: normalizeScheduler(source.scheduler),
  }
}

function normalizeCollector(value) {
  const source = value && typeof value === 'object' ? value : {}
  const base = emptyCollector()
  const status = ['idle', 'running', 'completed', 'interrupted', 'failed', 'blocked'].includes(source.status) ? source.status : 'idle'
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback)
  return {
    ...base,
    status,
    videoKey: nullable(source.videoKey, LIMITS.id),
    videoId: nullable(source.videoId, LIMITS.id),
    videoUrl: normalizeUrl(source.videoUrl),
    title: nullable(source.title, LIMITS.title),
    targetLimit: num(source.targetLimit, 50),
    maxPages: num(source.maxPages, 8),
    fetched: num(source.fetched),
    collected: num(source.collected),
    duplicates: num(source.duplicates),
    pages: num(source.pages),
    code: nullable(source.code, 40),
    lastError: clean(source.lastError, 300),
    phase: clean(source.phase, 200),
    startedAt: nullable(source.startedAt, 40),
    updatedAt: nullable(source.updatedAt, 40),
    finishedAt: nullable(source.finishedAt, 40),
  }
}

function emptyClassification() {
  return { category: null, intent: null, confidence: null, evidence: [], reason: '', model: null, classifiedAt: null, inputHash: null, reviewedByUser: false, needsRetry: false }
}

function normalizeClassification(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    ...emptyClassification(),
    category: typeof source.category === 'string' ? source.category : null,
    intent: typeof source.intent === 'string' ? source.intent : null,
    confidence: Number.isFinite(source.confidence) ? Math.max(0, Math.min(1, source.confidence)) : null,
    evidence: Array.isArray(source.evidence) ? source.evidence.filter(item => typeof item === 'string').slice(0, 6) : [],
    reason: clean(source.reason, 300),
    model: nullable(source.model, 100),
    classifiedAt: nullable(source.classifiedAt, 40),
    inputHash: nullable(source.inputHash, 64),
    reviewedByUser: source.reviewedByUser === true,
    needsRetry: source.needsRetry === true,
  }
}

function normalizeVideo(input) {
  const source = input && typeof input === 'object' ? input : {}
  const videoId = nullable(source.video_id, LIMITS.id)
  const url = normalizeUrl(source.video_url)
  if (!videoId && !url) return null
  if (videoId && !/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) return null
  const hashtags = (Array.isArray(source.hashtags) ? source.hashtags : String(source.hashtags || '').split(/[,#\s]+/))
    .map(item => clean(String(item).replace(/^#/, ''), 40)).filter(Boolean).slice(0, 20)
  return {
    key: videoId ? `v:id:${videoId}` : `v:url:${url}`,
    video_id: videoId,
    video_url: url,
    title: nullable(source.title, LIMITS.title),
    description: nullable(source.description, LIMITS.description),
    hashtags,
    author: nullable(source.author, LIMITS.author),
    topic: nullable(source.topic, LIMITS.topic),
    // 收藏夹来源：只记录同步时所在的收藏夹，方便用户核对；不覆盖用户自己填写的资料。
    favoritesFolder: nullable(source.favoritesFolder, LIMITS.folder),
    note: nullable(source.note, LIMITS.note),
    source: nullable(source.source, 40) || 'import',
    collected_at: nullable(source.collected_at, 40),
    imported_at: nullable(source.imported_at, 40) || new Date().toISOString(),
    classification: normalizeClassification(source.classification),
  }
}

function normalizeUrl(value) {
  const raw = clean(value, LIMITS.url)
  if (!raw) return null
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const parsed = new URL(raw)
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`.slice(0, LIMITS.url)
  } catch { return null }
}

// 抖音“复制链接”给出的是一整段口令，链接常被反引号或中文标点包裹：
// `https://v.douyin.com/foqgvHyHsxw/` 复制此链接，打开Dou音搜索，直接观看视频！
// 直接从整段文字里取第一个 URL，并去掉包裹字符，否则会把反引号当成路径的一部分。
const LINK_IN_TEXT = /https?:\/\/[^\s"'<>`]+/i
// 链接后面若紧跟中文说明（如“，好看”），会被一起吞进 path；遇到非 ASCII 字符就截断。
const stripUrlTail = value => String(value || '').split(/[^\x21-\x7e]/)[0].replace(/[`'"”’\)\]】》>，。！？、；：…]+$/g, '')

function parseVideoLink(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  // 纯作品 ID（抖音 aweme_id 为 19 位数字，也兼容带字母下划线的 ID）
  if (/^[A-Za-z0-9_-]{8,100}$/.test(raw) && /\d/.test(raw)) return { video_id: raw, video_url: null }
  const idMatch = raw.match(/(?:video\/|modal_id=|aweme_id=|item_id=|modalId=)([A-Za-z0-9_-]{6,100})/)
  const urlMatch = raw.match(LINK_IN_TEXT)
  const url = urlMatch ? normalizeUrl(stripUrlTail(urlMatch[0])) : null
  if (idMatch) return { video_id: idMatch[1], video_url: url }
  if (url) {
    // 短链（v.douyin.com/xxx）的尾段是跳转码而不是作品 ID，绝不能当 ID 用。
    const shortLink = /^https?:\/\/v\.douyin\.com\//i.test(url)
    const tail = url.split('/').filter(Boolean).pop() || ''
    if (!shortLink && /^[A-Za-z0-9_-]{8,100}$/.test(tail) && /\d/.test(tail)) return { video_id: tail, video_url: url }
    return { video_id: null, video_url: url }
  }
  return null
}

// 用户主动挑选的视频：链接/ID + 可选标题、标签、主题。source 记录采集方式（clipboard/manual/import）。
function videoRecordFromInput({ text = '', title = '', hashtags = [], topic = '', note = '', source = 'manual' } = {}) {
  const parsed = parseVideoLink(text)
  if (!parsed) return { ok: false, error: '无法识别视频链接或作品 ID，请粘贴 douyin.com/video/... 链接或 19 位作品 ID' }
  const video = normalizeVideo({ ...parsed, title, hashtags, topic, note, source, collected_at: new Date().toISOString() })
  if (!video) return { ok: false, error: '视频链接或作品 ID 不合法' }
  return { ok: true, video }
}

// 视频状态：界面用它展示从收录到候选生成的全流程进度。
const VIDEO_STATUS = {
  imported: '已导入', comments_imported: '评论已导入', analyzing: '分析中',
  analyzed: '分析完成', candidates_ready: '候选已生成', analysis_failed: '分析失败',
}

function videoStatusOf(video, comments = [], task = null) {
  const list = comments.filter(comment => (video.video_id && comment.video_id === video.video_id) || (video.video_url && comment.video_url === video.video_url))
  if (!list.length) return 'imported'
  if (list.some(comment => comment.candidate?.status === 'in_pool')) return 'candidates_ready'
  if (task?.status === 'running') return 'analyzing'
  const pending = list.filter(comment => !comment.classification?.intent || comment.classification?.needsRetry)
  if (!pending.length) return 'analyzed'
  if (pending.length === list.length) {
    if (task?.status === 'partial' || task?.status === 'failed') return 'analysis_failed'
    return 'comments_imported'
  }
  return 'analyzing'
}

function commentKey({ videoKey, commentId, authorId, authorName, text }) {
  if (commentId) return `c:${videoKey}:id:${commentId}`
  // 无评论 ID 时用「作者 + 正文」组合键；同作者同文的重复评论会被合并，属已知取舍。
  return `c:${videoKey}:h:${sha(`${authorId || authorName || ''}\u0000${text}`).slice(0, 24)}`
}

function normalizeComment(input) {
  const source = input && typeof input === 'object' ? input : {}
  const text = nullable(source.text, LIMITS.text)
  if (!text) return null
  const videoId = nullable(source.video_id, LIMITS.id)
  const videoUrl = normalizeUrl(source.video_url)
  if (!videoId && !videoUrl) return null
  const videoKey = videoId ? `v:id:${videoId}` : `v:url:${videoUrl}`
  const commentId = nullable(source.comment_id, LIMITS.id)
  const authorId = nullable(source.author_id, LIMITS.id)
  const authorName = nullable(source.author_name, LIMITS.author)
  const previousCandidate = source.candidate && typeof source.candidate === 'object' ? source.candidate : {}
  return {
    key: commentKey({ videoKey, commentId, authorId, authorName, text }),
    comment_id: commentId,
    video_id: videoId,
    video_url: videoUrl,
    author_id: authorId,
    author_name: authorName,
    text,
    created_at: nullable(source.created_at, 40),
    // 评论级「IP属地」与「回复总数」：页面没有该字段时保存 null，绝不填默认值或主页所在地。
    // ip_location_source 记录证据来源：explicit_label（页面明写 IP属地）/ footer_region（元信息地区段）/ not_present。
    ip_location: nullable(source.ip_location ?? source.ipLocation, 20),
    ip_location_source: nullable(source.ip_location_source ?? source.ipLocationSource, 30) || (nullable(source.ip_location, 20) ? 'unknown' : 'not_present'),
    reply_count: Number.isSafeInteger(source.reply_count) && source.reply_count >= 0 ? source.reply_count
      : (Number.isSafeInteger(source.replyCount) && source.replyCount >= 0 ? source.replyCount : null),
    imported_at: nullable(source.imported_at, 40) || new Date().toISOString(),
    // 来源与采集时间：区分页面读取（douyin_dom）与 JSON/CSV 导入（import）。
    source: nullable(source.source, 40) || 'import',
    collected_at: nullable(source.collected_at, 40),
    origin_note: nullable(source.origin_note, 300),
    note: nullable(source.note, LIMITS.note),
    classification: normalizeClassification(source.classification),
    candidate: {
      status: typeof previousCandidate.status === 'string' ? previousCandidate.status : 'unmapped',
      reason: nullable(previousCandidate.reason, 200),
      candidateId: nullable(previousCandidate.candidateId, 200),
      checkedAt: nullable(previousCandidate.checkedAt, 40),
    },
    originNote: nullable(source.originNote, LIMITS.note),
  }
}

function normalizeLibrary(raw) {
  const base = defaults()
  const source = raw && typeof raw === 'object' ? raw : {}
  const videos = [], comments = []
  const seenVideos = new Set(), seenComments = new Set()
  for (const item of Array.isArray(source.videos) ? source.videos : []) {
    const video = normalizeVideo(item)
    if (video && !seenVideos.has(video.key)) { seenVideos.add(video.key); videos.push(video) }
  }
  for (const item of Array.isArray(source.comments) ? source.comments : []) {
    const comment = normalizeComment(item)
    if (comment && !seenComments.has(comment.key)) { seenComments.add(comment.key); comments.push(comment) }
  }
  return {
    ...base,
    ...source,
    version: VERSION,
    videos: videos.slice(0, MAX_VIDEOS),
    comments: comments.slice(0, MAX_COMMENTS),
    importLogs: Array.isArray(source.importLogs) ? source.importLogs.slice(0, 30) : [],
    task: { ...base.task, ...(source.task && typeof source.task === 'object' ? source.task : {}) },
    collector: normalizeCollector(source.collector),
    favorites: normalizeFavorites(source.favorites),
    pipeline: normalizePipeline(source.pipeline),
    autoContact: normalizeAutoContact(source.autoContact),
    settings: { ...base.settings, ...(source.settings && typeof source.settings === 'object' ? source.settings : {}) },
  }
}

// ── 解析：JSON / JSONL / CSV ────────────────────────────────────────────────
const pickField = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return undefined
}

function rowToRecord(row) {
  if (!row || typeof row !== 'object') return { error: '不是对象' }
  const videoId = pickField(row, ['video_id', 'videoId', 'aweme_id', 'awemeId'])
  const videoUrl = pickField(row, ['video_url', 'videoUrl', 'share_url', 'shareUrl', 'url'])
  const text = pickField(row, ['comment_text', 'commentText', 'text', 'content', 'comment'])
  const author = pickField(row, ['author_id', 'authorId', 'user_id', 'userId', 'sec_uid', 'secUid', 'uid'])
  const isComment = Boolean(author || pickField(row, ['comment_id', 'commentId'])) && Boolean(text)
  const hashtags = pickField(row, ['hashtags', 'tags'])
  if (isComment) {
    return { type: 'comment', value: {
      comment_id: pickField(row, ['comment_id', 'commentId', 'cid']),
      video_id: videoId, video_url: videoUrl,
      author_id: author,
      author_name: pickField(row, ['author_name', 'authorName', 'nickname', 'user_name', 'userName', 'nick']),
      text,
      created_at: pickField(row, ['created_at', 'createdAt', 'time', 'publish_time', 'publishedAt']),
    } }
  }
  if (videoId || videoUrl) {
    return { type: 'video', value: {
      video_id: videoId, video_url: videoUrl,
      title: pickField(row, ['title', 'desc', 'description', 'caption']),
      description: pickField(row, ['description', 'desc', 'summary']),
      hashtags: Array.isArray(hashtags) ? hashtags : hashtags ? String(hashtags).split(/[,#\s]+/) : [],
      author: pickField(row, ['author', 'author_name', 'nickname', 'user_name']),
      topic: pickField(row, ['topic', 'category']),
      collected_at: pickField(row, ['collected_at', 'createdAt', 'created_at', 'time']),
      note: pickField(row, ['note', 'remark']),
    } }
  }
  return { error: '既没有视频 ID/链接，也没有可识别的评论作者与正文' }
}

function parseCsv(text) {
  const rows = []
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim())
  if (!lines.length) return []
  const parseLine = line => {
    const cells = []; let current = '', quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1 }
        else if (char === '"') quoted = false
        else current += char
      } else if (char === '"') quoted = true
      else if (char === ',') { cells.push(current); current = '' }
      else current += char
    }
    cells.push(current)
    return cells
  }
  const header = parseLine(lines[0]).map(item => item.trim())
  for (let index = 1; index < lines.length; index += 1) {
    const cells = parseLine(lines[index])
    const row = {}
    header.forEach((name, position) => { if (name) row[name] = cells[position] !== undefined ? cells[position].trim() : '' })
    rows.push(row)
  }
  return rows
}

function parseImport(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '')
  const trimmed = raw.trim()
  const errors = [], rows = []
  if (!trimmed) return { rows, errors: [{ row: 0, reason: '内容为空' }] }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed = null
    try { parsed = JSON.parse(trimmed) } catch { parsed = null }
    if (parsed) {
      if (Array.isArray(parsed)) return { rows: parsed, errors }
      if (typeof parsed === 'object') {
        const videos = Array.isArray(parsed.videos) ? parsed.videos : []
        const comments = Array.isArray(parsed.comments) ? parsed.comments : []
        return { rows: [...videos, ...comments], errors }
      }
    }
    // 不是整体 JSON：按 JSONL 逐行
    const lines = trimmed.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!line.trim()) return
      try { rows.push(JSON.parse(line)) } catch { errors.push({ row: index + 1, reason: '不是合法 JSON 行' }) }
    })
    return { rows, errors }
  }
  if (/^[^\n]*,[^\n]*/.test(trimmed.split(/\r?\n/)[0])) {
    const parsed = parseCsv(trimmed)
    if (parsed.length) return { rows: parsed, errors }
  }
  const lines = trimmed.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!line.trim()) return
    try { rows.push(JSON.parse(line)) } catch { errors.push({ row: index + 1, reason: '无法识别的行（既不是 CSV 表头也不是 JSON）' }) }
  })
  return { rows, errors }
}

// ── 库读写 ────────────────────────────────────────────────────────────────
class LibraryStore {
  constructor(dir) {
    this.dir = dir
    this.filePath = path.join(dir, 'library', 'library.json')
  }

  read() {
    // P2-15.1：主文件损坏时先尝试 .bak（原子写入降级时留下的上一代完整文件）。
    const primary = readJsonWithRecoverySync(this.filePath)
    if (primary.ok) return normalizeLibrary(primary.data)
    // 再退回更早的两代备份；都不可用则返回空库，绝不抛错。
    for (const name of ['library.prev.json', 'library.prev2.json']) {
      try {
        const file = path.join(path.dirname(this.filePath), name)
        if (fs.existsSync(file)) return normalizeLibrary(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch { /* 继续尝试下一份 */ }
    }
    return defaults()
  }

  // 一键清空素材库：只清本地收集的视频、评论与收集断点，不删除账号或聊天记录。
  clear() {
    return this.save(defaults())
  }

  save(library) {
    const normalized = normalizeLibrary({ ...library, updatedAt: new Date().toISOString() })
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    try {
      const prev = path.join(path.dirname(this.filePath), 'library.prev.json')
      const prev2 = path.join(path.dirname(this.filePath), 'library.prev2.json')
      if (fs.existsSync(prev)) copyFileRobustSync(prev, prev2)
      if (fs.existsSync(this.filePath)) copyFileRobustSync(this.filePath, prev)
    } catch { /* 备份失败不阻塞写入 */ }
    // P2-15：Windows 上 rename 覆盖可能被短暂占用（EPERM），统一走带重试的原子写入。
    writeFileAtomicSync(this.filePath, JSON.stringify(normalized, null, 2))
    return normalized
  }

  importText(text, { filename = '' } = {}) {
    const library = this.read()
    const { rows, errors } = parseImport(text)
    const videoKeys = new Set(library.videos.map(item => item.key))
    const commentKeys = new Set(library.comments.map(item => item.key))
    const log = {
      id: `import_${Date.now().toString(36)}`, at: new Date().toISOString(), filename: clean(filename, 200) || null,
      rows: rows.length, addedVideos: 0, duplicateVideos: 0, addedComments: 0, duplicateComments: 0, invalid: errors.length, errors: errors.slice(0, 50),
    }
    for (let index = 0; index < rows.length; index += 1) {
      const record = rowToRecord(rows[index])
      if (record.error) { log.invalid += 1; if (log.errors.length < 50) log.errors.push({ row: index + 1, reason: record.error }); continue }
      if (record.type === 'video') {
        const video = normalizeVideo(record.value)
        if (!video) { log.invalid += 1; if (log.errors.length < 50) log.errors.push({ row: index + 1, reason: '视频缺少有效 ID 或链接' }); continue }
        if (videoKeys.has(video.key)) { log.duplicateVideos += 1; continue }
        if (library.videos.length >= MAX_VIDEOS) { log.invalid += 1; log.errors.push({ row: index + 1, reason: '视频数量已达上限' }); continue }
        videoKeys.add(video.key); library.videos.push(video); log.addedVideos += 1
        continue
      }
      const comment = normalizeComment(record.value)
      if (!comment) { log.invalid += 1; if (log.errors.length < 50) log.errors.push({ row: index + 1, reason: '评论缺少正文或所属视频' }); continue }
      if (commentKeys.has(comment.key)) { log.duplicateComments += 1; continue }
      if (library.comments.length >= MAX_COMMENTS) { log.invalid += 1; log.errors.push({ row: index + 1, reason: '评论数量已达上限' }); continue }
      commentKeys.add(comment.key); library.comments.push(comment); log.addedComments += 1
    }
    library.importLogs = [log, ...library.importLogs].slice(0, 30)
    const saved = this.save(library)
    return { library: saved, log }
  }

  // 用户主动收录单条视频：已存在时只补齐缺失的标题/标签/主题，不覆盖人工内容。
  addVideo(input = {}) {
    const library = this.read()
    const video = input?.key ? normalizeVideo(input) : videoRecordFromInput(input).video
    if (!video) throw new Error('无法识别视频链接或作品 ID')
    const index = library.videos.findIndex(item => item.key === video.key)
    if (index >= 0) {
      const existing = library.videos[index]
      const merged = normalizeVideo({
        ...existing,
        title: existing.title || video.title,
        description: existing.description || video.description,
        hashtags: existing.hashtags.length ? existing.hashtags : video.hashtags,
        topic: existing.topic || video.topic,
        author: existing.author || video.author,
      })
      library.videos[index] = merged
      return { added: false, video: merged, library: this.save(library) }
    }
    if (library.videos.length >= MAX_VIDEOS) throw new Error('视频数量已达上限')
    library.videos.push(video)
    return { added: true, video, library: this.save(library) }
  }

  patchVideo(key, patch = {}) {
    const library = this.read()
    const index = library.videos.findIndex(item => item.key === key)
    if (index < 0) throw new Error('找不到该视频记录')
    const video = library.videos[index]
    const next = { ...video }
    if (typeof patch.category === 'string') {
      next.classification = { ...video.classification, category: patch.category, confidence: 1, reason: clean(patch.reason, 300) || '人工复核', reviewedByUser: true, classifiedAt: new Date().toISOString() }
    }
    if (typeof patch.topic === 'string') next.topic = nullable(patch.topic, LIMITS.topic)
    if (typeof patch.note === 'string') next.note = nullable(patch.note, LIMITS.note)
    library.videos[index] = next
    return this.save(library)
  }

  patchComment(key, patch = {}) {
    const library = this.read()
    const index = library.comments.findIndex(item => item.key === key)
    if (index < 0) throw new Error('找不到该评论记录')
    const comment = library.comments[index]
    const next = { ...comment }
    if (typeof patch.intent === 'string') {
      next.classification = { ...comment.classification, intent: patch.intent, confidence: 1, reason: clean(patch.reason, 300) || '人工复核', reviewedByUser: true, classifiedAt: new Date().toISOString() }
    }
    if (typeof patch.note === 'string') next.note = nullable(patch.note, LIMITS.note)
    library.comments[index] = next
    return this.save(library)
  }

  // P2-10 批量写入页面收集到的评论：按稳定 key 去重，已存在的评论不覆盖人工结论。
  addComments(inputs = []) {
    const library = this.read()
    const byKey = new Map(library.comments.map(item => [item.key, item]))
    let refreshed = false
    let added = 0, duplicates = 0, invalid = 0
    const addedKeys = []
    for (const input of Array.isArray(inputs) ? inputs : []) {
      const comment = normalizeComment(input)
      if (!comment) { invalid += 1; continue }
      const prior = byKey.get(comment.key)
      if (prior) {
        duplicates += 1
        if (comment.source === 'douyin_dom' && prior.author_id === comment.author_id && prior.text === comment.text) {
          if (comment.ip_location && (prior.ip_location !== comment.ip_location || prior.ip_location_source !== comment.ip_location_source)) {
            prior.ip_location = comment.ip_location
            prior.ip_location_source = comment.ip_location_source
            refreshed = true
          }
          if (comment.reply_count !== null && prior.reply_count !== comment.reply_count) {
            prior.reply_count = comment.reply_count
            refreshed = true
          }
        }
        continue
      }
      byKey.set(comment.key, comment)
      library.comments.push(comment)
      addedKeys.push(comment.key)
      added += 1
    }
    if (added || refreshed) this.save(library)
    return { added, duplicates, invalid, addedKeys, library: added || refreshed ? this.read() : library }
  }

  setCollector(patch = {}) {
    const library = this.read()
    library.collector = normalizeCollector({ ...library.collector, ...patch, updatedAt: new Date().toISOString() })
    return this.save(library).collector
  }

  collectorState() { return this.read().collector }

  // P2-11A 收藏夹同步状态：每次同步都写入时间和结果，失败原因保留给界面展示。
  setFavorites(patch = {}) {
    const library = this.read()
    library.favorites = normalizeFavorites({ ...library.favorites, ...patch, updatedAt: new Date().toISOString() })
    return this.save(library).favorites
  }

  favoritesState() { return this.read().favorites }
  schedulerState() { return this.read().scheduler }

  // P2-11B 自动流水线状态：每次只合并补丁，逐视频记录不会被整条覆盖。
  setPipeline(patch = {}) {
    const library = this.read()
    library.pipeline = normalizePipeline({ ...library.pipeline, ...patch, updatedAt: new Date().toISOString() })
    return this.save(library).pipeline
  }

  pipelineState() { return this.read().pipeline }

  // P2-13：双模式配置、自动联系队列与预算只写 library.json，不触碰 state.json 的联系人/聊天状态。
  setAutoContact(patch = {}) {
    const library = this.read()
    library.autoContact = normalizeAutoContact({ ...library.autoContact, ...patch, updatedAt: new Date().toISOString() })
    return this.save(library).autoContact
  }

  autoContactState() { return this.read().autoContact }

  // P2-15.1 授权证据写入：三类证据各自独立，任何一类都不能由另外两类推导出来。
  setPlatformAuthorization({ allowed = false, verifiedAt = null, basis = '', note = '', expiresAt = null } = {}) {
    const library = this.read()
    const authorization = normalizeAuthorization(library.autoContact.authorization)
    authorization.platform = {
      allowed: allowed === true,
      // 记录"核实平台自动化权限"的时间，与登录时间无关；未提供时按当前时间记录，便于追溯。
      verifiedAt: allowed === true ? (nullable(verifiedAt, 40) || new Date().toISOString()) : null,
      basis: clean(basis, 300),
      note: clean(note, 300),
      expiresAt: allowed === true ? nullable(expiresAt, 40) : null,
    }
    library.autoContact.authorization = authorization
    library.autoContact.updatedAt = new Date().toISOString()
    return this.save(library).autoContact.authorization.platform
  }

  setRecipientConsent(platformUserId, { accepted = false, at = null, source = '', note = '', expiresAt = null, revokedAt = null } = {}) {
    const id = clean(platformUserId, 120)
    if (!id) throw new Error('缺少可核对的用户 ID，不能记录对方同意')
    const library = this.read()
    const authorization = normalizeAuthorization(library.autoContact.authorization)
    authorization.recipientAiConsent[id] = {
      accepted: accepted === true,
      at: accepted === true ? (nullable(at, 40) || new Date().toISOString()) : null,
      source: clean(source, 200),
      note: clean(note, 300),
      revokedAt: accepted === true ? nullable(revokedAt, 40) : (nullable(revokedAt, 40) || new Date().toISOString()),
      expiresAt: accepted === true ? nullable(expiresAt, 40) : null,
    }
    library.autoContact.authorization = authorization
    library.autoContact.updatedAt = new Date().toISOString()
    return this.save(library).autoContact.authorization.recipientAiConsent[id]
  }

  // 操作者确认只对指定对象、指定动作生效，并带有效期；不是一次勾选永久解锁全部候选人。
  setOperatorConfirmation(platformUserId, { actions = [], expiresAt = null, channel = '', note = '' } = {}) {
    const id = clean(platformUserId, 120)
    if (!id) throw new Error('缺少可核对的用户 ID，不能记录操作者确认')
    const list = (Array.isArray(actions) ? actions : [actions]).map(action => clean(action, 20)).filter(action => AUTO_ACTIONS.includes(action))
    if (!list.length) throw new Error('操作者确认必须指定动作范围（follow / firstMessage）')
    const library = this.read()
    const authorization = normalizeAuthorization(library.autoContact.authorization)
    authorization.operator[id] = {
      confirmedAt: new Date().toISOString(),
      actions: [...new Set(list)],
      expiresAt: nullable(expiresAt, 40),
      channel: clean(channel, 60),
      note: clean(note, 200),
    }
    library.autoContact.authorization = authorization
    library.autoContact.updatedAt = new Date().toISOString()
    return this.save(library).autoContact.authorization.operator[id]
  }

  revokeAuthorization({ kind = '', platformUserId = '' } = {}) {
    const library = this.read()
    const authorization = normalizeAuthorization(library.autoContact.authorization)
    const id = clean(platformUserId, 120)
    if (kind === 'platform') authorization.platform = { allowed: false, verifiedAt: null, basis: '', note: '', expiresAt: null }
    else if (kind === 'recipient' && id) authorization.recipientAiConsent[id] = { accepted: false, at: null, source: '', note: '', revokedAt: new Date().toISOString(), expiresAt: null }
    else if (kind === 'operator' && id) delete authorization.operator[id]
    else throw new Error('撤销授权需要指定 kind（platform / recipient / operator）与用户 ID')
    library.autoContact.authorization = authorization
    library.autoContact.updatedAt = new Date().toISOString()
    return this.save(library).autoContact.authorization
  }

  // 收藏夹同步批量入库：一次保存，按作品 ID 去重。
  // 已经存在的视频原样保留，不覆盖用户填写的标题、主题、标签或人工分类。
  addFavoriteVideos(inputs = [], { folderName = '' } = {}) {
    const library = this.read()
    const keys = new Set(library.videos.map(item => item.key))
    const folder = nullable(folderName, LIMITS.folder)
    let added = 0, duplicates = 0, invalid = 0
    for (const input of Array.isArray(inputs) ? inputs : []) {
      const video = normalizeVideo({
        video_id: input?.video_id ?? input?.videoId,
        video_url: input?.video_url ?? input?.url,
        title: input?.title,
        source: 'favorites',
        favoritesFolder: folder,
        collected_at: new Date().toISOString(),
      })
      if (!video) { invalid += 1; continue }
      if (keys.has(video.key)) { duplicates += 1; continue }
      if (library.videos.length >= MAX_VIDEOS) { invalid += 1; continue }
      keys.add(video.key)
      library.videos.push(video)
      added += 1
    }
    if (added) this.save(library)
    return { added, duplicates, invalid, library: added ? this.read() : library }
  }

  markCandidate(key, patch = {}) {
    const library = this.read()
    const index = library.comments.findIndex(item => item.key === key)
    if (index < 0) return library
    library.comments[index] = { ...library.comments[index], candidate: { ...library.comments[index].candidate, ...patch, checkedAt: new Date().toISOString() } }
    return this.save(library)
  }

  replace(library) { return this.save(library) }
}

// ── 统计与视图 ────────────────────────────────────────────────────────────
function statsOf(library) {
  const videos = library.videos || [], comments = library.comments || []
  const byCategory = {}, byIntent = {}
  for (const video of videos) { const key = video.classification?.category || 'unknown'; byCategory[key] = (byCategory[key] || 0) + 1 }
  for (const comment of comments) { const key = comment.classification?.intent || 'unknown'; byIntent[key] = (byIntent[key] || 0) + 1 }
  const candidateIntent = item => CANDIDATE_INTENTS.includes(item.classification?.intent)
  return {
    videos: videos.length, comments: comments.length,
    // P2-11D 总览：只统计收藏夹来源的视频，手动导入不计入“同步视频数”。
    favoriteVideos: videos.filter(item => item.source === 'favorites' || item.favoritesFolder).length,
    videosNeedingClassification: videos.filter(item => !item.classification?.reviewedByUser && (!item.classification?.category || item.classification?.needsRetry)).length,
    commentsNeedingClassification: comments.filter(item => !item.classification?.reviewedByUser && (!item.classification?.intent || item.classification?.needsRetry)).length,
    byCategory, byIntent,
    candidateReady: comments.filter(item => candidateIntent(item) && item.author_id).length,
    missingAuthorId: comments.filter(item => candidateIntent(item) && !item.author_id).length,
    inPool: comments.filter(item => item.candidate?.status === 'in_pool').length,
  }
}

function viewOf(library, { videoLimit = 20, commentLimit = 40 } = {}) {
  const comments = library.comments || []
  return {
    stats: statsOf(library),
    updatedAt: library.updatedAt,
    task: library.task,
    collector: library.collector,
    favorites: library.favorites,
    pipeline: library.pipeline,
    autoContact: library.autoContact,
    settings: library.settings,
    importLogs: (library.importLogs || []).slice(0, 5),
    videos: (library.videos || []).slice(-videoLimit).reverse().map(video => {
      const list = comments.filter(comment => comment.video_id === video.video_id || (video.video_url && comment.video_url === video.video_url))
      const status = videoStatusOf(video, comments, library.task)
      return {
        ...video,
        status,
        statusLabel: VIDEO_STATUS[status],
        commentCount: list.length,
        classifiedCount: list.filter(comment => comment.classification?.intent || comment.classification?.reviewedByUser).length,
        candidateCount: list.filter(comment => comment.candidate?.status === 'in_pool').length,
      }
    }),
    comments: comments.slice(-commentLimit).reverse(),
  }
}

module.exports = {
  VERSION, MAX_VIDEOS, MAX_COMMENTS, LIMITS, VIDEO_STATUS,
  defaults, normalizeLibrary, normalizeVideo, normalizeComment, normalizeClassification, normalizeCollector,
  normalizeFavorites, emptyFavorites,
  normalizePipeline, normalizePipelineItem, emptyPipeline, PIPELINE_ITEM_STATUS,
  normalizeScheduler, emptyScheduler,
  AUTO_MODES, ACTION_TASK_STATUS, emptyAutoContact, normalizeAutoContact, autoModeConfig, normalizeAutoTask,
  parseImport, rowToRecord, parseCsv, normalizeUrl, parseVideoLink, videoRecordFromInput,
  videoStatusOf, commentKey, statsOf, viewOf, LibraryStore,
}
