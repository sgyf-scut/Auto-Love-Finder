const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { navigateReadable, pageReadinessSnapshot, executePageScript } = require('../electron/discovery/page-readiness.cjs')
const { VideoSources, visibleVideoSnapshot, topicAwemeSnapshot } = require('../electron/discovery/video-sources.cjs')
const { openCommentPanel } = require('../electron/discovery/comment-snapshot.cjs')
const { BatchRunner } = require('../electron/discovery/batch-runner.cjs')
const { CandidateManager } = require('../electron/discovery/candidate-manager.cjs')
const { createVideoReader } = require('../electron/discovery/video-rounds.cjs')
const id = '7709519124506501480', url = `https://www.douyin.com/video/${id}`

test('main frame script executes while webContents wrapper waits for subresources', async () => {
  const win = { webContents: { executeJavaScript: () => new Promise(() => {}),
    mainFrame: { executeJavaScript: async () => ({ ready: true }) } } }
  assert.equal((await executePageScript(win, 'read only', 50)).ready, true)
})
test('script execution is bounded if the renderer truly stops responding', async () => {
  const win = { webContents: { mainFrame: { executeJavaScript: () => new Promise(() => {}) } } }
  await assert.rejects(executePageScript(win, 'read only', 5), /读取超时/)
})

test('readable DOM does not wait for a stalled navigation promise', async () => {
  let stopped = false
  const r = await navigateReadable({ loadURL: () => new Promise(() => {}), webContents: { stop() { stopped = true } } }, url,
    { read: async () => ({ ready: true, href: url }), timeout: 50 })
  assert.equal(r.ok, true); assert.equal(stopped, false)
})
test('navigation error still permits a verified readable target', async () => {
  const r = await navigateReadable({ loadURL: async () => { throw Error('ERR_ABORTED') } }, url,
    { read: async () => ({ ready: true, href: url }) })
  assert.equal(r.ok, true)
})
test('unready wrong target times out and stops only its current load', async () => {
  let stopped = 0
  const r = await navigateReadable({ loadURL: async () => {}, webContents: { stop() { stopped++ } } }, url,
    { read: async () => ({ ready: false, matches: false }), timeout: 8, interval: 1 })
  assert.equal(r.code, 'TIMEOUT'); assert.equal(stopped, 1)
})
test('visible verification stops readiness instead of using page content', async () => {
  const r = await navigateReadable({ loadURL: async () => {} }, url, { read: async () => ({ code: 'CHALLENGE', ready: false }) })
  assert.equal(r.ok, false); assert.equal(r.code, 'CHALLENGE')
})
test('destroyed window is reported without navigation retries', async () => {
  const r = await navigateReadable({ loadURL: async () => {}, isDestroyed: () => true }, url)
  assert.equal(r.code, 'WINDOW_CLOSED')
})

function domContext(href = url, over = {}) {
  return { URL, location: { href, origin: new URL(href).origin }, innerHeight: 900,
    getComputedStyle: n => n.style || { visibility: 'visible', display: 'block' },
    document: { title: '正常作品', readyState: 'interactive', body: { innerText: '已显示的正常作品页面及作者介绍'.repeat(8) }, querySelector: () => null, querySelectorAll: () => [], ...over } }
}
function run(fn, arg, context) { return vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context) }
test('interactive target with content is ready without document complete', () => {
  assert.equal(run(pageReadinessSnapshot, { url }, domContext()).ready, true)
})
test('video and note routes are accepted only for the same work ID', () => {
  assert.equal(run(pageReadinessSnapshot, { url }, domContext(url.replace('/video/', '/note/'))).ready, true)
  assert.equal(run(pageReadinessSnapshot, { url }, domContext(url.replace(id, '7709519124506501481'))).ready, false)
})
test('wrong origin cannot supply ready content', () => {
  assert.equal(run(pageReadinessSnapshot, { url }, domContext('https://example.org/video/' + id)).ready, false)
})
test('hidden verification iframe is not treated as a visible challenge', () => {
  const frame = { tagName:'IFRAME', src:'https://rmc.bytedance.com/verifycenter/puzzle', getBoundingClientRect: () => ({ width: 500, height: 400 }), style: { visibility: 'hidden', display: 'block' } }
  const c = domContext(url, { querySelectorAll: () => [frame] })
  assert.equal(run(pageReadinessSnapshot, { url }, c).ready, true)
  frame.style.visibility = 'visible'
  assert.equal(run(pageReadinessSnapshot, { url }, c).code, 'CHALLENGE')
})

