// P2-11A 收藏夹读取：只读取当前已登录页面已经渲染出来的收藏夹内容。
// 不构造签名接口、不绕过登录/验证、不读取用户没有指定的收藏夹。
// 注意：注入页面的函数会被 toString() 单独执行，内部辅助逻辑必须写在函数体内。

const FAVORITES_URL = 'https://www.douyin.com/user/self?showTab=favorite_collection&showSubTab=favorite_folder'
const VIDEO_HREF = /^https:\/\/www\.douyin\.com\/(?:video|note)\/(\d{6,30})\/?$/i

const cleanLabel = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim()

// 收藏夹卡片文案通常是「恋爱视频，共62作品」，也可能只写名称。
// 只把「名称 + 可选的作品数」当作一张收藏夹卡片，避免把页面其他文字误认为分类。
function parseFolderLabel(value) {
  const text = cleanLabel(value)
  if (!text) return null
  const match = text.match(/^(.+?)[，,、·|]?(?:共)?(\d{1,6})(?:个)?作品$/)
  if (match && match[1]) return { name: match[1], count: Number(match[2]) }
  return { name: text, count: null }
}

// 名称必须完全一致；用户输入里带「，共62作品」也允许，但不会做模糊包含匹配。
function folderNameMatches(label, folderName) {
  const target = parseFolderLabel(folderName)
  const card = parseFolderLabel(label)
  if (!target || !card) return false
  return card.name === target.name
}

// 收藏夹页面是否可用：只做安全/登录/权限判断，不判断是否已选中分类。
function favoritesPageState() {
  if (location.origin !== 'https://www.douyin.com') return { wrongPage: true }
  const body = document.body?.innerText || ''
  if (/^\s*(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)/i.test(body)) {
    return { serverError: body.trim().split('\n')[0].slice(0, 80) }
  }
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  // 验证码中间页：正文可能为空，验证码在跨域 iframe 里，必须单独识别。
  if (document.title.trim() === '验证码中间页' || Boolean(document.querySelector('iframe[src*="rmc.bytedance.com/verifycenter"]'))) {
    return { challenge: true, verifyPage: true }
  }
  if ([...document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="verify"]')].some(visible)
    || /请完成.*验证|验证后继续|拖动滑块|本次登录需进行校验/.test(body)) return { challenge: true }
  if (/暂无权限|无访问权限|访问受限|操作过于频繁|请求过于频繁/.test(body)) {
    return { blocked: true, reason: body.match(/暂无权限|无访问权限|访问受限|操作过于频繁|请求过于频繁/)[0] }
  }
  if (/登录后查看|请先登录|登录后查看更多/.test(body) && !document.querySelector('[data-e2e="user-info"]')) {
    return { loginRequired: true }
  }
  return { ready: true, favoritesUrl: /showTab=favorite_collection/.test(location.href) }
}

// 返回「收藏夹」子分类的位置与选中状态；由主进程发真实鼠标事件点击。
function favoritesSubTabPoint() {
  if (location.origin !== 'https://www.douyin.com') return { wrongPage: true }
  const norm = value => String(value || '').replace(/\s+/g, '').trim()
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  const area = n => { const r = n.getBoundingClientRect(); return r.width * r.height }
  const nodes = [...document.querySelectorAll('[role="tab"], button, a, div, span')]
    .filter(n => visible(n) && norm(n.innerText) === '收藏夹')
    .sort((left, right) => area(left) - area(right))
  const tab = nodes[0] || null
  if (!tab) return { found: false }
  const selected = tab.getAttribute('aria-selected') === 'true'
    || /active|selected/i.test(String(tab.className || ''))
    || Boolean(tab.closest('[aria-selected="true"]'))
  const rect = tab.getBoundingClientRect()
  return { found: true, selected, point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } }
}

