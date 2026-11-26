const test = require('node:test')
const assert = require('node:assert/strict')
const { ConversationBuffer, STATES, DEFAULT_QUIET_WINDOW_MS, DEFAULT_MAX_BURST_WINDOW_MS } = require('../electron/social-brain/conversation-buffer.cjs')

function fakeClock() {
  let now = 0, sequence = 0
  const jobs = new Map()
  return {
    now: () => now,
    setTimer(fn, delay) { const id = ++sequence; jobs.set(id, { fn, at: now + delay }); return id },
    clearTimer(id) { jobs.delete(id) },
    tick(ms) {
      const end = now + ms
      while (true) {
        const next = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        now = next[1].at; jobs.delete(next[0]); next[1].fn()
      }
      now = end
    },
    pending: () => jobs.size
  }
}

function fixture(options = {}) {
  const clock = fakeClock(), ready = [], stale = []
  const buffer = new ConversationBuffer({ clock: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onReady: snapshot => ready.push(snapshot), onStale: (lease, snapshot) => stale.push({ lease, snapshot }), ...options })
  return { clock, buffer, ready, stale }
}
const msg = (id, text = id, extra = {}) => ({ messageId: id, text, content: text, type: 'text', role: 'them', sender: 'contact', ...extra })
function begin(f, contact = 'A') { f.buffer.append(contact, msg('1')); f.clock.tick(4000); return f.buffer.startGeneration(contact) }

test('defaults are 4 seconds quiet and 15 seconds maximum', () => {
  assert.equal(DEFAULT_QUIET_WINDOW_MS, 4000); assert.equal(DEFAULT_MAX_BURST_WINDOW_MS, 15000)
  assert.deepEqual(STATES, ['IDLE', 'COLLECTING', 'PLANNING', 'WRITING', 'READY_TO_SEND', 'SENDING', 'STALE'])
})

test('one incoming message becomes ready exactly after quiet window', () => {
  const f = fixture(); f.buffer.append('A', msg('1')); f.clock.tick(3999)
  assert.equal(f.ready.length, 0); assert.equal(f.buffer.startGeneration('A'), null)
  f.clock.tick(1); assert.equal(f.ready.length, 1); assert.equal(f.ready[0].readyReason, 'quiet_window')
  assert.equal(f.ready[0].firstMessageAt, 0); assert.equal(f.ready[0].lastMessageAt, 0)
})

test('second message after 2 seconds resets quiet deadline', () => {
  const f = fixture(); f.buffer.append('A', msg('1')); f.clock.tick(2000); f.buffer.append('A', msg('2'))
  f.clock.tick(3999); assert.equal(f.ready.length, 0); f.clock.tick(1)
  assert.equal(f.ready[0].readyAt, 6000); assert.deepEqual(f.ready[0].messages.map(m => m.messageId), ['1', '2'])
})

test('three consecutive messages form one ordered immutable generation burst', () => {
  const f = fixture(); f.buffer.append('A', msg('1', '今天答辩')); f.clock.tick(2000)
  f.buffer.append('A', msg('2', '老师喷惨了')); f.clock.tick(3000); f.buffer.append('A', msg('3', '补三组实验'))
  f.clock.tick(4000); const lease = f.buffer.startGeneration('A')
  assert.equal(f.ready.length, 1); assert.deepEqual(lease.messages.map(m => m.text), ['今天答辩', '老师喷惨了', '补三组实验'])
  assert.ok(Object.isFrozen(lease.messages)); assert.ok(Object.isFrozen(lease.messages[0])); assert.equal(lease.generationRevision, 3)
})

test('continuous incoming messages reach maximum window at 15 seconds', () => {
  const f = fixture(); f.buffer.append('A', msg('0'))
  for (let i = 1; i <= 4; i++) { f.clock.tick(3000); f.buffer.append('A', msg(String(i))) }
  f.clock.tick(2999); assert.equal(f.ready.length, 0); f.clock.tick(1)
  assert.equal(f.ready[0].readyAt, 15000); assert.equal(f.ready[0].readyReason, 'max_window'); assert.equal(f.ready[0].messages.length, 5)
})

