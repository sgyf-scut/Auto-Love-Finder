// P2-16.1 资料事实来源分级：未知 / 本人自述 / 主页公开 / 人工核实 / 信息冲突。
//
// 设计原则：
// 1. 只认"自我指称"。评论里"想找个男生"是在说择偶对象，不能当成本人性别；
//    "找18-30岁"是在说要求，不能当成本人年龄。这类语境必须排除。
// 2. 每个结论都保留原话与来源，界面上不能只剩一个裸值。
// 3. 冲突不合并、不猜。两个来源给出不同值时记 conflict，并把两个值都留下，交人工裁决。
// 4. "未核实"与"未知"是两件事：
//    attempted=false 表示还没去读过主页（未核实）；
//    attempted=true 且无值 表示读了但没有公开资料（确实未知）。
const FACT_FIELDS = ['gender', 'age']
const FACT_STATUS = {
  UNKNOWN: 'unknown',
  SELF_DECLARED: 'self_declared',
  PUBLIC_PROFILE: 'public_profile',
  MANUAL: 'manual',
  CONFLICT: 'conflict',
}
const FACT_STATUS_LABELS = {
  unknown: '未知',
  self_declared: '本人自述',
  public_profile: '主页公开',
  manual: '人工核实',
  conflict: '信息冲突',
}
const SOURCE_LABELS = {
  comment_text: '评论原话',
  profile_bio: '主页简介',
  manual_review: '人工核验',
}
// 检索时用来判断"这句话是在说本人还是在说对象"。
const PARTNER_CONTEXT = /(找|寻|求|喜欢|想要|希望|要求|对方|择偶|对象|另一半|男朋友|女朋友|男友|女友|条件|优先)/

const clean = (value, limit = 400) => (typeof value === 'string' ? value.trim().slice(0, limit) : '')

function genderWord(word) {
  const value = String(word || '').trim().toLowerCase()
  if (['女', '女性', '女生', '妹子', 'female', 'f'].includes(value)) return 'female'
  if (['男', '男性', '男生', '汉子', 'male', 'm'].includes(value)) return 'male'
  return null
}

// 把文本切成小句，避免跨句误配。
function clausesOf(text) {
  return String(text || '')
    .split(/[。；;！!？?\n\r]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 40)
}

// 该小句是否整体在说"别人"。含择偶词且在性别词之前，就不认。
function talksAboutPartner(clause, hitIndex) {
  const head = clause.slice(0, Math.max(0, hitIndex))
  return PARTNER_CONTEXT.test(head)
}

function genderFromClause(clause) {
  // 顺序即优先级：越明确的自我指称越先匹配。
  const patterns = [
    { re: /本人\s*(?:是)?\s*(女|男)(?:生|性)?/, word: m => m[1] },
    { re: /我\s*(?:是|系)\s*(?:一[枚个])?\s*(女|男)(?:生|性)?/, word: m => m[1] },
    { re: /(女|男)(?:生|性)?\s*一[枚个]/, word: m => m[1] },
    { re: /^[\s，,]*(女|男)(?:生|性)?[\s，,、]/, word: m => m[1] },
    // 主页资料区常见"整行只有一个性别字"，没有动词，不存在择偶语境。
    { re: /^(女|男)(?:生|性)?$/, word: m => m[1] },
    { re: /(\d{2})\s*年\s*(女|男)(?:生|性)?/, word: m => m[2] },
    { re: /性别\s*[:：]\s*(女|男)/, word: m => m[1] },
  ]
  for (const pattern of patterns) {
    const match = pattern.re.exec(clause)
    if (!match) continue
    if (talksAboutPartner(clause, match.index)) continue
    const value = genderWord(pattern.word(match))
    if (value) return { value, quote: clause }
  }
  return null
}

function ageFromClause(clause, { now = new Date() } = {}) {
  const currentYear = now.getFullYear()
  // 先说对方条件的排除：区间、"要求""希望"等。
  const rangeLike = /\d{1,2}\s*[-~—～至到]\s*\d{1,2}\s*岁/
  if (rangeLike.test(clause)) return null

  const patterns = [
    { re: /(?:本人|我)?\s*(\d{1,2})\s*岁/, kind: 'age' },
    { re: /今年\s*(\d{1,2})\s*(?:岁|了)?/, kind: 'age' },
    { re: /(\d{2})\s*年\s*(?:的|出生|生人)/, kind: 'birth' },
    { re: /(\d{2})\s*年\s*(?:女|男)/, kind: 'birth' },
    { re: /^[\s，,]*(\d{2})\s*年[\s，,、]/, kind: 'birth' },
  ]
  for (const pattern of patterns) {
    const match = pattern.re.exec(clause)
    if (!match) continue
    if (talksAboutPartner(clause, match.index)) continue
    const raw = Number(match[1])
    if (!Number.isSafeInteger(raw)) continue
    if (pattern.kind === 'age') {
      if (raw >= 12 && raw <= 99) return { value: raw, quote: clause, derivedFrom: 'stated_age' }
      continue
    }
    // 两位年份：<= 当前两位年则视为 20xx，否则 19xx。
    const currentYY = currentYear % 100
    const birthYear = raw <= currentYY ? 2000 + raw : 1900 + raw
    const age = currentYear - birthYear
    if (age >= 12 && age <= 80) return { value: age, quote: clause, derivedFrom: 'birth_year', birthYear }
  }
  return null
}