// 在收藏夹分类里按名称找卡片，返回点击坐标与声明作品数。
// 只有带「共 N 作品」的短文案才算收藏夹卡片：页脚、侧栏图标等文案一律不当作分类。
// 同一张卡片有多层祖先共享同一段文案；按「名称 + 左上角」聚合，取最小的一层做名称来源，
// 再向上找 cursor:pointer 的可点击层。整张 UL 常常比卡片宽得多，直接点 UL 中心会落到空白处。
// 卡片仍在渲染时返回 FOLDER_LIST_NOT_READY（可以继续等），确实没有该名称时才返回 FOLDER_NOT_FOUND。
function favoritesFolderEntry(folderName) {
  if (location.origin !== 'https://www.douyin.com') return { wrongPage: true }
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  const compact = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '')
  const parse = text => {
    const value = compact(text)
    if (!value) return null
    const match = value.match(/^(.+?)[，,、·|]?(?:共)?(\d{1,6})(?:个)?作品$/)
    if (match && match[1] && !/^共$/.test(match[1])) return { name: match[1], count: Number(match[2]) }
    return { name: value, count: null }
  }
  const box = n => n.getBoundingClientRect()
  const area = n => { const r = box(n); return r.width * r.height }
  const cursorOf = n => { try { return getComputedStyle(n).cursor } catch { return '' } }
  const target = parse(folderName)
  if (!target?.name) return { ok: false, code: 'FOLDER_REQUIRED', reason: '请填写收藏夹名称' }

  // 1) 收集所有“完整卡片文案”节点：文案很短且含「共 N 作品」。
  const nodes = []
  for (const node of document.querySelectorAll('div, li, a, section, p')) {
    if (!visible(node)) continue
    const text = String(node.innerText || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length > 60) continue
    const label = parse(text)
    if (!label?.name || label.count === null) continue
    const rect = box(node)
    // 只包住几个字的小节点不是卡片主体。
    if (rect.width < 120 || rect.height < 60) continue
    nodes.push({ node, label, rect, area: rect.width * rect.height })
  }
  if (!nodes.length) {
    // 只认明确的空状态文案；“创建收藏夹”按钮始终存在，不能当作没有收藏夹。
    if (/暂无收藏夹|还没有收藏夹/.test(document.body?.innerText || '')) {
      return { ok: false, code: 'FOLDER_NOT_FOUND', reason: '当前没有可用的收藏夹', folders: [] }
    }
    return { ok: false, code: 'FOLDER_LIST_NOT_READY', reason: '收藏夹列表还没有渲染完成' }
  }
  // 2) 同一张卡片的多层祖先按「名称 + 左上角」聚成一个卡片，保留面积最小的一层。
  const groups = new Map()
  for (const item of nodes) {
    const key = `${item.label.name}|${Math.round(item.rect.left / 8)}|${Math.round(item.rect.top / 8)}`
    const prev = groups.get(key)
    if (!prev || item.area < prev.area) groups.set(key, item)
  }
  const cards = [...groups.values()]
  const names = [...new Set(cards.map(card => card.label.name))]
  const matches = cards.filter(card => card.label.name === target.name)
  if (matches.length > 1) {
    // 同名卡片无法可靠区分，停止而不是猜测。
    return { ok: false, code: 'FOLDER_AMBIGUOUS', reason: `找到 ${matches.length} 个名为「${target.name}」的收藏夹，无法可靠判断要读取哪一个`, folders: names }
  }
  const match = matches[0] || null
  if (!match) {
    return { ok: false, code: 'FOLDER_NOT_FOUND', reason: `当前页没有名为「${target.name}」的收藏夹`, folders: names, listReady: true }
  }

  // 3) 找真正可点击的层：从文案节点向上最近的 cursor:pointer 祖先；没有就退回卡片节点自身。
  let clickable = match.node
  let node = match.node
  for (let depth = 0; node && node !== document.body && depth < 6; depth += 1) {
    if (cursorOf(node) === 'pointer') { clickable = node; break }
    node = node.parentElement
  }

  // 4) 收藏夹可能在列表下方：先滚到可见区域，再按可点击层的实际坐标计算中心点。
  let rect = box(clickable)
  const inView = r => r.top >= 0 && r.left >= 0 && r.top <= window.innerHeight - 40 && r.left <= window.innerWidth - 40
  if (!inView(rect)) {
    try { clickable.scrollIntoView({ block: 'center', inline: 'center' }) } catch { /* 忽略滚动失败 */ }
    rect = box(clickable)
  }
  const clamp = (value, max) => Math.max(1, Math.min(Math.round(value), Math.max(1, max - 2)))
  // 卡片右侧常有大片空白：用命中测试确认坐标确实落在卡片里，否则在卡片内部取样。
  const hitsCard = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x < 0 || y < 0 || x > window.innerWidth - 1 || y > window.innerHeight - 1) return false
    const hit = document.elementFromPoint(x, y)
    return Boolean(hit && (hit === clickable || clickable.contains(hit)))
  }
  const samples = [[0, 0], [0, -0.3], [0, 0.3], [-0.3, 0], [0.3, 0], [-0.25, -0.25], [0.25, 0.25]]
  const candidates = samples.map(([dx, dy]) => ({
    x: clamp(rect.left + rect.width * (0.5 + dx), window.innerWidth),
    y: clamp(rect.top + rect.height * (0.5 + dy), window.innerHeight),
  }))
  const point = candidates.find(item => hitsCard(item.x, item.y)) || candidates[0]
  const hit = document.elementFromPoint(point.x, point.y)
  return {
    ok: true, name: match.label.name, count: match.label.count, point,
    clickable: { tag: clickable.tagName, cls: String(clickable.className || '').slice(0, 80), rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } },
    hit: hit ? { tag: hit.tagName, cls: String(hit.className || '').slice(0, 80) } : null,
  }
}