for (const stage of ['PLANNING', 'WRITING', 'READY_TO_SEND', 'SENDING']) test(`new input invalidates an old ${stage} lease and preserves unanswered input`, () => {
  const f = fixture(), lease = begin(f)
  assert.equal(f.buffer.setStage(lease, stage), true); f.clock.tick(1000); f.buffer.append('A', msg('2'))
  assert.equal(f.buffer.isFresh(lease), false); assert.equal(f.buffer.setStage(lease, 'SENDING'), false); assert.equal(f.buffer.finish(lease), false)
  assert.equal(f.stale.length, 1); assert.equal(f.stale[0].snapshot.status, 'STALE')
  assert.equal(f.buffer.snapshot('A').status, 'COLLECTING'); assert.deepEqual(f.buffer.snapshot('A').messages.map(m => m.messageId), ['1', '2'])
  f.clock.tick(4000); const fresh = f.buffer.startGeneration('A'); assert.equal(fresh.generationRevision, 2); assert.notEqual(fresh.burstId, lease.burstId)
})

test('draft ready lease can be identified as outdated after more messages', () => {
  const f = fixture(), draft = begin(f); f.buffer.setStage(draft, 'READY_TO_SEND')
  f.buffer.append('A', msg('2')); f.buffer.append('A', msg('3'))
  assert.equal(f.buffer.isFresh(draft), false); assert.equal(f.buffer.snapshot('A').revision - draft.generationRevision, 2)
  assert.equal(f.stale.length, 1)
})

test('contacts collect independently and starting one cannot affect another', () => {
  const f = fixture(); f.buffer.append('A', msg('1')); f.clock.tick(1000); f.buffer.append('B', msg('1'))
  f.clock.tick(1000); f.buffer.append('A', msg('2')); f.clock.tick(3000)
  assert.deepEqual(f.ready.map(s => s.contactId), ['B']); assert.ok(f.buffer.startGeneration('B')); assert.equal(f.buffer.startGeneration('A'), null)
  f.clock.tick(1000); assert.deepEqual(f.ready.map(s => s.contactId), ['B', 'A'])
})

test('text, image, sticker, gif and quote preserve source ordering and references', () => {
  const f = fixture()
  const items = [msg('1'), msg('2', '', { type: 'image', media: { imageUrl: 'https://example.test/picture.png' } }),
    msg('3', '', { type: 'sticker', media: { stickerId: 's1' } }), msg('4', '', { type: 'gif', media: { url: 'https://example.test/a.gif' } }),
    msg('5', '这句', { type: 'quoted', timestamp: '2026-10-12T10:00:00+08:00', quote: { messageId: 'old', text: '原话', sender: 'owner' } })]
  items.forEach(m => f.buffer.append('A', m)); f.clock.tick(4000)
  const lease = f.buffer.startGeneration('A'); assert.deepEqual(lease.messages.map(m => m.type), ['text', 'image', 'sticker', 'gif', 'quoted'])
  assert.deepEqual(lease.messages[4].quote, items[4].quote); assert.equal(lease.messages[4].timestamp, items[4].timestamp)
})

test('haha / acknowledgement / sleeping trigger only one ready callback', () => {
  const f = fixture(); ['哈哈', '确实', '睡了'].forEach((text, i) => { f.buffer.append('A', msg(String(i), text)); f.clock.tick(1000) })
  f.clock.tick(3000); assert.equal(f.ready.length, 1); assert.equal(f.buffer.startGeneration('A').messages.length, 3)
})

test('NO_REPLY consumption has no sending effect and does not generate again', () => {
  const f = fixture(), lease = begin(f)
  assert.equal(f.buffer.finish(lease), true); f.clock.tick(30000)
  assert.equal(f.ready.length, 1); assert.equal(f.buffer.startGeneration('A'), null); assert.equal(f.buffer.snapshot('A').status, 'IDLE')
})

test('account namespaces and separate services never accept each other leases', () => {
  const a = fixture({ namespace: 'accountA' }), b = fixture({ namespace: 'accountB' })
  const leaseA = begin(a), leaseB = begin(b)
  assert.notEqual(leaseA.burstId, leaseB.burstId); assert.equal(a.buffer.isFresh(leaseB), false); assert.equal(b.buffer.isFresh(leaseA), false)
  a.buffer.append('A', msg('2')); assert.equal(b.buffer.isFresh(leaseB), true)
})

test('explicit event followup cannot enter an incoming buffer', () => {
  const f = fixture(); assert.throws(() => f.buffer.append('A', msg('event', '', { type: 'event_followup' })), /Event follow-ups/)
  assert.equal(f.clock.pending(), 0); assert.equal(f.buffer.snapshot('A').revision, 0)
})

