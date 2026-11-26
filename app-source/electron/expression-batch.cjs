const { randomUUID } = require('node:crypto')

const { STICKER_SLOTS: SLOT_MAP } = require('./social-brain/sticker-slots.cjs')
function expressionItems(expression, text = '') {
  const mode = expression?.mode || 'TEXT_ONLY'
  if (mode === 'NO_REPLY') return []
  if (!['TEXT_ONLY', 'STICKER_ONLY', 'TEXT_AND_STICKER'].includes(mode)) throw new Error('未知表达模式')
  const items = []
  if (mode !== 'STICKER_ONLY') {
    if (!String(text).trim()) throw new Error('文字表达不能为空')
    items.push({ type: 'text', content: String(text).trim(), status: 'pending' })
  }
  if (mode !== 'TEXT_ONLY') {
    const intent = expression.stickerIntent
    if (!Object.hasOwn(SLOT_MAP, intent)) throw new Error('未知收藏表情意图')
    const sticker = { type: 'sticker', intent, slot: SLOT_MAP[intent], status: 'pending' }
    if (mode === 'STICKER_ONLY' || expression.stickerPosition === 'before_text') items.unshift(sticker)
    else items.push(sticker)
  }
  return items
}
function createExpressionBatch(name, expression, text, metadata = {}) {
  return { id: `expression_${randomUUID()}`, name, expression: { mode: expression.mode, stickerIntent: expression.stickerIntent || 'NONE', stickerPosition: expression.stickerPosition || 'after_text' },
    items: expressionItems(expression, text), status: 'pending', createdAt: new Date().toISOString(),
    ...Object.fromEntries(['contactId', 'burstId', 'conversationRevision', 'bufferEpoch', 'draftId', 'platformUserId', 'incomingKey', 'selfProfileRevision'].filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])) }
}
function normalizeExpressionBatch(batch) {
  if (!batch || typeof batch !== 'object' || !batch.id || !batch.name || !Array.isArray(batch.items)) return null
  const items = batch.items.map(item => {
    const valid = item.type === 'text' ? Boolean(String(item.content || '').trim()) : item.type === 'sticker' && Object.hasOwn(SLOT_MAP, item.intent) && SLOT_MAP[item.intent] === item.slot
    const status = item.status === 'sending' ? 'unknown' : ['pending', 'sent', 'failed', 'unknown'].includes(item.status) ? item.status : 'unknown'
    return { ...item, status: valid ? status : 'unknown', ...(item.status === 'sending' ? { reason: '重启前发送尚未确认，请人工检查，不会自动重发' } : {}) }
  })
  const status = batch.status === 'cancelled' ? 'cancelled' : items.some(item => item.status === 'unknown') ? 'unknown' : items.every(item => item.status === 'sent') ? 'sent' : batch.status === 'sending' ? 'pending' : ['pending', 'failed', 'stale'].includes(batch.status) ? batch.status : 'pending'
  return { ...batch, items, status }
}
function normalizeExpressionBatches(value) { return (Array.isArray(value) ? value : []).map(normalizeExpressionBatch).filter(Boolean) }

// Persist sending before submission. A crash is ambiguous and never retryable.
async function executeExpressionBatch(batch, { persist, sendText, sendSticker, beforeItem = async () => {} }) {
  if (batch.items.some(item => ['unknown', 'sending'].includes(item.status)) || batch.status === 'unknown') return { ok: false, status: 'UNKNOWN', batch }
  if (['stale', 'cancelled'].includes(batch.status)) return { ok: false, status: 'FAILED', batch }
  for (let index = 0; index < batch.items.length; index++) {
    const item = batch.items[index]
    if (item.status === 'sent') continue
    try { await beforeItem(item, index) } catch (error) {
      batch.status = ['BURST_STALE', 'SELF_PROFILE_STALE'].includes(error.code) ? 'stale' : 'failed'
      batch.reason = error.message; batch.errorCode = error.code; await persist(batch)
      return { ok: false, status: 'FAILED', batch, error }
    }
    item.status = 'sending'; item.lastAttemptAt = new Date().toISOString(); batch.status = 'sending'
    await persist(batch)
    let result
    try { result = await (item.type === 'text' ? sendText(item, index) : sendSticker(item, index)) }
    catch (error) { result = { status: error.sendAttempted === false ? 'FAILED' : 'UNKNOWN', reason: error.message, error } }
    const status = result?.status || (result?.ok === true ? 'SUCCESS' : 'UNKNOWN')
    item.status = status === 'SUCCESS' ? 'sent' : status === 'FAILED' ? 'failed' : 'unknown'
    item.reason = result?.reason || ''; item.updatedAt = new Date().toISOString()
    batch.status = ['BURST_STALE', 'SELF_PROFILE_STALE'].includes(result?.error?.code) && item.status === 'failed' ? 'stale' : item.status === 'sent' ? 'pending' : item.status
    if (result?.error?.code) { batch.errorCode = result.error.code; batch.reason = result.error.message }
    await persist(batch)
    if (item.status !== 'sent') return { ok: false, status: item.status === 'unknown' ? 'UNKNOWN' : 'FAILED', batch, error: result?.error }
  }
  batch.status = 'sent'; batch.sentAt = new Date().toISOString(); await persist(batch)
  return { ok: true, status: 'SUCCESS', batch }
}
module.exports = { SLOT_MAP, expressionItems, createExpressionBatch, normalizeExpressionBatch, normalizeExpressionBatches, executeExpressionBatch }
