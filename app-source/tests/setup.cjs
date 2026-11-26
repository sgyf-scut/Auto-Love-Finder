// 测试引导：把 require('electron') 重定向到测试桩
const Module = require('node:module')
const path = require('node:path')

const originalResolve = Module._resolveFilename
if (!Module.__xushengStubbed) {
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return path.join(__dirname, 'electron-stub.cjs')
    return originalResolve.call(this, request, ...args)
  }
  Module.__xushengStubbed = true
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

// 内存存储桩（实现 JsonStorage 的最小接口）
function createMemoryStorage(initial = {}) {
  let state = {
    version: 2,
    automation: { autoReply: true, paused: false, sparks: [], dailyLimit: 30, maxPerContactDaily: 12, blacklist: [], aiDisabledContacts: [] },
    contacts: [],
    providers: [],
    aiSkills: [],
    logs: [],
    sendHistory: [],
    pendingDrafts: [],
    appearance: { theme: 'auto', defaultTone: '' },
    settings: {
      primaryChatEngine: 'legacy', // 存量用例锁定 Legacy 基线；生产默认已切到 simple_v3
      videoReplyEnabled: true, videoRecognitionEnabled: true, videoAnalysisFirst: true, videoRecognitionMode: 'smart', multiCandidateReply: false,
      twoMessageChance: 0, // 默认关：需要测试双消息的用例显式设为 1
      showAiModelLabel: true, failoverEnabled: true, longTermMemory: true, aiReplyDraftOnly: false,
      proactiveChat: { enabled: false, maxPerDay: 2, windowStart: '10:00', windowEnd: '22:00', minIntervalMinutes: 180, sendToDraft: false },
    },
    ...initial,
  }
  // Legacy queue tests exercise immediate processing explicitly. Production
  // JsonStorage defaults burst buffering ON; new burst tests opt in here.
  // `...initial` above replaces the whole settings object when a test passes any
  // settings, so the engine pin must be re-applied here or existing Legacy tests
  // would silently run on the new simple_v3 production default.
  state.settings = { ...state.settings, primaryChatEngine: initial.settings?.primaryChatEngine ?? 'legacy', incomingBurstEnabled: initial.settings?.incomingBurstEnabled ?? false, favoriteStickerEnabled: initial.settings?.favoriteStickerEnabled ?? false }
  return {
    get: () => structuredClone(state),
    update(patch) { state = deepMerge(state, patch || {}); return structuredClone(state) },
    addLog(entry) { state.logs = [{ id: Date.now(), at: new Date().toISOString(), ...entry }, ...state.logs].slice(0, 150); return structuredClone(state) },
    _raw: () => state,
  }
}

module.exports = { createMemoryStorage }
