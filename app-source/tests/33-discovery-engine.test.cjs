const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { DiscoveryEngine } = require('../electron/discovery/discovery-engine.cjs')
const { FriendshipService } = require('../electron/friendship.cjs')
const { commentAuthorSnapshot, publicProfileSnapshot, scoreCommentCandidate, summarizePublicProfile } = require('../electron/discovery/comment-snapshot.cjs')
const videoId = '1234567890123456789'
const profileUrl = 'https://www.douyin.com/user/sec-first'
const visible = { getBoundingClientRect: () => ({ width: 100, height: 40 }) }
function commentDom({ href = profileUrl, secUid = 'sec-first', text = '研二，想认识一起打球的朋友', nickname = '评论作者', duplicateLinks = false, nestedText = false, challenge = false, props = true } = {}) {
  const row = { ...visible }
  const anchor = { href, innerText: nickname, closest: () => row }
  const other = { href: 'https://www.douyin.com/user/sec-other', innerText: '另一个人', closest: () => row }
  const textNode = { innerText: text, closest: () => nestedText ? {} : row }
  const info = { querySelectorAll: () => duplicateLinks ? [anchor, other] : [anchor] }
  row.querySelector = selector => selector.includes('comment-item-info') ? info : selector.includes('tooltip') ? { id: 'tooltip_987654321' } : selector.includes('comment-content') ? textNode : null
  if (props) row.__reactPropsTest = { commentInfo: { cid: '987654321', text, user: { secUid, nickname, uid: '777777777' } } }
  const document = { title: '', body: { innerText: '' }, querySelector: () => null, querySelectorAll: selector => selector.includes('captcha') ? challenge ? [{tagName:'IFRAME',src:'https://rmc.bytedance.com/verifycenter/puzzle',getBoundingClientRect:()=>({width:300,height:200})}] : [] : [row] }
  const context = vm.createContext({ document, URL, location: new URL(`https://www.douyin.com/video/${videoId}`) })
  const read = limit => vm.runInContext(`(${commentAuthorSnapshot.toString()})('${videoId}',${limit || 20})`, context)
  return { context, read, row, anchor, textNode }
}
test('rendered comment links and matching row props establish secUid and comment provenance', () => {
  const snapshot = commentDom().read()
  assert.equal(snapshot.ready, true)
  assert.equal(snapshot.candidates.length, 1)
  assert.equal(snapshot.candidates[0].profileUrl, profileUrl)
  assert.equal(snapshot.candidates[0].platformUserId, 'sec-first')
  assert.equal(snapshot.candidates[0].platformNumericUserId, '777777777')
  assert.equal(snapshot.candidates[0].commentId, '987654321')
  assert.match(snapshot.candidates[0].commentText, /研二/)
})
test('author link and row secUid mismatch are discarded instead of guessing identity', () => {
  const value = commentDom({ secUid: 'sec-wrong' }).read()
  assert.equal(value.candidates.length, 0)
  assert.equal(value.skipped, 1)
})

