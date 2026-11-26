// P2-09 评论学习：人工标注样本库、分类器版本、相似案例检索、评估指标。
// 设计原则：
// 1) 人工标签（human）只由 annotate() 写入，任何模型/规则运行只能写 ai 与 predictions，绝不覆盖人工结论；
// 2) 训练案例与独立评估集互斥，按视频划分，避免同一视频的评论同时进入训练与测试；
// 3) 只读本地文件，不联网、不发送消息、不改 state.json。
const fs = require('node:fs')
const { writeFileAtomicSync, copyFileRobustSync } = require('../atomic-write.cjs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { COMMENT_INTENTS, CANDIDATE_INTENTS } = require('./library-classifier.cjs')

const LEARNING_VERSION = 1
const PROMPT_VERSION = 'comment-v1'
const MAX_SAMPLES = 20000
const MAX_PREDICTIONS = 12
const MAX_HISTORY = 20
const MAX_VERSIONS = 50
const LIMITS = { text: 2000, reason: 300, topic: 60, title: 300, note: 500, author: 80, id: 100, url: 500 }
const SCHEMES = { rule: '原始规则分类', model: '规则 + 豆包分类', model_cases: '规则 + 豆包 + 相似案例' }

const sha = value => createHash('sha256').update(String(value)).digest('hex')
const now = () => new Date().toISOString()
const clean = (value, limit) => String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, limit)
const nullable = (value, limit) => { const text = clean(value, limit); return text || null }
const num = value => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : null)

function emptySample() {
  return {
    key: '', text: '', authorId: null, authorName: null,
    // 评论本身不含性别；只有读取作者公开主页后才写入 female/male，绝不从昵称或头像猜测。
    authorGender: null, genderCheckedAt: null,
    videoId: null, videoUrl: null, videoTitle: null, videoDescription: null,
    videoHashtags: [], videoTopic: null, videoCategory: null,
    replies: [], note: null,
    createdAt: null, updatedAt: null,
    ai: null, predictions: [],
    human: null, annotationHistory: [],
    useForTraining: false, independentEval: false, split: 'unassigned',
    // P2-10：人工排除的样本不进入待复核、训练案例与评估。
    excluded: false, excludeReason: null,
  }
}

function normalizePrediction(value) {
  const source = value && typeof value === 'object' ? value : {}
  const intent = COMMENT_INTENTS.includes(source.intent) ? source.intent : 'UNKNOWN'
  const scheme = ['rule', 'model', 'model_cases'].includes(source.scheme) ? source.scheme : 'model'
  const confidence = num(source.confidence)
  const evidence = Array.isArray(source.evidence) ? source.evidence.map(item => clean(item, 120)).filter(Boolean).slice(0, 4) : []
  return {
    intent, scheme, confidence, evidence,
    reason: clean(source.reason, LIMITS.reason),
    model: nullable(source.model, 100),
    provider: nullable(source.provider, 60),
    promptVersion: nullable(source.promptVersion, 40),
    classifierVersion: nullable(source.classifierVersion, 60),
    runId: nullable(source.runId, 60),
    caseKeys: Array.isArray(source.caseKeys) ? source.caseKeys.slice(0, 6) : [],
    needsReview: source.needsReview === true || intent === 'UNKNOWN' || (confidence !== null && confidence < 0.6),
    usage: source.usage && typeof source.usage === 'object' ? { ...source.usage } : null,
    at: nullable(source.at, 40) || now(),
  }
}

function normalizeHuman(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source || !COMMENT_INTENTS.includes(source.intent)) return null
  const origin = ['p2-08-manual', 'assistant-review'].includes(source.source) ? source.source : 'user'
  return {
    intent: source.intent, confidence: 1,
    reason: clean(source.reason, LIMITS.reason) || '人工确认',
    source: origin,
    at: nullable(source.at, 40) || now(),
  }
}

