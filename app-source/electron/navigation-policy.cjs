const configuredSessions = new WeakSet()

// A web embed uses the real Chromium version, without desktop application products.
// Do not impersonate another installed browser or override client-hint versions.
function webCompatibleUserAgent(value) {
  const native = String(value || '')
  if (!/ Electron\/[\d.]+/.test(native)) return native
  return native.replace(/ \S+\/\S+(?= Chrome\/)/, '').replace(/ Electron\/[\d.]+/g, '')
}

// Current Electron frame events carry URL on the event itself. Older main-frame
// events additionally pass a string URL; keep compatibility with both forms.
function navigationUrl(event, argument) {
  return typeof argument === 'string' ? argument
    : typeof argument?.url === 'string' ? argument.url
      : typeof event?.url === 'string' ? event.url : ''
}

function installDouyinSessionPolicy(session) {
  if (!session || configuredSessions.has(session)) return
  if (typeof session.getUserAgent === 'function' && typeof session.setUserAgent === 'function') {
    const native = session.getUserAgent(), web = webCompatibleUserAgent(native)
    if (web !== native) session.setUserAgent(web)
  }
  // Browser-only chat never needs to launch another Windows application.
  // A denied check must also be denied by the request handler, otherwise
  // Chromium can still dispatch bytedance:// probes to the operating system.
  session.setPermissionCheckHandler((_contents, permission) => permission !== 'openExternal')
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission !== 'openExternal'))
  configuredSessions.add(session)
}

function releaseOwnedDeepLinkProtocol(app) {
  // Earlier versions registered this app as the OS protocol target. Only undo
  // our own registration; a real Douyin desktop client belongs to the user.
  if (!app.isDefaultProtocolClient('bytedance')) return false
  return app.removeAsDefaultProtocolClient('bytedance')
}

module.exports = { navigationUrl, installDouyinSessionPolicy, releaseOwnedDeepLinkProtocol, webCompatibleUserAgent }