test('rendered reply author keeps its own verified identity and parent comment without becoming the parent author', () => {
  const dom = commentDom({ secUid: 'sec-first', nickname: '回复作者' })
  Object.assign(dom.row.__reactPropsTest.commentInfo, { replyId: 'parent-comment-123', replyTotal: 0, replyToUserId: 'different-parent-user' })
  const result = dom.read().candidates[0]
  assert.equal(result.isReply, true); assert.equal(result.parentCommentId, 'parent-comment-123'); assert.equal(result.replyCount, 0)
  assert.equal(result.platformUserId, 'sec-first'); assert.equal(result.nickname, '回复作者')
})
test('DOM-only known author and comment are usable if React properties disappear', () => {
  const value = commentDom({ props: false }).read()
  assert.equal(value.candidates.length, 1)
  assert.equal(value.candidates[0].platformNumericUserId, '')
})
test('ambiguous authors, nested reply text and unsafe profile URLs never yield contactable candidates', () => {
  for (const opts of [{ duplicateLinks: true }, { nestedText: true }, { href: 'https://evil.com/user/sec-first' }, { href: 'https://www.douyin.com/user/self' }, { href: 'https://x@www.douyin.com/user/sec-first' }, { href: 'http://www.douyin.com/user/sec-first' }]) assert.equal(commentDom(opts).read().candidates.length, 0)
})
test('redirecting to another video or security challenge prevents all comment extraction', () => {
  const dom = commentDom()
  dom.context.location = new URL('https://www.douyin.com/video/9876543210123456789')
  assert.equal(dom.read().wrongPage, true)
  assert.equal(commentDom({ challenge: true }).read().challenge, true)
})
test('comment read limits bound processed records without clicking or scrolling', () => {
  const dom = commentDom()
  dom.context.document.querySelectorAll = selector => selector.includes('captcha') ? [] : Array.from({ length: 70 }, (_, i) => {
    const r = { ...visible, __reactPropsTest: { commentInfo: { cid: String(i + 1), text: `评论${i}`, user: { secUid: `sec-${i}`, nickname: `昵称${i}` } } } }
    const a = { href: `https://www.douyin.com/user/sec-${i}`, closest: () => r }
    r.querySelector = s => s.includes('comment-item-info') ? { querySelectorAll: () => [a] } : null
    return r
  })
  assert.equal(dom.read(3).candidates.length, 3)
  assert.equal(dom.read(1000).candidates.length, 30)
})
test('profile text preserves evidence, does not infer demographics from names or IP location', () => {
  const summary = summarizePublicProfile({ rawText: '小仙女02\nIP属地：浙江\n研二\n摄影旅行' })
  assert.equal(summary.ageText, null)
  assert.equal(summary.genderText, null)
  assert.equal(summary.city, null)
  assert.equal(summary.ipLocation, '浙江')
  assert.equal(summary.education, '研二')
  assert.equal(summary.evidence[0].source, 'public_profile_text')
  assert.equal(summarizePublicProfile({ rawText: 'IP属地：江西\n19岁\n江西·上饶' }).ageText, '19岁')
})
test('public profile snapshot reads visible DOM rather than hidden React age/gender fields', () => {
  const header = { ...visible, innerText: '公开昵称', parentElement: { innerText: '公开昵称\nIP属地：浙江' }, querySelector: () => ({ innerText: '公开昵称' }), __reactPropsTest: { userInfo: { secUid: 'sec-first', age: 25, gender: 2, school: '未公开学校' } } }
  const result = vm.runInNewContext(`(${publicProfileSnapshot.toString()})('${profileUrl}')`, { location: new URL(profileUrl), document: { body: { innerText: '' }, querySelectorAll: () => [], querySelector: () => header } })
  assert.equal(result.ready, true)
  assert.equal(result.platformUserId, 'sec-first')
  assert.equal(result.rawText.includes('未公开学校'), false)
  assert.equal('age' in result, false)
})
test('profile snapshot reads a bare standalone 男/女 line when douyin renders no label or prefix', () => {
  // 2026-11 线上实测：主页把性别渲染成独立一行“女”，没有 aria-label，也没有“性别：”前缀
  const rawText = '森么东东\n关注\n172\n粉丝\n181\n获赞\n450\n\n抖音号：30515366208\nIP属地：江苏\n女\n\n心肝：@某人\n分享主页\n私信\n关注'
  const header = { ...visible, __reactPropsTest: { userInfo: { secUid: 'sec-first' } }, innerText: '森么东东', parentElement: { innerText: rawText }, querySelector: () => ({ innerText: '森么东东' }) }
  const result = vm.runInNewContext(`(${publicProfileSnapshot.toString()})('${profileUrl}')`, { location: new URL(profileUrl), document: { body: { innerText: '' }, querySelectorAll: () => [], querySelector: () => header } })
  assert.equal(result.ready, true)
  assert.equal(result.genderText, '女')
})
test('conflicting bare gender lines are not trusted instead of picking one', () => {
  const rawText = '昵称\nIP属地：江苏\n男\n\n女\n私信'
  const header = { ...visible, __reactPropsTest: { userInfo: { secUid: 'sec-first' } }, innerText: '昵称', parentElement: { innerText: rawText }, querySelector: () => ({ innerText: '昵称' }) }
  const result = vm.runInNewContext(`(${publicProfileSnapshot.toString()})('${profileUrl}')`, { location: new URL(profileUrl), document: { body: { innerText: '' }, querySelectorAll: () => [], querySelector: () => header } })
  assert.equal(result.ready, true)
  assert.equal('genderText' in result, false)
})
test('review priority depends only on supplied comment content and never approves a person', () => {
  assert.ok(scoreCommentCandidate('研二想交朋友').score > scoreCommentCandidate('哈哈哈哈').score)
  assert.equal('approved' in scoreCommentCandidate('02女生想找对象'), false)
  assert.equal('gender' in scoreCommentCandidate('02女生想找对象'), false)
})
function harness(initial = {}) {
  const storage = createMemoryStorage(initial), calls = [], events = []
  const douyin = { storage, log: (...v) => calls.push(['log', ...v]), emitEvent: (...v) => events.push(v), partition: 'test',
    follow() { throw new Error('discovery must not follow') }, sendMessage() { throw new Error('discovery must not message') } }
  const engine = new DiscoveryEngine(douyin, { accountId: 'a' }), win = { show() {}, focus() {}, webContents: { stop() {}, executeJavaScript: async () => ({}) } }
  engine.ensureWindow = () => win
  engine.navigate = async (_, url) => calls.push(['navigate', url])
  engine.searchTopicVideos = async (_, keyword) => { calls.push(['search', keyword]); return { candidates: Array.from({ length: 8 }, (_, i) => ({ url: `https://www.douyin.com/video/${videoId.slice(0, -1)}${i}`, title: '交友主题' })) } }
  engine.readVideoComments = async (_, video, limit) => { calls.push(['read', video.url, limit]); return { candidates: [{ nickname: '评论作者', profileUrl, platformUserId: 'sec-first', commentText: '研究生想交朋友', commentId: '987654321' }], skipped: 0 } }
  return { engine, storage, calls, events, win, douyin }
}
test('manual finite discovery upserts real author records and merges cross-video sources', async () => {
  const h = harness(), result = await h.engine.start()
  assert.equal(result.ok, true)
  assert.equal(h.calls.filter(c => c[0] === 'read').length, 3)
  assert.equal(result.discovery.candidates.length, 1)
  assert.equal(result.discovery.candidates[0].sources.length, 3)
  assert.equal(result.discovery.candidates[0].status, 'REVIEW_PENDING')
  assert.equal(result.discovery.candidates[0].contact.openingStatus, 'not_started')
  assert.equal(result.discovery.runState.counts.added, 1)
  assert.equal(result.discovery.runState.counts.merged, 2)
  assert.equal(result.discovery.runState.status, 'completed')
  assert.equal(h.engine.running, false)
})

