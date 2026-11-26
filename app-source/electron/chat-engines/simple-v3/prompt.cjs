// SIMPLE_V3_CHAT: pure Context -> prompt text. No side effects.
// Reads only the public ChatContext fields; never Storage, Memory or Relationship.
const { DEFAULT_SIMPLE_V3_CONFIG, describeStage } = require('./config.cjs')

const SYSTEM_PROMPT = `你不是客服，也不是问答助手。
你正在代表本人（一个真实的人）用抖音私信和对方（另一个真实的人）聊天，希望双方自然地逐渐熟悉。

聊天原则：
- 不要只回答问题。自然的话，可以分享一点自己、顺着当前话题问一句、展开对方刚说的细节、轻微调侃、自然换到相关话题、回调以前聊过的事。
- 不要求每轮都提问，不要求每轮都分享，不要求每轮都推进关系。
- 像真人打字：短句、口语、可以有一点语气词，但别堆。
- 一次可以发1到3条短消息，像真人连发；由你判断发几条，不要为了凑数而拆句。
- 如果此刻确实没什么可说、说了反而尴尬，就选择 NO_REPLY。

关于话题进展（重要）：
- 聊天要有进展。已经讲清楚的经历、观点、信息，不要为了维持对话而换一种说法反复讲。
- 想继续同一个话题，要有新的内容：新的信息、新的看法，或者对方明确追问。
- 对方只给很短的一个回应时，不必硬把刚才那件事再展开一遍。
- 一个话题聊完了，可以自然收住，也可以自然地接着聊别的；但不要生硬地跳开。
- 对方追问细节、要求澄清或让你再说一遍时，就正常重复或展开，不用刻意回避。

必须避免（这些是客服味和机械感的主要来源）：
- 客服式道歉、正式解释、过度共情、过度礼貌。
- 连续采访式提问、长篇说教、每句都解释自己。
- 反复说“慢慢熟悉”“不方便透露”“希望你不要介意”。
- 大量“呀、啦、~”。
- 把聊天写成总结报告。

关于本人信息（重要）：
- 可以使用少量低风险的第一人称日常：生活习惯、日常偏好、运动、旅游、爱好、小经历、日常态度。
- 但不能和已知事实冲突；一轮不要新增很多个人经历；不要无必要地给出精确日期、金额、地点、人物。
- 以下内容严禁编造：核心学历/学校等身份绑定信息、家庭成员结构、出生信息、联系方式、重大现实工作经历、疾病、金钱资产、违法事项、重大感情经历、线下真实约定、重大现实承诺。
- 资料里没有的，不要硬编，也不要因此拒答；可以自然聊低风险内容。

当对方索要照片、联系方式、线下见面等敏感请求，或你判断需要真人接管时，用 HANDOFF。

只输出一个 JSON 对象，不要输出任何其它文字、解释或 Markdown：
{"action":"REPLY","messages":["第一条","第二条"],"handoff":false,"reason":null}
- action 只能是 REPLY / NO_REPLY / HANDOFF。
- action=REPLY 时 messages 为1到3条短消息，每条都是要直接发出去的原文。
- action=NO_REPLY 时 messages 必须为空数组。
- action=HANDOFF 时 messages 必须为空数组、handoff 为 true，reason 用简短英文大写标记（如 PHOTO_REQUEST）。`

function asText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('、')
  return asText(value.text ?? value.summary ?? value.value ?? value.topic ?? value.label ?? value.content)
}

function factLine(item) {
  if (item === null || item === undefined) return ''
  if (typeof item === 'string') return item.trim()
  const label = asText(item.label || item.key)
  const value = asText(item.value ?? item.text ?? item.summary ?? item.topic ?? item.content)
  if (label && value) return `${label}：${value}`
  return value || label
}

function promiseLine(item) {
  if (item === null || item === undefined) return ''
  if (typeof item === 'string') return item.trim()
  const summary = asText(item.summary)
  if (!summary) return ''
  if (item.status === 'done' && item.resolution) {
    const fields = (Array.isArray(item.resolution.fields) ? item.resolution.fields : [])
      .map(field => `${asText(field.label)}=${asText(field.value)}`).filter(Boolean).join('、')
    const result = asText(item.resolution.text)
    return `[已完成] 我答应过：${summary}｜实际结果：${result}${fields ? `（${fields}）` : ''}`
  }
  return `[未完成] 我答应过：${summary}${item.dueHint ? `（${asText(item.dueHint)}）` : ''}`
}

function section(title, lines) {
  const body = lines.filter(Boolean)
  return body.length ? `【${title}】\n${body.join('\n')}` : ''
}

function buildContextBlock(context, settings) {
  const blocks = []
  blocks.push(`【关系阶段】${describeStage(context?.relationship?.stage)}`)

  const incoming = (Array.isArray(context?.incomingMessages) ? context.incomingMessages : [])
    .filter(row => row && (row.role === undefined || row.role === 'contact'))
    .slice(-settings.maxIncoming)
    .map(row => `对方：${asText(row.text)}`)
  blocks.push(incoming.length ? section('对方刚刚发来的消息', incoming) : '【对方刚刚发来的消息】\n（本轮没有新的对方消息）')

  const recent = (Array.isArray(context?.recentMessages) ? context.recentMessages : [])
    .filter(row => row && asText(row.text))
    .slice(-settings.recentMessages)
    .map(row => `${row.role === 'me' ? '我' : '对方'}：${asText(row.text)}`)
  blocks.push(section('最近的聊天（旧→新）', recent))

  const selfFacts = (Array.isArray(context?.selfFacts) ? context.selfFacts : [])
    .slice(0, settings.maxSelfFacts).map(factLine)
  blocks.push(section('关于本人（可用，不能与已知事实冲突）', selfFacts))

  const contactFacts = (Array.isArray(context?.contactFacts) ? context.contactFacts : [])
    .slice(0, settings.maxContactFacts).map(factLine)
  blocks.push(section('关于对方（已知事实）', contactFacts))

  const shared = (Array.isArray(context?.sharedMemories) ? context.sharedMemories : [])
    .slice(0, settings.maxSharedMemories).map(item => asText(item.summary ?? item))
  blocks.push(section('共同经历（可选回访，不用也行）', shared))

  const narratives = (Array.isArray(context?.selfNarratives) ? context.selfNarratives : [])
    .slice(0, settings.maxSelfNarratives).map(item => asText(item.statement ?? item.summary ?? item))
  blocks.push(section('你之前在这个人面前说过的关于自己的话（保持一致，不要自相矛盾）', narratives))

  const promises = (Array.isArray(context?.promises) ? context.promises : [])
    .slice(0, settings.maxPromises).map(promiseLine)
  blocks.push(section('你在这个人面前答应过的事（已完成就按真实结果回答，没做完的别谎称做完，也不要主动催）', promises))

  const privacy = Array.isArray(context?.constraints?.privacy) ? context.constraints.privacy : []
  blocks.push(`【约束】不得披露本人私密或未经允许的个人敏感信息${privacy.length ? `（${privacy.join('、')}）` : ''}。`)

  return blocks.filter(Boolean).join('\n\n')
}

function buildSimpleV3Messages(context, config = {}) {
  const settings = { ...DEFAULT_SIMPLE_V3_CONFIG, ...config }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildContextBlock(context, settings) },
  ]
}

module.exports = { SYSTEM_PROMPT, buildSimpleV3Messages, buildContextBlock }
