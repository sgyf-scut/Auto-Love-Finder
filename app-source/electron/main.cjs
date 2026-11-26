const fs = require('node:fs')
const localDataPath = process.env.DOUYIN_ASSISTANT_DATA_DIR
if (localDataPath) fs.mkdirSync(localDataPath, { recursive: true })
const bootLogPath = require('node:path').join(localDataPath || __dirname, 'boot.log')
try {
  fs.appendFileSync(bootLogPath, `\n[${new Date().toISOString()}] === PROCESS START argv=${JSON.stringify(process.argv)} pid=${process.pid} ===\n`)
} catch {}
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, Notification, nativeTheme, session, clipboard } = require('electron')
const path = require('node:path')
if (localDataPath) app.setPath('userData', path.resolve(localDataPath))
const { JsonStorage, normalizeContact } = require('./storage.cjs')
const { SharedProvidersStore } = require('./providers-store.cjs')
const { DouyinService } = require('./automation.cjs')
const { FriendshipService, normalizePersona } = require('./friendship.cjs')
const { AutoFriendshipService } = require('./auto-friendship.cjs')
const { DiscoveryEngine } = require('./discovery/discovery-engine.cjs')
const { CommentCollectionService } = require('./discovery/comment-collection-service.cjs')
const { FavoritesSyncService } = require('./discovery/favorites-sync.cjs')
const { DiscoveryPipeline } = require('./discovery/discovery-pipeline.cjs')
const { DiscoveryScheduler } = require('./discovery/discovery-scheduler.cjs')
// P2-17B 三来源批次寻找：关键词 / 标签 / 收藏夹，固定目标人数，支持暂停与恢复。
const { BatchRunner, normalizeBatchConfig, batchOpeningInput } = require('./discovery/batch-runner.cjs')
const { evaluateBatchCandidate } = require('./discovery/batch-filter.cjs')
// P2-13 正式模式自动联系：筛选、资格判断、计划与实际队列（真实外发默认 Dry Run）。
const { AutoContactQueue, POLICY_VERSION: AUTO_POLICY_VERSION } = require('./discovery/auto-contact.cjs')
// P2-14A 资格审计：发现合格 / 联系资格 / 动作授权三层独立判定，默认不授权真实动作。
const { auditCandidates, explainFollowPlans, AUDIT_VERSION: CANDIDATE_AUDIT_VERSION } = require('./discovery/candidate-audit.cjs')
const { publicProfileSnapshot } = require('./discovery/comment-snapshot.cjs')
const { CommentCollector } = require('./social-brain/comment-collector.cjs')
const { ContactEngine } = require('./contact-engine.cjs')
const { evaluateActionGate, ACTIONS: GATE_ACTIONS, SOURCES: GATE_SOURCES } = require('./contact/action-gate.cjs')
const { VideoOpeningService } = require('./video-openings.cjs')
const { AiService, fetchWeatherContext, fetchHotTopicsCached, hotTopicForSparkCached, normalizeBaseUrl, setGlobalWeatherCity, clearWeatherCache } = require('./ai-service.cjs')
const { checkUpdate } = require('./update-service.cjs')
const { normalizeSelfProfile, stageSelfProfile, confirmSelfProfile, applySelfIntroduction, updateSelfProfile, createSeedSelfProfile, hasConfirmedSelfProfile } = require('./social-brain/self-profile.cjs')
const { extractSelfProfile } = require('./social-brain/self-profile-extractor.cjs')
const { installDouyinSessionPolicy, releaseOwnedDeepLinkProtocol } = require('./navigation-policy.cjs')
// P2 本地交友素材库：只读写账号目录下的 library/library.json，不写聊天状态。
const { LibraryStore, viewOf, autoModeConfig } = require('./social-brain/library-store.cjs')
const { classifyLibrary } = require('./social-brain/library-classifier.cjs')
const { candidateRecords, originForCandidate } = require('./social-brain/library-candidates.cjs')
const { buildIntroDraft } = require('./social-brain/first-contact.cjs')
const { LearningStore, viewOfLearning, evaluateLearning } = require('./social-brain/comment-learning.cjs')
const { BenchmarkStore, createBenchmarkSet, buildView: buildBenchmarkView, evaluateBenchmark, evaluateHumanLabels } = require('./social-brain/library-benchmark.cjs')
const { runCommentLearning } = require('./social-brain/comment-learning-runner.cjs')
const { MODES: LEARNING_MODES } = require('./social-brain/comment-classifier.cjs')

let mainWindow
let tray
let providersStore = null
let activeAccount = null
// 多账号并发服务注册表：accountId -> { storage, ai, douyin }。
// 所有账号的 worker 常驻并发；切换账号只改变界面展示目标。
const services = new Map()
let isQuitting = false

function getActiveServices() {
  return (activeAccount && services.get(activeAccount)) || null
}
function getActiveStorage() {
  return getActiveServices()?.storage || null
}

// 未捕获异常记录到日志但不退出：桌面自动化应用要尽量活着
process.on('uncaughtException', (error) => {
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] UncaughtException: ${error?.stack || error?.message || error}\n`)
  } catch {}
  try {
    getActiveStorage()?.addLog?.({ id: Date.now(), at: new Date().toISOString(), type: 'crash', message: '未捕获异常', detail: { error: String(error?.stack || error?.message || error) } })
  } catch {}
})
process.on('unhandledRejection', (reason) => {
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] UnhandledRejection: ${reason?.stack || reason?.message || reason}\n`)
  } catch {}
  try {
    getActiveStorage()?.addLog?.({ id: Date.now(), at: new Date().toISOString(), type: 'crash', message: '未处理的 Promise 拒绝', detail: { error: String(reason?.stack || reason?.message || reason) } })
  } catch {}
})
process.on('exit', (code) => {
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] process.exit code=${code}\n`)
  } catch {}
})

const BYTEDANCE_PROTOCOL = 'bytedance'
const assetPath = (name) => path.join(__dirname, '..', 'dist', name)
const hasBytedanceUrl = (argv) => argv.some((value) => typeof value === 'string' && /^bytedance:/i.test(value))
const hasSingleInstanceLock = app.requestSingleInstanceLock()
try {
  fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] hasSingleInstanceLock=${hasSingleInstanceLock}\n`)
} catch {}

// 抖音页面高频探测 bytedance:// 协议，每个探测拉起一个短命进程；
// 拿不到单实例锁立即 exit(0)，避免进程堆积吃满内存。
if (!hasSingleInstanceLock) {
  try { fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] Exiting due to !hasSingleInstanceLock\n`) } catch {}
  app.exit(0)
}

// 隐藏聊天页自动播放对方视频会常驻吃 CPU，禁止无手势自动播放
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required')

// Use Chromium's normal heap/process management for the full Douyin web app.
// The old 256 MB heap and three-renderer cap could force GC/contention during hydration.
// Keep normal GPU buffers and shader caching so warm visits can reuse compiled resources.
// Disable unrelated background services while keeping normal page rendering and cache.
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,Translate')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-domain-reliability')

function imageOrFallback(...names) {
  for (const name of names) {
    const image = nativeImage.createFromPath(assetPath(name))
    if (!image.isEmpty()) return image
  }
  return nativeImage.createEmpty()
}

function showMainWindow() {
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] showMainWindow called (hasWindow=${Boolean(mainWindow)})\n`)
  } catch {}
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  }
  if (!mainWindow) return
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  // Windows 前台锁定绕过：置顶唤醒并聚焦后解除置顶
  mainWindow.setAlwaysOnTop(true)
  mainWindow.focus()
  mainWindow.setAlwaysOnTop(false)
}

app.on('second-instance', (_event, argv) => {
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] second-instance event received argv=${JSON.stringify(argv)}\n`)
  } catch {}
  if (hasBytedanceUrl(argv)) return // 协议探测启动，静默吞掉
  showMainWindow()
})

function createWindow() {
  const isHiddenArg = process.argv.includes('--hidden')
  // 只有系统开机启动携带 --hidden 时才静默隐藏；用户常规打开一律正常显示窗口
  const shouldStartHidden = isHiddenArg
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    icon: assetPath('app-icon.png'),
    title: 'Auto Love Finder｜全自动找对象流水线',
    autoHideMenuBar: true,
    show: !shouldStartHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^file:/i.test(url)) event.preventDefault()
  })
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:;"],
      },
    })
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.once('ready-to-show', () => {
    if (!shouldStartHidden) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('close', (event) => {
    if (!isQuitting && getActiveStorage()?.get()?.settings?.minimizeToTray !== false) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
}

function applySystemSettings(settings = {}) {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.launchOnStartup),
      openAsHidden: Boolean(settings.startMinimized),
      path: process.execPath,
      args: Boolean(settings.startMinimized) ? ['--hidden'] : [],
    })
  }
}

// 桌面通知：按"产生事件的账号"自己的通知设置过滤
function notifyAutomationEvent(event, accountId = activeAccount) {
  const svc = accountId ? services.get(accountId) : null
  const settings = svc?.storage?.get()?.settings || {}
  if (!settings.desktopNotifications || !Notification.isSupported() || event?.type !== 'log') return
  const type = String(event.payload?.type || '')
  if (type === 'verification_required' || type === 'verification_cleared') {
    new Notification({
      title: type === 'verification_required' ? 'Auto Love Finder需要人工验证' : 'Auto Love Finder验证已通过',
      body: event.payload?.message || (type === 'verification_required' ? '请在登录窗口完成安全验证，自动回复已暂停' : '自动回复已恢复'),
      silent: false,
    }).show()
    return
  }
  const failed = /fail|error/i.test(type)
  const succeeded = /sent|success|answered/i.test(type)
  if ((failed && settings.notifyOnFailure === false) || (succeeded && settings.notifyOnSuccess === false)) return
  if (!failed && !succeeded) return
  new Notification({
    title: failed ? 'Auto Love Finder任务失败' : 'Auto Love Finder任务完成',
    body: event.payload?.message || (failed ? '请打开Auto Love Finder查看失败原因' : '任务已执行完成'),
    silent: !settings.soundNotifications,
  }).show()
}

function createTray() {
  try {
    const icon = imageOrFallback('tray-icon.png', 'app-icon.png')
    const resized = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 })
    tray = new Tray(resized)
    tray.setToolTip('Auto Love Finder')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示Auto Love Finder', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit() } },
    ]))
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
    try {
      fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] Tray created successfully (iconEmpty=${icon.isEmpty()})\n`)
    } catch {}
  } catch (trayErr) {
    try {
      fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] createTray error: ${trayErr?.stack || trayErr}\n`)
    } catch {}
  }
}

ipcMain.handle('app:info', () => ({
  name: 'Auto Love Finder',
  version: app.getVersion(),
  platform: process.platform,
}))

ipcMain.handle('app:check-update', async () => {
  try {
    return { ok: true, ...(await checkUpdate(app.getVersion())) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('app:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
  return false
})

function getDouyinService() {
  const svc = getActiveServices()
  if (!svc?.douyin) throw new Error('抖音登录服务尚未初始化，请重启Auto Love Finder')
  return svc.douyin
}

// ---- 多账号管理 ----
function accountRoot() {
  return path.join(app.getPath('userData'), 'accounts')
}
function accountIndexPath() {
  return path.join(app.getPath('userData'), 'accounts.json')
}
// P2 素材库存储：单独目录，绝不与 state.json 混写。
function libraryStore(accountId) {
  return new LibraryStore(path.join(accountRoot(), accountId))
}
// P2-15 统一动作门控的运行时上下文：所有真实关注/私信入口共用，避免各入口各写一份检查。
function platformUserIdOfUrl(url) {
  return String(url || '').match(/^https:\/\/www\.douyin\.com\/user\/([A-Za-z0-9_-]+)$/)?.[1] || ''
}
function discoveryCandidateOf(entry, platformUserId) {
  if (!platformUserId) return null
  try {
    return (entry?.storage?.get?.()?.discovery?.candidates || []).find(item => String(item.platformUserId || '') === String(platformUserId)) || null
  } catch { return null }
}
function evaluateEntryGate({ accountId, entry, action, source, candidate = null, audit = null, confirmation = {}, remaining = null }) {
  let state = {}, autoState = { mode: 'training', status: 'idle' }
  try { state = entry?.storage?.get?.() || {} } catch { state = {} }
  try { autoState = libraryStore(accountId).autoContactState() } catch { /* 素材库不可用时按训练模式处理 */ }
  const excludes = (state.contacts || []).map(contact => contact?.profile?.platformUserId).filter(Boolean)
  return evaluateActionGate({
    action, source, candidate, audit,
    automation: state.automation || {},
    autoState,
    platform: { verificationActive: entry?.douyin?.verificationActive === true },
    confirmation,
    remaining,
    excludes,
    blacklist: state.automation?.blacklist || [],
  })
}
function logGateDecision(entry, channel, gate) {
  try {
    if (!gate?.allowed) entry?.douyin?.log?.('action_gate_blocked', `已阻断真实动作：${gate.code}`, { channel, action: gate.action, source: gate.source, code: gate.code, requires: gate.requires })
  } catch { /* 日志失败不影响阻断 */ }
}
// P2-09 评论学习库：与素材库同目录，但独立 learning.json，人工标签单独保护。
function learningStore(accountId) {
  return new LearningStore(path.join(accountRoot(), accountId))
}
// P2-12A 人工基准集：独立 benchmark.json 只记录成员与抽样配额，人工标签仍写 learning.json。
function benchmarkStore(accountId) {
  return new BenchmarkStore(path.join(accountRoot(), accountId))
}
let bootDiscoveryScheduler = null
// P2-11C 自动候选筛选：把素材库里合规的评论意愿映射进候选池。
// 只复用已有判断（意愿标签、作者 sec_uid、联系人与黑名单排除），不推断年龄/性别；
// 已有候选人按 platformUserId 跨视频合并来源；不生成任何未经确认的经历。
function syncLibraryCandidates(services, { accountId = '', store }) {
  const state = services.storage.get()
  const { CandidateManager } = require('./discovery/candidate-manager.cjs')
  const { syncIntentPool } = require('./discovery/discovery-lists.cjs')
  const result = syncIntentPool({ manager: new CandidateManager(services.storage), libraryStore: store,
    learningStore: learningStore(accountId), accountId, contacts: state.contacts || [],
    blockedNames: [...(state.automation?.blacklist || []), ...(state.automation?.aiDisabledContacts || [])] })
  return { ...result, invalid: 0, skipped: 0, rejected: 0, candidateStats: candidateQualityStats(services, store), discovery: new CandidateManager(services.storage).get() }

}

// P2-12C 候选人质量统计：A/B/C/D、来源数、资料核实状态、拒绝保护、私信同意。
// 只读取已有候选与素材库标签，不抓取、不推断任何个人资料。
function candidateQualityStats(services, store, { gradeCounts = null, rejectedCount = 0 } = {}) {
  let candidates = []
  try {
    const { CandidateManager } = require('./discovery/candidate-manager.cjs')
    candidates = new CandidateManager(services.storage).get().candidates || []
  } catch { candidates = [] }
  const grades = { A: 0, B: 0, C: 0, D: 0 }
  const statuses = { DISCOVERED: 0, QUALIFIED: 0, INSUFFICIENT_INFO: 0, EXCLUDED: 0, REJECTED: 0 }
  let sources = 0, ageKnown = 0, genderKnown = 0, consent = 0, explicit = 0, rejectedInPool = 0
  for (const candidate of candidates) {
    const grade = ['A', 'B', 'C', 'D'].includes(candidate.discoveryGrade) ? candidate.discoveryGrade : 'D'
    grades[grade] += 1
    const status = candidate.status === 'REJECTED' || candidate.discoveryStatus === 'REJECTED' ? 'REJECTED'
      : ['DISCOVERED', 'QUALIFIED', 'INSUFFICIENT_INFO', 'EXCLUDED'].includes(candidate.discoveryStatus) ? candidate.discoveryStatus : 'DISCOVERED'
    statuses[status] += 1
    if (status === 'REJECTED') rejectedInPool += 1
    sources += Array.isArray(candidate.sources) ? candidate.sources.length : 0
    if (candidate.ageVerification && candidate.ageVerification !== 'unknown') ageKnown += 1
    if (candidate.genderVerification && candidate.genderVerification !== 'unknown') genderKnown += 1
    if (candidate.consentToDm === true) consent += 1
    if (candidate.explicitInvitation === true) explicit += 1
  }
  let commentGrades = gradeCounts
  if (!commentGrades) {
    commentGrades = { A: 0, B: 0, C: 0, D: 0 }
    const { gradeOfIntent } = require('./social-brain/library-candidates.cjs')
    for (const comment of store.read().comments || []) {
      const intent = comment.classification?.intent
      if (intent) commentGrades[gradeOfIntent(intent)] += 1
    }
  }
  const state = services.storage.get()
  return {
    total: candidates.length,
    grades, statuses, sources,
    ageKnown, genderKnown, ageUnknown: candidates.length - ageKnown, genderUnknown: candidates.length - genderKnown,
    consentCount: consent, explicitInvitationCount: explicit,
    rejectedProtected: Number(rejectedCount) || rejectedInPool,
    rejectedInPool,
    excludedByBlacklist: (state.automation?.blacklist || []).length + (state.automation?.aiDisabledContacts || []).length,
    contactCount: (state.contacts || []).length,
    commentGrades,
    note: '年龄/性别仅在本人公开自述或人工确认后才会从“未知”变更；A/B 级不等于私信许可。',
  }
}
function readAccountIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(accountIndexPath(), 'utf8'))
    const list = Array.isArray(raw.list) ? raw.list.filter((item) => item && item.id) : []
    return { active: typeof raw.active === 'string' ? raw.active : (list[0]?.id || null), list }
  } catch {
    return { active: null, list: [] }
  }
}
function writeAccountIndex(index) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(accountIndexPath(), JSON.stringify(index, null, 2), 'utf8')
}
function accountSummary(accountId) {
  try {
    const file = path.join(accountRoot(), accountId, 'state.json')
    if (!fs.existsSync(file)) return { contacts: 0 }
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { contacts: Array.isArray(state.contacts) ? state.contacts.length : 0 }
  } catch {
    return { contacts: 0 }
  }
}
function accountPartition(accountId) {
  // 默认账号沿用旧 partition，迁移后旧登录态不丢失
  return accountId === 'default' ? 'persist:douyin-account' : `persist:douyin-account-${accountId}`
}

// 每账号 storage 统一经共享模型列表视图包装：所有账号读写同一份 providers.json
function makeSharedProvidersView(baseStorage) {
  return {
    get() {
      const state = baseStorage.get()
      return { ...state, providers: providersStore ? providersStore.get() : (state.providers || []),
        aiSkills: (state.aiSkills || []).filter(skill => skill?.target !== 'friendship' && skill?.id !== 'friendship-advisor'),
      }
    },
    update(patch) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'providers')) {
        const { providers, ...rest } = patch
        if (rest && Object.keys(rest).length) baseStorage.update(rest)
        if (providersStore) providersStore.save(providers)
        return this.get()
      }
      baseStorage.update(patch)
      return this.get()
    },
    getBatch: () => baseStorage.getBatch(),
    addLog: (entry) => baseStorage.addLog(entry),
  }
}

function startAccountServices(accountId) {
  if (services.has(accountId)) return services.get(accountId)
  installDouyinSessionPolicy(session.fromPartition(accountPartition(accountId)))
  const dir = path.join(accountRoot(), accountId)
  fs.mkdirSync(dir, { recursive: true })
  const wrappedStorage = makeSharedProvidersView(new JsonStorage(dir))
  const ai = new AiService(wrappedStorage)
  const entry = { storage: wrappedStorage, ai, douyin: null }
  ai.accountId = accountId
  ai.sharedMemoryIsCurrent = () => services.get(accountId) === entry && !entry.douyin?._destroyed
  entry.douyin = new DouyinService({
    accountId,
    storage: entry.storage,
    ai: entry.ai,
    partition: accountPartition(accountId),
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('douyin:event', { ...event, accountId })
      notifyAutomationEvent(event, accountId)
    },
  })
  entry.douyin.accountId = accountId
  entry.douyin.startWorker()
  entry.douyin.getEventFollowups()
  startFriendshipServices(entry, accountId)
  startDiscoveryService(entry, accountId)
  entry.videoOpenings = new VideoOpeningService(entry.douyin)
  entry.douyin.videoOpenings = entry.videoOpenings
  services.set(accountId, entry)
  return entry
}

function startFriendshipServices(entry, accountId) {
  entry.friendship = new FriendshipService(entry.douyin)
  startContactService(entry, accountId)
  entry.friendshipAutomatic = new AutoFriendshipService({ douyin: entry.douyin, friendship: entry.friendship, storage: entry.storage, ai: entry.ai, accountId, contactEngine: entry.contactEngine,
    // P2-15.1 防御性收口：仅当联系引擎缺席、旧的直接关注路径被启用时才生效，
    // 保证任何真实关注都必须来自已入池并人工批准的候选人。
    poolCheck: target => {
      const platformUserId = platformUserIdOfUrl(target?.url)
      if (!platformUserId) return { ok: false, code: 'identity', reason: '缺少可核对的主页地址，不能自动关注' }
      const candidate = (entry.storage.get().discovery?.candidates || []).find(item => String(item.platformUserId || '') === platformUserId)
      if (!candidate) return { ok: false, code: 'not_in_pool', reason: '该用户不在候选池中：自动关注只处理已入池并人工批准的候选人' }
      if (candidate.status === 'REJECTED' || candidate.discoveryStatus === 'REJECTED') return { ok: false, code: 'rejected', reason: '该候选人已拒绝联系，禁止自动关注' }
      const approved = candidate.review?.status === 'approved' || ['APPROVED', 'APPROVED_PENDING_CONTACT'].includes(candidate.status)
      if (!approved) return { ok: false, code: 'not_approved', reason: '候选人尚未人工批准，不能自动关注' }
      return { ok: true }
    } })
  // 保留历史联系人状态与会话校验，发现批次负责寻找新候选。
  entry.douyin.friendshipAutomatic = entry.friendshipAutomatic
}

function stopFriendshipServices(entry, { logout = false } = {}) {
  if (logout) entry.friendshipAutomatic?.update({ enabled: false })
  if (logout) entry.contactEngine?.update({ enabled: false })
  stopContactService(entry)
  entry.friendshipAutomatic?.destroy()
  entry.friendship?.destroy()
}

function startContactService(entry, accountId) {
  if (!entry.contactEngine) {
    entry.contactEngine = new ContactEngine({ douyin: entry.douyin, friendship: entry.friendship, storage: entry.storage, accountId,
      inspectCandidate: async candidate => {
        if (!entry.discovery || entry.discovery.running || entry.discovery.busy) throw new Error('请先停止候选发现，再核验联系对象')
        return entry.discovery.inspect(candidate.id, { automated: true })
      } })
    entry.douyin.contactEngine = entry.contactEngine
    // Release preview: keep identity/gates and saved queues, but do not start
    // the legacy template-contact timer alongside the batch workflow.
  }
  if (entry.friendshipAutomatic) entry.friendshipAutomatic.contactEngine = entry.contactEngine
}
function stopContactService(entry) {
  entry?.contactEngine?.destroy()
  if (entry) { entry.contactEngine = null; if (entry.douyin) entry.douyin.contactEngine = null }
}

function startDiscoveryService(entry, accountId) {
  if (entry.discovery) return
  const { ProfileNavigator } = require('./discovery/profile-navigator.cjs')
  entry.douyin.profileNavigator = new ProfileNavigator(entry.douyin, {
    accountId,
    onVerified: ({ automated }) => {
      if (!automated && entry === getActiveServices() && entry.discoveryBatch?.state?.profileReadCircuit?.disabled) entry.discoveryBatch.save({ profileReadCircuit: { disabled: false, failures: [] } })
    },
    sourceFor: (platformUserId, candidate) => {
      const discovery = entry.storage.get().discovery || {}
      const record = (discovery.candidates || []).find(item => item.platformUserId === platformUserId)
      const batch = discovery.batch
      const match = batch?.added?.find(item => item.platformUserId === platformUserId || (record && item.candidateId === record.id))
      const source = [match?.commentSource, candidate.source, ...(candidate.sources || []), ...(record?.sources || [])]
        .find(item => item?.commentId && /^\d+$/.test(String(item.videoId)))
      if (!source) return null
      const videoId = String(source.videoId), commentId = String(source.commentId)
      const storedUrl = source.videoUrl || batch?.queue?.find(item => item.videoId === videoId)?.videoUrl
        || libraryStore(accountId).read().videos.find(item => String(item.video_id) === videoId)?.video_url
      const route = String(storedUrl || '').split(/[?#]/)[0].replace(/\/$/, '') === `https://www.douyin.com/note/${videoId}` ? 'note' : 'video'
      return { videoId, commentId, videoUrl: `https://www.douyin.com/${route}/${videoId}` }
    },
  })
  entry.discovery = new DiscoveryEngine(entry.douyin, { accountId })
}

