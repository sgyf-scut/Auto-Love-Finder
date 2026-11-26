// Local list ownership: comments -> intent pool -> filtered batch. No platform actions.
const fs = require('node:fs'), path = require('node:path')
const { candidateRecords } = require('../social-brain/library-candidates.cjs')
const { defaults: libraryDefaults } = require('../social-brain/library-store.cjs')
const { writeFileAtomicSync } = require('../atomic-write.cjs')
const { evaluateBatchCandidate, normalizeBatchFilters } = require('./batch-filter.cjs')

function syncIntentPool({ manager, libraryStore, learningStore, accountId = '', contacts = [], blockedNames = [] }) {
  const library = libraryStore.read(), discovery = manager.get()
  learningStore?.syncLibrary(library)
  const cleared = new Set(discovery.candidatePoolClearedKeys || [])
  const built = candidateRecords(library, { excludePlatformUserIds: contacts.map(c => c.profile?.platformUserId).filter(Boolean), excludeNames: blockedNames })
  const records = built.records.filter(record => !cleared.has(record._libraryKey))
  const existingById = new Map(discovery.candidates.map(c => [c.platformUserId, c])), byKey = new Map(library.comments.map(c => [c.key,c]))
  const rank = intent => ({EXPLICIT_INVITATION:3,SEEKING_FRIENDS:2,CONTEXTUAL_INTEREST:1})[intent] || 0
  const additions = records.filter(record => {
    const previous = existingById.get(record.platformUserId)
    return !previous || byKey.get(record._libraryKey)?.candidate?.candidateId !== previous.id || rank(record.libraryIntent) > rank(previous.libraryIntent)
  })
  const result = additions.length ? manager.upsert(additions.map(({ _libraryKey, ...record }) => ({...record,intentPoolOnly:true})), { accountId })
    : { added: 0, merged: 0, discovery }
  const byUser = new Map(result.discovery.candidates.map(c => [c.platformUserId, c]))
  const marks = new Map(built.unmapped.map(row => [row.key, { status: 'unmapped', reason: row.reason }]))
  for (const record of records) {
    const candidate = byUser.get(record.platformUserId)
    marks.set(record._libraryKey, candidate ? { status: 'in_pool', candidateId: candidate.id, reason: '' } : { status: 'unmapped', reason: 'UPSERT_SKIPPED' })
  }
  let changed = false
  for (const comment of library.comments) {
    const mark = marks.get(comment.key)
    if (mark && ['status','candidateId','reason'].some(k => (comment.candidate?.[k] || '') !== (mark[k] || ''))) { comment.candidate = mark; changed = true }
  }
  if (changed) libraryStore.save(library)
  for (const id of built.rejectedPlatformUserIds || []) {
    const c = byUser.get(id)
    if (c && ['REVIEW_PENDING','DISCOVERED','APPROVED','DEFERRED'].includes(c.status)) manager.review(c.id, { status: 'REJECTED', note: '评论者明确拒绝联系' })
  }
  return { ok: true, added: result.added, merged: result.merged, unmapped: built.unmapped.length }
}

function clearDiscoveryList({ scope, confirmed, manager, libraryStore, learningStore, busy = false }) {
  if (confirmed !== true) throw new Error('请先确认清除范围')
  if (!['candidates','comments'].includes(scope)) throw new Error('不支持的清除范围')
  const discovery = manager.get(), library = libraryStore.read(), learning = learningStore.read()
  if (busy || ['running','paused'].includes(discovery.batch?.status)) throw new Error('请先停止寻找、采集或自动联系任务，再清除列表')
  const folder = path.join(learningStore.dir, 'maintenance-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + scope)
  fs.mkdirSync(folder, { recursive: true })
  writeFileAtomicSync(path.join(folder, 'lists.json'), JSON.stringify({ scope, discovery, library, learning }))
  if (scope === 'candidates') {
    const ledger = { ...(discovery.candidateContactHistory || {}) }
    for (const c of discovery.candidates) {
      if (c.status === 'REJECTED' || c.review?.realContact || c.action?.needsReview || !['not_started',undefined].includes(c.action?.firstMessageStatus)
        || !['not_started',undefined].includes(c.contact?.status) || !['not_started',undefined].includes(c.action?.followStatus)) {
        ledger[c.platformUserId] = { accountId: c.accountId, status: c.status, action: c.action, contact: c.contact, realContact: c.review?.realContact }
      }
    }
    const keys = [...new Set([...(discovery.candidatePoolClearedKeys || []), ...library.comments.map(c => c.key)])]
    const trimmedBatch = b => b ? { ...b, added: [], profileDeferred: [], candidateDecisions: [], progress: { ...b.progress, qualified: 0 } } : b
    manager.save({ ...discovery, candidates: [], candidateContactHistory: ledger, candidatePoolClearedKeys: keys,
      batch: trimmedBatch(discovery.batch), batchHistory: (discovery.batchHistory || []).map(trimmedBatch) })
    for (const c of library.comments) c.candidate = { status: 'unmapped', reason: 'POOL_CLEARED' }
    for (const key of ['follow','firstMessage']) library.autoContact.queues[key] = library.autoContact.queues[key].filter(task => task.status !== 'pending')
    libraryStore.save(library)
    return { ok: true, removed: discovery.candidates.length, backupPath: folder }
  }
  libraryStore.save({ ...library, comments: [], collector: libraryDefaults().collector, pipeline: { ...library.pipeline, items: [], status: 'idle' } })
  learningStore.replace({ ...learning, samples: [], lastRun: null })
  manager.save({ ...discovery, videoRoundProgress: null, batch: discovery.batch ? { ...discovery.batch, classificationQueue: [] } : null })
  return { ok: true, removed: library.comments.length, removedSamples: learning.samples.length, backupPath: folder }
}

function filterIntentPool(manager, filters, goal = null) {
  const discovery = manager.get(), criteria = normalizeBatchFilters(filters), counts = { qualified: 0, pending: 0, excluded: 0 }
  for (const candidate of discovery.candidates) {
    const match = goal && (candidate.goalMatches || []).findLast(item => item.id === goal.id && item.version === goal.version && item.label === 'match')
    const source = match && candidate.sources?.find(item => item.videoId === match.videoId && item.commentText === match.text)
    const rejected = candidate.status === 'REJECTED' || candidate.discoveryStatus === 'REJECTED' || candidate.review?.intentConfirmation?.value === 'DO_NOT_CONTACT'
    const result = goal && rejected ? { status: 'excluded', reasons: ['REJECTED_PROTECTED'] }
      : goal && !match ? { status: 'excluded', reasons: ['GOAL_NOT_MATCHED'] }
      : evaluateBatchCandidate(candidate, criteria, source || candidate.source, match || null)
    candidate.batchScreening = { status: result.status, reasons: result.reasons, filters: criteria, ...(goal ? { goal } : {}), at: new Date().toISOString() }
    counts[result.status]++
  }
  manager.save(discovery)
  return { ok: true, counts }
}
module.exports = { syncIntentPool, clearDiscoveryList, filterIntentPool }
