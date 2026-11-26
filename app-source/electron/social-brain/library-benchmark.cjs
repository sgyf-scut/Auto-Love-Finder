// P2-12A 评论分类人工基准集：盲评抽样、进度保存、逐类别指标与混淆矩阵。
// 边界：
// 1) 只读本地学习库/素材库，不联网、不发送消息；
// 2) 盲评视图绝不返回模型分类、置信度、证据或作者身份；
// 3) 人工标签仍由 LearningStore.annotate 写入，本模块只记录基准集成员和评估结果；
// 4) 基准集抽样优先按需求给定配额，某类不足时如实记录缺口，不伪造样本、不改标签。
const fs = require('node:fs')
const { writeFileAtomicSync } = require('../atomic-write.cjs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { COMMENT_INTENTS, LABELS, CANDIDATE_INTENTS } = require('./library-classifier.cjs')

const VERSION = 1
const DEFAULT_SIZE = 60
const POSITIVE_INTENTS = CANDIDATE_INTENTS
const POSITIVE_SET = new Set(POSITIVE_INTENTS)
// 需求给定的首版抽样配额；实际不足时按真实可用样本补齐，并记录 shortage。
const DEFAULT_QUOTAS = [
  ['EXPLICIT_INVITATION', 3],
  ['SEEKING_FRIENDS', 15],
  ['CONTEXTUAL_INTEREST', 20],
  ['ORDINARY', 18],
  ['ADVERTISEMENT', 1],
  ['UNKNOWN', 2],
  ['UNCLASSIFIED', 1],
]
const LABEL_OPTIONS = COMMENT_INTENTS.map(intent => ({ intent, label: LABELS[intent] || intent }))
const UNCLASSIFIED = 'UNCLASSIFIED'
const CLASS_OF_INTENT = intent => (COMMENT_INTENTS.includes(intent) ? intent : UNCLASSIFIED)
const sha = value => createHash('sha256').update(String(value)).digest('hex')
const now = () => new Date().toISOString()
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : fallback)
const rate = (value, base) => (base ? Number((value / base).toFixed(4)) : null)

function emptyState() {
  return { version: VERSION, activeSet: null, history: [], updatedAt: null }
}

function normalizeSet(value) {
  if (!value || typeof value !== 'object') return null
  const keys = Array.isArray(value.keys) ? value.keys.filter(item => typeof item === 'string' && item).slice(0, 200) : []
  if (!keys.length) return null
  return {
    id: String(value.id || '').slice(0, 60) || `bm_${Date.parse(value.createdAt) || 0}`,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    status: ['open', 'completed', 'closed'].includes(value.status) ? value.status : 'open',
    size: keys.length,
    requestedSize: num(value.requestedSize, keys.length),
    quotas: value.quotas && typeof value.quotas === 'object' ? value.quotas : {},
    quotaActual: value.quotaActual && typeof value.quotaActual === 'object' ? value.quotaActual : {},
    shortage: value.shortage && typeof value.shortage === 'object' ? value.shortage : {},
    note: typeof value.note === 'string' ? value.note.slice(0, 300) : '',
    keys,
  }
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    version: VERSION,
    activeSet: normalizeSet(source.activeSet),
    history: (Array.isArray(source.history) ? source.history : []).map(normalizeSet).filter(Boolean).slice(-10),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  }
}

class BenchmarkStore {
  constructor(dir) {
    this.dir = dir
    this.filePath = path.join(dir, 'library', 'benchmark.json')
  }

  read() {
    try {
      if (!fs.existsSync(this.filePath)) return emptyState()
      return normalizeState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')))
    } catch {
      return emptyState()
    }
  }

  save(state) {
    const normalized = normalizeState({ ...state, updatedAt: now() })
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    // P2-15：Windows 上 rename 覆盖可能被短暂占用（EPERM），统一走带重试的原子写入。
    writeFileAtomicSync(this.filePath, JSON.stringify(normalized, null, 2))
    return normalized
  }
}

function favoritesVideoIds(library = {}) {
  const ids = new Set()
  for (const video of library.videos || []) {
    if (video.source === 'favorites' || video.favoritesFolder) {
      if (video.video_id) ids.add(String(video.video_id))
    }
  }
  return ids
}

