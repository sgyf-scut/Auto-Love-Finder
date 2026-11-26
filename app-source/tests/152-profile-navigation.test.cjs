const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createMemoryStorage } = require('./setup.cjs')
const { ProfileNavigator } = require('../electron/discovery/profile-navigator.cjs')
const { FriendshipService } = require('../electron/friendship.cjs')

const candidate = {
  url: 'https://www.douyin.com/user/example_A',
  platformUserId: 'example_A',
  name: '测试昵称',
}
const source = { videoId: '123', commentId: '456', videoUrl: 'https://www.douyin.com/note/123' }
const failure = code => Object.assign(new Error(code), { code })
const page = (url, executeJavaScript) => ({
  shown: false,
  show() { this.shown = true },
  webContents: { getURL: () => url, mainFrame: { executeJavaScript } },
})
function harness() {
  const douyin = { storage: createMemoryStorage(), assertCanSend() {} }
  const navigator = new ProfileNavigator(douyin, { accountId: 'test', sourceFor: () => source })
  const attempts = []
  const targetPage = page(candidate.url)
  navigator.direct = async (_win, _url, alive) => { alive(); attempts.push('direct'); throw failure('PROFILE_NOT_FOUND') }
  navigator.viewer = {
    async openCommentAuthor(target, alive) {
      alive()
      attempts.push('comment')
      assert.equal(target.videoUrl, source.videoUrl)
      assert.equal(target.commentId, source.commentId)
      return { page: targetPage }
    },
  }
  navigator.fromSearch = async (_viewer, target, alive) => {
    alive()
    attempts.push('search')
    assert.equal(target.name, candidate.name)
    return { page: targetPage }
  }
  return { navigator, douyin, attempts, targetPage }
}

test('profile opening falls back in order and reuses a verified page', async () => {
  const { navigator, attempts, targetPage } = harness()
  const opened = await navigator.open(page('about:blank'), candidate)
  assert.deepEqual(opened, { page: targetPage, method: 'comment' })
  assert.deepEqual(attempts, ['direct', 'comment'])
  navigator.inspect = async () => ({ ready: true })
  const reused = await navigator.open(page('about:blank'), candidate, { automated: true })
  assert.equal(reused.page, targetPage)
  assert.deepEqual(attempts, ['direct', 'comment'])
})

test('search is tried after the original author entry cannot be opened', async () => {
  const { navigator, attempts } = harness()
  navigator.viewer.openCommentAuthor = async () => { attempts.push('comment'); throw failure('COMMENT_ENTRY_UNAVAILABLE') }
  assert.equal((await navigator.open(page('about:blank'), candidate)).method, 'search')
  assert.deepEqual(attempts, ['direct', 'comment', 'search'])
})

test('restriction and identity mismatch stop without trying another route', async () => {
  for (const code of ['ACCESS_RESTRICTED', 'CHALLENGE_REQUIRED', 'LOGIN_REQUIRED', 'ACCOUNT_ID_MISMATCH']) {
    const { navigator, attempts } = harness()
    navigator.viewer.openCommentAuthor = async () => { attempts.push('comment'); throw failure(code) }
    await assert.rejects(navigator.open(page('about:blank'), candidate, { automated: true }), {
      code, preActionFailure: true, followAttempted: false, sendAttempted: false,
    })
    assert.deepEqual(attempts, ['direct', 'comment'])
  }
})

test('three distinct unavailable profiles pause automation and a manual success releases it', async () => {
  const { navigator, attempts } = harness()
  navigator.viewer.openCommentAuthor = async () => { throw failure('COMMENT_ENTRY_UNAVAILABLE') }
  navigator.fromSearch = async () => { throw failure('SEARCH_ENTRY_UNAVAILABLE') }
  const win = page('about:blank')
  const open = (id, automated = true) => navigator.open(win, { ...candidate, url: 'https://www.douyin.com/user/' + id, platformUserId: id }, { automated })
  for (const id of ['first', 'first', 'second']) await assert.rejects(open(id), { code: 'PAGE_NOT_READY' })
  await assert.rejects(open('third'), { code: 'PROFILE_QUEUE_PAUSED' })
  await assert.rejects(open('fourth'), { code: 'PROFILE_QUEUE_PAUSED' })
  assert.equal(attempts.length, 4)
  navigator.direct = async () => win
  assert.equal((await open('fourth', false)).method, 'direct')
  assert.equal(navigator.failures.size, 0)
})

