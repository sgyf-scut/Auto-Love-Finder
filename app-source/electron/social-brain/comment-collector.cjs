const { belowCommentMinimum } = require('../discovery/video-comment-count.cjs')
// P2-10 一键收集评论：分页、去重、数量上限、进度、中断恢复与来源绑定。
// 设计边界：
// 1) 只依赖 transport 提供的“已登录页面可见评论”，不构造签名接口、不绕过反爬；
// 2) 没有登录态、视频失效、评论关闭时明确返回原因和用户可执行的下一步；
// 3) 收集结果统一写入 library.json，学习样本由 P2-09 syncLibrary 生成，缺作者 ID 的评论不会进入候选池；
// 4) 本模块不关注、不发私信、不读写聊天状态。
const { parseVideoLink, normalizeUrl } = require('./library-store.cjs')

const DEFAULTS = { limit: 50, maxPages: 8, maxLimit: 300, maxPagesLimit: 20 }
const COLLECT_ERRORS = {
  VIDEO_COMMENTS_BELOW_MIN: { status: 'completed', reason: '视频总评论数低于本批门槛，已跳过', nextAction: '继续处理下一个视频' },
  LOGIN_REQUIRED: {
    status: 'blocked',
    reason: '当前账号的抖音登录态不可用，无法读取评论',
    nextAction: '在应用内打开抖音登录窗口完成登录后重试；也可以用 JSON/CSV 手动导入评论',
  },
  CHALLENGE: {
    status: 'blocked',
    reason: '抖音要求完成安全验证（验证码/滑块），验证完成前不能读取评论',
    nextAction: '在弹出的“收集评论 · 抖音”窗口里完成验证，页面会自动回到作品页；然后点击“继续收集”恢复，已收集的评论不会丢',
  },
  VIDEO_NOT_FOUND: {
    status: 'failed',
    reason: '视频不存在或已删除，链接可能已失效',
    nextAction: '重新复制抖音分享链接，或确认作品未被作者删除；已有评论仍可用 JSON/CSV 手动导入',
  },
  COMMENTS_CLOSED: {
    status: 'failed',
    reason: '该视频作者已关闭评论，无法获取评论',
    nextAction: '换一个允许评论的视频；已收录的视频仍可用 JSON/CSV 导入其他来源评论',
  },
  COMMENTS_UNAVAILABLE: {
    status: 'blocked',
    reason: '页面没有显示可读取的评论（可能需要登录、评论仅部分人可见或页面结构变化）',
    nextAction: '在收集评论窗口手动确认页面是否可见评论，仍不可见时改用 JSON/CSV 导入',
  },
  RATE_LIMITED: {
    status: 'interrupted',
    reason: '抖音限制了本次评论读取频率',
    nextAction: '稍后点击“继续收集”从中断页恢复，已收集的评论已保存',
  },
  NETWORK_ERROR: {
    status: 'interrupted',
    reason: '读取评论时网络或页面加载失败',
    nextAction: '检查网络后点击“继续收集”恢复，已收集的评论已保存',
  },
  VIDEO_ID_UNRESOLVED: {
    status: 'failed',
    reason: '未能从链接解析出可绑定的作品 ID',
    nextAction: '使用 douyin.com/video/... 形式的完整链接，或直接粘贴作品 ID',
  },
  LINK_RESOLVE_UNAVAILABLE: {
    status: 'failed',
    reason: '当前环境无法解析分享短链，请改用作品页完整链接',
    nextAction: '在抖音里打开该视频，复制“复制链接”得到的 douyin.com/video/… 地址后重试',
  },
  NO_TRANSPORT: {
    status: 'failed',
    reason: '当前环境没有可用的页面读取通道',
    nextAction: '在桌面应用内运行收集；测试环境请使用 JSON/CSV 导入',
  },
  CONTENT_UNSUPPORTED: {
    status: 'failed',
    reason: '该内容类型暂不支持读取评论（例如直播、合集等）',
    nextAction: '换一个视频或图文作品；已在库里的评论仍可继续使用',
  },
  TIMEOUT: {
    status: 'interrupted',
    reason: '页面在限定时间内没有返回可读评论',
    nextAction: '稍后重试；已收集的评论已保存',
  },
}
const SOURCE = 'douyin_dom'

const now = () => new Date().toISOString()
const clampInt = (value, fallback, min, max) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function errorOf(code, extra = {}) {
  const preset = COLLECT_ERRORS[code] || COLLECT_ERRORS.NETWORK_ERROR
  // 只覆盖显式给出的字段，避免 undefined 把预设原因/下一步冲掉。
  const defined = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  return { ok: false, code, ...preset, ...defined }
}