// 从列表里均匀抽取，覆盖前中后段；列表本身已按 key 排序，结果可复现。
function pickEvenly(list = [], count = 0) {
  const take = Math.min(list.length, Math.max(0, count))
  if (take <= 0) return []
  if (take >= list.length) return list.slice()
  const picked = []
  const step = list.length / take
  for (let index = 0; index < take; index += 1) {
    const at = Math.min(list.length - 1, Math.floor(index * step + step / 2))
    if (!picked.includes(list[at])) picked.push(list[at])
  }
  return picked
}

function bucketOf(sample) {
  const intent = sample?.ai?.intent
  return COMMENT_INTENTS.includes(intent) ? intent : UNCLASSIFIED
}

function eligibleSamples(learning = {}, library = {}) {
  const favorites = favoritesVideoIds(library)
  return (learning.samples || [])
    .filter(sample => !sample.excluded && !sample.human?.intent)
    .filter(sample => !favorites.size || favorites.has(String(sample.videoId || '')))
    .slice()
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
}

// 创建基准集：默认 3/15/20/18/1/2/1，缺额按真实可用样本补齐。
// 已被人工标注过的样本不会进入新基准集，避免把历史非盲标签当成盲评结果。
function createBenchmarkSet({ learning = {}, library = {}, size = DEFAULT_SIZE, reset = false, previous = null, quotas = null } = {}) {
  const state = normalizeState(previous)
  if (!reset && state.activeSet) return { created: false, set: state.activeSet, state }
  const pool = eligibleSamples(learning, library)
  const buckets = new Map()
  for (const sample of pool) {
    const bucket = bucketOf(sample)
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket).push(sample)
  }
  const spec = Array.isArray(quotas) && quotas.length ? quotas : DEFAULT_QUOTAS
  const requested = spec.reduce((sum, item) => sum + num(item[1]), 0) || size
  const target = Math.max(1, Math.min(num(size, DEFAULT_SIZE), requested))
  const chosen = []
  const chosenKeys = new Set()
  const quotaActual = {}
  const shortage = {}
  for (const [bucket, want] of spec) {
    const available = buckets.get(bucket) || []
    const picks = pickEvenly(available, Math.min(num(want), target))
    quotaActual[bucket] = picks.length
    if (picks.length < num(want)) shortage[bucket] = num(want) - picks.length
    for (const sample of picks) {
      if (!chosenKeys.has(sample.key)) { chosenKeys.add(sample.key); chosen.push(sample) }
    }
  }
  // 配额不足时从剩余真实样本补齐到目标数量，不重复、不替换。
  if (chosen.length < target) {
    const leftovers = pool.filter(sample => !chosenKeys.has(sample.key))
    for (const sample of pickEvenly(leftovers, target - chosen.length)) {
      if (!chosenKeys.has(sample.key)) { chosenKeys.add(sample.key); chosen.push(sample); quotaActual[bucketOf(sample)] = (quotaActual[bucketOf(sample)] || 0) + 1 }
    }
  }
  const id = `bm_${Date.now()}`
  // 打乱顺序：按 key+集合 id 的哈希排序，既避免按类别连续标注，也保证续标顺序稳定。
  const keys = chosen.map(sample => sample.key).sort((a, b) => sha(`${id}:${a}`).localeCompare(sha(`${id}:${b}`)))
  const set = normalizeSet({
    id, createdAt: now(), status: 'open', requestedSize: target, quotas: Object.fromEntries(spec),
    quotaActual, shortage, keys,
    note: `可用样本 ${pool.length} 条；不足配额会如实记录，未伪造样本。`,
  })
  const next = normalizeState({ activeSet: set, history: [...state.history, state.activeSet].filter(Boolean), updatedAt: now() })
  return { created: true, set, state: next }
}

function sampleMap(learning = {}) {
  return new Map((learning.samples || []).map(sample => [sample.key, sample]))
}

function labelOf(sample) {
  const intent = sample?.human?.intent
  return COMMENT_INTENTS.includes(intent) ? intent : null
}

function confusionTemplate() {
  const row = {}
  for (const intent of COMMENT_INTENTS) row[intent] = 0
  row[UNCLASSIFIED] = 0
  return row
}

function rowOf(sample) {
  const expected = labelOf(sample)
  if (!expected) return null
  const predicted = CLASS_OF_INTENT(sample?.ai?.intent)
  return {
    key: sample.key,
    expected,
    predicted,
    confidence: Number.isFinite(sample?.ai?.confidence) ? sample.ai.confidence : null,
    evidence: Array.isArray(sample?.ai?.evidence) ? sample.ai.evidence.slice(0, 3) : [],
    text: String(sample.text || '').slice(0, 160),
    videoTitle: String(sample.videoTitle || '').slice(0, 120),
    authorId: String(sample.authorId || ''),
    annotatedAt: sample.human?.at || null,
    humanReason: String(sample.human?.reason || '').slice(0, 200),
    correct: expected === predicted,
  }
}

