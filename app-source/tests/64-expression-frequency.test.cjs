const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { recentExpressionReplies, expressionConstraints, guardExpression } = require('../electron/social-brain/expression-planner.cjs')

const base = Date.parse('2026-10-13T10:00:00Z')
const row = (offset, kind, extra = {}) => ({ name: '虚拟频率朋友', at: new Date(base + offset).toISOString(), kind, ...extra })
const item = (offset, batchId, intent = 'NONE', status = 'sent') => row(offset, intent === 'NONE' ? 'text' : 'sticker', { expressionBatchId: batchId, stickerIntent: intent, status })
const marker = (offset, batchId, intent = 'NONE', extra = {}) => row(offset, 'expression_turn', { expressionBatchId: batchId, expression: { mode: intent === 'NONE' ? 'TEXT_ONLY' : 'TEXT_AND_STICKER', stickerIntent: intent }, quotaExcluded: true, ...extra })
const replies = history => recentExpressionReplies(history, '虚拟频率朋友')
const turns = (...intents) => intents.map(stickerIntent => ({ stickerIntent, usedSticker: stickerIntent !== 'NONE' }))
function nextExpression(history, intent = 'TEASE') {
  return guardExpression({ shouldReply: true, action: 'REACTION', goal: '轻量回应', relationshipIntensity: 0.2, expression: { mode: 'STICKER_ONLY', stickerIntent: intent, stickerPosition: 'only' } }, { constraints: {}, payload: { incoming: '哈哈，今天终于把论文交了', socialBehaviorConstraints: { relationshipStage: 'old_friend' }, expressionConstraints: expressionConstraints({ recentReplies: replies(history) }) } })
}

test('one text and one confirmed sticker form one reply turn without a completion marker', () => {
  assert.deepEqual(replies([item(0, 'batch1'), item(100, 'batch1', 'LIKE')]), turns('LIKE'))
})

test('a completion marker and its successful items do not count multiple sticker turns', () => {
  const history = [item(0, 'batch1'), item(100, 'batch1', 'LIKE'), marker(200, 'batch1', 'LIKE')]
  assert.deepEqual(replies(history), turns('LIKE'))
  assert.equal(expressionConstraints({ recentReplies: replies(history) }).consecutiveStickerReplies, false)
  assert.equal(nextExpression(history, 'TEASE').mode, 'STICKER_ONLY')
})

test('sticker-first partially delivered batch counts its sent sticker after later text fails', () => {
  const history = [item(0, 'partial1', 'HAPPY'), item(100, 'partial1', 'NONE', 'failed'), marker(200, 'partial1', 'HAPPY', { status: 'failed' })]
  assert.deepEqual(replies(history), turns('HAPPY'))
  assert.equal(nextExpression(history, 'HAPPY').mode, 'TEXT_ONLY')
})

test('failed sticker with no successful item creates no reply frequency evidence', () => {
  assert.deepEqual(replies([item(0, 'failed1', 'LIKE', 'failed'), marker(100, 'failed1', 'LIKE', { status: 'failed' })]), [])
})

test('text-first success and failed sticker counts an actual text-only turn', () => {
  assert.deepEqual(replies([item(0, 'partial1'), item(100, 'partial1', 'LIKE', 'failed')]), turns('NONE'))
})

test('unknown, pending, sending and failed rows never count as successful sticker use', () => {
  const history = ['unknown', 'pending', 'sending', 'failed'].map((status, i) => item(i, 'unconfirmed-' + i, 'LIKE', status))
  assert.deepEqual(replies(history), [])
  assert.equal(nextExpression(history, 'LIKE').mode, 'STICKER_ONLY')
})

test('manual text still resets consecutive stickers after expression markers exist', () => {
  const history = [marker(0, 'batch1', 'LIKE'), row(2000, 'manual'), marker(4000, 'batch2', 'HAPPY')]
  assert.deepEqual(replies(history), turns('LIKE', 'NONE', 'HAPPY'))
  const constraints = expressionConstraints({ recentReplies: replies(history) })
  assert.equal(constraints.consecutiveStickerReplies, false)
  assert.equal(constraints.highFrequency, true)
})

test('two manual text turns clear old high-frequency suppression', () => {
  const history = [marker(0, 'batch1', 'LIKE'), marker(100, 'batch2', 'HAPPY'), row(2000, 'text'), row(4000, 'manual')]
  assert.deepEqual(replies(history), turns('HAPPY', 'NONE', 'NONE'))
  assert.equal(nextExpression(history, 'LIKE').mode, 'STICKER_ONLY')
})

test('adjacent no-batch manual text ledger and marker within one second merge once', () => {
  const history = [row(0, 'text'), marker(1000, undefined), marker(2000, 'batch1', 'LIKE')]
  assert.deepEqual(replies(history), turns('NONE', 'LIKE'))
})

