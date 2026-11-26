// Contact-scoped promise extraction. A promise is only created from evidence the
// AI actually sent to this one contact (or a plan the contact raised and the AI
// never closed). Nothing is invented: the stored summary is the real message.
const { PROMISE_TYPES, normalizePromises, upsertPromise, promiseMessages, contactKey, hash, clock } = require('./promise.cjs')
const list = value => Array.isArray(value) ? value : []
const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
// Ordered matchers: the first hit decides both the stable key and the type, so
// "建个号过去" resolves to the account promise rather than a generic visit.
const PROMISE_ACTIONS = Object.freeze([
  { key: 'report', type: 'AI_FOLLOWUP', match: /(?:回头|晚点|等会|等会儿|待会|明天|下次|这两天|改天|之后).{0,8}(?:告诉|跟你说|说一声|回你|联系|答复|发你|更新|反馈)|我(?:会|要|再|回头)(?:告诉|说|回|联系|答复|发)你/, terms: ['回访', '告诉你'] },
  { key: 'account', type: 'HUMAN_ACTION', match: /建(?:个|一个)?号|建(?:个|一个)?小号|注册(?:个|一个)?(?:号|账号)|开(?:个|一个)?号|弄(?:个|一个)?(?:号|小号)|新号|小号|账号/, terms: ['建号', '账号', '小号'] },
  { key: 'ask', type: 'HUMAN_ACTION', match: /(?:帮你|替你|给你|我)(?:去)?问(?:问|一下|下)|打听(?:一下)?|了解(?:一下)?|(?:去)?查(?:一下)?/, terms: ['帮你问', '打听'] },
  { key: 'gift', type: 'HUMAN_ACTION', match: /给你(?:带|买|寄|送|拿)|帮你(?:买|带|拿|寄)|带(?:个|点|份|盒)/, terms: ['带东西', '买东西'] },
  { key: 'photo', type: 'AI_FOLLOWUP', match: /(?:发|拍|传)(?:给|张)?你|给你看|发张|发个图|发照片/, terms: ['发照片'] },
  { key: 'meal', type: 'REAL_WORLD_PLAN', match: /一起(?:吃|吃饭|喝|喝点|吃个饭)|请你(?:吃|喝)|约(?:饭|个饭)|聚餐/, terms: ['吃饭', '约饭'] },
  { key: 'play_together', type: 'REAL_WORLD_PLAN', match: /一起(?:玩|打|开黑|上分|排位|乱斗|看|去|游)|咱俩(?:玩|打|去)|我们(?:玩|打|去)/, terms: ['一起玩', '开黑'] },
  { key: 'visit', type: 'REAL_WORLD_PLAN', match: /(?:过去|过来|来找你|去找你|见个面|见一面|见面|线下|面基)/, terms: ['见面', '过去'] },
])
const substantive = text => !/^(?:哈哈+|嘿嘿+|嗯+|好的?|行|在干嘛|吃(?:饭|了)|你好|嗨|笑死|这个确实|我感觉还行|还行|可以|没事)[!！。~\s]*$/.test(text)
const question = text => /[?？]/.test(text) || /(?:吗|呢|嘛)[。！!~\s]*$/.test(text)
const future = text => /明天|后天|下次|改天|以后|待会|待会儿|一会|这两天|下周|周末|周[一二三四五六日天]|礼拜[一二三四五六日天]|马上|回头|等会|等会儿|晚点|之后|有空|什么时候|要不要|准备|打算|计划|想(?:要|去)/.test(text)
const commitment = text => /我(?:会|要|来|去|再|帮你|给你|带你|回头|晚点|这两天|明天|下次)|我来|交给我|包在我|说好|讲好|一言为定|答应/.test(text)
const actionVerb = text => /建|买|弄|做|问|找|查|订|约|安排|准备|发|告诉|说|回|联系|过去|过来|来|去|给|带|写|下载|注册|充|搞|整|打|玩|吃|喝|见|帮/.test(text)
const firstPerson = text => /我|咱/.test(text)
// A commitment only counts as a promise when it points at this contact or a
// shared plan; a private future plan ("我这两天去健身") is not owed to anyone.
const contactDirected = text => /你|咱俩|咱们|我们|一起|帮你|给你|带你/.test(text)
const thirdParty = text => /我(?:的)?(?:朋友|同学|同事|室友|家人|妈|爸|哥|姐|弟|妹|表|堂)|别人|他们说|他说|她说|有人/.test(text)
const dueHint = text => text.match(/明天|后天|下次|改天|以后|这两天|下周|周末|周[一二三四五六日天]|礼拜[一二三四五六日天]|晚上|中午|早上|上午|下午|待会|待会儿|一会|回头|晚点|有空/)?.[0] || null
function matchedAction(text) { return PROMISE_ACTIONS.find(item => item.match.test(text)) || null }
// The AI's own commitment gate lives in one place: an action keyword landing in
// the future, or a first-person promise this contact is the beneficiary of.
function aiCommitment(text) {
  const action = matchedAction(text)
  if (action) return future(text) || commitment(text)
  return firstPerson(text) && commitment(text) && actionVerb(text) && contactDirected(text) && future(text)
}
// Agreement path vocabulary: a plan the contact offers, and an AI reply that
// plainly accepts it. A hedge ("看情况") is never acceptance.
const PLAN_VERB = /一起|咱俩|咱们|我们|见面|见个面|见一面|碰面|集合|过去|过来|来找你|去找你|逛街|吃饭|约饭|聚餐|聚会|看电影|找你/
const PLAN_ANCHOR = /今天|明天|后天|大后天|这周|本周|下周|周末|周[一二三四五六日天]|礼拜[一二三四五六日天]|早上|上午|中午|下午|晚上|今晚|\d{1,2}\s*点|\d{1,2}\s*[:：]\s*\d{2}|什么时候|地铁口|地铁站|门口|大门口|哪里|哪儿|地方|那边|这边|附近|广场|公园|学校|大学|公司|楼下|咖啡|奶茶|餐厅|饭店|店里|宿舍|图书馆/
const ACCEPT = /^(?:好呀|好啊|好的?|可以(?:啊|呀|的)?|行(?:啊|呀|吧)?|没问题|没得问题|中|成交|收到|ok|okay|嗯+|一言为定|说好了?|讲好了?|放心|说到做到|我(?:肯定|一定|准时|必须)|肯定(?:到|来|去)|一定(?:到|来|去)|必须到)/i
const HEDGE = /看情况|再说吧|看时间|到时候再看|不一定|可能|应该|如果|要是|尽量|看吧|看下/
function promiseKey(text, action) {
  if (action) return action.key
  return `misc_${hash(clean(text, 200).replace(/\s+/g, '').toLowerCase())}`
}
function promiseType(text, action) {
  if (action) return action.type
  if (/一起|咱俩|咱们|我们|见面|过去|过来|来找你/.test(text)) return 'REAL_WORLD_PLAN'
  return 'HUMAN_ACTION'
}
function buildPromiseCandidates({ contact = {}, messages = contact.sharedMemoryLedger || [], now = Date.now(), selfProfile } = {}) {
  const key = contactKey(contact), store = normalizePromises(contact, { now, selfProfile })
  const rows = promiseMessages(messages, contact, { now, selfProfile })
  const candidates = [], seen = new Set()
  const add = (type, groupKey, summary, supporting, topics) => {
    if (!PROMISE_TYPES.includes(type) || !summary || seen.has(groupKey)) return
    const sources = [...new Map(supporting.map(row => [row.id, row])).values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-24)
    if (!sources.length) return
    const existing = store.items.find(item => item.key === groupKey)
    const unchanged = existing && existing.type === type && existing.summary === summary
      && JSON.stringify(existing.sourceMessageIds) === JSON.stringify(sources.map(row => row.id))
    if (unchanged) return
    const id = `pmc_${hash([key, groupKey, type, summary, sources.map(row => row.id)])}`
    if (store.processedCandidateIds.includes(id)) return
    seen.add(groupKey)
    candidates.push({ id, contactId: key, key: groupKey, type, summary, topics: [...new Set(topics)].slice(0, 6),
      dueHint: dueHint(summary), existingPromiseId: existing?.id || null, previousSummary: existing?.summary || null,
      keepResolution: Boolean(existing),
      sourceMessages: sources.map(row => ({ id: row.id, contactId: key, role: row.role, text: row.text, at: row.at, source: row.source,
        ...(row.role === 'me' ? { status: 'sent', confirmedSent: true } : {}), provenance: 'promise_evidence' })),
      sourceMessageIds: sources.map(row => row.id) })
  }
  // AI commitments: a confirmed send that names a future action the AI owes this
  // contact. Filler, questions and past statements never qualify. Statements that
  // share a key collapse, keeping the newest wording.
  const groups = new Map()
  for (const row of rows) {
    if (row.role !== 'me') continue
    const text = clean(row.text, 300)
    if (question(text) || thirdParty(text) || !substantive(text) || !aiCommitment(text)) continue
    const action = matchedAction(text)
    const groupKey = promiseKey(text, action)
    const group = groups.get(groupKey) || { key: groupKey, type: promiseType(text, action), terms: [], rows: [] }
    group.type = promiseType(text, action)
    group.terms = [...new Set([...group.terms, ...(action?.terms || [])])]
    group.rows.push({ row, text })
    groups.set(groupKey, group)
  }
  for (const group of groups.values()) {
    const ordered = group.rows.sort((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at))
    add(group.type, group.key, ordered.at(-1).text, ordered.map(item => item.row), group.terms)
  }
  // Contact-raised plans the AI never closed become open loops awaiting follow-up.
  const hasReplyAfter = row => rows.some(other => other.role === 'me' && Date.parse(other.at) > Date.parse(row.at))
  for (const row of rows) {
    if (row.role !== 'contact') continue
    const text = clean(row.text, 300)
    if (!substantive(text) || !future(text) || hasReplyAfter(row)) continue
    if (!/一起|咱俩|咱们|我们|请你|找你|见|约|吃|玩|去/.test(text)) continue
    add('OPEN_LOOP', `open_loop_${hash(clean(text, 200).replace(/\s+/g, '').toLowerCase())}`, text, [row], [])
  }
  // Agreement path: the contact offers a concrete plan and the AI accepts it in
  // the very next breath. Neither half is a promise on its own — the accepted
  // plan is. Consecutive contact bubbles collapse into one offer so a plan split
  // across messages ("那要不这周六" / "见一面") still reads as a single proposal.
  const agreements = new Map()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.role !== 'me') continue
    const text = clean(row.text, 300)
    if (aiCommitment(text) || question(text) || thirdParty(text)) continue
    if (text.length > 24 || HEDGE.test(text) || !ACCEPT.test(text)) continue
    const proposal = []
    for (let j = i - 1; j >= 0 && rows[j].role === 'contact'; j--) proposal.unshift(rows[j])
    const plan = clean(proposal.map(item => clean(item.text, 300)).join('，'), 300)
    if (plan.length < 4 || !PLAN_VERB.test(plan) || !PLAN_ANCHOR.test(plan)) continue
    const groupKey = `plan_${hash(clean(plan, 200).replace(/\s+/g, '').toLowerCase())}`
    const group = agreements.get(groupKey) || { key: groupKey, plan, rows: [] }
    group.plan = plan
    group.rows.push(...proposal, row)
    agreements.set(groupKey, group)
  }
  for (const group of agreements.values()) add('REAL_WORLD_PLAN', group.key, group.plan, group.rows, ['见面', '约定'])
  return candidates.slice(-8)
}
function extractPromises({ contact = {}, messages = contact.sharedMemoryLedger || [], now = Date.now(), selfProfile } = {}) {
  const store = normalizePromises(contact, { now, selfProfile })
  const candidates = buildPromiseCandidates({ contact: { ...contact, promises: store }, messages, now, selfProfile })
  if (!candidates.length) return { promises: store, candidates: [], changed: false, added: 0, updated: 0 }
  let added = 0, updated = 0
  for (const candidate of candidates) {
    const existed = Boolean(candidate.existingPromiseId)
    upsertPromise(store, candidate, { now })
    store.processedCandidateIds.push(candidate.id)
    if (existed) updated += 1; else added += 1
  }
  store.revision += 1
  store.updatedAt = new Date(clock(now)).toISOString()
  store.items = store.items.slice(-80)
  store.processedCandidateIds = [...new Set(store.processedCandidateIds)].slice(-256)
  return { promises: store, candidates, changed: true, added, updated }
}
module.exports = { PROMISE_ACTIONS, buildPromiseCandidates, extractPromises }