function stopDiscoveryService(entry) {
  if (!entry?.discovery) return
  entry.discovery.destroy()
  entry.douyin.profileNavigator?.destroy()
  entry.discovery = null
}

function stopAccountServices(accountId) {
  const entry = services.get(accountId)
  if (!entry) return
  entry.discoveryScheduler?.stopTimer?.()
  entry.discoveryScheduler?.pause?.('账号服务已停止')
  if (entry.discoverySampling?.running) { try { entry.discoverySampling.stop() } catch {} }
  entry.ai?.cancelSharedMemoryExtraction?.()
  entry.ai?.cancelSelfNarrativeExtraction?.()
  entry.ai?.cancelPromiseExtraction?.()
  try { stopDiscoveryService(entry) } catch {}
  try { stopFriendshipServices(entry) } catch {}
  try { entry.douyin?.destroy() } catch {}
  try { entry.videoOpenings?.destroy() } catch {}
  services.delete(accountId)
}

function activateAccount(accountId) {
  if (activeAccount && activeAccount !== accountId) {
    const previous = services.get(activeAccount)
    previous?.ai?.cancelSharedMemoryExtraction?.()
    previous?.ai?.cancelSelfNarrativeExtraction?.()
    previous?.ai?.cancelPromiseExtraction?.()
    previous?.douyin?.incomingBuffer?.pause()
    void previous?.douyin?.burstQuietObserver?.stop()
  }
  if (activeAccount && activeAccount !== accountId) {
    const previous = getActiveServices()
    stopContactService(previous)
    stopDiscoveryService(previous)
    previous?.discoveryScheduler?.stopTimer?.()
    previous?.discoveryScheduler?.pause?.('切换账号，自动发现任务暂停')
  }
  if (!services.has(accountId)) startAccountServices(accountId)
  activeAccount = accountId
  const entry = getActiveServices()
  if (entry) startDiscoveryService(entry, accountId)
  if (entry) startContactService(entry, accountId)
  if (entry) applySystemSettings(entry.storage.get().settings)
  // 切换账号后重建当前账号的自动发现调度，旧账号不会继续跑。
  try { if (typeof bootDiscoveryScheduler === 'function') bootDiscoveryScheduler() } catch (error) { entry?.storage?.addLog?.({ type: 'discovery_scheduler_error', message: `调度启动失败：${error?.message || error}` }) }
  return entry
}

async function clearAccount(accountId, kind) {
  if (!accountId) throw new Error('账号不存在')
  const index = readAccountIndex()
  if (!index.list.some((item) => item.id === accountId)) throw new Error('账号不存在')
  if (kind === 'logout') {
    const existing = services.get(accountId)
    if (existing) stopDiscoveryService(existing)
    if (existing) stopFriendshipServices(existing, { logout: true })
    services.get(accountId)?.videoOpenings?.destroy()
    if (services.get(accountId)) {
      const entry = services.get(accountId)
      entry.videoOpenings = new VideoOpeningService(entry.douyin)
      entry.douyin.videoOpenings = entry.videoOpenings
    }
    try { await session.fromPartition(accountPartition(accountId)).clearStorageData() }
    finally {
      if (existing && services.get(accountId) === existing) {
        startFriendshipServices(existing, accountId)
        startDiscoveryService(existing, accountId)
      }
    }
    const entry = services.get(accountId)
    if (entry?.douyin) {
      entry.douyin.lastSeen.clear()
      entry.douyin.lastSent.clear()
    }
    return { ok: true, kind: 'logout' }
  }
  if (kind === 'wipe') {
    stopAccountServices(accountId)
    await session.fromPartition(accountPartition(accountId)).clearStorageData()
    fs.rmSync(path.join(accountRoot(), accountId), { recursive: true, force: true })
    const next = readAccountIndex()
    const list = next.list.filter((item) => item.id !== accountId)
    const active = next.active === accountId ? (list[0]?.id || null) : next.active
    writeAccountIndex({ active, list })
    if (activeAccount === accountId && active) activateAccount(active)
    if (!activeAccount && active) activateAccount(active)
    return { ok: true, kind: 'wipe', active, accounts: list.map((item) => ({ ...item, ...accountSummary(item.id) })) }
  }
  throw new Error('未知的清除类型')
}

function listAccounts() {
  const index = readAccountIndex()
  return {
    active: index.active,
    accounts: index.list.map((item) => ({ ...item, ...accountSummary(item.id) })),
  }
}

// ---- IPC ----
ipcMain.handle('douyin:open-login', () => getDouyinService().openLogin())
ipcMain.handle('douyin:status', () => getDouyinService().getStatus())
ipcMain.handle('douyin:logout', async () => {
  const accountId = activeAccount, entry = getActiveServices()
  if (!entry) throw new Error('账号服务尚未加载')
  stopDiscoveryService(entry)
  stopFriendshipServices(entry, { logout: true })
  try { return await entry.douyin.logout() }
  finally {
    if (services.get(accountId) === entry) {
      startFriendshipServices(entry, accountId)
      startDiscoveryService(entry, accountId)
    }
  }
})
ipcMain.handle('douyin:sync-contacts', () => getDouyinService().syncContacts())
for (const method of ['get-state', 'refresh']) {
  ipcMain.handle(`conversation-sync:${method}`, async (_event, payload = {}) => {
    try {
      const accountId = activeAccount, entry = getActiveServices()
      if (!payload.accountId || payload.accountId !== accountId || !entry) throw new Error('账号已经切换，请刷新会话接管状态后操作')
      if (method === 'get-state') return { ok: true, conversationSync: entry.douyin.getConversationSyncManager().state() }
      if (typeof payload.contactId !== 'string' || !payload.contactId.trim()) throw new Error('请选择需要核验的联系人')
      const contacts = (entry.storage.get().contacts || []).filter(contact => contact.id === payload.contactId)
      if (contacts.length !== 1) throw new Error('联系人无法唯一定位，请先同步联系人后核验')
      const result = await entry.douyin.refreshConversationBinding(payload.contactId)
      if (activeAccount !== accountId || getActiveServices() !== entry) throw new Error('账号已经切换，本次核验结果不用于当前账号')
      return result
    } catch (error) { return { ok: false, error: error.message } }
  })
}
ipcMain.handle('douyin:learn-contact', (_event, name) => getDouyinService().learnConversation(name))
ipcMain.handle('douyin:send-message', async (_event, { name, text, metadata = {} }) => {
  const accountId = activeAccount, entry = getActiveServices()
  if (!entry) throw new Error('账号服务尚未加载')
  if (metadata.draftId === undefined) return entry.douyin.sendMessage(name, text)
  const draft = await entry.douyin.confirmDraftFresh(metadata.draftId)
  if (draft.name !== name || accountId !== activeAccount || entry !== getActiveServices()) throw new Error('账号或草稿联系人已经变化，请刷新后操作')
  if (draft.source === 'event_followup' || draft.videoOpeningId) throw new Error('请通过该草稿对应的发送按钮操作')
  const sendMetadata = { draftId: draft.id, ai: true, selfProfileRevision: draft.selfProfileRevision, sharedMemoryIds: draft.sharedMemoryIds || [], sharedMemoryRevision: draft.sharedMemoryRevision, source: 'ai_draft', model: draft.model || '', provider: draft.provider || '', beforeSubmit: async () => {
    if (accountId !== activeAccount || entry !== getActiveServices()) throw new Error('账号已经切换，已停止发送旧草稿')
  } }
  const result = draft.expression
    ? await entry.douyin.approveExpressionDraft(draft.id, text, sendMetadata)
    : await entry.douyin.sendMessage(draft.name, text, sendMetadata)
  if (result?.status === 'UNKNOWN') return result
  if (draft.expression && result?.ok !== true) return result
  if (result?.ok !== true) throw new Error('抖音未确认草稿发送成功，已保留草稿')
  entry.storage.update({ pendingDrafts: (entry.storage.get().pendingDrafts || []).filter(item => item.id !== draft.id) })
  return result
})
ipcMain.handle('drafts:discard', (_event, id) => {
  const entry = getActiveServices()
  if (!entry) throw new Error('账号服务尚未加载')
  const draft = (entry.storage.get().pendingDrafts || []).find(item => item.id === id)
  if (draft?.source === 'event_followup' || draft?.videoOpeningId) throw new Error('请通过该草稿对应的丢弃按钮操作')
  const state = entry.storage.get()
  entry.storage.update({ pendingDrafts: (state.pendingDrafts || []).filter(item => item.id !== id),
    ...(draft?.expressionBatchId ? { expressionBatches: (state.expressionBatches || []).map(batch => batch.id === draft.expressionBatchId ? { ...batch, status: 'cancelled' } : batch) } : {}) })
  return { ok: true }
})
ipcMain.handle('douyin:send-task', (_event, { name, task }) => getDouyinService().sendTask(name, task))
ipcMain.handle('expression:resume', async (_event, batchId) => {
  const accountId = activeAccount, entry = getActiveServices()
  if (!entry) throw new Error('账号服务尚未加载')
  return entry.douyin.resumeExpressionBatch(batchId, { beforeSubmit: async () => {
    if (accountId !== activeAccount || entry !== getActiveServices()) throw new Error('账号已经切换，已停止发送旧任务')
  } })
})

for (const [method, channel] of [['search', 'search-users'], ['open', 'open-profile'], ['follow', 'follow-user'], ['opening', 'friend-opening']]) {
  ipcMain.handle(`friendship:${channel}`, async (_event, payload) => {
    try {
      const accountId = activeAccount, entry = getActiveServices()
      // P2-15：人工点击也必须经过同一套暂停/验证/拒绝/身份检查；点击本身即本次确认。
      if (method === 'follow') {
        const platformUserId = platformUserIdOfUrl(payload)
        const gate = evaluateEntryGate({
          accountId, entry, action: GATE_ACTIONS.FOLLOW, source: GATE_SOURCES.MANUAL,
          candidate: discoveryCandidateOf(entry, platformUserId) || { platformUserId, profileUrl: payload },
          confirmation: { confirmed: true },
        })
        logGateDecision(entry, channel, gate)
        if (!gate.allowed) return { ok: false, code: gate.code, reason: gate.reason, gate }
      }
      const result = await entry.friendship[method](payload)
      if (method === 'follow' && result?.ok && !result.followPending && result.candidate?.followedAt && entry === getActiveServices() && accountId === activeAccount) {
        const platformUserId = result.candidate.url?.match(/^https:\/\/www\.douyin\.com\/user\/([A-Za-z0-9_-]+)$/)?.[1]
        if (platformUserId) {
          const failed = error => entry.douyin.log?.('conversation_sync_error', '关注已确认，会话同步请求暂未完成', { error: error.message })
          try {
            Promise.resolve(entry.douyin.requestConversationSync?.({ accountId, reason: 'follow_confirmed', name: result.candidate.name,
              platformUserId, eventKey: `manual-follow:${platformUserId}:${result.candidate.followedAt}` })).catch(failed)
          } catch (error) { failed(error) }
        }
      }
      if (method === 'search' && result?.ok && entry === getActiveServices() && accountId === activeAccount) {
        const { CandidateManager } = require('./discovery/candidate-manager.cjs')
        new CandidateManager(entry.storage).upsertUserSearch(result.candidates, { accountId, keyword: result.keyword || payload })
        entry.contactEngine?.refresh()
        return { ...result, discovery: entry.storage.get().discovery }
      }
      return result
    }
    catch (error) { return { ok: false, error: error.message } }
  })
}
// First-message writing requirements are per account and never authorize sending.
ipcMain.handle('friendship:opening-requirements', async (_event, { accountId, requirements, mode = 'ai', fixedText = '' } = {}) => {
  try {
    const entry = getActiveServices()
    if (!entry || !accountId || accountId !== activeAccount) throw new Error('账号已切换，请重新保存首句要求')
    const { MAX_OPENING_REQUIREMENTS, normalizeOpeningRequirements, validateFixedOpening } = require('./opening-requirements.cjs')
    if (typeof requirements !== 'string' || requirements.length > MAX_OPENING_REQUIREMENTS) throw new Error('首句要求请填写不超过2000字的文字')
    if (!['ai','fixed'].includes(mode) || typeof fixedText !== 'string' || fixedText.length > 80) throw new Error('首句方式无效或固定首句超过80字')
    if (mode === 'fixed') validateFixedOpening(fixedText)
    const value = normalizeOpeningRequirements(requirements)
    entry.storage.update({ settings: { openingRequirements: value, openingMode: mode, fixedOpeningText: fixedText } })
    return { ok: true, requirements: value, mode, fixedText }
  } catch (error) { return { ok: false, error: error.message } }
})
// 评论作者一键联系：先预览第一句，用户确认后才关注并发送。
ipcMain.handle('friendship:approach-preview', async (_event, payload = {}) => {
  try {
    const entry = getActiveServices()
    if (!entry?.friendship) throw new Error('账号的交友服务尚未加载')
    const result = await entry.friendship.approachPreview(payload || {})
    return { ...result, ok: true }
  } catch (error) { return { ok: false, error: error.message } }
})
ipcMain.handle('friendship:approach', async (_event, payload = {}) => {
  const accountId = activeAccount, entry = getActiveServices()
  try {
    if (!entry?.friendship) throw new Error('账号的交友服务尚未加载')
    const platformUserId = platformUserIdOfUrl(payload?.url)
    const candidate = discoveryCandidateOf(entry, platformUserId) || { platformUserId, profileUrl: payload?.url, nickname: payload?.name, libraryIntent: payload?.libraryIntent }
    const confirmation = { confirmed: payload?.confirmed !== false, invitationAcknowledged: payload?.invitationAcknowledged === true }
    // 关注 + 私信两步都过门控；一般交友意愿必须由操作者单独确认后才能发私信。
    const followGate = evaluateEntryGate({ accountId, entry, action: GATE_ACTIONS.FOLLOW, source: GATE_SOURCES.MANUAL, candidate, confirmation })
    logGateDecision(entry, 'friendship:approach', followGate)
    if (!followGate.allowed) return { ok: false, code: followGate.code, reason: followGate.reason, gate: followGate, requires: followGate.requires }
    const messageGate = evaluateEntryGate({ accountId, entry, action: GATE_ACTIONS.FIRST_MESSAGE, source: GATE_SOURCES.MANUAL, candidate, confirmation })
    logGateDecision(entry, 'friendship:approach', messageGate)
    if (!messageGate.allowed) return { ok: false, code: messageGate.code, reason: messageGate.reason, gate: messageGate, requires: messageGate.requires, needsConfirmation: messageGate.status === 'needs_confirmation' }
    const result = await entry.friendship.approach(payload || {})
    if (result?.ok && platformUserId && entry === getActiveServices() && accountId === activeAccount) {
      const failed = error => entry.douyin.log?.('conversation_sync_error', '关注与首句已确认，会话同步请求暂未完成', { error: error.message })
      try {
        Promise.resolve(entry.douyin.requestConversationSync?.({ accountId, reason: 'friend_approach', name: result.name,
          platformUserId, eventKey: `comment-approach:${platformUserId}:${Date.now()}` })).catch(failed)
      } catch (error) { failed(error) }
    }
    return result
  } catch (error) { return { ok: false, error: error.message, sendAttempted: error.sendAttempted === true } }
})
function friendshipAutoEntry(payload) {
  if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('当前账号已经切换，请刷新后操作')
  const entry = getActiveServices()
  if (!entry?.friendshipAutomatic) throw new Error('账号的自动交友服务尚未加载')
  return entry
}
ipcMain.handle('friendship:auto-update', (_event, payload) => {
  try { return friendshipAutoEntry(payload).friendshipAutomatic.update(payload?.config || {}) }
  catch (error) { return { ok: false, error: error.message } }
})
ipcMain.handle('friendship:auto-run', async (_event, payload) => {
  try {
    // P2-15：紧急停止是全局的；旧自动交友入口也必须遵守。
    if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('当前账号已经切换，请刷新后操作')
    const gate = evaluateEntryGate({ accountId: activeAccount, entry: getActiveServices(), action: GATE_ACTIONS.FOLLOW, source: GATE_SOURCES.AUTO_FRIENDSHIP, candidate: null })
    if (gate.blockedBy?.includes('EMERGENCY_STOPPED')) return { ok: false, code: 'EMERGENCY_STOPPED', reason: gate.reason, gate }
    return await friendshipAutoEntry(payload).friendshipAutomatic.runOnce()
  }
  catch (error) { return { ok: false, error: error.message } }
})

