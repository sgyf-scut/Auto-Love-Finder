const { withVerificationTools } = require('./verification-dom.cjs')
// Runs in the logged-in public video page. No private API or interaction with
// comment actions; identity comes from the rendered author's link and row props.
// 空评论判定只在“评论区已展开且可见”时成立：
// 图文/视频页面尚未展开评论时，DOM 里已有隐藏的占位文案与隐藏的 comment-item，
// 若按 body.innerText 判定会误报“暂无评论”，导致整次收集 0 条结束。
// 注意：本文件的函数会被 toString() 后单独注入页面执行，所以辅助逻辑必须写在函数内部。
const { withNicknameTools } = require('../nickname-identity.cjs')

function commentAuthorSnapshot(expectedVideoId, limit = 20, options = {}) {
  const clean = (v, max = 1000) => String(v || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().slice(0, max)
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  const body = document.body?.innerText || ''
  const currentId = location.href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] || ''
  if (location.origin !== 'https://www.douyin.com' || currentId !== String(expectedVideoId)) return { wrongPage: true }
  if (/^\s*(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)/i.test(body)) return { serverError: body.trim().split('\n')[0].slice(0, 80) }
  // 抖音风控会把作品页替换成“验证码中间页”：正文为空、验证码渲染在跨域 iframe 里，
  // 只看 body.innerText 识别不到，必须按页面标题与 iframe 来源判定，否则会被误判成“没有评论”。
  if (detectVerification().challenge) return { challenge: true, verifyPage: true }
  if (/登录后.*(?:评论|查看)|请先登录/.test(body)) return { loginRequired: true }
  const canonical = v => {
    try {
      const u = new URL(v, location.href), m = /^\/user\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname)
      return u.origin === 'https://www.douyin.com' && !u.username && !u.password && m && m[1] !== 'self' ? { profileUrl: `https://www.douyin.com/user/${m[1]}`, platformUserId: m[1] } : null
    } catch { return null }
  }
  const richText = n => {
    if (!n) return ''
    if (n.nodeType === 3) return n.textContent || ''
    if (n.tagName === 'IMG') return n.getAttribute('alt') || ''
    return n.childNodes?.length ? [...n.childNodes].map(richText).join('') : n.innerText || n.textContent || ''
  }
  const rowProps = row => {
    const hint = row.querySelector('[id^="tooltip_"]')?.id?.match(/tooltip_(\d+)/)?.[1]
    for (const key of Object.keys(row).filter(k => k.startsWith('__reactProps') || k.startsWith('__reactFiber'))) {
      for (let f = row[key], d = 0; f && d < 3; f = f.return, d++) {
        const p = f.memoizedProps || f
        const c = p.commentInfo || p.comment
        if (c?.user && typeof c.text === 'string' && c.cid && (!hint || String(c.cid) === hint)) return c
      }
    }
    return null
  }
  const candidates = [], seen = new Set()
  let skipped = 0
  const rows = [...document.querySelectorAll('[data-e2e="comment-item"]')]
  for (const row of options.preferLower ? rows.slice(-60).reverse() : rows.slice(0, 60)) {
    if (!visible(row)) continue
    const info = row.querySelector('.comment-item-info-wrap, [data-e2e="comment-user-info"]')
    const links = [...(info?.querySelectorAll('a[href*="/user/"]') || [])].filter(a => a.closest('[data-e2e="comment-item"]') === row)
    const identities = new Map(links.map(a => [canonical(a.href)?.platformUserId, { identity: canonical(a.href), anchor: a }]).filter(([id]) => id))
    if (identities.size !== 1) { skipped++; continue }
    const { identity, anchor } = [...identities.values()][0]
    const props = rowProps(row)
    const propId = props?.user?.secUid || props?.user?.sec_uid
    if (propId && propId !== identity.platformUserId) { skipped++; continue }
    const nickname = clean(props?.user?.nickname || richText(anchor), 100)
    const textNode = row.querySelector('[data-e2e="comment-content"], [data-e2e="comment-text"], .FduGc_lz, [class*="comment-content"]')
    const commentText = clean(props?.text || richText(textNode), 1000)
    // Never treat a reply's body or a mentioned user's link as the top-level author.
    if (!nickname || !commentText || (textNode && textNode.closest('[data-e2e="comment-item"]') !== row)) { skipped++; continue }
    const commentId = clean(String(props?.cid || row.querySelector('[id^="tooltip_"]')?.id?.match(/tooltip_(\d+)/)?.[1] || ''), 100)
    const key = `${identity.platformUserId}|${commentId || commentText}`
    if (seen.has(key)) continue
    seen.add(key)
    const parentId = props?.replyId || props?.reply_id
    const replyCount = Number(props?.replyTotal ?? props?.reply_comment_total)
    candidates.push({ ...identity, platformUserIdType: 'sec_uid', platformNumericUserId: clean(props?.user?.uid, 50), nickname, commentId, commentText,
      isReply: !!parentId && String(parentId) !== '0', parentCommentId: parentId && String(parentId) !== '0' ? String(parentId) : '',
      replyCount: Number.isSafeInteger(replyCount) && replyCount >= 0 ? replyCount : null,
      avatarUrl: clean(row.querySelector('.comment-item-avatar img')?.src, 2000) })
    if (candidates.length >= Math.max(1, Math.min(30, Number(limit) || 20))) break
  }
  const panel = [...document.querySelectorAll('[data-e2e="comment-list"]')].find(visible) || null
  const empty = Boolean(panel) && /暂无评论|还没有评论|成为第一个评论|快来抢沙发/.test(String(panel.innerText || ''))
  return { ready: candidates.length > 0 || empty, empty, panelVisible: Boolean(panel), candidates, skipped, rows: rows.filter(visible).length, videoId: currentId }
}

