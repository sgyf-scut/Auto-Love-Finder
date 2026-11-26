const fs = require('node:fs')
const { normalizeOpeningRequirements } = require('./opening-requirements.cjs')
const { writeFileAtomicSync, copyFileRobustSync } = require('./atomic-write.cjs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { normalizeMemory, clean, persistMemoryViews } = require('./social-brain/memory-manager.cjs')
const { normalizeAutoFriendshipConfig } = require('./auto-friendship.cjs')
const { normalizeDiscovery } = require('./discovery/candidate-manager.cjs')
const { emptySelfProfile, normalizeSelfProfile } = require('./social-brain/self-profile.cjs')
const { normalizeJourney } = require('./social-brain/relationship-journey.cjs')
const { normalizeSharedMemory } = require('./social-brain/shared-memory.cjs')
const { normalizeConversationSync } = require('./conversation-sync.cjs')

// v2 数据模型。相对 v0.7.x 的变化：
// - 移除：话题库(topicPool)、话题代问(inquiries)、视频分享(videoShare)、远程面板配置、
//   外观自定义（字号/强调色/背景色/动效/模糊）——均属死代码或性能负担。
// - 新增：contacts[].turn（轮次状态机持久化状态）、learning.mediaLog（视频上下文权重层）。
// - 旧字段在 read() 迁移时剥离，联系人学习数据（messages/facts/topicLog/styleMessages）完整保留。
const defaults = {
  version: 2,
  automation: { autoReply: false, paused: false, sparks: [], dailyLimit: 20, maxPerContactDaily: 10, maxPerContactDailyEnabled: false, blacklist: [], aiDisabledContacts: [] },
  contacts: [],
  selfPersona: {},
  selfProfile: emptySelfProfile(),
  conversationSync: normalizeConversationSync(),
  friendship: { followed: [], automatic: normalizeAutoFriendshipConfig(), autoState: { jobs: [], candidates: [] } },
  discovery: normalizeDiscovery(),
  videoGreetings: { pending: [], sent: [] },
  providers: [],
  aiSkills: [],
  logs: [],
  sendHistory: [],
  pendingDrafts: [],
  expressionBatches: [],
  // Simple V3 Shadow A/B comparison records. Never holds Memory or Relationship data.
  shadowComparisons: [],
  proactiveState: { date: '', sentToday: 0, lastSentAt: 0, sentContacts: [] },
  lastSeenPairs: [],
  lastSentPairs: [],
  appearance: { theme: 'auto', defaultTone: '' },
  settings: {
    openingRequirements: '', openingMode: 'ai', fixedOpeningText: '',
    primaryChatEngine: 'simple_v3', shadowChatEngine: null, shadowEnabled: false,
    launchOnStartup: false, startMinimized: false, minimizeToTray: true, confirmBeforeSend: true,
    desktopNotifications: true, soundNotifications: false, notifyOnSuccess: true, notifyOnFailure: true,
    autoLearnContacts: true, refreshInterval: '5', quietHours: true, quietStart: '23:00', quietEnd: '07:00',
    incomingBurstEnabled: true, incomingBurstQuietWindowMs: 4000, incomingBurstMaxWindowMs: 15000,
    favoriteStickerEnabled: true,
    // 媒体识别（沿用旧字段名，automation 层零改动复用）
    videoReplyEnabled: true, videoRecognitionEnabled: true, videoLowConfidenceReply: true, videoAnalysisFirst: true, videoRecognitionMode: 'smart',
    // v2 默认关闭多候选：单候选 + 一次自然化重写足够，减少一半 API 调用与延迟
    multiCandidateReply: false,
    // 双消息（允许而非必须）：每次回复按此概率补一条更短的随口话；0 = 关闭
    twoMessageChance: 0,
    // 续火花"今日播报"天气城市（留空按 IP 自动定位）
    weatherCity: '',
    saveLogs: true, logRetention: '30', showAiModelLabel: false, aiReplyDraftOnly: true, failoverEnabled: true,
    longTermMemory: true,
    eventFollowup: { enabled: true }, // This version only creates drafts.
    proactiveChat: { enabled: false, maxPerDay: 2, windowStart: '10:00', windowEnd: '22:00', minIntervalMinutes: 180, sendToDraft: true, openingType: 'text', topicNotes: '' },
  },
}

const emptyTurn = () => ({ lastHandledKey: '', lastOutgoingAt: 0 })

// 联系人规范化：补齐 turn / profile / learning 缺失字段，剥离已下线功能的残留数据
function normalizeContact(contact, options = {}) {
  if (!contact || typeof contact !== 'object' || !contact.name) return null
  const profile = { ...(contact.profile || {}) }
  delete profile.videoShare
  const learning = { ...(contact.learning || {}) }
  return {
    ...contact,
    profile,
    relationshipJourney: normalizeJourney(contact),
    sharedMemory: normalizeSharedMemory(contact, options),
    socialBrain: contact.socialBrain ? normalizeMemory(contact.socialBrain) : { ...normalizeMemory(), legacyMemories: (Array.isArray(learning.facts) ? learning.facts : []).map(f => ({ content: clean(typeof f === 'string' ? f : f?.text, 120), status: 'unverified_legacy' })).filter(f => f.content).slice(-30) },
    learning: {
      ...learning,
      messages: Array.isArray(learning.messages) ? learning.messages : [],
      topicLog: Array.isArray(learning.topicLog) ? learning.topicLog : [],
      mediaLog: Array.isArray(learning.mediaLog) ? learning.mediaLog : [],
      facts: Array.isArray(learning.facts) ? learning.facts : [],
    },
    turn: { ...emptyTurn(), ...(contact.turn || {}) },
  }
}

// 历史日志净化：旧版本写入的启动消息带内部构建标记，对用户无意义且不该出现在界面
const cleanLegacyLogValue = (value) => {
  if (typeof value === 'string') return value.replace(/（重构版[^）]*）/g, '').replace(/rebuild\S*/gi, '').trim()
  if (Array.isArray(value)) return value.map(cleanLegacyLogValue)
  if (value && typeof value === 'object') {
    // build 字段整体删除（内部构建标记，不面向用户）
    const { build: _build, ...rest } = value
    return Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, cleanLegacyLogValue(item)]))
  }
  return value
}
const cleanLegacyLogEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return entry
  return cleanLegacyLogValue({ ...entry })
}

