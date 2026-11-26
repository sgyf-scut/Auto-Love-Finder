const { withVerificationTools } = require('./verification-dom.cjs')
const { normalizeVideoCommentCount } = require('./video-comment-count.cjs')
const { requestManualVerification } = require('../manual-verification.cjs')
// P2-17B 视频来源适配层：关键词 / 标签 / 收藏夹。
// 页面内脚本全部为纯函数，通过 win.webContents.executeJavaScript 在已登录窗口执行。
// 接口参数来自 P2-17A 实测（experiments/p217a/lib/sources.cjs），此处改为应用内调用。

function keywordSearchUrl(keyword) {
  return `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`
}

function topicPageUrl(chId) {
  return `https://www.douyin.com/hashtag/${encodeURIComponent(chId)}`
}

const { navigateReadable, readPageState, executePageScript } = require('./page-readiness.cjs')

// —— 页面内脚本 ——
function keywordApiSnapshot(payload) {
  const { keyword, offset = 0, count = 10, timeout = 20000 } = payload || {}
  return (async () => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeout)
    const started = Date.now()
    const url = 'https://www.douyin.com/aweme/v1/web/search/item/?search_channel=aweme_video_web&enable_history=1'
      + '&keyword=' + encodeURIComponent(keyword)
      + '&search_source=normal_search&query_correct_type=1&is_filter_search=0&sort_type=0&publish_time=0'
      + '&from_group_id=&disable_rs=0&offset=' + offset + '&count=' + count + '&need_filter_settings=1&list_type=single'
      + '&update_version_code=170400&pc_client_type=1&version_code=170400&version_name=17.4.0'
      + '&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32'
      + '&browser_name=Chrome&browser_version=120.0.0.0&browser_online=true&engine_name=Blink&engine_version=120.0.0.0'
      + '&os_name=Windows&os_version=10&device_memory=8&platform=PC' + '&device_platform=webapp&aid=6383&channel=channel_pc_web'
    try {
      const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal })
      const text = await resp.text()
      clearTimeout(timer)
      let data = null; try { data = JSON.parse(text) } catch {}
      if (!data) return { ok: false, kind: 'BAD_RESPONSE', http: resp.status, sample: text.slice(0, 120), ms: Date.now() - started }
      if (data.status_code === 2483) return { ok: false, kind: 'LOGIN_REQUIRED', code: 2483, ms: Date.now() - started }
      if (data.status_code !== 0) return { ok: false, kind: 'API_ERROR', code: data.status_code, ms: Date.now() - started }
      const items = (data.data || []).filter(x => x && x.aweme_info).map((x, i) => {
        const a = x.aweme_info, au = a.author || {}, st = a.statistics || {}
        return { videoId: a.aweme_id || null, title: String(a.desc || '').trim() || null,
          authorId: au.sec_uid || null, authorName: au.nickname || null,
          likeCount: st.digg_count == null ? null : st.digg_count,
          commentCount: st.comment_count == null ? null : st.comment_count,
          publishAt: a.create_time ? new Date(a.create_time * 1000).toISOString() : null,
          position: offset + i }
      })
      return { ok: true, items, hasMore: data.has_more ? 1 : 0, nextOffset: offset + items.length, ms: Date.now() - started }
    } catch (e) {
      clearTimeout(timer)
      return { ok: false, kind: e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', ms: Date.now() - started, error: String(e && e.message || e) }
    }
  })()
}

function challengeLookupSnapshot(payload) {
  const { keyword, timeout = 9000 } = payload || {}
  return (async () => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const url = 'https://www.douyin.com/aweme/v1/web/challenge/search/?keyword=' + encodeURIComponent(keyword)
        + '&offset=0&count=10' + '&device_platform=webapp&aid=6383&channel=channel_pc_web'
      const r = await fetch(url, { credentials: 'include', signal: ctrl.signal })
      const text = await r.text(); clearTimeout(timer); let d = null; try { d = JSON.parse(text) } catch {}
      if (r.status === 401) return { ok: false, kind: 'LOGIN_REQUIRED', http: r.status }
      if (r.status === 403 || r.status === 429) return { ok: false, kind: 'ACCESS_RESTRICTED', http: r.status }
      if (!d) return { ok: false, kind: 'BAD_RESPONSE', http: r.status }
      if (d.status_code === 2483) return { ok: false, kind: 'LOGIN_REQUIRED', http: r.status, code: 2483 }
      if (d.status_code !== 0) return { ok: false, kind: 'API_ERROR', http: r.status, code: d.status_code,
        error: String(d.status_msg || d.message || '').slice(0, 160) }
      const topics = (d.challenge_list || []).map(c => {
        const info = c.challenge_info || c
        return { chId: String(info.cid || info.ch_id || ''), name: info.cha_name || null,
          viewCount: info.view_count == null ? null : info.view_count }
      }).filter(t => t.chId)
      return { ok: true, topics }
    } catch (e) { clearTimeout(timer); return { ok: false, kind: e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', error: String(e && e.message || e) } }
  })()
}