function severeKind(row) {
  if (row.expected === 'DO_NOT_CONTACT' && POSITIVE_SET.has(row.predicted)) return 'REJECTION_TO_POSITIVE'
  if (row.expected === 'ORDINARY' && row.predicted === 'SEEKING_FRIENDS') return 'ORDINARY_TO_SEEKING'
  if (row.expected === 'CONTEXTUAL_INTEREST' && row.predicted === 'EXPLICIT_INVITATION') return 'CONTEXTUAL_TO_EXPLICIT'
  if (POSITIVE_SET.has(row.expected) && row.predicted === 'DO_NOT_CONTACT') return 'POSITIVE_TO_REJECTION'
  return 'MISCLASSIFIED'
}

function metricsOfRows(rows = []) {
  const total = rows.length
  const classes = COMMENT_INTENTS.slice()
  const confusion = {}
  for (const expected of classes) confusion[expected] = confusionTemplate()
  for (const row of rows) {
    if (!confusion[row.expected]) confusion[row.expected] = confusionTemplate()
    confusion[row.expected][row.predicted] = (confusion[row.expected][row.predicted] || 0) + 1
  }
  const perClass = {}
  for (const intent of classes) {
    const support = rows.filter(row => row.expected === intent).length
    const predicted = rows.filter(row => row.predicted === intent).length
    const tp = rows.filter(row => row.expected === intent && row.predicted === intent).length
    const precision = rate(tp, predicted)
    const recall = rate(tp, support)
    const f1 = precision !== null && recall !== null && precision + recall > 0
      ? Number((2 * precision * recall / (precision + recall)).toFixed(4)) : (tp ? 0 : null)
    perClass[intent] = { support, predicted, tp, precision, recall, f1 }
  }
  const supported = classes.filter(intent => perClass[intent].support > 0)
  const macroF1Supported = supported.length
    ? Number((supported.reduce((sum, intent) => sum + (perClass[intent].f1 || 0), 0) / supported.length).toFixed(4)) : null
  const macroF1AllClasses = Number((classes.reduce((sum, intent) => sum + (perClass[intent].f1 || 0), 0) / classes.length).toFixed(4))
  const positives = rows.filter(row => POSITIVE_SET.has(row.expected))
  const predictedPositives = rows.filter(row => POSITIVE_SET.has(row.predicted))
  const truePositives = rows.filter(row => POSITIVE_SET.has(row.expected) && POSITIVE_SET.has(row.predicted))
  const falsePositives = rows.filter(row => POSITIVE_SET.has(row.predicted) && !POSITIVE_SET.has(row.expected))
  const falseNegatives = rows.filter(row => POSITIVE_SET.has(row.expected) && !POSITIVE_SET.has(row.predicted))
  const explicit = perClass.EXPLICIT_INVITATION
  const wrong = rows.filter(row => !row.correct).map(row => ({ ...row, severe: severeKind(row) }))
  const consentErrors = rows.filter(row => row.predicted === 'EXPLICIT_INVITATION' && row.expected !== 'EXPLICIT_INVITATION')
  const negative = rows.filter(row => !POSITIVE_SET.has(row.expected))
  const positiveClasses = POSITIVE_INTENTS.filter(intent => perClass[intent].support > 0)
  const sufficient = total >= 40
    && positiveClasses.length === POSITIVE_INTENTS.length
    && positiveClasses.every(intent => perClass[intent].support >= 2)
    && negative.length >= 10
  return {
    total,
    labeled: total,
    correct: rows.filter(row => row.correct).length,
    accuracy: rate(rows.filter(row => row.correct).length, total),
    perClass,
    macroF1: macroF1Supported,
    macroF1Supported,
    macroF1AllClasses,
    confusion,
    support: Object.fromEntries(classes.map(intent => [intent, perClass[intent].support])),
    positiveSupport: positives.length,
    negativeSupport: negative.length,
    friendship: {
      precision: rate(truePositives.length, predictedPositives.length),
      recall: rate(truePositives.length, positives.length),
      f1: (() => {
        const precision = rate(truePositives.length, predictedPositives.length)
        const recall = rate(truePositives.length, positives.length)
        return precision !== null && recall !== null && precision + recall > 0
          ? Number((2 * precision * recall / (precision + recall)).toFixed(4)) : null
      })(),
      predictedPositives: predictedPositives.length,
      truePositives: truePositives.length,
    },
    explicit: {
      precision: explicit.precision,
      recall: explicit.recall,
      support: explicit.support,
      predicted: explicit.predicted,
    },
    consentToDmErrors: consentErrors.length,
    consentToDmErrorRows: consentErrors.slice(0, 20),
    falsePositiveCount: falsePositives.length,
    falseNegativeCount: falseNegatives.length,
    falsePositiveRows: falsePositives.slice(0, 20),
    falseNegativeRows: falseNegatives.slice(0, 20),
    wrong: wrong.slice(0, 30),
    severeWrong: wrong.filter(row => row.severe !== 'MISCLASSIFIED').slice(0, 20),
    evidenceSufficient: sufficient,
    evidenceNote: sufficient
      ? '样本量满足首版评估要求'
      : `样本不足：已标注 ${total} 条，需至少 40 条且三类交友意愿各至少 2 条、非交友类至少 10 条；不得据此宣称达标`,
  }
}

