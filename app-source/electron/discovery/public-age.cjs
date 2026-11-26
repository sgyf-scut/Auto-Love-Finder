// Public, visible text only. A birth year alone cannot establish exact age.
function publicAge(profile = {}, { now = new Date() } = {}) {
  const clock = new Date(new Date(now).getTime() + 8 * 3600000)
  const today = [clock.getUTCFullYear(), clock.getUTCMonth() + 1, clock.getUTCDate()]
  const lines = [...String(profile.rawText || '').split(/\r?\n/), ...(profile.ageEvidenceTexts || [])].map(s => String(s).trim()).filter(Boolean)
  const evidence = []
  for (const line of lines) {
    const stated = /^(?:年龄\s*[:：]?\s*)?(\d{1,3})\s*岁$/.exec(line) || /^年龄\s*[:：]\s*(\d{1,3})$/.exec(line)
    if (stated) {
      const value = Number(stated[1]); if (value >= 1 && value <= 120) evidence.push({ value, quote: line.slice(0,120), derivedFrom: 'stated_age' })
      continue
    }
    const birth = /^(?:生日|出生日期|出生年月日)\s*[:：]?\s*(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?$/.exec(line)
    if (!birth) continue
    const [year,month,day] = birth.slice(1).map(Number), date = new Date(Date.UTC(year,month-1,day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth()+1 !== month || date.getUTCDate() !== day) continue
    const value = today[0] - year - (today[1] < month || today[1] === month && today[2] < day ? 1 : 0)
    if (value >= 1 && value <= 120) evidence.push({ value, quote: line.slice(0,120), derivedFrom:'birth_date', birthDate:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`, evaluatedOn:today.join('-') })
  }
  const values = [...new Set(evidence.map(x => x.value))]
  return { status: values.length > 1 ? 'conflict' : values.length ? 'found' : 'not_present', age: values.length === 1 ? values[0] : null, evidence: evidence.slice(0,12) }
}
module.exports = { publicAge }
