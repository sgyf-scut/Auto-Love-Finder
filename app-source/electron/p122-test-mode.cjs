// P1-22 真人聊天实测：联系人级测试开关 + 运行日志。
//
// 设计原则：
//  - 默认关闭。只有 userData/p122-test-mode.json 存在且 enabled=true 时生效。
//  - 只影响配置里点名的联系人；其他联系人的生产行为完全不变（仍是 30 条窗口、仍走原自动回复开关）。
//  - 不修改 Prompt、不修改 Context Builder、不修改联系人资料/记忆。
//  - 日志默认匿名：只写 anonymousId，不写真实昵称；会话原文只落本地受限目录。
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const FILE_NAME = 'p122-test-mode.json'
const STOP_PATTERN = /(别发了|不要再发|不用再发|别回我|不用回我|不用回了|不想聊了|不想继续聊|到此为止|停止联系|别再联系|不要联系我|删了吧|拉黑)/
// 会话列表里的系统提示（火花提醒、系统消息等）不是对方发来的真实消息，绝不能被当成新消息回复。
const SYSTEM_PREVIEW_PATTERN = /(火花|系统消息|对方已|消息已发出|撤回了一条消息|加入了群聊|安全提示|账号异常)/

const cache = { at: 0, value: null }
const CACHE_MS = 1500

function configPath() {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function readConfig() {
  const now = Date.now()
  if (cache.value && now - cache.at < CACHE_MS) return cache.value
  let value = null
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    if (raw && raw.enabled === true && Array.isArray(raw.contacts) && raw.contacts.length) {
      let mtime = 0
      try { mtime = fs.statSync(configPath()).mtimeMs } catch { mtime = 0 }
      const activatedAt = Number.isFinite(Date.parse(raw.activatedAt)) ? Date.parse(raw.activatedAt) : mtime
      value = {
        batch: String(raw.batch || 'p122-default'),
        recentMessages: 25,
        activatedAt,
        logDir: typeof raw.logDir === 'string' && raw.logDir.trim() ? raw.logDir.trim() : '',
        contacts: raw.contacts.map((item, index) => ({
          name: String(item?.name ?? item?.id ?? '').trim(),
          anonymousId: String(item?.anonymousId || `C${index + 1}`).trim(),
        })).filter(item => item.name),
      }
    }
  } catch { value = null }
  cache.at = now
  cache.value = value
  return value
}

function invalidate() { cache.at = 0; cache.value = null }

// 联系人级解析：返回 null 表示该联系人不在本轮测试范围。
function modeForContact(contact) {
  const config = readConfig()
  if (!config) return null
  const ids = [contact?.id, contact?.name].filter(Boolean).map(value => String(value).trim())
  const hit = config.contacts.find(item => ids.includes(item.name))
  if (!hit) return null
  return { batch: config.batch, recentMessages: config.recentMessages, anonymousId: hit.anonymousId, logDir: config.logDir, activatedAt: config.activatedAt }
}

// 测试开始前就存在的消息、以及会话列表的系统提示，都不应该触发自动回复。
// 返回原因字符串表示应忽略；返回空字符串表示可以正常处理。
function ignoreReason({ preview, sentAt, mode }) {
  if (!mode) return ''
  if (SYSTEM_PREVIEW_PATTERN.test(String(preview || ''))) return 'SYSTEM_PREVIEW'
  const time = Number(sentAt) || (Number.isFinite(Date.parse(sentAt)) ? Date.parse(sentAt) : 0)
  if (time && mode.activatedAt && time < mode.activatedAt - 60000) return 'PRE_TEST_MESSAGE'
  return ''
}

function isTestContact(contact) { return modeForContact(contact) !== null }

// 是否有启用中的测试联系人：用于阻止聊天窗口在测试期间休眠。
function isTestModeActive() {
  const config = readConfig()
  return Boolean(config && config.contacts.length)
}

function logDirOf(mode) {
  if (mode.logDir) return mode.logDir
  return path.join(app.getPath('userData'), 'p122-runtime', mode.batch)
}

function append(mode, row) {
  const dir = logDirOf(mode)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'runtime-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), batch: mode.batch, contact: mode.anonymousId, ...row })}\n`, 'utf8')
}

function detectStopRequest(text) {
  return STOP_PATTERN.test(String(text || ''))
}

// 生成记录：输入（system + user 实际文本）、输出、动作、用量、traceId、历史窗口。
function recordGeneration({ mode, contact, traceId, historyWindow, messages, result, latencyMs, gapMs }) {
  try {
    append(mode, {
      type: 'generation',
      traceId,
      historyWindow,
      contactStage: contact?.relationshipJourney?.currentStage || null,
      historyAvailable: Array.isArray(contact?.learning?.messages) ? contact.learning.messages.length : 0,
      gapMs: Number.isFinite(gapMs) ? gapMs : null,
      incomingMessages: (contact?.__p122Incoming || []).map(row => ({ role: 'contact', text: String(row.text || '') })),
      system: messages?.[0]?.content || '',
      user: messages?.[1]?.content || '',
      action: result?.action || null,
      messages: result?.messages || [],
      handoff: result?.handoff ?? null,
      reason: result?.reason ?? null,
      usage: result?.metadata?.usage || null,
      model: result?.metadata?.model || null,
      engine: result?.metadata?.engine || null,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      sent: null,
    })
  } catch { /* 诊断写入失败不得影响正常聊天 */ }
}

function recordStopRequest({ mode, contact, incoming, traceId }) {
  try {
    append(mode, { type: 'stop-request', traceId, incoming: String(incoming || ''), action: 'auto-send-disabled', note: '对方明确要求停止联系：已加入 AI 停发名单并转为人工处理。' })
  } catch { /* ignore */ }
}

// 明确停止要求：该联系人加入 AI 停发名单；其他联系人不受影响。
function handleStopRequest(ai, { mode, contact, incoming, traceId }) {
  recordStopRequest({ mode, contact, incoming, traceId })
  try {
    const state = ai.storage.get()
    const list = state.automation?.aiDisabledContacts || []
    if (!list.includes(contact.name)) {
      ai.storage.update({ automation: { ...state.automation, aiDisabledContacts: [...list, contact.name] } })
    }
    ai.storage.addLog?.({
      type: 'p122_stop_request',
      message: `P1-22：检测到停止联系要求，已停止对 ${contact.name} 的自动发送`,
      detail: { anonymousId: mode.anonymousId, batch: mode.batch, traceId },
    })
  } catch { /* ignore */ }
}

module.exports = { FILE_NAME, configPath, readConfig, invalidate, modeForContact, isTestContact, isTestModeActive, ignoreReason, detectStopRequest, recordGeneration, recordStopRequest, handleStopRequest, logDirOf, STOP_PATTERN, SYSTEM_PREVIEW_PATTERN }