test('engine searches only manual tags and keywords and stores their actual source queries', async () => {
  const h = harness({ discovery: { config: { videoTags: ['校园生活'], videoKeywords: ['猫咪日常'], maxVideosPerRun: 2 } } })
  h.engine.searchTopicVideos = async (_, keyword) => {
    h.calls.push(['search', keyword])
    return { candidates: [{ url: `https://www.douyin.com/video/${keyword.startsWith('#') ? '111111111' : '222222222'}`, title: keyword }] }
  }
  const result = await h.engine.start()
  assert.deepEqual(h.calls.filter(call => call[0] === 'search').map(call => call[1]), ['#校园生活', '猫咪日常'])
  assert.deepEqual(result.discovery.candidates[0].sources.map(source => [source.topic, source.keyword]), [['manual_tags', '#校园生活'], ['manual_keywords', '猫咪日常']])
})
test('review does not call any follow or private messaging API and repeat discovery preserves decision', async () => {
  const h = harness()
  await h.engine.start()
  const id = h.storage.get().discovery.candidates[0].id
  assert.equal(h.engine.review(id, { status: 'REJECTED', note: '不符合' }).candidate.status, 'REJECTED')
  await h.engine.start()
  assert.equal(h.storage.get().discovery.candidates[0].status, 'REJECTED')
})
test('discovery is never launched by constructing engine or reloading old running state', () => {
  const h = harness({ discovery: { runState: { status: 'running', counts: { added: 2 } } } })
  assert.equal(h.calls.length, 0)
  assert.equal(h.storage.get().discovery.runState.status, 'interrupted')
  assert.equal(h.storage.get().discovery.runState.counts.added, 2)
})
test('stop during pending page work prevents late results from entering candidate pool', async () => {
  const h = harness()
  let resolve
  h.engine.readVideoComments = () => new Promise(r => { resolve = r })
  const pending = h.engine.start()
  while (!resolve) await new Promise(r => setImmediate(r))
  h.engine.stop()
  resolve({ candidates: [{ nickname: '迟到作者', profileUrl, platformUserId: 'sec-first', commentText: '想交友' }] })
  const result = await pending
  assert.equal(result.stopped, true)
  assert.equal(h.storage.get().discovery.candidates.length, 0)
  assert.equal(h.storage.get().discovery.runState.status, 'stopped')
})
test('account destruction prevents late public profile inspection from changing saved review data', async () => {
  const h = harness()
  await h.engine.start()
  const id = h.storage.get().discovery.candidates[0].id
  let resolve
  h.engine.waitSnapshot = () => new Promise(r => { resolve = r })
  const pending = h.engine.inspect(id)
  while (!resolve) await new Promise(r => setImmediate(r))
  h.engine.window = null; h.engine.destroy()
  resolve({ profileUrl, platformUserId: 'sec-first', rawText: '不应保存' })
  await assert.rejects(pending, /停止/)
  assert.equal(h.storage.get().discovery.candidates[0].publicProfile, undefined)
})
test('stop recognizes a native load cancellation without reporting a discovery failure', async () => {
  const h = harness()
  let reject
  h.engine.searchTopicVideos = () => new Promise((_, j) => { reject = j })
  const pending = h.engine.start()
  h.engine.stop(); reject(new Error('ERR_ABORTED'))
  const result = await pending
  assert.equal(result.stopped, true)
  assert.equal(result.error, undefined)
  assert.equal(h.storage.get().discovery.runState.status, 'stopped')
})
test('configuration changes and concurrent discovery are blocked during a run', async () => {
  const h = harness()
  let resolve
  h.engine.searchTopicVideos = () => new Promise(r => { resolve = r })
  const pending = h.engine.start()
  assert.throws(() => h.engine.updateConfig({ maxVideosPerRun: 1 }), /过程中/)
  await assert.rejects(h.engine.start(), /正在操作/)
  h.engine.stop(); resolve({ candidates: [] }); await pending
})
test('empty searches are capped and no enabled keywords never opens a public window', async () => {
  const h = harness()
  h.engine.updateConfig({ videoTags: [], videoKeywords: Array.from({ length: 20 }, (_, i) => `主题${i}`) })
  h.engine.searchTopicVideos = async (_, keyword) => { h.calls.push(['search', keyword]); return { candidates: [], empty: true } }
  assert.equal((await h.engine.start()).ok, true)
  assert.equal(h.calls.filter(c => c[0] === 'search').length, 5)
  h.engine.updateConfig({ videoTags: [], videoKeywords: [] })
  await assert.rejects(h.engine.start(), /视频标签或搜索关键词/)
})
test('verification and parsing failures retain already saved candidates but do not fabricate new ones', async () => {
  const h = harness()
  let reads = 0
  h.engine.readVideoComments = async () => {
    if (++reads === 2) throw Object.assign(new Error('需要验证'), { blocked: true })
    return { candidates: [{ nickname: '评论作者', profileUrl, platformUserId: 'sec-first', commentText: '想交朋友' }] }
  }
  const result = await h.engine.start()
  assert.equal(result.ok, false)
  assert.equal(result.discovery.candidates.length, 1)
  assert.equal(result.discovery.runState.status, 'blocked')
})
test('public profile capture binds to immutable candidate identity and preserves original comment evidence', async () => {
  const h = harness()
  await h.engine.start()
  const original = h.storage.get().discovery.candidates[0]
  h.engine.waitSnapshot = async () => ({ profileUrl, platformUserId: 'sec-first', rawText: 'IP属地：浙江\n研二', nickname: '新昵称' })
  const result = await h.engine.inspect(original.id)
  assert.equal(result.candidate.nickname, original.nickname)
  assert.equal(result.candidate.publicProfile.nickname, '新昵称')
  assert.deepEqual(result.candidate.sources, original.sources)
  assert.equal(result.candidate.publicSignals.city, null)
  h.engine.waitSnapshot = async () => ({ profileUrl, platformUserId: 'sec-other', rawText: '错误作者' })
  await assert.rejects(h.engine.inspect(original.id), /身份已改变/)
})
test('a timed out profile navigation continues only at the exact expected URL for later DOM verification', async () => {
  const original = FriendshipService.prototype.navigate
  try {
    FriendshipService.prototype.navigate = async () => { throw new Error('抖音页面加载超时，请稍后重试') }
    const win = { isDestroyed: () => false, webContents: { getURL: () => profileUrl } }
    await DiscoveryEngine.prototype.navigate.call({}, win, profileUrl)
    await assert.rejects(DiscoveryEngine.prototype.navigate.call({}, win, profileUrl + '-wrong'), /超时/)
    FriendshipService.prototype.navigate = async () => { throw new Error('ERR_CONNECTION_REFUSED') }
    await assert.rejects(DiscoveryEngine.prototype.navigate.call({}, win, profileUrl), /REFUSED/)
  } finally { FriendshipService.prototype.navigate = original }
})