test('a delayed or non-adjacent no-batch marker cannot erase a distinct manual text turn', () => {
  assert.deepEqual(replies([row(0, 'text'), marker(1001, undefined)]), turns('NONE', 'NONE'))
  assert.deepEqual(replies([row(0, 'text'), row(100, 'manual'), marker(200, undefined)]), turns('NONE', 'NONE', 'NONE'))
})

test('restored successful item for an existing batch moves that turn to the most recent position', () => {
  const history = [item(0, 'restored1', 'LIKE'), item(1000, 'batch2'), item(2000, 'batch3'), item(3000, 'batch4'), marker(4000, 'restored1', 'LIKE')]
  assert.deepEqual(replies(history), turns('NONE', 'NONE', 'LIKE'))
  assert.equal(nextExpression(history, 'LIKE').mode, 'TEXT_ONLY')
})

test('a failed restoration does not move an old batch ahead of actual later replies', () => {
  const history = [item(0, 'old1', 'LIKE'), row(1000, 'manual'), row(2000, 'manual'), row(3000, 'manual'), item(4000, 'old1', 'LIKE', 'unknown')]
  assert.deepEqual(replies(history), turns('NONE', 'NONE', 'NONE'))
  assert.equal(nextExpression(history, 'LIKE').mode, 'STICKER_ONLY')
})

test('two successful sticker batches suppress a third independent of item counts', () => {
  const history = [item(0, 'batch1'), item(100, 'batch1', 'LIKE'), marker(200, 'batch1', 'LIKE'), item(1000, 'batch2', 'HAPPY'), marker(1100, 'batch2', 'HAPPY')]
  const constraints = expressionConstraints({ recentReplies: replies(history) })
  assert.deepEqual(replies(history), turns('LIKE', 'HAPPY'))
  assert.equal(constraints.consecutiveStickerReplies, true)
  assert.equal(nextExpression(history).mode, 'TEXT_ONLY')
})

test('two of three real replies suppress stickers even with one text turn between', () => {
  const history = [item(0, 'batch1', 'LIKE'), row(1000, 'manual'), item(2000, 'batch2', 'HAPPY')]
  assert.equal(expressionConstraints({ recentReplies: replies(history) }).highFrequency, true)
  assert.equal(nextExpression(history).mode, 'TEXT_ONLY')
})

test('single recent semantic repetition is blocked without imposing two-turn frequency', () => {
  const history = [item(0, 'batch1', 'LIKE')]
  assert.equal(expressionConstraints({ recentReplies: replies(history) }).highFrequency, false)
  assert.equal(nextExpression(history, 'LIKE').mode, 'TEXT_ONLY')
  assert.equal(nextExpression(history, 'TEASE').mode, 'STICKER_ONLY')
})

test('other contact names and conflicting contact IDs cannot affect this contact frequency', () => {
  const history = [item(0, 'batch1', 'LIKE'), { ...item(100, 'foreign1', 'HAPPY'), name: '另一位朋友' }, { ...item(200, 'foreign2', 'HAPPY'), contactId: 'other-id' }]
  assert.deepEqual(recentExpressionReplies(history, { name: '虚拟频率朋友', id: 'current-id' }), turns('LIKE'))
})

test('identical nicknames in separate account storage have independent frequency state', () => {
  const accountA = createMemoryStorage({ sendHistory: [item(0, 'batch1', 'LIKE'), item(100, 'batch2', 'HAPPY')] })
  const accountB = createMemoryStorage({ sendHistory: [row(0, 'manual')] })
  assert.equal(nextExpression(accountA.get().sendHistory).mode, 'TEXT_ONLY')
  assert.equal(nextExpression(accountB.get().sendHistory).mode, 'STICKER_ONLY')
  accountB.update({ sendHistory: [item(0, 'other-account-batch', 'TEASE')] })
  assert.deepEqual(replies(accountA.get().sendHistory), turns('LIKE', 'HAPPY'))
})

test('legacy successful rows without status remain evidence while event/video rows do not count', () => {
  assert.deepEqual(replies([row(0, 'ai'), row(100, 'video', { stickerIntent: 'LIKE' }), row(200, 'event_followup', { stickerIntent: 'HAPPY' }), row(300, 'reply', { stickerIntent: 'LIKE' })]), turns('NONE', 'LIKE'))
})

test('reading frequency history is pure and preserves ledger rows for quota and recovery', () => {
  const history = [item(0, 'batch1'), item(100, 'batch1', 'LIKE'), marker(200, 'batch1', 'LIKE'), row(2000, 'text'), marker(2200, undefined)]
  const original = structuredClone(history)
  replies(history); nextExpression(history)
  assert.deepEqual(history, original)
})