test('DOM probe distinguishes access restriction and missing profile even with pageload pending', async () => {
  const { navigator } = harness()
  function withBody(url, innerText) {
    return page(url, script => vm.runInNewContext(script, {
      location: new URL(url), document: { body: { innerText }, title: '', querySelector: () => null, querySelectorAll: () => [] },
    }))
  }
  assert.equal((await navigator.inspect(withBody(candidate.url + '/', '你查看的用户不存在'), candidate.url)).code, 'PROFILE_NOT_FOUND')
  assert.equal((await navigator.inspect(withBody('https://www.douyin.com/', '访问受限'), candidate.url)).code, 'ACCESS_RESTRICTED')
  assert.equal((await navigator.inspect(withBody('https://www.douyin.com/user/other', '你查看的用户不存在'), candidate.url)).ready, false)
})

test('manual opening and automated follow and greeting use the same locator', async () => {
  const { douyin, navigator, targetPage } = harness()
  const paths = []
  navigator.open = async (_win, _candidate, options = {}) => {
    paths.push(options.automated === true ? 'automated' : 'manual')
    if (options.automated) throw failure('PAGE_NOT_READY')
    return { page: targetPage, method: 'comment' }
  }
  douyin.profileNavigator = navigator
  const service = new FriendshipService(douyin)
  service.ensureWindow = () => ({ show() {}, focus() {} })
  service.candidate = () => candidate
  assert.equal((await service.open(candidate.url)).method, 'comment')
  await assert.rejects(service.followCandidate(candidate, { automated: true }), { code: 'PAGE_NOT_READY' })
  await assert.rejects(service.greetingCandidate(candidate, '你好', { automated: true }), { code: 'PAGE_NOT_READY' })
  assert.deepEqual(paths, ['manual', 'automated', 'automated'])
})

test('batch gender reads only the page returned by the shared navigator', async () => {
  const { DiscoveryEngine } = require('../electron/discovery/discovery-engine.cjs')
  const { douyin, navigator } = harness()
  const record = { profileUrl: candidate.url, platformUserId: candidate.platformUserId, nickname: candidate.name }
  const resolved = page(record.profileUrl, async () => ({
    ...record, ready: true, identityStatus: 'verified', documentKey: 'local-doc', documentState: 'complete', rawText: '女 22岁', genderText: '女',
  }))
  const unused = page('about:blank', () => assert.fail('The original window should not be read'))
  douyin.profileNavigator = navigator
  navigator.open = async (win, input, options) => {
    assert.equal(win, unused)
    assert.equal(input, record)
    assert.equal(options.automated, true)
    options.assertActive()
    return { page: resolved, method: 'search' }
  }
  const discovery = new DiscoveryEngine(douyin, { accountId: 'test' })
  discovery.ensureWindow = () => unused
  assert.equal((await discovery.readBatchGender(record, () => true)).status, 'found')
  navigator.open = async () => { throw Object.assign(failure('PROFILE_QUEUE_PAUSED'), { blocked: true }) }
  assert.equal((await discovery.readBatchGender(record, () => true)).profileQueuePaused, true)
})

test('user search selects the exact account even when another result has the same name', async () => {
  class Link {
    constructor(id, left) {
      this.href = 'https://www.douyin.com/user/' + id
      this.innerText = candidate.name
      this.left = left
    }
    scrollIntoView() {}
    getBoundingClientRect() { return { left: this.left, top: 10, width: 40, height: 20 } }
    contains(node) { return this === node }
  }
  const { navigator } = harness()
  const searchUrl = 'https://www.douyin.com/search/example?type=user'
  const other = new Link('example_B', 10), exact = new Link(candidate.platformUserId, 100)
  const searchPage = page(searchUrl, script => vm.runInNewContext(script, {
    URL, location: new URL(searchUrl),
    document: {
      title: '搜索', body: { innerText: candidate.name },
      querySelector: () => null,
      querySelectorAll: () => [other, exact],
      elementFromPoint: x => (x < 100 ? other : exact),
    },
  }))
  const viewer = {
    ensureWindow: () => searchPage,
    async navigate(win) { assert.equal(win, searchPage) },
    async clickProfileEntry(win, point, url) {
      assert.equal(win, searchPage)
      assert.equal(url, candidate.url)
      assert.equal(point.x, 120)
      return { page: win }
    },
  }
  await ProfileNavigator.prototype.fromSearch.call(navigator, viewer, candidate, () => {})
})
