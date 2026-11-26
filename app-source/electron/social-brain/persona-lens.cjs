// Expression emphasis is separate from both contacts' factual profiles.
const { actualMessages, contactKey, relationshipStage, normalizeRelationshipState } = require('./relationship-state.cjs')
const TOPICS = Object.freeze({
  gaming: /游戏|英雄联盟|三角洲|种田|单机|王者|原神|steam|gaming/i,
  running: /跑步|跑马|半马|马拉松|running/i,
  fitness: /健身|撸铁|力量训练|fitness/i,
  sports: /运动|游泳|羽毛球|篮球|足球|sports/i,
  travel: /旅游|旅行|风景|新疆|西安|广西|travel/i,
  food: /美食|吃饭|吃的|火锅|烧烤|咖啡|food/i,
  music: /音乐|电音|演唱会|歌|music/i,
  pets: /宠物|猫|狗|仓鼠|pets/i,
  study: /研究生|论文|开题|实验室|读研|专业|学习|study/i,
  work: /工作|加班|老板|职业|work/i,
  movies: /电影|影视|短剧|电视剧|movies/i,
})
const list = value => Array.isArray(value) ? value : []
const text = value => typeof value === 'string' ? value.trim().slice(0, 500) : ''
const content = item => [text(item?.key), text(item?.label), ...list(Array.isArray(item?.value) ? item.value : [item?.value]).map(text)].join(' ')
const round = value => Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000
const topicsFor = value => Object.entries(TOPICS).filter(([, regex]) => regex.test(text(value))).map(([name]) => name)
function verifiedFacts(memory, contact) {
  return list(memory?.facts).filter(fact => fact && fact.status === 'fact' && text(fact.evidence) && list(fact.sourceMessageIds).some(id => text(id))
    && (!fact.contactId || fact.contactId === contactKey(contact))).slice(-80)
}
function permittedSelfItems(items) {
  return list(items).filter(item => item && item.shareLevel !== 'PRIVATE' && item.shareLevelSuggestion !== 'PRIVATE' && item.status !== 'uncertain' && item.verified !== false).slice(0, 12)
}
function buildPersonaLens({ contact = {}, memory = contact.socialBrain, messages = contact?.learning?.messages || [], relationshipState = contact.relationshipState,
  attention, conversationState, activeTopic = conversationState?.activeTopic || attention?.activeTopic, selectedFocus = attention?.selectedFocus,
  momentum, selfRelevantItems, selfProfileRelevant = selfRelevantItems || [], previousLens = contact.personaLens, now = Date.now() } = {}) {
  const relation = normalizeRelationshipState(relationshipState, { contact, now }), stage = relationshipStage(contact)
  const rows = actualMessages(messages, contact), inbound = rows.filter(row => row.role === 'contact').slice(-12)
  const knownIds = new Set(rows.map(row => row.id)), facts = verifiedFacts(memory, contact)
  for (const fact of facts) for (const id of fact.sourceMessageIds) knownIds.add(id)
  const scores = new Map(), evidence = []
  const add = (topic, strength, ids, kind) => {
    const sources = [...new Set(list(ids).filter(id => knownIds.has(id)))].slice(-8)
    if (!sources.length) return
    const prior = scores.get(topic)
    scores.set(topic, { topic, strength: Math.max(prior?.strength || 0, strength), sourceMessageIds: [...new Set([...(prior?.sourceMessageIds || []), ...sources])].slice(-8) })
    evidence.push({ topic, kind, sourceMessageIds: sources })
  }
  for (const fact of facts.filter(fact => ['interest', 'interests', 'gaming', 'sports', 'music', 'travel', 'food', 'hobby'].includes(fact.field || fact.key))) {
    for (const topic of topicsFor(content(fact))) add(topic, 0.72, fact.sourceMessageIds, 'contact_verified_interest')
  }
  for (const [value, kind, weight] of [[activeTopic, 'active_topic', 0.82], [selectedFocus, 'selected_focus', 0.78]]) {
    for (const topic of topicsFor(value?.summary || value?.text)) add(topic, weight, value?.sourceMessageIds || [value?.messageId], kind)
  }
  // A successful common thread needs real contributions by both parties, not
  // a generated topic description or an arbitrary remembered score.
  for (const node of list(conversationState?.topicTree).slice(-8)) {
    const participating = rows.filter(row => list(node.sourceMessageIds).includes(row.id))
    if (!participating.some(row => row.role === 'me') || !participating.some(row => row.role === 'contact')) continue
    if (!participating.some(row => row.role === 'contact' && /哈哈|喜欢|好玩|有意思|不错|我也/.test(row.text))) continue
    for (const topic of topicsFor(node.summary)) add(topic, 0.65, node.sourceMessageIds, 'successful_shared_topic')
  }
  const selfTopics = new Set(permittedSelfItems(selfProfileRelevant).flatMap(item => topicsFor(content(item))))
  const prior = previousLens?.contactId === contactKey(contact) ? previousLens : null
  const adaptiveAffinities = [...scores.values()].sort((a, b) => b.strength - a.strength).slice(0, 6).map(item => {
    const previous = list(prior?.adaptiveAffinities).find(value => value.topic === item.topic)
    const strength = previous && Number.isFinite(previous.strength) ? round(Math.max(previous.strength - 0.08, Math.min(previous.strength + 0.08, item.strength))) : item.strength
    return { ...item, strength, level: strength, kind: 'TEMPORARY_AFFINITY', factual: false, realCommonInterest: selfTopics.has(item.topic),
      allowedExpression: 'interest_and_attitude_only', mayCreateExperience: false }
  })
  const substantive = inbound.filter(row => row.text), meanLength = substantive.length ? substantive.reduce((total, row) => total + [...row.text].length, 0) / substantive.length : 0
  const joking = substantive.filter(row => /哈哈|笑死|绷不住|离谱|嘿嘿|抽象/.test(row.text)).length
  const expressive = substantive.filter(row => /[!！]{1,}|哈哈|好耶|笑死/.test(row.text)).length
  const engaged = momentum?.engagement?.level === 'HIGH' && inbound.length > 0
  const quiet = substantive.length >= 2 && meanLength < 8 && !expressive
  const newContact = ['NEW_CONTACT', 'STRANGER', 'EXPLORING'].includes(stage), humor = Math.min(newContact ? 0.55 : 0.85, 0.28 + relation.playfulness * 0.3 + (joking ? 0.12 : 0) - (quiet ? 0.12 : 0))
  const style = { energy: round(0.4 + (engaged ? 0.12 : 0) + (expressive ? 0.12 : 0) - (quiet ? 0.16 : 0)),
    warmth: round(Math.min(newContact ? 0.7 : 0.85, 0.4 + relation.warmth * 0.35)), humor: round(humor),
    curiosity: round(0.35 + relation.curiosity * 0.25 - (quiet ? 0.12 : 0) - (momentum?.reciprocity?.questionsByMe >= 2 ? 0.1 : 0)),
    playfulness: round(Math.min(newContact ? 0.45 : 0.8, 0.18 + relation.playfulness * 0.45 + (joking ? 0.12 : 0))) }
  const emphasis = adaptiveAffinities.map(item => item.topic)
  if (joking) emphasis.push('casual_humor')
  return { version: 1, contactId: contactKey(contact), kind: 'ADAPTIVE_PERSONA', emphasis: [...new Set(emphasis)].slice(0, 7), adaptiveAffinities,
    style, relationshipStage: stage, evidence: evidence.slice(-16), updatedAt: relation.updatedAt,
    constraints: { factualIdentityUnchanged: true, neverPromoteAffinityToFact: true, noInventedSpecificExperience: true, doNotInferFromAvatar: true, researchTopicDefaultWeight: 'low_unless_relevant' } }
}

module.exports = { TOPICS, topicsFor, verifiedFacts, permittedSelfItems, buildPersonaLens }