// 页面快照行 → 素材库评论记录。作者 ID 允许为空（仅用于学习），不伪造。
// P2-17B.2：评论级 IP 属地与回复总数按页面原样保存；没有就是 null + 状态，不用主页资料顶替。
function rowToComment(row, { videoId, videoUrl, title }) {
  const text = String(row?.commentText ?? row?.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const authorId = String(row?.platformUserId ?? row?.authorId ?? '').trim() || null
  const authorName = String(row?.nickname ?? row?.authorName ?? '').trim() || null
  const commentId = String(row?.commentId ?? '').trim() || null
  const replyCount = Number.isSafeInteger(row?.replyCount) && row.replyCount >= 0 ? row.replyCount : null
  const ipLocation = String(row?.ipLocation ?? '').trim().slice(0, 20) || null
  const ipLocationSource = ipLocation ? (String(row?.ipLocationSource || '').trim() || 'unknown') : 'not_present'
  const context = row?.isReply
    ? `回复评论${row?.parentCommentId ? `（父评论 ${String(row.parentCommentId).slice(0, 40)}）` : ''}`
    : '视频一级评论'
  return {
    comment_id: commentId,
    video_id: videoId || null,
    video_url: videoUrl || null,
    author_id: authorId,
    author_name: authorName,
    text,
    created_at: row?.createdAt || null,
    reply_count: replyCount,
    ip_location: ipLocation,
    ip_location_source: ipLocationSource,
    source: SOURCE,
    collected_at: now(),
    origin_note: [
      '抖音视频页公开评论',
      context,
      title ? `视频：${String(title).slice(0, 80)}` : '',
      authorId ? '' : '作者 ID 缺失（仅用于学习，不进入候选池）',
    ].filter(Boolean).join(' · '),
  }
}

class CommentCollector {
  constructor({ store, transport, onProgress = null, retryDelayMs = 900 } = {}) {
    if (!store) throw new Error('缺少素材库')
    this.store = store
    this.transport = transport || null
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {}
    this.retryDelayMs = retryDelayMs
  }

  progress(collector) {
    try { this.onProgress(collector) } catch { /* 进度回调失败不影响采集 */ }
  }

  saveCollector(patch) {
    const collector = this.store.setCollector(patch)
    this.progress(collector)
    return collector
  }

  async run({ text = '', videoId = null, videoUrl = null, title = null, limit = DEFAULTS.limit, maxPages = DEFAULTS.maxPages, resume = false, startPage = null, startPageKey = null, onPage = null, minVideoComments = 0 } = {}) {
    if (!this.transport) {
      const failure = errorOf('NO_TRANSPORT')
      this.saveCollector({ status: 'failed', code: failure.code, lastError: failure.reason, finishedAt: now(), phase: '页面读取通道不可用' })
      return { ...failure, collector: this.store.collectorState(), added: 0, duplicates: 0, fetched: 0, pages: 0, comments: [] }
    }
    const parsed = parseVideoLink(text) || {}
    const targetId = videoId || parsed.video_id || null
    // 解析出作品 ID 时优先用标准视频页 URL：用户主页带 modal_id 的链接也能稳定打开。
    const targetUrl = (targetId ? `https://www.douyin.com/video/${targetId}` : null)
      || normalizeUrl(videoUrl || parsed.video_url) || null
    if (!targetId && !targetUrl) {
      const failure = errorOf('VIDEO_ID_UNRESOLVED', { reason: '无法识别视频链接或作品 ID，请粘贴 douyin.com/video/... 链接' })
      this.saveCollector({ status: 'failed', code: failure.code, lastError: failure.reason, finishedAt: now(), phase: '链接无法识别' })
      return { ...failure, collector: this.store.collectorState(), added: 0, duplicates: 0, fetched: 0, pages: 0, comments: [] }
    }

    const wanted = clampInt(limit, DEFAULTS.limit, 1, DEFAULTS.maxLimit)
    const pagesCap = clampInt(maxPages, DEFAULTS.maxPages, 1, DEFAULTS.maxPagesLimit)
    const requestedKey = targetId ? `v:id:${targetId}` : `v:url:${targetUrl}`
    const checkpoint = this.store.collectorState()
    const canResume = resume === true && checkpoint.status !== 'running'
      && (checkpoint.videoKey === requestedKey || checkpoint.videoUrl === targetUrl)
    // 显式 startPage 必须绑定同一个 videoKey（默认绑定到当前请求），避免把 A 视频的页数用到 B 视频。
    const explicitStart = Number.isFinite(Number(startPage)) ? Math.max(0, Math.floor(Number(startPage))) : 0
    const explicitKeyMatched = explicitStart > 0 && (!startPageKey || startPageKey === requestedKey)
    const checkpointStart = canResume ? Math.max(0, Number(checkpoint.pages) || 0) : 0
    const resumeFrom = Math.max(checkpointStart, explicitKeyMatched ? explicitStart : 0)

    this.saveCollector({
      status: 'running', code: null, lastError: '', phase: resumeFrom ? `继续收集（从第 ${resumeFrom + 1} 页恢复）` : '正在检查视频页与登录态',
      videoKey: requestedKey, videoId: targetId, videoUrl: targetUrl, title,
      targetLimit: wanted, maxPages: pagesCap, pages: resumeFrom, fetched: 0, collected: 0, duplicates: 0,
      startedAt: now(), finishedAt: null,
    })

    // 1) 权限探测：登录态 + 页面是否可读评论。
    let prepared
    try {
      prepared = await this.transport.prepare({ videoId: targetId, videoUrl: targetUrl, title })
    } catch (error) {
      prepared = { ok: false, code: 'NETWORK_ERROR', reason: String(error?.message || error) }
    }
    if (!prepared?.ok) {
      const failure = errorOf(prepared?.code || 'NETWORK_ERROR', { reason: prepared?.reason || undefined, transient: prepared?.transient === true })
      const collector = this.saveCollector({ status: failure.status, code: failure.code, lastError: failure.reason, finishedAt: now(), phase: failure.reason })
      return { ...failure, nextAction: prepared?.nextAction || failure.nextAction, diagnostics: prepared?.diagnostics || null, collector, added: 0, duplicates: 0, fetched: 0, pages: resumeFrom, comments: [] }
    }
    const resolvedId = prepared.videoId || targetId || null
    const resolvedUrl = normalizeUrl(prepared.videoUrl || targetUrl)
    if (!resolvedId) {
      const failure = errorOf('VIDEO_ID_UNRESOLVED')
      const collector = this.saveCollector({ status: failure.status, code: failure.code, lastError: failure.reason, finishedAt: now(), phase: failure.reason })
      return { ...failure, collector, added: 0, duplicates: 0, fetched: 0, pages: resumeFrom, comments: [] }
    }
    const videoKey = `v:id:${resolvedId}`
    const resolvedTitle = prepared.title || title || null
    // 2) 采集前先把视频收录进素材库，保证评论能绑定到确定的视频。
    let video = null
    try {
      const added = this.store.addVideo({ key: videoKey, video_id: resolvedId, video_url: resolvedUrl, title: resolvedTitle, source: SOURCE, collected_at: now() })
      video = added.video
    } catch { /* 视频入库失败不阻塞评论采集，评论仍带 video_id */ }

    const existingCount = this.store.read().comments.filter(item => item.video_id === resolvedId).length
    let stored = existingCount
    let added = 0, duplicates = 0, fetched = 0, pages = resumeFrom
    // 评论区是否明确显示"暂无评论"：这决定 0 条到底算"确实没评论"还是"没加载出来"。
    let emptySeen = false
    const addedKeys = []
    let blocked = null
    // 连续两页都没有新增才认为到底：虚拟列表滚动位置可能略有偏差，
    // 单页全量重复不代表后面没有新评论，过早停止会让“继续寻找”失效。
    let stalePages = 0

    // 库里已有的评论已达本次上限：直接结束，不要把“已收满”误报成“暂无可见评论”。
    if (stored >= wanted) {
      const phase = `该视频已有 ${stored} 条评论，已达到本次上限 ${wanted} 条，未重复读取`
      const collector = this.saveCollector({
        status: 'completed', code: null, lastError: '', finishedAt: now(), pages, fetched, collected: 0, duplicates: 0, phase,
      })
      return { ok: true, code: null, reachedCap: true, collector, video: video || null, added: 0, duplicates: 0, fetched, pages, existing: stored, empty: false, panelLoaded: true, comments: addedKeys, reason: `已有 ${stored} 条，达到本次上限 ${wanted} 条` }
    }

    this.saveCollector({ status: 'running', phase: `正在读取评论（已有 ${existingCount} 条）`, videoKey, videoId: resolvedId, videoUrl: resolvedUrl, title: resolvedTitle, pages, targetLimit: wanted, maxPages: pagesCap })

    // 3) 逐页读取：每页写盘一次，中断后已收集内容不丢。
    for (let page = resumeFrom; page < pagesCap; page += 1) {
      if (stored >= wanted) break
      const read = await this.readPageWithRetry({ videoId: resolvedId, videoUrl: resolvedUrl, page, minVideoComments })
      if (!read.ok) { blocked = read; break }
      if (belowCommentMinimum(read.videoCommentCount, minVideoComments)) { blocked = { ok: false, code: 'VIDEO_COMMENTS_BELOW_MIN', reason: `页面显示视频总评论 ${read.videoCommentCount} 条，少于本批门槛 ${minVideoComments} 条，已跳过` }; break }
      const rows = Array.isArray(read.rows) ? read.rows : []
      if (read.empty === true) emptySeen = true
      if (!rows.length) { if (page === resumeFrom) pages = resumeFrom; break }
      pages = page + 1
      fetched += rows.length
      // 条数上限是硬约束：最后一页只取到剩余额度为止，避免超出用户设定。
      const mapped = rows
        .map(row => rowToComment(row, { videoId: resolvedId, videoUrl: resolvedUrl, title: resolvedTitle }))
        .filter(Boolean)
        .slice(0, Math.max(0, wanted - stored))
      const saved = mapped.length ? this.store.addComments(mapped) : { added: 0, duplicates: 0, invalid: 0, addedKeys: [] }
      added += saved.added
      duplicates += saved.duplicates
      stored = existingCount + added
      addedKeys.push(...(saved.addedKeys || []))
      this.saveCollector({
        status: 'running', pages, fetched, collected: added, duplicates,
        phase: `第 ${pages} 页读取完成：新增 ${added} 条，去重 ${duplicates} 条，累计 ${stored} 条`,
      })
      // 逐页回调给流水线：把「当前视频已完成页数」写入该视频自己的任务项，供下次任务安全续读。
      if (typeof onPage === 'function') {
        try {
          onPage({ videoKey, videoId: resolvedId, videoUrl: resolvedUrl, pages, fetched, collected: added, duplicates, stored })
        } catch { /* 回调失败不影响继续采集 */ }
      }
      if (read.empty) break
      stalePages = saved.added === 0 && rows.length > 0 ? stalePages + 1 : 0
      // 连续两页没有新评论才认为已经到底或页面结构变化，继续滚动无意义。
      if (stalePages >= 2) break
      if (stored >= wanted) break
    }

    if (blocked) {
      const failure = errorOf(blocked.code || 'NETWORK_ERROR', { reason: blocked.reason || undefined, transient: blocked.transient === true })
      const collector = this.saveCollector({
        status: failure.status, code: failure.code, lastError: failure.reason, finishedAt: now(),
        pages, fetched, collected: added, duplicates, phase: `${failure.reason}（已保存 ${stored} 条）`,
      })
      return { ...failure, diagnostics: blocked.diagnostics || null, collector, video: video || null, added, duplicates, fetched, pages, existing: existingCount, empty: emptySeen, panelLoaded: pages > 0 || emptySeen, comments: addedKeys }
    }

    const noVisible = pages === 0 && added === 0
    const reachedCap = stored < wanted && pages >= pagesCap && pages > 0
    const phase = noVisible
      ? (emptySeen
        ? '该视频评论区已加载并显示暂无评论'
        : '评论区没有读到内容（未确认是否真的没有评论，可能未加载或被风控拦截）')
      : reachedCap
        ? `已达页数上限 ${pagesCap} 页，本次新增 ${added} 条；可再次点击继续收集`
        : `收集完成，本次新增 ${added} 条，去重 ${duplicates} 条`
    const collector = this.saveCollector({
      status: 'completed', code: null, lastError: '', finishedAt: now(),
      pages, fetched, collected: added, duplicates, phase,
    })
    return {
      ok: true, code: null, reachedCap, collector, video: video || null,
      added, duplicates, fetched, pages, comments: addedKeys,
      existing: existingCount, empty: emptySeen, panelLoaded: pages > 0 || emptySeen,
      reason: noVisible ? (emptySeen ? '该视频暂无评论' : '评论区未读到内容') : reachedCap ? `已读取 ${pagesCap} 页（上限）` : '收集完成',
    }
  }

  async readPageWithRetry(payload, attempts = 2) {
    let last = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try { last = await this.transport.readPage(payload) } catch (error) {
        last = { ok: false, code: 'NETWORK_ERROR', reason: String(error?.message || error), transient: true }
      }
      if (last?.ok) return last
      if (!last?.transient || attempt === attempts - 1) return last
      await sleep(this.retryDelayMs)
    }
    return last
  }
}

module.exports = {
  DEFAULTS, COLLECT_ERRORS, SOURCE, rowToComment, CommentCollector,
}
