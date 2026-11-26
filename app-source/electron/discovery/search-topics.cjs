const DEFAULT_TOPICS = Object.freeze([
  { id: 'dating', label: '恋爱', enabled: false, keywords: ['恋爱', '找对象'] },
  { id: 'social', label: '交友', enabled: true, keywords: ['交友', '认识新朋友'] },
  { id: 'graduate', label: '研究生', enabled: false, keywords: ['研究生', '研一', '研二', '研三'] },
  { id: 'undergraduate', label: '本科生', enabled: false, keywords: ['本科生', '大学生'] },
  { id: 'single', label: '脱单', enabled: false, keywords: ['脱单'] },
])
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
function keywords(value) {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,，;；、]+/) : []
  return [...new Set(entries.map(item => clean(item, 80)).filter(Boolean))].slice(0, 20)
}
function bounded(value, fallback, min, max) {
  if (value === null || value === '' || typeof value === 'boolean') return fallback
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback
}
function normalizeDiscoveryConfig(value = {}) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const inputs = Array.isArray(value.topics) ? value.topics : DEFAULT_TOPICS
  const seen = new Set(), topics = []
  for (const topic of inputs) {
    const id = clean(topic?.id, 80), label = clean(topic?.label, 100)
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !label || seen.has(id)) continue
    seen.add(id)
    topics.push({ id, label, enabled: topic.enabled === true, keywords: keywords(topic.keywords) })
    if (topics.length >= 20) break
  }
  const videoTags = keywords(value.videoTags).map(tag => tag.replace(/^[#＃]+/, '').trim()).filter(Boolean)
  const videoKeywords = keywords(value.videoKeywords === undefined ? topics.filter(topic => topic.enabled).flatMap(topic => topic.keywords) : value.videoKeywords)
  return { ...value, topics, videoTags: [...new Set(videoTags)], videoKeywords, targetGender: value.targetGender === 'female' ? 'female' : 'any',
    requirementsText: clean(value.requirementsText, 2000),
    preferLowReplies: value.preferLowReplies === true, includeReplies: value.includeReplies === true, preferLowerComments: value.preferLowerComments === true,
    followerLimit: bounded(value.followerLimit, 150, 1, 100000),
    requireFollowerLimit: value.requireFollowerLimit === true,
    requireAgeRange: value.requireAgeRange === true,
    ageMin: bounded(value.ageMin, 20, 18, 100),
    ageMax: Math.max(bounded(value.ageMin, 20, 18, 100), bounded(value.ageMax, 30, 18, 100)),
    automaticContactThreshold: bounded(value.automaticContactThreshold, 70, 0, 100),
    commentScrollSteps: bounded(value.commentScrollSteps, 3, 0, 8),
    profileChecksPerRun: bounded(value.profileChecksPerRun, 8, 0, 20),
    maxVideosPerRun: bounded(value.maxVideosPerRun, 3, 1, 5), commentsPerVideo: bounded(value.commentsPerVideo, 20, 1, 30) }
}
function discoverySearches(value) {
  const config = normalizeDiscoveryConfig(value), seen = new Set()
  return [
    ...config.videoTags.map(tag => ({ topic: 'manual_tags', keyword: `#${tag}` })),
    ...config.videoKeywords.map(keyword => ({ topic: 'manual_keywords', keyword })),
  ].filter(search => !seen.has(search.keyword) && seen.add(search.keyword))
}
module.exports = { DEFAULT_TOPICS, normalizeDiscoveryConfig, discoverySearches }