test('visible cards are deduplicated and limited to requested page and platform origin', () => {
  const href = 'https://www.douyin.com/hashtag/12345678'
  const a = link => ({ href: link, innerText: '真实可见标题', getAttribute: () => null, querySelector: () => null,
    getBoundingClientRect: () => ({ width: 200, height: 120, top: 0, bottom: 120 }) })
  const c = domContext(href, { querySelectorAll: selector => selector.startsWith('a[') ? [a(url), a(url), a('https://example.org/video/' + id)] : [] })
  const r = run(visibleVideoSnapshot, { url: href }, c)
  assert.equal(r.items.length, 1); assert.equal(r.items[0].videoId, id)
  assert.equal(run(visibleVideoSnapshot, { url: href + '/different' }, c).kind, 'WRONG_PAGE')
})
test('exact Comments tab is supported when legacy selectors are absent', () => {
  const tab = { innerText: '评论(13)', children: [], getBoundingClientRect: () => ({ width: 100, height: 40, left: 700, top: 400 }) }
  const c = domContext(url, { querySelectorAll: selector => selector === '[role="tab"], button, span, div' ? [tab] : [] })
  const r = run(openCommentPanel, id, c)
  assert.equal(r.opened, true); assert.equal(r.point.x, 750); assert.equal(r.point.y, 420)
})
test('ambiguous Comments tabs are never clicked', () => {
  const tab = { innerText: '评论(13)', children: [], getBoundingClientRect: () => ({ width: 100, height: 40 }) }
  const c = domContext(url, { querySelectorAll: selector => selector === '[role="tab"], button, span, div' ? [tab, tab] : [] })
  assert.equal(run(openCommentPanel, id, c).opened, false)
})

test('visible cards avoid the failing interface entirely', async () => {
  let calls = 0
  const win = { webContents: { executeJavaScript: async () => ({ ready: true }) } }
  const sources = new VideoSources({ ensureWindow: () => win })
  sources.evalInPage = async fn => { calls++; assert.equal(fn, visibleVideoSnapshot); return { ok: true, items: [{ videoId: id }], hasMore: 0 } }
  const r = await sources.requestVideos(topicAwemeSnapshot, {}, url)
  assert.equal(r.fallback, 'visible_page'); assert.equal(calls, 1)
})
test('API timeout falls back to newly visible cards and retains original diagnosis', async () => {
  let cards = 0
  const win = { webContents: { executeJavaScript: async () => ({ ready: true }) } }
  const sources = new VideoSources({ ensureWindow: () => win })
  sources.evalInPage = async fn => fn === visibleVideoSnapshot
    ? (++cards === 1 ? { ok: false, items: [] } : { ok: true, items: [{ videoId: id }], hasMore: 0 })
    : { ok: false, kind: 'TIMEOUT', error: 'request aborted' }
  const r = await sources.requestVideos(topicAwemeSnapshot, {}, url)
  assert.equal(r.ok, true); assert.equal(r.originalKind, 'TIMEOUT')
})
test('visible verification prevents any interface or fallback call', async () => {
  const sources = new VideoSources({ ensureWindow: () => ({ webContents: { executeJavaScript: async () => ({ code: 'CHALLENGE' }) } }) })
  sources.evalInPage = () => { throw Error('must not call') }
  assert.equal((await sources.requestVideos(topicAwemeSnapshot, {}, url)).kind, 'CHALLENGE')
})
test('response body is covered by the request timeout', async () => {
  const r = await vm.runInNewContext(`(${topicAwemeSnapshot.toString()})({chId:'123',timeout:5})`, {
    AbortController, setTimeout, clearTimeout, Date, encodeURIComponent,
    fetch: async (_, options) => ({ status: 200, text: () => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(Error('body stalled'), { name: 'AbortError' })))
    }) }),
  })
  assert.equal(r.kind, 'TIMEOUT')
})

