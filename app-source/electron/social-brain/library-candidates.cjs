// 从本地素材库生成候选、映射认识来源。不抓取、不发送、不关注。
// 三类意愿可进入候选审核队列，但只有「明确欢迎认识或私信」才带直接的私信同意证据。
const { LABELS, CANDIDATE_INTENTS, VIDEO_CATEGORIES, isFriendVideo, commentInputHash } = require('./library-classifier.cjs')
// P2-16.1：从评论原话里抽本人自述，并带来源与五态，不再一律写 unknown。
const { buildProfileFacts } = require('../discovery/profile-facts.cjs')

const PLATFORM = 'douyin'
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]+$/
// P2-12C 候选人发现等级：A 明确、B 一般、C 语境兴趣证据不足、D 普通/广告/拒绝联系。
// 等级只表示交友意愿证据强度，不等于私信许可；私信同意仍只由 explicitInvitation/consentToDm 表达。
const DISCOVERY_GRADES = ['A', 'B', 'C', 'D']
const GRADE_OF_INTENT = { EXPLICIT_INVITATION: 'A', SEEKING_FRIENDS: 'B', CONTEXTUAL_INTEREST: 'C' }
const GRADE_LABELS = { A: '明确交友意愿', B: '一般交友意愿', C: '语境兴趣·证据不足', D: '普通评论/广告/拒绝联系' }
// 发现状态只描述候选池内的处理状态，绝不改写联系人状态或消息发送状态。
const DISCOVERY_STATUS = ['DISCOVERED', 'QUALIFIED', 'INSUFFICIENT_INFO', 'EXCLUDED', 'REJECTED']

function gradeOfIntent(intent) {
  return GRADE_OF_INTENT[intent] || 'D'
}

function discoveryStatusOf(intent) {
  if (intent === 'CONTEXTUAL_INTEREST') return 'INSUFFICIENT_INFO'
  return 'DISCOVERED'
}

function labelOfCategory(value) {
  return LABELS[value] && VIDEO_CATEGORIES.includes(value) ? LABELS[value] : null
}

function keywordOf(video, topic) {
  const title = String(video?.title || video?.description || '').replace(/\s+/g, ' ').trim()
  if (title) return title.slice(0, 80)
  const hashtag = (video?.hashtags || [])[0]
  if (hashtag) return String(hashtag).slice(0, 80)
  return topic
}

// 一条评论要成为候选，必须同时满足：已标注的允许意图、有作者 ID、有昵称、有合法 video_id、正文非空。
function eligibilityOf(comment, video, goalMatch) {
  const intent = comment.classification?.intent || 'UNKNOWN'
  if (!goalMatch && !CANDIDATE_INTENTS.includes(intent)) return { ok: false, reason: 'INTENT_NOT_ALLOWED', detail: intent }
  // 只有“结合视频语境”的短评论必须有交友类视频支撑，否则退回人工判断。
  if (!goalMatch && intent === 'CONTEXTUAL_INTEREST' && !isFriendVideo(video)) return { ok: false, reason: 'VIDEO_CONTEXT_NOT_FRIEND', detail: '所属视频不是交友主题，短评论不能按交友意愿处理' }
  if (!comment.author_id) return { ok: false, reason: 'MISSING_AUTHOR_ID', detail: '评论缺少作者 sec_uid，无法定位主页' }
  if (!comment.author_name) return { ok: false, reason: 'MISSING_NICKNAME', detail: '评论缺少作者昵称' }
  const videoId = comment.video_id || video?.video_id || null
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return { ok: false, reason: 'VIDEO_ID_INVALID', detail: `视频 ID 不可用：${videoId || '空'}` }
  if (!String(comment.text || '').trim()) return { ok: false, reason: 'EMPTY_TEXT', detail: '评论正文为空' }
  return { ok: true }
}

function staleClassification(comment, video) {
  const classification = comment?.classification || {}
  // 人工审核过的标签是用户结论，不因模型输入变化而失效。
  if (classification.reviewedByUser) return false
  if (!classification.inputHash) return false
  return classification.inputHash !== commentInputHash(comment, video)
}