test('duplicate ID does not increase revision or reset quiet timer', () => {
  const f = fixture(); f.buffer.append('A', msg('1')); f.clock.tick(2000); f.buffer.append('A', msg('1', 'changed preview'))
  assert.equal(f.buffer.snapshot('A').revision, 1); f.clock.tick(2000); assert.equal(f.ready.length, 1)
  assert.equal(f.ready[0].messages[0].text, '1')
})

test('same text with different IDs is two messages and increments revision', () => {
  const f = fixture(); f.buffer.append('A', msg('1', '哈哈')); f.clock.tick(2000); f.buffer.append('A', msg('2', '哈哈')); f.clock.tick(2000)
  assert.equal(f.ready.length, 0); f.clock.tick(2000); assert.equal(f.ready[0].revision, 2); assert.equal(f.ready[0].messages.length, 2)
})

test('already consumed message IDs remain deduplicated', () => {
  const f = fixture(), lease = begin(f); f.buffer.finish(lease); f.buffer.append('A', msg('1'))
  assert.equal(f.buffer.snapshot('A').messages.length, 0); assert.equal(f.clock.pending(), 0)
  f.buffer.append('A', msg('2')); assert.equal(f.buffer.snapshot('A').revision, 2)
})

test('generation cannot start twice for same revision', () => {
  const f = fixture(), lease = begin(f); assert.equal(f.buffer.startGeneration('A'), null)
  assert.equal(f.buffer.isFresh(lease), true); f.clock.tick(30000); assert.equal(f.ready.length, 1)
})

test('new message following maximum ready creates a fresh waiting window', () => {
  const f = fixture(); f.buffer.append('A', msg('0'))
  for (let i = 1; i <= 4; i++) { f.clock.tick(3000); f.buffer.append('A', msg(String(i))) }
  f.clock.tick(3000); const old = f.buffer.startGeneration('A'); f.clock.tick(1000); f.buffer.append('A', msg('5'))
  f.clock.tick(3999); assert.equal(f.ready.length, 1); f.clock.tick(1); assert.equal(f.ready.length, 2)
  assert.equal(f.buffer.isFresh(old), false); assert.equal(f.buffer.startGeneration('A').messages.length, 6)
})

test('new message after readiness but before generation resets ready state', () => {
  const f = fixture(); f.buffer.append('A', msg('1')); f.clock.tick(4000); f.buffer.append('A', msg('2'))
  assert.equal(f.buffer.startGeneration('A'), null); f.clock.tick(4000); assert.equal(f.buffer.startGeneration('A').messages.length, 2)
})

test('pause clears all timers, expires leases and retains pending messages', () => {
  const f = fixture(), lease = begin(f); f.buffer.append('B', msg('b1')); f.buffer.pause()
  assert.equal(f.clock.pending(), 0); assert.equal(f.buffer.isFresh(lease), false); f.clock.tick(30000)
  assert.equal(f.ready.length, 1); assert.equal(f.buffer.snapshot('A').messages.length, 1); assert.equal(f.buffer.snapshot('B').messages.length, 1)
  f.buffer.append('A', msg('2')); assert.equal(f.clock.pending(), 0); assert.equal(f.buffer.startGeneration('A'), null)
})

test('resume reconstructs inputs without reviving old generation', () => {
  const f = fixture(), lease = begin(f); f.buffer.pause(); f.clock.tick(10000); f.buffer.resume()
  f.clock.tick(3999); assert.equal(f.ready.length, 1); f.clock.tick(1); const current = f.buffer.startGeneration('A')
  assert.equal(f.buffer.isFresh(lease), false); assert.equal(f.buffer.isFresh(current), true); assert.notEqual(current.leaseId, lease.leaseId)
  assert.equal(current.messages[0].messageId, '1')
})

test('invalidate retains all input and prevents stale finish of same revision', () => {
  const f = fixture(), old = begin(f); f.buffer.invalidate('A'); assert.equal(f.buffer.finish(old), false)
  f.clock.tick(4000); const current = f.buffer.startGeneration('A'); assert.equal(old.generationRevision, current.generationRevision)
  assert.equal(f.buffer.isFresh(old), false); assert.equal(f.buffer.finish(current), true)
})