// P2-10：先判断视频页是否可读评论，再决定是否滚动采集。
// 只读页面文案与 DOM 状态，不构造任何签名请求。
function videoCommentsState(expectedVideoId = null) {
  if (location.origin !== 'https://www.douyin.com') return { wrongPage: true }
  const body = document.body?.innerText || ''
  const currentId = location.href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] || ''
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  // 验证码中间页：正文为空 + 验证码在跨域 iframe，必须单独识别，否则会被当成“评论区没渲染”。
  if (detectVerification().challenge) return { challenge: true, verifyPage: true }
  if (expectedVideoId && currentId !== String(expectedVideoId)) return { wrongPage: true, videoId: currentId }
  if (/^\s*(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)/i.test(body)) return { serverError: body.trim().split('\n')[0].slice(0, 80) }
  if (/作品不存在|视频不存在|作品已删除|该作品已被删除|内容不存在|你访问的页面不见了|页面不存在/.test(body)) return { removed: true, reason: body.match(/作品不存在|视频不存在|作品已删除|该作品已被删除|内容不存在|你访问的页面不见了|页面不存在/)[0] }
  if (/评论已关闭|已关闭评论|作者已关闭|评论功能已关闭|暂不开放评论/.test(body)) return { commentsClosed: true, reason: body.match(/评论已关闭|已关闭评论|作者已关闭|评论功能已关闭|暂不开放评论/)[0] }
  if (/登录后.*(?:评论|查看)|请先登录/.test(body)) return { loginRequired: true }
  const rows = [...document.querySelectorAll('[data-e2e="comment-item"]')].filter(visible).length
  const panel = [...document.querySelectorAll('[data-e2e="comment-list"]')].find(visible) || null
  const empty = Boolean(panel) && /暂无评论|还没有评论|成为第一个评论|快来抢沙发/.test(String(panel.innerText || ''))
  // A readable title/sidebar is not evidence that the player has hydrated.
  // Media buffering is only a loading signal; visible comments always win.
  const media = [...document.querySelectorAll('video')].filter(visible)
  const buffering = media.some(v => Number.isFinite(v.readyState) && v.readyState < 2 && !v.error)
  const busy = [...document.querySelectorAll('.xgplayer-loading, [data-e2e="video-loading"], [data-e2e="video-player"] [aria-busy="true"]')].some(visible)
  const pageLoading = !panel && !rows && (document.readyState === 'loading' || buffering || busy)
  return { ready: rows > 0 || empty, rows, empty, panelVisible: Boolean(panel), totalRows: document.querySelectorAll('[data-e2e="comment-item"]').length,
    phase: rows > 0 ? 'COMMENTS_READY' : empty ? 'EMPTY' : panel ? 'PANEL_LOADING' : pageLoading ? 'PAGE_LOADING' : 'ENTRY_PENDING', videoId: currentId, pageLoading, mediaBuffering: buffering, loadingIndicator: busy, documentState: document.readyState || '' }
}

