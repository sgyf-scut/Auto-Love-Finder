function normalizeVideoCommentCount(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
function belowCommentMinimum(value, minimum) {
  const count = normalizeVideoCommentCount(value)
  return count !== null && Number.isSafeInteger(minimum) && minimum > 0 && count < minimum
}
// Visible platform totals only. Never infer a video total from sampled row count,
// likes, reply counts, hidden props or the collection already present on disk.
function videoCommentCountSnapshot(expectedId) {
  const id = location.href.match(/(?:\/(?:video|note)\/|modal_id=)(\d+)/)?.[1]
  if (location.origin !== 'https://www.douyin.com' || id !== String(expectedId)) return null
  const visible = n => { const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden' }
  const totals = new Set()
  const exact = value => { const s=String(value||'').trim();return /^\d[\d,，]*$/.test(s) ? Number(s.replace(/[,，]/g,'')) : null }
  for (const n of document.querySelectorAll('[data-e2e="video-player-comment"], [data-e2e="feed-comment-icon"], [data-e2e="comment-icon"], [data-e2e="comment-count"]')) {
    if (!visible(n)) continue
    for (const box of [n, n.closest?.('button, [role="button"]'), n.parentElement].filter(Boolean)) {
      const count=exact(box.innerText)
      if(Number.isSafeInteger(count)&&count>=0)totals.add(count)
    }
  }
  for (const n of document.querySelectorAll('[role="tab"], button, span')) {
    if(!visible(n))continue
    const match=String(n.innerText||'').trim().match(/^评论\s*[（(]\s*(\d[\d,，]*)\s*[）)]$/)
    if(match){const count=exact(match[1]);if(Number.isSafeInteger(count)&&count>=0)totals.add(count)}
  }
  return totals.size===1?[...totals][0]:null
}
module.exports={normalizeVideoCommentCount,belowCommentMinimum,videoCommentCountSnapshot}