function normalizeSample(input) {
  const source = input && typeof input === 'object' ? input : {}
  const text = nullable(source.text, LIMITS.text)
  if (!text) return null
  const base = emptySample()
  const predictions = (Array.isArray(source.predictions) ? source.predictions : [])
    .map(normalizePrediction).slice(-MAX_PREDICTIONS)
  const human = normalizeHuman(source.human)
  const annotations = (Array.isArray(source.annotationHistory) ? source.annotationHistory : [])
    .map(normalizeHuman).filter(Boolean).slice(-MAX_HISTORY)
  const output = {
    ...base,
    key: clean(source.key, 200),
    text,
    authorId: nullable(source.authorId, LIMITS.id),
    authorName: nullable(source.authorName, LIMITS.author),
    authorGender: ['female', 'male'].includes(source.authorGender) ? source.authorGender : null,
    genderCheckedAt: nullable(source.genderCheckedAt, 40),
    videoId: nullable(source.videoId, LIMITS.id),
    videoUrl: nullable(source.videoUrl, LIMITS.url),
    videoTitle: nullable(source.videoTitle, LIMITS.title),
    videoDescription: nullable(source.videoDescription, 800),
    videoHashtags: (Array.isArray(source.videoHashtags) ? source.videoHashtags : []).map(tag => clean(tag, 40)).filter(Boolean).slice(0, 20),
    videoTopic: nullable(source.videoTopic, LIMITS.topic),
    videoCategory: nullable(source.videoCategory, 40),
    replies: (Array.isArray(source.replies) ? source.replies : []).map(item => clean(item, 300)).filter(Boolean).slice(0, 8),
    note: nullable(source.note, LIMITS.note),
    createdAt: nullable(source.createdAt, 40) || now(),
    updatedAt: nullable(source.updatedAt, 40),
    ai: source.ai ? normalizePrediction(source.ai) : (predictions.length ? predictions[predictions.length - 1] : null),
    predictions,
    human,
    annotationHistory: annotations,
    useForTraining: source.useForTraining === true,
    independentEval: source.independentEval === true,
    split: ['train', 'eval', 'unassigned'].includes(source.split) ? source.split : 'unassigned',
    excluded: source.excluded === true,
    excludeReason: nullable(source.excludeReason, LIMITS.reason),
  }
  if (!output.key) output.key = `ext:${output.videoId || 'novideo'}:${sha(`${output.authorId || output.authorName || ''}\u0000${output.text}`).slice(0, 24)}`
  // 人工与拆分状态必须自洽：独立评估集不能同时作为训练案例；排除样本不参与任何数据集。
  if (output.excluded) { output.useForTraining = false; output.independentEval = false; output.split = 'unassigned' }
  else if (output.independentEval) { output.useForTraining = false; output.split = 'eval' }
  else if (output.useForTraining) output.split = 'train'
  else output.split = 'unassigned'
  return output
}

function defaults() {
  return {
    version: LEARNING_VERSION,
    createdAt: now(),
    updatedAt: null,
    samples: [],
    classifierVersions: [],
    activeVersion: null,
    settings: { defaultTopK: 3, autoNeedsReviewBelow: 0.6 },
    lastRun: null,
  }
}

function normalizeLearning(raw) {
  const base = defaults()
  const source = raw && typeof raw === 'object' ? raw : {}
  const samples = [], seen = new Set()
  for (const item of Array.isArray(source.samples) ? source.samples : []) {
    const sample = normalizeSample(item)
    if (sample && !seen.has(sample.key)) { seen.add(sample.key); samples.push(sample) }
  }
  const versions = (Array.isArray(source.classifierVersions) ? source.classifierVersions : [])
    .filter(item => item && typeof item === 'object' && item.id)
    .map(item => ({
      id: clean(item.id, 60),
      promptVersion: nullable(item.promptVersion, 40) || PROMPT_VERSION,
      at: nullable(item.at, 40) || now(),
      config: { useCases: item.config?.useCases === true, topK: Number(item.config?.topK) || base.settings.defaultTopK },
      sampleCount: Number(item.sampleCount) || 0,
      note: clean(item.note, 200),
      active: item.active === true,
    }))
    .slice(-MAX_VERSIONS)
  return {
    ...base,
    ...source,
    version: LEARNING_VERSION,
    samples: samples.slice(0, MAX_SAMPLES),
    classifierVersions: versions,
    activeVersion: nullable(source.activeVersion, 60),
    settings: { ...base.settings, ...(source.settings && typeof source.settings === 'object' ? source.settings : {}) },
    lastRun: source.lastRun && typeof source.lastRun === 'object' ? source.lastRun : null,
  }
}