// 读取当前打开收藏夹里已渲染的作品卡片。只有出现「返回」才认为确实进入了某个收藏夹，
// 避免把收藏夹总览页里的其他作品当成目标分类。
// 页面底部的“相关推荐”等文字链也是 a[href]（高度只有十几像素、没有封面图），必须排除；
// 只读同一个作品网格里的封面卡，避免把页脚或其他区域的作品混进指定收藏夹。
function readFavoriteVideos() {
  if (location.origin !== 'https://www.douyin.com') return { wrongPage: true }
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim()
  const body = document.body?.innerText || ''
  const backVisible = [...document.querySelectorAll('button, a, div, span')]
    .some(node => visible(node) && norm(node.innerText) === '返回')

  const candidates = []
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!visible(anchor)) continue
    const rect = anchor.getBoundingClientRect()
    if (rect.height < 60) continue
    if (anchor.closest('footer')) continue
    if (!anchor.querySelector('img')) continue
    let url = null
    try { url = new URL(anchor.href, location.href) } catch { url = null }
    if (!url || url.origin !== 'https://www.douyin.com') continue
    const match = url.pathname.match(/^\/(video|note)\/(\d{6,30})\/?$/)
    if (!match) continue
    candidates.push({ anchor, kind: match[1], videoId: match[2] })
  }

  // 作品网格通常是同一个 UL：取包含最多封面卡的 UL，其他区域的零星视频不参与。
  const lists = new Map()
  for (const item of candidates) {
    const list = item.anchor.closest('ul')
    if (!list || !visible(list)) continue
    const bucket = lists.get(list) || []
    bucket.push(item)
    lists.set(list, bucket)
  }
  let best = null
  for (const bucket of lists.values()) if (!best || bucket.length > best.length) best = bucket
  const selected = best && best.length >= 3 ? best : candidates
  const gridList = selected !== candidates ? selected[0]?.anchor?.closest('ul') || null : null
  // 大尺寸封面卡是收藏夹作品网格的直接证据：滚动到下方时顶部的“返回”会滚出可视区域，
  // 但网格仍然是同一个收藏夹。收藏夹总览页只有 46px 的小预览图，达不到这个门槛。
  if (!backVisible && selected.length < 8) {
    return { ok: false, code: 'FOLDER_NOT_OPENED', reason: '还不在收藏夹作品列表里' }
  }

  const videos = [], seen = new Set()
  for (const { anchor, kind, videoId } of selected) {
    if (seen.has(videoId)) continue
    seen.add(videoId)
    const image = anchor.querySelector('img')
    let title = norm(anchor.getAttribute('aria-label') || image?.getAttribute('alt') || '')
    if (!title) {
      title = (anchor.innerText || '').split('\n').map(line => norm(line))
        .find(line => line.length >= 4 && !/^[\d,.]+万?$/.test(line)) || ''
    }
    videos.push({
      videoId,
      video_url: `https://www.douyin.com/${kind}/${videoId}`,
      title: title.slice(0, 300) || null,
    })
  }
  // 「没有更多了」只认作品网格附近的那一个：收藏夹列表页同样有这句提示，不能当作网格到底。
  let moreVisible = false
  if (gridList) {
    const gridRoot = gridList.parentElement?.parentElement || gridList.parentElement || gridList
    moreVisible = [...gridRoot.querySelectorAll('div, span, p')]
      .some(node => visible(node) && /暂时没有更多了|没有更多了/.test(norm(node.innerText)))
  }
  return { ok: true, videos, done: moreVisible, moreVisible, total: videos.length, grid: gridList ? 'ul' : 'all' }
}

// 分步滚动收藏夹列表，逐步累积作品 ID，避免一次滚到底只拿到虚拟列表中的一小段。
// 作品卡的滚动通常发生在页面级 route 容器上；从锚点向上找可滚动祖先，取滚动范围最大的那个。
function advanceFavoritesViewport() {
  if (location.origin !== 'https://www.douyin.com') return { wrongPage: true }
  const visible = n => Boolean(n && n.getBoundingClientRect().width && n.getBoundingClientRect().height)
  const viewport = window.innerHeight
  const scrollers = []
  for (const anchor of [...document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')].slice(0, 12)) {
    if (!visible(anchor)) continue
    if (!anchor.querySelector('img')) continue
    let node = anchor.parentElement
    for (let depth = 0; node && node !== document.body && depth < 30; depth += 1) {
      const style = getComputedStyle(node)
      if (node.scrollHeight > node.clientHeight + 80 && /auto|scroll/.test(style.overflowY)
        && node.clientHeight >= 300 && !scrollers.includes(node)) scrollers.push(node)
      node = node.parentElement
    }
  }
  // 取可滚动范围最大的容器，通常是承载整页内容的 route 容器。
  const container = scrollers.sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0] || null
  if (container) {
    container.scrollTop += Math.max(320, Math.round(container.clientHeight * 0.85))
    return {
      ok: true, container: true,
      scrollTop: Math.round(container.scrollTop), scrollHeight: container.scrollHeight,
      atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 40,
    }
  }
  window.scrollBy(0, Math.max(400, Math.round(viewport * 0.8)))
  return { ok: true, container: false, scrollTop: Math.round(window.scrollY), atBottom: false }
}

module.exports = {
  FAVORITES_URL, parseFolderLabel, folderNameMatches,
  favoritesPageState, favoritesSubTabPoint, favoritesFolderEntry, readFavoriteVideos, advanceFavoritesViewport,
}
