// Promise result writeback: the plain-language outcome a human types for a
// finished promise is turned into a small, contact-scoped payload. It never
// promotes anything to Core Self, never leaks across contacts, and never
// invents a field the human did not write. The raw result text is kept as-is;
// the extracted fields only add structure on top of it.
const { redactPrivateData } = require('./disclosure-policy.cjs')
const list = value => Array.isArray(value) ? value : []
const clean = (value, limit = 400) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const privateProfile = value => value || { stableProfile: [], currentLife: [], privacyPreferences: [] }
const safe = (value, selfProfile) => redactPrivateData(value, privateProfile(selfProfile))
const SEGMENTS = /[，,、;；\n]+/
const SEPARATOR = /^[\s:：=,，、\-—]+/
const CONNECTOR = /^[\s:：=,，、\-—]*(?:叫|是|为)?[\s:：=,，、\-—]*/
const PAIR = /^(.{1,12}?)\s*[:：=]\s*(.+)$/
const ID_TOKEN = /^[A-Za-z]{0,8}\d{3,}[A-Za-z0-9]*$/
// Ordered so a narrower keyword wins when two labels share a prefix.
const FIELD_KEYWORDS = Object.freeze([
  { label: '区服', keys: ['区服', '服务器名', '服务器', '大区'] },
  { label: '账号', keys: ['账号', '帐号', '用户名', '游戏id', 'uid', 'id'] },
  { label: '名称', keys: ['名字', '名称', '昵称'] },
  { label: '角色', keys: ['角色', '职业'] },
  { label: '段位', keys: ['段位', '等级'] },
  { label: '地点', keys: ['地点', '地址', '位置'] },
])
// A keyword only counts as a field label when something separates it from its
// value; "时间不早了" must not read as a 时间 field with the value "不早了".
function keywordField(segment) {
  for (const { label, keys } of FIELD_KEYWORDS) {
    for (const key of keys) {
      if (segment.length <= key.length) continue
      if (segment.slice(0, key.length).toLowerCase() !== key.toLowerCase()) continue
      const remainder = segment.slice(key.length)
      const stripped = remainder.replace(CONNECTOR, '')
      if (!stripped || (stripped === remainder && !SEPARATOR.test(remainder))) continue
      return { label, value: stripped }
    }
  }
  return null
}
function extractPromiseResult(promise, text, { selfProfile } = {}) {
  const source = safe(clean(text, 400), selfProfile)
  if (!source || source.includes('[私密信息]')) return { fields: [], topics: [] }
  const segments = source.split(SEGMENTS).map(part => part.trim()).filter(Boolean)
  const fields = []
  const push = (label, value) => {
    const name = clean(label, 20), content = clean(value, 200)
    if (!name || !content) return
    if (name !== '其他' && fields.some(field => field.label === name)) return
    if (fields.some(field => field.label === name && field.value === content)) return
    fields.push({ label: name, value: content })
  }
  const deferred = []
  for (const segment of segments) {
    const keyword = keywordField(segment)
    if (keyword) { push(keyword.label, keyword.value); continue }
    const pair = segment.match(PAIR)
    if (pair) { push(pair[1], pair[2]); continue }
    if (ID_TOKEN.test(segment)) { push('账号', segment); continue }
    deferred.push(segment)
  }
  // A bare, label-less segment sitting beside an account value is the server the
  // account lives on — the only reading that keeps "黑色玫瑰，ID 546124" intact.
  if (fields.some(field => field.label === '账号') && !fields.some(field => field.label === '区服') && deferred.length) {
    push('区服', deferred.shift())
  }
  // Leftovers only become fields once real structure exists; otherwise the raw
  // result text alone carries the meaning and the preview stays honest.
  if (fields.length) for (const segment of deferred) push('其他', segment)
  const topics = [...new Set([...list(promise?.topics), ...fields.map(field => field.label)])]
    .map(value => clean(value, 40)).filter(Boolean).slice(0, 6)
  return { fields: fields.slice(0, 8), topics }
}
module.exports = { extractPromiseResult, FIELD_KEYWORDS }