// ── 相似案例检索：字符二元组 Jaccard + 同视频加权，不建向量库 ─────────────────
function bigrams(value) {
  const text = String(value || '').replace(/\s+/g, ' ').toLowerCase()
  const set = new Set()
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2))
  if (!set.size && text) set.add(text)
  return set
}

function similarity(left, right) {
  const a = bigrams(left), b = bigrams(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

// 只从“人工已确认且标记为训练案例”的样本里取，评估集永远不进入案例池。
function trainingCases(learning) {
  return (learning.samples || []).filter(sample => sample.human && sample.useForTraining && !sample.independentEval && !sample.excluded)
}

function retrieveCases(text, cases, { k = 3, excludeKeys = [], videoId = null, minScore = 0.04 } = {}) {
  const exclude = new Set(excludeKeys)
  const scored = []
  for (const sample of cases || []) {
    if (!sample.human || exclude.has(sample.key)) continue
    const base = similarity(text, sample.text)
    // 同一视频的案例更贴近语境，但相似度仍然必须过线，避免只按视频硬凑。
    const score = base + (videoId && sample.videoId === videoId ? 0.12 : 0)
    if (score < minScore) continue
    scored.push({
      key: sample.key, text: sample.text, intent: sample.human.intent,
      reason: sample.human.reason, videoTitle: sample.videoTitle || null,
      videoId: sample.videoId || null, score: Number(score.toFixed(3)),
    })
  }
  scored.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
  return scored.slice(0, Math.max(0, k))
}

function describeCase(item) {
  return `[${item.intent}] ${String(item.text || '').slice(0, 120)} —— 人工依据：${item.reason || '未填写'}`
}

// ── 学习库存储 ────────────────────────────────────────────────────────────
class LearningStore {
  constructor(dir) {
    this.dir = dir
    this.filePath = path.join(dir, 'library', 'learning.json')
  }

  read() {
    try {
      if (!fs.existsSync(this.filePath)) return defaults()
      return normalizeLearning(JSON.parse(fs.readFileSync(this.filePath, 'utf8')))
    } catch {
      for (const name of ['learning.prev.json', 'learning.prev2.json']) {
        try {
          const file = path.join(path.dirname(this.filePath), name)
          if (fs.existsSync(file)) return normalizeLearning(JSON.parse(fs.readFileSync(file, 'utf8')))
        } catch { /* 继续尝试下一份备份 */ }
      }
      return defaults()
    }
  }

  save(learning) {
    const normalized = normalizeLearning({ ...learning, updatedAt: now() })
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    try {
      const prev = path.join(path.dirname(this.filePath), 'learning.prev.json')
      const prev2 = path.join(path.dirname(this.filePath), 'learning.prev2.json')
      if (fs.existsSync(prev)) copyFileRobustSync(prev, prev2)
      if (fs.existsSync(this.filePath)) copyFileRobustSync(this.filePath, prev)
    } catch { /* 备份失败不阻塞写入 */ }
    // P2-15：Windows 上 rename 覆盖可能被短暂占用（EPERM），统一走带重试的原子写入。
    writeFileAtomicSync(this.filePath, JSON.stringify(normalized, null, 2))
    return normalized
  }

  // 把素材库里的评论同步成学习样本；已存在时只刷新视频背景与原文，绝不触碰人工标签。
  syncLibrary(library = {}) {
    const learning = this.read()
    const byKey = new Map(learning.samples.map(sample => [sample.key, sample]))
    const videos = Array.isArray(library.videos) ? library.videos : []
    const videoOf = comment => videos.find(video => video.video_id && video.video_id === comment.video_id)
      || videos.find(video => video.video_url && video.video_url === comment.video_url) || null
    let added = 0, updated = 0
    for (const comment of Array.isArray(library.comments) ? library.comments : []) {
      const video = videoOf(comment)
      const context = {
        text: clean(comment.text, LIMITS.text),
        authorId: nullable(comment.author_id, LIMITS.id),
        authorName: nullable(comment.author_name, LIMITS.author),
        videoId: nullable(comment.video_id, LIMITS.id),
        videoUrl: nullable(comment.video_url, LIMITS.url),
        videoTitle: nullable(video?.title, LIMITS.title),
        videoDescription: nullable(video?.description, 800),
        videoHashtags: (video?.hashtags || []).slice(0, 20),
        videoTopic: nullable(video?.topic, LIMITS.topic),
        videoCategory: nullable(video?.classification?.category, 40),
      }
      const existing = byKey.get(comment.key)
      if (existing) {
        Object.assign(existing, context, { updatedAt: now() })
        updated += 1
        continue
      }
      const sample = normalizeSample({
        key: comment.key, ...context, createdAt: comment.imported_at || now(), updatedAt: now(),
        ai: comment.classification?.intent ? {
          intent: comment.classification.intent, scheme: comment.classification.model === 'rule' ? 'rule' : 'model',
          confidence: comment.classification.confidence, evidence: comment.classification.evidence,
          reason: comment.classification.reason, model: comment.classification.model,
          at: comment.classification.classifiedAt,
        } : null,
        predictions: comment.classification?.intent ? [{
          intent: comment.classification.intent, scheme: comment.classification.model === 'rule' ? 'rule' : 'model',
          confidence: comment.classification.confidence, evidence: comment.classification.evidence,
          reason: comment.classification.reason, model: comment.classification.model,
          at: comment.classification.classifiedAt,
        }] : [],
        human: comment.classification?.reviewedByUser && comment.classification?.intent
          ? { intent: comment.classification.intent, reason: comment.classification.reason || '素材库人工复核', source: 'user', at: comment.classification.classifiedAt }
          : null,
      })
      if (!sample) continue
      byKey.set(sample.key, sample)
      learning.samples.push(sample)
      added += 1
    }
    if (added || updated) this.save(learning)
    return { added, updated, learning: this.read() }
  }

  // 写入单条外部真实评论（例如从已导入的 discovery 数据整理而来）。不做任何推断。
  upsertSample(input = {}) {
    const learning = this.read()
    const sample = normalizeSample({ ...input, updatedAt: now() })
    if (!sample) throw new Error('评论正文为空，无法建立样本')
    const index = learning.samples.findIndex(item => item.key === sample.key)
    if (index >= 0) {
      const previous = learning.samples[index]
      // 保留已有预测与人工标签，只补背景信息。
      learning.samples[index] = normalizeSample({
        ...previous, ...sample,
        ai: sample.ai || previous.ai,
        predictions: previous.predictions,
        human: previous.human,
        annotationHistory: previous.annotationHistory,
      })
    } else {
      learning.samples.push(sample)
    }
    this.save(learning)
    return this.read().samples.find(item => item.key === sample.key)
  }

  // 人工标注：唯一允许写 human 的入口。模型运行永远不经过这里。
  annotate(key, { intent, reason = '', useForTraining, independentEval, source = 'user' } = {}) {
    if (!COMMENT_INTENTS.includes(intent)) throw new Error(`不支持的人工标签：${intent}`)
    const learning = this.read()
    const sample = learning.samples.find(item => item.key === key)
    if (!sample) throw new Error('找不到该评论样本')
    const at = now()
    const human = { intent, confidence: 1, reason: clean(reason, LIMITS.reason) || '人工确认', source: ['p2-08-manual', 'assistant-review'].includes(source) ? source : 'user', at }
    sample.human = human
    sample.annotationHistory = [...sample.annotationHistory, human].slice(-MAX_HISTORY)
    sample.excluded = false; sample.excludeReason = null
    if (typeof useForTraining === 'boolean') sample.useForTraining = useForTraining
    if (typeof independentEval === 'boolean') {
      sample.independentEval = independentEval
      if (independentEval) sample.useForTraining = false
    }
    sample.split = sample.independentEval ? 'eval' : sample.useForTraining ? 'train' : 'unassigned'
    // 人工结论一旦落库，就要从“待标注”里消失，不再被模型结果打扰。
    sample.updatedAt = at
    this.save(learning)
    return sample
  }

  annotateMany(keys = [], patch = {}) {
    const learning = this.read()
    let changed = 0
    for (const key of keys) {
      const sample = learning.samples.find(item => item.key === key)
      if (!sample) continue
      const intent = patch.intent || sample.ai?.intent
      if (!COMMENT_INTENTS.includes(intent)) continue
      const at = now()
      const human = { intent, confidence: 1, reason: clean(patch.reason, LIMITS.reason) || '批量确认', source: patch.source || 'user', at }
      sample.human = human
      sample.annotationHistory = [...sample.annotationHistory, human].slice(-MAX_HISTORY)
      sample.excluded = false; sample.excludeReason = null
      if (typeof patch.useForTraining === 'boolean') sample.useForTraining = patch.useForTraining
      if (typeof patch.independentEval === 'boolean') {
        sample.independentEval = patch.independentEval
        if (patch.independentEval) sample.useForTraining = false
      }
      sample.split = sample.independentEval ? 'eval' : sample.useForTraining ? 'train' : 'unassigned'
      sample.updatedAt = at
      changed += 1
    }
    this.save(learning)
    return changed
  }

  // 批量写入作者公开性别（female/male），只更新同一 authorId 的样本。
  setAuthorGenders(map = {}) {
    const genders = Object.fromEntries(Object.entries(map || {}).filter(([id, gender]) => /^[A-Za-z0-9_-]{1,100}$/.test(id) && ['female', 'male'].includes(gender)))
    if (!Object.keys(genders).length) return 0
    const learning = this.read()
    let changed = 0
    for (const sample of learning.samples) {
      const gender = genders[sample.authorId]
      if (!gender || sample.authorGender === gender) continue
      sample.authorGender = gender
      sample.genderCheckedAt = now()
      sample.updatedAt = now()
      changed += 1
    }
    if (changed) this.save(learning)
    return changed
  }
  // 一键清空待审列表：批量排除所有未判断样本，只写 excluded 标记，
  // 不删除原始评论，也不影响已经人工标注过的样本。
  excludeMany(keys = [], { reason = '' } = {}) {
    const wanted = new Set(keys)
    if (!wanted.size) return 0
    const learning = this.read()
    let changed = 0
    for (const sample of learning.samples) {
      if (!wanted.has(sample.key) || sample.excluded) continue
      sample.excluded = true
      sample.excludeReason = clean(reason, LIMITS.reason) || '人工一键清空'
      sample.useForTraining = false
      sample.independentEval = false
      sample.split = 'unassigned'
      sample.updatedAt = now()
      changed += 1
    }
    if (changed) this.save(learning)
    return changed
  }
  // P2-10：人工排除样本。只写 excluded 标记，不动 human；排除后的样本不再出现在待复核/训练/评估。
  setExcluded(key, { excluded = true, reason = '' } = {}) {
    const learning = this.read()
    const sample = learning.samples.find(item => item.key === key)
    if (!sample) throw new Error('找不到该评论样本')
    sample.excluded = excluded === true
    sample.excludeReason = sample.excluded ? (clean(reason, LIMITS.reason) || '人工排除') : null
    if (sample.excluded) { sample.useForTraining = false; sample.independentEval = false; sample.split = 'unassigned' }
    sample.updatedAt = now()
    this.save(learning)
    return sample
  }

  // 记录一次模型/规则预测。human 字段在这里是只读的：写进来就报错，避免覆盖人工标签。
  recordPrediction(key, prediction = {}) {
    if (prediction.human !== undefined || prediction.annotationHistory !== undefined) {
      throw new Error('模型运行不能写入人工标签')
    }
    const learning = this.read()
    const sample = learning.samples.find(item => item.key === key)
    if (!sample) return null
    const entry = normalizePrediction(prediction)
    const previous = sample.predictions || []
    sample.predictions = [...previous, entry].slice(-MAX_PREDICTIONS)
    sample.ai = entry
    sample.updatedAt = now()
    this.save(learning)
    return entry
  }

  // A classification batch is persisted once; human annotations are read fresh and never replaced.
  recordPredictions(entries = []) {
    for (const { prediction = {} } of entries) {
      if (prediction.human !== undefined || prediction.annotationHistory !== undefined) throw new Error('模型运行不能写入人工标签')
    }
    const learning = this.read(), samples = new Map(learning.samples.map(sample => [sample.key, sample]))
    let changed = 0
    for (const { key, prediction = {} } of entries) {
      const sample = samples.get(key)
      if (!sample) continue
      const entry = normalizePrediction(prediction)
      sample.predictions = [...(sample.predictions || []), entry].slice(-MAX_PREDICTIONS)
      sample.ai = entry
      sample.updatedAt = now()
      changed++
    }
    if (changed) this.save(learning)
    return changed
  }

  // 按视频划分训练/评估：同一视频的评论只会落在同一边，避免数据泄漏。
  assignSplits({ evalVideoIds = null } = {}) {
    const learning = this.read()
    const videos = [...new Set(learning.samples.map(sample => sample.videoId || 'unknown'))].sort()
    let evalVideos
    if (Array.isArray(evalVideoIds) && evalVideoIds.length) {
      evalVideos = new Set(evalVideoIds.map(String))
    } else if (videos.length <= 1) {
      evalVideos = new Set()
    } else {
      // 确定性：排序后隔一个取一个作为独立评估视频，至少留 1 个评估、1 个训练。
      evalVideos = new Set(videos.filter((_, index) => index % 2 === 1))
      if (!evalVideos.size) evalVideos.add(videos[videos.length - 1])
      if (evalVideos.size === videos.length) evalVideos.delete(videos[0])
    }
    let train = 0, evalCount = 0
    for (const sample of learning.samples) {
      if (!sample.human) { sample.split = 'unassigned'; sample.independentEval = false; sample.useForTraining = false; continue }
      const isEval = evalVideos.has(sample.videoId || 'unknown')
      sample.independentEval = isEval
      sample.useForTraining = !isEval
      sample.split = isEval ? 'eval' : 'train'
      if (isEval) evalCount += 1; else train += 1
    }
    this.save(learning)
    return { evalVideos: [...evalVideos], train, eval: evalCount, videos }
  }

  createVersion({ note = '', config = {}, sampleCount = null } = {}) {
    const learning = this.read()
    const id = `clf_${Date.now().toString(36)}_${sha(String(Math.random())).slice(0, 6)}`
    const version = {
      id, promptVersion: PROMPT_VERSION, at: now(),
      config: { useCases: config.useCases === true, topK: Math.max(1, Math.min(5, Number(config.topK) || learning.settings.defaultTopK)) },
      sampleCount: sampleCount === null ? trainingCases(learning).length : Number(sampleCount) || 0,
      note: clean(note, 200), active: true,
    }
    learning.classifierVersions.forEach(item => { item.active = false })
    learning.classifierVersions = [...learning.classifierVersions, version].slice(-MAX_VERSIONS)
    learning.activeVersion = id
    this.save(learning)
    return version
  }

  activeClassifier() {
    const learning = this.read()
    const active = learning.classifierVersions.find(item => item.id === learning.activeVersion)
      || learning.classifierVersions[learning.classifierVersions.length - 1] || null
    return active || { id: 'builtin', promptVersion: PROMPT_VERSION, at: null, config: { useCases: true, topK: learning.settings.defaultTopK }, sampleCount: 0, note: '内置默认', active: true }
  }

  activateVersion(id) {
    const learning = this.read()
    const target = learning.classifierVersions.find(item => item.id === id)
    if (!target) throw new Error('找不到该分类器版本')
    learning.classifierVersions.forEach(item => { item.active = item.id === id })
    learning.activeVersion = id
    this.save(learning)
    return target
  }

  // 回滚：回到当前版本之前最近的一个非当前版本；当前已是最早版本时退回最新版本。
  rollback() {
    const learning = this.read()
    const versions = learning.classifierVersions
    if (versions.length < 2) throw new Error('没有可回滚的历史版本')
    const currentIndex = versions.findIndex(item => item.id === learning.activeVersion)
    const target = currentIndex > 0 ? versions[currentIndex - 1] : versions[versions.length - 1]
    return this.activateVersion(target.id)
  }

  replace(learning) { return this.save(learning) }
}

// ── 评估指标 ──────────────────────────────────────────────────────────────
const POSITIVE_INTENTS = new Set(CANDIDATE_INTENTS)

function metricsOf(rows = []) {
  const total = rows.length
  const abstained = rows.filter(row => !row.actual || row.actual === 'UNKNOWN')
  const decided = rows.filter(row => row.actual && row.actual !== 'UNKNOWN')
  const correct = decided.filter(row => row.actual === row.expected)
  const positives = rows.filter(row => POSITIVE_INTENTS.has(row.expected))
  const predictedPositives = rows.filter(row => POSITIVE_INTENTS.has(row.actual))
  const truePositives = positives.filter(row => POSITIVE_INTENTS.has(row.actual))
  const falsePositives = rows.filter(row => POSITIVE_INTENTS.has(row.actual) && !POSITIVE_INTENTS.has(row.expected))
  const refusals = rows.filter(row => row.expected === 'DO_NOT_CONTACT')
  const refusalHit = refusals.filter(row => row.actual === 'DO_NOT_CONTACT')
  const refusalFalse = rows.filter(row => row.actual === 'DO_NOT_CONTACT' && row.expected !== 'DO_NOT_CONTACT')
  const rate = (value, base) => (base ? Number((value / base).toFixed(4)) : null)
  return {
    total,
    decided: decided.length,
    abstained: abstained.length,
    abstainRate: rate(abstained.length, total),
    correct: correct.length,
    accuracyOnDecided: rate(correct.length, decided.length),
    accuracyOverall: rate(correct.length, total),
    positives: positives.length,
    recall: rate(truePositives.length, positives.length),
    precision: rate(truePositives.length, predictedPositives.length),
    falsePositive: falsePositives.length,
    missedPositive: positives.length - truePositives.length,
    refusalTotal: refusals.length,
    refusalRecall: rate(refusalHit.length, refusals.length),
    refusalFalsePositive: refusalFalse.length,
  }
}

// 按方案汇总已存预测；eval 只统计独立评估集（无泄漏），all 统计全部已人工标注样本。
// 指定 runId 时只看该轮运行的预测，避免多轮结果互相覆盖。
function evaluateLearning(learning, { runId = null } = {}) {
  const samples = (learning.samples || []).filter(sample => sample.human && !sample.excluded)
  const pick = (sample, scheme) => {
    const list = [...(sample.predictions || [])].reverse().filter(item => (!runId || item.runId === runId) && item.scheme === scheme)
    return list[0] || null
  }
  const build = predicate => {
    const scopes = { eval: samples.filter(sample => sample.independentEval), all: samples }
    const out = {}
    for (const [name, list] of Object.entries(scopes)) {
      out[name] = {}
      for (const scheme of Object.keys(SCHEMES)) {
        out[name][scheme] = metricsOf(list.filter(predicate).map(sample => {
          const last = pick(sample, scheme)
          return {
            key: sample.key, videoId: sample.videoId,
            expected: sample.human.intent,
            actual: last?.intent || 'UNKNOWN',
            confidence: last?.confidence ?? null,
            hasPrediction: Boolean(last),
          }
        }))
      }
    }
    return out
  }
  const result = build(() => true)
  const withPrediction = build(sample => (sample.predictions || []).length > 0)
  return { scopes: result, onlyPredicted: withPrediction, sampleCount: samples.length, evalCount: samples.filter(item => item.independentEval).length }
}

// ── 视图 ──────────────────────────────────────────────────────────────────
function uncertaintyOf(sample) {
  if (sample.human) return 1000
  if (!sample.ai) return 0
  const confidence = sample.ai.confidence === null ? 0.5 : sample.ai.confidence
  return sample.ai.needsReview ? Math.max(0, confidence - 0.5) : confidence
}

function viewOfLearning(learning, { limit = 40, offset = 0, query = '', label = 'all' } = {}) {
  const samples = learning.samples || []
  const annotated = samples.filter(sample => sample.human && !sample.excluded)
  const pending = samples.filter(sample => !sample.human && !sample.excluded)
  const byHuman = {}, byAi = {}
  for (const sample of annotated) byHuman[sample.human.intent] = (byHuman[sample.human.intent] || 0) + 1
  for (const sample of samples) { const key = sample.ai?.intent || 'NONE'; byAi[key] = (byAi[key] || 0) + 1 }
  const ordered = [...pending]
    .sort((left, right) => uncertaintyOf(left) - uncertaintyOf(right) || left.key.localeCompare(right.key))
    .slice(0, limit)
  const needle = String(query || '').trim().toLowerCase().slice(0, 200)
  const pageRows = samples.filter(sample => !sample.excluded && (!needle || [sample.text,sample.authorName,sample.videoTitle].some(x => String(x || '').toLowerCase().includes(needle)))
    && (label === 'all' || label === 'annotated' && sample.human || label === 'pending' && !sample.human))
    .sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.key.localeCompare(b.key))
  const pageSize = Math.max(1, Math.min(40, Math.floor(Number(limit) || 20)))
  const pageOffset = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), Math.max(0, Math.floor((pageRows.length - 1) / pageSize) * pageSize))
  const active = learning.classifierVersions.find(item => item.id === learning.activeVersion) || null
  return {
    stats: {
      samples: samples.length,
      annotated: annotated.length,
      pending: pending.length,
      needsReview: pending.filter(sample => sample.ai?.needsReview || !sample.ai).length,
      excluded: samples.filter(sample => sample.excluded).length,
      trainCases: samples.filter(sample => sample.human && sample.useForTraining && !sample.independentEval && !sample.excluded).length,
      evalSamples: samples.filter(sample => sample.human && sample.independentEval && !sample.excluded).length,
      evalVideos: [...new Set(samples.filter(sample => sample.independentEval && !sample.excluded).map(sample => sample.videoId || 'unknown'))],
      byHuman, byAi,
    },
    page: { rows: pageRows.slice(pageOffset, pageOffset + pageSize), total: pageRows.length, offset: pageOffset, limit: pageSize },
    pending: ordered,
    annotated: [...annotated].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))).slice(0, limit),
    versions: learning.classifierVersions.slice(-5).reverse(),
    activeVersion: active,
    activeClassifier: new LessonActiveView(learning),
    lastRun: learning.lastRun,
    updatedAt: learning.updatedAt,
    filePath: null,
  }
}

// 仅用于视图里展示当前生效分类器；避免在 viewOfLearning 里重复读盘。
function LessonActiveView(learning) {
  const active = learning.classifierVersions.find(item => item.id === learning.activeVersion)
    || learning.classifierVersions[learning.classifierVersions.length - 1]
  return active || { id: 'builtin', promptVersion: PROMPT_VERSION, config: { useCases: true, topK: learning.settings.defaultTopK }, note: '内置默认', sampleCount: 0 }
}

module.exports = {
  LEARNING_VERSION, PROMPT_VERSION, SCHEMES, LIMITS, POSITIVE_INTENTS,
  defaults, normalizeLearning, normalizeSample, normalizePrediction,
  bigrams, similarity, retrieveCases, describeCase,
  trainingCases, metricsOf, evaluateLearning, uncertaintyOf, viewOfLearning,
  LearningStore,
}
