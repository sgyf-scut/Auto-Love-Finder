const { activeSelfItems, inferShareLevel, containsPrivateData, normalizeSelfProfile } = require('./self-profile.cjs')

const GROUPS = [
  { id: 'gaming', keys: /gaming|games?|游戏/i, words: /游戏|英雄联盟|LOL|三角洲|种田|单机|打游戏|游戏党|steam/i },
  { id: 'sports', keys: /sports|fitness|swimming|运动|健身|游泳/i, words: /运动|健身|游泳|羽毛球|跑步|跑马|马拉松|半马|配速|体育|锻炼/i },
  { id: 'travel', keys: /travel|旅游/i, words: /旅游|旅行|出去玩|风景|景点|广西|西安|新疆/i },
  { id: 'food', keys: /food|diet|interests|饮食|美食|兴趣/i, words: /美食|吃啥|吃什么|吃的|吃饭|火锅|奶茶|烧烤|酒|喝酒/i },
  { id: 'music', keys: /music|interests|音乐|兴趣/i, words: /音乐|电音|听歌|演唱会|歌手/i },
  { id: 'entertainment', keys: /shows?|interests|影视|兴趣/i, words: /短剧|电影|电视剧|追剧/i },
  { id: 'education', keys: /school|education|grade|major|学历|学校|专业|年级/i, words: /学校|大学|本科|硕士|研究生|研几|年级|专业|读书|上学/i },
  { id: 'work', keys: /currentWork|research|project|occupation|work|科研|职业|项目/i, words: /论文|科研|实验|开题|开发|项目|气雾剂|工作|职业|做什么的|做啥的/i },
  { id: 'routine', keys: /routine|schedule|日常|作息|时间/i, words: /日常|作息|几点|起床|实验室|忙啥|忙什么|下班/i },
  { id: 'hometown', keys: /hometown|city|province|老家|城市/i, words: /哪里人|哪的人|老家|家乡|城市|住哪|在哪|三明|宁化|福建/i },
  { id: 'name', keys: /^name$|姓名/i, words: /叫什么|叫啥|名字|姓名|怎么称呼/i },
  { id: 'age', keys: /birthDate|birthday|^age$|出生|年龄/i, words: /年龄|几岁|多大|哪年|生日|出生/i },
]
function contextText(context = {}) {
  const payload = context.payload || context
  const attention = payload.attentionContext || context.attentionContext || {}
  const burst = payload.currentIncomingBurst || context.currentIncomingBurst
  const burstText = (Array.isArray(burst?.messages) ? burst.messages : []).filter(item => !item.role || item.role === 'contact').map(item => String(item.text || '').slice(0, 1000)).join(' ').slice(0, 3000)
  const fields = [payload.incoming, context.incoming, burstText, payload.activeTopic, context.activeTopic, attention.activeTopic, payload.selectedFocus, context.selectedFocus, attention.selectedFocus, context.question, payload.counterpartQuestion]
  return fields.map(value => typeof value === 'string' ? value : value?.text || value?.summary || value?.topic || value?.label || '').filter(Boolean).join(' ').slice(0, 4000)
}
function isSelfProfileEnabled(profile) { return Boolean(profile && profile.enabled !== false && activeSelfItems(profile).length) }
function privateItems(profile) {
  const normalized = normalizeSelfProfile(profile)
  return [...normalized.stableProfile, ...normalized.currentLife].filter(item => preferenceLevel(item, normalized) === 'PRIVATE')
}
function collectPrivateValues(profile) {
  return [...new Set(privateItems(profile).flatMap(item => [item.sourceText, ...(Array.isArray(item.value) ? item.value : [item.value])]).filter(value => value !== null && String(value).length >= 2).map(String))].sort((a, b) => b.length - a.length)
}
const AUTO_PRIVATE = /\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|\b\d{16,19}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:密码|验证码|身份证|银行卡|银行账号|微信号|QQ号|手机号|电话号|账号密码|API\s*Key|密钥|口令)\s*[:：是为]?\s*[^\s，。；;]{2,}|(?:路|街|巷)\s*\d+号|\d+(?:栋|幢|单元|室)|sk-[A-Za-z0-9_-]{8,}/gi
function redactPrivateData(value, profile) {
  const secrets = collectPrivateValues(profile), seen = new WeakSet()
  const redact = input => {
    if (typeof input === 'string') {
      let text = input
      for (const secret of secrets) text = text.split(secret).join('[私密信息]')
      return text.replace(AUTO_PRIVATE, '[私密信息]')
    }
    if (typeof input === 'number' && (secrets.includes(String(input)) || containsPrivateData(String(input)))) return '[私密信息]'
    if (input === null || typeof input !== 'object') return input
    if (seen.has(input)) return null
    seen.add(input)
    const result = Array.isArray(input) ? input.map(redact) : Object.fromEntries(Object.entries(input).map(([key, child]) => [redact(key), redact(child)]))
    seen.delete(input)
    return result
  }
  return redact(value)
}
function preferenceLevel(item, profile) {
  if (inferShareLevel(item) === 'PRIVATE') return 'PRIVATE'
  const related = profile.privacyPreferences.filter(preference => preference.key === item.key || (/school|education/i.test(item.key) && /school|education/i.test(preference.key)))
  const ranks = ['OPEN', 'NORMAL', 'CAUTIOUS', 'PRIVATE']
  return related.reduce((level, preference) => ranks.indexOf(inferShareLevel(preference)) > ranks.indexOf(level) ? inferShareLevel(preference) : level, item.shareLevel)
}
function derivedAge(item, now) {
  if (!/birthDate|birthday/i.test(item.key) || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.value))) return null
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  const age = Number(day.slice(0, 4)) - Number(String(item.value).slice(0, 4)) - Number(day.slice(5) < String(item.value).slice(5))
  return age >= 0 && age < 130 ? { ...item, id: `${item.id}:age`, key: 'age', label: '年龄', value: age, shareLevel: 'OPEN' } : null
}
function getRelevantSelfProfile(saved, context = {}, { now = new Date(), limit = 5 } = {}) {
  if (saved?.enabled === false) return []
  const profile = normalizeSelfProfile(saved, { now }), text = contextText(context), groups = GROUPS.filter(group => group.words.test(text))
  if (!text || !groups.length) return []
  const rows = []
  for (const original of activeSelfItems(profile, { now })) {
    const shareLevel = preferenceLevel(original, profile)
    if (shareLevel === 'PRIVATE') continue
    const matches = groups.filter(group => group.keys.test(`${original.key} ${original.label}`) || group.words.test((Array.isArray(original.value) ? original.value : [original.value]).join(' ')))
    if (!matches.length) continue
    const item = matches.some(group => group.id === 'age') && /年龄|几岁|多大/.test(text) ? derivedAge(original, now) || original : original
    let value = item.value
    // Broad interest collections must not disclose unrelated interests simply
    // because one member belongs to the current topic.
    if (Array.isArray(value) && /interests|兴趣/i.test(item.key) && !/gaming|video/i.test(item.key)) value = value.filter(part => matches.some(group => group.words.test(String(part))))
    if (Array.isArray(value) && !value.length) continue
    const explicit = /[?？]|你.{0,12}(?:什么|啥|哪|几|吗|名字|年龄)/.test(text)
    rows.push({ id: item.id, key: item.key, label: item.label, value, shareLevel: item === original ? shareLevel : item.shareLevel,
      score: Math.min(1, 0.55 + matches.length * 0.12 + (explicit ? 0.1 : 0)),
      disclosurePreference: shareLevel === 'CAUTIOUS' ? '谨慎软偏好：倾向对方主动问、关系熟悉或上下文自然时使用，不刚认识主动介绍学校。' : shareLevel === 'NORMAL' ? '当前话题相关时可自然使用。' : '可自然使用，仍避免无关资料倾倒。' })
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(8, Number(limit) || 5)))
}
function approveSelfDisclosure(profile, context = {}, plan = {}) {
  if (plan.shouldReply === false || plan.action === 'NO_REPLY' || plan.allowSelfDisclosure === false) return []
  const relevant = getRelevantSelfProfile(profile, context, { now: context.now || new Date() })
  const requested = plan.selfDisclosureKeys || plan.approvedSelfDisclosure || []
  const keys = new Set((Array.isArray(requested) ? requested : []).map(value => typeof value === 'string' ? value : value?.id || value?.key).filter(Boolean))
  return relevant.filter(item => keys.has(item.key) || keys.has(item.id)).slice(0, 3).map(({ id, key, label, value, shareLevel }) => ({ id, key, label, value, shareLevel }))
}
function getPublicInterestPersona(profile, { now = new Date() } = {}) {
  const normalized = normalizeSelfProfile(profile, { now })
  const values = activeSelfItems(normalized, { now }).filter(item => /gaming|games?|sports|fitness|swimming|travel|food|music|interests|videoInterests|游戏|运动|健身|游泳|旅游|美食|音乐|兴趣/i.test(`${item.key} ${item.label}`) && ['OPEN', 'NORMAL'].includes(preferenceLevel(item, normalized))).flatMap(item => Array.isArray(item.value) ? item.value : [item.value])
  return { name: '', identity: '', interests: redactPrivateData([...new Set(values.map(String))].slice(0, 25).join('、'), normalized).slice(0, 500) }
}
function assertPrivateDisclosure(text, profile) {
  const output = String(text || '')
  if (containsPrivateData(output) || collectPrivateValues(profile).some(value => output.includes(value))) throw new Error('生成内容包含本人私密资料，已停止发送')
  return true
}
function assertApprovedSelfDisclosure(text, profile, approved = []) {
  const output = String(text || '')
  assertPrivateDisclosure(text, profile)
  const evidence = approved.map(item => Array.isArray(item.value) ? item.value.join(' ') : String(item.value)).join(' ')
  const concrete = output.match(/我(?:平时|通常|一般|现在|以前|去年|今年)?(?:每(?:周|天|月)[^，。！？!?]{0,12}|(?:跑过|参加过|完成过|去过|住过|读过|毕业于)[^，。！？!?]{1,18}|(?:的)?(?:10公里|十公里|半马|全马|马拉松|最好成绩|配速)[^，。！？!?]{0,18}|(?:是|在)[^，。！？!?]{0,18}(?:大学|学院|研[一二三四]|硕士|博士))/g) || []
  const normalized = value => String(value).replace(/[\s，。！？,.!?]/g, '')
  for (const claim of concrete) {
    const core = normalized(claim.replace(/^我(?:平时|通常|一般|现在|以前|去年|今年)?(?:的)?/, '').replace(/^(?:是|在|跑过|参加过|完成过|去过|住过|读过|毕业于)/, ''))
    const evidenceTokens = approved.flatMap(item => (Array.isArray(item.value) ? item.value : [item.value]).map(value => ({ key: item.key, label: item.label, value: String(value) })))
    const supportedPlace = /(?:去过|住过|读过|毕业于)/.test(claim) && evidenceTokens.some(item => /travel|education|school|旅游|学校|教育/i.test(`${item.key} ${item.label}`) && normalized(item.value).length >= 2 && core.includes(normalized(item.value)))
    const supportedSchool = /大学|学院/.test(claim) && evidenceTokens.some(item => /education|school|学校|教育/i.test(`${item.key} ${item.label}`) && (core.match(/[\u4e00-\u9fffA-Za-z]{2,}(?:大学|学院)/g) || []).some(place => normalized(item.value).includes(place)))
    const supportedRoutine = /每(?:周|天|月)/.test(claim) && evidenceTokens.some(item => /routine|日常|频率/i.test(`${item.key} ${item.label}`) && normalized(item.value).includes(core.replace(/游泳|健身|运动|跑步/g, '')) && (!/跑/.test(claim) || /跑/.test(`${item.label} ${item.value}`)))
    if (!core || (!normalized(evidence).includes(core) && !supportedPlace && !supportedSchool && !supportedRoutine)) throw new Error('生成内容包含未经批准的具体本人经历或身份，已停止发送')
  }
  if (/^(?:研[一二三四]|大[一二三四])(?:[，。\s]|$)|我(?:也|也是|现在|目前)?(?:是|读|在读)?(?:研[一二三四]|大[一二三四])/.test(output) && !evidenceTokensGrade(approved).some(value => output.includes(value))) throw new Error('生成内容包含未经批准的本人年级，已停止发送')
  if (/跑步(?:还)?在(?:慢慢)?练|(?:平时|最近|通常|一般)(?:我)?跑(?:得|步|着)|我(?:平时|最近|也)?(?:经常|每天|每周|一直|开始)(?:在)?跑步/.test(output) && !approved.some(item => /跑步|running/i.test(`${item.key} ${item.label} ${item.value}`))) throw new Error('生成内容包含未经批准的跑步习惯，已停止发送')
  if (/没(?:有)?跑过(?:半马|全马|马拉松)|(?:半马|全马|马拉松).{0,5}没跑过/.test(output) && !approved.some(item => /running|跑步|比赛|半马|全马/i.test(`${item.key} ${item.label} ${item.value}`))) throw new Error('本人比赛经历未知，不能把未知说成从未参加，已停止发送')
  if (/^(?:\d+公里|十公里|半马|全马|马拉松|最好成绩|配速).{0,18}(?:\d|[一二三四五六七八九十]).{0,5}(?:分钟|秒|小时|次|公里)/.test(output) && !approved.some(item => /running|跑步|成绩|配速/.test(`${item.key} ${item.label}`) && String(item.value).includes(output))) throw new Error('生成内容包含未经批准的具体跑步成绩，已停止发送')
  return true
}
function evidenceTokensGrade(approved) { return approved.flatMap(item => String(Array.isArray(item.value) ? item.value.join(' ') : item.value).match(/研[一二三四]|大[一二三四]/g) || []) }
module.exports = { isSelfProfileEnabled, contextText, getRelevantSelfProfile, approveSelfDisclosure, getPublicInterestPersona, redactPrivateData, collectPrivateValues, assertPrivateDisclosure, assertApprovedSelfDisclosure }