// P2-10 评论采集：读取页面上能看到的评论正文，作者标识只在可唯一确认时保留，
// 否则留空（仅用于学习，不进入候选池）。绝不猜测或拼接作者身份。
// P2-17B.2：同时读取评论级「IP属地」与「回复总数」。两者都是页面已有字段：
//   - IP属地只认两种证据：显式「IP属地：X」文案，或评论区元信息里整段等于省级名称（如「· 广东」）。
//     不拿主页所在地替代，也不从正文里认地区；取不到就返回 null 并标注 not_present。
//   - 回复总数取「展开N条回复」按钮文案或只读行属性；取不到返回 null（未知 ≠ 0）。
function collectCommentRows(expectedVideoId, limit = 60, options = {}) {
  const clean = (v, max = 1000) => String(v || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().slice(0, max)
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  const body = document.body?.innerText || ''
  const currentId = location.href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] || ''
  if (location.origin !== 'https://www.douyin.com' || currentId !== String(expectedVideoId)) return { wrongPage: true }
  if (/^\s*(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)/i.test(body)) return { serverError: body.trim().split('\n')[0].slice(0, 80) }
  // 验证码中间页会被替换成整页验证，没有任何评论 DOM；直接当“无评论”会给出错误结论。
  if (detectVerification().challenge) return { challenge: true, verifyPage: true }
  if (/登录后.*(?:评论|查看)|请先登录/.test(body)) return { loginRequired: true }
  if (/作品不存在|视频不存在|作品已删除|该作品已被删除|内容不存在|你访问的页面不见了|页面不存在/.test(body)) return { removed: true }
  if (/评论已关闭|已关闭评论|作者已关闭|评论功能已关闭|暂不开放评论/.test(body)) return { commentsClosed: true }
  if (options.authorTarget && /访问过于频繁|访问受限|请求过于频繁/.test(body)) return { accessRestricted: true }
  const REGION = /^(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门|海外|其他)(?:省|市|(?:壮族|回族|维吾尔)?自治区|特别行政区)?$/
  const canonical = v => {
    try {
      const u = new URL(v, location.href), m = /^\/user\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname)
      return u.origin === 'https://www.douyin.com' && !u.username && !u.password && m && m[1] !== 'self' ? { platformUserId: m[1] } : null
    } catch { return null }
  }
  const richText = n => {
    if (!n) return ''
    if (n.nodeType === 3) return n.textContent || ''
    if (n.tagName === 'IMG') return n.getAttribute('alt') || ''
    return n.childNodes?.length ? [...n.childNodes].map(richText).join('') : n.innerText || n.textContent || ''
  }
  const rowProps = row => {
    const hint = row.querySelector('[id^="tooltip_"]')?.id?.match(/tooltip_(\d+)/)?.[1]
    for (const key of Object.keys(row).filter(k => k.startsWith('__reactProps') || k.startsWith('__reactFiber'))) {
      for (let f = row[key], d = 0; f && d < 3; f = f.return, d++) {
        const p = f.memoizedProps || f
        const c = p.commentInfo || p.comment
        if (c?.text && typeof c.text === 'string' && (!hint || String(c.cid) === hint)) return c
      }
    }
    return null
  }
  // 评论元信息（时间/地区）与正文分开：先把正文从整行文本里剔除，避免正文里的地名被当成 IP。
  const ipOf = (row, textNode, contentText, info) => {
    let meta = String(row.innerText || '')
    const withoutInvisible = text => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '')
    meta = withoutInvisible(meta)
    for (const node of (row.querySelectorAll?.('[data-e2e="comment-item"]') || [])) {
      const nested = withoutInvisible(node.innerText)
      if (nested) meta = meta.replace(nested, ' ')
    }
    const bodyText = withoutInvisible(textNode?.innerText || (textNode ? contentText : ''))
    // If the displayed body cannot be isolated, do not infer metadata from the whole row.
    if (!bodyText || !meta.includes(bodyText)) return { ipLocation: null, ipLocationSource: 'not_present' }
    meta = meta.replace(bodyText, ' ')
    const author = withoutInvisible(info?.innerText)
    if (author) meta = meta.replace(author, ' ')
    const explicit = meta.match(/IP\s*属地\s*[:：]?\s*([^\s·•・|，,；;]{1,20})/)
    if (explicit) return { ipLocation: clean(explicit[1], 20), ipLocationSource: 'explicit_label' }
    const segments = meta.split(/[·•・⋅\n|]/).map(s => s.trim()).filter(Boolean)
    const hit = segments.find(s => REGION.test(s))
    return hit ? { ipLocation: hit, ipLocationSource: 'footer_region' } : { ipLocation: null, ipLocationSource: 'not_present' }
  }
  const replyCountOf = (row, props) => {
    const fromProps = Number(props?.replyTotal ?? props?.reply_comment_total)
    if (Number.isSafeInteger(fromProps) && fromProps >= 0) return fromProps
    const button = row.querySelector('button.comment-reply-expand-btn, [class*="reply-expand"]')
    const matched = String(button?.innerText || '').match(/展开\s*(\d+)\s*条回复/)
    const fromButton = matched ? Number(matched[1]) : NaN
    return Number.isSafeInteger(fromButton) && fromButton >= 0 ? fromButton : null
  }
  const rows = [...document.querySelectorAll('[data-e2e="comment-item"]')]
  const slice = options.authorTarget ? rows : options.preferLower ? rows.slice(-80).reverse() : rows.slice(0, 80)
  const output = [], seen = new Set()
  for (const row of slice) {
    if (!visible(row)) continue
    const info = row.querySelector('.comment-item-info-wrap, [data-e2e="comment-user-info"]')
    const links = [...(info?.querySelectorAll('a[href*="/user/"]') || [])].filter(a => a.closest('[data-e2e="comment-item"]') === row)
    const ids = new Set(links.map(a => canonical(a.href)?.platformUserId).filter(Boolean))
    const authorId = ids.size === 1 ? [...ids][0] : null
    const props = rowProps(row)
    const propUserId = props?.user ? (props.user.secUid || props.user.sec_uid) : null
    const reliableId = authorId && (!propUserId || propUserId === authorId) ? authorId : null
    const nickname = clean(props?.user?.nickname || (links[0] ? richText(links[0]) : ''), 100) || null
    const textNode = row.querySelector('[data-e2e="comment-content"], [data-e2e="comment-text"], .FduGc_lz, [class*="comment-content"]')
    const commentText = clean(props?.text || richText(textNode), 1000)
    if (!commentText || (textNode && textNode.closest('[data-e2e="comment-item"]') !== row)) continue
    const commentId = clean(String(props?.cid || row.querySelector('[id^="tooltip_"]')?.id?.match(/tooltip_(\d+)/)?.[1] || ''), 100) || null
    if (options.authorTarget) {
      const target = options.authorTarget
      if (commentId !== target.commentId) continue
      if (!reliableId && !propUserId && !authorId) return { authorEntryMissing: true }
      if (reliableId !== target.platformUserId) return { authorMismatch: true }
      const avatars = [...row.querySelectorAll('.comment-item-avatar a[href*="/user/"], a.comment-item-avatar[href*="/user/"]')]
      const entry = [...avatars, ...links].find(link => visible(link)
        && link.closest('[data-e2e="comment-item"]') === row && canonical(link.href)?.platformUserId === reliableId)
      if (!entry) return { authorEntryMissing: true }
      entry.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = entry.getBoundingClientRect()
      const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      const hit = document.elementFromPoint(point.x, point.y)
      if (!hit || !(hit === entry || entry.contains(hit))) return { authorEntryObscured: true }
      return { authorPoint: point }
    }
    const marker = commentId || `${textNode?.innerText || commentText}`
    if (seen.has(marker)) continue
    seen.add(marker)
    const parentId = props?.replyId || props?.reply_id
    const ip = ipOf(row, textNode, commentText, info)
    output.push({
      platformUserId: reliableId,
      nickname,
      commentId,
      commentText,
      isReply: !!parentId && String(parentId) !== '0',
      parentCommentId: parentId && String(parentId) !== '0' ? String(parentId) : '',
      replyCount: replyCountOf(row, props),
      ipLocation: ip.ipLocation,
      ipLocationSource: ip.ipLocationSource,
    })
    if (output.length >= Math.max(1, Math.min(80, Number(limit) || 60))) break
  }
  const panel = [...document.querySelectorAll('[data-e2e="comment-list"]')].find(visible) || null
  const empty = Boolean(panel) && /暂无评论|还没有评论|成为第一个评论|快来抢沙发/.test(String(panel.innerText || ''))
  return { ready: output.length > 0 || empty, empty, panelVisible: Boolean(panel), rows: output, shown: rows.filter(visible).length, videoId: currentId }
}