function rejectionLeaks(learning = {}, library = {}, candidateUserIds = []) {
  const humanRejected = new Set()
  const modelRejected = new Set()
  for (const sample of learning.samples || []) {
    if (sample.excluded) continue
    if (sample.human?.intent === 'DO_NOT_CONTACT' && sample.authorId) humanRejected.add(String(sample.authorId))
    if (sample.ai?.intent === 'DO_NOT_CONTACT' && Array.isArray(sample.ai.evidence) && sample.ai.evidence.length && sample.authorId) {
      modelRejected.add(String(sample.authorId))
    }
  }
  const candidateIds = new Set((candidateUserIds || []).map(String).filter(Boolean))
  const inPool = new Set()
  const leakedKeys = []
  for (const comment of library.comments || []) {
    if (!comment.author_id || comment.candidate?.status !== 'in_pool') continue
    inPool.add(String(comment.author_id))
    if (humanRejected.has(String(comment.author_id)) || modelRejected.has(String(comment.author_id))) {
      leakedKeys.push({ key: comment.key, authorId: String(comment.author_id), reason: humanRejected.has(String(comment.author_id)) ? 'HUMAN_REJECTION' : 'MODEL_REJECTION' })
    }
  }
  const candidateLeaks = [...candidateIds].filter(id => humanRejected.has(id) || modelRejected.has(id))
  return {
    humanRejectedCount: humanRejected.size,
    modelRejectedCount: modelRejected.size,
    poolAuthorCount: inPool.size,
    leakedCandidates: candidateLeaks.length,
    leakedCommentKeys: leakedKeys.slice(0, 20),
    leakCount: new Set([...candidateLeaks, ...leakedKeys.map(item => item.authorId)]).size,
  }
}

function targetsOf(metrics, leaks) {
  const macroTarget = 0.8
  const friendshipTarget = 0.9
  const macroPass = metrics.macroF1 !== null && metrics.macroF1 >= macroTarget
  const friendshipPass = metrics.friendship.precision !== null && metrics.friendship.precision >= friendshipTarget
  const consentPass = metrics.consentToDmErrors === 0
  const rejectionPass = leaks.leakCount === 0
  const sufficient = metrics.evidenceSufficient
  return {
    macroF1Target: macroTarget, friendshipPrecisionTarget: friendshipTarget,
    macroF1Pass: macroPass, friendshipPrecisionPass: friendshipPass,
    consentToDmPass: consentPass, rejectionProtectionPass: rejectionPass,
    status: !sufficient ? 'insufficient_evidence' : (macroPass && friendshipPass && consentPass && rejectionPass ? 'meets_targets' : 'below_targets'),
    note: !sufficient
      ? '人工标注不足，指标仅作阶段性参考，不能宣称分类器已达标'
      : (macroPass && friendshipPass && consentPass && rejectionPass ? '达到首版验收目标' : '未达到首版验收目标，需要定位可复现错误后再修正'),
  }
}

