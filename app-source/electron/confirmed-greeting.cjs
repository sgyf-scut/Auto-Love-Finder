// Platform delivery and local contact bookkeeping are separate facts.
function resolveGreetingContact(contacts, candidate) {
  const expected = new URL(candidate.url).pathname.split('/').filter(Boolean).at(-1)
  const identity = contact => {
    const profile = contact.profile || {}, ids = new Set()
    if (profile.platformUserId) ids.add(String(profile.platformUserId))
    if (profile.autoFriendshipUrl) {
      try { const u = new URL(profile.autoFriendshipUrl); if (u.origin === 'https://www.douyin.com' && /^\/user\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)) ids.add(u.pathname.split('/').filter(Boolean).at(-1)) } catch {}
    }
    return ids
  }
  const matches = contacts.filter(contact => identity(contact).has(expected))
  const existing = matches[0], name = existing?.name || candidate.name
  if (matches.length > 1 || (existing && identity(existing).size !== 1)
    || contacts.some(contact => contact.name === name && contact !== existing)) {
    throw Object.assign(new Error('联系人身份冲突，归档保留原记录，消息无需重发'), { code: 'CONTACT_ARCHIVE_CONFLICT' })
  }
  return existing
}

// Call only AFTER sendCurrentInput has returned a confirmed delivery.
function archiveConfirmedGreeting(service, candidate, archive) {
  let contact
  try { contact = archive() }
  catch (error) {
    const warning = `消息已确认发送，联系人归档未完成：${String(error?.message || error).slice(0, 200)}。请勿重发。`
    try { service.douyin.log?.('friend_greeting_archive_pending', warning, { name: candidate.name, url: candidate.url, deliveryStatus: 'confirmed' }) } catch {}
    return { ok: true, messageSent: true, deliveryStatus: 'confirmed', name: candidate.name, profileUrl: candidate.url,
      contactId: null, contactSyncPending: true, warning }
  }
  return { ok: true, messageSent: true, deliveryStatus: 'confirmed', name: candidate.name, profileUrl: candidate.url, contactId: contact.id }
}
module.exports = { resolveGreetingContact, archiveConfirmedGreeting }
