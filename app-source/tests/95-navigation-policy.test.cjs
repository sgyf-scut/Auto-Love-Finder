const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { navigationUrl, installDouyinSessionPolicy, releaseOwnedDeepLinkProtocol } = require('../electron/navigation-policy.cjs')

test('navigation event supports current details-event and older positional URL signatures', () => {
  assert.equal(navigationUrl({ url: 'bytedance://dispatch_message/' }), 'bytedance://dispatch_message/')
  assert.equal(navigationUrl({}, 'https://www.douyin.com/chat'), 'https://www.douyin.com/chat')
  assert.equal(navigationUrl({}, { url: 'https://www.douyin.com/video/123' }), 'https://www.douyin.com/video/123')
  assert.equal(navigationUrl(null), '')
})

test('actual chat navigation listeners block single-argument iframe deep links and preserve video capture', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/automation.cjs'), 'utf8')
  const start = source.indexOf("this.window.webContents.on('will-navigate'")
  const stop = source.indexOf('    // 抖音网页版聊天点击分享卡片', start)
  assert.ok(start > 0 && stop > start)
  const handlers = {}, captured = []
  vm.runInNewContext(source.slice(start, stop), { window: { webContents: {
    on: (name, callback) => { handlers[name] = callback }, setWindowOpenHandler() {},
  } }, navigationUrl, captureVideoUrl: url => { if (url.includes('/video/')) { captured.push(url); return true }; return false } })
  for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    let blocked = 0
    const event = { url: 'bytedance://dispatch_message/', preventDefault() { blocked++ } }
    handlers[eventName](event)
    assert.equal(blocked, 1, eventName)
    handlers[eventName]({ url: 'https://www.douyin.com/chat', preventDefault() { throw Error('chat must remain usable') } })
    handlers[eventName]({ url: 'https://www.douyin.com/video/123', preventDefault() { blocked++ } })
    assert.equal(blocked, 2)
  }
  assert.equal(captured.length, 3)
})

test('Douyin session denies external-app probes at both permission stages', () => {
  let check, request
  const session = { setPermissionCheckHandler: fn => { check = fn }, setPermissionRequestHandler: fn => { request = fn } }
  installDouyinSessionPolicy(session)
  for (const contents of [null, { getURL: () => 'https://www.douyin.com/chat' }]) {
    assert.equal(check(contents, 'openExternal'), false)
    let result
    request(contents, 'openExternal', value => { result = value }, { externalURL: 'bytedance://dispatch_message/' })
    assert.equal(result, false)
  }
})

test('session setup preserves other permission decisions and is scoped to each account session', () => {
  function session() {
    return { checkCount: 0, requestCount: 0, setPermissionCheckHandler(fn) { this.checkCount++; this.check = fn },
      setPermissionRequestHandler(fn) { this.requestCount++; this.request = fn } }
  }
  const a = session(), b = session()
  installDouyinSessionPolicy(a); installDouyinSessionPolicy(a); installDouyinSessionPolicy(b)
  assert.equal(a.checkCount, 1); assert.equal(a.requestCount, 1); assert.equal(b.checkCount, 1)
  assert.equal(a.check(null, 'notifications'), true)
  let result; a.request(null, 'clipboard-sanitized-write', value => { result = value }); assert.equal(result, true)
})

test('legacy protocol cleanup removes only this app own OS association', () => {
  const calls = []
  const app = { isDefaultProtocolClient: name => { calls.push(['check', name]); return false },
    removeAsDefaultProtocolClient: name => { calls.push(['remove', name]); return true } }
  assert.equal(releaseOwnedDeepLinkProtocol(app), false)
  assert.deepEqual(calls, [['check', 'bytedance']])
  app.isDefaultProtocolClient = () => true
  assert.equal(releaseOwnedDeepLinkProtocol(app), true)
  assert.deepEqual(calls.at(-1), ['remove', 'bytedance'])
})

test('main installs the account policy before starting chat workers and never registers a protocol handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
  const start = source.indexOf('function startAccountServices(accountId)')
  const policy = source.indexOf('installDouyinSessionPolicy(session.fromPartition(accountPartition(accountId)))', start)
  assert.ok(policy > start && policy < source.indexOf('new DouyinService(', start))
  assert.doesNotMatch(source, /app\.setAsDefaultProtocolClient\(/)
  assert.match(source, /releaseOwnedDeepLinkProtocol\(app\)/)
})
