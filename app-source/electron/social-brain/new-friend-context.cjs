const { relationshipStage: inferStage, actualMessages } = require('./relationship-state.cjs')
const { topicsFor, verifiedFacts, permittedSelfItems } = require('./persona-lens.cjs')
const list = value => Array.isArray(value) ? value : []
const text = value => typeof value === 'string' ? value.trim().slice(0, 400) : ''
const AREAS = Object.freeze(['studyWorkStatus', 'major', 'grade', 'city', 'hometown', 'currentLife', 'gamePreference', 'music', 'movies', 'sports', 'travel', 'food', 'dailyLife'])
const AREA_FIELDS = Object.freeze({ studyWorkStatus: ['occupation', 'education', 'studyWorkStatus'], major: ['major'], grade: ['grade', 'year', 'schoolYear'],
  city: ['city'], hometown: ['province', 'hometown'], currentLife: ['current_life', 'currentLife'], gamePreference: ['gaming', 'gamePreference'], music: ['music'],
  movies: ['movies'], sports: ['sports', 'fitness', 'running'], travel: ['travel'], food: ['food'], dailyLife: ['routine', 'dailyLife'] })
const TOPIC_AREAS = Object.freeze({ gaming: 'gamePreference', running: 'sports', fitness: 'sports', sports: 'sports', travel: 'travel', food: 'food', music: 'music', movies: 'movies', study: 'studyWorkStatus', work: 'studyWorkStatus' })
const QUESTION_AREAS = Object.freeze({ grade: /研几|大几|几年级|年级/, major: /什么专业|啥专业|学什么|学啥|专业方向/,
  city: /哪个城市|在哪(?:里)?(?:工作|生活|上班)|住哪/, hometown: /哪里人|哪的人|老家|家乡/,
  studyWorkStatus: /什么工作|做什么工作|做啥|什么职业|上学还是|读书还是/,
  gamePreference: /玩什么游戏|玩啥游戏|什么游戏|游戏/, music: /音乐|听什么歌|歌手/, sports: /运动|跑步|健身|游泳|羽毛球/,
  travel: /旅游|旅行/, food: /美食|喜欢吃|吃什么/, currentLife: /最近.*忙|最近在干嘛/, movies: /电影|短剧|电视剧/ })

function knownAreas(memory, contact) {
  const facts = verifiedFacts(memory, contact), known = new Set(), identity = {}
  for (const [key, value] of Object.entries(memory?.profile?.identity || {})) {
    if (value?.status !== 'fact' || !value.value || !list(value.sourceMessageIds).length) continue
    identity[key] = { value: value.value, sourceMessageIds: value.sourceMessageIds.slice(-4), status: 'fact' }
    for (const [area, fields] of Object.entries(AREA_FIELDS)) if (fields.includes(key)) known.add(area)
  }
  for (const fact of facts) {
    const field = fact.field || fact.key
    for (const [area, fields] of Object.entries(AREA_FIELDS)) if (fields.includes(field)) known.add(area)
    if (field === 'interest') for (const topic of topicsFor(Array.isArray(fact.value) ? fact.value.join(' ') : fact.value)) if (TOPIC_AREAS[topic]) known.add(TOPIC_AREAS[topic])
    if (['grade', 'year', 'schoolYear', 'city', 'major', 'occupation', 'school', 'province'].includes(field)) identity[field] = { value: fact.value, sourceMessageIds: fact.sourceMessageIds.slice(-4), status: 'fact' }
  }
  return { known, identity }
}
function explicitRefusals(memory, contact, messages, incoming) {
  const rows = actualMessages(messages, contact), refused = new Set()
  const refusalPattern = /不想说|不方便说|别(?:再)?问|不告诉|不要问|不愿意说/
  const hardHistory = list(memory?.learningHistory).filter(item => ['refused', 'declined'].includes(item.result) || item.result === 'avoided' && refusalPattern.test(item.evidence || item.reason || ''))
  for (const attempt of hardHistory) {
    for (const [area, fields] of Object.entries(AREA_FIELDS)) if (fields.includes(attempt.topic) || area === attempt.topic) refused.add(area)
  }
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].role !== 'contact' || !refusalPattern.test(rows[index].text) || rows[index].quote) continue
    const previous = rows.slice(0, index).findLast(row => row.role === 'me')
    const scope = `${rows[index].text} ${previous?.text || ''}`
    for (const [area, regex] of Object.entries(QUESTION_AREAS)) if (regex.test(scope)) refused.add(area)
  }
  if (refusalPattern.test(incoming)) for (const [area, regex] of Object.entries(QUESTION_AREAS)) if (regex.test(incoming)) refused.add(area)
  return [...refused]
}