test('comment IP comes from the displayed row metadata on video and note pages', () => {
  const { collectCommentRows } = require('../electron/discovery/comment-snapshot.cjs')
  const dom = commentDom({ text: '正文提到 IP属地：北京' })
  dom.context.document.querySelectorAll = selector => selector === '[data-e2e="comment-item"]' ? [dom.row] : []
  dom.row.innerText = '评论作者\n正文提到 IP属地：北京\n1天前 · 湖南省\n回复'
  for (const route of ['video', 'note']) {
    dom.context.location = new URL(`https://www.douyin.com/${route}/${videoId}`)
    const read = () => vm.runInContext(`(${collectCommentRows.toString()})('${videoId}')`, dom.context)
    const row = read().rows[0]
    assert.equal(row.ipLocation, '湖南省')
    assert.equal(row.ipLocationSource, 'footer_region')
  }
  dom.row.innerText = '评论作者\n正文提到 IP属地：北京\n1天前\n回复'
  const result = vm.runInContext(`(${collectCommentRows.toString()})('${videoId}')`, dom.context)
  assert.equal(result.rows[0].ipLocation, null)
})

test('batch profile reader waits for late public gender and uses the live frame', async () => {
  const { engine } = harness()
  let reads = 0
  let loads = 0
  const win = {
    loadURL() { loads++; return new Promise(() => {}) },
    webContents: { mainFrame: { async executeJavaScript(code) {
      reads++
      const rawText = reads === 1 ? '合成昵称' : '合成昵称\n性别：女'
      const header = { ...visible, __reactPropsTest: { userInfo: { secUid: 'sec-first' } }, parentElement: { innerText: rawText }, querySelector: () => ({ innerText: '合成昵称' }) }
      return vm.runInNewContext(code, { location: new URL(profileUrl), document: {
        title: '', body: { innerText: '' }, querySelectorAll: () => [], querySelector: () => header,
      } })
    } } },
  }
  engine.ensureWindow = () => win
  const result = await engine.readBatchGender({ profileUrl, platformUserId: 'sec-first' }, () => true)
  assert.equal(loads, 1)
  assert.ok(reads >= 3, '公开字段需要跨轮保持稳定，不能在第一次出现时立即采信')
  assert.equal(result.publicSignals.genderText, '女')
  assert.equal(result.status, 'found')
})