function isPlainObject(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item)
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target
  const output = { ...(target || {}) }
  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const tgtVal = target ? target[key] : undefined
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      output[key] = deepMerge(tgtVal, srcVal)
    } else {
      output[key] = srcVal
    }
  }
  return output
}

function normalizeIncomingBurstSettings(settings = {}) {
  settings = { ...settings, openingRequirements: normalizeOpeningRequirements(settings.openingRequirements), openingMode: settings.openingMode === 'fixed' ? 'fixed' : 'ai', fixedOpeningText: typeof settings.fixedOpeningText === 'string' && settings.fixedOpeningText.length <= 80 ? settings.fixedOpeningText : '' }
  const bounded = (value, fallback, min, max) => {
    const number = value === '' || value === null ? NaN : Number(value)
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
  }
  const quiet = bounded(settings.incomingBurstQuietWindowMs, 4000, 1000, 15000)
  return {
    ...settings,
    proactiveChat: { ...(settings.proactiveChat || {}), topicNotes: typeof settings.proactiveChat?.topicNotes === 'string' ? settings.proactiveChat.topicNotes.trim().slice(0, 2000) : '' },
    incomingBurstEnabled: settings.incomingBurstEnabled !== false,
    incomingBurstQuietWindowMs: quiet,
    incomingBurstMaxWindowMs: bounded(settings.incomingBurstMaxWindowMs, 15000, quiet, 60000),
  }
}

function normalizeFriendshipState(value) {
  const saved = isPlainObject(value) ? value : {}
  const validUser = item => {
    try { return typeof item?.name === 'string' && Boolean(item.name.trim()) && require('./friendship.cjs').profileUrl(item.url) === item.url && !item.url.endsWith('/user/self') }
    catch { return false }
  }
  const autoState = isPlainObject(saved.autoState) ? saved.autoState : {}
  // Keep the durable attempt ledger. Dropping old jobs would allow the same
  // stranger to receive another opening after restarting the application.
  const jobs = (Array.isArray(autoState.jobs) ? autoState.jobs : []).filter(validUser).map(job => {
    if (job.status === 'sending') return { ...job, status: 'uncertain', lastError: '上次打招呼中断，发送结果未确认，请检查抖音，不能自动重发' }
    if (job.status === 'following') return { ...job, status: 'follow_uncertain', lastError: '上次关注中断，关注结果未确认，请先检查抖音' }
    return job
  })
  return {
    followed: (Array.isArray(saved.followed) ? saved.followed : []).filter(item => {
      try { return require('./friendship.cjs').profileUrl(item?.url) === item.url && !item.url.endsWith('/user/self') } catch { return false }
    }).slice(0, 200),
    automatic: normalizeAutoFriendshipConfig(saved.automatic),
    autoState: { ...autoState, jobs, candidates: (Array.isArray(autoState.candidates) ? autoState.candidates : []).filter(validUser).slice(0, 100) },
  }
}