function harness(result, extra = {}) {
  const { deps, ...state } = extra
  const storage = createMemoryStorage(state), manager = new CandidateManager(storage)
  const runner = new BatchRunner({ storage, manager, libraryStore: { read: () => ({ comments: [], videos: [] }) },
    sourcesFactory: () => ({ collectByTag: async () => result }), ...deps })
  return { runner, storage }
}
test('source timeout is FAILED rather than normal empty candidates', async () => {
  const { runner } = harness({ ok: false, kind: 'TIMEOUT', videos: [], events: [{ error: 'aborted' }] })
  const { batch } = await runner.start({ sources: { tags: ['交友'] } })
  assert.equal(batch.status, 'failed'); assert.equal(batch.stopCode, 'SOURCE_FAILED')
})
test('genuine empty source retains normal queue exhaustion', async () => {
  const { runner } = harness({ ok: true, kind: 'EMPTY', videos: [], events: [] })
  const { batch } = await runner.start({ sources: { tags: ['交友'] } })
  assert.equal(batch.status, 'done'); assert.equal(batch.stopCode, 'QUEUE_EXHAUSTED')
})
test('new batches clear stale average and last diagnosis under deep merge', async () => {
  const { runner } = harness({ ok: true, kind: 'EMPTY', videos: [], events: [] },
    { discovery: { batch: { perf: { avgVideoMs: 2683 }, diagnostics: { lastLabel: '旧错误' } } } })
  const { batch } = await runner.start({ sources: { tags: ['交友'] } })
  assert.equal(batch.perf.avgVideoMs, 0); assert.equal(batch.diagnostics.lastLabel, '')
})
test('comment exception retains raw detail and fails the collection batch', async () => {
  const { runner } = harness({ ok: true, kind: 'OK', videos: [{ videoId: id, videoUrl: url }], events: [] },
    { deps: { enableVideoRounds: true, collectorFactory: () => { throw Error('raw renderer exception') } } })
  const { batch } = await runner.start({ sources: { tags: ['交友'] } })
  assert.equal(batch.status, 'failed'); assert.equal(batch.stopCode, 'COLLECTION_FAILED')
  assert.equal(batch.queue[0].error, 'raw renderer exception')
})

