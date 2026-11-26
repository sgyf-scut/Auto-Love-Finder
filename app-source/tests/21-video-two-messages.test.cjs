const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { VideoOpeningService } = require('../electron/video-openings.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { migrateLegacy } = require('../electron/storage.cjs')
const name = '朋友'
const url = 'https://www.douyin.com/video/1234567890123456789'
function fixture() {
  const item = { id: 'v', name, url, text: '猫咪好可爱', title: '可爱小猫', category: 'pets' }
  const storage = createMemoryStorage({ contacts: [{ name }], videoGreetings: { pending: [item], sent: [] } })
  const calls = []
  const douyin = { storage, partition: 'test', log() {}, sendMessage: async (...args) => calls.push(args) }
  return { storage, item, calls, douyin, service: new VideoOpeningService(douyin) }
}
test('caption preflight failure preserves the sent video and retry sends only the caption', async () => {
  const { storage, calls, douyin, service } = fixture()
  douyin.sendMessage = async (...args) => {
    calls.push(args)
    if (calls.length === 2) {
      assert.ok(storage.get().videoGreetings.pending[0].videoSentAt)
      const error = new Error('配文尚未写入'); error.sendAttempted = false; throw error
    }
  }
  await assert.rejects(service.send({ id: 'v' }), /配文尚未写入/)
  assert.equal(storage.get().videoGreetings.pending[0].status, 'retryable')
  const migrated = migrateLegacy(storage.get())
  storage.update({ videoGreetings: migrated.videoGreetings })
  const restarted = new VideoOpeningService(douyin)
  await restarted.send({ id: 'v', text: '你看这只猫' })
  assert.deepEqual(calls.map(args => args[1]), [url, '猫咪好可爱', '你看这只猫'])
  assert.equal(storage.get().videoGreetings.sent.length, 1)
  assert.equal(storage.get().videoGreetings.pending.length, 0)
})
test('uncertain caption confirmation cannot repeat either bubble after restart', async () => {
  const { storage, calls, douyin, service } = fixture()
  douyin.sendMessage = async (...args) => { calls.push(args); if (calls.length === 2) throw new Error('配文确认超时') }
  await assert.rejects(service.send({ id: 'v' }), /确认超时/)
  assert.ok(storage.get().videoGreetings.pending[0].videoSentAt)
  assert.equal(storage.get().videoGreetings.pending[0].status, 'uncertain')
  storage.update({ videoGreetings: migrateLegacy(storage.get()).videoGreetings })
  await assert.rejects(new VideoOpeningService(douyin).send({ id: 'v' }), /尚未确认/)
  assert.equal(calls.length, 2)
})
test('pause between bubbles leaves only the caption retryable', async () => {
  const { storage, calls, douyin, service } = fixture()
  douyin.sendMessage = async (...args) => { calls.push(args); storage.update({ automation: { paused: true } }) }
  await assert.rejects(service.send({ id: 'v' }), /暂停/)
  assert.equal(calls.length, 1)
  assert.equal(storage.get().videoGreetings.pending[0].status, 'retryable')
  assert.ok(storage.get().videoGreetings.pending[0].videoSentAt)
})
test('total and enabled per-contact quotas must have room for two before sharing', async () => {
  for (const automation of [{ dailyLimit: 2, maxPerContactDailyEnabled: false }, { dailyLimit: 10, maxPerContactDaily: 2, maxPerContactDailyEnabled: true }]) {
    const { storage, calls, douyin, service } = fixture()
    storage.update({ automation, sendHistory: [{ name, at: new Date().toISOString(), kind: 'text' }] })
    const sender = new DouyinService({ storage, ai: {} })
    douyin.assertCanSend = (...args) => sender.assertCanSend(...args)
    await assert.rejects(service.send({ id: 'v' }), /额度不足/)
    assert.equal(calls.length, 0)
    assert.equal(storage.get().videoGreetings.pending[0].videoSentAt, undefined)
    assert.equal(sender.getSendAllowance(name).ok, true)
  }
})
test('only the matching in-progress video caption bypasses contact reply delay', async () => {
  const { storage, item } = fixture()
  storage.update({ contacts: [{ name, profile: { frequency: '60s' } }], videoGreetings: { pending: [{ ...item, status: 'sending', videoSentAt: new Date().toISOString() }], sent: [] } })
  const sender = new DouyinService({ storage, ai: {} })
  sender.lastReplyTime.set(name, Date.now())
  sender.selectConversation = async () => { throw new Error('passed frequency guard') }
  await assert.rejects(sender.sendMessage(name, item.text, { source: 'video_opening_caption', videoOpeningId: 'v' }), /passed frequency guard/)
  await assert.rejects(sender.sendMessage(name, '其他话题', { source: 'video_opening_caption', videoOpeningId: 'v' }), /回复间隔/)
  await assert.rejects(sender.sendMessage(name, item.text, { source: 'manual' }), /回复间隔/)
})
