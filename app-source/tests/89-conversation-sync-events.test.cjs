const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ContactEngine } = require('../electron/contact-engine.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
function fixture({ sync = true } = {}) {
  let at = new Date('2026-10-10T12:00:00+08:00')
  let data = { selfPersona: { name: '本人', interests: '宠物，摄影' }, settings: {}, automation: {}, contacts: [], sendHistory: [],
    friendship: { followed: [], contactConfig: { enabled: true, templates: { default: '手动填写首句' } } }, discovery: { config: { targetGender: 'female', requireFollowerLimit: true, followerLimit: 150 }, candidates: [] } }
  const requests = [], calls = [], logs = []
  const storage = { get: () => structuredClone(data), update: patch => { data = { ...data, ...structuredClone(patch) }; return storage.get() } }
  const manager = new CandidateManager(storage)
  manager.upsert([{ profileUrl: 'https://www.douyin.com/user/verified-user', nickname: '真实昵称', source: { topic: 'social', keyword: '交友', videoId: 'v1', commentId: 'm1', commentText: '研二想交朋友，喜欢宠物和摄影，希望认识一起交流日常的朋友' } }], { accountId: 'a' })
  const id = manager.get().candidates[0].id
  manager.patch(id, { publicSignals: { genderText: '女', followerCount: 10 } }); manager.review(id, { status: 'APPROVED' })
  const douyin = { getSendAllowance: () => ({ ok: true }), emitEvent() {}, log: (...args) => logs.push(args) }
  if (sync) douyin.requestConversationSync = payload => { requests.push(structuredClone(payload)); return { ok: true } }
  const friendship = { candidates: new Map(), async follow(url, options) { await options.beforeAction(); calls.push('follow'); return { ok: true } },
    async probeContact(url, options) { await options.beforeAction(); calls.push('probe'); return { ok: true, identityVerified: true, platformUserId: 'verified-user', followed: true, dmAvailable: true } },
    async greeting(url, text, options) {
      await options.beforeSubmit(); calls.push(['greeting', text]); storage.update({ contacts: [{ id: 'c1', name: '真实昵称', profile: { platformUserId: 'verified-user', autoFriendshipUrl: url }, learning: { messages: [] } }] })
      return { ok: true, profileUrl: url, contactId: 'c1' }
    } }
  const engine = new ContactEngine({ storage, douyin, friendship, accountId: 'a', clock: () => new Date(at) })
  engine.enqueue(id)
  return { engine, storage, douyin, friendship, manager, id, requests, calls, logs, candidate: () => manager.get().candidates[0], advance(minutes = 60) { at = new Date(at.getTime() + minutes * 60000) }, now: () => at.toISOString() }
}
test('confirmed follow and opening enqueue targeted sync with reliable candidate identity and real checkpoints', async () => {
  const f = fixture(); await f.engine.runOnce()
  assert.deepEqual(f.requests.map(item => item.reason), ['follow_confirmed', 'opening_confirmed'])
  for (const request of f.requests) {
    assert.equal(request.accountId, 'a'); assert.equal(request.candidateId, f.id); assert.equal(request.name, '真实昵称')
    assert.equal(request.platformUserId, 'verified-user'); assert.ok(request.eventKey.includes(f.id)); assert.ok(request.eventKey.includes(f.now()))
  }
  assert.equal(f.requests[0].contactId, undefined); assert.equal(f.requests[1].contactId, 'c1')
  assert.deepEqual(f.calls, ['follow', 'probe', ['greeting', '手动填写首句']]); assert.equal(f.candidate().status, 'WAITING_REPLY')
})
test('first verified reply requests one sync with linked contact name, message ID and actual reply time', async () => {
  const f = fixture(); await f.engine.runOnce(); f.advance(1)
  const contact = f.storage.get().contacts[0]; contact.name = '已改名联系人'; f.storage.update({ contacts: [contact] })
  const message = { id: 'real-message-id', at: f.now(), role: 'contact', text: '你好' }
  assert.equal(f.engine.onIncoming(contact, message).skipped, true); assert.equal(f.requests.length, 2)
  assert.equal(f.engine.onIncoming(contact, message, { platformUserId: 'verified-user' }).replied, true)
  const request = f.requests[2]
  assert.equal(request.reason, 'first_reply'); assert.equal(request.contactId, 'c1'); assert.equal(request.name, '已改名联系人')
  assert.ok(request.eventKey.includes(message.id)); assert.ok(request.eventKey.includes(message.at))
  assert.equal(f.engine.onIncoming(contact, message, { platformUserId: 'verified-user' }).skipped, true); assert.equal(f.requests.length, 3)
})
test('pending follow enqueues only after reliable read-only confirmation, once', async () => {
  const f = fixture(); f.friendship.follow = async () => ({ ok: true, followPending: true })
  await f.engine.runOnce(); assert.equal(f.requests.length, 0); assert.equal(f.candidate().status, 'FOLLOW_PENDING')
  f.advance(); await f.engine.runOnce()
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].reason, 'follow_confirmed')
  await f.engine.runOnce(); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].reason, 'opening_confirmed')
})
test('uncertain follow and opening never enqueue a false confirmation or retry a submission', async () => {
  const follow = fixture(); follow.friendship.follow = async () => { throw new Error('unknown follow result') }
  await follow.engine.runOnce(); assert.equal(follow.requests.length, 0); assert.equal(follow.candidate().status, 'FOLLOW_UNCERTAIN')
  const opening = fixture(); opening.friendship.greeting = async () => { throw new Error('unknown send result') }
  await opening.engine.runOnce(); assert.deepEqual(opening.requests.map(item => item.reason), ['follow_confirmed']); assert.equal(opening.candidate().status, 'SEND_UNKNOWN')
  opening.advance(); await opening.engine.runOnce(); assert.equal(opening.requests.length, 1); assert.throws(() => opening.engine.retry(opening.id))
})
test('queue requests do not await remote work and queue errors are logged without altering confirmed checkpoints', async () => {
  const waiting = fixture(); waiting.douyin.requestConversationSync = payload => { waiting.requests.push(payload); return new Promise(() => {}) }
  assert.equal((await waiting.engine.runOnce()).greeted, true); assert.equal(waiting.requests.length, 2)
  for (const mode of ['throw', 'reject', 'failed_result']) {
    const f = fixture(); f.douyin.requestConversationSync = () => { if (mode === 'throw') throw new Error('queue unavailable'); if (mode === 'failed_result') return { ok: false, reason: 'queue unavailable' }; return Promise.reject(new Error('queue unavailable')) }
    assert.equal((await f.engine.runOnce()).greeted, true); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.candidate().status, 'WAITING_REPLY'); assert.equal(f.logs.length, 2); assert.equal(f.logs[0][0], 'conversation_sync_error')
  }
})
test('legacy mocks without optional queue method keep the existing contact pipeline working', async () => {
  const f = fixture({ sync: false }); assert.equal((await f.engine.runOnce()).greeted, true)
  assert.equal(f.candidate().status, 'WAITING_REPLY'); assert.equal(f.requests.length, 0)
})
