// P2-17B.2 采集结果分类：把"成功读取但无新增 / 确实没有评论 / 评论区未加载 /
// 内容不存在 / 图文类型不支持 / 登录 / 验证 / 限流 / 超时 / 其它错误"分开。
//
// 硬规矩：只有「真的读到了评论」或「评论区明确显示暂无评论」时，才能对这个视频下
// "没有交友价值"的结论。读取失败、评论区没加载出来、被风控挡住，都只是"没读到"，
// 不能算成视频无价值——否则下一轮又会把可用视频静默丢掉。
const COLLECTION_CODES = {
  VIDEO_COMMENTS_BELOW_MIN: { label: '视频评论不足', ok: false, judgeable: false, reason: '视频总评论数低于本批门槛', nextAction: '继续下一个视频' },
  READ_CANCELLED: { label: '读取任务已切换', ok: false, judgeable: false, reason: '旧任务结果已忽略', nextAction: '等待当前任务完成后继续' },
  READ_TARGET_MISMATCH: { label: '作品身份不一致', ok: false, judgeable: false, reason: '页面不是本次目标作品', nextAction: '查看读取现场后继续' },
  COLLECTED_NEW: {
    label: '读取成功·有新增评论', ok: true, judgeable: true,
    reason: '本次读到并入库了新的评论', nextAction: '',
  },
  COLLECTED_NO_NEW: {
    label: '读取成功·无新增评论', ok: true, judgeable: true,
    reason: '读取成功，本次评论都已在素材库中（不是没有评论）', nextAction: '可直接用库内已有评论判断价值',
  },
  NO_COMMENTS: {
    label: '确实没有评论', ok: true, judgeable: true,
    reason: '评论区已加载并明确显示暂无评论', nextAction: '',
  },
  PANEL_NOT_LOADED: {
    label: '评论区未加载', ok: false, judgeable: false,
    reason: '页面打开了但评论区没有渲染出可读内容', nextAction: '稍后重试或人工打开该视频确认评论区是否正常',
  },
  COMMENTS_CLOSED: {
    label: '评论已关闭', ok: false, judgeable: false,
    reason: '作者关闭了评论，无法读取', nextAction: '换一个允许评论的视频',
  },
  VIDEO_NOT_FOUND: {
    label: '内容不存在或不可访问', ok: false, judgeable: false,
    reason: '作品不存在、已删除或链接已失效', nextAction: '换一个视频来源',
  },
  CONTENT_UNSUPPORTED: {
    label: '内容类型不支持', ok: false, judgeable: false,
    reason: '当前读取通道不支持该内容类型（如直播/合集等）', nextAction: '跳过该内容，改用视频或图文作品',
  },
  LOGIN_REQUIRED: {
    label: '登录态不可用', ok: false, judgeable: false,
    reason: '当前账号的抖音登录态不可用', nextAction: '在应用内重新登录后重试',
  },
  VERIFICATION_REQUIRED: {
    label: '需要安全验证', ok: false, judgeable: false,
    reason: '抖音要求完成验证码/滑块验证', nextAction: '在收集窗口完成验证后继续',
  },
  RATE_LIMITED: {
    label: '被限流', ok: false, judgeable: false,
    reason: '抖音限制了本次读取频率', nextAction: '稍后继续，已采集内容不会丢',
  },
  TIMEOUT: {
    label: '读取超时', ok: false, judgeable: false,
    reason: '页面在限定时间内没有返回可读评论', nextAction: '稍后重试',
  },
  NETWORK_ERROR: {
    label: '页面/网络错误', ok: false, judgeable: false,
    reason: '读取过程中页面或网络出错', nextAction: '检查网络后重试',
  },
  ERROR: {
    label: '未知错误', ok: false, judgeable: false,
    reason: '读取失败且未归入已知类别', nextAction: '查看该视频的原始错误信息后重试',
  },
}

// 采集器/传输层错误码 → 统一分类。只做映射，不改变原始错误文本。
const CODE_MAP = {
  VIDEO_COMMENTS_BELOW_MIN: 'VIDEO_COMMENTS_BELOW_MIN',
  READ_CANCELLED: 'READ_CANCELLED', READ_TARGET_MISMATCH: 'READ_TARGET_MISMATCH',
  VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
  VIDEO_ID_UNRESOLVED: 'VIDEO_NOT_FOUND',
  LINK_RESOLVE_UNAVAILABLE: 'VIDEO_NOT_FOUND',
  COMMENTS_CLOSED: 'COMMENTS_CLOSED',
  COMMENTS_UNAVAILABLE: 'PANEL_NOT_LOADED',
  CONTENT_UNSUPPORTED: 'CONTENT_UNSUPPORTED',
  NOTE_UNSUPPORTED: 'CONTENT_UNSUPPORTED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CHALLENGE: 'VERIFICATION_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  NO_TRANSPORT: 'ERROR',
  NO_ADAPTER: 'ERROR',
}

function isTimeout(result) {
  return /timeout|timed out|超时/i.test(String(result?.reason || result?.error || ''))
}

function classifyCollection(result, extra = {}) {
  const added = Number(extra.added ?? result?.added ?? 0) || 0
  const fetched = Number(extra.fetched ?? result?.fetched ?? 0) || 0
  const existing = Number(extra.existing ?? result?.existing ?? 0) || 0
  const emptySeen = extra.emptySeen === true || result?.empty === true

  if (result?.ok) {
    if (added > 0) return build('COLLECTED_NEW', { added, fetched })
    if (fetched > 0) return build('COLLECTED_NO_NEW', { added, fetched })
    // 库内已有评论、本次未重复读取（已达本次上限）：是"无新增"，不是"没评论"。
    if (existing > 0) return build('COLLECTED_NO_NEW', { added, fetched })
    if (emptySeen) return build('NO_COMMENTS', { added, fetched })
    // 读取"成功"但一条都没读到、也没有"暂无评论"证据：只能算评论区没加载出来。
    return build('PANEL_NOT_LOADED', { added, fetched })
  }

  const raw = String(result?.code || '').trim()
  // 超时要优先于通用网络错误识别：页面 18s 没返回和断网要分开统计。
  const code = raw === 'TIMEOUT' || ((raw === 'NETWORK_ERROR' || !raw) && isTimeout(result))
    ? 'TIMEOUT'
    : (CODE_MAP[raw] || (isTimeout(result) ? 'TIMEOUT' : 'ERROR'))
  return build(code, { added, fetched, rawCode: raw, detail: String(result?.reason || result?.error || '') })
}

function build(code, { added = 0, fetched = 0, rawCode = '', detail = '' } = {}) {
  const preset = COLLECTION_CODES[code] || COLLECTION_CODES.ERROR
  return {
    code, label: preset.label, ok: preset.ok, judgeable: preset.judgeable,
    reason: preset.reason, nextAction: preset.nextAction,
    newComments: added, fetched, rawCode: rawCode || '', detail: detail ? String(detail).slice(0, 300) : '',
  }
}

// 批次队列项的诊断摘要：只保留可追溯的字段，避免把整段 DOM 文本带进批次状态。
function diagnose(queueItem) {
  const code = queueItem?.code || ''
  const preset = COLLECTION_CODES[code] || null
  return {
    code: code || null,
    label: preset?.label || '',
    judgeable: preset ? preset.judgeable : null,
    reason: String(queueItem?.error || queueItem?.reason || preset?.reason || '').slice(0, 200),
    stages: queueItem?.stages || null,
  }
}

module.exports = { COLLECTION_CODES, CODE_MAP, classifyCollection, diagnose }