// 返回评论入口的屏幕坐标，由主进程发真实鼠标事件点击：
// 图文作品的评论图标只挂了 React 合成事件，脚本 .click() 在刚加载完时经常点不动。
function openCommentPanel(expectedVideoId, { activate = false } = {}) {
  if (location.origin !== 'https://www.douyin.com' || location.href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] !== String(expectedVideoId)) return { wrongPage: true }
  const visible = n => {
    if (!n) return false
    const r = n.getBoundingClientRect(), s = typeof getComputedStyle === 'function' ? getComputedStyle(n) : null
    return r.width > 0 && r.height > 0 && (!s || s.visibility !== 'hidden' && s.display !== 'none')
  }
  if (detectVerification().challenge) return { challenge: true }
  if (activate) document.querySelectorAll('video').forEach(v => { v.pause(); v.muted = true })
  if ([...document.querySelectorAll('[data-e2e="comment-item"]')].some(visible)) return { ready: true }
  // An already opened loading/empty list must never be toggled shut by a retry.
  if ([...document.querySelectorAll('[data-e2e="comment-list"]')].some(visible)) return { opened: true, panelVisible: true }
  const label = n => String(n.innerText || '').trim()
  const exactTab = value => /^评论\s*[（(]\s*\d[\d,.]*(?:万|亿|[wWkK])?\s*[）)]$/.test(value)
  const target = (node, source) => {
    try { node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) } catch {}
    const r = node.getBoundingClientRect()
    const point = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    const outside = point.x < 0 || point.y < 0 || typeof innerWidth === 'number' && point.x >= innerWidth || typeof innerHeight === 'number' && point.y >= innerHeight
    const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(point.x, point.y) : null
    if (outside || hit && hit !== node && !node.contains?.(hit)) return { opened: false, blocked: true, reason: 'entry_obscured', source }
    if (activate && typeof node.click === 'function') { node.click(); return { opened: true, activated: true, source } }
    return { opened: true, point, source }
  }
  const tabs = [...document.querySelectorAll('[role="tab"], button, span, div')].filter(n => visible(n) && exactTab(label(n)))
    .filter(n => !Array.from(n.children || []).some(child => exactTab(label(child))))
  if (tabs.length > 1) return { opened: false, ambiguous: true, reason: 'ambiguous_entry' }
  if (tabs.length === 1) return target(tabs[0], 'comments_tab')
  for (const selector of ['[data-e2e="video-player-comment"]', '[data-e2e="feed-comment-icon"]', '[data-e2e="comment-icon"]', '[data-e2e="comment-count"]']) {
    const controls = [...document.querySelectorAll(selector)].filter(visible)
    if (controls.length === 1) return target(controls[0], 'comment_icon')
  }
  const labelled = [...document.querySelectorAll('button[aria-label], [role="button"][aria-label], button[title], [role="button"][title]')]
    .filter(n => visible(n) && /^(?:查看)?评论(?:\s*[（(]?\s*\d[\d,.]*(?:万|亿)?\s*[）)]?)?$/.test(String(n.getAttribute('aria-label') || n.getAttribute('title') || '').trim()))
  if (labelled.length === 1) return target(labelled[0], 'accessible_comment_button')
  if (labelled.length > 1) return { opened: false, reason: 'ambiguous_entry' }
  return { opened: false, reason: 'entry_not_ready' }
}

