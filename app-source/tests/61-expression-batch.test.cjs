const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createExpressionBatch, expressionItems, executeExpressionBatch, normalizeExpressionBatch } = require('../electron/expression-batch.cjs')
const expression = { mode: 'TEXT_AND_STICKER', stickerIntent: 'SPEECHLESS', stickerPosition: 'after_text' }
function fixture() { return createExpressionBatch('测试联系人', expression, '你是真行') }
test('batch text then sticker semantic mapping ignores model slot', () => {
  assert.deepEqual(expressionItems({ ...expression, slot: 2 }, '你是真行').map(item => [item.type, item.slot]), [['text', undefined], ['sticker', 7]])
})
test('batch sticker before text supported', () => assert.deepEqual(expressionItems({ ...expression, stickerPosition: 'before_text' }, '你是真行').map(item => item.type), ['sticker', 'text']))
test('batch NO_REPLY stays empty', () => assert.deepEqual(expressionItems({ mode: 'NO_REPLY', stickerIntent: 'TEASE' }), []))
test('batch STICKER_ONLY permits empty writer text', () => assert.equal(expressionItems({ mode: 'STICKER_ONLY', stickerIntent: 'TEASE' })[0].slot, 1))
test('batch unknown intent cannot silently send text only', () => assert.throws(() => expressionItems({ ...expression, stickerIntent: 'fake' }, 'text')))
test('batch success persists sending before every actual submission', async () => {
  const batch = fixture(), calls = [], saved = []
  const result = await executeExpressionBatch(batch, { persist: b => saved.push(structuredClone(b)), sendText: async () => { assert.equal(saved.at(-1).items[0].status, 'sending'); calls.push('text'); return { ok: true } }, sendSticker: async () => { assert.equal(saved.at(-1).items[1].status, 'sending'); calls.push('sticker'); return { status: 'SUCCESS' } } })
  assert.equal(result.status, 'SUCCESS'); assert.deepEqual(calls, ['text', 'sticker']); assert.equal(batch.status, 'sent')
})
test('batch second failed resumes only second and never first', async () => {
  const batch = fixture(); let text = 0, sticker = 0
  const callbacks = { persist: () => {}, sendText: async () => { text++; return { ok: true } }, sendSticker: async () => { sticker++; return { status: sticker === 1 ? 'FAILED' : 'SUCCESS' } } }
  assert.equal((await executeExpressionBatch(batch, callbacks)).status, 'FAILED')
  const restarted = normalizeExpressionBatch(batch)
  assert.equal((await executeExpressionBatch(restarted, callbacks)).status, 'SUCCESS')
  assert.equal(text, 1); assert.equal(sticker, 2)
})
test('batch UNKNOWN stops remaining item and all recovery', async () => {
  const batch = createExpressionBatch('测试联系人', { ...expression, stickerPosition: 'before_text' }, '你是真行')
  let text = 0, sticker = 0
  const callbacks = { persist: () => {}, sendText: async () => { text++; return { ok: true } }, sendSticker: async () => { sticker++; return { status: 'UNKNOWN' } } }
  assert.equal((await executeExpressionBatch(batch, callbacks)).status, 'UNKNOWN')
  assert.equal((await executeExpressionBatch(normalizeExpressionBatch(batch), callbacks)).status, 'UNKNOWN')
  assert.equal(sticker, 1); assert.equal(text, 0)
})
test('batch crash during sending migrates to UNKNOWN not pending', () => {
  const batch = fixture(); batch.items[0].status = 'sent'; batch.items[1].status = 'sending'; batch.status = 'sending'
  const restarted = normalizeExpressionBatch(batch)
  assert.equal(restarted.status, 'unknown'); assert.equal(restarted.items[1].status, 'unknown')
})
test('batch unknown transport exception is UNKNOWN', async () => {
  const batch = fixture()
  const result = await executeExpressionBatch(batch, { persist: () => {}, sendText: async () => { throw new Error('connection lost') }, sendSticker: async () => assert.fail('must stop') })
  assert.equal(result.status, 'UNKNOWN')
})
test('batch explicitly pre-submit failure is recoverable FAILED', async () => {
  const batch = fixture()
  const result = await executeExpressionBatch(batch, { persist: () => {}, sendText: async () => { const e = new Error('editor missing'); e.sendAttempted = false; throw e }, sendSticker: async () => assert.fail('must stop') })
  assert.equal(result.status, 'FAILED')
})
test('batch stale guard before next item preserves delivered first', async () => {
  const batch = fixture()
  const result = await executeExpressionBatch(batch, { persist: () => {}, beforeItem: async (_, index) => { if (index === 1) { const e = new Error('new message'); e.code = 'BURST_STALE'; throw e } }, sendText: async () => ({ ok: true }), sendSticker: async () => assert.fail('must stop') })
  assert.equal(result.status, 'FAILED'); assert.equal(batch.status, 'stale'); assert.equal(batch.items[0].status, 'sent'); assert.equal(batch.items[1].status, 'pending')
})
test('batch invalid persisted slot becomes UNKNOWN for manual intervention', () => {
  const batch = fixture(); batch.items[1].slot = 1
  assert.equal(normalizeExpressionBatch(batch).status, 'unknown')
})
test('cancelled batch remains cancelled across restart and never resumes', async () => {
  const batch = fixture(); batch.items[0].status = 'sent'; batch.status = 'cancelled'
  const restarted = normalizeExpressionBatch(batch)
  assert.equal(restarted.status, 'cancelled')
  assert.equal((await executeExpressionBatch(restarted, { persist: () => {}, sendText: async () => assert.fail(), sendSticker: async () => assert.fail() })).status, 'FAILED')
})