function buildView(state, learning = {}, { limit = 12, offset = 0 } = {}) {
  const set = state.activeSet
  if (!set) {
    return {
      active: null, total: 0, labeled: 0, remaining: 0, progress: 0, offset: 0, range: null,
      labelOptions: LABEL_OPTIONS,
      message: '还没有人工基准集。点击“创建基准集”从真实收藏夹评论中抽取 60 条盲评样本。',
      queue: [],
    }
  }
  const samples = sampleMap(learning)
  const labeled = set.keys.filter(key => labelOf(samples.get(key)))
  const remainingKeys = set.keys.filter(key => !labelOf(samples.get(key)))
  // 盲评队列：只给原文与必要视频语境；不返回模型标签、置信度、证据、作者信息。
  // offset 让“跳过”能翻到下一条：跳过的样本不写标签，仍留在 remaining 里，靠偏移量避开。
  const pageSize = Math.max(1, num(limit, 12))
  const start = remainingKeys.length ? Math.max(0, Math.min(num(offset, 0), remainingKeys.length - 1)) : 0
  const queue = remainingKeys.slice(start, start + pageSize).map(key => {
    const sample = samples.get(key)
    if (!sample) return { key, missing: true, text: '', videoTitle: '', position: set.keys.indexOf(key) + 1 }
    return {
      key,
      position: set.keys.indexOf(key) + 1,
      text: sample.text,
      videoTitle: sample.videoTitle || '',
      videoDescription: sample.videoDescription || '',
      videoHashtags: Array.isArray(sample.videoHashtags) ? sample.videoHashtags.slice(0, 8) : [],
      videoTopic: sample.videoTopic || '',
      videoCategory: sample.videoCategory || '',
      commentAt: sample.createdAt || null,
      replies: (sample.replies || []).slice(0, 3).map(reply => String(reply?.text || reply || '').slice(0, 120)),
    }
  })
  return {
    active: {
      id: set.id, createdAt: set.createdAt, status: labeled.length === set.keys.length ? 'completed' : set.status,
      requestedSize: set.requestedSize, size: set.size, quotas: set.quotas, quotaActual: set.quotaActual, shortage: set.shortage, note: set.note,
    },
    total: set.keys.length,
    labeled: labeled.length,
    remaining: remainingKeys.length,
    offset: start,
    range: { from: remainingKeys.length ? start + 1 : 0, to: start + queue.length, of: set.keys.length },
    progress: rate(labeled.length, set.keys.length),
    labelOptions: LABEL_OPTIONS,
    message: labeled.length === set.keys.length ? '基准集已全部标注，可在下方查看评估结果。' : '盲评中：页面不会显示模型原始分类，请按评论原文判断。',
    queue,
  }
}

function evaluateBenchmark(state, learning = {}, library = {}, { candidateUserIds = [] } = {}) {
  const set = state.activeSet
  const samples = sampleMap(learning)
  const rows = set ? set.keys.map(key => (labelOf(samples.get(key)) ? rowOf(samples.get(key)) : null)).filter(Boolean) : []
  const metrics = metricsOfRows(rows)
  const leaks = rejectionLeaks(learning, library, candidateUserIds)
  return {
    scope: 'benchmark',
    activeSet: set ? { id: set.id, createdAt: set.createdAt, size: set.size, labeled: metrics.total, remaining: set.keys.length - metrics.total } : null,
    ...metrics,
    rejectionProtection: leaks,
    targets: targetsOf(metrics, leaks),
    caveat: '只有基准集内的人工盲标计入本评估；历史非盲标注不计入。',
  }
}

// 历史已有人工标注的阶段性参考：不是盲评，不能替代基准集结论。
function evaluateHumanLabels(learning = {}, library = {}, { candidateUserIds = [] } = {}) {
  const rows = (learning.samples || [])
    .filter(sample => !sample.excluded && labelOf(sample))
    .map(sample => rowOf(sample))
    .filter(Boolean)
  const metrics = metricsOfRows(rows)
  const leaks = rejectionLeaks(learning, library, candidateUserIds)
  return {
    scope: 'all_human_labels',
    ...metrics,
    rejectionProtection: leaks,
    targets: targetsOf(metrics, leaks),
    caveat: '这是全部历史人工标注（可能非盲），只作阶段性参考；正式结论以基准集盲评结果为准。',
  }
}

module.exports = {
  VERSION, DEFAULT_SIZE, DEFAULT_QUOTAS, LABEL_OPTIONS, UNCLASSIFIED,
  emptyState, normalizeState, normalizeSet, BenchmarkStore,
  favoritesVideoIds, pickEvenly, eligibleSamples, createBenchmarkSet,
  buildView, metricsOfRows, rejectionLeaks, evaluateBenchmark, evaluateHumanLabels,
}
