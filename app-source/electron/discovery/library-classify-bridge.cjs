// P2-17B.2 分类结果回写素材库：学习库（learning.samples）→ 素材库（comment.classification）。
//
// 批次的价值判断（evaluateVideoValue）和候选生成（candidateRecords）都读 comment.classification。
// 如果只写学习库，素材库里永远是"未分类"，价值恒为 0、候选也建不出来——这是 P2-17B.1 的次根因。
// 抽成独立模块，主进程与离线集成测试共用同一份实现，避免测试夹具掩盖真实契约。
const clean = (v, n = 200) => String(v || '').trim().slice(0, n)

// 只回写本次请求的 keys，且只回写模型给出 intent 的样本；人工标注（reviewedByUser）不覆盖。
function writeBackClassification({ libraryStore, learningStore, keys = [], preferHuman = false, now = () => new Date().toISOString() }) {
  const wanted = new Set((keys || []).map(String).filter(Boolean))
  if (!wanted.size) return { changed: 0, skipped: 0, missing: 0 }
  const library = libraryStore.read()
  const samples = (learningStore.read().samples || [])
  const byKey = new Map((library.comments || []).map(comment => [comment.key, comment]))
  let changed = 0, skipped = 0, missing = 0
  for (const sample of samples) {
    if (!wanted.has(sample.key)) continue
    const human = sample.human?.intent ? sample.human : null
    const intent = human?.intent || sample.ai?.intent
    if (!intent) continue
    const comment = byKey.get(sample.key)
    if (!comment) { missing++; continue }
    if (comment.classification?.reviewedByUser && !(preferHuman && human &&
      Date.parse(human.at) > Date.parse(comment.classification.classifiedAt || '1970-01-01'))) { skipped++; continue }
    comment.classification = {
      ...(human ? { reviewedByUser: true } : {}),
      intent,
      confidence: human ? 1 : Number.isFinite(sample.ai.confidence) ? sample.ai.confidence : null,
      reason: clean(human?.reason || sample.ai?.reason, 300),
      model: human ? 'human' : clean(sample.ai?.model, 100),
      ...(sample.ai?.inputHash ? { inputHash: sample.ai?.inputHash } : {}),
      classifiedAt: human?.at || now(),
    }
    changed++
  }
  if (changed) libraryStore.save(library)
  return { changed, skipped, missing }
}

module.exports = { writeBackClassification }
