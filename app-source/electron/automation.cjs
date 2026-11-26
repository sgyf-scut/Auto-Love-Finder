const { executePageScript } = require('./discovery/page-readiness.cjs')
const { withNicknameTools } = require('./nickname-identity.cjs')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { BrowserWindow, session } = require('electron')
const { analyzeLanguageStyle, daysSinceContact, factText, fetchWeatherContext, fetchHotTopicsCached, hotTopicForSparkCached, stripAiPrefix } = require('./ai-service.cjs')
const { shouldAutoReply, dailyMessageKey } = require('./conversation-engine.cjs')
const { factsConversationKey, shouldRefreshFacts, isFriendshipContact } = require('./conversation-modes.cjs')
const { EDITOR_SELECTOR, readInput, readDelivery, writeMessageInput, clearMatchingInput, clickMessageSend } = require('./message-editor.cjs')
const { syncMemory, compatibilityFacts } = require('./social-brain/memory-manager.cjs')
const { ProactiveEngine, scanDueEvents, quietNow } = require('./social-brain/proactive-engine.cjs')
const { activeChatIdentity } = require('./friendship.cjs')
const { ConversationBuffer } = require('./social-brain/conversation-buffer.cjs')
const { createExpressionBatch, executeExpressionBatch } = require('./expression-batch.cjs')
const { sendFavoriteSticker, SELECTORS: STICKER_SELECTORS, favoriteStickerDom } = require('./sticker-sender.cjs')
const { normalizeSharedMemory } = require('./social-brain/shared-memory.cjs')
const { assertPrivateDisclosure } = require('./social-brain/disclosure-policy.cjs')
const { ChatWindowCoordinator, chatWindowDeferred } = require('./chat-window-coordinator.cjs')
const { ConversationSyncManager } = require('./conversation-sync.cjs')
const { navigationUrl } = require('./navigation-policy.cjs')

const CHAT_URL = 'https://www.douyin.com/chat?isPopup=1'
const PARTITION = 'persist:douyin-account'
const AUTOMATION_POLL_MS = 1000
// 联系人资料里的回复频率选项 → 两次发送的最小间隔秒数（instant 不限）
const REPLY_FREQUENCY_SECONDS = { instant: 0, '30s': 30, '60s': 60, '300s': 300, '3600s': 3600 }
const SPARK_RETRY_MS = 5 * 60 * 1000
// AI 自己写进输入框的残留只在这么长的时间窗口内被认定为"自己的"，之后不再自动清理
const AI_OWNED_EDITOR_WRITE_TTL_MS = 10 * 60 * 1000

// 风控软化：按空闲时长计算下一轮轮询延迟（1×/2×/3× + ±20% 抖动，钳制在 5s–300s）
function computePollDelay(baseMs, idleMs = 0, random = Math.random) {
  const factor = idleMs < 5 * 60_000 ? 1 : (idleMs < 30 * 60_000 ? 2 : 3)
  const jitter = 0.8 + random() * 0.4
  return Math.max(5000, Math.min(300_000, Math.round(baseMs * factor * jitter)))
}