// 从一段自由文本（评论正文、主页简介）里提取本人自述。
// 返回结构固定，找不到就是 null，绝不返回猜测值。
function extractSelfDeclaredFacts(text, options = {}) {
  const result = { gender: null, age: null }
  for (const clause of clausesOf(text)) {
    if (!result.gender) {
      const gender = genderFromClause(clause)
      if (gender) result.gender = gender
    }
    if (!result.age) {
      const age = ageFromClause(clause, options)
      if (age) result.age = age
    }
    if (result.gender && result.age) break
  }
  return result
}

// 把一条来源整理成统一证据条目。
function evidenceOf({ field, value, source, quote, extra = {} }) {
  if (value === null || value === undefined || value === '') return null
  return { field, value, source, quote: clean(quote, 200), ...extra }
}

// 单字段合成。优先级有两条硬规矩：
// 1. 主页公开资料不能被人工确认或评论自述改写（既有安全约定，防止误联系男性）；
//    两者不同时记 conflict，保留双方原话，同时给出 blockingValue 供判定层沿用公开值。
// 2. 没有公开资料时，人工核实 > 本人自述。
// attempted 记录"有没有真的去读过主页"，用于把"未核实"和"未知"分开。
function buildFact({ field, manual = null, selfEntries = [], publicEntries = [], attempted = false }) {
  const evidence = [...selfEntries, ...publicEntries].filter(Boolean)
  const manualEntry = manual && manual.value !== null && manual.value !== undefined && manual.value !== ''
    ? evidenceOf({ field, value: manual.value, source: 'manual_review', quote: clean(manual.quote, 200) || '人工核验', extra: { at: manual.at || null } })
    : null
  const uniqueOf = entries => {
    const map = new Map()
    for (const item of entries) if (!map.has(String(item.value))) map.set(String(item.value), item)
    return [...map.values()]
  }
  const publics = uniqueOf(publicEntries)
  const selfs = uniqueOf(selfEntries)
  const conflict = (blockingValue = null) => ({
    status: FACT_STATUS.CONFLICT,
    value: null,
    blockingValue,
    source: null,
    quote: '',
    // 冲突时人工结论也是来源之一，必须留在证据里，不能因为"没采用"就丢掉。
    evidence: manualEntry ? [...evidence, manualEntry] : evidence,
    attempted,
    conflictValues: uniqueOf([...publics, ...selfs, ...(manualEntry ? [manualEntry] : [])])
      .map(item => ({ value: item.value, source: item.source, quote: item.quote })),
  })

  // 主页公开值唯一时作为基准；主页自相矛盾时按冲突处理，不做选择。
  if (publics.length > 1) return conflict()
  const published = publics.length === 1 ? publics[0] : null

  if (published) {
    const manualDiffers = manualEntry && String(manualEntry.value) !== String(published.value)
    const selfDiffers = selfs.some(item => String(item.value) !== String(published.value))
    if (manualDiffers) return conflict(published.value)
    // 评论自述与主页公开不一致：保留冲突状态交人工裁决，但判定沿用公开值，
    // 避免"自述女性 + 主页男性"被当成合格候选（公开资料不能被自述改写）。
    if (selfDiffers) return conflict(published.value)
    return { status: FACT_STATUS.PUBLIC_PROFILE, value: published.value, source: 'profile_bio', quote: published.quote, evidence, attempted }
  }
  if (manualEntry) {
    return { status: FACT_STATUS.MANUAL, value: manualEntry.value, source: 'manual_review', quote: manualEntry.quote, evidence: [...evidence, manualEntry], attempted, manualOverrides: selfs.length > 0 && selfs.some(item => String(item.value) !== String(manualEntry.value)) }
  }
  if (selfs.length > 1) return conflict()
  if (selfs.length === 1) {
    return { status: FACT_STATUS.SELF_DECLARED, value: selfs[0].value, source: selfs[0].source, quote: selfs[0].quote, evidence, attempted }
  }
  return { status: FACT_STATUS.UNKNOWN, value: null, source: null, quote: '', evidence: [], attempted }
}