function candidateRecords(library, { excludePlatformUserIds = [], excludeNames = [], goalDecisions = null, goal = null } = {}) {
  const videoByKey = new Map()
  const blockedIds = new Set((excludePlatformUserIds || []).map(String).filter(Boolean))
  const blockedNames = new Set((excludeNames || []).map(item => String(item).trim()).filter(Boolean))
  for (const video of library.videos || []) {
    if (video.video_id) videoByKey.set(`id:${video.video_id}`, video)
    if (video.video_url) videoByKey.set(`url:${video.video_url}`, video)
  }
  const videoOf = comment => (comment.video_id && videoByKey.get(`id:${comment.video_id}`))
    || (comment.video_url && videoByKey.get(`url:${comment.video_url}`)) || null
  // 同一作者只要有一条仍与当前语境一致、且明确拒绝联系的评论，就覆盖其先前任何积极意愿。
  const rejectedIds = new Set()
  for (const comment of library.comments || []) {
    if (comment.classification?.intent !== 'DO_NOT_CONTACT') continue
    if (!comment.author_id || staleClassification(comment, videoOf(comment))) continue
    rejectedIds.add(String(comment.author_id))
  }
  const records = [], unmapped = []
  for (const comment of library.comments || []) {
    const video = videoOf(comment)
    const match = goalDecisions?.get(comment.key)
    if (goal && match?.label !== 'match') continue
    // 旧分类结果换了视频/标题后不能继续当证据，避免把过期判断带进候选池。
    if (!goal && staleClassification(comment, video)) {
      unmapped.push({ key: comment.key, reason: 'STALE_CLASSIFICATION', detail: '分类结果与当前视频语境不一致，需要重新分类', authorName: comment.author_name })
      continue
    }
    const eligibility = eligibilityOf(comment, video, match)
    if (!eligibility.ok) {
      if (CANDIDATE_INTENTS.includes(comment.classification?.intent)) unmapped.push({ key: comment.key, reason: eligibility.reason, detail: eligibility.detail, authorName: comment.author_name })
      continue
    }
    // 已经是现有联系人或已在黑名单的人，不再进候选池。
    if (blockedIds.has(String(comment.author_id))) { unmapped.push({ key: comment.key, reason: 'ALREADY_CONTACT', detail: '作者已是现有联系人', authorName: comment.author_name }); continue }
    if (blockedNames.has(String(comment.author_name || '').trim())) { unmapped.push({ key: comment.key, reason: 'BLOCKED_NAME', detail: '作者在黑名单或已停止自动回复', authorName: comment.author_name }); continue }
    // 明确拒绝联系：排除该作者所有评论，不留积极意愿。
    if (rejectedIds.has(String(comment.author_id))) { unmapped.push({ key: comment.key, reason: 'DO_NOT_CONTACT', detail: '作者明确拒绝联系', authorName: comment.author_name }); continue }
    const topic = goal?.name || labelOfCategory(video?.classification?.category) || video?.topic || '交友'
    const intent = goal ? 'UNKNOWN' : comment.classification.intent
    const grade = gradeOfIntent(intent)
    const evidence = !goal && Array.isArray(comment.classification?.evidence) ? comment.classification.evidence.filter(item => typeof item === 'string' && item.trim()).slice(0, 6) : []
    // 只有原话明确邀请私信且存在可核对证据，才把“同意接受私信”作为事实带上；
    // 意愿等级 A 本身不等于私信许可，证据为空时不自动设置 consentToDm。
    const directInvite = !goal && intent === 'EXPLICIT_INVITATION' && evidence.length > 0
    const goalMatch = goal && { id: goal.id, version: goal.version, snapshotId: goal.snapshotId, name: goal.name,
      key: comment.key, videoId: comment.video_id, text: comment.text, label: match.label, reason: match.reason,
      evidence: match.evidence, source: match.source, cases: match.cases }
    const profileFacts = buildProfileFacts({ sources: [{ commentText: comment.text }], publicSignals: {}, review: {} })
    records.push({
      _libraryKey: comment.key,
      ...(goalMatch ? { goalMatch } : {}),
      nickname: comment.author_name,
      platformUserId: comment.author_id,
      platformUserIdType: 'sec_uid',
      profileUrl: `https://www.douyin.com/user/${comment.author_id}`,
      avatarUrl: comment.avatar_url || '',
      score: Math.round((Number(comment.classification?.confidence) || 0.5) * 100),
      libraryIntent: goal ? 'UNKNOWN' : intent,
      libraryEvidence: evidence,
      intentConfidence: Number.isFinite(comment.classification?.confidence) ? comment.classification.confidence : null,
      discoveryGrade: grade,
      discoveryGradeLabel: GRADE_LABELS[grade],
      // 发现状态：CONTEXTUAL_INTEREST 证据不足；明确/一般意愿先标 DISCOVERED，等待用户条件筛选。
      discoveryStatus: discoveryStatusOf(intent),
      discoveryStatusNote: goal ? '已匹配自定义寻找目标，联系资格独立判断' : intent === 'CONTEXTUAL_INTEREST' ? '仅结合视频语境的短评论，缺少明确交友证据' : '意愿等级不等于私信许可，仍需人工确认',
      explicitInvitation: directInvite,
      consentToDm: directInvite,
      commentTime: comment.created_at || null,
      // 年龄/性别先按本条评论原话抽本人自述；主页公开资料与人工核验在候选合并时补齐。
      // 只认自我指称，不从"想找个男生"或头像昵称反推。
      ageVerification: profileFacts.age.status,
      genderVerification: profileFacts.gender.status,
      profileFacts,
      signals: goal ? [`寻找目标：${goal.name}`] : [
        `评论意愿：${LABELS[intent] || intent}（${grade} 级）`,
        directInvite ? '原话明确欢迎认识或私信，且带可核对证据' : intent === 'EXPLICIT_INVITATION' ? '原话像邀请但缺少可核对证据，未设置私信同意' : '仅潜在交友意愿，未表示同意私信',
        `所属视频类型：${labelOfCategory(video?.classification?.category) || '未分类'}`,
      ],
      source: {
        type: 'comment',
        topic,
        keyword: keywordOf(video, topic),
        videoId: comment.video_id || video?.video_id,
        videoTitle: video?.title || '',
        commentId: comment.comment_id || undefined,
        commentText: comment.text,
        activitySource: 'public_comment',
        // P2-17B.2：评论级依据。页面没有该字段时显式标 not_present，筛选层据此判定"不可核实"，
        // 不用主页所在地或 0 条回复顶替。
        ...(Number.isSafeInteger(comment.reply_count) && comment.reply_count >= 0 ? { replyCount: comment.reply_count } : { replyCount: null }),
        ...(comment.ip_location ? { commentIpLocation: comment.ip_location, commentIpLocationSource: comment.ip_location_source || 'unknown' }
          : { commentIpLocation: null, commentIpLocationSource: 'not_present' }),
        ...(comment.created_at ? { publishedAt: comment.created_at } : {}),
      },
      // 跨视频来源会由 CandidateManager 合并；这里保留本条评论的完整证据。
      librarySource: {
        videoKey: video?.key || null,
        videoId: comment.video_id || video?.video_id || null,
        videoUrl: comment.video_url || video?.video_url || null,
        videoTitle: video?.title || '',
        folder: video?.favoritesFolder || null,
        commentKey: comment.key,
        commentTime: comment.created_at || null,
        intent,
        evidence,
        inputHash: comment.classification?.inputHash || null,
        reviewedByUser: comment.classification?.reviewedByUser === true,
      },
    })
  }
  // 非候选评论的等级统计（D 类不入池），用于界面区分“候选”和“普通/广告/拒绝”。
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 }
  for (const comment of library.comments || []) {
    if (staleClassification(comment, videoOf(comment))) continue
    const intent = comment.classification?.intent
    if (!intent) continue
    gradeCounts[gradeOfIntent(intent)] += 1
  }
  return { records, unmapped, rejectedPlatformUserIds: [...rejectedIds], rejectedCount: rejectedIds.size, gradeCounts }
}

