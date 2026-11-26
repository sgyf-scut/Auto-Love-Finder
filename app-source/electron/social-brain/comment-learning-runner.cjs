// P2-09 评论学习运行器：把规则层、豆包分类、相似案例串起来，并把结果写进学习库。
// 只写 learning.json 的 ai/predictions；人工标签永远不会被这里覆盖。
const { ruleComment, COMMENT_INTENTS } = require('./library-classifier.cjs')
const { classifyComments, composeScheme, consentOf, PROMPT_VERSION } = require('./comment-classifier.cjs')
const { trainingCases, retrieveCases, SCHEMES } = require('./comment-learning.cjs')

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()

function videoOfSample(sample) {
  return {
    video_id: sample.videoId,
    video_url: sample.videoUrl,
    title: sample.videoTitle,
    description: sample.videoDescription,
    hashtags: sample.videoHashtags || [],
    topic: sample.videoTopic,
    classification: { category: sample.videoCategory || null },
  }
}

function commentOfSample(sample) {
  return {
    key: sample.key,
    text: sample.text,
    video_id: sample.videoId,
    video_url: sample.videoUrl,
    author_id: sample.authorId,
    author_name: sample.authorName,
  }
}

function selectSamples(learning, { scope = 'pending', keys = null, minConfidence = null } = {}) {
  let samples = learning.samples || []
  if (Array.isArray(keys) && keys.length) {
    const wanted = new Set(keys)
    samples = samples.filter(sample => wanted.has(sample.key))
  }
  if (scope === 'pending') return samples.filter(sample => !sample.human)
  if (scope === 'annotated') return samples.filter(sample => sample.human)
  return samples
}

/**
 * 运行一轮评论学习。
 * mode:
 *   'rule'       只跑规则层（不调用模型，用于对照基线）
 *   'model'      规则优先，规则弃权才调用豆包
 *   'model_cases' 同上，但把人工确认的训练案例注入 Prompt
 */