function discoveryEntry(payload) {
  if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('当前账号已经切换，请刷新后操作')
  const entry = getActiveServices()
  if (!entry?.discovery) throw new Error('账号的候选发现服务尚未加载')
  return entry.discovery
}
for (const [channel, invoke] of [
  ['config', (service, payload) => service.updateConfig(payload.config || {})],
  ['parse', (service, payload) => service.parseRequirements(payload.text, getActiveServices().ai)],
  ['start', service => service.start()],
  ['stop', service => service.stop()],
  ['open', (service, payload) => service.open(payload.id)],
  ['inspect', (service, payload) => service.inspect(payload.id)],
  ['intent', (service, payload) => service.setIntent(payload.id, payload.intent)],
  ['review', (service, payload) => service.review(payload.id, { status: payload.status, note: payload.note, genderConfirmation: payload.genderConfirmation, ageConfirmation: payload.ageConfirmation })],
]) {
  ipcMain.handle(`discovery:${channel}`, async (_event, payload) => {
    try {
      const service = discoveryEntry(payload), result = await invoke(service, payload)
      const entry = getActiveServices()
      if (payload.accountId === activeAccount && entry?.discovery === service && ['config', 'start', 'inspect', 'review'].includes(channel)) {
        entry.contactEngine?.refresh()
        return { ...result, discovery: entry.storage.get().discovery }
      }
      return result
    }
    catch (error) { return { ok: false, error: error.message } }
  })
}
for (const [channel, invoke] of [
  ['get-state', service => service.state()],
  ['update', (service, payload) => service.update(payload.config || {})],
  ['enqueue', (service, payload) => service.enqueue(payload.id)],
  ['run', service => service.runOnce()],
  ['pause', (service, payload) => service.pause(payload.id)],
  ['resume', (service, payload) => service.resume(payload.id)],
  ['retry', (service, payload) => service.retry(payload.id)],
  ['refresh', service => service.refresh()],
]) {
  ipcMain.handle(`contact:${channel}`, async (_event, payload) => {
    let service
    try {
      if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('当前账号已经切换，请刷新后操作')
      service = getActiveServices()?.contactEngine
      if (!service) throw new Error('账号联系服务尚未加载')
      // P2-15：统一联系引擎也受全局紧急停止约束，避免从一个入口停止、另一个入口继续外发。
      if (channel === 'run') {
        const gate = evaluateEntryGate({ accountId: activeAccount, entry: getActiveServices(), action: GATE_ACTIONS.FOLLOW, source: GATE_SOURCES.CONTACT_ENGINE, candidate: null })
        if (gate.blockedBy?.includes('EMERGENCY_STOPPED')) return { ok: false, code: 'EMERGENCY_STOPPED', reason: gate.reason, gate }
      }
      const result = await invoke(service, payload)
      if (payload.accountId !== activeAccount || service !== getActiveServices()?.contactEngine) throw new Error('账号已经切换，本次联系操作已停止')
      return { ok: true, ...result, ...(['get-state', 'refresh'].includes(channel) ? {} : service.state()) }
    } catch (error) { return { ok: false, error: error.message, ...(service && payload?.accountId === activeAccount ? service.state() : {}) } }
  })
}
ipcMain.handle('friendship:save-persona', (_event, value) => {
  try { return { ok: true, state: getActiveStorage().update({ selfPersona: normalizePersona(value) }) } }
  catch (error) { return { ok: false, error: error.message } }
})
ipcMain.handle('friendship:set-mode', (_event, { name, mode } = {}) => {
  try {
    if (!['friendship', 'oldfriend'].includes(mode)) throw new Error('聊天模式无效')
    const storage = getActiveStorage()
    const state = storage.get()
    const persona = state.selfPersona || {}
    if (mode === 'friendship' && !hasConfirmedSelfProfile(state.selfProfile) && !persona.name && !persona.identity && !persona.interests) throw new Error('请先在“本人信息库”或“交友发现 → 我的介绍”保存本人信息')
    if ((state.contacts || []).filter(item => item.name === name).length !== 1) throw new Error('请选择唯一的联系人')
    return { ok: true, state: storage.update({ contacts: state.contacts.map(item => item.name === name ? { ...item, profile: { ...item.profile, chatMode: mode, useSelfPersona: mode === 'friendship' } } : item) }) }
  } catch (error) { return { ok: false, error: error.message } }
})
for (const method of ['create', 'open', 'send', 'discard']) {
  ipcMain.handle(`video-openings:${method}`, async (_event, value) => {
    try { return await getActiveServices().videoOpenings[method](value) }
    catch (error) { return { ok: false, error: error.message } }
  })
}

