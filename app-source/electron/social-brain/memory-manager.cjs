const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const IDENTITY_FIELDS = ['province', 'city', 'occupation', 'school', 'major', 'grade']
const clean = (value, limit = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
const list = value => Array.isArray(value) ? value : []
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24)
function localDay(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
function shiftDay(day, days) { return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10) }
function messageQuote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return { messageId: clean(value.messageId || value.id || value.sourceMessageId, 100), sourceMessageId: clean(value.sourceMessageId || value.messageId || value.id, 100), text: clean(value.text || value.content, 280), role: ['me', 'contact'].includes(value.role) ? value.role : 'unknown', ownership: 'unknown', author: clean(value.author || value.name, 60), type: clean(value.type, 30) }
}
function messageMetadata(message) {
  const quote = messageQuote(message.quote)
  return { ...(clean(message.messageId, 100) ? { messageId: clean(message.messageId, 100) } : {}), ...(clean(message.type, 30) ? { type: clean(message.type, 30) } : {}), ...(clean(message.mediaKind, 30) ? { mediaKind: clean(message.mediaKind, 30) } : {}), ...(clean(message.textSource, 30) ? { textSource: clean(message.textSource, 30) } : {}), ...(quote ? { quote } : {}) }
}
function messageList(contact, incoming = '', now = new Date(), incomingMeta = {}) {
  const isMediaRow = m => Boolean(m && (/^(?:image|sticker|gif|video|album|media)$/i.test(m.type || m.mediaKind || '') || m.quote))
  const messages = list(contact?.learning?.messages).filter(m => m && ['me', 'contact'].includes(m.role) && (clean(m.text) || isMediaRow(m))).slice(-80).map(m => ({
    id: clean(m.id || m.messageId, 100) || `m_${hash(`${contact?.id || contact?.name}\n${m.role}\n${clean(m.text)}\n${m.at || m.sentAt || ''}`)}`,
    role: m.role, text: clean(m.text), at: Number.isFinite(Date.parse(m.at || m.sentAt)) ? new Date(m.at || m.sentAt).toISOString() : '',
    ...messageMetadata(m),
  }))
  const value = clean(incoming)
  if (value) {
    const last = messages.at(-1)
    // Reusing a historical message must not invent its original date.
    const explicitId = clean(incomingMeta.messageId || incomingMeta.id, 100)
    if (last?.role === 'contact' && explicitId && [last.id, last.messageId].includes(explicitId) && !last.text && isMediaRow(last)) {
      last.text = value
      Object.assign(last, messageMetadata(incomingMeta))
      return messages.slice(-80)
    }
    if (!(last?.role === 'contact' && last.text === value && (!explicitId || [last.id, last.messageId].includes(explicitId)))) messages.push({ id: explicitId || `m_${hash(`${contact?.id || contact?.name}\ncontact\n${value}`)}`, role: 'contact', text: value, at: new Date(now).toISOString(), ...messageMetadata(incomingMeta) })
    else if (explicitId) Object.assign(last, messageMetadata(incomingMeta))
  }
  return messages.slice(-80)
}
function emptyMemory() {
  return { version: 1, profile: { identity: Object.fromEntries(IDENTITY_FIELDS.map(key => [key, { value: null, status: 'unknown' }])), interests: [], currentLife: [] }, facts: [], inferences: [], unknowns: [...IDENTITY_FIELDS], legacyMemories: [], events: [], learningHistory: [], planHistory: [], processedMessageIds: [], relationshipMetrics: {}, summary: '' }
}
function normalizeMemory(saved) {
  const base = emptyMemory()
  if (!saved || typeof saved !== 'object') return base
  const identity = Object.fromEntries(IDENTITY_FIELDS.map(key => {
    const item = saved.profile?.identity?.[key]
    return [key, item?.status === 'fact' && clean(item.value) && list(item.sourceMessageIds).length ? { ...item } : { value: null, status: 'unknown' }]
  }))
  return { ...base, ...saved, version: 1, profile: { identity, interests: list(saved.profile?.interests).filter(Boolean).slice(-30), currentLife: list(saved.profile?.currentLife).filter(Boolean).slice(-30) }, facts: list(saved.facts).filter(f => f && f.status === 'fact' && f.evidence && list(f.sourceMessageIds).length).slice(-80), inferences: list(saved.inferences).filter(Boolean).map(i => ({ ...i, status: 'inference', confidence: Math.min(0.8, Math.max(0, Number(i.confidence) || 0)) })).slice(-20), legacyMemories: list(saved.legacyMemories).filter(Boolean).slice(-30), events: list(saved.events).filter(Boolean).map(normalizeEvent).slice(-40), learningHistory: list(saved.learningHistory).filter(Boolean).slice(-40), planHistory: list(saved.planHistory).filter(Boolean).slice(-20), processedMessageIds: list(saved.processedMessageIds).slice(-240), relationshipMetrics: saved.relationshipMetrics || {} }
}
function questionTopic(text) {
  if (!isQuestion(text)) return ''
  if (/研几|大几|几年级|什么年级|哪个年级|年级(?:是)?几/.test(text)) return 'grade'
  if (/专业|学啥|学什么/.test(text)) return 'major'
  if (/学校|哪个大学|哪所大学/.test(text)) return 'school'
  if (/职业|做啥|做什么|干啥工作|什么工作|什么行业/.test(text)) return 'occupation'
  if (/哪.*人|老家|哪里人/.test(text)) return 'province'
  if (/城市|住哪|在哪.*(?:工作|生活|上班)|哪个市/.test(text)) return 'city'
  return ''
}
function isQuestion(text) { return /[?？]|(?:你.*(?:啥|什么|哪|怎么|有没有|是不是)|你呢|(?:研几|大几|几年级|什么年级|哪个年级)(?:[，。！! ]|$)|年级(?:是)?几|吗(?:[，。！! ]|$)|(?:说说|讲讲|告诉我|介绍一下|方便.*说))/.test(clean(text)) }
function ownAssertion(text) { return !/[?？]|(?:如果|假如|比如|可能|听说|他说|她说|朋友说|我朋友|我同事|引用|转发|开玩笑|假装|我是说|不是|不在)/.test(text) }
function memoryEvidenceAllowed(message) {
  if (!message || message.role !== 'contact' || !clean(message.text)) return false
  // OCR and visual interpretations are observations about a media item, not
  // statements made by its sender. A quoted statement belongs to its author.
  if (/^(?:ocr|visual|media|interpretation)$/i.test(message.textSource || '')) return false
  if (message.quote?.text && clean(message.text).includes(clean(message.quote.text))) return false
  return !/^(?:\[|【)?(?:图片|照片|表情|表情包|动画表情|动图|GIF|视频|引用消息)(?:\]|】)?$/i.test(clean(message.text))
}
function observedFacts(message, previousQuestion = '') {
  const text = message.text
  if (!memoryEvidenceAllowed(message) || !ownAssertion(text)) return []
  const facts = []
  const add = (field, value, evidence = text) => { if (clean(value)) facts.push({ field, value: clean(value, 60), evidence, sourceMessageIds: [message.id], status: 'fact', confidence: 0.98, updatedAt: message.at || '' }) }
  const province = text.match(/我(?:是|来自|老家(?:在|是))\s*(湖南|湖北|广东|广西|河南|河北|山东|山西|四川|贵州|云南|陕西|甘肃|青海|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|海南|台湾|内蒙古|新疆|西藏|宁夏)(?:省|自治区)?(?:人|的|[，。！! ]|$)/)
  if (province) add('province', province[1])
  const city = text.match(/我(?:现在|目前)?(?:住在|住|在|定居在|搬到|搬去)\s*([\u4e00-\u9fff]{2,8}?)(?:市)?(?:上班|工作|生活|读书|念书|居住|[，。！! ]|$)/)
  if (city && !/学校|大学|学院|中学|公司|家里|实验室|医院|宿舍|^(湖南|湖北|广东|广西|河南|河北|山东|山西|四川|贵州|云南|陕西|甘肃|青海|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|海南|台湾|内蒙古|新疆|西藏|宁夏)$/.test(city[1])) add('city', city[1])
  const occupation = text.match(/我(?:现在|目前)?(?:的职业是|是(?:一名|一个)?|做的是)\s*(程序员|软件工程师|产品经理|设计师|老师|教师|医生|护士|会计|律师|销售|摄影师|学生)(?:[，。！! ]|$|啊|呀|呢)/)
  if (occupation) add('occupation', occupation[1])
  const major = text.match(/我(?:的)?专业(?:是)?\s*([\u4e00-\u9fffA-Za-z]{2,18}?)(?:[，。！! ]|$|啊|呀|呢)/) || text.match(/我(?:学的是|读的是)\s*([\u4e00-\u9fffA-Za-z]{2,18}?)(?:专业|[，。！! ]|$|啊|呀|呢)/)
  if (major && !/^(校|生|校里|什么|啥|不知道|还没确定)$/.test(major[1])) add('major', major[1])
  else if (previousQuestion === 'major' && /^(?:机械(?:工程)?|计算机(?:科学与技术)?|软件工程|电子信息|自动化|机器人(?:工程)?|土木(?:工程)?|建筑(?:学)?|法学|医学|护理(?:学)?|经济(?:学)?|金融(?:学)?|会计(?:学)?|英语|中文|设计)(?:啊|呀|呢|的|专业|[。！! ])*$/.test(text)) add('major', text.replace(/(?:啊|呀|呢|的|专业|[。！! ])+$/g, ''))
  const school = text.match(/我(?:在|就读于|学校是)\s*([\u4e00-\u9fffA-Za-z]{2,20}?(?:大学|学院|中学))(?:[，。！! ]|$|读|上学)/)
  if (school) add('school', school[1])
  // Grade is a present contact self-statement, never derived from age or
  // school. Quotations, hypotheticals and third-party speech supply no grade.
  const gradeEligible = !/[“”「」『』"']|(?:明年|去年|以前|曾经|将来|以后|到时候|如果|假如|假设|要是|假使|可能|也许|大概|假装|同学|同事|室友|朋友|他说|她说|别人说)/.test(text)
  const grade = gradeEligible && text.match(/(?:^|[，。！？!?；; ])我(?:现在|目前)?(?:是|读|在读)?\s*(研[一二三四]|大[一二三四])(?=[，。！？!?；; ]|$|(?:啊|呀|呢|了|在读)(?:[，。！？!?；; ]|$))/)
  if (grade) add('grade', grade[1])
  else if (gradeEligible && previousQuestion === 'grade' && /^(?:研[一二三四]|大[一二三四])(?:啊|呀|呢|了|在读|[。！! ])*$/.test(text)) add('grade', text.match(/研[一二三四]|大[一二三四]/)[0])
  const interest = text.match(/我(?:比较|很|特别|平时)?(?:喜欢|爱好是|爱好)\s*([^，。！？!?；;]{1,20})/)
  if (interest) add('interest', interest[1].replace(/(?:来着|啊|呀|呢)$/g, ''))
  if (/老板.*(?:让我|要求我).*加班|我.*(?:加班|开会|上课|准备.*面试|养了.*(?:猫|狗))/.test(text)) add('current_life', text.slice(0, 60))
  return facts
}
const FOLLOWUP_RULES = {
  interview: { delayHours: 4, validHours: 30 }, exam: { delayHours: 3, validHours: 30 },
  trip: { delayHours: 8, validHours: 48 }, defense: { delayHours: 3, validHours: 30 },
  presentation: { delayHours: 3, validHours: 30 }, generic: { delayHours: 6, validHours: 36 },
}
const TERMINAL_EVENT_STATUSES = ['followed_up', 'resolved', 'cancelled', 'stale']
const isoTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const shanghaiTime = (day, hour, minute = 0) => isoTime(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
function validDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && isoTime(value)?.startsWith(value) }
function followupWindow(type, day, endDay = day, period = '', exactHour = null, exactMinute = 0) {
  if (!validDay(day) || !validDay(endDay)) return null
  const rule = FOLLOWUP_RULES[type] || FOLLOWUP_RULES.generic
  let start
  if (endDay !== day || (!period && exactHour === null)) start = shanghaiTime(shiftDay(endDay, 1), 10)
  else {
    // A period describes an interval, not its starting instant. Never ask for
    // an afternoon result in the morning or at the beginning of the event.
    const upperHour = exactHour ?? ({ 凌晨: 6, 早上: 12, 上午: 12, 中午: 14, 下午: 18, 傍晚: 20, 晚上: 23 }[period] || 23)
    start = new Date(Date.parse(shanghaiTime(day, upperHour, exactHour === null ? 0 : exactMinute)) + rule.delayHours * 3600000).toISOString()
  }
  return { startAt: start, endAt: new Date(Date.parse(start) + rule.validHours * 3600000).toISOString() }
}
function normalizeEvent(saved = {}) {
  const dueDate = validDay(saved.dueDate) ? saved.dueDate : validDay(saved.eventAt) ? saved.eventAt : saved.eventAt && isoTime(saved.eventAt) ? localDay(saved.eventAt) : null
  const dueEnd = validDay(saved.dueEnd) ? saved.dueEnd : dueDate
  const terminal = TERMINAL_EVENT_STATUSES.includes(saved.status)
  let window = saved.followUpWindow && isoTime(saved.followUpWindow.startAt) && isoTime(saved.followUpWindow.endAt)
    && Date.parse(saved.followUpWindow.endAt) > Date.parse(saved.followUpWindow.startAt)
    ? { startAt: isoTime(saved.followUpWindow.startAt), endAt: isoTime(saved.followUpWindow.endAt) } : null
  if (!window && dueDate && !terminal) {
    window = followupWindow(saved.type, dueDate, dueEnd)
    const priorStart = isoTime(saved.followUpAt) || (validDay(saved.followUp?.notBefore) ? shanghaiTime(saved.followUp.notBefore, 10) : null)
    if (priorStart) { const rule = FOLLOWUP_RULES[saved.type] || FOLLOWUP_RULES.generic; window = { startAt: priorStart, endAt: new Date(Date.parse(priorStart) + rule.validHours * 3600000).toISOString() } }
  }
  const followUp = saved.followUp || {}
  const status = terminal ? saved.status : dueDate ? (saved.status === 'due' ? 'due' : 'upcoming') : 'undated'
  return { ...saved, id: clean(saved.id, 100), type: saved.type || 'generic', description: clean(saved.description, 120),
    status, dueDate, dueEnd, eventAt: saved.eventAt || dueDate, datePrecision: saved.datePrecision || (dueDate ? 'day' : 'unknown'),
    confidence: Math.max(0, Math.min(1, Number(saved.confidence) || (list(saved.sourceMessageIds).length ? 0.96 : 0))),
    sourceMessageIds: list(saved.sourceMessageIds).filter(Boolean), createdAt: saved.createdAt || saved.updatedAt || null,
    updatedAt: saved.updatedAt || saved.createdAt || null, followUpAt: terminal ? null : window?.startAt || null,
    followUpWindow: terminal ? null : window,
    followUp: { ...followUp, enabled: !terminal && Boolean(window) && followUp.enabled !== false,
      status: terminal ? followUp.status || status : window ? followUp.status || 'pending' : 'needs_date',
      attempts: Math.max(0, Math.floor(Number(followUp.attempts) || 0)), lastAttemptAt: isoTime(followUp.lastAttemptAt),
      notBefore: terminal ? null : followUp.notBefore || (window ? localDay(window.startAt) : null) } }
}
function eventType(text) {
  return /面试|面完/.test(text) ? 'interview' : /答辩/.test(text) ? 'defense' : /考试|考完/.test(text) ? 'exam'
    : /出差|旅行|旅游|出发/.test(text) ? 'trip' : /汇报|演讲|展示/.test(text) ? 'presentation' : ''
}
function eventOwnStatement(message) {
  return memoryEvidenceAllowed(message) && !/[?？]|如果|假如|比如|听说|他说|她说|朋友说|我朋友|我同事|我室友|引用|转发|假装/.test(message.text)
    && !/(?:他|她|朋友|同事|室友|同学).{0,12}(?:面试|面完|考试|考完|答辩|旅游|出差|旅行|推迟|取消)/.test(message.text)
}
function eventDate(text, at) {
  const time = text.match(/(?:下周|这周|本周|周|星期)[一二三四五六日天]?|明天|后天|今天|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}[日号]/)?.[0] || ''
  let dueDate = null, dueEnd = null, precision = 'unknown'
  if (/^\d{4}-/.test(time) && validDay(time)) { dueDate = time; precision = 'day' }
  else if (isoTime(at)) {
    const today = localDay(at)
    if (/^(今天|明天|后天)$/.test(time)) { dueDate = shiftDay(today, { 今天: 0, 明天: 1, 后天: 2 }[time]); precision = 'day' }
    else if (/周|星期/.test(time)) {
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() || 7
      const monday = shiftDay(today, 1 - weekday + (time.startsWith('下') ? 7 : 0))
      const day = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }[time.slice(-1)]
      dueDate = shiftDay(monday, day ?? 0)
      if (/^(周|星期)/.test(time) && day !== undefined && dueDate < today) dueDate = shiftDay(dueDate, 7)
      dueEnd = day === undefined ? shiftDay(monday, 6) : dueDate; precision = day === undefined ? 'week' : 'day'
    } else if (/月/.test(time)) {
      const [month, day] = time.match(/\d+/g).map(Number)
      const date = `${today.slice(0, 4)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (validDay(date)) { dueDate = date < today ? `${Number(today.slice(0, 4)) + 1}${date.slice(4)}` : date; precision = 'day' }
    }
  }
  // Uncertainty does not become a calendar commitment, even if a date appears.
  if (/可能|也许|说不定|不一定|还没定|不确定/.test(text)) { dueDate = null; dueEnd = null; precision = 'unknown' }
  const period = text.match(/凌晨|早上|上午|中午|下午|傍晚|晚上/)?.[0] || ''
  const clock = text.match(/(\d{1,2})(?:[:：](\d{2})|点)/)
  let hour = clock ? Number(clock[1]) : null
  if (hour !== null && hour < 12 && /下午|晚上|傍晚/.test(period)) hour += 12
  if (hour !== null && (hour > 23 || Number(clock?.[2] || 0) > 59)) hour = null
  return { timeText: time || clean(text.match(/最近|近期|过几天/)?.[0]), dueDate, dueEnd: dueEnd || dueDate, datePrecision: precision, period, exactHour: hour, exactMinute: hour === null ? 0 : Number(clock?.[2] || 0) }
}
function eventFromMessage(message) {
  if (!eventOwnStatement(message) || !/我|^(?:下周|这周|本周|周|星期|明天|后天|今天|最近|近期|\d)/.test(message.text)) return null
  const type = eventType(message.text)
  if (!type || /取消|推迟|改期|延后|不去|不面试|不考试|不用考|不答辩|不出差|不旅游|刚面完|面试完|面试结束|考完|答辩完/.test(message.text)) return null
  const date = eventDate(message.text, message.at)
  if (!date.timeText && !/准备|打算|要|将|安排/.test(message.text)) return null
  const window = followupWindow(type, date.dueDate, date.dueEnd, date.period, date.exactHour, date.exactMinute)
  return normalizeEvent({ id: `e_${hash(`${message.id}|${type}|${date.timeText}`)}`, type, description: clean(message.text, 120),
    ...date, eventAt: date.dueDate && date.exactHour !== null ? shanghaiTime(date.dueDate, date.exactHour, date.exactMinute) : date.dueDate,
    status: date.dueDate ? 'upcoming' : 'undated', confidence: date.dueDate ? 0.96 : 0.7,
    evidence: message.text, sourceMessageIds: [message.id], createdAt: message.at || null, updatedAt: message.at || null,
    followUpAt: window?.startAt || null, followUpWindow: window,
    followUp: { enabled: Boolean(window), status: window ? 'pending' : 'needs_date', attempts: 0, lastAttemptAt: null, notBefore: window ? localDay(window.startAt) : null } })
}
function updateEventsFromMessage(memory, message) {
  if (!eventOwnStatement(message)) return ''
  const text = message.text, type = eventType(text)
  const active = memory.events.filter(e => !['resolved', 'cancelled', 'stale'].includes(e.status))
  const matching = type ? active.filter(e => e.type === type) : active
  const target = matching.length === 1 ? matching[0] : null
  // A model observation can replay the same evidence after syncMemory. It must
  // not reopen a resolved event or count the operation twice.
  if (memory.events.some(e => list(e.sourceMessageIds).includes(message.id))) return ''
  const cancelled = /取消|不去了|不面试了|不考试了|不用考了|不答辩了|不出差了|不旅游了/.test(text)
  const resolved = /刚面完|面试(?:完了|(?:已经)?结束)|已经面完|刚考完|考完了|考试(?:已经)?结束|答辩(?:完了|(?:已经)?结束)|刚答辩完|刚回来|到(?:酒店|目的地)了|汇报完|演讲完/.test(text)
    || Boolean(target && /感觉(?:凉了|过了)|面(?:得)?(?:很|不|挺)|考(?:得)?(?:很|不|挺)/.test(text))
  const rescheduled = /推迟|改期|延后|延期|改到|改成/.test(text)
  if (target && (cancelled || resolved || rescheduled)) {
    const updated = { ...target, sourceMessageIds: [...new Set([...list(target.sourceMessageIds), message.id])],
      evidence: text, updatedAt: message.at || target.updatedAt, description: clean(`${target.description}；${text}`, 120) }
    if (cancelled || resolved) {
      updated.status = cancelled ? 'cancelled' : 'resolved'; updated.followUpAt = null; updated.followUpWindow = null
      updated.followUp = { ...target.followUp, enabled: false, status: cancelled ? 'cancelled' : 'resolved_in_chat', notBefore: null }
    } else {
      const date = eventDate(text, message.at), window = followupWindow(target.type, date.dueDate, date.dueEnd, date.period, date.exactHour, date.exactMinute)
      Object.assign(updated, date, { eventAt: date.dueDate && date.exactHour !== null ? shanghaiTime(date.dueDate, date.exactHour, date.exactMinute) : date.dueDate,
        status: date.dueDate ? 'upcoming' : 'undated', followUpAt: window?.startAt || null, followUpWindow: window,
        followUp: { enabled: Boolean(window), status: window ? 'pending' : 'needs_date', attempts: 0, lastAttemptAt: null, notBefore: window ? localDay(window.startAt) : null } })
    }
    memory.events = memory.events.map(e => e.id === target.id ? normalizeEvent(updated) : e)
    return cancelled ? 'CANCEL' : resolved ? 'RESOLVE' : 'RESCHEDULE'
  }
  const created = eventFromMessage(message)
  if (!created) return ''
  if (target?.dueDate && target.dueDate === created.dueDate && target.dueEnd === created.dueEnd) {
    // Repeating an already known appointment is additional evidence, not a
    // second appointment. A sent follow-up must never be reopened by repetition.
    const precise = created.exactHour !== null || Boolean(created.period)
    const timed = precise && !TERMINAL_EVENT_STATUSES.includes(target.status) ? created : target
    memory.events = memory.events.map(e => e.id === target.id ? normalizeEvent({ ...target,
      ...(precise ? { eventAt: timed.eventAt, exactHour: timed.exactHour, exactMinute: timed.exactMinute, period: timed.period,
        followUpAt: timed.followUpAt, followUpWindow: timed.followUpWindow, followUp: timed.followUp } : {}),
      sourceMessageIds: [...new Set([...list(target.sourceMessageIds), message.id])], evidence: text,
      description: clean(`${target.description}；${text}`, 120), updatedAt: message.at || target.updatedAt }) : e)
    return 'UPDATE'
  }
  // A clearer date for a single undated event updates that event instead of
  // creating an abandoned parallel follow-up.
  const undated = matching.length === 1 && !target?.dueDate ? target : null
  if (undated) { memory.events = memory.events.map(e => e.id === undated.id ? normalizeEvent({ ...created, id: undated.id, createdAt: undated.createdAt, sourceMessageIds: [...new Set([...list(undated.sourceMessageIds), message.id])] }) : e); return 'UPDATE' }
  memory.events.push(created)
  return 'CREATE'
}
function advanceEventLifecycle(events, now = new Date()) {
  const at = new Date(now).getTime()
  return list(events).map(saved => {
    const event = normalizeEvent(saved)
    if (TERMINAL_EVENT_STATUSES.includes(event.status) || !event.followUp.enabled || !event.followUpWindow) return event
    if (at > Date.parse(event.followUpWindow.endAt)) return normalizeEvent({ ...event, status: 'stale', followUp: { ...event.followUp, enabled: false, status: 'stale' } })
    return { ...event, status: at >= Date.parse(event.followUpWindow.startAt) ? 'due' : 'upcoming' }
  })
}
function putFact(memory, fact) {
  const previous = memory.profile.identity[fact.field]
  if (previous?.updatedAt && fact.updatedAt && Date.parse(previous.updatedAt) > Date.parse(fact.updatedAt)) return
  if (IDENTITY_FIELDS.includes(fact.field)) memory.profile.identity[fact.field] = { ...fact }
  else {
    const key = fact.field === 'interest' ? 'interests' : 'currentLife'
    memory.profile[key] = [...memory.profile[key].filter(item => item.value !== fact.value), fact].slice(-30)
  }
  memory.facts = [...memory.facts.filter(item => IDENTITY_FIELDS.includes(fact.field) ? item.field !== fact.field : item.field !== fact.field || item.value !== fact.value), fact].slice(-80)
}
function relationMetrics(messages, now = new Date()) {
  const owner = messages.filter(m => m.role === 'me').slice(-6)
  let consecutiveQuestions = 0
  for (let i = owner.length - 1; i >= 0 && isQuestion(owner[i].text); i--) consecutiveQuestions++
  let unansweredOutgoing = 0
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'me'; i--) unansweredOutgoing++
  const contact = messages.filter(m => m.role === 'contact').slice(-20)
  let incomingInitiations7d = 0, outgoingInitiations7d = 0
  const replyIntervals = []
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i], previous = messages[i - 1]
    const at = Date.parse(current.at), prior = Date.parse(previous?.at)
    if (Number.isFinite(at) && new Date(now).getTime() - at <= 7 * 86400000 && new Date(now).getTime() >= at && (!previous || (Number.isFinite(prior) && at - prior >= 6 * 3600000))) {
      if (current.role === 'contact') incomingInitiations7d++; else outgoingInitiations7d++
    }
    if (previous?.role === 'me' && current.role === 'contact' && Number.isFinite(at) && Number.isFinite(prior) && at >= prior) replyIntervals.push(at - prior)
  }
  const average = items => items.reduce((sum, m) => sum + [...m.text].length, 0) / Math.max(1, items.length)
  const engagementTrend = contact.length < 6 ? 'unknown' : average(contact.slice(-3)) < average(contact.slice(-6, -3)) * 0.6 ? 'shortening' : 'stable'
  return { questionPressure: owner.length ? owner.filter(m => isQuestion(m.text)).length / owner.length : 0, consecutiveQuestions, unansweredOutgoing, averageReplyLength: contact.length ? Math.round(average(contact)) : 0, averageReplyIntervalMs: replyIntervals.length ? Math.round(replyIntervals.reduce((a, b) => a + b, 0) / replyIntervals.length) : null, incomingInitiations7d, outgoingInitiations7d, measurementScope: 'available_messages', engagementTrend }
}
function syncMemory(contact, { incoming = '', now = new Date(), incomingMeta = {} } = {}) {
  const memory = normalizeMemory(contact?.socialBrain)
  if (!contact?.socialBrain) memory.legacyMemories = list(contact?.learning?.facts).map(f => ({ content: clean(typeof f === 'string' ? f : f?.text, 120), status: 'unverified_legacy' })).filter(f => f.content).slice(-30)
  const messages = messageList(contact, incoming, now, incomingMeta)
  const seen = new Set(memory.processedMessageIds)
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (seen.has(message.id)) continue
    if (message.role === 'me') {
      const topic = questionTopic(message.text)
      if (topic && memory.profile.identity[topic].status === 'unknown') memory.learningHistory.push({ id: `l_${hash(message.id)}`, topic, sourceMessageId: message.id, askedAt: message.at || null, result: 'pending', cooldownUntil: message.at ? shiftDay(localDay(message.at), 3) : null })
    } else {
      const previousQuestion = messages[i - 1]?.role === 'me' ? questionTopic(messages[i - 1].text) : ''
      const facts = observedFacts(message, previousQuestion)
      facts.forEach(f => putFact(memory, f))
      updateEventsFromMessage(memory, message)
      for (const attempt of memory.learningHistory.filter(a => a.result === 'pending')) {
        if (facts.some(f => f.field === attempt.topic)) { attempt.result = 'answered'; attempt.answeredAt = message.at || null; attempt.cooldownUntil = null }
        else if (previousQuestion === attempt.topic) { attempt.result = 'avoided'; attempt.cooldownUntil = message.at ? shiftDay(localDay(message.at), 10) : null }
      }
    }
    seen.add(message.id)
  }
  memory.events = advanceEventLifecycle(memory.events.slice(-40), now)
  memory.learningHistory = memory.learningHistory.slice(-40)
  memory.processedMessageIds = [...seen].slice(-240)
  memory.relationshipMetrics = relationMetrics(messages, now)
  memory.unknowns = IDENTITY_FIELDS.filter(field => memory.profile.identity[field].status === 'unknown')
  memory.summary = summarizeMemory(memory, messages)
  return memory
}
function applyObservations(memoryInput, observations, messages, now = new Date()) {
  const memory = normalizeMemory(memoryInput)
  const sources = new Map(messages.filter(m => m.role === 'contact').map(m => [m.id, m]))
  // Evidence presence is necessary but not sufficient. Identity updates must
  // also match an explicit self-statement; "老板让我加班" cannot prove a job.
  for (const item of list(observations?.facts).slice(0, 15)) {
    if (!item || typeof item !== 'object') continue
    const source = sources.get(item.evidenceMessageId || list(item.sourceMessageIds)[0])
    if (!memoryEvidenceAllowed(source) || !ownAssertion(source.text)) continue
    const evidence = clean(item.evidence)
    if (!evidence || !source.text.includes(evidence)) continue
    const known = observedFacts(source, questionTopic(messages[messages.findIndex(m => m.id === source.id) - 1]?.text || ''))
    const fact = known.find(f => f.field === (item.field || item.type) && f.value === clean(item.value, 60))
    if (fact) putFact(memory, fact)
  }
  for (const item of list(observations?.inferences).slice(0, 6)) {
    if (!item || typeof item !== 'object') continue
    const source = sources.get(item.evidenceMessageId || list(item.sourceMessageIds)[0])
    const content = clean(item.content || item.value, 120)
    if (!memoryEvidenceAllowed(source) || !content || !clean(item.evidence) || !source.text.includes(clean(item.evidence))) continue
    const inference = { content, status: 'inference', confidence: Math.min(0.8, Math.max(0, Number(item.confidence) || 0)), evidence: clean(item.evidence), sourceMessageIds: [source.id], updatedAt: new Date(now).toISOString() }
    memory.inferences = [...memory.inferences.filter(i => i.content !== content), inference].slice(-20)
  }
  // Operations are accepted only when the named source belongs to this contact
  // and the operation is independently supported by its exact wording. Model
  // dates, descriptions and confidence never override deterministic evidence.
  for (const item of list(observations?.events).slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const source = sources.get(item.evidenceMessageId || list(item.sourceMessageIds)[0])
    if (!source || !clean(item.evidence) || !source.text.includes(clean(item.evidence))) continue
    const operation = clean(item.operation || item.action || 'CREATE').toUpperCase()
    if (!['CREATE', 'UPDATE', 'RESCHEDULE', 'RESOLVE', 'CANCEL'].includes(operation)) continue
    const trial = { events: memory.events.map(e => normalizeEvent({ ...e, followUp: { ...e.followUp } })) }
    const detected = updateEventsFromMessage(trial, source)
    if (detected === operation || (operation === 'UPDATE' && detected === 'RESCHEDULE')) memory.events = trial.events
  }
  memory.events = advanceEventLifecycle(memory.events.slice(-40), now)
  memory.unknowns = IDENTITY_FIELDS.filter(field => memory.profile.identity[field].status === 'unknown')
  memory.summary = summarizeMemory(memory, messages)
  return memory
}
function summarizeMemory(memory, messages = []) {
  const facts = memory.facts.slice(-12).map(f => `${f.field}：${f.value}`).join('；')
  const recent = messages.slice(-4).map(m => `${m.role === 'me' ? '我' : '对方'}：${m.text.slice(0, 70)}`).join('\n')
  const older = messages.slice(0, -30).slice(-4).map(m => `${m.role === 'me' ? '我' : '对方'}：${m.text.slice(0, 50)}`).join('；')
  return `# 联系人记忆视图\n\n## 关系状态\n${JSON.stringify(memory.relationshipMetrics)}\n\n## 已知信息\n${facts || '暂无有证据的事实'}\n\n## 推测（未确认）\n${memory.inferences.slice(-3).map(i => i.content).join('；') || '无'}\n\n## 最近聊天\n${recent || '暂无'}\n${older ? `较早聊天摘录：${older}\n` : ''}\n## 沟通经验\n${memory.learningHistory.slice(-6).map(a => `${a.topic}：${a.result}`).join('；') || '暂无'}\n\n## 待跟进\n${memory.events.filter(e => e.followUp?.status === 'pending').slice(-6).map(e => `${e.description}；可跟进日期：${e.followUp.notBefore}`).join('\n') || '无'}`.slice(0, 2600)
}
function compatibilityFacts(memory) {
  return memory.facts.map(f => ({ text: `${f.field === 'interest' ? '兴趣' : f.field === 'current_life' ? '近况' : { province: '籍贯省份', city: '所在城市', occupation: '职业', school: '学校', major: '专业', grade: '年级' }[f.field]}：${f.value}`, evidence: f.evidence, sourceMessageIds: f.sourceMessageIds, source: 'contact', at: f.updatedAt, status: 'fact' })).slice(-30)
}
function persistMemoryViews(root, contact) {
  if (!contact.socialBrain) return
  const memory = normalizeMemory(contact.socialBrain)
  const dir = path.join(root, 'social-brain', hash(`${contact.id || ''}\n${contact.name}`))
  fs.mkdirSync(dir, { recursive: true })
  const records = { 'profile.json': { version: 1, contactId: contact.id || '', name: contact.name, ...memory.profile, unknowns: memory.unknowns || [] }, 'events.json': memory.events, 'memories.json': { facts: memory.facts, inferences: memory.inferences, legacyMemories: memory.legacyMemories || [] }, 'style.json': { ownerStyle: contact.learning?.ownerStyle || {}, realExamples: contact.profile?.examplesSource === 'shared-conversation' ? [] : list(contact.profile?.examples).slice(-12), examplesSource: contact.profile?.examplesSource || 'owner' }, 'relationship.json': { metrics: memory.relationshipMetrics, lastPlan: memory.lastPlan || null }, 'learning-history.json': memory.learningHistory, 'summary.md': memory.summary || summarizeMemory(memory) }
  for (const [file, content] of Object.entries(records)) {
    const target = path.join(dir, file), temp = `${target}.tmp`
    fs.writeFileSync(temp, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
    fs.renameSync(temp, target)
  }
}
module.exports = { IDENTITY_FIELDS, FOLLOWUP_RULES, TERMINAL_EVENT_STATUSES, clean, localDay, shiftDay, messageQuote, messageList, memoryEvidenceAllowed, emptyMemory, normalizeMemory, questionTopic, isQuestion, observedFacts, eventFromMessage, normalizeEvent, updateEventsFromMessage, advanceEventLifecycle, relationMetrics, syncMemory, applyObservations, summarizeMemory, compatibilityFacts, persistMemoryViews }