async function runCommentLearning({
  learningStore, libraryStore = null, ai = null,
  mode = 'model', scope = 'pending', keys = null,
  maxCalls = 6, batchSize = 6, topK = null, force = false,
  onCall = null, recallFirst = false,
} = {}) {
  if (!learningStore) throw new Error('缺少学习库')
  if (libraryStore) learningStore.syncLibrary(libraryStore.read())
  const learning = learningStore.read()
  const classifier = learningStore.activeClassifier()
  const k = Math.max(1, Math.min(5, Number(topK) || classifier.config?.topK || 3))
  const selected = selectSamples(learning, { scope, keys })
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const task = {
    runId, mode, scope, classifierVersion: classifier.id, promptVersion: PROMPT_VERSION,
    startedAt: new Date().toISOString(), total: selected.length, processed: 0,
    aiCalls: 0, tokens: 0, errors: [], rulesDecided: 0,
  }

  const items = []
  const ruleResults = new Map()
  const examples = recallFirst && mode === 'model_cases' ? trainingCases(learning) : null
  const pendingPredictions = []
  const recordPrediction = (key, prediction) => {
    if (recallFirst && learningStore.recordPredictions) pendingPredictions.push({ key, prediction })
    else learningStore.recordPrediction(key, prediction)
  }
  const flushPredictions = () => {
    if (pendingPredictions.length) learningStore.recordPredictions(pendingPredictions.splice(0))
  }
  for (const sample of selected) {
    const video = videoOfSample(sample)
    if (recallFirst && sample.human?.intent) {
      recordPrediction(sample.key, { ...sample.human, scheme: 'model_cases', confidence: 1, model: 'human', provider: 'human', runId, reason: sample.human.reason || '采用人工标注', needsReview: false })
      task.processed += 1; continue
    }
    let rule = ruleComment(commentOfSample(sample), video)
    if (recallFirst && rule) {
      const text = sample.text || ''
      const negative = rule.intent === 'DO_NOT_CONTACT'
        && /^(?:请)?(?:不要私信|别私信|勿扰|请勿打扰|不要打扰|别打扰|不加好友|不要加我|别加我|不想认识|别来找我|不要联系我|别联系我)[！!。\s]*$/.test(text)
        || rule.intent === 'ADVERTISEMENT' && /(?:代购|返现|引流|刷屏|私信.{0,4}(?:领取|购买|咨询)|(?:优惠|课程).{0,8}(?:购买|报名|领取))/.test(text)
      const positive = /^(?:私信我|欢迎来聊|找个搭子|想交朋友|想认识新朋友)[！!。\s]*$/.test(text)
      if (!negative && !positive) rule = null
    }
    if (rule) ruleResults.set(sample.key, rule)
    if (rule) task.rulesDecided += 1
    if (mode === 'rule') {
      recordPrediction(sample.key, {
        intent: rule?.intent || 'UNKNOWN',
        scheme: 'rule',
        confidence: rule?.confidence ?? null,
        evidence: rule?.evidence || [],
        reason: rule?.reason || '规则层无明确结论（弃权）',
        model: 'rule',
        provider: 'rule',
        promptVersion: null,
        classifierVersion: classifier.id,
        runId,
        needsReview: !rule,
        at: new Date().toISOString(),
      })
      task.processed += 1
      continue
    }
    // 规则有结论时，'规则 + 豆包' 与 '规则 + 豆包 + 案例' 都沿用规则结论（豆包只补弃权部分）。
    if (rule) {
      for (const scheme of ['rule', 'model', 'model_cases']) {
        recordPrediction(sample.key, {
          intent: rule.intent, scheme,
          confidence: rule.confidence, evidence: rule.evidence || [], reason: rule.reason,
          model: 'rule', provider: 'rule', promptVersion: null,
          classifierVersion: classifier.id, runId, needsReview: false,
          at: new Date().toISOString(),
        })
      }
      task.processed += 1
      continue
    }
    const cases = mode === 'model_cases'
      ? retrieveCases(sample.text, examples || trainingCases(learning), { k: recallFirst ? Math.min(3, k) : k, excludeKeys: [sample.key], videoId: sample.videoId })
      : []
    items.push({ key: sample.key, comment: commentOfSample(sample), text: sample.text, video: videoOfSample(sample), replies: sample.replies || [], cases })
  }

  if (!items.length) {
    flushPredictions()
    const finished = learningStore.read()
    finished.lastRun = { ...task, status: 'done', finishedAt: new Date().toISOString() }
    learningStore.replace(finished)
    return { ok: true, task: { ...task, status: 'done' }, learning: finished, classifier }
  }
  if (!ai) {
    flushPredictions()
    const finished = learningStore.read()
    finished.lastRun = { ...task, status: 'blocked', finishedAt: new Date().toISOString(), errors: [{ reason: '没有可用模型，规则弃权的评论保持未分类' }] }
    learningStore.replace(finished)
    return { ok: false, error: '没有可用模型', task: finished.lastRun, learning: finished, classifier }
  }

  const run = await classifyComments({
    ai, items, mode: mode === 'model_cases' ? 'model_cases' : 'model',
    batchSize, maxCalls, classifierVersion: classifier.id, onCall, recallFirst,
  })
  task.aiCalls = run.calls
  task.tokens = run.tokens
  task.errors = run.errors
  for (const result of run.results) {
    const rule = ruleResults.get(result.key) || null
    if (mode === 'model_cases') {
      // 先写对照方案，最后写本方案：sample.ai 始终是“本轮实际采用”的结论。
      recordPrediction(result.key, {
        intent: rule?.intent || 'UNKNOWN', scheme: 'rule', confidence: rule?.confidence ?? null,
        evidence: rule?.evidence || [], reason: rule?.reason || '规则层无明确结论（弃权）', model: 'rule', provider: 'rule', runId, needsReview: !rule,
      })
      recordPrediction(result.key, { ...result, runId, scheme: 'model', caseKeys: [] })
      recordPrediction(result.key, { ...result, runId, scheme: 'model_cases' })
    } else if (mode === 'model') {
      recordPrediction(result.key, {
        intent: rule?.intent || 'UNKNOWN', scheme: 'rule', confidence: rule?.confidence ?? null,
        evidence: rule?.evidence || [], reason: rule?.reason || '规则层无明确结论（弃权）', model: 'rule', provider: 'rule', runId, needsReview: !rule,
      })
      recordPrediction(result.key, { ...result, runId, scheme: 'model' })
    }
    task.processed += 1
  }

  flushPredictions()
  const finished = learningStore.read()
  const status = run.errors.length ? 'partial' : 'done'
  finished.lastRun = { ...task, status, finishedAt: new Date().toISOString(), errors: run.errors.slice(0, 10) }
  learningStore.replace(finished)
  return { ok: true, task: finished.lastRun, learning: finished, classifier }
}

// 计算单条评论在三种方案下的结论（只读，不写盘），用于界面展示。
function previewSchemes(sample) {
  const out = {}
  for (const scheme of Object.keys(SCHEMES)) {
    const last = [...(sample.predictions || [])].reverse().find(item => item.scheme === scheme)
    out[scheme] = last ? { intent: last.intent, confidence: last.confidence, reason: last.reason, needsReview: last.needsReview } : null
  }
  if (sample.ai) out.latest = { intent: sample.ai.intent, confidence: sample.ai.confidence, reason: sample.ai.reason, needsReview: sample.ai.needsReview }
  out.candidate = COMMENT_INTENTS.includes(sample.ai?.intent) ? sample.ai.intent : null
  out.consentToDm = consentOf(sample.ai?.intent)
  return out
}

module.exports = {
  videoOfSample, commentOfSample, selectSamples, runCommentLearning, previewSchemes,
}