// 风控软化：真人不会秒回。按回复长度生成 1.5–12 秒的随机“打字时间”
function humanReplyDelay(text = '', random = Math.random) {
  const length = String(text || '').length
  return Math.min(12_000, Math.round(1500 + length * 55 + random() * 2500))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const normalizeEditorText = (text) => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
function isAutoFriendshipContact(contact) {
  return contact?.profile?.autoFriendship === true && isFriendshipContact(contact)
}
function autoFriendshipReplyEnabled(state, contact) {
  if (!isAutoFriendshipContact(contact)) return false
  if (contact.profile?.contactPipeline === true) {
    const candidate = (state.discovery?.candidates || []).find(item => item.id === contact.profile.candidateId)
    return state.friendship?.contactConfig?.enabled === true && state.friendship?.contactState?.paused !== true && !state.automation?.paused && contact.profile?.autoFriendshipSuspended !== true
      && candidate?.platformUserId === contact.profile.platformUserId && ['WAITING_REPLY', 'REPLIED', 'CONTACT'].includes(candidate.status)
  }
  return state.friendship?.automatic?.enabled === true && !state.automation?.paused && contact.profile?.autoFriendshipSuspended !== true
}
function extractPublicCommentItemText(value) {
  const lines = String(value || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (lines.length < 2) return ''

  const startsAfterMenu = lines[1] === '...' || lines[1] === '\u2026'
  const start = startsAfterMenu ? 2 : 1
  const timeLine = /^(?:\u521a\u521a|\d+\s*(?:\u79d2(?:\u949f)?|\u5206\u949f|\u5c0f\u65f6|\u5929|\u5468|\u4e2a\u6708|\u6708|\u5e74)\u524d|\u6628\u5929|\u524d\u5929|\d{1,2}[-/.]\d{1,2}|(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s*[\u00b7\u2022]\s*.*)?$/
  const end = lines.findIndex((line, index) => index >= start && timeLine.test(line))
  const actionLine = /^(?:\d+(?:\.\d+)?[\u4e07wW]?|\u5206\u4eab|\u56de\u590d|\u5c55\u5f00\s*\d+\s*\u6761\u56de\u590d|\u6536\u8d77\u56de\u590d)$/
  return lines
    .slice(start, end >= 0 ? end : lines.length)
    .filter((line) => !actionLine.test(line))
    .join(' ')
    .trim()
}

function extractReactAwemeId(root) {
  if (!root) return ''
  const validId = (value) => /^\d{17,20}$/.test(String(value || '')) ? String(value) : ''
  const fromProps = (props) => {
    const candidates = [
      props?.message?.parsedContent,
      props?.parsedContent,
      props?.message?.content,
      props?.item,
      props?.aweme,
      props,
    ]
    for (const value of candidates) {
      if (!value || typeof value !== 'object') continue
      for (const key of ['itemId', 'item_id', 'awemeId', 'aweme_id', 'groupId', 'group_id']) {
        const id = validId(value[key])
        if (id) return id
      }
      const sharedId = String(value.share_id || value.shareId || '').split('_').at(-1)
      const id = validId(sharedId)
      if (id) return id
    }
    return ''
  }
  const descendants = typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll('*')] : []
  for (const node of [root, ...descendants].slice(0, 160)) {
    for (const key of Object.keys(node || {})) {
      if (key.startsWith('__reactProps')) {
        const id = fromProps(node[key])
        if (id) return id
      }
      if (!key.startsWith('__reactFiber')) continue
      for (let fiber = node[key], depth = 0; fiber && depth < 20; fiber = fiber.return, depth += 1) {
        const id = fromProps(fiber.memoizedProps) || fromProps(fiber.pendingProps)
        if (id) return id
      }
    }
  }
  return ''
}
const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024
const AUDIO_TRANSCRIPTION_SECONDS = 90
const CHAT_MESSAGE_ROW_SELECTOR = '[class*="MessageBoxContentrowBox"], [class*="messageMessageBoxcontentBox"], [class*="MessageBoxContentcolumnBox"], [data-e2e*="message-item"], [data-e2e*="messageItem"]'
const CHAT_MESSAGE_MEDIA_SELECTOR = '[class*="sticker"], [class*="emoji"], [class*="imageMsg"], [class*="mediaMsg"], [class*="cardMsg"], [class*="ShareAweme" i]'

// Read the nickname element, not the row's layout-dependent innerText.
// Hidden Chromium windows may flatten nickname, streak, time and preview.
function extractConversationName(node) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const title = node?.querySelector('[data-e2e="conversation-name"], [class*="conversationConversationItemtitle"]:not([class*="titleWrapper"]), [class*="conversation-nickname"]')
  if (title) return clean(nicknameTools().read(title).text)
  const lines = String(node?.innerText || '').split(/\n+/).map(clean).filter(Boolean)
  if (lines.length > 1) return lines[0]
  // A flat row with metadata cannot safely be treated as a nickname.
  if (node?.querySelector('[class*="ConversationItemHint"], [class*="commonStreak"], [class*="time" i], [class*="unread" i]')) return ''
  return lines[0] || ''
}

extractConversationName = withNicknameTools(extractConversationName)

const normalizeConversationName = (value) => String(value || '').replace(/\s+/g, ' ').trim()
function isLegacyConversationName(previous, current) {
  const oldName = normalizeConversationName(previous)
  const name = normalizeConversationName(current)
  if (!name || !oldName.startsWith(name + ' ')) return false
  const suffix = oldName.slice(name.length).trim()
  return /^(?:\d+\s+)?(?:\d{1,2}:\d{2}|刚刚|昨天|今天|星期[一二三四五六日天]|\d+(?:分钟|小时|天)前|\d{1,2}月\d{1,2}日)(?!\d)/.test(suffix)
}

function resolveConversationName(value, contacts = []) {
  const name = normalizeConversationName(value)
  const exact = contacts.filter(c => normalizeConversationName(c.name) === name)
  if (exact.length === 1) return exact[0].name
  const candidates = contacts.filter(c => isLegacyConversationName(name, c.name))
  return candidates.length === 1 ? candidates[0].name : name
}

function conversationPlatformId(contact) {
  const value = contact?.profile?.platformUserId || contact?.platformUserId || ''
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : ''
}

function allowsLegacyConversationName(contact, record) {
  return Boolean(contact && !contact.conversationIdentityAmbiguous && !contact.profile?.autoFriendship && !contact.profile?.contactPipeline
    && !conversationPlatformId(contact) && !record?.platformUserId && !record?.expectedPlatformUserId && !record?.identityConflict && !record?.attempts)
}

// Only public profile links or the conversation participant's React properties
// can identify a row. Nicknames, avatars and arbitrary numeric data-id cannot.
function extractPlatformIdentity(node) {
  const ids = new Set()
  const add = value => { if (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)) ids.add(value) }
  for (const anchor of node?.querySelectorAll?.('a[href*="/user/"]') || []) {
    const href = anchor.getAttribute?.('href') || ''
    const match = href.match(/^(?:https:\/\/www\.douyin\.com)?\/user\/([A-Za-z0-9_-]+)(?:[?#/]|$)/)
    if (match) add(match[1])
  }
  for (const key of Object.keys(node || {}).filter(key => key.startsWith('__reactProps') || key.startsWith('__reactFiber'))) {
    let fiber = node[key]
    for (let depth = 0; fiber && depth < 1; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber
      for (const profile of [props.curConversation, props.conversation, props.opponentUserProfile, props.item?.conversation]) {
        add(profile?.toParticipantSecUserId || profile?._toParticipantSecUserId || profile?.sec_uid || profile?.secUid)
      }
    }
  }
  return ids.size === 1 ? { verified: true, platformUserId: [...ids][0], source: 'conversation_row_dom_react' } : { verified: false, ambiguous: ids.size > 1 }
}

function conversationListScroll(doc, operation = 'read', top = 0) {
  const wrapper = doc.querySelector('[class*="conversationConversationListwrapper"]')
  if (!wrapper) return null
  const candidates = [wrapper, ...wrapper.querySelectorAll('*')].slice(0, 100)
  const container = candidates.find(node => Number(node.scrollHeight) > Number(node.clientHeight) + 8) || wrapper
  if (operation === 'set') container.scrollTop = Math.max(0, Number(top) || 0)
  return { top: Number(container.scrollTop) || 0, height: Number(container.clientHeight) || 500,
    max: Math.max(0, (Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0)) }
}

function conversationSyncDeferred(reason, record) {
  const error = new Error(reason || '联系人会话暂不可用，已安排有限重试')
  error.code = 'CONVERSATION_SYNC_DEFERRED'; error.sendAttempted = false
  error.contactId = record?.contactId || ''; error.nextRetryAt = record?.nextRetryAt || 0
  return error
}

function reconcileConversationContacts(saved = [], fresh = []) {
  const renamed = {}
  const consumed = new Set()
  const unique = (items) => [...new Map(items.map(item => [JSON.stringify(item), item])).values()]
  const sameAvatar = (left, right) => {
    if (left === right) return true
    // Douyin serves the same avatar asset from rotating CDN hosts and signed URLs.
    try { return new URL(left).pathname === new URL(right).pathname } catch { return false }
  }
  const ambiguousFreshNames = new Set(fresh.filter(row => fresh.filter(other => other.name === row.name).length > 1).map(row => row.name))
  const contacts = fresh.filter(row => !(ambiguousFreshNames.has(row.name) && !conversationPlatformId(row) && saved.some(old => old.name === row.name))).map(row => {
    const rowId = conversationPlatformId(row)
    const uniqueFreshName = fresh.filter(item => item.name === row.name).length === 1
    const matches = saved.filter(old => {
      const oldId = conversationPlatformId(old)
      if (rowId && oldId) return rowId === oldId
      if (!uniqueFreshName) return false
      if (normalizeConversationName(old.name) === row.name) return saved.filter(item => item.name === row.name).length === 1
      if (rowId || oldId) return false // Renaming without a verified shared ID is not evidence.
      if (old.avatar && row.avatar && !sameAvatar(old.avatar, row.avatar)) return false
      const candidates = fresh.filter(candidate => isLegacyConversationName(old.name, candidate.name))
      return candidates.length === 1 && candidates[0] === row
    }).sort((a, b) => Number(a.name === row.name) - Number(b.name === row.name))
    let merged = {}
    for (const old of matches) {
      consumed.add(old)
      if (old.name !== row.name && saved.filter(item => item.name === old.name).length === 1) renamed[old.name] = row.name
      const learning = { ...(merged.learning || {}), ...(old.learning || {}) }
      if (merged.learning || old.learning) {
        learning.messages = mergeMessageHistory(merged.learning?.messages, old.learning?.messages)
        for (const key of ['facts', 'styleMessages', 'topicLog', 'mediaLog']) {
          learning[key] = unique([...(merged.learning?.[key] || []), ...(old.learning?.[key] || [])])
        }
      }
      const turn = Number(old.turn?.lastOutgoingAt || 0) >= Number(merged.turn?.lastOutgoingAt || 0) ? old.turn : merged.turn
      merged = { ...merged, ...old, profile: { ...(merged.profile || {}), ...(old.profile || {}) }, ...(merged.learning || old.learning ? { learning } : {}), ...(turn ? { turn } : {}) }
    }
    const stableId = merged.id && !isLegacyConversationName(merged.id, row.name) ? merged.id : row.id
    const aliases = rowId && matches.some(old => old.name !== row.name)
      ? { conversationAliases: [...new Set([...(merged.profile?.conversationAliases || []), ...matches.map(old => old.name).filter(name => name !== row.name)])].slice(-20) } : {}
    return { ...merged, ...row, ...(stableId ? { id: stableId } : {}),
      ...(merged.profile || row.profile ? { profile: { ...merged.profile, ...row.profile, ...aliases } } : {}) }
  })
  contacts.push(...saved.filter(old => !consumed.has(old)))
  for (const contact of contacts) {
    if (ambiguousFreshNames.has(contact.name) || contacts.filter(other => other.name === contact.name).length > 1) contact.conversationIdentityAmbiguous = true
    else if (contact.conversationIdentityAmbiguous) contact.conversationIdentityAmbiguous = false
  }
  return { contacts, renamed }
}

function renameConversationReferences(state, renamed) {
  const name = value => Object.prototype.hasOwnProperty.call(renamed, value) ? renamed[value] : value
  const rows = list => (Array.isArray(list) ? list : []).map(row => ({ ...row, name: name(row.name) }))
  return {
    automation: { ...state.automation,
      blacklist: (state.automation?.blacklist || []).map(name),
      aiDisabledContacts: (state.automation?.aiDisabledContacts || []).map(name),
      sparks: rows(state.automation?.sparks),
    },
    pendingDrafts: rows(state.pendingDrafts), sendHistory: rows(state.sendHistory),
    lastSeenPairs: rows(state.lastSeenPairs), lastSentPairs: rows(state.lastSentPairs),
    proactiveState: { ...state.proactiveState, sentContacts: (state.proactiveState?.sentContacts || []).map(name) },
  }
}

function pickLatestChatMessageRole(candidates, { editorRect, innerWidth = 0 } = {}) {
  const divider = editorRect ? editorRect.left + (editorRect.width / 2) : innerWidth * 0.65
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item && item.withinMessageRow === true && item.rect && item.rect.width > 0 && item.rect.height > 0)
    .sort((left, right) => right.rect.top - left.rect.top)
  if (!rows.length) return null
  const last = rows[0]
  if (last.me === true) return 'me'
  if (last.them === true) return 'contact'
  if (last.avatarRect && last.avatarRect.width > 0) {
    return (last.avatarRect.left + (last.avatarRect.width / 2)) > divider ? 'me' : 'contact'
  }
  return last.rect.left + (last.rect.width / 2) > divider ? 'me' : 'contact'
}

const tempPath = (prefix, extension) => path.join(
  os.tmpdir(),
  `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
)

const existingExecutable = (candidate) => {
  try {
    if (!candidate) return ''
    const stat = fs.statSync(candidate)
    return stat.isFile() ? candidate : ''
  } catch (_) {
    return ''
  }
}

const findFfmpegPath = () => {
  const candidates = []
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'ffmpeg.exe'),
      path.join(process.resourcesPath, 'ffmpeg'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'ffmpeg.exe'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'ffmpeg'),
    )
  }
  candidates.push(
    path.join(process.cwd(), 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg'),
    path.join(process.cwd(), 'resources', 'ffmpeg.exe'),
    path.join(process.cwd(), 'resources', 'ffmpeg'),
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg'),
    path.join(__dirname, '..', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'ffmpeg'),
    path.join(__dirname, '..', '..', 'ffmpeg.exe'),
    path.join(__dirname, '..', '..', 'ffmpeg'),
  )
  for (const candidate of candidates) {
    const found = existingExecutable(candidate)
    if (found) return found
  }
  const executableNames = process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat', 'ffmpeg']
    : ['ffmpeg']
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames) {
      const found = existingExecutable(path.join(dir, name))
      if (found) return found
    }
  }
  return ''
}

const runProcess = (file, args, { timeoutMs = 90000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true })
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (error, result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) reject(error)
    else resolve(result)
  }
  const timer = setTimeout(() => {
    const error = new Error('ffmpeg audio extraction timed out')
    error.code = 'PROCESS_TIMEOUT'
    child.kill('SIGKILL')
    finish(error)
  }, timeoutMs)
  child.stdout.on('data', (chunk) => { if (stdout.length < 4000) stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk.toString('utf8') })
  child.on('error', (error) => finish(error))
  child.on('close', (code) => {
    if (code === 0) return finish(null, { stdout, stderr })
    const tail = stderr.trim().slice(-800)
    finish(new Error(`ffmpeg exited with code ${code}${tail ? `: ${tail}` : ''}`))
  })
})

const safeMediaExtension = (value) => {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase()
    return /^\.(?:mp4|mov|m4v|webm|mkv|ts|m3u8)$/i.test(extension) ? extension : '.mp4'
  } catch (_) {
    return '.mp4'
  }
}

const downloadFile = (url, filePath, headers = {}, redirectCount = 0) => new Promise((resolve, reject) => {
  if (redirectCount > 5) return reject(new Error('video download redirected too many times'))
  const target = new URL(url)
  const client = target.protocol === 'https:' ? https : http
  const request = client.request(target, { method: 'GET', headers, timeout: 30000 }, (response) => {
    const status = Number(response.statusCode || 0)
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.resume()
      const nextUrl = new URL(response.headers.location, target).toString()
      downloadFile(nextUrl, filePath, headers, redirectCount + 1).then(resolve, reject)
      return
    }
    if (status < 200 || status >= 300) {
      response.resume()
      reject(new Error(`video download failed with HTTP ${status}`))
      return
    }
    const output = fs.createWriteStream(filePath)
    let bytes = 0
    let failed = false
    const fail = (error) => {
      if (failed) return
      failed = true
      response.destroy()
      output.destroy()
      try { fs.rmSync(filePath, { force: true }) } catch (_) {}
      reject(error)
    }
    response.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_VIDEO_DOWNLOAD_BYTES) {
        fail(new Error('video file is too large to transcribe'))
        return
      }
      if (!output.write(chunk)) response.pause()
    })
    output.on('drain', () => response.resume())
    response.on('end', () => {
      if (failed) return
      output.end(() => resolve({ filePath, bytes }))
    })
    response.on('error', fail)
    output.on('error', fail)
  })
  request.on('timeout', () => request.destroy(new Error('video download timed out')))
  request.on('error', reject)
  request.end()
})

const downloadToTemp = async (url, headers = {}) => {
  const filePath = tempPath('xusheng-video', safeMediaExtension(url))
  await downloadFile(url, filePath, headers)
  return filePath
}

const ffmpegHeaderArgs = (headers = {}) => {
  const lines = Object.entries(headers)
    .filter(([, value]) => String(value || '').trim())
    .map(([key, value]) => `${key}: ${String(value).replace(/\r?\n/g, ' ')}`)
  return lines.length ? ['-headers', `${lines.join('\r\n')}\r\n`] : []
}

const extractAudioWithFfmpeg = async (ffmpegPath, input, outputPath, headers = {}) => {
  const networkInput = /^https?:\/\//i.test(input)
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error']
  if (networkInput) args.push('-rw_timeout', '20000000', ...ffmpegHeaderArgs(headers))
  args.push(
    '-t', String(AUDIO_TRANSCRIPTION_SECONDS),
    '-i', input,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    outputPath,
  )
  await runProcess(ffmpegPath, args, { timeoutMs: 120000 })
  return outputPath
}

const extractAudioTrack = async ({ ffmpegPath, videoUrl, outputPath, headers = {} }) => {
  let directError
  try {
    await extractAudioWithFfmpeg(ffmpegPath, videoUrl, outputPath, headers)
    return { source: 'direct_url' }
  } catch (error) {
    directError = error
  }
  const downloadedPath = await downloadToTemp(videoUrl, headers)
  try {
    await extractAudioWithFfmpeg(ffmpegPath, downloadedPath, outputPath)
    return { source: 'downloaded_video' }
  } catch (error) {
    error.message = `${error.message}; direct_url_error=${directError.message}`
    throw error
  } finally {
    try { fs.rmSync(downloadedPath, { force: true }) } catch (_) {}
  }
}

const mediaRequestHeaders = async (url, win) => {
  const headers = {
    Accept: '*/*',
    Referer: 'https://www.douyin.com/',
    'User-Agent': 'Mozilla/5.0',
  }
  try {
    const userAgent = typeof win?.webContents?.getUserAgent === 'function' ? win.webContents.getUserAgent() : ''
    if (userAgent) headers['User-Agent'] = userAgent
  } catch (_) {}
  try {
    const cookieSession = typeof session?.fromPartition === 'function'
      ? session.fromPartition(this.partition)
      : session?.defaultSession
    const cookies = await cookieSession?.cookies?.get?.({ url })
    if (Array.isArray(cookies) && cookies.length) {
      headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }
  } catch (_) {}
  return headers
}

const normalizeVideoRecognitionMode = (value) => {
  const key = String(value || 'comments').toLowerCase()
  return ['smart', 'comments', 'lite'].includes(key) ? key : 'comments'
}

const videoRecognitionOptions = (settings = {}) => {
  const mode = normalizeVideoRecognitionMode(settings.videoRecognitionMode || settings.videoRecognitionStrength)
  // 模式优化（评论收集上限收敛至 20 条，大幅提速并削减 Token 消耗）：
  // smart    增强型文案+神评模式，精选 20 条热门神评与文案，快速精准又地道
  // comments 文案+高密度神评模式，精选 20 条热门神评
  // lite     极速轻量模式，精选 10 条热门神评
  const presets = {
    smart: { mode: 'comments', maxFrames: 0, audio: false, commentLimit: 20, commentWaitMs: 2800, commentScrolls: 3, publicPageOnly: true },
    comments: { mode: 'comments', maxFrames: 0, audio: false, commentLimit: 20, commentWaitMs: 2800, commentScrolls: 3, publicPageOnly: true },
    lite: { mode: 'lite', maxFrames: 0, audio: false, commentLimit: 10, commentWaitMs: 2000, commentScrolls: 2, publicPageOnly: true },
  }
  return presets[mode] || presets.comments
}

const normalizeCommentContext = (value = {}, limit = 5) => {
  const source = value && typeof value === 'object' ? value : {}
  const comments = (Array.isArray(source.comments) ? source.comments : Array.isArray(source.videoComments) ? source.videoComments : [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 2)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, Math.max(0, Math.min(50, Math.floor(Number(limit) || 0))))
  return {
    videoPageTitle: String(source.title || source.videoPageTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    videoPageAuthor: String(source.author || source.videoPageAuthor || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    videoPageDescription: String(source.description || source.videoPageDescription || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    videoSharedComment: String(source.sharedComment || source.videoSharedComment || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    videoComments: comments,
    videoCommentSource: String(source.source || source.videoCommentSource || ''),
    videoCommentError: String(source.error || source.videoCommentError || ''),
  }
}

const visibleMediaJunk = /^(?:分享|来自(?:视频|图文|图片|作品)|播放|评论|写评论|发表评论|点赞|收藏|转发|打开抖音|点击查看|展开|收起|查看更多|全部评论|暂无评论|广告|举报)$/i

function normalizeVisibleMediaContext(value = {}, limit = 5) {
  const raw = typeof value === 'string'
    ? value
    : String(value?.visibleText || value?.shareText || value?.shareTitle || value?.text || '')
  const maxComments = Math.max(0, Math.min(50, Math.floor(Number(limit) || 0)))
  const lines = raw
    .split(/[\r\n]+/)
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 2)
    .filter((line, index, list) => list.indexOf(line) === index)
  const compact = lines.join(' ')
  const comments = []
  let description = ''
  let afterCommentHeader = false
  let afterVideoLabel = false

  const pushComment = (line) => {
    const text = String(line || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length < 2 || visibleMediaJunk.test(text)) return
    if (/^(?:分享\s*@?.{0,48}\s*的评论|来自视频)$/i.test(text)) return
    if (!comments.some((item) => item === text || item.includes(text) || text.includes(item))) comments.push(text.slice(0, 180))
  }

  for (const line of lines) {
    if (/分享\s*@?.{0,48}\s*的评论/i.test(line) || /分享\s*\[?\s*评论\s*\]?/i.test(line)) {
      afterCommentHeader = true
      afterVideoLabel = false
      continue
    }
    if (/来自(?:视频|图文|图片|作品)/i.test(line)) {
      const inlineDescription = line.replace(/^.*?来自(?:视频|图文|图片|作品)\s*[:：]?\s*/i, '').trim()
      if (inlineDescription && inlineDescription !== line && !visibleMediaJunk.test(inlineDescription)) description = inlineDescription.slice(0, 500)
      afterVideoLabel = true
      afterCommentHeader = false
      continue
    }
    if (afterVideoLabel && !description && !visibleMediaJunk.test(line)) {
      description = line.slice(0, 500)
      continue
    }
    if (afterCommentHeader) pushComment(line)
  }

  if (!comments.length) {
    const match = compact.match(/分享\s*@?.{1,48}?\s*的评论\s+(.{2,180}?)(?:\s+来自视频\s+(.{2,500}))?$/i)
    if (match) {
      pushComment(match[1])
      if (!description && match[2]) description = match[2].replace(/\s+/g, ' ').trim().slice(0, 500)
    }
  }

  return {
    videoPageTitle: '',
    videoPageDescription: description,
    videoSharedComment: comments[0] || '',
    videoComments: comments.slice(0, maxComments),
    videoCommentSource: comments.length || description ? 'visible_card' : '',
  }
}

function mergePublicMediaContext(publicContext = {}, visibleText = '', limit = 5) {
  const publicMeta = normalizeCommentContext(publicContext, limit)
  const visibleMeta = normalizeVisibleMediaContext(visibleText, limit)
  const maxComments = Math.max(0, Math.min(50, Math.floor(Number(limit) || 0)))
  const sharedComment = visibleMeta.videoSharedComment || publicMeta.videoSharedComment || ''
  const mergedComments = [...new Set([
    sharedComment,
    ...publicMeta.videoComments,
    ...visibleMeta.videoComments,
  ].map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter((item) => item.length >= 2))].slice(0, maxComments)
  const author = publicMeta.videoPageAuthor
  const rawTitle = publicMeta.videoPageTitle
  const titleWithoutPlatform = rawTitle
    .replace(/\s*[-|｜·]\s*(?:抖音|Douyin).*$/i, '')
    .trim()
  const normalizedAuthor = author.replace(/^@/, '').replace(/\s+/g, '').trim()
  const normalizedTitle = titleWithoutPlatform.replace(/^@/, '').replace(/\s+/g, '').trim()
  const visibleLines = String(visibleText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const visibleAuthorOnly = visibleLines.length === 1
    && visibleLines[0].length <= 60
    && !/(?:分享|评论|来自视频|来自图文|#)/.test(visibleLines[0])
    ? visibleLines[0].replace(/^@/, '').replace(/\s+/g, '').trim()
    : ''
  const sourceOnlyTitle = !titleWithoutPlatform
    || /^(?:抖音|Douyin)(?:\s*[-|｜·].*)?$/i.test(titleWithoutPlatform)
    || /^.{1,48}(?:的作品|的主页|的抖音)$/i.test(titleWithoutPlatform)
    || (normalizedAuthor && normalizedTitle === normalizedAuthor)
    || (visibleAuthorOnly && normalizedTitle.toLowerCase() === visibleAuthorOnly.toLowerCase())
  const publicTitle = sourceOnlyTitle ? '' : titleWithoutPlatform

  return {
    videoPageTitle: publicTitle || visibleMeta.videoPageTitle || '',
    videoPageAuthor: author || visibleMeta.videoPageAuthor || visibleAuthorOnly || '',
    videoPageDescription: publicMeta.videoPageDescription || visibleMeta.videoPageDescription || '',
    videoSharedComment: sharedComment,
    videoComments: mergedComments,
    videoCommentSource: publicMeta.videoCommentSource || visibleMeta.videoCommentSource || '',
    videoCommentError: publicMeta.videoCommentError || '',
    videoPageUrlFound: Boolean(publicContext?.videoPageUrlFound),
  }
}
const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const timeToMinutes = (value) => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return Number.POSITIVE_INFINITY
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
    ? hours * 60 + minutes
    : Number.POSITIVE_INFINITY
}

const minutesToDate = (minutes, value = new Date()) => {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return date
}

const sparkMessageOptions = (task) => {
  const raw = Array.isArray(task?.messages) && task.messages.length
    ? task.messages
    : String(task?.message || '').split(/\r?\n/)
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
}

const dailySparkMessage = (task, value = new Date()) => {
  const options = sparkMessageOptions(task)
  if (!options.length) return String(task?.message || '').trim()
  const date = value instanceof Date ? value : new Date(value)
  const indexForDate = (day) => {
    const key = `${localDateKey(day)}:${task?.id ?? ''}:${task?.name ?? ''}`
    let hash = 0
    for (let index = 0; index < key.length; index += 1) {
      hash = Math.imul(hash ^ key.charCodeAt(index), 16777619) >>> 0
    }
    return hash % options.length
  }
  const todayIndex = indexForDate(date)
  if (options.length > 1) {
    const yesterday = new Date(date)
    yesterday.setDate(yesterday.getDate() - 1)
    if (todayIndex === indexForDate(yesterday)) return options[(todayIndex + 1) % options.length]
  }
  return options[todayIndex]
}

const resolveSparkTask = (task, value = new Date()) => {
  const message = dailySparkMessage(task, value)
  return message ? { ...task, message } : { ...task }
}
const normalizeMediaEvidence = (value) => value && ['visible_message_dom', 'visible_quote_dom'].includes(value.source) ? {
  source: value.source,
  urls: [...new Set((Array.isArray(value.urls) ? value.urls : []).map(String).filter(url => /^(?:https?:|blob:|data:image\/)/i.test(url)))].slice(0, 8),
  alt: String(value.alt || '').slice(0, 300), title: String(value.title || '').slice(0, 300),
} : undefined
const normalizeQuote = (value) => value?.source === 'visible_quote_dom' ? {
  source: 'visible_quote_dom', text: String(value.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  type: ['text', 'image', 'gif', 'sticker', 'video', 'share', 'media'].includes(value.type) ? value.type : 'text',
  ...(normalizeMediaEvidence(value.mediaEvidence) ? { mediaEvidence: normalizeMediaEvidence(value.mediaEvidence) } : {}),
} : undefined
const normalizeHistoryMessage = (item) => ({
  role: item?.role === 'me' ? 'me' : 'contact',
  text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  ...(item?.id ? { id: item.id } : {}),
  ...(item?.messageId ? { messageId: String(item.messageId).slice(0, 100) } : {}),
  ...(item?.type && ['text', 'image', 'gif', 'sticker', 'video', 'share', 'media', 'album'].includes(item.type) ? { type: item.type } : {}),
  ...(item?.mediaKind ? { mediaKind: String(item.mediaKind).slice(0, 20) } : {}),
  ...(normalizeMediaEvidence(item?.mediaEvidence) ? { mediaEvidence: normalizeMediaEvidence(item.mediaEvidence) } : {}),
  ...(normalizeQuote(item?.quote) ? { quote: normalizeQuote(item.quote) } : {}),
  ...(item?.at ? { at: item.at } : {}),
  ...(typeof item?.human === 'boolean' ? { human: item.human } : {}),
  ...(typeof item?.verifiedHuman === 'boolean' ? { verifiedHuman: item.verifiedHuman } : {}),
  ...(['manual_owner', 'ai_generated', 'contact_human'].includes(item?.source) ? { source: item.source } : {}),
  ...(item?.identityVerified === true && typeof item.platformUserId === 'string' && /^[A-Za-z0-9_-]+$/.test(item.platformUserId)
    ? { platformUserId: item.platformUserId, identityVerified: true, ...(item.observedAt ? { observedAt: item.observedAt } : {}) } : {}),
})

// Serialized into the chat renderer. All evidence is confined to one message
// row; quoted content is kept separate from the author's current utterance.
function readVisibleMessageEvidence(node) {
  const quoteSelector = '[data-e2e*="quote" i], [class*="quote" i], [class*="replyMsg" i], [class*="referMsg" i]'
  const quoteNode = node.querySelector(quoteSelector)
  const safeMedia = (root) => [...root.querySelectorAll('video, img, [style*="background-image"]')].filter(el => {
    let signature = ''
    for (let current = el; current && current !== root; current = current.parentElement) signature += ' ' + String(current.className || '')
    const rect = el.getBoundingClientRect()
    return !/avatar|userhead|headimage|profilephoto/i.test(signature) && rect.width >= 32 && rect.height >= 32
  })
  const classify = (root, media) => {
    const signature = [root.className, ...media.map(el => {
      let classes = ''
      for (let current = el; current && current !== root; current = current.parentElement) classes += ' ' + String(current.className || '')
      return classes + ' ' + (el.currentSrc || el.src || '')
    })].join(' ')
    if (media.some(el => el.tagName === 'VIDEO') || /ShareAweme|awemeContainer|videoMsg/i.test(signature)) return 'video'
    if (/gif|动图/i.test(signature)) return 'gif'
    if (/sticker|emoji|表情/i.test(signature)) return 'sticker'
    return media.length ? 'image' : 'text'
  }
  const mediaEvidence = (media, source) => ({ source,
    urls: [...new Set(media.map(el => el.currentSrc || el.src || el.poster || el.getAttribute?.('src') || '').filter(Boolean))].slice(0, 8),
    alt: media.map(el => el.getAttribute?.('alt') || '').filter(Boolean).join(' ').slice(0, 300),
    title: media.map(el => el.getAttribute?.('title') || '').filter(Boolean).join(' ').slice(0, 300),
  })
  const quotedMedia = quoteNode ? safeMedia(quoteNode) : []
  const media = safeMedia(node).filter(el => !quoteNode?.contains(el))
  const raw = String(node.innerText || node.textContent || '')
  const quoteText = String(quoteNode?.innerText || quoteNode?.textContent || '').trim()
  const text = (quoteText ? raw.replace(quoteText, '') : raw).split(/\n+/).map(part => part.trim())
    .filter(part => part && !/^(?:已读|未读|刚刚|昨天|今天|\d{1,2}:\d{2})$/.test(part)).join(' ').replace(/\s+/g, ' ').trim().slice(0, 500)
  const type = classify(node, media)
  const ids = ['data-message-id', 'data-msg-id', 'data-item-id', 'data-id'].map(attr => node.getAttribute?.(attr)).filter(Boolean)
  return { text, type, mediaKind: type === 'text' ? '' : type, ids,
    ...(media.length ? { mediaEvidence: mediaEvidence(media, 'visible_message_dom') } : {}),
    ...(quoteNode ? { quote: { text: quoteText.slice(0, 500), type: classify(quoteNode, quotedMedia), source: 'visible_quote_dom',
      ...(quotedMedia.length ? { mediaEvidence: mediaEvidence(quotedMedia, 'visible_quote_dom') } : {}) } } : {}),
  }
}

// Both burst discovery and the final freshness check must read the same row,
// sender and occurrence ordinal. Two DOM readers can otherwise assign different
// IDs to an unchanged bubble (especially nested rows and repeated short text).
// Serialized with readVisibleMessageEvidence and CHAT_MESSAGE_ROW_SELECTOR.
function readVisibleChatRows() {
  const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
  const editorRect = editor?.getBoundingClientRect()
  const divider = editorRect ? editorRect.left + editorRect.width / 2 : window.innerWidth * 0.65
  const candidates = [...document.querySelectorAll(CHAT_MESSAGE_ROW_SELECTOR)]
  const rows = candidates.filter((node, index) => {
    const rect = node.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    return !candidates.some((other, otherIndex) => otherIndex !== index && other.parentElement === node && other.getBoundingClientRect().height >= rect.height * 0.7)
  }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
  const result = []
  for (const node of rows) {
    const message = readVisibleMessageEvidence(node)
    if (!message.text && !message.mediaEvidence && !message.quote) continue
    let signature = ''
    for (let current = node, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) signature += ' ' + String(current.className || '')
    const me = /isFromMe|MessageItemTextisFromMe/i.test(signature) || /(?:^|[\s_-])(self|mine|my|right|send|owner)(?:[\s_-]|$)/i.test(signature)
    const them = /(?:^|[\s_-])(other|left|receive|peer)(?:[\s_-]|$)/i.test(signature)
    const avatar = node.querySelector('[class*="avatar" i], img[src*="avatar"], [class*="Avatar" i]')
    const avatarRect = avatar?.getBoundingClientRect()
    const bubble = node.querySelector('[class*="MessageItemShareAweme" i], [class*="ShareAweme" i], [class*="MessageItemText" i], [class*="cardMsg" i], [class*="imageMsg" i], [class*="mediaMsg" i], [class*="textMsg" i], [class*="bubble" i], video, img:not([class*="avatar" i])')
      || node.querySelector('[class*="content"]:not([class*="rowBox"]):not([class*="columnBox"]):not([class*="contentBox"]):not([class*="ClickArea" i]), [class*="text"], [style*="background-image"], [class*="video" i], [class*="image" i], [class*="card" i]') || node
    const rect = bubble.getBoundingClientRect()
    const role = me ? 'me' : them ? 'contact' : avatarRect?.width > 0 && avatarRect?.height > 0
      ? avatarRect.left + avatarRect.width / 2 > divider ? 'me' : 'contact'
      : rect.left + rect.width / 2 > divider ? 'me' : 'contact'
    const fallbackOrdinal = result.filter(item => item.role === role && item.message.text === message.text
      && JSON.stringify(item.message.mediaEvidence?.urls || []) === JSON.stringify(message.mediaEvidence?.urls || [])
      && JSON.stringify(item.message.quote?.mediaEvidence?.urls || []) === JSON.stringify(message.quote?.mediaEvidence?.urls || [])).length
    result.push({ node, message, role, fallbackOrdinal })
  }
  return result
}

const MEDIA_MESSAGE_FINGERPRINT_SEPARATOR = '\u241e'
const contactMessageKey = (contact) => String(contact?.messageKey || contact?.preview || '')
const normalizeMessageFingerprintText = (value) => String(value || '')
  .replace(/(?:刚刚|昨天|今天|星期[一二三四五六日天]|\d+(?:分钟|小时|天)前|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 1200)
const normalizeMessageFingerprintUrl = (value) => {
  const text = String(value || '').trim()
  if (!text || /^(?:blob:|data:)/i.test(text)) return ''
  try {
    const parsed = new URL(text, 'https://www.douyin.com')
    return decodeURIComponent(parsed.pathname).replace(/\/+$/, '')
  } catch (_) {
    return text.split(/[?#]/, 1)[0]
  }
}
function stableMessageFingerprint({ ids = [], urls = [], text = '', role = '', fallbackOrdinal = 0 } = {}) {
  const stableIds = [...new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || '').trim()).filter(Boolean))].sort()
  const stableUrls = [...new Set((Array.isArray(urls) ? urls : []).map(normalizeMessageFingerprintUrl).filter(Boolean))].sort()
  const stableText = normalizeMessageFingerprintText(text)
  const stableParts = [String(role || ''), ...stableIds.map((value) => `id:${value}`), ...stableUrls.map((value) => `url:${value}`), `text:${stableText}`]
  // A row without a platform message ID needs its position among matching visible
  // rows: the same sticker asset can occur in several distinct messages, and short
  // repeated text ("嗯嗯", "哈哈") is common. Both DOM readers compute the ordinal
  // from the same row set, so discovery and freshness agree, and two identical
  // bubbles stay distinguishable instead of collapsing into one.
  if (!stableIds.length) stableParts.push(`ordinal:${Math.max(0, Number(fallbackOrdinal) || 0)}`)
  const signature = stableParts.join('\u241f')
  return signature.replace(/[\u241f:]/g, '').trim() ? `msg-${createHash('sha256').update(signature).digest('hex').slice(0, 20)}` : ''
}
const mediaMessageKey = (contact, fingerprint) => {
  const preview = String(contact?.preview || '').trim()
  const identity = String(fingerprint || '').trim()
  return identity ? `${preview}${MEDIA_MESSAGE_FINGERPRINT_SEPARATOR}${identity}` : contactMessageKey(contact)
}
const isMediaMessageKey = (value, preview) => String(value || '').startsWith(`${String(preview || '').trim()}${MEDIA_MESSAGE_FINGERPRINT_SEPARATOR}`)

const CONVERSATION_TIME_RE = /^(?:刚刚|昨天|今天|星期[一二三四五六日天]|\d{1,2}:\d{2}|\d+(?:分钟|小时|天)前|\d{1,2}月\d{1,2}日)$/

function extractConversationTimeLabel(lines, explicitTime = '') {
  const explicit = String(explicitTime || '').replace(/\s+/g, ' ').trim()
  if (explicit && CONVERSATION_TIME_RE.test(explicit)) return explicit
  return (Array.isArray(lines) ? lines : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .find((value, index) => index > 0 && CONVERSATION_TIME_RE.test(value)) || ''
}

function weekdayNumber(label) {
  const key = String(label || '').replace(/^星期/, '')
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[key]
}

function resolveConversationSentAt(label, nowValue = new Date()) {
  const text = String(label || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const now = nowValue instanceof Date ? new Date(nowValue.getTime()) : new Date(nowValue)
  if (Number.isNaN(now.getTime())) return ''
  if (text === '刚刚') return now.toISOString()
  let match = text.match(/^(\d+)(分钟|小时|天)前$/)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2]
    const ms = unit === '分钟' ? amount * 60_000 : unit === '小时' ? amount * 60 * 60_000 : amount * 24 * 60 * 60_000
    return new Date(now.getTime() - ms).toISOString()
  }
  match = text.match(/^(\d{1,2}):(\d{2})$/)
  if (match) {
    const date = new Date(now.getTime())
    date.setHours(Number(match[1]), Number(match[2]), 0, 0)
    if (date.getTime() - now.getTime() > 5 * 60_000) date.setDate(date.getDate() - 1)
    return date.toISOString()
  }
  if (text === '今天') {
    const date = new Date(now.getTime())
    date.setHours(0, 0, 0, 0)
    return date.toISOString()
  }
  if (text === '昨天') {
    const date = new Date(now.getTime())
    date.setDate(date.getDate() - 1)
    date.setHours(0, 0, 0, 0)
    return date.toISOString()
  }
  const weekday = weekdayNumber(text)
  if (weekday !== undefined) {
    const date = new Date(now.getTime())
    const diff = (date.getDay() - weekday + 7) % 7 || 7
    date.setDate(date.getDate() - diff)
    date.setHours(0, 0, 0, 0)
    return date.toISOString()
  }
  match = text.match(/^(\d{1,2})月(\d{1,2})日$/)
  if (match) {
    const date = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), 0, 0, 0, 0)
    if (date.getTime() - now.getTime() > 24 * 60 * 60_000) date.setFullYear(date.getFullYear() - 1)
    return date.toISOString()
  }
  return ''
}

function conversationTimeMeta(contact, now = new Date()) {
  const label = String(contact?.sentAtLabel || contact?.timeLabel || '').trim()
  const sentAt = contact?.sentAt || resolveConversationSentAt(label, now)
  return { sentAtLabel: label, sentAt }
}

const isVideoPreview = (value) => /(?:\[?视频\]?|发来一个视频|分享(?:了)?视频|分享(?:了)?作品|video|短视频|视频卡片|来自视频|播放|[▶⏵]|\d{1,3}["秒]?\s*$|作品|看这个|你看看|发来了一段)/i.test(String(value || ''))
const mediaPreviewKind = (value) => {
  const text = String(value || '')
  if (/暂不支持该消息类型/i.test(text)) return 'unsupported'
  if (isVideoPreview(text)) return 'video'
  if (/(?:\[?媒体\]?|媒体卡片|分享\s*@|来自视频|分享\s*\[?\s*评论\s*\]?|分享(?:了)?评论)/i.test(text)) return 'share'
  if (/(?:\[?图集\]?|分享\[图集\]|相册)/i.test(text)) return 'album'
  if (/(?:\[?图片\]?|照片|photo|image)/i.test(text)) return 'image'
  if (/(?:\[?动图\]?|GIF)/i.test(text)) return 'gif'
  if (/(?:\[?表情\]?|表情包|emoji)/i.test(text)) return 'sticker'
  if (/(?:分享(?:了)?(?:链接|商品|直播|音乐|作品)|\[分享\])/i.test(text)) return 'share'
  return ''
}

// 竞态保护判定（AI 回复吞掉对方第二条消息的根因）：
// 对方在 AI 处理上一条消息期间又发来新消息时，聊天面板最后一条可能是 AI 刚发出的回复，
// "最后一条是我发的"会误判为无需回复，并把这条新消息的 key 消费掉，导致它永远不被处理。
// 判定：当前预览像"对方发来的媒体"（我自己只发文字/表情，不会是视频/图片/分享卡片），
// 且不等于我最近一次发出的内容 → 视为疑似新消息，暂不消费 key，留待下轮重新确认。
const INCOMING_MEDIA_KINDS = ['video', 'album', 'image', 'gif', 'share']
const shouldDeferConsumptionOnFromMe = (preview, myLastSentText) => {
  const previewText = String(preview || '').replace(/\s+/g, ' ').trim()
  if (!previewText) return false
  if (previewText === String(myLastSentText || '').replace(/\s+/g, ' ').trim()) return false
  // 「分享[商品]/分享[音乐]」等带方括号的分享预览不走 mediaPreviewKind（历史上按文本回复），
  // 但它们同样是"对方发来的卡片"，在竞态保护里也应暂不消费
  if (/^分享\[|^\[分享/.test(previewText)) return true
  return INCOMING_MEDIA_KINDS.includes(mediaPreviewKind(previewText))
}
const pureMediaPreviewPattern = /^(?:\[?\s*(?:视频|媒体|图集|图片|照片|动图|表情|GIF)\s*\]?|分享\s*@?[^\s，,。；;：:]{1,48}\s*的(?:作品|视频|评论)|分享\s*\[?\s*(?:视频|媒体|图集|图片|评论)\s*\]?|分享(?:了)?(?:视频|作品|评论|链接|商品|直播|音乐)|发来一个视频|发来了一段|视频卡片|媒体卡片|来自视频|播放|作品|[▶⏵]|\d{1,3}["秒]?|暂不支持该消息类型|\[暂不支持该消息类型\])$/i
const mediaMarkerPattern = /(?:\[?\s*(?:视频|媒体|图集|图片|照片|动图|表情|GIF)\s*\]?|分享\s*@?[^\s，,。；;：:]{1,48}\s*的(?:作品|视频|评论)|分享\s*\[?\s*(?:视频|媒体|图集|图片|评论)\s*\]?|分享(?:了)?(?:视频|作品|评论|链接|商品|直播|音乐)|发来一个视频|发来了一段|视频卡片|媒体卡片|来自视频|播放|作品|看这个|你看看|[▶⏵]|\d{1,3}["秒]?)/ig
const hasReplyablePreviewText = (value) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text || pureMediaPreviewPattern.test(text) || /暂不支持该消息类型/i.test(text)) return false
  const remainder = text.replace(mediaMarkerPattern, '').replace(/暂不支持该消息类型/g, '').replace(/\s+/g, '').trim()
  return remainder.length > 0
}

const unavailableMediaReplyPattern = /(?:没|未|无法|不能).{0,8}(?:加载|显示|弹出|读取|看见|看到)|(?:看|读|加载|显示).{0,4}不到|(?:没|没有).{0,6}(?:内容|东西|画面)|(?:截|发)(?:个|张)?图|截图(?:发|给|看)/i
const isUnavailableMediaReply = (value) => unavailableMediaReplyPattern.test(String(value || '').replace(/\s+/g, ' ').trim())

const normalizeCapturedMedia = (value, hintedKind = '') => {
  const source = value && typeof value === 'object' ? value : {}
  const frames = (Array.isArray(value) ? value : Array.isArray(source.frames) ? source.frames : [])
    .map((frame) => String(frame || '').trim())
    .filter((frame) => /^data:image\/(?:jpeg|png|webp);base64,/i.test(frame) || /^https?:\/\//i.test(frame))
    .slice(0, 3)
  const mediaKind = String(source.mediaKind || hintedKind || (source.detectedVideo ? 'video' : frames.length ? 'media' : '') || '')
  const decodedVideoFrames = Math.max(0, Math.floor(Number(source.decodedVideoFrames || 0) || 0))
  const detectedVideo = Boolean(source.detectedVideo || mediaKind === 'video')
  const videoReady = source.videoReady === true || decodedVideoFrames > 0
  const confidence = String(source.confidence || (
    !frames.length ? 'none' : detectedVideo ? (videoReady ? 'high' : 'low') : mediaKind === 'share' ? 'medium' : 'medium'
  ))
  const commentContext = normalizeCommentContext(source, source.videoComments?.length || 0)
  return {
    frames,
    mediaKind,
    detectedVideo,
    videoReady,
    decodedVideoFrames,
    videoAddressFound: Boolean(source.videoAddressFound),
    videoPageUrlFound: Boolean(source.videoPageUrlFound),
    posterFound: Boolean(source.posterFound),
    captureSource: String(source.captureSource || ''),
    audioTranscript: String(source.audioTranscript || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    audioTranscriptionSource: String(source.audioTranscriptionSource || ''),
    audioTranscriptionModel: String(source.audioTranscriptionModel || ''),
    audioTranscriptionError: String(source.audioTranscriptionError || ''),
    ...commentContext,
    confidence,
    reason: String(source.reason || ''),
    capturedMessageId: String(source.capturedMessageId || ''),
    captureEvidence: source.captureEvidence && typeof source.captureEvidence === 'object' ? { ...source.captureEvidence } : { source: 'visible_message_dom', status: 'failed', reason: String(source.reason || 'unbound_media') },
    frameCoverage: String(source.frameCoverage || (frames.length ? detectedVideo && videoReady ? 'representative_frames' : 'current_frame_only' : 'none')),
    originalText: String(source.originalText || '').slice(0, 500),
    ...(normalizeMediaEvidence(source.mediaEvidence) ? { mediaEvidence: normalizeMediaEvidence(source.mediaEvidence) } : {}),
    ...(normalizeQuote(source.quote) ? { quote: normalizeQuote(source.quote) } : {}),
  }
}

const hasPublicMediaContext = (media = {}) => Boolean(
  String(media.videoPageTitle || '').trim()
    || String(media.videoPageDescription || '').trim()
    || String(media.videoPageAuthor || '').trim()
    || String(media.videoSharedComment || '').trim()
    || (Array.isArray(media.videoComments) && media.videoComments.length)
)

const shouldUseVideoFrameFallback = (recognition = {}, mediaCapture = {}) => (
  !mediaCapture.frames?.length
  && (recognition.publicPageOnly !== true || !hasPublicMediaContext(mediaCapture))
)

function extractConversationPreview(lines, explicitPreview = '', explicitStreak = '') {
  const preview = String(explicitPreview || '').replace(/\s+/g, ' ').trim()
  if (preview) return preview.slice(0, 180)

  const normalized = (Array.isArray(lines) ? lines : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const streak = String(explicitStreak || '').trim()
  const metadataNumberIndex = normalized.findIndex((value, index) => index > 0 && index <= 2 && /^\d{1,4}$/.test(value))
  return normalized.filter((value, index) => {
    if (index === 0 || value === streak || index === metadataNumberIndex) return false
    return !/^(?:刚刚|昨天|今天|星期[一二三四五六日天]|\d{1,2}:\d{2}|\d+(?:分钟|小时|天)前|已读|未读)$/.test(value)
  }).join(' ').slice(0, 180)
}

function extractStreakCount(explicitStreak = '', lines = []) {
  const explicit = String(explicitStreak || '').match(/\d+/)
  if (explicit) return Number(explicit[0])
  const labelled = (Array.isArray(lines) ? lines : []).find((value) => /鐏姳|杩炵画\s*\d+\s*澶﹟^\d+\s*澶?/.test(String(value)))
  return Number((String(labelled || '').match(/\d+/) || [0])[0])
}

function mergeMessageHistory(previous, visible) {
  const meaningful = item => item.text || item.mediaEvidence || item.quote
  const content = item => JSON.stringify([item.role, item.text, item.type || 'text', item.mediaEvidence || null, item.quote || null])
  const identity = item => item.messageId || item.id
  // A `msg-…` id is a DOM fingerprint, not a platform id: it is derived from the
  // row's position in the visible window, so the same bubble is issued a new id
  // every time the window shifts. Only ids that are not fingerprints are stable
  // identity; a fingerprint-only row has to be matched by content instead.
  const stableIdentity = item => { const id = String(identity(item) || ''); return id && !id.startsWith('msg-') ? id : '' }
  const rows = [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(visible) ? visible : [])]
    .map(normalizeHistoryMessage)
    .filter(meaningful)
  // Each message must be stored once. A sliding visible window can begin before the
  // stored tail and re-surface rows that are already saved (only the last 20 rows are
  // read, and short repeated text shifts the window), so a tail-versus-head overlap
  // never aligned and whole windows were appended again on every read. Deduplicate by
  // identity across the entire merged list instead, keeping the earliest occurrence so
  // chronological order survives. Identity and content are one namespace rather than
  // two: a row is dropped when its stable id repeats, or — for plain text — when its
  // content repeats, which is what collapses the fingerprint-only copy of a message
  // against the copy that carries a real id. Media rows keep their positional identity
  // so two genuinely distinct identical stickers are not folded into one.
  const merged = []
  const indexByRawId = new Map()
  const indexByContent = new Map()
  for (const item of rows) {
    const raw = identity(item)
    if (raw && indexByRawId.has(raw)) {
      // The same message re-read under the same id. A copy carrying a real
      // messageId is strictly richer than an id-only copy of that row, so it
      // replaces the stored one in place instead of being dropped.
      const at = indexByRawId.get(raw)
      if (item.messageId && !merged[at].messageId) merged[at] = item
      continue
    }
    const id = stableIdentity(item)
    const body = content(item)
    const existing = indexByContent.get(body)
    if (existing === undefined) {
      if (raw) indexByRawId.set(raw, merged.length)
      indexByContent.set(body, merged.length)
      merged.push(item)
      continue
    }
    const kept = merged[existing]
    if (item.mediaEvidence || kept.mediaEvidence) { if (raw) indexByRawId.set(raw, merged.length); merged.push(item); continue }
    // A real id outranks a fingerprint-only copy of the same text.
    if (id && !stableIdentity(kept)) { indexByRawId.set(id, existing); merged[existing] = item; continue }
    if (!id) continue
    // Two distinct real ids with identical text are two genuine messages.
    indexByRawId.set(id, merged.length)
    merged.push(item)
  }
  return merged.slice(-80)
}

function isConversationTargetMatch(target, activeName, headerText) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const t = clean(target)
  const a = clean(activeName)
  const headers = (Array.isArray(headerText) ? headerText : [headerText]).map(clean).filter(Boolean)
  if (!t) return false
  if (a && a !== t) return false
  if (headers.some(h => h !== t)) return false
  return a === t || headers.includes(t)
}

// Read the dedicated chat title. Generic "header" selectors also match the
// entire notHeaderArea, which contains messages and cannot identify a recipient.
function readConversationIdentity(doc, target) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
  const wrapper = doc.querySelector('[class*="conversationConversationListwrapper"]')
  const rows = wrapper ? [...wrapper.querySelectorAll('[class*="conversationConversationItemwrapper"]')] : []
  const activeNames = rows.filter(row => {
    const cls = String(row.className || '') + ' ' + [...row.children].map(child => child.className || '').join(' ')
    return /conversationConversationItem(?:active|selected)|(?:^|[\s_-])(active|selected|current|focus|is-active)(?:[\s_-]|$)/i.test(cls) || row.getAttribute('aria-selected') === 'true'
  }).map(extractConversationName).filter(Boolean)
  const titles = [...doc.querySelectorAll('[data-e2e="chat-header-title"], [class~="RightPanelHeadertitle"], [class~="imChatHeadertitle"], [class~="chatHeaderTitle"]')]
    .filter(node => { const r = node.getBoundingClientRect(); return r.left > 200 && r.top >= 0 && r.top <= 120 && r.width > 20 && r.height > 10 })
  const headerNames = [...new Set(titles.map(node => clean(nicknameTools().read(node).text)).filter(Boolean))]
  const activeName = activeNames[0] || ''
  const ambiguous = new Set(activeNames).size > 1 || headerNames.length > 1
  const isTargetMatch = !ambiguous && isConversationTargetMatch(target, activeName, headerNames)
  return { isTargetMatch, activeName, headerNames, headerText: headerNames.join(' / '), ambiguous }
}

readConversationIdentity = withNicknameTools(readConversationIdentity)

function conversationIdentityScript(target, expectedPlatformId = '') {
  return `(() => {
    const extractConversationName = ${extractConversationName.toString()}
    const isConversationTargetMatch = ${isConversationTargetMatch.toString()}
    const readConversationIdentity = ${readConversationIdentity.toString()}
    ${expectedPlatformId ? `const identity = readConversationIdentity(document, ${JSON.stringify(target)});
    const platform = (${activeChatIdentity.toString()})(${JSON.stringify(target)}, ${JSON.stringify(expectedPlatformId)});
    return { ...identity, platformUserId: platform.platformUserId || '', identityState: platform.state || 'PENDING', nameMatch: platform.nameMatch || 'DIFFERENT', isTargetMatch: platform.verified === true && platform.platformUserId === ${JSON.stringify(expectedPlatformId)} }` : `return readConversationIdentity(document, ${JSON.stringify(target)})`}
  })()`
}

function boundConversationPlatformId(contacts, name) {
  const matches = (contacts || []).filter(contact => contact.name === name)
  return matches.length === 1 && !matches[0].conversationIdentityAmbiguous ? conversationPlatformId(matches[0]) : ''
}

function findConversationTargetRow(doc, target, expectedId = '') {
  const rows = [...doc.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
  const names = nicknameTools()
  if (!expectedId) {
    const matches = rows.filter(row => names.same(extractConversationName(row), target))
    return matches.length === 1 ? matches[0] : null
  }
  const records = rows.map(row => ({ row, identity: extractPlatformIdentity(row) }))
  const byId = records.filter(item => item.identity.verified && item.identity.platformUserId === expectedId)
  if (byId.length) return byId.length === 1 ? byId[0].row : null
  // Name comparisons can select a row for inspection only. The opened panel must
  // subsequently prove its account ID before any input or send is allowed.
  const unknown = records.filter(item => !item.identity.verified && !item.identity.ambiguous)
  const exact = unknown.filter(item => names.same(extractConversationName(item.row), target))
  if (exact.length) return exact.length === 1 ? exact[0].row : null
  const key = names.comparisonName(target)
  const candidates = key ? unknown.filter(item => names.comparisonName(extractConversationName(item.row)) === key) : []
  return candidates.length === 1 ? candidates[0].row : null
}
findConversationTargetRow = withNicknameTools(findConversationTargetRow)

function conversationRowScript(target, expectedId = '') {
  return `(() => {
    const extractConversationName = ${extractConversationName.toString()}
    const extractPlatformIdentity = ${extractPlatformIdentity.toString()}
    const findConversationTargetRow = ${findConversationTargetRow.toString()}
    return findConversationTargetRow(document, ${JSON.stringify(target)}, ${JSON.stringify(expectedId)})
  })()`
}

async function safeExecuteJavaScript(win, script, timeoutMs = 3000, fallback = null) {
  if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isDestroyed?.()) return fallback
  let timer
  try {
    const promise = executePageScript(win, script, timeoutMs)
    const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs) })
    return await Promise.race([promise, timeoutPromise])
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

function shouldSleepChatWindow({ config = {}, settings = {}, now = new Date() } = {}) {
  // 1. 若处于免打扰时段，允许休眠
  if (settings.quietHours) {
    const toMinutes = (value) => {
      const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
      return match ? Number(match[1]) * 60 + Number(match[2]) : 0
    }
    const current = now.getHours() * 60 + now.getMinutes()
    const start = toMinutes(settings.quietStart || '23:00')
    const end = toMinutes(settings.quietEnd || '07:00')
    const muted = start === end || (start < end ? current >= start && current < end : current >= start || current < end)
    if (muted) return true
  }

  const autoReplyOn = Boolean(config.autoReply) && !config.paused
  const hasCompanion = Boolean(settings.proactiveChat?.enabled || settings.eventFollowupDue || settings.autoFriendshipReplies)
  const hasSparkWork = (config.sparks || []).some((task) => task && task.enabled)

  // 2. 没有自动回复、没有主动伴聊、也没有续火花：彻底闲置，休眠释放 300MB+ 内存
  if (!autoReplyOn && !hasCompanion && !hasSparkWork) return true

  // 3. 仅有续火花任务（无实时回复和伴聊）：检查近 10 分钟内是否有即将到来的任务
  if (!autoReplyOn && !hasCompanion && hasSparkWork) {
    const today = localDateKey(now)
    const minutesNow = now.getHours() * 60 + now.getMinutes()
    const timeToMinutes = (str) => {
      const [h, m] = String(str || '00:00').split(':').map(Number)
      return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
    }
    // 检查是否有今天尚未执行且已经到了执行时间（或即将在 10 分钟内到达）的续火花任务
    const hasPendingSoon = (config.sparks || []).some((task) => {
      if (!task || !task.enabled || task.lastRunDate === today) return false
      const diff = timeToMinutes(task.time) - minutesNow
      return diff <= 10
    })
    // 若所有任务今天已跑完，或距下次触发时间尚早，允许休眠
    if (!hasPendingSoon) return true
  }

  return false
}

class DouyinService {
  constructor({ storage, emit, ai, partition, accountId }) {
    this.chatWindowCoordinator = new ChatWindowCoordinator()
    // This service's revoked async continuations cannot write through its
    // storage reference. The account store itself is left untouched for the UI
    // and other services, and successful deferred memory work remains valid.
    this.storage = new Proxy(storage, { get: (target, key) => {
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? (...args) => {
        this.chatWindowCoordinator.assertActive()
        return value.apply(target, args)
      } : value
    } })
    this.emit = emit
    this.ai = ai
    this.partition = partition || PARTITION
    this.accountId = String(accountId || partition || 'default')
    this.conversationSyncEpoch = 0
    this.window = null
    this.discoveryWindow = null
    this.pollTimer = null
    this.polling = false
    this.lastSeen = new Map()
    this.lastLimitNotice = new Map()
    this.lastSkipNotice = new Map()
    this.blockedContacts = new Set()
    this.aiBackoff = new Map()
    this.fromMeDeferCount = new Map()
    this.verificationActive = false
    this.lastActivityAt = Date.now() // 最近一次会话有新消息的时间，用于空闲自适应降频
    this._capturedVideoUrl = null
    this._videoDetailIds = new Set()
    this._detailListenerAttached = false
    const savedSeen = (this.storage?.get().lastSeenPairs || []).filter(p => Date.now() - p.at < 86400000)
    savedSeen.forEach(p => this.lastSeen.set(p.name, p.preview))
    const savedPairs = (this.storage?.get().lastSentPairs || []).filter(p => Date.now() - p.at < 86400000)
    this.lastSent = new Map(savedPairs.map(p => [p.name, p.text]))
    this.lastReplyTime = new Map()
    this.expressionSending = new Set()
    this.expressionPreparing = new Set()
    // 本轮/上一轮 AI 亲自写进输入框的文本（用于识别"AI 自己的残留"并安全清理）
    this.aiOwnedEditorWrites = new Map()
    // 输入框被真人草稿占用而暂停自动发送的联系人（key 为被阻塞的那条入站消息）
    this.userDraftBlocks = new Map()
  }

  findFfmpegPath() {
    return findFfmpegPath()
  }

  async mediaRequestHeaders(url, win) {
    return mediaRequestHeaders(url, win)
  }

  async extractAudioTrack(options) {
    return extractAudioTrack(options)
  }

  async transcribeCapturedMediaAudio(media, name, win) {
    if (!media?.isVideo || !media.videoUrl || !this.ai?.transcribeAudio) return {}
    const ffmpegPath = this.findFfmpegPath()
    if (!ffmpegPath) {
      this.log('media_audio_unavailable', `${name} 视频音频未转写：未找到 ffmpeg`, { name, reason: 'missing_ffmpeg' })
      return { audioTranscriptionError: 'missing_ffmpeg' }
    }
    const audioPath = tempPath('xusheng-audio', '.wav')
    try {
      const headers = await this.mediaRequestHeaders(media.videoUrl, win)
      const extracted = await this.extractAudioTrack({ ffmpegPath, videoUrl: media.videoUrl, outputPath: audioPath, headers })
      const transcript = await this.ai.transcribeAudio({ filePath: audioPath, mimeType: 'audio/wav', language: 'zh' })
      const text = String(transcript?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
      if (!text) throw new Error('audio transcription returned empty text')
      this.log('media_audio_transcribed', `已转写 ${name} 的视频音频`, {
        name,
        source: extracted.source || '',
        model: transcript.model || '',
        provider: transcript.provider || '',
      })
      return {
        audioTranscript: text,
        audioTranscriptionSource: extracted.source || 'video_audio',
        audioTranscriptionModel: transcript.model || '',
      }
    } catch (error) {
      this.log('media_audio_unavailable', `${name} 视频音频未转写`, { name, error: error.message })
      return { audioTranscriptionError: error.message || 'audio_transcription_failed' }
    } finally {
      try { fs.rmSync(audioPath, { force: true }) } catch (_) {}
    }
  }

  async readVideoCommentContext(media, name, options = {}, sourceWindow = null) {
    const limit = Math.max(0, Math.min(50, Math.floor(Number(options.commentLimit || 0) || 0)))
    if (!limit) return {}
    const hasShareUrl = Boolean(media?.shareUrl)
    const targetAwemeId = String(options.targetAwemeId || '') || (media?.shareUrl || '').match(/(?:modal_id=|\/(?:video|note)\/)(\d+)/)?.[1]
      || (media?.shareUrl || '').match(/\d{18,20}/)?.[0]
      || ''
    const win = hasShareUrl ? this.ensureDiscoveryWindow() : sourceWindow
    if (!win) return {}
    try {
      if (hasShareUrl) {
        await win.loadURL(media.shareUrl, { timeout: 15000 }).catch(() => {})
        // 立即静音并暂停视频播放，防止自动播放完后切到下一个视频
        await executePageScript(win, `(() => {
          try {
            document.querySelectorAll('video').forEach((v) => { v.pause(); v.muted = true })
          } catch {}
        })()`).catch(() => {})
        // 校验加载后的 URL：若被重定向到了无关推荐流（如 /jingxuan 但 modal_id 与目标不符），立即放弃，严禁张冠李戴
        const loadedUrl = String(win.webContents.getURL() || '')
        const loadedModalMatch = loadedUrl.match(/(?:modal_id=|\/(?:video|note)\/)(\d+)/)?.[1] || ''
        if (targetAwemeId && loadedModalMatch && loadedModalMatch !== targetAwemeId) {
          this.log('video_comments_mismatch', `公开页被重定向到其他推荐视频（目标 ${targetAwemeId} vs 当前 ${loadedModalMatch}），已放弃读取该页`, {
            name,
            targetAwemeId,
            loadedModalMatch,
            url: loadedUrl.slice(0, 120),
          })
          return { videoCommentError: 'video_redirect_mismatch', videoPageUrlFound: true }
        }
      } else {
        const pageState = await executePageScript(win, `(() => {
          const href = String(location.href || '')
          const body = String(document.body?.innerText || '')
          const isPublicVideo = /douyin\\.com\\/(?:video|note)\\//i.test(href)
            || /(?:全部评论|发布评论|展开\\s*\\d+\\s*条回复)/i.test(body)
          return { href, isPublicVideo }
        })()`).catch(() => ({ isPublicVideo: false }))
        if (!pageState?.isPublicVideo) return {}
      }
      await sleep(Math.max(1800, Number(options.commentWaitMs || 3000)))
      // 再次暂停可能自动播放的视频
      await executePageScript(win, `(() => {
        try {
          document.querySelectorAll('video').forEach((v) => { v.pause(); v.muted = true })
        } catch {}
      })()`).catch(() => {})
      await executePageScript(win, `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
        const visible = (node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const nodes = [...document.querySelectorAll('button, [role="button"], [aria-label], [title], div, span')]
        const target = nodes.map((node) => {
          const text = normalize([node.innerText, node.getAttribute('aria-label'), node.getAttribute('title'), node.className, node.getAttribute('data-e2e')].join(' '))
          if (!visible(node) || !/(评论|comment)/i.test(text) || /(发表评论|写评论|输入|搜索|查看更多回复)/.test(text)) return null
          const clickTarget = node.closest('button, [role="button"]') || node
          const rect = clickTarget.getBoundingClientRect()
          const score = (/^评论$/.test(text) ? 10 : 0) + (/comment/i.test(text) ? 4 : 0) + (clickTarget.tagName === 'BUTTON' ? 2 : 0)
          return { node: clickTarget, score, y: rect.top }
        }).filter(Boolean).sort((left, right) => right.score - left.score || left.y - right.y)[0]?.node
        if (target) target.click()
        return Boolean(target)
      })()`).catch(() => false)
      const scrolls = Math.max(1, Math.min(3, Math.floor(Number(options.commentScrolls || 1) || 1)))
      for (let index = 0; index < scrolls; index += 1) {
        await sleep(Math.max(450, Math.floor(Number(options.commentWaitMs || 3000) / Math.max(2, scrolls + 1))))
        // 滚动中检查是否发生切视频
        const currentAweme = await executePageScript(win, `(() => {
          try { document.querySelectorAll('video').forEach((v) => { v.pause(); v.muted = true }) } catch {}
          const m = location.href.match(/(?:modal_id=|\\/(?:video|note)\\/)(\\d+)/);
          return m ? m[1] : '';
        })()`).catch(() => '')
        if (targetAwemeId && currentAweme && currentAweme !== targetAwemeId) {
          this.log('video_comments_mismatch', `滚动中页面切到了其他推荐视频（目标 ${targetAwemeId} vs 当前 ${currentAweme}），已停止读取`, { name, targetAwemeId, currentAweme })
          return { videoCommentError: 'video_redirect_mismatch', videoPageUrlFound: true }
        }
        await executePageScript(win, `(() => {
          try {
            // 只查找真正的评论列表滚动容器，严禁滚动 main, body, documentElement，防止触发切视频！
            const scrollers = [...document.querySelectorAll('[class*="comment" i], [data-e2e*="comment" i], [role="dialog"]')]
              .filter((node) => node && !['MAIN', 'BODY', 'HTML'].includes(node.tagName) && node.scrollHeight > node.clientHeight + 50)
              .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))
            const target = scrollers[0]
            if (target) {
              target.scrollBy(0, Math.max(320, innerHeight * 0.65))
            }
          } catch {}
          return true
        })()`).catch(() => false)
      }
      await sleep(Math.max(500, Math.floor(Number(options.commentWaitMs || 3000) / 4)))
      const context = await executePageScript(win, `(async () => {
        const limit = ${JSON.stringify(limit)}
        const preferDomComments = ${JSON.stringify(options.preferDomComments === true)}
        const targetAwemeId = ${JSON.stringify(targetAwemeId)}
        const currentHref = String(location.href || '')
        const currentId = currentHref.match(/(?:modal_id=|\\/(?:video|note)\\/)(\\d+)/)?.[1] || ''
        if (targetAwemeId && currentId && currentId !== targetAwemeId) {
          return { mismatch: true, targetAwemeId, currentId, href: currentHref }
        }
        const normalize = (value, max = 500) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max)
        const extractPublicCommentItemText = ${extractPublicCommentItemText.toString()}
        const meta = (selector, max = 500) => normalize(document.querySelector(selector)?.content || document.querySelector(selector)?.getAttribute('content') || '', max)
        const title = normalize(meta('meta[property="og:title"]') || meta('meta[name="title"]') || document.title, 120)
        const description = normalize(
          meta('meta[property="og:description"]', 500)
            || meta('meta[name="description"]', 500)
            || document.querySelector('[data-e2e*="desc"], [class*="desc" i], [class*="caption" i], [class*="title" i]')?.innerText,
          500
        )
        const author = normalize(document.querySelector('[data-e2e="video-author-name"], [data-e2e*="author-name"], [class*="authorName" i], [class*="author-name" i]')?.innerText || '', 60)
        const bad = /^(?:发表评论|写评论|输入评论|登录|扫码|打开抖音|点击查看|分享|收藏|点赞|展开|收起|回复|查看更多|全部评论|暂无评论|相关搜索|搜索|广告|举报)$/i
        const textOf = (node) => normalize([
          node.innerText,
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
        ].find(Boolean) || '', 180)
        const comments = []
        const commentItems = [...document.querySelectorAll('[data-e2e="comment-item"]')]
        for (const node of commentItems) {
          const text = normalize(extractPublicCommentItemText(node.innerText), 180)
          if (text.length < 3 || text.length > 180) continue
          if (bad.test(text)) continue
          if (title && (text === title || title.includes(text))) continue
          if (description && description.includes(text) && text.length < 12) continue
          if (/^\\d+$/.test(text) || /^\\[\\d.万wW]+$/.test(text)) continue
          if (comments.some((item) => item === text || item.includes(text) || text.includes(item))) continue
          comments.push(text)
          if (comments.length >= limit) break
        }
        if (!comments.length) {
          const fallbackSelectors = [
            '[data-e2e*="comment-content"]',
            '[data-e2e*="comment-text"]',
            '[class*="comment-content" i]',
            '[class*="comment-text" i]',
          ]
          const nodes = [...new Set(fallbackSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
          for (const node of nodes) {
            const text = textOf(node)
            if (text.length < 3 || text.length > 180 || bad.test(text)) continue
            if (title && (text === title || title.includes(text))) continue
            if (description && description.includes(text) && text.length < 12) continue
            if (/^\\d+$/.test(text) || /^\\[\\d.万wW]+$/.test(text)) continue
            if (comments.some((item) => item === text || item.includes(text) || text.includes(item))) continue
            comments.push(text)
            if (comments.length >= limit) break
          }
        }
        const apiComments = []
        const commentUrls = preferDomComments && comments.length ? [] : [...new Set(performance.getEntriesByType('resource')
          .map((entry) => String(entry.name || ''))
          .filter((url) => /aweme\\/v1\\/web\\/comment\\/list\\//i.test(url)))]
          .filter((url) => !targetAwemeId || url.includes('aweme_id=' + targetAwemeId) || url.includes(targetAwemeId))
        for (const url of commentUrls.slice(-Math.max(2, Math.ceil(limit / 5) + 2))) {
          try {
            const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(8000) })
            if (!response.ok) continue
            const payload = await response.json()
            for (const item of (Array.isArray(payload?.comments) ? payload.comments : [])) {
              const text = normalize(item?.text || item?.comment_text || item?.content || '', 180)
              if (text.length >= 2 && !apiComments.includes(text)) apiComments.push(text)
              if (apiComments.length >= limit) break
            }
          } catch {}
          if (apiComments.length >= limit) break
        }
        return { title, description, author, apiComments, comments, source: location.href }
      })()`).catch((error) => ({ error: error.message }))
      if (context?.mismatch) {
        this.log('video_comments_mismatch', `公开页内容提取发现视频 ID 不符（目标 ${targetAwemeId} vs 当前 ${context.currentId}），已丢弃无关评论`, {
          name,
          targetAwemeId,
          currentId: context.currentId,
          href: context.href,
        })
        return { videoCommentError: 'video_redirect_mismatch', videoPageUrlFound: true }
      }
      const normalized = normalizeCommentContext({
        ...context,
        comments: Array.isArray(context?.apiComments) && context.apiComments.length
          ? context.apiComments
          : context?.comments,
      }, limit)
      if (normalized.videoComments.length || normalized.videoPageTitle || normalized.videoPageDescription) {
        this.log('video_comments_captured', `已读取 ${name} 的视频公开页评论`, {
          name,
          comments: normalized.videoComments.length,
          titleFound: Boolean(normalized.videoPageTitle),
        })
      }
      return { ...normalized, videoPageUrlFound: Boolean(hasShareUrl || context?.source || sourceWindow) }
    } catch (error) {
      this.log('video_comments_unavailable', `${name} 视频评论未读取`, { name, error: error.message })
      return { videoCommentError: error.message || 'video_comments_unavailable', videoPageUrlFound: hasShareUrl }
    }
  }

  ensureWindow(show = false) {
    if (this.window && !this.window.isDestroyed()) {
      if (show) this.window.show()
      return this.window
    }

    this.window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      show,
      title: '鎶栭煶璐﹀彿鐧诲綍 路 缁０',
      autoHideMenuBar: true,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    // Douyin pages sometimes advertise a Windows-only `bytedance:` deep link.
    // It is not needed for web automation and Windows otherwise shows a Store dialog.
    // Video/note pages must never replace the chat page in the main window:
    // opening them there strands the automation on a page with no editor/send
    // button. Discovery work is delegated to the hidden discovery window instead.
    const isVideoDetailUrl = (url) => /^https?:\/\/[^/]*douyin\.com\/(?:video|note)\//i.test(String(url || ''))
    this._capturedVideoUrl = null
    const captureVideoUrl = (url) => {
      if (isVideoDetailUrl(url)) {
        this._capturedVideoUrl = url
        return true
      }
      return false
    }
    this.window.webContents.on('will-navigate', (event, url) => {
      url = navigationUrl(event, url)
      if (/^bytedance:/i.test(url) || captureVideoUrl(url)) event.preventDefault()
    })
    this.window.webContents.on('will-redirect', (event, url) => {
      url = navigationUrl(event, url)
      if (/^bytedance:/i.test(url) || captureVideoUrl(url)) event.preventDefault()
    })
    this.window.webContents.on('will-frame-navigate', (event, details) => {
      const url = navigationUrl(event, details)
      if (/^bytedance:/i.test(url) || captureVideoUrl(url)) event.preventDefault()
    })
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^bytedance:/i.test(url) || captureVideoUrl(url)) return { action: 'deny' }
      return { action: 'allow' }
    })
    // 抖音网页版聊天点击分享卡片后，视频详情通过 XHR 拉取（不导航、也不挂
    // window 全局变量）。监听详情 API 响应，从 URL 或响应体里提取 aweme_id，
    // 用于拼公开页地址交给独立 discovery 窗口抓取。
    this._videoDetailIds = new Set()
    const captureDetailId = (url) => {
      const id = String(url || '').match(/aweme_id[=/\-](\d{10,20})|aweme\/v1\/web\/aweme\/detail\/(\d{10,20})|video\/(\d{10,20})|note\/(\d{10,20})/i)
      if (id) {
        const found = id[1] || id[2] || id[3] || id[4]
        if (found) {
          this._videoDetailIds.add(found)
          if (!this._capturedVideoUrl) this._capturedVideoUrl = 'https://www.douyin.com/video/' + found
          return found
        }
      }
      return ''
    }
    const attachDetailListener = () => {
      const session = this.window.webContents.session
      if (this._detailListenerAttached) return
      this._detailListenerAttached = true
      session.webRequest.onBeforeRequest({ urls: ['*://*.douyin.com/*', '*://*.amemv.com/*', '*://*.douyinpic.com/*'] }, (details, callback) => {
        if (/aweme\/v1\/web\/aweme\/detail|aweme\/v1\/web\/comment|aweme\/detail/i.test(details.url)) {
          captureDetailId(details.url)
        }
        callback({})
      })
    }
    attachDetailListener()
    this.window.on('closed', () => { this._detailListenerAttached = false })
    // 抖音聊天消息通过 WebSocket 长连接推送，必须在页面加载时注入 hook，
    // 否则会话切换后已建立的连接抓不到消息帧。
    this.window.webContents.on('did-finish-load', () => {
      this.injectMessageCaptureHook(this.window)
    })
    this.window.on('close', (event) => {
      if (!this.window.__forceClose) {
        event.preventDefault()
        this.window.hide()
      }
    })
    this.window.loadURL(CHAT_URL)
    return this.window
  }

  // 在抖音页面上下文里 hook WebSocket / fetch / XHR，捕获聊天消息数据里的
  // aweme_id（含视频标题、作者、文案），供 publicPageOnly 模式零点击提取，
  // 之后交给独立 discovery 窗口抓取完整文案和评论。
  async injectMessageCaptureHook(win) {
    if (!win || win.isDestroyed?.()) return false
    try {
      return await executePageScript(win, `(() => {
        if (window.__xushengFetchHook) return true
        window.__xushengVideoIds = []
        window.__xushengVideoInfo = new Map()
        const collect = (text) => {
          try {
            const data = JSON.parse(String(text || ''))
            const walk = (value) => {
              if (!value || typeof value !== 'object') return
              if (Array.isArray(value)) { value.forEach(walk); return }
              if (typeof value.aweme_id === 'string' && /^\\d{10,20}$/.test(value.aweme_id)) {
                const id = value.aweme_id
                if (!window.__xushengVideoIds.includes(id)) window.__xushengVideoIds.push(id)
                const shareInfo = value.share_info || value.shareInfo || value.share || {}
                const author = String(
                  value.author?.nickname
                  || value.author?.name
                  || value.authorName
                  || value.nickname
                  || value.user?.nickname
                  || value.user_name
                  || shareInfo.share_author
                  || shareInfo.author
                  || value.author?.user?.nickname
                  || ''
                ).trim().slice(0, 60)
                const desc = String(
                  value.desc
                  || value.title
                  || shareInfo.share_title
                  || shareInfo.title
                  || shareInfo.share_desc
                  || value.content
                  || ''
                ).trim().slice(0, 500)
                const covers = []
                const addCover = (candidate) => {
                  if (Array.isArray(candidate)) {
                    candidate.forEach(addCover)
                    return
                  }
                  const url = String(candidate?.url || candidate || '').trim()
                  if (/^https?:\\/\\//i.test(url) && !covers.includes(url)) covers.push(url.slice(0, 800))
                }
                addCover(value.video?.cover?.url_list)
                addCover(value.video?.origin_cover?.url_list)
                addCover(value.video?.dynamic_cover?.url_list)
                addCover(value.cover?.url_list)
                addCover(value.cover_url?.url_list)
                addCover(value.images?.flatMap?.((image) => image?.url_list || []))
                window.__xushengVideoInfo.set(id, {
                  desc,
                  author,
                  title: String(value.title || shareInfo.share_title || '').slice(0, 120),
                  covers: covers.slice(0, 12),
                  stats: value.statistics || null,
                  at: Date.now(),
                })
              }
              for (const key of Object.keys(value)) {
                if (key === 'aweme_id' && typeof value.aweme_id === 'string' && /^\\d{10,20}$/.test(value.aweme_id)) continue
                walk(value[key])
              }
            }
            walk(data)
          } catch {}
        }
        const decodeData = (data) => {
          // WebSocket 帧可能是文本、Blob 或 ArrayBuffer
          if (typeof data === 'string') return data
          if (data instanceof ArrayBuffer) { try { return new TextDecoder().decode(data) } catch {} }
          if (ArrayBuffer.isView(data)) { try { return new TextDecoder().decode(data.buffer, { stream: true }) } catch {} }
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            try {
              // 同步拿不到 Blob 内容，异步处理
              data.text().then((t) => collect(t)).catch(() => {})
              return ''
            } catch {}
          }
          return ''
        }
        const OriginalWebSocket = window.WebSocket
        if (OriginalWebSocket) {
          window.WebSocket = function (...args) {
            const socket = new OriginalWebSocket(...args)
            try {
              const originalAddEventListener = socket.addEventListener.bind(socket)
              socket.addEventListener = (type, listener, options) => {
                if (type === 'message') {
                  return originalAddEventListener(type, (event) => {
                    try { collect(decodeData(event.data)) } catch {}
                    if (typeof listener === 'function') listener(event)
                  }, options)
                }
                return originalAddEventListener(type, listener, options)
              }
              // onmessage 访问器定义在原型上，实例级覆盖不生效，
              // 因此统一走 addEventListener 捕获；若页面用 onmessage 赋值，
              // 通过包装原型访问器补捕获。
            } catch {}
            return socket
          }
          window.WebSocket.prototype = OriginalWebSocket.prototype
          const originalProtoDescriptor = Object.getOwnPropertyDescriptor(OriginalWebSocket.prototype, 'onmessage')
          if (originalProtoDescriptor) {
            Object.defineProperty(window.WebSocket.prototype, 'onmessage', {
              set(value) {
                if (typeof value === 'function') {
                  this.__xushengUserOnMessage = value
                  const handler = (event) => {
                    try { collect(decodeData(event.data)) } catch {}
                    if (typeof this.__xushengUserOnMessage === 'function') this.__xushengUserOnMessage(event)
                  }
                  if (originalProtoDescriptor.set) originalProtoDescriptor.set.call(this, handler)
                  else this.addEventListener('message', handler)
                } else if (originalProtoDescriptor.set) {
                  originalProtoDescriptor.set.call(this, value)
                }
              },
              get() {
                if (originalProtoDescriptor.get) return originalProtoDescriptor.get.call(this)
                return this.__xushengUserOnMessage || null
              },
              configurable: true,
            })
          }
          Object.setPrototypeOf(window.WebSocket, OriginalWebSocket)
        }
        const originalFetch = window.fetch
        if (originalFetch) {
          window.fetch = async (...args) => {
            const response = await originalFetch(...args)
            try {
              const cloned = response.clone()
              cloned.text().then(collect).catch(() => {})
            } catch {}
            return response
          }
        }
        const originalOpen = XMLHttpRequest.prototype.open
        const originalSend = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.open = function (...args) {
          this.__xushengUrl = String(args[1] || '')
          return originalOpen.apply(this, args)
        }
        XMLHttpRequest.prototype.send = function (...args) {
          if (this.__xushengUrl && /douyin\\.com|amemv\\.com/i.test(this.__xushengUrl)) {
            this.addEventListener('load', () => { try { collect(this.responseText) } catch {} })
          }
          return originalSend.apply(this, args)
        }
        window.__xushengFetchHook = true
        return true
      })()`)
    } catch {
      return false
    }
  }

  ensureDiscoveryWindow() {
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) {
      this.scheduleDiscoveryCleanup()
      return this.discoveryWindow
    }
    this.discoveryWindow = new BrowserWindow({
      width: 980,
      height: 760,
      show: false,
      title: 'Douyin video discovery',
      autoHideMenuBar: true,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    // 后台窗口静音：搜索/观看视频时页面自动播放不发出任何声音，画面照常渲染
    this.discoveryWindow.webContents.setAudioMuted(true)
    const denyDeepLink = (event, url) => {
      url = navigationUrl(event, url)
      if (/^bytedance:/i.test(url)) event.preventDefault()
    }
    this.discoveryWindow.webContents.on('will-navigate', denyDeepLink)
    this.discoveryWindow.webContents.on('will-redirect', denyDeepLink)
    this.discoveryWindow.webContents.on('will-frame-navigate', denyDeepLink)
    this.discoveryWindow.webContents.setWindowOpenHandler(({ url }) => (/^bytedance:/i.test(url) ? { action: 'deny' } : { action: 'deny' }))
    this.scheduleDiscoveryCleanup()
    return this.discoveryWindow
  }

  // 发现窗口用完即毁：常驻隐藏浏览器窗口是后台内存的主要来源之一（空闲 2 分钟后销毁）
  scheduleDiscoveryCleanup() {
    if (this._discoveryCleanupTimer) clearTimeout(this._discoveryCleanupTimer)
    this._discoveryCleanupTimer = setTimeout(() => {
      this._discoveryCleanupTimer = null
      if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) {
        try { this.discoveryWindow.destroy() } catch { /* ignore */ }
      }
      this.discoveryWindow = null
    }, 2 * 60 * 1000)
  }

  async openLogin() {
    this.requestConversationSync({ reason: 'open_login' })
    const win = this.ensureWindow(true)
    if (!win.webContents.getURL().startsWith('https://www.douyin.com/')) await win.loadURL(CHAT_URL)
    win.focus()
    return { ok: true }
  }

  async logout() {
    this.conversationSyncEpoch++
    await session.fromPartition(this.partition).clearStorageData()
    if (this.window && !this.window.isDestroyed()) await this.window.loadURL(CHAT_URL)
    this.lastSeen.clear()
    this.lastSent.clear()
    this.emitEvent('status', await this.getStatus())
    return { ok: true }
  }

  async getStatus() {
    const cookies = await this.withChatRead(() => session.fromPartition(this.partition).cookies.get({ url: 'https://www.douyin.com' }), 'login_cookies')
    // Douyin has used several equivalent session cookie names over time.
    const connected = cookies.some(({ name }) => [
      'sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss',
      'passport_auth_status', 'passport_auth_status_ss',
    ].includes(name))
    if (connected && this._conversationSyncConnected === false && !this._destroyed) {
      this.getConversationSyncManager().resetForReconnect(); this.emitConversationSync()
    }
    this._conversationSyncConnected = connected
    return {
      connected,
      mode: 'local-browser',
      accountWindowOpen: Boolean(this.window && !this.window.isDestroyed()),
      message: connected ? 'Douyin login is saved' : 'Open the login window and scan the QR code',
    }
  }

  async waitForChatReady(timeout = 15000) {
    const win = this.ensureWindow(false)
    if (!win.webContents.getURL().startsWith('https://www.douyin.com/chat')) {
      if (this.backgroundNavigationBlocked(win)) throw chatWindowDeferred()
      win.loadURL(CHAT_URL).catch(() => {})
    }
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const ready = await this.withChatRead(() => executePageScript(win, `Boolean(document.querySelector('[class*="conversationConversationListwrapper"], [class*="messageEditorimChatEditorContainer"]'))`), 'chat_ready', 2500)
      if (ready) return win
      await sleep(700)
    }
    throw new Error('抖音聊天页面未加载完成，请在登录窗口确认已经登录并进入私信页')
  }

  async syncContacts() {
    const epoch = this.conversationSyncEpoch
    const win = await this.waitForChatReady()
    this.assertConversationSyncAlive(epoch)
    const contacts = await this.withChatRead(() => executePageScript(win, `(() => {
      const wrapper = document.querySelector('[class*="conversationConversationListwrapper"]')
      if (!wrapper) return []
      const extractConversationPreview = ${extractConversationPreview.toString()}
      const CONVERSATION_TIME_RE = ${CONVERSATION_TIME_RE.toString()}
      const extractConversationTimeLabel = ${extractConversationTimeLabel.toString()}
      const extractStreakCount = ${extractStreakCount.toString()}
      const extractConversationName = ${extractConversationName.toString()}
      const extractPlatformIdentity = ${extractPlatformIdentity.toString()}
      const nodes = [...wrapper.querySelectorAll('[class*="conversationConversationItemwrapper"]')].slice(0, 100)
      const seen = new Set()
      return nodes.map((node, index) => {
        const lines = (node.innerText || '').split(/\\n+/).map(v => v.trim()).filter(Boolean)
        const image = node.querySelector('img')
        const name = extractConversationName(node)
        const identity = extractPlatformIdentity(node)
        const rowKey = identity.verified ? 'id:' + identity.platformUserId : 'unverified:' + name + ':' + index
        if (!name || name.length > 40 || seen.has(rowKey)) return null
        seen.add(rowKey)
        const previewNode = node.querySelector('[class*="ConversationItemHinttextBox"]')
        const timeNode = node.querySelector('[class*="time" i], [class*="date" i], [class*="ConversationItemtime" i]')
        const streakNode = node.querySelector('[class*="commonStreaknormalText"]')
        const streakText = streakNode?.innerText || streakNode?.textContent || ''
        let preview = extractConversationPreview(lines, previewNode?.innerText || previewNode?.textContent || '', streakText)
        const sentAtLabel = extractConversationTimeLabel(lines, timeNode?.innerText || timeNode?.textContent || '')
        const mediaHint = node.querySelector('video, [class*="video" i], [class*="player" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]')
        if (mediaHint && !/(?:视频|图集|图片|动图|表情|分享|作品|播放|▶|⏵|媒体)/i.test(preview)) preview = '[媒体] ' + (preview || '复合消息')
        const fire = extractStreakCount(streakText, lines)
        const fromMe = lines.slice(1).some(l => /^你[：:]/.test(l.trim())) ? true : null
        const unreadNode = node.querySelector('[class*="unread" i], [data-e2e*="unread" i], [aria-label*="未读"]')
        const unreadLabel = (unreadNode?.innerText || unreadNode?.textContent || unreadNode?.getAttribute('aria-label') || '').trim()
        const unread = Boolean(unreadNode)
        const messageKey = unread ? preview + '\u241f' + (unreadLabel || 'unread') : preview
        const ambiguousName = nodes.filter(other => extractConversationName(other) === name).length > 1
        const listTop = wrapper.getBoundingClientRect?.().top
        const rowTop = node.getBoundingClientRect?.().top
        const listPosition = Number(rowTop) + Number(wrapper.scrollTop || 0) - Number(listTop)
        return { id: identity.verified ? 'douyin:' + identity.platformUserId : ambiguousName ? 'unverified:' + name + ':' + index : name, name, avatar: image?.src || '', fire, preview, messageKey, unread, unreadLabel, fromMe, sentAtLabel,
          ...(Number.isFinite(listPosition) && listPosition >= 0 ? { conversationListPosition: listPosition, conversationListPositionSource: 'douyin_list_geometry' } : {}),
          ...(identity.verified ? { platformUserId: identity.platformUserId, identityVerified: true,
            profile: { platformUserId: identity.platformUserId, dmIdentityVerified: true, conversationIdentitySource: identity.source } } : {}) }
      }).filter(Boolean)
    })()`), 'conversation_list')
    this.assertConversationSyncAlive(epoch)
    const savedContacts = this.storage.get().contacts || []
    const savedByName = new Map(savedContacts.map((contact) => [contact.name, contact]))
    // 垃圾名过滤：页面尚未渲染完成时，聊天列表会把数字 ID 当昵称抓下来。
    // 这类条目绝不能入库——2026-08-29 曾因重启后首帧抓到纯数字名，
    // 与已存昵称全部失配，导致全部联系人的 learning/profile 被裸数据覆盖清空。
    const isJunkName = (value) => !String(value || '').trim() || /^\d+$/.test(String(value).trim())
    const validContacts = contacts.filter((contact) => contact?.name && !isJunkName(contact.name))
    const observedAt = new Date().toISOString()
    const contactsWithTime = validContacts.map(contact => {
      const platformId = conversationPlatformId(contact)
      const matches = savedContacts.filter(old => platformId && conversationPlatformId(old) ? platformId === conversationPlatformId(old) : old.name === contact.name)
      const previous = matches.length === 1 ? matches[0] : null
      const time = conversationTimeMeta({ sentAtLabel: contact.sentAtLabel })
      const sameMessage = previous && contactMessageKey(previous) === contactMessageKey(contact) && previous.sentAtLabel === contact.sentAtLabel
      const preserveTime = sameMessage && previous.sentAtSource === 'platform_label' && Number.isFinite(Date.parse(previous.sentAt))
      return { ...contact, ...time, sentAt: preserveTime ? previous.sentAt : time.sentAt,
        sentAtSource: time.sentAt ? 'platform_label' : '', sentAtObservedAt: preserveTime ? previous.sentAtObservedAt : time.sentAt ? observedAt : '',
        ...(!(Number.isFinite(contact.conversationListPosition) && contact.conversationListPosition >= 0 && contact.conversationListPositionSource === 'douyin_list_geometry')
          ? { conversationListPosition: null, conversationListPositionSource: '' } : {}),
        conversationListObservedAt: observedAt, conversationListCurrent: true }
    })
    // 保留本次未出现在列表里的已存联系人：列表懒加载/部分渲染时只能看到一部分，
    // 绝不能把没显示的联系人（连同其 learning/profile）从存储里丢掉。
    const { contacts: reconciledContacts, renamed } = reconcileConversationContacts(savedContacts.filter(contact => !isJunkName(contact?.name)), contactsWithTime)
    const freshMatch = contact => contactsWithTime.some(row => row.name === contact.name
      && (!conversationPlatformId(row) || conversationPlatformId(row) === conversationPlatformId(contact)))
    const mergedContacts = reconciledContacts.map(contact => ({ ...contact, conversationListCurrent: freshMatch(contact) }))
    if (this.storage?.update && (mergedContacts.length || !savedContacts.length)) {
      // 仅当联系人列表实际发生变化时才写盘，避免每轮轮询都触发全量保存。
      // 变更按"名字 → 列表字段签名"比较，避免保序追加 preserved 后索引错位导致的多余写盘。
      const signature = (contact) => `${contact.id}|${contact.preview}|${contact.messageKey}|${contact.unread}|${contact.fire}|${conversationPlatformId(contact)}|${contact.profile?.dmIdentityVerified}|${contact.conversationIdentityAmbiguous}|${contact.name}|${contact.sentAt}|${contact.sentAtSource}|${contact.sentAtLabel}|${contact.conversationListPositionSource}|${contact.conversationListPosition}|${contact.conversationListCurrent}`
      const savedSignatures = new Map(savedContacts.map((contact) => [contact.name, signature(contact)]))
      const changed = mergedContacts.length !== savedContacts.length
        || mergedContacts.some((contact) => !savedByName.has(contact.name))
        || mergedContacts.some((contact) => savedSignatures.get(contact.name) !== undefined && savedSignatures.get(contact.name) !== signature(contact))
      if (changed) {
        const references = Object.keys(renamed).length ? renameConversationReferences(this.storage.get(), renamed) : {}
        this.storage.update({ ...references, contacts: mergedContacts })
        for (const map of [this.lastSeen, this.lastSent, this.aiBackoff, this.fromMeDeferCount, this.incomingQueue]) {
          if (!(map instanceof Map)) continue
          for (const [oldName, name] of Object.entries(renamed)) {
            if (!map.has(oldName)) continue
            const value = map.get(oldName)
            if (!map.has(name)) map.set(name, value && typeof value === 'object' && value.name === oldName ? { ...value, name } : value)
            map.delete(oldName)
          }
        }
      }
    }
    this.emitEvent('contacts', { contacts: mergedContacts, renamed, visibleContactIds: mergedContacts.filter(freshMatch).map(contact => contact.id) })
    this.getConversationSyncManager().observe(mergedContacts)
    this.emitConversationSync()
    const visibleContacts = mergedContacts.filter(freshMatch)
    return { ok: true, contacts: mergedContacts, visibleContacts }
  }

  getChatWindowCoordinator() {
    return this.chatWindowCoordinator ||= new ChatWindowCoordinator()
  }

  assertChatOperationActive() { return this.getChatWindowCoordinator().assertActive() }

  setAutomationStage(stage) {
    const owner = this.assertChatOperationActive()
    if (owner?.kind === 'automation') owner.stage = stage
  }

  async withChatRead(operation, stage, timeoutMs = 5000) {
    this.assertChatOperationActive()
    let timer
    try {
      const value = await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`抖音页面读取超时：${stage}`)
          error.code = 'CHAT_READ_TIMEOUT'; error.stage = stage; error.sendAttempted = false
          reject(error)
        }, timeoutMs)
      })])
      this.assertChatOperationActive()
      return value
    } catch (error) {
      this.assertChatOperationActive()
      if (error.code === 'CHAT_READ_TIMEOUT' && this.getChatWindowCoordinator().current()?.kind === 'automation') {
        this.conversationSyncEpoch++
        this.recycleChatWindow()
        this.log('chat_read_timeout', '抖音页面读取无响应，已回收旧窗口，保留未处理消息等待重新同步', { stage, timeoutMs })
      }
      throw error
    } finally { clearTimeout(timer) }
  }

  getConversationSyncManager() {
    if (!this.conversationSyncManager) {
      this.conversationSyncManager = new ConversationSyncManager({ storage: this.storage, accountId: this.accountId || this.partition || 'default' })
      this.conversationSyncManager.observe(this.storage.get().contacts || [])
    }
    return this.conversationSyncManager
  }

  emitConversationSync() {
    if (this._destroyed) return
    this.emitEvent('conversation_sync', { accountId: this.accountId || this.partition || 'default', conversationSync: this.getConversationSyncManager().state() })
  }

  requestConversationSync(payload = {}) {
    if (this._destroyed) return { ok: false, reason: 'account_destroyed' }
    const accountId = this.accountId || this.partition || 'default'
    if (payload.accountId && payload.accountId !== accountId) return { ok: false, reason: 'account_mismatch' }
    const manager = this.getConversationSyncManager()
    manager.request(payload)
    this.emitConversationSync()
    return { ok: true, conversationSync: manager.state() }
  }

  chatWindowHidden(win = this.window) {
    return Boolean(win && !win.isDestroyed?.() && win.isVisible?.() !== true)
  }

  assertConversationSyncAlive(epoch) {
    if (this._destroyed || epoch !== this.conversationSyncEpoch) throw conversationSyncDeferred('账号或同步任务已改变，本次同步停止')
  }

  async restoreConversationScroll(scan) {
    if (!scan || !this.chatWindowHidden(scan.win) || this._destroyed || scan.epoch !== this.conversationSyncEpoch) return
    await executePageScript(scan.win, `(${conversationListScroll.toString()})(document,'set',${Number(scan.originalScrollTop) || 0})`)
  }

  // Read a bounded set of lazy-loaded rows, without selecting chats or touching
  // the editor. A newly visible window ends the scan immediately.
  async reconcileConversationList({ targetName = '', targetPlatformId = '', restore = true, maxSteps = 5, maxContacts = 100 } = {}) {
    const epoch = this.conversationSyncEpoch
    const win = this.window || await this.waitForChatReady()
    if (!this.chatWindowHidden(win)) return { ok: false, deferred: true, reason: 'manual_window_visible', steps: 0 }
    if (win.webContents.getURL?.() && !win.webContents.getURL().startsWith('https://www.douyin.com/chat')) return { ok: false, deferred: true, reason: 'chat_page_not_ready', steps: 0 }
    this.assertConversationSyncAlive(epoch)
    const position = await executePageScript(win, `(${conversationListScroll.toString()})(document,'read')`)
    const scan = { ok: true, win, epoch, originalScrollTop: position?.top || 0, steps: 0, contacts: [] }
    if (!position) return { ...scan, ok: false, reason: 'conversation_list_unavailable' }
    const limit = Math.min(5, Math.max(0, Math.floor(Number(maxSteps) || 0)))
    const contactLimit = Math.min(100, Math.max(1, Math.floor(Number(maxContacts) || 100)))
    const collected = new Map()
    try {
      if (position.top > 0 && limit > 0 && this.chatWindowHidden(win)) {
        await executePageScript(win, `(${conversationListScroll.toString()})(document,'set',0)`)
        scan.steps++
      }
      for (let step = 0; step <= limit; step++) {
        this.assertConversationSyncAlive(epoch)
        if (!this.chatWindowHidden(win)) { scan.ok = false; scan.deferred = true; scan.reason = 'manual_window_visible'; break }
        const result = await this.syncContacts()
        this.assertConversationSyncAlive(epoch)
        if (!this.chatWindowHidden(win)) { scan.ok = false; scan.deferred = true; scan.reason = 'manual_window_visible'; break }
        for (const row of result.visibleContacts || result.contacts || []) {
          collected.set(row.id || row.name, row)
          if (collected.size >= contactLimit) break
        }
        scan.contacts = [...collected.values()].slice(0, contactLimit)
        if ((targetPlatformId && scan.contacts.some(row => conversationPlatformId(row) === targetPlatformId))
          || (targetName && scan.contacts.filter(row => row.name === targetName).length === 1)) break
        if (scan.steps >= limit || collected.size >= contactLimit) break
        const current = await executePageScript(win, `(${conversationListScroll.toString()})(document,'read')`)
        if (!current || current.top >= current.max) break
        if (!this.chatWindowHidden(win)) { scan.ok = false; scan.deferred = true; scan.reason = 'manual_window_visible'; break }
        await executePageScript(win, `(${conversationListScroll.toString()})(document,'set',${Math.min(current.max, current.top + Math.max(100, current.height * 0.85))})`)
        scan.steps++
        await sleep(100)
      }
      return scan
    } finally { if (restore) await this.restoreConversationScroll(scan) }
  }

  async verifyConversationBinding(contact, win, { manualVerified = false } = {}) {
    if (!contact) return null
    const epoch = this.conversationSyncEpoch
    const manager = this.getConversationSyncManager()
    const expectedId = conversationPlatformId(contact) || manager.getRecord(contact.id)?.expectedPlatformUserId
    const identity = await safeExecuteJavaScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(contact.name)}, ${JSON.stringify(expectedId || '')})`, 2000, null)
    this.assertConversationSyncAlive(epoch)
    if (!identity?.verified) {
      if (!expectedId && !contact.profile?.autoFriendship && !contact.profile?.contactPipeline) return null // unique-name legacy compatibility, never READY
      const error = conversationSyncDeferred('当前聊天面板的用户 ID 尚未核验')
      error.lookupFailure = true; throw error
    }
    if (expectedId && identity.platformUserId !== expectedId) {
      const error = conversationSyncDeferred('当前聊天用户 ID 与联系人不一致，已阻止接管')
      error.lookupFailure = true; throw error
    }
    const record = manager.bind({ contactId: contact.id, name: contact.name, platformUserId: identity.platformUserId, verified: true, source: 'active_chat_dom_react' })
    if (record?.identityConflict) { const error = conversationSyncDeferred('联系人身份存在冲突，等待人工检查', record); error.lookupFailure = true; throw error }
    const contacts = this.storage.get().contacts || []
    this.storage.update({ contacts: contacts.map(item => item.id === contact.id ? { ...item, profile: { ...item.profile,
      platformUserId: identity.platformUserId, dmIdentityVerified: true, conversationIdentitySource: 'active_chat_dom_react' } } : item) })
    manager.success(contact.id, manualVerified ? { manualVerified: true, verifiedPlatformUserId: identity.platformUserId } : {})
    this.emitConversationSync()
    return identity.platformUserId
  }

  async refreshConversationBinding(contactId) {
    return this.getChatWindowCoordinator().run('manual_sync', async () => {
      const epoch = this.conversationSyncEpoch
      const contact = (this.storage.get().contacts || []).find(item => item.id === contactId)
      if (!contact) throw new Error('联系人不存在，无法刷新会话绑定')
      this.requestConversationSync({ reason: 'manual_refresh', contactId, name: contact.name, platformUserId: conversationPlatformId(contact) })
      if (this.window?.isVisible?.() && this.window.webContents.getURL?.() && !this.window.webContents.getURL().startsWith('https://www.douyin.com/chat')) {
        const manager = this.getConversationSyncManager(); manager.defer(contactId, 'manual_window_visible'); this.emitConversationSync()
        return { ok: true, conversationSync: manager.state() }
      }
      await this.syncContacts()
      this.assertConversationSyncAlive(epoch)
      const manager = this.getConversationSyncManager()
      if (this.window?.isVisible?.()) {
        const current = await safeExecuteJavaScript(this.window, conversationIdentityScript(contact.name, conversationPlatformId(contact)), 2000, null)
        if (current?.isTargetMatch && !contact.conversationIdentityAmbiguous) {
          try { await this.verifyConversationBinding(contact, this.window, { manualVerified: true }) }
          catch (error) { if (error.code !== 'CONVERSATION_SYNC_DEFERRED') throw error; manager.defer(contactId, 'identity_pending') }
        }
        else manager.defer(contactId, 'manual_window_visible')
      } else if (!contact.conversationIdentityAmbiguous) {
        // Explicit refresh performs one real identity check, even after the
        // automatic retry budget is exhausted. Only successful proof recovers it.
        try { const win = await this.selectConversationCore(contact.name); await this.verifyConversationBinding(contact, win, { manualVerified: true }) }
        catch (error) {
          if (!error.lookupFailure && !['CONVERSATION_SYNC_DEFERRED', 'CHAT_WINDOW_MANUAL_CONTROL'].includes(error.code)) throw error
          manager.defer(contactId, error.code === 'CHAT_WINDOW_MANUAL_CONTROL' ? 'manual_window_visible' : 'identity_pending')
        }
      }
      this.assertConversationSyncAlive(epoch)
      this.emitConversationSync()
      return { ok: true, conversationSync: manager.state() }
    })
  }

  async processConversationSync({ idle = true } = {}) {
    if (this._destroyed) return
    const manager = this.getConversationSyncManager(), epoch = this.conversationSyncEpoch
    const work = manager.due({ idle, manualVisible: this.window?.isVisible?.() === true })
    if (work.reconcile) {
      const scan = await this.reconcileConversationList()
      this.assertConversationSyncAlive(epoch)
      if (scan.ok) manager.completeReconcile()
    }
    // Incoming work already ran first. At most one bounded identity task may
    // use the chat window per idle round; leave all other targets queued.
    const budgetUntil = Date.now() + 8000
    for (const record of work.targets.slice(0, 1)) {
      if (Date.now() >= budgetUntil) break
      if (!this.chatWindowHidden() || this._destroyed) break
      const contact = (this.storage.get().contacts || []).find(item => (record.contactIds || [record.contactId]).includes(item.id))
      if (!contact) { manager.defer(record.contactId, 'waiting_conversation'); continue }
      if (!record.expectedPlatformUserId && !record.platformUserId && !record.attempts) { manager.defer(record.contactId, 'identity_unknown'); continue }
      try { await this.selectConversation(contact.name, { syncTask: true }) }
      catch (error) {
        if (!['CONVERSATION_SYNC_DEFERRED', 'CHAT_WINDOW_MANUAL_CONTROL'].includes(error.code)) throw error
        if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') manager.defer(record.contactId, 'manual_window_visible')
      }
      this.assertConversationSyncAlive(epoch)
    }
    this.emitConversationSync()
  }

  conversationSyncIdle(ctx) {
    if (this.expressionPreparing.size || this.expressionSending.size) return false
    // Unavailable/backoff entries must not permanently starve the very sync
    // task that can repair them. Active replies and quiet-window bursts win.
    return !this.planIncomingQueue(ctx).some(plan => plan.action === 'reply' || plan.reason === 'waiting_for_incoming_burst')
  }

  isBackgroundChatOperation() {
    return this.getChatWindowCoordinator().current()?.kind === 'automation'
  }

  backgroundNavigationBlocked(win = this.window) {
    return this.isBackgroundChatOperation() && Boolean(win && !win.isDestroyed?.() && win.isVisible?.())
  }

  noteManualWindowDefer(name) {
    const key = `manual_window:${name}`
    if (Date.now() - (this.lastSkipNotice.get(key) || 0) < 10 * 60_000) return
    this.lastSkipNotice.set(key, Date.now())
    this.log('queue_deferred', `${name} 暂缓：抖音窗口由本人操作，隐藏窗口后继续`, { name, reason: 'chat_window_manual_control' })
  }

  async assertBackgroundChatTarget(name, win = this.window) {
    this.assertChatOperationActive()
    if (!this.backgroundNavigationBlocked(win)) return true
    const target = resolveConversationName(name, this.storage.get().contacts || [])
    const identity = await safeExecuteJavaScript(win, conversationIdentityScript(target, boundConversationPlatformId(this.storage.get().contacts, target)), 2000, null)
    this.assertChatOperationActive()
    if (!identity?.isTargetMatch) throw chatWindowDeferred(name)
    return true
  }

  async selectConversation(name, { syncTask = false } = {}) {
    const contacts = this.storage.get().contacts || []
    const target = resolveConversationName(name, contacts)
    const matches = contacts.filter(item => item.name === target)
    if (matches.length > 1 || matches[0]?.conversationIdentityAmbiguous) throw conversationSyncDeferred('同名联系人身份不唯一，已阻止会话接管')
    const contact = matches[0], manager = this.getConversationSyncManager(), epoch = this.conversationSyncEpoch
    const record = contact?.id ? manager.getRecord(contact.id) : null
    await this.assertBackgroundChatTarget(target)
    if (record && !manager.canAttempt(contact.id) && !allowsLegacyConversationName(contact, record)) throw conversationSyncDeferred(record.status === 'NEEDS_REVIEW'
      ? '会话定位多次失败，等待新可信消息或人工检查' : '会话同步正在退避，稍后自动重试', record)
    let scan
    try {
      try {
        const win = await this.selectConversationCore(target, { timeoutMs: syncTask ? 2000 : 6000 })
        this.assertConversationSyncAlive(epoch)
        await this.verifyConversationBinding(contact, win)
        return win
      } catch (error) {
        if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL' || !error.lookupFailure) throw error
        // Exactly one directed refresh/retry in this attempt. A visible window
        // is never scrolled or redirected to recover another conversation.
        if (this.window?.isVisible?.()) throw chatWindowDeferred(target)
        scan = await this.reconcileConversationList({ targetName: target, targetPlatformId: conversationPlatformId(contact), restore: false })
        this.assertConversationSyncAlive(epoch)
        if (scan.deferred || this.window?.isVisible?.()) throw chatWindowDeferred(target)
        const win = await this.selectConversationCore(target, { timeoutMs: syncTask ? 2000 : 6000 })
        this.assertConversationSyncAlive(epoch)
        const refreshed = (this.storage.get().contacts || []).find(item => item.id === contact?.id) || contact
        await this.verifyConversationBinding(refreshed, win)
        return win
      }
    } catch (error) {
      if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') { if (contact?.id) manager.defer(contact.id, 'manual_window_visible'); throw error }
      if (!error.lookupFailure) throw error
      if (contact?.id) {
        manager.request({ reason: 'locate_failed', contactId: contact.id, name: target, platformUserId: conversationPlatformId(contact) })
        this.conversationLookupAttempt = (this.conversationLookupAttempt || 0) + 1
        this.conversationSyncInstanceId ||= require('node:crypto').randomUUID()
        const failed = manager.failure(contact.id, { reason: error.message, evidenceKey: `attempt:${this.conversationSyncInstanceId}:${this.conversationLookupAttempt}` })
        this.emitConversationSync()
        throw conversationSyncDeferred(error.message, failed)
      }
      throw error
    } finally { await this.restoreConversationScroll(scan) }
  }

  async selectConversationCore(name, { timeoutMs = 6000 } = {}) {
    const win = await this.waitForChatReady()
    const targetName = resolveConversationName(name, this.storage.get().contacts || [])
    const expectedPlatformId = boundConversationPlatformId(this.storage.get().contacts, targetName)
    if (!targetName) throw new Error('联系人名称不能为空')

    // 检查当前是否已经停留在目标会话上（且右侧编辑器就绪）
    const initialCheck = await safeExecuteJavaScript(win, `(() => {
      const target = ${JSON.stringify(targetName)}
      const extractConversationName = ${extractConversationName.toString()}
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      if (!editor || document.querySelector('[class*="RightPanelEmpty"]')) return { isAlreadyTarget: false }

      const isConversationTargetMatch = ${isConversationTargetMatch.toString()}
      const readConversationIdentity = ${readConversationIdentity.toString()}
      const identity = ${expectedPlatformId ? conversationIdentityScript(targetName, expectedPlatformId) : 'readConversationIdentity(document, target)'}
      return { ...identity, isAlreadyTarget: identity.isTargetMatch }
    })()`, 2000, null)

    if (initialCheck?.isAlreadyTarget) return win
    // A visible login/chat window belongs to the user. Recheck immediately
    // before every navigation, including after DOM awaits in an older round.
    if (this.backgroundNavigationBlocked(win)) throw chatWindowDeferred(name)

    const point = await safeExecuteJavaScript(win, `(() => {
      const target = ${JSON.stringify(targetName)}
      const extractConversationName = ${extractConversationName.toString()}
      const wrapper = document.querySelector('[class*="conversationConversationListwrapper"]')
      if (!wrapper) return null
      const rows = [...wrapper.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
      const row = ${conversationRowScript(targetName, expectedPlatformId)}
      if (!row) return null
      row.scrollIntoView({ block: 'nearest' })
      const rect = row.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`, 2500, null)
    if (!point) { const error = new Error(`没有在当前私信列表中找到联系人：${name}`); error.lookupFailure = true; throw error }

    if (this.backgroundNavigationBlocked(win)) throw chatWindowDeferred(name)

    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })

    const started = Date.now()
    let lastDomClickAt = 0
    let lastActiveName = ''
    while (Date.now() - started < timeoutMs) {
      const check = await safeExecuteJavaScript(win, `(() => {
        const target = ${JSON.stringify(targetName)}
        const extractConversationName = ${extractConversationName.toString()}
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        const hasEmpty = Boolean(document.querySelector('[class*="RightPanelEmpty"]'))
        if (!editor || hasEmpty) return { ready: false, reason: 'editor_not_ready' }

        const isConversationTargetMatch = ${isConversationTargetMatch.toString()}
        const readConversationIdentity = ${readConversationIdentity.toString()}
        const identity = ${expectedPlatformId ? conversationIdentityScript(targetName, expectedPlatformId) : 'readConversationIdentity(document, target)'}
        return { ...identity, ready: identity.isTargetMatch }
      })()`, 2000, null)

      if (check?.ready) return win
      if (check?.activeName) lastActiveName = check.activeName

      if (this.backgroundNavigationBlocked(win)) throw chatWindowDeferred(name)

      // 若未切换成功，每隔 500ms 重试一次 DOM 点击
      if (Date.now() - lastDomClickAt >= 500) {
        lastDomClickAt = Date.now()
        await safeExecuteJavaScript(win, `(() => {
          const target = ${JSON.stringify(targetName)}
          const extractConversationName = ${extractConversationName.toString()}
          const rows = [...document.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
          const row = ${conversationRowScript(targetName, expectedPlatformId)}
          if (!row) return false
          row.scrollIntoView({ block: 'nearest' })
          row.click()
          row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
          row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
          return true
        })()`, 1500, false)
      }

      await sleep(150)
    }

    const error = new Error(`点击联系人后未成功切换到目标聊天窗口：期望“${targetName}”，当前停留在“${lastActiveName || '其他会话'}”`)
    error.lookupFailure = true; throw error
  }

  async captureLatestIncomingMessageIdentity(name, sourceWindow = null) {
    const win = sourceWindow && !sourceWindow.isDestroyed?.() ? sourceWindow : await this.selectConversation(name)
    await this.assertConversationTarget(win, name)
    await this.waitForEditor(win)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const identity = await this.withChatRead(() => executePageScript(win, `(() => {
        const readVisibleMessageEvidence = ${readVisibleMessageEvidence.toString()}
        const CHAT_MESSAGE_ROW_SELECTOR = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
        const readVisibleChatRows = ${readVisibleChatRows.toString()}
        document.querySelectorAll('[data-xusheng-latest-message]').forEach((node) => node.removeAttribute('data-xusheng-latest-message'))
        const rows = readVisibleChatRows()
        const selected = rows.at(-1)
        if (!selected) return null
        const rect = selected.node.getBoundingClientRect()
        if (rect.bottom <= 0 || rect.top >= innerHeight) return null
        selected.node.setAttribute('data-xusheng-latest-message', selected.role)
        return {
          role: selected.role,
          ids: selected.message.ids,
          urls: [...(selected.message.mediaEvidence?.urls || []), ...(selected.message.quote?.mediaEvidence?.urls || [])],
          text: selected.message.text,
          fallbackOrdinal: selected.fallbackOrdinal,
          message: selected.message,
          media: Boolean(selected.message.mediaEvidence || selected.message.quote?.mediaEvidence),
        }
      })()`), 'latest_message').catch(() => null)
      await this.assertConversationTarget(win, name)
      if (!identity) {
        if (attempt < 3) await sleep(250)
        continue
      }
      const fingerprint = identity.fingerprint || (identity.message ? stableMessageFingerprint({ ...identity,
        ids: identity.message.ids, urls: [...(identity.message.mediaEvidence?.urls || []), ...(identity.message.quote?.mediaEvidence?.urls || [])], text: identity.message.text,
      }) : stableMessageFingerprint(identity))
      if (fingerprint) return { ...identity, fingerprint, messageId: fingerprint }
      if (attempt < 3) await sleep(250)
    }
    return null
  }

  // Capture the complete latest incoming media bubble. Douyin share cards often
  // contain a poster image, text and nested video nodes, so selecting the last
  // <img> or <video> alone can capture an avatar or a sticker instead.
  async captureLatestIncomingMedia(name, recognitionOptions = {}) {
    const recognition = { ...videoRecognitionOptions(this.storage.get().settings || {}), ...(recognitionOptions || {}) }
    const maxFrames = Math.max(0, Math.min(3, Math.floor(Number(recognition.maxFrames ?? 3) || 0)))
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const identity = await this.captureLatestIncomingMessageIdentity(name, win)
    const expectedId = recognition.expectedMessageId || recognition.expectedFingerprint || ''
    const failedCapture = reason => normalizeCapturedMedia({ frames: [], mediaKind: recognition.expectedMediaKind || '', capturedMessageId: expectedId,
      confidence: 'none', reason, captureEvidence: { source: 'visible_message_dom', status: 'failed', reason }, frameCoverage: 'none' })
    if (!identity || identity.role !== 'contact') return failedCapture('current_incoming_message_unverified')
    if (expectedId && identity.fingerprint !== expectedId && identity.messageId !== expectedId) return failedCapture('current_message_changed')
    const capturedMessageId = identity.messageId || identity.fingerprint
    // 消息捕获 hook 在页面加载时已注入（见 ensureWindow），这里幂等兜底。
    await this.injectMessageCaptureHook(win)
    const media = await executePageScript(win, `(() => {
      document.querySelectorAll('[data-xusheng-media-capture]').forEach((node) => node.removeAttribute('data-xusheng-media-capture'))
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const rowSelector = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
      const mediaSelector = ${JSON.stringify(CHAT_MESSAGE_MEDIA_SELECTOR)}
      const extractReactAwemeId = ${extractReactAwemeId.toString()}
      const markedRow = document.querySelector('[data-xusheng-latest-message="contact"]')
      const readVisibleMessageEvidence = ${readVisibleMessageEvidence.toString()}
      if (!markedRow) return null
      const expectedStructure = ${JSON.stringify(identity.message || null)}
      if (expectedStructure && JSON.stringify(readVisibleMessageEvidence(markedRow)) !== JSON.stringify(expectedStructure)) return null
      const seen = new Set()
      const all = markedRow
        ? [markedRow]
        : [...document.querySelectorAll(rowSelector + ', ' + mediaSelector)]
            .map((node) => node.closest(rowSelector))
            .filter((node) => node && !seen.has(node) && seen.add(node))
      const rows = all
        .map((node) => {
          const rect = node.getBoundingClientRect()
          let signature = ''
          for (let parent = node, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
          const selfByClass = /MessageItemTextisFromMe|isFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
          const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
          const quoteNode = node.querySelector('[data-e2e*="quote" i], [class*="quote" i], [class*="replyMsg" i], [class*="referMsg" i]')
          const message = readVisibleMessageEvidence(node)
          const mediaRoot = message.mediaKind ? node : message.quote?.mediaEvidence ? quoteNode : node
          const mediaNode = [...mediaRoot.querySelectorAll('video, [style*="background-image"], [class*="video" i], [class*="image" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i], img')].find((candidate) => {
            const candidateRect = candidate.getBoundingClientRect()
            let candidateClasses = ''
            for (let current = candidate, depth = 0; current && current !== node && depth < 4; current = current.parentElement, depth += 1) candidateClasses += ' ' + String(current.className || '')
            return candidateRect.width >= 32 && candidateRect.height >= 32 && !/avatar|userhead|headimage|profilephoto/i.test(candidateClasses)
              && candidateRect.bottom > 0 && candidateRect.top < innerHeight && candidateRect.right > 0 && candidateRect.left < innerWidth
              && (mediaRoot === quoteNode || !quoteNode?.contains(candidate))
          })
          if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return null
          const roleNode = mediaNode || node
          const mediaRect = roleNode.getBoundingClientRect()
          const center = mediaRect.left + mediaRect.width / 2
          const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
          const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
          const video = mediaRoot.querySelector('video')
          const videoCandidate = video || mediaRoot.querySelector('[class*="video" i], [class*="player" i], [class*="play" i]')
          const poster = video?.poster || node.querySelector('img')?.currentSrc || node.querySelector('img')?.src || ''
          const videoUrl = video?.currentSrc || video?.src || video?.querySelector('source')?.src || ''
          const shareUrl = (() => {
            const reactAwemeId = extractReactAwemeId(node)
            if (reactAwemeId) return 'https://www.douyin.com/video/' + reactAwemeId
            const urlPattern = /(?:https?:\\/\\/v\\.douyin\\.com\\/[^\\s"'<>]+|https?:\\/\\/[^\\s"'<>]*douyin\\.com\\/(?:video|note|share)\\/[^\\s"'<>]+|\\/video\\/\\d+|\\/note\\/\\d+|\\/share\\/[^\\s"'<>]+)/i
            const values = []
            const collect = (item) => {
              const text = String(item || '')
              const match = text.match(urlPattern)
              if (match) values.push(match[0])
            }
            // 视频卡片常被 <a href> 包裹，链接可能挂在外层祖先上：向上扫描到 body。
            const ancestors = []
            for (let parent = node.parentElement, depth = 0; parent && parent !== document.body && depth < 12; parent = parent.parentElement, depth += 1) ancestors.push(parent)
            const nodes = [node, ...node.querySelectorAll('*'), ...ancestors]
            for (const item of nodes) {
              for (const attr of ['href', 'src', 'data-href', 'data-url', 'data-share-url', 'data-video-url', 'data-item-url', 'data-link', 'data-id', 'data-item-id', 'data-aweme-id', 'data-video-id', 'data-group-id', 'data-e2e', 'aria-label', 'title']) {
                collect(item.getAttribute?.(attr))
              }
              collect(item.dataset ? Object.values(item.dataset).join(' ') : '')
            }
            collect(node.innerText)
            collect(node.outerHTML)
            // 没有完整链接时，尝试从 id 类属性拼出公开页 URL（videoId 通常 ≥ 8 位数字）。
            for (const item of nodes) {
              for (const attr of ['data-id', 'data-item-id', 'data-aweme-id', 'data-video-id', 'data-group-id']) {
                const id = String(item.getAttribute?.(attr) || '').match(/\\d{8,}/)?.[0]
                if (id) values.push('https://www.douyin.com/video/' + id)
              }
            }
            // 封面 div 的背景图 URL 常带 aweme_id 参数（如 ...?aweme_id=xxx），
            // 这是最后一条可靠线索：从计算样式里提取背景图并匹配视频 ID。
            if (!values.length) {
              const bgNodes = [...node.querySelectorAll('[class*="awemeContainer" i], [class*="cover" i], [style*="background"]')]
              for (const el of bgNodes) {
                const bg = String(getComputedStyle(el).backgroundImage || el.getAttribute('style') || '')
                const urlMatch = bg.match(/url\\(["']?([^"')]+)["']?\\)/i)
                if (urlMatch) collect(urlMatch[1])
                collect(bg)
              }
            }
            for (const raw of values) {
              try { return new URL(raw, location.href).href } catch {}
            }
            return ''
          })()
          if (!mediaNode && !shareUrl) return null
          const shareText = String(node.innerText || '').replace(/\\r/g, '\\n').trim().slice(0, 1000)
          // 诊断：记录卡片 DOM 特征，便于排查分享链接/标题提取失败。
          const domHint = {
            rowClass: String(node.className || '').slice(0, 120),
            anchors: [...node.querySelectorAll('a[href]')].slice(0, 3).map((a) => String(a.getAttribute('href') || '').slice(0, 120)),
            imgSrcs: [...node.querySelectorAll('img')].slice(0, 3).map((img) => String(img.getAttribute('src') || img.currentSrc || '').slice(0, 160)),
            bgImages: [...node.querySelectorAll('[class*="awemeContainer" i], [class*="cover" i], [style*="background"]')].slice(0, 3).map((el) => String(getComputedStyle(el).backgroundImage || el.getAttribute('style') || '').slice(0, 200)),
            videoSrcs: [...node.querySelectorAll('video')].slice(0, 2).map((v) => String(v.currentSrc || v.src || '').slice(0, 120)),
            html: String(node.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 2500),
          }
          const videoRect = video?.getBoundingClientRect()
          return { node, rect, role, top: rect.top, video, videoCandidate, poster, videoUrl, videoRect, shareUrl, shareText, domHint, message, mediaNode, quoteMedia: mediaRoot === quoteNode }
        }).filter((item) => item && item.role === 'contact').sort((left, right) => left.top - right.top)
      const selected = rows.at(-1)
      if (!selected) return null
      selected.node.scrollIntoView({ block: 'center', inline: 'nearest' })
      selected.node.setAttribute('data-xusheng-media-capture', 'latest')
      // Non-video captures contain only the selected visible media, never the
      // whole chat row (which also includes avatars and unrelated quotations).
      const rect = (selected.videoCandidate ? selected.node : selected.mediaNode)?.getBoundingClientRect()
      if (!rect) return null
      const videoAfterScroll = selected.node.querySelector('video')
      const videoRectAfterScroll = videoAfterScroll?.getBoundingClientRect()
      const openTarget = selected.node.querySelector('[class*="ShareAweme" i], [class*="activeClickArea" i], [class*="awemeContainer" i], a[href], [role="button"], [class*="video" i], [class*="card" i], [class*="play" i], video') || selected.videoCandidate || selected.node
      const openRect = openTarget.getBoundingClientRect()
      const playIcon = selected.node.querySelector('[class*="playIcon" i], [class*="PlayIcon" i], [class*="play" i], svg[viewBox]')
      const playIconRect = playIcon?.getBoundingClientRect()
      const coverEl = selected.node.querySelector('[class*="awemeContainer" i], [class*="cover" i], [class*="imgReal" i]') || selected.node.querySelector('img')
      const coverRect = coverEl?.getBoundingClientRect()
      return {
        message: selected.message,
        quoteMedia: selected.quoteMedia,
        isVideo: Boolean(videoAfterScroll || selected.videoCandidate || selected.message.mediaKind === 'video' || String(selected.shareUrl).includes('douyin.com/video/')),
        duration: videoAfterScroll && Number.isFinite(videoAfterScroll.duration) ? videoAfterScroll.duration : 0,
        videoUrl: /^https?:\\/\\//i.test(selected.videoUrl || '') ? selected.videoUrl : '',
        shareUrl: /^https?:\\/\\//i.test(selected.shareUrl || '') ? selected.shareUrl : '',
        shareText: selected.shareText || '',
        domHint: selected.domHint || null,
        assetUrls: [...selected.node.querySelectorAll('img')]
          .map((image) => image.currentSrc || image.src || '')
          .filter((url) => /^https?:\\/\\//i.test(url))
          .slice(0, 10),
        playIconPoint: playIconRect?.width && playIconRect?.height ? {
          x: Math.round(playIconRect.left + playIconRect.width / 2),
          y: Math.round(playIconRect.top + playIconRect.height / 2),
        } : null,
        coverPoint: coverRect?.width && coverRect?.height ? {
          x: Math.round(coverRect.left + coverRect.width / 2),
          y: Math.round(coverRect.top + coverRect.height / 2),
        } : null,
        posterUrl: /^https?:\\/\\//i.test(selected.poster || '') ? selected.poster : '',
        openPoint: openRect.width && openRect.height ? {
          x: Math.round(openRect.left + openRect.width / 2),
          y: Math.round(openRect.top + openRect.height / 2),
        } : null,
        videoRect: videoRectAfterScroll ? {
          x: Math.max(0, Math.floor(videoRectAfterScroll.x)),
          y: Math.max(0, Math.floor(videoRectAfterScroll.y)),
          width: Math.max(1, Math.ceil(Math.min(videoRectAfterScroll.right, innerWidth) - Math.max(0, videoRectAfterScroll.x))),
          height: Math.max(1, Math.ceil(Math.min(videoRectAfterScroll.bottom, innerHeight) - Math.max(0, videoRectAfterScroll.y))),
        } : null,
        rect: {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(Math.min(rect.right, innerWidth) - Math.max(0, rect.x))),
          height: Math.max(1, Math.ceil(Math.min(rect.bottom, innerHeight) - Math.max(0, rect.y))),
        },
      }
    })()`).catch(() => null)
    if (!media?.rect?.width || !media?.rect?.height) return failedCapture('no_bound_visible_media')
    const currentMediaKind = media.isVideo ? 'video' : media.quoteMedia ? media.message?.quote?.type || 'image' : media.message?.mediaKind || recognition.expectedMediaKind || 'image'
    const shouldCaptureFrames = maxFrames > 0 && (recognition.publicPageOnly !== true || !media.isVideo)
    // publicPageOnly 模式：优先从 fetch/XHR hook 捕获的消息数据里取视频 ID
    // （零点击、零弹层）；hook 没捕获到时才点击卡片，由导航/webRequest 拦截
    // 兜底。无论哪种方式，主窗口都保持聊天界面不导航。
    if (recognition.publicPageOnly === true && media.isVideo && !media.shareUrl && media.openPoint) {
      // WebSocket 推送有延迟，轮询等待 hook 捕获到最新消息（最多 3.5 秒）。
      const waitStarted = Date.now()
      while (Date.now() - waitStarted < 3500) {
        await sleep(400)
        const pendingCount = await executePageScript(win, `(() => {
          const info = window.__xushengVideoInfo || new Map()
          let fresh = 0
          for (const meta of info.values()) if (meta && meta.at >= Date.now() - 90 * 1000) fresh += 1
          return fresh
        })()`).catch(() => 0)
        if (pendingCount > 0) break
      }
      // 1) 只接受能与当前卡片作者、封面或文案强匹配的 hook 数据。
      //    绝不能拿任意历史 ID 兜底，否则会用旧视频回复当前消息。
      const hookResult = await executePageScript(win, `(() => {
        const ids = window.__xushengVideoIds || []
        const info = window.__xushengVideoInfo || new Map()
        const cardText = ${JSON.stringify(String(media.shareText || '').slice(0, 1000))}
        const assetUrls = ${JSON.stringify((media.assetUrls || []).slice(0, 10))}
        const normalize = (value) => String(value || '').replace(/^@/, '').replace(/\\s+/g, '').trim().toLowerCase()
        const assetKey = (value) => {
          try { return decodeURIComponent(new URL(String(value || '')).pathname).replace(/~.*$/, '') }
          catch { return String(value || '').split('?')[0].replace(/~.*$/, '') }
        }
        const pick = (id) => {
          const meta = info.get(id)
          return { id, author: meta?.author || '', desc: meta?.desc || '' }
        }
        const cardKeys = new Set(assetUrls.map(assetKey).filter((key) => key.length >= 12))
        const coverMatches = ids.filter((id) => {
          const covers = info.get(id)?.covers || []
          return covers.some((url) => cardKeys.has(assetKey(url)))
        })
        if (coverMatches.length === 1) return pick(coverMatches[0])

        const lines = cardText.split(/[\\r\\n]+/).map((line) => line.trim()).filter(Boolean)
        const sourceIndex = lines.findIndex((line) => /来自(?:视频|图文)/.test(line))
        const sourceAuthor = sourceIndex >= 0 ? lines[sourceIndex + 1] || '' : ''
        const authorHint = normalize(sourceAuthor || (lines.length === 1 ? lines[0] : ''))
        if (authorHint.length >= 2) {
          const authorMatches = ids.filter((id) => {
            const author = normalize(info.get(id)?.author)
            return author && (author === authorHint || author.includes(authorHint) || authorHint.includes(author))
          })
          if (authorMatches.length === 1) return pick(authorMatches[0])
        }

        const normalizedCard = normalize(cardText)
        const textMatches = ids.filter((id) => {
          const meta = info.get(id)
          return [meta?.title, meta?.desc].some((value) => {
            const text = normalize(value)
            return text.length >= 8 && normalizedCard.length >= 8 && (text.includes(normalizedCard) || normalizedCard.includes(text))
          })
        })
        if (textMatches.length === 1) return pick(textMatches[0])
        return { id: '' }
      })()`).catch(() => ({ id: '' }))
      if (hookResult && /^\d{10,20}$/.test(String(hookResult.id || ''))) {
        media.shareUrl = 'https://www.douyin.com/video/' + hookResult.id
        const hookedText = [hookResult.author, hookResult.desc].filter(Boolean).join(' ').trim().slice(0, 300)
        if (hookedText) media.shareText = hookedText
      } else {
        // hook 未拿到强匹配 ID 时只记录状态，不能使用任意历史 ID。
        const hookDebug = await executePageScript(win, `(() => {
          const ids = window.__xushengVideoIds || []
          const info = window.__xushengVideoInfo || new Map()
          return {
            len: ids.length,
            last: ids.at(-1) || '',
            all: ids.slice(-8),
            hooked: Boolean(window.__xushengFetchHook),
          }
        })()`).catch(() => null)
        this.log('video_hook_debug', `当前卡片未匹配到 hook 视频 ${name}`, { name, hookDebug, shareText: String(media.shareText || '').slice(0, 60) })
        if (!media.shareUrl) {
        // 2) hook 未捕获，点击卡片由导航/webRequest 拦截兜底，随后关闭弹层。
        const detailIdsBefore = new Set(this._videoDetailIds)
        const hookIdsBefore = await executePageScript(win, 'Array.from(window.__xushengVideoIds || [])').catch(() => [])
        const winBefore = this._capturedVideoUrl
        this._capturedVideoUrl = null
        const click = (point) => {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
        }
        click(media.openPoint)
        const started = Date.now()
        let awemeId = ''
        let urlAfterClick = ''
        let detailRequests = 0
        while (Date.now() - started < 3500) {
          await sleep(400)
          if (this._capturedVideoUrl) break
          const href = await executePageScript(win, 'location.href').catch(() => '')
          urlAfterClick = String(href || urlAfterClick)
          if (/douyin\.com\/(?:video|note)\//i.test(urlAfterClick)) {
            this._capturedVideoUrl = urlAfterClick
            break
          }
          detailRequests = this._videoDetailIds.size
          if (!awemeId) {
            const lastId = [...this._videoDetailIds].filter((id) => !detailIdsBefore.has(id)).at(-1)
            if (lastId) awemeId = lastId
          }
        }
        // 无论是否捕获成功，都要关闭播放器弹层（Esc），避免遮挡聊天界面。
        try {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await executePageScript(win, `(() => {
            const closeBtn = [...document.querySelectorAll('[class*="close" i], [class*="Close" i], [aria-label*="关闭" i], [title*="关闭" i]')]
              .find((node) => { const r = node.getBoundingClientRect(); return r.width > 8 && r.height > 8 })
            if (closeBtn) closeBtn.click()
            return Boolean(closeBtn)
          })()`).catch(() => false)
          await sleep(300)
        } catch {}
        if (this._capturedVideoUrl) {
          media.shareUrl = this._capturedVideoUrl
        } else if (awemeId) {
          media.shareUrl = 'https://www.douyin.com/video/' + awemeId
        } else {
          this._capturedVideoUrl = winBefore
        }
        // 点击后只接受本次新增的 hook ID；点击前已有的均属于历史候选。
        if (!media.shareUrl) {
          const hookLatest = await executePageScript(win, `(() => {
            const ids = window.__xushengVideoIds || []
            const before = new Set(${JSON.stringify(hookIdsBefore)})
            return ids.filter((id) => !before.has(id)).at(-1) || ''
          })()`).catch(() => '')
          if (/^\d{10,20}$/.test(String(hookLatest))) {
            media.shareUrl = 'https://www.douyin.com/video/' + hookLatest
          }
        }
        if (!media.shareUrl) {
          const hookState = await executePageScript(win, `(() => {
            const ids = window.__xushengVideoIds || []
            const info = window.__xushengVideoInfo || new Map()
            return {
              ids: ids.slice(-5),
              authors: ids.slice(-5).map((id) => String(info.get(id)?.author || '')),
              hooked: Boolean(window.__xushengFetchHook),
            }
          })()`).catch(() => null)
          this.log('video_url_capture_debug', `视频链接捕获失败诊断 ${name}`, {
            name,
            openPoint: media.openPoint,
            urlAfterClick: String(urlAfterClick || '').slice(0, 120),
            detailRequests,
            shareText: String(media.shareText || '').slice(0, 80),
            hookState,
          })
        }
        }
      }
    }
    const frames = []
    let captureBindingLost = false
    const capture = async (rect = media.rect) => {
      const stillBound = await executePageScript(win, `(() => {
        const row = document.querySelector('[data-xusheng-media-capture="latest"]')
        return row && JSON.stringify((${readVisibleMessageEvidence.toString()})(row)) === ${JSON.stringify(JSON.stringify(media.message))}
      })()`).catch(() => false)
      if (!stillBound) { captureBindingLost = true; return false }
      const image = await win.webContents.capturePage(rect)
      if (image.isEmpty()) return false
      const size = image.getSize()
      const scale = Math.min(1, 640 / size.width, 640 / size.height)
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : image
      const frame = `data:image/jpeg;base64,${resized.toJPEG(58).toString('base64')}`
      if (frame.length <= 220_000 && !frames.includes(frame)) frames.push(frame)
      return true
    }
    const seek = async (ratio) => executePageScript(win, `new Promise((resolve) => {
      const video = document.querySelector('[data-xusheng-media-capture="latest"] video')
      if (!video) return resolve(false)
      video.pause(); video.muted = true
      const seekNow = () => {
        if (!Number.isFinite(video.duration) || video.duration <= 0) return resolve(false)
        const done = () => { video.removeEventListener('seeked', done); resolve(true) }
        video.addEventListener('seeked', done, { once: true })
        setTimeout(done, 1500)
        video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.duration * ${Number(ratio)}))
      }
      const source = video.currentSrc || video.src || video.querySelector('source')?.src || ''
      if (video.readyState < 1 && /^https?:\\/\\//i.test(source)) {
        try { video.src = source; video.load() } catch {}
      } else {
        try { video.load() } catch {}
      }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 1) return seekNow()
      const ready = () => { video.removeEventListener('loadedmetadata', ready); seekNow() }
      video.addEventListener('loadedmetadata', ready, { once: true })
      setTimeout(() => { video.removeEventListener('loadedmetadata', ready); seekNow() }, 2500)
    })`).catch(() => false)
    let decodedVideoFrames = 0
    if (!shouldCaptureFrames) {
      // Public-page modes intentionally avoid screenshots, posters and video frames.
    } else if (media.isVideo) {
      // 视频只采用真实解码出的关键帧（seek 到具体时间点截取）；
      // 不再使用气泡截图和封面 poster —— 封面与视频内容常常不符，据此回复容易编错画面。
      for (const ratio of (maxFrames > 2 ? [0.2, 0.68] : maxFrames >= 1 ? [0.5] : [])) {
        if (await seek(ratio)) {
          if (await capture(media.videoRect || media.rect)) decodedVideoFrames += 1
        }
      }
    } else {
      await capture()
    }
    this.log(recognition.publicPageOnly === true ? 'video_public_context_attempted' : 'media_captured', recognition.publicPageOnly === true ? `已尝试读取 ${name} 的视频公开页文案和评论` : `Captured media from ${name}`, { name, frames: Math.min(frames.length, maxFrames), video: media.isVideo, videoAddressFound: Boolean(media.videoUrl), videoPageUrlFound: Boolean(media.shareUrl), shareUrl: String(media.shareUrl || '').slice(0, 120), shareText: String(media.shareText || '').slice(0, 120), openPoint: media.openPoint, domHint: media.domHint, posterFound: shouldCaptureFrames && Boolean(media.posterUrl), mode: recognition.mode || 'smart', publicPageOnly: recognition.publicPageOnly === true })
    const [audioMeta, commentMeta] = await Promise.all([
      recognition.audio === false || recognition.publicPageOnly === true ? Promise.resolve({}) : this.transcribeCapturedMediaAudio(media, name, win),
      media.isVideo || media.shareUrl ? this.readVideoCommentContext(media, name, recognition, win) : Promise.resolve({}),
    ])
    const mergedCommentMeta = mergePublicMediaContext(commentMeta, media.shareText || '', recognition.commentLimit || 5)
    if (recognition.publicPageOnly === true) {
      this.log('video_public_context_ready', `已整理 ${name} 的视频文案和评论上下文`, {
        name,
        comments: mergedCommentMeta.videoComments.length,
        titleFound: Boolean(mergedCommentMeta.videoPageTitle),
        descriptionFound: Boolean(mergedCommentMeta.videoPageDescription),
        source: mergedCommentMeta.videoCommentSource || '',
        error: mergedCommentMeta.videoCommentError || '',
      })
    }
    const result = normalizeCapturedMedia({
      ...mergedCommentMeta,
      ...audioMeta,
      frames: captureBindingLost ? [] : frames.slice(0, maxFrames),
      mediaKind: currentMediaKind,
      capturedMessageId,
      captureEvidence: { source: 'visible_message_dom', status: captureBindingLost ? 'failed' : 'bound', messageId: capturedMessageId,
        ...(captureBindingLost ? { reason: 'current_message_changed' } : {}),
        association: 'latest_incoming_row_identity', ...(media.quoteMedia ? { target: 'quote_media' } : { target: 'current_media' }) },
      frameCoverage: media.isVideo && decodedVideoFrames > 0 ? 'representative_frames' : frames.length ? 'current_frame_only' : 'none',
      originalText: media.message?.text || '',
      mediaEvidence: media.message?.mediaEvidence,
      quote: media.message?.quote,
      detectedVideo: media.isVideo,
      videoReady: media.isVideo && decodedVideoFrames > 0,
      decodedVideoFrames,
      videoAddressFound: Boolean(media.videoUrl),
      videoPageUrlFound: Boolean(media.shareUrl || mergedCommentMeta.videoPageUrlFound),
      posterFound: shouldCaptureFrames && Boolean(media.posterUrl),
      captureSource: 'message_bubble',
      confidence: shouldCaptureFrames ? (media.isVideo ? (decodedVideoFrames > 0 ? 'high' : 'none') : (frames.length ? 'medium' : 'none')) : (mergedCommentMeta.videoComments.length || mergedCommentMeta.videoPageDescription || mergedCommentMeta.videoPageTitle ? 'medium' : 'none'),
      reason: captureBindingLost ? 'current_message_changed' : shouldCaptureFrames ? (media.isVideo && decodedVideoFrames <= 0 ? 'video_not_decoded' : '') : 'public_page_only',
    })
    return result
  }

  async captureLatestIncomingVideo(name) {
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const media = await executePageScript(win, `(() => {
      document.querySelectorAll('[data-xusheng-video-capture]').forEach((node) => node.removeAttribute('data-xusheng-video-capture'))
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const rowSelector = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
      const markedRow = document.querySelector('[data-xusheng-latest-message="contact"]')
      const visible = (node) => {
        const rect = node.getBoundingClientRect()
        return rect.width >= 72 && rect.height >= 48 && rect.bottom > 0 && rect.top < innerHeight
      }
      const build = (node) => {
        const rect = node.getBoundingClientRect()
        let signature = ''
        let parent = node
        for (let depth = 0; parent && depth < 7; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
        const looksLikeMedia = node.tagName === 'VIDEO' || /video|player|play|image|photo|picture|album|gallery|sticker|emoji|gif|share|card|content/i.test(signature) || /background-image/i.test(node.getAttribute('style') || '')
        const looksLikeAvatar = /avatar|userhead|headimage|profilephoto/i.test(signature)
        if (!looksLikeMedia || looksLikeAvatar || !visible(node)) return null
        const selfByClass = /MessageItemTextisFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
        const fromMe = selfByClass || (!contactByClass && center > divider)
        if (fromMe) return null
        return { node, rect, isVideo: node.tagName === 'VIDEO', top: rect.top }
      }
      let candidates = []
      // 优先在身份捕获标记的最新消息行内寻找媒体，避免新消息尚未渲染
      // 完成时误选旧消息或界面其它元素。
      if (markedRow) {
        for (const node of markedRow.querySelectorAll('video, img, [style*="background-image"]')) {
          const item = build(node)
          if (item) candidates.push(item)
        }
      }
      // 标记行内没有候选时，退回全页面扫描（仍限定在聊天消息行容器内）。
      if (!candidates.length) {
        for (const row of document.querySelectorAll(rowSelector)) {
          for (const node of row.querySelectorAll('video, img, [style*="background-image"]')) {
            const item = build(node)
            if (item) candidates.push(item)
          }
        }
      }
      if (!candidates.length) return null
      candidates.sort((left, right) => left.top - right.top)
      const selected = candidates.at(-1)
      selected.node.setAttribute('data-xusheng-video-capture', 'latest')
      const rect = selected.rect
      return {
        isVideo: selected.isVideo,
        duration: selected.isVideo && Number.isFinite(selected.node.duration) ? selected.node.duration : 0,
        rect: {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(Math.min(rect.right, innerWidth) - Math.max(0, rect.x))),
          height: Math.max(1, Math.ceil(Math.min(rect.bottom, innerHeight) - Math.max(0, rect.y))),
        },
      }
    })()`).catch(() => null)
    if (!media?.rect?.width || !media?.rect?.height) return []

    const frames = []
    const capture = async () => {
      const image = await win.webContents.capturePage(media.rect)
      if (image.isEmpty()) return
      const size = image.getSize()
      const scale = Math.min(1, 448 / size.width, 320 / size.height)
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : image
      const frame = `data:image/jpeg;base64,${resized.toJPEG(52).toString('base64')}`
      if (frame.length <= 180_000 && !frames.includes(frame)) frames.push(frame)
    }
    const seek = async (ratio) => executePageScript(win, `new Promise((resolve) => {
      const video = document.querySelector('[data-xusheng-video-capture="latest"]')
      if (!video || video.tagName !== 'VIDEO' || !Number.isFinite(video.duration) || video.duration <= 0) return resolve(false)
      video.pause(); video.muted = true
      const done = () => { video.removeEventListener('seeked', done); resolve(true) }
      video.addEventListener('seeked', done, { once: true })
      setTimeout(done, 1500)
      video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.duration * ${Number(ratio)}))
    })`).catch(() => false)

    if (media.isVideo && media.duration > 0) {
      for (const ratio of [0.08, 0.5, 0.88]) {
        await seek(ratio)
        await capture()
      }
    } else {
      await capture()
    }
    this.log('video_captured', `Captured video frames from ${name}`, { name, frames: frames.length })
    return frames.slice(0, 3)
  }

  async learnConversation(name) {
    if (!name) throw new Error('Select a contact')
    await this.syncContacts()
    name = resolveConversationName(name, this.storage.get().contacts || [])
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const visibleMessages = await executePageScript(win, `(() => {
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const primary = [...document.querySelectorAll('[class*="MessageItemTextcontainer"]')]
      const candidates = primary.length ? primary : [...document.querySelectorAll('[class*="messageItem"], [data-e2e*="message-item"]')]
      const rows = candidates.filter((node, index) => {
        const rect = node.getBoundingClientRect()
        if (!rect.width || !rect.height) return false
        return !candidates.some((other, otherIndex) => otherIndex !== index && other.parentElement === node && other.getBoundingClientRect().height >= rect.height * 0.7)
      }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      const messages = []
      for (const node of rows) {
        const raw = (node.innerText || '').split(/\\n+/).map((part) => part.trim()).filter(Boolean)
        const text = raw.filter((part) => !/^(已读|未读|\\d{1,2}:\\d{2}|昨天|今天)$/.test(part)).join(' ').replace(/\\s+/g, ' ').trim()
        if (!text || text.length > 500) continue
        let signature = ''
        for (let current = node, depth = 0; current && depth < 4; current = current.parentElement, depth += 1) signature += ' ' + String(current.className || '')
        const selfByClass = /MessageItemTextisFromMe/i.test(signature) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const bubble = node.querySelector('[class*="content"], [class*="text"], [class*="bubble"]') || node
        const rect = bubble.getBoundingClientRect()
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : window.innerWidth * 0.65
        const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
        const last = messages[messages.length - 1]
        if (!last || last.role !== role || last.text !== text) messages.push({ role, text })
      }
      return messages.slice(-40)
    })()`).catch((error) => { throw new Error('Failed to read chat history: ' + error.message) })
    if (!visibleMessages.length) throw new Error('当前会话没有可学习的文字消息')

    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    const current = index >= 0 ? contacts[index] : { id: name, name }
    const messages = mergeMessageHistory(current.learning?.messages, visibleMessages)
    const learning = this.analyzeConversation(messages, current.learning)
    const updated = { ...current, learning, ...(state.settings?.longTermMemory !== false && state.settings?.eventFollowup?.enabled === true ? { socialBrain: syncMemory({ ...current, learning }) } : {}) }
    if (index >= 0) contacts[index] = updated
    else contacts.push(updated)
    this.storage.update({ contacts })
    this.emitEvent('contacts', { contacts })
    this.log('language_learned', `Updated chat style for ${name}`, { name, messages: messages.length })
    this.eventFollowups?.reconcile()
    return { ok: true, contact: updated, learnedMessages: messages.length }
  }

  async captureVisibleMessages(win, { strict = false } = {}) {
    if (!win || win.isDestroyed?.()) return []
    const captured = await this.withChatRead(() => executePageScript(win, `(() => {
      const readVisibleMessageEvidence = ${readVisibleMessageEvidence.toString()}
      const CHAT_MESSAGE_ROW_SELECTOR = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
      const readVisibleChatRows = ${readVisibleChatRows.toString()}
      return readVisibleChatRows().slice(-20).map(({ role, message, fallbackOrdinal }) => ({ role, ...message, fallbackOrdinal }))
    })()`), 'visible_messages').catch(error => { if (strict) throw error; return [] })
    return (Array.isArray(captured) ? captured : []).map(message => normalizeHistoryMessage({ ...message,
      messageId: stableMessageFingerprint({ role: message.role, text: message.text, ids: message.ids,
        urls: [...(message.mediaEvidence?.urls || []), ...(message.quote?.mediaEvidence?.urls || [])], fallbackOrdinal: message.fallbackOrdinal }),
    }))
  }

  // 用 AI 归纳对话风格;未配置 AI 时退化为仅保存原始消息(行为与旧内联逻辑一致)
  analyzeConversation(messages, previous = {}) {
    return this.ai?.analyzeConversation
      ? this.ai.analyzeConversation(messages, previous)
      : { messages, videoInsights: Array.isArray(previous.videoInsights) ? previous.videoInsights : [], updatedAt: new Date().toISOString() }
  }

  recordSharedMemoryLedger(contactId, messages) {
    if (!contactId || !Array.isArray(messages)) return
    const state = this.storage.get()
    const contact = (state.contacts || []).find(item => item.id === contactId)
    if (!contact) return
    const ledger = new Map((contact.sharedMemoryLedger || []).filter(row => row.contactId === contactId).map(row => [row.id || row.messageId, row]))
    for (const row of messages) {
      const id = row.id || row.messageId
      if (!id || row.previewOnly === true || row.contactId && row.contactId !== contactId || row.accountId && this.accountId && row.accountId !== this.accountId) continue
      const observedTime = row.observedAt || row.receivedAt || row.timestamp
      const timestamp = Number.isFinite(Date.parse(row.at)) ? Date.parse(row.at) : typeof observedTime === 'number' ? observedTime : Date.parse(observedTime)
      if (!Number.isFinite(timestamp)) continue
      if (row.role === 'me' && row.confirmedSent !== true) continue
      if (!['me', 'contact'].includes(row.role)) continue
      ledger.set(id, { ...row, id, messageId: id, at: new Date(timestamp).toISOString(), timestampSource: Number.isFinite(Date.parse(row.at)) ? 'message_at' : 'observed_at', contactId, accountId: this.accountId || '',
        source: row.role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(row.role === 'me' ? { confirmedSent: true, status: 'sent' } : {}) })
    }
    this.storage.update({ contacts: state.contacts.map(item => item.id === contactId ? { ...item, sharedMemoryLedger: [...ledger.values()].slice(-240) } : item) })
  }

  queueCompletedSharedInteraction(contactId, name, reason = 'interaction_complete', burstId = '') {
    // All real send paths use the same non-blocking, account-bound queue.
    try { this.ai?.queueSharedMemoryExtraction?.({ contactId, name, accountId: this.accountId || '', reason, burstId, isCurrent: () => !this._destroyed }) }
    catch (error) { this.log('shared_memory_queue_failed', '共同记忆排队失败，正常聊天不受影响', { contactId, code: error.code || 'SHARED_MEMORY_QUEUE_FAILED' }) }
    try { this.ai?.queueSelfNarrativeExtraction?.({ contactId, name, accountId: this.accountId || '', reason, burstId, isCurrent: () => !this._destroyed }) }
    catch (error) { this.log('self_narrative_queue_failed', '关系内自我记忆排队失败，正常聊天不受影响', { contactId, code: error.code || 'SELF_NARRATIVE_QUEUE_FAILED' }) }
    try { this.ai?.queuePromiseExtraction?.({ contactId, name, accountId: this.accountId || '', reason, burstId, isCurrent: () => !this._destroyed }) }
    catch (error) { this.log('promise_queue_failed', '关系内承诺排队失败，正常聊天不受影响', { contactId, code: error.code || 'PROMISE_QUEUE_FAILED' }) }
  }

  recordConversationMessage(name, role, text, fallbackContact = {}, options = {}) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (!name || (!value && !options.mediaEvidence && !options.quote) || !this.storage?.update) return fallbackContact
    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    const current = index >= 0 ? contacts[index] : { ...fallbackContact, id: fallbackContact.id || name, name }
    const human = options.human === true
    // 对话历史保留全部消息（含 AI 生成的），仅用于提供聊天语境
    const recordedAt = options.at === undefined ? new Date().toISOString() : Number.isFinite(Date.parse(options.at)) ? new Date(options.at).toISOString() : ''
    const identityEvidence = options.platformUserId && options.identityVerified === true ? { platformUserId: options.platformUserId, identityVerified: true, observedAt: new Date().toISOString() } : {}
    const messageId = options.messageId || `m_${require('node:crypto').randomUUID()}`
    const provenance = typeof options.human === 'boolean' ? { human: options.human, verifiedHuman: options.human,
      ...(human ? { source: role === 'me' ? 'manual_owner' : 'contact_human' } : role === 'me' ? { source: 'ai_generated' } : {}) } : {}
    const recordedMessage = { role, text: value, id: messageId, messageId, at: recordedAt, ...identityEvidence, ...provenance,
      type: options.type, mediaKind: options.mediaKind, mediaEvidence: options.mediaEvidence, quote: options.quote }
    const messages = mergeMessageHistory(current.learning?.messages, [recordedMessage])
    // 风格统计只吸收真人消息：对方的发言、以及本人手动发送/配置的回复；
    // AI 自动生成或自动任务发送的消息不进风格数据，防止 AI 把自己的话当成"本人的说话习惯"越学越像自己。
    const stylePrev = Array.isArray(current.learning?.styleMessages)
      ? current.learning.styleMessages
      : []
    const styleMessages = mergeMessageHistory(stylePrev, human ? [recordedMessage] : [])
    const learning = this.analyzeConversation(messages, current.learning)
    learning.styleMessages = styleMessages
    learning.contactStyle = analyzeLanguageStyle(styleMessages, 'contact')
    learning.ownerStyle = analyzeLanguageStyle(styleMessages, 'me')
    let updated = { ...current, learning }
    if ((isFriendshipContact(current) || state.settings?.eventFollowup?.enabled === true) && state.settings?.longTermMemory !== false) {
      const socialBrain = syncMemory(updated)
      updated = { ...updated, socialBrain, ...(isFriendshipContact(current) ? { learning: { ...learning, facts: compatibilityFacts(socialBrain) } } : {}) }
    }
    if (index >= 0) contacts[index] = updated
    else contacts.push(updated)
    this.storage.update({ contacts })
    if (!options.synthetic && (options.sharedMemoryObserved === true && role === 'contact' || options.confirmedSent === true && role === 'me')) this.recordSharedMemoryLedger(current.id, [{ ...recordedMessage, contactId: current.id, confirmedSent: options.confirmedSent === true, observedAt: new Date().toISOString() }])
    this.eventFollowups?.reconcile()
    this.emitEvent('contacts', { contacts })
    return updated
  }
  async waitForEditor(win, timeout = 8000) {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const editor = await executePageScript(win, `(() => {
        const node = document.querySelector('${EDITOR_SELECTOR}')
        return node ? { tag: node.tagName, disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'), placeholder: node.getAttribute('placeholder') || node.getAttribute('data-placeholder') || '' } : null
      })()`).catch(() => null)
      if (editor && !editor.disabled) return editor
      await sleep(400)
    }
    throw new Error('已找到联系人，但没有找到可用的私信输入框')
  }

  async runTextSubmission(submit) {
    // Each account has separate chat and friendship windows. Share only the
    // text submission and quota update, not the automation round or model work.
    const previous = this.textSubmissionTail
    let release
    const pending = new Promise(resolve => { release = resolve })
    this.textSubmissionTail = pending
    try {
      if (previous) await previous
      return await submit()
    } finally {
      release()
      if (this.textSubmissionTail === pending) this.textSubmissionTail = null
    }
  }

  async sendCurrentInput(win, { name, targetCheckScript, assertTarget } = {}) {
    this.assertChatOperationActive?.()
    const read = (operation, stage) => this.withChatRead ? this.withChatRead(operation, stage) : operation()
    let attempted = false
    let point = null
    try {
      const verifyTarget = async () => {
        if (assertTarget) {
          if (await assertTarget() === false) throw new Error('当前会话联系人已变化，已停止发送')
        } else if (name) await this.assertConversationTarget(win, name)
      }
      if (assertTarget) await verifyTarget()
      const before = await read(() => readInput(win), 'send_input')
      if (!before.found || !normalizeEditorText(before.text)) throw new Error('私信输入框为空，已停止发送')
      const deliveryBefore = await read(() => readDelivery(win, before.text), 'send_delivery_before')
      const targetContact = name && (this.storage?.get?.()?.contacts || []).find(item => item.name === name)
      const expectedPlatformId = conversationPlatformId(targetContact)
      // Check recipient and unchanged input in the same renderer turn as the
      // single click. Never retry Enter/click after an uncertain submission.
      const targetCheck = targetCheckScript
        ? `if (!(${targetCheckScript})) return { attempted: false, reason: 'recipient_changed' };`
        : name ? `const identity = ${conversationIdentityScript(name, expectedPlatformId)}; if (!identity?.isTargetMatch) return { attempted: false, reason: 'recipient_changed' };` : ''
      if (assertTarget) await verifyTarget()
      this.assertChatOperationActive?.()
      const owner = this.getChatWindowCoordinator?.()?.current()
      if (owner?.kind === 'automation') owner.pendingSubmission = { name, incomingKey: this.incomingQueueMap().get(name)?.key || '' }
      attempted = true // Renderer errors after dispatch must remain uncertain.
      const result = await read(() => executePageScript(win, `(() => {
        ${targetCheck}
        return (${clickMessageSend.toString()})(document, ${JSON.stringify(EDITOR_SELECTOR)}, ${JSON.stringify(before.text)})
      })()`), 'send_confirmation')
      if (!result?.attempted) {
        attempted = false
        if (owner) owner.pendingSubmission = null
        throw new Error(result?.reason === 'recipient_changed' ? '当前会话联系人已变化，已停止发送' : result?.reason === 'editor_changed' ? '私信输入内容已变化，已停止发送' : '没有找到唯一可用的发送按钮，已停止发送')
      }
      attempted = true
      point = result.point
      const started = Date.now()
      while (Date.now() - started < 5000) {
        await sleep(250)
        await verifyTarget()
        const after = await read(() => readDelivery(win, before.text), 'send_delivery_after')
        if (after.found && !normalizeEditorText(after.text) && after.completeCopies > deliveryBefore.completeCopies) {
          if (owner) owner.pendingSubmission = null
          return
        }
      }
      throw new Error(`抖音未确认消息发送成功，已停止自动重试；发送位置=${point ? `(${point.x}, ${point.y})` : '未知'}`)
    } catch (error) {
      error.sendAttempted = attempted
      error.sendPoint = point
      throw error
    }
  }

  async sendEmoji(name, emojiName = '\u65e9\u4e0a\u597d') {
    if (!name || !emojiName) throw new Error('联系人和表情名称不能为空')
    this.assertCanSend(name)
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const beforeCount = await executePageScript(win, `document.querySelectorAll('.MessageItemEmojiimage').length`)
    const opened = await executePageScript(win, `(() => {
      const node = document.querySelector('.messageMsgInputiconAction')
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (!opened) throw new Error('没有找到抖音表情按钮')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: opened.x, y: opened.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: opened.x, y: opened.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: opened.x, y: opened.y })
    await sleep(800)
    const clicked = await executePageScript(win, `(() => {
      const items = [...document.querySelectorAll('.emojiEmojiItememojiItem')]
      const item = items.find((node) => (node.innerText || '').trim() === ${JSON.stringify(emojiName)})
      const target = item?.querySelector('.emojiEmojiItemimgBox')
      if (!target) return false
      target.click()
      return true
    })()`)
    if (!clicked) throw new Error(`没有找到“${emojiName}”表情包`)
    const started = Date.now()
    let sent = false
    while (Date.now() - started < 4000) {
      sent = await executePageScript(win, `(() => {
        const count = document.querySelectorAll('.MessageItemEmojiimage').length
        const panelClosed = !document.querySelector('.componentsemojiim-saas-modal')
        return panelClosed && count > ${Number(beforeCount)}
      })()`)
      if (sent) break
      await sleep(250)
    }
    if (!sent) throw new Error(`Douyin did not confirm emoji "${emojiName}" was sent`)
    this.lastSent.set(name, `[${emojiName}]`)
    this.lastReplyTime.set(name, Date.now())
    const pairs = [...this.lastSent].map(([n, t]) => ({ name: n, text: t, at: Date.now() }))
    this.storage.update({ lastSentPairs: pairs })
    this.recordSuccessfulSend(name, 'emoji')
    this.log('message_sent', `Sent emoji "${emojiName}" to ${name}`, { name, emoji: emojiName })
    return { ok: true, kind: 'emoji', emojiName }
  }

  async sendTask(name, task) {
    const effectiveTask = resolveSparkTask(task)
    if (effectiveTask?.kind === 'aiSpark') return this.sendAiSparkTask(name, effectiveTask)
    if (effectiveTask?.kind === 'emoji') return this.sendEmoji(name, effectiveTask.emojiName || '\u65e9\u4e0a\u597d')
    if (effectiveTask?.kind === 'combo') {
      await this.sendMessage(name, effectiveTask?.message || '', { source: 'spark_combo_text', allowedDrafts: sparkMessageOptions(effectiveTask) })
      const emoji = await this.sendEmoji(name, effectiveTask.emojiName || '\u65e9\u4e0a\u597d')
      return { ok: true, kind: 'combo', emojiName: emoji.emojiName, message: effectiveTask?.message || '' }
    }
    return this.sendMessage(name, effectiveTask?.message || '', { source: 'spark_text', allowedDrafts: sparkMessageOptions(effectiveTask) })
  }

  // AI 自动续火花：从行为池（该联系人近期聊天记录，按角色区分）生成一条当天自然的续火花消息并发送。
  // AI 生成失败时回退到任务自带文案，保证续火花任务不会因此中断。
  async sendAiSparkTask(name, task) {
    if (!name) throw new Error('联系人名称不能为空')
    this.assertCanSend(name)
    const state = this.storage.get()
    const contact = (state.contacts || []).find((item) => item.name === name)
    let text = ''
    let aiMeta = {}
    let sparkWeather = ''
    let sparkHotTopic = ''
    if (this.ai?.draftSparkMessage) {
      try {
        try { await fetchHotTopicsCached() } catch { /* 热点抓取失败不阻塞，热点段落自动跳过 */ }
        try { sparkWeather = await fetchWeatherContext(this.storage) } catch { sparkWeather = '' }
        try { sparkHotTopic = hotTopicForSparkCached() } catch { sparkHotTopic = '' }
        const draft = await this.ai.draftSparkMessage({ contact, task, weather: sparkWeather, hotTopic: sparkHotTopic })
        if (isFriendshipContact(contact) && draft?.skipped) return { ok: true, skipped: true, kind: 'aiSpark', message: '' }
        if (draft?.ok && draft.text) {
          text = String(draft.text).trim()
          aiMeta = { source: 'ai_spark', ai: true, model: draft.model || '', provider: draft.provider || '', aiLabel: draft.aiLabel || 'AI', selfProfileRevision: draft.selfProfileRevision }
        }
      } catch (error) {
        if (isFriendshipContact(contact) || error.code === 'SELF_PROFILE_STALE') throw error
        this.log('ai_spark_fallback', `${name} 的 AI 续火花文案生成失败，已回退默认文案`, { name, error: error.message })
      }
    }
    if (!text) {
      const hourNow = new Date().getHours()
      const greeting = hourNow < 11 ? '早上好呀' : hourNow < 14 ? '中午好' : hourNow < 18 ? '下午好' : '晚上好'
      text = sparkWeather ? `${greeting}，${sparkWeather}，今天也要照顾好自己呀～` : (String(task?.message || '').trim() || `${greeting}，今天也要照顾好自己呀～`)
      aiMeta = { source: 'spark_text' }
    }
    await this.sendMessage(name, text, aiMeta)
    return { ok: true, kind: 'aiSpark', message: text }
  }
  // 主动搭话：活跃时段内随机挑一位联系人，AI 结合其行为池（长期记忆 + 兴趣 + 最近聊天）生成自然话题主动发送。
  // 低频限流：每日总量、最小间隔、每联系人每天最多 1 条；黑名单/禁 AI 名单跳过。
  async processProactiveChats(now, blacklist, aiDisabledContacts) {
    const config = this.storage.get().settings?.proactiveChat || {}
    if (!config.enabled) return
    const today = localDateKey(now)
    const minutesNow = now.getHours() * 60 + now.getMinutes()
    const start = timeToMinutes(config.windowStart || '10:00')
    const end = timeToMinutes(config.windowEnd || '22:00')
    // 支持跨午夜窗口（如 08:00 ~ 次日 01:00）：start > end 时视为跨天
    const inWindow = start === end
      ? true
      : start < end
        ? (minutesNow >= start && minutesNow <= end)
        : (minutesNow >= start || minutesNow <= end)
    if (!inWindow) return

    let pstate = this.storage.get().proactiveState || { date: '', sentToday: 0, lastSentAt: 0, sentContacts: [] }
    if (pstate.date !== today) pstate = { date: today, sentToday: 0, lastSentAt: 0, sentContacts: [] }
    const maxPerDay = Math.max(1, Math.floor(Number(config.maxPerDay) || 2))
    if (pstate.sentToday >= maxPerDay) return
    const minIntervalMs = Math.max(60, Math.floor(Number(config.minIntervalMinutes) || 180)) * 60 * 1000
    if (pstate.lastSentAt && Date.now() - pstate.lastSentAt < minIntervalMs) return

    const contacts = this.storage.get().contacts || []
    const sentContacts = new Set(Array.isArray(pstate.sentContacts) ? pstate.sentContacts : [])
    // 候选：未被黑名单/禁 AI 屏蔽、今天还没主动搭话过、该联系人允许主动伴聊（profile.companion !== false）。
    // 注意：不能用”今天没有过发送记录”来过滤——自动回复开启时，活跃联系人每天都会被
    // 自动回复聊过，那样候选永远是空的，主动搭话就永远不触发。这里只保证每人每天最多主动搭话 1 次。
    const candidates = contacts.filter((contact) => {
      if (!contact?.name) return false
      // 防脏数据：跳过纯数字昵称（抖音同步偶发把数字 ID 当成联系人）
      if (/^\d+$/.test(String(contact.name).trim())) return false
      if (blacklist.has(contact.name) || aiDisabledContacts.has(contact.name)) return false
      if (contact?.profile?.companion === false) return false
      if (isFriendshipContact(contact) && contact?.learning?.relationshipPlan?.stop) return false
      if (isFriendshipContact(contact) && [...(contact?.learning?.messages || [])].reverse().find(item => ['me', 'contact'].includes(item.role))?.role === 'me') return false
      if (sentContacts.has(contact.name)) return false
      return true
    })
    if (!candidates.length) return
    // 选人优先级（AI 伴聊）：先挑”有话题记录且近期互动过 1~3 天”的人续话题，
    // 其次挑”很久没聊”的人重拾关系，都没有再随机兜底。
    const withRecentTopic = []
    const withGap = []
    for (const contact of candidates) {
      const days = daysSinceContact(contact?.learning || {})
      if (days === null) continue
      if (days <= 3) withRecentTopic.push(contact)
      else withGap.push(contact)
    }
    const pool = withRecentTopic.length ? withRecentTopic : (withGap.length ? withGap : candidates)
    const contact = pool[Math.floor(Math.random() * pool.length)]
    if (config.openingType === 'video' && !String(config.topicNotes || '').trim()) {
      if (!this.videoOpenings) return
      this.assertCanSend(contact.name)
      const existing = (this.storage.get().videoGreetings?.pending || []).find(item => item.name === contact.name)
      const video = existing || (await this.videoOpenings.create(contact.name)).video
      if (this.storage.get().settings?.proactiveChat?.sendToDraft === true) {
        const drafts = this.storage.get().pendingDrafts || []
        if (!drafts.some(item => item.videoOpeningId === video.id)) {
          const next = [{ id: video.id, videoOpeningId: video.id, at: new Date().toISOString(), name: video.name, text: video.text, videoUrl: video.url, videoTitle: video.title, model: video.model, status: 'pending' }, ...drafts].slice(0, 50)
          this.storage.update({ pendingDrafts: next })
          this.emitEvent('drafts', { drafts: next })
          this.log('ai_companion_draft', `已为 ${contact.name} 生成视频开场草稿`, { name: contact.name, url: video.url })
        }
      } else await this.videoOpenings.send({ id: video.id })
      this.storage.update({ proactiveState: { date: today, sentToday: pstate.sentToday + 1, lastSentAt: Date.now(), sentContacts: [...sentContacts, contact.name].slice(-100) } })
      return
    }
    if (!this.ai?.draftCompanionMessage) return
    let text = ''
    let aiMeta = {}
    try {
      const draft = await this.ai.draftCompanionMessage({ contact })
      if (draft?.ok && draft.text) {
        text = String(draft.text).trim()
        aiMeta = { source: 'companion', ai: true, model: draft.model || '', provider: draft.provider || '', aiLabel: draft.aiLabel || 'AI', selfProfileRevision: draft.selfProfileRevision }
      }
    } catch (error) {
      this.log('ai_proactive_fallback', `${contact.name} 的主动伴聊文案生成失败`, { name: contact.name, error: error.message })
    }
    if (!text) return
    const settings = this.storage.get().settings || {}
    if (String(settings.proactiveChat?.topicNotes || '').trim() !== String(config.topicNotes || '').trim()) {
      this.log('ai_proactive_fallback', '伴聊素材已修改，本次旧草稿已作废，等待下一次生成', { name: contact.name })
      return
    }
    // 伴聊消息先拟草稿：与自动回复的 aiReplyDraftOnly 同款闸门，人工确认/修改后再发送
    if (settings.proactiveChat?.sendToDraft === true) {
      const drafts = [...(this.storage.get().pendingDrafts || [])]
      this.assertAiSelfProfile(text, aiMeta)
      drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text, incoming: '', model: aiMeta.model, provider: aiMeta.provider, selfProfileRevision: aiMeta.selfProfileRevision, status: 'pending' })
      const capped = drafts.slice(0, 50)
      this.storage.update({ pendingDrafts: capped })
      this.emitEvent('drafts', { drafts: capped })
      this.log('ai_companion_draft', `已为 ${contact.name} 生成 AI 伴聊草稿待确认`, { name: contact.name, text })
    } else {
      await this.sendMessage(contact.name, text, aiMeta)
      this.log('companion_sent', `已主动与 ${contact.name} 伴聊`, { name: contact.name, text })
    }
    const sentToday = pstate.sentToday + 1
    const nextState = { date: today, sentToday, lastSentAt: Date.now(), sentContacts: [...sentContacts, contact.name].slice(-100) }
    this.storage.update({ proactiveState: nextState })
  }

  async isLastMessageFromMe(name) {
    try {
      const win = await this.selectConversation(name)
      await this.waitForEditor(win)
      const role = await executePageScript(win, `(() => {
        const rowSelector = ${JSON.stringify(CHAT_MESSAGE_ROW_SELECTOR)}
        const mediaSelector = ${JSON.stringify(CHAT_MESSAGE_MEDIA_SELECTOR)}
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        const editorRect = editor?.getBoundingClientRect()
        const seen = new Set()
        const candidates = [...document.querySelectorAll(rowSelector + ', ' + mediaSelector)]
          .map((node) => {
            const row = node.closest(rowSelector)
            if (!row || seen.has(row)) return null
            seen.add(row)
            const rect = row.getBoundingClientRect()
            if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return null
            let sig = ''
            for (let c = row, d = 0; c && d < 4; c = c.parentElement, d += 1) sig += ' ' + String(c.className || '')
            const me = /isFromMe|MessageItemTextisFromMe/i.test(sig) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(sig)
            const them = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(sig)
            const avatar = row.querySelector('[class*="avatar" i], img[src*="avatar"], [class*="Avatar" i]')
            let avatarRect = null
            if (avatar) {
              const ar = avatar.getBoundingClientRect()
              if (ar.width > 0 && ar.height > 0) avatarRect = { left: ar.left, width: ar.width, top: ar.top, height: ar.height }
            }
            const bubble = row.querySelector('[class*="MessageItemShareAweme" i], [class*="ShareAweme" i], [class*="MessageItemText" i], [class*="cardMsg" i], [class*="imageMsg" i], [class*="mediaMsg" i], [class*="textMsg" i], [class*="bubble" i], video, img:not([class*="avatar" i])')
              || row.querySelector('[class*="content"]:not([class*="rowBox"]):not([class*="columnBox"]):not([class*="contentBox"]):not([class*="ClickArea" i]), [class*="text"], [style*="background-image"], [class*="video" i], [class*="image" i], [class*="card" i]')
              || row
            const bubbleRect = bubble.getBoundingClientRect()
            return {
              withinMessageRow: true,
              rect: {
                top: rect.top,
                left: bubbleRect.left,
                width: bubbleRect.width,
                height: bubbleRect.height,
              },
              avatarRect,
              me,
              them,
            }
          })
          .filter(Boolean)
        return (${pickLatestChatMessageRole.toString()})(candidates, {
          innerWidth: window.innerWidth,
          editorRect: editorRect ? { left: editorRect.left, width: editorRect.width } : null,
        })
      })()`).catch(() => null)
      return role === 'me' ? true : role === 'contact' ? false : null
    } catch (error) { if (['CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error; return null }
  }

  async assertConversationTarget(win, name) {
    this.assertChatOperationActive()
    const contacts = this.storage.get().contacts || []
    const target = resolveConversationName(name, contacts)
    const matches = contacts.filter(item => item.name === target)
    if (matches.length > 1 || matches[0]?.conversationIdentityAmbiguous) throw new Error('发送前安全拦截：同名联系人身份不唯一，已阻止错发！')
    const expectedPlatformId = conversationPlatformId(matches[0])
    const check = await this.withChatRead(() => executePageScript(win, conversationIdentityScript(target, expectedPlatformId)), 'recipient_identity').catch(error => {
      throw new Error(`发送前无法核实联系人：${error.message}`)
    })
    this.assertChatOperationActive()
    if (!check?.isTargetMatch) {
      if (this.backgroundNavigationBlocked(win)) throw chatWindowDeferred(name)
      if (expectedPlatformId) {
        const mismatch = check?.identityState === 'MISMATCH'
        throw Object.assign(new Error(mismatch ? '发送前安全拦截：当前聊天账号与目标不一致，已阻止错发！' : '发送前暂未能核实当前聊天账号，等待页面资料加载后再试'), { code: mismatch ? 'ACCOUNT_ID_MISMATCH' : 'ACCOUNT_ID_PENDING' })
      }
      const current = check?.activeName || check?.headerText || '无法识别当前联系人'
      throw new Error(`发送前安全拦截：当前窗口处于“${current}”，与目标“${target}”不一致，已阻止错发！`)
    }
    return check
  }

  assertSharedMemoryMetadata(name, metadata = {}) {
    const ids = metadata.sharedMemoryIds || []
    if (!ids.length) return true
    const state = this.storage.get()
    const matches = (state.contacts || []).filter(contact => metadata.contactId ? contact.id === metadata.contactId && contact.name === name : contact.name === name)
    const contact = matches.length === 1 ? matches[0] : null
    const store = contact && normalizeSharedMemory(contact, { selfProfile: state.selfProfile })
    if (!store || ids.some(id => !store.memories.some(memory => memory.id === id && memory.status === 'active'))) {
      const error = new Error('本轮使用的共同记忆已删除或变更，旧回复已作废')
      error.code = 'SHARED_MEMORY_STALE'; error.sendAttempted = false
      throw error
    }
    return true
  }

  assertAiSelfProfile(text, metadata = {}) {
    if (metadata.ai !== true) return true
    const profile = this.storage.get().selfProfile
    if (metadata.selfProfileRevision !== undefined && Number(metadata.selfProfileRevision) !== Number(profile?.revision || 0)) {
      const error = new Error('本人资料已变更，旧回复已作废，请重新生成')
      error.code = 'SELF_PROFILE_STALE'; error.sendAttempted = false
      throw error
    }
    try { assertPrivateDisclosure(String(text || ''), profile) }
    catch (error) { error.sendAttempted = false; throw error }
    return true
  }

  markProfileDraftOutdated(id, error) {
    if (id === undefined || !['SELF_PROFILE_STALE', 'SHARED_MEMORY_STALE'].includes(error?.code)) return
    const drafts = (this.storage.get().pendingDrafts || []).map(draft => String(draft.id) === String(id)
      ? { ...draft, status: 'outdated', outdatedReason: error.message, outdatedCode: error.code } : draft)
    this.storage.update({ pendingDrafts: drafts }); this.emitEvent('drafts', { drafts })
  }

  // AI 输入框写入账本：只记录程序自己写进去的内容，用于区分"AI 残留"和"真人草稿"。
  aiOwnedEditorWrite(name) {
    const entry = this.aiOwnedEditorWrites?.get(name)
    if (!entry) return null
    if (Date.now() - (entry.writtenAt || 0) > AI_OWNED_EDITOR_WRITE_TTL_MS) {
      this.aiOwnedEditorWrites.delete(name)
      return null
    }
    return entry
  }

  markAiOwnedEditorWrite(name, { text = '', traceId = '' } = {}) {
    if (!this.aiOwnedEditorWrites) this.aiOwnedEditorWrites = new Map()
    this.aiOwnedEditorWrites.set(name, { text: String(text || ''), traceId: String(traceId || ''), writtenAt: Date.now() })
  }

  clearAiOwnedEditorWrite(name) { this.aiOwnedEditorWrites?.delete(name) }

  ownedResidualTexts(name) {
    const entry = this.aiOwnedEditorWrite(name)
    return entry?.text ? [entry.text] : []
  }

  // 真人草稿占用输入框时暂停该联系人的自动发送：只 hold 住触发它的那条消息，
  // 不按时间循环重试；用户手动发送或对方又发来新消息后自动恢复。
  isUserDraftBlocked(name, key) {
    const entry = this.userDraftBlocks?.get(name)
    if (!entry) return false
    if (entry.key !== key) { this.userDraftBlocks.delete(name); return false }
    return true
  }

  blockUserDraftContact(name, error = {}) {
    if (!this.userDraftBlocks) this.userDraftBlocks = new Map()
    const key = this.incomingQueueMap().get(name)?.key || ''
    const detail = { name, code: error.code || '', actualText: String(error.actualText || '').slice(0, 200) }
    const previous = this.userDraftBlocks.get(name)
    this.userDraftBlocks.set(name, { key, at: Date.now(), ...detail })
    if (previous?.key !== key) this.log('user_draft_present', `${name} 的输入框里有未发送的人工草稿，已暂停该联系人的自动发送（不重试）`, detail)
  }

  releaseUserDraftBlock(name) { this.userDraftBlocks?.delete(name) }

  async sendMessage(name, text, metadata = {}) {
    this.assertChatOperationActive?.()
    const coordinator = this.getChatWindowCoordinator?.()
    if (coordinator && !coordinator.current()) return coordinator.run('manual_send', () => this.sendMessage(name, text, metadata))
    // 用户自己动手发送即视为"重新触发"：解除该联系人的真人草稿阻塞
    if (metadata.ai !== true) this.releaseUserDraftBlock?.(name)
    let sendAttempted = false
    try {
      if (!name || !String(text).trim()) throw new Error('联系人和消息内容不能为空')
      this.assertAiSelfProfile(text, metadata)
      this.assertSharedMemoryMetadata(name, metadata)
      if (metadata.draftId !== undefined) {
        await this.confirmDraftFresh(metadata.draftId)
        const originalGuard = metadata.beforeSubmit
        metadata = { ...metadata, beforeSubmit: async (sourceWindow) => {
          await this.confirmDraftFresh(metadata.draftId, sourceWindow)
          await originalGuard?.()
        } }
      }
      if (metadata.ai === true) {
        const originalGuard = metadata.beforeSubmit
        metadata = { ...metadata, beforeSubmit: async sourceWindow => {
          this.assertAiSelfProfile(text, metadata)
          this.assertSharedMemoryMetadata(name, metadata)
          await originalGuard?.(sourceWindow)
          this.assertAiSelfProfile(text, metadata)
          this.assertSharedMemoryMetadata(name, metadata)
        } }
      }
      this.assertCanSend(name)
      // 回复频率节流：按联系人资料里配置的最小发送间隔限制（instant 不限）
      const freqContact = (this.storage.get().contacts || []).find((item) => item.name === name)
      const opening = metadata.source === 'video_opening_caption' && (this.storage.get().videoGreetings?.pending || []).find(item => item.id === metadata.videoOpeningId && item.name === name && item.videoSentAt && item.status === 'sending')
      const isVideoContinuation = Boolean(opening && normalizeEditorText(String(text)) === normalizeEditorText(opening.text))
      const expressionBatch = metadata.expressionBatchId && (this.storage.get().expressionBatches || []).find(batch => batch.id === metadata.expressionBatchId && batch.name === name)
      const isExpressionContinuation = Boolean(expressionBatch?.items?.some(item => item.status === 'sent') && expressionBatch.items.some(item => item.type === 'text' && item.status === 'sending' && normalizeEditorText(item.content) === normalizeEditorText(String(text))))
      const freqSeconds = isVideoContinuation || isExpressionContinuation ? 0 : REPLY_FREQUENCY_SECONDS[freqContact?.profile?.frequency] || 0
      if (freqSeconds > 0) {
        const lastAt = this.lastReplyTime.get(name) || 0
        const waitMs = freqSeconds * 1000 - (Date.now() - lastAt)
        if (waitMs > 0) throw new Error(`该联系人设置了回复间隔，请 ${Math.ceil(waitMs / 1000)} 秒后再发送`)
      }
      let value = String(text).trim()
      const win = await this.selectConversation(name)
      await this.waitForEditor(win)
      // Read the same normalized nickname used by conversation selection.
      await this.assertConversationTarget(win, name)
      // 若之前点击分享卡片打开过播放器弹层，先关闭，避免遮挡输入框/发送按钮。
      try {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        await executePageScript(win, `(() => {
          const closeBtn = [...document.querySelectorAll('[class*="close" i], [class*="Close" i], [aria-label*="关闭" i], [title*="关闭" i]')]
            .find((node) => { const r = node.getBoundingClientRect(); return r.width > 8 && r.height > 8 })
          if (closeBtn) closeBtn.click()
          return Boolean(closeBtn)
        })()`).catch(() => false)
        await sleep(200)
      } catch {}
      await this.assertConversationTarget(win, name)
      let wroteOwned = false
      try {
        // 第一刀：过期检查必须发生在写输入框之前——已经过期的回复根本不碰输入框
        if (metadata.beforeSubmit) await metadata.beforeSubmit(win)
        this.assertChatOperationActive?.()
        await this.assertConversationTarget(win, name)
        value = await writeMessageInput(win, value, {
          allowedDrafts: Array.isArray(metadata.allowedDrafts) ? metadata.allowedDrafts : [],
          ownedResiduals: this.ownedResidualTexts?.(name) || [],
          assertTarget: () => this.assertConversationTarget(win, name),
        })
        wroteOwned = true
        this.markAiOwnedEditorWrite?.(name, { text: value, traceId: metadata.traceId })
        await this.assertConversationTarget(win, name)
        // 第二刀：写入后再次检查，堵住"检查通过 → 写输入框 → 对方突然插话"的竞态
        if (metadata.beforeSubmit) await metadata.beforeSubmit(win)
        const submit = async () => {
          this.assertChatOperationActive?.()
          this.assertCanSend(name)
          sendAttempted = true
          await this.sendCurrentInput(win, { name, assertTarget: metadata.beforeSubmit ? async () => {
            await this.assertConversationTarget(win, name)
            await metadata.beforeSubmit?.(win)
          } : undefined })
          this.recordSuccessfulSend(name, 'text', metadata.expressionBatchId ? { expressionBatchId: metadata.expressionBatchId, stickerIntent: 'NONE' } : {})
        }
        if (this.runTextSubmission) await this.runTextSubmission(submit)
        else await submit()
        this.clearAiOwnedEditorWrite?.(name)
      } catch (error) {
        // 只清"程序自己写进去的"内容：真人草稿绝不触碰；清理失败不静默吞掉
        let cleared = true
        if (error.code === 'USER_DRAFT_PRESENT') cleared = true
        else if (wroteOwned) cleared = await clearMatchingInput(win, value, () => this.assertConversationTarget(win, name)).catch(() => null) === true
        else if (error.code === 'DRAFT_CLEAR_FAILED') cleared = false
        if (cleared) {
          this.clearAiOwnedEditorWrite?.(name)
        } else {
          // 清理失败必须留下可定位的日志：actualText/reason/retryCount 取自真实的清理结果，
          // 而不是抛出的 stale 错误——后者没有这些字段，会让日志恒为默认值而无法排查。
          let actualText = String(error?.actualText || '')
          if (!actualText && typeof readInput === 'function') {
            try { actualText = String((await readInput(win))?.text || '') } catch {}
          }
          this.log('draft_clear_failed', `${name} 的输入框清理失败，可能残留 AI 草稿`, {
            name, traceId: metadata.traceId || '', expectedText: String(value).slice(0, 200),
            actualText: actualText.slice(0, 200),
            reason: error.code === 'DRAFT_CLEAR_FAILED' ? 'uncleared' : 'editor_text_changed',
            retryCount: error.code === 'DRAFT_CLEAR_FAILED' ? (error?.retryCount || 0) : 0,
          })
        }
        throw error
      }
      const normalized = value.replace(/\s+/g, ' ').trim()
      this.lastSent.set(name, normalized)
      this.lastSeen.set(name, normalized)
      this.lastReplyTime.set(name, Date.now())
      const pairs = [...this.lastSent].map(([n, t]) => ({ name: n, text: t, at: Date.now() }))
      this.storage.update({ lastSentPairs: pairs })
      const outgoingMessageId = `m_${require('node:crypto').randomUUID()}`
      const learnedContact = this.recordConversationMessage(name, 'me', normalized, {}, { human: !metadata.ai, messageId: outgoingMessageId, confirmedSent: true })
      try { this.ai?.markSharedMemoryRecall?.({ contactId: learnedContact.id, sharedMemoryIds: metadata.sharedMemoryIds || [], outgoingMessageId, confirmedSent: true, text: normalized }) }
      catch (error) { this.log('shared_memory_recall_failed', '共同记忆回访记录失败，消息已发送', { code: error.code || 'SHARED_MEMORY_RECALL_FAILED' }) }
      if (!metadata.deferSharedMemoryExtraction && !metadata.expressionBatchId) this.queueCompletedSharedInteraction(learnedContact.id, name, 'confirmed_send')
      if (!metadata.ai && !metadata.expressionBatchId) this.recordExpressionTurn(name, { mode: 'TEXT_ONLY', stickerIntent: 'NONE' })
      this.log('message_sent', `Sent a message to ${name}`, { name, text: normalized, source: metadata.source || 'manual', ai: Boolean(metadata.ai), model: metadata.model || '', provider: metadata.provider || '', aiLabel: metadata.aiLabel || '' })
      return { ok: true }
    } catch (error) {
      this.markProfileDraftOutdated(metadata.draftId, error)
      if (error.sendAttempted === undefined) error.sendAttempted = sendAttempted
      throw error
    }
  }

  assertExpressionAllowed(name, { count = 1, continuation = false, usesSticker = true, automaticReply = false } = {}) {
    const state = this.storage.get()
    const contact = (state.contacts || []).find(item => item.name === name)
    if (!contact || this._destroyed || this.verificationActive || state.automation?.paused) throw new Error('自动表达发送已暂停或联系人不可用')
    if (automaticReply && !this.canReplyToAutomaticContact(state, contact)) throw new Error('联系人自动回复已关闭')
    if ((state.automation?.blacklist || []).includes(name) || (state.automation?.aiDisabledContacts || []).includes(name) || contact.profile?.aiEnabled === false) throw new Error('联系人 AI 已关闭或位于黑名单')
    if (usesSticker && state.settings?.favoriteStickerEnabled === false) throw new Error('收藏表情发送已关闭')
    if (quietNow(state.settings || {}, new Date()) || (state.settings?.quietHours && state.settings.quietStart === state.settings.quietEnd)) throw new Error('当前为免打扰时段')
    if (!continuation) {
      const frequency = REPLY_FREQUENCY_SECONDS[contact.profile?.frequency] || 0
      if (frequency && Date.now() - (this.lastReplyTime.get(name) || 0) < frequency * 1000) throw new Error('该联系人设置的回复间隔尚未到期')
    }
    this.assertCanSend(name, { count })
    return contact
  }

  persistExpressionBatch(batch) {
    const state = this.storage.get()
    const batches = [...(state.expressionBatches || [])]
    const index = batches.findIndex(item => item.id === batch.id)
    if (index >= 0 && batches[index].status === 'cancelled') batch.status = 'cancelled'
    if (index < 0) batches.push(structuredClone(batch))
    else batches[index] = structuredClone(batch)
    this.storage.update({ expressionBatches: batches })
    this.emitEvent('expression_batches', { batches })
  }

  recordExpressionTurn(name, expression, batchId) {
    const state = this.storage.get()
    if (batchId && (state.sendHistory || []).some(item => item.kind === 'expression_turn' && item.expressionBatchId === batchId)) return
    this.storage.update({ sendHistory: [...(state.sendHistory || []), { at: new Date().toISOString(), name, kind: 'expression_turn', quotaExcluded: true,
      expression: { mode: expression?.mode || 'TEXT_ONLY', stickerIntent: expression?.stickerIntent || 'NONE' }, expressionBatchId: batchId }].slice(-1000) })
  }

  async inspectFavoriteStickers(name, selectors = {}) {
    const win = await this.selectConversation(name)
    await this.assertConversationTarget(win, name)
    const identity = await this.withChatRead(() => executePageScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(name)}, ${JSON.stringify(boundConversationPlatformId(this.storage.get().contacts, name))})`), 'burst_recipient')
    if (!identity?.verified) return { ok: false, reason: 'contact_identity_unverified' }
    const expected = { name, platformUserId: identity.platformUserId }
    const run = operation => executePageScript(win, `(${favoriteStickerDom.toString()})(document,${JSON.stringify(operation)},${JSON.stringify({ ...STICKER_SELECTORS, ...selectors })},1,${JSON.stringify(expected)},${activeChatIdentity.toString()},null)`)
    for (const operation of ['toggle', 'favorites']) { const result = await run(operation); if (!result.ok) return result; await sleep(150) }
    return run('list') // List positions even while GIFs load; never clicks a sticker.
  }

  async sendExpression(name, expression, metadata = {}) {
    if (this.polling && !metadata.automaticReply) throw new Error('自动回复正在处理，请稍后批准表情草稿')
    const items = createExpressionBatch(name, expression, metadata.text ?? expression?.text ?? '', metadata)
    if (!items.items.length) return { ok: true, status: 'SUCCESS', skipped: true }
    this.assertAiSelfProfile(metadata.text ?? expression?.text ?? '', { ...metadata, ai: true })
    this.assertExpressionAllowed(name, { count: items.items.length, usesSticker: items.items.some(item => item.type === 'sticker'), automaticReply: metadata.automaticReply })
    if (this.expressionSending.has(name) || this.expressionPreparing.has(name)) throw new Error('该联系人的表达发送正在进行')
    this.expressionPreparing.add(name)
    try {
    await metadata.beforeSubmit?.()
    const win = await this.selectConversation(name)
    await this.assertConversationTarget(win, name)
    const identity = await this.withChatRead(() => executePageScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(name)}, ${JSON.stringify(boundConversationPlatformId(this.storage.get().contacts, name))})`), 'burst_recipient')
    if (!identity?.verified) throw new Error('无法核验表达发送对象身份')
    const contact = (this.storage.get().contacts || []).find(item => item.name === name)
    if (contact?.profile?.platformUserId && identity.platformUserId !== contact.profile.platformUserId) throw new Error('表达发送对象身份不匹配')
    items.sharedMemoryIds = metadata.sharedMemoryIds || []
    items.sharedMemoryRevision = metadata.sharedMemoryRevision
    items.platformUserId = identity.platformUserId
    items.contactId = contact?.id || name
    const messages = await this.readBoundIncomingMessages(name, win)
    items.latestIncomingMessageId = messages.filter(item => item.role === 'contact').at(-1)?.messageId || ''
    this.persistExpressionBatch(items)
    return await this.runExpressionBatch(items, { ...metadata, window: win })
    } finally { this.expressionPreparing.delete(name) }
  }

  async runExpressionBatch(batch, metadata = {}) {
    // A persisted batch keeps its own generation revision across resume. A
    // caller cannot approve old content by supplying the latest revision.
    metadata = { ...metadata, ai: true, ...(batch.sharedMemoryIds ? { sharedMemoryIds: batch.sharedMemoryIds, sharedMemoryRevision: batch.sharedMemoryRevision } : {}), ...(batch.selfProfileRevision !== undefined ? { selfProfileRevision: batch.selfProfileRevision } : {}) }
    if (this.polling && !metadata.automaticReply) throw new Error('自动回复正在处理，请稍后继续表达任务')
    if (this.expressionSending.has(batch.name)) throw new Error('该联系人的表达发送正在进行')
    if (batch.status === 'unknown' || batch.items.some(item => ['sending', 'unknown'].includes(item.status))) return { ok: false, status: 'UNKNOWN', batchId: batch.id, batch }
    if (['stale', 'cancelled'].includes(batch.status)) return { ok: false, status: 'FAILED', batchId: batch.id, batch }
    this.expressionSending.add(batch.name)
    try {
      const win = metadata.window || await this.selectConversation(batch.name)
      const guard = async () => {
        this.assertSharedMemoryMetadata(batch.name, metadata)
        this.assertAiSelfProfile(batch.items.filter(item => item.type === 'text' && item.status !== 'sent').map(item => item.content).join('\n'), metadata)
        const currentBatch = (this.storage.get().expressionBatches || []).find(item => item.id === batch.id)
        if (!currentBatch || ['cancelled', 'stale', 'unknown'].includes(currentBatch.status)) throw this.staleBurstError('表达任务已取消或暂停')
        const continuation = batch.items.some(item => item.status === 'sent')
        const contact = this.assertExpressionAllowed(batch.name, { continuation, usesSticker: batch.items.some(item => item.type === 'sticker'), automaticReply: metadata.automaticReply })
        if (String(contact.id || batch.name) !== String(batch.contactId)) throw this.staleBurstError('表达任务的联系人已变化')
        await this.assertConversationTarget(win, batch.name)
        const identity = await executePageScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(batch.name)}, ${JSON.stringify(batch.platformUserId || boundConversationPlatformId(this.storage.get().contacts, batch.name))})`)
        if (!identity?.verified || identity.platformUserId !== batch.platformUserId) throw this.staleBurstError('表达任务的聊天对象已变化')
        await metadata.beforeSubmit?.(win)
        const messages = await this.readBoundIncomingMessages(batch.name, win)
        const latest = messages.filter(item => item.role === 'contact').at(-1)?.messageId || ''
        if (latest !== batch.latestIncomingMessageId) throw this.staleBurstError('已有新入站消息，剩余表达作废')
        this.assertAiSelfProfile(batch.items.filter(item => item.type === 'text' && item.status !== 'sent').map(item => item.content).join('\n'), metadata)
      }
      const result = await executeExpressionBatch(batch, {
        persist: value => this.persistExpressionBatch(value), beforeItem: guard,
        sendText: async item => {
          this._burstExpectedOutgoing = { contactId: batch.contactId, text: item.content,
            expressions: [...(this._burstExpectedOutgoing?.contactId === batch.contactId ? this._burstExpectedOutgoing.expressions || [] : []), { text: item.content }] }
          const sent = await this.sendMessage(batch.name, item.content, { ...metadata, ai: true, source: 'ai_expression', expressionBatchId: batch.id, draftId: undefined, beforeSubmit: guard })
          return { status: sent?.ok === true ? 'SUCCESS' : 'UNKNOWN' }
        },
        sendSticker: async item => {
          const sent = await sendFavoriteSticker({ win, name: batch.name, intent: item.intent, expectedPlatformUserId: batch.platformUserId,
            selectors: metadata.stickerSelectors || this.storage.get().settings?.favoriteStickerSelectors || {}, assertTarget: () => this.assertConversationTarget(win, batch.name), beforeSubmit: guard,
            onTargetSelected: target => { this._burstExpectedOutgoing = { contactId: batch.contactId,
              expressions: [...(this._burstExpectedOutgoing?.contactId === batch.contactId ? this._burstExpectedOutgoing.expressions || [] : []), { src: target.src }] } } })
          if (sent.status === 'SUCCESS') {
            this.recordSuccessfulSend(batch.name, 'sticker', { expressionBatchId: batch.id, stickerIntent: item.intent })
            this.recordConversationMessage(batch.name, 'me', `[表情：${item.intent}]`, {}, { human: false, type: 'sticker', mediaKind: 'sticker', confirmedSent: true })
            this.lastReplyTime.set(batch.name, Date.now())
            this.lastSent.set(batch.name, `[表情：${item.intent}]`)
          }
          return sent
        },
      })
      if (batch.status === 'cancelled') { result.ok = false; result.status = 'FAILED' }
      if (result.ok) this.recordExpressionTurn(batch.name, batch.expression, batch.id)
      this.queueCompletedSharedInteraction(batch.contactId, batch.name, 'expression_complete', batch.burstId || '')
      if (batch.draftId !== undefined) {
        const drafts = this.storage.get().pendingDrafts || []
        this.storage.update({ pendingDrafts: result.ok ? drafts.filter(item => String(item.id) !== String(batch.draftId)) : drafts.map(item => String(item.id) === String(batch.draftId)
          ? { ...item, expressionBatchId: batch.id, expressionSendStatus: result.status, ...(batch.status === 'stale' ? { status: 'outdated', outdatedReason: batch.reason } : {}) } : item) })
      }
      return { ...result, batchId: batch.id }
    } finally { this.expressionSending.delete(batch.name) }
  }

  async resumeExpressionBatch(id, metadata = {}) {
    const batch = (this.storage.get().expressionBatches || []).find(item => String(item.id) === String(id))
    if (!batch) throw new Error('表达发送任务不存在')
    if (this.expressionPreparing.has(batch.name)) throw new Error('该联系人的表达发送正在进行')
    return this.runExpressionBatch(batch, metadata)
  }

  async approveExpressionDraft(id, editedText, metadata = {}) {
    const draft = (this.storage.get().pendingDrafts || []).find(item => String(item.id) === String(id))
    if (!draft) throw new Error('表达草稿不存在')
    metadata = { ...metadata, ai: true, selfProfileRevision: draft.selfProfileRevision, sharedMemoryIds: draft.sharedMemoryIds || draft.strategy?.sharedMemoryIds || [], sharedMemoryRevision: draft.sharedMemoryRevision ?? draft.strategy?.sharedMemoryRevision }
    try { this.assertAiSelfProfile(editedText ?? draft.text, metadata) }
    catch (error) { this.markProfileDraftOutdated(id, error); throw error }
    if (draft.expressionBatchId) return this.resumeExpressionBatch(draft.expressionBatchId, metadata)
    await this.confirmDraftFresh(id)
    return this.sendExpression(draft.name, draft.expression, { ...metadata, draftId: draft.id, text: editedText ?? draft.text,
      burstId: draft.burstId, conversationRevision: draft.conversationRevision, bufferEpoch: draft.bufferEpoch,
      beforeSubmit: async win => { await this.confirmDraftFresh(id, win); await metadata.beforeSubmit?.(win) } })
  }

  updateAutomation(config) {
    const current = this.storage.get()
    this.storage.update({ automation: { ...current.automation, ...config } })
    this.startWorker()
    return { ok: true }
  }

  getSendAllowance(name, now = Date.now(), count = 1) {
    const state = this.storage.get()
    const config = state.automation || {}
    const dailyLimit = Math.max(1, Math.floor(Number(config.dailyLimit ?? 30) || 30))
    const today = localDateKey(now)
    const history = (Array.isArray(state.sendHistory) ? state.sendHistory : []).filter(entry => entry.quotaExcluded !== true)
    const sentToday = history.filter((entry) => entry.at && localDateKey(entry.at) === today).length
    const required = Math.max(1, Math.floor(Number(count) || 1))
    if (sentToday >= dailyLimit) {
      return { ok: false, reason: `今天已发送 ${sentToday} 条，达到每日上限 ${dailyLimit} 条`, sentToday, dailyLimit }
    }
    if (sentToday + required > dailyLimit) return { ok: false, reason: `剩余每日额度不足以发送 ${required} 条消息`, sentToday, dailyLimit }
    // 单联系人限额由用户开关控制；关闭时仍遵守每日总上限。
    if (config.maxPerContactDailyEnabled === true) {
      const perContactLimit = Math.max(1, Math.floor(Number(config.maxPerContactDaily) || 10))
      const sentToContact = history.filter((entry) => entry.at && entry.name === name && localDateKey(entry.at) === today).length
      if (sentToContact >= perContactLimit) {
        return { ok: false, reason: `今天已向该联系人发送 ${sentToContact} 条，达到单联系人上限 ${perContactLimit} 条`, sentToday, dailyLimit }
      }
      if (sentToContact + required > perContactLimit) return { ok: false, reason: `该联系人剩余额度不足以发送 ${required} 条消息`, sentToday, dailyLimit }
    }

    return { ok: true, sentToday, dailyLimit }
  }

  hasSentConversationToday(name, now = Date.now()) {
    const target = String(name || '').trim()
    if (!target) return false
    const today = localDateKey(now)
    return (this.storage.get().sendHistory || []).some((entry) => (
      entry.quotaExcluded !== true && String(entry?.name || '').trim() === target && entry?.at && localDateKey(entry.at) === today
    ))
  }

  assertCanSend(name, { count = 1 } = {}) {
    const allowance = this.getSendAllowance(name, Date.now(), count)
    if (!allowance.ok) throw new Error(allowance.reason)
    return allowance
  }

  recordSuccessfulSend(name, kind, details = {}) {
    const now = new Date()
    const cutoff = now.getTime() - (8 * 24 * 60 * 60 * 1000)
    const state = this.storage.get()
    const sendHistory = [...(state.sendHistory || []), { at: now.toISOString(), name, kind, ...details }]
      .filter((entry) => new Date(entry.at).getTime() >= cutoff)
      .slice(-1000)
    this.storage.update({ sendHistory })
  }

  startWorker() {
    if (this.pollTimer) return
    if (!this._conversationSyncStarted) { this._conversationSyncStarted = true; this.requestConversationSync({ reason: 'startup' }) }
    const scheduleNext = () => {
      const refreshSeconds = Number(this.storage.get().settings?.refreshInterval || 5)
      const base = Math.max(5000, Math.min(300000, refreshSeconds * 1000))
      // 风控软化：固定节拍是机器人特征。空闲越久轮询越慢（5 分钟内 1×，30 分钟内 2×，
      // 更久 3×），并叠加 ±20% 抖动；任何新消息都会把 lastActivityAt 拉回当前、节奏自动变快。
      const idleMs = Date.now() - (this.lastActivityAt || Date.now())
      const delay = computePollDelay(base, idleMs)
      this.pollTimer = setTimeout(async () => {
        try {
          await this.runAutomation()
        } catch (error) {
          if (error?.code !== 'AUTOMATION_ROUND_TIMEOUT') {
            this.log('worker_error', error ? error.message : String(error))
          }
        } finally {
          if (this.pollTimer && !this._destroyed) scheduleNext()
        }
      }, delay || AUTOMATION_POLL_MS)
    }
    scheduleNext()
    this.startMemoryHygiene()
  }

  // 轮次状态持久化：把对话引擎的 turn 状态写回联系人记录
  persistTurn(name, patcher) {
    try {
      const state = this.storage.get()
      const contacts = [...(state.contacts || [])]
      const index = contacts.findIndex((contact) => contact.name === name)
      if (index < 0) return
      const contact = contacts[index]
      contacts[index] = { ...contact, turn: patcher({ ...(contact.turn || {}) }) }
      this.storage.update({ contacts })
    } catch { /* turn 持久化失败不阻塞主流程 */ }
  }

  // ==================== 消息队列：收集 → 规划 → 执行 ====================
  // 旧版是"轮询即处理"：一轮里遍历联系人、边发现边回；处理期间来的新消息只能靠
  // auto_recheck"下轮重查"补，去重状态散在 lastSeen / turn / lastSent / lastSkipNotice
  // 四处，既看不到积压、也保证不了顺序，同一个人连发多条时容易出现"只回最后一条"。
  // 现在改成显式队列，三段式：
  //   ① 收集：轮询只负责发现新消息并入队，不做任何回复动作；
  //   ② 规划：出队前统一判定，结果只有 reply / hold / defer / skip 四种；
  //   ③ 执行：严格串行，同一时刻只有一个 AI 调用和一次发送。
  // 队列按联系人聚合（同一联系人只留最新一条，连发自动合并成一批）。未消费的消息
  // 不推进 lastSeen，重启后会被重新发现并入队——等价于"队列不丢"。
  incomingQueueMap() {
    if (!(this.incomingQueue instanceof Map)) this.incomingQueue = new Map()
    return this.incomingQueue
  }

  incomingBurstEnabled() { return this.storage.get().settings?.incomingBurstEnabled !== false }

  burstContactId(name) {
    return String((this.storage.get().contacts || []).find(contact => contact.name === name)?.id || name)
  }

  ensureIncomingBuffer() {
    const settings = this.storage.get().settings || {}
    const config = { quietWindowMs: Math.max(0, Number(settings.incomingBurstQuietWindowMs ?? 4000)),
      maxBurstWindowMs: Math.max(0, Number(settings.incomingBurstMaxWindowMs ?? 15000)) }
    const configKey = JSON.stringify(config)
    if (this.incomingBuffer && (!this.incomingBufferSettings || this.incomingBufferSettings === configKey)) return this.incomingBuffer
    const retainedIds = new Set([...(this.burstObservedIds?.keys() || []),
      ...[...this.incomingQueueMap().values()].map(item => this.burstContactId(item.name))])
    const retained = this.incomingBuffer ? [...retainedIds].map(id => ({
      id, snapshot: this.incomingBuffer.snapshot(id), seen: [...(this.burstObservedIds.get(id) || [])],
    })) : []
    this.incomingBuffer?.dispose()
    this.bufferEpoch = require('node:crypto').randomUUID()
    this.burstObservedIds ||= new Map()
    this.incomingBufferSettings = configKey
    this.incomingBuffer = new ConversationBuffer({ namespace: this.partition,
      ...config,
      onReady: () => {
        if (!this._destroyed && !this.polling && !this.storage.get().automation?.paused) {
          Promise.resolve(this.runAutomation()).catch(error => this.log('burst_worker_error', error.message))
        }
      },
      onStale: (lease, snapshot) => this.markBurstDraftsOutdated(snapshot.contactId, snapshot.conversationRevision),
    })
    for (const { id, snapshot, seen } of retained) {
      const pendingIds = new Set(snapshot.messages.map(message => message.messageId || message.id))
      this.incomingBuffer.hydrate(id, { messages: snapshot.messages,
        processedMessageIds: seen.filter(messageId => !pendingIds.has(messageId)), conversationRevision: snapshot.conversationRevision })
      this.markBurstDraftsOutdated(id, this.incomingBuffer.snapshot(id).conversationRevision,
        { force: true, reason: '消息聚合设置已变化，请重新生成草稿' })
    }
    return this.incomingBuffer
  }

  staleBurstError(reason = '对方又发来了消息，旧回复已作废') {
    const error = new Error(reason)
    error.code = 'BURST_STALE'
    error.stale = true
    return error
  }

  markBurstDraftsOutdated(contactId, revision, { force = false, reason = '对方有新消息，需要重新生成' } = {}) {
    let changed = false
    const drafts = (this.storage.get().pendingDrafts || []).map(draft => {
      if (draft.source === 'event_followup' || draft.eventId || draft.source === 'video_opening' || draft.videoOpeningId) return draft
      if (draft.status !== 'pending' || String(draft.contactId || this.burstContactId(draft.name)) !== String(contactId)) return draft
      if (!force && draft.conversationRevision === revision && draft.bufferEpoch === this.bufferEpoch) return draft
      changed = true
      return { ...draft, status: 'outdated', outdatedReason: reason, outdatedAt: new Date().toISOString(),
        outdatedMessageCount: Math.max(0, revision - (draft.conversationRevision || 0)) }
    })
    if (changed) { this.storage.update({ pendingDrafts: drafts }); this.emitEvent('drafts', { drafts }) }
  }

  // Read only the already selected chat. Both identity checks surround the DOM read;
  // a watcher never changes the active contact or consumes an outgoing bubble.
  async readBoundIncomingMessages(name, win) {
    if (!win || win.isDestroyed?.()) throw this.staleBurstError('聊天窗口已关闭')
    await this.assertConversationTarget(win, name)
    const contact = (this.storage.get().contacts || []).find(item => item.name === name)
    if (contact?.profile?.platformUserId) {
      const identity = await this.withChatRead(() => executePageScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(name)}, ${JSON.stringify(boundConversationPlatformId(this.storage.get().contacts, name))})`), 'burst_recipient')
      if (!identity?.verified || identity.platformUserId !== contact.profile.platformUserId) throw this.staleBurstError('当前聊天对象已变化')
    }
    const messages = await this.captureVisibleMessages(win, { strict: true })
    await this.assertConversationTarget(win, name)
    if (contact?.profile?.platformUserId) {
      const identity = await this.withChatRead(() => executePageScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(name)}, ${JSON.stringify(boundConversationPlatformId(this.storage.get().contacts, name))})`), 'burst_recipient')
      if (!identity?.verified || identity.platformUserId !== contact.profile.platformUserId) throw this.staleBurstError('读取消息期间聊天对象已变化')
    }
    return messages
  }

  async observeIncomingBurst(name, win, { initial = false } = {}) {
    const buffer = this.ensureIncomingBuffer()
    const contactId = this.burstContactId(name)
    const messages = await this.readBoundIncomingMessages(name, win)
    this.recordObservedChatPreview(name, messages.at(-1))
    let seen = this.burstObservedIds.get(contactId)
    if (!seen) {
      seen = new Set()
      this.burstObservedIds.set(contactId, seen)
      const contact = (this.storage.get().contacts || []).find(item => item.name === name)
      for (const message of contact?.learning?.messages || []) if (message.messageId || message.id) seen.add(message.messageId || message.id)
      // On first discovery capture the consecutive incoming tail, not every old bubble.
      const lastMe = messages.findLastIndex(message => message.role === 'me')
      if (initial) for (const message of messages.slice(0, lastMe + 1)) seen.add(message.messageId || message.id)
      else for (const message of messages) seen.add(message.messageId || message.id)
    }
    for (const message of messages) {
      const id = message.messageId || message.id
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (message.role !== 'contact') {
        const expected = this._burstExpectedOutgoing
        const knownExpression = expected?.contactId === contactId && (expected.expressions || []).some(entry =>
          (entry.text && normalizeEditorText(message.text) === normalizeEditorText(entry.text))
          || (entry.src && (message.mediaEvidence?.urls || []).includes(entry.src)))
        // 本轮已发出的多个气泡都算"自己人"：同一轮生成的多条回复不会互相把对方
        // 当成对方插话而作废（第二条、第三条气泡仍可独立发送）。
        const knownOwnText = expected?.contactId === contactId && (
          (expected.text && normalizeEditorText(message.text) === normalizeEditorText(expected.text))
          || (expected.texts || []).some(text => normalizeEditorText(text) === normalizeEditorText(message.text)))
        if (message.role === 'me' && !knownOwnText && !knownExpression) {
          buffer.invalidate(contactId)
          this.markBurstDraftsOutdated(contactId, buffer.snapshot(contactId).conversationRevision,
            { force: true, reason: '本人已在聊天中回复，旧草稿需要重新检查' })
        }
        continue
      }
      const snapshot = buffer.append(contactId, { ...message, receivedAt: Date.now() })
      const current = this.incomingQueueMap().get(name)
      this.enqueueIncoming({ ...current, name, key: `burst:${id}`, preview: message.text || current?.preview || '',
        incomingIdentity: { role: 'contact', fingerprint: id, messageId: id, message }, incomingMessages: [message],
        enqueuedAt: current?.enqueuedAt || Date.now(), attempts: 0 })
      this.markBurstDraftsOutdated(contactId, snapshot.conversationRevision)
    }
    return { messages, snapshot: buffer.snapshot(contactId) }
  }

  recordObservedChatPreview(name, message) {
    if (!message?.messageId || !['contact', 'me'].includes(message.role)) return
    const state = this.storage.get(), contacts = state.contacts || []
    const matches = contacts.filter(contact => contact.name === name)
    const contact = matches.length === 1 ? matches[0] : null
    const platformUserId = contact?.profile?.platformUserId
    // This is called only after readBoundIncomingMessages has verified this ID
    // on both sides of the DOM read; name-only legacy chats do not publish it.
    if (!platformUserId) return
    const baseListMessageKey = contactMessageKey(contact)
    const previous = contact.observedChatPreview
    // A newer platform list key invalidates the old pane observation. Do not
    // simply rebind the same cached bubble to that newer list notification.
    if (previous?.messageId === message.messageId && previous.baseListMessageKey !== baseListMessageKey) return
    if (previous?.messageId === message.messageId && previous.baseListMessageKey === baseListMessageKey && previous.role === message.role && previous.text === message.text) return
    const observedChatPreview = { source: 'verified_chat_dom', messageId: message.messageId, text: String(message.text || '').slice(0, 500),
      type: message.type || 'text', mediaKind: message.mediaKind || '', role: message.role, platformUserId,
      observedAt: new Date().toISOString(), baseListMessageKey }
    const updated = contacts.map(row => row.id === contact.id ? { ...row, observedChatPreview } : row)
    this.storage.update({ contacts: updated }); this.emitEvent('contacts', { contacts: updated })
  }

  async observeSelectedConversation(contacts) {
    if (!this.incomingBurstEnabled()) return
    const win = this.window
    if (!win || win.isDestroyed?.()) return
    const identity = await safeExecuteJavaScript(win, conversationIdentityScript(''), 1500, null)
    this.assertChatOperationActive()
    const names = identity?.headerNames || []
    if (identity?.ambiguous || names.length !== 1 || identity.activeName && identity.activeName !== names[0]) return
    const matches = contacts.filter(contact => contact.name === names[0])
    if (matches.length !== 1) return
    const contact = matches[0], state = this.storage.get(), config = state.automation || {}
    if (!this.canReplyToAutomaticContact(state, contact) || contact.profile?.aiEnabled === false
      || (config.blacklist || []).includes(contact.name) || (config.aiDisabledContacts || []).includes(contact.name)) return
    this.setAutomationStage(`observe_selected:${contact.name}`)
    const messages = await this.readBoundIncomingMessages(contact.name, win)
    this.recordObservedChatPreview(contact.name, messages.at(-1))
    const learnedIds = new Set((contact.learning?.messages || []).map(message => message.messageId || message.id).filter(Boolean))
    // A known history anchor allows discovery of a new tail even if Douyin's
    // list still displays the preceding sticker. Without one, establish a DOM
    // baseline first so opening an old conversation cannot trigger old replies.
    const hasKnownAnchor = messages.some(message => learnedIds.has(message.messageId || message.id))
    await this.observeIncomingBurst(contact.name, win, { initial: hasKnownAnchor })
  }

  startBurstObserver(name, win) {
    let stopped = false
    let running = null
    const observer = { failure: null, tick: async () => {
      if (stopped) return
      if (running) return running
      running = this.observeIncomingBurst(name, win).catch(error => {
        observer.failure = error.code === 'BURST_STALE' ? error : this.staleBurstError(error.message)
        stopped = true
        clearInterval(timer)
      }).finally(() => { running = null })
      return running
    }, stop: async () => { stopped = true; clearInterval(timer); await running } }
    const timer = setInterval(() => { void observer.tick() }, 500)
    timer.unref?.()
    return observer
  }

  async assertBurstFresh(item) {
    await this.assertBackgroundChatTarget(item.name)
    const lease = item?._burstLease
    if (!lease) return true
    await item._burstObserver?.tick()
    if (item._burstObserver?.failure) throw item._burstObserver.failure
    const state = this.storage.get()
    const contact = (state.contacts || []).find(entry => entry.name === item.name)
    if (this._destroyed || state.automation?.paused || !this.incomingBurstEnabled() || this.partition !== lease.namespace || !this.ensureIncomingBuffer().isFresh(lease)) {
      throw this.staleBurstError()
    }
    if (!contact || String(contact.id || contact.name) !== lease.contactId
      || (state.automation?.blacklist || []).includes(item.name)
      || (state.automation?.aiDisabledContacts || []).includes(item.name) || contact.profile?.aiEnabled === false
      || !this.canReplyToAutomaticContact(state, contact) || quietNow(state.settings || {}, new Date())) {
      throw this.staleBurstError('联系人或自动回复设置已变化，旧回复已作废')
    }
    return true
  }

  async confirmDraftFresh(id, sourceWindow) {
    const draft = (this.storage.get().pendingDrafts || []).find(item => String(item.id) === String(id))
    if (!draft || draft.status !== 'pending') throw this.staleBurstError('这份草稿已过期或已处理')
    if (!draft.burstId) {
      if (!this.incomingBurstEnabled() || draft.eventId || draft.type === 'event_followup' || draft.source === 'event_followup') return draft
      const drafts = (this.storage.get().pendingDrafts || []).map(item => item.id === draft.id
        ? { ...item, status: 'outdated', outdatedReason: '这份草稿缺少消息版本，请重新生成' } : item)
      this.storage.update({ pendingDrafts: drafts }); this.emitEvent('drafts', { drafts })
      throw this.staleBurstError('这份草稿缺少消息版本，请重新生成')
    }
    const win = sourceWindow || await this.selectConversation(draft.name)
    await this.observeIncomingBurst(draft.name, win)
    const snapshot = this.ensureIncomingBuffer().snapshot(this.burstContactId(draft.name))
    const currentDraft = (this.storage.get().pendingDrafts || []).find(item => String(item.id) === String(id))
    if (this._destroyed || this.storage.get().automation?.paused || currentDraft?.status !== 'pending' || draft.bufferEpoch !== this.bufferEpoch || snapshot.conversationRevision !== draft.conversationRevision) {
      this.markBurstDraftsOutdated(this.burstContactId(draft.name), snapshot.conversationRevision)
      throw this.staleBurstError('草稿生成后已有新消息，请刷新草稿')
    }
    return draft
  }

  // 入队：同一联系人只保留最新一条待处理消息，连发合并成一批（回复仍针对最新预览，
  // 更早的内容照样随 learning.messages 进入上下文）。
  // 注意：未消费的消息每轮都会被"重新发现"（lastSeen 未推进），同 key 重复入队只刷新
  // 元数据、不算新消息也不记日志——否则延后中的消息会每轮刷一条 queue_merged。
  enqueueIncoming(item) {
    this.assertChatOperationActive()
    if (!item?.name) return null
    if (this.incomingBurstEnabled()) {
      const buffer = this.ensureIncomingBuffer()
      const messages = item.incomingMessages || [item.incomingIdentity?.message ? {
        ...item.incomingIdentity.message, role: item.incomingIdentity.role,
        messageId: item.incomingIdentity.messageId || item.incomingIdentity.fingerprint,
      } : { role: 'contact', text: item.preview || '', messageId: item.key, previewOnly: true }]
      for (const message of messages) {
        if (message.role === 'me') continue
        const snapshot = buffer.append(this.burstContactId(item.name), message)
        this.markBurstDraftsOutdated(snapshot.contactId, snapshot.conversationRevision)
      }
    }
    const queue = this.incomingQueueMap()
    const previous = queue.get(item.name)
    if (previous && previous.key === item.key) {
      const refreshed = {
        ...previous,
        preview: item.preview,
        unread: item.unread,
        incomingIdentity: item.incomingIdentity || previous.incomingIdentity,
        receivedAt: item.receivedAt || previous.receivedAt,
      }
      queue.set(item.name, refreshed)
      return refreshed
    }
    const merged = previous
      ? { ...item, mergedCount: (previous.mergedCount || 1) + 1, enqueuedAt: previous.enqueuedAt || item.enqueuedAt }
      : { ...item, mergedCount: 1 }
    queue.set(item.name, merged)
    if (previous) {
      // 日志节流：媒体预览的指纹键会随轮询抖动（同一张图集每轮指纹略有差异），
      // 不节流会变成"每轮一条 queue_merged"。同一联系人 10 分钟最多记一条。
      const noticeKey = `queue_merged:${item.name}`
      if (Date.now() - (this.lastSkipNotice.get(noticeKey) || 0) >= 10 * 60 * 1000) {
        this.lastSkipNotice.set(noticeKey, Date.now())
        this.log('queue_merged', `${item.name} 又发来新消息，与待处理消息合并为一轮`, { name: item.name, merged: merged.mergedCount, queueSize: queue.size })
      }
    } else {
      this.log('queue_enqueued', `新消息入队：${item.name}`, { name: item.name, mediaKind: item.mediaKind || '', queueSize: queue.size })
    }
    return merged
  }

  // ② 规划：出队前统一判定（只做不需要读页面的便宜判断，页面级守卫在执行阶段）
  // 返回 [{ item, action, reason }]，action：reply 该回 / hold 暂留（限额） / defer 等条件成熟
  planIncomingQueue({ canSend }) {
    const queue = this.incomingQueueMap()
    const plans = []
    for (const item of [...queue.values()].sort((a, b) => (a.enqueuedAt || 0) - (b.enqueuedAt || 0))) {
      const currentState = this.storage.get()
      const currentContact = (currentState.contacts || []).find(contact => contact.name === item.name)
      const binding = currentContact?.id && this.getConversationSyncManager().getRecord(currentContact.id)
      if (binding && !this.getConversationSyncManager().canAttempt(currentContact.id) && !allowsLegacyConversationName(currentContact, binding)) {
        plans.push({ item, action: 'defer', reason: 'conversation_sync_backoff' }); continue
      }
      if (currentContact?.profile?.autoFriendship === true && !this.canReplyToAutomaticContact(currentState, currentContact)) {
        plans.push({ item, action: 'hold', reason: 'auto_friendship_disabled' })
        continue
      }
      if (item.deferUntil && Date.now() < item.deferUntil) {
        plans.push({ item, action: 'defer', reason: 'wait_until' })
        continue
      }
      // 真人草稿占用输入框：hold 住触发它的那条消息，不按时间循环重试；
      // 用户手动发送或对方又发来新消息（key 变化）后自动恢复。
      if (this.isUserDraftBlocked?.(item.name, item.key)) {
        plans.push({ item, action: 'hold', reason: 'user_draft_present' })
        continue
      }
      // 每日发送上限：保留消息，限额重置后补回（与旧版一致，不消费）
      if (!canSend(item.name)) {
        const noticeKey = `${item.name}:${localDateKey()}`
        if (!this.lastLimitNotice.has(noticeKey)) {
          this.lastLimitNotice.set(noticeKey, Date.now())
          this.log('send_blocked', `已达到每日发送上限，暂不回复 ${item.name}`, { name: item.name })
        }
        plans.push({ item, action: 'hold', reason: 'daily_limit' })
        continue
      }
      if (this.incomingBurstEnabled()) {
        const buffer = this.ensureIncomingBuffer()
        if (currentState.automation?.paused) buffer.pause()
        else if (buffer.paused) buffer.resume()
        if (!buffer.snapshot(this.burstContactId(item.name)).ready) {
          plans.push({ item, action: 'defer', reason: 'waiting_for_incoming_burst' })
          continue
        }
      }
      plans.push({ item, action: 'reply', reason: '' })
    }
    return plans
  }

  // 消费：推进 lastSeen 与轮次状态并出队（这条消息闭环）
  markIncomingConsumed(item) {
    this.assertChatOperationActive()
    if (item?._burstLease && !this.ensureIncomingBuffer().isFresh(item._burstLease)) return false
    const queued = this.incomingQueueMap().get(item.name)
    if (queued && queued.key !== item.key) return false
    this.lastSeen.set(item.name, item.key)
    this.persistTurn(item.name, (turn) => ({ ...turn, lastHandledKey: item.key }))
    this.incomingQueueMap().delete(item.name)
    this.fromMeDeferCount?.delete(item.name)
    if (item?._burstLease) this.ensureIncomingBuffer().finish(item._burstLease)
    return true
  }

  canReplyToAutomaticContact(state, contact) {
    if (isAutoFriendshipContact(contact)) return autoFriendshipReplyEnabled(state, contact)
    return Boolean(state.automation?.autoReply) && !state.automation?.paused
  }

  assertAutoFriendshipReply(name, expectedContact, session, requireReplied = false) {
    const state = this.storage.get()
    const contact = (state.contacts || []).find(item => item.name === name)
    const config = state.automation || {}
    let reason = ''
    if (this._destroyed || !contact || !autoFriendshipReplyEnabled(state, contact)) reason = '自动交友已关闭或此联系人已暂停自动聊天'
    else if (contact.id !== expectedContact.id || contact.profile?.autoFriendshipUrl !== expectedContact.profile?.autoFriendshipUrl) reason = '联系人资料已变化'
    else if (contact.profile?.contactPipeline === true && (!this.contactEngine || this.contactEngine.destroyed)) reason = '联系队列服务已停止'
    else if (session !== undefined && (contact.profile?.contactPipeline === true ? this.contactEngine?.session : this.friendshipAutomatic?.session) !== session) reason = '自动交友设置已变化'
    else if (requireReplied && contact.profile?.contactPipeline === true && !(state.discovery?.candidates || []).some(candidate => candidate.id === contact.profile.candidateId && ['REPLIED', 'CONTACT'].includes(candidate.status))) reason = '尚未核验对方首次回复，不发送后续消息'
    else if (this.verificationActive) reason = '抖音安全验证期间停止自动聊天'
    else if ((config.blacklist || []).includes(name)) reason = '联系人位于黑名单'
    else if ((config.aiDisabledContacts || []).includes(name) || contact.profile?.aiEnabled === false) reason = '联系人 AI 回复已关闭'
    else if (quietNow(state.settings || {}, new Date()) || (state.settings?.quietHours && (state.settings.quietStart || '23:00') === (state.settings.quietEnd || '07:00'))) reason = '当前为免打扰时段'
    else {
      const allowance = this.getSendAllowance(name)
      if (!allowance.ok) reason = allowance.reason
      const frequency = REPLY_FREQUENCY_SECONDS[contact.profile?.frequency] || 0
      if (!reason && frequency && Date.now() - (this.lastReplyTime.get(name) || 0) < frequency * 1000) reason = '该联系人设置的回复间隔尚未到期'
    }
    if (reason) {
      const error = new Error(reason)
      error.stopped = true
      throw error
    }
    return contact
  }

  async verifyContactPipelineIdentity(contact, select = false) {
    if (select) await this.selectConversation(contact.name)
    await this.assertBackgroundChatTarget(contact.name)
    const win = this.window
    if (!win || win.isDestroyed()) throw new Error('聊天窗口尚未准备好，无法核验对方身份')
    const result = await executePageScript(win, `(${activeChatIdentity.toString()})(${JSON.stringify(contact.name)}, ${JSON.stringify(conversationPlatformId(contact))})`)
    if (!result?.verified || result.platformUserId !== contact.profile?.platformUserId) throw new Error('聊天面板用户 ID 与候选不一致，已停止接聊')
    return result.platformUserId
  }

  suspendAutoFriendshipReply(name, error) {
    const state = this.storage.get()
    this.storage.update({ contacts: (state.contacts || []).map(contact => contact.name === name ? {
      ...contact, profile: { ...contact.profile, autoFriendshipSuspended: true, autoFriendshipSuspendedAt: new Date().toISOString(), autoFriendshipSuspendReason: error.message },
    } : contact) })
    this.log('auto_friendship_reply_uncertain', `${name} 的消息发送结果不明确，已暂停自动接聊；请核实抖音聊天记录后处理`, { name, error: error.message })
    this.emitEvent('contacts', { contacts: this.storage.get().contacts || [] })
  }

  // ① 收集：扫描联系人，把"未消费的新消息"入队。除媒体身份探测外不做任何动作。
  async collectIncoming(contacts, ctx) {
    const { autoReplyOn, blacklist, aiDisabledContacts } = ctx
    try { await this.observeSelectedConversation(ctx.contacts || contacts) }
    catch (error) {
      this.assertChatOperationActive()
      if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') this.noteManualWindowDefer(error.nameOfContact || '当前会话')
      else this.log('selected_message_observation_deferred', '当前会话消息暂未完成核验，保留到下一轮检查', { reason: error.message })
    }
    const groups = new Map()
    for (const contact of contacts) {
      // Preserved offscreen rows are account history, not freshly observed
      // unread notifications. They must not keep navigating old conversations.
      if (contact.conversationListCurrent === false) continue
      const previewKind = mediaPreviewKind(contact.preview)
      const key = previewKind ? contactMessageKey(contact) : dailyMessageKey(contactMessageKey(contact), conversationTimeMeta(contact).sentAt)
      if (this.lastSeen.get(contact.name) === key && !(this.incomingBurstEnabled() && contact.unread)) continue
      const priority = contact.unread ? 3 : this.lastSeen.has(contact.name) ? 2 : this.incomingQueueMap().has(contact.name) ? 1 : 0
      if (!groups.has(priority)) groups.set(priority, [])
      groups.get(priority).push(contact)
    }
    this.collectIncomingCursors ||= new Map()
    const candidates = []
    const cursorAfter = new Map()
    for (const priority of [3, 2, 1, 0]) {
      const group = groups.get(priority) || []
      if (!group.length) continue
      const offset = (this.collectIncomingCursors.get(priority) || 0) % group.length
      const count = Math.min(8 - candidates.length, group.length)
      const selected = [...group.slice(offset), ...group.slice(0, offset)].slice(0, count)
      selected.forEach((contact, index) => cursorAfter.set(contact, { priority, next: (offset + index + 1) % group.length }))
      candidates.push(...selected)
      if (candidates.length >= 8) break
    }
    const startedAt = Date.now()
    for (const contact of candidates) {
      this.assertChatOperationActive()
      if (Date.now() - startedAt >= 12000) break
      const cursor = cursorAfter.get(contact)
      this.collectIncomingCursors.set(cursor.priority, cursor.next)
      this.setAutomationStage(`collect_incoming:${contact.name}`)
      const currentState = this.storage.get()
      const currentContact = (currentState.contacts || []).find(item => item.id === contact.id) || contact
      const canReply = currentContact.profile?.autoFriendship === true
        ? this.canReplyToAutomaticContact(currentState, currentContact) : autoReplyOn
      if (!canReply || blacklist.has(contact.name) || aiDisabledContacts.has(contact.name)
        || currentContact.profile?.aiEnabled === false || currentContact.conversationIdentityAmbiguous) continue
      try { await this.assertBackgroundChatTarget(contact.name) }
      catch (error) {
        if (error.code !== 'CHAT_WINDOW_MANUAL_CONTROL') throw error
        this.noteManualWindowDefer(contact.name)
        continue // No baseline/lastSeen update: hiding the window must unlock it.
      }
      const timeMeta = conversationTimeMeta(contact)
      const previewMediaKind = mediaPreviewKind(contact.preview)
      let currentMessageKey = contactMessageKey(contact)
      // 每日消息键：对方每天发同样的"早上好/嗨"是新的一天的新消息——文本消息把
      // 【收到日期】并入 key：同一天相同文本只处理一次（防刷屏），跨天自动解锁
      // （旧版跨天同文本会被误判"已处理"而永远沉默；媒体消息沿用指纹键不受影响）
      if (!previewMediaKind) currentMessageKey = dailyMessageKey(currentMessageKey, timeMeta.sentAt)
      const previous = this.lastSeen.get(contact.name)
      if (currentMessageKey !== previous) this.lastActivityAt = Date.now()
      const hasPrevious = this.lastSeen.has(contact.name)
      if (!contact.preview) {
        this.lastSeen.set(contact.name, currentMessageKey)
        continue
      }
      // 回声拦截：若预览文本就是我刚发出的内容（含截断、前缀、AI 标签显现），
      // 或联系人显式标记为 fromMe，直接更新 lastSeen，绝不入队（防止发送后 5 秒假入队与自我复读循环）
      const lastSentText = String(this.lastSent.get(contact.name) || '').replace(/\s+/g, ' ').trim()
      const previewText = String(contact.preview || '').replace(/\s+/g, ' ').trim()
      const isOutgoingEcho = Boolean(lastSentText) && (
        previewText === lastSentText
        || lastSentText.startsWith(previewText)
        || previewText.startsWith(lastSentText)
        || (previewText.length >= 8 && lastSentText.includes(previewText))
        || (previewText.length >= 8 && previewText.includes(lastSentText.slice(0, 15)))
        || previewText.includes('【AI · ')
      )
      if (isOutgoingEcho || contact.fromMe === true) {
        this.lastSeen.set(contact.name, currentMessageKey)
        continue
      }
      const receivedAt = timeMeta.sentAt
      const receivedAtMs = receivedAt ? new Date(receivedAt).getTime() : Number.NaN
      const recentlyReceived = Number.isFinite(receivedAtMs) && Date.now() - receivedAtMs <= 30 * 60_000 && receivedAtMs <= Date.now() + 5 * 60_000
      let incomingIdentity = null
      const manager = this.getConversationSyncManager(), binding = manager.getRecord(contact.id)
      if (binding && !manager.canAttempt(contact.id) && !allowsLegacyConversationName(contact, binding)) {
        // A list preview is merely a hint. During backoff we only read the
        // already selected panel; a real new inbound ID may reopen the binding.
        const expectedId = conversationPlatformId(contact) || binding.expectedPlatformUserId
        const selected = this.window && await safeExecuteJavaScript(this.window, conversationIdentityScript(contact.name, expectedId || ''), 1500, null)
        if (!selected?.isTargetMatch) continue
        if (expectedId) {
          const proof = await safeExecuteJavaScript(this.window, `(${activeChatIdentity.toString()})(${JSON.stringify(contact.name)}, ${JSON.stringify(expectedId || '')})`, 1500, null)
          if (!proof?.verified || proof.platformUserId !== expectedId) continue
        }
        try { incomingIdentity = await this.captureLatestIncomingMessageIdentity(contact.name, this.window) }
        catch (error) { if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') this.noteManualWindowDefer(contact.name); continue }
        if (incomingIdentity?.role !== 'contact' || !(incomingIdentity.messageId || incomingIdentity.fingerprint)) continue
        this.requestConversationSync({ reason: 'new_incoming', contactId: contact.id, name: contact.name,
          eventKey: `${contact.id}:${incomingIdentity.messageId || incomingIdentity.fingerprint}`, eventAt: incomingIdentity.message?.at })
        if (!manager.canAttempt(contact.id)) continue
      }
      // New unread text is not an old-history baseline. Require both recent
      // timing and a confirmed inbound bubble before accepting the first turn.
      if (!hasPrevious && !previewMediaKind && contact.unread) {
        if (!recentlyReceived) continue // Unknown/old time: leave it unconsumed.
        try { incomingIdentity ||= await this.captureLatestIncomingMessageIdentity(contact.name) }
        catch (error) {
          if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') this.noteManualWindowDefer(contact.name)
          continue
        }
        if (incomingIdentity?.role === 'me') { this.lastSeen.set(contact.name, currentMessageKey); continue }
        if (incomingIdentity?.role !== 'contact') continue
      }
      const shouldInspectMediaIdentity = Boolean(previewMediaKind) && (
        !hasPrevious
        || Boolean(contact.unread)
        || recentlyReceived
        || !isMediaMessageKey(previous, contact.preview)
      )
      if (shouldInspectMediaIdentity) {
        try {
          incomingIdentity ||= await this.captureLatestIncomingMessageIdentity(contact.name)
          if (incomingIdentity?.fingerprint) currentMessageKey = mediaMessageKey(contact, incomingIdentity.fingerprint)
        } catch (error) {
          if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') { this.noteManualWindowDefer(contact.name); continue }
          if (error.code === 'CONVERSATION_SYNC_DEFERRED') continue
        }
      } else if (previewMediaKind && isMediaMessageKey(previous, contact.preview)) {
        currentMessageKey = previous
      }
      // 基线：首见联系人只建基线不回复（防旧会话被意外回复）
      if (!hasPrevious && !(previewMediaKind && (Boolean(contact.unread) || recentlyReceived))
        && !(contact.unread && recentlyReceived && incomingIdentity?.role === 'contact')) {
        this.lastSeen.set(contact.name, currentMessageKey)
        continue
      }
      const legacyMediaKey = Boolean(previewMediaKind) && hasPrevious && !isMediaMessageKey(previous, contact.preview)
      if (legacyMediaKey && incomingIdentity?.fingerprint && previous === contactMessageKey(contact) && !contact.unread && !recentlyReceived) {
        this.lastSeen.set(contact.name, currentMessageKey)
        continue
      }
      if (previous === currentMessageKey && !(this.incomingBurstEnabled() && contact.unread)) continue
      if (blacklist.has(contact.name)) {
        const firstBlockedThisSession = !this.blockedContacts.has(contact.name)
        this.blockedContacts.add(contact.name)
        if (firstBlockedThisSession) this.log('auto_blocked', `已跳过 ${contact.name}：该联系人位于黑名单`, { name: contact.name, reason: 'blacklist' })
        continue
      }
      if (aiDisabledContacts.has(contact.name)) continue // 用户主动关闭：不刷日志、不消费消息
      if (this.incomingBurstEnabled()) {
        try {
          await this.assertBackgroundChatTarget(contact.name)
          await this.burstQuietObserver?.stop()
          const win = await this.selectConversation(contact.name)
          const observed = await this.observeIncomingBurst(contact.name, win, { initial: true })
          const latest = observed.messages.at(-1)
          if (latest?.role === 'me') continue
          if (latest?.role === 'contact') {
            incomingIdentity = { role: 'contact', fingerprint: latest.messageId || latest.id,
              messageId: latest.messageId || latest.id, message: latest }
            currentMessageKey = `burst:${incomingIdentity.messageId}`
          }
          this.burstQuietObserver = this.startBurstObserver(contact.name, win)
          if (previous === currentMessageKey) continue
        } catch (error) {
          if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') { this.noteManualWindowDefer(contact.name); continue }
          if (error.code === 'CONVERSATION_SYNC_DEFERRED') continue
          this.log('burst_context_unavailable', '连续消息尚未获得可靠上下文，暂缓回复', { name: contact.name, reason: error.message })
          continue
        }
      }
      if (incomingIdentity?.role === 'contact' && (incomingIdentity.messageId || incomingIdentity.fingerprint)) {
        this.requestConversationSync({ reason: 'new_incoming', contactId: contact.id, name: contact.name,
          eventKey: `${contact.id}:${incomingIdentity.messageId || incomingIdentity.fingerprint}`, eventAt: incomingIdentity.message?.at })
      }
      this.enqueueIncoming({
        name: contact.name,
        key: currentMessageKey,
        preview: contact.preview,
        mediaKind: previewMediaKind,
        receivedAt,
        unread: Boolean(contact.unread),
        incomingIdentity,
        enqueuedAt: Date.now(),
        attempts: 0,
      })
    }
  }

  // ③ 执行队列：串行处理规划结果，一次只跑一个 AI 调用 + 一次发送
  async drainIncomingQueue(ctx) {
    const queue = this.incomingQueueMap()
    if (!queue.size) return
    const startedAt = Date.now()
    const oldestEnqueuedAt = Math.min(...[...queue.values()].map((item) => item.enqueuedAt || startedAt))
    const contactsByName = new Map((ctx.contacts || []).map((contact) => [contact.name, contact]))
    const plans = this.planIncomingQueue(ctx).sort((left, right) => {
      const rank = plan => Number(contactsByName.get(plan.item?.name)?.conversationListCurrent !== false) * 2 + Number(Boolean(contactsByName.get(plan.item?.name)?.unread))
      return rank(right) - rank(left)
    })
    let consumed = 0
    let deferred = 0
    let held = 0
    let attempted = 0
    for (const plan of plans) {
      this.assertChatOperationActive()
      if (plan.action === 'hold') { held += 1; continue }
      if (plan.action === 'defer') { deferred += 1; continue }
      const item = plan.item
      if (attempted >= 2 || Date.now() - startedAt >= 30000) { deferred += 1; continue }
      const contact = contactsByName.get(item.name)
      if (!contact) { queue.delete(item.name); continue }
      try { await this.assertBackgroundChatTarget(item.name) }
      catch (error) {
        if (error.code !== 'CHAT_WINDOW_MANUAL_CONTROL') throw error
        this.noteManualWindowDefer(item.name); deferred += 1; continue
      }
      const result = await this.handleIncomingItem(item, contact, ctx)
      attempted += 1
      this.assertChatOperationActive()
      if (result === 'consumed') consumed += 1
      else deferred += 1
    }
    // 观测：只在真的消费了消息时记一条处理汇总；队列长期积压时单独告警（10 分钟一次），
    // 避免"每轮一条 queue_drained"这种刷屏式日志。
    const waitedMs = Math.max(0, startedAt - oldestEnqueuedAt)
    if (consumed > 0) {
      this.log('queue_drained', `队列处理完成：消费 ${consumed} 条 / 延后 ${deferred} 条 / 保留 ${held} 条`, {
        consumed,
        deferred,
        held,
        queueSize: this.incomingQueueMap().size,
        waitedMs,
        elapsedMs: Date.now() - startedAt,
      })
    } else if (waitedMs >= 5 * 60 * 1000 && Date.now() - (this.lastSkipNotice.get('queue_backlog') || 0) >= 10 * 60 * 1000) {
      this.lastSkipNotice.set('queue_backlog', Date.now())
      const isAllHeld = held > 0 && held === this.incomingQueueMap().size
      const msg = isAllHeld
        ? `队列暂挂 ${held} 条（已达单日发送保护上限，待限额刷新）`
        : `队列积压 ${this.incomingQueueMap().size} 条，最早一条已等待 ${Math.round(waitedMs / 1000)} 秒`
      this.log('queue_backlog', msg, {
        queueSize: this.incomingQueueMap().size,
        waitedMs,
        deferred,
        held,
      })
    }
  }

  // 执行单条消息：页面级守卫 + AI 拟回复 + 发送。
  // 返回 'consumed'（消息闭环、出队）或 'deferred'（保留在队列，下轮重新规划）
  async handleIncomingItem(item, contact, ctx) {
    try {
      await this.assertBackgroundChatTarget(item.name)
      return await this.handleIncomingItemInWindow(item, contact, ctx)
    } catch (error) {
      if (!['CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error
      if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') this.noteManualWindowDefer(item.name)
      return 'deferred'
    }
  }

  async handleIncomingItemInWindow(item, contact, ctx) {
    if (!this.incomingBurstEnabled()) {
      try { return await this.handleIncomingItemCore(item, contact, ctx) }
      catch (error) {
        if (error.code !== 'SELF_PROFILE_STALE') throw error
        this.aiBackoff.delete(contact.name)
        this.log('self_profile_generation_stale', '本人资料变化，保留入站消息等待重新生成', { name: item.name })
        return 'deferred'
      }
    }
    const buffer = this.ensureIncomingBuffer()
    const id = this.burstContactId(item.name)
    await this.assertBackgroundChatTarget(item.name)
    await this.burstQuietObserver?.stop()
    let win
    try {
      win = await this.selectConversation(item.name)
      if (!win) return 'deferred'
      await this.observeIncomingBurst(item.name, win, { initial: true })
    } catch (error) {
      if (['CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error
      this.log('burst_context_unavailable', '无法读取绑定的聊天窗口，暂缓回复', { name: item.name, reason: error.message })
      return 'deferred'
    }
    const latest = this.incomingQueueMap().get(item.name) || item
    const lease = buffer.startGeneration(id)
    if (!lease) return 'deferred'
    const observer = this.startBurstObserver(item.name, win)
    const guarded = { ...latest, _burstLease: lease, _burstObserver: observer }
    const actualMessages = lease.messages.filter(message => !message.previewOnly)
    guarded.currentIncomingBurst = { burstId: lease.burstId, contactId: lease.contactId,
      conversationRevision: lease.conversationRevision, messages: actualMessages.length ? actualMessages : lease.messages,
      firstMessageAt: lease.firstMessageAt, lastMessageAt: lease.lastMessageAt }
    try {
      return await this.handleIncomingItemCore(guarded, { ...contact, preview: latest.preview, fromMe: false }, ctx)
    } catch (error) {
      if (!['BURST_STALE', 'SELF_PROFILE_STALE'].includes(error.code)) throw error
      if (error.code === 'SELF_PROFILE_STALE') this.aiBackoff.delete(contact.name)
      this.log(error.code === 'SELF_PROFILE_STALE' ? 'self_profile_generation_stale' : 'burst_generation_stale', error.code === 'SELF_PROFILE_STALE' ? '本人资料变化，保留入站消息等待重新生成' : '对方有新消息，旧回复已作废，等待合并后重生成', { name: item.name })
      return 'deferred'
    } finally {
      await observer.stop()
      this.assertChatOperationActive()
      if (this._burstExpectedOutgoing?.contactId === id) this._burstExpectedOutgoing = null
      if (buffer.isFresh(lease)) buffer.invalidate(id)
    }
  }

  async handleIncomingItemCore(item, contact, ctx) {
    const { settings, today, factCandidates, topicCandidates } = ctx
    const currentMessageKey = item.key
    const incomingIdentity = item.incomingIdentity
    const timeMeta = conversationTimeMeta(contact)
    const initialState = this.storage.get()
    const initialContact = (initialState.contacts || []).find(entry => entry.name === contact.name) || contact
    const automaticContact = isAutoFriendshipContact(initialContact)
    const automaticSession = initialContact.profile?.contactPipeline === true ? this.contactEngine?.session : this.friendshipAutomatic?.session

    // 延后：保留消息（不推进 lastSeen），带重试时间回队列。
    // 日志节流：同一联系人同一原因每 10 分钟最多一条——延后项每轮都会重新规划，
    // 不节流会变成"每轮刷日志"，既污染运行记录又白写盘。
    const defer = (reason, waitMs = 0) => {
      const queued = this.incomingQueueMap().get(item.name)
      if (queued) {
        queued.attempts = (queued.attempts || 0) + 1
        queued.deferUntil = waitMs ? Date.now() + waitMs : 0
      }
      if (reason) {
        const logKey = `${item.name}:${reason}`
        const lastLoggedAt = this.lastSkipNotice.get(`queue_defer:${logKey}`) || 0
        if (Date.now() - lastLoggedAt >= 10 * 60 * 1000) {
          this.lastSkipNotice.set(`queue_defer:${logKey}`, Date.now())
          this.log('queue_deferred', `${item.name} 本轮不处理：${reason}`, { name: item.name, reason, attempts: queued?.attempts || 1 })
        }
      }
      return 'deferred'
    }

    // Part of this expression was genuinely sent before its profile changed.
    // Keep incoming evidence, but do not regenerate and repeat the first item.
    // A new incoming key or explicit removal of the stale task permits review.
    const partialProfileBatch = (initialState.expressionBatches || []).find(batch => batch.name === item.name && batch.incomingKey === currentMessageKey
      && batch.errorCode === 'SELF_PROFILE_STALE' && batch.items?.some(part => part.status === 'sent'))
    if (partialProfileBatch) return defer('profile_changed_after_partial_expression', 60000)

    if (initialContact.profile?.autoFriendship === true && !this.canReplyToAutomaticContact(initialState, initialContact)) return defer('auto_friendship_disabled')
    if (automaticContact) {
      try { this.assertAutoFriendshipReply(contact.name, initialContact, automaticSession) }
      catch (error) { return defer(error.message) }
    }

    // 角色判定（三层）。最后一条消息的发送方【无法确认】时绝不抢发——
    // 旧版把 null 当成"对方发的"处理，这是自动回复自言自语循环的直接来源。
    let fromMe = contact.fromMe === true
      ? true
      : incomingIdentity?.role === 'me'
        ? true
        : incomingIdentity?.role === 'contact'
          ? false
          : await this.isLastMessageFromMe(contact.name)
    await this.assertBackgroundChatTarget(contact.name)
    if (fromMe === true) {
      // 竞态保护：最后一条是"我"但预览像对方媒体时，可能是新消息被盖住——不消费，下轮重查
      if (shouldDeferConsumptionOnFromMe(contact.preview, this.lastSent.get(contact.name) || '')) {
        const deferTimes = (this.fromMeDeferCount?.get(contact.name) || 0) + 1
        if (deferTimes <= 2 || automaticContact) {
          this.fromMeDeferCount?.set(contact.name, deferTimes)
          // 去重：同一联系人每 10 分钟最多提示一次。此处消息 key 含媒体指纹、会逐轮变化，
          // 仅按 key 去重无效，会每轮（约 5 秒）刷一条日志、疯狂写盘并推高主进程内存。
          const noticeKey = `defer_on_from_me:${contact.name}`
          if (Date.now() - (this.lastSkipNotice.get(noticeKey) || 0) >= 10 * 60 * 1000) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('auto_recheck', `${contact.name} 疑似在我回复期间发来新消息，暂不消费，下轮重查（第 ${deferTimes} 次暂缓）`, { name: contact.name, preview: String(contact.preview || '').slice(0, 60), deferTimes })
          }
          return defer('', 15 * 1000)
        }
        // 熔断保护：连续暂缓已达 2 次（累计等待超过 30 秒仍未改变），判定为角色误判，强制放行回复！
        this.fromMeDeferCount?.delete(contact.name)
        this.log('auto_recheck', `${contact.name} 媒体消息连续暂缓达上限，触发熔断放行，强制判定为对方新消息并回复`, { name: contact.name, preview: String(contact.preview || '').slice(0, 60) })
        fromMe = false
      } else {
        this.fromMeDeferCount?.delete(contact.name)
        this.markIncomingConsumed(item)
        return 'consumed'
      }
    } else {
      this.fromMeDeferCount?.delete(contact.name)
    }
    if (fromMe !== false) {
      const noticeKey = `role_unknown:${contact.name}:${currentMessageKey}`
      if (!this.lastSkipNotice.has(noticeKey)) {
        this.lastSkipNotice.set(noticeKey, Date.now())
        this.log('auto_recheck', `无法确认 ${contact.name} 最后一条消息的发送方，本轮不回复，下轮重查`, { name: contact.name })
      }
      return defer('role_unknown', 30 * 1000)
    }
    // 我方回声守卫：预览就是刚发出的内容（或带 AI 标签的回显），绝不再次回复
    const lastSentText = String(this.lastSent.get(contact.name) || '').replace(/\s+/g, ' ').trim()
    const previewText = String(contact.preview || '').replace(/\s+/g, ' ').trim()
    const isEcho = Boolean(lastSentText) && (
      previewText === lastSentText
      || lastSentText.startsWith(previewText)
      || previewText.startsWith(lastSentText)
      || (previewText.length >= 8 && lastSentText.includes(previewText))
      || (previewText.length >= 8 && previewText.includes(lastSentText.slice(0, 15)))
      || previewText.includes('【AI · ')
    )
    if (isEcho) {
      this.markIncomingConsumed(item)
      return 'consumed'
    }
    // 引擎轮次闸门：同一消息 key 只处理一次；两次自动发送之间有最小间隔
    const gate = shouldAutoReply({ ...contact, turn: initialContact.turn || contact.turn }, { key: currentMessageKey, fromMe: false })
    if (!gate.ok) {
      if (gate.reason === 'already_handled') {
        this.markIncomingConsumed(item)
        return 'consumed'
      }
      if (gate.reason === 'min_gap') {
        const noticeKey = `min_gap:${contact.name}`
        if (!this.lastSkipNotice.has(noticeKey)) {
          this.lastSkipNotice.set(noticeKey, Date.now())
          this.log('auto_recheck', `${contact.name} 刚回复过，等待 ${Math.ceil((gate.retryInMs || 0) / 1000)} 秒后再处理`, { name: contact.name })
        }
        return defer('min_gap', gate.retryInMs || 20000)
      }
      return defer(gate.reason || 'gate_blocked')
    }
    let pipelineIdentity = ''
    if (initialContact.profile?.contactPipeline === true) {
      try { pipelineIdentity = await this.verifyContactPipelineIdentity(initialContact, true) }
      catch (error) { if (['CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error; return defer(error.message, 30000) }
      // Role must still be incoming after selecting and verifying this exact user.
      if (await this.isLastMessageFromMe(contact.name) !== false) return defer('无法确认已核验对象的新消息发送方', 30000)
    }
    let currentIdentity = incomingIdentity
    try {
      const currentWindow = await this.selectConversation(contact.name)
      if (currentWindow) {
        if (!pipelineIdentity && conversationPlatformId(initialContact)) pipelineIdentity = await this.verifyConversationBinding(initialContact, currentWindow) || ''
        const latestIdentity = await this.captureLatestIncomingMessageIdentity(contact.name, currentWindow)
        if (latestIdentity?.role === 'contact' && (!incomingIdentity?.fingerprint || latestIdentity.fingerprint === incomingIdentity.fingerprint)) currentIdentity = latestIdentity
        else if (incomingIdentity?.fingerprint && latestIdentity?.fingerprint !== incomingIdentity.fingerprint) return defer('current_message_changed', 10000)
      }
    } catch (error) {
      if (['CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error
      this.log('message_context_unavailable', `未能核验 ${contact.name} 的消息结构，使用预览文本`, { name: contact.name, reason: error.message })
    }
    await this.assertBackgroundChatTarget(contact.name)
    const currentMessage = currentIdentity?.message || { text: contact.preview, type: mediaPreviewKind(contact.preview) || 'text' }
    const incomingMeta = { ...timeMeta, ...currentMessage, messageId: currentIdentity?.messageId || currentIdentity?.fingerprint || currentMessageKey }
    const currentIncomingText = currentMessage.text || (currentMessage.mediaEvidence ? `[${currentMessage.type || '媒体'}]` : currentMessage.quote ? '[引用消息]' : contact.preview)
    const learnedContact = this.recordConversationMessage(contact.name, 'contact', currentMessage.text || (currentMessage.mediaEvidence || currentMessage.quote ? '' : contact.preview), contact, { human: true, sharedMemoryObserved: Boolean(currentIdentity?.message && currentIdentity?.role === 'contact'), at: timeMeta.sentAt || '',
      ...currentMessage, messageId: incomingMeta.messageId,
      ...(pipelineIdentity ? { platformUserId: pipelineIdentity, identityVerified: true } : {}) })
    if (pipelineIdentity) await this.contactEngine?.reconcileReplies()
    // 新朋友在新增对方消息后更新记忆；老朋友沿用每天一次。
    if (this.ai?.mineFacts && shouldRefreshFacts(learnedContact, today, settings.longTermMemory !== false)) {
      factCandidates.push(learnedContact)
    }
    // 话题状态候选：最近一次话题记录早于 2 小时才入列
    if (this.ai?.summarizeRecentTopic && !isFriendshipContact(learnedContact)) {
      const topicLog = Array.isArray(learnedContact?.learning?.topicLog) ? learnedContact.learning.topicLog : []
      const lastTopicAt = topicLog.length ? new Date(topicLog.at(-1).at).getTime() : 0
      if (!Number.isFinite(lastTopicAt) || Date.now() - lastTopicAt >= 2 * 60 * 60 * 1000) {
        topicCandidates.push(learnedContact)
      }
    }
    let replyText = ''
    let aiAttempted = false
    let aiDraft = null
    if (this.ai?.hasProvider?.()) {
      // AI 失败退避：同联系人连续失败时按指数拉长重试间隔（30s→2min→8min→30min）
      const backoff = this.aiBackoff.get(contact.name)
      if (backoff && Date.now() < backoff.retryAt) {
        if (!this.lastSkipNotice.has(`ai_backoff:${contact.name}`)) {
          this.lastSkipNotice.set(`ai_backoff:${contact.name}`, Date.now())
          this.log('ai_backoff', `${contact.name} 的 AI 调用暂缓（${Math.ceil((backoff.retryAt - Date.now()) / 1000)} 秒后重试）`, { name: contact.name })
        }
        return defer('ai_backoff', Math.max(1000, backoff.retryAt - Date.now()))
      }
      aiAttempted = true
      try {
        // 打开会话抓取完整可见消息，增强上下文（传入 previous.learning 防止 facts/topicLog 被擦）
        let enhancedContact = learnedContact
        try {
          const chatWin = await this.selectConversation(contact.name)
          if (chatWin) {
            const visibleMessages = await this.captureVisibleMessages(chatWin)
            await this.assertBackgroundChatTarget(contact.name, chatWin)
            if (visibleMessages.length > 0) {
              const mergedMessages = mergeMessageHistory(learnedContact.learning?.messages, visibleMessages)
              const enhancedLearning = this.ai.analyzeConversation(mergedMessages, learnedContact.learning)
              enhancedContact = { ...learnedContact, learning: enhancedLearning }
              if (isFriendshipContact(enhancedContact)) {
                const latestContacts = this.storage.get().contacts || []
                this.storage.update({ contacts: latestContacts.map(item => item.name === contact.name ? { ...item, learning: { ...item.learning, messages: mergedMessages } } : item) })
                const factIndex = factCandidates.findIndex(item => item.name === contact.name)
                if (factIndex >= 0) factCandidates[factIndex] = enhancedContact
                else if (shouldRefreshFacts(enhancedContact, today, settings.longTermMemory !== false)) factCandidates.push(enhancedContact)
              }
            }
          }
        } catch (error) { if (['CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error; /* 抓取失败回退预览文本 */ }

        let mediaCapture = normalizeCapturedMedia([])
        const mediaKind = currentMessage.mediaKind || mediaPreviewKind(contact.preview) || (currentMessage.quote?.mediaEvidence ? currentMessage.quote.type : '')
        const isMedia = Boolean(mediaKind)
        let useMediaForReply = isMedia
        if (isMedia) {
          if (settings.videoReplyEnabled === false || settings.videoRecognitionEnabled === false) {
            if (hasReplyablePreviewText(contact.preview)) {
              useMediaForReply = false
              this.log('media_text_fallback', `${contact.name} 媒体回复已关闭，使用预览文本回复`, { name: contact.name, mediaKind, reason: 'replyable_preview' })
            } else {
              this.log('media_skipped', `${contact.name} 媒体已跳过：视频回复已关闭`, { name: contact.name, mediaKind, reason: 'video_reply_disabled' })
              this.markIncomingConsumed(item)
              return 'consumed'
            }
          } else {
            try {
              const recognition = { ...videoRecognitionOptions(settings), expectedMessageId: currentIdentity?.messageId || currentIdentity?.fingerprint || '', expectedMediaKind: mediaKind }
              mediaCapture = normalizeCapturedMedia(await this.captureLatestIncomingMedia(contact.name, recognition), mediaKind)
              if (!currentIdentity?.fingerprint && mediaKind === 'video' && shouldUseVideoFrameFallback(recognition, mediaCapture) && this.captureLatestIncomingVideo && mediaCapture.captureEvidence?.status !== 'failed') {
                mediaCapture = normalizeCapturedMedia(await this.captureLatestIncomingVideo(contact.name), mediaKind)
              }
            } catch (error) {
              if (['CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error
              mediaCapture = normalizeCapturedMedia({ frames: [], mediaKind, capturedMessageId: incomingMeta.messageId, quote: currentMessage.quote,
                originalText: currentMessage.text, reason: 'capture_failed', captureEvidence: { source: 'visible_message_dom', status: 'failed', reason: error.message } }, mediaKind)
            }
          }
        }
        const providers = this.storage.get().providers || []
        await this.assertBackgroundChatTarget(contact.name)
        const hasAudioTranscript = Boolean(mediaCapture.audioTranscript)
        const hasPublicContext = hasPublicMediaContext(mediaCapture)
        if (useMediaForReply && !mediaCapture.frames.length && !hasAudioTranscript && !hasPublicContext && hasReplyablePreviewText(contact.preview)) {
          useMediaForReply = false
          this.log('media_text_fallback', `${contact.name} 媒体捕获不可用，使用预览文本回复`, { name: contact.name, mediaKind, reason: mediaCapture.reason || 'media_capture_unavailable' })
        }
        if (useMediaForReply) {
          const caps = providers.length ? providers.some(p => (p.capabilities || []).includes('vision')) : Boolean(this.ai?.hasProvider?.())
          if (!caps && !hasAudioTranscript && !hasPublicContext) {
            this.log('media_skipped', `${contact.name} 媒体已跳过：模型不支持视觉`, { name: contact.name, mediaKind })
            this.markIncomingConsumed(item)
            return 'consumed'
          }
          const requiresDecodedVideo = mediaKind === 'video' || mediaCapture.detectedVideo === true
          if (!mediaCapture.frames.length && !hasAudioTranscript && !hasPublicContext) {
            if (settings.videoLowConfidenceReply === false) {
              this.log(requiresDecodedVideo ? 'video_unreadable' : 'media_uncertain', `${contact.name} 媒体画面无法捕获且已关闭低置信度回复`, { name: contact.name, mediaKind })
              this.markIncomingConsumed(item)
              return 'consumed'
            }
            useMediaForReply = false
            this.log('media_text_fallback', `${contact.name} 媒体画面未捕获，按聊天上下文语境回复`, { name: contact.name, mediaKind })
          }
        }
        if (item._burstLease) {
          const burstMessages = item.currentIncomingBurst.messages
          const merged = mergeMessageHistory(enhancedContact.learning?.messages, burstMessages)
          enhancedContact = { ...enhancedContact, learning: { ...enhancedContact.learning, messages: merged } }
        }
        await this.assertBurstFresh(item)
        if (item._burstLease) this.recordSharedMemoryLedger(enhancedContact.id, item.currentIncomingBurst.messages)
        aiDraft = await this.ai.draft({ contact: enhancedContact, incoming: currentIncomingText, incomingMeta,
          currentIncomingBurst: item.currentIncomingBurst,
          recentConversationContext: enhancedContact.learning?.messages || [],
          generationGuard: () => this.assertBurstFresh(item),
          onGenerationStage: stage => item._burstLease ? this.ensureIncomingBuffer().setStage(item._burstLease, stage) : true,
          videoFrames: isMedia ? { ...mediaCapture, quote: mediaCapture.quote || currentMessage.quote, originalText: currentMessage.text || '',
            capturedMessageId: mediaCapture.capturedMessageId || incomingMeta.messageId } : undefined })
        this.assertAiSelfProfile(aiDraft?.text || '', { ai: true, selfProfileRevision: aiDraft?.selfProfileRevision })
        await this.assertBurstFresh(item)
        if (aiDraft?.ok && (aiDraft.labeledText || aiDraft.text)) {
          const model = aiDraft.model || providers?.[0]?.model || '当前模型'
          const label = aiDraft.aiLabel || `AI · ${model}`
          const showAiModelLabel = this.storage.get().settings?.showAiModelLabel !== false
          const rawGenerated = String(showAiModelLabel ? (aiDraft.labeledText || aiDraft.text) : aiDraft.text).trim()
          const cleanText = stripAiPrefix(rawGenerated)
          replyText = showAiModelLabel ? (cleanText ? `【${label}】${cleanText}` : '') : cleanText
        }
      } catch (error) {
        if (error.code === 'SHARED_MEMORY_STALE') {
          this.aiBackoff.delete(contact.name); this.log('shared_memory_generation_stale', '共同记忆已删除，旧回复已作废，本轮不重试', { name: contact.name }); this.markIncomingConsumed(item); return 'consumed'
        }
        if (['BURST_STALE', 'SELF_PROFILE_STALE', 'CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error
        this.log('ai_error', `为 ${contact.name} 调用 AI 失败`, { name: contact.name, error: error.message })
        const prevStep = this.aiBackoff.get(contact.name)?.step || 0
        const step = Math.min(prevStep + 1, 4)
        const delay = [30000, 120000, 480000, 1800000][step - 1]
        this.aiBackoff.set(contact.name, { step, retryAt: Date.now() + delay })
        return defer('ai_error', delay) // 不消费，退避后重试
      }
    }
    if (aiAttempted && aiDraft?.skipped === true) {
      await this.assertBurstFresh(item)
      this.aiBackoff.delete(contact.name)
      this.log('ai_reply_skipped', `已处理 ${contact.name} 的消息，本轮不回复`, { name: contact.name, reason: String(aiDraft.reason || aiDraft.plan?.reason || 'NO_REPLY'), messageId: incomingMeta.messageId })
      this.markIncomingConsumed(item)
      this.queueCompletedSharedInteraction(contact.id, contact.name, 'no_reply', item._burstLease?.burstId || '')
      return 'consumed'
    }
    const plannedExpression = aiDraft?.expression || aiDraft?.strategy?.expression || aiDraft?.plan?.expression
    const hasStickerExpression = aiAttempted && ['STICKER_ONLY', 'TEXT_AND_STICKER'].includes(plannedExpression?.mode)
    if (replyText || hasStickerExpression) {
      try {
        await this.assertBurstFresh(item)
        if (automaticContact) this.assertAutoFriendshipReply(contact.name, initialContact, automaticSession)
        const mediaKindForReply = mediaPreviewKind(contact.preview)
        if (mediaKindForReply && isUnavailableMediaReply(replyText)) {
          this.log('ai_reply_rejected', `${contact.name} 的媒体回复已拦截`, { name: contact.name, mediaKind: mediaKindForReply, text: replyText, reason: 'unavailable_media_reply' })
          this.markIncomingConsumed(item)
          return 'consumed'
        }
        // 草稿模式：AI 生成的回复进入草稿列表等待人工确认
        if (settings.aiReplyDraftOnly === true && !automaticContact) {
          const drafts = [...(this.storage.get().pendingDrafts || [])]
          drafts.unshift({ id: Date.now(), at: new Date().toISOString(), name: contact.name, text: replyText + (aiDraft?.text2 ? '\n' + aiDraft.text2 : '') + (aiDraft?.text3 ? '\n' + aiDraft.text3 : ''), incoming: String(contact.preview || ''), model: aiDraft?.model || '', provider: aiDraft?.provider || '', status: 'pending',
            selfProfileRevision: aiDraft?.selfProfileRevision, sharedMemoryIds: aiDraft?.strategy?.sharedMemoryIds || [], sharedMemoryRevision: aiDraft?.strategy?.sharedMemoryRevision,
            ...(plannedExpression ? { expression: plannedExpression } : {}),
            ...(item._burstLease ? { burstId: item._burstLease.burstId, contactId: item._burstLease.contactId,
              conversationRevision: item._burstLease.conversationRevision, latestIncomingMessageId: incomingMeta.messageId, bufferEpoch: this.bufferEpoch } : {}) })
          const capped = drafts.slice(0, 50)
          this.storage.update({ pendingDrafts: capped })
          this.emitEvent('drafts', { drafts: capped })
          this.log('ai_draft_pending', `已为 ${contact.name} 生成 AI 草稿待确认`, { name: contact.name, text: replyText })
          this.markIncomingConsumed(item)
          return 'consumed'
        }
        const aiMeta = aiAttempted ? { ai: true, deferSharedMemoryExtraction: true, traceId: aiDraft?.chatTraceId || '', sharedMemoryIds: aiDraft?.strategy?.sharedMemoryIds || [], sharedMemoryRevision: aiDraft?.strategy?.sharedMemoryRevision, source: 'ai', model: aiDraft?.model || '', provider: aiDraft?.provider || '', aiLabel: aiDraft?.aiLabel || '', selfProfileRevision: aiDraft?.selfProfileRevision } : { source: 'rule' }
        if (automaticContact || item._burstLease) {
          aiMeta.autoFriendship = automaticContact
          aiMeta.beforeSubmit = async () => {
            await this.assertBurstFresh(item)
            if (automaticContact) {
              this.assertAutoFriendshipReply(contact.name, initialContact, automaticSession, true)
              if (initialContact.profile?.contactPipeline === true) await this.verifyContactPipelineIdentity(initialContact)
            }
          }
        }
        // 拟人延迟：AI 回复不秒回，按长度加 1.5–12 秒随机"打字时间"
        if (aiAttempted) await sleep(humanReplyDelay(replyText))
        await aiMeta.beforeSubmit?.()
        if (item._burstLease) {
          this.ensureIncomingBuffer().setStage(item._burstLease, 'SENDING')
          this._burstExpectedOutgoing = { contactId: item._burstLease.contactId, text: replyText, texts: [replyText] }
        }
        if (hasStickerExpression) {
          const result = await this.sendExpression(contact.name, plannedExpression, { ...aiMeta, automaticReply: true,
            text: replyText + (aiDraft?.text2 ? '\n' + aiDraft.text2 : ''), incomingKey: currentMessageKey,
            ...(item._burstLease ? { burstId: item._burstLease.burstId, contactId: item._burstLease.contactId,
              conversationRevision: item._burstLease.conversationRevision, bufferEpoch: this.bufferEpoch } : {}) })
          if (['SELF_PROFILE_STALE', 'SHARED_MEMORY_STALE', 'CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(result.error?.code)) throw result.error
          // A partial or uncertain expression must never regenerate its text on the
          // next polling round. The independent persisted batch owns recovery.
          this.aiBackoff.delete(contact.name)
          this.log(result.ok ? 'expression_sent' : 'expression_paused', `表达发送${result.ok ? '完成' : '暂停'}：${contact.name}`, { name: contact.name, batchId: result.batchId, status: result.status })
          this.markIncomingConsumed(item)
          this.queueCompletedSharedInteraction(contact.id, contact.name, 'expression_complete', item._burstLease?.burstId || '')
          return 'consumed'
        }
        await this.sendMessage(contact.name, replyText, aiMeta)
        if (aiAttempted) this.recordExpressionTurn(contact.name, { mode: 'TEXT_ONLY', stickerIntent: 'NONE' })
        this.aiBackoff.delete(contact.name)
        this.lastSent.set(contact.name, replyText)
        this.lastSeen.set(contact.name, currentMessageKey)
        this.persistTurn(contact.name, (turn) => ({ ...turn, lastHandledKey: currentMessageKey, lastOutgoingAt: Date.now() }))
        // 多条（允许而非必须）：模型补了后续随口话时紧跟发出（首条之外最多再两条）；每个气泡
        // 独立做 stale 检查（sendMessage 内部写入前/后各查一次），一旦对方插话立刻停止后续气泡，
        // 绝不因为"同属一轮生成结果"就默认第二条、第三条仍然有效。
        const followUps = aiAttempted
          ? [aiDraft?.text2, aiDraft?.text3].map((value) => String(value || '').trim()).filter(Boolean).slice(0, 2)
          : []
        for (const [index, followUp] of followUps.entries()) {
          try {
            await sleep(humanReplyDelay(followUp))
            await this.sendMessage(contact.name, followUp, aiMeta)
            this.lastSent.set(contact.name, followUp)
            if (item._burstLease && this._burstExpectedOutgoing?.contactId === item._burstLease.contactId) {
              this._burstExpectedOutgoing.texts = [...(this._burstExpectedOutgoing.texts || []), followUp]
            }
          } catch (followError) {
            if (automaticContact && followError.sendAttempted === true) this.suspendAutoFriendshipReply(contact.name, followError)
            if (['USER_DRAFT_PRESENT', 'DRAFT_CLEAR_FAILED'].includes(followError.code)) this.blockUserDraftContact?.(contact.name, followError)
            if (['BURST_STALE', 'SELF_PROFILE_STALE', 'SHARED_MEMORY_STALE', 'CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED', 'USER_DRAFT_PRESENT', 'DRAFT_CLEAR_FAILED'].includes(followError.code)) {
              this.log('followup_cancelled', `第${index + 2}条气泡已取消（首条已送达）：${contact.name}`, { name: contact.name, code: followError.code, error: followError.message })
              break
            }
            this.log('send_error', `第${index + 2}条消息发送失败（首条已送达，不影响本轮）`, { name: contact.name, error: followError.message })
          }
        }
        if (item._burstLease) {
          // The send has already happened. A later incoming revision must remain queued,
          // while this delivered turn is recorded exactly once.
          if (this.ensureIncomingBuffer().isFresh(item._burstLease)) this.markIncomingConsumed(item)
        } else if (this.incomingQueueMap().get(contact.name)?.key === item.key) this.incomingQueueMap().delete(contact.name)
        this.queueCompletedSharedInteraction(contact.id, contact.name, 'reply_complete', item._burstLease?.burstId || '')
        return 'consumed'
      } catch (error) {
        if (error.code === 'SHARED_MEMORY_STALE') {
          this.aiBackoff.delete(contact.name); this.log('shared_memory_generation_stale', '共同记忆已删除，旧回复已作废，本轮不重试', { name: contact.name }); this.markIncomingConsumed(item); return 'consumed'
        }
        if (['BURST_STALE', 'SELF_PROFILE_STALE', 'CHAT_WINDOW_MANUAL_CONTROL', 'CONVERSATION_SYNC_DEFERRED'].includes(error.code)) throw error
        // 输入框被真人草稿占用（或 AI 残留清理失败）：暂停该联系人的自动发送，不按时间
        // 循环重试，只 hold 住这条消息；用户手动发送或对方再发新消息后自动恢复。
        if (['USER_DRAFT_PRESENT', 'DRAFT_CLEAR_FAILED'].includes(error.code)) {
          this.blockUserDraftContact(contact.name, error)
          return 'deferred'
        }
        this.log('send_error', `自动回复发送失败：${contact.name}`, { name: contact.name, error: error.message })
        if (automaticContact && error.sendAttempted === true) {
          this.suspendAutoFriendshipReply(contact.name, error)
          this.markIncomingConsumed(item)
          return 'consumed'
        }
        return defer('send_error', 60 * 1000) // 不消费，下轮重试
      }
    }
    if (aiAttempted && aiDraft?.rejected === true) {
      // 拒发不重试：同一输入重试大概率产出同类内容，直接消费消息（宁可不说）
      this.markIncomingConsumed(item)
      return 'consumed'
    }
    if (aiAttempted) {
      const noticeKey = `ai_empty:${contact.name}:${currentMessageKey}`
      if (!this.lastSkipNotice.has(noticeKey)) {
        this.lastSkipNotice.set(noticeKey, Date.now())
        this.log('ai_empty', `AI 未返回有效回复，保留 ${contact.name} 的消息待重试`, { name: contact.name })
      }
      return defer('ai_empty', 60 * 1000)
    }
    const noticeKey = `ai_unavailable:${contact.name}:${currentMessageKey}`
    if (!this.lastSkipNotice.has(noticeKey)) {
      this.lastSkipNotice.set(noticeKey, Date.now())
      this.log('ai_unavailable', `未配置可用模型，保留 ${contact.name} 的消息待重试`, { name: contact.name })
    }
    return defer('ai_unavailable', 60 * 1000)
  }

  // 内存卫生：聊天页是常驻重型 SPA，渲染进程会累积数百 MB。每 10 分钟检查一次，
  // 空闲且超阈值时重建渲染进程（destroy 让进程退出、OS 立即回收内存），下次轮询按需重建。
  startMemoryHygiene() {
    if (this._memoryTimer) return
    this._pageLoadedAt = Date.now()
    this._memoryTimer = setInterval(() => { this.runMemoryHygiene().catch(() => {}) }, 10 * 60 * 1000)
  }

  // 读取聊天页渲染进程内存（MB）。注意：Electron 37 起 getAppMetrics 只在 app 上
  // （process.getAppMetrics 已移除，旧代码因此一直抛错、清理从未生效）。
  // 这里逐级回退：app.getAppMetrics → process.getAppMetrics → 渲染进程 JS 堆。
  async readChatPageMemoryMB(win) {
    try {
      const el = require('electron')
      const fn = (el && el.app && typeof el.app.getAppMetrics === 'function')
        ? el.app.getAppMetrics.bind(el.app)
        : (typeof process.getAppMetrics === 'function' ? process.getAppMetrics.bind(process) : null)
      if (fn) {
        const pid = win.webContents.getOSProcessId()
        const metric = fn().find((m) => m.pid === pid)
        // workingSetSize 单位是 KB（Electron MemoryInfo），换算成 MB
        if (metric) return { memMB: Math.round((metric.memory?.workingSetSize || 0) / 1024), source: 'appMetrics' }
      }
    } catch { /* 换下一级回退 */ }
    try {
      const bytes = await executePageScript(win, '(performance.memory && performance.memory.usedJSHeapSize) || 0').catch(() => 0)
      if (bytes) return { memMB: Math.round(Number(bytes) / 1048576), source: 'jsHeap' }
    } catch { /* ignore */ }
    return { memMB: 0, source: 'none' }
  }

  async runMemoryHygiene() {
    if (this.polling || this.verificationActive) return
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (win.webContents.isLoading()) return
    const uptimeMin = Math.round((Date.now() - (this._pageLoadedAt || Date.now())) / 60000)
    const { memMB, source } = await this.readChatPageMemoryMB(win)
    // 触发条件（防泄漏护栏）：聊天页常驻内存异常偏高才重建。实测抖音聊天页自身固有占用
    // 就有 300-600MB，重载并不能降低这部分、反而会瞬时冲高，因此阈值必须高于正常水位，
    // 只在疑似泄漏（持续增长到 800MB 以上）时才回收。RSS 与 JS 堆两套口径分别设阈。
    const overMem = source === 'jsHeap' ? memMB >= 250 : memMB >= 800
    if (!(overMem && uptimeMin >= 10)) return
    this.log('memory_hygiene', `聊天页内存 ${memMB}MB（${source}）/ 已加载 ${uptimeMin} 分钟，疑似异常增长，重建渲染进程释放内存`, { memMB, source, uptimeMin })
    this.recycleChatWindow()
  }

  // 账号空闲休眠判定：无待办实时消息回复，且近 10 分钟内无续火花任务时，休眠隐藏聊天窗口以节约内存
  static shouldSleepChatWindow({ config = {}, settings = {}, now = new Date() } = {}) {
    return shouldSleepChatWindow({ config, settings, now })
  }

  // 重建聊天页：destroy 让渲染进程彻底退出（OS 回收内存），下次轮询按需重建
  recycleChatWindow() {
    this.incomingBuffer?.pause()
    void this.burstQuietObserver?.stop()
    const win = this.window
    this.window = null
    this._pageLoadedAt = Date.now()
    try {
      if (win && !win.isDestroyed()) {
        win.__forceClose = true
        win.destroy()
      }
    } catch { /* 销毁失败不阻塞自动化 */ }
    try { if (typeof global.gc === 'function') global.gc() } catch { /* 主进程堆回收（需 --expose-gc） */ }
  }

  getEventFollowups() {
    if (!this.eventFollowups) this.eventFollowups = new ProactiveEngine({ storage: this.storage, ai: this.ai, douyin: this, accountId: this.accountId || '' })
    return this.eventFollowups
  }

  async runAutomation() {
    if (this._destroyed) return
    if (this._automationRun) return this._automationRun
    if (this.polling) return
    const pending = this.getChatWindowCoordinator().run('automation', async () => {
      try { return await this.runAutomationInWindow() }
      catch (error) {
        if (error.code !== 'CHAT_WINDOW_MANUAL_CONTROL') throw error
        this.noteManualWindowDefer(error.nameOfContact || '后台会话')
      }
    }, { onTimeout: owner => {
      this.conversationSyncEpoch++
      this._burstExpectedOutgoing = null
      const uncertain = owner.pendingSubmission
      if (uncertain?.incomingKey) {
        const queued = this.incomingQueueMap().get(uncertain.name)
        if (queued?.key === uncertain.incomingKey) {
          this.markIncomingConsumed(queued)
          this.log('auto_send_uncertain', '发送提交后本轮超时，结果待人工核实，已阻止同条消息自动重发', { name: uncertain.name, key: uncertain.incomingKey })
        }
      }
      this.recycleChatWindow()
      this.burstQuietObserver = null
      this.polling = false
      this.log('worker_watchdog', '自动回复单轮超过 120 秒，旧任务已失效并释放窗口锁，下轮重新同步', { stage: owner.stage, timeoutMs: 120000 })
    } })
    this._automationRun = pending
    try { return await pending }
    finally { if (this._automationRun === pending) this._automationRun = null }
  }

  async runAutomationInWindow() {
    const round = this.assertChatOperationActive()
    if (this.polling || this.friendshipGreetingInProgress || this.expressionPreparing.size || this.expressionSending.size) return
    const state = this.storage.get()
    const config = state.automation || {}
    const settings = state.settings || {}
    if (this.incomingBuffer) {
      if (config.paused || !this.incomingBurstEnabled()) this.incomingBuffer.pause()
      else if (this.incomingBuffer.paused) this.incomingBuffer.resume()
    }

    // 空闲休眠守卫：若当前处于免打扰时段，或无实时回复需求且近期无续火花任务，休眠隐藏窗口释放 300MB+ 内存
    const eventFollowupDue = settings.eventFollowup?.enabled === true && !config.paused && scanDueEvents(state.contacts).length > 0
    const autoFriendshipReplies = (state.contacts || []).some(contact => autoFriendshipReplyEnabled(state, contact))
    const conversationWork = this.getConversationSyncManager().due({ idle: true, manualVisible: this.window?.isVisible?.() === true })
    if (!conversationWork.reconcile && !conversationWork.targets.length && shouldSleepChatWindow({ config, settings: { ...settings, eventFollowupDue, autoFriendshipReplies } })) {
      if (this.window && !this.window.isDestroyed() && !this.window.isVisible()) {
        this.log('window_idle_sleep', '当前账号处于免打扰期或无待办实时任务，已休眠后台聊天窗口以释放内存')
        this.recycleChatWindow()
      }
      return
    }

    this.setAutomationStage('login_status')
    const status = await this.getStatus()
    this.assertChatOperationActive()
    if (!status.connected) return
    if (!this.window || this.window.isDestroyed()) this.ensureWindow(false)
    // 风控检测：可见验证码出现即暂停本账号自动化，验证通过后自动恢复
    try {
      this.setAutomationStage('verification_check')
      const challenged = await this.withChatRead(() => executePageScript(this.window, `(() => {
        const bodyText = String(document.body?.innerText || '')
        const hasVerifyText = /(?:请完成安全验证|拖动下方滑块完成拼图|点击下方按钮完成验证|按顺序点击|请按要求完成验证)/.test(bodyText)
        if (!hasVerifyText) return false

        const nodes = document.querySelectorAll('[class*="secsdk_captcha_modal" i], [class*="captcha_modal" i], [class*="captcha" i], iframe[src*="captcha" i], [id*="captcha" i]')
        for (const el of nodes) {
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.05) continue
          const rect = el.getBoundingClientRect()
          if (rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth) {
            return {
              matched: true,
              tag: el.tagName,
              className: String(el.className || '').slice(0, 100),
              id: el.id || '',
              src: String(el.getAttribute('src') || '').slice(0, 120),
            }
          }
        }
        return false
      })()`), 'verification_check')
      const hasChallenge = Boolean(challenged?.matched)
      if (hasChallenge && !this.verificationActive) {
        this.verificationActive = true
        this.log('verification_required', '检测到抖音安全验证，已暂停本账号的自动回复；请在登录窗口完成验证，通过后自动恢复', { account: this.partition, node: challenged })
        this.emitEvent('verification', { required: true })
      } else if (!hasChallenge && this.verificationActive) {
        this.verificationActive = false
        this.log('verification_cleared', '安全验证已通过，本账号自动回复恢复运行', {})
        this.emitEvent('verification', { required: false })
      }
      if (hasChallenge) return
    } catch (error) {
      this.assertChatOperationActive()
      this.log('verification_check_unavailable', '无法完成安全验证检查，本轮暂缓发送并等待下一轮重新读取', { error: error.message })
      return
    }
    if (this.expressionPreparing.size || this.expressionSending.size) return
    this.polling = true
    try {
      this.setAutomationStage('sync_contacts')
      const { contacts, visibleContacts } = await this.syncContacts()
      this.assertChatOperationActive()
      const today = localDateKey()
      const autoReplyOn = Boolean(config.autoReply) && !config.paused
      const blacklist = new Set((config.blacklist || []).map((name) => String(name).trim()).filter(Boolean))
      const aiDisabledContacts = new Set((config.aiDisabledContacts || []).map((name) => String(name).trim()).filter(Boolean))
      const canSend = (name) => !blacklist.has(name) && this.getSendAllowance(name).ok
      const factCandidates = []
      const topicCandidates = []
      const ctx = { config, settings, contacts, today, autoReplyOn, blacklist, aiDisabledContacts, canSend, factCandidates, topicCandidates }

      // ① 收集：只发现、只入队，不做任何回复动作
      this.setAutomationStage('collect_incoming')
      await this.collectIncoming(Array.isArray(visibleContacts) ? visibleContacts : contacts, ctx)
      // ② 规划 + ③ 执行：先统一判定，再严格串行处理（同一时刻只有一个 AI 调用和一次发送）
      this.setAutomationStage('drain_incoming')
      await this.drainIncomingQueue(ctx)
      this.setAutomationStage('conversation_sync')
      await this.processConversationSync({ idle: this.conversationSyncIdle(ctx) })
      this.eventFollowups?.reconcile()
      if (settings.eventFollowup?.enabled === true && !config.paused) {
        try { await this.getEventFollowups().scan() } catch (error) { this.log('event_followup_error', '事件跟进检查失败', { error: error.message }) }
      }

      const seenArr = [...this.lastSeen].map(([n, p]) => ({ name: n, preview: p, at: Date.now() }))
      if (this.storage?.update) this.storage.update({ lastSeenPairs: seenArr })

      const now = new Date()
      const minutesNow = now.getHours() * 60 + now.getMinutes()
      const sparks = [...(config.sparks || [])]
      for (let index = 0; index < sparks.length; index += 1) {
        if (this.backgroundNavigationBlocked()) break
        const task = sparks[index]
        const due = timeToMinutes(task.time) <= minutesNow
        const retryReady = !task.lastAttemptAt || (Date.now() - Number(task.lastAttemptAt)) >= SPARK_RETRY_MS
        if (!task.enabled || !due || task.lastRunDate === today || !retryReady) continue
        if (this.hasSentConversationToday(task.name)) {
          sparks[index] = { ...task, lastRunDate: today, lastAttemptAt: Date.now() }
          this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
          this.log('spark_fill_skipped', `${task.name} 今天已有发送记录，本次无需补续`, { name: task.name, reason: 'sent_today' })
          continue
        }
        if (!canSend(task.name)) continue
        const attempted = { ...task, lastAttemptAt: Date.now() }
        sparks[index] = attempted
        this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
        try {
          await this.sendTask(task.name, task)
          sparks[index] = { ...attempted, lastRunDate: today, lastAttemptAt: Date.now() }
          this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
          this.log('spark_sent', `${task.name} 的问候任务已完成`, { name: task.name })
        } catch (error) {
          if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') this.noteManualWindowDefer(task.name)
          else this.log('spark_fill_failed', `${task.name} 问候任务执行失败，稍后重试`, { name: task.name, error: error.message })
        }
        if (index < sparks.length - 1) await sleep(1500)
      }
      // 主动伴聊：活跃时段内低频挑人主动聊
      if (!this.backgroundNavigationBlocked()) {
        try { await this.processProactiveChats(now, blacklist, aiDisabledContacts) }
        catch (error) {
          if (error.code === 'CHAT_WINDOW_MANUAL_CONTROL') this.noteManualWindowDefer(error.nameOfContact || '主动伴聊')
          else this.log('companion_error', `主动伴聊执行失败`, { error: error.message })
        }
      }
      // 长期记忆提炼：本轮最多 3 位联系人
      this.setAutomationStage('memory_extraction')
      for (const candidate of factCandidates.slice(0, 3)) {
        if (!candidate?.name) continue
        try {
          const learned = await this.ai.mineFacts({ name: candidate.name, messages: candidate.learning?.messages, existing: candidate.learning?.facts, friendship: isFriendshipContact(candidate) })
          if (learned?.ok && Array.isArray(learned.facts)) {
            const latestState = this.storage.get()
            const latestContacts = [...(latestState.contacts || [])]
            const idx = latestContacts.findIndex((item) => item.name === candidate.name)
            if (idx >= 0) {
              latestContacts[idx] = { ...latestContacts[idx], learning: { ...(latestContacts[idx].learning || {}), facts: learned.facts, factsUpdatedAt: today, ...(isFriendshipContact(candidate) ? { factsConversationKey: factsConversationKey(candidate) } : {}) } }
              this.storage.update({ contacts: latestContacts })
              this.emitEvent('contacts', { contacts: latestContacts })
            }
          }
        } catch (_) { /* 提炼失败不影响主流程 */ }
      }
      // 话题状态总结：本轮最多 2 位联系人
      this.setAutomationStage('topic_summary')
      for (const candidate of topicCandidates.slice(0, 2)) {
        if (!candidate?.name) continue
        try {
          const learned = await this.ai.summarizeRecentTopic({ name: candidate.name, messages: candidate.learning?.messages, existing: candidate.learning?.topicLog })
          if (learned?.ok && Array.isArray(learned.topics)) {
            const latestState = this.storage.get()
            const latestContacts = [...(latestState.contacts || [])]
            const idx = latestContacts.findIndex((item) => item.name === candidate.name)
            if (idx >= 0) {
              latestContacts[idx] = { ...latestContacts[idx], learning: { ...(latestContacts[idx].learning || {}), topicLog: learned.topics } }
              this.storage.update({ contacts: latestContacts })
              this.emitEvent('contacts', { contacts: latestContacts })
            }
          }
        } catch (_) { /* 话题总结失败不影响主流程 */ }
      }
    } finally {
      if (!round?.revoked) this.polling = false
    }
  }

  log(type, message, detail = {}) {
    const entry = { id: Date.now(), at: new Date().toISOString(), type, message, detail }
    this.storage.addLog(entry)
    this.emitEvent('log', entry)
  }

  emitEvent(type, payload) {
    this.assertChatOperationActive()
    this.emit?.({ type, payload })
  }

  destroy() {
    this.getChatWindowCoordinator().close()
    this.conversationSyncEpoch++
    this.conversationSyncManager?.destroy()
    this.ai?.cancelSharedMemoryExtraction?.()
    this.ai?.cancelSelfNarrativeExtraction?.()
    this.ai?.cancelPromiseExtraction?.()
    this._destroyed = true
    this.incomingBuffer?.dispose()
    void this.burstQuietObserver?.stop()
    this.eventFollowups?.destroy()
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    if (this._memoryTimer) { clearInterval(this._memoryTimer); this._memoryTimer = null }
    if (this.incomingQueue instanceof Map) this.incomingQueue.clear()
    if (this._discoveryCleanupTimer) { clearTimeout(this._discoveryCleanupTimer); this._discoveryCleanupTimer = null }
    if (this.window && !this.window.isDestroyed()) {
      this.window.__forceClose = true
      this.window.destroy()
    }
    if (this.discoveryWindow && !this.discoveryWindow.isDestroyed()) this.discoveryWindow.destroy()
  }
}
module.exports = { AUTOMATION_POLL_MS, DouyinService, computePollDelay, humanReplyDelay, conversationTimeMeta, dailySparkMessage, extractConversationPreview, extractConversationTimeLabel, extractPublicCommentItemText, extractReactAwemeId, extractStreakCount, hasPublicMediaContext, hasReplyablePreviewText, isConversationTargetMatch, isUnavailableMediaReply, isVideoPreview, mediaPreviewKind, mergeMessageHistory, mergePublicMediaContext, normalizeCapturedMedia, normalizeCommentContext, normalizeVisibleMediaContext, normalizeVideoRecognitionMode, pickLatestChatMessageRole, resolveConversationSentAt, resolveSparkTask, shouldDeferConsumptionOnFromMe, shouldUseVideoFrameFallback, videoRecognitionOptions, shouldSleepChatWindow }

Object.assign(module.exports, { extractConversationName, normalizeConversationName, isLegacyConversationName, resolveConversationName, reconcileConversationContacts, renameConversationReferences, readConversationIdentity, conversationIdentityScript, findConversationTargetRow, conversationRowScript })
Object.assign(module.exports, { normalizeHistoryMessage, readVisibleMessageEvidence, stableMessageFingerprint })
Object.assign(module.exports, { extractPlatformIdentity, conversationPlatformId, conversationListScroll, allowsLegacyConversationName })
