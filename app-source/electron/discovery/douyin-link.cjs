// 抖音链接解析：把分享短链（v.douyin.com/xxx）换成平台自带跳转的正式作品页。
// 只做一次普通的 HTTP GET 跟随 302，不构造签名参数、不绕过反爬。
const DOUYIN_HOST = /(^|\.)douyin\.com$/i
const SHORT_HOST = /^v\.douyin\.com$/i
const CONTENT_PATH = /^\/(?:share\/)?(video|note)\/(\d{6,})\/?$/

const normalize = value => {
  const raw = String(value || '').trim()
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const parsed = new URL(raw)
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  } catch { return null }
}

// 从正式作品页提取类型与作品 ID；短链或其它页面返回 null。
function extractContent(url) {
  const normalized = normalize(url)
  if (!normalized) return null
  let parsed
  try { parsed = new URL(normalized) } catch { return null }
  if (!DOUYIN_HOST.test(parsed.hostname)) return null
  const match = parsed.pathname.match(CONTENT_PATH)
  if (!match) return null
  return { kind: match[1], videoId: match[2], url: normalized }
}

// 解析结果统一为 { ok, url, videoId, kind } 或 { ok:false, code, reason, transient }。
async function resolveDouyinTarget(input, { fetchImpl } = {}) {
  const normalized = normalize(input)
  if (!normalized) return { ok: false, code: 'VIDEO_ID_UNRESOLVED', reason: '链接格式不正确，请粘贴抖音作品链接或分享短链' }
  let parsed
  try { parsed = new URL(normalized) } catch { return { ok: false, code: 'VIDEO_ID_UNRESOLVED', reason: '链接格式不正确' } }
  if (!DOUYIN_HOST.test(parsed.hostname)) {
    return { ok: false, code: 'VIDEO_ID_UNRESOLVED', reason: '只支持 douyin.com 域名下的作品链接' }
  }
  const direct = extractContent(normalized)
  if (direct) return { ok: true, ...direct }
  if (!SHORT_HOST.test(parsed.hostname)) {
    return { ok: false, code: 'VIDEO_ID_UNRESOLVED', reason: '链接里找不到作品 ID，请使用作品页或分享短链' }
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'LINK_RESOLVE_UNAVAILABLE', reason: '当前环境无法解析分享短链', transient: true }
  }
  let finalUrl = ''
  try {
    const response = await fetchImpl(normalized)
    finalUrl = String(response?.url || '')
    // 只看重定向结果，不读取页面正文。
    try { response?.body?.cancel?.() } catch { /* 忽略取消失败 */ }
  } catch (error) {
    return { ok: false, code: 'NETWORK_ERROR', reason: `分享短链解析失败：${String(error?.message || error)}`, transient: true }
  }
  const content = extractContent(finalUrl)
  if (!content) {
    const idMatch = finalUrl.match(/(?:video\/|note\/|modal_id=)(\d{6,})/)
    if (idMatch) {
      return { ok: true, kind: 'video', videoId: idMatch[1], url: `https://www.douyin.com/video/${idMatch[1]}` }
    }
    return { ok: false, code: 'VIDEO_NOT_FOUND', reason: '分享短链没有跳转到作品页，可能已失效或不是作品链接' }
  }
  return { ok: true, ...content }
}

module.exports = { resolveDouyinTarget, extractContent }