// 从候选记录合成两个字段。sources 是该候选收集到的全部评论出处。
function buildProfileFacts(candidate = {}, { now = new Date() } = {}) {
  const sources = Array.isArray(candidate.sources) && candidate.sources.length
    ? candidate.sources
    : candidate.source ? [candidate.source] : []
  const commentTexts = sources.map(item => clean(item.commentText, 4000)).filter(Boolean)

  const selfGender = []
  const selfAge = []
  for (const text of commentTexts) {
    const found = extractSelfDeclaredFacts(text, { now })
    if (found.gender) selfGender.push(evidenceOf({ field: 'gender', value: found.gender.value, source: 'comment_text', quote: found.gender.quote }))
    if (found.age) selfAge.push(evidenceOf({ field: 'age', value: found.age.value, source: 'comment_text', quote: found.age.quote, extra: found.age.birthYear ? { birthYear: found.age.birthYear, derivedFrom: found.age.derivedFrom } : { derivedFrom: found.age.derivedFrom } }))
  }

  // 主页公开：优先用已经解析好的结构化结论，再用简介原文兜底。
  const signals = candidate.publicSignals || {}
  const profileText = clean(candidate.publicProfile && candidate.publicProfile.rawText, 4000)
  const publicGender = []
  const publicAge = []
  const publishedGender = signals.genderText ? genderWord(signals.genderText) : null
  if (signals.genderConflict) for (const value of ['male','female']) publicGender.push(evidenceOf({ field: 'gender', value, source: 'profile_bio', quote: '公开性别字段存在冲突' }))
  if (publishedGender) publicGender.push(evidenceOf({ field: 'gender', value: publishedGender, source: 'profile_bio', quote: `主页资料：性别 ${signals.genderText}` }))
  if (Number.isSafeInteger(signals.age) && signals.age >= 12 && signals.age <= 99) {
    publicAge.push(evidenceOf({ field: 'age', value: signals.age, source: 'profile_bio', quote: signals.ageEvidence?.find(item => item.value === signals.age)?.quote || `主页资料：年龄 ${signals.age}` }))
  }
  if (signals.ageConflict) for (const item of signals.ageEvidence || []) if (Number.isSafeInteger(item.value)) publicAge.push(evidenceOf({ field: 'age', value: item.value, source: 'profile_bio', quote: item.quote }))
  if (profileText) {
    const fromBio = extractSelfDeclaredFacts(profileText, { now })
    if (fromBio.gender) publicGender.push(evidenceOf({ field: 'gender', value: fromBio.gender.value, source: 'profile_bio', quote: fromBio.gender.quote }))
    if (fromBio.age && !signals.publicAgeChecked) publicAge.push(evidenceOf({ field: 'age', value: fromBio.age.value, source: 'profile_bio', quote: fromBio.age.quote, extra: fromBio.age.birthYear ? { birthYear: fromBio.age.birthYear, derivedFrom: fromBio.age.derivedFrom } : { derivedFrom: fromBio.age.derivedFrom } }))
  }

  const review = candidate.review || {}
  const manualGender = review.genderConfirmation && review.genderConfirmation.source === 'manual'
    ? { value: genderWord(review.genderConfirmation.value), quote: review.genderConfirmation.note || '', at: review.genderConfirmation.at || null }
    : null
  const manualAge = review.ageConfirmation && review.ageConfirmation.source === 'manual' && Number.isSafeInteger(review.ageConfirmation.value)
    ? { value: review.ageConfirmation.value, quote: review.ageConfirmation.note || '', at: review.ageConfirmation.at || null }
    : null

  // attempted：真的抓过主页文本，才算"核实过"。没抓过 = 未核实。
  const attempted = Boolean(profileText) || Object.keys(signals).length > 0

  return {
    version: 'P2-16.1',
    gender: buildFact({ field: 'gender', manual: manualGender, selfEntries: selfGender, publicEntries: publicGender, attempted }),
    age: buildFact({ field: 'age', manual: manualAge, selfEntries: selfAge, publicEntries: publicAge, attempted }),
  }
}

// 取值：冲突与未知都返回 null，绝不替人做选择。
function factValue(fact) {
  if (!fact || !fact.status) return null
  if (fact.status === FACT_STATUS.UNKNOWN || fact.status === FACT_STATUS.CONFLICT) return null
  return fact.value === undefined ? null : fact.value
}

// 界面文案：必须能分清"未核实"和"未知"。
function describeFact(fact, { field = '', unit = '' } = {}) {
  const status = fact && fact.status ? fact.status : FACT_STATUS.UNKNOWN
  const label = FACT_STATUS_LABELS[status] || '未知'
  if (status === FACT_STATUS.CONFLICT) {
    const items = (fact.conflictValues || []).map(item => `${item.value}${unit}（${SOURCE_LABELS[item.source] || item.source}）`).join(' 与 ')
    return `信息冲突：${items || '来源互相矛盾'}，待人工裁决`
  }
  if (status === FACT_STATUS.UNKNOWN) {
    return fact && fact.attempted ? `${label}（已读主页，未找到公开资料）` : `${label}（尚未读取主页）`
  }
  const value = fact.value === null || fact.value === undefined ? '' : `${fact.value}${unit}`
  const sourceLabel = SOURCE_LABELS[fact.source] || fact.source || ''
  const quote = fact.quote && fact.quote.length <= 40 ? `「${fact.quote}」` : ''
  return `${value}（${label}${sourceLabel ? '·' + sourceLabel : ''}${quote ? '·' + quote : ''}）`
}

module.exports = {
  FACT_FIELDS, FACT_STATUS, FACT_STATUS_LABELS, SOURCE_LABELS,
  extractSelfDeclaredFacts, buildFact, buildProfileFacts, factValue, describeFact, genderWord,
}