// Public DOM only: do not turn hidden React demographic fields into facts.
function publicProfileSnapshot(expectedUrl) {
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  const body = document.body?.innerText || ''
  const pageUrl = location.origin + location.pathname.replace(/\/$/, '')
  const documentKey = typeof performance !== 'undefined' ? String(performance.timeOrigin || '') : ''
  if (detectVerification().challenge) return { challenge: true, pageUrl, documentKey }
  if (pageUrl !== expectedUrl) return { wrongPage: true, pageUrl, documentKey }
  if (/^\s*(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)/i.test(body)) return { serverError: body.trim().split('\n')[0].slice(0,80), pageUrl, documentKey }
  const header = document.querySelector('[data-e2e="user-info"]')
  if (!visible(header)) {
    // A terminal page is not a slow profile or an unpublished demographic field.
    // Require an exact visible line and no public header; biography/comments may quote it.
    const unavailableText = body.split(/\r?\n/).map(line => line.trim()).find(line => /^(?:用户不存在|该用户不存在|你访问的用户不存在)$/.test(line))
    return { ready: false, pageUrl, documentKey, documentState: document.readyState || '', loginRequired: /登录后查看|请先登录/.test(body),
      ...(unavailableText ? { unavailable: true, unavailableText } : {}) }
  }
  const title = header.querySelector('[data-e2e="user-title"], [class*="nickname"], [class*="Nickname"], h1')
  const name = (title?.innerText || '').trim().slice(0, 100)
  // Route changes can precede header hydration. Only the header's own account
  // identity binds these public fields; neither the URL nor its nickname does.
  const expectedId = expectedUrl.split('/').at(-1)
  const proof = nicknameTools().profileProof(header, expectedId, name)
  const rawText = (header.parentElement?.innerText || header.innerText || '').trim().slice(0, 1800)
  const genderLabels = [...(header.parentElement?.querySelectorAll?.('[aria-label], [title]') || [])].filter(visible)
    .map(n => n.getAttribute('aria-label') || n.getAttribute('title')).filter(t => /^(?:性别[:：]?\s*)?(?:男|女|男性|女性)$/.test(t || ''))
  const genders = [...new Set(genderLabels.map(t => t.replace(/^性别[:：]?\s*/, '')[0]))]
  // 主页正文里有时只显示“性别：女”，没有 aria-label；仍只认带“性别”前缀的公开文字。
  // 抖音还常把性别渲染成无前缀的独立一行（如 “IP属地：江苏\n女\n”），此时只认整行完全等于
  // 男/女、且全页只有一种值的情形；出现多种值或混在句子里都不采信，避免把简介文字当性别。
  const bareLines = [...new Set(rawText.split('\n').map(line => line.trim()).filter(line => /^(?:女性|男性|女|男)$/.test(line)))]
  const explicit = [...rawText.matchAll(/(?:^|\n)\s*性别\s*[:：]?\s*(女性|男性|女|男)\s*(?=\n|$)/g)].map(hit => hit[1][0])
  // Only explicit, visible semantic icon identifiers. Never infer from color,
  // avatar, nickname, arbitrary SVG geometry or hidden account demographic data.
  const iconEvidence = []
  for (const node of [...(header.parentElement?.querySelectorAll?.('svg, svg use, [data-icon], [data-e2e]') || [])]) {
    const shown = node.tagName?.toLowerCase() === 'use' ? node.closest?.('svg') : node
    if (!visible(shown)) continue
    const ids = ['data-icon','data-e2e','id','href','xlink:href'].map(key => node.getAttribute?.(key) || '')
    for (const id of ids) {
      const match = /^(?:#)?(?:icon[-_])?(?:(?:user|profile|gender|sex)[-_])?(female|male|woman|man)(?:[-_]icon)?$/i.exec(id)
      if (match) iconEvidence.push({ value: /^(?:female|woman)$/i.test(match[1]) ? '女' : '男', source: 'visible_semantic_icon', label: id.slice(0,100) })
    }
  }
  const observed = new Set([...genders, ...explicit, ...bareLines.map(label => label[0]), ...iconEvidence.map(x => x.value)])
  const metadataLoading = [...(header.parentElement?.querySelectorAll?.('[aria-busy="true"], [data-e2e="user-info-loading"]') || [])].some(visible)
  const ageEvidenceTexts = [...(header.parentElement?.querySelectorAll?.('[aria-label], [title], [data-e2e="user-age"], [data-e2e="user-birthday"]') || [])].filter(visible)
    .map(n => { const text = n.getAttribute?.('aria-label') || n.getAttribute?.('title') || n.innerText || ''; return n.getAttribute?.('data-e2e') === 'user-birthday' && !/^(?:生日|出生日期|出生年月日)/.test(text) ? '生日：' + text : text }).filter(t => /^(?:年龄|生日|出生日期|出生年月日)\s*[:：]?/.test(t) || /^\d{1,3}\s*岁$/.test(t)).slice(0,12).map(t => String(t).slice(0,120))
  return { documentState: document.readyState || '', pageUrl, documentKey, metadataLoading, ready: Boolean(name && proof.verified), hasHeader: true,
    identityStatus: proof.conflicting ? 'mismatch' : proof.verified ? 'verified' : 'pending', observedPlatformUserIds: proof.ids,
    genderEvidence: [...genderLabels.map(label => ({source:'visible_label', label})), ...iconEvidence].slice(0,12),
    unlabelledIconCount: [...(header.parentElement?.querySelectorAll?.('svg') || [])].filter(visible).length,
    profileUrl: expectedUrl, platformUserId: proof.verified ? expectedId : '', nickname: name, rawText, ageEvidenceTexts,
    ...(observed.size === 1 ? { genderText: [...observed][0] } : {}), genderConflict: observed.size > 1 }

}

function advanceCommentViewport(expectedVideoId, { initialize = false, expandReplies = false } = {}) {
  if (location.origin !== 'https://www.douyin.com' || location.href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] !== String(expectedVideoId)) return { wrongPage: true }
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  // 页面上可能同时存在隐藏与可见的 comment-list（图文作品点开后才有可见的那个），必须选可滚动的那个。
  const lists = [...document.querySelectorAll('[data-e2e="comment-list"]')]
  const visibleList = lists.find(visible) || null
  const list = visibleList || lists[0] || document.querySelector('[data-e2e="comment-item"]')?.parentElement
  if (!list) return { ready: false }
  if (initialize) list.scrollIntoView?.({ block: 'start' })
  let container = visibleList || list
  while (container && container !== document.body) {
    if (container.scrollHeight > container.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(container).overflowY)) break
    container = container.parentElement
  }
  if (!initialize) {
    if (container && container !== document.body) container.scrollTop += Math.max(300, Math.round(container.clientHeight * 0.85))
    else window.scrollBy(0, Math.max(350, window.innerHeight * 0.7))
  }
  const scrollTop = container && container !== document.body ? Math.round(container.scrollTop) : null
  const scrollHeight = container && container !== document.body ? container.scrollHeight : null
  let expanded = 0
  if (expandReplies) {
    const buttons = [...list.querySelectorAll('button.comment-reply-expand-btn')].filter(b => {
      const r = b.getBoundingClientRect()
      return r.width && r.height && r.bottom > 0 && r.top < window.innerHeight && /^展开\d+条回复$/.test(b.innerText.trim()) && !b.dataset.discoveryExpanded
    }).sort((a, b) => Number(a.innerText.match(/\d+/)?.[0]) - Number(b.innerText.match(/\d+/)?.[0]))
    for (const b of buttons.slice(0, 2)) { b.dataset.discoveryExpanded = '1'; (b.querySelector?.('span') || b).click(); expanded++ }
  }
  return { ready: true, expanded, scrollTop, scrollHeight }
}
function prioritizeComments(rows, { preferLowReplies = false, includeReplies = false, preferLowerComments = false } = {}) {
  const priority = c => (preferLowReplies ? c.replyCount === 0 ? 4 : c.replyCount <= 2 && c.replyCount !== null ? 2 : c.replyCount == null ? 0 : -Math.min(c.replyCount, 100) / 100 : 0)
    + (includeReplies && c.isReply ? 3 : 0) + (preferLowerComments ? Math.min(Number(c.scrollDepth) || 0, 8) * 0.5 : 0)
  return rows.filter(c => includeReplies || !c.isReply).sort((a, b) => priority(b) - priority(a))
}
function scoreCommentCandidate(text) {
  const t = String(text || '').trim(), signals = []
  let score = 0.25
  if (/认识.{0,5}朋友|想.{0,5}(?:交友|交朋友|认识)|找对象|蹲.{0,5}(?:朋友|对象)|求.{0,4}交友|脱单|找.{0,3}搭子/.test(t)) { score += 0.45; signals.push('评论含交友意愿相关表达') }
  if (/研究生|研[一二三]|本科生|大学生/.test(t)) { score += 0.15; signals.push('评论含学习身份相关字样，待人工核实') }
  if (/摄影|旅行|篮球|音乐|游戏|猫|狗|宠物|羽毛球/.test(t)) { score += 0.1; signals.push('评论提到兴趣话题') }
  if (/^(?:哈+|6+|来了|不错|好看|[\p{Extended_Pictographic}\s]+)$/u.test(t)) { score = 0.05; signals.push('短互动评论，信息较少') }
  return { score: Math.min(1, score), signals, reason: signals.join('；') || '有可核对的评论来源，身份与交友意愿待查看' }
}

