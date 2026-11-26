// P2-17B.2 按需读取评论回复：卡片默认只显示回复总数，用户点开才读。
//
// 设计边界：
// 1) 只读页面已渲染的回复，不构造签名接口、不绕过反爬；
// 2) 读之前核对 videoId 与 commentId，两者都对上才返回，避免把别人的回复挂错卡片；
// 3) 结果按「视频+评论」缓存并去重，重复点开不重复请求；带 TTL，过期才重新读；
// 4) 状态必须分得清：加载中、空、失败、部分加载（可继续）、已完成。
const fs = require('node:fs')
const path = require('node:path')
const { writeFileAtomicSync } = require('../atomic-write.cjs')

const DAY = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 500
const DEFAULT_TTL = 7 * DAY

const ERROR_CODES = {
  NO_ADAPTER: { label: '当前环境没有可用的页面读取通道', retryable: false },
  VIDEO_ID_INVALID: { label: '候选缺少可核对的视频 ID，无法读取回复', retryable: false },
  COMMENT_ID_MISSING: { label: '该评论没有评论 ID（页面未提供），无法按条读取回复', retryable: false },
  COMMENT_NOT_FOUND: { label: '页面上找不到这条评论，可能已删除或评论区未加载到该位置', retryable: true },
  COMMENTS_NOT_LOADED: { label: '评论区还没有加载出来', retryable: true },
  NEED_EXPAND: { label: '回复列表未能展开', retryable: true },
  CHALLENGE: { label: '抖音要求完成安全验证，暂时无法读取', retryable: false },
  LOGIN_REQUIRED: { label: '登录态不可用，无法读取回复', retryable: false },
  RATE_LIMITED: { label: '读取过于频繁被限流，稍后再试', retryable: true },
  NETWORK_ERROR: { label: '页面或网络错误', retryable: true },
  TIMEOUT: { label: '读取超时', retryable: true },
  WRONG_PAGE: { label: '页面已经不在该视频上', retryable: true },
  SCRIPT_ERROR: { label: '页面脚本执行失败', retryable: true },
  ERROR: { label: '未知错误', retryable: true },
}

const clean = (v, n = 400) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n)
const keyOf = (videoId, commentId) => `v:${videoId}|c:${commentId}`

class ReplyCache {
  constructor(filePath = null, { now = () => Date.now(), ttl = DEFAULT_TTL } = {}) {
    this.filePath = filePath
    this.now = now
    this.ttl = ttl
    this.entries = null
  }

  load() {
    if (this.entries) return this.entries
    this.entries = {}
    if (!this.filePath) return this.entries
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (raw && typeof raw.entries === 'object' && raw.entries) this.entries = raw.entries
    } catch { /* 首次或损坏都从空缓存开始，不影响读取 */ }
    return this.entries
  }

  get(videoId, commentId) {
    const entry = this.load()[keyOf(videoId, commentId)]
    if (!entry) return null
    if (this.now() - Number(entry.at || 0) > this.ttl) return null
    return entry
  }

  set(videoId, commentId, value) {
    const entries = this.load()
    const key = keyOf(videoId, commentId)
    entries[key] = { ...value, at: this.now() }
    // 控制文件大小：超限时丢掉最旧的记录。
    const keys = Object.keys(entries)
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => Number(entries[a].at || 0) - Number(entries[b].at || 0))
      for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[old]
    }
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        writeFileAtomicSync(this.filePath, JSON.stringify({ version: 1, entries }))
      } catch { /* 缓存写失败不影响本次结果 */ }
    }
    return entries[key]
  }
}

