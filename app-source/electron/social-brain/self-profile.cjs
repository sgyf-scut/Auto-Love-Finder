const { createHash, randomUUID } = require('node:crypto')

const SHARE_LEVELS = Object.freeze(['OPEN', 'NORMAL', 'CAUTIOUS', 'PRIVATE'])
const list = value => Array.isArray(value) ? value : []
const clean = (value, limit = 2000) => String(value ?? '').trim().slice(0, limit)
const iso = value => new Date(value || Date.now()).toISOString()
const PRIVATE_KEYS = /(?:phone|mobile|contact|wechat|weixin|qq|email|password|secret|token|otp|verification|identity_card|id_card|bank_card|account|detailed_address|^address(?:\s|$)|电话|手机|联系方式|微信|邮箱|密码|口令|密钥|验证码|身份证|证件|银行卡|银行账户|详细住址|门牌|住址|地址|账号)/i
const PRIVATE_TEXT = /(?:\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|\b\d{16,19}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:密码|验证码|身份证|银行卡|银行账号|微信号|QQ号|手机号|电话号|账号密码|API\s*Key|密钥|口令)\s*[:：是为]?\s*[^\s，。；;]{2,}|(?:路|街|巷)\s*\d+号|\d+(?:栋|幢|单元|室)|sk-[A-Za-z0-9_-]{8,})/i
function containsPrivateData(value) { return PRIVATE_TEXT.test(typeof value === 'string' ? value : JSON.stringify(value ?? '')) }
function inferShareLevel(item = {}) {
  if (PRIVATE_KEYS.test(`${item.key || ''} ${item.label || ''}`) || containsPrivateData(item.value) || containsPrivateData(item.sourceText)) return 'PRIVATE'
  const requested = String(item.shareLevel || item.shareLevelSuggestion || '').toUpperCase()
  if (SHARE_LEVELS.includes(requested)) return requested
  if (/school|education|family|学校|教育|家庭|父母/i.test(`${item.key || ''} ${item.label || ''}`)) return 'CAUTIOUS'
  return 'NORMAL'
}
function valueOf(value) {
  if (typeof value === 'string') return clean(value, 1000)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))) return [...new Set(value.map(item => typeof item === 'string' ? clean(item, 300) : item).filter(item => item !== ''))].slice(0, 25)
  return null
}
function normalizeItem(item, { section = 'stableProfile', now = new Date(), status = 'confirmed' } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const key = clean(item.key, 80), value = valueOf(item.value)
  if (!key || value === null || value === '' || (Array.isArray(value) && !value.length)) return null
  const at = iso(now), expires = item.expiresAt || item.expiry || null
  return { id: clean(item.id, 100) || `self_${createHash('sha256').update(`${section}:${key}`).digest('hex').slice(0, 20)}`, key, label: clean(item.label || key, 100), value,
    shareLevel: inferShareLevel({ ...item, value }), confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)), sourceText: clean(item.sourceText, 4000),
    status, source: clean(item.source || 'user_edit', 80), createdAt: Number.isFinite(Date.parse(item.createdAt)) ? iso(item.createdAt) : at, updatedAt: Number.isFinite(Date.parse(item.updatedAt)) ? iso(item.updatedAt) : at,
    expiresAt: expires && Number.isFinite(Date.parse(expires)) ? iso(expires) : section === 'currentLife' ? new Date(new Date(now).getTime() + 30 * 86400000).toISOString() : null,
    revision: Math.max(1, Math.floor(Number(item.revision) || 1)) }
}
function emptySelfProfile() { return { version: 1, revision: 0, stableProfile: [], currentLife: [], privacyPreferences: [], pending: null, updatedAt: null } }
function normalizeSection(items, section, now, status = 'confirmed') {
  const map = new Map()
  for (const raw of list(items).slice(-100)) {
    const item = normalizeItem(raw, { section, now, status })
    if (item && !['deleted', 'rejected'].includes(raw.status) && (status === 'pending' || !raw.status || raw.status === 'confirmed')) map.set(item.key, item)
  }
  return [...map.values()]
}
function normalizeSelfProfile(saved, { now = new Date() } = {}) {
  const profile = emptySelfProfile()
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return profile
  return { ...profile, ...(typeof saved.enabled === 'boolean' ? { enabled: saved.enabled } : {}), revision: Math.max(0, Math.floor(Number(saved.revision) || 0)),
    ...(typeof saved.introductionText === 'string' ? { introductionText: clean(saved.introductionText, 30000) } : {}),
    stableProfile: normalizeSection(saved.stableProfile, 'stableProfile', now).filter(item => item.status === 'confirmed'),
    currentLife: normalizeSection(saved.currentLife, 'currentLife', now).filter(item => item.status === 'confirmed'),
    privacyPreferences: normalizeSection(saved.privacyPreferences, 'privacyPreferences', now),
    pending: saved.pending?.status === 'pending' ? normalizePending(saved.pending, now) : null,
    updatedAt: Number.isFinite(Date.parse(saved.updatedAt)) ? iso(saved.updatedAt) : null }
}
function normalizePending(pending, now = new Date()) {
  return { id: clean(pending.id, 100) || `pending_${randomUUID()}`, status: 'pending', baseRevision: Math.max(0, Math.floor(Number(pending.baseRevision) || 0)), sourceText: clean(pending.sourceText, 30000), createdAt: Number.isFinite(Date.parse(pending.createdAt)) ? iso(pending.createdAt) : iso(now),
    stableProfile: normalizeSection(pending.stableProfile, 'stableProfile', now, 'pending'), currentLife: normalizeSection(pending.currentLife, 'currentLife', now, 'pending'),
    privacyPreferences: normalizeSection(pending.privacyPreferences, 'privacyPreferences', now, 'pending'),
    uncertainItems: list(pending.uncertainItems).slice(0, 50).map(item => ({ key: clean(item?.key, 80), label: clean(item?.label, 100), reason: clean(item?.reason, 300), sourceText: clean(item?.sourceText, 2000) })) }
}
function stageSelfProfile(saved, pending, { now = new Date() } = {}) {
  const profile = normalizeSelfProfile(saved, { now })
  return { ...profile, pending: normalizePending({ ...pending, baseRevision: profile.revision }, now) }
}
function mergeConfirmed(existing, incoming, section, now) {
  const map = new Map(existing.map(item => [item.key, item]))
  for (const raw of incoming) {
    if (raw?.keep === false || raw?.status === 'rejected') continue
    const item = normalizeItem(raw, { section, now })
    if (!item) throw new Error('本人资料条目无效，请检查字段和值')
    const prior = map.get(item.key)
    map.set(item.key, { ...item, id: prior?.id || item.id, createdAt: prior?.createdAt || item.createdAt, updatedAt: iso(now), revision: (prior?.revision || 0) + 1 })
  }
  return [...map.values()].slice(-100)
}
function confirmSelfProfile(saved, { pendingId, stableProfile, currentLife, privacyPreferences, now = new Date() } = {}) {
  const profile = normalizeSelfProfile(saved, { now })
  if (!profile.pending || pendingId !== profile.pending.id || profile.pending.baseRevision !== profile.revision) throw new Error('待审核本人资料已变更，请刷新后重新审核')
  const output = { ...profile, pending: null, revision: profile.revision + 1, updatedAt: iso(now) }
  for (const [section, supplied] of Object.entries({ stableProfile, currentLife, privacyPreferences })) {
    if (supplied !== undefined && !Array.isArray(supplied)) throw new Error('审核资料格式无效')
    const reviewed = supplied === undefined ? profile.pending[section] : supplied.map(item => {
      const original = profile.pending[section].find(prior => prior.id === item?.id || prior.key === item?.key)
      return original && JSON.stringify(original.value) === JSON.stringify(item.value) ? { ...item, source: original.source } : { ...item, source: 'user_review' }
    })
    output[section] = mergeConfirmed(profile[section], reviewed, section, now)
  }
  return output
}
function applySelfIntroduction(saved, extracted, { now = new Date() } = {}) {
  const profile = normalizeSelfProfile(saved, { now })
  const output = { ...profile, revision: profile.revision + 1, introductionText: extracted.sourceText, updatedAt: iso(now) }
  for (const section of ['stableProfile', 'currentLife', 'privacyPreferences']) {
    const previous = new Map(profile[section].map(item => [item.key, item]))
    const incoming = list(extracted[section]).flatMap(item => {
      const prior = previous.get(item.key)
      // 手工或审核过的资料继续由本人信息库管理。
      if (prior && prior.source !== 'self_introduction') return []
      const rank = Math.max(SHARE_LEVELS.indexOf(prior?.shareLevel), SHARE_LEVELS.indexOf(item.shareLevel), 0)
      return [{ ...item, source: 'self_introduction', shareLevel: SHARE_LEVELS[rank] }]
    })
    output[section] = mergeConfirmed(profile[section], incoming, section, now)
      .filter(item => item.source !== 'self_introduction' || incoming.some(row => row.key === item.key))
  }
  return output
}
function updateSelfProfile(saved, { section = 'stableProfile', item, removeId, now = new Date() } = {}) {
  if (!['stableProfile', 'currentLife', 'privacyPreferences'].includes(section)) throw new Error('本人资料分区无效')
  const profile = normalizeSelfProfile(saved, { now })
  if (!removeId && !item) throw new Error('请指定要修改或删除的本人资料')
  const existing = removeId ? profile[section].filter(entry => ![entry.id, entry.key].includes(removeId)) : profile[section]
  return { ...profile, [section]: item ? mergeConfirmed(existing, [item], section, now) : existing, pending: null, revision: profile.revision + 1, updatedAt: iso(now) }
}
function activeSelfItems(saved, { now = new Date() } = {}) {
  const profile = normalizeSelfProfile(saved, { now }), at = new Date(now).getTime()
  return [...profile.stableProfile, ...profile.currentLife].filter(item => item.status === 'confirmed' && (!item.expiresAt || Date.parse(item.expiresAt) > at))
}
function hasConfirmedSelfProfile(profile) { return Boolean(profile && profile.enabled !== false && Number(profile.revision) > 0 && activeSelfItems(profile).length) }
// Fictional starter template only; explicit initialization never overwrites an existing profile.
function createSeedSelfProfile({ now = new Date() } = {}) {
  const rows = [
    ['name', '姓名', '示例用户', 'OPEN'], ['birthDate', '出生日期', '2000-01-01', 'NORMAL'], ['hometown', '老家', '示例省示例市', 'OPEN'],
    ['education', '教育', '本科、硕士均在示例理工大学', 'CAUTIOUS'], ['routine', '日常', ['约08:00起床', '约08:30到实验室', '约22:00结束实验室工作'], 'NORMAL'],
    ['gaming', '游戏', ['英雄联盟', '三角洲', '种田类游戏', '单机游戏'], 'OPEN'], ['sports', '运动', ['健身', '游泳', '羽毛球'], 'OPEN'],
    ['fitnessRoutine', '健身时间', '通常约17:00', 'NORMAL'], ['swimmingRoutine', '游泳频率', '约每周两次', 'NORMAL'],
    ['interests', '其他兴趣', ['美食', '喝酒', '短剧', '电音'], 'OPEN'], ['travel', '旅游经历', ['广西', '西安', '新疆'], 'NORMAL'],
    ['videoInterests', '视频兴趣', ['可爱猫咪', '风景', '美食', '大众有趣内容'], 'OPEN'] ]
  return { ...emptySelfProfile(), revision: 1, stableProfile: rows.map(([key, label, value, shareLevel]) => normalizeItem({ key, label, value, shareLevel, confidence: 1, sourceText: `${label}：${Array.isArray(value) ? value.join('、') : value}` }, { now })),
    currentLife: [normalizeItem({ key: 'currentWork', label: '最近主要在忙', value: ['示例项目开发', '论文阅读', '开题'], shareLevel: 'NORMAL', confidence: 1, sourceText: '最近主要在忙：示例项目开发、论文阅读、开题' }, { section: 'currentLife', now })],
    privacyPreferences: [normalizeItem({ key: 'school', label: '学校披露偏好', value: '谨慎，不要刚认识就主动说', shareLevel: 'CAUTIOUS', sourceText: '学校披露偏好：谨慎，不要刚认识就主动说', confidence: 1 }, { section: 'privacyPreferences', now })], updatedAt: iso(now) }
}
module.exports = { SHARE_LEVELS, emptySelfProfile, normalizeSelfProfile, normalizeItem, normalizePending, stageSelfProfile, confirmSelfProfile, applySelfIntroduction, updateSelfProfile, activeSelfItems, hasConfirmedSelfProfile, createSeedSelfProfile, inferShareLevel, containsPrivateData }
