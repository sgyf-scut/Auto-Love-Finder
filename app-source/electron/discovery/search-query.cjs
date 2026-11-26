// Spaces stay inside a term (e.g. English game titles); C++ and C# remain intact.
const SEPARATORS = /[,，、;；\r\n\t|｜/\\]+/
function parseSearchTerms(value, { tags = false, max = 10 } = {}) {
  const result = [], seen = new Set()
  for (const input of Array.isArray(value) ? value : [value]) {
    if (typeof input !== 'string') continue
    for (let term of input.split(SEPARATORS)) {
      term = term.trim().replace(/^#+/, '').trim().slice(0, 80)
      const key = term.toLocaleLowerCase()
      if (!term || seen.has(key)) continue
      seen.add(key); result.push(term)
      if (result.length >= max) return result
    }
  }
  return result
}
function sourceTerms(sources = {}) {
  return parseSearchTerms([...(sources.keywords || []), ...(sources.tags || [])], { max: 20 })
}
function keywordQueries(sources = {}) {
  const terms = sourceTerms(sources), keywords = sources.keywords || []
  if (sources.combinedSearch !== true || terms.length < 2) return keywords
  return [...new Set([terms.join(' '), ...keywords])]
}
function rankVideos(videos, sources = {}) {
  if (sources.combinedSearch !== true) return videos
  const terms = sourceTerms(sources), combined = terms.length > 1 ? terms.join(' ') : ''
  if (terms.length < 2) return videos
  return videos.map((video, index) => {
    const text = String(video.title || '').normalize('NFKC').toLocaleLowerCase()
    const matchedTerms = terms.filter(term => text.includes(term.normalize('NFKC').toLocaleLowerCase()))
    return { video: { ...video, matchedSearchTerms: matchedTerms }, index, score: matchedTerms.length,
      combined: video.sourceType === 'keyword' && video.query === combined ? 1 : 0 }
  }).sort((a, b) => b.score - a.score || b.combined - a.combined || a.index - b.index).map(row => row.video)
}
module.exports = { parseSearchTerms, sourceTerms, keywordQueries, rankVideos }
