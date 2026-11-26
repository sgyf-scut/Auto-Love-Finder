const { bounded, normalizeType, normalizeQuote, interpretMedia } = require('./media-interpreter.cjs')

async function interpretMessage({ message, media = {}, history = [], analyze } = {}) {
  const raw = typeof message === 'string' ? { text: message, type: 'text' } : message && typeof message === 'object' ? message : {}
  const originalType = bounded(raw.type || raw.kind || media.mediaKind || 'text', 80)
  let type = normalizeType(originalType)
  const quote = normalizeQuote(media.quote || raw.quote)
  if (quote && type === 'text') type = 'quote'
  const originalText = typeof raw.text === 'string' ? raw.text : typeof raw.content === 'string' ? raw.content : ''
  const base = { type, originalType, originalText, messageId: bounded(raw.messageId || raw.id, 200), understandingStatus: 'not_required', visualDescription: '', textInImage: '', emotion: [], socialMeaning: '', socialMeaningIsInference: true, replyRole: 'unknown', confidence: 0, uncertainty: [], evidence: [], sourceFrameCount: 0, frameCoverage: 'none', quote, ownership: 'unknown', errorCode: '' }
  // Existing video/share analysis remains authoritative in this first iteration.
  if (type === 'video' || /share|分享/.test(originalType)) return base
  if (type === 'unknown' && /图片|表情|动图|媒体|image|sticker|media/i.test(originalText)) return { ...base, understandingStatus: 'failed', errorCode: 'unknown_media_type', uncertainty: ['未能确认媒体类型，保留原始消息而不猜测内容'] }
  const quoteVisual = quote && ['image', 'sticker', 'gif', 'video'].includes(quote.type)
  const hasVisual = ['image', 'sticker', 'gif', 'video'].includes(type) || quoteVisual || (type === 'quote' && Array.isArray(media.frames) && media.frames.length > 0)
  if (!hasVisual) return base
  return interpretMedia({ base, media: { ...media, mediaKind: quoteVisual ? quote.type : media.mediaKind, mediaEvidence: media.mediaEvidence || raw.mediaEvidence }, history, analyze })
}

module.exports = { interpretMessage }
