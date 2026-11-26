// Serializable DOM probe. Background risk widgets are not human challenges.
function verificationSnapshot() {
  const title = String(document.title || '').trim()
  if (title === '验证码中间页') return { challenge: true, evidence: { kind: 'verification_page', title } }
  const prompt = /请完成.{0,12}(?:安全)?验证|验证后继续|拖动.{0,12}滑块|完成拼图|按顺序点击|本次登录需进行校验/
  const body = String(document.body?.innerText || '')
  const visible = node => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false
    const rect = node.getBoundingClientRect()
    if (!(rect.width >= 120 && rect.height >= 60)) return false
    const height = typeof innerHeight === 'number' ? innerHeight : Infinity, width = typeof innerWidth === 'number' ? innerWidth : Infinity
    if (Number.isFinite(rect.bottom) && rect.bottom <= 0 || Number.isFinite(rect.right) && rect.right <= 0 || rect.top >= height || rect.left >= width) return false
    for (let current = node, depth = 0; current && depth < 15; current = current.parentElement, depth++) {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(current) : {}
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= .05 || current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false
    }
    return true
  }
  const nodes = document.querySelectorAll('iframe[src*="verifycenter"], iframe[src*="captcha"], [class*="captcha"], [id*="captcha"], [role="dialog"]')
  for (const node of nodes) {
    if (!visible(node)) continue
    const src = String(node.getAttribute?.('src') || node.src || ''), tag = String(node.tagName || '').toUpperCase()
    const ownText = String(node.innerText || '')
    const passive = /nocaptcha|no-captcha/i.test(src)
    const challengeFrame = tag === 'IFRAME' && /verifycenter|captcha/i.test(src) && !passive
    const modal = /captcha[_-]?modal|secsdk_captcha_modal/i.test(String(node.className || '') + ' ' + String(node.id || ''))
    const parent = node.parentElement, parentText = String(parent?.innerText || '')
    const passivePrompt = passive && parent && parent !== document.body && parentText.length < 250 && prompt.test(parentText) && /captcha|verify|dialog/i.test(String(parent.className || '') + ' ' + String(parent.id || ''))
    if (challengeFrame || prompt.test(ownText) || !passive && modal && prompt.test(body) || passivePrompt) {
      const rect = node.getBoundingClientRect()
      return { challenge: true, evidence: { kind: challengeFrame ? 'visible_frame' : 'visible_challenge', tag, src: src.split('?')[0].slice(0, 180), width: rect.width, height: rect.height } }
    }
  }
  return { challenge: false }
}
function withVerificationTools(fn) {
  // Both sources are trusted application functions; no page/user text is compiled.
  return new Function(`return function verificationBound(...args) { const detectVerification = (${verificationSnapshot.toString()}); return (${fn.toString()})(...args) }`)()
}
module.exports = { verificationSnapshot, withVerificationTools }
