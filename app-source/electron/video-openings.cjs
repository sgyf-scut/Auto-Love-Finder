const { randomUUID } = require('node:crypto')
const { FriendshipService } = require('./friendship.cjs')

const SEARCHES = { scenery: '治愈风景', pets: '可爱萌宠', funny: '轻松搞笑日常' }
function videoUrl(value) {
  let url
  try { url = new URL(String(value || '')) } catch { throw new Error('无效的抖音视频地址') }
  if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || !/^\/video\/\d{8,24}\/?$/.test(url.pathname)) throw new Error('只支持抖音公开视频链接')
  return `https://www.douyin.com${url.pathname.replace(/\/$/, '')}`
}
// Executed in the account's isolated, logged-in public-page window.
function videoSearchSnapshot() {
  const visible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const body = document.body?.innerText || ''
  if (/^\s*(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-out)/i.test(body)) return { serverError: body.trim().split('\n')[0].slice(0, 80), candidates: [] }
  if ([...document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="verify"]')].some(visible) || /请完成.*验证|验证后继续|拖动滑块/.test(body)) return { challenge: true, candidates: [] }
  const candidates = [], seen = new Set()
  for (const anchor of document.querySelectorAll('a[href*="/video/"], a[href*="modal_id="]')) {
    if (!visible(anchor)) continue
    let parsed
    try { parsed = new URL(anchor.href, location.href) } catch { continue }
    if (parsed.hostname !== 'www.douyin.com') continue
    const id = parsed.pathname.match(/^\/video\/(\d{8,24})\/?$/)?.[1] || parsed.searchParams.get('modal_id')
    if (!id || !/^\d{8,24}$/.test(id) || seen.has(id)) continue
    let card = anchor.closest('[data-e2e="search-video-item"], [data-e2e="search-result-item"], li') || anchor
    for (let depth = 0; depth < 3 && card.parentElement && !(card.innerText || '').trim(); depth++) card = card.parentElement
    const description = card.querySelector('[data-e2e="video-desc"], [data-e2e*="desc"], [class*="videoTitle"], [class*="VideoTitle"]')
    const lines = (card.innerText || '').split(/\n+/).map(s => s.trim()).filter(Boolean)
    const metadata = /^(?:合集|\d{1,2}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?[万亿wW]?(?:赞)?|@.*|\d+\s*(?:秒|分钟|小时|天|周|月|年)前)$/
    const title = (description?.innerText || anchor.getAttribute('title') || anchor.querySelector('img')?.alt || lines.find(line => line.length >= 4 && !metadata.test(line)) || '').trim().slice(0, 250)
    if (title.length < 4 || /广告|购买|商品|带货|低价|团购|直播间|点击.*链接|成人|血腥|虐待/.test(title)) continue
    seen.add(id)
    candidates.push({ url: `https://www.douyin.com/video/${id}`, title, summary: lines.join(' · ').slice(0, 500) })
    if (candidates.length >= 16) break
  }
  return { candidates, empty: /暂无.*结果|未找到.*结果|没有找到/.test(body), loginRequired: !candidates.length && /登录后.*搜索|登录后查看|请先登录/.test(body) }
}
function composeVideoMessage(url, caption) {
  const canonical = videoUrl(url)
  const text = String(caption || '').trim()
  if (!text || text.length > 80 || /https?:\/\/|bytedance:|[\r\n]/i.test(text)) throw new Error('请填写一行80字以内的视频配文，不要插入其他链接')
  return [canonical, text]
}

class VideoOpeningService extends FriendshipService {
  constructor(douyin) { super(douyin); this.sending = new Set() }
  ensureWindow() {
    const win = super.ensureWindow()
    win.setTitle?.('AI 找视频 · 抖音')
    return win
  }
  contact(name) {
    const matches = (this.storage.get().contacts || []).filter(item => item.name === name)
    if (matches.length !== 1) throw new Error('请选择私信列表中唯一的联系人')
    return matches[0]
  }
  ensureActive() {
    if (this.destroyed) throw new Error('此账号的视频服务已关闭')
    if (this.storage.get().automation?.paused || this.douyin.verificationActive) throw new Error('账号已暂停或需要安全验证')
  }
  ensureRecipient(name) {
    this.ensureActive()
    const contact = this.contact(name)
    if ((this.storage.get().automation?.blacklist || []).includes(name)) throw new Error('该联系人在黑名单中')
    if ((this.storage.get().automation?.aiDisabledContacts || []).includes(name)) throw new Error('该联系人已禁止 AI 消息')
    return contact
  }
  progress(name, phase) {
    this.douyin.emitEvent?.('video_opening_progress', { name, phase })
    this.phase = phase
  }
  async create(name) {
    if (this.sending.size) throw new Error('视频正在发送，请稍后换一批')
    return this.exclusive(async () => {
      const contact = this.ensureRecipient(name)
      this.progress(name, '正在选择风景、宠物或搞笑类别')
      const plan = await this.douyin.ai.planVideoSearch(contact)
      this.ensureRecipient(name)
      const keyword = SEARCHES[plan.category]
      if (!keyword) throw new Error('视频类别无效')
      const win = this.ensureWindow()
      this.progress(name, '正在搜索真实抖音视频')
      let snapshot
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.navigate(win, `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`)
        try { snapshot = await this.wait(win, videoSearchSnapshot, [], result => result?.candidates?.length || result?.empty); break }
        catch (error) { if (!error.transient || attempt === 1) throw error }
      }
      const greetingState = this.storage.get().videoGreetings || {}
      const excluded = new Set([...(greetingState.sent || []), ...(greetingState.pending || [])].filter(item => item.name === name).map(item => item.url))
      const history = this.storage.get().sendHistory || []
      const candidates = snapshot.candidates.filter(item => !excluded.has(item.url) && !history.some(sent => sent.name === name && String(sent.text || '').includes(item.url))).map(item => ({ ...item, category: plan.category }))
      if (!candidates.length) throw new Error('这批视频已给对方选过或没有合适内容，请稍后换一批')
      this.progress(name, `AI 正在从 ${candidates.length} 条视频中挑选`)
      const chosen = await this.douyin.ai.selectVideoOpening(contact, candidates)
      // A model may only select an actual result, never invent a destination URL.
      const selected = candidates.find(item => item.url === chosen.url)
      if (!selected) throw new Error('AI 选择的视频不在真实搜索结果中')
      this.progress(name, '正在打开视频并读取实际评论')
      await this.navigate(win, videoUrl(selected.url))
      await win.webContents.executeJavaScript('document.querySelectorAll("video").forEach(v => { v.pause(); v.muted = true })').catch(() => {})
      const expectedId = selected.url.split('/').pop()
      const currentId = String(win.webContents.getURL()).match(/(?:modal_id=|\/video\/)(\d+)/)?.[1]
      if (currentId !== expectedId) throw new Error('视频页面跳转到其他内容，请换一批')
      const context = await this.douyin.readVideoCommentContext({}, name, { commentLimit: 10, commentWaitMs: 1800, commentScrolls: 1, targetAwemeId: expectedId, preferDomComments: true }, win)
      const finalId = String(win.webContents.getURL()).match(/(?:modal_id=|\/video\/)(\d+)/)?.[1]
      if (finalId !== expectedId || context.videoCommentError) throw new Error('无法核对视频信息，请换一批')
      this.ensureRecipient(name)
      this.progress(name, 'AI 正在生成一句配文')
      const caption = await this.douyin.ai.draftVideoOpening({ contact: this.contact(name), video: selected, context })
      composeVideoMessage(selected.url, caption.text)
      this.ensureRecipient(name)
      const item = { id: randomUUID(), name, url: selected.url, title: selected.title, category: selected.category, text: caption.text, source: caption.source, reason: String(chosen.reason || plan.reason || '').slice(0, 160), model: caption.model || '', provider: caption.provider || '', at: new Date().toISOString() }
      const latest = this.storage.get().videoGreetings || {}
      const queued = new Set((this.storage.get().pendingDrafts || []).map(draft => draft.videoOpeningId).filter(Boolean))
      this.storage.update({ videoGreetings: { ...latest, pending: [item, ...(latest.pending || []).filter(old => old.name !== name || old.videoSentAt || queued.has(old.id) || ['sending', 'uncertain'].includes(old.status))].slice(0, 20) } })
      this.douyin.log('video_opening_ready', `已为 ${name} 挑选视频并配文`, { name, category: item.category, url: item.url, source: item.source })
      this.progress(name, '视频和配文已就绪')
      return { ok: true, video: item }
    })
  }
  async open(id) {
    const item = (this.storage.get().videoGreetings?.pending || []).find(item => item.id === id)
    if (!item) throw new Error('视频草稿已失效，请重新生成')
    return this.exclusive(async () => { const win = this.ensureWindow(); await this.navigate(win, videoUrl(item.url)); win.show(); return { ok: true } })
  }
  discard(id) {
    const current = this.storage.get().videoGreetings || {}
    if (this.sending.has(id)) throw new Error('此视频正在发送，请稍后再试')
    this.storage.update({ videoGreetings: { ...current, pending: (current.pending || []).filter(item => item.id !== id) }, pendingDrafts: (this.storage.get().pendingDrafts || []).filter(item => item.videoOpeningId !== id) })
    return { ok: true }
  }
  async send({ id, text } = {}) {
    if (this.sending.has(id)) throw new Error('此视频正在发送，请稍后再试')
    const item = (this.storage.get().videoGreetings?.pending || []).find(item => item.id === id)
    if (!item) throw new Error('视频草稿已发送或失效，请重新生成')
    if (['sending', 'uncertain'].includes(item.status)) throw new Error('上次发送结果尚未确认，请先检查抖音聊天记录并丢弃此草稿，避免重复发送')
    this.ensureRecipient(item.name)
    const [link, caption] = composeVideoMessage(item.url, text === undefined ? item.text : text)
    const alreadySent = (this.storage.get().videoGreetings?.sent || []).some(sent => sent.name === item.name && sent.url === item.url)
      || (this.storage.get().sendHistory || []).some(sent => sent.name === item.name && String(sent.text || '').includes(item.url))
    if (alreadySent) throw new Error('这条视频已分享给对方，请换一个')
    // Reserve enough allowance for both bubbles before posting the video.
    this.douyin.assertCanSend?.(item.name, { count: item.videoSentAt ? 1 : 2 })
    this.sending.add(id)
    let videoSentAt = item.videoSentAt || ''
    let submissionUncertain = false
    let captionSent = false
    try {
      this.ensureRecipient(item.name)
      const before = this.storage.get().videoGreetings || {}
      this.storage.update({ videoGreetings: { ...before, pending: (before.pending || []).map(old => old.id === id ? { ...old, text: caption, status: 'sending' } : old) } })
      const metadata = { ai: true, model: item.model, provider: item.provider, videoOpeningId: id }
      if (!videoSentAt) {
        submissionUncertain = true
        await this.douyin.sendMessage(item.name, link, { ...metadata, source: 'video_opening' })
        videoSentAt = new Date().toISOString()
        submissionUncertain = false
        // Persist the first bubble before attempting the caption. A safe
        // caption retry (including after restart) must never resend the video.
        const checkpoint = this.storage.get().videoGreetings || {}
        this.storage.update({ videoGreetings: { ...checkpoint, pending: (checkpoint.pending || []).map(old => old.id === id ? { ...old, text: caption, videoSentAt, status: 'sending' } : old) } })
      }
      this.ensureRecipient(item.name)
      submissionUncertain = true
      await this.douyin.sendMessage(item.name, caption, { ...metadata, source: 'video_opening_caption' })
      captionSent = true
      const latest = this.storage.get().videoGreetings || {}
      this.storage.update({ videoGreetings: { ...latest, pending: (latest.pending || []).filter(old => old.id !== id), sent: [...(latest.sent || []), { ...item, videoSentAt, text: caption, sentAt: new Date().toISOString() }].slice(-200) }, pendingDrafts: (this.storage.get().pendingDrafts || []).filter(draft => draft.videoOpeningId !== id) })
      this.douyin.ai?.recordMediaContext?.(item.name, { summary: `我方向对方分享了视频：${item.title}；配文：${caption}`, topic: `我方主动分享${item.category === 'pets' ? '宠物' : item.category === 'scenery' ? '风景' : '搞笑'}视频` })
      this.douyin.log('video_opening_sent', `已向 ${item.name} 分享视频和配文`, { name: item.name, url: item.url })
      return { ok: true, name: item.name }
    } catch (error) {
      const current = this.storage.get().videoGreetings || {}
      const safeToRetry = !captionSent && (error.sendAttempted === false || !submissionUncertain)
      this.storage.update({ videoGreetings: { ...current, pending: (current.pending || []).map(old => old.id === id ? { ...old, text: caption, ...(videoSentAt ? { videoSentAt } : {}), status: safeToRetry ? 'retryable' : 'uncertain', error: error.message } : old) } })
      this.douyin.log('video_opening_error', `视频发送失败：${error.message}`, { name: item.name, url: item.url, sendAttempted: error.sendAttempted !== false })
      throw error
    } finally { this.sending.delete(id) }
  }
}
module.exports = { VideoOpeningService, SEARCHES, videoUrl, videoSearchSnapshot, composeVideoMessage }
