// Shared identity policy: account IDs authorize; display-name comparisons only assist.
// This factory is inlined into serialized page functions so it needs no page globals.
function browserNicknameTools() {
  const normalize = value => String(value || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF\u2060\uFE00-\uFE0F\s]/g, '')
  const read = node => {
    let complete = true
    const walk = item => {
      if (!item) return ''
      if (item.nodeType === 3) return item.nodeValue ?? item.textContent ?? ''
      if (item.hidden) return ''
      if (typeof getComputedStyle === 'function' && item.nodeType === 1) {
        const style = getComputedStyle(item)
        if (style.display === 'none' || style.visibility === 'hidden') return ''
      }
      if (String(item.tagName || '').toUpperCase() === 'IMG') {
        const alt = String(item.getAttribute?.('alt') ?? item.alt ?? '').trim()
        if (!alt) complete = false
        return alt
      }
      if (['SVG', 'SCRIPT', 'STYLE'].includes(String(item.tagName || '').toUpperCase())) return ''
      const children = Array.from(item.childNodes || [])
      return children.length ? children.map(walk).join('') : String(item.textContent || item.innerText || '')
    }
    const text = walk(node).trim().slice(0, 100)
    return { text, normalized: normalize(text), complete }
  }
  const same = (left, right) => Boolean(normalize(left)) && normalize(left) === normalize(right)
  const comparisonName = value => normalize(value).replace(/[^\p{L}\p{N}]/gu, '')
  const compareNames = (left, right) => same(left, right) ? 'EXACT'
    : comparisonName(left) && comparisonName(left) === comparisonName(right) ? 'DECORATION_ONLY' : 'DIFFERENT'
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
  const decide = ({ expectedId, observedIds = [], expectedName = '', displayedName = '' }) => {
    const ids = [...new Set(observedIds.filter(validId))]
    const base = { nameMatch: compareNames(expectedName, displayedName), platformUserId: ids.length === 1 ? ids[0] : '' }
    if (!validId(expectedId)) return { ...base, verified: false, state: 'PENDING', reason: 'expected_id_missing' }
    if (ids.length > 1 || (ids.length === 1 && ids[0] !== expectedId)) return { ...base, verified: false, state: 'MISMATCH', reason: 'account_id_conflict' }
    return ids.length === 1 ? { ...base, verified: true, state: 'VERIFIED', source: 'account_id' }
      : { ...base, verified: false, state: 'PENDING', reason: 'account_id_loading' }
  }
  const profileProof = (header, expectedId, displayedName) => {
    const ids = new Set()
    const add = value => { if (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)) ids.add(value) }
    // Only the visible profile header's own user objects, never recommendation lists.
    for (let node = header, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
      for (const key of Object.keys(node).filter(k => k.startsWith('__reactProps') || k.startsWith('__reactFiber'))) {
        for (let fiber = node[key], index = 0; fiber && index < 4; fiber = fiber.return, index++) {
          const props = fiber.memoizedProps || fiber
          for (const user of [props.userInfo, props.user, props.profile, props.userInfo?.user, props.userDetail?.userInfo]) {
            // The visible profile header's own user props bind this route to an ID.
            // Do not require a nickname match before looking at that stronger proof.
            if (!user) continue
            add(user.secUid); add(user.sec_uid)
          }
        }
      }
    }
    return { verified: ids.size === 1 && ids.has(expectedId), conflicting: ids.size > 0 && (ids.size !== 1 || !ids.has(expectedId)), ids: [...ids] }
  }
  // Douyin briefly renders the numeric IM user ID before its nickname request completes.
  // An alias is valid only inside that same header's opponent profile, never from a list/cache lookup.
  const uidTitleMatches = (profile, title, expectedName) => {
    const value = normalize(title)
    const uid = typeof profile?.uid === 'string' ? profile.uid
      : Number.isSafeInteger(profile?.uid) ? String(profile.uid) : ''
    return /^\d{1,25}$/.test(value) && value === uid && same(profile?.nickname, expectedName)
  }
  const chatTitles = doc => {
    const nodes = [...doc.querySelectorAll('[class*="StackLayoutStackChatHeadertitle"], [class*="RightPanelHeadertitle"], [data-e2e="chat-header-name"], [data-e2e="chat-header-title"], [class~="imChatHeadertitle"], [class~="chatHeaderTitle"]')]
      .filter(node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !/Container|MoreIcon|titleBar/.test(node.getAttribute('class') || '') })
    return nodes.filter(node => !nodes.some(other => other !== node && node.contains?.(other)))
  }
  const chatProof = (title, expectedName) => {
    const titleName = read(title), peerIds = new Set(), profileIds = new Set(), unnamedProfileIds = new Set()
    const add = (set, value) => { if (validId(value)) set.add(value) }
    let uidAlias = false
    for (let node = title, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      for (const key of Object.keys(node).filter(key => key.startsWith('__reactProps') || key.startsWith('__reactFiber'))) {
        for (let fiber = node[key], index = 0; fiber && index < 8; fiber = fiber.return, index++) {
          const props = fiber.memoizedProps || fiber
          for (const conversation of [props.curConversation, props.conversation]) {
            add(peerIds, conversation?.toParticipantSecUserId); add(peerIds, conversation?._toParticipantSecUserId)
          }
          // A differently named stale profile can remain in React ancestors.
          // Only a profile bound to this visible title may corroborate or contradict it.
          const profile = props.opponentUserProfile
          const alias = uidTitleMatches(profile, titleName.text, profile?.nickname)
          if (uidTitleMatches(profile, titleName.text, expectedName)) uidAlias = true
          if (compareNames(profile?.nickname, titleName.text) !== 'DIFFERENT' || alias) {
            add(profileIds, profile?.sec_uid); add(profileIds, profile?.secUid)
          } else if (profile && !normalize(profile.nickname)) {
            add(unnamedProfileIds, profile.sec_uid); add(unnamedProfileIds, profile.secUid)
          }
        }
      }
    }
    return { titleName, peerIds: [...peerIds], profileIds: [...profileIds], unnamedProfileIds: [...unnamedProfileIds], uidAlias }
  }
  const verifyChat = (title, expectedName, expectedId) => {
    const proof = chatProof(title, expectedName)
    const result = decide({ expectedId, observedIds: [...proof.peerIds, ...proof.profileIds, ...proof.unnamedProfileIds], expectedName, displayedName: proof.titleName.text })
    // A cached opponent profile alone is insufficient for an ID-bound send.
    if (result.state !== 'MISMATCH' && !proof.peerIds.length) return { ...result, verified: false, state: 'PENDING', reason: 'current_peer_loading' }
    return result
  }
  return { read, normalize, same, comparisonName, compareNames, decide, profileProof, uidTitleMatches, chatTitles, chatProof, verifyChat }
}

function withNicknameTools(fn) {
  const source = fn.toString(), body = source.indexOf('{')
  if (body < 0) throw new Error('Expected a serializable browser function')
  // Compile only our static function sources. No user text is part of this code.
  return new Function(`return (${source.slice(0, body + 1)}\nconst nicknameTools = (${browserNicknameTools.toString()});\n${source.slice(body + 1)})`)()
}

module.exports = { browserNicknameTools, withNicknameTools }