function parseFollowerCount(raw) {
  const match = String(raw || '').match(/(?:^|\n)\s*粉丝\s*[:：]?\s*\n?\s*(\d[\d,]*(?:\.\d+)?\s*(?:万|千|[wWkK])?)(?=\s*(?:\n|$))/)
  if (!match) return null
  const value = match[1].replace(/[\s,]/g, ''), unit = value.match(/[万千wWkK]$/)?.[0]
  const number = Number(value.replace(/[万千wWkK]$/, '')) * (unit ? /[万wW]/.test(unit) ? 10000 : 1000 : 1)
  // Abbreviated zero cannot prove there are no followers.
  return Number.isSafeInteger(number) && number >= 0 && !(unit && number === 0) ? number : null
}
function summarizePublicProfile(profile) {
  const raw = String(profile.rawText || ''), evidence = []
  const match = (field, pattern) => { const value = raw.match(pattern)?.[1] || null; if (value) evidence.push({ field, text: value, source: 'public_profile_text' }); return value }
  const ageText = match('ageText', /年龄\s*[:：]\s*(\d{1,3}(?:岁)?)\s*(?=\n|$)/) || match('ageText', /(?:^|\n)\s*(\d{1,3}岁)\s*(?=\n|$)/)
  const age = ageText ? Number(ageText.replace('岁', '')) : null
  const checked = profile.publicAge
  return { ageText: checked ? checked.age === null ? null : `${checked.age}岁` : ageText, age: checked ? checked.age : Number.isSafeInteger(age) && age >= 1 && age <= 120 ? age : null,
    ...(checked ? { publicAgeChecked: true, ageConflict: checked.status === 'conflict', ageEvidence: checked.evidence } : {}),
    ...(profile.genderConflict ? { genderConflict: true } : {}),
    genderText: Object.hasOwn(profile, 'genderConflict') ? (profile.genderText || null) : match('genderText', /(?:性别)\s*[:：]\s*([^\n]{1,12})/) || match('genderText', /(?:^|\n)\s*(女性|男性|女|男)\s*(?=\n|$)/) || (/^(?:女性|男性|女|男)$/.test(profile.genderText || '') ? profile.genderText : null),
    followerCount: parseFollowerCount(raw),
    school: match('school', /(?:学校|院校)\s*[:：]\s*([^\n]{1,40})/),
    education: match('education', /((?:研[一二三]|研究生|本科生|大学生))/),
    city: match('city', /(?:现居|居住地|坐标)\s*[:：]\s*([^\n]{1,30})/),
    ipLocation: match('ipLocation', /IP属地\s*[:：]\s*([^\n]{1,30})/i), interests: [], evidence }
}
// P2-17B.2 按需读取某条评论的回复：默认只显示回复总数，用户点开才调用这里。
// 只读页面已渲染的回复，不构造接口；视频 ID 与评论 ID 都必须核对，避免把别人的回复挂错卡片。
function readCommentReplies(expectedVideoId, expectedCommentId, { cursor = 0, pageSize = 10 } = {}) {
  const clean = (v, max = 1000) => String(v || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().slice(0, max)
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  if (location.origin !== 'https://www.douyin.com') return { ok: false, code: 'WRONG_PAGE' }
  const currentId = location.href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1] || ''
  if (String(currentId) !== String(expectedVideoId)) return { ok: false, code: 'WRONG_PAGE', videoId: currentId }
  if (!expectedCommentId) return { ok: false, code: 'COMMENT_ID_MISSING' }
  const body = document.body?.innerText || ''
  if (detectVerification().challenge) return { ok: false, code: 'CHALLENGE' }
  if (detectVerification().challenge) return { ok: false, code: 'CHALLENGE' }
  const rowProps = row => {
    const hint = row.querySelector('[id^="tooltip_"]')?.id?.match(/tooltip_(\d+)/)?.[1]
    for (const key of Object.keys(row).filter(k => k.startsWith('__reactProps') || k.startsWith('__reactFiber'))) {
      for (let f = row[key], d = 0; f && d < 3; f = f.return, d++) {
        const p = f.memoizedProps || f
        const c = p.commentInfo || p.comment
        if (c?.text && typeof c.text === 'string' && (!hint || String(c.cid) === hint)) return c
      }
    }
    return null
  }
  const rows = [...document.querySelectorAll('[data-e2e="comment-item"]')]
  if (!rows.some(visible) && !document.querySelector('[data-e2e="comment-list"]')) return { ok: false, code: 'COMMENTS_NOT_LOADED' }
  const rowOf = id => rows.find(row => String(rowProps(row)?.cid || row.querySelector('[id^="tooltip_"]')?.id?.match(/tooltip_(\d+)/)?.[1] || '') === String(id))
  const target = rowOf(expectedCommentId)
  if (!target) return { ok: false, code: 'COMMENT_NOT_FOUND' }
  const expandButton = [...target.querySelectorAll('button.comment-reply-expand-btn, [class*="reply-expand"]')]
    .find(b => /^\s*展开\s*\d+\s*条回复\s*$/.test(String(b.innerText || '')))
  const totalFromButton = Number(String(expandButton?.innerText || '').match(/(\d+)/)?.[1])
  const totalFromProps = Number(rowProps(target)?.replyTotal ?? rowProps(target)?.reply_comment_total)
  const total = Number.isSafeInteger(totalFromProps) && totalFromProps >= 0 ? totalFromProps
    : Number.isSafeInteger(totalFromButton) ? totalFromButton : null
  // 未展开：把按钮坐标交回主进程用真实鼠标事件点开（React 合成事件对脚本 click 不敏感）。
  if (expandButton && !expandButton.dataset.discoveryExpanded) {
    const r = expandButton.getBoundingClientRect()
    if (r.width && r.height) {
      return { ok: false, code: 'NEED_EXPAND', total, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
    }
  }
  const replies = []
  for (const row of rows) {
    if (!visible(row)) continue
    const props = rowProps(row)
    const parentId = props?.replyId || props?.reply_id
    if (!parentId || String(parentId) !== String(expectedCommentId)) continue
    const text = clean(props?.text || row.querySelector('[data-e2e="comment-content"], [data-e2e="comment-text"], [class*="comment-content"]')?.innerText, 500)
    if (!text) continue
    replies.push({
      replyId: clean(String(props?.cid || ''), 100) || null,
      author: clean(props?.user?.nickname || row.querySelector('a[href*="/user/"]')?.innerText, 100) || null,
      text,
    })
  }
  // 去重：同一条回复可能在虚拟列表里被重复渲染。
  const seen = new Set(), unique = []
  for (const item of replies) {
    const key = item.replyId || `${item.author || ''}\u0000${item.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  const start = Math.max(0, Number(cursor) || 0)
  const page = unique.slice(start, start + Math.max(1, Number(pageSize) || 10))
  return {
    ok: true, videoId: String(expectedVideoId), commentId: String(expectedCommentId),
    total: total === null ? unique.length : total, loaded: unique.length,
    replies: page, cursor: start + page.length, hasMore: start + page.length < unique.length,
    expanded: Boolean(expandButton?.dataset.discoveryExpanded),
  }
}

commentAuthorSnapshot = withVerificationTools(commentAuthorSnapshot)
videoCommentsState = withVerificationTools(videoCommentsState)
collectCommentRows = withVerificationTools(collectCommentRows)
readCommentReplies = withVerificationTools(readCommentReplies)
openCommentPanel = withVerificationTools(openCommentPanel)
publicProfileSnapshot = withVerificationTools(publicProfileSnapshot)
module.exports = { commentAuthorSnapshot, videoCommentsState, collectCommentRows, readCommentReplies, openCommentPanel, advanceCommentViewport, prioritizeComments, publicProfileSnapshot: withNicknameTools(publicProfileSnapshot), scoreCommentCandidate, summarizePublicProfile, parseFollowerCount }