test('a stalled video reader cancels its owned transport at the per-video limit', async () => {
  let cancelled = 0
  const read = createVideoReader({ transport: { prepare: () => new Promise(() => {}), cancel: () => cancelled++ } },
    { read: () => ({ comments: [] }) }, { videoId: id, videoUrl: url }, { timeoutMs: 5 })
  const r = await read({ limit: 5, alive: () => true })
  assert.equal(r.code, 'TIMEOUT'); assert.equal(cancelled, 1)
})
test('one failed video is skipped and the next video is processed', async () => {
  const visited = []
  const ids = [id, '7709519124506501481']
  const library = { read: () => ({ comments: [], videos: [] }), addVideo() {}, addComments: () => ({ added: 0 }) }
  const { runner } = harness({ ok: true, kind: 'OK', videos: ids.map(videoId => ({ videoId, videoUrl: url.replace(id, videoId) })), events: [] },
    { deps: { enableVideoRounds: true, libraryStore: library, collectorFactory: () => ({
      transport: { prepare: async ({ videoId }) => { visited.push(videoId); return videoId === id ? { ok: false, code: 'TIMEOUT', reason: 'first failed' } : { ok: true, videoId } } },
      readPageWithRetry: async () => ({ ok: true, rows: [], empty: true }),
    }) } })
  const { batch } = await runner.start({ sources: { tags: ['交友'] } })
  assert.deepEqual(visited, ids); assert.equal(batch.queue[0].status, 'failed'); assert.equal(batch.queue[1].code, 'COMMENTS_EXHAUSTED')
})
test('three consecutive read failures stop the batch before a fourth video', async () => {
  let visited = 0
  const { runner } = harness({ ok: true, kind: 'OK', videos: [1, 2, 3, 4].map(n => ({ videoId: String(BigInt(id) + BigInt(n)), videoUrl: url })), events: [] },
    { deps: { enableVideoRounds: true, collectorFactory: () => ({ transport: { prepare: async () => { visited++; return { ok: false, code: 'NETWORK_ERROR', reason: 'fixture error' } } } }) } })
  const { batch } = await runner.start({ sources: { tags: ['交友'] } })
  assert.equal(visited, 3); assert.equal(batch.stopCode, 'CONSECUTIVE_FAILURES'); assert.equal(batch.status, 'paused')
})
test('retry activation clicks only the exact Comments tab', () => {
  let clicks = 0
  const tab = { innerText: '评论(13)', children: [], click: () => clicks++, getBoundingClientRect: () => ({ width: 100, height: 40 }) }
  const c = domContext(url, { querySelectorAll: selector => selector === '[role="tab"], button, span, div' ? [tab] : [] })
  const r = vm.runInNewContext(`(${openCommentPanel.toString()})('${id}',{activate:true})`, c)
  assert.equal(r.activated, true); assert.equal(clicks, 1)
})

test('automatic read pause preserves the fourth pending video and resumes without restarting earlier videos', async () => {
  let visited = 0, finished = 0
  const ids = [1, 2, 3, 4].map(n => String(BigInt(id) + BigInt(n)))
  const library = { read: () => ({ comments: [], videos: [] }), addVideo() {}, addComments: () => ({ added: 0 }) }
  const { runner } = harness({ ok: true, kind: 'OK', videos: ids.map(videoId => ({ videoId, videoUrl: url })), events: [] },
    { deps: { enableVideoRounds: true, libraryStore: library, onBatchDone: () => { finished++ }, collectorFactory: () => ({
      transport: { prepare: async ({ videoId }) => { visited++; return visited <= 3 ? { ok: false, code: 'TIMEOUT' } : { ok: true, videoId } } },
      readPageWithRetry: async () => ({ ok: true, rows: [], empty: true }),
    }) } })
  const first = await runner.start({ sources: { tags: ['交友'] } })
  assert.equal(first.batch.status, 'paused'); assert.equal(first.batch.queue[3].status, 'pending'); assert.equal(finished, 0)
  const resumed = await runner.resume()
  assert.equal(visited, 4); assert.equal(resumed.batch.status, 'done'); assert.equal(resumed.batch.queue[3].code, 'COMMENTS_EXHAUSTED')
  assert.equal(resumed.batch.id, first.batch.id)
})

for (const code of ['READ_CANCELLED', 'READ_TARGET_MISMATCH']) test(`${code} pauses before another video instead of declaring the target deleted`, async () => {
  const { runner } = harness({ ok: true, kind: 'OK', videos: [{ videoId: id, videoUrl: url }, { videoId: String(BigInt(id)+1n), videoUrl: url }], events: [] },
    { deps: { enableVideoRounds: true, collectorFactory: () => ({ transport: { prepare: async () => ({ ok: false, code, reason: 'fixture ownership mismatch' }) } }) } })
  const { batch } = await runner.start({ sources: { tags: ['交友'] } })
  assert.equal(batch.status, 'paused'); assert.equal(batch.stopCode, code); assert.equal(batch.queue[1].status, 'pending'); assert.equal(batch.queue[0].code, code)
})