ipcMain.handle('accounts:list', () => listAccounts())
ipcMain.handle('accounts:add', () => {
  const id = `acc-${Date.now().toString(36)}`
  const name = `账号 ${new Date().toLocaleDateString('zh-CN')} ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  const index = readAccountIndex()
  index.list.push({ id, name })
  index.active = id
  writeAccountIndex(index)
  activateAccount(id)
  return { ok: true, active: id, accounts: listAccounts().accounts }
})
ipcMain.handle('accounts:switch', (_event, accountId) => {
  const index = readAccountIndex()
  if (!index.list.some((item) => item.id === accountId)) throw new Error('账号不存在')
  index.active = accountId
  writeAccountIndex(index)
  activateAccount(accountId)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:changed', { active: accountId })
  return { ok: true, active: accountId, state: getActiveStorage().get() }
})
ipcMain.handle('accounts:rename', (_event, { accountId, name }) => {
  const index = readAccountIndex()
  const item = index.list.find((entry) => entry.id === accountId)
  if (!item) throw new Error('账号不存在')
  item.name = String(name || '').trim() || item.name
  writeAccountIndex(index)
  return { ok: true, accounts: listAccounts().accounts }
})
ipcMain.handle('accounts:logout', async (_event, accountId) => clearAccount(accountId, 'logout'))
ipcMain.handle('accounts:wipe', async (_event, accountId) => clearAccount(accountId, 'wipe'))
ipcMain.handle('accounts:active-state', () => ({ active: activeAccount, state: getActiveStorage()?.get() ?? null }))

ipcMain.handle('automation:get-state', () => {
  const entry = getActiveServices()
  if (!entry) throw new Error('本机配置尚未加载，请重启Auto Love Finder')
  return entry.storage.get()
})
ipcMain.handle('automation:update', (_event, config) => {
  const entry = getActiveServices()
  if (!entry) throw new Error('本机配置尚未加载，请重试')
  if (Object.prototype.hasOwnProperty.call(config || {}, 'selfProfile')) throw new Error('请通过本人信息库的审核或修改按钮保存资料')
  if (Object.prototype.hasOwnProperty.call(config || {}, 'conversationSync')) throw new Error('请通过联系人会话接管的核验按钮更新状态')
  if (Array.isArray(config?.contacts)) config = preserveSharedMemoryFields(config, entry.storage.get())
  if (config?.settings?.longTermMemory === false) { entry.ai?.cancelSharedMemoryExtraction?.(); entry.ai?.cancelSelfNarrativeExtraction?.(); entry.ai?.cancelPromiseExtraction?.() }
  const next = entry.storage.update(config || {})
  // Invalidate immediately, even if the user resumes before an in-flight
  // model returns. Saving a transient paused flag alone cannot fence it.
  if (config?.automation?.paused === true || config?.settings?.incomingBurstEnabled === false) {
    entry.douyin?.incomingBuffer?.pause()
    void entry.douyin?.burstQuietObserver?.stop()
  }
  if (config?.settings) {
    applySystemSettings(next.settings)
    if (Object.prototype.hasOwnProperty.call(config.settings, 'weatherCity')) {
      const city = String(config.settings.weatherCity || '').trim()
      setGlobalWeatherCity(city)
      clearWeatherCache()
      for (const [id, s] of services.entries()) {
        if (s?.storage && s !== entry) {
          s.storage.update({ settings: { weatherCity: city } })
        }
      }
    }
  }
  entry.douyin?.startWorker()
  return { ok: true, state: next }
})

function preserveSharedMemoryFields(config, state) {
  return { ...config, contacts: config.contacts.map(contact => {
    const matches = (state.contacts || []).filter(current => String(current.id) === String(contact.id))
    const { sharedMemory: _clientMemory, sharedMemoryLedger: _clientLedger, selfNarrative: _clientNarrative, promises: _clientPromises, ...fields } = contact
    return matches.length === 1 ? { ...fields, sharedMemory: matches[0].sharedMemory, sharedMemoryLedger: matches[0].sharedMemoryLedger, selfNarrative: matches[0].selfNarrative, promises: matches[0].promises } : fields
  }) }
}

function deleteContactSharedMemory(payload) {
  if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('当前账号已经切换，请刷新后操作')
  if (typeof payload.contactId !== 'string' || !payload.contactId || typeof payload.memoryId !== 'string' || !payload.memoryId) throw new Error('缺少联系人或共同记忆编号')
  const entry = getActiveServices()
  if (!entry) throw new Error('账号服务尚未加载')
  const state = entry.storage.get()
  const matches = (state.contacts || []).filter(contact => String(contact.id) === payload.contactId)
  if (matches.length !== 1) throw new Error('联系人不存在或身份不唯一，请刷新后操作')
  const current = matches[0]
  const { normalizeSharedMemory, deleteSharedMemory } = require('./social-brain/shared-memory.cjs')
  const store = normalizeSharedMemory(current, { selfProfile: state.selfProfile })
  if (!store.memories.some(memory => memory.id === payload.memoryId)) throw new Error('该共同记忆已不存在或不属于当前联系人')
  const next = { ...current, sharedMemory: deleteSharedMemory({ ...current, sharedMemory: store }, payload.memoryId) }
  const { buildRelationshipJourney } = require('./social-brain/relationship-journey.cjs')
  next.relationshipJourney = buildRelationshipJourney({ contact: next })
  const pendingDrafts = (state.pendingDrafts || []).map(draft => {
    const same = draft.contactId ? String(draft.contactId) === payload.contactId : draft.name === current.name
    return same && (draft.sharedMemoryIds || []).includes(payload.memoryId) && !['sent', 'outdated'].includes(draft.status)
      ? { ...draft, status: 'outdated', outdatedReason: '引用的共同记忆已删除，请重新生成回复' } : draft
  })
  return entry.storage.update({ contacts: state.contacts.map(contact => contact === current ? next : contact), pendingDrafts })
}

ipcMain.handle('shared-memory:delete', (_event, payload) => {
  try { return deleteContactSharedMemory(payload) } catch (error) { return { ok: false, error: error.message } }
})

function contactPromiseTarget(payload) {
  if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('当前账号已经切换，请刷新后操作')
  if (typeof payload.contactId !== 'string' || !payload.contactId || typeof payload.promiseId !== 'string' || !payload.promiseId) throw new Error('缺少联系人或承诺编号')
  const entry = getActiveServices()
  if (!entry) throw new Error('账号服务尚未加载')
  const state = entry.storage.get()
  const matches = (state.contacts || []).filter(contact => String(contact.id) === payload.contactId)
  if (matches.length !== 1) throw new Error('联系人不存在或身份不唯一，请刷新后操作')
  return { entry, state, current: matches[0] }
}

function promiseFields(payload) {
  return Array.isArray(payload.fields)
    ? payload.fields.filter(field => field && typeof field.label === 'string' && typeof field.value === 'string').slice(0, 8)
    : []
}

function pendingContactPromise(payload) {
  const { entry, state, current } = contactPromiseTarget(payload)
  const { normalizePromises } = require('./social-brain/promise.cjs')
  const store = normalizePromises(current, { selfProfile: state.selfProfile })
  const promise = store.items.find(item => item.id === payload.promiseId && item.status === 'pending')
  if (!promise) throw new Error('这条承诺已处理或不属于当前联系人')
  return { entry, state, current, store, promise }
}

function promiseResultText(state, payload) {
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) throw new Error('请填写这条承诺的实际结果')
  const { redactPrivateData } = require('./social-brain/disclosure-policy.cjs')
  if (redactPrivateData(text, state.selfProfile).includes('[私密信息]')) throw new Error('结果里含手机号、账号密码等私密信息，请去掉后再写入')
  return text
}

// Read-only: extracts the structured writeback so the renderer can show it for
// confirmation before anything is committed to the contact's memory.
function previewContactPromise(payload) {
  const { state, store, promise } = pendingContactPromise(payload)
  const text = promiseResultText(state, payload)
  const { extractPromiseResult } = require('./social-brain/promise-result-extractor.cjs')
  const { fields, topics } = extractPromiseResult(promise, text, { selfProfile: state.selfProfile })
  return { ok: true, revision: store.revision, contactId: store.contactId,
    promise: { id: promise.id, type: promise.type, summary: promise.summary, dueHint: promise.dueHint }, text, fields, topics }
}

function resolveContactPromise(payload) {
  const { entry, state, current, store } = pendingContactPromise(payload)
  const text = promiseResultText(state, payload)
  const { resolvePromise } = require('./social-brain/promise.cjs')
  const promises = resolvePromise({ ...current, promises: store }, payload.promiseId,
    { text, fields: promiseFields(payload), now: new Date(), expectedRevision: payload.expectedRevision, selfProfile: state.selfProfile })
  return entry.storage.update({ contacts: state.contacts.map(contact => contact === current ? { ...current, promises } : contact) })
}

function cancelContactPromise(payload) {
  const { entry, state, current, store } = pendingContactPromise(payload)
  const { cancelPromise } = require('./social-brain/promise.cjs')
  const promises = cancelPromise({ ...current, promises: store }, payload.promiseId, { now: new Date() })
  return entry.storage.update({ contacts: state.contacts.map(contact => contact === current ? { ...current, promises } : contact) })
}

function rescheduleContactPromise(payload) {
  const { entry, state, current, store } = pendingContactPromise(payload)
  const dueHint = typeof payload.dueHint === 'string' ? payload.dueHint.trim() : ''
  const { reschedulePromise } = require('./social-brain/promise.cjs')
  const promises = reschedulePromise({ ...current, promises: store }, payload.promiseId, { dueHint, now: new Date() })
  return entry.storage.update({ contacts: state.contacts.map(contact => contact === current ? { ...current, promises } : contact) })
}

ipcMain.handle('promise:preview', (_event, payload) => {
  try { return previewContactPromise(payload) } catch (error) { return { ok: false, error: error.message } }
})

ipcMain.handle('promise:resolve', (_event, payload) => {
  try { return resolveContactPromise(payload) } catch (error) { return { ok: false, error: error.message } }
})

ipcMain.handle('promise:cancel', (_event, payload) => {
  try { return cancelContactPromise(payload) } catch (error) { return { ok: false, error: error.message } }
})

ipcMain.handle('promise:reschedule', (_event, payload) => {
  try { return rescheduleContactPromise(payload) } catch (error) { return { ok: false, error: error.message } }
})

function selfProfileEntry(payload) {
  if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('账号已经切换，请刷新本人信息库后操作')
  const entry = getActiveServices()
  if (!entry) throw new Error('账号服务尚未加载')
  return entry
}
function assertSelfProfileRevision(profile, payload) {
  if (!Number.isInteger(payload.revision) || profile.revision !== payload.revision) throw new Error('本人资料已更新，请刷新后重新审核或修改')
}
function commitSelfProfile(entry, profile, { formal = false } = {}) {
  const state = entry.storage.get()
  const patch = { selfProfile: profile }
  if (formal) {
    entry.douyin?.incomingBuffer?.pause()
    void entry.douyin?.burstQuietObserver?.stop()
    patch.pendingDrafts = (state.pendingDrafts || []).map(draft => draft.source !== 'event_followup' && !draft.videoOpeningId && ['pending', 'failed'].includes(draft.status || 'pending')
      ? { ...draft, status: 'outdated', outdatedReason: '本人信息库已更新，请重新生成这份草稿。' } : draft)
    entry.selfProfileExtractionSeq = (entry.selfProfileExtractionSeq || 0) + 1
  }
  const next = entry.storage.update(patch)
  return { ok: true, selfProfile: next.selfProfile }
}
for (const method of ['get', 'extract', 'confirm', 'update', 'discard', 'initialize', 'save-introduction']) {
  ipcMain.handle(`self-profile:${method}`, async (_event, payload = {}) => {
    try {
      const accountId = activeAccount, entry = selfProfileEntry(payload)
      const profile = normalizeSelfProfile(entry.storage.get().selfProfile)
      if (method === 'get') return { ok: true, selfProfile: profile }
      assertSelfProfileRevision(profile, payload)
      if (method === 'save-introduction') {
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text || text.length > 30000) throw new Error('请填写 1～30000 字的介绍')
        const request = entry.selfProfileExtractionSeq = (entry.selfProfileExtractionSeq || 0) + 1
        commitSelfProfile(entry, { ...profile, introductionText: text })
        const extracted = await extractSelfProfile({ text, complete: entry.ai.inquiryCompletion.bind(entry.ai) })
        if (activeAccount !== accountId || getActiveServices() !== entry || request !== entry.selfProfileExtractionSeq) throw new Error('账号或提取任务已经变化，本次结果未生效')
        const latest = normalizeSelfProfile(entry.storage.get().selfProfile)
        assertSelfProfileRevision(latest, payload)
        if (![extracted.stableProfile, extracted.currentLife, extracted.privacyPreferences].some(rows => rows.length)) throw new Error('已保存介绍原文，本次未提取到可用资料')
        return commitSelfProfile(entry, applySelfIntroduction(latest, extracted), { formal: true })
      }
      if (method === 'extract') {
        const request = entry.selfProfileExtractionSeq = (entry.selfProfileExtractionSeq || 0) + 1
        const pending = await extractSelfProfile({ text: payload.text, complete: entry.ai.inquiryCompletion.bind(entry.ai) })
        if (activeAccount !== accountId || getActiveServices() !== entry || request !== entry.selfProfileExtractionSeq) throw new Error('账号或提取任务已经变化，本次结果未保存')
        const latest = normalizeSelfProfile(entry.storage.get().selfProfile)
        assertSelfProfileRevision(latest, payload)
        return commitSelfProfile(entry, stageSelfProfile(latest, pending))
      }
      if (method === 'confirm') return commitSelfProfile(entry, confirmSelfProfile(profile, { pendingId: payload.pendingId, stableProfile: payload.stableProfile, currentLife: payload.currentLife, privacyPreferences: payload.privacyPreferences }), { formal: true })
      if (method === 'update') return commitSelfProfile(entry, updateSelfProfile(profile, { section: payload.section, item: payload.item, removeId: payload.removeId }), { formal: true })
      if (method === 'discard') {
        if (!profile.pending || payload.pendingId !== profile.pending.id) throw new Error('待审核资料已经变化，请刷新')
        entry.selfProfileExtractionSeq = (entry.selfProfileExtractionSeq || 0) + 1
        return commitSelfProfile(entry, { ...profile, pending: null })
      }
      if (profile.revision || profile.pending || profile.stableProfile.length || profile.currentLife.length || profile.privacyPreferences.length) throw new Error('本人信息库已有资料，初始化不会覆盖现有内容')
      return commitSelfProfile(entry, createSeedSelfProfile(), { formal: true })
    } catch (error) { return { ok: false, error: error.message } }
  })
}

// AI 服务 IPC：统一捕获异常
function registerAiHandlers() {
  const guarded = (handler, errorKey = 'error') => async (_event, payload) => {
    try {
      return await handler(payload)
    } catch (error) {
      return { ok: false, [errorKey]: error.message }
    }
  }
  ipcMain.handle('ai:save-provider', guarded((provider) => getActiveServices().ai.saveProvider(provider)))
  ipcMain.handle('ai:delete-provider', guarded((name) => getActiveServices().ai.deleteProvider(name)))
  ipcMain.handle('ai:set-primary-provider', guarded((name) => getActiveServices().ai.setPrimaryProvider(name)))
  ipcMain.handle('ai:test-provider', guarded((index) => getActiveServices().ai.test(index), 'message'))
  ipcMain.handle('ai:fetch-models', guarded((payload) => getActiveServices().ai.fetchModels(payload), 'message'))
  // 接口地址实时预览：复用主进程同一套归一化逻辑，前端不重复实现，避免规则漂移
  ipcMain.handle('ai:normalize-base-url', (_event, value) => {
    try { return { ok: true, baseUrl: normalizeBaseUrl(value) } } catch (error) { return { ok: false, message: error.message } }
  })
  ipcMain.handle('ai:draft', guarded((payload) => getActiveServices().ai.draft(payload)))
  const eventEntry = payload => {
    if (!payload?.accountId || payload.accountId !== activeAccount) throw new Error('当前账号已经切换，请刷新后操作')
    const entry = getActiveServices()
    if (!entry) throw new Error('账号服务尚未加载')
    return entry
  }
  ipcMain.handle('events:scan', guarded(payload => eventEntry(payload).douyin.getEventFollowups().scan({ force: true })))
  ipcMain.handle('events:send', guarded(payload => {
    const entry = eventEntry(payload)
    return entry.douyin.getEventFollowups().send(payload, { isActive: () => getActiveServices() === entry })
  }))
  ipcMain.handle('events:skip', guarded(payload => eventEntry(payload).douyin.getEventFollowups().skip(payload)))
  ipcMain.handle('events:rewrite', guarded(payload => eventEntry(payload).douyin.getEventFollowups().rewrite(payload)))
  // 训练场：用户示范自己的回复方式，AI 学习（样例 + 风格统计 + 对话历史）
  ipcMain.handle('train:learn', guarded(async (payload) => {
    const entry = getActiveServices()
    if (!entry) throw new Error('本机配置尚未加载，请重启Auto Love Finder')
    const name = String(payload?.name || '').trim()
    if (!name) throw new Error('缺少训练对象名称')
    // 训练对象不存在时先创建（虚拟联系人，不影响真实联系人）
    const before = entry.storage.get()
    if (!(before.contacts || []).some((c) => c.name === name)) {
      const created = normalizeContact({ id: name, name, profile: { relationship: payload?.relationship || '训练对象' } })
      entry.storage.update({ contacts: [...(before.contacts || []), created] })
    }
    if (payload?.incoming) {
      entry.douyin.recordConversationMessage(name, 'contact', String(payload.incoming).slice(0, 300), { id: name, name }, { human: true, synthetic: true })
    }
    let learned = false
    let examplesCount = 0
    if (payload?.userText) {
      // 用户示范：进对话历史 + 风格统计（human:true），并进入"本人说话样例"（prompt 最高优先级）
      const updated = entry.douyin.recordConversationMessage(name, 'me', String(payload.userText).slice(0, 200), { id: name, name }, { human: true, synthetic: true })
      const after = entry.storage.get()
      const contacts = [...(after.contacts || [])]
      const idx = contacts.findIndex((c) => c.name === name)
      if (idx >= 0) {
        const profile = { ...(contacts[idx].profile || {}) }
        const examples = (profile.examples || []).filter((item) => item !== payload.userText)
        examples.push(String(payload.userText).trim())
        profile.examples = examples.slice(-12)
        contacts[idx] = { ...contacts[idx], profile }
        entry.storage.update({ contacts })
        examplesCount = profile.examples.length
      }
      learned = true
    } else if (payload?.acceptAiText) {
      // 直接采用 AI 原文：只进对话历史，不进风格统计（防止 AI 学自己）
      entry.douyin.recordConversationMessage(name, 'me', String(payload.acceptAiText).slice(0, 200), { id: name, name }, { human: false, synthetic: true })
    }
    const after = entry.storage.get()
    const trained = (after.contacts || []).find((c) => c.name === name)
    return {
      ok: true, learned, examplesCount,
      styleSummary: trained?.learning?.ownerStyle?.summary || '样本不足',
      historyCount: trained?.learning?.messages?.length || 0,
    }
  }))
  // AI 拟一条"今日播报"问候（预览，不发送）：抓取天气/热点 → 续火花文案链路。
  // 供任务页预览与对话理解基准（spark-sim）驱动。
  ipcMain.handle('ai:draft-spark', guarded(async (payload) => {
    const entry = getActiveServices()
    if (!entry) throw new Error('本机配置尚未加载，请重启Auto Love Finder')
    const name = String(payload?.name || '').trim()
    if (!name) throw new Error('缺少联系人名称')
    const state = entry.storage.get()
    const contact = (state.contacts || []).find((c) => c.name === name) || { id: name, name, profile: {}, learning: { messages: payload?.history || [], facts: [], topicLog: [], mediaLog: [] } }
    if (Array.isArray(payload?.history) && contact.learning) contact.learning.messages = payload.history
    let weather = ''
    let hotTopic = ''
    try { await fetchHotTopicsCached() } catch { /* 抓取失败则热点段落自动跳过 */ }
    try { weather = await fetchWeatherContext(entry.storage) } catch { weather = '' }
    try { hotTopic = hotTopicForSparkCached() } catch { hotTopic = '' }
    const result = await entry.ai.draftSparkMessage({ contact, task: payload?.task || {}, weather, hotTopic })
    return { ...result, weatherUsed: weather, hotTopicUsed: hotTopic }
  }))
  ipcMain.handle('ai:get-weather', guarded(async (customCity) => {
    const entry = getActiveServices()
    const targetCity = typeof customCity === 'string' && customCity.trim() ? customCity.trim() : (entry?.storage?.get()?.settings?.weatherCity || '')
    if (targetCity) setGlobalWeatherCity(targetCity)
    clearWeatherCache()
    const text = await fetchWeatherContext(entry?.storage, targetCity)
    return { ok: true, success: true, text, city: targetCity }
  }))
  ipcMain.handle('ai:get-skills', guarded(() => ({ ok: true, skills: getActiveStorage().get().aiSkills || [] })))
  ipcMain.handle('ai:save-skills', guarded((skills) => getActiveServices().ai.saveSkills(skills)))
  ipcMain.handle('ai:import-skills', guarded((rawText) => getActiveServices().ai.importSkills(rawText)))
  ipcMain.handle('ai:clear-learning', guarded((name) => {
    if (typeof name !== 'string' || !name) throw new Error('缺少联系人名称')
    const entry = getActiveServices()
    const state = entry.storage.get()
    if ((state.contacts || []).filter(contact => contact.name === name).length > 1) throw new Error('存在同名联系人，已停止清除以保护不同联系人的记忆')
    entry.ai?.cancelSharedMemoryExtraction?.()
    entry.ai?.cancelSelfNarrativeExtraction?.()
    entry.ai?.cancelPromiseExtraction?.()
    const contacts = (state.contacts || []).map((contact) => {
      if (contact.name !== name) return contact
      const next = { ...contact }
      const { normalizeSharedMemory, deleteSharedMemory } = require('./social-brain/shared-memory.cjs')
      next.sharedMemory = normalizeSharedMemory(contact, { selfProfile: state.selfProfile })
      for (const memory of [...next.sharedMemory.memories]) next.sharedMemory = deleteSharedMemory(next, memory.id)
      delete next.sharedMemoryLedger
      delete next.selfNarrative
      delete next.promises
      delete next.learning
      delete next.socialBrain
      if (next.relationshipJourney) next.relationshipJourney = { ...next.relationshipJourney, relationshipEvidence: [], evaluatedEvidenceHash: '', evaluatedEvidenceIds: [] }
      return next
    })
    entry.storage.update({ contacts })
    return { ok: true, name }
  }))

  // ── P2 本地交友素材库（导入 / 标注 / 候选 / 来源 / 开场白）─────────────────
  // 只读写当前账号目录下的 library/library.json；不动聊天历史，不发消息、不关注。
  ipcMain.handle('library:get', guarded(async () => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const store = libraryStore(activeAccount)
    const services = getActiveServices()
    let scheduler = null
    try { scheduler = store.pipelineState().scheduler } catch { /* Read-only view; never starts an old scheduler. */ }
    return {
      ok: true,
      library: viewOf(store.read()),
      scheduler,
      candidateStats: services ? candidateQualityStats(services, store) : null,
    }
  }))

  // 一键清空素材库：清掉已收集的视频、评论和收集断点，同时把还没判断的学习样本移出待审。
  // 已人工判断的学习案例保留，账号和聊天记录不受影响。
  ipcMain.handle('library:clear', guarded(async () => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const store = libraryStore(activeAccount)
    const cleared = store.clear()
    const learning = learningStore(activeAccount)
    const keys = learning.read().samples.filter(sample => !sample.human && !sample.excluded).map(sample => sample.key)
    const excluded = keys.length ? learning.excludeMany(keys, { reason: '素材库一键清空' }) : 0
    return { ok: true, library: viewOf(cleared), learning: learningView(learning), excluded }
  }))

  // 用户主动挑选视频：粘贴链接/作品 ID，或从剪贴板一键收录。不做网页抓取。
  const collectVideo = async (payload) => {
    const store = libraryStore(activeAccount)
    const result = store.addVideo(payload)
    return {
      ok: true, added: result.added, video: { ...result.video, status: 'imported', statusLabel: '已导入' },
      library: viewOf(result.library), libraryFile: store.filePath,
      message: result.added ? '视频已收录到本地素材库' : '这条视频已在素材库里，已补齐缺失信息',
    }
  }
  ipcMain.handle('library:collect-video', guarded(async ({ text = '', title = '', hashtags = [], topic = '' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    try {
      return await collectVideo({ text, title, hashtags, topic, source: 'manual' })
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }))
  ipcMain.handle('library:collect-clipboard', guarded(async ({ title = '', hashtags = [], topic = '' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const copied = String(clipboard.readText() || '').trim()
    if (!copied) return { ok: false, error: '剪贴板是空的，请先在抖音复制视频分享链接' }
    try {
      const result = await collectVideo({ text: copied, title, hashtags, topic, source: 'clipboard' })
      return { ...result, copied: copied.slice(0, 300) }
    } catch (error) {
      return { ok: false, error: `剪贴板内容不是可识别的视频链接：${String(error?.message || error)}`, copied: copied.slice(0, 300) }
    }
  }))

  // P2-10 一键收集评论：登录态 + 视频页公开评论，分页/去重/上限/断点恢复。
  // 无权限时直接返回原因，绝不构造签名接口或绕过反爬；失败后可用 JSON/CSV 手动导入。
  ipcMain.handle('library:collect-comments', guarded(async ({
    text = '', videoId = null, videoUrl = null, title = null,
    limit = 50, maxPages = 8, resume = false, classify = true, maxAiCalls = 6,
  } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const services = getActiveServices()
    if (!services) return { ok: false, error: '账号服务尚未就绪' }
    const store = libraryStore(activeAccount)
    const pushCollector = collector => {
      try { mainWindow?.webContents.send('douyin:event', { type: 'library_collector', payload: { collector }, accountId: activeAccount }) } catch { /* 窗口已关闭 */ }
    }
    if (!services.commentCollection) services.commentCollection = new CommentCollectionService(services.douyin, { accountId: activeAccount })
    const checkpoint = store.collectorState()
    const useResume = resume === true
    const targetText = text || (useResume ? (checkpoint.videoUrl || checkpoint.videoId || '') : '')
    if (!targetText && !videoId && !videoUrl) return { ok: false, error: '请先粘贴抖音视频链接，或选择一个已收录视频' }

    let transport = null
    try {
      transport = services.commentCollection.createTransport({
        onPhase: phase => {
          try { pushCollector(store.setCollector({ phase })) } catch { /* 进度写入失败不阻塞采集 */ }
        },
      })
    } catch (error) {
      return { ok: false, code: 'NO_TRANSPORT', error: String(error?.message || error) }
    }

    let result = null
    try {
      const collector = new CommentCollector({ store, transport, onProgress: pushCollector })
      result = await collector.run({
        text: targetText, videoId, videoUrl, title,
        limit, maxPages, resume: useResume,
      })
    } catch (error) {
      const collector = store.setCollector({ status: 'failed', code: 'NETWORK_ERROR', lastError: String(error?.message || error), finishedAt: new Date().toISOString(), phase: '收集过程异常' })
      pushCollector(collector)
      return { ok: false, code: 'NETWORK_ERROR', error: String(error?.message || error), library: viewOf(store.read()), collector }
    }

    let learning = null, review = [], classified = null
    if (result.ok && classify && (result.comments || []).length) {
      const lstore = learningStore(activeAccount)
      try {
        lstore.syncLibrary(store.read())
        classified = await runCommentLearning({
          learningStore: lstore, libraryStore: store, ai: services.ai,
          mode: 'model', scope: 'all', keys: result.comments,
          maxCalls: Math.max(1, Math.min(30, Number(maxAiCalls) || 6)), batchSize: 6,
        })
      } catch (error) {
        classified = { ok: false, error: String(error?.message || error) }
      }
      const learningViewNow = viewOfLearning(lstore.read(), { limit: 200 })
      const wanted = new Set(result.comments)
      review = (learningViewNow.pending || []).filter(sample => wanted.has(sample.key))
      learning = { ...learningViewNow, filePath: lstore.filePath, modes: LEARNING_MODES }
    } else if (result.ok) {
      const lstore = learningStore(activeAccount)
      try { lstore.syncLibrary(store.read()) } catch { /* 素材库为空时忽略 */ }
      learning = { ...viewOfLearning(lstore.read(), { limit: 200 }), filePath: lstore.filePath, modes: LEARNING_MODES }
    }

    return {
      ok: result.ok, code: result.code || null,
      reason: result.reason || result.error || null, nextAction: result.nextAction || null,
      added: result.added || 0, duplicates: result.duplicates || 0, fetched: result.fetched || 0,
      pages: result.pages || 0, reachedCap: result.reachedCap === true,
      collector: store.collectorState(),
      library: viewOf(store.read()), learning, review,
      classified: classified ? { ok: classified.ok !== false, aiCalls: classified.task?.aiCalls || 0, tokens: classified.task?.tokens || 0, processed: classified.task?.processed || 0, errors: classified.task?.errors || [] } : null,
      libraryFile: store.filePath,
      message: result.ok
        ? `新增 ${result.added || 0} 条评论，去重 ${result.duplicates || 0} 条${result.reachedCap ? '（已达页数上限，可继续收集）' : ''}`
        : `收集未完成：${result.reason || result.error || '未知原因'}`,
    }
  }))

  // P2-17B.2 点击卡片后才读取该评论的回复：默认只显示回复总数，点开才请求。
  // 校验候选、视频 ID、评论 ID；结果按「视频+评论」缓存去重，带状态（加载/空/失败/部分）。
  ipcMain.handle('discovery:batch-replies', async (_event, { id, cursor = 0, force = false } = {}) => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (!services || !accountId) return { ok: false, state: 'failed', error: '账号服务尚未就绪', replies: [] }
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const { ReplyReader, ReplyCache } = require('./discovery/reply-reader.cjs')
      const candidate = new CandidateManager(services.storage).get().candidates.find(c => c.id === id)
      if (!candidate) return { ok: false, state: 'failed', error: '找不到候选人', replies: [] }
      const source = (candidate.sources || [])[0] || candidate.source || {}
      const checked = ReplyReader.validate({ videoId: source.videoId, commentId: source.commentId })
      if (!checked.ok) {
        const preset = require('./discovery/reply-reader.cjs').ERROR_CODES[checked.code]
        return { ok: false, state: 'failed', code: checked.code, error: preset?.label || '无法读取该评论的回复', retryable: false, replies: [], videoId: checked.videoId || null, commentId: checked.commentId || null }
      }
      const cache = new ReplyCache(path.join(accountRoot(), accountId, 'reply-cache.json'))
      const reader = new ReplyReader({
        cache,
        // 没有抖音服务时只读缓存：绝不假装读到了页面上的实时回复。
        transport: services.douyin
          ? { readReplies: payload => {
            if (!services.commentCollection) services.commentCollection = new CommentCollectionService(services.douyin, { accountId })
            const transport = services.commentCollection.createTransport({})
            return transport.readReplies(payload)
          } }
          : null,
      })
      const result = await reader.read({ videoId: checked.videoId, commentId: checked.commentId }, { cursor, force })
      return { ...result, videoId: checked.videoId, commentId: checked.commentId }
    } catch (error) { return { ok: false, state: 'failed', code: 'ERROR', error: String(error?.message || error), replies: [] } }
  })

  // ===== P2-17B 批次寻找：三来源、固定目标、可暂停恢复、Mock 发送 =====

  // P2-17B.4 批次结束后的真实联系：训练模式不动作；正式模式按配置执行，默认单批只发 1 人试水。
  const batchAutoContact = async (services, accountId, batch) => {
    try {
      if (!services?.friendship || !accountId || !batch) return null
      const store = libraryStore(accountId)
      const state = store.autoContactState()
      const skip = (code, reason) => ({ ok: false, code, reason, results: [], followed: 0 })
      if (state.mode !== 'auto') return skip('TRAINING_MODE', '训练模式不自动联系，请在卡片上逐人确认')
      if (!state.riskAcceptedAt) return skip('RISK_CONFIRM_REQUIRED', '正式模式尚未完成风险确认')
      if (!state.config.autoFollow) return skip('AUTO_FOLLOW_DISABLED', '未开启“允许自动关注”')
      const today = new Date().toISOString().slice(0, 10)
      const sameDay = state.budget?.day === today
      const usedFollows = sameDay && Number.isFinite(state.budget?.realFollows) ? state.budget.realFollows : 0
      const usedMessages = sameDay && Number.isFinite(state.budget?.realMessages) ? state.budget.realMessages : 0
      const followLeft = Math.max(0, state.config.dailyFollowLimit - usedFollows)
      const messageLeft = Math.max(0, state.config.dailyFirstMessageLimit - usedMessages)
      const limit = Math.min(Number(state.config.batchAutoLimit) || 0, followLeft, messageLeft)
      if (limit <= 0) return skip('DAILY_LIMIT_REACHED', `今日真实额度已用尽（关注 ${usedFollows}/${state.config.dailyFollowLimit}，首句 ${usedMessages}/${state.config.dailyFirstMessageLimit}）`)
      const { pickBatchTargets, intentLevelOf, skippableIdentityFailure } = require('./discovery/batch-contact.cjs')
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const manager = new CandidateManager(services.storage)
      const contactedIds = ((services.storage.get()?.contacts) || []).map(contact => contact.profile?.platformUserId).filter(Boolean)
      const minIntent = intentLevelOf(state.config.autoMinIntent)
      // 只要还有结果待核实的人，整批自动联系都暂停：与 P2-16「UNCERTAIN_NEEDS_REVIEW」一致，
      // 不确定的外发状态下不对任何新对象继续动手，避免重复发送或连环失败。
      const pendingReview = (manager.get().candidates || []).filter(c => c?.action?.needsReview === true || c?.review?.realContact?.needsReview === true)
      if (pendingReview.length) {
        const summary = { ok: false, code: 'UNCERTAIN_NEEDS_REVIEW', reason: `${pendingReview.length} 人上一次发送结果待核实，已暂停全部自动联系，请先人工核对并解除标记`, results: [], skipped: [], followed: 0, messaged: 0, at: new Date().toISOString(), limit: 0 }
        try { services.discoveryBatch?.save?.({ autoContact: summary }) } catch { /* 批次已变化 */ }
        return summary
      }
      const { targets, skipped } = pickBatchTargets(batch, manager.get().candidates, { limit, contactedIds, minIntent })
      const results = []
      // 逐个串行执行：一个失败立刻停，避免连续触发风控。
      for (const candidate of targets) {
        // 无人值守时不能因为"首句没预生成成功"就整批放弃：这里现场补一次。
        const goalEntry = batch.targetSnapshot && batch.added.find(entry => entry.candidateId === candidate.id && entry.goalMatch)
        let text = goalEntry?.draftOpening || ''
        if (!text && (goalEntry || !candidate?.review?.draftOpening)) {
          try {
            const input = goalEntry
              ? batchOpeningInput(candidate, batch, goalEntry)
              : { url: candidate.profileUrl, name: candidate.nickname, commentText: candidate.firstComment, videoTitle: '' }
            const draft = await services.friendship.approachPreview(input)
            text = String(draft?.text || '').trim()
          } catch (error) {
            results.push({ ok: false, code: 'OPENING_EMPTY', reason: `首句生成失败：${String(error?.message || error).slice(0, 160)}`, candidateId: candidate.id, name: candidate.nickname, platformUserId: candidate.platformUserId })
            break
          }
        }
        const { executeBatchContact } = require('./discovery/batch-contact-service.cjs')
        const result = await executeBatchContact({ manager, store, candidate, friendship: services.friendship, contactedIds, minIntent, text })
        results.push(result)
        if (skippableIdentityFailure(result)) {
          skipped.push({ candidateId: candidate.id, nickname: candidate.nickname, code: result.code, reason: result.reason })
          if (result.followStatus === 'not_followed') {
            const next = skipped.findIndex(item => item.code === 'OVER_LIMIT')
            if (next >= 0) {
              const replacement = skipped.splice(next, 1)[0]
              const fresh = manager.get().candidates.find(item => item.id === replacement.candidateId)
              if (fresh) targets.push(fresh)
            }
          }
          continue
        }
        if (!result.ok || result.needsReview) break
      }
      const done = results.filter(item => item.ok)
      const followed = results.filter(item => item.followStatus === 'confirmed').length
      const messaged = results.filter(item => item.messageStatus === 'sent').length
      // 一个都没执行时要说明原因（否则界面只显示"成功 0 人"，看不出是人不够还是被红线挡了）。
      const identitySkipped = results.filter(skippableIdentityFailure)
      const firstFail = results.find(item => !item.ok && !skippableIdentityFailure(item)) || null
      const firstSkip = skipped.find(item => !['PROFILE_NAME_MISMATCH', 'NICKNAME_UNREADABLE', 'ACCOUNT_ID_MISMATCH', 'PAGE_NOT_READY'].includes(item.code)) || null
      const code = done.length ? null : (firstFail?.code || (identitySkipped.length ? 'IDENTITY_SKIPPED' : firstSkip?.code || 'NO_ELIGIBLE_TARGET'))
      const reason = done.length ? '' : (firstFail?.reason
        || (identitySkipped.length ? `本批 ${identitySkipped.length} 人页面或账号身份未核实，已分别跳过；没有提交第一句` : '')
        || (firstSkip ? `本批没有符合自动联系条件的人：${firstSkip.nickname || firstSkip.candidateId}（${firstSkip.reason || firstSkip.code}）` : '本批没有新增候选，未执行自动联系'))
      const summary = { ok: done.length > 0, identitySkipped: identitySkipped.length, at: new Date().toISOString(), minIntent, limit, followed, messaged, results, skipped: skipped.slice(0, 20), ...(code ? { code, reason } : {}) }
      try { services.discoveryBatch?.save?.({ autoContact: summary }) } catch { /* 批次已变化 */ }
      return summary
    } catch (error) {
      return { ok: false, code: 'ERROR', reason: String(error?.message || error), results: [], followed: 0 }
    }
  }

  const customGoalStore = accountId => {
    const { CustomGoalStore } = require('./discovery/custom-goals.cjs')
    return new CustomGoalStore(path.join(accountRoot(), accountId))
  }
  const batchRunnerOf = (accountId, services, { create = false, sampling = false } = {}) => {
    if (!services || !accountId) return null
    const slot = sampling ? 'discoverySampling' : 'discoveryBatch'
    if (!services[slot] && create) {
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const library = libraryStore(accountId)
      const manager = new CandidateManager(services.storage)
      const favoritesOwner = Symbol('batch-favorites')
      const runner = new BatchRunner({
        enableVideoRounds: true,
        crossVideoClassification: true,
        retainIntentPool: true,
        observeComments: () => learningStore(accountId).syncLibrary(library.read()),
        goalStore: customGoalStore(accountId),
        ...(sampling ? { stateKey: "goalSampling" } : {}),
        manager,
        storage: services.storage,
        accountId,
        engine: services.discovery,
        checkVerification: () => services.discovery.checkBatchVerification([
          { win: services.commentCollection?.window, source: '收集评论窗口' },
          { win: services.favoritesSync?.window, source: '收藏夹窗口' },
        ]),
        libraryStore: library,
        accountServices: services,
        ai: services.ai,
        collectorFactory: () => {
          if (!services.commentCollection) services.commentCollection = new CommentCollectionService(services.douyin, { accountId })
          const store = libraryStore(accountId)
          const transport = services.commentCollection.createTransport({})
          return new CommentCollector({ store, transport })
        },
        // 收藏夹来源直接用现有同步服务进用户收藏夹读取：与手动同步同一条链路（只读页面可见作品）。
        cancelFavorites: () => services.favoritesSync?.stop(favoritesOwner),
        syncFavorites: async ({ onProgress } = {}) => {
          if (activeAccount !== accountId) return { ok: false, code: 'ACCOUNT_CHANGED', reason: '账号已切换，请切回原账号后同步收藏夹' }
          const ctx = ensureFavoritesSync()
          if (!ctx || ctx.accountId !== accountId) return { ok: false, code: 'NO_TRANSPORT', reason: '账号服务尚未就绪或账号已切换' }
          const folderName = String(ctx.store.favoritesState().folderName || '').trim()
          if (!folderName) return { ok: false, code: 'CONFIG_MISSING', nextAction: '请在「高级 → 收藏夹来源」填写与抖音里完全一致的收藏夹名称并保存（只需设置一次）' }
          try { return await ctx.favoritesSync.run({ folderName, maxScrolls: 30, maxVideos: 100, resume: true, ownerToken: favoritesOwner, onProgress }) }
          catch (error) { return { ok: false, code: 'SYNC_FAILED', reason: String(error?.message || error) } }
        },
        prepareClassification: () => {
          const lstore = learningStore(accountId)
          const keys = lstore.read().samples.filter(sample => sample.human?.intent && !sample.excluded).map(sample => sample.key)
          const { writeBackClassification } = require('./discovery/library-classify-bridge.cjs')
          writeBackClassification({ libraryStore: library, learningStore: lstore, keys, preferHuman: true })
        },
        classify: async (keys, maxCalls) => {
          const lstore = learningStore(accountId)
          lstore.syncLibrary(library.read())
          const result = await runCommentLearning({ learningStore: lstore, libraryStore: library, ai: services.ai,
            mode: 'model_cases', recallFirst: true, scope: 'keys', keys, maxCalls: Math.max(1, Math.min(6, Number(maxCalls) || 3)), batchSize: 50 })
          // 分类结果写回素材库评论：批次的价值判断与候选生成都读 comment.classification，
          // 只写学习库会让试采价值恒为 0、候选也建不出来。
          try {
            const { writeBackClassification } = require('./discovery/library-classify-bridge.cjs')
            writeBackClassification({ libraryStore: library, learningStore: lstore, keys })
          } catch { /* 回写失败不阻断批次，候选会因缺分类被跳过 */ }
          syncLibraryCandidates(services, { accountId, store: library })
          return { aiCalls: result?.task?.aiCalls || 0, tokens: result?.task?.tokens || 0 }
        },
        // 预生成首句：复用现有开场生成，不改 Simple V3 与生成参数。
        openingPolicy: () => require('./opening-requirements.cjs').openingPolicyOf(services.storage.get()),
        draftOpening: (_candidate, input) => services.friendship?.approachPreview(input),
        emit: () => { try { mainWindow?.webContents.send('douyin:event', { type: sampling ? 'discovery_goal_sample' : 'discovery_batch', payload: { batch: runner.state }, accountId }) } catch { /* 窗口已关闭 */ } },
        // 批次正常结束后的真实联系（训练模式在内部直接跳过）。
        onBatchDone: batch => batchAutoContact(services, accountId, batch),
      })
      services[slot] = runner
      runner.recoverOnBoot()
    }
    if (services[slot] && services.discovery) services[slot].deps.engine = services.discovery
    return services[slot] || null
  }

  ipcMain.handle('discovery:sync-intent-pool', guarded(async () => {
    const entry = getActiveServices()
    if (!entry || !activeAccount) return { ok: false, error: '没有活动账号' }
    return syncLibraryCandidates(entry, { accountId: activeAccount, store: libraryStore(activeAccount) })
  }))
  ipcMain.handle('discovery:clear-list', guarded(async ({ scope, confirmed, accountId } = {}) => {
    const entry = getActiveServices()
    if (!entry || !activeAccount || accountId !== activeAccount) return { ok: false, error: '账号已切换，请刷新后重试' }
    const { CandidateManager } = require('./discovery/candidate-manager.cjs')
    const { clearDiscoveryList } = require('./discovery/discovery-lists.cjs')
    const store = libraryStore(activeAccount)
    const busy = entry.discoveryBatch?.running || entry.discoverySampling?.running || entry.discoveryTaskRunning || entry.discovery?.running || entry.discovery?.busy
      || entry.discoveryPipeline?.running || entry.discoveryListsModelRunning || entry.contactEngine?.running
      || entry.friendship?.busy || entry.commentCollection?.running || entry.contactEngine?.config?.().enabled
      || ['running','syncing','collecting','classifying'].includes(store.collectorState?.().status)
      || ['running','syncing','collecting','classifying'].includes(store.pipelineState?.().status)
      || store.autoContactState().status === 'running'
    const result = clearDiscoveryList({ scope, confirmed, manager: new CandidateManager(entry.storage), libraryStore: store, learningStore: learningStore(activeAccount), busy })
    return { ...result, learning: learningView(learningStore(activeAccount)) }
  }))
  ipcMain.handle('discovery:filter-intent-pool', guarded(async ({ filters = {}, accountId, goal = null } = {}) => {
    const entry = getActiveServices()
    if (!entry || accountId !== activeAccount) return { ok: false, error: '账号已切换，请刷新后重试' }
    const { CandidateManager } = require('./discovery/candidate-manager.cjs')
    const { filterIntentPool } = require('./discovery/discovery-lists.cjs')
    if (goal && !customGoalStore(accountId).view().goals.some(item => item.id === goal.id && item.versions.some(v => v.version === goal.version))) return { ok: false, error: '寻找目标已变化，请刷新后筛选' }
    return filterIntentPool(new CandidateManager(entry.storage), filters, goal)
  }))

  ipcMain.handle('discovery:goal', guarded(async ({ action, accountId, id = null, version, name, description, openingInstructions, key, label, reason } = {}) => {
    if (!activeAccount || accountId !== activeAccount) return { ok: false, error: '账号已切换，请刷新后再操作' }
    const store = customGoalStore(accountId)
    try {
      if (action === 'save') return { ok: true, ...store.setGoal({ id, name, description, openingInstructions }) }
      if (action === 'select') return { ok: true, ...store.select(id) }
      if (action === 'annotate') store.review({ id, version }, key, label, reason)
      if (action === 'samples' || action === 'annotate') {
        const view = store.view()
        if (!view.goals.some(goal => goal.id === id && goal.versions.some(item => item.version === version))) {
          return { ok: false, error: '找不到此目标版本' }
        }
        const sampler = batchRunnerOf(accountId, getActiveServices(), { sampling: true, create: true })
        return { ok: true, ...view, ...store.samples({ id, version }), sampling: sampler?.state || null }
      }
      if (action === 'stop-sampling' || action === 'resume-sampling') {
        const services = getActiveServices()
        const sampler = batchRunnerOf(accountId, services, { sampling: true, create: true })
        if (!sampler?.state) return { ok: false, error: '没有采样任务' }
        if (action === 'stop-sampling') sampler.stop()
        else {
          if (services.discoveryBatch?.running || ['running', 'paused', 'interrupted'].includes(services.discoveryBatch?.state?.status)) {
            return { ok: false, error: '请先结束寻找批次' }
          }
          if (sampler.running || !['paused', 'interrupted'].includes(sampler.state.status)) return { ok: false, error: '当前采样无法继续' }
          sampler.resume().catch(() => {})
        }
        return { ok: true, ...store.view() }
      }
      if (action === 'view') return { ok: true, ...store.view() }
      return { ok: false, error: '不支持的目标操作' }
    } catch (error) { return { ok: false, error: error.message } }
  }))

  ipcMain.handle('discovery:batch-status', async () => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (!services) return { ok: false, error: '账号服务尚未就绪' }
      // 重启后批次还在存储里：必须把 runner 建起来，否则界面读不到上次批次（只能看到空白面板）。
      let hasStoredBatch = false
      try { hasStoredBatch = Boolean(services.storage?.get?.()?.discovery?.batch) } catch { hasStoredBatch = false }
      const runner = batchRunnerOf(accountId, services, { create: hasStoredBatch })
      const favorites = libraryStore(accountId).favoritesState()
      const result = runner ? runner.status() : { ok: true, batch: null, cards: [] }
      return { ...result, favoritesFolder: favorites.folderName || '' }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  ipcMain.handle('discovery:batch-start', async (_event, payload = {}) => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (!services) return { ok: false, error: '账号服务尚未就绪' }
      if (!services.discovery) return { ok: false, error: '发现服务尚未就绪，请稍后再试' }
      const sampleOnly = payload.sampleOnly === true
      const other = batchRunnerOf(accountId, services, { create: true, sampling: !sampleOnly })
      if (other.running || ['running', 'paused', 'interrupted'].includes(other.state?.status)) {
        return { ok: false, error: sampleOnly ? '请先结束或停止现有寻找批次' : '请先结束或停止人工标注采样' }
      }
      const runner = batchRunnerOf(accountId, services, { create: true, sampling: sampleOnly })
      const config = normalizeBatchConfig(payload)
      // 先返回状态，批次在后台跑；界面通过事件与轮询拿进度。
      if (runner.running || ['running', 'paused'].includes(runner.state?.status)) {
        return { ok: false, error: '请先结束或停止现有批次' }
      }
      if (!config.sources.keywords.length && !config.sources.tags.length && !config.sources.favorites) {
        return { ok: false, error: '请先在寻找设置中选择来源' }
      }
      let targetSnapshot = null
      if (payload.goal || sampleOnly) {
        if (payload.accountId !== accountId || !payload.goal?.id) return { ok: false, error: '请先选择当前账号的自定义目标' }
        if (runner.state?.status === 'interrupted') return { ok: false, error: '请先继续或停止上一个批次' }
        targetSnapshot = customGoalStore(accountId).freeze(payload.goal.id, payload.goal.version)
      }
      const started = runner.start(config, { targetSnapshot, sampleOnly })
      started.catch(() => {})
      return { ok: true, batch: runner.state }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  ipcMain.handle('discovery:batch-pause', async () => {
    try { const runner = batchRunnerOf(activeAccount, getActiveServices()); if (!runner) return { ok: false, error: '没有批次' }
      return { ok: true, batch: runner.pause() } } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  ipcMain.handle('discovery:batch-resume', async () => {
    try { const runner = batchRunnerOf(activeAccount, getActiveServices()); if (!runner) return { ok: false, error: '没有批次' }
      runner.resume().catch(() => {})
      return { ok: true, batch: runner.state } } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  ipcMain.handle('discovery:batch-stop', async () => {
    try { const runner = batchRunnerOf(activeAccount, getActiveServices()); if (!runner) return { ok: false, error: '没有批次' }
      return { ok: true, batch: runner.stop() } } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  // 单张卡片补生成首句（批次内预生成失败或用户想换一版）
  ipcMain.handle('discovery:batch-draft', async (_event, { id, batchId, goal: requestedGoal, accountId: requestedAccount } = {}) => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (requestedAccount !== undefined && requestedAccount !== accountId) return { ok: false, error: '账号已切换，请重新操作' }
      if (!services?.friendship) return { ok: false, error: '交友服务尚未就绪' }
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const manager = new CandidateManager(services.storage)
      const candidate = manager.get().candidates.find(c => c.id === id)
      if (!candidate) return { ok: false, error: '找不到候选人' }
      if (candidate.accountId && candidate.accountId !== accountId) return { ok: false, error: '候选人不属于当前账号' }
      const runner = batchId ? batchRunnerOf(accountId, services, { create: true }) : null
      const batch = runner?.state
      if (batchId && batch?.id !== batchId) throw new Error('批次已切换，请刷新候选卡')
      const row = batch?.added?.find(entry => entry.candidateId === id)
      if (batchId && !row) throw new Error('该候选人已不在本批')
      const globalGoalInput = requestedGoal ? require('./discovery/custom-goals.cjs').candidateGoalOpeningInput(customGoalStore(accountId), candidate, requestedGoal) : null
      const draft = await services.friendship.approachPreview(globalGoalInput || batchOpeningInput(candidate, batch, row))
      if (activeAccount !== accountId || getActiveServices() !== services || (batchId && runner.state?.id !== batchId)) {
        throw new Error('账号或批次已切换，本次首句未保存')
      }
      if (globalGoalInput) return { ok: true, text: draft.text }
      if (batch?.targetSnapshot && row?.goalMatch) {
        if (!runner.saveGoalDraft(batch.id, id, draft.text, { replace: true })) throw new Error('候选卡已变化，本次首句未保存')
      } else {
        manager.patch(id, { review: { draftOpening: draft.text } })
      }
      return { ok: true, text: draft.text }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  // Mock 发送：只绑定账号/候选/最终文本并返回模拟结果，不触发任何真实关注或私信。
  ipcMain.handle('discovery:batch-send-mock', async (_event, { id, text = '' } = {}) => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (!services || !accountId) return { ok: false, error: '没有活动账号' }
      const finalText = String(text || '').trim()
      if (!finalText) return { ok: false, error: '首句不能为空' }
      if (finalText.length > 300) return { ok: false, error: '首句超过 300 字' }
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const manager = new CandidateManager(services.storage)
      const discovery = manager.get()
      const candidate = discovery.candidates.find(c => c.id === id)
      if (!candidate) return { ok: false, error: '找不到候选人' }
      if (candidate.accountId && candidate.accountId !== accountId) return { ok: false, error: '候选人不属于当前账号' }
      const crypto = require('node:crypto')
      const mock = {
        mock: true, accountId, candidateId: candidate.id, platformUserId: candidate.platformUserId,
        name: candidate.nickname, text: finalText, textHash: crypto.createHash('sha256').update(finalText).digest('hex').slice(0, 16),
        at: new Date().toISOString(), realActions: 0,
        steps: [
          { step: '关注', status: 'simulated', note: 'Dry Run：未调用真实关注接口' },
          { step: '发送第一句', status: 'simulated', note: 'Dry Run：未调用真实私信接口' },
        ],
      }
      candidate.review = { ...candidate.review, mockSend: mock }
      manager.save(discovery)
      return { ok: true, mock }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  // P2-17B.4 单张卡片的真实执行：真实关注 + 真实发送第一句（训练模式下点按钮即执行，需二次确认）。
  ipcMain.handle('discovery:batch-contact', async (_event, { id, text = '', confirmed = false, accountId: requestedAccount, origin, goal: requestedGoal } = {}) => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (requestedAccount !== undefined && requestedAccount !== accountId) return { ok: false, error: '账号已切换，请重新操作' }
      if (!services?.friendship) return { ok: false, error: '交友服务尚未就绪' }
      if (confirmed !== true) return { ok: false, code: 'CONFIRM_REQUIRED', error: '真实关注并发送需要本次确认' }
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const manager = new CandidateManager(services.storage)
      const candidate = manager.get().candidates.find(c => c.id === id)
      if (!candidate) return { ok: false, error: '找不到候选人' }
      if (candidate.accountId && candidate.accountId !== accountId) return { ok: false, error: '候选人不属于当前账号' }
      const { intentLevelOf } = require('./discovery/batch-contact.cjs')
      const { executeBatchContact } = require('./discovery/batch-contact-service.cjs')
      const store = libraryStore(accountId)
      const minIntent = intentLevelOf(store.autoContactState().config.autoMinIntent)
      const matchedGoal = origin === 'workspace' && requestedGoal ? require('./discovery/custom-goals.cjs').candidateGoalOpeningInput(customGoalStore(accountId), candidate, requestedGoal) : null
      if (origin === 'workspace' && (candidate.status === 'REJECTED' || ['REJECTED', 'EXCLUDED'].includes(candidate.discoveryStatus) || (!matchedGoal && !['EXPLICIT_INVITATION', 'SEEKING_FRIENDS', 'CONTEXTUAL_INTEREST'].includes(candidate.libraryIntent)))) return { ok: false, error: '该候选已排除或意愿不符合，请先核对候选资料' }
      const result = await executeBatchContact({ manager, store, candidate, friendship: services.friendship, text, minIntent, manual: true })
      return { ok: result.ok, contact: result, candidate: manager.get().candidates.find(c => c.id === id), error: result.ok ? undefined : result.reason }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  ipcMain.handle('discovery:batch-contact-review', async (_event, { id, conclusion = 'checked' } = {}) => {
    try {
      const services = getActiveServices()
      if (!services) return { ok: false, error: '账号服务尚未就绪' }
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const { reviewBatchContact } = require('./discovery/batch-contact-service.cjs')
      return reviewBatchContact({ manager: new CandidateManager(services.storage), store: libraryStore(activeAccount), id, conclusion })
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  ipcMain.handle('discovery:batch-not-interested', async (_event, { id } = {}) => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (!services) return { ok: false, error: '账号服务尚未就绪' }
      const runner = batchRunnerOf(accountId, services)
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const manager = new CandidateManager(services.storage)
      const discovery = manager.get()
      const candidate = discovery.candidates.find(c => c.id === id)
      if (!candidate) return { ok: false, error: '找不到候选人' }
      runner?.skipAccount(candidate.platformUserId, 'not_interested')
      const batch = runner?.state
      if (batch) runner.save({ added: (batch.added || []).filter(x => x.candidateId !== id) })
      // 候选池列表按审核状态过滤：只打 notInterestedAt 标记的话，人还会留在「待审核」列表里。
      // 统一走 review(REJECTED)——从候选池移除、撤销私信同意、阻断自动关注；去重记录由 skipAccount 保留。
      try { manager.review(id, { status: 'REJECTED', note: '不感兴趣（批次内人工排除）' }) } catch { /* 已进入联系流程时只保留不感兴趣标记 */ }
      // skipAccount/review 已经各自写过存储；这里必须重新读一次再保存，
      // 否则用旧快照会把刚写入的去重记录覆盖掉（下批又会推荐同一个人）。
      const latest = manager.get()
      const target = latest.candidates.find(c => c.id === id)
      if (!target) return { ok: false, error: '找不到候选人' }
      target.review = { ...target.review, notInterestedAt: new Date().toISOString() }
      manager.save(latest)
      return { ok: true, candidate: target }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  // 清空本批：保留去重记录（下批不再推荐），不删除聊天历史、联系人与人工标签。
  ipcMain.handle('discovery:batch-clear', async () => {
    try {
      const services = getActiveServices(), accountId = activeAccount
      if (!services) return { ok: false, error: '账号服务尚未就绪' }
      const runner = batchRunnerOf(accountId, services)
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      const manager = new CandidateManager(services.storage)
      const discovery = manager.get()
      const batch = runner?.state
      const ids = new Set((batch?.added || []).map(x => x.platformUserId))
      const list = Array.isArray(discovery.batchExcluded) ? discovery.batchExcluded : []
      const merged = [...list]
      for (const platformUserId of ids) if (!merged.some(x => x.platformUserId === platformUserId)) merged.push({ platformUserId, reason: 'cleared_batch', at: new Date().toISOString() })
      manager.save({ ...discovery, batchExcluded: merged })
      if (runner) runner.save({ added: [], status: 'done', finishedAt: new Date().toISOString(), reason: '本批已清空（保留去重记录）' })
      return { ok: true, cleared: ids.size }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  })

  // P2-11A 收藏夹同步：只读已登录页面当前可见的作品，按作品 ID 去重后增量入库。
  // 没有确认到指定收藏夹时直接失败，绝不把全部收藏当成交友视频；不关注、不发私信。
  const ensureFavoritesSync = () => {
    const accountId = activeAccount
    const services = getActiveServices()
    if (!services || !accountId) return null
    const store = libraryStore(accountId)
    if (!services.favoritesSync) {
      services.favoritesSync = new FavoritesSyncService(services.douyin, {
        accountId,
        store,
        onProgress: favorites => {
          try { mainWindow?.webContents.send('douyin:event', { type: 'library_favorites', payload: { favorites }, accountId }) } catch { /* 窗口已关闭 */ }
        },
      })
      // 应用重启后把遗留的“同步中”标记为可恢复的中断。
      services.favoritesSync.markInterrupted()
    }
    services.favoritesSync.store = store
    return { accountId, services, store, favoritesSync: services.favoritesSync }
  }

  // P2-12E：收藏夹名称单独保存，避免“已填写但未同步”导致自动任务误报配置缺失。
  ipcMain.handle('library:set-favorites-folder', guarded(async ({ folderName = '' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const ctx = ensureFavoritesSync()
    if (!ctx) return { ok: false, error: '账号服务尚未就绪' }
    const name = String(folderName || '').trim().slice(0, 80)
    if (!name) return { ok: false, code: 'CONFIG_MISSING', reason: '收藏夹名称不能为空', favorites: ctx.store.favoritesState() }
    const favorites = ctx.store.setFavorites({ folderName: name })
    return { ok: true, favorites, library: viewOf(ctx.store.read()), message: `已保存收藏夹名称：${name}` }
  }))
  ipcMain.handle('library:sync-favorites', guarded(async ({ folderName = '', maxScrolls = 120, maxVideos = 500, resume = false } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const ctx = ensureFavoritesSync()
    if (!ctx) return { ok: false, error: '账号服务尚未就绪' }
    const { store, favoritesSync } = ctx
    const name = String(folderName || '').trim().slice(0, 80)
    if (!name) return { ok: false, code: 'CONFIG_MISSING', reason: '请先填写并保存收藏夹名称', favorites: store.favoritesState(), library: viewOf(store.read()) }
    try {
      const result = await favoritesSync.run({ folderName: name, maxScrolls, maxVideos, resume: resume === true })
      // 手动同步也记入每日预算，避免自动任务重复消耗当日同步次数。
      try { ensureDiscoveryScheduler()?.accountManualSync(result) } catch { /* 记账失败不影响同步结果 */ }
      return { ...result, library: viewOf(store.read()), favorites: store.favoritesState(), libraryFile: store.filePath }
    } catch (error) {
      const favorites = store.setFavorites({
        status: 'failed', code: 'NETWORK_ERROR', phase: '',
        lastError: String(error?.message || error), nextAction: '请稍后重新同步；已读到的作品不会重复收录',
        finishedAt: new Date().toISOString(),
      })
      return { ok: false, code: 'NETWORK_ERROR', reason: String(error?.message || error), favorites, library: viewOf(store.read()), libraryFile: store.filePath }
    }
  }))

  // P2-11B 自动评论处理流水线：只处理收藏夹来源视频；逐视频状态持久化，支持暂停/恢复/重试。
  // 读取通道复用已登录的评论收集窗口；遇到登录/验证/限频会停止，不绕过。
  const ensureDiscoveryPipeline = () => {
    const services = getActiveServices()
    if (!services) return null
    const accountId = activeAccount
    const store = libraryStore(accountId)
    if (!services.commentCollection) services.commentCollection = new CommentCollectionService(services.douyin, { accountId })
    if (!services.discoveryPipeline) {
      services.discoveryPipeline = new DiscoveryPipeline({
        store,
        learningStore: learningStore(accountId),
        ai: services.ai,
        accountId,
        onProgress: pipeline => {
          try { mainWindow?.webContents.send('douyin:event', { type: 'discovery_pipeline', payload: { pipeline }, accountId }) } catch { /* 窗口已关闭 */ }
        },
      })
      // 应用重启后把遗留的“处理中”恢复成可继续的中断状态。
      services.discoveryPipeline.recover()
    }
    const pipeline = services.discoveryPipeline
    pipeline.store = store
    pipeline.learningStore = learningStore(accountId)
    pipeline.ai = services.ai
    pipeline.accountId = accountId
    pipeline.transportFactory = () => services.commentCollection.createTransport({})
    // P2-11C：每轮结束后把新出现的合规意愿自动合并进候选池；不自动发第一条消息。
    pipeline.syncCandidates = () => syncLibraryCandidates(services, { accountId, store })
    return pipeline
  }

  // P2-12B 调度器：复用已验证的收藏夹同步与自动分析，只负责时间、开关、预算和失败退避。
  // 每个账号独立一个实例；切换账号或停止账号服务时会停掉旧账号的定时器。
  const ensureDiscoveryScheduler = () => {
    const services = getActiveServices()
    const accountId = activeAccount
    if (!services || !accountId) return null
    const store = libraryStore(accountId)
    if (!services.discoveryScheduler) {
      services.discoveryScheduler = new DiscoveryScheduler({
        store,
        syncFavorites: async () => {
          const ctx = ensureFavoritesSync()
          if (!ctx) return { ok: false, code: 'NO_TRANSPORT', reason: '账号服务尚未就绪' }
          const folderName = String(ctx.store.favoritesState().folderName || '').trim()
          if (!folderName) return { ok: false, code: 'CONFIG_MISSING', reason: '尚未设置收藏夹名称，请先在 B 区填写并保存' }
          try {
            const result = await ctx.favoritesSync.run({ folderName, maxScrolls: 120, maxVideos: 500, resume: true })
            return result || { ok: false, code: 'SYNC_FAILED', reason: '收藏夹同步无返回' }
          } catch (error) {
            return { ok: false, code: 'NETWORK_ERROR', reason: String(error?.message || error) }
          }
        },
        runPipeline: async (options = {}) => {
          if (services.discoveryTaskRunning) return { ok: false, status: 'blocked', code: 'DISCOVERY_RUNNING', message: '已有发现任务在运行', aiCalls: 0, tokens: 0, remaining: 1 }
          const pipeline = ensureDiscoveryPipeline()
          if (!pipeline) return { ok: false, status: 'blocked', code: 'NO_TRANSPORT', message: '账号服务尚未就绪', aiCalls: 0, tokens: 0, remaining: 1 }
          services.discoveryTaskRunning = true
          try {
            const result = await pipeline.run({ ...options, retryFailed: false })
            return result
          } finally {
            services.discoveryTaskRunning = false
          }
        },
        pendingCount: () => {
          const pipeline = services.discoveryPipeline
          if (!pipeline) return 0
          try { return pipeline.selectQueue().length } catch { return 0 }
        },
        isBusy: () => Boolean(services.discoveryTaskRunning) || Boolean(services.discoveryPipeline?.running),
        emit: scheduler => {
          try { mainWindow?.webContents.send('douyin:event', { type: 'discovery_scheduler', payload: { scheduler }, accountId }) } catch { /* 窗口已关闭 */ }
        },
        logger: message => {
          try { services.storage?.addLog?.({ type: 'discovery_scheduler', message: String(message).slice(0, 300) }) } catch { /* 日志失败不影响调度 */ }
        },
      })
    }
    services.discoveryScheduler.store = store
    services.discoveryScheduler.accountId = accountId
    return services.discoveryScheduler
  }

  bootDiscoveryScheduler = () => {
    // Release preview uses the batch workflow. Preserve saved legacy switches
    // for inspection, without recovering tasks or starting their old timer.
    if (!activeAccount) return null
    return { state: libraryStore(activeAccount).pipelineState().scheduler }
  }

  ipcMain.handle('library:scheduler-get', guarded(async () => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const scheduler = ensureDiscoveryScheduler()
    if (!scheduler) return { ok: false, error: '账号服务尚未就绪' }
    const store = libraryStore(activeAccount)
    return { ok: true, scheduler: scheduler.summary(), pipeline: store.pipelineState(), favorites: store.favoritesState(), library: viewOf(store.read()) }
  }))

  ipcMain.handle('library:scheduler-set', guarded(async ({ autoSync, autoAnalyze, syncIntervalHours, analyzeIntervalMinutes, limits } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const scheduler = ensureDiscoveryScheduler()
    if (!scheduler) return { ok: false, error: '账号服务尚未就绪' }
    const state = scheduler.configure({ autoSync, autoAnalyze, syncIntervalHours, analyzeIntervalMinutes, limits })
    return { ok: true, scheduler: scheduler.summary(), message: state.autoSync || state.autoAnalyze ? '自动任务已开启' : '自动任务已关闭' }
  }))

  ipcMain.handle('library:scheduler-pause', guarded(async () => {
    const scheduler = ensureDiscoveryScheduler()
    if (!scheduler) return { ok: false, error: '账号服务尚未就绪' }
    const state = scheduler.pause()
    return { ok: true, scheduler: scheduler.summary(), message: state.nextAction }
  }))

  ipcMain.handle('library:scheduler-resume', guarded(async () => {
    const scheduler = ensureDiscoveryScheduler()
    if (!scheduler) return { ok: false, error: '账号服务尚未就绪' }
    const state = scheduler.resume()
    return { ok: true, scheduler: scheduler.summary(), message: state.nextAction }
  }))

  ipcMain.handle('library:scheduler-stop', guarded(async () => {
    const scheduler = ensureDiscoveryScheduler()
    if (!scheduler) return { ok: false, error: '账号服务尚未就绪' }
    scheduler.pause('用户停止自动任务')
    const state = scheduler.stop()
    return { ok: true, scheduler: scheduler.summary(), message: state.nextAction }
  }))

  ipcMain.handle('library:scheduler-run-now', guarded(async ({ kind = 'all' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const scheduler = ensureDiscoveryScheduler()
    if (!scheduler) return { ok: false, error: '账号服务尚未就绪' }
    const result = await scheduler.tick({ forceSync: kind !== 'analyze', forceAnalyze: kind !== 'sync' })
    return { ok: true, scheduler: scheduler.summary(), result, library: viewOf(libraryStore(activeAccount).read()) }
  }))

  // P2-11E 统一入口：同步指定收藏夹 + 自动分析，一次启动走完“收藏 → 评论 → 意愿 → 候选”。
  // 任务预算默认单次最多 10 个视频、12 次模型调用；达到后持久化状态，下一次任务继续，不空转。
  ipcMain.handle('library:run-discovery', guarded(async (payload = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const ctx = ensureFavoritesSync()
    if (!ctx) return { ok: false, error: '账号服务尚未就绪' }
    const { accountId, services, store, favoritesSync } = ctx
    // 同一账号禁止重复启动两个发现任务（同步与分析必须串行）。
    if (services.discoveryTaskRunning) {
      return { ok: false, code: 'DISCOVERY_RUNNING', error: '该账号已有发现任务在运行，请等待当前任务完成', favorites: store.favoritesState(), pipeline: store.pipelineState() }
    }
    const folderName = String(payload.folderName || store.favoritesState().folderName || '').trim().slice(0, 80)
    if (!folderName) return { ok: false, error: '请填写抖音收藏夹名称' }
    const pipeline = ensureDiscoveryPipeline()
    if (!pipeline) return { ok: false, error: '账号服务尚未就绪' }
    services.discoveryTaskRunning = true
    try {
      const sync = await favoritesSync.run({
        folderName,
        maxScrolls: payload.maxScrolls,
        maxVideos: payload.maxVideos,
        resume: payload.resumeSync === true,
      })
      const favorites = store.favoritesState()
      if (!sync?.ok) {
        // 收藏夹同步失败时不分析旧队列，避免把别的视频当成“本次新收藏”。
        return {
          ok: false, code: sync?.code || 'FAVORITES_SYNC_FAILED',
          error: sync?.reason || sync?.error || '收藏夹同步失败，未开始自动分析',
          favorites, pipeline: store.pipelineState(), library: viewOf(store.read()),
        }
      }
      try { ensureDiscoveryScheduler()?.accountManualSync(sync) } catch { /* 记账失败不影响同步结果 */ }
      const result = await pipeline.run({
        maxVideosPerRound: payload.maxVideosPerRound,
        maxCommentsPerVideo: payload.maxCommentsPerVideo,
        maxPagesPerVideo: payload.maxPagesPerVideo,
        maxAiCallsPerRound: payload.maxAiCallsPerRound,
        firstBatchComments: payload.firstBatchComments,
        secondBatchComments: payload.secondBatchComments,
        taskLimits: {
          maxVideos: payload.maxVideosPerTask ?? 10,
          maxAiCalls: payload.maxAiCallsPerTask ?? 12,
        },
        retryFailed: payload.retryFailed === true,
      })
      try { ensureDiscoveryScheduler()?.accountManualRun(result) } catch { /* 记账失败不影响分析结果 */ }
      const library = viewOf(store.read())
      return {
        ok: result.ok !== false,
        sync: { status: favorites.status, found: sync.found || 0, added: sync.added || 0, duplicates: sync.duplicates || 0, scrolls: sync.scrolls || 0, reachedCap: sync.reachedCap === true, lastSyncAt: favorites.lastSyncAt },
        favorites, library, pipeline: store.pipelineState(),
        learning: learningView(learningStore(accountId)),
        result,
        message: result.message || (result.ok ? '同步并自动分析完成' : '自动分析未完成'),
      }
    } catch (error) {
      const favorites = store.setFavorites({
        status: 'failed', code: 'NETWORK_ERROR', phase: '',
        lastError: String(error?.message || error), nextAction: '请稍后再次点击“同步并自动分析”；已读到的作品不会重复收录',
        finishedAt: new Date().toISOString(),
      })
      return { ok: false, code: 'NETWORK_ERROR', error: String(error?.message || error), favorites, pipeline: store.pipelineState(), library: viewOf(store.read()) }
    } finally {
      services.discoveryTaskRunning = false
    }
  }))

  ipcMain.handle('library:run-pipeline', guarded(async (payload = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const services = getActiveServices()
    if (services?.discoveryTaskRunning) {
      return { ok: false, code: 'DISCOVERY_RUNNING', error: '发现任务正在同步收藏夹并自动分析，请等待完成' }
    }
    const pipeline = ensureDiscoveryPipeline()
    if (!pipeline) return { ok: false, error: '账号服务尚未就绪' }
    if (!pipeline.ai) {
      const state = pipeline.store.setPipeline({
        status: 'blocked', code: 'MODEL_UNAVAILABLE', phase: '未配置可用模型，无法执行豆包分类',
        lastError: '规则无法确定的评论需要调用豆包分类，但当前没有可用模型',
        nextAction: '先在“设置 → AI 模型”里配置可用模型，再点击“继续自动分析”',
      })
      return { ok: false, code: 'MODEL_UNAVAILABLE', error: state.lastError, pipeline: state, library: viewOf(pipeline.store.read()) }
    }
    const result = await pipeline.run({
      maxVideosPerRound: payload.maxVideosPerRound,
      maxCommentsPerVideo: payload.maxCommentsPerVideo,
      maxPagesPerVideo: payload.maxPagesPerVideo,
      maxAiCallsPerRound: payload.maxAiCallsPerRound,
      firstBatchComments: payload.firstBatchComments,
      secondBatchComments: payload.secondBatchComments,
      taskLimits: payload.taskLimits,
      retryFailed: payload.retryFailed === true,
    })
    try { ensureDiscoveryScheduler()?.accountManualRun(result) } catch { /* 记账失败不影响分析结果 */ }
    const store = libraryStore(activeAccount)
    const lstore = learningStore(activeAccount)
    return { ...result, library: viewOf(store.read()), pipeline: store.pipelineState(), learning: learningView(lstore) }
  }))

  ipcMain.handle('library:pause-pipeline', guarded(async () => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const services = getActiveServices()
    const pipeline = services?.discoveryPipeline
    if (!pipeline) return { ok: true, pipeline: libraryStore(activeAccount).pipelineState(), message: '当前没有运行中的自动分析' }
    const state = pipeline.pause()
    return { ok: true, pipeline: state, library: viewOf(libraryStore(activeAccount).read()), message: state.phase }
  }))

  ipcMain.handle('library:import', guarded(async ({ text = '', filename = '' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const body = String(text || '')
    if (!body.trim()) return { ok: false, error: '导入内容为空' }
    if (Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024) return { ok: false, error: '导入文件超过 8MB，请拆分后再导入' }
    const store = libraryStore(activeAccount)
    const { library, log } = store.importText(body, { filename })
    return { ok: true, log, library: viewOf(library), libraryFile: store.filePath }
  }))

  ipcMain.handle('library:classify', guarded(async ({ maxAiCalls = null } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const services = getActiveServices()
    if (!services) return { ok: false, error: '账号服务尚未就绪' }
    const store = libraryStore(activeAccount)
    const result = await classifyLibrary({ store, ai: services.ai, options: { maxAiCalls } })
    return { ...result, library: viewOf(result.library) }
  }))

  ipcMain.handle('library:review', guarded(async ({ type, key, label, note = '' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    if (!key) return { ok: false, error: '缺少条目 key' }
    const store = libraryStore(activeAccount)
    const library = type === 'video' ? store.patchVideo(key, { category: label, note }) : store.patchComment(key, { intent: label, note })
    return { ok: true, library: viewOf(library) }
  }))

  ipcMain.handle('library:candidates', guarded(async () => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const services = getActiveServices()
    if (!services) return { ok: false, error: '账号服务尚未就绪' }
    const store = libraryStore(activeAccount)
    const result = syncLibraryCandidates(services, { accountId: activeAccount, store })
    return { ...result, library: viewOf(store.read()) }
  }))

  // ── P2-13 双模式与自动联系 ──────────────────────────────────────────────
  // 自动发现引擎（同步/评论/分类/候选）完全复用现有服务；这里只增加模式、筛选、队列和 Dry Run。
  const autoContactContext = () => {
    if (!activeAccount) return null
    const services = getActiveServices()
    if (!services) return null
    const store = libraryStore(activeAccount)
    return { accountId: activeAccount, services, store, queue: new AutoContactQueue({ store }) }
  }
  // 训练模式和正式模式共用同一发现引擎；任务运行中禁止切换，避免半途改变执行策略。
  const autoTaskRunning = (store, services) => {
    if (services?.discoveryTaskRunning === true) return true
    if (store?.autoContactState?.()?.status === 'running') return true
    try {
      const statuses = [
        store?.pipelineState?.().status,
        store?.favoritesState?.().status,
        store?.schedulerState?.().status,
      ].filter(Boolean)
      return statuses.some(status => ['running', 'syncing', 'collecting', 'classifying', 'analyzing'].includes(status))
    } catch { return false }
  }
  const autoCandidateList = (store, services) => {
    try { syncLibraryCandidates(services, { accountId: activeAccount, store }) } catch { /* 候选同步失败不阻断计划生成 */ }
    try {
      const { CandidateManager } = require('./discovery/candidate-manager.cjs')
      return new CandidateManager(services.storage).get().candidates || []
    } catch { return [] }
  }
  const autoExcludes = services => {
    try { return ((services.storage.get()?.contacts) || []).map(contact => contact.profile?.platformUserId).filter(Boolean) } catch { return [] }
  }
  const autoSnapshot = (store) => {
    const state = store.autoContactState()
    const counts = { followPending: 0, followDone: 0, firstMessagePending: 0, firstMessageDone: 0, simulatedDone: 0, realDone: 0, uncertain: 0, uncertainTasks: [] }
    for (const task of state.queues.follow) {
      if (task.status === 'pending') counts.followPending++
      if (task.status === 'done') counts.followDone++
      if (task.status === 'uncertain') { counts.uncertain++; counts.uncertainTasks.push({ taskId: task.taskId, action: 'follow', platformUserId: task.platformUserId, nickname: task.nickname, reasonCode: task.reasonCode, reason: task.reason, startedAt: task.startedAt }) }
      if (task.status === 'done' && task.simulated === true) counts.simulatedDone++
      if (task.status === 'done' && task.realAction === true) counts.realDone++
    }
    for (const task of state.queues.firstMessage) {
      if (task.status === 'pending') counts.firstMessagePending++
      if (task.status === 'done') counts.firstMessageDone++
      if (task.status === 'uncertain') { counts.uncertain++; counts.uncertainTasks.push({ taskId: task.taskId, action: 'firstMessage', platformUserId: task.platformUserId, nickname: task.nickname, reasonCode: task.reasonCode, reason: task.reason, startedAt: task.startedAt }) }
      if (task.status === 'done' && task.simulated === true) counts.simulatedDone++
      if (task.status === 'done' && task.realAction === true) counts.realDone++
    }
    counts.uncertainTasks = counts.uncertainTasks.slice(0, 50)
    return { autoContact: state, queueCounts: counts, policyVersion: AUTO_POLICY_VERSION, auditVersion: CANDIDATE_AUDIT_VERSION }
  }
  // 只读审计：不抓取页面、不改候选人状态；平台权限/对方同意/操作者确认缺一不可。
  const autoAudit = (ctx) => {
    const state = ctx.store.autoContactState()
    const candidates = autoCandidateList(ctx.store, ctx.services)
    const excludes = autoExcludes(ctx.services)
    const plan = ctx.queue.plan({ candidates, excludePlatformUserIds: excludes, config: state.config })
    const library = libraryStore(activeAccount).read()
    // P2-15.1：授权证据来自独立存储，不再固定传空对象；平台权限 / 对方同意 / 操作者确认分别判定。
    const result = auditCandidates(candidates, { library, config: state.config, excludePlatformUserIds: excludes, plan, authorization: library.autoContact.authorization })
    const explanations = explainFollowPlans(plan, result.audits)
    return { ...result, planSummary: plan.summary, scope: plan.scope || [], explanations }
  }

  ipcMain.handle('library:auto-get', guarded(async () => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    return { ok: true, ...autoSnapshot(ctx.store) }
  }))

  ipcMain.handle('library:auto-audit', guarded(async () => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    const result = autoAudit(ctx)
    return { ok: true, audit: { summary: result.summary, explanations: result.explanations, audits: result.audits, planSummary: result.planSummary, scope: result.scope }, ...autoSnapshot(ctx.store) }
  }))

  // P2-16 人工裁决结果未知任务：只有明确"确认未执行"才允许重试，"确认已执行"按完成记账。
  ipcMain.handle('library:auto-resolve-uncertain', guarded(async (payload = {}) => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    const result = ctx.queue.resolveUncertain(payload || {})
    return { ...result, ...autoSnapshot(ctx.store) }
  }))

  // P2-15.1 三类授权证据分开录入：登录成功不写这里，操作者勾选也不写这里。
  ipcMain.handle('library:authorization-get', guarded(async () => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    return { ok: true, authorization: libraryStore(activeAccount).autoContactState().authorization }
  }))
  ipcMain.handle('library:authorization-platform', guarded(async (payload = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const platform = libraryStore(activeAccount).setPlatformAuthorization(payload || {})
    return { ok: true, platform, authorization: libraryStore(activeAccount).autoContactState().authorization }
  }))
  ipcMain.handle('library:authorization-consent', guarded(async (payload = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const record = libraryStore(activeAccount).setRecipientConsent(payload.platformUserId, payload || {})
    return { ok: true, record, authorization: libraryStore(activeAccount).autoContactState().authorization }
  }))
  ipcMain.handle('library:authorization-operator', guarded(async (payload = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const record = libraryStore(activeAccount).setOperatorConfirmation(payload.platformUserId, payload || {})
    return { ok: true, record, authorization: libraryStore(activeAccount).autoContactState().authorization }
  }))
  ipcMain.handle('library:authorization-revoke', guarded(async (payload = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const authorization = libraryStore(activeAccount).revokeAuthorization(payload || {})
    return { ok: true, authorization }
  }))

  // 训练模式默认；正式模式首次启用必须显式 confirmRisk，且当前有任务运行时不允许切换。
  ipcMain.handle('library:auto-mode-set', guarded(async ({ mode = '', confirmed = false } = {}) => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    if (!['training', 'auto'].includes(mode)) return { ok: false, error: '不支持的模式' }
    const state = ctx.store.autoContactState()
    if (state.mode === mode) return { ok: true, ...autoSnapshot(ctx.store), message: '模式未变化' }
    if (autoTaskRunning(ctx.store, ctx.services)) return { ok: false, code: 'TASK_RUNNING', reason: '当前运行任务未结束，不能切换模式' }
    if (mode === 'auto' && !state.riskAcceptedAt && confirmed !== true) return { ok: false, code: 'RISK_CONFIRM_REQUIRED', reason: '首次启用正式模式需要确认自动关注/私信权限与风险' }
    // 只改运行模式，不改学习库、模型版本或历史标签。
    // 正式模式 = 用户已确认"无人值守全自动"：同时打开自动关注与自动首句，
    // 单批人数保持用户设定值（默认 1），每日额度至少保留 1，避免切成正式后仍被开关挡住。
    const autoConfig = mode === 'auto' ? autoModeConfig(state.config) : state.config
    const saved = ctx.store.setAutoContact({
      mode,
      config: autoConfig,
      ...(mode === 'auto' ? { riskAcceptedAt: state.riskAcceptedAt || new Date().toISOString() } : {}),
    })
    return { ok: true, autoContact: saved, queueCounts: autoSnapshot(ctx.store).queueCounts,
      message: mode === 'auto' ? `已切换到正式自动模式：批次结束后自动关注并发送第一句（单批上限 ${autoConfig.batchAutoLimit} 人）` : '已切换到训练模式' }
  }))

  ipcMain.handle('library:auto-config-set', guarded(async ({ config = {}, dryRun, authorized = false } = {}) => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    const state = ctx.store.autoContactState()
    const source = config && typeof config === 'object' ? config : {}
    const booleanKeys = ['autoFollow', 'autoFirstMessage', 'requireAgeRange', 'requireFollowerLimit']
    const numberKeys = ['ageMin', 'ageMax', 'followerMin', 'followerMax', 'dailyFollowLimit', 'dailyFirstMessageLimit', 'maxAttempts', 'perPersonCooldownMinutes', 'batchAutoLimit']
    const patch = {}
    for (const key of booleanKeys) if (typeof source[key] === 'boolean') patch[key] = source[key]
    for (const key of numberKeys) if (source[key] !== undefined && Number.isFinite(Number(source[key]))) patch[key] = Number(source[key])
    if (typeof source.autoMinIntent === 'string') patch.autoMinIntent = source.autoMinIntent === 'explicit' ? 'explicit' : 'any'
    if (typeof source.targetGender === 'string') patch.targetGender = source.targetGender
    if (typeof source.friendType === 'string') patch.friendType = source.friendType
    if (typeof source.extra === 'string') patch.extra = source.extra
    if (Array.isArray(source.keywords)) patch.keywords = source.keywords
    const nextConfig = { ...state.config, ...patch }
    const update = { config: nextConfig }
    if (typeof dryRun === 'boolean') update.dryRun = dryRun
    // 真实外发授权只能发生在正式模式且已完成风险确认；否则强制保持 Dry Run。
    if (authorized === true && state.mode === 'auto' && state.riskAcceptedAt) update.realActionsAuthorized = true
    // 每日上限同时写入预算，保证跨天重置时仍沿用用户设置。
    update.budget = { ...state.budget, limits: { dailyFollowLimit: nextConfig.dailyFollowLimit, dailyFirstMessageLimit: nextConfig.dailyFirstMessageLimit } }
    const saved = ctx.store.setAutoContact(update)
    return { ok: true, autoContact: saved, message: '自动联系设置已保存' }
  }))

  // 生成正式模式执行计划：只读判断，不入队、不发消息。Dry Run 的第一步。
  ipcMain.handle('library:auto-plan', guarded(async ({ enqueue = false } = {}) => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    const candidates = autoCandidateList(ctx.store, ctx.services)
    const result = ctx.queue.plan({ candidates, excludePlatformUserIds: autoExcludes(ctx.services), config: ctx.store.autoContactState().config })
    const enqueued = enqueue === true ? ctx.queue.enqueue(result.plans, { dryRun: true }) : null
    return { ok: true, ...result, enqueued, ...autoSnapshot(ctx.store) }
  }))

  // 自动发现运行：训练模式只做发现，不产生任何关注/私信；正式模式当前强制 Dry Run。
  ipcMain.handle('library:auto-run', guarded(async ({ enqueue = true } = {}) => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    const state = ctx.store.autoContactState()
    if (state.mode !== 'auto') return { ok: false, code: 'TRAINING_MODE', reason: '训练模式不执行关注或私信；请先切换正式模式并完成风险确认' }
    const candidates = autoCandidateList(ctx.store, ctx.services)
    const plan = ctx.queue.plan({ candidates, excludePlatformUserIds: autoExcludes(ctx.services), config: state.config })
    if (enqueue !== false) ctx.queue.enqueue(plan.plans, { dryRun: true })
    // P2-13D：真实操作仍保持 Dry Run，executor 显式传 null，绝不触发平台接口。
    const blocked = candidates.filter(item => item.status === 'REJECTED' || item.discoveryStatus === 'REJECTED').map(item => item.platformUserId)
    const run = await ctx.queue.run({ dryRun: true, executor: null, blockedPlatformUserIds: [...autoExcludes(ctx.services), ...blocked] })
    return { ok: run.ok, ...run, plan: plan.summary, ...autoSnapshot(ctx.store) }
  }))

  // 正式模式“一键关注”：真实打开候选人主页并点击关注。
  // 只在正式模式 + 已完成风险确认 + 用户每次点击确认 + 每日上限内执行；首次私信仍保持 Dry Run。
  ipcMain.handle('library:auto-follow', guarded(async ({ confirmed = false } = {}) => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: activeAccount ? '账号服务尚未就绪' : '没有活动账号' }
    const state = ctx.store.autoContactState()
    if (state.mode !== 'auto') return { ok: false, code: 'TRAINING_MODE', reason: '训练模式不执行真实关注，请先切换到正式模式' }
    if (!state.riskAcceptedAt) return { ok: false, code: 'RISK_CONFIRM_REQUIRED', reason: '请先完成正式模式的风险确认' }
    if (confirmed !== true) return { ok: false, code: 'CONFIRM_REQUIRED', reason: '真实关注需要本次操作确认' }
    if (!state.config.autoFollow) return { ok: false, code: 'AUTO_FOLLOW_DISABLED', reason: '请先在高级设置中开启“允许自动关注”' }
    // P2-15：暂停 / 安全验证 / 紧急停止 / 黑名单与其它入口共用同一套门控判定，失败码保持兼容。
    const gate = evaluateEntryGate({ accountId: activeAccount, entry: ctx.services, action: GATE_ACTIONS.FOLLOW, source: GATE_SOURCES.AUTO_CONTACT, confirmation: { confirmed: true } })
    logGateDecision(ctx.services, 'library:auto-follow', gate)
    const alias = { ACCOUNT_PAUSED: 'AUTO_PAUSED' }
    if (!gate.allowed) return { ok: false, code: alias[gate.code] || gate.code, reason: gate.reason, gate }
    const today = new Date().toISOString().slice(0, 10)
    // 真实额度只统计真实执行；Dry Run 记录不占用真实每日上限。
    const usedReal = state.budget.day === today ? (Number.isFinite(state.budget.realFollows) ? state.budget.realFollows : state.budget.follows) : 0
    const remaining = Math.max(0, state.config.dailyFollowLimit - usedReal)
    if (remaining <= 0) return { ok: false, code: 'DAILY_LIMIT_REACHED', reason: `今日关注已达上限 ${state.config.dailyFollowLimit} 人` }
    const candidates = autoCandidateList(ctx.store, ctx.services)
    const plan = ctx.queue.plan({ candidates, excludePlatformUserIds: autoExcludes(ctx.services), config: state.config })
    // P2-14A：发现合格不等于可真实执行。平台权限、对方同意、操作者确认缺一不可。
    const audit = autoAudit(ctx)
    const authorizedIds = new Set(audit.audits.filter(item => item.action.allowed).map(item => item.platformUserId))
    const eligible = plan.plans.filter(item => item.follow.eligible && authorizedIds.has(item.platformUserId))
    if (!eligible.length) {
      const blocked = plan.summary.follow || 0
      return { ok: true, followed: 0, audit: { summary: audit.summary, explanations: audit.explanations }, message: blocked ? `${blocked} 条计划均未获得真实操作授权（平台权限 / 对方同意 / 操作者确认需同时具备），只允许 Dry Run` : '没有新的可关注候选人', ...autoSnapshot(ctx.store), plan: plan.summary }
    }
    // 用户在本次点击中已完成确认：写入真实执行授权，否则队列会按策略自动降级为 Dry Run。
    ctx.store.setAutoContact({ realActionsAuthorized: true, dryRun: false })
    ctx.queue.enqueue(eligible, { dryRun: false })
    const { CandidateManager } = require('./discovery/candidate-manager.cjs')
    const manager = new CandidateManager(ctx.services.storage)
    const now = () => new Date().toISOString()
    const executor = async ({ candidateId, platformUserId, profileUrl, nickname }) => {
      const target = candidates.find(item => item.platformUserId === platformUserId) || {}
      const name = nickname || target.nickname
      const url = profileUrl || target.profileUrl
      try {
        if (!url || !name) throw new Error('缺少可核对的公开主页或昵称')
        const adopted = ctx.services.friendship.adoptCandidate({ url, name, summary: '来自评论区的公开交友意愿候选人' })
        const result = await ctx.services.friendship.followCandidate(adopted, { background: true })
        manager.patch(candidateId, { action: { followStatus: result.followPending ? 'pending' : 'followed', lastAttemptAt: now(), lastActionReason: result.followPending ? '已发送关注申请，等待对方通过' : '关注成功' } })
        return { ok: true }
      } catch (error) {
        const message = String(error?.message || error).slice(0, 300)
        const code = /验证|安全/.test(message) ? 'CHALLENGE_REQUIRED' : /频繁|频率|限流/.test(message) ? 'RATE_LIMITED' : /登录/.test(message) ? 'LOGIN_REQUIRED' : /暂停/.test(message) ? 'AUTO_PAUSED' : 'FOLLOW_FAILED'
        manager.patch(candidateId, { action: { followStatus: 'failed', lastAttemptAt: now(), lastActionReason: message } })
        return { ok: false, reasonCode: code, reason: message }
      }
    }
    const blocked = candidates.filter(item => item.status === 'REJECTED' || item.discoveryStatus === 'REJECTED').map(item => item.platformUserId)
    const run = await ctx.queue.run({ dryRun: false, executor, onlyAction: 'follow', limit: remaining, blockedPlatformUserIds: [...autoExcludes(ctx.services), ...blocked] })
    const followed = run.results.filter(item => item.status === 'done').length
    return { ok: run.ok, ...run, followed, message: run.stopped ? `已停止：${run.stopped.reason}` : `已真实关注 ${followed} 人`, ...autoSnapshot(ctx.store), plan: plan.summary }
  }))

  ipcMain.handle('library:auto-pause', guarded(async () => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    ctx.queue.pause('用户暂停')
    return { ok: true, ...autoSnapshot(ctx.store) }
  }))
  ipcMain.handle('library:auto-resume', guarded(async () => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    ctx.queue.recover()
    return { ok: true, ...autoSnapshot(ctx.store) }
  }))
  ipcMain.handle('library:auto-stop', guarded(async () => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    ctx.queue.stop('用户紧急停止')
    return { ok: true, ...autoSnapshot(ctx.store), message: '已紧急停止关注与首次联系队列' }
  }))
  ipcMain.handle('library:auto-reset', guarded(async () => {
    const ctx = autoContactContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    ctx.queue.reset()
    return { ok: true, ...autoSnapshot(ctx.store), message: '已清空自动联系队列（不影响候选人和学习数据）' }
  }))

  // P2-12A 人工基准集：盲评队列 + 逐类别评估。模型标签在盲评期间绝不返回给界面。
  const benchmarkContext = () => {
    if (!activeAccount) return null
    const accountId = activeAccount
    const lstore = learningStore(accountId)
    syncLearning(lstore)
    const store = benchmarkStore(accountId)
    const learning = lstore.read()
    return { accountId, lstore, store, learning, state: store.read(), library: libraryStore(accountId).read() }
  }
  const candidateIdsOf = () => {
    try {
      const services = getActiveServices()
      const list = services?.storage?.get?.().discovery?.candidates || []
      return list.map(item => String(item.platformUserId || '')).filter(Boolean)
    } catch { return [] }
  }

  ipcMain.handle('library:benchmark-get', guarded(async ({ limit = 12, offset = 0 } = {}) => {
    const ctx = benchmarkContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    return { ok: true, benchmark: buildBenchmarkView(ctx.state, ctx.learning, { limit, offset }), learning: learningView(ctx.lstore) }
  }))

  ipcMain.handle('library:benchmark-create', guarded(async ({ size = 60, reset = false } = {}) => {
    const ctx = benchmarkContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    const created = createBenchmarkSet({ learning: ctx.learning, library: ctx.library, size, reset: reset === true, previous: ctx.state })
    const state = ctx.store.save(created.state)
    return {
      ok: true, created: created.created, benchmark: buildBenchmarkView(state, ctx.learning, { limit: 12 }),
      message: created.created ? `基准集已创建：${created.set.size} 条（配额不足的部分已在说明中记录）` : '已有未完成的基准集，已继续上次进度',
    }
  }))

  ipcMain.handle('library:benchmark-annotate', guarded(async ({ key = '', intent = '', reason = '', offset = 0 } = {}) => {
    const ctx = benchmarkContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    const set = ctx.state.activeSet
    if (!set) return { ok: false, error: '还没有基准集，请先创建' }
    if (!key || !set.keys.includes(key)) return { ok: false, error: '该评论不在当前基准集内' }
    // SKIP 只跳过当前条目，不写人工标签；“无法判断”请选择 UNKNOWN。
    if (String(intent).toUpperCase() === 'SKIP') {
      return { ok: true, skipped: true, benchmark: buildBenchmarkView(ctx.state, ctx.learning, { limit: 12, offset }) }
    }
    // 空字符串不允许当作标签；未知资料必须显式选择“无法判断”。
    if (!intent) return { ok: false, error: '请选择人工标签或“无法判断”' }
    try {
      ctx.lstore.annotate(key, {
        intent: String(intent).toUpperCase(),
        reason: `基准集盲评 ${set.id}｜${String(reason || '按评论原文判断').slice(0, 120)}`,
        useForTraining: false,
        independentEval: true,
        source: 'user',
      })
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    const learning = ctx.lstore.read()
    const labeled = set.keys.filter(item => {
      const sample = (learning.samples || []).find(entry => entry.key === item)
      return Boolean(sample?.human?.intent)
    }).length
    let state = ctx.state
    if (labeled >= set.keys.length) state = ctx.store.save({ ...ctx.state, activeSet: { ...set, status: 'completed' } })
    return { ok: true, benchmark: buildBenchmarkView(state, learning, { limit: 12, offset }), learning: learningView(ctx.lstore), message: `已保存人工标签（${labeled}/${set.keys.length}）` }
  }))

  ipcMain.handle('library:benchmark-evaluate', guarded(async () => {
    const ctx = benchmarkContext()
    if (!ctx) return { ok: false, error: '没有活动账号' }
    const candidateUserIds = candidateIdsOf()
    return {
      ok: true,
      benchmark: evaluateBenchmark(ctx.state, ctx.learning, ctx.library, { candidateUserIds }),
      reference: evaluateHumanLabels(ctx.learning, ctx.library, { candidateUserIds }),
      view: buildBenchmarkView(ctx.state, ctx.learning, { limit: 6 }),
    }
  }))

  ipcMain.handle('library:intro', guarded(async ({ candidateId = null, template = null } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    if (!candidateId) return { ok: false, error: '缺少候选人 ID' }
    const services = getActiveServices()
    if (!services) return { ok: false, error: '账号服务尚未就绪' }
    const { CandidateManager } = require('./discovery/candidate-manager.cjs')
    const manager = new CandidateManager(services.storage)
    const candidate = (manager.get().candidates || []).find(item => item.id === candidateId)
    if (!candidate) return { ok: false, error: '找不到该候选人' }
    const store = libraryStore(activeAccount)
    const mapped = originForCandidate(candidate, store.read())
    if (!mapped.ok) return { ok: false, error: mapped.error, detail: mapped.detail, draft: null }
    const draft = buildIntroDraft({ origin: mapped.origin, template, intent: candidate.libraryIntent })
    return { ok: true, draft, origin: mapped.origin, candidate: { id: candidate.id, nickname: candidate.nickname, status: candidate.status, libraryIntent: candidate.libraryIntent, consentToDm: candidate.consentToDm === true }, requiresApproval: true }
  }))

  // 把库里的来源写进候选人对应的联系人资料：默认未确认，且绝不覆盖已有来源。
  ipcMain.handle('library:write-origin', guarded(async ({ candidateId = null, contactId = null } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const services = getActiveServices()
    if (!services) return { ok: false, error: '账号服务尚未就绪' }
    const { CandidateManager } = require('./discovery/candidate-manager.cjs')
    const manager = new CandidateManager(services.storage)
    const candidate = (manager.get().candidates || []).find(item => item.id === candidateId)
    if (!candidate) return { ok: false, error: '找不到该候选人' }
    const state = services.storage.get()
    const contact = (state.contacts || []).find(item => item.id === contactId)
      || (state.contacts || []).find(item => item.profile?.platformUserId && item.profile.platformUserId === candidate.platformUserId)
    if (!contact) return { ok: false, error: '该候选人还没有对应的联系人，先完成联系流程再写入来源' }
    if (contact.profile?.platformUserId && contact.profile.platformUserId !== candidate.platformUserId) return { ok: false, error: '联系人平台 ID 与候选人不一致，已拒绝写入' }
    const existing = contact.profile?.contact_origin
    if (existing && (existing.platform || existing.source_type || existing.video_topic)) return { ok: false, error: '该联系人已有来源记录，未覆盖；如需修改请在联系人资料里编辑' }
    const mapped = originForCandidate(candidate, libraryStore(activeAccount).read())
    if (!mapped.ok) return { ok: false, error: mapped.error, detail: mapped.detail }
    services.storage.update({ contacts: (state.contacts || []).map(item => item.id === contact.id ? { ...item, profile: { ...item.profile, contact_origin: { ...mapped.origin, verified_by_user: false } } } : item) })
    return { ok: true, contactId: contact.id, origin: { ...mapped.origin, verified_by_user: false } }
  }))

  // ── P2-09 评论学习（人工标注 / 豆包分类 / 相似案例 / 评估 / 版本回滚）──────
  // 只读写 accounts/<id>/library/learning.json；人工标签只能由 learning:annotate 写入。
  const learningView = (store, options = {}) => {
    const view = viewOfLearning(store.read(), options)
    view.filePath = store.filePath
    view.modes = LEARNING_MODES
    return view
  }
  const syncLearning = store => {
    try { store.syncLibrary(libraryStore(activeAccount).read()) } catch { /* 素材库为空时忽略 */ }
    return store
  }

  ipcMain.handle('learning:get', guarded(async (options = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const store = learningStore(activeAccount)
    syncLearning(store)
    return { ok: true, learning: learningView(store, options) }
  }))

  ipcMain.handle('learning:annotate', guarded(async ({ key = '', intent = '', reason = '', useForTraining, independentEval } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    if (!key) return { ok: false, error: '缺少评论 key' }
    const store = learningStore(activeAccount)
    try {
      store.annotate(key, { intent, reason, useForTraining, independentEval })
      return { ok: true, learning: learningView(store) }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  }))

  ipcMain.handle('learning:annotate-batch', guarded(async ({ keys = [], intent = '', reason = '', useForTraining, independentEval } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    if (!Array.isArray(keys) || !keys.length) return { ok: false, error: '没有可批量处理的评论' }
    const store = learningStore(activeAccount)
    const changed = store.annotateMany(keys, { intent, reason, useForTraining, independentEval })
    return { ok: changed > 0, changed, learning: learningView(store), error: changed > 0 ? null : '没有匹配的评论样本' }
  }))

  // P2-10：人工排除样本。排除只影响学习/复核，不删除原始评论，不进候选池。
  ipcMain.handle('learning:exclude', guarded(async ({ key = '', excluded = true, reason = '' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    if (!key) return { ok: false, error: '缺少评论 key' }
    const store = learningStore(activeAccount)
    try {
      store.setExcluded(key, { excluded, reason })
      return { ok: true, learning: learningView(store) }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  }))

  // 读取待审评论作者的公开主页性别：只认主页里公开显示的“男/女”，不从昵称、头像或评论内容推测。
  // 每次最多核验 limit 位作者，读完写回学习样本，前端据此只显示女性。
  ipcMain.handle('learning:verify-genders', guarded(async ({ limit = 12 } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const entry = services.get(activeAccount)
    if (!entry?.friendship) return { ok: false, error: '交友服务尚未就绪，请稍后再试' }
    const store = learningStore(activeAccount)
    const samples = store.read().samples.filter(sample => !sample.excluded && !sample.authorGender && sample.authorId)
    const unique = [...new Map(samples.map(sample => [sample.authorId, sample])).values()]
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 12)))
    if (!unique.length) {
      return { ok: true, checked: 0, female: 0, male: 0, unknown: 0, changed: 0, blocked: '', learning: learningView(store) }
    }
    const commentsByKey = new Map(libraryStore(activeAccount).read().comments.map(c => [c.key,c]))
    const genders = {}
    let blocked = ''
    await entry.friendship.exclusive(async () => {
      const win = entry.friendship.ensureWindow()
      win.show(); win.focus?.()
      for (const sample of unique) {
        if (blocked) break
        const url = `https://www.${'douyin'}.com/user/${sample.authorId}`
        try {
          const { page } = await entry.friendship.openProfilePage(win, { url, name: sample.authorName, platformUserId: sample.authorId,
            sources: [{videoId:sample.videoId,videoUrl:sample.videoUrl,commentId:commentsByKey.get(sample.key)?.comment_id}] },
            { automated:true, assertActive:()=>{if(entry!==getActiveServices())throw new Error('当前账号已切换')} })
          const deadline = Date.now() + 15000
          let snap = null
          while (Date.now() < deadline) {
            snap = await page.webContents.executeJavaScript(`(${publicProfileSnapshot.toString()})(${JSON.stringify(url)})`).catch(() => null)
            if (snap?.ready || snap?.challenge || snap?.loginRequired) break
            await new Promise(resolve => setTimeout(resolve, 400))
          }
          if (snap?.challenge || snap?.loginRequired) {
            blocked = snap.challenge ? '抖音需要安全验证，请在交友窗口完成后再点一次核验' : '请先在交友窗口登录抖音'
            break
          }
          const label = String(snap?.genderText || '').trim()
          if (/女/.test(label)) genders[sample.authorId] = 'female'
          else if (/男/.test(label)) genders[sample.authorId] = 'male'
        } catch (error) {
          if (error.blocked || /安全验证|登录|账号已切换/.test(error.message || '')) { blocked = error.message; break }
          // 单个主页读取失败不影响其他人，下次可重试。
        }
        await new Promise(resolve => setTimeout(resolve, 600))
      }
    })
    const changed = store.setAuthorGenders(genders)
    const female = Object.values(genders).filter(gender => gender === 'female').length
    const male = Object.values(genders).filter(gender => gender === 'male').length
    return { ok: true, checked: unique.length, female, male, unknown: unique.length - female - male, changed, blocked, learning: learningView(store) }
  }))

  // 一键清空待审列表：把所有还没人工判断的样本批量排除，只影响学习/复核，
  // 不删除原始评论，也不动已经判断过的样本。
  ipcMain.handle('learning:clear-pending', guarded(async ({ reason = '' } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const store = learningStore(activeAccount)
    const keys = store.read().samples.filter(sample => !sample.human && !sample.excluded).map(sample => sample.key)
    const changed = store.excludeMany(keys, { reason: reason || '人工一键清空，未逐条判断' })
    return { ok: true, changed, learning: learningView(store) }
  }))

  ipcMain.handle('learning:classify', guarded(async ({ mode = 'model', scope = 'pending', keys = null, maxAiCalls = 6, batchSize = 6, topK = null } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    if (!LEARNING_MODES[mode]) return { ok: false, error: `不支持的分类方案：${mode}` }
    const store = learningStore(activeAccount)
    syncLearning(store)
    let ai = null
    if (mode !== 'rule') {
      const services = getActiveServices()
      if (!services?.ai) return { ok: false, error: '账号服务尚未就绪' }
      ai = services.ai
    }
    const owner = getActiveServices()
    if (owner) owner.discoveryListsModelRunning = true
    try {
      const result = await runCommentLearning({
        learningStore: store, libraryStore: libraryStore(activeAccount), ai,
        mode, scope, keys, maxCalls: Math.max(0, Math.min(30, Number(maxAiCalls) || 6)), batchSize, topK,
      })
      return { ...result, library: viewOf(libraryStore(activeAccount).read()), learning: learningView(store) }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
    finally { if (owner) owner.discoveryListsModelRunning = false }
  }))

  ipcMain.handle('learning:evaluate', guarded(async ({ runId = null } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const store = learningStore(activeAccount)
    syncLearning(store)
    const learning = store.read()
    return { ok: true, evaluation: evaluateLearning(learning, { runId }), learning: learningView(store) }
  }))

  ipcMain.handle('learning:version', guarded(async ({ action = 'create', id = null, note = '', useCases = true, topK = 3 } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const store = learningStore(activeAccount)
    try {
      if (action === 'create') store.createVersion({ note, config: { useCases, topK } })
      else if (action === 'activate') { if (!id) return { ok: false, error: '缺少版本 ID' }; store.activateVersion(id) }
      else if (action === 'rollback') store.rollback()
      else return { ok: false, error: `未知操作：${action}` }
      return { ok: true, learning: learningView(store) }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  }))

  ipcMain.handle('learning:splits', guarded(async ({ evalVideoIds = null } = {}) => {
    if (!activeAccount) return { ok: false, error: '没有活动账号' }
    const store = learningStore(activeAccount)
    syncLearning(store)
    try {
      const result = store.assignSplits({ evalVideoIds })
      return { ok: true, ...result, learning: learningView(store) }
    } catch (error) { return { ok: false, error: String(error?.message || error) } }
  }))


  // Release preview: inspect saved legacy status without restoring its scheduler.
  try {
    const boot = bootDiscoveryScheduler()
    if (boot?.state?.status === 'blocked') {
      getActiveServices()?.storage?.addLog?.({ type: 'discovery_scheduler_blocked', message: boot.state.lastError || boot.state.code })
    }
  } catch (error) {
    getActiveServices()?.storage?.addLog?.({ type: 'discovery_scheduler_error', message: `调度启动失败：${error?.message || error}` })
  }
}

app.whenReady().then(() => {
  try { fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] app.whenReady started\n`) } catch {}
  if (!hasSingleInstanceLock) return
  if (process.platform === 'win32') {
    app.setAppUserModelId('douyin-reply-assistant.desktop')
    releaseOwnedDeepLinkProtocol(app)
  }

  // 账号索引；首次运行把旧版根 state.json 迁移为 default 账号
  let index = readAccountIndex()
  if (!index.list.length) {
    const legacyState = path.join(app.getPath('userData'), 'state.json')
    const defaultId = 'default'
    const dir = path.join(accountRoot(), defaultId)
    fs.mkdirSync(dir, { recursive: true })
    if (fs.existsSync(legacyState) && !fs.existsSync(path.join(dir, 'state.json'))) {
      try { fs.copyFileSync(legacyState, path.join(dir, 'state.json')) } catch {}
    }
    index = { active: defaultId, list: [{ id: defaultId, name: '默认账号' }] }
    writeAccountIndex(index)
  }
  providersStore = new SharedProvidersStore(app.getPath('userData'))
  try { fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] starting account services, accounts=${index.list.map(i=>i.id).join(',')}\n`) } catch {}
  for (const item of index.list) startAccountServices(item.id)
  activeAccount = (index.active && services.has(index.active)) ? index.active : (index.list[0]?.id || null)

  // 跨账号同步天气城市配置（保证本机全局生效）
  let globalCity = ''
  for (const item of index.list) {
    const sCity = services.get(item.id)?.storage?.get()?.settings?.weatherCity
    if (sCity && !globalCity) globalCity = sCity
  }
  if (globalCity) {
    setGlobalWeatherCity(globalCity)
    for (const [id, s] of services.entries()) {
      if (s?.storage && !s.storage.get()?.settings?.weatherCity) {
        s.storage.update({ settings: { weatherCity: globalCity } })
      }
    }
  }

  getActiveStorage()?.addLog?.({ type: 'app_boot', message: `Auto Love Finder v${app.getVersion()} 已启动`, detail: { version: app.getVersion() } })
  registerAiHandlers()
  if (process.env.DOUYIN_ASSISTANT_DEV_TOOLS === '1' && fs.existsSync(path.join(__dirname, 'dev-ipc.cjs'))) {
    require('./dev-ipc.cjs').registerDevHandlers({ ipcMain, app, getActiveServices, getActiveAccount: () => activeAccount })
  }
  try { fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] creating window and tray\n`) } catch {}
  createWindow()
  createTray()
  try { fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] window and tray created, windows=${BrowserWindow.getAllWindows().length}\n`) } catch {}

  // 开启心跳日志
  setInterval(() => {
    try {
      fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] HEARTBEAT pid=${process.pid} windows=${BrowserWindow.getAllWindows().length}\n`)
    } catch {}
  }, 60000)

  // Do not force working-set eviction while Chromium is loading/processing pages.
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] app window-all-closed (isQuitting=${isQuitting}, windows=${BrowserWindow.getAllWindows().length})\n`)
  } catch {}
  if (isQuitting) app.quit()
})

app.on('before-quit', async () => {
  try {
    fs.appendFileSync(bootLogPath, `[${new Date().toISOString()}] app before-quit (isQuitting=${isQuitting})\n`)
  } catch {}
  isQuitting = true
  for (const entry of services.values()) {
    try { entry.discoveryScheduler?.stopTimer?.() } catch { /* ignore quit-time errors */ }
    try { stopDiscoveryService(entry) } catch { /* ignore quit-time errors */ }
    try { stopFriendshipServices(entry) } catch { /* ignore quit-time errors */ }
    try { entry.videoOpenings?.destroy(); await entry.douyin?.destroy() } catch { /* ignore quit-time errors */ }
  }
})
