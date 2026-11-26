const { belowCommentMinimum } = require('./video-comment-count.cjs')
const { gradeOfIntent } = require('./candidate-manager.cjs')
const { rowToComment, SOURCE } = require('../social-brain/comment-collector.cjs')
const { normalizeSampling, meetsIntent } = require('./selection-policy.cjs')

function roundLimits(round, sampling) {
  if (sampling) { const p = normalizeSampling(sampling); return { size: round === 0 ? p.first : round === 1 ? p.second : p.later, minimum: 1 } }
  if (round === 0) return { size: 20, minimum: 2 }
  return { size: round === 1 ? 30 : 40, minimum: 3 }
}

function isInterested(comment, minimum) {
  if (minimum) return meetsIntent(comment?.classification?.intent, minimum)
  const grade = gradeOfIntent(comment?.classification?.intent)
  return grade === 'A' || grade === 'B'
}

// Holds the current page and the remainder of its visible rows while a video is open.
function createVideoReader(collector, library, video, { startPage = 0, timeoutMs = 45000, minVideoComments = 0 } = {}) {
  let remainingReadMs = Math.max(1, Number(timeoutMs) || 45000)
  const boundedRead = async operation => {
    const started = Date.now()
    let timer
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise(resolve => { timer = setTimeout(() => {
          try { collector.transport.cancel?.() } catch {}
          resolve({ ok: false, code: 'TIMEOUT', diagnostics: collector.transport.diagnostics?.() || null, reason: `该视频评论读取超过 ${Math.round(timeoutMs / 1000)} 秒上限，已跳过` })
        }, remainingReadMs) }),
      ])
    } finally { clearTimeout(timer); remainingReadMs = Math.max(1, remainingReadMs - (Date.now() - started)) }
  }
  let ready = false
  let page = Math.max(0, startPage)
  let rows = []
  let previousTail = null
  const target = { videoId: video.videoId, videoUrl: video.videoUrl, title: video.title, minVideoComments }
  const identity = comment => comment.comment_id
    ? `id:${comment.comment_id}` : JSON.stringify([comment.author_id, comment.text])
  const known = new Set((library.read().comments || []).filter(comment => String(comment.video_id) === video.videoId).map(identity))

  return async ({ limit, alive }) => {
    if (!ready) {
      const result = await boundedRead(() => collector.transport.prepare(target))
      if (!result?.ok) return { ...result, read: 0 }
      if (String(result.videoId) !== String(video.videoId)) return { ok: false, code: 'VIDEO_NOT_FOUND', read: 0 }
      target.videoUrl = result.videoUrl || target.videoUrl
      target.title = result.title || target.title
      library.addVideo({ video_id: video.videoId, video_url: target.videoUrl, title: target.title, key: `v:id:${video.videoId}`, source: SOURCE })
      ready = true
    }
    let read = 0, fetched = 0
    const comments = []
    const finish = result => {
      const saved = comments.length ? library.addComments(comments) : null
      return { ...result, read, fetched, added: saved?.added || 0, page: Math.max(0, page - 1) }
    }
    while (read < limit && alive()) {
      if (!rows.length) {
        const result = await boundedRead(() => collector.readPageWithRetry({ ...target, page }))
        if (!result?.ok) {
          return finish(result)
        }
        if (!alive()) break
        if (belowCommentMinimum(result.videoCommentCount, minVideoComments)) return finish({ ok: false, code: 'VIDEO_COMMENTS_BELOW_MIN', reason: `页面显示视频总评论 ${result.videoCommentCount} 条，少于本批门槛 ${minVideoComments} 条，已跳过` })
        page += 1
        rows = result.rows || []
        if (!rows.length) {
          return finish({ ok: true, exhausted: result.empty === true, stalled: result.empty !== true })
        }
        const last = rows[rows.length - 1]
        const tail = JSON.stringify([last.commentId, last.platformUserId, last.commentText])
        if (tail === previousTail) {
          return finish({ ok: true, stalled: true })
        }
        previousTail = tail
      }
      const chunk = rows.splice(0, limit - read)
      fetched += chunk.length
      for (const row of chunk) {
        const mapped = rowToComment(row, target)
        if (mapped && known.has(identity(mapped))) {
          if (mapped.ip_location || mapped.reply_count !== null) comments.push(mapped)
          continue
        }
        read += 1
        if (!mapped) continue
        known.add(identity(mapped))
        comments.push(mapped)
      }
    }
    return finish({ ok: true })
  }
}

module.exports = { roundLimits, isInterested, createVideoReader }