test('dispose clears timers and cannot be resumed or appended', () => {
  const f = fixture(), lease = begin(f); f.buffer.append('B', msg('b1')); f.buffer.dispose(); f.buffer.dispose()
  assert.equal(f.clock.pending(), 0); assert.equal(f.buffer.isFresh(lease), false); f.clock.tick(30000); assert.equal(f.ready.length, 1)
  assert.throws(() => f.buffer.resume(), /disposed/); assert.throws(() => f.buffer.append('A', msg('2')), /disposed/)
})

test('hydrate ignores processed IDs and never restores stale generation lease', () => {
  const f = fixture(); f.buffer.hydrate('A', { conversationRevision: 17, processedMessageIds: ['1'], messages: [msg('1'), msg('2'), msg('2'), msg('3')] })
  assert.deepEqual(f.buffer.snapshot('A').messages.map(m => m.messageId), ['2', '3']); assert.equal(f.buffer.snapshot('A').revision, 19)
  assert.equal(f.buffer.startGeneration('A'), null); f.clock.tick(4000); assert.equal(f.buffer.startGeneration('A').generationRevision, 19)
})

test('hydrate rejects replacement of a live buffer', () => {
  const f = fixture(); f.buffer.append('A', msg('1')); assert.throws(() => f.buffer.hydrate('A', { messages: [] }), /live contact/)
})

test('large image payloads and byte arrays are stripped while metadata survives', () => {
  const f = fixture(); const original = msg('1', '看这个', { type: 'image', media: { frames: [{ frameIndex: 0, mimeType: 'image/png',
    imageUrl: 'data:image/png;base64,AAAA', base64: 'AAAA', bytes: Buffer.from('secret'), description: '一只猫' }], url: 'https://example.test/cat' } })
  f.buffer.append('A', original); const saved = f.buffer.snapshot('A').messages[0]
  assert.deepEqual(saved.media.frames[0], { frameIndex: 0, mimeType: 'image/png', description: '一只猫' }); assert.equal(saved.media.url, original.media.url)
})

test('snapshot mutation and original mutation cannot alter buffered input', () => {
  const f = fixture(), original = msg('1', 'original', { media: { title: 'original' } }); f.buffer.append('A', original)
  original.media.title = 'changed'; const copy = f.buffer.snapshot('A'); copy.messages[0].text = 'changed'; copy.messages[0].media.title = 'changed'
  assert.equal(f.buffer.snapshot('A').messages[0].text, 'original'); assert.equal(f.buffer.snapshot('A').messages[0].media.title, 'original')
})

test('more than 100 incoming messages are not dropped in snapshots or leases', () => {
  const f = fixture(); for (let i = 0; i < 125; i++) f.buffer.append('A', msg(String(i)))
  f.clock.tick(4000); assert.equal(f.ready[0].messages.length, 125); assert.equal(f.buffer.startGeneration('A').messages.length, 125)
})

test('invalid inputs and generation states surface errors', () => {
  const f = fixture(); assert.throws(() => f.buffer.append('', msg('1')), /contactId/)
  assert.throws(() => f.buffer.append('A', {}), /messageId/); assert.throws(() => f.buffer.append('A', null), /object/)
  assert.throws(() => new ConversationBuffer({ quietWindowMs: -1 }), /duration/); assert.throws(() => new ConversationBuffer({ maxBurstWindowMs: NaN }), /duration/)
  assert.throws(() => f.buffer.setStage(null, 'INVALID'), /Invalid generation stage/)
})

test('configured zero quiet delay and object clock are supported', () => {
  const clock = fakeClock(), ready = [], buffer = new ConversationBuffer({ clock: { now: clock.now }, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    quietWindowMs: 0, maxBurstWindowMs: 100, onReady: s => ready.push(s) })
  buffer.append(0, msg(0)); clock.tick(0); assert.equal(ready.length, 1); assert.equal(ready[0].contactId, '0'); assert.equal(ready[0].messages[0].messageId, '0')
})

test('cleared callbacks cannot notify after invalidation with same revision', () => {
  const captured = [], ready = []
  const buffer = new ConversationBuffer({ clock: () => 0, setTimer: fn => { captured.push(fn); return captured.length }, clearTimer: () => {}, onReady: s => ready.push(s) })
  buffer.append('A', msg('1')); buffer.invalidate('A'); captured[0](); assert.equal(ready.length, 0)
  captured[1](); assert.equal(ready.length, 1)
})