function normalizeReplies(list) {
  const seen = new Set(), out = []
  for (const item of Array.isArray(list) ? list : []) {
    const text = clean(item?.text ?? item?.content, 500)
    if (!text) continue
    const author = clean(item?.author ?? item?.nickname, 100) || null
    const replyId = clean(item?.replyId ?? item?.id, 100) || null
    const key = replyId || `${author || ''}\u0000${text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ replyId, author, text })
  }
  return out
}

class ReplyReader {
  // deps: { transport, cache, now }
  constructor({ transport = null, cache = null, now = () => Date.now() } = {}) {
    this.transport = transport
    this.transportFactory = null
    this.cache = cache || new ReplyCache(null, { now })
    this.now = now
  }

  setTransportFactory(factory) { this.transportFactory = factory }

  resolveTransport() {
    if (this.transport) return this.transport
    if (typeof this.transportFactory === 'function') {
      try { this.transport = this.transportFactory() } catch { this.transport = null }
    }
    return this.transport
  }

  // 只做参数校验：返回 null 表示可以继续读，否则返回不可读的原因。
  static validate(source) {
    const videoId = String(source?.videoId || '').trim()
    const commentId = String(source?.commentId || '').trim()
    if (!/^\d{8,24}$/.test(videoId)) return { ok: false, code: 'VIDEO_ID_INVALID', videoId, commentId }
    if (!commentId) return { ok: false, code: 'COMMENT_ID_MISSING', videoId, commentId }
    return { ok: true, videoId, commentId }
  }

  statusOf({ ok, code, replies = [], total = null, partial = false, cached = false, note = '' }) {
    if (!ok) {
      const preset = ERROR_CODES[code] || ERROR_CODES.ERROR
      return { ok: false, code, state: 'failed', error: preset.label, retryable: preset.retryable, replies: [], cached }
    }
    if (!replies.length) return { ok: true, state: 'empty', replies: [], total, partial, cached, note: note || '该评论没有可读回复' }
    return { ok: true, state: partial ? 'partial' : 'complete', replies, total, partial, cached, note }
  }

  // source: 候选的 comment source（含 videoId/commentId）。
  async read(source, { cursor = 0, force = false, pageSize = 10 } = {}) {
    const checked = ReplyReader.validate(source)
    if (!checked.ok) return this.statusOf({ ok: false, code: checked.code })
    const { videoId, commentId } = checked

    const cached = force ? null : this.cache.get(videoId, commentId)
    if (cached) {
      const replies = normalizeReplies(cached.replies)
      const start = Math.max(0, Number(cursor) || 0)
      const page = replies.slice(start, start + pageSize)
      return this.statusOf({ ok: true, replies: page, total: cached.total ?? replies.length, cached: true,
        partial: start + page.length < replies.length, note: cached.note || '' })
    }

    const transport = this.resolveTransport()
    if (!transport || typeof transport.readReplies !== 'function') return this.statusOf({ ok: false, code: 'NO_ADAPTER' })

    let result = null
    try { result = await transport.readReplies({ videoId, commentId, cursor: 0, pageSize: 200 }) }
    catch (error) { result = { ok: false, code: 'NETWORK_ERROR', reason: String(error?.message || error) } }

    if (!result?.ok) {
      const code = ERROR_CODES[result?.code] ? result.code : 'ERROR'
      return this.statusOf({ ok: false, code, note: String(result?.reason || '') })
    }
    // 双保险：页面返回的 video/comment 必须与请求一致。
    if (String(result.videoId || '') && String(result.videoId) !== videoId) return this.statusOf({ ok: false, code: 'WRONG_PAGE' })
    if (String(result.commentId || '') && String(result.commentId) !== commentId) return this.statusOf({ ok: false, code: 'COMMENT_NOT_FOUND' })

    const replies = normalizeReplies(result.replies)
    const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : replies.length
    this.cache.set(videoId, commentId, { replies, total })
    const start = Math.max(0, Number(cursor) || 0)
    const page = replies.slice(start, start + pageSize)
    const complete = result.hasMore !== true && start + page.length >= replies.length
    return this.statusOf({ ok: true, replies: page, total, partial: !complete,
      note: complete ? '' : `已读取 ${replies.length}/${total} 条，可继续加载` })
  }
}

module.exports = { ReplyReader, ReplyCache, ERROR_CODES, normalizeReplies, keyOf }