// 迁移：旧版 state.json → v2。宽容读取（旧字段存在即剥离），学习数据原样保留。
function migrateLegacy(input) {
  const saved = input && typeof input === 'object' ? input : {}
  const legacyAutomation = saved.automation || {}
  const automation = {
    ...defaults.automation,
    autoReply: Boolean(legacyAutomation.autoReply),
    paused: Boolean(legacyAutomation.paused),
    sparks: Array.isArray(legacyAutomation.sparks)
      ? legacyAutomation.sparks.filter((task) => task && String(task.kind || 'text') !== 'videoShare' && task.name)
      : [],
    dailyLimit: Number(legacyAutomation.dailyLimit) || defaults.automation.dailyLimit,
    maxPerContactDaily: Number(legacyAutomation.maxPerContactDaily) || defaults.automation.maxPerContactDaily,
    maxPerContactDailyEnabled: legacyAutomation.maxPerContactDailyEnabled === true,
    blacklist: Array.isArray(legacyAutomation.blacklist) ? legacyAutomation.blacklist : [],
    aiDisabledContacts: Array.isArray(legacyAutomation.aiDisabledContacts) ? legacyAutomation.aiDisabledContacts : [],
  }
  const appearance = {
    theme: saved.appearance?.theme === 'dark' ? 'dark' : (saved.appearance?.theme === 'light' ? 'light' : 'auto'),
    defaultTone: String(saved.appearance?.defaultTone || '')
  }
  const selfProfile = normalizeSelfProfile(saved.selfProfile)
  const contacts = (Array.isArray(saved.contacts) ? saved.contacts : []).map(contact => normalizeContact(contact, { selfProfile })).filter(Boolean)
  const savedSettings = saved.settings || {}
  return {
    ...structuredClone(defaults),
    contacts,
    selfPersona: require('./friendship.cjs').normalizePersona(saved.selfPersona),
    selfProfile,
    conversationSync: normalizeConversationSync(saved.conversationSync),
    friendship: normalizeFriendshipState(saved.friendship),
    discovery: normalizeDiscovery(saved.discovery),
    providers: Array.isArray(saved.providers) ? saved.providers : [],
    videoGreetings: {
      pending: (Array.isArray(saved.videoGreetings?.pending) ? saved.videoGreetings.pending : []).filter(item => item && item.id && contacts.some(contact => contact.name === item.name)).map(item => item.status === 'sending' ? { ...item, status: 'uncertain' } : item).slice(0, 20),
      sent: (Array.isArray(saved.videoGreetings?.sent) ? saved.videoGreetings.sent : []).slice(-200),
    },
    aiSkills: Array.isArray(saved.aiSkills) ? saved.aiSkills : [],
    logs: (Array.isArray(saved.logs) ? saved.logs : []).slice(0, 200).map(cleanLegacyLogEntry),
    sendHistory: Array.isArray(saved.sendHistory) ? saved.sendHistory : [],
    pendingDrafts: Array.isArray(saved.pendingDrafts) ? saved.pendingDrafts.slice(0, 50).map(d => d.source === 'event_followup' && d.status === 'sending' ? { ...d, status: 'uncertain', error: '上次发送中断，结果未确认，请先检查抖音记录' } : d) : [],
    expressionBatches: require('./expression-batch.cjs').normalizeExpressionBatches(saved.expressionBatches),
    shadowComparisons: Array.isArray(saved.shadowComparisons) ? saved.shadowComparisons.slice(-200) : [],
    proactiveState: saved.proactiveState && typeof saved.proactiveState === 'object' ? saved.proactiveState : structuredClone(defaults.proactiveState),
    lastSeenPairs: Array.isArray(saved.lastSeenPairs) ? saved.lastSeenPairs : [],
    lastSentPairs: Array.isArray(saved.lastSentPairs) ? saved.lastSentPairs : [],
    appearance,
    automation,
    settings: normalizeIncomingBurstSettings({
      ...defaults.settings,
      ...savedSettings,
      eventFollowup: { ...defaults.settings.eventFollowup, ...(savedSettings.eventFollowup || {}) },
      proactiveChat: {
        ...defaults.settings.proactiveChat,
        ...(savedSettings.proactiveChat || {}),
      },
    }),
  }
}

