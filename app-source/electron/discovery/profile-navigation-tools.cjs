// Serializable probe used by both direct navigation and in-page author clicks.
function profileUnavailableSnapshot() {
  const body = String(document.body?.innerText || '')
  if (/访问过于频繁|访问受限|操作频繁|请求过于频繁/.test(body)) return 'ACCESS_RESTRICTED'
  if (body.split(/\r?\n/).some(line => /^(?:(?:你查看的|你访问的|该)?用户不存在)[。！!]?$/u.test(line.trim()))) return 'PROFILE_NOT_FOUND'
  return ''
}

function profileSearchQueries(name) {
  const full = Array.from(String(name || '').trim()).slice(0, 80).join('')
  if (!full) return []
  const cleaned = full.normalize('NFKC').replace(/[^\p{Script=Han}\p{Script=Latin}\p{Number}]/gu, '')
  return [{ text: full, mode: 'full' },
    ...(cleaned !== full && Array.from(cleaned).length >= 2 ? [{ text: cleaned, mode: 'plain' }] : [])]
}

module.exports = { profileUnavailableSnapshot, profileSearchQueries }