function originFromComment(comment, video, { candidateId = null } = {}) {
  const topic = labelOfCategory(video?.classification?.category) || video?.topic || null
  return {
    platform: PLATFORM,
    source_type: 'video_comments',
    video_topic: topic,
    video_id: comment.video_id || video?.video_id || null,
    video_url: comment.video_url || video?.video_url || null,
    video_title: video?.title || null,
    comment_text: comment.text || null,
    note: null,
    verified_by_user: false,
    evidence: {
      candidateId,
      libraryCommentKey: comment.key,
      libraryVideoKey: video?.key || null,
      capturedAt: new Date().toISOString(),
    },
  }
}

function findCommentForCandidate(candidate, library) {
  const comments = library.comments || []
  const videoId = candidate?.source?.videoId || null
  const commentId = candidate?.source?.commentId || null
  const platformUserId = candidate?.platformUserId || null
  if (commentId) {
    const hit = comments.find(item => item.comment_id === commentId && (!platformUserId || item.author_id === platformUserId))
    if (hit) return hit
  }
  const text = String(candidate?.source?.commentText || candidate?.firstComment || '').replace(/\s+/g, ' ').trim()
  return comments.find(item => (!platformUserId || item.author_id === platformUserId) && (!videoId || item.video_id === videoId) && String(item.text || '').replace(/\s+/g, ' ').trim() === text) || null
}

function findVideoForComment(comment, library) {
  const videos = library.videos || []
  if (comment?.video_id) {
    const hit = videos.find(item => item.video_id === comment.video_id)
    if (hit) return hit
  }
  if (comment?.video_url) return videos.find(item => item.video_url === comment.video_url) || null
  return null
}

function originForCandidate(candidate, library) {
  const comment = findCommentForCandidate(candidate, library)
  if (!comment) return { ok: false, error: 'MISSING_LIBRARY_COMMENT', detail: '本地库里找不到这条评论的原始记录' }
  const video = findVideoForComment(comment, library)
  return { ok: true, origin: originFromComment(comment, video, { candidateId: candidate.id }), comment, video }
}

module.exports = {
  PLATFORM, VIDEO_ID_PATTERN, DISCOVERY_GRADES, GRADE_LABELS, GRADE_OF_INTENT, DISCOVERY_STATUS,
  labelOfCategory, keywordOf, eligibilityOf, gradeOfIntent, discoveryStatusOf,
  candidateRecords, originFromComment, findCommentForCandidate, findVideoForComment, originForCandidate,
}