function topicAwemeSnapshot(payload) {
  const { chId, offset = 0, count = 10, timeout = 20000 } = payload || {}
  return (async () => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeout)
    const started = Date.now()
    try {
      const url = 'https://www.douyin.com/aweme/v1/web/challenge/aweme/?ch_id=' + encodeURIComponent(chId)
        + '&offset=' + offset + '&count=' + count + '&sort_type=0&cursor=' + offset + '&device_platform=webapp&aid=6383&channel=channel_pc_web'
      const r = await fetch(url, { credentials: 'include', signal: ctrl.signal })
      const text = await r.text(); clearTimeout(timer); let d = null; try { d = JSON.parse(text) } catch {}
      if (!d) return { ok: false, kind: 'BAD_RESPONSE', http: r.status, sample: text.slice(0, 120), ms: Date.now() - started }
      if (d.status_code === 2483) return { ok: false, kind: 'LOGIN_REQUIRED', code: 2483, ms: Date.now() - started }
      if (d.status_code !== 0) return { ok: false, kind: 'API_ERROR', code: d.status_code, ms: Date.now() - started }
      const items = (d.aweme_list || []).map((a, i) => {
        const au = a.author || {}, st = a.statistics || {}
        return { videoId: a.aweme_id || null, title: String(a.desc || '').trim() || null,
          authorId: au.sec_uid || null, authorName: au.nickname || null,
          likeCount: st.digg_count == null ? null : st.digg_count,
          commentCount: st.comment_count == null ? null : st.comment_count,
          publishAt: a.create_time ? new Date(a.create_time * 1000).toISOString() : null,
          position: offset + i }
      })
      return { ok: true, items, hasMore: d.has_more ? 1 : 0, nextOffset: offset + items.length, ms: Date.now() - started }
    } catch (e) { clearTimeout(timer); return { ok: false, kind: e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', ms: Date.now() - started, error: String(e && e.message || e) } }
  })()
}