function buildNewFriendContext({ contact = {}, memory = contact.socialBrain, relationshipStage, relationshipState, personaLens,
  selfRelevantItems, selfProfileRelevant = selfRelevantItems || [], approvedSelfDisclosure,
  attention, conversationState, activeTopic = conversationState?.activeTopic || attention?.activeTopic, selectedFocus = attention?.selectedFocus,
  momentum, incoming = '', messages = contact?.learning?.messages || [] } = {}) {
  const stage = inferStage(contact, relationshipStage), isNew = ['NEW_CONTACT', 'STRANGER', 'EXPLORING'].includes(stage)
  const acquaintance = stage === 'ACQUAINTANCE', familiar = stage === 'FAMILIAR'
  const relevant = permittedSelfItems(approvedSelfDisclosure || selfProfileRelevant)
  const { known, identity } = knownAreas(memory, contact)
  const refusedAreas = explicitRefusals(memory, contact, messages, incoming), blocked = new Set(refusedAreas)
  const topic = text(activeTopic?.summary || selectedFocus?.summary || incoming)
  const topicKinds = topicsFor(topic), opportunities = []
  const engagement = momentum?.engagement?.level, pressure = Number(momentum?.reciprocity?.questionsByMe || 0)
  const add = (type, score, fields) => opportunities.push({ type, score, ...fields, optional: true })
  const sourceMessageIds = [...new Set(list(activeTopic?.sourceMessageIds || selectedFocus?.sourceMessageIds || [selectedFocus?.messageId]).filter(id => text(id)))].slice(-8)
  if (topic) add('CONTINUE_TOPIC', engagement === 'HIGH' ? 0.94 : 0.8, { topic, sourceMessageIds, reason: '先沿用对方当前表达，不为补齐未知资料转移话题' })
  const selfTopics = new Set(relevant.flatMap(item => topicsFor(`${text(item.key)} ${text(item.label)} ${Array.isArray(item.value) ? item.value.join(' ') : text(item.value)}`)))
  for (const topicKind of topicKinds) {
    const affinity = list(personaLens?.adaptiveAffinities).find(item => item.topic === topicKind && item.factual === false)
    if (selfTopics.has(topicKind)) add('COMMON_GROUND', 0.88, { topic: topicKind, basis: 'approved_self_fact', reason: '有披露允许的真实共同方向' })
    else if (affinity) add('COMMON_GROUND', 0.66, { topic: topicKind, basis: 'temporary_affinity', reason: '可以积极关注对方兴趣，不声称已有具体经历' })
    // Broad sports commonality never turns fitness/swimming into a running record.
    else if (['running', 'fitness', 'sports'].includes(topicKind) && [...selfTopics].some(value => ['running', 'fitness', 'sports'].includes(value))) add('COMMON_GROUND', 0.75, { topic: 'sports', basis: 'related_approved_self_fact', reason: '运动方向相近，不假装做过对方的具体运动' })
  }
  for (const item of relevant.slice(0, 4)) add('SELF_DISCLOSURE', pressure >= 2 ? 0.84 : 0.73, { profileKey: text(item.key), reason: '可选地分享已筛选的真实本人信息，形成双向交流' })
  const reciprocityAreas = Object.entries(QUESTION_AREAS).filter(([, pattern]) => pattern.test(incoming) && /你|[?？]|吗|研几|大几/.test(incoming)).map(([area]) => area)
  const topicAreas = topicKinds.map(kind => TOPIC_AREAS[kind]).filter(Boolean)
  for (const area of [...new Set([...reciprocityAreas, ...topicAreas])]) {
    if (known.has(area) || blocked.has(area)) continue
    add('RECIPROCAL_ASK', pressure >= 2 ? 0.28 : reciprocityAreas.includes(area) ? 0.69 : 0.48, { area,
      reason: reciprocityAreas.includes(area) ? '对方主动问了相关本人信息，可选择自然反问' : '当前话题自然提供了解方向，可选择不问', neverRequired: true })
  }
  const positive = /终于|好耶|成功|通过了|交了|搞定|开心|太棒/.test(incoming)
  const negative = /累死|烦|难过|崩溃|失败|凉了|加班|委屈/.test(incoming)
  const playful = /哈哈|笑死|绷不住|离谱|嘿嘿|抽象/.test(incoming)
  const emotionalValue = { preference: 'high', cues: [...(positive ? ['celebrate'] : []), ...(negative ? ['empathy_or_shared_complaint'] : []), ...(playful ? ['light_playfulness'] : [])],
    guidance: '理解、共鸣或轻松反馈均可，不要求每轮夸人或获得新信息' }
  const learning = { priority: 'low', optional: true, allowNone: true, candidates: opportunities.filter(item => item.type === 'RECIPROCAL_ASK').map(item => ({ area: item.area, score: item.score, optional: true })),
    suppressedAreas: [...new Set([...known, ...blocked])], reason: pressure >= 2 ? '近期问题较多，分享、接梗、反应或继续当前话题也是成功互动' : '资料学习不是本轮必须完成的任务' }
  return { version: 1, relationshipStage: stage, socialGoal: isNew ? 'BUILD_CONNECTION' : ['ACQUAINTANCE', 'FAMILIAR'].includes(stage) ? 'DEVELOP_CONNECTION' : 'MAINTAIN_CONNECTION',
    preferences: { conversationContinuity: 'very_high', emotionalValue: 'high', commonGround: isNew || acquaintance ? 'high' : 'medium', mutualUnderstanding: 'medium', factCollection: 'low',
      dailySharing: isNew || acquaintance ? 'medium' : 'high', meaninglessChat: 'allowed', videoSharing: isNew || acquaintance ? 'medium' : 'high', callback: isNew ? 'medium' : 'high', lightProactivity: familiar ? 'optional' : isNew || acquaintance ? 'low' : 'available_under_existing_send_rules' },
    emotionalValue, opportunities: opportunities.slice(0, 12), explorationDirections: AREAS.filter(area => !known.has(area) && !blocked.has(area)),
    knownIdentity: identity, knownAreas: [...known], refusedAreas, learning,
    interactionRisks: { questionPressure: pressure, guidance: pressure >= 2 ? '降低采访感，其他社交行为仍由Planner选择' : '可以顺势双向交流' },
    hardGuards: { doNotRepeatRefusedAreas: refusedAreas, privateDisclosureForbidden: true, noFabricatedExperience: true, preserveNoReply: true,
      stopConversation: /别再联系|不要联系|不想聊|不用回复|别回了/.test(incoming) },
    relationshipState: relationshipState ? Object.fromEntries(['warmth', 'familiarity', 'curiosity', 'playfulness', 'trust', 'flirt'].map(key => [key, relationshipState[key]])) : null,
    guidance: '机会是建议而非动作命令；不按最高分自动执行。允许玩笑、吐槽、表情、无意义但愉快的闲聊，以及learning=none。新朋友优先自然交流，老朋友可更多日常与旧话题。' }
}

module.exports = { AREAS, AREA_FIELDS, QUESTION_AREAS, knownAreas, explicitRefusals, buildNewFriendContext }
