// Contact-scoped self narrative extraction. Only AI-authored, already-sent
// statements about the AI itself are eligible. Entries are stored verbatim, so
// no model is asked to invent or rewrite anything.
const { normalizeSelfNarrative, upsertSelfNarrative, selfStatementMessages, contactKey, hash, clock } = require('./self-narrative.cjs')
const list = value => Array.isArray(value) ? value : []
const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
// Granular keys let ranked/ARAM/server habits stay separate while still
// collapsing paraphrases of the same habit onto one entry.
// `selfFact` marks a topic whose matches are a concrete first-person fact
// (server, availability, self-rated skill). Such a statement is stored even
// without a habit marker; every other topic still needs one.
const SELF_TOPICS = Object.freeze([
  { key: 'lol_rank', match: /排位|上分|段位|ranked/i, terms: ['排位', '上分', '段位'] },
  { key: 'lol_aram', match: /大乱斗|极地大乱斗|\bARAM\b/i, terms: ['大乱斗', 'ARAM'] },
  { key: 'lol_server', match: /黑色玫瑰|艾欧尼亚|祖安|德玛西亚|诺克萨斯|班德尔城|皮尔特沃夫|比尔吉沃特|弗雷尔卓德|峡谷之巅/, terms: ['黑色玫瑰', '艾欧尼亚', '祖安', '德玛西亚', '诺克萨斯', '班德尔城'], selfFact: true },
  { key: 'lol', match: /英雄联盟|\bLOL\b|开黑/i, terms: ['英雄联盟', 'LOL', '开黑'] },
  { key: 'cycling', match: /骑车|骑行|单车|自行车/, terms: ['骑车', '骑行', '单车', '自行车'] },
  { key: 'selfie', match: /自拍/, terms: ['自拍'] },
  { key: 'swimming', match: /游泳/, terms: ['游泳'] },
  { key: 'fitness', match: /健身|撸铁|跑步|晨跑/, terms: ['健身', '撸铁', '跑步'] },
  { key: 'sleep', match: /起得(?:比较)?(?:晚|早)|晚睡|熬夜|早睡|作息|睡懒觉/, terms: ['起得晚', '起得早', '熬夜', '作息', '睡懒觉'] },
  { key: 'game_other', match: /三角洲|永劫|王者|原神|吃鸡|无畏契约|\bCS2?\b/i, terms: ['三角洲', '永劫', '王者', '原神', '吃鸡'] },
  { key: 'travel', match: /旅游|旅行|出去玩|自驾/, terms: ['旅游', '旅行', '自驾'] },
  { key: 'food', match: /吃辣|火锅|口味|奶茶|咖啡/, terms: ['吃辣', '火锅', '口味', '奶茶', '咖啡'] },
  { key: 'music', match: /听歌|音乐|电音|演唱会|乐队|唱歌/, terms: ['听歌', '音乐', '电音', '演唱会', '唱歌'] },
  { key: 'pet', match: /养猫|养狗|养了|仓鼠|宠物/, terms: ['养猫', '养狗', '仓鼠', '宠物'] },
  { key: 'work', match: /上班|加班|工作|实习/, terms: ['上班', '加班', '工作', '实习'] },
  { key: 'study', match: /上课|课程|实验室|论文|考试|专业|答辩|考研/, terms: ['上课', '实验室', '论文', '考试', '专业'] },
  { key: 'availability', match: /有空|没空|不忙|得空|有时间|时间安排/, terms: ['有空', '时间', '周末', '什么时候', '忙不忙', '方便'], selfFact: true },
  { key: 'self_eval', match: /菜得很|很菜|比较菜|有点菜|我菜|技术|水平|打得(?:好|差|一般|还行|怎么样)|厉害|强不强|萌新|菜鸟/, terms: ['菜', '厉害', '水平', '技术', '打得怎么样', '强不强'], selfFact: true },
])
const substantive = text => !/^(?:哈哈+|嘿嘿+|嗯+|好的?|行|在干嘛|吃(?:饭|了)|你好|嗨|笑死|这个确实|我感觉还行|还行|可以)[!！。~\s]*$/.test(text)
const question = text => /[?？]/.test(text) || /(?:吗|呢|嘛)[。！!~\s]*$/.test(text)
const thirdParty = text => /我(?:的)?(?:朋友|同学|同事|室友|家人|妈|爸|哥|姐|弟|妹|表|堂)|别人|他们说|他说|她说|有人/.test(text)
const futurePlan = text => /明天|下次|改天|以后|待会|一会|这两天|下周|马上|回头|等会|晚点/.test(text)
// Chinese often drops the subject ("排位基本不碰"). A first-person marker is
// enough to accept, and a statement with no other-person subject is accepted
// too; anything addressed to or about someone else is not a self statement.
const selfReference = text => /我|咱/.test(text)
const addressesOther = text => /你|他|她|别人|有人/.test(text)
const attribute = text => /平时|最近|以前|经常|一般|平常|基本|习惯|很少|不太|不怎么|其实|挺|比较|喜欢|爱|玩|有(?:个|一个)?/.test(text)
function matchedTopics(text) { return SELF_TOPICS.filter(item => item.match.test(text)) }
function buildSelfNarrativeCandidates({ contact = {}, messages = contact.sharedMemoryLedger || [], now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), store = normalizeSelfNarrative(contact, { now, selfProfile })
  const rows = selfStatementMessages(messages, contact, { now, selfProfile })
  const groups = new Map()
  for (const row of rows) {
    const text = clean(row.text, 200)
    if (!(selfReference(text) || !addressesOther(text)) || question(text) || thirdParty(text) || futurePlan(text) || !substantive(text)) continue
    const matched = matchedTopics(text)
    if (!matched.length) continue
    // A concrete first-person fact ("我在黑色玫瑰") counts even without a habit
    // marker, but only for `selfFact` topics. Mood and filler lines match no topic
    // at all, so "只要有我" never becomes a storage rule.
    if (!attribute(text) && !matched.some(item => item.selfFact)) continue
    const groupKey = matched[0].key
    const terms = [...new Set(matched.flatMap(item => item.terms))]
    const group = groups.get(groupKey) || { key: groupKey, rows: [], terms: [] }
    group.rows.push(row); group.terms = [...new Set([...group.terms, ...terms])]
    groups.set(groupKey, group)
  }
  const candidates = []
  for (const group of groups.values()) {
    const ordered = group.rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const statement = clean(ordered.at(-1).text, 200)
    const existing = store.narratives.find(item => item.key === group.key)
    if (existing && existing.statement === statement) continue
    const id = `snc_${hash([key, group.key, statement, ordered.map(row => row.id)])}`
    if (store.processedCandidateIds.includes(id)) continue
    candidates.push({ id, contactId: key, key: group.key, statement, topics: group.terms.slice(0, 6),
      sourceMessages: ordered.map(row => ({ id: row.id, contactId: key, role: 'me', text: row.text, at: row.at, source: row.source, status: 'sent', confirmedSent: true, provenance: 'ai_self_statement' })),
      sourceMessageIds: ordered.map(row => row.id), existingNarrativeId: existing?.id || null, previousStatement: existing?.statement || null })
  }
  return candidates.slice(-8)
}
function extractSelfNarratives({ contact = {}, messages = contact.sharedMemoryLedger || [], now = Date.now(), selfProfile } = {}) {
  const store = normalizeSelfNarrative(contact, { now, selfProfile })
  const candidates = buildSelfNarrativeCandidates({ contact: { ...contact, selfNarrative: store }, messages, now, selfProfile })
  if (!candidates.length) return { selfNarrative: store, candidates: [], changed: false, added: 0, updated: 0 }
  let added = 0, updated = 0
  for (const candidate of candidates) {
    const existed = Boolean(candidate.existingNarrativeId)
    upsertSelfNarrative(store, candidate, { now })
    store.processedCandidateIds.push(candidate.id)
    if (existed) updated += 1; else added += 1
  }
  store.revision += 1
  store.updatedAt = new Date(clock(now)).toISOString()
  store.narratives = store.narratives.slice(-60)
  store.processedCandidateIds = [...new Set(store.processedCandidateIds)].slice(-256)
  return { selfNarrative: store, candidates, changed: true, added, updated }
}
module.exports = { SELF_TOPICS, buildSelfNarrativeCandidates, extractSelfNarratives }
