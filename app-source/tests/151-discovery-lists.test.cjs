const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { LibraryStore } = require('../electron/social-brain/library-store.cjs')
const { LearningStore, viewOfLearning } = require('../electron/social-brain/comment-learning.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { syncIntentPool, clearDiscoveryList, filterIntentPool } = require('../electron/discovery/discovery-lists.cjs')
const { preflight } = require('../electron/discovery/batch-contact.cjs')
const { createMemoryStorage } = require('./setup.cjs')
const B = 'SEEKING_FRIENDS', O = 'ORDINARY'
function fixture(t, intents = [B,'CONTEXTUAL_INTEREST',O,null]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-lists-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const storage = createMemoryStorage({ contacts: [{ id: 'untouched', learning: { messages: ['keep'] } }] }), manager = new CandidateManager(storage)
  const libraryStore = new LibraryStore(dir), learningStore = new LearningStore(dir), video = '7300000000000000001'
  libraryStore.addVideo({ text: video, title: '认识朋友找游戏搭子', classification: { category: 'friend_general' } })
  libraryStore.addComments(intents.map((intent, i) => ({ video_id: video, comment_id: String(i), author_id: 'author-' + i, author_name: '本地' + i, text: '想认识朋友一起玩' + i, ...(intent ? { classification: { intent, confidence: .8 } } : {}) })))
  const context = { manager, libraryStore, learningStore, accountId: 'offline' }
  return { ...context, storage, dir, sync: () => syncIntentPool(context), clear: scope => clearDiscoveryList({ ...context, scope, confirmed: true }) }
}

test('all collected comments become learning samples; only positive identities enter the intent pool', t => {
  const h = fixture(t); const result = h.sync()
  assert.equal(result.added, 2); assert.equal(h.learningStore.read().samples.length, 4)
  assert.equal(h.learningStore.read().samples.filter(s => s.human).length, 0)
  assert.equal(h.manager.get().candidates.length, 2)
  for (const c of h.manager.get().candidates) { assert.equal(c.intentPoolOnly, true); assert.equal(preflight(c).ok, false) }
})

test('refreshing unchanged intent records causes no candidate or library rewrite', t => {
  const h = fixture(t); h.sync(); const before = fs.readFileSync(h.libraryStore.filePath, 'utf8')
  let writes = 0; const save = h.manager.save.bind(h.manager); h.manager.save = data => { writes++; return save(data) }
  h.sync(); assert.equal(writes, 0); assert.equal(fs.readFileSync(h.libraryStore.filePath, 'utf8'), before)
})

test('hard filters apply after pooling and retain pending records for manual recovery', t => {
  const h = fixture(t); h.sync()
  const result = filterIntentPool(h.manager, { gender: 'female', requireAgeRange: true, ageMin: 18, ageMax: 25 })
  assert.equal(result.counts.pending, 2); assert.equal(h.manager.get().candidates.length, 2)
  assert.ok(h.manager.get().candidates.every(c => c.batchScreening.status === 'pending'))
})

test('clear candidates preserves comments and confirmed labels without auto-restoring cleared entries', t => {
  const h = fixture(t); h.sync(); const sample = h.learningStore.read().samples[0]
  h.learningStore.annotate(sample.key, { intent: B, useForTraining: true })
  const result = h.clear('candidates')
  assert.equal(result.removed, 2); assert.ok(fs.existsSync(path.join(result.backupPath, 'lists.json')))
  assert.equal(h.manager.get().candidates.length, 0); assert.equal(h.libraryStore.read().comments.length, 4)
  assert.equal(h.learningStore.read().samples[0].human.intent, B)
  h.sync(); assert.equal(h.manager.get().candidates.length, 0)
  assert.deepEqual(h.storage.get().contacts[0].learning.messages, ['keep'])
})

test('clear comments and training samples preserves candidate source evidence and prevents re-import on refresh', t => {
  const h = fixture(t); h.sync(); const before = h.manager.get().candidates
  const result = h.clear('comments')
  assert.equal(result.removed, 4); assert.equal(result.removedSamples, 4)
  h.sync(); assert.equal(h.learningStore.read().samples.length, 0)
  assert.deepEqual(h.manager.get().candidates, before)
})

test('sent, uncertain and rejected identities retain protection after clear and a new source', t => {
  const h = fixture(t, [B,B,B]); h.sync()
  const records = h.manager.get().candidates
  h.manager.patch(records[0].id, { action: { firstMessageStatus: 'sent' }, review: { realContact: { messageStatus: 'sent' } } })
  h.manager.patch(records[1].id, { action: { needsReview: true }, review: { realContact: { needsReview: true } } })
  h.manager.review(records[2].id, { status: 'REJECTED' })
  h.clear('candidates')
  const library = h.libraryStore.read()
  h.libraryStore.addComments(records.map((c, i) => ({ video_id: library.videos[0].video_id, comment_id: 'new' + i, author_id: c.platformUserId, author_name: c.nickname, text: '新评论想认识朋友', classification: { intent: B } })))
  h.sync(); const after = h.manager.get().candidates
  assert.equal(after.length, 3)
  assert.equal(after.find(c => c.id === records[0].id).action.firstMessageStatus, 'sent')
  assert.equal(after.find(c => c.id === records[1].id).action.needsReview, true)
  assert.equal(after.find(c => c.id === records[2].id).status, 'REJECTED')
})

test('clear requires explicit confirmation and an idle workflow', t => {
  const h = fixture(t); h.sync(); const before = h.manager.get()
  assert.throws(() => clearDiscoveryList({ ...h, scope: 'candidates', confirmed: false }))
  assert.throws(() => clearDiscoveryList({ ...h, scope: 'comments', confirmed: true, busy: true }))
  assert.deepEqual(h.manager.get(), before); assert.equal(h.libraryStore.read().comments.length, 4)
})

test('comment and candidate maintenance remain isolated between accounts', t => {
  const a = fixture(t), b = fixture(t); a.sync(); b.sync(); a.clear('comments'); a.clear('candidates')
  assert.equal(b.manager.get().candidates.length, 2); assert.equal(b.learningStore.read().samples.length, 4)
})

test('learning pagination exposes older samples and preserves manual labels across pages', t => {
  const h = fixture(t, Array.from({ length: 45 }, () => B)); h.sync()
  const data = h.learningStore.read(), pages = [0,20,40].map(offset => viewOfLearning(data, { offset, limit: 20 }))
  assert.deepEqual(pages.map(x => x.page.rows.length), [20,20,5])
  assert.equal(new Set(pages.flatMap(x => x.page.rows.map(row => row.key))).size, 45)
  assert.equal(viewOfLearning(data, { query: '想认识朋友一起玩44', limit: 20 }).page.total, 1)
})