// Only visible video cards from the requested page; never private React state or another page.
function visibleVideoSnapshot({ url } = {}) {
  const expected = new URL(url), actual = new URL(location.href)
  if (actual.origin !== expected.origin || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) return { ok: false, kind: 'WRONG_PAGE', items: [] }
  const body = String(document.body?.innerText || '')
  const visible = n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none' }
  if (detectVerification().challenge) return { ok: false, kind: 'CHALLENGE', items: [] }
  if (/访问过于频繁|请求过于频繁|访问受限/.test(body)) return {ok:false,kind:'ACCESS_RESTRICTED',items:[]}
  const items = [], seen = new Set()
  for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="]')) {
    if (!visible(a)) continue
    let target
    try { target = new URL(a.href, location.href) } catch { continue }
    const videoId = target.origin === expected.origin && (target.pathname.match(/^\/(?:video|note)\/(\d{8,24})\/?$/)?.[1] || (/^\d{8,24}$/.test(target.searchParams.get('modal_id') || '') ? target.searchParams.get('modal_id') : null))
    if (!videoId || seen.has(videoId)) continue
    seen.add(videoId)
    items.push({ videoId, videoUrl: /^\/(?:video|note)\//.test(target.pathname) ? target.origin + target.pathname : `https://www.douyin.com/video/${videoId}`, title: String(a.innerText || a.getAttribute('title') || a.querySelector('img')?.alt || '').trim().slice(0, 600), position: items.length })
  }
  return { ok: items.length > 0, kind: items.length ? 'OK' : 'EMPTY', items, hasMore: 0, nextOffset: null }
}

// 图文（/note/）与视频（/video/）混在搜索结果里；采集器只认视频页，这里按 aweme type 判断不可靠，
// 统一交给采集器打开后由错误码兜底，并在记录上标出 href 形态。
function normalizeVideoItem(item, source) {
  const videoId = String(item?.videoId || '').trim()
  if (!/^\d{8,24}$/.test(videoId)) return null
  return {
    videoId,
    videoUrl: String(item.videoUrl || '') === `https://www.douyin.com/note/${videoId}` ? item.videoUrl : `https://www.douyin.com/video/${videoId}`,
    title: item.title || null,
    authorId: item.authorId || null,
    authorName: item.authorName || null,
    likeCount: Number.isSafeInteger(item.likeCount) ? item.likeCount : null,
    commentCount: normalizeVideoCommentCount(item.commentCount),
    publishAt: item.publishAt || null,
    sources: [{
      sourceType: source.sourceType,
      query: source.query || null,
      topicId: source.topicId || null,
      position: Number.isSafeInteger(item.position) ? item.position : null,
      capturedAt: new Date().toISOString(),
    }],
  }
}

class VideoSources {
  constructor(engine) { this.engine = engine }

  async evalInPage(fn, payload, { timeout = 30000 } = {}) {
    const win = this.engine.ensureWindow()
    // 超时护栏：页面挂起（休眠唤醒、渲染器卡死、被导航走）时不能让批次永久等待。
    // 超时后 reject，由上层按阶段错误记录并停止批次；错误带上当前页面 URL 便于定位。
    let timer = null
    try {
      return await Promise.race([
        executePageScript(win, `(${fn.toString()})(${JSON.stringify(payload || {})})`, timeout),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const url = win.isDestroyed?.() ? '(窗口已销毁)' : String(win.webContents.getURL?.() || '(未知)')
            reject(new Error(`EVAL_TIMEOUT: 页内脚本 ${timeout}ms 未返回，页面可能挂起 | 当前URL: ${url}`))
          }, timeout)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // 页面加载完成后再读接口：接口依赖当前页面的登录态与 referer。
  async waitPageReady({ timeout = 20000, settle = 1200 } = {}) {
    const win = this.engine.ensureWindow()
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      let state = null
      try { state = await executePageScript(win, 'document.readyState') } catch {}
      if (state === 'complete') { await new Promise(resolve => setTimeout(resolve, settle)); return true }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    return false
  }

  async preparePage(url) {
    const result = await navigateReadable(this.engine.ensureWindow(), url)
    if (!result.ok) {
      const error = new Error(result.reason || result.code)
      error.code = result.code
      if (result.code === 'CHALLENGE') requestManualVerification(this.engine.douyin, this.engine.ensureWindow(), { source: '交友发现窗口' })
      throw error
    }
    return result
  }

  async requestVideos(fn, payload, url) {
    const state = await readPageState(this.engine.ensureWindow(), url)
    if (state?.code === 'CHALLENGE') requestManualVerification(this.engine.douyin, this.engine.ensureWindow(), { source: '交友发现窗口' })
    if (state?.code) return { ok: false, kind: state.code, error: '页面当前不可读取', items: [] }
    if (state?.ready) {
      const cards = await this.evalInPage(visibleVideoSnapshot, { url })
      if (cards?.ok && cards.items?.length) return { ...cards, fallback: 'visible_page' }
      if (cards?.kind === 'CHALLENGE') return cards
    }
    let result
    try { result = await this.evalInPage(fn, { ...payload, timeout: 20000 }) }
    catch (error) { result = { ok: false, kind: /TIMEOUT/.test(error.message) ? 'TIMEOUT' : 'NETWORK_ERROR', error: String(error.message).slice(0, 300) } }
    if (result?.kind === 'CHALLENGE') requestManualVerification(this.engine.douyin, this.engine.ensureWindow(), { source: '交友发现窗口' })
    if (result?.ok || !['TIMEOUT', 'NETWORK_ERROR', 'BAD_RESPONSE', 'API_ERROR'].includes(result?.kind)) return result
    // A failed interface is not evidence of an empty source. Read only cards already visible on this exact page.
    const current = await readPageState(this.engine.ensureWindow(), url)
    if (current?.code === 'CHALLENGE') requestManualVerification(this.engine.douyin, this.engine.ensureWindow(), { source: '交友发现窗口' })
    if (current?.code) return { ok: false, kind: current.code, error: result.error || result.kind, items: [] }
    if (!current?.ready) return result
    const visible = await this.evalInPage(visibleVideoSnapshot, { url })
    if (visible?.ok && visible.items?.length) return { ...visible, fallback: 'visible_page', originalKind: result.kind }
    return { ...result, fallback: 'visible_page_empty' }
  }

  async waitVisibleVideos(url, { timeout = 8000, interval = 400 } = {}) {
    const deadline = Date.now() + timeout
    let result = { ok:false, kind:'SEARCH_RESULTS_NOT_READY', items:[] }
    do {
      if (this.engine.destroyed || this.engine.douyin?._destroyed) return {ok:false,kind:'READ_CANCELLED',items:[]}
      result = await this.evalInPage(visibleVideoSnapshot, {url}, {timeout:Math.max(1,Math.min(2000,deadline-Date.now()))}).catch(error=>({ok:false,kind:'SEARCH_RESULTS_NOT_READY',items:[],error:String(error?.message || error).slice(0,150)}))
      if (result?.items?.length || ['CHALLENGE','LOGIN_REQUIRED','ACCESS_RESTRICTED','WRONG_PAGE'].includes(result?.kind)) return result
      if (Date.now() < deadline) await new Promise(resolve=>setTimeout(resolve,interval))
    } while (Date.now() < deadline)
    return result
  }

  async collectByKeyword(keyword, { limit = 10, maxPages = 1, startOffset = 0 } = {}) {
    const started = Date.now()
    const engine = this.engine
    const searchUrl = keywordSearchUrl(keyword)
    let preparationError = null
    try { await this.preparePage(searchUrl) }
    catch (error) { if (!['TIMEOUT','NETWORK_ERROR'].includes(error.code)) throw error; preparationError = error }
    let visible = await this.waitVisibleVideos(searchUrl)
    if (visible?.kind === 'CHALLENGE') requestManualVerification(this.engine.douyin, this.engine.ensureWindow(), {source:'关键词搜索窗口'})
    if (visible?.items?.length && !startOffset) {
      const videos = visible.items.slice(0,limit).map(item=>normalizeVideoItem(item,{sourceType:'keyword',query:keyword})).filter(Boolean)
      return {ok:true,kind:'OK',sourceType:'keyword',query:keyword,videos,pages:1,hasMore:0,nextOffset:null,
        events:[{page:1,ok:true,kind:'OK',items:videos.length,fallback:'visible_page',...(preparationError?{navigationWarning:preparationError.code}:{})}],ms:Date.now()-started}
    }
    if (['CHALLENGE','LOGIN_REQUIRED','ACCESS_RESTRICTED','WRONG_PAGE','READ_CANCELLED'].includes(visible?.kind)) return {ok:false,kind:visible.kind,sourceType:'keyword',query:keyword,videos:[],pages:0,events:[{kind:visible.kind}]}
    if (preparationError) throw preparationError
    const videos = [], events = []
    let offset = startOffset, pages = 0, hasMore = 1, kind = 'OK'
    while (pages < maxPages && videos.length < limit) {
      pages++
      const r = await this.requestVideos(keywordApiSnapshot, { keyword, offset, count: 10 }, keywordSearchUrl(keyword))
      events.push({ page: pages, offset, ok: !!r?.ok, kind: r?.kind || (r?.items?.length ? 'OK' : 'EMPTY'), items: r?.items?.length || 0, ms: r?.ms ?? null, error: String(r?.error || '').slice(0, 300), fallback: r?.fallback || null, originalKind: r?.originalKind || null })
      if (!r?.ok) { kind = r.kind || 'ERROR'; break }
      const items = r.items || []
      if (!items.length) { kind = r.hasMore ? 'EMPTY_UNEXPECTED' : 'EMPTY'; break }
      for (const item of items) {
        if (videos.length >= limit) break
        const record = normalizeVideoItem(item, { sourceType: 'keyword', query: keyword })
        if (record) videos.push(record)
      }
      hasMore = r.hasMore ? 1 : 0
      offset = Number.isSafeInteger(r.nextOffset) ? r.nextOffset : offset + items.length
      if (!hasMore) break
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    return { ok: ['OK', 'EMPTY'].includes(kind), kind, sourceType: 'keyword', query: keyword, videos, pages, hasMore, nextOffset: hasMore && offset > startOffset ? offset : null, events, ms: Date.now() - started }
  }

  async collectByTag(tag, { limit = 10, maxPages = 1, startOffset = 0 } = {}) {
    const started = Date.now()
    const engine = this.engine
    // 话题查询依赖抖音域的登录态与 referer：窗口不在 douyin.com 上时（如应用刚启动、
    // 休眠唤醒、上一批次结束在别的页面），必须先导航，否则页内 fetch 会挂起或被 CORS 拒绝。
    const win = engine.ensureWindow()
    const currentUrl = String(win.webContents.getURL?.() || '')
    if (!/^https:\/\/(www\.)?douyin\.com\//.test(currentUrl)) {
      await this.preparePage('https://www.douyin.com/')
    }
    const lookupEvents = []
    const blocked = new Set(['CHALLENGE', 'LOGIN_REQUIRED', 'ACCESS_RESTRICTED', 'READ_CANCELLED', 'WRONG_PAGE'])
    let lookup
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Respect visible account restrictions before any retry or normal search fallback.
      const current = String(win.webContents.getURL?.() || '')
      const state = await readPageState(win, current || 'https://www.douyin.com/').catch(() => null)
      if (blocked.has(state?.code)) { lookup = { ok: false, kind: state.code }; break }
      if (engine.destroyed || engine.douyin?._destroyed) { lookup = { ok:false, kind:'READ_CANCELLED' }; break }
      try { lookup = await this.evalInPage(challengeLookupSnapshot, { keyword: tag }, { timeout: 10000 }) }
      catch (error) { lookup = { ok:false, kind:/超时|TIMEOUT/.test(error.message) ? 'TIMEOUT' : 'NETWORK_ERROR', error:String(error.message).slice(0,160) } }
      lookupEvents.push({ topicLookup: lookup?.ok ? (lookup.topics?.length ? 'OK' : 'EMPTY') : lookup?.kind,
        attempt, code: lookup?.code ?? null, http: lookup?.http ?? null, error: String(lookup?.error || '').slice(0,160) })
      if (lookup?.ok || !['API_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'BAD_RESPONSE'].includes(lookup?.kind)) break
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400))
    }
    if (!lookup?.ok || !lookup.topics?.length) {
      const kind = lookup?.ok ? 'NO_TOPIC' : lookup?.kind || 'ERROR'
      if (kind === 'CHALLENGE') requestManualVerification(engine.douyin, win, { source:'交友发现窗口' })
      if (blocked.has(kind)) return { ok:false, kind, sourceType:'hashtag', query:tag, videos:[], pages:0,
        events:[...lookupEvents, {kind}], ms:Date.now()-started }
      // A failed topic lookup is not an empty tag: use normal public video search.
      // This is only a source fallback; search hits do not prove exact tag membership.
      let fallback
      try { fallback = await this.collectByKeyword('#' + tag, { limit, maxPages, startOffset }) }
      catch (error) { fallback = { ok:false, kind:error.code || 'ERROR', videos:[], pages:0, events:[{error:String(error.message).slice(0,160)}] } }
      return { ...fallback, sourceType:'hashtag', query:tag, topicId:null, lookupKind:kind,
        events:[...lookupEvents, {fallback:'tag_keyword_search', originalKind:kind}, ...(fallback.events || [])], ms:Date.now()-started }
    }
    const exact = lookup.topics.find(t => t.name === tag || t.name === '#' + tag)
    const topic = exact || lookup.topics[0]
    await this.preparePage(topicPageUrl(topic.chId))
    const videos = [], events = [...lookupEvents, { topicLookup: 'OK', chId: topic.chId, name: topic.name, candidates: lookup.topics.length }]
    let offset = startOffset, pages = 0, hasMore = 1, kind = 'OK'
    while (pages < maxPages && videos.length < limit) {
      pages++
      const r = await this.requestVideos(topicAwemeSnapshot, { chId: topic.chId, offset, count: 10 }, topicPageUrl(topic.chId))
      events.push({ page: pages, offset, ok: !!r?.ok, kind: r?.kind || (r?.items?.length ? 'OK' : 'EMPTY'), items: r?.items?.length || 0, ms: r?.ms ?? null, error: String(r?.error || '').slice(0, 300), fallback: r?.fallback || null, originalKind: r?.originalKind || null })
      if (!r?.ok) { kind = r.kind || 'ERROR'; break }
      const items = r.items || []
      if (!items.length) { kind = r.hasMore ? 'EMPTY_UNEXPECTED' : 'EMPTY'; break }
      for (const item of items) {
        if (videos.length >= limit) break
        const record = normalizeVideoItem(item, { sourceType: 'hashtag', query: tag, topicId: topic.chId })
        if (record) videos.push(record)
      }
      hasMore = r.hasMore ? 1 : 0
      offset = Number.isSafeInteger(r.nextOffset) ? r.nextOffset : offset + items.length
      if (!hasMore) break
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    return { ok: ['OK', 'EMPTY'].includes(kind), kind, sourceType: 'hashtag', query: tag, topicId: topic.chId, topicName: topic.name, videos, pages, hasMore, nextOffset: hasMore && offset > startOffset ? offset : null, events, ms: Date.now() - started }
  }
}

visibleVideoSnapshot = withVerificationTools(visibleVideoSnapshot)
module.exports = { visibleVideoSnapshot, VideoSources, keywordSearchUrl, topicPageUrl, keywordApiSnapshot, challengeLookupSnapshot, topicAwemeSnapshot, normalizeVideoItem }