class JsonStorage {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'state.json')
    // 启动时滚动备份上一会话状态（保留 2 代）：数据损坏时可回滚
    this.backupPreviousState()
    this.state = this.read()
    this._memoryViewHashes = new Map()
    this.refreshMemoryViews()
  }

  refreshMemoryViews() {
    for (const contact of this.state.contacts || []) {
      const key = `${contact.id || ''}\n${contact.name}`
      if (!contact.socialBrain) {
        if (this._memoryViewHashes.has(key)) {
          try { persistMemoryViews(path.dirname(this.filePath), { ...contact, socialBrain: normalizeMemory() }); this._memoryViewHashes.delete(key) } catch (error) { this.lastMemoryViewError = error.message }
        }
        continue
      }
      const signature = createHash('sha256').update(JSON.stringify([contact.socialBrain, contact.learning?.ownerStyle, contact.profile?.examples, contact.profile?.examplesSource])).digest('hex')
      if (this._memoryViewHashes.get(key) === signature) continue
      try {
        persistMemoryViews(path.dirname(this.filePath), contact)
        this._memoryViewHashes.set(key, signature)
      } catch (error) {
        // state.json remains canonical. Derived views can be rebuilt; record
        // a local diagnostic without dropping successfully committed state.
        this.lastMemoryViewError = error.message
      }
    }
  }

  backupPreviousState() {
    try {
      if (!fs.existsSync(this.filePath)) return
      const dir = path.dirname(this.filePath)
      const prev = path.join(dir, 'state.prev.json')
      const prev2 = path.join(dir, 'state.prev2.json')
      // 用 copyFileRobustSync 而非 fs.copyFileSync：受限环境里 copyFileSync 会 EPERM，
      // 而读+原子写(rename 重试)仍可用，备份链才不会在这里静默断掉。
      try { if (fs.existsSync(prev)) copyFileRobustSync(prev, prev2) } catch { /* 轮转失败不阻塞启动 */ }
      try { copyFileRobustSync(this.filePath, prev) } catch { /* 备份失败不阻塞启动 */ }
    } catch { /* 备份失败不阻塞启动 */ }
  }

  read() {
    // P2-15.1：主文件损坏时依次尝试 .bak / 上一代备份，避免把"读取失败"误当成"空账号"。
    const dir = path.dirname(this.filePath)
    const sources = [this.filePath, `${this.filePath}.bak`, path.join(dir, 'state.prev.json'), path.join(dir, 'state.prev2.json')]
    for (const file of sources) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (saved && Number(saved.version) === 2) return migrateLegacy(saved)
        return migrateLegacy(saved || {})
      } catch { /* 尝试下一份备份 */ }
    }
    return structuredClone(defaults)
  }

  get() {
    return structuredClone(this.state)
  }

  // Batch polling must not clone unrelated contacts, messages and memories.
  getBatch() {
    return structuredClone(this.state.discovery?.batch || null)
  }

  update(patch) {
    this.state = deepMerge(this.state, patch || {})
    this.state.settings = normalizeIncomingBurstSettings({ ...defaults.settings, ...(this.state.settings || {}) })
    this.state.selfProfile = normalizeSelfProfile(this.state.selfProfile)
    this.state.conversationSync = normalizeConversationSync(this.state.conversationSync)
    // Journey belongs to the contact; preserve its original stageSince and
    // history during unrelated updates. Normalization never evaluates stages.
    this.state.contacts = (Array.isArray(this.state.contacts) ? this.state.contacts : []).map(contact => ({ ...contact, relationshipJourney: normalizeJourney(contact), sharedMemory: normalizeSharedMemory(contact, { selfProfile: this.state.selfProfile }) }))
    try {
      // P2-15：Windows 上 rename 覆盖可能被短暂占用（EPERM）；统一使用带重试的原子写入。
      writeFileAtomicSync(this.filePath, JSON.stringify(this.state))
      this.refreshMemoryViews()
    } catch (writeError) {
      // 主文件仍可读时保留旧状态，不让写盘失败拖垮运行中的进程
      try { JSON.parse(fs.readFileSync(this.filePath, 'utf8')); return this.get() } catch {}
      throw writeError
    }
    return this.get()
  }

  addLog(entry) {
    const settings = { ...defaults.settings, ...(this.state.settings || {}) }
    if (!settings.saveLogs) return this.get()
    const retentionDays = Math.max(0, Number(settings.logRetention) || 0)
    const cutoff = retentionDays ? Date.now() - (retentionDays * 24 * 60 * 60 * 1000) : 0
    const logs = [{ id: Date.now(), at: new Date().toISOString(), ...entry }, ...(this.state.logs || [])]
      .filter((item) => !cutoff || new Date(item.at).getTime() >= cutoff)
      .slice(0, 150)
    return this.update({ logs })
  }
}

module.exports = { JsonStorage, defaults, migrateLegacy, normalizeContact, emptyTurn, normalizeIncomingBurstSettings }
