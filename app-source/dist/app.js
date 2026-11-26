// v2 渲染层：无框架、无动画、事件全量委托。
// 可靠性设计：
// - 所有按钮通过单一 document 级 click 委托 + data-act 分发表处理，重渲染不会丢失监听；
// - 异步操作期间按钮自动禁用（busy），避免重复提交导致的"点了没反应"；
// - 设置项通过 data-path 声明存储路径，change 事件自动保存，无需依赖渲染时机。
//
// 渲染分层（修复"滚动被重置/下拉自动关闭"）：
// - 结构渲染 render()：仅在切换页面、切换联系人、打开/关闭编辑表单时执行，并保持滚动位置；
// - 数据补丁 refreshDynamic()：后台事件（轮询同步/日志/状态）只替换列表容器，
//   带"焦点保护"（容器内有输入焦点就跳过）和"滚动保持"（替换前后恢复 scrollTop），
//   表单区域永远不被后台事件触碰——展开中的下拉选项不会被销毁。
const api = window.desktopApp

const LOG_LABELS = {
  message_sent: '发送消息', send_error: '发送失败', send_blocked: '发送受限',
  friend_followed: '交友关注',
  friendship_auto: '自动交友', friendship_auto_error: '自动交友暂停',
  relationship_plan: '交友话题选择', video_opening_ready: '视频配文就绪', video_opening_sent: '视频分享已发送',
  event_followup_draft: '事件跟进草稿', event_followup_sent: '事件已跟进', event_followup_failed: '事件跟进失败', event_followup_skipped: '事件跟进已跳过',
  auto_skip: '跳过（自己发的）', auto_blocked: '已拉黑跳过', auto_recheck: '暂缓重查', worker_error: '轮询异常', worker_watchdog: '轮询看门狗',
  ai_error: 'AI 调用失败', ai_backoff: 'AI 退避', ai_unavailable: 'AI 不可用', ai_empty: 'AI 空回复', ai_reply_rejected: 'AI 拒发', ai_reply_skipped: 'AI 判断不回复', ai_draft: 'AI 草稿', ai_draft_pending: '草稿待确认', ai_natural_rewrite_failed: '重写失败', ai_provider_failed: '模型切换', ai_provider_cooldown: '模型降级',
  media_text_fallback: '媒体转文本', media_skipped: '媒体跳过', media_audio_transcribed: '音频已转写', media_audio_unavailable: '音频不可用', audio_transcription_failed: '转写失败', ai_media_analysis_failed: '媒体理解失败', ai_media_analysis_unavailable: '媒体理解不可用', video_unreadable: '视频不可读', media_captured: '媒体已捕获', video_public_context_ready: '视频上下文就绪',
  language_learned: '会话学习', ai_facts_mined: '长期记忆更新', ai_topic_summarized: '话题状态更新',
  spark_sent: '问候已发送', spark_fill_skipped: '问候跳过', spark_fill_failed: '问候失败', ai_spark_draft: '问候文案', ai_spark_fallback: '问候回退',
  ai_companion_draft: '伴聊草稿', companion_sent: '伴聊已发送', companion_error: '伴聊失败',
  verification_required: '需要安全验证', verification_cleared: '验证已通过',
  memory_hygiene: '内存自动优化',
  crash: '异常', app_boot: '启动',
}

const SECTION_TITLES = { discovery: '交友发现', chat: '对话', train: '训练场', tasks: '任务', promises: '承诺中心', models: '模型', logs: '运行记录', settings: '设置' }

const S = {
  section: 'models',
  info: null,
  accounts: { active: null, accounts: [] },
  data: null, // automation state 镜像
  status: { connected: false },
  selected: '', // 当前查看的联系人名
  contactSearch: '',
  showCachedConversations: false,
  notice: null,
  noticeTimer: null,
  logFilter: { type: '', keyword: '' },
  providerEditing: null, // null 关闭；-1 新建；>=0 编辑
  modelOptions: [], // 拉取到的模型 ID 候选（仅当前表单，不落库）
  modelFetchMsg: '', // 拉取状态提示文案
  basePreviewTimer: null,
  sparkEditing: null, // null 关闭；'new' 新建
  weatherPreview: '',
  train: { name: '', log: [], draft: null, lastIncoming: '' },
  discovery: { selected: '', filter: 'pending', busy: false, notes: {} },
  library: {
    busy: false, data: null, message: '', intro: null, learning: null, learningBusy: false, learningMessage: '', evaluation: null,
    collecting: false, collectorMessage: '', review: [], skipped: [], fixKey: '', analyzeMessage: '', advanced: false,
    favoritesBusy: false, favoritesMessage: '', pipelineBusy: false, pipelineMessage: '',
    // P2-12B 自动调度摘要（同步/分析开关、下次时间、当日预算、待处理数量）。
    scheduler: null, schedulerBusy: false, schedulerMessage: '',
    // P2-12C 候选人质量统计（A/B/C/D、来源、核实状态、拒绝保护）。
    candidateStats: null,
    // P2-12A 人工基准集：盲评队列、评估结果、历史标注参考。
    benchmark: null, benchmarkEvaluation: null, benchmarkReference: null, benchmarkBusy: false, benchmarkMessage: '', benchmarkOffset: 0,
    // P2-13 双模式：自动联系配置、最近一次执行计划、Dry Run 结果。
    autoContact: null, autoPlans: null, autoBusy: false, autoMessage: '',
    // P2-14A 资格审计：发现合格 / 联系资格 / 动作授权三层分开。
    autoAudit: null,
  },
  contact: { busy: false, config: null, metrics: {}, running: false, paused: false, contactState: {}, drafts: {} },
  conversationSyncUi: { busyContactId: '' },
  selfProfileUi: { accountId: null, raw: '', pendingId: '', review: {}, editing: {}, add: {}, busy: false },
}

// ---- 工具 ----
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }) } catch { return '' } }
const isTypingIn = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')

// 提示条：只更新顶栏提示元素，绝不触发整页渲染
function showNotice(message, kind = 'ok') {
  S.notice = { message, kind }
  const el = document.getElementById('topbar-notice')
  if (el) el.outerHTML = `<div id="topbar-notice" class="notice ${kind}">${esc(message)}</div>`
  else render()
  clearTimeout(S.noticeTimer)
  // 错误提示也要自动消失：旧错误长期挂在顶栏会让人误以为是当前状态。
  S.noticeTimer = setTimeout(() => {
    S.notice = null
    const node = document.getElementById('topbar-notice')
    if (node) node.outerHTML = '<div id="topbar-notice" style="display:none"></div>'
  }, kind === 'err' ? 6000 : 2600)
}

// 数据补丁：替换容器 innerHTML，但
// 1) 容器内存在输入焦点（正在打字/选择了下拉）→ 跳过本次补丁，等下一个事件；
// 2) 替换前后保持 scrollTop，滚动位置不丢。
function patchContainer(id, html) {
  const el = document.getElementById(id)
  if (!el) return false
  if (el.contains(document.activeElement) && isTypingIn(document.activeElement)) return false
  const scrollTop = el.scrollTop
  if (typeof html === 'function' && el.closest?.('#discovery-tools:not([open])')) return false
  el.innerHTML = typeof html === 'function' ? html() : html
  el.scrollTop = scrollTop
  return true
}

// 保存/恢复整个视图的滚动位置（结构渲染用；按 section 记忆，切页归零）
const scrollMemory = { section: null, values: [] }
function captureScrolls() {
  if (scrollMemory.section === S.section) {
    scrollMemory.values = [...document.querySelectorAll('.view, .list-scroll, .contact-detail')].map((el) => ({ cls: el.className, top: el.scrollTop }))
  } else {
    scrollMemory.section = S.section
    scrollMemory.values = []
  }
}
function restoreScrolls() {
  for (const saved of scrollMemory.values) {
    const el = [...document.querySelectorAll('.view, .list-scroll, .contact-detail')].find((node) => node.className === saved.cls)
    if (el) el.scrollTop = saved.top
  }
}

// 结构渲染：切页 / 换联系人 / 表单开关时执行
function render() {
  if (!S.data) return
  applyTheme()
  captureScrolls()
  const navItems = [
    ['chat', '对话'], ['train', '训练场'], ['discovery', '交友发现'], ['tasks', '任务'], ['promises', '承诺中心'], ['models', '模型'], ['logs', '运行记录'], ['settings', '设置'],
  ]
  const views = { discovery: discoveryView, chat: chatView, train: trainView, tasks: tasksView, promises: promisesView, models: modelsView, logs: logsView, settings: settingsView }
  document.getElementById('app').innerHTML = `
    <div class="layout">
      <div class="rail">
        <div class="rail-brand">全自动找对象流水线<small>v${esc(S.info?.version || '')}</small></div>
        <div class="rail-nav">
          ${navItems.map(([key, label]) => `<button class="rail-item ${S.section === key ? 'active' : ''}" data-act="nav" data-args="${esc(JSON.stringify({ section: key }))}"><span>${label}</span></button>`).join('')}
        </div>
        <div class="rail-bottom">
          <div class="field"><label>当前账号</label><select data-act-change="switch-account">
            ${(S.accounts.accounts || []).map((a) => `<option value="${esc(a.id)}" ${S.accounts.active === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select></div>
        </div>
      </div>
      <div class="main">
        <div class="topbar">
          <h2>${SECTION_TITLES[S.section] || ''}</h2>
          ${S.notice ? `<div id="topbar-notice" class="notice ${S.notice.kind}">${esc(S.notice.message)}</div>` : '<div id="topbar-notice" style="display:none"></div>'}
        </div>
        <div class="view">${views[S.section] ? views[S.section]() : ''}</div>
      </div>
    </div>`
  restoreScrolls()
  if (S.section === 'settings') selfProfileUi().displayedSignature = selfProfileSignature()
  // 模型表单打开时，重算一次接口地址预览（render 会重建 DOM）
  if (document.getElementById('pv-base')) refreshBasePreview()
}

// 数据补丁：后台事件只刷新动态区域，绝不触碰表单
let dynamicTimer = null
function queueDynamic() {
  if (dynamicTimer) return
  dynamicTimer = setTimeout(() => {
    dynamicTimer = null
    refreshDynamic()
  }, 300)
}

function refreshDynamic() {
  if (!S.data) return
  applyTheme()
  // 顶栏状态徽标
  const pills = statusPills()
  patchContainer('topbar-status', pills)
  // 当前页面的列表区域
  if (S.section === 'chat') {
    if ((S.selected || S.selectedContactId) && !selectedConversation()) {
      S.selected = ''; S.selectedContactId = ''; render(); return
    }
    const searchEl = document.getElementById('contact-search')
    if (searchEl) S.contactSearch = searchEl.value
    patchContainer('contact-list-scroll', contactListItems())
    const contact = selectedConversation()
    if (contact) patchContainer('contact-relationship-journey', relationshipJourneyView(contact))
    if (contact) patchContainer('contact-conversation-sync', conversationSyncView(contact))
    if (contact) patchContainer('contact-shared-memory', sharedMemoryView(contact))
    const summary = document.getElementById('learn-summary')
    if (summary && contact) {
      const learning = contact.learning || {}
      summary.textContent = `最近消息 ${learning.messages?.length || 0} 条 · 长期记忆 ${learning.facts?.length || 0} 条 · 话题记录 ${learning.topicLog?.length || 0} 条 · 视频上下文 ${learning.mediaLog?.length || 0} 条`
      const facts = document.getElementById('contact-confirmed-facts')
      if (facts) facts.textContent = confirmedFactTexts(contact).join('；') || '聊天中透露的信息会逐步记入长期记忆'
      patchContainer('contact-social-memory', socialMemoryView(contact))
      patchContainer('contact-persona-lens', personaLensView(contact))
      const plan = document.getElementById('contact-relationship-plan')
      if (plan) plan.textContent = learning.relationshipPlan ? `本轮话题：${learning.relationshipPlan.selectedTopic || ''} · ${learning.relationshipPlan.reason || ''}` : ''
    }
    const hint = document.getElementById('manual-hint')
    if (hint && contact) { const preview = contactDisplayPreview(contact); hint.textContent = preview ? `对方最近：${String(preview).slice(0, 40)}` : '' }
    patchContainer('conversation-drafts', () => conversationDrafts(contact || null) + (contact ? conversationDrafts(null) : ''))
    patchContainer('chat-actions', chatActions())
  } else if (S.section === 'tasks') {
    patchContainer('sparks-list', sparksList())
  } else if (S.section === 'promises') {
    patchContainer('promises-board', promisesBoard())
  } else if (S.section === 'models') {
    patchContainer('providers-list', providersList())
  } else if (S.section === 'logs') {
    patchContainer('logs-list', logsList())
  } else if (S.section === 'discovery') {
    refreshDiscovery()
  } else if (S.section === 'settings') {
    patchContainer('conversation-sync-overview', conversationSyncOverview())
    if (selfProfileUi().displayedSignature !== selfProfileSignature()) refreshSelfProfilePanel()
  }
}

function statusPills() {
  return `<span class="pill ${S.status.connected ? 'ok' : 'err'}">${S.status.connected ? '已登录' : '未登录'}</span>
    ${S.status.verification ? '<span class="pill err">需要安全验证</span>' : ''}`
}

// ---- 数据加载 ----
function beginAccountUiTransition(id = null) {
  S.showCachedConversations = false
  S.contactSearch = ''
  S.accountEpoch = (S.accountEpoch || 0) + 1
  S.accountSwitching = true
  S.accounts = { ...S.accounts, active: id }
  S.data = { contacts: [], pendingDrafts: [], logs: [], providers: [], sparks: [], selfProfile: {pending:null}, selfPersona: {}, settings: {}, automation: {}, friendship: {}, discovery: {candidates:[]} }
  S.selected = ''; S.selectedContactId = ''; S.contactSearch = ''
  S.status = { connected: false }
  S.train = { name: '', log: [], draft: null, lastIncoming: '' }
  S.conversationSyncUi = {busyContactId:''}
  resetSelfProfileUi()
  S.discovery = { selected: '', filter: 'pending', busy: false, notes: {} }
  S.library = { busy: false, data: null, learning: null, learningBusy: false, review: [], skipped: [], fixKey: '', message: '' }
  S.contact = {busy:false,config:null,metrics:{},running:false,paused:false,contactState:{},drafts:{}}
  render()
  return S.accountEpoch
}

async function loadAll() {
  const epoch = S.accountEpoch || 0
  try {
    const [info, accounts, state] = await Promise.all([api.getInfo(), api.accounts.list(), api.automation.getState()])
    if (epoch !== (S.accountEpoch || 0)) return
    S.info = info
    S.accounts = accounts
    S.data = state
    S.accountSwitching = false
    if (!S.selected && state.contacts?.length) S.selected = state.contacts[0].name
    render()
    // Optional status and contact summaries must not delay the first usable view.
    const accountId = accounts.active
    const status = await api.douyin.getStatus().catch(() => ({ connected: false }))
    if (epoch !== (S.accountEpoch || 0) || S.accounts.active !== accountId) return
    S.status = status
    queueDynamic()
    if (api.contact?.getState) await refreshContactState(accountId).catch(() => {})
    if (epoch === (S.accountEpoch || 0) && S.accounts.active === accountId) queueDynamic()
  } catch (error) {
    if (epoch !== (S.accountEpoch || 0)) return
    document.getElementById('app').innerHTML = `<div class="empty">初始化失败：${esc(error.message)}</div>`
  }
}

api.onDouyinEvent((event) => {
  if (S.accountSwitching) return
  if (!S.data || (event.accountId && event.accountId !== S.accounts.active)) return
  const { type, payload } = event
  if (type === 'contacts' && Array.isArray(payload?.contacts)) {
    S.data.contacts = payload.contacts
    if (payload.renamed && Object.prototype.hasOwnProperty.call(payload.renamed, S.selected)) {
      S.selected = payload.renamed[S.selected]
      render()
    }
  }
  else if (type === 'drafts' && Array.isArray(payload?.drafts)) S.data.pendingDrafts = payload.drafts
  else if (type === 'log' && payload) S.data.logs = [payload, ...(S.data.logs || [])].slice(0, 150)
  else if (type === 'verification') S.status.verification = Boolean(payload?.required)
  else if (type === 'friendship_auto' && payload) {
    S.data.friendship = { ...(S.data.friendship || {}), ...(payload.friendship || payload) }
  }
  else if (type === 'discovery_progress' && payload?.discovery) S.data.discovery = payload.discovery
  else if (type === 'discovery_goal_sample') {
    if (S.section === 'discovery' && discoveryWorkspaceTab() === 'labels') {
      const local = S.discovery
      clearTimeout(local.goalRefreshTimer)
      local.goalRefreshTimer = setTimeout(() => {
        if (S.discovery === local && S.section === 'discovery' && discoveryWorkspaceTab() === 'labels') loadGoalSamples()
      }, 250)
    }
  }
  else if (type === 'discovery_batch') {
    // 批次进度事件：只更新状态并刷新批次区域，不重建整页
    if (payload?.batch) { const st = batchState(); st.revision = (st.revision || 0) + 1; st.data = payload.batch }
    if (S.section === 'discovery') queueBatchRefresh()
  }
  else if (type === 'library_collector' && payload?.collector) {
    if (S.library.data) S.library.data.collector = payload.collector
    if (S.section === 'discovery') {
      patchContainer('collector-panel', () => collectorView())
      patchContainer('discover-home', () => discoverHomeView())
    }
  }
  else if (type === 'library_favorites' && payload?.favorites) {
    if (S.library.data) S.library.data.favorites = payload.favorites
    if (S.section === 'discovery') {
      patchContainer('favorites-panel', () => favoritesSyncView())
      patchContainer('discovery-overview', () => discoveryOverviewView())
    }
  }
  else if (type === 'discovery_pipeline' && payload?.pipeline) {
    if (S.library.data) S.library.data.pipeline = payload.pipeline
    if (S.section === 'discovery') {
      patchContainer('pipeline-panel', () => pipelineView())
      patchContainer('discovery-overview', () => discoveryOverviewView())
    }
  }
  // P2-12B：自动调度状态由主进程推送；只补丁调度区，不打断正在输入的盲评标签。
  else if (type === 'discovery_scheduler' && payload?.scheduler) {
    S.library.scheduler = payload.scheduler
    if (S.section === 'discovery') {
      patchContainer('scheduler-panel', () => schedulerView())
      patchContainer('discovery-overview', () => discoveryOverviewView())
    }
  }
  else if (type === 'contact_progress' && payload) applyContactState(payload)
  else if (type === 'conversation_sync' && payload) {
    if (payload.accountId && payload.accountId !== S.accounts.active) return
    if (!applyConversationSync(payload.conversationSync, S.accounts.active)) return
  }
  else if (type === 'video_opening_progress' && payload?.name === S.selected) {
    const progress = document.getElementById('video-opening-progress')
    if (progress) progress.textContent = payload.phase || ''
  }
  queueDynamic()
})

api.accounts.onChanged(async () => {
  const epoch = beginAccountUiTransition()
  try {
    const accounts = await api.accounts.list()
    if (S.accountEpoch !== epoch) return
    S.accounts = accounts
    const state = await api.automation.getState()
    if (S.accountEpoch !== epoch) return
    S.data = state
    S.accountSwitching = false
    if (api.contact?.getState) await refreshContactState(accounts.active)
    if (S.accountEpoch !== epoch) return
    render(); batchPoll()
    if (S.section === 'discovery') { loadDiscoveryMode(); loadBatch() }
  } catch (error) {
    if (S.accountEpoch === epoch) { S.accountSwitching = false; showNotice(error.message || '账号资料加载失败，请重试', 'err'); render() }
  }
})

setInterval(async () => {
  const epoch = S.accountEpoch || 0
  const status = await api.douyin.getStatus().catch(() => null)
  if (epoch !== (S.accountEpoch || 0) || S.accountSwitching) return
  if (status) { S.status = status; queueDynamic() }
}, 30000)

// 主题应用
function applyTheme() {
  const theme = S.data?.appearance?.theme || 'auto'
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

// ---- 视图片段 ----
function contactsInConversationOrder(contacts) {
  // 平台列表包含置顶会话，不能用保存顺序或“刚刚”推算它的实际顺序。
  // 仅使用同步层从抖音列表滚动位置核验的位置；未加载资料稳定保留。
  const position = contact => contact?.conversationListPositionSource === 'douyin_list_geometry'
    && Number.isFinite(contact.conversationListPosition) && contact.conversationListPosition >= 0
    ? contact.conversationListPosition : Infinity
  const observedAt = contact => {
    const value = Date.parse(contact?.conversationListObservedAt || '')
    return Number.isFinite(value) ? value : 0
  }
  return (Array.isArray(contacts) ? contacts : []).map((contact, index) => ({ contact, index, position: position(contact), observedAt: observedAt(contact) }))
    .sort((left, right) => {
      if (left.position !== right.position) return left.position < right.position ? -1 : 1
      if (Number.isFinite(left.position) && left.observedAt !== right.observedAt) return right.observedAt - left.observedAt
      return left.index - right.index
    }).map(item => item.contact)
}

function contactDisplayPreview(contact) {
  const observed = contact?.observedChatPreview
  const fallback = contact?.preview || ''
  const listMessageKey = String(contact?.messageKey || fallback || '')
  if (observed?.source !== 'verified_chat_dom' || !observed.messageId || !['contact', 'me'].includes(observed.role)
    || typeof observed.text !== 'string' || !observed.text.trim()
    || !listMessageKey || observed.baseListMessageKey !== listMessageKey
    || contact.conversationIdentityAmbiguous === true) return fallback
  const ids = [contact.platformUserId, contact.profile?.platformUserId].filter(value => typeof value === 'string' && value)
  const verifiedIds = [contact.identityVerified === true ? contact.platformUserId : '',
    contact.profile?.dmIdentityVerified === true || contact.profile?.identityVerified === true ? contact.profile?.platformUserId : ''].filter(Boolean)
  if (!verifiedIds.length || new Set(ids).size !== 1 || !ids[0] || observed.platformUserId !== ids[0]) return fallback
  return observed.text
}

function visibleConversations() {
  return (S.data.contacts || []).filter(c => S.showCachedConversations || c.conversationListCurrent !== false)
}
function selectedConversation() {
  const contacts = visibleConversations()
  return (S.selectedContactId && contacts.find(contact => String(contact.id) === S.selectedContactId))
    || contacts.find(contact => contact.name === S.selected)
}
function conversationsWithPendingWork() {
  const byId = new Map(), byName = new Map()
  for (const contact of S.data.contacts || []) {
    if (contact.id) byId.set(String(contact.id), contact)
    byName.set(contact.name, byName.has(contact.name) ? null : contact)
  }
  const scoped = new Map()
  for (const item of [...(S.data.pendingDrafts || []), ...(S.data.expressionBatches || []).filter(batch => batch.status !== 'sent')]) {
    const key = (item.contactId ? byId.get(String(item.contactId)) : byName.get(item.name)) || null
    if (key?.conversationListCurrent === false && !S.showCachedConversations) continue
    if (!scoped.has(key)) scoped.set(key, new Set())
    scoped.get(key).add(item)
  }
  return scoped
}
function conversationDrafts(contact, work = conversationsWithPendingWork()) {
  const items = work.get(contact)
  if (!items?.size) return ''
  const heading = contact ? '待审核' : '待归属的草稿与发送记录'
  return `<section class="panel"><h3>${heading}</h3>${contact ? '' : '<p class="muted">同步并核对联系人后，可在对应对话处理发送。</p>'}${draftsList(item => items.has(item), Boolean(contact))}</section>`
}
function contactListItems() {
  const selected = selectedConversation()
  const contacts = contactsInConversationOrder(visibleConversations()).filter((c) => !S.contactSearch || String(c.name || '').includes(S.contactSearch))
  if (!contacts.length) return '<div class="empty">暂无联系人<br/><span class="muted">打开登录窗口并进入私信页后，点击"同步联系人"</span></div>'
  const pending = conversationsWithPendingWork()
  return contacts.map((contact) => {
    const active = contact === selected ? ' active' : ''
    const disabled = (S.data.automation.aiDisabledContacts || []).includes(contact.name)
    const unread = contact.unread ? '<span class="ci-unread">未读</span>' : ''
    const cached = contact.conversationListCurrent === false ? ' <span class="muted" title="本轮抖音列表未加载此会话，保留资料与上次消息">历史缓存</span>' : ''
    return `<button class="contact-item${active}" data-act="select-contact" data-args="${esc(JSON.stringify({ name: contact.name, id: contact.id }))}">
      <span class="ci-top"><span class="ci-name">${esc(contact.name)}${disabled ? ' <span class="muted">(AI关)</span>' : ''}</span>${unread}</span>
      <span class="ci-preview">${pending.has(contact) ? '<span class="pill">待审核</span> ' : ''}${esc(contactDisplayPreview(contact))}${cached}</span>
    </button>`
  }).join('')
}

function chatActions() {
  const auto = S.data.automation
  return `
    <button class="btn ${auto.autoReply && !auto.paused ? 'primary' : ''}" data-act="toggle-auto">${auto.autoReply ? '自动回复：开' : '自动回复：关'}</button>
    <button class="btn ${auto.paused ? 'danger' : ''}" data-act="toggle-pause" ${auto.autoReply ? '' : 'disabled'}>${auto.paused ? '已暂停，点击恢复' : '暂停自动回复'}</button>
    <button class="btn" data-act="open-login">打开登录窗口</button>
    <button class="btn" data-act="sync-contacts">同步联系人</button>
    ${statusPills()}`
}

function friendshipContact(contact) { return contact?.profile?.chatMode === 'friendship' || (!contact?.profile?.chatMode && contact?.profile?.useSelfPersona === true) }
function confirmedFactTexts(contact) {
  if (!friendshipContact(contact) || !contact.socialBrain) return (contact?.learning?.facts || []).map(item => typeof item === 'string' ? item : item?.text || '').filter(Boolean)
  const labels = { province: '籍贯省份', city: '所在城市', occupation: '职业', school: '学校', major: '专业', interest: '兴趣', current_life: '近况' }
  return (contact.socialBrain.facts || []).filter(f => f.status === 'fact').map(f => `${labels[f.field] || '信息'}：${f.value}`)
}
function eventWindowText(event) {
  const window = event?.followUpWindow || {}
  const start = window.startAt || window.start || window.from || event?.followUpAt
  const end = window.endAt || window.end || window.to
  return start ? `${fmtTime(start)}${end ? ` ～ ${fmtTime(end)}` : ''}` : '时间待确认'
}
function socialMemoryView(contact) {
  const friendship = friendshipContact(contact)
  const memory = contact?.socialBrain || {}
  const labels = { province: '籍贯省份', city: '所在城市', occupation: '职业', school: '学校', major: '专业' }
  const unknowns = Object.entries(labels).filter(([key]) => memory.profile?.identity?.[key]?.status !== 'fact').map(([, label]) => label)
  const inferred = (memory.inferences || []).slice(-4).map(item => esc(item.content)).join('；')
  const events = (memory.events || []).slice(-5)
  const attempts = (memory.learningHistory || []).slice(-4)
  const results = { pending: '等待回应', answered: '已了解', avoided: '暂不追问' }
  const eventStatus = { upcoming: '等待跟进窗口', due: '已到跟进窗口', followed_up: '已跟进', resolved: '聊天中已解决', cancelled: '已取消', stale: '窗口已过期' }
  const followUpStatus = { pending: '等待跟进', needs_date: '等待日期', wait_for_more_info: '等待更多信息', draft: '草稿待审核', drafted: '草稿待审核', failed: '发送失败，可重试', uncertain: '发送结果未确认', skipped: '已跳过', resolved_in_chat: '聊天中已解决' }
  const eventView = events.length ? `<h3 style="margin-top:12px">事件记忆与跟进</h3>${events.map(item => `<p>${esc(item.description)} · ${esc(eventStatus[item.status] || followUpStatus[item.followUp?.status] || '已记录')}<br/><span class="muted">事件日期：${esc(item.eventAt || item.dueDate || '待确认')} · 跟进窗口：${esc(eventWindowText(item))}${followUpStatus[item.followUp?.status] ? ` · ${esc(followUpStatus[item.followUp.status])}` : ''}</span></p>`).join('')}` : ''
  if (!friendship) return eventView
  return `<h3 style="margin-top:12px">逐步了解的信息</h3><p class="muted">尚未了解：${esc(unknowns.join('、') || '上述基本信息已有记录')}。遇到合适的话题再了解。</p>
    ${inferred ? `<p class="muted">未确认的推测：${inferred}</p>` : ''}
    ${eventView}
    ${attempts.length ? `<p class="muted">最近了解过：${attempts.map(item => `${labels[item.topic] || '信息'} · ${results[item.result] || '已记录'}`).join('；')}</p>` : ''}
    ${(memory.legacyMemories || []).length ? `<details><summary class="muted">旧版记忆笔记（待核实）</summary><p class="muted">${memory.legacyMemories.slice(-8).map(item => esc(item.content)).join('；')}</p></details>` : ''}`
}
const CONVERSATION_SYNC_LABELS = { WAITING_CONVERSATION: '等待会话出现', DISCOVERED: '已发现会话', IDENTITY_VERIFIED: '身份已核验', READY: '可自动聊天', TEMP_UNAVAILABLE: '暂时不可用', IDENTITY_PENDING: '身份待核验', NEEDS_REVIEW: '需要人工核对' }
const CONVERSATION_SYNC_REASONS = {
  identity_unverified: '尚未核验会话身份', identity_pending: '会话身份等待核验', identity_verified: '会话身份已核验',
  new_evidence: '收到新证据，等待同步核验', manual_window_visible: '抖音窗口正在由你操作，隐藏窗口后继续核验',
  identity_unknown: '尚未取得可靠的平台用户 ID', platform_identity_conflict: '平台用户 ID 与预期身份不一致，需要人工核对',
  same_name_different_id: '发现同名但平台用户 ID 不同的联系人，需要人工核对', retry: '等待下次重试',
  conversation_unavailable: '会话暂时无法定位，等待重试', waiting_conversation: '等待会话出现在私信列表',
  contact_changed: '联系人资料已变化，等待同步核验', contact_discovered: '发现新联系人，等待同步核验',
  new_incoming: '收到新消息，等待同步核验', reconnect: '账号已重新连接，等待同步核验', locate_failed: '会话定位失败，等待重试',
  follow_confirmed: '关注已确认，等待会话同步', opening_confirmed: '首句已确认，等待会话同步', first_reply: '收到首次回复，等待接管核验',
}
function conversationSyncAccount() {
  return (S.data?.conversationSync?.accounts || []).find(item => item.accountId === S.accounts.active) || { accountId: S.accounts.active, records: [] }
}
function applyConversationSync(value, accountId) {
  if (!S.data || !value || accountId !== S.accounts.active || value.accountId !== accountId || !Array.isArray(value.records)) return false
  const root = S.data.conversationSync || { version: 1, accounts: [] }
  S.data.conversationSync = { ...root, accounts: [...(root.accounts || []).filter(item => item.accountId !== accountId), value] }
  return true
}
function syncTime(value) {
  return value && Number.isFinite(new Date(value).getTime()) ? fmtTime(value) : '暂无'
}
function conversationSyncView(contact) {
  const account = conversationSyncAccount()
  const matches = (account.records || []).filter(item => contact.id && (item.contactId === contact.id || item.contactIds?.includes(contact.id)))
  const record = matches.length === 1 ? matches[0] : null
  const status = matches.length > 1 ? 'NEEDS_REVIEW' : record?.status || 'IDENTITY_PENDING'
  const reason = matches.length > 1 ? '联系人关联多条会话记录，需要人工核对' : record?.reason || '尚无可靠会话核验记录，请重新同步核验'
  const args = esc(JSON.stringify({ contactId: contact.id, accountId: S.accounts.active }))
  return `<h3>会话接管</h3><p><span class="pill ${status === 'READY' ? 'ok' : ''}">${esc(CONVERSATION_SYNC_LABELS[status] || '身份待核验')}</span></p>
    <p class="muted" style="margin-top:8px;overflow-wrap:anywhere">${esc(CONVERSATION_SYNC_REASONS[reason] || reason)}</p>
    <p class="muted" style="margin-top:8px">下次重试：${esc(syncTime(record?.nextRetryAt))} · 最近同步：${esc(syncTime(record?.lastSyncedAt || account.lastSyncedAt))}<br/>最近发现：${esc(syncTime(record?.lastObservedAt))} · 最近核验：${esc(syncTime(record?.lastVerifiedAt))}</p>
    <p class="muted" style="margin-top:8px">旧联系人保留兼容聊天定位；新人自动接管需核验身份，仅昵称匹配不足以接管。聊天仍受 AI 开关、自动回复开关、暂停、黑名单和发送额度限制。</p>
    <button class="btn small" style="margin-top:8px" data-act="conversation-sync-refresh" data-args='${args}' ${!contact.id || S.conversationSyncUi.busyContactId === contact.id || !api.douyin?.refreshConversationSync ? 'disabled' : ''}>${S.conversationSyncUi.busyContactId === contact.id ? '正在同步核验…' : '重新同步核验'}</button>`
}
function conversationSyncOverview() {
  const account = conversationSyncAccount(), records = account.records || []
  const counts = Object.entries(CONVERSATION_SYNC_LABELS).map(([status, label]) => `${label} ${records.filter(item => item.status === status).length}`).join(' · ')
  return `<h3>会话同步概况</h3><p class="muted">${esc(counts)}</p><p class="muted" style="margin-top:8px">每10分钟补齐会话，使用现有轮询轻量观察；关注确认、首句确认和首次回复会请求定向同步核验。</p><p class="muted" style="margin-top:8px">最近同步：${esc(syncTime(account.lastSyncedAt))} · 最近补齐：${esc(syncTime(account.lastReconciledAt))} · 下次补齐：${esc(syncTime(account.nextReconcileAt))}</p>`
}
function contactDetail(contact) {
  const profile = contact?.profile || {}
  const learning = contact?.learning || {}
  const aiOff = (S.data.automation.aiDisabledContacts || []).includes(S.selected)
  const blacked = (S.data.automation.blacklist || []).includes(S.selected)
  if (!contact) return '<div class="empty">从左侧选择一个联系人</div>'
  return `
    <div class="panel" id="contact-conversation-sync">${conversationSyncView(contact)}</div>
    <div class="panel">
      <h3>联系人 · ${esc(contact.name)}</h3>
      <div class="row" style="margin-bottom:10px">
        <button class="btn small ${aiOff ? '' : 'primary'}" data-act="toggle-contact-ai" data-args='${esc(JSON.stringify({ name: contact.name }))}'>${aiOff ? '允许 AI 回复' : '禁止 AI 回复'}</button>
        <button class="btn small ${blacked ? 'danger' : ''}" data-act="toggle-contact-black" data-args='${esc(JSON.stringify({ name: contact.name }))}'>${blacked ? '移出黑名单' : '加入黑名单'}</button>
        <button class="btn small" data-act="learn-contact" data-args='${esc(JSON.stringify({ name: contact.name }))}'>学习聊天记录</button>
        <button class="btn small danger" data-act="clear-learning" data-args='${esc(JSON.stringify({ name: contact.name }))}'>清除学习数据</button>
      </div>
      <div class="field"><label>联系人备注</label><input data-cf="notes" value="${esc(profile.notes || '')}" /></div>
      ${contactOriginView(profile)}
      <div class="row" style="margin-top:10px">
        <button class="btn primary" data-act="save-profile">保存资料</button>
        <span class="muted" id="learn-summary">最近消息 ${learning.messages?.length || 0} 条 · 长期记忆 ${learning.facts?.length || 0} 条 · 话题记录 ${learning.topicLog?.length || 0} 条 · 视频上下文 ${learning.mediaLog?.length || 0} 条</span>
      </div>
      <div style="margin-top:12px"><h3>对方已确认的信息</h3><p class="muted" id="contact-confirmed-facts">${esc(confirmedFactTexts(contact).join('；') || '聊天中透露的信息会逐步记入长期记忆')}</p>
      <div id="contact-social-memory">${socialMemoryView(contact)}</div>
      <div id="contact-persona-lens">${personaLensView(contact)}</div>
      <div id="contact-shared-memory">${sharedMemoryView(contact)}</div>
      <p class="muted" id="contact-relationship-plan" style="margin-top:6px">${learning.relationshipPlan ? `本轮话题：${esc(learning.relationshipPlan.selectedTopic || '')} · ${esc(learning.relationshipPlan.reason || '')}` : ''}</p></div>
    </div>
    <div class="panel">
      <h3>手动发送</h3>
      <div class="field"><textarea id="manual-text" placeholder="输入要发送的内容"></textarea></div>
      <div class="row" style="margin-top:8px">
        <button class="btn primary" data-act="manual-send">发送</button>
        <button class="btn" data-act="ai-draft">AI 拟回复</button>
        <span class="muted" id="manual-hint">${contactDisplayPreview(contact) ? `对方最近：${esc(String(contactDisplayPreview(contact)).slice(0, 40))}` : ''}</span>
      </div>
    </div>
    <div class="panel"><h3>分享视频＋一句话</h3><p class="muted">AI 从风景、宠物、轻松搞笑视频中搜索并挑选，生成评价或引用真实评论。先单独发视频链接，再发一句配文，共两条消息。</p>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="video-create" data-args='${esc(JSON.stringify({ name: contact.name }))}'>AI 找视频并配一句</button></div>
      <p class="muted" id="video-opening-progress" style="margin-top:8px"></p>
      <div id="video-opening-preview" style="margin-top:10px">${videoOpeningPreview(contact.name)}</div>
    </div>`
}

function contactOriginView(profile) {
  const origin = (profile && profile.contact_origin) || {}
  const platform = origin.platform || 'douyin'
  const sourceType = origin.source_type || 'video_comments'
  const ref = origin.video_url || origin.video_id || ''
  return `<details style="margin-top:10px"><summary class="muted">认识来源（选填，仅在对方问起时提供给 AI）</summary>
    <div class="grid2" style="margin-top:8px">
      <div class="field"><label>认识平台</label><select data-cfo="platform">
        ${[['douyin', '抖音'], ['wechat', '微信'], ['xiaohongshu', '小红书'], ['other', '其他']].map(([v, t]) => `<option value="${v}" ${platform === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
      <div class="field"><label>认识方式</label><select data-cfo="source_type">
        ${[['video_comments', '视频评论区'], ['video_dm', '视频私信'], ['search', '搜索'], ['friend_referral', '朋友介绍'], ['other', '其他']].map(([v, t]) => `<option value="${v}" ${sourceType === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
      <div class="field"><label>视频主题或场景</label><input data-cfo="video_topic" value="${esc(origin.video_topic || '')}" placeholder="如：交友" /></div>
      <div class="field"><label>视频链接或 ID（不知道就留空）</label><input data-cfo="video_ref" value="${esc(ref)}" placeholder="留空表示未确认" /></div>
      <div class="field" style="grid-column:1/-1"><label>备注（选填）</label><input data-cfo="note" value="${esc(origin.note || '')}" /></div>
      <div class="field" style="grid-column:1/-1"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-cfo="verified" ${origin.verified_by_user === false ? '' : 'checked'} style="width:auto" />以上是我确认过的事实（未勾选不会提供给 AI）</label></div>
    </div>
  </details>`
}

function videoOpeningPreview(name) {
  const video = (S.data.videoGreetings?.pending || []).find(item => item.name === name)
  if (!video) return ''
  const args = esc(JSON.stringify({ id: video.id }))
  return `<strong>${esc(video.title)}</strong><p class="muted" style="margin:6px 0;overflow-wrap:anywhere">${esc(video.url)}<br/>${esc(video.reason || '')} · ${video.source === 'comment' ? '引用实际评论' : '视频评价'}</p>
    ${video.status === 'uncertain' ? '<p class="muted">上次发送结果未确认，请检查抖音记录后丢弃此草稿，避免重复发送。</p>' : ''}
    ${video.status === 'retryable' ? `<p class="muted">${video.videoSentAt ? '视频已发送，重试只补发配文。' : '内容尚未提交发送，可处理报错后重试。'}</p>` : ''}
    <div class="field"><textarea data-video-caption="${esc(video.id)}" maxlength="80">${esc(video.text)}</textarea></div>
    <div class="row" style="margin-top:8px"><button class="btn" data-act="video-open" data-args='${args}'>查看视频</button><button class="btn primary" data-act="video-send" data-args='${args}' ${['sending', 'uncertain'].includes(video.status) ? 'disabled' : ''}>${video.videoSentAt ? '只补发配文' : '分两条发送视频和配文'}</button><button class="btn" data-act="video-discard" data-args='${args}'>丢弃</button></div>`
}

function chatView() {
  const contact = selectedConversation()
  return `<div class="split">
    <div class="contact-list">
      <div style="padding:10px;border-bottom:1px solid var(--border)">
        <div class="field"><input id="contact-search" placeholder="搜索联系人" value="${esc(S.contactSearch)}" /></div>
        <label class="muted"><input type="checkbox" id="show-cached-conversations" ${S.showCachedConversations ? 'checked' : ''}> 显示历史缓存（未在当前列表加载的会话）</label>
      </div>
      <div class="list-scroll" id="contact-list-scroll">${contactListItems()}</div>
    </div>
    <div class="contact-detail">
      <div class="row" id="chat-actions" style="margin-bottom:12px">${chatActions()}</div>
      <div id="conversation-drafts">${conversationDrafts(contact || null)}${contact ? conversationDrafts(null) : ''}</div>
      ${contactDetail(contact)}
    </div>
  </div>`
}

function draftsList(include = () => true, canSend = true) {
  const drafts = (S.data.pendingDrafts || []).filter(include)
  const batches = expressionBatchList(include, canSend)
  if (!drafts.length) return '<div class="empty">暂无待确认草稿<br/><span class="muted">开启回复草稿模式或在任务页检查到期事件，生成的草稿会到这里等你确认</span></div>' + batches
  return drafts.map((d) => d.source === 'event_followup' ? eventDraftCard(d, canSend) : `
    <div class="card">
      <div class="card-head"><strong>${esc(d.name)}</strong><span class="muted">${fmtTime(d.at)}</span>
        ${d.model ? `<span class="pill">${esc(d.model)}</span>` : ''}<span class="spacer"></span>
        <button class="btn small primary" data-act="draft-send" data-args='${esc(JSON.stringify({ id: d.id }))}' ${!canSend || draftExpressionBlocked(d) ? 'disabled' : ''}>发送</button>
        <button class="btn small danger" data-act="draft-discard" data-args='${esc(JSON.stringify({ id: d.id }))}'>丢弃</button>
      </div>
      ${d.status === 'outdated' ? `<p style="color:var(--danger,#ef6464)">${esc(d.outdatedReason || '对方在该草稿生成后发送了新消息，草稿已过期。')}${Number.isSafeInteger(d.outdatedMessageCount) && d.outdatedMessageCount > 0 ? `新增 ${d.outdatedMessageCount} 条消息。` : ''}</p>` : ''}
      ${d.incoming ? `<div class="muted" style="margin-bottom:6px">对方：${esc(String(d.incoming).slice(0, 80))}</div>` : ''}
      ${d.videoUrl ? `<div class="muted" style="margin-bottom:6px;overflow-wrap:anywhere">视频：${esc(d.videoTitle || '')}<br/>${esc(d.videoUrl)}</div>` : ''}
      ${d.expressionBatchId ? '<p class="muted">此草稿已开始分项发送，请查看下面的发送记录；已发送的项目不会重复发送。</p>' : ''}
      ${d.expression?.mode === 'STICKER_ONLY' ? '' : `<div class="field"><textarea data-draft-text="${esc(d.id)}" ${draftExpressionBlocked(d) ? 'disabled' : ''}>${esc(d.text || '')}</textarea></div>`}
      ${expressionDraftPreview(d)}
    </div>`).join('') + batches
}

function draftExpressionBlocked(draft) {
  return ['outdated', 'sending', 'unknown', 'uncertain'].includes(draft.status) || Boolean(draft.expressionBatchId)
}

function expressionDraftPreview(draft) {
  const expression = draft.expression
  const slots = { TEASE: 1, LIKE: 2, HAPPY: 3, FLIRT: 4, SAD: 5, SURPRISED: 6, SPEECHLESS: 7, COMFORT: 8, ANNOYED: 9, GOODNIGHT: 10 }
  const slot = slots[expression?.stickerIntent]
  if (!slot || !['STICKER_ONLY', 'TEXT_AND_STICKER'].includes(expression.mode)) return ''
  const position = expression.mode === 'STICKER_ONLY' ? '只发送表情' : expression.stickerPosition === 'before_text' ? '先表情，后文字' : '先文字，后表情'
  return `<p class="muted">[表情：${esc(expression.stickerIntent)} / 收藏第${slot}个]<br/>${position}，批准后才会发送。</p>`
}

function expressionBatchList(include = () => true, canSend = true) {
  const batches = (S.data.expressionBatches || []).filter(batch => batch.status !== 'sent' && include(batch)).slice(-20).reverse()
  if (!batches.length) return ''
  const statuses = { pending: '待发送', sending: '发送中', sent: '已发送', failed: '发送失败', unknown: '结果未确认', stale: '已过期', cancelled: '已取消' }
  return `<div class="panel"><h3>文字与表情发送记录</h3>${batches.map(batch => {
    const items = Array.isArray(batch.items) ? batch.items : []
    const unknown = batch.status === 'unknown' || items.some(item => ['unknown', 'sending'].includes(item.status))
    const canResume = canSend && !unknown && ['pending', 'failed'].includes(batch.status) && items.some(item => ['pending', 'failed'].includes(item.status))
    return `<div class="card"><div class="card-head"><strong>${esc(batch.name)}</strong><span class="pill">${esc(statuses[batch.status] || batch.status)}</span><span class="spacer"></span>${canResume ? `<button class="btn small primary" data-act="expression-resume" data-args='${esc(JSON.stringify({ id: batch.id }))}'>继续未发送项</button>` : ''}</div>
      ${items.map(item => `<p class="muted">${esc(item.type === 'sticker' ? `[表情：${item.intent} / 收藏第${item.slot}个]` : item.content || '')} · ${esc(statuses[item.status] || item.status)}</p>`).join('')}
      ${unknown ? '<p class="muted">发送结果未确认，已暂停。请先检查抖音聊天记录；程序不会再次点击或继续后续项目。</p>' : ''}
      ${batch.error ? `<p class="muted">${esc(batch.error)}</p>` : ''}
    </div>`
  }).join('')}</div>`
}

function eventDraftCard(draft, canSend = true) {
  const args = esc(JSON.stringify({ id: draft.id }))
  const blocked = ['sending', 'uncertain'].includes(draft.status)
  return `<div class="card">
    <div class="card-head"><strong>${esc(draft.name)}</strong><span class="pill">事件跟进</span><span class="muted">${fmtTime(draft.at)}</span><span class="spacer"></span>
      <button class="btn small primary" data-act="event-send" data-args='${args}' ${!canSend || blocked ? 'disabled' : ''}>${draft.status === 'failed' ? '重试发送' : '发送'}</button>
      <button class="btn small" data-act="event-rewrite" data-args='${args}' ${!canSend || blocked ? 'disabled' : ''}>改写</button>
      <button class="btn small danger" data-act="event-skip" data-args='${args}' ${draft.status === 'sending' ? 'disabled' : ''}>跳过</button>
    </div>
    <p class="muted">依据：${esc(draft.reason || draft.eventDescription || '对方聊天中提到的事件')}<br/>跟进窗口：${esc(eventWindowText(draft))}</p>
    ${draft.status === 'uncertain' ? '<p class="muted">上次发送结果未确认，请先检查抖音聊天记录。此草稿已禁止再次发送，跳过会放弃本次跟进。</p>' : ''}
    ${draft.status === 'failed' ? `<p class="muted">发送失败，事件尚未标记已跟进。${esc(draft.error || '')} 重试时会重新检查打扰规则。</p>` : ''}
    <div class="field"><textarea data-draft-text="${esc(draft.id)}" maxlength="80" ${blocked ? 'disabled' : ''}>${esc(draft.text)}</textarea></div>
  </div>`
}

function sparksList() {
  const sparks = S.data.automation.sparks || []
  const kindLabel = { aiSpark: 'AI', text: '文字', emoji: '表情', combo: '组合' }
  if (!sparks.length) return '<div class="empty" style="padding:20px">还没有定时任务</div>'
  return sparks.map((task, index) => `
    <div class="card">
      <div class="card-head">
        <strong>${esc(task.name || '')}</strong>
        <span class="pill">${kindLabel[task.kind] || task.kind || '文字'} ${esc(task.time || '')}</span>
        ${task.lastRunDate ? `<span class="muted">上次执行 ${esc(task.lastRunDate)}</span>` : ''}
        <span class="spacer"></span>
        <button class="btn small" data-act="spark-toggle" data-args='${esc(JSON.stringify({ index }))}'>${task.enabled ? '停用' : '启用'}</button>
        <button class="btn small" data-act="spark-edit" data-args='${esc(JSON.stringify({ id: String(task.__id ?? task.name ?? index) }))}'>编辑</button>
        <button class="btn small" data-act="spark-send-now" data-args='${esc(JSON.stringify({ index }))}'>立即发送</button>
        <button class="btn small danger" data-act="spark-delete" data-args='${esc(JSON.stringify({ index }))}'>删除</button>
      </div>
      ${task.message ? `<div class="muted">${esc(String(task.message).slice(0, 80))}</div>` : ''}
    </div>`).join('')
}

function sparkEditForm() {
  if (S.sparkEditing === null) return ''
  const sparks = S.data.automation.sparks || []
  const task = S.sparkEditing === 'new' ? { kind: 'text', time: '09:00', enabled: true } : sparks.find((t) => String(t.__id ?? t.name ?? '') === String(S.sparkEditing)) || {}
  return `<div class="panel">
    <h3>${S.sparkEditing === 'new' ? '新建任务' : '编辑任务'}</h3>
    <div class="grid3">
      <div class="field"><label>联系人名称</label><input id="spark-name" value="${esc(task.name || '')}" /></div>
      <div class="field"><label>类型</label><select id="spark-kind">
        ${[['aiSpark', 'AI 智能问候'], ['text', '固定文字'], ['emoji', '表情'], ['combo', '文字+表情']].map(([v, t]) => `<option value="${v}" ${(task.kind || 'text') === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
      <div class="field"><label>每天发送时间</label><input id="spark-time" value="${esc(task.time || '09:00')}" placeholder="HH:MM" /></div>
      <div class="field" style="grid-column:1/-1"><label>文字内容（AI 类型可留空作为兜底文案）</label><input id="spark-message" value="${esc(task.message || '')}" /></div>
      <div class="field"><label>表情名称（emoji/combo 类型）</label><input id="spark-emoji" value="${esc(task.emojiName || '早上好')}" /></div>
      <div class="field"><label>AI 额外提示（可选）</label><input id="spark-note" value="${esc(task.aiNote || '')}" /></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-act="spark-save" data-args='${esc(JSON.stringify({ id: S.sparkEditing }))}'>保存任务</button>
      <button class="btn" data-act="spark-cancel">取消</button>
    </div>
  </div>`
}

// 搜索与评论共用候选池；人工标记与联系队列分别操作。
function discoveryReviewStatus(candidate) {
  const value = String(candidate.review?.status || candidate.status || 'pending').toLowerCase()
  return ({ review_pending: 'pending', held: 'deferred', approved_pending_contact: 'approved' })[value] || value
}
function discoveryReviewLabel(candidate) {
  return ({ pending: '待审核', approved: '符合', deferred: '暂存', rejected: '排除' })[discoveryReviewStatus(candidate)] || candidate.status || '待审核'
}
function discoveryCandidates() { return Array.isArray(S.data.discovery?.candidates) ? S.data.discovery.candidates : [] }
const CONTACT_STATUS_LABELS = { CONTACT_QUEUED: '联系队列', FOLLOW_PENDING: '等待关注通过', FOLLOWING: '正在关注', FOLLOWED: '已关注，等待首句', OPENING_SENDING: '正在发送首句', OPENING_SENT: '首句已发送', CONTACT_WAITLIST: 'Waitlist：等待私信权限', SEND_UNKNOWN: '首句发送未确认', MESSAGE_UNCERTAIN: '首句发送未确认', FOLLOW_UNCERTAIN: '关注未确认', WAITING_REPLY: '等待对方回复', REPLIED: '对方已回复', CONTACT: '已建立联系', ACTIVE: '持续互动', PAUSED: '已暂停', FAILED: '执行失败', FOLLOW_FAILED: '关注明确失败', MESSAGE_FAILED: '首句明确失败' }
const CONTACT_TEMPLATE_LABELS = { graduate: '研究生', dating: '恋爱／脱单', social: '交友', interest: '共同兴趣', default: '默认首句' }
const CONTACT_PAUSABLE_STATES = new Set(['CONTACT_QUEUED', 'FOLLOW_PENDING', 'FOLLOWED', 'CONTACT_WAITLIST', 'FAILED', 'FOLLOW_FAILED', 'MESSAGE_FAILED'])
const CONTACT_EVENT_LABELS = { first_discovered: '发现候选人', source_added: '新增发现来源', manual_review: '人工审核', public_profile_updated: '核验公开主页', candidate_scored: '更新候选评分', candidate_rechecked: '重新核验候选人', contact_queued: '加入联系队列', automatically_queued: '自动筛选加入队列', follow_started: '开始关注', follow_confirmed: '关注成功', follow_pending: '等待关注通过', follow_failed: '关注明确失败', follow_unknown: '关注结果未确认', follow_interrupted: '关注中断，待核对', opening_started: '开始发送首句', opening_confirmed: '首句发送成功', opening_sent: '首句已发送', opening_failed: '首句明确失败', opening_unknown: '首句发送未确认', opening_interrupted: '首句中断，待核对', waiting_reply: '等待对方回复', first_reply_received: '收到首次回复', friendship_handoff: '转入朋友聊天', contact_waitlisted: '等待私信权限', candidate_paused: '暂停此人联系流程', candidate_resumed: '恢复此人联系流程', pause_requested: '已请求暂停', safe_retry_queued: '明确失败步骤重新入队', legacy_imported: '导入既有交友记录' }
function contactStatus(candidate) { return String(candidate.contact?.status || candidate.status || '').toUpperCase() }
function contactCanPause(candidate) { return CONTACT_PAUSABLE_STATES.has(contactStatus(candidate)) }
function contactCanResume(candidate) { return contactStatus(candidate) === 'PAUSED' && (CONTACT_PAUSABLE_STATES.has(candidate.contact?.resumeStatus) || ['DISCOVERED', 'REVIEW_PENDING', 'APPROVED', 'APPROVED_PENDING_CONTACT'].includes(candidate.contact?.resumeStatus)) }
function contactCanRetry(candidate) { return ['FAILED', 'FOLLOW_FAILED', 'MESSAGE_FAILED'].includes(contactStatus(candidate)) && candidate.contact?.retrySafe === true }
function contactConfig() { return S.contact.config || {} }
function applyContactState(result) {
  if (!result || typeof result !== 'object') return
  if (result.config) S.contact.config = result.config
  if (result.discovery) S.data.discovery = result.discovery
  if (result.metrics) S.contact.metrics = result.metrics
  if (typeof result.running === 'boolean') S.contact.running = result.running
  if (typeof result.paused === 'boolean') S.contact.paused = result.paused
  if (result.contactState) S.contact.contactState = result.contactState
}
async function refreshContactState(accountId) {
  const local = S.contact
  const result = await api.contact.getState({ accountId })
  if (S.accounts.active !== accountId || S.contact !== local) return false
  if (result?.ok === false) throw new Error(result.error || '联系队列状态读取失败')
  applyContactState(result)
  return true
}
function discoveryBrainLabel(candidate) {
  return ({ high_priority: '高优先级', worth_reviewing: '普通候选', uncertain: '信息不足', reject: '排除' })[String(candidate.brain?.eligibility || '').toLowerCase()] || '未评估'
}
function discoveryScore(candidate) { return Number(candidate.brain?.score ?? candidate.score) || 0 }
function discoverySourceLabel(source) { return source?.type === 'user_search' || source?.sourceType === 'user_search' ? '用户搜索' : '视频评论' }
function contactMetricsView() {
  const metrics = S.contact.metrics || {}
  const rate = (part, total) => Number.isFinite(total) && total > 0 && Number.isFinite(part) ? `${(part / total * 100).toFixed(1)}%` : '—'
  const bySource = Object.entries(metrics.bySource || {})
  return `<div class="row">${[['discovered', '发现'], ['eligible', '符合'], ['approved', '批准'], ['followed', '关注'], ['openingSent', '首句'], ['replied', '回复'], ['fiveRounds', '5轮'], ['sevenDays', '7天']].map(([key, label]) => `<span class="pill">${label} ${esc(Number.isFinite(metrics[key]) ? metrics[key] : 0)}</span>`).join('')}</div>
    <h4 style="margin:14px 0 8px">来源效果（按首次发现来源与关键词统计）</h4>${bySource.length ? `<div style="overflow:auto"><table><thead><tr><th>来源／关键词</th><th>发现</th><th>首句</th><th>回复</th><th>首句率</th><th>回复率</th></tr></thead><tbody>${bySource.map(([source, counts]) => `<tr><td>${esc(source.replace(/^user_search[：:]/, '用户搜索：').replace(/^comment[：:]/, '视频评论：'))}</td>${['discovered', 'openingSent', 'replied'].map(key => `<td>${esc(Number.isFinite(counts[key]) ? counts[key] : 0)}</td>`).join('')}<td>${esc(rate(counts.openingSent, counts.discovered))}</td><td>${esc(rate(counts.replied, counts.openingSent))}</td></tr>`).join('')}</tbody></table></div><p class="muted" style="margin-top:8px">首句率＝首句／发现；回复率＝回复／首句。没有分母样本时显示“—”。</p>` : '<p class="muted">尚无来源统计样本</p>'}`
}
function contactQueueView() {
  const candidates = discoveryCandidates().filter(candidate => CONTACT_STATUS_LABELS[contactStatus(candidate)])
  const reason = S.contact.lastResultReason || S.contact.contactState?.blockedReason || S.contact.contactState?.reason || S.contact.contactState?.lastError
  return `<div class="row"><span class="pill">${contactConfig().enabled === true ? '联系引擎已开启' : '联系引擎已关闭'}</span><span class="pill">${contactConfig().mode === 'automatic' ? '自动筛选联系' : '人工批准联系'}</span>${S.contact.paused ? '<span class="pill">全队列已暂停</span>' : ''}${S.contact.running ? '<span class="pill">正在检查</span>' : ''}<span class="spacer"></span><button class="btn small" data-act="${S.contact.paused ? 'contact-global-resume' : 'contact-global-pause'}" ${S.contact.busy ? 'disabled' : ''}>${S.contact.paused ? '恢复全队列' : '暂停全队列'}</button></div>
    ${reason ? `<p class="muted" style="margin-top:8px;overflow-wrap:anywhere">检查／状态原因：${esc(reason)}</p>` : ''}
    <div style="margin-top:10px">${contactMetricsView()}</div>
    <p class="muted" style="margin:10px 0">指标来自实际记录；批准和排队不等于已关注或已发送。未回复时不追加催促。</p>
    ${candidates.map(candidate => `<button class="contact-item" data-act="discovery-select" data-args="${esc(JSON.stringify({ id: candidate.id }))}"><span class="ci-top"><strong>${esc(candidate.nickname || '昵称未提供')}</strong><span class="pill">${esc(CONTACT_STATUS_LABELS[contactStatus(candidate)])}</span></span><span class="ci-preview">${esc(candidate.contact?.reason || '')}</span>${candidate.contact?.nextCheckAt ? `<span class="muted">下次检查 ${esc(fmtTime(candidate.contact.nextCheckAt))}</span>` : ''}</button>`).join('') || '<p class="muted">联系队列和 Waitlist 暂无记录</p>'}`
}
function contactSettingsView() {
  const config = contactConfig(), drafts = S.contact.drafts || {}, value = key => drafts[key] ?? config[key]
  return `<div class="panel"><h3>联系引擎</h3><p class="muted">独立控制关注与首次招呼，默认关闭。人工模式只处理你批准加入的候选人；自动模式按硬条件和 Brain 分数选择候选人。首句只使用你写好的模板，不由AI生成；模板留空时不会联系。</p>
    <div class="grid2" style="margin-top:10px"><div class="field"><label>联系引擎开关</label><select id="contact-enabled" data-contact-config="enabled"><option value="off" ${value('enabled') !== true ? 'selected' : ''}>关闭</option><option value="on" ${value('enabled') === true ? 'selected' : ''}>开启</option></select></div><div class="field"><label>联系模式</label><select id="contact-mode" data-contact-config="mode"><option value="review" ${value('mode') !== 'automatic' ? 'selected' : ''}>人工审核后联系</option><option value="automatic" ${value('mode') === 'automatic' ? 'selected' : ''}>自动筛选后联系</option></select></div>
    ${[['dailyLimit', '每日联系上限', 3, 1, 20], ['intervalMinutes', '联系间隔（分钟）', 30, 5, 1440], ['waitlistCheckMinutes', 'Waitlist 检查间隔（分钟）', 60, 10, 1440], ['autoScoreThreshold', '自动模式最低分', 70, 0, 100]].map(([key, label, fallback, min, max]) => `<div class="field"><label>${label}</label><input id="contact-${key}" data-contact-config="${key}" type="number" min="${min}" max="${max}" value="${esc(value(key) ?? fallback)}"></div>`).join('')}</div>
    <h4 style="margin-top:14px">首次招呼模板（先留空，需要时手动填写；每项最多80字）</h4><div class="grid2">${Object.entries(CONTACT_TEMPLATE_LABELS).map(([key, label]) => `<div class="field"><label>${label}</label><textarea data-contact-template="${key}" maxlength="80" placeholder="未填写时使用默认首句，默认也为空则不联系">${esc(drafts.templates?.[key] ?? config.templates?.[key] ?? '')}</textarea></div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary" data-act="contact-save" ${S.contact.busy ? 'disabled' : ''}>保存联系设置</button><button class="btn" data-act="contact-run" ${S.contact.busy || S.contact.running || config.enabled !== true ? 'disabled' : ''}>检查联系队列</button><button class="btn" data-act="contact-refresh" ${S.contact.busy ? 'disabled' : ''}>刷新回复与候选状态</button></div>
    <p class="muted" style="margin-top:8px">Waitlist 只检查互关／私信权限；发送未确认必须人工核对，不提供一键重发。</p></div><div class="panel"><h3>联系队列 · Waitlist · 互动漏斗</h3><div id="contact-queue">${contactQueueView()}</div></div>`
}
function readContactConfig() {
  const old = contactConfig(), drafts = S.contact.drafts || {}, config = { ...old, enabled: (document.getElementById('contact-enabled')?.value ?? (drafts.enabled ?? old.enabled ? 'on' : 'off')) === 'on', mode: document.getElementById('contact-mode')?.value ?? drafts.mode ?? old.mode ?? 'review' }
  if (!['review', 'automatic'].includes(config.mode)) throw new Error('联系模式无效')
  for (const [key, fallback, min, max] of [['dailyLimit', 3, 1, 20], ['intervalMinutes', 30, 5, 1440], ['waitlistCheckMinutes', 60, 10, 1440], ['autoScoreThreshold', 70, 0, 100]]) {
    const value = Number(document.getElementById(`contact-${key}`)?.value ?? drafts[key] ?? old[key] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 请填写 ${min}～${max} 的整数`)
    config[key] = value
  }
  config.templates = { ...old.templates, ...drafts.templates }
  for (const key of Object.keys(CONTACT_TEMPLATE_LABELS)) {
    const node = [...document.querySelectorAll('[data-contact-template]')].find(el => el.dataset.contactTemplate === key)
    const text = node?.value ?? config.templates[key] ?? ''
    if (text.trim().length > 80) throw new Error('首次招呼模板不能超过80字')
    config.templates[key] = text.trim()
  }
  return config
}
async function contactOperation(btn, operation, success) {
  const local = S.contact, accountId = S.accounts.active
  if (local.busy) return
  local.busy = true
  if (btn) btn.disabled = true
  try {
    if (!api.contact) throw new Error('联系引擎接口尚未就绪，请重启助手')
    const result = await operation(accountId)
    if (S.accounts.active !== accountId || S.contact !== local) return
    applyContactState(result)
    if (!result?.ok) throw new Error(result?.error || '联系操作失败')
    local.lastResultReason = result.skipped ? (result.reason || result.contactState?.blockedReason || result.contactState?.reason || '本次没有可执行的联系任务') : ''
    if (success) showNotice(typeof success === 'function' ? success(result) : success)
    return result
  } catch (error) { if (S.accounts.active === accountId && S.contact === local) { local.lastResultReason = error.message || String(error); showNotice(local.lastResultReason, 'err') } }
  finally { local.busy = false; if (btn) btn.disabled = false; if (S.accounts.active === accountId && S.contact === local) refreshDiscovery() }
}
// P2-16.1 资料结论五态：未知 / 本人自述 / 主页公开 / 人工核实 / 信息冲突。
// 界面必须按 status 展示来源；"未核实"（没去读主页）与"未知"（读了但没有）不能混为一谈。
const FACT_STATUS_LABELS = { unknown: '未知', self_declared: '本人自述', public_profile: '主页公开', manual: '人工核实', conflict: '信息冲突', verified: '人工核实' }
const FACT_SOURCE_LABELS = { comment_text: '评论原话', profile_bio: '主页简介', manual_review: '人工核验' }
function factOf(candidate, field) {
  const fact = candidate?.profileFacts?.[field]
  if (fact && fact.status) return fact
  const legacy = field === 'age' ? candidate?.ageVerification : candidate?.genderVerification
  if (legacy && legacy !== 'unknown') return { status: legacy === 'verified' ? 'manual' : legacy, value: null, attempted: false }
  return { status: 'unknown', value: null, attempted: false }
}
function factValueText(field, value) {
  if (field === 'gender') return ({ female: '女性', male: '男性' })[value] || value
  return value
}
function factText(candidate, field, unit = '') {
  const fact = factOf(candidate, field)
  if (fact.status === 'conflict') {
    const items = (fact.conflictValues || []).map(item => `${factValueText(field, item.value)}${field === 'gender' ? '' : unit}（${FACT_SOURCE_LABELS[item.source] || item.source}）`).join(' 与 ')
    return `信息冲突：${items || '来源矛盾'}，待人工裁决`
  }
  if (fact.status === 'unknown') return fact.attempted ? '未知（已读主页，未找到公开资料）' : '未核实（尚未读取主页）'
  const label = FACT_STATUS_LABELS[fact.status] || '未知'
  const value = fact.value === null || fact.value === undefined ? '' : `${factValueText(field, fact.value)}${field === 'gender' ? '' : unit}`
  const source = FACT_SOURCE_LABELS[fact.source] || ''
  const quote = fact.quote && fact.quote.length <= 30 ? `「${fact.quote}」` : ''
  return `${value}${value ? '·' : ''}${label}${source ? '·' + source : ''}${quote ? '·' + quote : ''}`
}
function factCounts(list, field) {
  const counts = { unknown: 0, self_declared: 0, public_profile: 0, manual: 0, conflict: 0, unverified: 0 }
  for (const candidate of list || []) {
    const fact = factOf(candidate, field)
    const status = counts[fact.status] === undefined ? 'unknown' : fact.status
    counts[status] += 1
    if (status === 'unknown' && fact.attempted !== true) counts.unverified += 1
  }
  return counts
}
function factSummaryText(list, field, unit = '') {
  const counts = factCounts(list, field)
  const parts = [`${FACT_STATUS_LABELS.unknown} ${counts.unknown}`]
  if (counts.unverified) parts[0] += `（其中未读取主页 ${counts.unverified}）`
  parts.push(`${FACT_STATUS_LABELS.self_declared} ${counts.self_declared}`)
  parts.push(`${FACT_STATUS_LABELS.public_profile} ${counts.public_profile}`)
  parts.push(`${FACT_STATUS_LABELS.manual} ${counts.manual}`)
  parts.push(`${FACT_STATUS_LABELS.conflict} ${counts.conflict}`)
  return parts.join(' · ')
}
function discoveryGender(candidate) {
  const fact = candidate?.profileFacts?.gender
  if (fact && fact.status) {
    if (fact.status === 'conflict') return fact.blockingValue || 'conflict'
    if (fact.status === 'unknown') return 'unknown'
    return fact.value || 'unknown'
  }
  const value = ({ '女': 'female', '女性': 'female', '女生': 'female', '男': 'male', '男性': 'male', '男生': 'male' })[candidate.publicSignals?.genderText] || 'unknown'
  return value !== 'unknown' ? value : candidate.review?.genderConfirmation?.source === 'manual' ? candidate.review.genderConfirmation.value : 'unknown'
}
function discoveryEligibility(candidate) {
  const config = S.data.discovery?.config || {}, gender = discoveryGender(candidate), followers = candidate.publicSignals?.followerCount
  const genderFact = factOf(candidate, 'gender'), ageFact = factOf(candidate, 'age')
  if (gender === 'conflict') return '待裁决：性别信息冲突'
  if (config.targetGender === 'female' && gender === 'male') return '不符合：男性'
  if (config.requireFollowerLimit && Number.isSafeInteger(followers) && followers >= config.followerLimit) return `不符合：粉丝不少于${config.followerLimit}`
  if (config.targetGender === 'female' && gender !== 'female') return genderFact.status === 'unknown' ? '未核实性别' : '待确认性别'
  if (config.requireFollowerLimit && (!Number.isSafeInteger(followers) || followers < 0)) return '待确认粉丝数'
  if (config.requireAgeRange) {
    if (ageFact.status === 'conflict') return '待裁决：年龄信息冲突'
    const age = ageFact.status !== 'unknown' ? ageFact.value : candidate.publicSignals?.age ?? candidate.publicSignals?.ageYears ?? null
    if (!Number.isSafeInteger(age)) return ageFact.attempted ? '未知年龄（主页无公开资料）' : '未核实年龄'
    if (age < config.ageMin || age > config.ageMax) return '不符合：年龄超出范围'
  }
  if (candidate.brain?.hardGate?.passed === false) return `${discoveryBrainLabel(candidate) === '排除' ? '不符合' : '待确认'}：${candidate.brain.hardGate.reason || '硬条件待核验'}`
  return '条件符合'
}
function discoveryRunning() { return ['running', 'starting', 'searching', 'collecting', 'inspecting', 'stopping'].includes(String(S.data.discovery?.runState?.status || '').toLowerCase()) }
function discoveryText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object') return JSON.stringify(value)
  return ''
}
function discoveryStatusView() {
  const state = S.data.discovery?.runState || {}
  const labels = { idle: '未开始', running: '正在发现', completed: '本轮完成', stopped: '已停止', stopping: '正在停止', failed: '失败', blocked: '等待处理', interrupted: '上次运行已中断' }
  const counts = state.counts || {}
  return `<div class="row"><span class="pill">${esc(labels[String(state.status).toLowerCase()] || state.status || '未开始')}</span><span>${esc(state.phase || '')}</span></div>
    <p class="muted" style="margin-top:8px">${Object.entries(counts).map(([key, count]) => `${esc(({ videos: '视频', comments: '评论', candidates: '候选人', added: '新增', merged: '合并来源', invalid: '身份或来源不完整', duplicates: '重复', skipped: '跳过', searchedVideos: '已搜索视频', scannedVideos: '已读取视频', scannedComments: '已读取评论' })[key] || key)}：${esc(count)}`).join(' · ') || '尚无发现记录'}</p>
    ${state.startedAt ? `<p class="muted" style="margin-top:8px">开始：${esc(fmtTime(state.startedAt))}${state.finishedAt ? ` · 结束：${esc(fmtTime(state.finishedAt))}` : ''}</p>` : ''}
    ${state.lastError ? `<p class="notice err" style="margin-top:8px">${esc(state.lastError)}</p>` : ''}`
}
function discoveryListView() {
  const candidates = discoveryCandidates().filter(item => S.discovery.filter === 'all' || (discoveryReviewStatus(item) === S.discovery.filter && (S.discovery.filter === 'rejected' || S.discovery.brainFilter === 'reject' || !discoveryEligibility(item).startsWith('不符合')) && (S.discovery.filter !== 'approved' || discoveryEligibility(item) === '条件符合'))).filter(item => !S.discovery.brainFilter || S.discovery.brainFilter === 'all' || String(item.brain?.eligibility || '').toLowerCase() === S.discovery.brainFilter).sort((left, right) => discoveryScore(right) - discoveryScore(left))
  if (!candidates.length) return '<p class="muted">当前筛选下没有候选人。选择主题并开始发现，候选人会按主页身份去重。</p>'
  return candidates.map(candidate => {
    const source = candidate.sources?.[0] || {}
    return `<button class="contact-item${S.discovery.selected === candidate.id ? ' active' : ''}" data-act="discovery-select" data-args="${esc(JSON.stringify({ id: candidate.id }))}">
      <span class="ci-top"><strong>${esc(candidate.nickname || '昵称未提供')}</strong><span class="pill">${esc(discoveryReviewLabel(candidate))}</span></span>
      <span class="ci-preview">${esc(source.commentText || source.summary || candidate.publicProfile?.signature || '暂无来源描述')}</span>
      <span class="muted">${esc(discoveryEligibility(candidate))} · ${esc(({ female: '女性', male: '男性' })[discoveryGender(candidate)] || (factOf(candidate, 'gender').attempted ? '性别未知' : '性别未核实'))}${Number.isSafeInteger(candidate.publicSignals?.followerCount) ? ` · ${candidate.publicSignals.followerCount}粉丝` : ''}${source.isReply ? ' · 楼中楼作者' : ''}${Number.isSafeInteger(source.replyCount) ? ` · ${source.replyCount}条回复` : ''}</span>
      <span class="muted">${esc(discoverySourceLabel(source))} · ${esc(discoveryBrainLabel(candidate))} · Brain分 ${esc(candidate.brain?.score ?? '未评估')} · ${esc(source.keyword || '')}${CONTACT_STATUS_LABELS[contactStatus(candidate)] ? ` · ${esc(CONTACT_STATUS_LABELS[contactStatus(candidate)])}` : ''}</span></button>`
  }).join('')
}
function candidateGoalMatch(candidate) {
  if (candidate?.status === 'REJECTED' || candidate?.discoveryStatus === 'REJECTED' || candidate?.review?.intentConfirmation?.value === 'DO_NOT_CONTACT') return null
  const matches = (candidate?.goalMatches || []).filter(match => match.label === 'match')
  const ref = goalRef()
  return ref ? matches.findLast(match => match.id === ref.id && match.version === ref.version) || null
    : candidate?.customOnly ? matches.at(-1) : null
}
function candidateGoalRef(candidate) {
  const match = candidateGoalMatch(candidate)
  return match ? { id: match.id, version: match.version, snapshotId: match.snapshotId, key: match.key } : undefined
}
function discoveryDetailView({ workspace = false } = {}) {
  const candidate = discoveryCandidates().find(item => item.id === S.discovery.selected)
  if (!candidate) return '<p class="muted">在候选池选择一人，查看评论出处、公开简介和审核备注。</p>'
  const args = esc(JSON.stringify({ id: candidate.id }))
  const publicProfile = candidate.publicProfile || {}
  const signals = candidate.publicSignals || []
  const signalLabels = { ageText: '公开年龄文字', genderText: '公开性别', followerCount: '公开粉丝数', school: '自述学校', education: '自述学习身份', city: '自述居住城市', ipLocation: 'IP 属地', interests: '明确兴趣' }
  const entries = [...(Array.isArray(candidate.signals) ? candidate.signals.map(item => discoveryText(item)) : []), ...(Array.isArray(signals) ? signals.map(item => discoveryText(item)) : Object.entries(signals).filter(([key]) => key in signalLabels).map(([key, value]) => `${signalLabels[key]}：${Array.isArray(value) ? (value.join('、') || '待确认') : (discoveryText(value) || '待确认')}`))]
  const note = Object.hasOwn(S.discovery.notes, candidate.id) ? S.discovery.notes[candidate.id] : candidate.review?.note || ''
  const publicEntries = Object.entries(publicProfile).filter(([key, value]) => !['ready', 'platformUserId', 'capturedAt', 'profileUrl', 'url', 'nickname', 'name', 'checkedAt', 'fetchedAt', 'secUid'].includes(key) && value !== null && value !== '').map(([key, value]) => `<p style="margin-top:6px;overflow-wrap:anywhere"><span class="muted">${esc(({ description: '简介原文', signature: '简介原文', bio: '简介原文', ipLocation: 'IP 属地', city: '自述城市', rawText: '公开原文', text: '公开原文' })[key] || key)}：</span>${esc(discoveryText(value))}</p>`).join('')
  return `<div class="row"><strong>${esc(candidate.nickname || '昵称未提供')}</strong><span class="pill">${esc(discoveryReviewLabel(candidate))}</span></div>
    <p class="muted" style="margin:8px 0;overflow-wrap:anywhere">${esc(candidate.profileUrl || '')}</p>
    <div class="row"><button class="btn small" data-act="discovery-open" data-args="${args}">打开主页</button><button class="btn small" data-act="discovery-inspect" data-args="${args}" ${S.discovery.busy ? 'disabled' : ''}>读取公开简介</button></div>
    <h4 style="margin:14px 0 6px">发现来源</h4>${(candidate.sources || []).map(source => `<div class="card"><p class="muted">${esc(discoverySourceLabel(source))}</p><p style="overflow-wrap:anywhere">${esc(source.commentText || source.summary || '')}</p><p class="muted" style="margin-top:6px">主题：${esc(({ manual_tags: '手动视频标签', manual_keywords: '手动搜索关键词' })[source.topic] || (S.data.discovery?.config?.topics || []).find(t => t.id === source.topic)?.label || source.topic || '')} · 关键词：${esc(source.keyword || '')}</p>${discoverySourceLabel(source) === '视频评论' ? `<p class="muted" style="margin-top:6px">视频：${esc(source.videoTitle || source.videoId || '未知')} · 评论 ID：${esc(source.commentId || '未提供')}</p>` : ''}</div>`).join('') || '<p class="muted">暂无出处</p>'}
    ${candidate.goalMatches?.length ? `<h4>寻找目标匹配</h4>${candidate.goalMatches.map(match => `<div class="card"><b>${esc(match.name)} · 版本 ${esc(match.version)}</b><p>${esc(match.text)}</p><p class="muted">${esc(match.reason || '')} · 视频 ${esc(match.videoId || '')}</p></div>`).join('')}` : ''}
    <h4 style="margin:14px 0 6px">资料结论与来源</h4>${['age', 'gender'].map(field => {
      const fact = factOf(candidate, field), unit = field === 'age' ? '岁' : ''
      const label = FACT_STATUS_LABELS[fact.status] || '未知'
      const evidence = (fact.evidence || []).map(item => `<p class="muted" style="margin-top:2px;overflow-wrap:anywhere">· ${esc(FACT_SOURCE_LABELS[item.source] || item.source)}：${esc(String(factValueText(field, item.value)) + (field === 'gender' ? '' : unit))}${item.quote ? `「${esc(item.quote)}」` : ''}</p>`).join('')
      return `<div class="card"><p><b>${field === 'age' ? '年龄' : '性别'}</b> · <span class="pill">${esc(label)}</span></p><p class="muted" style="margin-top:2px">${esc(factText(candidate, field, unit))}</p>${evidence || '<p class="muted" style="margin-top:2px">暂无来源证据</p>'}</div>`
    }).join('')}
    <h4 style="margin:14px 0 6px">公开资料与信号</h4>${publicEntries || '<p class="muted">尚未读取公开简介</p>'}
    ${entries.map(text => `<p class="muted" style="margin-top:6px;overflow-wrap:anywhere">${esc(text)}</p>`).join('')}
    <p class="muted" style="margin-top:8px">保留公开原文与出处；含糊数字不作为年龄结论，IP 属地不等同于居住城市。</p>
    <p class="muted" style="margin-top:8px">筛选结果：${esc(discoveryEligibility(candidate))}</p>
    <h4 style="margin:14px 0 6px">Brain 判断：${esc(discoveryBrainLabel(candidate))} · ${esc(candidate.brain?.score ?? '未评估')}分</h4>
    ${(candidate.brain?.signals || []).map(signal => `<p class="muted" style="margin-top:6px">${esc(typeof signal === 'string' ? signal : signal.reason || signal.description || signal.label || discoveryText(signal))}</p>`).join('') || '<p class="muted">暂无评分依据</p>'}
    <p class="muted" style="margin-top:8px">未知信息：${esc((candidate.brain?.unknowns || []).map(discoveryText).join('、') || '暂无记录')}</p>
    <div class="field" style="margin-top:14px"><label>交友意愿等级（人工修正）</label><select id="discovery-intent" data-candidate-id="${esc(candidate.id)}">${Object.entries(LIBRARY_INTENT_LABELS).map(([value, label]) => `<option value="${value}" ${(candidate.libraryIntent || 'UNKNOWN') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <button class="btn small" data-act="discovery-intent-save" data-args="${args}" ${S.discovery.busy ? 'disabled' : ''}>保存意愿等级</button>
    <p class="muted">${candidate.review?.intentConfirmation ? '当前采用人工等级。' : ''}修正保留审核、资料证据和联系记录，不等同于对方同意私信；原批次不会因此重新执行。</p>
    <div class="field" style="margin-top:14px"><label>人工性别核验（查看主页后填写）</label><select id="discovery-gender-confirmation" data-candidate-id="${esc(candidate.id)}">${[['unknown', '未确认'], ['female', '已人工确认女性'], ['male', '已人工确认男性']].map(([value, label]) => `<option value="${value}" ${(S.discovery.genders?.[candidate.id] || candidate.review?.genderConfirmation?.value || 'unknown') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="field" style="margin-top:14px"><label>人工年龄核验（只填公开资料中明确的年龄；留空表示未核实，不是"未知"）</label><input id="discovery-age-confirmation" data-candidate-id="${esc(candidate.id)}" type="number" min="18" max="120" value="${esc(S.discovery.ages?.[candidate.id] ?? candidate.review?.ageConfirmation?.value ?? '')}"></div>
    <div class="field" style="margin-top:14px"><label>审核备注</label><textarea id="discovery-note" data-candidate-id="${esc(candidate.id)}" maxlength="1000" placeholder="记录你的判断依据">${esc(note)}</textarea></div>
    <div class="row" style="margin-top:10px">${[['APPROVED', '标记符合'], ['DEFERRED', '暂时保留'], ['REJECTED', '排除'], ['REVIEW_PENDING', '重新待审核']].map(([status, label]) => `<button class="btn small${status === 'APPROVED' ? ' primary' : ''}" data-act="discovery-review" data-args="${esc(JSON.stringify({ id: candidate.id, status }))}" ${S.discovery.busy ? 'disabled' : ''}>${label}</button>`).join('')}</div>
    <p class="muted" style="margin-top:8px">${workspace ? '人工标记只更新资料。可在下方确认首句后关注并开始聊天。' : '标记符合不会关注或发送消息；加入联系队列后，由联系引擎按开关、模板和额度执行。'}</p>
    ${workspace ? `<h4 style="margin-top:16px">开始联系</h4><button class="btn primary" data-act="workspace-approach" data-args="${args}" ${S.discovery.busy || candidate.status === 'REJECTED' || candidate.action?.firstMessageStatus === 'sent' || candidate.action?.needsReview || candidate.review?.realContact?.messageStatus === 'sent' || candidate.review?.realContact?.needsReview || (!candidateGoalMatch(candidate) && !['EXPLICIT_INVITATION','SEEKING_FRIENDS','CONTEXTUAL_INTEREST'].includes(candidate.libraryIntent)) ? 'disabled' : ''}>关注并开始聊天</button><p class="muted">确认首句后真实关注并发送；后续回复沿用当前自动回复与草稿开关。已发送或结果待核实的对象不会重复发首句。</p>${workspaceReceiptView(candidate)}` : contactCandidateDetail(candidate, args)}
    ${workspace ? '' : libraryIntroDetail(candidate, args)}`
}
function contactCandidateDetail(candidate, args) {
  const status = contactStatus(candidate), contact = candidate.contact || {}, queued = Boolean(CONTACT_STATUS_LABELS[status])
  const retry = contactCanRetry(candidate), paused = status === 'PAUSED', uncertain = ['SEND_UNKNOWN', 'FOLLOW_UNCERTAIN', 'MESSAGE_UNCERTAIN'].includes(status), delivered = ['OPENING_SENT', 'WAITING_REPLY', 'REPLIED', 'CONTACT', 'ACTIVE'].includes(status)
  return `<h4 style="margin:18px 0 8px">联系状态 · ${esc(CONTACT_STATUS_LABELS[status] || '尚未进入队列')}</h4>
    ${contact.reason ? `<p class="muted" style="overflow-wrap:anywhere">${esc(contact.reason)}</p>` : ''}${contact.nextCheckAt ? `<p class="muted" style="margin-top:8px">下次检查 ${esc(fmtTime(contact.nextCheckAt))}</p>` : ''}
    <div class="row" style="margin-top:10px">${!queued && discoveryReviewStatus(candidate) !== 'rejected' ? `<button class="btn primary small" data-act="contact-enqueue" data-args="${args}" ${S.contact.busy || S.discovery.busy ? 'disabled' : ''}>符合，加入联系队列</button>` : ''}${contactCanPause(candidate) ? `<button class="btn small" data-act="contact-pause" data-args="${args}" ${S.contact.busy ? 'disabled' : ''}>暂停</button>` : ''}${paused && contactCanResume(candidate) ? `<button class="btn small" data-act="contact-resume" data-args="${args}" ${S.contact.busy ? 'disabled' : ''}>恢复</button>` : ''}${retry ? `<button class="btn small" data-act="contact-retry" data-args="${args}" ${S.contact.busy ? 'disabled' : ''}>重试明确失败的步骤</button>` : ''}</div>
    ${uncertain ? '<p class="notice err" style="margin-top:8px">操作结果未确认，请在抖音核对记录；禁止一键重发。</p>' : ''}
    ${delivered ? '<p class="muted" style="margin-top:8px">已发送首句或进入朋友聊天；后续接聊由“对话”里的联系人 AI 开关控制。</p>' : ''}
    <h4 style="margin:14px 0 8px">联系历史</h4>${(candidate.timeline || []).slice(-20).reverse().map(item => `<div class="card"><p>${esc(CONTACT_EVENT_LABELS[String(item.type || '').toLowerCase()] || '状态更新')} · ${esc(fmtTime(item.at))}</p><p class="muted" style="margin-top:6px;overflow-wrap:anywhere">${esc(contactHistoryDetail(item.detail))}</p></div>`).join('') || '<p class="muted">暂无联系记录</p>'}`
}
function contactHistoryDetail(detail) {
  if (typeof detail === 'string') return detail
  if (!detail || typeof detail !== 'object') return ''
  const status = String(detail.status || '').toUpperCase(), source = detail.source || {}, parts = []
  const label = CONTACT_STATUS_LABELS[status] || ({ APPROVED: '已批准', APPROVED_PENDING_CONTACT: '已批准待联系', REVIEW_PENDING: '待审核', REJECTED: '已排除', DEFERRED: '暂存' })[status]
  if (label) parts.push(label)
  if (typeof detail.reason === 'string' && detail.reason) parts.push(detail.reason)
  const keyword = detail.keyword || detail.sourceKeyword || source.keyword, type = detail.sourceType || source.type
  if (type === 'user_search') parts.push('用户搜索')
  if (type === 'comment') parts.push('视频评论')
  if (typeof keyword === 'string' && keyword) parts.push(`关键词：${keyword}`)
  return parts.join(' · ')
}
function discoverySearchValues() {
  const config = S.data.discovery?.config || {}
  return {
    videoTagsText: S.discovery.videoTagsText ?? (config.videoTags || []).join('、'),
    videoKeywordsText: S.discovery.videoKeywordsText ?? (config.videoKeywords ?? (config.topics || []).filter(topic => topic.enabled).flatMap(topic => topic.keywords || [])).join('、'),
  }
}
function readDiscoverySearch() {
  const fallback = discoverySearchValues()
  const split = value => [...new Set(value.split(/[,，、;；\n]+/).map(word => word.trim()).filter(Boolean))]
  const videoTags = [...new Set(split(document.getElementById('discovery-video-tags')?.value ?? fallback.videoTagsText).map(tag => tag.replace(/^[#＃]+/, '').trim()).filter(Boolean))]
  const videoKeywords = split(document.getElementById('discovery-video-keywords')?.value ?? fallback.videoKeywordsText)
  if ([videoTags, videoKeywords].some(items => items.length > 20 || items.some(item => item.length > 80))) throw new Error('标签和关键词各最多20个，每个不超过80字')
  return { videoTags, videoKeywords }
}
const LIBRARY_VIDEO_LABELS = { friend_general: '交友综合', friend_chat: '交友聊天/找搭子', friend_local: '同城/本地交友', friend_interest: '兴趣同好', friend_romance: '相亲/恋爱倾向', irrelevant: '与交友无关', unknown: '不确定' }
const LIBRARY_INTENT_LABELS = {
  EXPLICIT_INVITATION: '明确欢迎认识或私信', SEEKING_FRIENDS: '表达交友或找搭子意愿',
  CONTEXTUAL_INTEREST: '结合视频语境可能是交友意愿', ORDINARY: '普通或无关评论',
  DO_NOT_CONTACT: '明确拒绝联系', ADVERTISEMENT: '广告、重复或不适宜', UNKNOWN: '无法判断',
}
const LIBRARY_SOURCE_LABELS = { clipboard: '剪贴板收录', manual: '手动收录', import: '文件导入', favorites: '收藏夹同步', douyin_dom: '页面读取' }
function libraryVideoStatusBadge(video) {
  const tone = video.status === 'analysis_failed' ? 'err' : (video.status === 'candidates_ready' ? 'ok' : '')
  return `<span class="muted" ${tone === 'err' ? 'style="color:#c0392b"' : tone === 'ok' ? 'style="color:#1e8e3e"' : ''}>${esc(video.statusLabel || '已导入')}</span>`
}
function libraryBodyView() {
  const data = S.library.data
  if (!data) return '<p class="muted">尚未加载素材库。点击“刷新素材库”读取本地数据。</p>'
  const stats = data.stats || {}, videos = data.videos || [], comments = data.comments || [], task = data.task || {}
  return `<div class="row" style="margin-bottom:8px;flex-wrap:wrap"><button class="btn small" data-act="library-clear" ${S.library.busy || (!stats.videos && !stats.comments) ? 'disabled' : ''}>一键清空素材库（${stats.videos || 0} 视频 / ${stats.comments || 0} 评论）</button><span class="muted">清空只删除本地收集的视频与评论、重置收集断点；账号和聊天记录不受影响。</span></div>
    <p class="muted">视频 ${stats.videos || 0} 条 · 评论 ${stats.comments || 0} 条 · 视频待标注 ${stats.videosNeedingClassification || 0} · 评论待标注 ${stats.commentsNeedingClassification || 0} · 可审核候选 ${stats.candidateReady || 0} · 已在候选池 ${stats.inPool || 0} · 缺作者ID ${stats.missingAuthorId || 0}</p>
    <p class="muted" style="margin-top:6px">视频标签统计：${Object.entries(stats.byCategory || {}).map(([key, value]) => `${esc(LIBRARY_VIDEO_LABELS[key] || key)} ${value}`).join(' · ') || '暂无'}</p>
    <p class="muted">评论意愿统计：${Object.entries(stats.byIntent || {}).map(([key, value]) => `${esc(LIBRARY_INTENT_LABELS[key] || key)} ${value}`).join(' · ') || '暂无'}</p>
    <p class="muted" style="margin-top:6px">最近分析：${esc(task.status || 'idle')} · 已处理 ${task.processed || 0}/${task.total || 0} · 模型调用 ${task.aiCalls || 0} 次${task.errors?.length ? ` · ${esc(task.errors[0].reason || '')}` : ''}</p>
    ${S.library.message ? `<p class="notice">${esc(S.library.message)}</p>` : ''}
    <h4 style="margin:12px 0 6px">已选视频（最近 ${videos.length} 条）</h4>
    ${videos.map(video => `<div class="card"><p style="overflow-wrap:anywhere">${esc(video.title || video.video_id || video.video_url || '未命名视频')} · ${libraryVideoStatusBadge(video)}</p><p class="muted" style="margin-top:4px;overflow-wrap:anywhere">ID：${esc(video.video_id || '未提供')}${video.video_url ? ` · 链接：${esc(video.video_url)}` : ''}</p><p class="muted" style="margin-top:2px">来源：${esc(LIBRARY_SOURCE_LABELS[video.source] || video.source || '未知')} · 分类：${esc(LIBRARY_VIDEO_LABELS[video.classification?.category] || '未标注')} · 评论 ${video.commentCount || 0} 条（已分析 ${video.classifiedCount || 0}）· 候选 ${video.candidateCount || 0}</p><div class="row" style="margin-top:4px"><button class="btn small" data-act="library-collect-from-video" data-args='${esc(JSON.stringify({ text: video.video_url || video.video_id || '', title: video.title || '' }))}' ${S.library.collecting ? 'disabled' : ''}>一键收集该视频评论</button></div>${(video.hashtags || []).length ? `<p class="muted" style="margin-top:2px">标签：${esc(video.hashtags.map(tag => `#${tag}`).join(' '))}</p>` : ''}<div class="field" style="margin-top:6px"><label>人工标注视频类型</label><select data-library-video="${esc(video.key)}">${['', ...Object.keys(LIBRARY_VIDEO_LABELS)].map(value => `<option value="${esc(value)}" ${video.classification?.category === value ? 'selected' : ''}>${esc(value ? LIBRARY_VIDEO_LABELS[value] : '未标注')}</option>`).join('')}</select></div></div>`).join('') || '<p class="muted">还没有视频。请在抖音收藏夹里选好一个视频，复制分享链接后用上面的“收录剪贴板视频”。</p>'}
    <h4 style="margin:12px 0 6px">评论（最近 ${comments.length} 条）</h4>
    ${comments.map(comment => {
      const intent = comment.classification?.intent
      const hint = intent === 'EXPLICIT_INVITATION' ? '原话可作为接受私信的证据' : (['SEEKING_FRIENDS', 'CONTEXTUAL_INTEREST'].includes(intent) ? '仅潜在意愿，未表示同意私信' : '')
      return `<div class="card"><p style="overflow-wrap:anywhere">${esc(comment.text || '')}</p><p class="muted" style="margin-top:4px">${esc(comment.author_name || '昵称未提供')} · ${esc(comment.author_id || '缺作者ID')} · 视频 ${esc(comment.video_id || '未提供')} · 意愿：${esc(LIBRARY_INTENT_LABELS[intent] || '未标注')}${hint ? `（${esc(hint)}）` : ''} · 候选：${esc(comment.candidate?.status || 'unmapped')}${comment.candidate?.reason ? `（${esc(comment.candidate.reason)}）` : ''}</p><div class="field" style="margin-top:6px"><label>人工标注意愿</label><select data-library-comment="${esc(comment.key)}">${['', ...Object.keys(LIBRARY_INTENT_LABELS)].map(value => `<option value="${esc(value)}" ${intent === value ? 'selected' : ''}>${esc(value ? LIBRARY_INTENT_LABELS[value] : '未标注')}</option>`).join('')}</select></div></div>`
    }).join('') || '<p class="muted">还没有评论。可导入评论文件，或在下面粘贴评论内容。</p>'}`
}
const COLLECTOR_STATUS_LABELS = { idle: '未开始', running: '收集中', completed: '已完成', interrupted: '已中断，可继续', failed: '失败', blocked: '缺少权限' }
function collectorView() {
  const collector = S.library.data?.collector || {}
  const busy = S.library.collecting
  const canResume = Boolean(collector.videoId || collector.videoUrl) && ['interrupted', 'failed', 'blocked', 'completed'].includes(collector.status)
  return `<div class="panel" id="collector-panel"><h3>指定视频分析</h3>
    <p class="muted">视频链接 → 收集评论 → AI 自动分析 → 人工审核。只读取当前账号已登录页面上可见的公开评论，保留断点以便继续；此工具不关注、不发私信。</p>
    <div class="field" style="margin-top:8px"><label>抖音视频链接或作品 ID</label><input id="library-collect-input" maxlength="500" placeholder="https://www.douyin.com/video/7300000000000000000"></div>
    <div class="grid3" style="margin-top:8px"><div class="field"><label>最多收集条数</label><input id="library-collect-limit" type="number" min="1" max="300" value="${Number(collector.targetLimit) || 50}"></div><div class="field"><label>最多翻页数</label><input id="library-collect-pages" type="number" min="1" max="20" value="${Number(collector.maxPages) || 8}"></div><div class="field"><label>标题（可选）</label><input id="library-collect-title" maxlength="300" placeholder="留空则用页面标题"></div></div>
    <div class="row" style="margin-top:8px">
      <button class="btn primary" data-act="library-collect-comments" ${busy ? 'disabled' : ''}>${busy ? '收集中…' : '收集评论'}</button>
      <button class="btn" data-act="library-resume-collect" ${busy || !canResume ? 'disabled' : ''}>继续收集（从第 ${(Number(collector.pages) || 0) + 1} 页恢复）</button>
      <button class="btn" data-act="library-refresh" ${busy ? 'disabled' : ''}>刷新素材库</button>
    </div>
    <p class="muted" style="margin-top:6px">状态：${esc(COLLECTOR_STATUS_LABELS[collector.status] || '未开始')}${collector.code ? ` · 原因代码 ${esc(collector.code)}` : ''}${collector.pages ? ` · 已读 ${collector.pages} 页` : ''}${collector.fetched ? ` · 页面读取 ${collector.fetched} 条` : ''}${collector.collected ? ` · 新增 ${collector.collected} 条` : ''}${collector.duplicates ? ` · 去重 ${collector.duplicates} 条` : ''}${collector.phase ? ` · ${esc(collector.phase)}` : ''}</p>
    ${collector.lastError ? `<p class="notice">${collector.finishedAt ? `上次（${esc(fmtTime(collector.finishedAt))}）：` : ''}${esc(collector.lastError)}${collector.nextAction ? `；下一步：${esc(collector.nextAction)}` : ''}</p>` : ''}
    ${S.library.collectorMessage ? `<p class="notice">${esc(S.library.collectorMessage)}</p>` : ''}
    <p class="muted" style="margin-top:6px">没有权限时请用下方“备用：手动导入评论”。学习用评论允许缺少作者 ID，但缺少作者 ID 的评论不会进入可联系候选池。</p>
  </div>`
}
function libraryReviewView() {
  const review = S.library.review || []
  if (!review.length) return '<div id="library-review"></div>'
  return `<div class="panel" id="library-review"><h3>本次收集的待复核评论（${review.length} 条）</h3><p class="muted">已按模型不确定程度排序：先确认或修改类别，再决定是否作为训练案例。确认结果写入 P2-09 学习库。</p>${review.map(sample => learningSampleCard(sample)).join('')}</div>`
}
// 审核后同步“本次收集待复核列表”：已确认/已排除的条目从列表消失，保留仍在待复核的。
function refreshLibraryReview() {
  if (!S.library.review.length) return
  const pending = new Map((S.library.learning?.pending || []).map(sample => [sample.key, sample]))
  S.library.review = S.library.review.map(sample => pending.get(sample.key)).filter(Boolean)
  const host = document.getElementById('library-review')
  if (host) host.outerHTML = libraryReviewView()
}
function libraryView() {
  return `${collectorView()}
    <div class="panel"><h3>本地素材库（P2）</h3><p class="muted">主流程已简化为一键收集；下面的手动收录与导入保留作为备用。系统不抓取网页、不自动关注、不自动私信。</p>
    <h4 style="margin:12px 0 6px">备用：手动收录视频</h4>
    <p class="muted">在抖音收藏夹选好视频后复制分享链接，点“收录剪贴板视频”；也可以直接粘贴链接或作品 ID。</p>
    <div class="field" style="margin-top:8px"><label>视频链接或作品 ID</label><input id="library-video-input" maxlength="500" placeholder="https://www.douyin.com/video/7300000000000000000"></div>
    <div class="grid3" style="margin-top:8px"><div class="field"><label>标题（可选）</label><input id="library-video-title" maxlength="300" placeholder="评论区上方显示的标题"></div><div class="field"><label>标签（可选，逗号分隔）</label><input id="library-video-hashtags" maxlength="300" placeholder="交友,同城"></div><div class="field"><label>主题（可选）</label><input id="library-video-topic" maxlength="60" placeholder="同城交友"></div></div>
    <div class="row" style="margin-top:8px"><button class="btn" data-act="library-collect-clipboard" ${S.library.busy ? 'disabled' : ''}>收录剪贴板视频</button><button class="btn" data-act="library-collect-video" ${S.library.busy ? 'disabled' : ''}>收录输入的视频</button><label class="btn">导入视频文件<input id="library-file" type="file" accept=".json,.jsonl,.csv,.txt" style="display:none"></label></div>
    <p class="muted" style="margin-top:6px">视频文件支持 JSON／JSONL／CSV；评论可在下面单独导入。</p>
    <h4 style="margin:14px 0 6px">备用：手动导入评论</h4>
    <div class="field"><label>粘贴评论（JSON 数组／JSONL／CSV）</label><textarea id="library-paste" rows="4" placeholder='例如：{"video_id":"7300000000000000001","comment_text":"dd","author_id":"MS4wLj...","author_name":"某人"}'></textarea></div>
    <div class="row"><button class="btn small" data-act="library-paste-import">导入粘贴的评论</button></div>
    <h4 style="margin:14px 0 6px">评论分析</h4>
    <div class="row"><button class="btn" data-act="library-classify" ${S.library.busy ? 'disabled' : ''}>运行评论分析</button><span class="muted" style="margin-left:8px">短评论（dd、蹲、有没有湖南的…）会结合所属视频主题判断；分析不发送任何消息。</span></div>
    <h4 style="margin:14px 0 6px">查看候选评论</h4>
    <div class="row"><button class="btn primary" data-act="library-candidates" ${S.library.busy ? 'disabled' : ''}>生成候选评论</button><span class="muted" style="margin-left:8px">候选只进入统一候选池，状态保持待审核。</span></div>
    <h4 style="margin:14px 0 6px">人工审核与首次联系</h4>
    <p class="muted">在“统一候选池”里查看每条候选的意愿标签，审核通过后才可准备开场白。来源视频与评论始终显示在视频列表中。</p>
    <div id="library-body" style="margin-top:12px">${libraryBodyView()}</div></div>
    ${libraryReviewView()}
    <div id="learning-panel">${learningView()}</div>`
}
// ── P2-09 评论学习面板 ──────────────────────────────────────────────────────
function learningConfidenceText(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2)
}
function learningSampleCard(sample, { annotated = false } = {}) {
  const ai = sample.ai, human = sample.human
  const intent = human?.intent || ai?.intent || null
  const label = intent ? (LIBRARY_INTENT_LABELS[intent] || intent) : '未分类'
  const evidence = (ai?.evidence || []).join('；')
  const args = esc(JSON.stringify({ key: sample.key }))
  const videoLine = [sample.videoTitle, sample.videoTopic ? `主题 ${sample.videoTopic}` : '', sample.videoCategory ? `类型 ${LIBRARY_VIDEO_LABELS[sample.videoCategory] || sample.videoCategory}` : ''].filter(Boolean).join(' · ')
  return `<div class="card">
    <p style="overflow-wrap:anywhere"><b>${human ? '人工' : 'AI'}：${esc(label)}</b>${ai ? ` · 置信度 ${learningConfidenceText(ai.confidence)}${ai.needsReview ? ' · 需复核' : ''}${ai.scheme ? ` · ${esc(ai.scheme === 'rule' ? '规则' : ai.scheme === 'model_cases' ? '规则+豆包+案例' : '规则+豆包')}` : ''}` : ' · 尚未分类'}</p>
    <p style="margin-top:4px;overflow-wrap:anywhere">${esc(sample.text || '')}</p>
    <p class="muted" style="margin-top:4px;overflow-wrap:anywhere">视频：${esc(videoLine || '背景信息缺失')}${sample.videoId ? ` · ID ${esc(sample.videoId)}` : ''}</p>
    ${ai?.reason ? `<p class="muted" style="margin-top:2px">分类依据：${esc(ai.reason)}${evidence ? ` · 证据「${esc(evidence)}」` : ''}</p>` : ''}
    ${human ? `<p class="muted" style="margin-top:2px">人工依据：${esc(human.reason)} · ${esc((human.at || '').slice(0, 16))}${sample.split === 'eval' ? ' · 独立评估集' : sample.split === 'train' ? ' · 训练案例' : ''}</p>` : ''}
    <div class="row" style="margin-top:6px">
      <button class="btn small primary" data-act="learning-confirm" data-args='${args}' ${!ai || sample.human ? 'disabled' : ''}>确认 AI 正确</button>
      <button class="btn small" data-act="learning-unknown" data-args='${args}' ${sample.human?.intent === 'UNKNOWN' ? 'disabled' : ''}>无法判断</button>
      <button class="btn small" data-act="learning-exclude" data-args='${args}' ${sample.excluded ? 'disabled' : ''}>${sample.excluded ? '已排除' : '排除样本'}</button>
    </div>
    ${sample.excluded ? `<p class="muted" style="margin-top:2px">已人工排除：${esc(sample.excludeReason || '')}（不进入复核、训练案例或评估）</p>` : ''}
    <div class="field" style="margin-top:6px"><label>手动标注意愿（保存后覆盖人工标签，不会被后续模型覆盖）</label><select data-learning-intent="${esc(sample.key)}">${['', ...Object.keys(LIBRARY_INTENT_LABELS)].map(value => `<option value="${esc(value)}" ${human?.intent === value ? 'selected' : ''}>${esc(value ? LIBRARY_INTENT_LABELS[value] : '未标注')}</option>`).join('')}</select></div>
    <div class="row" style="margin-top:4px"><label><input type="checkbox" data-learning-training="${esc(sample.key)}" ${sample.useForTraining ? 'checked' : ''}> 用作训练案例</label><label><input type="checkbox" data-learning-eval="${esc(sample.key)}" ${sample.independentEval ? 'checked' : ''}> 划入独立评估集</label></div>
  </div>`
}
function learningView() {
  const data = S.library.learning
  if (!data) return `<div class="panel"><h3>评论分类纠错</h3><p class="muted">尚未加载。点击下方按钮读取本地学习样本。</p><div class="row" style="margin-top:8px"><button class="btn" data-act="learning-refresh">加载评论学习</button></div></div>`
  const stats = data.stats || {}, active = data.activeVersion || {}
  const evaluation = S.library.evaluation
  const scheme = key => evaluation?.scopes?.eval?.[key]
  const line = (name, key) => {
    const item = scheme(key)
    if (!item) return `${name}：无数据`
    const pct = value => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(0)}%`)
    return `${name}：准确率 ${pct(item.accuracyOnDecided)}（有结论 ${item.decided}/${item.total}）· 召回 ${pct(item.recall)} · 弃权 ${pct(item.abstainRate)} · 拒绝联系命中 ${pct(item.refusalRecall)}${item.refusalFalsePositive ? `（误伤 ${item.refusalFalsePositive}）` : ''}`
  }
  return `<div class="panel"><h3>评论分类纠错</h3>
    <p class="muted">人工标签单独存储，模型运行只追加预测，绝不覆盖人工结论。训练案例与独立评估集按视频互斥，评估集不会进入相似案例检索。</p>
    <p class="muted" style="margin-top:6px">样本 ${stats.samples || 0} · 已人工标注 ${stats.annotated || 0} · 待标注 ${stats.pending || 0} · 需复核 ${stats.needsReview || 0} · 训练案例 ${stats.trainCases || 0} · 独立评估 ${stats.evalSamples || 0}（视频 ${(stats.evalVideos || []).length} 个）</p>
    <p class="muted">人工标签分布：${Object.entries(stats.byHuman || {}).map(([key, value]) => `${LIBRARY_INTENT_LABELS[key] || key} ${value}`).join(' · ') || '暂无'}</p>
    <p class="muted">当前分类器：${esc(active.id || 'builtin')} · 提示词 ${esc(active.promptVersion || 'comment-v1')} · topK ${esc(active.config?.topK ?? 3)} · 训练案例 ${esc(active.sampleCount ?? 0)}</p>
    ${S.library.learningMessage ? `<p class="notice">${esc(S.library.learningMessage)}</p>` : ''}
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      <button class="btn small" data-act="learning-refresh" ${S.library.learningBusy ? 'disabled' : ''}>刷新学习样本</button>
      <button class="btn small" data-act="review-clear" ${S.library.learningBusy || !stats.pending ? 'disabled' : ''}>清空待确认（${stats.pending || 0} 条）</button>
      <button class="btn small" data-act="learning-classify-rule" ${S.library.learningBusy ? 'disabled' : ''}>① 原始规则分类</button>
      <button class="btn small" data-act="learning-classify-model" ${S.library.learningBusy ? 'disabled' : ''}>② 规则 + 豆包</button>
      <button class="btn small primary" data-act="learning-classify-cases" ${S.library.learningBusy ? 'disabled' : ''}>③ 规则 + 豆包 + 相似案例</button>
      <button class="btn small" data-act="learning-batch-confirm" ${S.library.learningBusy ? 'disabled' : ''}>批量确认高置信</button>
      <button class="btn small" data-act="learning-splits" ${S.library.learningBusy ? 'disabled' : ''}>按视频划分训练／评估</button>
      <button class="btn small" data-act="learning-evaluate" ${S.library.learningBusy ? 'disabled' : ''}>评估三种方案</button>
      <button class="btn small" data-act="learning-version-create" ${S.library.learningBusy ? 'disabled' : ''}>保存分类配置</button>
      <button class="btn small" data-act="learning-version-rollback" ${S.library.learningBusy || (data.versions || []).length < 2 ? 'disabled' : ''}>切换上一分类配置</button>
    </div>
    <p class="muted" style="margin-top:6px">豆包分类只补规则弃权的评论；每条评论最多 30 次调用预算，不自动无限重试。交友意愿不等于同意私信，只有“明确欢迎认识或私信”才可作为私信依据。</p>
    ${evaluation ? `<div style="margin-top:10px"><h4 style="margin:0 0 6px">独立评估集（按视频划分，无泄漏）</h4><p class="muted">${line('① 原始规则', 'rule')}</p><p class="muted">${line('② 规则 + 豆包', 'model')}</p><p class="muted">${line('③ 规则 + 豆包 + 案例', 'model_cases')}</p>${evaluation.evalCount ? '' : '<p class="muted">当前没有独立评估样本：请先人工标注并按视频划分。</p>'}</div>` : ''}
    ${(data.versions || []).length ? `<p class="muted" style="margin-top:8px">历史版本：${data.versions.map(item => `${esc(item.id)}${item.active ? '（生效）' : ''} · topK ${esc(item.config?.topK ?? 3)} · ${esc((item.at || '').slice(0, 16))}`).join('；')}</p>` : ''}
    ${data.lastRun ? `<p class="muted" style="margin-top:6px">最近运行：${esc(data.lastRun.mode || '')} · ${esc(data.lastRun.status || '')} · 处理 ${data.lastRun.processed || 0}/${data.lastRun.total || 0} · 模型调用 ${data.lastRun.aiCalls || 0} 次 · token ${data.lastRun.tokens || 0}${data.lastRun.errors?.length ? ` · ${esc(data.lastRun.errors[0].reason || '')}` : ''}</p>` : ''}
    ${discoveryWorkspaceTab() === 'developer' ? '<p class="muted">日常标注已移到“所有评论 / 人工标注”，这里保留分类诊断和评估。</p>' : `    <h4 style="margin:12px 0 6px">待人工确认（按不确定程度排序，共 ${(data.pending || []).length} 条）</h4>
    ${(data.pending || []).map(sample => learningSampleCard(sample)).join('') || '<p class="muted">没有待确认的评论。规则与模型都已有确定结论，或已全部人工确认。</p>'}
    <h4 style="margin:12px 0 6px">已人工标注（最近 ${(data.annotated || []).length} 条）</h4>
    ${(data.annotated || []).map(sample => learningSampleCard(sample, { annotated: true })).join('') || '<p class="muted">还没有人工标注样本。</p>'}`}

  </div>`
}
// 素材库候选才能用本地开场白与来源映射，避免给网页发现的候选错误引导。
function libraryCandidateIds() {
  return new Set((S.library.data?.comments || []).filter(item => item.candidate?.status === 'in_pool' && item.candidate?.candidateId).map(item => item.candidate.candidateId))
}
function libraryIntroDetail(candidate, args) {
  if (!libraryCandidateIds().has(candidate.id)) return ''
  const intro = S.library.intro && S.library.intro.candidateId === candidate.id ? S.library.intro : null
  const draft = intro?.draft || null
  return `<h4 style="margin:18px 0 8px">本地素材开场白（人工确认）</h4>
    <p class="muted">只依据该候选人在本地素材库里的评论与视频信息生成；视频或评论未记录时会明确回避，不编造。发送前必须由你确认，正文可自由修改。</p>
    <div class="row" style="margin-top:8px"><button class="btn small" data-act="library-intro" data-args="${args}" ${S.library.busy ? 'disabled' : ''}>生成／刷新开场白</button><button class="btn small" data-act="library-write-origin" data-args="${args}" ${S.library.busy ? 'disabled' : ''}>写入认识来源（未确认）</button></div>
    ${intro && !intro.ok ? `<p class="notice err" style="margin-top:8px">${esc(intro.error || '无法生成开场白')}</p>` : ''}
    ${draft ? `<div class="field" style="margin-top:10px"><textarea id="library-intro-text" maxlength="300" data-library-intro="${esc(candidate.id)}">${esc(intro.text ?? draft.text ?? '')}</textarea></div><p class="muted" style="margin-top:6px">${draft.violations?.length ? `已拦截：${esc(draft.violations.join('；'))}` : (draft.warnings?.length ? esc(draft.warnings.join('；')) : '未发现编造视频或评论内容的表述')}</p><div class="row"><button class="btn small" data-act="library-intro-copy" data-args="${args}">复制开场白</button></div>` : ''}`
}
// ── P2-11A 简化主页：发现区 + 审核区，其余功能折叠到“高级管理” ────────────────
// 主页只做两件事：粘链接开始分析、审核 AI 给出的评论。收集/去重/分类全部在后台串联。
function discoverHomeView() {
  const collector = S.library.data?.collector || {}
  const busy = S.library.collecting
  const phase = collector.phase || ''
  const running = busy || collector.status === 'running'
  const canResume = Boolean(collector.videoId || collector.videoUrl) && ['interrupted', 'failed', 'blocked'].includes(collector.status)
  const counts = [collector.pages ? `已读 ${collector.pages} 页` : '', collector.fetched ? `页面 ${collector.fetched} 条` : '', collector.collected ? `新增 ${collector.collected} 条` : '', collector.duplicates ? `去重 ${collector.duplicates} 条` : ''].filter(Boolean).join(' · ')
  const reviewCount = reviewQueueSamples().length
  return `<div class="panel" id="discover-home"><h3>AI 交友发现</h3>
    <p class="muted">粘贴抖音里“复制链接”得到的整段文字即可（含标题、话题、口令都没关系），系统会自动提取链接。点“开始分析”后读取该视频页面已登录可见的评论，自动去重并按交友意愿分类，然后把需要你判断的评论列在下面。</p>
    <div class="row" style="margin-top:10px;align-items:flex-end">
      <div class="field" style="flex:1"><label>抖音视频链接或作品 ID（可整段粘贴）</label><input id="discover-link" maxlength="800" placeholder="直接粘贴整段分享口令，例如 12/17 TES… https://v.douyin.com/xxxx 复制此链接…"></div>
      <button class="btn primary" data-act="discover-analyze" ${busy ? 'disabled' : ''}>${busy ? '分析中…' : '开始分析'}</button>
      ${canResume ? `<button class="btn" data-act="discover-resume" ${busy ? 'disabled' : ''}>继续上次收集</button>` : ''}
    </div>
    <p class="muted" style="margin-top:8px">${running ? '进度：' : '状态：'}${esc(running ? (phase || COLLECTOR_STATUS_LABELS[collector.status] || '处理中') : (COLLECTOR_STATUS_LABELS[collector.status] || '未开始'))}${counts ? ` · ${esc(counts)}` : ''}${reviewCount ? ` · 待你审核 ${reviewCount} 条` : ''}</p>
    ${collector.lastError ? `<p class="notice">${esc(collector.lastError)}${collector.nextAction ? `；下一步：${esc(collector.nextAction)}` : ''}</p>` : ''}
    ${S.library.analyzeMessage ? `<p class="notice">${esc(S.library.analyzeMessage)}</p>` : ''}
    <p class="muted" style="margin-top:8px">只读取当前账号已登录页面上可见的公开评论：不构造签名接口、不绕过反爬、不自动关注、不发送私信。没有权限时会说明原因，可在“高级管理”里手动导入评论。</p>
  </div>`
}
// P2-11A 收藏夹同步：用户填写收藏夹名称，后台读取并增量入库；不读取其他收藏夹。
const FAVORITES_STATUS_LABELS = { idle: '未同步', running: '同步中', completed: '已完成', interrupted: '已中断，可重新同步', failed: '失败', blocked: '需要登录或完成验证' }
function favoritesSyncView() {
  const favorites = S.library.data?.favorites || {}
  const busy = S.library.favoritesBusy
  const folder = favorites.folderName || ''
  const running = busy || favorites.status === 'running'
  const canResume = Boolean(folder) && ['interrupted', 'failed', 'blocked', 'completed'].includes(favorites.status)
  const counts = [favorites.declaredCount ? `收藏夹声明 ${favorites.declaredCount} 个作品` : '', favorites.found ? `识别 ${favorites.found} 个` : '', favorites.added ? `新增 ${favorites.added} 个` : '', favorites.duplicates ? `去重 ${favorites.duplicates} 个` : '', favorites.scrolls ? `滚动 ${favorites.scrolls} 次` : ''].filter(Boolean).join(' · ')
  return `<div class="panel" id="favorites-panel"><h3>收藏夹自动发现（P2-11E）</h3>
    <p class="muted">填写你在抖音里创建的收藏夹名称，点“同步并自动分析”一次完成：只读取这个收藏夹里已登录页面可见的作品 → 按作品 ID 去重增量入库 → 自动收集评论 → 规则/豆包判断交友意愿 → 整理候选人。找不到同名收藏夹时会直接停止，不会把全部收藏当成交友视频。不关注、不发私信。</p>
    <div class="row" style="margin-top:10px;align-items:flex-end">
      <div class="field" style="flex:1"><label>收藏夹名称（与抖音里完全一致，只需设置一次）</label><input id="favorites-folder" maxlength="80" value="${esc(folder)}" placeholder="例如：恋爱视频"></div>
      <button class="btn primary" data-act="discovery-sync-run" ${running || busy ? 'disabled' : ''}>${running || busy ? '同步并分析中…' : '同步并自动分析'}</button>
      <button class="btn" data-act="favorites-save-folder" ${running || busy ? 'disabled' : ''}>保存名称</button>
      <button class="btn" data-act="favorites-sync" ${running || busy ? 'disabled' : ''}>仅同步收藏夹</button>
      ${canResume ? `<button class="btn" data-act="favorites-resume" ${running || busy ? 'disabled' : ''}>重新同步上次收藏夹</button>` : ''}
    </div>
    <p class="muted" style="margin-top:8px">状态：${esc(FAVORITES_STATUS_LABELS[favorites.status] || '未同步')}${counts ? ` · ${esc(counts)}` : ''}${favorites.lastSyncAt ? ` · 最近同步 ${esc(fmtTime(favorites.lastSyncAt))}` : ''}${favorites.phase ? ` · ${esc(favorites.phase)}` : ''}</p>
    ${favorites.lastError ? `<p class="notice">${esc(favorites.lastError)}${favorites.nextAction ? `；下一步：${esc(favorites.nextAction)}` : ''}</p>` : ''}
    ${S.library.favoritesMessage ? `<p class="notice">${esc(S.library.favoritesMessage)}</p>` : ''}
    <p class="muted" style="margin-top:8px">只读取已登录页面当前渲染的收藏作品，不构造签名接口、不绕过验证或限频。收藏夹声明数量与页面实际可读数量不一致时会如实显示。无法读取时可用“高级管理 → 备用：手动收录视频”粘贴分享链接，或用文件导入。</p>
  </div>`
}
// P2-12B 自动调度：每日收藏夹同步 + 自动分析队列 + 预算 + 暂停/继续。
// 所有开关和预算都由主进程持久化；界面只读摘要，不自己计算跨日。
const SCHEDULER_STATUS_LABELS = {
  idle: '未启用自动任务', waiting: '等待下一轮', running: '自动运行中', paused: '已暂停',
  blocked: '需要处理（登录/验证/页面异常）', completed: '当前没有待处理任务', budget_wait: '今日模型预算已用完',
}
const TOKEN_SOURCE_LABELS = { none: '暂无', model_returned: '模型真实返回值', estimated: '估算值', mixed: '部分真实/部分估算' }
function schedulerView() {
  const scheduler = S.library.scheduler
  const busy = S.library.schedulerBusy
  if (!scheduler) {
    return `<div class="panel" id="scheduler-panel"><h3>自动同步与分析（P2-12B）</h3>
      <p class="muted">尚未读取调度状态。点“刷新”读取当前账号的自动任务配置。</p>
      <div class="row" style="margin-top:8px"><button class="btn small" data-act="library-refresh" ${S.library.busy ? 'disabled' : ''}>刷新</button></div>
      ${S.library.schedulerMessage ? `<p class="notice">${esc(S.library.schedulerMessage)}</p>` : ''}
    </div>`
  }
  const autoSync = scheduler.autoSync === true
  const autoAnalyze = scheduler.autoAnalyze === true
  const budget = scheduler.budget || {}
  const limits = budget.limits || {}
  const paused = scheduler.status === 'paused'
  const blocked = scheduler.status === 'blocked'
  const isRunning = scheduler.status === 'running'
  const disabled = busy || isRunning
  const budgetLine = `今日模型调用 ${budget.modelCalls || 0}/${limits.dailyModelCalls || 24} 次 · Token ${budget.tokens || 0}（${TOKEN_SOURCE_LABELS[budget.tokenSource] || '暂无'}）`
  const volumeLine = `本轮已处理视频 ${budget.videos || 0} 个 · 评论 ${budget.comments || 0} 条 · 今日同步 ${budget.syncs || 0}/${limits.dailySyncCount || 1} 次`
  const scheduleLine = [
    scheduler.lastSyncAt ? `上次同步 ${fmtTime(scheduler.lastSyncAt)}` : '尚未同步',
    autoSync ? (scheduler.nextSyncAt ? `下次同步 ${fmtTime(scheduler.nextSyncAt)}` : '下次同步待排期') : '自动同步已关闭',
  ].join(' · ')
  return `<div class="panel" id="scheduler-panel"><h3>自动同步与分析（P2-12B）</h3>
    <p class="muted">开启后，软件会按本地日期自动执行：同步收藏夹 → 分析新视频评论 → 更新候选池 → 安排下一轮。每轮最多 ${limits.perRoundVideos || 10} 个视频、${limits.perRoundModelCalls || 12} 次模型调用，每天最多 ${limits.dailyModelCalls || 24} 次；预算跨轮保存，程序重启不会归零。遇到登录失效、验证码、评论不可见或页面异常会暂停并说明原因，不绕过平台限制。</p>
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      <button class="btn ${autoSync ? 'primary' : ''}" data-act="scheduler-toggle-sync" ${disabled ? 'disabled' : ''}>自动同步：${autoSync ? '开' : '关'}</button>
      <button class="btn ${autoAnalyze ? 'primary' : ''}" data-act="scheduler-toggle-analyze" ${disabled ? 'disabled' : ''}>自动分析：${autoAnalyze ? '开' : '关'}</button>
      <button class="btn" data-act="scheduler-run-now" ${disabled || (!autoSync && !autoAnalyze) ? 'disabled' : ''}>立即同步并分析一轮</button>
      ${paused || blocked ? `<button class="btn primary" data-act="scheduler-resume" ${busy ? 'disabled' : ''}>继续</button>` : `<button class="btn" data-act="scheduler-pause" ${disabled ? 'disabled' : ''}>暂停</button>`}
      <button class="btn danger" data-act="scheduler-stop" ${busy ? 'disabled' : ''}>停止自动任务</button>
    </div>
    <p class="muted" style="margin-top:8px">状态：${esc(SCHEDULER_STATUS_LABELS[scheduler.status] || scheduler.status || '未启用')}${scheduler.pending !== null && scheduler.pending !== undefined ? ` · 待处理视频 ${scheduler.pending} 个` : ''}${scheduler.nextAction ? ` · ${esc(scheduler.nextAction)}` : ''}</p>
    <p class="muted">${esc(scheduleLine)}</p>
    <p class="muted">${esc(budgetLine)} · 剩余 ${scheduler.dailyLeft ?? '—'} 次</p>
    <p class="muted">${esc(volumeLine)}</p>
    ${scheduler.lastError ? `<p class="notice">${esc(scheduler.lastError)}${scheduler.code ? `（${esc(scheduler.code)}）` : ''}${scheduler.attempts ? `；已重试 ${scheduler.attempts} 次` : ''}</p>` : ''}
    ${S.library.schedulerMessage ? `<p class="notice">${esc(S.library.schedulerMessage)}</p>` : ''}
    ${(scheduler.log || []).length ? `<p class="muted" style="margin-top:6px">最近调度：${esc((scheduler.log || []).slice(-3).reverse().map(item => `${fmtTime(item.at)} ${item.message || item.status}`).join('；'))}</p>` : ''}
  </div>`
}
// P2-11B 自动评论分析：逐视频读取评论 → 规则/豆包分类 → 记录可核对证据。
const PIPELINE_STATUS_LABELS = { idle: '未运行', running: '自动分析中', paused: '已暂停', completed: '本轮完成', interrupted: '已中断，可继续', failed: '失败', blocked: '需要登录/验证/配置模型' }
const PIPELINE_ITEM_LABELS = { pending: '待处理', running: '处理中', completed: '已完成', failed: '失败', interrupted: '中断，可继续', blocked: '受限，待处理', skipped: '已跳过' }
const PIPELINE_QUALITY_LABELS = { unknown_no_comments: '未读到评论（未判定质量）', no_evidence: '抽样未发现有效交友证据', evidence_found: '发现可核对证据', unavailable: '不可访问' }
function pipelineView() {
  const pipeline = S.library.data?.pipeline || {}
  const busy = S.library.pipelineBusy
  const running = busy || pipeline.status === 'running'
  const c = pipeline.counters || {}
  const counts = [
    `已完成视频 ${c.videosCompleted || 0}`, `失败视频 ${c.videosFailed || 0}`, `受限视频 ${c.videosBlocked || 0}`,
    `新增评论 ${c.commentsCollected || 0}`, `已分类评论 ${c.commentsClassified || 0}`,
    `模型调用 ${c.aiCalls || 0} 次`, `Token ${c.tokens || 0}`,
  ].join(' · ')
  const items = (pipeline.items || []).slice(-10).reverse()
  const failed = items.some(item => item.status === 'failed')
  const task = pipeline.task || {}
  const taskText = task.maxVideos ? `本次任务预算：最多 ${task.maxVideos} 个视频、${task.maxAiCalls} 次模型调用；已处理 ${task.videosProcessed || 0} 个视频、${task.aiCalls || 0} 次调用、${task.tokens || 0} Token` : ''
  return `<div class="panel" id="pipeline-panel"><h3>自动评论分析（P2-11B）</h3>
    <p class="muted">自动处理收藏夹里新增的视频：读取视频页允许访问的评论，先用规则分类，规则无法确定的再调用豆包。首批 12 条没有证据时会从剩余评论按位置再抽一批，两批都没有才标记“抽样未发现有效交友证据”，不直接判定视频低质量。视频没有加载出评论只记为“未判定质量”。本阶段不关注、不发私信。</p>
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      <button class="btn primary" data-act="pipeline-run" ${running ? 'disabled' : ''}>${running ? '分析中…' : (pipeline.status === 'idle' ? '开始自动分析' : '继续自动分析')}</button>
      ${running ? '<button class="btn" data-act="pipeline-pause">暂停</button>' : ''}
      ${failed ? `<button class="btn" data-act="pipeline-retry" ${running ? 'disabled' : ''}>重试失败视频</button>` : ''}
    </div>
    <p class="muted" style="margin-top:8px">状态：${esc(PIPELINE_STATUS_LABELS[pipeline.status] || '未运行')}${pipeline.phase ? ` · ${esc(pipeline.phase)}` : ''}<br>累计：${esc(counts)}${taskText ? `<br>${esc(taskText)}` : ''}</p>
    ${pipeline.lastError ? `<p class="notice">${esc(pipeline.lastError)}${pipeline.nextAction ? `；下一步：${esc(pipeline.nextAction)}` : ''}</p>` : ''}
    ${S.library.pipelineMessage ? `<p class="notice">${esc(S.library.pipelineMessage)}</p>` : ''}
    ${items.length ? `<div class="table" style="margin-top:8px"><table><thead><tr><th>视频</th><th>状态</th><th>评论</th><th>证据</th><th>模型</th><th>说明</th></tr></thead><tbody>${items.map(item => `<tr>
      <td>${esc(String(item.title || item.videoId || item.videoKey || '').slice(0, 48))}</td>
      <td>${esc(PIPELINE_ITEM_LABELS[item.status] || item.status)}</td>
      <td>${esc(`${item.classifiedCount || 0}/${item.commentsTotal || 0}`)}</td>
      <td>${esc(`${item.candidateEvidence || 0}（明确邀请 ${item.explicitInvitations || 0}）`)}</td>
      <td>${esc(`${item.modelCalls || 0} 次 · ${item.tokens || 0} Token`)}</td>
      <td>${esc([item.reason, item.quality ? PIPELINE_QUALITY_LABELS[item.quality] : ''].filter(Boolean).join(' · '))}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted" style="margin-top:8px">还没有处理记录。先在上方同步收藏夹，再点“开始自动分析”。</p>'}
    <p class="muted" style="margin-top:8px">遇到的抖音验证、限频或没有访问权限时会直接停止相关采集，不绕过限制；已收集的评论和已分类结果都会保留，恢复后不会重复请求模型。</p>
  </div>`
}
// 性别筛选：评论本身不带性别，只有“核验作者性别”读取公开主页后才写入 authorGender。
// 选“只看女性”时只显示已核验为女性的作者，未核验和男性都不显示，避免把男生推到面前。
function reviewGenderFilter() {
  if (!S.library.genderFilter) {
    try {
      const saved = localStorage.getItem('review-gender-filter')
      S.library.genderFilter = ['female', 'male'].includes(saved) ? saved : 'any'
    } catch { S.library.genderFilter = 'any' }
  }
  return ['female', 'male'].includes(S.library.genderFilter) ? S.library.genderFilter : 'any'
}
function reviewQueueSamples() {
  const skipped = new Set(S.library.skipped || [])
  const gender = reviewGenderFilter()
  // 本次收集的 review 列表不带性别，用学习库里同一 key 的核验结果补上。
  const genderByKey = new Map((S.library.learning?.pending || []).map(sample => [sample.key, sample.authorGender]))
  const source = (S.library.review?.length ? S.library.review : (S.library.learning?.pending || []))
    .map(sample => sample && !sample.authorGender && genderByKey.get(sample.key) ? { ...sample, authorGender: genderByKey.get(sample.key) } : sample)
  return source.filter(sample => sample && sample.key && !skipped.has(sample.key) && !sample.excluded && (gender === 'any' || sample.authorGender === gender)).slice(0, 30)
}
const REVIEW_SORT = sample => {
  const ai = sample.ai || {}
  const uncertain = ai.needsReview ? 0 : (ai.intent === 'UNKNOWN' ? 1 : 2)
  return [uncertain, Number.isFinite(Number(ai.confidence)) ? Number(ai.confidence) : 1]
}
function reviewQueueView() {
  const samples = reviewQueueSamples().map(sample => ({ sample, rank: REVIEW_SORT(sample) }))
    .sort((left, right) => left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1])
    .map(item => item.sample)
  const collector = S.library.data?.collector || {}
  const canContinue = Boolean(collector.videoId || collector.videoUrl) && !S.library.collecting
  const totalPending = Number(S.library.learning?.stats?.pending || samples.length)
  const filter = reviewGenderFilter()
  // 一键清空只清“还没判断”的评论：把合适的点“判断正确/关注并发第一句”之后，
  // 剩下的直接清走，不会在列表里越积越多。
  const actionRow = (canContinue || samples.length || totalPending) ? `<div class="row" style="margin-bottom:8px;flex-wrap:wrap">
    ${canContinue ? `<button class="btn small" data-act="discover-more">继续寻找更多评论</button>` : ''}
    ${totalPending ? `<button class="btn small" data-act="review-clear">一键清空列表（${totalPending} 条）</button>` : ''}
    <label class="muted">性别 <select id="review-gender-filter"><option value="any" ${filter === 'any' ? 'selected' : ''}>不限</option><option value="female" ${filter === 'female' ? 'selected' : ''}>女</option><option value="male" ${filter === 'male' ? 'selected' : ''}>男</option></select></label>
    ${totalPending ? `<button class="btn small" data-act="verify-genders" ${S.library.verifying ? 'disabled' : ''}>${S.library.verifying ? '正在核验性别…' : '核验作者性别（最多12人）'}</button>` : ''}
    <span class="muted" style="flex-basis:100%">${filter !== 'any' ? `只显示已读取公开主页并核验为${filter === 'female' ? '女性' : '男性'}的作者；未核验和其他性别都不显示。核验需要逐个打开作者主页，每人约几秒。` : canContinue ? '这批都不满意时，从这个视频上次停下的位置继续往下读，不会重复已有评论。清空只是移出审核列表，原始评论仍保留在素材库。' : '评论本身不含性别。选“女”或“男”后点“核验作者性别”，只读取公开主页显示的性别，不猜昵称和头像。'}</span>
  </div>` : ''
  if (!samples.length) {
    const emptyText = S.library.collecting
      ? '分析完成后会在这里列出需要你判断的评论。'
      : filter !== 'any' && totalPending
        ? `已按“${filter === 'female' ? '女' : '男'}”筛选：当前 ${totalPending} 条待审评论里还没有核验为${filter === 'female' ? '女性' : '男性'}的作者。点上方“核验作者性别”读取公开主页后再看。`
        : '暂无待审核评论。粘贴一个视频链接点“开始分析”，或已收录的视频在“高级管理”里重新收集。'
    return `<div class="panel" id="review-queue"><h3>待你审核的评论</h3><p class="muted">${emptyText}</p>${actionRow}</div>`
  }
  return `<div class="panel" id="review-queue"><h3>待你审核的评论（${samples.length} 条）</h3>
    <p class="muted">按模型不确定程度排序，越靠前越可能误判。判断错误会让你选择正确类别，保存后进入 P2-09 学习案例库；跳过只是本次不看。</p>
    ${actionRow}
    ${samples.map(sample => reviewCard(sample)).join('')}</div>`
}
function reviewCard(sample) {
  const ai = sample.ai || {}, human = sample.human
  const intent = human?.intent || ai.intent || null
  const args = esc(JSON.stringify({ key: sample.key }))
  const videoLine = [sample.videoTitle, sample.videoTopic ? `主题 ${sample.videoTopic}` : ''].filter(Boolean).join(' · ')
  const evidence = (ai.evidence || []).join('；')
  const tone = intent === 'EXPLICIT_INVITATION' ? '明确邀请' : intent === 'SEEKING_FRIENDS' ? '可能想认识' : intent === 'CONTEXTUAL_INTEREST' ? '需结合语境' : intent === 'DO_NOT_CONTACT' ? '不要联系' : intent === 'ORDINARY' ? '普通评论' : intent === 'ADVERTISEMENT' ? '广告' : '无法确定'
  // 只有能唯一确认作者 sec_uid 的评论才允许关注并发第一句；缺作者 ID 的只能用于学习。
  // 性别筛选是硬条件：选了“女”就只有已核验为女的作者能关注/发第一句，
  // 未核验和男性都不显示该按钮；选“男”同理；只有“不限”才放开。
  const genderFilter = reviewGenderFilter()
  const approachable = Boolean(sample.authorId && (sample.authorName || '').trim()) && (genderFilter === 'any' || sample.authorGender === genderFilter)
  const genderText = sample.authorGender === 'female' ? '性别 女（已核验）' : sample.authorGender === 'male' ? '性别 男（已核验）' : '性别未核验'
  return `<div class="card">
    <p class="muted" style="overflow-wrap:anywhere">${esc(videoLine || '视频背景缺失')} · AI 判断：<b style="color:#333">${esc(human ? `${tone}（人工已改）` : tone)}</b>${ai.confidence !== null && ai.confidence !== undefined ? ` · 置信度 ${learningConfidenceText(ai.confidence)}` : ''}${ai.needsReview ? ' · 模型不确定' : ''} · ${esc(genderText)}</p>
    <p style="margin-top:6px;overflow-wrap:anywhere">${esc(sample.text || '')}</p>
    ${ai.reason ? `<p class="muted" style="margin-top:2px">依据：${esc(ai.reason)}${evidence ? ` · 证据「${esc(evidence)}」` : ''}</p>` : '<p class="muted" style="margin-top:2px">这是规则与模型都弃权的评论，需要你判断。</p>'}
    ${S.library.fixKey === sample.key ? `<div class="row" style="margin-top:8px;align-items:flex-end"><div class="field" style="flex:1"><label>正确类别是</label><select id="review-fix-select">${['', ...Object.keys(LIBRARY_INTENT_LABELS)].map(value => `<option value="${esc(value)}" ${ai.intent === value ? 'selected' : ''}>${esc(value ? LIBRARY_INTENT_LABELS[value] : '请选择')}</option>`).join('')}</select></div><button class="btn primary small" data-act="review-set" data-args='${args}'>保存并学习</button><button class="btn small" data-act="review-cancel">取消</button></div>`
      : `<div class="row" style="margin-top:8px">${intent && intent !== 'UNKNOWN' ? `<button class="btn small primary" data-act="review-correct" data-args='${args}'>判断正确</button>` : ''}<button class="btn small ${intent && intent !== 'UNKNOWN' ? '' : 'primary'}" data-act="review-wrong" data-args='${args}'>${intent && intent !== 'UNKNOWN' ? '判断错误' : '选择正确类别'}</button>${approachable ? `<button class="btn small" data-act="review-approach" data-args='${args}' title="先关注该作者，再发送你确认过的第一句私信">关注并发第一句</button>` : ''}<button class="btn small" data-act="review-skip" data-args='${args}'>跳过</button>${sample.key ? `<button class="btn small" data-act="learning-exclude" data-args='${args}'>排除样本</button>` : ''}</div>`}
    <p class="muted" style="margin-top:4px">交友意愿不等于同意私信；缺少作者 ID 的评论只用于学习，不会进入可联系候选池。</p>
  </div>`
}

// 高级管理：原有全部能力保留，折叠起来避免挡住日常两件事。
function advancedDiscoveryView() {
  const config = S.data.discovery?.config || {}
  const search = discoverySearchValues()
  return `<details class="panel" id="discovery-advanced"><summary style="cursor:pointer"><b>高级管理</b><span class="muted"> · 手动粘贴链接、关键词搜索、视频库、手动导入、案例学习、模型评估、版本回滚、统一候选池</span></summary>
  <div style="margin-top:12px">
  ${discoverHomeView()}
  <div class="panel"><h3>我要找什么样的人</h3><p class="muted">直接写筛选要求，让AI解析；检查下面的条件后保存或开始发现。尚不支持自动核验的条件会提示，不会悄悄忽略。</p><div class="field" style="margin-top:10px"><textarea id="discovery-requirements" maxlength="2000" placeholder="例如：女生，粉丝少于150，优先找靠下、回复少的评论作者，也找楼中楼作者">${esc(S.discovery.requirementsText ?? config.requirementsText ?? '')}</textarea></div><button class="btn primary" data-act="discovery-parse" ${S.discovery.busy ? 'disabled' : ''}>AI解析要求</button></div>
    <div class="panel"><h3>解析结果与搜索设置</h3><div class="grid2"><div class="field"><label>性别条件</label><select id="discovery-target-gender"><option value="any" ${config.targetGender !== 'female' ? 'selected' : ''}>不限</option><option value="female" ${config.targetGender === 'female' ? 'selected' : ''}>仅女性</option></select></div><div class="field"><label>粉丝数条件</label><select id="discovery-follower-required"><option value="off" ${!config.requireFollowerLimit ? 'selected' : ''}>不限</option><option value="on" ${config.requireFollowerLimit ? 'selected' : ''}>少于下方人数</option></select></div><div class="field"><label>粉丝数需少于（填150表示最多149）</label><input id="discovery-follower-limit" type="number" min="1" max="100000" value="${esc(config.followerLimit ?? 150)}"></div><div class="field"><label>每轮最多核验主页数</label><input id="discovery-profile-checks" type="number" min="0" max="20" value="${esc(config.profileChecksPerRun ?? 8)}"></div></div><div class="row" style="margin-top:10px">${[['preferLowerComments', '优先向下找评论'], ['preferLowReplies', '优先回复少的评论'], ['includeReplies', '包含楼中楼作者']].map(([key, label]) => `<label><input type="checkbox" data-discovery-preference="${key}" ${config[key] ? 'checked' : ''}> ${label}</label>`).join('')}</div>
    <div class="grid3" style="margin-top:12px"><div class="field"><label>年龄条件（可选）</label><select id="discovery-age-required"><option value="off" ${!config.requireAgeRange ? 'selected' : ''}>不限制年龄</option><option value="on" ${config.requireAgeRange ? 'selected' : ''}>限制为下方区间</option></select></div><div class="field"><label>最低年龄</label><input id="discovery-age-min" type="number" min="18" max="100" value="${esc(config.ageMin ?? 20)}"></div><div class="field"><label>最高年龄</label><input id="discovery-age-max" type="number" min="18" max="100" value="${esc(config.ageMax ?? 30)}"></div></div>
    <h3 style="margin-top:18px">主题视频评论区发现</h3><p class="muted" style="margin-bottom:12px">搜索主题视频，从评论作者中发现候选人，再由你打开主页判断。评论和用户搜索结果共用下面的候选池。发现本身不关注、不发送消息；性别、年龄和粉丝数未确认的候选保留待核验。</p>
    <div class="grid2" style="margin-bottom:10px"><div class="field"><label>视频标签（手动输入）</label><textarea id="discovery-video-tags" maxlength="2000" placeholder="例如：校园生活、宠物、摄影（可带#）">${esc(search.videoTagsText)}</textarea></div><div class="field"><label>搜索关键词（手动输入）</label><textarea id="discovery-video-keywords" maxlength="2000" placeholder="例如：大学日常、猫咪搞笑、周末徒步">${esc(search.videoKeywordsText)}</textarea></div></div><p class="muted" style="margin-bottom:12px">逗号、顿号或换行分隔，各最多20个，每个最多80字。标签以“#标签”搜索，关键词逐个搜索；至少填写一项。标签用于搜索相关视频，并非严格标签过滤。AI解析交友要求不会改写这两项。</p>
    <div class="grid2"><div class="field"><label>本轮最多读取视频数</label><input id="discovery-max-videos" type="number" min="1" max="5" step="1" value="${esc(config.maxVideosPerRun ?? 3)}"></div><div class="field"><label>每个视频最多读取评论数</label><input id="discovery-comments" type="number" min="1" max="30" step="1" value="${esc(config.commentsPerVideo ?? 20)}"></div></div>
    <div class="row" style="margin-top:12px"><button class="btn" data-act="discovery-config" ${S.discovery.busy ? 'disabled' : ''}>保存搜索设置</button><button class="btn primary" data-act="discovery-start" ${S.discovery.busy || discoveryRunning() ? 'disabled' : ''}>开始发现</button><button class="btn" data-act="discovery-stop" ${!discoveryRunning() ? 'disabled' : ''}>停止</button></div></div>
    <div class="panel"><h3>发现状态</h3><div id="discovery-progress">${discoveryStatusView()}</div></div>
    ${learningView()}
    ${libraryView()}
    ${contactSettingsView()}
    <div class="grid2 discovery-candidate-grid" style="align-items:start"><div class="panel"><h3>统一候选池（按Brain分数排序）</h3><div class="grid2" style="margin-bottom:10px"><div class="field"><label>人工审核状态</label><select id="discovery-filter">${[['pending', '待审核'], ['approved', '符合'], ['deferred', '暂存'], ['rejected', '排除'], ['all', '全部']].map(([value, label]) => `<option value="${value}" ${S.discovery.filter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field"><label>Brain 判断</label><select id="discovery-brain-filter">${[['all', '全部'], ['high_priority', '高优先级'], ['worth_reviewing', '普通候选'], ['uncertain', '信息不足'], ['reject', '排除']].map(([value, label]) => `<option value="${value}" ${(S.discovery.brainFilter || 'all') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div><div id="discovery-candidates" style="max-height:650px;overflow:auto">${discoveryListView()}</div></div>
    <div class="panel"><h3>候选详情</h3><div id="discovery-detail">${discoveryDetailView()}</div></div></div>
  </div></details>`
}
// 主页只保留两个区域：发现（粘链接→分析）与审核（判断正确/错误/跳过）。
// ── P2-11D 四个区域：A 总览 / B 收藏夹自动分析 / C 评论学习 / D 候选人池 ──────
function discoveryOverviewView() {
  const stats = S.library.data?.stats || {}
  const pipeline = S.library.data?.pipeline || {}
  const favorites = S.library.data?.favorites || {}
  const candidates = discoveryCandidates()
  const analyzed = Object.entries(stats.byIntent || {}).reduce((sum, [key, value]) => (key === 'unknown' ? sum : sum + (Number(value) || 0)), 0)
  const running = S.library.pipelineBusy || pipeline.status === 'running'
  const statusText = running ? '自动分析中' : (PIPELINE_STATUS_LABELS[pipeline.status] || '未运行')
  const pending = candidates.filter(item => discoveryReviewStatus(item) === 'pending').length
  const counters = pipeline.counters || {}
  const tile = (label, value, hint = '') => `<div class="card"><p class="muted">${esc(label)}</p><p style="font-size:20px;font-weight:600;margin-top:4px">${esc(value)}</p>${hint ? `<p class="muted" style="margin-top:2px">${esc(hint)}</p>` : ''}</div>`
  return `<div class="panel" id="discovery-overview"><h3>总览</h3>
    <div class="grid2" style="margin-top:8px">
      ${tile('已同步收藏视频', stats.favoriteVideos || 0, favorites.folderName ? `收藏夹：${favorites.folderName}` : '尚未指定收藏夹')}
      ${tile('已分析视频', counters.videosCompleted || 0, pipeline.items?.length ? `任务项共 ${pipeline.items.length} 个` : '')}
      ${tile('已分析评论', analyzed, `素材库共 ${stats.comments || 0} 条 · 累计新增 ${counters.commentsCollected || 0} · 去重 ${counters.commentsSkipped || 0}`)}
      ${tile('符合初筛候选人数', candidates.length, pending ? `待审核 ${pending} 人` : '暂无待审核')}
      ${tile('模型调用与 Token', `${counters.aiCalls || 0} 次 / ${counters.tokens || 0}`, '规则直接判定的不调用模型')}
      ${tile('任务状态', statusText, favorites.lastSyncAt ? `最近同步 ${fmtTime(favorites.lastSyncAt)}` : '')}
    </div>
    ${favorites.lastError ? `<p class="notice" style="margin-top:8px">${esc(favorites.lastError)}</p>` : ''}
    ${pipeline.lastError ? `<p class="notice" style="margin-top:8px">${esc(pipeline.lastError)}</p>` : ''}
    <p class="muted" style="margin-top:8px">这一页只做发现、分析和候选管理：不关注、不主动私信陌生人。交友意愿不等于允许私信。</p>
  </div>`
}
// ── P2-12A 人工基准集：盲评队列 + 逐类别指标 + 混淆矩阵 ─────────────────────
const BENCHMARK_CLASS_LABELS = {
  EXPLICIT_INVITATION: '明确邀请', SEEKING_FRIENDS: '交友意愿', CONTEXTUAL_INTEREST: '语境兴趣',
  ORDINARY: '普通评论', DO_NOT_CONTACT: '明确拒绝', ADVERTISEMENT: '广告', UNKNOWN: '无法判断', UNCLASSIFIED: '未分类',
}
const BENCHMARK_CLASS_ORDER = ['EXPLICIT_INVITATION', 'SEEKING_FRIENDS', 'CONTEXTUAL_INTEREST', 'ORDINARY', 'DO_NOT_CONTACT', 'ADVERTISEMENT', 'UNKNOWN', 'UNCLASSIFIED']
const shapePercent = value => (value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`)
function benchmarkQuotaLine(active) {
  if (!active) return ''
  const quotas = active.quotas || {}, actual = active.quotaActual || {}, shortage = active.shortage || {}
  const parts = BENCHMARK_CLASS_ORDER
    .filter(key => quotas[key])
    .map(key => `${BENCHMARK_CLASS_LABELS[key] || key} ${actual[key] || 0}/${quotas[key]}${shortage[key] ? `（缺 ${shortage[key]}）` : ''}`)
  return parts.join(' · ')
}
function benchmarkQueueCard(item, labelOptions) {
  if (item.missing) return `<div class="card"><p class="muted">第 ${item.position} 条：样本已不在学习库（可能被排除），可点“跳过”。</p><div class="row"><button class="btn small" data-act="benchmark-skip" data-args='${esc(JSON.stringify({ key: item.key, position: item.position }))}'>跳过</button></div></div>`
  const context = [item.videoTitle, item.videoDescription, item.videoTopic ? `主题 ${item.videoTopic}` : '', item.videoCategory ? `分类 ${item.videoCategory}` : '', (item.videoHashtags || []).length ? item.videoHashtags.map(tag => `#${tag}`).join(' ') : ''].filter(Boolean).join(' · ')
  return `<div class="card">
    <p class="muted" style="overflow-wrap:anywhere">第 ${item.position} 条${context ? ` · ${esc(context)}` : ''}${item.commentAt ? ` · 评论时间 ${esc(fmtTime(item.commentAt))}` : ''}</p>
    <p style="margin-top:6px;overflow-wrap:anywhere">${esc(item.text || '')}</p>
    ${(item.replies || []).length ? `<p class="muted" style="margin-top:2px">楼中楼：${esc((item.replies || []).join('；'))}</p>` : ''}
    <div class="row" style="margin-top:8px;align-items:flex-end">
      <div class="field" style="flex:1"><label>你的判断（模型结论已隐藏）</label><select id="bm-select-${item.position}"><option value="">请选择</option>${(labelOptions || []).map(option => `<option value="${esc(option.intent)}">${esc(option.label)}</option>`).join('')}</select></div>
      <button class="btn primary small" data-act="benchmark-save" data-args='${esc(JSON.stringify({ key: item.key, position: item.position }))}'>保存标签</button>
      <button class="btn small" data-act="benchmark-unknown" data-args='${esc(JSON.stringify({ key: item.key, position: item.position }))}'>无法判断</button>
      <button class="btn small" data-act="benchmark-skip" data-args='${esc(JSON.stringify({ key: item.key, position: item.position }))}'>跳过</button>
    </div>
  </div>`
}
function benchmarkMetricsView(evaluation) {
  if (!evaluation) return ''
  const targets = evaluation.targets || {}
  const statusText = targets.status === 'meets_targets' ? '达到首版验收目标'
    : targets.status === 'below_targets' ? '未达到首版验收目标'
      : '证据不足：不能宣称分类器已达标'
  const tone = targets.status === 'meets_targets' ? 'color:#1e8e3e' : (targets.status === 'below_targets' ? 'color:#c0392b' : 'color:#8a6d3b')
  const rows = BENCHMARK_CLASS_ORDER.map(key => {
    const cls = evaluation.perClass?.[key]
    if (!cls || !cls.support) return ''
    return `<tr><td>${esc(BENCHMARK_CLASS_LABELS[key] || key)}</td><td>${cls.support}</td><td>${cls.predicted}</td><td>${shapePercent(cls.precision)}</td><td>${shapePercent(cls.recall)}</td><td>${shapePercent(cls.f1)}</td></tr>`
  }).join('')
  const columns = BENCHMARK_CLASS_ORDER
  const matrixRows = columns.map(expected => {
    const row = evaluation.confusion?.[expected] || {}
    if (!Object.values(row).some(value => Number(value))) return ''
    return `<tr><td>${esc(BENCHMARK_CLASS_LABELS[expected] || expected)}</td>${columns.map(predicted => `<td>${Number(row[predicted]) || 0}</td>`).join('')}</tr>`
  }).join('')
  const leaks = evaluation.rejectionProtection || {}
  const wrongList = (list, title) => (list || []).length ? `<p class="muted" style="margin-top:6px"><b>${title}</b>：${list.slice(0, 8).map(row => `${esc(BENCHMARK_CLASS_LABELS[row.expected] || row.expected)} → ${esc(BENCHMARK_CLASS_LABELS[row.predicted] || row.predicted)}「${esc(String(row.text || '').slice(0, 40))}」`).join('；')}</p>` : ''
  return `<div class="card" style="margin-top:10px">
    <p><b>${esc(evaluation.scope === 'benchmark' ? '基准集评估' : '历史人工标注参考')}</b> · <b style="${tone}">${esc(statusText)}</b></p>
    <p class="muted" style="margin-top:4px">有效标注 ${evaluation.total || 0} 条 · 准确率 ${shapePercent(evaluation.accuracy)} · Macro-F1 ${shapePercent(evaluation.macroF1)}（支持类别）· 交友意愿 Precision ${shapePercent(evaluation.friendship?.precision)} · 明确邀请 Precision ${shapePercent(evaluation.explicit?.precision)}</p>
    <p class="muted">验收目标：Macro-F1 ≥ ${targets.macroF1Target ?? 0.8}（${targets.macroF1Pass ? '通过' : '未通过'}）· 交友意愿 Precision ≥ ${targets.friendshipPrecisionTarget ?? 0.9}（${targets.friendshipPrecisionPass ? '通过' : '未通过'}）· consentToDm 误判 ${evaluation.consentToDmErrors || 0}（${targets.consentToDmPass ? '通过' : '未通过'}）· 拒绝联系泄漏 ${leaks.leakCount || 0}（${targets.rejectionProtectionPass ? '通过' : '未通过'}）</p>
    <p class="muted">${esc(targets.note || '')}${evaluation.evidenceNote ? `；${esc(evaluation.evidenceNote)}` : ''}</p>
    ${evaluation.scope !== 'benchmark' && evaluation.caveat ? `<p class="muted">${esc(evaluation.caveat)}</p>` : ''}
    ${rows ? `<div class="table" style="margin-top:8px"><table><thead><tr><th>类别</th><th>人工标注</th><th>模型预测</th><th>Precision</th><th>Recall</th><th>F1</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted" style="margin-top:8px">还不能计算逐类别指标：需要至少一条有结论的人工标注。</p>'}
    ${matrixRows ? `<p class="muted" style="margin-top:8px">混淆矩阵（行＝人工标签，列＝模型预测）：</p><div class="table" style="overflow:auto;margin-top:4px"><table><thead><tr><th>人工＼预测</th>${columns.map(key => `<th title="${esc(BENCHMARK_CLASS_LABELS[key] || key)}">${esc((BENCHMARK_CLASS_LABELS[key] || key).slice(0, 2))}</th>`).join('')}</tr></thead><tbody>${matrixRows}</tbody></table></div>` : ''}
    ${wrongList(evaluation.severeWrong, '重点错误')}
    ${wrongList(evaluation.wrong?.filter(row => row.severe === 'MISCLASSIFIED'), '其他误判')}
    ${wrongList(evaluation.falseNegativeRows, '漏判')}
    ${leaks.humanRejectedCount || leaks.modelRejectedCount ? `<p class="muted" style="margin-top:6px">拒绝保护：人工拒绝 ${leaks.humanRejectedCount || 0} 人、模型识别拒绝 ${leaks.modelRejectedCount || 0} 人、候选池命中拒绝者 ${leaks.leakedCandidates || 0} 人、候选池作者 ${leaks.poolAuthorCount || 0} 人。</p>` : ''}
  </div>`
}
function benchmarkPanelView() {
  const view = S.library.benchmark
  const busy = S.library.benchmarkBusy
  const evaluation = S.library.benchmarkEvaluation
  const reference = S.library.benchmarkReference
  if (!view) {
    return `<div class="panel"><h3>人工基准集与分类评估</h3>
      <p class="muted">用真实收藏夹评论建立 60 条盲评样本：页面只显示评论原文和必要的视频语境，隐藏模型结论；人工标签单独保存，不会被模型预测覆盖。标注完成后输出逐类别 Precision / Recall / F1、Macro-F1、混淆矩阵、误判与漏判明细。</p>
      <div class="row" style="margin-top:8px"><button class="btn small" data-act="benchmark-refresh" ${busy ? 'disabled' : ''}>加载人工基准集</button><button class="btn small primary" data-act="benchmark-create" ${busy ? 'disabled' : ''}>创建基准集</button></div>
      ${S.library.benchmarkMessage ? `<p class="notice">${esc(S.library.benchmarkMessage)}</p>` : ''}
    </div>`
  }
  const active = view.active
  const queue = view.queue || []
  return `<div class="panel"><h3>人工基准集与分类评估</h3>
    <p class="muted">盲评：页面不显示模型原始分类、置信度和证据，也不显示作者身份。人工标签与模型预测分开保存；标完 60 条会输出每类 Precision / Recall / F1、Macro-F1、混淆矩阵、误判和漏判明细。样本不足时明确标记“证据不足”，不会伪造达标。</p>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      <button class="btn small" data-act="benchmark-refresh" ${busy ? 'disabled' : ''}>刷新</button>
      <button class="btn small" data-act="benchmark-create" ${busy ? 'disabled' : ''}>${active ? '重建基准集' : '创建基准集'}</button>
      <button class="btn small primary" data-act="benchmark-evaluate" ${busy || !active ? 'disabled' : ''}>评估当前基准集</button>
      <button class="btn small" data-act="benchmark-continue" ${busy || !active ? 'disabled' : ''}>继续 60 条盲评（${view.labeled}/${view.total}）</button>
      ${active ? `<button class="btn small" data-act="benchmark-page" data-args='${esc(JSON.stringify({ delta: -12 }))}' ${busy || (view.offset || 0) <= 0 ? 'disabled' : ''}>上一批</button><button class="btn small" data-act="benchmark-page" data-args='${esc(JSON.stringify({ delta: 12 }))}' ${busy || (view.range?.to || 0) >= (view.remaining || 0) ? 'disabled' : ''}>下一批</button>` : ''}
    </div>
    ${active ? `<p class="muted" style="margin-top:8px">进度 ${view.labeled}/${view.total}（${shapePercent(view.progress)}）· 状态 ${active.status === 'completed' ? '已完成' : '盲评中'}${active.createdAt ? ` · 创建于 ${esc(fmtTime(active.createdAt))}` : ''}</p>
      <p class="muted">抽样配额：${esc(benchmarkQuotaLine(active))}</p>${active.note ? `<p class="muted">${esc(active.note)}</p>` : ''}` : ''}
    ${S.library.benchmarkMessage ? `<p class="notice">${esc(S.library.benchmarkMessage)}</p>` : ''}
    ${view.message ? `<p class="muted" style="margin-top:6px">${esc(view.message)}</p>` : ''}
    ${queue.length ? `<p class="muted" id="benchmark-blind-list" style="margin-top:10px">待标注 ${view.range ? `第 ${view.range.from}–${view.range.to} 条（按剩余顺序，共剩 ${view.remaining} 条）` : `（${queue.length} 条）`}：保存后自动补位；跳过只翻到下一条，不写标签，稍后仍会回到队列。</p>${queue.map(item => benchmarkQueueCard(item, view.labelOptions)).join('')}` : `<p class="muted" style="margin-top:10px">${view.remaining ? '当前批次已到底，点“上一批”回看。' : '全部标注完成。'}</p>`}
    ${evaluation ? `<h4 style="margin:14px 0 4px">基准集评估结果</h4>${benchmarkMetricsView(evaluation)}` : ''}
    ${reference ? `<h4 style="margin:14px 0 4px">历史人工标注参考（非盲，不计入正式结论）</h4>${benchmarkMetricsView(reference)}` : ''}
    ${!evaluation && active ? '<p class="muted" style="margin-top:8px">完成标注后点“评估当前基准集”，这里会显示逐类别指标、混淆矩阵和错误样本。</p>' : ''}
  </div>`
}
function learningSummaryView() {
  const data = S.library.learning
  if (!data) return '<div class="panel" id="learning-summary"><h3>评论学习</h3><p class="muted">尚未加载。点击下方按钮读取本地学习样本。</p><div class="row" style="margin-top:8px"><button class="btn" data-act="learning-refresh">加载评论学习</button></div></div>'
  const stats = data.stats || {}, evaluation = S.library.evaluation, run = data.lastRun
  const pct = value => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(0)}%`)
  const scheme = key => evaluation?.scopes?.eval?.[key]
  const line = (name, key) => {
    const item = scheme(key)
    if (!item) return `${name}：无数据`
    return `${name}：准确率 ${pct(item.accuracyOnDecided)}（有结论 ${item.decided}/${item.total}）· 召回 ${pct(item.recall)} · 弃权 ${pct(item.abstainRate)} · 拒绝联系命中 ${pct(item.refusalRecall)}`
  }
  return `<div class="panel" id="learning-summary"><h3>评论学习</h3>
    <p class="muted">这里只显示模型分类效果和需要你判断的异常样本；完整训练、评估与版本回滚在“高级管理”。</p>
    <p class="muted" style="margin-top:6px">样本 ${stats.samples || 0} · 已人工标注 ${stats.annotated || 0} · 待标注 ${stats.pending || 0} · 需复核 ${stats.needsReview || 0}</p>
    ${run ? `<p class="muted">最近运行：${esc(run.mode || '')} · 处理 ${run.processed || 0}/${run.total || 0} · 模型调用 ${run.aiCalls || 0} 次 · Token ${run.tokens || 0}${run.errors?.length ? ` · ${esc(run.errors[0].reason || '')}` : ''}</p>` : ''}
    ${evaluation ? `<p class="muted" style="margin-top:6px">${esc(line('① 原始规则', 'rule'))}</p><p class="muted">${esc(line('② 规则 + 豆包', 'model'))}</p><p class="muted">${esc(line('③ 规则 + 豆包 + 案例', 'model_cases'))}</p>` : '<p class="muted" style="margin-top:6px">还没有独立评估结果；完成人工标注后可在高级管理里评估三种方案。</p>'}
    <div class="row" style="margin-top:8px"><button class="btn small" data-act="learning-refresh" ${S.library.learningBusy ? 'disabled' : ''}>刷新学习样本</button></div>
  </div>`
}
// P2-12C 候选人质量：A/B/C/D 是发现等级，不等于私信许可；拒绝联系优先级最高。
const CANDIDATE_GRADE_LABELS = { A: 'A 明确交友意愿', B: 'B 一般交友意愿', C: 'C 语境兴趣/证据不足', D: 'D 普通/广告/拒绝联系' }
const CANDIDATE_STATUS_LABELS = { DISCOVERED: '已发现', QUALIFIED: '条件符合', INSUFFICIENT_INFO: '信息不足', EXCLUDED: '已排除', REJECTED: '拒绝联系' }
function candidateGradeSummary() {
  const candidates = discoveryCandidates()
  const grades = { A: 0, B: 0, C: 0, D: 0 }
  const statuses = { DISCOVERED: 0, QUALIFIED: 0, INSUFFICIENT_INFO: 0, EXCLUDED: 0, REJECTED: 0 }
  let sources = 0, ageKnown = 0, genderKnown = 0, consent = 0, explicit = 0, rejected = 0, multiSource = 0
  for (const candidate of candidates) {
    const grade = ['A', 'B', 'C', 'D'].includes(candidate.discoveryGrade) ? candidate.discoveryGrade : 'D'
    grades[grade] += 1
    const status = candidate.status === 'REJECTED' || candidate.discoveryStatus === 'REJECTED' ? 'REJECTED'
      : ['DISCOVERED', 'QUALIFIED', 'INSUFFICIENT_INFO', 'EXCLUDED'].includes(candidate.discoveryStatus) ? candidate.discoveryStatus : 'DISCOVERED'
    statuses[status] += 1
    if (status === 'REJECTED') rejected += 1
    const count = Array.isArray(candidate.sources) ? candidate.sources.length : 0
    sources += count
    if (count > 1) multiSource += 1
    if (candidate.ageVerification && candidate.ageVerification !== 'unknown') ageKnown += 1
    if (candidate.genderVerification && candidate.genderVerification !== 'unknown') genderKnown += 1
    if (candidate.consentToDm === true) consent += 1
    if (candidate.explicitInvitation === true) explicit += 1
  }
  return { total: candidates.length, grades, statuses, sources, multiSource, ageKnown, genderKnown, consent, explicit, rejected }
}
function coreCandidatesView() {
  const all = discoveryCandidates()
  const summary = candidateGradeSummary()
  const rows = [...all].sort((left, right) => discoveryScore(right) - discoveryScore(left)).slice(0, 12)
  const pending = all.filter(item => discoveryReviewStatus(item) === 'pending').length
  const matched = all.filter(item => discoveryEligibility(item) === '条件符合').length
  return `<div class="panel" id="core-candidates"><h3>候选人池</h3>
    <p class="muted">只显示从收藏视频评论里筛出的候选：交友意愿、作者账号标识、联系人与拒绝联系记录都已核对。年龄和性别区分“未知 / 本人自述 / 主页公开 / 人工核实 / 信息冲突”，每项都带来源与原话；未读取主页时明确写“未核实”，不按头像、昵称或照片推断。候选不会自动收到第一条消息。</p>
    <p class="muted" style="margin-top:6px">共 ${summary.total} 人 · 待审核 ${pending} · 条件符合 ${matched} · 待核实 ${Math.max(0, all.length - pending - matched)}</p>
    <p class="muted" style="margin-top:6px">发现等级：${CANDIDATE_GRADE_LABELS.A} ${summary.grades.A} · ${CANDIDATE_GRADE_LABELS.B} ${summary.grades.B} · ${CANDIDATE_GRADE_LABELS.C} ${summary.grades.C} · ${CANDIDATE_GRADE_LABELS.D} ${summary.grades.D}</p>
    <p class="muted">来源视频 ${summary.sources} 个（跨视频合并 ${summary.multiSource} 人）</p>
    <p class="muted">年龄：${esc(factSummaryText(all, 'age', '岁'))}</p>
    <p class="muted">性别：${esc(factSummaryText(all, 'gender'))}</p>
    <p class="muted">拒绝保护：已排除拒绝联系者 ${summary.rejected} 人；评论原话明确欢迎私信 ${summary.consent} 人、存在明确邀请 ${summary.explicit} 人。A/B 级只是发现等级，不代表允许私信；真正发送仍由现有联系流程和人工审核控制。</p>
    ${rows.map(candidate => {
      const source = candidate.sources?.[0] || {}
      const more = (candidate.sources || []).length
      const grade = ['A', 'B', 'C', 'D'].includes(candidate.discoveryGrade) ? candidate.discoveryGrade : 'D'
      const audit = (S.library.autoAudit?.audits || []).find(item => item.platformUserId === candidate.platformUserId)
      const reasons = audit ? [...audit.discovery.reasons, ...audit.contact.reasons, ...audit.action.reasons] : []
      return `<div class="card" style="margin-top:8px">
        <p><b>${esc(candidate.nickname || '昵称未提供')}</b> <span class="pill">${esc(CANDIDATE_GRADE_LABELS[grade])}</span> <span class="pill">${esc(discoveryReviewLabel(candidate))}</span> <span class="muted"> · ${esc(discoveryEligibility(candidate))}</span></p>
        <p class="muted" style="margin-top:4px">交友意愿：${esc(LIBRARY_INTENT_LABELS[candidate.libraryIntent] || candidate.libraryIntent || '未记录')}${candidate.consentToDm ? ' · 原话明确欢迎私信' : ' · 仅表达意愿，未同意私信'} · 发现状态 ${esc(CANDIDATE_STATUS_LABELS[candidate.discoveryStatus] || candidate.discoveryStatus || '已发现')}</p>
        <p class="muted" style="margin-top:4px">资料：年龄 ${esc(factText(candidate, 'age', '岁'))} · 性别 ${esc(factText(candidate, 'gender'))}</p>
        ${audit ? `<p class="muted" style="margin-top:4px">资格审计：发现 ${esc(auditStatusLabel(audit.discovery.status))} · 联系 ${esc(auditStatusLabel(audit.contact.status))} · 动作 ${esc(auditStatusLabel(audit.action.status))}${reasons.length ? ` · 未通过原因：${reasons.filter((code, index, list) => list.indexOf(code) === index).map(code => esc(auditReasonLabel(code))).join('、')}` : ''}</p>` : ''}
        <p class="muted" style="margin-top:4px;overflow-wrap:anywhere">来源视频：${esc(source.videoTitle || source.videoId || source.keyword || '未记录')}${more > 1 ? `（另有 ${more - 1} 个来源）` : ''}</p>
        <p style="margin-top:4px;overflow-wrap:anywhere">${esc(source.commentText || '评论原文未记录')}</p>
      </div>`
    }).join('') || '<p class="muted" style="margin-top:8px">还没有候选人。先同步收藏夹并运行自动分析；如果已有评论但没有候选，请到高级管理查看未入选原因。</p>'}
  </div>`
}
// ── P2-13 双模式：训练模式只发现，正式模式严格筛选后 Dry Run ───────────────
function autoContactStateOf() {
  return S.library.autoContact || { mode: 'training', config: {}, dryRun: true, status: 'idle', queues: { follow: [], firstMessage: [] }, budget: { follows: 0, messages: 0, limits: {} } }
}
const AUDIT_STATUS_LABELS = {
  DISCOVERY_QUALIFIED: '发现合格', DISCOVERY_NOT_QUALIFIED: '发现不合格', DISCOVERY_INSUFFICIENT: '资料不足',
  CONTACT_ELIGIBLE: '联系资格满足', CONTACT_NOT_ELIGIBLE: '联系资格不满足', CONTACT_INSUFFICIENT_INFO: '联系资料不足',
  ACTION_AUTHORIZED: '已获准执行', ACTION_NOT_AUTHORIZED: '未获准执行', ACTION_BLOCKED: '已阻断',
}
const AUDIT_REASON_LABELS = {
  MISSING_AUTHOR_ID: '作者 ID 缺失', SOURCE_COMMENT_MISSING: '来源评论缺失', SOURCE_AUTHOR_MISMATCH: '评论作者不一致',
  CLASSIFICATION_MISSING: '缺少分类结果', CLASSIFICATION_STALE: '分类结果已过期', SOURCE_VIDEO_MISSING: '来源视频缺失',
  REJECTED_PROTECTED: '已拒绝联系', EXCLUDED: '已排除', ALREADY_CONTACT: '已是联系人', DUPLICATE_CANDIDATE: '候选重复',
  NOT_FRIENDLY_INTENT: '无交友意愿', INSUFFICIENT_INFO: '信息不足', DISCOVERY_NOT_QUALIFIED: '发现阶段不合格',
  AGE_UNVERIFIED: '年龄未核实', AGE_CONFLICT: '年龄信息冲突', MINOR_BLOCKED: '未成年阻断', AGE_OUT_OF_RANGE: '年龄不符合',
  GENDER_UNVERIFIED: '性别未核实', GENDER_CONFLICT: '性别信息冲突', GENDER_MISMATCH: '性别不符合', FOLLOWERS_UNVERIFIED: '粉丝数未核实', FOLLOWERS_OUT_OF_RANGE: '粉丝数不符合',
  PLATFORM_PERMISSION_UNVERIFIED: '平台权限未核实', RECIPIENT_AI_CONSENT_MISSING: '对方未同意 AI 参与', OPERATOR_CONFIRMATION_MISSING: '操作者未确认',
  CONSENT_NOT_EXPLICIT: '无明确私信邀请', CONSENT_INTENT_MISMATCH: '邀请证据与意愿不一致', CONTACT_NOT_ELIGIBLE: '联系资格未满足',
}
function auditStatusLabel(status) { return AUDIT_STATUS_LABELS[status] || status || '未知' }
function auditReasonLabel(code) { return AUDIT_REASON_LABELS[code] || code }
function autoActionText(entry) {
  if (!entry) return '—'
  return [entry.status, entry.reasonCode ? `（${entry.reasonCode}）` : '', entry.reason ? ` ${entry.reason}` : ''].join('')
}
function patchAutoModePanel() {
  const panel = document.getElementById('auto-mode-panel')
  if (!panel || panel.contains(document.activeElement) && isTypingIn(document.activeElement)) return false
  const scrollTop = panel.scrollTop
  panel.outerHTML = autoModeView()
  const updated = document.getElementById('auto-mode-panel')
  if (updated) updated.scrollTop = scrollTop
  return true
}
function autoModeView() {
  const auto = autoContactStateOf()
  const mode = auto.mode === 'auto' ? 'auto' : 'training'
  const busy = S.library.autoBusy
  const card = (key, title, description) => `
    <div class="card" style="flex:1;min-width:240px;border:2px solid ${mode === key ? '#3b82f6' : 'var(--border, #ddd)'}">
      <h4>${esc(title)}${mode === key ? '（当前）' : ''}</h4>
      <p class="muted">${esc(description)}</p>
      <button class="btn ${mode === key ? 'primary' : ''}" data-act="auto-mode-${key}" ${busy || mode === key ? 'disabled' : ''}>${mode === key ? '正在使用' : `切换到${esc(title)}`}</button>
    </div>`
  return `<div class="panel" id="auto-mode-panel"><h3>自动发现模式</h3>
    <p class="muted">两种模式共用同一套发现引擎：收藏夹 → 视频 → 评论 → 规则/AI 分类 → 候选人。训练模式只积累数据和人工审核；正式模式在此之上自动筛选、关注，并只对明确欢迎私信的人发送首次消息。</p>
    <div class="row" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
      ${card('training', '训练模式', 'AI 自动寻找、分析和生成候选人，由人工审核。绝不自动关注或私信。')}
      ${card('auto', '正式自动模式', 'AI 自动筛选并生成关注/首次联系计划；真实动作需平台权限、对方同意与操作者确认同时具备，否则只执行 Dry Run。')}
    </div>
    ${!auto.riskAcceptedAt ? '<p class="muted" style="margin-top:6px">正式模式首次启用需要确认自动关注/私信权限与风险；确认后会记录时间，但不会修改历史学习数据。</p>' : ''}
    ${S.library.autoMessage ? `<p class="notice" style="margin-top:8px">${esc(S.library.autoMessage)}</p>` : ''}
  </div>`
}
function autoDiscoveryPanelView() {
  const auto = autoContactStateOf(), mode = auto.mode === 'auto' ? 'auto' : 'training'
  const data = S.library.data || {}, stats = data.stats || {}, pipeline = data.pipeline || {}, favorites = data.favorites || {}
  const counters = pipeline.counters || {}
  const autoConfig = auto.config || {}
  const queueCounts = {
    followPending: (auto.queues?.follow || []).filter(task => task.status === 'pending').length,
    firstMessagePending: (auto.queues?.firstMessage || []).filter(task => task.status === 'pending').length,
    // P2-15：模拟完成与真实完成分开显示，避免把 Dry Run 当成已关注。
    followSimulated: (auto.queues?.follow || []).filter(task => task.status === 'done' && task.simulated === true).length
      + (auto.queues?.firstMessage || []).filter(task => task.status === 'done' && task.simulated === true).length,
    followReal: (auto.queues?.follow || []).filter(task => task.status === 'done' && task.realAction === true).length
      + (auto.queues?.firstMessage || []).filter(task => task.status === 'done' && task.realAction === true).length,
    uncertain: [...(auto.queues?.follow || []), ...(auto.queues?.firstMessage || [])].filter(task => task.status === 'uncertain').length,
  }
  const tile = (label, value, hint = '') => `<div class="card"><p class="muted">${esc(label)}</p><p style="font-size:20px;font-weight:600;margin-top:4px">${esc(value)}</p>${hint ? `<p class="muted" style="margin-top:2px">${esc(hint)}</p>` : ''}</div>`
  const busy = S.library.autoBusy || S.library.favoritesBusy || S.library.pipelineBusy
  const runningText = { idle: '未运行', planned: '已生成计划', running: '运行中', paused: '已暂停', stopped: '已紧急停止', completed: '已完成', blocked: '已阻断' }[auto.status] || '未运行'
  const plans = S.library.autoPlans?.plans || []
  const audit = S.library.autoAudit || {}
  const auditCounts = audit.summary?.counts || {}
  const auditReasons = audit.summary?.actionReasons || {}
  const configNotes = audit.summary?.configNotes || []
  const authorized = auditCounts.actionAuthorized || 0
  // P2-16 筛选口径：候选数 ≠ 合格人数。合格只表示"满足全部已启用必需条件"。
  const planSummary = audit.planSummary || {}
  const scopeLabels = { gender: '性别', age: '年龄', followers: '粉丝数' }
  const scope = Array.isArray(audit.scope) ? audit.scope : []
  const scopeText = scope.length ? scope.map(item => scopeLabels[item] || item).join(' / ') : '未启用额外条件（性别不限、年龄与粉丝不限制）'
  // "未核实"不等于"未知"：这里统一用"未核实"，避免让人以为资料已经查过、只是没有。
  const pendingLabels = { AGE_UNVERIFIED: '年龄未核实', GENDER_UNVERIFIED: '性别未核实', FOLLOWERS_UNVERIFIED: '粉丝数未核实', AGE_CONFLICT: '年龄信息冲突', GENDER_CONFLICT: '性别信息冲突', INSUFFICIENT_INFO: '资料不足' }
  const pendingEntries = Object.entries(planSummary.pendingVerification || {})
  const pendingText = pendingEntries.length ? pendingEntries.map(([code, count]) => `${pendingLabels[code] || code} ${count}`).join(' · ') : '无待核实'
  return `<div class="panel" id="auto-contact-panel"><h3>自动发现运行面板</h3>
    <p class="muted">当前模式：<strong>${mode === 'auto' ? '正式自动模式' : '训练模式'}</strong> · 状态：${esc(runningText)}${mode === 'auto' ? ` · ${autoConfig.autoFollow ? `批次结束后自动真实执行（单批上限 ${autoConfig.batchAutoLimit ?? 1} 人，意愿门槛：${autoConfig.autoMinIntent === 'explicit' ? '明确表达' : '有一点意愿即可'}）` : '自动关注未开启，批次结束后不会真实执行'}` : ' · 训练模式只在卡片上逐人手动执行，不会自动发'}</p>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      ${mode === 'auto'
        ? `<button class="btn primary" data-act="auto-follow-now" ${busy || !autoConfig.autoFollow || authorized === 0 ? 'disabled' : ''}>正式一键关注（真实执行）</button><button class="btn" data-act="auto-run" ${busy ? 'disabled' : ''}>发现并生成计划（Dry Run）</button><button class="btn" data-act="auto-plan" ${busy ? 'disabled' : ''}>预览执行计划</button><button class="btn small" data-act="auto-audit" ${busy ? 'disabled' : ''}>重新审计资格</button><button class="btn small" data-act="auto-open-settings">开启自动关注</button>`
        : `<button class="btn primary" data-act="auto-training-run" ${busy ? 'disabled' : ''}>开始训练发现</button>`}
      ${mode === 'auto' ? `<button class="btn small" data-act="auto-pause" ${busy || auto.status === 'paused' ? 'disabled' : ''}>暂停</button><button class="btn small" data-act="auto-resume" ${busy || !['paused', 'stopped'].includes(auto.status) ? 'disabled' : ''}>继续</button><button class="btn small" data-act="auto-stop" ${busy ? 'disabled' : ''}>紧急停止</button>` : ''}
      <span class="muted">训练模式不关注、不私信；正式模式下批次结束即按硬红线自动关注并发第一句，无需逐人授权。</span>
    </div>
    <div class="grid2" style="margin-top:10px">
      ${tile('已同步视频', stats.favoriteVideos || 0, favorites.folderName ? `收藏夹：${favorites.folderName}` : '尚未指定收藏夹')}
      ${tile('已分析视频', counters.videosCompleted || 0)}
      ${tile('已采集评论', stats.comments || 0, `累计新增 ${counters.commentsCollected || 0} · 去重 ${counters.commentsSkipped || 0}`)}
      ${tile('已生成候选人', (S.data?.discovery?.candidates || []).length)}
      ${tile('AI 调用与 Token', `${counters.aiCalls || 0} 次 / ${counters.tokens || 0}`)}
      ${tile('待执行 / 失败', `${queueCounts.followPending + queueCounts.firstMessagePending} / ${(pipeline.errors || []).length || 0}`)}
    </div>
    ${mode === 'auto' ? `<div class="grid2" style="margin-top:10px">
      ${tile('发现候选数', planSummary.total ?? 0, '进入候选池的全部人，不等于合格人数')}
      ${tile('满足全部必需条件', planSummary.qualified ?? planSummary.follow ?? 0, `必需条件：${scopeText}`)}
      ${tile('待核实', planSummary.pendingVerificationTotal || 0, pendingText)}
      ${tile('已排除', planSummary.blocked || 0, '不满足意向、年龄、性别或粉丝条件')}
      ${tile('可真实执行', auditCounts.actionAuthorized || 0, '需平台权限 + 对方同意 + 操作者确认')}
    </div>
    <p class="muted" style="margin-top:6px">口径：满足全部必需条件 ${planSummary.qualified ?? 0} 人（必需条件：${scopeText}），来自候选 ${planSummary.total ?? 0} 人；其中 ${planSummary.pendingVerificationTotal || 0} 人待核实、${planSummary.blocked || 0} 人被排除，其余为已关注等跳过项。待核实只表示资料不足，既不算合格也不算不合格，不会进入自动流程。关注计划 ${auditCounts.followPlans || 0} 条、首次联系计划 ${auditCounts.firstMessagePlans || 0} 条；模拟完成 ${queueCounts.followSimulated}、真实完成 ${queueCounts.followReal}。</p>
    <p class="muted" style="margin-top:8px">今日预算：真实关注 ${auto.budget?.realFollows ?? 0}/${autoConfig.dailyFollowLimit ?? 0} · 真实首次联系 ${auto.budget?.realMessages ?? 0}/${autoConfig.dailyFirstMessageLimit ?? 0} · Dry Run 模拟 ${(auto.budget?.simulatedFollows ?? 0) + (auto.budget?.simulatedMessages ?? 0)} 次（不占用真实额度）${queueCounts.uncertain ? ` · 结果不确定 ${queueCounts.uncertain} 条（禁止自动重试）` : ''}；自动关注${autoConfig.autoFollow ? '已开启，但真实执行仍需上述三项授权' : '未开启（需在高级设置中开启）'}；自动首次联系${autoConfig.autoFirstMessage ? '已开启，但发送仍为 Dry Run' : '未开启'}。</p>
    ${(queueCounts.uncertainTasks || []).length ? `<div class="card" style="margin-top:8px"><p><strong>结果未知，已停止自动重试（${queueCounts.uncertainTasks.length} 条）</strong></p>${queueCounts.uncertainTasks.map(task => `<p class="muted">${esc(task.action === 'follow' ? '关注' : '首次联系')} · ${esc(task.nickname || task.platformUserId || task.taskId)} · ${esc(task.reasonCode || '')} · ${esc(task.reason || '')}</p>`).join('')}<p class="muted">平台可能已执行，系统不会自动重试。确认未执行后才能重新排队；确认已执行则按完成记账。</p></div>` : ''}
    ${configNotes.length ? `<p class="muted" style="margin-top:4px">审计口径：${configNotes.map(note => esc(note)).join('；')}</p>` : ''}
    ${Object.keys(auditReasons).length ? `<p class="muted" style="margin-top:4px">动作阻断原因：${Object.entries(auditReasons).map(([code, count]) => `${esc(code)} ${count}`).join('；')}</p>` : ''}` : ''}
    ${auto.lastError ? `<p class="notice" style="margin-top:8px">${esc(auto.lastError)}</p>` : ''}
    ${auto.stoppedReason ? `<p class="notice" style="margin-top:8px">${esc(auto.stoppedReason)}</p>` : ''}
    <h4 style="margin:12px 0 6px">${mode === 'auto' ? '自动筛选与首次联系资格' : '候选人与审核提示'}</h4>
    ${plans.length ? plans.slice(0, 20).map(plan => {
      const explain = (audit.explanations || []).find(item => item.platformUserId === plan.platformUserId)
      return `<div class="card"><p><strong>${esc(plan.nickname || plan.platformUserId || '未知')}</strong> <span class="muted">${esc(plan.grade || '')} · ${esc(plan.intent || '')}</span></p><p class="muted">关注计划：${esc(autoActionText(plan.follow))}</p><p class="muted">首次联系计划：${esc(autoActionText(plan.firstMessage))}${plan.firstMessage?.consentEvidenceId ? ` · 证据 ${esc(plan.firstMessage.consentEvidenceId)}` : ''}</p>${explain ? `<p class="muted">联系资格：${esc(explain.contactStatus)}${explain.contactReasons?.length ? `（${explain.contactReasons.map(esc).join('、')}）` : ''} · 动作授权：${esc(explain.actionStatus)}${explain.actionReasons?.length ? `（${explain.actionReasons.map(esc).join('、')}）` : ''}</p>` : ''}${plan.firstMessage?.message?.text ? `<p class="muted" style="overflow-wrap:anywhere">开场白：${esc(plan.firstMessage.message.text)}</p>` : ''}</div>`
    }).join('') : `<p class="muted">${mode === 'auto' ? '还没有执行计划。点击“预览执行计划”查看筛选结果。' : '训练模式的候选审核队列在下方；所有候选人仍需人工确认。'}</p>`}
  </div>`
}
function autoAdvancedSettingsView() {
  const auto = autoContactStateOf(), c = auto.config || {}
  return `<details class="panel" id="auto-advanced" style="margin-top:12px"><summary><strong>自动执行设置（高级）</strong></summary>
    <div class="card" style="margin-top:10px">
      <h4>自动执行与安全</h4>
      <p class="muted">人群筛选请在上方批次表单中设置。正式自动模式可能执行真实关注和发送第一句，受单批人数及每日额度限制；遇到安全验证需手动处理，发送结果待核实时不会自动重发。</p>
      <div class="row" style="flex-wrap:wrap;margin-top:8px">
        <label><input type="checkbox" id="auto-follow-enabled" ${c.autoFollow ? 'checked' : ''}> 允许自动关注</label>
        <label><input type="checkbox" id="auto-message-enabled" ${c.autoFirstMessage ? 'checked' : ''}> 允许自动首次联系</label>
        <div class="field"><label>每日关注上限</label><input id="auto-follow-limit" type="number" min="0" max="100" value="${Number(c.dailyFollowLimit) || 0}"></div>
        <div class="field"><label>每日首次联系上限</label><input id="auto-message-limit" type="number" min="0" max="100" value="${Number(c.dailyFirstMessageLimit) || 0}"></div>
        <div class="field"><label>失败重试上限</label><input id="auto-max-attempts" type="number" min="1" max="5" value="${Number(c.maxAttempts) || 2}"></div>
      </div>
      <div class="row" style="margin-top:8px;flex-wrap:wrap">
        <button class="btn primary" data-act="auto-config-save" ${S.library.autoBusy ? 'disabled' : ''}>保存自动执行设置</button>
        <button class="btn small" data-act="auto-reset" ${S.library.autoBusy ? 'disabled' : ''}>清空自动联系队列</button>
        <span class="muted">清空只影响关注/首条消息队列，不删除候选人与学习数据。</span>
      </div>
    </div>
  </details>`
}
const BATCH_STATUS_LABELS = { idle: '未开始', running: '寻找中', paused: '已暂停', stopped: '已停止', done: '已结束', failed: '失败', interrupted: '已中断（可继续）' }
const BATCH_SOURCE_LABELS = { keyword: '关键词', hashtag: '标签', favorites: '收藏夹' }
const BATCH_REASON_LABELS = {
  INTENT_BELOW_MINIMUM: '低于本批入池意愿标准', NOT_FRIENDLY_INTENT: '交友意愿不足', GENDER_MISMATCH: '性别不符合', GENDER_UNVERIFIED: '性别未核实', GENDER_CONFLICT: '性别信息冲突',
  AGE_UNVERIFIED: '年龄未核实', AGE_OUT_OF_RANGE: '年龄超出范围', IP_UNVERIFIED: '评论IP未核实', IP_MISMATCH: '评论IP不符合',
  FOLLOWERS_UNVERIFIED: '粉丝数未核实', FOLLOWERS_OUT_OF_RANGE: '粉丝数超出范围', REPLIES_UNVERIFIED: '回复数未核实', REPLIES_OUT_OF_RANGE: '回复数超出范围',
  PROFILE_CHECK_LIMIT: '核验额度已用完，尚未核实',
  CANDIDATE_SAVE_FAILED: '候选写入失败',
}
// 采集结果分类与停止原因：界面必须能一眼分清"没读到"和"读了但没有值得联系的人"。
const COLLECTION_LABELS = {
  VIDEO_COMMENTS_BELOW_MIN: '视频总评论不足',
  READ_CANCELLED: '读取任务已切换', READ_TARGET_MISMATCH: '作品身份不一致',
  COLLECTED_NEW: '读到新评论', COLLECTED_NO_NEW: '无新增评论', NO_COMMENTS: '确实没有评论',
  PANEL_NOT_LOADED: '评论区未加载', COMMENTS_CLOSED: '评论已关闭', VIDEO_NOT_FOUND: '内容不存在',
  CONTENT_UNSUPPORTED: '内容类型不支持', LOGIN_REQUIRED: '登录态不可用', VERIFICATION_REQUIRED: '需要安全验证',
  RATE_LIMITED: '被限流', TIMEOUT: '读取超时', NETWORK_ERROR: '页面/网络错误', ERROR: '未知错误',
  LOW_VALUE: '试采价值不足', FILTER_BLOCKED: '筛选挡下', NO_RECORDS: '没有生成候选记录', CANDIDATE_BUILD_FAILED: '候选生成失败',
}
const BATCH_STOP_LABELS = {
  PROFILE_CHECK_LIMIT: '主页核验额度已用完，保留待核实对象',
  READ_CANCELLED: '读取任务切换，已暂停', READ_TARGET_MISMATCH: '页面与目标不一致，已暂停',
  TARGET_REACHED: '已达到目标人数', QUEUE_EXHAUSTED: '队列处理完，候选不足', BUDGET_TIME: '达到时间上限',
  BUDGET_COMMENTS: '达到采集量上限', BUDGET_VIDEOS: '达到视频处理上限', BUDGET_AI: '达到模型调用上限',
  USER_STOP: '用户停止', USER_PAUSE: '用户暂停', ERROR: '批次出错',
  SOURCE_FAILED: '视频来源读取失败', COLLECTION_FAILED: '评论读取失败',
  CONSECUTIVE_FAILURES: '连续三个视频读取失败，已暂停，可查看诊断后继续',
  CHALLENGE: '需要完成安全验证', LOGIN_REQUIRED: '需要重新登录', WINDOW_CLOSED: '读取窗口已关闭',
}
const IP_SOURCE_LABELS = { explicit_label: '页面标注', footer_region: '评论区地区', unknown: '来源未记录', not_present: '页面无该字段' }
function batchState() {
  if (!S.discovery.batch) S.discovery.batch = { data: null, cards: [], busy: false, texts: {}, replies: {}, loaded: false }
  return S.discovery.batch
}
function batchConfigOf() { return batchState().data?.config || null }
function batchRunning() { const st = batchState().data?.status; return st === 'running' || st === 'paused' }
function batchSourceText(card) {
  const label = BATCH_SOURCE_LABELS[card.sourceType] || card.sourceType || '-'
  return card.sourceQuery ? `${label}：${card.sourceQuery}` : label
}
function batchProfileReadView(b) {
  const rows = b?.genderReadResults || []
  if (!rows.length) return ''
  const names = { found: '读到公开资料', not_present: '未识别到所需字段', failed: '读取失败', blocked: '需人工处理' }
  const details = rows.slice(-10).map(row => {
    const label = row.code === 'PROFILE_UNAVAILABLE' ? '主页未能核验（本批跳过）' : names[row.status] || row.status
    const networkLabel = ({ observing: '已记录请求结果', initializing: '正在准备记录', unavailable: '本轮未能记录请求结果', already_attached: '调试工具占用，本轮未记录', detached: '请求记录已中断' })[row.diagnostics?.network?.availability] || '未记录请求结果'
    const videoId = /^\d{1,30}$/.test(String(row.sourceVideoId || '')) ? row.sourceVideoId : ''
    const profile = /^https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9_-]+$/.test(String(row.profileUrl || '')) ? row.profileUrl : ''
    return `<div style="margin:8px 0;overflow-wrap:anywhere"><b>${esc(row.nickname || '候选人')}</b> · ${esc(label)} · 第 ${esc(row.readAttempts || 1)} 次<br>${esc(row.reason || row.code || '')}${row.diagnostics?.elapsedMs ? ` · ${Math.round(row.diagnostics.elapsedMs / 100) / 10} 秒` : ''}
      ${videoId ? `<br><a href="https://www.douyin.com/video/${esc(videoId)}" target="_blank" rel="noopener noreferrer">原视频</a>` : ''}${profile ? ` · <a href="${esc(profile)}" target="_blank" rel="noopener noreferrer">核验主页</a>` : ''}
      ${row.requestedFields?.includes('age') ? `<br>公开年龄：${Number.isSafeInteger(row.publicSignals?.age) ? esc(row.publicSignals.age) + '岁' : row.fieldStatuses?.age === 'conflict' ? '信息冲突' : ['failed','blocked'].includes(row.status) ? '未完成读取' : '未公开'}` : ''}
      ${row.sourceCommentText ? `<br>原评论：${esc(row.sourceCommentText)}` : ''}
      ${row.diagnostics?.profileNavigation?.length ? `<br>主页入口：${row.diagnostics.profileNavigation.map(x=>esc(`${x.method}${x.query ? '（'+x.query+'）' : ''} · ${x.status}${x.code ? ' · '+x.code : ''}${Number.isFinite(x.elapsedMs) ? ' · '+Math.round(x.elapsedMs/100)/10+'秒' : ''}${x.reason ? ' · '+x.reason : ''}`)).join('<br>→ ')}` : ''}
      ${row.source ? `<br>验证窗口：${esc(row.source)}` : ''}${row.diagnostics?.initialScreenshotPath ? `<br><span class="muted">资料刚出现时：${esc(row.diagnostics.initialScreenshotPath)}</span>` : ''}${row.diagnostics?.pageTransitions?.length ? `<br><span class="muted">已记录 ${row.diagnostics.pageTransitions.length} 次页面变化；${esc(networkLabel)}</span>` : ''}${row.diagnostics?.recordPath ? `<br><span class="muted">现场记录：${esc(row.diagnostics.recordPath)}</span>` : ''}${row.diagnostics?.screenshotPath ? `<br><span class="muted">截图：${esc(row.diagnostics.screenshotPath)}</span>` : ''}</div>`
  }).join('')
  const cap = Math.min(60, (b.config?.target || 20) * 2)
  return `<details style="margin:8px 0"><summary>主页核验详情（最近 ${Math.min(10, rows.length)} 次）</summary>${details}${b.progress?.genderChecks >= cap ? '<p class="muted">本批主页核验次数已用完；所需性别或年龄未知的候选仍保留待核实，不会放宽筛选条件。</p>' : ''}</details>`
}
function batchIntentOptions(value = 'CONTEXTUAL_INTEREST') {
  return [['EXPLICIT_INVITATION','明确欢迎认识或私信'],['SEEKING_FRIENDS','表达交友或找搭子意愿'],['CONTEXTUAL_INTEREST','结合视频语境可能有交友意愿']].map(([v,label]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${label}及以上</option>`).join('')
}
function batchWarningsView(batch) {
  return (batch?.warnings || []).map(warning => `<p style="margin:6px 0 0;color:#b45309">⚠ ${esc(warning)}</p>`).join('')
}
function batchPanelView() {
  const b = batchState().data, config = batchState().formConfig || b?.config
  const progress = b?.progress || {}
  const filters = config?.filters || { gender: 'any' }
  const status = b?.status || 'idle'
  const running = status === 'running', paused = status === 'paused', active = BatchLike(status)
  const customTarget = active ? b?.targetSnapshot : selectedGoal()
  const keywords = (config?.sources?.keywords || []).join('、')
  const tags = (config?.sources?.tags || []).join('、')
  return `<div class="panel" id="batch-panel" data-batch-stamp="${esc(b?.updatedAt || b?.id || '')}"><h3>批次寻找（关键词 / 标签 / 收藏夹）</h3>
    <div id="current-search-goal">${currentSearchGoalView()}</div>
    <p class="muted">三种来源可任意组合；视频按 ID 去重并保留来源。关键词与标签会先试采评论判断是否值得继续，收藏夹直接采集。找够目标人数即停，处理候选后不会自动补人；达到预算上限时交付实际人数，不放宽条件。</p>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>关键词（逗号、顿号、分号或换行分隔，最多10个）</label><textarea id="batch-keywords" maxlength="600" placeholder="例如：找对象，同城交友">${esc(keywords)}</textarea></div>
      <div class="field"><label>标签（逗号、顿号、分号或换行分隔，最多10个）</label><textarea id="batch-tags" maxlength="600" placeholder="例如：脱单，找对象（可带#）">${esc(tags)}</textarea></div>
      <div class="field"><label><input type="checkbox" id="batch-combined-search" ${config?.sources?.combinedSearch !== false ? 'checked' : ''}/>优先组合多个词搜索</label><span class="muted">例如“找对象，同城交友”会先组合搜索，并优先读取标题或话题命中更多词的视频。也支持 |、/ 分隔；空格保留在词内。</span></div>
    </div>
    <div class="row" style="margin-top:10px">
      <label><input type="checkbox" id="batch-favorites" ${config?.sources?.favorites ? 'checked' : ''}> 使用收藏夹来源</label>
      <input id="batch-favorites-folder" maxlength="80" value="${esc(batchState().favoritesFolder ?? S.library.data?.favorites?.folderName ?? '')}" aria-label="抖音收藏夹名称" placeholder="抖音收藏夹名称">
      <button class="btn small" data-act="batch-favorites-save">保存名称</button>
    </div>
    <div class="grid3" style="margin-top:10px">
      <div class="field"><label>目标人数</label><input id="batch-target" type="number" min="1" max="100" value="${esc(config?.target ?? 20)}"></div>
      <div class="field"><label>最多处理视频数</label><input id="batch-max-videos" type="number" min="1" max="200" value="${esc(config?.budgets?.maxVideos ?? 30)}"></div>
      <div class="field"><label>最多采集评论数</label><input id="batch-max-comments" type="number" min="10" max="2000" value="${esc(config?.budgets?.maxComments ?? 400)}"></div>
      <div class="field"><label>时间上限（分钟）</label><input id="batch-max-minutes" type="number" min="1" max="240" value="${esc(config?.budgets?.maxMinutes ?? 30)}"></div>
      <div class="field"><label>视频最低评论数（0 表示不限）</label><input id="batch-min-video-comments" type="number" min="0" max="1000000" value="${esc(config?.minVideoComments ?? 20)}"><small class="muted">按视频总评论数筛选；未知先读取确认，不按已采集条数判断。</small></div>
      <div class="field"><label>本批最多核验主页数</label><input id="batch-profile-limit" type="number" min="1" max="60" value="${esc(config?.maxProfileChecks ?? Math.min(60,(config?.target || 20)*2))}"><small class="muted">额度用完会暂停，未知资料不当作不符合；修改用于下一批。</small></div>
      <div class="field"><label>模型调用上限</label><input id="batch-max-ai" type="number" min="0" max="200" value="${esc(config?.budgets?.maxAiCalls ?? 30)}"></div>

    </div>
    <h4 style="margin:14px 0 6px">每个视频的分轮采样</h4>
    <div class="grid3">${[['first','第一轮新增评论数',30],['second','第二轮新增评论数',40],['later','第三轮及以后每轮新增评论数',50]].map(([key,label,def]) => `<div class="field"><label>${label}</label><input id="batch-round-${key}" type="number" min="1" max="200" value="${esc(config?.sampling?.[key] ?? def)}"></div>`).join('')}</div>
    <div class="field"><label>${customTarget ? '继续深挖视频的标准：本轮至少一条符合目标' : '继续深挖视频的最低意愿'}</label><select id="batch-continue-intent" ${customTarget ? 'disabled' : ''}>${customTarget ? '<option value="CONTEXTUAL_INTEREST">符合当前自定义目标</option>' : batchIntentOptions(config?.sampling?.continueMinIntent)}</select></div>
    <p class="muted">每轮只要有一条达到深挖标准就继续，否则换下一个视频。默认依次新增 30、40、50 条，之后每轮 50 条。评论读完或预算用尽会提前停止；收藏夹继续沿用直接采集。入池标准单独设置，降低意愿门槛不会放宽硬性筛选或授予私信许可。修改设置用于下一批，暂停后继续仍用本批原设置。</p>
    ${batchRequirementsView()}
    <div class="field"><label>${customTarget ? '候选入池标准' : '纳入候选池的最低意愿'}</label><select id="batch-min-intent" ${customTarget ? 'disabled' : ''}>${customTarget ? '<option value="CONTEXTUAL_INTEREST">符合当前自定义目标</option>' : batchIntentOptions(filters.minIntent)}</select><small class="muted">${customTarget ? '只有“符合”计入目标人数；“值得确认”单独展示，仍须满足下方已开启的筛选条件。' : '仅上面三档可入池；普通评论、拒绝联系、广告和无法判断均不纳入。'}</small></div>
    <h4 style="margin:14px 0 6px">对象筛选条件（各自可限制或不限）</h4>
    <div class="grid3">
      <div class="field"><label>性别</label><select id="batch-gender">${[['any', '不限'], ['female', '仅女性'], ['male', '仅男性']].map(([v, l]) => `<option value="${v}" ${(filters.gender || 'any') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>年龄</label><select id="batch-age-required"><option value="off" ${!filters.requireAgeRange ? 'selected' : ''}>不限</option><option value="on" ${filters.requireAgeRange ? 'selected' : ''}>限制区间</option></select></div>
      <div class="field"><label>年龄区间</label><div class="row"><input id="batch-age-min" type="number" min="18" max="100" value="${esc(filters.ageMin ?? 18)}" style="width:80px"><span>–</span><input id="batch-age-max" type="number" min="18" max="100" value="${esc(filters.ageMax ?? 45)}" style="width:80px"></div></div>
      <div class="field"><label>评论IP属地</label><select id="batch-ip-required"><option value="off" ${!filters.requireIp ? 'selected' : ''}>不限</option><option value="on" ${filters.requireIp ? 'selected' : ''}>限制地区</option></select></div>
      <div class="field"><label>允许的地区（逗号分隔）</label><input id="batch-ip-values" maxlength="200" value="${esc((filters.ipValues || []).join('、'))}" placeholder="例如：广东、江苏"></div>
      <div class="field"><label>粉丝数</label><select id="batch-followers-required"><option value="off" ${!filters.requireFollowerLimit ? 'selected' : ''}>不限</option><option value="on" ${filters.requireFollowerLimit ? 'selected' : ''}>少于指定值</option></select></div>
      <div class="field"><label>粉丝数少于</label><input id="batch-followers" type="number" min="1" max="10000000" value="${esc(filters.followerLimit ?? 1000)}"></div>
      <div class="field"><label>评论回复数</label><select id="batch-replies-required"><option value="off" ${!filters.requireReplyLimit ? 'selected' : ''}>不限</option><option value="on" ${filters.requireReplyLimit ? 'selected' : ''}>不超过指定值</option></select></div>
      <div class="field"><label>回复数不超过</label><input id="batch-replies" type="number" min="0" max="1000" value="${esc(filters.replyLimit ?? 5)}"></div>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" data-act="batch-start" ${active || batchState().busy || batchState().parsing ? 'disabled' : ''}>开始寻找</button>
      <button class="btn" data-act="batch-pause" ${!running || batchState().busy ? 'disabled' : ''}>暂停</button>
      <button class="btn" data-act="batch-resume" ${batchState().busy || !(paused || status === 'interrupted' || status === 'failed' && b?.stopCode === 'CHALLENGE') ? 'disabled' : ''}>继续</button>
      <button class="btn" data-act="batch-stop" ${!active || batchState().busy ? 'disabled' : ''}>停止</button>
      <button class="btn" data-act="batch-clear" ${!(b?.added || []).length ? 'disabled' : ''}>清空本批</button>
    </div>
    <p class="muted" style="margin-top:10px">状态：<b>${esc(BATCH_STATUS_LABELS[status] || status)}</b>${b?.reason ? ' · ' + esc(b.reason) : ''}${b?.phase ? ' · ' + esc(b.phase) : ''}</p>
    ${b?.sourceProgress ? `<p class="muted">当前来源步骤：${esc(b.sourceProgress.phase || '')} · <span data-source-wait-start="${esc(b.sourceProgress.phaseStartedAt || '')}">0</span> 秒${b.sourceProgress.stageTimings?.length ? ` · 已完成：${b.sourceProgress.stageTimings.map(x => `${esc(x.phase)} ${Math.round(x.ms / 100) / 10}秒`).join('、')}` : ''}</p>` : ''}
    <div id="batch-warnings">${batchWarningsView(b)}</div>
    ${b?.draftError ? `<p style="margin:6px 0 0;color:#b45309">⚠ 首句未自动生成：${esc(b.draftError)}（可在候选卡片上点「重新生成首句」）</p>` : ''}
    <p class="muted">已入批 ${progress.qualified ?? (b?.added || []).length} / ${config?.target ?? '-'} 人 · 视频 ${progress.videosEvaluated ?? 0} 个（跳过 ${progress.videosSkipped ?? 0}，其中评论不足 ${progress.videosLowComments ?? 0}，读取失败 ${progress.videosFailed ?? 0}）</p>
    <p class="muted">评论：页面读到 ${progress.commentsFetched ?? 0} 条 · 新增入库 ${progress.commentsAdded ?? 0} 条 · 库内已有 ${progress.commentsExisting ?? 0} 条 · ${b?.targetSnapshot ? '符合目标' : '有交友意愿'} ${progress.commentsUsable ?? 0} 条 · 待补分类 ${progress.classifyTargets ?? 0} 条</p>
    ${progress.genderChecks ? `<p class="muted">主页核验 ${progress.genderChecks} / ${(config?.maxProfileChecks ?? Math.min(60, (config?.target || 20) * 2))} 次 · 性别读到 ${progress.genderFound || 0} · 未识别 ${progress.genderMissing || 0} · 读取失败 ${progress.genderErrors || 0}${progress.genderUnavailable ? `（其中页面提示用户不存在 ${progress.genderUnavailable}）` : ''} · 信息冲突 ${progress.genderConflicts || 0} · 年龄读到 ${progress.ageFound || 0} · 年龄未识别 ${progress.ageMissing || 0} · 年龄读取失败 ${progress.ageErrors || 0} · 年龄冲突 ${progress.ageConflicts || 0}</p>` : ''}
    ${b?.crossVideoClassification ? `<p class="muted">待判断队列 ${(b.classificationQueue || []).length} 条 · 跨视频累计20条处理，队列收尾时不足20条也处理</p>` : ''}
    ${b?.profileReadCircuit?.disabled ? `<p class="muted">主页读取已退化：不同主页的可用入口连续核验失败，本批不再自动打开主页；评论寻找继续，需要性别或年龄核验的人已保留待核实。</p>` : ''}
    ${(b?.profileDeferred || []).length ? `<details><summary>资料待核实（${b.profileDeferred.length} 人，不占已入批人数）</summary>${b.profileDeferred.slice(-100).map(x => `<p><b>${esc(x.nickname)}</b> · ${(x.reasons || []).map(r => esc(BATCH_REASON_LABELS[r] || r)).join('、')}<br>${esc(x.source?.commentText || '')}<br>来源视频 ${esc(x.source?.videoId || '')} · ${esc(x.profileUrl || '')}</p>`).join('')}</details>` : ''}
    ${batchProfileReadView(b)}
    <details><summary>逐人筛选明细（最近 ${(b?.candidateDecisions || []).length} 次）</summary>${(b?.candidateDecisions || []).slice(-200).map(x => `<p><b>${esc(x.nickname)}</b> · ${esc(({qualified:'符合',pending:'待核实',excluded:'不符合'})[x.status] || x.status)} · ${esc((x.reasons || []).map(r => BATCH_REASON_LABELS[r] || r).join('、') || '已通过全部条件')} · 性别 ${esc(x.facts?.gender || 'unknown')} · 年龄 ${esc(x.facts?.age ?? '未识别')}</p>`).join('')}</details>
    <details><summary>最近批次核对记录</summary>${(batchState().history || []).map(x=>`<p>${esc(x.startedAt)} · ${esc(x.status)} · 核验 ${(x.genderReadResults || []).length} 次 · 筛选明细 ${(x.candidateDecisions || []).length} 条</p>`).join('')}</details>
    <p class="muted">候选：生成记录 ${progress.candidatesSeen ?? 0} 条 · 筛选挡下 ${progress.filtered ?? 0}（不符合 ${progress.excluded ?? 0} / 待核实 ${progress.pending ?? 0}）· 入批 ${progress.qualified ?? 0} 人${progress.poolExisting ? ` · 池内已有 ${progress.poolExisting} 人（资料已刷新，不占名额）` : ''}</p>
    <p class="muted">成本：模型 ${progress.aiCalls ?? 0} 次 / ${progress.tokens ?? 0} tokens · 预生成首句 ${progress.drafts ?? 0} 条 · 用时 ${progress.minutes ?? 0} 分钟${b?.perf?.avgVideoMs ? ` · 平均每视频 ${Math.round(b.perf.avgVideoMs / 100) / 10} 秒（采集 ${Math.round((b.perf.collectMs || 0) / 100) / 10}s / 分类 ${Math.round((b.perf.classifyMs || 0) / 100) / 10}s / 建候选 ${Math.round((b.perf.recordsMs || 0) / 100) / 10}s / 筛选 ${Math.round((b.perf.filterMs || 0) / 100) / 10}s）` : ''}</p>
    ${b?.stopCode ? `<p class="muted">停止原因：${esc(BATCH_STOP_LABELS[b.stopCode] || b.stopCode)}</p>` : ''}
    ${b?.diagnostics?.byCode && Object.keys(b.diagnostics.byCode).length ? `<p class="muted">采集结果：${Object.entries(b.diagnostics.byCode).map(([code, n]) => `${esc(COLLECTION_LABELS[code] || code)} ${n}`).join(' · ')}</p>` : ''}
    ${(b?.sourceRuns || []).length ? `<p class="muted">来源：${b.sourceRuns.map(r => {
      if (r.sourceType === 'favorites') {
        const sync = r.events?.[0]?.sync
        const folder = sync?.favorites?.folderName ? `「${esc(sync.favorites.folderName)}」` : ''
        const syncText = !sync ? '未执行同步'
          : sync.ok ? `同步成功（本次新收 ${sync.added || 0} / 页面可见 ${sync.found || 0} / 重复 ${sync.duplicates || 0}）`
          : `同步未完成（${esc(sync.code || 'SYNC_FAILED')}：${esc(sync.reason || '')}${sync.nextAction ? '；' + esc(sync.nextAction) : ''}）`
        return `收藏夹${folder} · ${syncText} · 按素材库收藏视频 ${r.videos || 0} 个入队`
      }
      const failure = !r.ok ? `（${esc(COLLECTION_LABELS[r.kind] || r.kind || '读取失败')}）` : ''
      const fromPage = r.events?.some(e => e.fallback === 'visible_page') ? ' · 已读取页面可见视频' : ''
      return `${esc(BATCH_SOURCE_LABELS[r.sourceType] || r.sourceType)}「${esc(r.query || '')}」${r.ok ? '成功' : '失败'}${failure} ${r.videos || 0} 个视频${fromPage}`
    }).join(' · ')}</p>` : ''}
    ${(b?.queue || []).length ? batchQueueView(b) : ''}
    <p class="muted" style="margin-top:6px">手动点「关注并发送第一句（真实）」时，你确认的对象与内容会直接执行，程序不做任何条件审核（只要求有主页地址和首句）；点之前会二次确认。“只演练（Dry Run）”不产生任何真实动作。正式模式下批次结束会按硬红线自动执行，默认单批只发 1 人试水。</p>
    ${b?.autoContact ? `<div class="panel" style="margin-top:8px"><b>批次结束后的自动联系</b><p class="muted">${esc(b.autoContact.at || '')} · 意愿门槛 ${b.autoContact.minIntent === 'explicit' ? '明确表达' : '有一点意愿即可'} · 本轮上限 ${esc(b.autoContact.limit)} 人 · 成功 ${esc(b.autoContact.followed || 0)} 人（已发首句 ${esc(b.autoContact.messaged || 0)} 人）${b.autoContact.code ? ` · 未执行：${esc(b.autoContact.reason || b.autoContact.code)}` : ''}</p>
      ${(b.autoContact.results || []).map(r => `<p class="muted" style="margin:2px 0">${esc(r.name || '')}：${({ confirmed: '✅关注成功', pending: '⏳关注申请中', unknown: '❓关注待核实', not_followed: '❌未关注' })[r.followStatus] || (r.ok ? '✅关注成功' : '❌未关注')} · ${({ sent: '✅第一句已发出', failed: '❌第一句未发出', unknown: '❓发送待核实', not_sent: '—未发送' })[r.messageStatus] || (r.ok ? '✅第一句已发出' : '❌未发出')}${r.needsReview ? ' · <b style="color:#b45309">已暂停自动重发，请人工核对</b>' : ''}${r.reason ? ` · ${esc(r.reason)}` : ''}</p>`).join('')}
      ${b.autoContact.code === 'UNCERTAIN_NEEDS_REVIEW' ? `<p style="margin:6px 0 0;color:#b45309"><b>⏸ 自动联系已整体暂停</b>：存在结果待核实的候选，请在候选卡片上人工核对并解除后，下一批才会恢复自动联系。</p>` : ''}
      ${(b.autoContact.skipped || []).length ? `<p class="muted">未进入本轮：${esc(b.autoContact.skipped.slice(0, 5).map(s => `${s.nickname || s.candidateId}（${s.reason || s.code}）`).join('；'))}${b.autoContact.skipped.length > 5 ? ` 等 ${b.autoContact.skipped.length} 人` : ''}</p>` : ''}
    </div>` : ''}
  </div>`
}
function BatchLike(status) { return status === 'running' || status === 'paused' }
// 逐视频诊断：每层计数分开列，定位"数据在哪一层丢了"不用再靠猜。
function batchQueueView(b) {
  const rows = (b.queue || []).slice(-80).map(item => {
    const st = item.stages || {}
    const code = item.blockReason || item.code || ''
    const reason = COLLECTION_LABELS[code] || BATCH_REASON_LABELS[code] || ''
    return `<tr>
      <td style="padding:3px 6px">${esc(item.videoId || '')}</td>
      <td style="padding:3px 6px">${esc(BATCH_SOURCE_LABELS[item.sourceType] || item.sourceType || '')}</td>
      <td style="padding:3px 6px">${esc(item.status || '')}</td>
      <td style="padding:3px 6px">${esc(reason || code || '-')}${item.error ? `<br><span class="muted">${esc(String(item.error).slice(0, 80))}</span>` : ''}${item.readDiagnostics ? `<details><summary>读取现场</summary><pre style="white-space:pre-wrap;max-width:420px;word-break:break-all">${esc(JSON.stringify(item.readDiagnostics, null, 2))}</pre></details>` : ''}</td>
      <td style="padding:3px 6px;text-align:right">${st.read ?? '-'}</td>
      <td style="padding:3px 6px;text-align:right">${st.existing ?? '-'}</td>
      <td style="padding:3px 6px;text-align:right">${st.fresh ?? '-'}</td>
      <td style="padding:3px 6px;text-align:right">${st.classifyTargets ?? '-'}</td>
      <td style="padding:3px 6px;text-align:right">${st.friendly ?? '-'}</td>
      <td style="padding:3px 6px;text-align:right">${st.records ?? '-'}</td>
      <td style="padding:3px 6px;text-align:right">${st.added ?? '-'}</td>
      <td style="padding:3px 6px;text-align:right">${item.ms ? Math.round(item.ms / 100) / 10 + 's' : '-'}</td>
    </tr>`
  }).join('')
  return `<details style="margin-top:8px"><summary class="muted">逐视频诊断（${b.queue.length} 个，显示最近 80 个）</summary>
    <div style="max-height:340px;overflow:auto;margin-top:6px">
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr class="muted">
          <th style="text-align:left;padding:3px 6px">视频</th><th style="text-align:left;padding:3px 6px">来源</th><th style="text-align:left;padding:3px 6px">状态</th><th style="text-align:left;padding:3px 6px">结果/阻断原因</th>
          <th style="padding:3px 6px">读取</th><th style="padding:3px 6px">已有</th><th style="padding:3px 6px">新增</th><th style="padding:3px 6px">待分类</th><th style="padding:3px 6px">意愿</th><th style="padding:3px 6px">记录</th><th style="padding:3px 6px">入批</th><th style="padding:3px 6px">耗时</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`
}
// 真实联系的三态结果：关注、第一句、待核实分别显示，不能用一个"失败"糊过去。
function contactOutcomeView(r, id) {
  if (!r) return ''
  const outcome = r.outcome || (r.ok ? (r.followPending ? 'FOLLOW_PENDING' : 'SENT') : 'FAILED')
  const follow = r.followStatus || (r.ok ? (r.followPending ? 'pending' : 'confirmed') : 'unknown')
  const message = r.messageStatus || (r.ok ? (r.followPending ? 'not_sent' : 'sent') : 'unknown')
  const followText = ({ confirmed: '✅ 关注成功', pending: '⏳ 关注申请中（待对方通过）', unknown: '❓ 关注结果待核实', not_followed: '❌ 未关注' })[follow] || '❓ 关注结果待核实'
  const messageText = ({ sent: '✅ 第一句已发出', failed: '❌ 第一句未发出', unknown: '❓ 发送结果待核实', not_sent: '— 第一句未发送' })[message] || '❓ 发送结果待核实'
  const label = ({ SENT: '已完成', FOLLOW_PENDING: '关注申请中', FOLLOW_OK_DM_FAILED: '关注成功、私信失败', REVIEWED: '已核对', UNCERTAIN: '结果待核实', FAILED: '执行失败', BLOCKED: '未执行' })[outcome] || outcome
  const uncertain = r.needsReview === true || outcome === 'UNCERTAIN'
  const note = r.ok ? (r.note || '') : (r.reason || r.code || '')
  return `<div class="panel" style="margin:8px 0 0;padding:8px 10px;${uncertain ? 'border:1px solid #d97706;background:#fffbeb' : ''}">
    <b>真实联系结果：${esc(label)}</b>
    <p class="muted" style="margin:4px 0 0">${esc(r.at || '')} · ${followText} · ${messageText}</p>
    ${note ? `<p class="muted" style="margin:4px 0 0">${esc(note)}</p>` : ''}
    ${uncertain ? `<p style="margin:6px 0 0;color:#b45309"><b>⏸ 已暂停自动重发</b>：无法确认关注或第一句是否已生效。请到交友窗口人工核对，确认后再解除；解除前不会自动再对任何人执行真实联系。</p>
      ${id ? `<div class="row" style="margin-top:6px"><button class="btn small" data-act="batch-contact-review" data-args="${esc(JSON.stringify({ id, conclusion: 'sent' }))}">确认已发出</button><button class="btn small" data-act="batch-contact-review" data-args="${esc(JSON.stringify({ id, conclusion: 'not_sent' }))}">确认未发出</button></div>` : ''}` : ''}
  </div>`
}
function replyBlockView(card, open) {
  if (!open) return ''
  if (open.loading) return `<div class="muted" style="margin-top:6px">正在读取该评论的回复…</div>`
  const replies = open.replies || []
  const retry = `<button class="btn small" data-act="batch-replies" data-args="${esc(JSON.stringify({ id: card.id, force: true }))}">重试</button>`
  if (open.state === 'failed') {
    return `<div style="margin-top:6px"><p style="color:#b91c1c;margin:2px 0">读取失败：${esc(open.note || open.error || '未知原因')}${open.retryable === false ? '（该原因重试通常无效）' : '（可重试）'}</p>${open.retryable === false ? '' : retry}</div>`
  }
  if (!replies.length) return `<div class="muted" style="margin-top:6px">${esc(open.note || '该评论没有可读回复')}</div>`
  const shown = open.loaded ?? replies.length
  const total = open.total ?? shown
  return `<div class="muted" style="margin-top:6px">
    <p style="margin:2px 0">已读取 ${shown}/${total} 条回复${open.cached ? '（来自缓存）' : ''}</p>
    ${replies.map(r => `<p style="margin:2px 0">· ${esc(r.text || '')}${r.author ? `（${esc(r.author)}）` : ''}</p>`).join('')}
    ${open.partial ? `<button class="btn small" data-act="batch-replies-more" data-args="${esc(JSON.stringify({ id: card.id }))}">继续加载</button>` : ''}
  </div>`
}
function batchTextKey(id, batch = batchState()) {
  return batch.data?.targetSnapshot ? `${batch.data.id}/${id}` : id
}
function batchCardsView() {
  const batch = batchState()
  const cards = batch.cards || []
  const checks = batch.data?.goalChecks || []
  const checkView = checks.length ? `<details style="margin:10px 0"><summary>值得确认（${checks.length} 条）</summary>${checks.map(row => `<div class="card"><p>${esc(row.text)}</p><p class="muted">${esc(row.videoTitle || row.videoId)} · ${esc(row.reason || '需要更多公开信息')}</p></div>`).join('')}</details>` : ''
  if (!cards.length) return `<div class="panel" id="batch-cards" data-batch-id="${esc(batch.data?.id || '')}"><h3>本批候选（按回复数升序）</h3><p class="muted">还没有候选。填好来源与目标人数后点“开始寻找”。</p>${checkView}</div>`
  const items = cards.map(card => {
    const open = batch.replies[card.id]
    const text = batch.texts[batchTextKey(card.id, batch)] ?? card.draftOpening ?? ''
    const gender = ({ female: '女', male: '男', conflict: '信息冲突', unknown: '未核实' })[card.gender] || '未核实'
    return `<div class="contact-item" style="cursor:default" data-batch-card="${esc(card.id)}">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
        <div class="row" style="gap:8px;align-items:center">
          ${card.avatarUrl ? `<img src="${esc(card.avatarUrl)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover">` : '<span style="width:36px;height:36px;border-radius:50%;background:#e5e7eb;display:inline-block"></span>'}
          <div><b>${esc(card.nickname || '（无昵称）')}</b><br><span class="muted">${esc(gender)} · 年龄${Number.isSafeInteger(card.age) ? esc(card.age) + '岁' : '未核实'} · 来源 ${esc(batchSourceText(card))}${card.sourceType ? '' : ' · 来源未知'} · 回复 ${card.replyCount === null || card.replyCount === undefined ? '未读取' : esc(card.replyCount)}</span></div>
        </div>
        <span class="muted">${esc(card.goalMatch ? `符合 ${card.goalMatch.name}` : card.intentClass === 'explicit' ? '明确交友意愿' : card.intentClass === 'general' ? '一般交流意愿' : '意愿未定')}</span>
      </div>
      <p style="margin:8px 0 4px;overflow-wrap:anywhere">「${esc(card.comment || '（无评论）')}」</p>
      <p class="muted">评论时间 ${esc(card.commentTime || '未读取')} · IP属地 ${esc(card.commentIp || '未读取')}${card.commentIp ? `（${esc(IP_SOURCE_LABELS[card.commentIpSource] || card.commentIpSource || '来源未记录')}）` : `（${esc(IP_SOURCE_LABELS[card.commentIpSource] || '页面无该字段')}）`} · 回复 ${card.replyTotal === null || card.replyTotal === undefined ? '未读取' : esc(card.replyTotal)} 条 · 来源视频 ${card.videoId ? `<a href="#" data-act="batch-open-video" data-args="${esc(JSON.stringify({ videoId: card.videoId }))}">${esc(card.videoId)}</a>` : '未知'}</p>
      ${card.goalMatch ? `<p class="muted">目标依据 · ${esc(card.goalMatch.reason || '已核对评论原文')} ${esc((card.goalMatch.evidence || []).join('；'))}</p>` : ''}
      <p class="muted">筛选依据：${esc((card.filterBasis || []).map(r => BATCH_REASON_LABELS[r] || r).join('、') || '全部条件符合')}</p>
      <div class="field" style="margin-top:6px"><label>第一句（可编辑，点“真实发送”会按这里的内容发出）</label><textarea id="batch-text-${esc(card.id)}" maxlength="300">${esc(text)}</textarea></div>
      ${card.mock ? `<p class="muted">模拟结果：${esc(card.mock.at)} 已绑定账号 ${esc(card.mock.accountId)}，候选 ${esc(card.mock.name || card.nickname || '')}，文本指纹 ${esc(card.mock.textHash)}，真实动作 ${esc(card.mock.realActions)} 次</p>` : ''}
      ${contactOutcomeView(card.realContact, card.id)}
      <div class="row" style="margin-top:6px">
        <button class="btn small" data-act="discovery-open" data-args="${esc(JSON.stringify({ id: card.id }))}">打开主页</button>
        <button class="btn small primary" data-act="batch-contact" data-args="${esc(JSON.stringify({ id: card.id }))}">关注并发送第一句（真实）</button>
        <button class="btn small" data-act="batch-send-mock" data-args="${esc(JSON.stringify({ id: card.id }))}">只演练（Dry Run）</button>
        <button class="btn small" data-act="batch-draft" data-args="${esc(JSON.stringify({ id: card.id }))}">重新生成首句</button>
        <button class="btn small" data-act="batch-replies" data-args="${esc(JSON.stringify({ id: card.id }))}">${open ? '收起回复' : '读取回复'}</button>
        <button class="btn small" data-act="batch-not-interested" data-args="${esc(JSON.stringify({ id: card.id }))}">不感兴趣</button>
      </div>
      ${replyBlockView(card, open)}
    </div>`
  }).join('')
  return `<div class="panel" id="batch-cards" data-batch-id="${esc(batch.data?.id || '')}"><h3>本批候选（按回复数升序）</h3><p class="muted">回复数未知排在最后，不当成 0。<b>不感兴趣</b>与<b>清空本批</b>都会保留账号去重记录，下批不再推荐；不会删除聊天历史、联系人或人工标签。</p><div style="max-height:720px;overflow:auto">${items}</div>${checkView}</div>`
}
async function loadBatch() {
  const st = batchState()
  if (st.loading) { st.reload = true; return }
  const account = S.accounts.active
  const revision = st.revision || 0
  st.loading = true
  try {
    const r = await api.discovery.batchStatus()
    if (S.accounts.active !== account || S.discovery.batch !== st) return
    if (revision !== (st.revision || 0) || st.busy) { st.reload = true; return }
    if (r?.ok) {
      st.data = r.batch || null; st.cards = r.cards || []; st.history = r.history || []; st.loaded = true
      const field = document.getElementById('batch-favorites-folder')
      if (field && document.activeElement !== field && field.value === (st.favoritesFolder || '')) field.value = r.favoritesFolder || ''
      st.favoritesFolder = r.favoritesFolder || ''
    }
  } catch { /* 批次接口暂不可用时保持上次状态 */ }
  finally {
    st.loading = false
    if (st.reload && S.accounts.active === account && S.section === 'discovery') queueBatchRefresh()
    st.reload = false
  }
  if (S.section === 'discovery') {
    // 首次加载/批次状态变化时重建面板；重建前先记住用户填的内容，重建后回填，避免输入被冲掉。
    const panel = document.getElementById('batch-panel')
    const stamp = String(st.data?.updatedAt || st.data?.id || '')
    if (panel && panel.dataset.batchStamp !== stamp && !(panel.contains(document.activeElement) && isTypingIn(document.activeElement))) {
      const snapshot = snapshotBatchForm()
      panel.outerHTML = batchPanelView()
      restoreBatchForm(snapshot)
    }
    patchContainer('batch-warnings', () => batchWarningsView(st.data))
    const signature = JSON.stringify([st.cards, st.data?.goalChecks])
    if (st.renderedCards !== signature && patchBatch()) st.renderedCards = signature
    updateSourceWait()
    batchPoll()
  }
}
// 面板输入快照：轮询重建面板时保住用户已填的关键词/标签/筛选值。
function snapshotBatchForm() {
  const out = {}
  for (const el of document.querySelectorAll('#batch-panel input, #batch-panel textarea, #batch-panel select')) {
    if (el.id) out[el.id] = el.type === 'checkbox' ? el.checked : el.value
  }
  return out
}
function restoreBatchForm(snapshot) {
  for (const [id, value] of Object.entries(snapshot || {})) {
    const el = document.getElementById(id)
    if (!el) continue
    if (el.type === 'checkbox') el.checked = value
    else el.value = value
  }
}
function captureBatchEdits() {
  const st = batchState()
  const cards = document.getElementById('batch-cards')
  if (cards?.dataset?.batchId !== undefined && cards.dataset.batchId !== (st.data?.id || '')) return
  for (const el of document.querySelectorAll('[id^="batch-text-"]')) {
    if (el.dataset?.dirty === '1') st.texts[batchTextKey(el.id.slice('batch-text-'.length), st)] = el.value
  }
}
function patchBatch(force = false) {
  captureBatchEdits()
  // 只在明确操作后重建面板；轮询只刷新卡片，避免把用户正在填的内容冲掉。
  if (force) {
    const panel = document.getElementById('batch-panel')
    if (panel) {
      const snapshot = snapshotBatchForm(), focused = document.activeElement
      const focusId = panel.contains(focused) && isTypingIn(focused) ? focused.id : ''
      const selection = focusId && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null
      panel.outerHTML = batchPanelView()
      restoreBatchForm(snapshot)
      const next = focusId && document.getElementById(focusId)
      if (next) { next.focus({ preventScroll: true }); if (selection) next.setSelectionRange?.(...selection) }
    }
  }
  const cards = document.getElementById('batch-cards')
  // 用户正在卡片里输入首句时，轮询不重建卡片列表（输入框会被替换掉）。
  if (cards && !force && cards.contains(document.activeElement)) return false
  if (cards) cards.outerHTML = batchCardsView()
  return Boolean(cards)
}
function openingRequirementsView() {
  const local = S.discovery, settings = S.data.settings || {}
  const value = local.openingRequirementsDraft ?? settings.openingRequirements ?? ''
  const mode = local.openingModeDraft ?? settings.openingMode ?? 'ai'
  const fixedText = local.fixedOpeningDraft ?? settings.fixedOpeningText ?? ''
  return `<div class="panel" id="opening-requirements-panel"><h3>首句生成要求</h3>
    <div class="field"><label for="opening-mode">首句方式</label><select id="opening-mode" ${local.openingRequirementsSaving ? 'disabled' : ''}><option value="ai" ${mode === 'ai' ? 'selected' : ''}>AI 按要求生成</option><option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>直接使用固定首句</option></select></div>
    ${mode === 'fixed' ? `<div class="field"><label for="fixed-opening-text">固定首句内容（最多80字）</label><textarea id="fixed-opening-text" maxlength="80" rows="3" placeholder="填入你写好的完整首句，将原样使用">${esc(fixedText)}</textarea></div>` : `<div class="field"><label for="opening-requirements">告诉 AI 你希望怎样开场</label><textarea id="opening-requirements" maxlength="2000" rows="3" placeholder="例如：结合对方评论轻松打招呼，只问一个容易回答的问题，一句话，不要自我介绍。">${esc(value)}</textarea></div>`}
    <button class="btn primary" data-act="opening-requirements-save" ${local.openingRequirementsSaving ? 'disabled' : ''}>${local.openingRequirementsSaving ? '保存中…' : '保存首句设置'}</button>
    <p class="muted" style="margin-top:8px">${mode === 'fixed' ? '固定模式不调用模型，不改写文字，也不按目标追加内容。' : '所有寻找目标共用，目标内的首句要求作为补充；结合实际评论生成，个人介绍选填。留空时自然开场。'}保存后用于新生成的首句，已有草稿请点“重新生成首句”；保存设置不会关注或发送。</p></div>`
}
function selfIntroductionView() {
  const profile = S.data.selfProfile || {}
  const persona = S.data.selfPersona || {}
  const labels = { name: '称呼', identity: '身份', city: '所在城市', interests: '兴趣', tone: '语气', goal: '交友目的', boundary: '聊天边界', examples: '说话样例', experiences: '日常经历' }
  const oldIntro = Object.entries(labels).filter(([key]) => persona[key]).map(([key, label]) => `${label}：${persona[key]}`).join('\n')
  const local = selfProfileUi()
  const text = local.introduction ?? profile.introductionText ?? oldIntro
  return `<details class="panel"><summary><strong>我的介绍</strong></summary>
    <div class="field"><label for="self-introduction">我的介绍</label><textarea id="self-introduction" maxlength="30000" placeholder="写一段关于你的介绍，可以包括兴趣、交友目的和聊天边界。">${esc(text)}</textarea></div>
    <button class="btn primary" data-act="self-introduction-save">保存并整理</button>
  </details>`
}
// One visible discovery workflow. Legacy modules remain available for data compatibility.
async function clearWorkspaceList(scope) {
  const account = S.accounts.active
  const message = scope === 'candidates'
    ? '清除本账号的全部候选列表？已采集评论和人工训练案例保留。已发送、发送结果待核实、拒绝联系的保护记录保留；旧评论不会在刷新后自动补回。'
    : '清除本账号的全部采集评论、人工标签及训练/评估样本？全部候选及其来源证据、账号与聊天记录保留。'
  if (!window.confirm(message + '\n操作前会生成本地备份。')) return
  const result = await api.discovery.clearList({ scope, confirmed: true, accountId: account })
  if (S.accounts.active !== account) return
  if (!result?.ok) return showNotice(result?.error || '清除失败', 'err')
  S.discovery.selected = null; S.discovery.historyPage = 0; S.library.trainingOffset = 0
  if (result.learning) S.library.learning = result.learning
  S.library.data = null; S.library.evaluation = null; S.library.benchmark = null
  S.data = await api.automation.getState()
  render()
  showNotice(`已清除 ${result.removed || 0} 条记录，备份：${result.backupPath || ''}`)
}
function discoveryWorkspaceTab() {
  const value = S.discovery.workspaceTab === 'training' ? 'labels' : S.discovery.workspaceTab || 'find'
  return ['find', 'labels', 'candidates', 'tools', 'developer'].includes(value) ? value : 'find'
}
function discoveryWorkspaceNav() {
  const tab = discoveryWorkspaceTab()
  return `<div class="panel" id="discovery-workspace-nav"><div class="row" role="tablist" aria-label="交友发现工作区" style="flex-wrap:wrap">${[
    ['find', '寻找设置与本批结果'], ['labels', '所有评论 / 人工标注'], ['candidates', '全部候选'], ['tools', '备用工具'], ['developer', '开发工具'],
  ].map(([key, label]) => `<button class="btn${tab === key ? ' primary' : ''}" role="tab" aria-selected="${tab === key}" data-act="workspace-tab" data-args="${esc(JSON.stringify({ tab: key }))}">${label}</button>`).join('')}</div><p class="muted" style="margin-top:8px">在“寻找设置”开始任务，并在同一页查看本批候选和发送状态；跨批次记录统一保留在“全部候选”。</p></div>`
}
function batchRequirementsView() {
  const st = batchState(), disabled = batchRunning() || st.busy || st.parsing
  return `<details class="card" style="margin-top:12px"><summary><strong>用一句话填写筛选要求（可选）</strong></summary><p class="muted" style="margin:8px 0">例如“女生，粉丝少于150，年龄22到30”。解析结果只填入本页条件，不会开始寻找、关注或发送。关键词和标签仍由你填写；地区、回复数可在下方手动设置。</p><textarea id="batch-requirements" maxlength="2000" rows="2" placeholder="描述你想认识什么样的人" ${disabled ? 'disabled' : ''}>${esc(st.requirementsText || '')}</textarea><button class="btn" data-act="workspace-parse" ${disabled ? 'disabled' : ''}>${st.parsing ? '解析中…' : '解析到本页条件'}</button>${st.requirementsNotice ? `<p class="notice ${st.requirementsError ? 'err' : ''}" style="margin-top:8px">${esc(st.requirementsNotice)}</p>` : ''}</details>`
}
function workspaceCandidateListView() {
  const query = String(S.discovery.historySearch || '').trim().toLowerCase()
  const filter = S.discovery.historyFilter || 'all'
  const rows = discoveryCandidates().filter(c => (!query || [c.nickname, c.platformUserId, c.profileUrl].some(v => String(v || '').toLowerCase().includes(query)))
    && (filter === 'all' || discoveryReviewStatus(c) === filter)
    && (!S.discovery.historyScreening || S.discovery.historyScreening === 'all' || c.batchScreening?.status === S.discovery.historyScreening)).sort((a, b) => discoveryScore(b) - discoveryScore(a))
  const size = 30, pages = Math.max(1, Math.ceil(rows.length / size))
  const page = Math.min(pages - 1, Math.max(0, Number(S.discovery.historyPage) || 0))
  S.discovery.historyPage = page
  return `<p class="muted" style="margin-bottom:8px">匹配 ${rows.length} 人 · 第 ${page + 1} / ${pages} 页</p>${rows.slice(page * size, (page + 1) * size).map(c => `<button class="contact-item${S.discovery.selected === c.id ? ' active' : ''}" data-act="workspace-select" data-args="${esc(JSON.stringify({ id: c.id }))}"><span class="ci-top"><strong>${esc(c.nickname || '昵称未提供')}</strong><span class="pill">${esc(discoveryReviewLabel(c))}</span></span><span class="ci-preview">${c.batchScreening ? esc(({qualified:'条件符合',pending:'资料待核实',excluded:'当前条件不符'})[c.batchScreening.status] || '') + ' · ' : c.intentPoolOnly ? '待筛选 / 核实 · ' : ''}${esc(c.firstComment || c.sources?.[0]?.commentText || c.sources?.[0]?.summary || '暂无来源描述')}</span><span class="muted">${esc(c.review?.realContact?.messageStatus === 'sent' ? '首句已发送' : c.review?.realContact?.needsReview ? '发送结果待核实' : '保留在候选池')} · ${esc(c.platformUserId || '')}</span></button>`).join('') || '<p class="muted">当前条件下没有候选人。历史记录不会因清空本批而删除。</p>'}<div class="row" style="margin-top:8px"><button class="btn small" data-act="workspace-page" data-args='{"delta":-1}' ${page <= 0 ? 'disabled' : ''}>上一页</button><button class="btn small" data-act="workspace-page" data-args='{"delta":1}' ${page >= pages - 1 ? 'disabled' : ''}>下一页</button></div>`
}
function workspaceReceiptView(candidate) {
  const r = candidate.review?.realContact
  if (!r) return '<p class="muted" style="margin-top:12px">暂无批次联系记录。人工标记只保存判断，不会加入旧联系队列或触发发送。</p>'
  return contactOutcomeView(r, candidate.id)
}
function workspaceTrainingView() {
  const data = S.library.learning, page = data?.page || { rows: [], total: 0, offset: 0, limit: 20 }
  return `<div class="panel"><h3>所有评论 / 人工标注</h3><p class="muted">读到的评论在寻找过程中持续保存，停止或未达目标也保留。模型判断是待纠错样本；人工确认并勾选“用作训练案例”后才会用于案例学习。</p><p class="muted">全部样本 ${data?.stats?.samples || 0} · 已人工标注 ${data?.stats?.annotated || 0} · 训练案例 ${data?.stats?.trainCases || 0}</p><div class="row" style="margin:10px 0"><input id="training-query" placeholder="搜索评论、昵称或视频" value="${esc(S.library.trainingQuery || '')}"><select id="training-label">${[['all','全部评论'],['pending','待人工标注'],['annotated','已人工标注']].map(([v,l])=>`<option value="${v}" ${(S.library.trainingLabel || 'all')===v?'selected':''}>${l}</option>`).join('')}</select><button class="btn small" data-act="training-search">搜索 / 刷新</button><button class="btn small danger" data-act="workspace-clear-comments" ${S.library.learningBusy || batchRunning() ? 'disabled' : ''}>一键清除评论与训练样本</button></div>${S.library.learningMessage ? `<p class="notice">${esc(S.library.learningMessage)}</p>` : ''}<p class="muted">匹配 ${page.total} 条 · 第 ${Math.floor(page.offset/page.limit)+1} / ${Math.max(1,Math.ceil(page.total/page.limit))} 页</p>${(page.rows || []).map(sample=>learningSampleCard(sample,{annotated:!!sample.human})).join('') || '<p class="muted">尚无匹配评论，开始寻找或点击刷新读取已保存数据。</p>'}<div class="row"><button class="btn small" data-act="training-page" data-args='{"delta":-1}' ${!page.offset?'disabled':''}>上一页</button><button class="btn small" data-act="training-page" data-args='{"delta":1}' ${page.offset+page.limit>=page.total?'disabled':''}>下一页</button></div><p class="muted">清除会删除本账号已采集评论、人工标签、训练及评估样本，操作前确认并备份；全部候选及其来源证据、账号和聊天记录保留。</p></div>`
}
function workspaceCandidatesView() {
  return `<div class="panel"><h3>全部候选</h3><p class="muted">有意愿的人在判断完成后即保存，不要求整批成功或性别年龄齐全。硬性条件只决定本批入选与自动联系资格；可在这里人工查看待核实对象。</p><div class="grid3" style="margin:12px 0"><div class="field"><label>搜索昵称或账号</label><input id="workspace-history-search" value="${esc(S.discovery.historySearch || '')}" placeholder="输入昵称或账号，点击搜索"></div><div class="field"><label>人工审核状态</label><select id="workspace-history-filter">${[['all', '全部'], ['pending', '待审核'], ['approved', '符合'], ['deferred', '暂存'], ['rejected', '排除']].map(([v, l]) => `<option value="${v}" ${(S.discovery.historyFilter || 'all') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="row"><button class="btn" data-act="workspace-history-filter">搜索 / 筛选</button><button class="btn small" data-act="workspace-history-refresh">刷新记录</button><button class="btn small" data-act="workspace-screen-pool">按寻找设置筛选</button><button class="btn small danger" data-act="workspace-clear-candidates" ${batchRunning() ? 'disabled' : ''}>一键清除全部候选</button><select id="workspace-screening-filter">${[['all','全部筛选状态'],['qualified','当前条件符合'],['pending','资料待核实'],['excluded','当前条件不符']].map(([v,l])=>`<option value="${v}" ${(S.discovery.historyScreening || 'all')===v?'selected':''}>${l}</option>`).join('')}</select></div></div><div class="grid2 discovery-candidate-grid" style="align-items:start"><div id="discovery-candidates" style="max-height:650px;overflow:auto">${workspaceCandidateListView()}</div><div id="discovery-detail">${discoveryDetailView({ workspace: true })}</div></div></div>`
}
function workspaceImportsView() {
  return `<details class="panel"><summary><strong>备用导入</strong></summary><p class="muted" style="margin:8px 0">页面无法读取或你已有导出文件时使用。导入只保存素材，不会自动寻找、关注或发消息。</p><div class="field"><label>视频分享链接或作品 ID（仅收录）</label><input id="library-video-input" maxlength="1000"></div><div class="grid3"><div class="field"><label>标题（可选）</label><input id="library-video-title" maxlength="300"></div><div class="field"><label>标签（可选）</label><input id="library-video-hashtags" maxlength="300"></div><div class="field"><label>主题（可选）</label><input id="library-video-topic" maxlength="60"></div></div><div class="row"><button class="btn small" data-act="library-collect-video">收录链接</button><label class="btn small">导入视频或评论文件<input id="library-file" type="file" accept=".json,.jsonl,.csv,.txt" style="display:none"></label></div><div class="field" style="margin-top:12px"><label>评论内容（JSON / JSONL / CSV）</label><textarea id="library-paste" rows="3"></textarea></div><div class="row"><button class="btn small" data-act="library-paste-import">导入评论</button><button class="btn primary small" data-act="workspace-analyze-imports" ${S.library.busy ? 'disabled' : ''}>分析并整理候选</button></div><p class="muted">分析后到“全部候选”查看结果。这里只合并手动处理步骤，不会执行首次联系。</p></details>`
}
function workspaceToolsView() {
  return `${collectorView()}<details class="panel"><summary><strong>收藏夹读取检查</strong></summary><p class="muted" style="margin:8px 0">收藏夹名称在“寻找设置”里保存。此处只检查已保存收藏夹的读取情况，不启动另一套自动分析任务。</p><button class="btn" data-act="workspace-sync-favorites" ${S.library.favoritesBusy ? 'disabled' : ''}>仅同步已保存收藏夹</button><p class="muted">${esc(S.library.favoritesMessage || '')}</p></details>${workspaceImportsView()}<details class="panel"><summary><strong>素材库查看与维护</strong></summary><div id="library-body" style="margin-top:10px">${libraryBodyView()}</div></details>`
}
function workspaceLegacyStatusView() {
  const scheduler = S.library.scheduler || {}, config = contactConfig()
  return `<div class="panel"><h3>旧任务状态</h3><p class="muted">旧版独立寻找、调度和模板首句不再提供启动入口。历史配置与结果保留，不迁移未知投递状态。</p><p>收藏夹调度：${scheduler.autoSync || scheduler.autoAnalyze ? '历史开关仍开启，请停止旧任务后使用主批次' : '未开启'} · 联系引擎：${config.enabled ? '历史开关开启' : '未开启'}</p><div class="row"><button class="btn small" data-act="workspace-stop-scheduler">停止旧调度</button><button class="btn small" data-act="workspace-stop-contact">停用旧联系引擎</button></div><p class="muted">停止操作只暂停旧任务，不清空候选、队列或聊天记录。当前主批次和“对话”自动回复的开关不在这里修改。</p></div>`
}
const CUSTOM_GOAL_LABELS = { match: '符合', check: '值得确认', reject: '不符合' }

function selectedGoal() {
  const data = S.discovery.goals
  return data?.goals?.find(goal => goal.id === data.selectedId) || null
}

function goalRef() {
  const goal = selectedGoal()
  return goal ? { id: goal.id, version: goal.versions.at(-1).version } : null
}

function currentSearchGoalView() {
  const batch = batchState().data
  const runningGoal = batch?.targetSnapshot
  return `<div class="row"><span>下次寻找目标 · ${esc(selectedGoal()?.name || '找对象')}</span><button class="btn small" data-act="workspace-tab" data-args='{"tab":"labels"}'>修改</button></div>
    ${runningGoal ? `<p class="muted">本批${batch.sampleOnly ? '采样' : '寻找'}目标 · ${esc(runningGoal.name)} · 版本 ${esc(runningGoal.version)}</p>` : ''}`
}

function customGoalSampleCard(sample, target, readOnly) {
  const args = esc(JSON.stringify({ ...target, key: sample.key }))
  return `<div class="card" data-goal-sample><p><b>${esc(sample.text)}</b></p>
    <p class="muted">${esc(sample.videoTitle || sample.videoId || '视频信息缺失')}</p>
    ${sample.videoDescription ? `<p class="muted">${esc(sample.videoDescription)}</p>` : ''}
    ${sample.human ? `<p>人工 · ${esc(CUSTOM_GOAL_LABELS[sample.human.intent])} ${esc(sample.human.reason)}</p>` : ''}
    ${readOnly ? '' : `<div class="row"><select aria-label="人工标签" data-goal-label>${Object.entries(CUSTOM_GOAL_LABELS).map(([key, text]) => `<option value="${key}" ${sample.human?.intent === key ? 'selected' : ''}>${text}</option>`).join('')}</select>
    <input aria-label="标注理由" maxlength="200" data-goal-reason value="${esc(sample.human?.reason || '')}" placeholder="理由（选填）">
    <button class="btn small" data-act="goal-annotate" data-args="${args}">保存标注</button></div>`}
  </div>`
}

function goalDecisionLogView(decisions) {
  return `<details><summary>最近的目标判断与案例引用</summary>${(decisions || []).map(row => `<div class="card">
    <p>${esc(row.text)} · ${esc(CUSTOM_GOAL_LABELS[row.label])} · ${row.source === 'human' ? '直接采用人工标注' : '模型判断'}</p>
    <p class="muted">目标 ${esc(row.target.name)} · 版本 ${esc(row.target.version)} · 快照 ${esc(row.target.snapshotId.slice(0, 12))}</p>
    <p>${esc(row.reason)} ${esc((row.evidence || []).join('；'))}</p>
    ${(row.cases || []).map(item => `<p class="muted">参考 · ${esc(CUSTOM_GOAL_LABELS[item.label])} · ${esc(item.text)} · ${esc(item.reason)}</p>`).join('')}
  </div>`).join('') || '<p class="muted">暂无判断记录</p>'}</details>`
}

function goalSamplesView() {
  const rows = S.discovery.goalSamples
  const ref = goalRef()
  const target = rows?.target || ref
  if (!ref) return ''
  const b = rows?.sampling
  const sampleStatus = b?.sampleOnly && ['running', 'paused', 'interrupted'].includes(b.status) || b?.targetSnapshot?.id === ref.id && b.targetSnapshot.version === ref.version
  return `${sampleStatus ? `<p>${esc(b.targetSnapshot.name)} · ${esc(BATCH_STATUS_LABELS[b.status] || b.status)} · 已采 ${esc(b.sampleKeys?.length || 0)} 条 ${esc(b.reason || '')} ${['running', 'paused', 'interrupted'].includes(b.status) ? '<button class="btn small" data-act="goal-stop-sampling">停止采样</button>' : ''} ${b.status === 'interrupted' ? '<button class="btn small" data-act="goal-resume-sampling">继续采样</button>' : ''}</p>` : ''}
    ${(rows?.samples || []).map(sample => customGoalSampleCard(sample, target, target.version !== ref.version)).join('') || '<p class="muted">还没有评论样本。</p>'}
    ${goalDecisionLogView(rows?.decisions)}`
}

function workspaceLabelsView() {
  const data = S.discovery.goals
  const goal = selectedGoal(), version = goal?.versions.at(-1)
  const creating = S.discovery.newGoal === true
  return `<div class="panel"><h3>人工标注</h3>
    <div class="row"><label for="goal-selector">寻找目标</label><select id="goal-selector">
      <option value="">找对象（默认）</option>${(data?.goals || []).map(item => `<option value="${esc(item.id)}" ${item.id === data.selectedId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
    </select><button class="btn small" data-act="goal-select">使用目标</button><button class="btn small" data-act="goal-create">新建自定义目标</button></div>
    ${goal || creating ? `<div class="field"><label for="goal-name">目标名称</label><input id="goal-name" maxlength="80" value="${esc(creating ? '' : goal.name)}"></div>
      <div class="field"><label for="goal-description">我要找什么样的评论</label><textarea id="goal-description" maxlength="2000" rows="4">${esc(creating ? '' : version.description)}</textarea></div>
      <div class="field"><label for="goal-opening-instructions">此目标的首句补充要求（选填）</label><textarea id="goal-opening-instructions" maxlength="500" rows="2" placeholder="例如：结合对方的组队评论，问平时几点上线。语气轻松，一句话。">${esc(creating ? '' : goal.openingInstructions || '')}</textarea><small class="muted">通用要求在寻找设置的“首句生成要求”填写；固定模式直接使用固定文字。</small></div>
      <div class="row"><button class="btn primary" data-act="goal-save" data-args="${esc(JSON.stringify({ id: creating ? null : goal.id }))}">保存目标</button>
      ${creating ? '<button class="btn small" data-act="goal-cancel">取消</button>' : `<button class="btn" data-act="goal-sample">采样并标注</button><span class="muted">使用寻找设置里的来源，最多采 12 条评论。</span>
        <label for="goal-label-version">标注版本</label><select id="goal-label-version">${goal.versions.map(item => `<option value="${item.version}" ${item.version === (S.discovery.goalSamples?.target?.version || version.version) ? 'selected' : ''}>版本 ${item.version}</option>`).join('')}</select>
        <button class="btn small" data-act="goal-history">查看</button>`}</div>` : ''}
  </div>${!creating ? goal ? `<div class="panel" id="goal-sample-list">${goalSamplesView()}</div>` : `<div id="learning-panel">${workspaceTrainingView()}</div>` : ''}`
}

async function goalRequest(action, params = {}) {
  const local = S.discovery, accountId = S.accounts.active
  if (!api.discovery?.goal) return null
  const result = await api.discovery.goal({ action, accountId, ...params })
  if (S.discovery !== local || S.accounts.active !== accountId) return null
  if (!result?.ok) throw new Error(result?.error || '无法读取寻找目标')
  local.goals = { goals: result.goals, selectedId: result.selectedId }
  return result
}

async function loadGoalSamples(target = S.discovery.goalSamples?.target || goalRef()) {
  if (!target) return
  const local = S.discovery, request = (local.goalSampleRequest || 0) + 1
  local.goalSampleRequest = request
  try {
    const result = await goalRequest('samples', target)
    if (!result || S.discovery !== local || local.goalSampleRequest !== request || selectedGoal()?.id !== target.id) return
    local.goalSamples = { target, samples: result.samples, decisions: result.decisions, sampling: result.sampling }
    const panel = document.getElementById('goal-sample-list')
    if (!panel?.contains?.(document.activeElement) || !document.activeElement?.matches?.('[data-goal-label], [data-goal-reason]')) {
      patchContainer('goal-sample-list', goalSamplesView)
    }
  } catch (error) { showNotice(error.message, 'err') }
}

function workspaceDeveloperView() {
  return `<div class="panel"><h3>评论分类评估</h3><p class="muted">在人工标注页修改目标或纠正评论标签。</p></div><div id="benchmark-panel">${benchmarkPanelView()}</div><div id="workspace-legacy-status">${workspaceLegacyStatusView()}</div>`
}
function refreshWorkspaceHistory() {
  if (S.section !== 'discovery' || discoveryWorkspaceTab() !== 'candidates') return
  patchContainer('discovery-candidates', () => workspaceCandidateListView())
  patchContainer('discovery-detail', () => discoveryDetailView({ workspace: true }))
}
const DISCOVERY_WORKSPACE_ACTIONS = {
  async 'workspace-tab'({ tab }) {
    if (!['find', 'labels', 'candidates', 'tools', 'developer'].includes(tab)) return
    captureBatchEdits()
    if (discoveryWorkspaceTab() === 'find' && document.getElementById('batch-keywords')) {
      batchState().formConfig = readBatchConfig()
      batchState().requirementsText = document.getElementById('batch-requirements')?.value ?? batchState().requirementsText ?? ''
    }
    S.discovery.workspaceTab = tab
    S.discovery.toolsOpen = tab === 'tools' || tab === 'developer'
    render()
    if (tab === 'candidates') { await DISCOVERY_WORKSPACE_ACTIONS['workspace-history-refresh'](); return }
    if (tab === 'labels') {
      const result = await goalRequest('view')
      if (discoveryWorkspaceTab() !== 'labels') return
      if (result) render()
      if (selectedGoal()) await loadGoalSamples()
      else await loadLearning()
    }
    if (tab === 'tools') await loadLibrary()
    if (tab === 'developer') { await Promise.all([loadLibrary(), loadLearning(), loadBenchmark()]); patchContainer('workspace-legacy-status', () => workspaceLegacyStatusView()) }
  },
  'goal-create'() { S.discovery.newGoal = true; render() },
  'goal-cancel'() { S.discovery.newGoal = false; render() },
  async 'goal-select'() {
    const id = document.getElementById('goal-selector')?.value || null
    if (!await goalRequest('select', { id })) return
    S.discovery.newGoal = false
    S.discovery.goalSamples = null
    render()
    if (id) await loadGoalSamples()
    else await loadLearning()
  },
  async 'goal-save'({ id }) {
    const name = document.getElementById('goal-name')?.value
    const description = document.getElementById('goal-description')?.value
    const openingInstructions = document.getElementById('goal-opening-instructions')?.value
    if (!await goalRequest('save', { id, name, description, openingInstructions })) return
    S.discovery.newGoal = false
    S.discovery.goalSamples = null
    render()
    await loadGoalSamples()
  },
  async 'goal-history'() {
    const goal = goalRef(), version = Number(document.getElementById('goal-label-version')?.value)
    if (goal && version) await loadGoalSamples({ id: goal.id, version })
  },
  async 'goal-annotate'(target, btn) {
    const card = btn?.closest('[data-goal-sample]')
    const label = card?.querySelector('[data-goal-label]')?.value
    const reason = card?.querySelector('[data-goal-reason]')?.value
    const local = S.discovery
    const result = await goalRequest('annotate', { ...target, label, reason })
    if (!result || S.discovery !== local || selectedGoal()?.id !== target.id) return
    const ref = { id: target.id, version: target.version }
    local.goalSampleRequest = (local.goalSampleRequest || 0) + 1
    local.goalSamples = { target: ref, samples: result.samples, decisions: result.decisions, sampling: result.sampling }
    patchContainer('goal-sample-list', goalSamplesView)
  },
  async 'goal-stop-sampling'() { await goalRequest('stop-sampling'); await loadGoalSamples() },
  async 'goal-resume-sampling'() { await goalRequest('resume-sampling'); await loadGoalSamples() },
  async 'goal-sample'(args, btn) {
    const st = batchState(), target = goalRef()
    const config = st.formConfig || st.data?.config
    if (!target || !config || st.busy) return showNotice('请先保存自定义目标，并在寻找设置选择来源', 'err')
    const local = S.discovery, accountId = S.accounts.active
    st.busy = true
    if (btn) btn.disabled = true
    try {
      const result = await api.discovery.batchStart({ ...config, goal: target, accountId, sampleOnly: true })
      if (S.discovery !== local || S.accounts.active !== accountId) return
      if (!result?.ok) throw new Error(result?.error || '采样启动失败')
      await loadGoalSamples(target)
    } finally { st.busy = false; if (btn) btn.disabled = false }
  },
  async 'workspace-history-refresh'() {
    const account = S.accounts.active, local = S.discovery
    const synced = await api.discovery.syncIntentPool()
    if (S.accounts.active !== account || S.discovery !== local) return
    if (!synced?.ok) return showNotice(synced?.error || '候选整理失败', 'err')
    const state = await api.automation.getState()
    if (S.accounts.active !== account || S.discovery !== local) return
    S.data = state
    refreshWorkspaceHistory()
  },
  'workspace-history-filter'() {
    S.discovery.historySearch = document.getElementById('workspace-history-search')?.value || ''
    S.discovery.historyFilter = document.getElementById('workspace-history-filter')?.value || 'all'
    S.discovery.historyScreening = document.getElementById('workspace-screening-filter')?.value || 'all'
    S.discovery.historyPage = 0
    refreshWorkspaceHistory()
  },
  async 'workspace-screen-pool'() {
    const account = S.accounts.active
    const filters = batchState().formConfig?.filters || batchState().data?.config?.filters || S.data.discovery?.batch?.config?.filters || {}
    const result = await api.discovery.filterIntentPool({ accountId: account, filters, goal: goalRef() })
    if (S.accounts.active !== account) return
    if (!result?.ok) return showNotice(result?.error || '筛选失败', 'err')
    S.discovery.historyScreening = 'qualified'
    S.data = await api.automation.getState()
    render()
    showNotice(`符合 ${result.counts.qualified} 人，资料待核实 ${result.counts.pending} 人，条件不符 ${result.counts.excluded} 人；未关注或发送`)
  },
  async 'workspace-clear-candidates'() { await clearWorkspaceList('candidates') },
  async 'workspace-clear-comments'() { await clearWorkspaceList('comments') },
  async 'training-search'() {
    S.library.trainingQuery = document.getElementById('training-query')?.value || ''
    S.library.trainingLabel = document.getElementById('training-label')?.value || 'all'
    S.library.trainingOffset = 0
    await loadLearning()
  },
  async 'training-page'({ delta }) {
    const page = S.library.learning?.page
    S.library.trainingOffset = Math.max(0, (page?.offset || 0) + (delta === -1 ? -20 : 20))
    await loadLearning()
  },
  'workspace-page'({ delta }) { S.discovery.historyPage = Math.max(0, (Number(S.discovery.historyPage) || 0) + (delta === -1 ? -1 : 1)); refreshWorkspaceHistory() },
  'workspace-select'({ id }) { S.discovery.selected = id; refreshWorkspaceHistory() },
  async 'workspace-parse'(args, btn) {
    const st = batchState(), account = S.accounts.active, local = S.discovery
    if (batchRunning() || st.busy || st.parsing) return
    const text = document.getElementById('batch-requirements')?.value.trim() || ''
    if (!text) return showNotice('请先填写筛选要求', 'err')
    const current = readBatchConfig()
    st.formConfig = current; st.requirementsText = text; st.parsing = true
    if (btn) btn.disabled = true
    try {
      const result = await api.discovery.parse({ accountId: account, text })
      if (S.accounts.active !== account || S.discovery !== local || batchState() !== st) return
      if (!result?.ok || !result.config) throw new Error(result?.error || '未得到有效筛选条件')
      const latest = document.getElementById('batch-keywords') ? readBatchConfig() : st.formConfig || current
      st.formConfig = latest
      if (JSON.stringify(latest) !== JSON.stringify(current)) throw new Error('解析期间你修改了设置，已保留最新输入；请重新解析后再应用。')
      const c = result.config, unsupported = [...(result.unsupported || [])]
      if (!['female', 'any'].includes(c.targetGender)) throw new Error('模型返回了未支持的性别条件，请手动填写。')
      if (c.preferLowerComments) unsupported.push('优先往下找评论尚未接入主批次条件')
      if (c.preferLowReplies) unsupported.push('“优先少回复”暂不能映射为排序；可以手动设置回复数上限')
      if (c.includeReplies) unsupported.push('主动展开楼中楼尚未接入主批次条件')
      if (unsupported.length) throw new Error(`本次没有应用条件：${[...new Set(unsupported)].join('；')}。请修改要求或手动填写。`)
      st.formConfig = { ...current, filters: { ...current.filters, gender: c.targetGender === 'female' ? 'female' : 'any',
        requireFollowerLimit: c.requireFollowerLimit === true, ...(c.requireFollowerLimit ? { followerLimit: c.followerLimit } : {}),
        requireAgeRange: c.requireAgeRange === true, ...(c.requireAgeRange ? { ageMin: c.ageMin, ageMax: c.ageMax } : {}) } }
      st.requirementsNotice = '已填入本页筛选条件，请核对后点击“开始寻找”。关键词、标签、地区和回复数设置已保留。'; st.requirementsError = false
    } catch (error) {
      if (S.accounts.active === account && S.discovery === local) { st.requirementsNotice = error.message || String(error); st.requirementsError = true }
    } finally {
      st.parsing = false
      if (S.accounts.active === account && S.discovery === local) patchBatch(true)
    }
  },
  async 'workspace-analyze-imports'(args, btn) {
    const account = S.accounts.active, local = S.library
    await libraryOperation(btn, async () => {
      const classified = await api.library.classify({ maxAiCalls: null })
      if (!classified?.ok) return classified
      if (S.accounts.active !== account || S.library !== local) return { ok: false, error: '账号已切换，已停止后续整理' }
      const candidates = await api.library.candidates()
      return { ...candidates, library: candidates.library || classified.library }
    }, result => `素材已分析并整理候选：新增 ${result.added || 0} 人，合并 ${result.merged || 0} 人。请到“全部候选”查看。`)
    if (S.accounts.active === account && S.library === local) await DISCOVERY_WORKSPACE_ACTIONS['workspace-history-refresh']()
  },
  async 'workspace-sync-favorites'(args, btn) {
    const name = S.library.data?.favorites?.folderName || batchState().favoritesFolder || ''
    if (!name) return showNotice('请先在“寻找设置”里保存收藏夹名称', 'err')
    await libraryOperation(btn, () => api.library.syncFavorites({ folderName: name, resume: true }), result => { S.library.favoritesMessage = `收藏夹同步完成，找到 ${result.found || 0} 个作品；未启动自动分析`; return S.library.favoritesMessage })
  },
  async 'workspace-stop-scheduler'(args, btn) {
    await schedulerOperation(btn, () => api.library.stopScheduler(), '旧调度已停止，记录和预算保留')
    patchContainer('workspace-legacy-status', () => workspaceLegacyStatusView())
  },
  async 'workspace-stop-contact'(args, btn) {
    await contactOperation(btn, accountId => api.contact.update({ accountId, config: { enabled: false } }), '旧联系引擎已停用，历史队列保留')
    patchContainer('workspace-legacy-status', () => workspaceLegacyStatusView())
  },
}

function discoveryView() {
  const tab = discoveryWorkspaceTab()
  const body = tab === 'find' ? `${batchPanelView()}${batchCardsView()}${autoModeView()}${openingRequirementsView()}${selfIntroductionView()}${autoAdvancedSettingsView()}`
    : tab === 'labels' ? workspaceLabelsView() : tab === 'candidates' ? workspaceCandidatesView() : tab === 'tools' ? workspaceToolsView() : workspaceDeveloperView()
  return `${discoveryWorkspaceNav()}<div id="discovery-workspace-body">${body}</div>`
}
function discoveryToolsView() { return discoveryWorkspaceTab() === 'developer' ? workspaceDeveloperView() : workspaceToolsView() }
document.addEventListener('toggle', event => {
  const panel = event.target
  if (panel.id !== 'discovery-tools') return
  S.discovery.toolsOpen = panel.open
  if (!panel.open) return
  const body = panel.querySelector('#discovery-tools-body')
  if (body && !body.innerHTML) body.innerHTML = discoveryToolsView()
  loadDiscoveryTools()
}, true)
function loadDiscoveryTools() {
  if (!S.library.data && !S.library.busy) loadLibrary()
  if (!S.library.learning && !S.library.learningBusy) loadLearning()
  if (!S.library.benchmark && !S.library.benchmarkBusy) loadBenchmark()
}
async function loadDiscoveryMode() {
  goalRequest('view').then(result => {
    if (result && S.section === 'discovery') patchContainer('current-search-goal', currentSearchGoalView)
  }).catch(error => showNotice(error.message, 'err'))
  const account = S.accounts.active
  const result = await api.library?.getAutoContact?.().catch(() => null)
  if (S.accounts.active !== account || !result?.ok) return
  S.library.autoContact = result.autoContact
  if (S.section === 'discovery') patchAutoModePanel()
}
function refreshDiscovery() {
  if (S.section !== 'discovery') return
  refreshWorkspaceHistory()
  patchAutoModePanel()
  if (!S.discovery.toolsOpen) return
  patchContainer('discovery-overview', () => discoveryOverviewView())
  patchContainer('discover-home', () => discoverHomeView())
  patchAutoModePanel()
  patchContainer('auto-contact-panel', () => autoDiscoveryPanelView())
  patchContainer('favorites-panel', () => favoritesSyncView())
  patchContainer('scheduler-panel', () => schedulerView())
  patchContainer('pipeline-panel', () => pipelineView())
  patchContainer('learning-summary', () => learningSummaryView())
  patchContainer('benchmark-panel', () => benchmarkPanelView())
  patchContainer('review-queue', () => reviewQueueView())
  patchContainer('core-candidates', () => coreCandidatesView())
  patchContainer('discovery-progress', discoveryStatusView())
  patchContainer('discovery-candidates', discoveryListView())
  patchContainer('discovery-detail', discoveryDetailView())
  patchContainer('library-body', () => libraryBodyView())
  patchContainer('learning-panel', () => discoveryWorkspaceTab() === 'labels' && !selectedGoal() ? workspaceTrainingView() : learningView())
  patchContainer('contact-queue', () => contactQueueView())
  for (const button of document.querySelectorAll('[data-act="discovery-parse"], [data-act="discovery-start"], [data-act="discovery-stop"], [data-act="discovery-config"], [data-act="discovery-open"], [data-act="discovery-inspect"], [data-act="discovery-review"]')) {
    button.disabled = button.dataset.act === 'discovery-stop' ? !discoveryRunning() : S.discovery.busy || (button.dataset.act === 'discovery-start' && discoveryRunning())
  }
  for (const button of document.querySelectorAll('[data-act="contact-save"], [data-act="contact-run"], [data-act="contact-refresh"], [data-act="contact-enqueue"], [data-act="contact-pause"], [data-act="contact-resume"], [data-act="contact-retry"], [data-act="contact-global-pause"], [data-act="contact-global-resume"]')) {
    button.disabled = S.contact.busy || (button.dataset.act === 'contact-enqueue' && S.discovery.busy) || (button.dataset.act === 'contact-run' && (S.contact.running || contactConfig().enabled !== true))
  }
}
function readDiscoveryConfig(requireEnabled = false) {
  const maxVideosPerRun = Number(document.getElementById('discovery-max-videos')?.value)
  const commentsPerVideo = Number(document.getElementById('discovery-comments')?.value)
  if (!Number.isSafeInteger(maxVideosPerRun) || maxVideosPerRun < 1 || maxVideosPerRun > 5) throw new Error('本轮视频数请填写 1～5 的整数')
  if (!Number.isSafeInteger(commentsPerVideo) || commentsPerVideo < 1 || commentsPerVideo > 30) throw new Error('每视频评论数请填写 1～30 的整数')
  const old = S.data.discovery?.config || {}
  const search = readDiscoverySearch()
  if (requireEnabled && !search.videoTags.length && !search.videoKeywords.length) throw new Error('请手动填写至少一个视频标签或搜索关键词')
  const targetGender = document.getElementById('discovery-target-gender')?.value ?? old.targetGender ?? 'any'
  const followerLimit = Number(document.getElementById('discovery-follower-limit')?.value ?? old.followerLimit ?? 150)
  const profileChecksPerRun = Number(document.getElementById('discovery-profile-checks')?.value ?? old.profileChecksPerRun ?? 8)
  if (!Number.isSafeInteger(followerLimit) || followerLimit < 1 || followerLimit > 100000) throw new Error('粉丝上限请填写1～100000的整数')
  if (!Number.isSafeInteger(profileChecksPerRun) || profileChecksPerRun < 0 || profileChecksPerRun > 20) throw new Error('主页核验数量请填写0～20的整数')
  const preferences = Object.fromEntries(['preferLowerComments', 'preferLowReplies', 'includeReplies'].map(key => [key, [...document.querySelectorAll('[data-discovery-preference]')].find(el => el.dataset.discoveryPreference === key)?.checked ?? old[key] ?? false]))
  const requireAgeRange = document.getElementById('discovery-age-required') ? document.getElementById('discovery-age-required').value === 'on' : old.requireAgeRange === true
  const ageMin = Number(document.getElementById('discovery-age-min')?.value ?? old.ageMin ?? 20), ageMax = Number(document.getElementById('discovery-age-max')?.value ?? old.ageMax ?? 30)
    if (![ageMin, ageMax].every(age => Number.isSafeInteger(age) && age >= 18 && age <= 100) || ageMin > ageMax) throw new Error('年龄范围请填写18～100的整数，最低年龄不能高于最高年龄')
  return { ...old, ...search, maxVideosPerRun, commentsPerVideo, targetGender, followerLimit, profileChecksPerRun, ...preferences,
    requireAgeRange, ageMin, ageMax,
    requireFollowerLimit: document.getElementById('discovery-follower-required') ? document.getElementById('discovery-follower-required').value === 'on' : old.requireFollowerLimit === true,
    requirementsText: document.getElementById('discovery-requirements')?.value ?? old.requirementsText ?? '' }
}
function discoveryReviewEvidence(id) {
  const extra = {}, gender = document.getElementById('discovery-gender-confirmation'), age = document.getElementById('discovery-age-confirmation')
  if (gender?.dataset.candidateId === id) extra.genderConfirmation = gender.value
  if (age?.dataset.candidateId === id) {
    const text = age.value.trim()
    if (text && (!Number.isSafeInteger(Number(text)) || Number(text) < 18 || Number(text) > 120)) throw new Error('人工年龄请填18～120的明确整数，未知时留空')
    extra.ageConfirmation = text ? Number(text) : 'unknown'
  }
  return extra
}
async function discoveryOperation(btn, operation, success) {
  if (S.discovery.busy) return
  const local = S.discovery, account = S.accounts.active
  local.busy = true
  if (btn) btn.disabled = true
  refreshDiscovery()
  try {
    const result = await operation(account)
    if (S.accounts.active !== account || S.discovery !== local) return
    if (result?.discovery) S.data.discovery = result.discovery
    if (result?.candidate) {
      const index = discoveryCandidates().findIndex(item => item.id === result.candidate.id)
      if (index >= 0) S.data.discovery.candidates[index] = result.candidate
    }
    if (!result?.ok) throw new Error(result?.error || '交友发现操作失败')
    if (success) showNotice(success)
  } catch (error) { if (S.accounts.active === account && S.discovery === local) showNotice(error.message || String(error), 'err') }
  finally { local.busy = false; if (btn) btn.disabled = false; if (S.accounts.active === account && S.discovery === local) refreshDiscovery() }
}
async function loadLibrary() {
  const account = S.accounts.active
  S.library.busy = true
  try {
    const [result, auto, audit] = await Promise.all([api.library.get(), api.library.getAutoContact().catch(() => null), api.library.getAutoAudit().catch(() => null)])
    if (S.accounts.active !== account) return
    if (!result?.ok) throw new Error(result?.error || '读取素材库失败')
    S.library.data = result.library
    // P2-12B/C：调度摘要和候选人质量统计随素材库一起刷新。
    if (result.scheduler) S.library.scheduler = result.scheduler
    if (result.candidateStats) S.library.candidateStats = result.candidateStats
    if (auto?.ok) S.library.autoContact = auto.autoContact
    if (audit?.ok) { S.library.autoAudit = audit.audit; S.library.autoContact = audit.autoContact || S.library.autoContact }
  } catch (error) {
    if (S.accounts.active === account) S.library.message = error.message || String(error)
  } finally {
    S.library.busy = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('library-body', () => libraryBodyView())
      patchContainer('discovery-overview', () => discoveryOverviewView())
      patchContainer('scheduler-panel', () => schedulerView())
      patchContainer('favorites-panel', () => favoritesSyncView())
      patchContainer('pipeline-panel', () => pipelineView())
      patchContainer('learning-summary', () => learningSummaryView())
      patchContainer('benchmark-panel', () => benchmarkPanelView())
      patchContainer('core-candidates', () => coreCandidatesView())
      patchAutoModePanel()
      patchContainer('auto-contact-panel', () => autoDiscoveryPanelView())
    }
  }
}
function refreshLearningPanel() {
  if (S.section === 'discovery') patchContainer('learning-panel', () => discoveryWorkspaceTab() === 'labels' && !selectedGoal() ? workspaceTrainingView() : learningView())
}
async function loadLearning() {
  const account = S.accounts.active
  S.library.learningBusy = true
  try {
    const result = await api.learning.get({ offset: S.library.trainingOffset || 0, limit: 20, query: S.library.trainingQuery || '', label: S.library.trainingLabel || 'all' })
    if (S.accounts.active !== account) return
    if (!result?.ok) throw new Error(result?.error || '读取评论学习失败')
    S.library.learning = result.learning
  } catch (error) {
    if (S.accounts.active === account) S.library.learningMessage = error.message || String(error)
  } finally {
    S.library.learningBusy = false
    if (S.accounts.active === account) refreshLearningPanel()
  }
}
// P2-12A 盲评加载：只取原文与视频语境，模型结论由主进程剥离。
async function loadBenchmark() {
  const account = S.accounts.active
  S.library.benchmarkBusy = true
  try {
    const result = await api.library.getBenchmark({ limit: 12, offset: S.library.benchmarkOffset || 0 })
    if (S.accounts.active !== account) return
    if (!result?.ok) throw new Error(result?.error || '读取人工基准集失败')
    S.library.benchmark = result.benchmark || null
    // 后端会把越界的 offset 收敛回来，前端跟着以它为准，避免翻页后越界。
    if (Number.isFinite(result.benchmark?.offset)) S.library.benchmarkOffset = result.benchmark.offset
    if (result.learning) S.library.learning = result.learning
  } catch (error) {
    if (S.accounts.active === account) S.library.benchmarkMessage = error.message || String(error)
  } finally {
    S.library.benchmarkBusy = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('benchmark-panel', () => benchmarkPanelView())
      patchContainer('learning-summary', () => learningSummaryView())
    }
  }
}
async function benchmarkOperation(btn, operation, success) {
  if (S.library.benchmarkBusy) return
  const account = S.accounts.active
  S.library.benchmarkBusy = true
  S.library.benchmarkMessage = ''
  if (btn) btn.disabled = true
  try {
    const result = await operation()
    if (S.accounts.active !== account) return
    if (result?.benchmark && result.benchmark.total !== undefined && result.benchmark.active) {
      S.library.benchmark = result.benchmark
      if (Number.isFinite(result.benchmark.offset)) S.library.benchmarkOffset = result.benchmark.offset
    }
    if (result?.view) S.library.benchmark = result.view
    if (result?.learning) S.library.learning = result.learning
    if (!result?.ok) throw new Error(result?.error || '人工基准集操作失败')
    S.library.benchmarkMessage = typeof success === 'function' ? success(result) : (success || '')
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.benchmarkMessage = error.message || String(error)
      showNotice(S.library.benchmarkMessage, 'err')
    }
  } finally {
    S.library.benchmarkBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('benchmark-panel', () => benchmarkPanelView())
      patchContainer('learning-summary', () => learningSummaryView())
    }
  }
}
async function benchmarkEvaluateOperation(btn) {
  if (S.library.benchmarkBusy) return
  const account = S.accounts.active
  S.library.benchmarkBusy = true
  S.library.benchmarkMessage = ''
  if (btn) btn.disabled = true
  try {
    const result = await api.library.evaluateBenchmark()
    if (S.accounts.active !== account) return
    if (!result?.ok) throw new Error(result?.error || '评估失败')
    S.library.benchmarkEvaluation = result.benchmark || null
    S.library.benchmarkReference = result.reference || null
    if (result.view) S.library.benchmark = result.view
    S.library.benchmarkMessage = result.benchmark?.targets?.note || '评估完成'
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.benchmarkMessage = error.message || String(error)
      showNotice(S.library.benchmarkMessage, 'err')
    }
  } finally {
    S.library.benchmarkBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') patchContainer('benchmark-panel', () => benchmarkPanelView())
  }
}
async function learningOperation(btn, operation, success) {
  if (S.library.learningBusy) return
  const account = S.accounts.active
  S.library.learningBusy = true
  S.library.learningMessage = ''
  if (btn) btn.disabled = true
  try {
    const result = await operation()
    if (S.accounts.active !== account) return
    if (result?.learning) S.library.learning = result.learning
    if (result?.library) S.library.data = result.library
    if (!result?.ok) throw new Error(result?.error || '评论学习操作失败')
    S.library.learningMessage = typeof success === 'function' ? success(result) : (success || '')
  } catch (error) {
    if (S.accounts.active === account) S.library.learningMessage = error.message || String(error)
  } finally {
    S.library.learningBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account) { if (discoveryWorkspaceTab() === 'training') await loadLearning(); refreshLearningPanel(); refreshLibraryReview(); patchContainer('library-body', () => libraryBodyView()) }
  }
}
function learningSampleOf(key) {
  const data = S.library.learning
  return [...(data?.page?.rows || []), ...(data?.pending || []), ...(data?.annotated || [])].find(sample => sample.key === key) || null
}
async function learningAnnotate(key, patch, message) {
  const sample = learningSampleOf(key)
  if (!sample) return
  await learningOperation(null, () => api.learning.annotate({
    key,
    intent: patch.intent || sample.human?.intent || sample.ai?.intent || '',
    reason: patch.reason || '人工标注',
    useForTraining: patch.useForTraining !== undefined ? patch.useForTraining : sample.useForTraining,
    independentEval: patch.independentEval !== undefined ? patch.independentEval : sample.independentEval,
  }), message)
}
async function libraryOperation(btn, operation, success) {
  if (S.library.busy) return
  const account = S.accounts.active
  S.library.busy = true
  S.library.message = ''
  if (btn) btn.disabled = true
  try {
    const result = await operation()
    if (S.accounts.active !== account) return
    if (result?.library) S.library.data = result.library
    if (!result?.ok) throw new Error(result?.error || '素材库操作失败')
    S.library.message = typeof success === 'function' ? success(result) : (success || '')
  } catch (error) { if (S.accounts.active === account) S.library.message = error.message || String(error) }
  finally {
    S.library.busy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account) { patchContainer('library-body', () => libraryBodyView()); patchContainer('discovery-candidates', discoveryListView()); patchContainer('discovery-detail', discoveryDetailView()) }
  }
}
// P2-13 双模式/自动联系：所有操作共用一套忙碌状态和补丁刷新，不触发整页重绘。
async function autoOperation(btn, operation, success, { reloadLibrary = false } = {}) {
  if (S.library.autoBusy) return null
  const account = S.accounts.active
  S.library.autoBusy = true
  S.library.autoMessage = ''
  if (btn) btn.disabled = true
  try {
    const result = await operation()
    if (S.accounts.active !== account) return null
    if (result?.autoContact) S.library.autoContact = result.autoContact
    if (result?.audit) S.library.autoAudit = result.audit
    if (!result?.ok) throw new Error(result?.reason || result?.error || '自动联系操作失败')
    if (result?.plans) S.library.autoPlans = { plans: result.plans, summary: result.summary }
    if (reloadLibrary) { try { await loadLibrary() } catch { /* 刷新失败保留本次结果 */ } }
    S.library.autoMessage = typeof success === 'function' ? success(result) : (success || '')
    return result
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.autoMessage = error.message || String(error)
      showNotice(S.library.autoMessage, 'err')
    }
    return null
  } finally {
    S.library.autoBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchAutoModePanel()
      patchContainer('auto-contact-panel', () => autoDiscoveryPanelView())
      patchContainer('core-candidates', () => coreCandidatesView())
    }
  }
}
// 训练模式统一入口：复用收藏夹同步 + 自动分析 + 候选生成；不关注、不私信。
async function autoTrainingRunOperation(btn) {
  const folderName = String(S.library.data?.favorites?.folderName || '').trim()
  if (!folderName) { showNotice('请先在“视频来源设置”里填写并保存收藏夹名称', 'err'); return }
  if (S.library.favoritesBusy || S.library.pipelineBusy || S.library.autoBusy) return
  const account = S.accounts.active
  S.library.favoritesBusy = true
  S.library.pipelineBusy = true
  S.library.autoMessage = ''
  if (btn) btn.disabled = true
  try {
    const result = await api.library.runDiscovery({ folderName })
    if (S.accounts.active !== account) return
    if (result?.library) S.library.data = result.library
    if (result?.learning) S.library.learning = result.learning
    const candidates = result?.result?.candidates
    if (candidates?.discovery && S.data) S.data.discovery = candidates.discovery
    if (!result?.ok) throw new Error(result?.error || result?.result?.message || '训练发现未完成')
    S.library.autoMessage = `训练发现完成：${result.result?.message || '收藏夹已同步并自动分析；候选人等待人工审核'}`
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.autoMessage = error.message || String(error)
      showNotice(S.library.autoMessage, 'err')
    }
  } finally {
    S.library.favoritesBusy = false
    S.library.pipelineBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchAutoModePanel()
      patchContainer('auto-contact-panel', () => autoDiscoveryPanelView())
      patchContainer('core-candidates', () => coreCandidatesView())
      patchContainer('learning-summary', () => learningSummaryView())
      patchContainer('review-queue', () => reviewQueueView())
    }
  }
}
function readAutoConfigInputs() {
  const el = id => document.getElementById(id)
  return {
    autoFollow: Boolean(el('auto-follow-enabled')?.checked),
    autoFirstMessage: Boolean(el('auto-message-enabled')?.checked),
    dailyFollowLimit: Number(el('auto-follow-limit')?.value) || 0,
    dailyFirstMessageLimit: Number(el('auto-message-limit')?.value) || 0,
    maxAttempts: Number(el('auto-max-attempts')?.value) || 2,
  }
}
async function autoModeSelect(mode, btn) {
  const auto = autoContactStateOf()
  if (mode === 'auto' && !auto.riskAcceptedAt) {
    const confirmed = window.confirm('启用正式自动模式？\n\n· 自动筛选候选人并在批次结束后自动执行：真实关注 + 真实发送第一句\n· 切换后会同时打开"允许自动关注"和"自动发送首句"，不需要再去高级设置勾选\n· 默认单批只处理 1 人（试水），每日受额度限制\n· 已排除、已是联系人、未满 18 岁、已判定男性的人永不处理\n· 关注申请与私信权限分别检查，仅在页面允许时发送首句\n· 发出去的话对方能看到，不可撤回\n\n确认接受上述权限与风险后继续。')
    if (!confirmed) return
  }
  await autoOperation(btn, () => api.library.setAutoMode({ mode, confirmed: true }), result => result.message || '模式已更新')
}
// P2-10 一键收集：收集会走真实页面读取，可能耗时较长，单独维护 collecting 状态与进度条。
async function collectCommentsOperation(btn, payload) {
  if (S.library.collecting || S.library.busy) return
  const account = S.accounts.active
  S.library.collecting = true
  S.library.collectorMessage = ''
  S.library.analyzeMessage = ''
  if (btn) btn.disabled = true
  patchContainer('discover-home', () => discoverHomeView())
  patchContainer('collector-panel', () => collectorView())
  try {
    const result = await api.library.collectComments(payload)
    if (S.accounts.active !== account) return
    if (result?.library) S.library.data = result.library
    if (result?.learning) S.library.learning = result.learning
    S.library.review = Array.isArray(result?.review) ? result.review : []
    if (result?.ok) {
      const extra = result.classified
        ? `；AI 分析：模型调用 ${result.classified.aiCalls || 0} 次${result.classified.errors?.length ? `，${result.classified.errors[0].reason || '部分失败'}` : ''}`
        : ''
      S.library.collectorMessage = `${result.message}${extra}`
      S.library.analyzeMessage = `已收集 ${result.added || 0} 条评论（去重 ${result.duplicates || 0} 条），${S.library.review.length ? `其中 ${S.library.review.length} 条需要你判断` : '没有需要你判断的评论'}`
      if (result.reachedCap) S.library.analyzeMessage += '；已达页数上限，可点“继续上次收集”'
    } else {
      S.library.collectorMessage = `${result.reason || result.error || '收集未完成'}${result.nextAction ? `；下一步：${result.nextAction}` : ''}`
      S.library.analyzeMessage = S.library.collectorMessage
      showNotice(S.library.collectorMessage, 'err')
    }
  } catch (error) {
    if (S.accounts.active === account) { S.library.collectorMessage = error.message || String(error); S.library.analyzeMessage = S.library.collectorMessage; showNotice(S.library.collectorMessage, 'err') }
  } finally {
    S.library.collecting = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account) {
      patchContainer('discover-home', () => discoverHomeView())
      patchContainer('review-queue', () => reviewQueueView())
      patchContainer('collector-panel', () => collectorView())
      patchContainer('library-body', () => libraryBodyView())
      patchContainer('discovery-candidates', discoveryListView())
      patchContainer('discovery-detail', discoveryDetailView())
      refreshLearningPanel()
      const host = document.getElementById('library-review')
      if (host) host.outerHTML = libraryReviewView()
      else {
        const anchor = document.querySelector('#learning-panel')
        if (anchor) anchor.insertAdjacentHTML('beforebegin', libraryReviewView())
      }
    }
  }
}
// P2-11A 收藏夹同步：读取用户指定收藏夹，按作品 ID 去重后增量入库。
async function favoritesSaveFolderOperation(btn, inputId = 'favorites-folder') {
  if (S.library.favoritesBusy || S.library.busy) return
  const account = S.accounts.active
  const folderName = String(document.getElementById(inputId)?.value || '').trim()
  if (!folderName) { showNotice('收藏夹名称不能为空', 'err'); return }
  S.library.favoritesBusy = true
  S.library.favoritesMessage = ''
  if (btn) btn.disabled = true
  try {
    const result = await api.library.saveFavoritesFolder({ folderName })
    if (S.accounts.active !== account) return
    if (!result?.ok) throw new Error(result?.reason || result?.error || '保存失败')
    if (result.library) S.library.data = result.library
    else if (S.library.data && result.favorites) S.library.data.favorites = result.favorites
    batchState().favoritesFolder = folderName
    S.library.favoritesMessage = result.message || '已保存收藏夹名称'
    showNotice(S.library.favoritesMessage)
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.favoritesMessage = error.message || String(error)
      showNotice(S.library.favoritesMessage, 'err')
    }
  } finally {
    S.library.favoritesBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('favorites-panel', () => favoritesSyncView())
      patchContainer('scheduler-panel', () => schedulerView())
    }
  }
}
async function favoritesSyncOperation(btn, { resume = false } = {}) {
  if (S.library.favoritesBusy || S.library.busy) return
  const account = S.accounts.active
  const folderName = String(document.getElementById('favorites-folder')?.value || '').trim()
  if (!folderName) { showNotice('请先填写抖音收藏夹名称', 'err'); return }
  S.library.favoritesBusy = true
  S.library.favoritesMessage = ''
  if (btn) btn.disabled = true
  patchContainer('favorites-panel', () => favoritesSyncView())
  try {
    const result = await api.library.syncFavorites({ folderName, resume })
    if (S.accounts.active !== account) return
    if (result?.library) S.library.data = result.library
    if (!result?.ok) {
      if (result?.code === 'CONFIG_MISSING') {
        S.library.favoritesMessage = '配置缺失：收藏夹名称尚未保存。请填写名称后点“保存名称”，再开始同步。'
        showNotice(S.library.favoritesMessage, 'err')
        return
      }
      throw new Error(`${result?.reason || result?.error || '收藏夹同步失败'}${result?.nextAction ? `；下一步：${result.nextAction}` : ''}`)
    }
    S.library.favoritesMessage = result.message || `识别 ${result.found || 0} 个作品，新增 ${result.added || 0} 个，去重 ${result.duplicates || 0} 个`
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.favoritesMessage = error.message || String(error)
      showNotice(S.library.favoritesMessage, 'err')
    }
  } finally {
    S.library.favoritesBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('favorites-panel', () => favoritesSyncView())
      patchContainer('discover-home', () => discoverHomeView())
      patchContainer('library-body', () => libraryBodyView())
      patchContainer('discovery-candidates', discoveryListView())
      patchContainer('discovery-detail', discoveryDetailView())
    }
  }
}
// P2-12B 调度操作：开关/暂停/继续/停止/立即一轮都由主进程持久化并扣预算。
async function schedulerOperation(btn, operation, success) {
  if (S.library.schedulerBusy) return
  const account = S.accounts.active
  S.library.schedulerBusy = true
  S.library.schedulerMessage = ''
  if (btn) btn.disabled = true
  patchContainer('scheduler-panel', () => schedulerView())
  try {
    const result = await operation()
    if (S.accounts.active !== account) return
    if (result?.scheduler) S.library.scheduler = result.scheduler
    if (result?.library) S.library.data = result.library
    if (!result?.ok) throw new Error(result?.error || '自动任务操作失败')
    S.library.schedulerMessage = typeof success === 'function' ? success(result) : (success || result.message || '已更新自动任务')
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.schedulerMessage = error.message || String(error)
      showNotice(S.library.schedulerMessage, 'err')
    }
  } finally {
    S.library.schedulerBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('scheduler-panel', () => schedulerView())
      patchContainer('discovery-overview', () => discoveryOverviewView())
      patchContainer('favorites-panel', () => favoritesSyncView())
      patchContainer('pipeline-panel', () => pipelineView())
      patchContainer('learning-summary', () => learningSummaryView())
      patchContainer('core-candidates', () => coreCandidatesView())
      patchContainer('library-body', () => libraryBodyView())
      patchContainer('discovery-candidates', discoveryListView())
      patchContainer('discovery-detail', discoveryDetailView())
    }
  }
}
// P2-11E 同步并自动分析：一次启动完成收藏夹同步 → 评论收集 → 意愿分类 → 候选整理。
// 单次任务有全局预算（默认 10 个视频、12 次模型调用），达到后持久化状态，下次继续。
async function discoverySyncRunOperation(btn) {
  if (S.library.favoritesBusy || S.library.pipelineBusy) return
  const account = S.accounts.active
  const folderName = String(document.getElementById('favorites-folder')?.value || '').trim()
  if (!folderName) { showNotice('请先填写抖音收藏夹名称', 'err'); return }
  S.library.favoritesBusy = true
  S.library.pipelineBusy = true
  S.library.favoritesMessage = ''
  S.library.pipelineMessage = ''
  if (btn) btn.disabled = true
  patchContainer('favorites-panel', () => favoritesSyncView())
  patchContainer('pipeline-panel', () => pipelineView())
  try {
    const result = await api.library.runDiscovery({ folderName })
    if (S.accounts.active !== account) return
    if (result?.library) S.library.data = result.library
    if (result?.learning) S.library.learning = result.learning
    const candidates = result?.result?.candidates
    if (candidates?.discovery && S.data) S.data.discovery = candidates.discovery
    if (!result?.ok) throw new Error(result?.error || result?.result?.message || '同步或自动分析未完成')
    const sync = result.sync || {}
    S.library.favoritesMessage = `同步完成：识别 ${sync.found || 0} 个作品，新增 ${sync.added || 0} 个，去重 ${sync.duplicates || 0} 个`
    S.library.pipelineMessage = result.result?.message || '自动分析完成'
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.favoritesMessage = error.message || String(error)
      S.library.pipelineMessage = error.message || String(error)
      showNotice(S.library.favoritesMessage, 'err')
    }
  } finally {
    S.library.favoritesBusy = false
    S.library.pipelineBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('discovery-overview', () => discoveryOverviewView())
      patchContainer('favorites-panel', () => favoritesSyncView())
      patchContainer('pipeline-panel', () => pipelineView())
      patchContainer('core-candidates', () => coreCandidatesView())
      patchContainer('learning-summary', () => learningSummaryView())
      patchContainer('library-body', () => libraryBodyView())
      patchContainer('discovery-candidates', discoveryListView())
      patchContainer('discovery-detail', discoveryDetailView())
    }
  }
}
// P2-11B 自动评论分析：逐视频读取评论、规则/豆包分类；暂停只停止后续视频，不打断已开始的读取。
async function pipelineOperation(btn, { retryFailed = false } = {}) {
  if (S.library.pipelineBusy) return
  const account = S.accounts.active
  S.library.pipelineBusy = true
  S.library.pipelineMessage = ''
  if (btn) btn.disabled = true
  patchContainer('pipeline-panel', () => pipelineView())
  try {
    const result = await api.library.runPipeline({ retryFailed })
    if (S.accounts.active !== account) return
    if (result?.library) S.library.data = result.library
    if (result?.learning) S.library.learning = result.learning
    // P2-11C：本轮自动更新候选池后，界面同步最新候选列表。
    if (result?.candidates?.discovery && S.data) S.data.discovery = result.candidates.discovery
    if (!result?.ok) throw new Error(result?.error || result?.reason || '自动分析未完成')
    S.library.pipelineMessage = result.message || `本轮处理 ${result.processed || 0} 个视频`
  } catch (error) {
    if (S.accounts.active === account) {
      S.library.pipelineMessage = error.message || String(error)
      showNotice(S.library.pipelineMessage, 'err')
    }
  } finally {
    S.library.pipelineBusy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === account && S.section === 'discovery') {
      patchContainer('discovery-overview', () => discoveryOverviewView())
      patchContainer('pipeline-panel', () => pipelineView())
      patchContainer('core-candidates', () => coreCandidatesView())
      patchContainer('learning-summary', () => learningSummaryView())
      patchContainer('library-body', () => libraryBodyView())
      patchContainer('discovery-candidates', discoveryListView())
      patchContainer('discovery-detail', discoveryDetailView())
    }
  }
}
async function pipelinePauseOperation(btn) {
  if (btn) btn.disabled = true
  try {
    const result = await api.library.pausePipeline()
    if (result?.library) S.library.data = result.library
    else if (result?.pipeline && S.library.data) S.library.data.pipeline = result.pipeline
    S.library.pipelineMessage = result?.message || '已请求暂停，将在当前视频处理完成后停止'
  } catch (error) {
    S.library.pipelineMessage = error.message || String(error)
    showNotice(S.library.pipelineMessage, 'err')
  } finally {
    if (btn) btn.disabled = false
    if (S.section === 'discovery') patchContainer('pipeline-panel', () => pipelineView())
  }
}
function collectPayloadFromInputs() {
  const text = document.getElementById('library-collect-input')?.value.trim() || ''
  if (!text) throw new Error('请粘贴抖音视频链接或作品 ID')
  const limit = Number(document.getElementById('library-collect-limit')?.value)
  const maxPages = Number(document.getElementById('library-collect-pages')?.value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 300) throw new Error('最多收集条数请填 1～300 的整数')
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error('最多翻页数请填 1～20 的整数')
  return { text, limit, maxPages, title: document.getElementById('library-collect-title')?.value.trim() || '' }
}
function tasksView() {
  const pc = S.data.settings.proactiveChat || {}
  const eventEnabled = S.data.settings.eventFollowup?.enabled !== false
  return `
    ${sparkEditForm()}
    <div class="panel">
      <div class="row"><h3 style="margin:0">事件跟进</h3><span class="spacer"></span><button class="btn small primary" data-act="event-scan">检查到期事件</button></div>
      <div class="field" style="margin-top:10px"><label>自动检查事件</label><select data-path="settings.eventFollowup.enabled"><option value="on" ${eventEnabled ? 'selected' : ''}>开启（只生成草稿）</option><option value="off" ${!eventEnabled ? 'selected' : ''}>关闭</option></select></div>
      <p class="muted">对方明确提过的事件进入跟进窗口后，交给 AI 判断是否值得问一句，结果放入对应对话，审核后发送。默认距离上次聊天至少 6 小时，并检查连续主动、未回复消息、免打扰与发送额度。</p>
      <p class="muted">交友模式和老朋友模式均可使用；独立于 AI 伴聊开关，暂停自动回复时也暂停事件跟进。聊天中已解决、取消或改期的事件会更新待跟进任务。</p>
    </div>
    <div class="panel">
      <div class="row"><h3 style="margin:0">定时问候任务（原"续火花"）</h3><span class="spacer"></span>
        <button class="btn small" data-act="spark-preview">AI 拟一条预览（不发送）</button>
        <button class="btn small primary" data-act="spark-new">新建任务</button></div>
      <div id="sparks-list">${sparksList()}</div>
    </div>
    <div class="panel">
      <h3>AI 伴聊（低频主动开场）</h3>
      <div class="field"><label>伴聊话题素材（可选）</label><textarea maxlength="2000" data-path="settings.proactiveChat.topicNotes" placeholder="例如：今天买咖啡时顺口说了谢谢老师，把店员和自己都逗笑了。可以围绕这件事轻松开场，不编其他经历。">${esc(pc.topicNotes || '')}</textarea></div>
      <p class="muted">填写后，符合伴聊条件的联系人会优先围绕这份素材生成文字开场；不会立即群发。清空后恢复自主选题。时效过了请更新或清空，频率和联系人权限仍然有效。</p>
      <div class="grid3">
        <div class="field"><label>开关</label><select data-path="settings.proactiveChat.enabled">
          <option value="off" ${!pc.enabled ? 'selected' : ''}>关闭</option>
          <option value="on" ${pc.enabled ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>每天最多</label><input data-path="settings.proactiveChat.maxPerDay" value="${esc(pc.maxPerDay ?? 2)}" /></div>
        <div class="field"><label>最小间隔（分钟）</label><input data-path="settings.proactiveChat.minIntervalMinutes" value="${esc(pc.minIntervalMinutes ?? 180)}" /></div>
        <div class="field"><label>活跃时段开始</label><input data-path="settings.proactiveChat.windowStart" value="${esc(pc.windowStart || '10:00')}" /></div>
        <div class="field"><label>活跃时段结束</label><input data-path="settings.proactiveChat.windowEnd" value="${esc(pc.windowEnd || '22:00')}" /></div>
        <div class="field"><label>先拟草稿</label><select data-path="settings.proactiveChat.sendToDraft">
          <option value="off" ${!pc.sendToDraft ? 'selected' : ''}>直接发送</option>
          <option value="on" ${pc.sendToDraft ? 'selected' : ''}>先拟草稿</option>
        </select></div>
        <div class="field"><label>开场方式</label><select data-path="settings.proactiveChat.openingType"><option value="text" ${pc.openingType !== 'video' ? 'selected' : ''}>文字话题</option><option value="video" ${pc.openingType === 'video' ? 'selected' : ''}>AI 找视频＋一句话</option></select></div>
      </div>
      <div class="muted" style="margin-top:8px">伴聊会给较久未联系的朋友发一条自然的开场消息；每天有总量与间隔限制，不会刷屏。</div>
    </div>`
}

function providersList() {
  const providers = S.data.providers || []
  if (!providers.length) return '<div class="empty" style="padding:20px">还没有配置模型。AI 回复需要至少一个 OpenAI 兼容接口。</div>'
  return providers.map((p, index) => `
    <div class="card">
      <div class="card-head">
        <strong>${esc(p.name)}</strong>
        <span class="pill">${esc(p.model)}</span>
        ${(p.capabilities || []).includes('vision') ? '<span class="pill ok">视觉</span>' : ''}
        <span class="spacer"></span>
        <button class="btn small" data-act="provider-test" data-args='${esc(JSON.stringify({ index }))}'>测试</button>
        <button class="btn small" data-act="provider-edit" data-args='${esc(JSON.stringify({ index }))}'>编辑</button>
        <button class="btn small" data-act="provider-primary" data-args='${esc(JSON.stringify({ name: p.name }))}'>设为主模型</button>
        <button class="btn small danger" data-act="provider-delete" data-args='${esc(JSON.stringify({ name: p.name }))}'>删除</button>
      </div>
      <div class="muted">${esc(p.baseUrl || '')}</div>
    </div>`).join('')
}

function providerForm() {
  if (S.providerEditing === null) return ''
  const p = S.providerEditing >= 0 ? (S.data.providers || [])[S.providerEditing] || {} : {}
  return `<div class="panel">
    <h3>${S.providerEditing >= 0 ? `编辑：${esc(p.name || '')}` : '添加模型接口'}</h3>
    <div class="grid2">
      <div class="field"><label>名称</label><input id="pv-name" value="${esc(p.name || '')}" placeholder="如：主力模型" /></div>
      <div class="field"><label>接口地址</label><input id="pv-base" value="${esc(p.baseUrl || '')}" placeholder="如：https://api.deepseek.com/v1" />
        <div class="muted" id="pv-base-preview"></div></div>
      <div class="field"><label>API Key（留空保持不变）</label><input id="pv-key" type="password" value="" placeholder="sk-..." /></div>
      <div class="field"><label>模型 ID</label>
        <div class="row" style="gap:6px">
          <input id="pv-model" list="pv-model-list" value="${esc(p.model || '')}" placeholder="填好地址和 Key 后点右侧获取，或手动填写" style="flex:1" />
          <button class="btn small" data-act="provider-fetch-models">获取模型列表</button>
        </div>
        <datalist id="pv-model-list">${(S.modelOptions || []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
        <div class="muted" id="pv-model-status">${esc(S.modelFetchMsg || '')}</div>
      </div>
      <div class="field"><label>能力</label><label class="check"><input type="checkbox" id="pv-vision" ${((p.capabilities || []).includes('vision')) ? 'checked' : ''}/> 支持图片/视频识别</label></div>
      <div class="field"><label>音频转写模型（可选）</label><input id="pv-trans" value="${esc(p.transcriptionModel || '')}" placeholder="whisper-1" /></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-act="provider-save" data-args='${esc(JSON.stringify({ index: S.providerEditing }))}'>保存</button>
      <button class="btn" data-act="provider-cancel">取消</button>
    </div>
  </div>`
}

// 接口地址实时预览：调用主进程同一套归一化逻辑，显示最终会请求的地址
async function refreshBasePreview() {
  const input = document.getElementById('pv-base')
  const box = document.getElementById('pv-base-preview')
  if (!input || !box) return
  const value = input.value.trim()
  if (!value) { box.textContent = ''; box.className = 'muted'; return }
  try {
    const result = await api.ai.normalizeBaseUrl(value)
    if (result?.ok) {
      box.textContent = `实际请求地址：${result.baseUrl}/chat/completions`
      box.className = 'muted ok'
    } else {
      box.textContent = result?.message || '接口地址格式不正确'
      box.className = 'muted err'
    }
  } catch {
    box.textContent = ''
    box.className = 'muted'
  }
}

function queueBasePreview() {
  clearTimeout(S.basePreviewTimer)
  S.basePreviewTimer = setTimeout(() => { refreshBasePreview() }, 250)
}

// 把拉取到的模型 ID 填进 datalist（直接改 DOM，不重渲染，避免丢失已填内容）
function applyModelOptions(list) {
  const dl = document.getElementById('pv-model-list')
  if (dl) dl.innerHTML = (list || []).map((m) => `<option value="${esc(m)}"></option>`).join('')
}

function setModelStatus(text, kind = '') {
  const box = document.getElementById('pv-model-status')
  if (!box) return
  box.textContent = text || ''
  box.className = kind ? `muted ${kind}` : 'muted'
}

function modelsView() {
  return `
    ${providerForm()}
    <div class="panel">
      <div class="row"><h3 style="margin:0">模型列表（多账号共享，按顺序故障转移）</h3><span class="spacer"></span>
        <label class="check"><input type="checkbox" data-path="settings.failoverEnabled" ${S.data.settings.failoverEnabled !== false ? 'checked' : ''}/> 启用备用模型切换</label>
        <button class="btn small primary" data-act="provider-new">添加模型</button></div>
      <div id="providers-list">${providersList()}</div>
    </div>`
}

function logsList() {
  const logs = S.data.logs || []
  const f = S.logFilter
  const filtered = logs.filter((entry) => {
    if (f.type && entry.type !== f.type) return false
    if (f.keyword) {
      const hay = `${entry.message || ''} ${JSON.stringify(entry.detail || {})}`.toLowerCase()
      if (!hay.includes(f.keyword.toLowerCase())) return false
    }
    return true
  })
  if (!filtered.length) return '<div class="empty">没有匹配的记录</div>'
  return filtered.map((entry) => `
    <div class="log-item">
      <div class="log-head">
        <span class="log-type">${LOG_LABELS[entry.type] || entry.type}</span>
        <span class="log-time">${fmtTime(entry.at)}</span>
      </div>
      <div>${esc(entry.message || '')}</div>
      ${entry.detail && Object.keys(entry.detail).length ? `<div class="log-detail">${esc(JSON.stringify(entry.detail).slice(0, 300))}</div>` : ''}
    </div>`).join('')
}

// ---- 训练场 ----
function trainBubble(m) {
  if (m.role === 'contact') return `<div class="muted" style="margin:8px 0">对方：${esc(m.text)}</div>`
  if (m.role === 'ai') return `<div style="margin:8px 0;color:var(--text-dim)">AI 拟：${esc(m.text)}</div>`
  if (m.role === 'me') return `<div style="margin:8px 0"><strong>你${m.learned ? '（已学习 ✓）' : ''}：</strong>${esc(m.text)}</div>`
  return ''
}

function trainView() {
  const contacts = S.data.contacts || []
  const name = S.train.name
  const contact = contacts.find((c) => c.name === name)
  const examples = contact?.profile?.examples || []
  const learning = contact?.learning || {}
  const styleSummary = learning.ownerStyle?.summary || '样本不足（多示范几条就会开始积累）'
  return `
    <div class="panel">
      <h3>训练对象</h3>
      <div class="row">
        <div class="field" style="width:280px"><label>选择联系人（真实或虚拟均可）</label>
          <select id="train-contact">
            <option value="">选择…</option>
            ${contacts.map((c) => `<option value="${esc(c.name)}" ${name === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            ${name && !contacts.some((c) => c.name === name) ? `<option value="${esc(name)}" selected>${esc(name)}（虚拟）</option>` : ''}
          </select>
        </div>
        <button class="btn" data-act="train-new-contact">新建训练对象</button>
        ${name ? `<span class="muted">已学样例 <strong>${examples.length}</strong> 条 · 历史消息 ${learning.messages?.length || 0} 条 · 当前风格：${esc(styleSummary)}</span>` : ''}
      </div>
    </div>
    ${name ? `
    <div class="panel">
      <h3>对话练习（纯本地学习，不发送给任何人）</h3>
      <div id="train-transcript" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--panel-2)">
        ${S.train.log.length ? S.train.log.map(trainBubble).join('') : '<div class="muted">流程：输入一句"对方发的消息" → 让 AI 拟回复 → 你改成自己的语气确认。反复练习，自动回复就会模仿你的说法。</div>'}
      </div>
      <div class="row" style="margin-top:10px">
        <input id="train-incoming" style="flex:1;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:7px 9px" placeholder="对方发的消息，如：在干嘛呢" />
        <button class="btn" data-act="train-incoming">对方说 →</button>
      </div>
      ${S.train.draft !== null ? `
        <div class="field" style="margin-top:10px"><label>AI 拟回复（可直接采用；或改成你的语气点"学习"——改动会被记为你的示范）</label>
        <textarea id="train-draft">${esc(S.train.draft)}</textarea></div>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" data-act="train-learn">✓ 就这样说，学习它</button>
          <button class="btn" data-act="train-accept">直接采用（不学习语气）</button>
          <button class="btn" data-act="train-redraft">重新拟一条</button>
        </div>` : `
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-act="train-draft">让 AI 拟回复</button>
        </div>`}
    </div>
    <div class="muted">学习去向：① 你的示范进入该联系人的"本人说话样例"（自动回复时的最高优先级模仿对象）；② 句长/标点/语气词等风格统计照常累积；③ 对话历史照常累积供上下文。AI 自己的原文不会被当成你的语气（防止 AI 学自己）。</div>` : ''}
  `
}

function logsView() {
  const logs = S.data.logs || []
  const types = [...new Set(logs.map((l) => l.type))].sort()
  return `
    <div class="panel">
      <div class="row">
        <div class="field" style="width:220px"><label>类型</label><select id="log-type">
          <option value="">全部</option>
          ${types.map((t) => `<option value="${esc(t)}" ${S.logFilter.type === t ? 'selected' : ''}>${LOG_LABELS[t] || t}</option>`).join('')}
        </select></div>
        <div class="field" style="flex:1"><label>关键词</label><input id="log-keyword" value="${esc(S.logFilter.keyword)}" placeholder="搜索消息内容 / 联系人" /></div>
      </div>
    </div>
    <div class="panel"><div id="logs-list">${logsList()}</div></div>`
}

// This form keeps local edits separate from the background state mirror.
function resetSelfProfileUi() {
  S.selfProfileUi = { accountId: S.accounts.active, raw: '', pendingId: '', review: {}, editing: {}, add: {}, busy: false }
}
function selfProfileUi() {
  if (S.selfProfileUi.accountId !== S.accounts.active) resetSelfProfileUi()
  const pendingId = S.data?.selfProfile?.pending?.id || ''
  if (S.selfProfileUi.pendingId !== pendingId) { S.selfProfileUi.pendingId = pendingId; S.selfProfileUi.review = {} }
  return S.selfProfileUi
}
function selfProfileSignature() { return `${S.accounts.active}:${S.data?.selfProfile?.revision || 0}:${S.data?.selfProfile?.pending?.id || ''}` }
function refreshSelfProfilePanel() {
  if (patchContainer('self-profile-content', selfProfileContent())) selfProfileUi().displayedSignature = selfProfileSignature()
}
const SELF_SECTIONS = { stableProfile: '稳定资料', currentLife: '当前生活', privacyPreferences: '披露偏好' }
const SELF_LEVELS = { OPEN: 'OPEN · 可以自然使用', NORMAL: 'NORMAL · 话题相关时使用', CAUTIOUS: 'CAUTIOUS · 谨慎、顺势使用', PRIVATE: 'PRIVATE · 自动聊天不披露' }
function selfValueText(value) { return Array.isArray(value) ? value.join('\n') : String(value ?? '') }
function selfExpiryDay(value) { return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '' }
function selfEditKey(section, id) { return `${section}:${id}` }
function selfProfileCard(item, section, scope) {
  const local = selfProfileUi(), key = selfEditKey(section, item.id)
  const edit = (scope === 'pending' ? local.review : local.editing)[key] || {}
  const label = edit.label ?? item.label, value = edit.valueText ?? selfValueText(item.value), level = edit.shareLevel ?? item.shareLevel
  const keep = edit.keep !== false, disabled = local.busy || (scope === 'pending' && !keep)
  const attributes = `data-self-scope="${scope}" data-self-section="${section}" data-self-id="${esc(item.id)}"`
  const args = esc(JSON.stringify({ section, id: item.id }))
  const expires = edit.expiresDate ?? selfExpiryDay(item.expiresAt)
  return `<details class="card" ${scope === 'pending' ? 'open' : ''}><summary>${esc(label || item.key)} · ${esc(level || 'NORMAL')}${item.expiresAt && Date.parse(item.expiresAt) <= Date.now() ? ' · 已过期（不进入聊天）' : ''}</summary>
    ${scope === 'pending' ? `<label class="check" style="margin:8px 0"><input type="checkbox" ${attributes} data-self-field="keep" ${keep ? 'checked' : ''} ${local.busy ? 'disabled' : ''}> 保留这一条</label>` : ''}
    <div class="grid2" style="margin-top:8px"><div class="field"><label>名称</label><input ${attributes} data-self-field="label" value="${esc(label)}" maxlength="100" ${disabled ? 'disabled' : ''}></div>
    <div class="field"><label>披露级别</label><select ${attributes} data-self-field="shareLevel" ${disabled ? 'disabled' : ''}>${Object.entries(SELF_LEVELS).map(([code, name]) => `<option value="${code}" ${level === code ? 'selected' : ''}>${name}</option>`).join('')}</select></div></div>
    <div class="field" style="margin-top:8px"><label>内容（多项每行一项）</label><textarea ${attributes} data-self-field="valueText" maxlength="4000" ${disabled ? 'disabled' : ''}>${esc(value)}</textarea></div>
    ${section === 'currentLife' ? `<div class="field" style="margin-top:8px"><label>有效期至（空白使用 30 天）</label><input type="date" ${attributes} data-self-field="expiresDate" value="${esc(expires)}" ${disabled ? 'disabled' : ''}></div>` : ''}
    ${item.sourceText ? `<details style="margin-top:8px"><summary class="muted">资料来源</summary><p class="muted" style="white-space:pre-wrap">${esc(item.sourceText)}</p></details>` : ''}
    ${scope === 'saved' ? `<div class="row" style="margin-top:8px"><button class="btn small primary" data-act="self-profile-save" data-args="${args}" ${local.busy ? 'disabled' : ''}>保存修改</button><button class="btn small danger" data-act="self-profile-delete" data-args="${args}" ${local.busy ? 'disabled' : ''}>删除这条</button></div>` : ''}
  </details>`
}
function selfProfileContent() {
  const local = selfProfileUi(), profile = S.data?.selfProfile || { revision: 0 }, pending = profile.pending
  const empty = !profile.revision && !pending && !Object.keys(SELF_SECTIONS).some(section => profile[section]?.length)
  const disabled = local.busy ? 'disabled' : ''
  return `<p class="muted">写一段关于自己的真实介绍，AI 提取后先由你审核。PRIVATE 资料不进入自动聊天；学校等谨慎资料只在自然相关的话题中酌情分享。</p>
    <div class="field" style="margin-top:10px"><label>直接输入我的资料</label><textarea id="self-profile-about" maxlength="30000" placeholder="介绍真实兴趣、日常和近期状态；无需逐项填写。">${esc(local.raw)}</textarea></div>
    <div class="row" style="margin-top:8px"><button class="btn primary" data-act="self-profile-extract" ${disabled}>${local.busy ? '正在处理…' : 'AI 提取个人信息'}</button><button class="btn" data-act="self-profile-refresh" ${disabled}>刷新已保存资料</button>${empty ? `<button class="btn" data-act="self-profile-initialize" ${disabled}>使用本轮已提供的基础资料</button>` : ''}</div>
    ${pending ? `<div style="margin-top:18px"><h3>审核提取结果</h3><p class="muted">这些资料尚未生效。可以修改内容和披露级别，取消勾选删除；确认后才进入本人信息库。</p>
      ${Object.entries(SELF_SECTIONS).map(([section, label]) => pending[section]?.length ? `<h4>${label}</h4>${pending[section].map(item => selfProfileCard(item, section, 'pending')).join('')}` : '').join('')}
      ${(pending.uncertainItems || []).length ? `<details open><summary>未确认内容（不会自动变成事实）</summary>${pending.uncertainItems.map(item => `<p class="muted">${esc(item.label || item.key || '待核实')}：${esc(item.reason || '没有可靠原文证据')}${item.sourceText ? `<br>${esc(item.sourceText)}` : ''}</p>`).join('')}</details>` : ''}
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="self-profile-confirm" ${disabled}>确认并正式保存</button><button class="btn" data-act="self-profile-discard" ${disabled}>丢弃本次提取</button></div></div>` : ''}
    <h3 style="margin-top:18px">已保存资料</h3>
    ${Object.entries(SELF_SECTIONS).map(([section, label]) => `<details ${section === 'currentLife' ? 'open' : ''}><summary>${label} · ${(profile[section] || []).length} 条</summary>${(profile[section] || []).map(item => selfProfileCard(item, section, 'saved')).join('') || '<p class="muted">暂无资料</p>'}</details>`).join('')}
    <details style="margin-top:12px"><summary>手动添加一条真实资料</summary><div class="grid2" style="margin-top:8px">
      <div class="field"><label>资料分区</label><select data-self-scope="add" data-self-field="section" ${disabled}>${Object.entries(SELF_SECTIONS).map(([section, label]) => `<option value="${section}" ${(local.add.section || 'stableProfile') === section ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="field"><label>资料类别标识</label><input data-self-scope="add" data-self-field="key" value="${esc(local.add.key || '')}" placeholder="例如 gaming / currentWork；相同类别会替换" maxlength="80" ${disabled}></div>
      <div class="field"><label>名称</label><input data-self-scope="add" data-self-field="label" value="${esc(local.add.label || '')}" maxlength="100" ${disabled}></div>
      <div class="field"><label>披露级别</label><select data-self-scope="add" data-self-field="shareLevel" ${disabled}>${Object.entries(SELF_LEVELS).map(([level, label]) => `<option value="${level}" ${(local.add.shareLevel || 'NORMAL') === level ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:1/-1"><label>内容（多项每行一项）</label><textarea data-self-scope="add" data-self-field="valueText" maxlength="4000" ${disabled}>${esc(local.add.valueText || '')}</textarea></div>
      <div class="field"><label>当前生活有效期（其他分区忽略）</label><input type="date" data-self-scope="add" data-self-field="expiresDate" value="${esc(local.add.expiresDate || '')}" ${disabled}></div>
      </div><button class="btn" style="margin-top:8px" data-act="self-profile-add" ${disabled}>保存这条资料</button></details>`
}
function selfProfileView() { return `<div class="panel"><h3>本人信息库</h3><div id="self-profile-content">${selfProfileContent()}</div></div>` }
function rememberSelfProfileField(el) {
  if (el.id === 'self-profile-about') { selfProfileUi().raw = el.value; return true }
  if (!el.dataset?.selfField) return false
  const local = selfProfileUi(), scope = el.dataset.selfScope, field = el.dataset.selfField
  const value = field === 'keep' ? Boolean(el.checked) : el.value
  if (scope === 'add') { if (!Object.keys(local.add).length) local.add.baseRevision = S.data.selfProfile?.revision || 0; local.add[field] = value; return true }
  if (!['pending', 'saved'].includes(scope) || !SELF_SECTIONS[el.dataset.selfSection]) return true
  const target = scope === 'pending' ? local.review : local.editing, key = selfEditKey(el.dataset.selfSection, el.dataset.selfId)
  target[key] ||= { baseRevision: S.data.selfProfile?.revision || 0 }
  target[key][field] = value
  return true
}
function selfProfileEditedItem(item, section, edit = {}) {
  if (edit.keep === false) return { ...item, keep: false }
  const parts = String(edit.valueText ?? selfValueText(item.value)).split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (!parts.length) throw new Error('资料内容不能为空；不保留的提取项请取消勾选')
  const label = String(edit.label ?? item.label ?? item.key).trim(), level = edit.shareLevel ?? item.shareLevel ?? 'NORMAL'
  if (!label || !SELF_LEVELS[level]) throw new Error('请填写资料名称并选择有效披露级别')
  let value = Array.isArray(item.value) || parts.length > 1 ? parts : parts[0]
  if (typeof item.value === 'number' && parts.length === 1) { value = Number(parts[0]); if (!Number.isFinite(value)) throw new Error('这条资料需要有效数字') }
  let expiresAt = item.expiresAt || null
  if (section === 'currentLife' && Object.hasOwn(edit, 'expiresDate')) {
    const day = String(edit.expiresDate).trim()
    if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T12:00:00Z`)) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day)) throw new Error('当前生活有效期不是有效日期')
    expiresAt = day ? new Date(`${day}T23:59:59+08:00`).toISOString() : null
  }
  return { ...item, label, value, shareLevel: level, expiresAt }
}
async function selfProfileOperation(method, buildPayload, btn, successMessage, afterSuccess) {
  const local = selfProfileUi(), accountId = S.accounts.active
  if (local.busy) return
  local.busy = true
  if (btn) btn.disabled = true
  try {
    if (!api.selfProfile?.[method]) throw new Error('本人信息库接口尚未就绪，请重新启动程序')
    const extra = typeof buildPayload === 'function' ? buildPayload() : buildPayload || {}
    const result = await api.selfProfile[method]({ accountId, revision: S.data.selfProfile?.revision || 0, ...extra })
    if (S.accounts.active !== accountId || S.selfProfileUi !== local) return
    if (!result?.ok || !result.selfProfile) throw new Error(result?.error || '本人信息库操作失败')
    if ((result.selfProfile.revision || 0) < (S.data.selfProfile?.revision || 0)) throw new Error('本人资料已在后台更新，请刷新后查看最新版本')
    S.data.selfProfile = result.selfProfile
    if (afterSuccess) afterSuccess(local)
    selfProfileUi()
    if (successMessage) showNotice(successMessage)
    return result
  } catch (error) {
    if (S.accounts.active === accountId && S.selfProfileUi === local) showNotice(error.message || String(error), 'err')
  } finally {
    local.busy = false
    if (btn) btn.disabled = false
    if (S.accounts.active === accountId && S.selfProfileUi === local && S.section === 'settings') refreshSelfProfilePanel()
  }
}
const JOURNEY_STAGE_LABELS = { STRANGER: '陌生人', EXPLORING: '相互了解', ACQUAINTANCE: '认识的人', FAMILIAR: '熟悉的人', FRIEND: '朋友', CLOSE_FRIEND: '亲近的朋友' }
const SHARED_MEMORY_LABELS = { SHARED_MOMENT: '共同经历', INSIDE_JOKE: '共同梗', MUTUAL_DISCOVERY: '发现共同点', EMOTIONAL_MOMENT: '情绪互动', SUPPORT_MOMENT: '支持与陪伴', CELEBRATION: '共同庆祝', CONFLICT_AND_REPAIR: '冲突与和解', PROMISE: '双方约定', CALLBACK_CHAIN: '多次回访', MILESTONE: '关系节点' }
function sharedMemoryView(contact) {
  const key = String(contact?.id || contact?.name || ''), container = contact?.sharedMemory || {}
  const deleted = new Set((Array.isArray(container.tombstones) ? container.tombstones : []).filter(item => item?.contactId === key).map(item => item.id))
  const memories = container.contactId === key && Array.isArray(container.memories) ? container.memories.filter(item => item && item.contactId === key && item.sourceContactId === key && item.status === 'active' && !deleted.has(item.id) && Object.hasOwn(SHARED_MEMORY_LABELS, item.type)) : []
  const strength = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` : '待确认'
  const recalls = value => Number.isInteger(value) && value >= 0 ? value : 0
  return `<h3 style="margin-top:12px">共同记忆</h3><p class="muted">记录我们共同发生过的互动；可删除错误记忆。</p>${memories.length ? memories.map(item => `<div class="card" style="margin-top:8px"><strong>${esc(SHARED_MEMORY_LABELS[item.type])}</strong><p style="overflow-wrap:anywhere">${esc(item.summary)}</p><p class="muted">时间：${esc(journeyDate(item.createdAt))} · 更新：${esc(journeyDate(item.updatedAt))}<br/>强度：${esc(strength(item.strength))} · 状态：有效 · 回忆 ${esc(recalls(item.recallCount))} 次${item.lastRecalledAt ? `（最近 ${esc(journeyDate(item.lastRecalledAt))}）` : ''}<br/>来源消息：${esc((Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds : []).join('、') || '待确认')}</p><button class="btn small danger" data-act="shared-memory-delete" data-args='${esc(JSON.stringify({ accountId: S.accounts.active, contactId: key, memoryId: item.id }))}'>删除这条共同记忆</button></div>`).join('') : '<p class="muted">暂无共同记忆。普通寒暄不会自动成为共同经历。</p>'}`
}
const JOURNEY_EVIDENCE_LABELS = { MUTUAL_DISCLOSURE: '双向分享', COMMON_GROUND: '共同话题', MUTUAL_INITIATION: '双方主动', CALLBACK: '回访旧话题', SHARED_MOMENT: '共同经历', EMOTIONAL_SUPPORT: '情绪支持', PLAYFUL_INTERACTION: '轻松玩笑', TRUST_SIGNAL: '信任表达', CONTINUITY: '持续交流', INSIDE_JOKE: '共同梗' }
function journeyTime(value) {
  if (value === null || value === undefined || value === '') return null
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}
function journeyDuration(stageSince, now = Date.now()) {
  const timestamp = journeyTime(stageSince), current = journeyTime(now)
  if (timestamp === null || current === null || timestamp > current) return '待确认'
  const hours = Math.floor((current - timestamp) / 3600000)
  return hours >= 24 ? `${Math.floor(hours / 24)} 天` : hours >= 1 ? `${hours} 小时` : '不足 1 小时'
}
function journeyDate(value) {
  const timestamp = journeyTime(value)
  return timestamp === null ? '时间待确认' : new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
function relationshipJourneyView(contact, now = Date.now()) {
  const journey = contact?.relationshipJourney || {}
  const legacyOld = ['oldfriend', 'old_friend'].includes(contact?.profile?.chatMode) || /舍友|老朋友|好友|室友/.test(contact?.profile?.relationship || '')
  const stage = Object.hasOwn(JOURNEY_STAGE_LABELS, journey.currentStage) ? journey.currentStage : legacyOld ? 'FRIEND' : 'STRANGER'
  const stageLabel = value => Object.hasOwn(JOURNEY_STAGE_LABELS, value) ? JOURNEY_STAGE_LABELS[value] : '待确认'
  const evidence = Array.isArray(journey.relationshipEvidence) ? journey.relationshipEvidence.filter(item => item && Object.hasOwn(JOURNEY_EVIDENCE_LABELS, item.type)).slice(-6) : []
  const history = Array.isArray(journey.stageHistory) ? journey.stageHistory.filter(item => item && typeof item === 'object').slice(-3).reverse() : []
  const hasEvaluation = journeyTime(journey.evaluatedAt) !== null && typeof journey.confidence === 'number' && Number.isFinite(journey.confidence) && journey.confidence >= 0 && journey.confidence <= 1
  const suggestion = !hasEvaluation ? '尚未评估' : Object.hasOwn(JOURNEY_STAGE_LABELS, journey.suggestedStage) ? stageLabel(journey.suggestedStage) : '暂无阶段变化建议'
  return `<h3>关系旅程 · ${esc(stageLabel(stage))}</h3><p class="muted">当前关系阶段：${esc(stageLabel(stage))} · 阶段持续时间：${esc(journeyDuration(journey.stageSince, now))}${journeyTime(journey.stageSince) !== null ? `（自 ${esc(journeyDate(journey.stageSince))}）` : ''}</p>
    <p class="muted">AI 建议阶段：${esc(suggestion)}。关系阶段用于理解相处方式，不代表必须升级；起始时间是阶段记录起点，并非认识日期。</p>
    <details><summary class="muted">最近关系变化与主要关系证据</summary>
      <p class="muted">最近关系变化：${history.length ? history.map(item => `${esc(stageLabel(item.fromStage))} → ${esc(stageLabel(item.toStage))} · ${esc(journeyDate(item.timestamp))}${Array.isArray(item.reasons) && item.reasons.length ? ` · ${esc(item.reasons.join('；'))}` : ''}`).join('<br/>') : '暂无阶段变化记录'}</p>
      <p class="muted">主要关系证据：${evidence.length ? evidence.map(item => `${esc(JOURNEY_EVIDENCE_LABELS[item.type])}：${esc(item.summary || '已记录')} · ${esc(journeyDate(item.timestamp))}`).join('<br/>') : '随双方真实交流逐步积累；不会按消息条数升级'}</p>
    </details>`
}
function personaLensView(contact) {
  const lens = contact?.personaLens, relation = contact?.relationshipState
  if (!lens && !relation) return '<h3 style="margin-top:12px">当前 Persona Lens</h3><p class="muted">随真实聊天逐步形成共同方向和表达倾向。</p>'
  const topicLabels = { gaming: '游戏', sports: '运动', fitness: '健身', running: '跑步', travel: '旅行', food: '美食', music: '音乐', pets: '宠物', study: '学习与实验室', work: '工作', movies: '影视', casual_humor: '轻松玩笑' }
  const number = value => Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '暂无'
  return `<h3 style="margin-top:12px">当前 Persona Lens</h3><p class="muted">主要共同方向：${esc((lens?.emphasis || []).map(topic => topicLabels[topic] || topic).join('、') || '逐步了解中')}</p>
    <p class="muted">聊天能量 ${number(lens?.style?.energy)} · 幽默 ${number(lens?.style?.humor)} · 热情 ${number(lens?.style?.warmth)} · 好奇 ${number(lens?.style?.curiosity)}</p>
    <p class="muted">当前适应兴趣：${esc((lens?.adaptiveAffinities || []).map(item => `${topicLabels[item.topic] || item.topic} ${number(item.strength ?? item.level)}${item.realCommonInterest ? '（真实共同兴趣）' : '（兴趣靠拢）'}`).join('、') || '暂无')}。兴趣靠拢不代表已有具体经历。</p>
    <p class="muted">关系状态：熟悉 ${number(relation?.familiarity)} · 温暖 ${number(relation?.warmth)} · 信任 ${number(relation?.trust)} · 玩笑 ${number(relation?.playfulness)}</p>`
}
const PROMISE_TYPE_LABELS = { OPEN_LOOP: '待续话题', AI_FOLLOWUP: 'AI 待回访', HUMAN_ACTION: '待我处理', REAL_WORLD_PLAN: '现实约定' }
const PROMISE_STATUS_LABELS = { pending: '待处理', done: '已完成', cancelled: '已取消' }
function promiseItems(contact) {
  const key = String(contact?.id || contact?.name || ''), store = contact?.promises
  if (!key || !store || store.contactId !== key || !Array.isArray(store.items)) return []
  return store.items.filter(item => item && item.contactId === key && item.sourceContactId === key && typeof item.id === 'string'
    && Object.hasOwn(PROMISE_STATUS_LABELS, item.status) && typeof item.summary === 'string' && item.summary)
}
function promiseCard(contact, item) {
  const key = String(contact?.id || contact?.name || ''), args = esc(JSON.stringify({ accountId: S.accounts.active, contactId: key, promiseId: item.id }))
  const pending = item.status === 'pending'
  const resolution = item.status === 'done' && item.resolution ? `<br/>结果：${esc(item.resolution.text)} · ${esc(journeyDate(item.resolvedAt))}` : ''
  const written = item.status === 'done' && Array.isArray(item.resolution?.fields) && item.resolution.fields.length
    ? `<br/>已写入记忆：${item.resolution.fields.map(field => `${esc(field.label)}：${esc(field.value)}`).join(' · ')}` : ''
  const cancelled = item.status === 'cancelled' ? `<br/>取消：${esc(journeyDate(item.cancelledAt))}` : ''
  return `<div class="card promise-card">
    <div class="card-head"><strong>${esc(contact?.name || '联系人')}</strong><span class="pill">${esc(PROMISE_TYPE_LABELS[item.type] || item.type)}</span>${item.dueHint ? `<span class="pill warn">${esc(item.dueHint)}</span>` : ''}</div>
    <p style="overflow-wrap:anywhere">${esc(item.summary)}</p>
    <p class="muted">记录：${esc(journeyDate(item.createdAt))}${resolution}${written}${cancelled}${Array.isArray(item.sourceMessageIds) && item.sourceMessageIds.length ? `<br/>来源消息：${esc(item.sourceMessageIds.join('、'))}` : ''}</p>
    ${pending ? `<div class="row" style="margin-top:8px">
      <button class="btn small primary" data-act="promise-resolve" data-args='${args}'>完成</button>
      <button class="btn small" data-act="promise-reschedule" data-args='${args}'>改时间</button>
      <button class="btn small danger" data-act="promise-cancel" data-args='${args}'>取消</button>
    </div>` : ''}
  </div>`
}
function promisesBoard() {
  const columns = [
    { title: '待我处理', match: item => item.status === 'pending' && ['HUMAN_ACTION', 'REAL_WORLD_PLAN'].includes(item.type) },
    { title: 'AI 待回访', match: item => item.status === 'pending' && ['AI_FOLLOWUP', 'OPEN_LOOP'].includes(item.type) },
    { title: '已完成', match: item => item.status === 'done' },
    { title: '已取消', match: item => item.status === 'cancelled' },
  ]
  const all = (S.data.contacts || []).flatMap(contact => promiseItems(contact).map(item => ({ contact, item })))
  return `<div class="promise-board">${columns.map(column => {
    const rows = all.filter(({ item }) => column.match(item)).sort((a, b) => Date.parse(b.item.updatedAt || 0) - Date.parse(a.item.updatedAt || 0))
    return `<div class="promise-col"><div class="promise-col-head"><strong>${column.title}</strong><span class="pill">${rows.length}</span></div>
      ${rows.length ? rows.map(({ contact, item }) => promiseCard(contact, item)).join('') : '<p class="muted">暂无</p>'}</div>`
  }).join('')}</div>`
}
function promisesView() {
  return `<div class="panel">
    <div class="row"><h3 style="margin:0">承诺中心</h3><span class="spacer"></span><span class="muted">汇总 AI 在聊天里答应过的事，以及需要你去处理的事；完成时填写真实结果。</span></div>
    <p class="muted" style="margin-top:8px">每个联系人的承诺彼此独立，不会互相串用；只有你确认完成并填写结果后，才会作为这段关系的记忆保存。</p>
  </div>
  <div id="promises-board">${promisesBoard()}</div>`
}
function settingsView() {
  const st = S.data.settings
  const accounts = S.accounts.accounts || []
  return `
    ${selfProfileView()}
    <div class="panel" id="conversation-sync-overview">${conversationSyncOverview()}</div>
    <div class="panel">
      <h3>通用</h3>
      <div class="grid3">
        <div class="field"><label>主题</label><select data-path="appearance.theme">
          ${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, t]) => `<option value="${v}" ${(S.data.appearance.theme || 'auto') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field"><label>默认语气</label><input data-path="appearance.defaultTone" value="${esc(S.data.appearance.defaultTone || '')}" placeholder="留空自动跟随语境" /></div>
        <div class="field"><label>开机自启</label><select data-path="settings.launchOnStartup">
          <option value="off" ${!st.launchOnStartup ? 'selected' : ''}>关闭</option><option value="on" ${st.launchOnStartup ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>静默启动</label><select data-path="settings.startMinimized">
          <option value="off" ${!st.startMinimized ? 'selected' : ''}>关闭（正常弹出主窗口）</option><option value="on" ${st.startMinimized ? 'selected' : ''}>开启（静默最小化到托盘）</option>
        </select></div>
        <div class="field"><label>关闭窗口时</label><select data-path="settings.minimizeToTray">
          <option value="on" ${st.minimizeToTray !== false ? 'selected' : ''}>最小化到托盘</option><option value="off" ${st.minimizeToTray === false ? 'selected' : ''}>退出程序</option>
        </select></div>
      </div>
    </div>
    <div class="panel">
      <h3>回复行为</h3>
      <div class="grid3">
        <div class="field"><label>每日总上限</label><input data-path="automation.dailyLimit" value="${esc(S.data.automation.dailyLimit ?? 30)}" /></div>
        <div class="field"><label>单联系人限额</label><select data-path="automation.maxPerContactDailyEnabled"><option value="off" ${S.data.automation.maxPerContactDailyEnabled !== true ? 'selected' : ''}>关闭（不限制）</option><option value="on" ${S.data.automation.maxPerContactDailyEnabled === true ? 'selected' : ''}>开启（使用手动上限）</option></select></div>
        <div class="field"><label>单联系人每日上限（条）</label><input type="number" min="1" step="1" data-path="automation.maxPerContactDaily" value="${esc(S.data.automation.maxPerContactDaily ?? 10)}" ${S.data.automation.maxPerContactDailyEnabled !== true ? 'disabled' : ''} /></div>
        <div class="field"><label>第二条消息（连发）</label><select data-path="settings.twoMessageChance">
          <option value="0" ${Number(st.twoMessageChance) === 0 ? 'selected' : ''}>关闭</option>
          <option value="0.35" ${Math.abs(Number(st.twoMessageChance ?? 0.35) - 0.35) < 0.01 ? 'selected' : ''}>偶尔（35%）</option>
          <option value="0.6" ${Math.abs(Number(st.twoMessageChance) - 0.6) < 0.01 ? 'selected' : ''}>经常（60%）</option>
        </select></div>
        <div class="field"><label>轮询间隔（秒，空闲自动降频）</label><input data-path="settings.refreshInterval" value="${esc(st.refreshInterval || '5')}" /></div>
        <div class="field"><label>等待对方说完</label><select data-path="settings.incomingBurstEnabled"><option value="on" ${st.incomingBurstEnabled !== false ? 'selected' : ''}>开启</option><option value="off" ${st.incomingBurstEnabled === false ? 'selected' : ''}>关闭</option></select></div>
        <div class="field"><label>固定收藏表情</label><select data-path="settings.favoriteStickerEnabled"><option value="on" ${st.favoriteStickerEnabled === true ? 'selected' : ''}>开启</option><option value="off" ${st.favoriteStickerEnabled !== true ? 'selected' : ''}>关闭（只回复文字）</option></select></div>
        <div class="field"><label>停顿等待（秒）</label><input type="number" min="1" max="15" step="0.1" data-path="settings.incomingBurstQuietWindowMs" value="${esc((st.incomingBurstQuietWindowMs ?? 4000) / 1000)}" /></div>
        <div class="field"><label>最长聚合（秒）</label><input type="number" min="1" max="60" step="0.1" data-path="settings.incomingBurstMaxWindowMs" value="${esc((st.incomingBurstMaxWindowMs ?? 15000) / 1000)}" /></div>
        <div class="field"><label>AI 回复先拟草稿</label><select data-path="settings.aiReplyDraftOnly">
          <option value="off" ${!st.aiReplyDraftOnly ? 'selected' : ''}>关闭（自动发送）</option><option value="on" ${st.aiReplyDraftOnly ? 'selected' : ''}>开启（去草稿页确认）</option>
        </select></div>
        <div class="field"><label>消息标注 AI 模型</label><select data-path="settings.showAiModelLabel">
          <option value="on" ${st.showAiModelLabel !== false ? 'selected' : ''}>显示【AI·模型】前缀</option><option value="off" ${st.showAiModelLabel === false ? 'selected' : ''}>不显示</option>
        </select></div>
        <div class="field"><label>免打扰时段</label><select data-path="settings.quietHours">
          <option value="off" ${!st.quietHours ? 'selected' : ''}>关闭</option><option value="on" ${st.quietHours ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>免打扰开始</label><input data-path="settings.quietStart" value="${esc(st.quietStart || '23:00')}" /></div>
        <div class="field"><label>免打扰结束</label><input data-path="settings.quietEnd" value="${esc(st.quietEnd || '07:00')}" /></div>
      </div>
      <p class="muted">等待对方说完：每条新消息都会重新计时，默认停顿 4 秒后一起处理，最长聚合 15 秒。实际采集受轮询间隔影响，可能有延迟；AI 生成时又收到新消息，会暂缓旧回复并合并处理。</p>
      <p class="muted">固定收藏表情顺序：1 调侃、2 点赞、3 开心、4 害羞、5 难过、6 惊讶、7 无语、8 安慰、9 生气、10 晚安。请保持前 10 个收藏的顺序；草稿会预览表情，收藏不足 10 个时停止发送。</p>
    </div>
    <div class="panel">
      <h3>媒体识别（对方发视频/图片时）</h3>
      <div class="grid3">
        <div class="field"><label>视频回复</label><select data-path="settings.videoReplyEnabled">
          <option value="on" ${st.videoReplyEnabled !== false ? 'selected' : ''}>开启</option><option value="off" ${st.videoReplyEnabled === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>天气城市（续火花今日播报，留空自动定位）</label>
          <div class="row" style="gap:6px">
            <input data-path="settings.weatherCity" id="setting-weather-city" value="${esc(st.weatherCity || '')}" placeholder="如：银川" style="flex:1" />
            <button class="btn small" data-act="test-weather">测试天气</button>
          </div>
          ${S.weatherPreview ? `<div class="muted" style="margin-top:4px;font-size:12px;color:var(--text-dim)">${esc(S.weatherPreview)}</div>` : ''}
        </div>
        <div class="field"><label>识别模式</label><select data-path="settings.videoRecognitionMode">
          <option value="smart" ${st.videoRecognitionMode !== 'comments' && st.videoRecognitionMode !== 'lite' ? 'selected' : ''}>智能（先理解再回复）</option>
          <option value="comments" ${st.videoRecognitionMode === 'comments' ? 'selected' : ''}>轻量（仅文案与评论）</option>
          <option value="lite" ${st.videoRecognitionMode === 'lite' ? 'selected' : ''}>极简（仅文字）</option>
        </select></div>
      </div>
      <div class="muted" style="margin-top:8px">智能模式会截取关键帧 + 转写音频 + 读取公开页文案，理解结果会作为后续对话的上下文背景保留（视频上下文）。</div>
    </div>
    <div class="panel">
      <h3>学习与记忆</h3>
      <div class="grid3">
        <div class="field"><label>长期记忆</label><select data-path="settings.longTermMemory">
          <option value="on" ${st.longTermMemory !== false ? 'selected' : ''}>开启（自动提炼对方信息）</option><option value="off" ${st.longTermMemory === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>自动学习新联系人</label><select data-path="settings.autoLearnContacts">
          <option value="on" ${st.autoLearnContacts !== false ? 'selected' : ''}>开启</option><option value="off" ${st.autoLearnContacts === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>运行记录保留（天）</label><input data-path="settings.logRetention" value="${esc(st.logRetention || '30')}" /></div>
        <div class="field"><label>写入运行记录</label><select data-path="settings.saveLogs">
          <option value="on" ${st.saveLogs !== false ? 'selected' : ''}>开启</option><option value="off" ${st.saveLogs === false ? 'selected' : ''}>关闭</option>
        </select></div>
      </div>
    </div>
    <div class="panel">
      <h3>通知</h3>
      <div class="grid3">
        <div class="field"><label>桌面通知</label><select data-path="settings.desktopNotifications">
          <option value="on" ${st.desktopNotifications !== false ? 'selected' : ''}>开启</option><option value="off" ${st.desktopNotifications === false ? 'selected' : ''}>关闭</option>
        </select></div>
        <div class="field"><label>提示音</label><select data-path="settings.soundNotifications">
          <option value="off" ${!st.soundNotifications ? 'selected' : ''}>关闭</option><option value="on" ${st.soundNotifications ? 'selected' : ''}>开启</option>
        </select></div>
        <div class="field"><label>失败时通知</label><select data-path="settings.notifyOnFailure">
          <option value="on" ${st.notifyOnFailure !== false ? 'selected' : ''}>开启</option><option value="off" ${st.notifyOnFailure === false ? 'selected' : ''}>关闭</option>
        </select></div>
      </div>
    </div>
    <div class="panel">
      <h3>账号管理</h3>
      <div class="row" style="margin-bottom:10px">
        <button class="btn" data-act="account-add">添加账号</button>
      </div>
      ${accounts.map((a) => `
        <div class="card">
          <div class="card-head">
            <strong>${esc(a.name)}</strong>
            <span class="pill">${a.contacts || 0} 位联系人</span>
            ${S.accounts.active === a.id ? '<span class="pill ok">当前</span>' : ''}
            <span class="spacer"></span>
            ${S.accounts.active !== a.id ? `<button class="btn small" data-act="account-switch" data-args='${esc(JSON.stringify({ id: a.id }))}'>切换</button>` : ''}
            <button class="btn small" data-act="account-rename" data-args='${esc(JSON.stringify({ id: a.id, name: a.name }))}'>重命名</button>
            <button class="btn small" data-act="account-logout" data-args='${esc(JSON.stringify({ id: a.id }))}'>退出登录</button>
            <button class="btn small danger" data-act="account-wipe" data-args='${esc(JSON.stringify({ id: a.id }))}'>删除账号</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="panel">
      <h3>关于</h3>
      <div class="muted">
        全自动找对象流水线 v${esc(S.info?.version || '')} · Electron ${esc(S.info?.version || '')}<br/>
        配置和聊天记忆保存在本机；生成回复时，相关对话和媒体会发送到你配置的模型接口。<br/>
        <button class="btn small" data-act="check-update" style="margin-top:8px">检查更新</button>
      </div>
    </div>`
}

// ---- 状态保存 ----
async function saveState(patch, silent = false) {
  const accountId = S.accounts.active, epoch = S.accountEpoch || 0
  try {
    const result = await api.automation.update(patch)
    if (S.accounts.active !== accountId || (S.accountEpoch || 0) !== epoch) return
    S.data = result.state
    if (!silent) showNotice('已保存')
    applyTheme()
    queueDynamic()
  } catch (error) {
    if (S.accounts.active !== accountId || (S.accountEpoch || 0) !== epoch) return
    showNotice(`保存失败：${error.message}`, 'err')
  }
}

// 事件草稿只由后台原子更新，避免覆盖新草稿、发送状态或已改期事件。
async function eventOperation(btn, operation, successMessage) {
  const account = S.accounts.active
  await run(btn, async () => {
    let result, operationError
    try { result = await operation(account) } catch (error) { operationError = error }
    if (S.accounts.active !== account) return
    const state = await api.automation.getState()
    if (S.accounts.active !== account) return
    S.data = state
    if (S.section === 'chat') document.querySelector('#conversation-drafts')?.contains(document.activeElement) && document.activeElement?.blur()
    refreshDynamic()
    if (operationError) throw operationError
    if (!result?.ok) throw new Error(result?.error || '事件跟进操作失败')
    if (successMessage) showNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage)
  })
}

// ---- 动作分发（单一委托点，杜绝按钮失联）----
function readBatchConfig() {
  const val = id => document.getElementById(id)?.value ?? ''
  const split = s => String(s || '').split(/[,，、;；\r\n\t|｜/\\]+/).map(x => x.trim()).filter(Boolean)
  return {
    target: Number(val('batch-target')) || 20,
    maxProfileChecks: Number(val('batch-profile-limit')) || undefined,
    minVideoComments: val('batch-min-video-comments') === '' ? 20 : Number(val('batch-min-video-comments')),
    sampling: { first: Number(val('batch-round-first')) || 30, second: Number(val('batch-round-second')) || 40, later: Number(val('batch-round-later')) || 50, continueMinIntent: val('batch-continue-intent') || 'CONTEXTUAL_INTEREST' },
    sources: {
      keywords: split(val('batch-keywords')),
      tags: split(val('batch-tags')).map(t => t.replace(/^#+/, '')),
      combinedSearch: document.getElementById('batch-combined-search')?.checked !== false,
      favorites: document.getElementById('batch-favorites')?.checked === true,
    },
    budgets: {
      maxVideos: Number(val('batch-max-videos')) || 30,
      maxComments: Number(val('batch-max-comments')) || 400,
      maxMinutes: Number(val('batch-max-minutes')) || 30,
      maxAiCalls: val('batch-max-ai') === '' ? 30 : Number(val('batch-max-ai')),
    },
    filters: {
      minIntent: val('batch-min-intent') || 'CONTEXTUAL_INTEREST',
      gender: val('batch-gender') || 'any',
      requireAgeRange: val('batch-age-required') === 'on',
      ageMin: Number(val('batch-age-min')) || 18,
      ageMax: Number(val('batch-age-max')) || 45,
      requireIp: val('batch-ip-required') === 'on',
      ipValues: split(val('batch-ip-values')),
      requireFollowerLimit: val('batch-followers-required') === 'on',
      followerLimit: Number(val('batch-followers')) || 1000,
      requireReplyLimit: val('batch-replies-required') === 'on',
      replyLimit: val('batch-replies') === '' ? 5 : Number(val('batch-replies')),
    },
  }
}
function updateSourceWait() {
  for (const el of document.querySelectorAll('[data-source-wait-start]')) {
    const started = Date.parse(el.dataset.sourceWaitStart)
    if (Number.isFinite(started) && batchState().data?.status === 'running') el.textContent = String(Math.max(0, Math.floor((Date.now() - started) / 1000)))
  }
}
let batchRefreshTimer
function queueBatchRefresh() {
  if (batchRefreshTimer) return
  batchRefreshTimer = setTimeout(() => {
    batchRefreshTimer = null
    if (S.section === 'discovery') loadBatch()
  }, 300)
}
function batchPoll() {
  const active = S.section === 'discovery' && batchState().data?.status === 'running'
  if (!active && window.__batchTimer) {
    clearInterval(window.__batchTimer)
    window.__batchTimer = null
  }
  if (active && !window.__batchTimer) window.__batchTimer = setInterval(loadBatch, 4000)
}
async function batchControl(method, notice) {
  const st = batchState(), local = S.discovery, account = S.accounts.active
  if (st.busy) return
  st.busy = true; st.revision = (st.revision || 0) + 1; patchBatch(true)
  try {
    const r = await api.discovery[method]()
    if (S.accounts.active !== account || S.discovery !== local) return
    if (!r?.ok) throw new Error(r?.error || '批次操作失败')
    st.revision++; st.data = r.batch
    showNotice(notice)
  } catch (error) { if (S.discovery === local) showNotice(error.message || String(error), 'err') }
  finally {
    st.busy = false
    if (S.discovery === local && S.accounts.active === account) { patchBatch(true); batchPoll(); queueBatchRefresh() }
  }
}
const BATCH_ACTIONS = {
  async 'batch-start'(args, btn) {
    const st = batchState(), local = S.discovery, account = S.accounts.active
    if (st.busy || st.parsing) return
    const config = readBatchConfig()
    if (!config.sources.keywords.length && !config.sources.tags.length && !config.sources.favorites) return showNotice('请至少填写一个关键词、一个标签，或勾选收藏夹', 'err')
    st.busy = true; st.revision = (st.revision || 0) + 1
    if (btn) btn.disabled = true
    try {
      if (api.discovery.goal && !S.discovery.goals && !await goalRequest('view')) return
      if (S.discovery !== local || S.accounts.active !== account) return
      const target = goalRef()
      const r = await api.discovery.batchStart(target ? { ...config, goal: target, accountId: account } : config)
      if (S.discovery !== local || S.accounts.active !== account) return
      st.revision++
      if (!r.ok) throw new Error(r.error || '启动批次失败')
      st.data = r.batch; delete st.formConfig
      showNotice('批次已启动，可随时暂停或停止', 'ok')
      await loadBatch(); patchBatch(true); batchPoll()
    } catch (error) { showNotice(error.message || String(error), 'err') }
    finally { st.busy = false; if (S.discovery === local && S.accounts.active === account && S.section === 'discovery') { patchBatch(true); queueBatchRefresh() } }
  },
  async 'batch-pause'() { await batchControl('batchPause', '已暂停，已入批的候选保留') },
  async 'batch-resume'() { await batchControl('batchResume', '已继续，从队列剩余部分恢复') },
  async 'batch-stop'() { await batchControl('batchStop', '已停止，已收集的评论和候选保留') },
  async 'batch-clear'() {
    try { const r = await api.discovery.batchClear(); if (!r.ok) throw new Error(r.error || '清空失败'); showNotice(`已清空本批 ${r.cleared || 0} 人，去重记录已保留`, 'ok'); await loadBatch(); patchBatch(true); if (typeof refreshDiscovery === 'function') refreshDiscovery() }
    catch (error) { showNotice(error.message || String(error), 'err') }
  },
  async 'batch-draft'({ id }, btn) {
    const st = batchState(), batchId = st.data?.id, accountId = S.accounts.active
    const before = document.getElementById(`batch-text-${id}`)?.value
    const isCurrent = () => S.accounts.active === accountId && batchState() === st && st.data?.id === batchId
    if (btn) btn.disabled = true
    try {
      const r = await api.discovery.batchDraft({ id, batchId })
      if (!isCurrent()) return
      if (!r.ok) throw new Error(r.error || '生成失败')
      const field = document.getElementById(`batch-text-${id}`)
      if (!field || field.value === before) {
        if (field) field.value = r.text
        st.texts[batchTextKey(id, st)] = r.text
        showNotice('首句已重新生成', 'ok')
      } else {
        showNotice('新草稿已保存，保留你正在编辑的首句', 'ok')
      }
      patchBatch()
    } catch (error) { if (isCurrent()) showNotice(error.message || String(error), 'err') }
    finally { if (btn) btn.disabled = false }
  },
  async 'batch-contact'({ id }, btn) {
    const el = document.getElementById(`batch-text-${id}`)
    const text = (el?.value ?? batchState().texts[batchTextKey(id)] ?? '').trim()
    if (!text) return showNotice('请先填写或生成第一句', 'err')
    const card = batchState().cards.find(c => c.id === id) || {}
    if (card.realContact?.needsReview) return showNotice('请先核对上一次首次联系结果', 'err')
    if (card.realContact?.messageStatus === 'sent') return showNotice('第一句已发送', 'err')
    if (!window.confirm(`现在真实关注并发送第一句？\n\n对象：${card.nickname || '（无昵称）'}\n内容：${text}\n\n· 会真实打开对方主页、点关注、再打开私信发送这句话\n· 你点了这一步就是最终判断，程序不再做任何条件审核，直接执行\n· 关注申请与私信权限分别检查，仅在页面允许时发送首句\n· 这一步不可撤回，发出去的话对方能看到`)) return
    batchState().texts[batchTextKey(id)] = text
    if (btn) btn.disabled = true
    try {
      const r = await api.discovery.batchContact({ id, text, confirmed: true })
      const c = r.contact || {}
      // 三态分开报：关注成功不等于私信成功，结果待核实必须明确要求人工核对。
      const note = c.needsReview ? '⏸ 结果待核实，已暂停自动重发，请人工核对'
        : c.outcome === 'FOLLOW_OK_DM_FAILED' ? '✅ 关注成功，但第一句未发出'
          : c.outcome === 'FOLLOW_PENDING' ? '⏳ 已发送关注申请，等待对方通过后才能私信'
            : (c.note || '已关注并发送第一句')
      if (!r.ok) throw new Error(c.reason || r.error || note)
      showNotice(`${note}：${c.name || card.nickname || ''}`, c.needsReview ? 'err' : 'ok')
      await loadBatch(); patchBatch(true)
    } catch (error) { showNotice(error.message || String(error), 'err'); await loadBatch(); patchBatch(true) }
    finally { if (btn) btn.disabled = false }
  },
  async 'batch-contact-review'({ id, conclusion }, btn) {
    const account = S.accounts.active
    if (btn) btn.disabled = true
    try {
      const r = await api.discovery.batchContactReview({ id, conclusion })
      if (S.accounts.active !== account) return
      if (!r.ok) throw new Error(r.error || '解除失败')
      showNotice(`${r.conclusion || '已人工核对'}，自动重发暂停已解除`, 'ok')
      await loadBatch(); patchBatch(true)
      if (S.accounts.active === account && discoveryWorkspaceTab() === 'candidates') await DISCOVERY_WORKSPACE_ACTIONS['workspace-history-refresh']()
    } catch (error) { showNotice(error.message || String(error), 'err') }
    finally { if (btn) btn.disabled = false }
  },
  async 'batch-send-mock'({ id }, btn) {
    const el = document.getElementById(`batch-text-${id}`)
    const text = (el?.value ?? batchState().texts[batchTextKey(id)] ?? '').trim()
    if (!text) return showNotice('请先填写或生成第一句', 'err')
    batchState().texts[batchTextKey(id)] = text
    if (btn) btn.disabled = true
    try {
      const r = await api.discovery.batchSendMock({ id, text })
      if (!r.ok) throw new Error(r.error || 'Dry Run 失败')
      showNotice(`Dry Run 完成：已绑定账号 ${r.mock.accountId} 与候选 ${r.mock.name}，真实动作 ${r.mock.realActions} 次`, 'ok')
      await loadBatch(); patchBatch(true)
    } catch (error) { showNotice(error.message || String(error), 'err') }
    finally { if (btn) btn.disabled = false }
  },
  async 'batch-not-interested'({ id }) {
    try {
      const r = await api.discovery.batchNotInterested({ id })
      if (!r.ok) throw new Error(r.error || '操作失败')
      const st = batchState(); st.cards = st.cards.filter(c => c.id !== id)
      // 主进程同时把它记为审核排除；这里同步候选池本地数据，避免本批卡片消失后池子里还留着。
      if (r.candidate && Array.isArray(S.data?.discovery?.candidates)) {
        const index = S.data.discovery.candidates.findIndex(item => item.id === id)
        if (index >= 0) S.data.discovery.candidates[index] = r.candidate
        if (S.discovery.selected === id) S.discovery.selected = null
      }
      showNotice('已移出本批，并记录为不感兴趣（下批不再推荐）', 'ok')
      patchBatch()
      if (S.section === 'discovery') refreshDiscovery()
    } catch (error) { showNotice(error.message || String(error), 'err') }
  },
  // 点击卡片才读回复：默认收起只显示回复总数；展开后按页继续加载，失败可重试。
  async 'batch-replies'({ id, force = false }) {
    const st = batchState()
    const cur = st.replies[id]
    if (cur && !cur.loading && !force) { delete st.replies[id]; return patchBatch() }
    st.replies[id] = { loading: true, replies: [], cursor: 0 }
    patchBatch()
    try {
      const r = await api.discovery.batchReplies({ id, cursor: 0, force })
      const replies = r.replies || []
      st.replies[id] = {
        loading: false, replies, cursor: replies.length,
        note: r.note || r.error || '', state: r.state || (r.ok ? 'complete' : 'failed'),
        total: r.total ?? null, loaded: replies.length, partial: r.partial === true,
        cached: r.cached === true, retryable: r.retryable,
      }
    } catch (error) {
      st.replies[id] = { loading: false, replies: [], state: 'failed', note: error.message || '读取失败', retryable: true }
    }
    patchBatch()
  },
  async 'batch-replies-more'({ id }) {
    const st = batchState(), cur = st.replies[id]
    if (!cur || cur.loading) return
    const existing = cur.replies || []
    st.replies[id] = { ...cur, loading: true }
    patchBatch()
    try {
      const r = await api.discovery.batchReplies({ id, cursor: cur.cursor || existing.length })
      const replies = [...existing, ...(r.replies || [])]
      st.replies[id] = { ...cur, loading: false, replies, cursor: replies.length, loaded: replies.length,
        partial: r.partial === true, total: r.total ?? cur.total, state: r.state || cur.state,
        note: r.note || r.error || '' }
    } catch (error) {
      st.replies[id] = { ...cur, loading: false, state: 'failed', note: error.message || '读取失败' }
    }
    patchBatch()
  },
  'batch-open-video'({ videoId }) {
    showNotice(`来源视频：https://www.douyin.com/video/${videoId}（不自动打开，避免切走当前页面）`, 'ok')
  },
}

const ACTIONS = {
  ...BATCH_ACTIONS,
  ...DISCOVERY_WORKSPACE_ACTIONS,
  async 'conversation-sync-refresh'({ contactId, accountId }, btn) {
    if (accountId !== S.accounts.active || !(S.data?.contacts || []).some(item => item.id === contactId) || !api.douyin?.refreshConversationSync) return
    const local = S.conversationSyncUi
    if (local.busyContactId) return
    local.busyContactId = contactId
    refreshDynamic()
    await run(btn, async () => {
      try {
        let result
        try { result = await api.douyin.refreshConversationSync({ accountId: S.accounts.active, contactId }) }
        catch (error) { if (S.accounts.active !== accountId || local !== S.conversationSyncUi) return; throw error }
        if (S.accounts.active !== accountId || local !== S.conversationSyncUi) return
        if (!result?.ok) throw new Error(result?.error || '会话同步核验失败')
        const root = result.state?.conversationSync
        const account = result.conversationSync || root?.accounts?.find(item => item.accountId === accountId)
        if (!applyConversationSync(account, accountId)) throw new Error('会话同步结果缺少当前账号状态，请刷新后重试')
        refreshDynamic()
        showNotice('会话同步核验已更新，请查看接管状态')
      } finally {
        if (local === S.conversationSyncUi) { local.busyContactId = ''; refreshDynamic() }
      }
    })
  },
  async 'shared-memory-delete'({ accountId, contactId, memoryId }, btn) {
    if (!accountId || S.accounts.active !== accountId) throw new Error('当前账号已变化，请刷新后再删除')
    const contact = (S.data.contacts || []).find(item => String(item.id || item.name || '') === contactId)
    if (!contact || !memoryId) throw new Error('共同记忆所属联系人不存在')
    if (!confirm('确定删除这条共同记忆？删除后不会再用于聊天。')) return
    await run(btn, async () => {
      let state
      try { state = await api.sharedMemory.delete({ accountId, contactId, memoryId }) }
      catch (error) { if (S.accounts.active !== accountId) return; throw error }
      if (S.accounts.active !== accountId) return
      if (!state || !Array.isArray(state.contacts)) throw new Error('删除共同记忆返回的状态无效，请刷新检查')
      S.data = state
      refreshDynamic()
      showNotice('这条共同记忆已删除')
    })
  },
  async 'promise-resolve'({ accountId, contactId, promiseId }, btn) {
    if (!accountId || S.accounts.active !== accountId) throw new Error('当前账号已变化，请刷新后重试')
    const text = await askText('填写这条承诺的实际结果（例如：黑色玫瑰，ID 546124）')
    if (text === null) return
    if (!text.trim()) throw new Error('请填写实际结果')
    let preview
    try { preview = await api.promise.preview({ accountId, contactId, promiseId, text: text.trim() }) }
    catch (error) { if (S.accounts.active !== accountId) return; throw error }
    if (S.accounts.active !== accountId) return
    if (!preview?.ok) throw new Error(preview?.error || '无法生成写入预览，请刷新后重试')
    const contactName = (S.data.contacts || []).find(contact => String(contact.id || contact.name) === contactId)?.name || '联系人'
    const confirmed = await askWriteback({ ...preview, contactName })
    if (!confirmed) return
    await run(btn, async () => {
      let state
      try { state = await api.promise.resolve({ accountId, contactId, promiseId, text: confirmed.text, fields: confirmed.fields, expectedRevision: preview.revision }) }
      catch (error) { if (S.accounts.active !== accountId) return; throw error }
      if (S.accounts.active !== accountId) return
      if (state?.ok === false) throw new Error(state.error || '完成承诺失败，请刷新后重试')
      if (!state || !Array.isArray(state.contacts)) throw new Error('完成承诺返回的状态无效，请刷新检查')
      S.data = state
      refreshDynamic()
      showNotice('已记录这条承诺的结果，并写入该联系人的关系记忆')
    })
  },
  async 'promise-reschedule'({ accountId, contactId, promiseId }, btn) {
    if (!accountId || S.accounts.active !== accountId) throw new Error('当前账号已变化，请刷新后重试')
    const dueHint = await askText('把这条承诺改到什么时候？（可写：明天晚上 / 周末 / 下周）')
    if (dueHint === null) return
    await run(btn, async () => {
      let state
      try { state = await api.promise.reschedule({ accountId, contactId, promiseId, dueHint: dueHint.trim() }) }
      catch (error) { if (S.accounts.active !== accountId) return; throw error }
      if (S.accounts.active !== accountId) return
      if (!state || !Array.isArray(state.contacts)) throw new Error('改时间返回的状态无效，请刷新检查')
      S.data = state
      refreshDynamic()
      showNotice('已更新这条承诺的时间')
    })
  },
  async 'promise-cancel'({ accountId, contactId, promiseId }, btn) {
    if (!accountId || S.accounts.active !== accountId) throw new Error('当前账号已变化，请刷新后重试')
    if (!confirm('确定取消这条承诺？取消后不再提醒，但仍保留原始记录。')) return
    await run(btn, async () => {
      let state
      try { state = await api.promise.cancel({ accountId, contactId, promiseId }) }
      catch (error) { if (S.accounts.active !== accountId) return; throw error }
      if (S.accounts.active !== accountId) return
      if (!state || !Array.isArray(state.contacts)) throw new Error('取消承诺返回的状态无效，请刷新检查')
      S.data = state
      refreshDynamic()
      showNotice('这条承诺已取消')
    })
  },
  async 'opening-requirements-save'(args, btn) {
    const local = S.discovery, accountId = S.accounts.active
    if (local.openingRequirementsSaving) return
    const requirements = String(document.getElementById('opening-requirements')?.value ?? local.openingRequirementsDraft ?? S.data.settings?.openingRequirements ?? '')
    if (requirements.length > 2000) return showNotice('首句要求请控制在2000字以内', 'err')
    const mode = local.openingModeDraft ?? S.data.settings?.openingMode ?? 'ai'
    const fixedText = String(document.getElementById('fixed-opening-text')?.value ?? local.fixedOpeningDraft ?? S.data.settings?.fixedOpeningText ?? '')
    if (fixedText.length > 80 || mode === 'fixed' && !fixedText.trim()) return showNotice('固定首句请填写1～80字', 'err')
    local.openingRequirementsSaving = true
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    try {
      const result = await api.friendship.saveOpeningRequirements({ accountId, requirements, mode, fixedText })
      if (S.accounts.active !== accountId || S.discovery !== local) return
      if (!result?.ok) throw new Error(result?.error || '保存失败')
      S.data.settings ||= {}; S.data.settings.openingRequirements = result.requirements
      S.data.settings.openingMode = result.mode; S.data.settings.fixedOpeningText = result.fixedText
      if (document.getElementById('opening-requirements') && document.getElementById('opening-requirements').value === requirements) {
        local.openingRequirementsDraft = result.requirements
        document.getElementById('opening-requirements').value = result.requirements
      }
      showNotice('首句要求已保存；已有草稿可点“重新生成首句”更新')
    } catch (error) { if (S.accounts.active === accountId && S.discovery === local) showNotice(error.message || String(error), 'err') }
    finally { local.openingRequirementsSaving = false; if (btn) { btn.disabled = false; btn.textContent = '保存首句设置' } }
  },
  async 'self-introduction-save'(args, btn) {
    const local = selfProfileUi()
    const field = document.getElementById('self-introduction')
    const text = (field?.value || '').trim()
    if (!text || text.length > 30000) return showNotice('请填写 1～30000 字的介绍', 'err')
    local.introduction = text
    const result = await selfProfileOperation('saveIntroduction', { text }, btn, '介绍已保存并整理为本人资料')
    if (result && S.section === 'discovery') await loadBatch()
  },
  async 'self-profile-extract'(args, btn) {
    await selfProfileOperation('extract', () => {
      const text = selfProfileUi().raw.trim()
      if (!text) throw new Error('请先输入关于你的介绍')
      if (text.length > 30000) throw new Error('介绍请控制在30000字以内')
      return { text }
    }, btn, '提取完成，请审核后确认；尚未写入正式资料')
  },
  async 'self-profile-confirm'(args, btn) {
    await selfProfileOperation('confirm', () => {
      const pending = S.data.selfProfile?.pending, local = selfProfileUi()
      if (!pending?.id) throw new Error('暂无待审核资料')
      const rows = {}
      for (const section of Object.keys(SELF_SECTIONS)) rows[section] = (pending[section] || []).map(item => selfProfileEditedItem(item, section, local.review[selfEditKey(section, item.id)]))
      if (!Object.values(rows).some(items => items.some(item => item.keep !== false))) throw new Error('没有保留的资料，请使用“丢弃本次提取”')
      return { pendingId: pending.id, ...rows }
    }, btn, '已确认并保存本人资料，后续聊天会使用最新资料')
  },
  async 'self-profile-discard'(args, btn) {
    await selfProfileOperation('discard', () => {
      const pendingId = S.data.selfProfile?.pending?.id
      if (!pendingId) throw new Error('暂无待审核资料')
      return { pendingId }
    }, btn, '已丢弃待审核内容，已保存资料保持不变')
  },
  async 'self-profile-save'({ section, id }, btn) {
    await selfProfileOperation('update', () => {
      if (!SELF_SECTIONS[section]) throw new Error('资料分区无效')
      const item = S.data.selfProfile?.[section]?.find(row => row.id === id)
      if (!item) throw new Error('这条资料已变化，请刷新')
      const edit = selfProfileUi().editing[selfEditKey(section, id)] || {}
      return { section, item: selfProfileEditedItem(item, section, edit), ...(Number.isInteger(edit.baseRevision) ? { revision: edit.baseRevision } : {}) }
    }, btn, '这条本人资料已更新', local => { delete local.editing[selfEditKey(section, id)] })
  },
  async 'self-profile-delete'({ section, id }, btn) {
    if (!SELF_SECTIONS[section] || !S.data.selfProfile?.[section]?.some(row => row.id === id)) { showNotice('这条资料已变化，请刷新', 'err'); return }
    if (!confirm('删除这条已保存的本人资料？')) return
    await selfProfileOperation('update', { section, removeId: id }, btn, '这条本人资料已删除', local => { delete local.editing[selfEditKey(section, id)] })
  },
  async 'self-profile-add'(args, btn) {
    await selfProfileOperation('update', () => {
      const edit = selfProfileUi().add, section = edit.section || 'stableProfile', key = String(edit.key || '').trim()
      if (!key || key.length > 80 || !SELF_SECTIONS[section]) throw new Error('请填写资料类别标识并选择有效分区')
      if (S.data.selfProfile?.[section]?.some(item => item.key === key)) throw new Error('该键名已有资料，请在已保存条目中修改')
      const item = selfProfileEditedItem({ key, label: edit.label || key, shareLevel: edit.shareLevel || 'NORMAL', source: 'user_edit', sourceText: String(edit.valueText || '') }, section, edit)
      return { section, item, ...(Number.isInteger(edit.baseRevision) ? { revision: edit.baseRevision } : {}) }
    }, btn, '已保存这条真实资料', local => { local.add = {} })
  },
  async 'self-profile-refresh'(args, btn) {
    await selfProfileOperation('get', {}, btn, '本人信息库已刷新', local => { local.editing = {}; local.add = {} })
  },
  async 'self-profile-initialize'(args, btn) {
    await selfProfileOperation('initialize', () => {
      const profile = S.data.selfProfile || {}
      if (profile.revision || profile.pending || Object.keys(SELF_SECTIONS).some(section => profile[section]?.length)) throw new Error('本人信息库已有资料，不会覆盖初始化')
      return {}
    }, btn, '已保存本轮明确提供的基础资料，可逐条修改')
  },
  async 'contact-save'(args, btn) {
    const local = S.contact
    await contactOperation(btn, async accountId => {
      const config = readContactConfig(), result = await api.contact.update({ accountId, config })
      if (result.ok && S.contact === local && S.accounts.active === accountId) local.drafts = {}
      return result
    }, '联系设置已保存；空模板不会发送首句')
  },
  async 'contact-run'(args, btn) {
    if (contactConfig().enabled !== true) { showNotice('请先开启并保存联系引擎开关', 'err'); return }
    await contactOperation(btn, accountId => api.contact.run({ accountId }), result => result.skipped ? `本次未执行联系：${result.reason || result.contactState?.blockedReason || result.contactState?.reason || '没有可执行任务'}` : '联系队列检查完成，请查看实际状态与记录')
  },
  async 'contact-global-pause'(args, btn) {
    await contactOperation(btn, accountId => api.contact.pause({ accountId }), '全队列已暂停；已提交操作仍需核对实际结果')
  },
  async 'contact-global-resume'(args, btn) {
    await contactOperation(btn, accountId => api.contact.resume({ accountId }), '全队列已恢复；未确认操作不会自动重发')
  },
  async 'contact-refresh'(args, btn) {
    await contactOperation(btn, accountId => api.contact.refresh({ accountId }), '回复与权限状态已刷新')
  },
  async 'contact-enqueue'({ id }, btn) {
    const local = S.contact, discovery = S.discovery
    await contactOperation(btn, async accountId => {
      const candidate = discoveryCandidates().find(item => item.id === id)
      if (!candidate) throw new Error('候选人不存在')
      if (discovery.busy) throw new Error('请等待候选审核操作完成')
      const note = discovery.notes[id] ?? candidate.review?.note ?? '', extra = discoveryReviewEvidence(id)
      const approved = await api.discovery.review({ accountId, id, status: 'APPROVED', note, ...extra })
      if (S.accounts.active !== accountId || S.contact !== local || S.discovery !== discovery) return { ok: false, error: '当前账号已切换，本次未加入联系队列' }
      if (!approved.ok) return approved
      if (approved.discovery) S.data.discovery = approved.discovery
      return api.contact.enqueue({ accountId, id })
    }, '已批准并加入联系队列；只有开关开启、模板已填且发送规则允许时才执行')
  },
  async 'contact-pause'({ id }, btn) {
    if (!contactCanPause(discoveryCandidates().find(item => item.id === id) || {})) return
    await contactOperation(btn, accountId => api.contact.pause({ accountId, id }), '联系任务已暂停')
  },
  async 'contact-resume'({ id }, btn) {
    if (!contactCanResume(discoveryCandidates().find(item => item.id === id) || {})) return
    await contactOperation(btn, accountId => api.contact.resume({ accountId, id }), '联系任务已恢复；未确认操作仍需人工核对')
  },
  async 'contact-retry'({ id }, btn) {
    if (!contactCanRetry(discoveryCandidates().find(item => item.id === id) || {})) { showNotice('仅能重试已证明未提交的明确失败步骤；未确认操作不可一键重发', 'err'); return }
    await contactOperation(btn, accountId => api.contact.retry({ accountId, id }), '已请求重试明确失败的步骤')
  },
  async 'library-refresh'(args, btn) {
    if (S.library.busy) return
    if (btn) btn.disabled = true
    await loadLibrary()
    if (btn) btn.disabled = false
  },
  async 'batch-favorites-save'(args, btn) {
    await favoritesSaveFolderOperation(btn, 'batch-favorites-folder')
  },
  async 'favorites-save-folder'(args, btn) {
    await favoritesSaveFolderOperation(btn)
  },
  async 'favorites-sync'(args, btn) {
    await favoritesSyncOperation(btn, { resume: false })
  },
  async 'favorites-resume'(args, btn) {
    await favoritesSyncOperation(btn, { resume: true })
  },
  async 'discovery-sync-run'(args, btn) {
    await discoverySyncRunOperation(btn)
  },
  async 'pipeline-run'(args, btn) {
    await pipelineOperation(btn, { retryFailed: false })
  },
  async 'pipeline-retry'(args, btn) {
    await pipelineOperation(btn, { retryFailed: true })
  },
  async 'pipeline-pause'(args, btn) {
    await pipelinePauseOperation(btn)
  },
  // ── P2-12B 自动调度 ──────────────────────────────────────────────────────
  async 'scheduler-toggle-sync'(args, btn) {
    const next = S.library.scheduler?.autoSync !== true
    await schedulerOperation(btn, () => api.library.setScheduler({ autoSync: next }), next ? '已开启每日收藏夹同步' : '已暂停自动收藏夹同步')
  },
  async 'scheduler-toggle-analyze'(args, btn) {
    const next = S.library.scheduler?.autoAnalyze !== true
    await schedulerOperation(btn, () => api.library.setScheduler({ autoAnalyze: next }), next ? '已开启自动分析队列' : '已暂停自动分析队列')
  },
  async 'scheduler-pause'(args, btn) {
    await schedulerOperation(btn, () => api.library.pauseScheduler(), result => result.message || '已暂停自动任务')
  },
  async 'scheduler-resume'(args, btn) {
    await schedulerOperation(btn, () => api.library.resumeScheduler(), result => result.message || '已恢复自动任务')
  },
  async 'scheduler-stop'(args, btn) {
    await schedulerOperation(btn, () => api.library.stopScheduler(), result => result.message || '已停止自动任务')
  },
  async 'scheduler-run-now'(args, btn) {
    await schedulerOperation(btn, () => api.library.runSchedulerNow({ kind: 'all' }), result => {
      const round = result.result || {}
      if (round.skipped) return `本轮未执行：${round.reason === 'DISABLED' ? '两个自动开关都未开启' : round.reason === 'BUSY' ? '已有任务在运行' : round.reason === 'paused' ? '任务已暂停' : round.reason === 'blocked' ? '任务需要处理后才能继续' : '已跳过'}`
      if (round.syncFailed) return '收藏夹同步失败，已暂停并等待重试；请查看上方错误原因'
      if (round.budgetWait) return '今日模型预算已用完，已保存进度等待明天'
      if (round.done) return '没有待处理视频，已停止本轮'
      if (round.stopped) return `任务已暂停：${round.reason === 'SYNC_BLOCKED' ? '收藏夹同步被平台限制' : '需要处理登录/验证/页面异常'}`
      if (round.idle) return '本轮没有到期的同步或分析任务'
      return result.message || '已执行一轮自动任务'
    })
  },
  // ── P2-12A 人工基准集（盲评） ────────────────────────────────────────────
  'benchmark-continue'() {
    document.getElementById('benchmark-blind-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  },
  async 'benchmark-refresh'(args, btn) {
    if (S.library.benchmarkBusy) return
    if (btn) btn.disabled = true
    await loadBenchmark()
    if (btn) btn.disabled = false
  },
  async 'benchmark-create'(args, btn) {
    await benchmarkOperation(btn, () => api.library.createBenchmark({ size: 60 }), result => result.message || (result.created ? '基准集已创建' : '已继续上次进度'))
  },
  async 'benchmark-save'({ key, position }, btn) {
    const intent = String(document.getElementById(`bm-select-${position}`)?.value || '').trim()
    if (!intent) { showNotice('请选择人工标签，或点“无法判断”', 'err'); return }
    await benchmarkOperation(btn, () => api.library.annotateBenchmark({ key, intent, offset: S.library.benchmarkOffset || 0 }), result => result.message || '已保存人工标签')
  },
  async 'benchmark-unknown'({ key, position }, btn) {
    await benchmarkOperation(btn, () => api.library.annotateBenchmark({ key, intent: 'UNKNOWN', reason: '盲评：无法判断', offset: S.library.benchmarkOffset || 0 }), result => result.message || '已保存“无法判断”')
  },
  async 'benchmark-skip'({ key }, btn) {
    // 跳过的样本不写人工标签，靠偏移量翻到下一条，之后仍会回到队列里。
    await benchmarkOperation(btn, () => api.library.annotateBenchmark({ key, intent: 'SKIP', offset: (S.library.benchmarkOffset || 0) + 1 }), '已跳过本条（未写入人工标签）')
  },
  async 'benchmark-page'({ delta }, btn) {
    S.library.benchmarkOffset = Math.max(0, (S.library.benchmarkOffset || 0) + Number(delta || 0))
    await benchmarkOperation(btn, () => api.library.getBenchmark({ limit: 12, offset: S.library.benchmarkOffset }), '')
  },
  async 'benchmark-evaluate'(args, btn) {
    await benchmarkEvaluateOperation(btn)
  },
  // ── P2-13 双模式与自动联系 ──────────────────────────────────────────────
  async 'auto-mode-training'(args, btn) { await autoModeSelect('training', btn) },
  async 'auto-mode-auto'(args, btn) { await autoModeSelect('auto', btn) },
  async 'auto-config-save'(args, btn) {
    const config = readAutoConfigInputs()
    await autoOperation(btn, () => api.library.setAutoConfig({ config }), '已保存自动执行设置')
  },
  async 'auto-plan'(args, btn) {
    await autoOperation(btn, () => api.library.autoPlan({}), result => `已生成执行计划：关注 ${result.summary?.follow || 0} 人，首次联系 ${result.summary?.firstMessage || 0} 人，阻断 ${result.summary?.blocked || 0} 人（Dry Run）`)
  },
  async 'auto-run'(args, btn) {
    await autoOperation(btn, () => api.library.autoRun({}), result => result.dryRun ? 'Dry Run 完成：只生成计划与结果，未产生真实关注或私信' : '自动发现执行完成', { reloadLibrary: true })
  },
  // P2-14A 只读资格审计：发现合格 / 联系资格 / 动作授权分开统计。
  async 'auto-audit'(args, btn) {
    await autoOperation(btn, () => api.library.getAutoAudit(), result => {
      const counts = result.audit?.summary?.counts || {}
      return `审计完成：发现合格 ${counts.discoveryQualified || 0} · 信息不足 ${counts.insufficientInfo || 0} · 联系资格 ${counts.contactEligible || 0} · 可真实执行 ${counts.actionAuthorized || 0}`
    })
  },
  // 真实一键关注：每次点击都二次确认，受每日上限与硬停条件约束。
  async 'auto-follow-now'(args, btn) {
    const auto = autoContactStateOf()
    if (auto.mode !== 'auto') { showNotice('训练模式不允许真实关注，请先切换到正式模式', 'err'); return }
    if (!auto.config?.autoFollow) { showNotice('请先在高级设置中勾选“允许自动关注”并保存', 'err'); return }
    const limit = Number(auto.config.dailyFollowLimit) || 0
    const today = new Date().toISOString().slice(0, 10)
    const used = auto.budget?.day === today ? Number(auto.budget.follows) || 0 : 0
    const remaining = Math.max(0, limit - used)
    if (remaining <= 0) { showNotice(`今日关注已达上限 ${limit} 人，可在高级设置调整上限或明天再试`, 'err'); return }
    const confirmed = window.confirm(`现在执行真实关注？\n\n· 会真实打开抖音主页并点击“关注”\n· 只处理筛选通过的候选人；已拒绝联系、已是联系人、资料不符的人永不处理\n· 本次最多关注 ${remaining} 人（今日剩余额度）\n· 遇到验证码、登录失效、频率限制或权限异常会立即停止\n\n首次私信仍是 Dry Run，不会发送。`)
    if (!confirmed) return
    await autoOperation(btn, () => api.library.autoFollow({ confirmed: true }), result => result.stopped ? `已停止：${result.stopped.reason}` : (result.message || `已真实关注 ${result.followed || 0} 人`), { reloadLibrary: true })
  },
  'auto-open-settings'() {
    const panel = document.getElementById('auto-advanced')
    if (panel) {
      panel.open = true
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const checkbox = document.getElementById('auto-follow-enabled')
    if (checkbox && !checkbox.checked) checkbox.checked = true
    showNotice('已在高级设置中勾选“允许自动关注”，请点击“保存自动执行设置”后再使用一键关注')
  },
  async 'auto-training-run'(args, btn) { await autoTrainingRunOperation(btn) },
  async 'auto-pause'(args, btn) { await autoOperation(btn, () => api.library.pauseAuto(), '已暂停关注与首次联系队列') },
  async 'auto-resume'(args, btn) { await autoOperation(btn, () => api.library.resumeAuto(), '已恢复关注与首次联系队列') },
  async 'auto-stop'(args, btn) { await autoOperation(btn, () => api.library.stopAuto(), result => result.message || '已紧急停止关注与首次联系队列') },
  async 'auto-reset'(args, btn) { await autoOperation(btn, () => api.library.resetAuto(), result => result.message || '已清空自动联系队列') },
  async 'library-collect-video'(args, btn) {
    const text = document.getElementById('library-video-input')?.value.trim()
    if (!text) throw new Error('请粘贴视频链接或作品 ID')
    await libraryOperation(btn, () => api.library.collectVideo({
      text,
      title: document.getElementById('library-video-title')?.value.trim() || '',
      hashtags: (document.getElementById('library-video-hashtags')?.value || '').split(/[,，、\s]+/).map(tag => tag.replace(/^[#＃]+/, '').trim()).filter(Boolean),
      topic: document.getElementById('library-video-topic')?.value.trim() || '',
    }), result => {
      const field = document.getElementById('library-video-input')
      if (field && result.added) field.value = ''
      return result.message || '视频已收录'
    })
  },
  async 'library-collect-clipboard'(args, btn) {
    await libraryOperation(btn, () => api.library.collectClipboard({
      title: document.getElementById('library-video-title')?.value.trim() || '',
      hashtags: (document.getElementById('library-video-hashtags')?.value || '').split(/[,，、\s]+/).map(tag => tag.replace(/^[#＃]+/, '').trim()).filter(Boolean),
      topic: document.getElementById('library-video-topic')?.value.trim() || '',
    }), result => `${result.message || '视频已收录'}${result.copied ? `（剪贴板：${result.copied.slice(0, 80)}）` : ''}`)
  },
  // ── P2-11A 简化流程：一处输入，后台完成收集与分类；审核区只做判断 ─────────────
  async 'discover-analyze'(args, btn) {
    const text = document.getElementById('discover-link')?.value.trim() || ''
    if (!text) { showNotice('请先粘贴抖音视频链接或作品 ID', 'err'); return }
    const collector = S.library.data?.collector || {}
    S.library.skipped = []
    S.library.fixKey = ''
    S.library.analyzeMessage = ''
    await collectCommentsOperation(btn, {
      text,
      limit: Number(collector.targetLimit) || 50,
      maxPages: Number(collector.maxPages) || 8,
      title: '',
    })
  },
  async 'discover-resume'(args, btn) {
    const collector = S.library.data?.collector || {}
    const text = document.getElementById('discover-link')?.value.trim() || collector.videoUrl || collector.videoId || ''
    if (!text && !collector.videoId) { showNotice('没有可恢复的收集任务，请粘贴视频链接重新开始', 'err'); return }
    await collectCommentsOperation(btn, {
      text, videoId: collector.videoId || null, videoUrl: collector.videoUrl || null,
      title: collector.title || '',
      limit: Number(collector.targetLimit) || 50,
      maxPages: Number(collector.maxPages) || 8,
      resume: true,
    })
  },
  async 'review-correct'({ key }) {
    const sample = learningSampleOf(key) || (S.library.review || []).find(item => item.key === key)
    const intent = sample?.ai?.intent
    if (!intent || intent === 'UNKNOWN') { showNotice('模型没有给出可用类别，请点“判断错误”选择正确类别', 'err'); return }
    await learningAnnotate(key, { intent, reason: '人工确认 AI 判断正确', useForTraining: true }, '已确认 AI 判断正确，并存入学习案例库')
  },
  'review-wrong'({ key }) {
    S.library.fixKey = key
    patchContainer('review-queue', () => reviewQueueView())
  },
  'review-cancel'() {
    S.library.fixKey = ''
    patchContainer('review-queue', () => reviewQueueView())
  },
  // 评论作者的一键联系：先由 AI 起草第一句，弹窗让用户看清对象与正文，
  // 只有用户点“确认关注并发送”才会真的关注并发私信；绝不批量发送。
  async 'review-approach'({ key }) {
    const sample = learningSampleOf(key) || (S.library.review || []).find(item => item.key === key)
    if (!sample) { showNotice('找不到这条评论，请刷新后重试', 'err'); return }
    const authorId = String(sample.authorId || '').trim()
    const name = String(sample.authorName || '').trim()
    if (!authorId || !name) { showNotice('这条评论缺少可核对的作者 ID 或昵称，只能用于学习', 'err'); return }
    const genderFilter = reviewGenderFilter()
    if (genderFilter !== 'any' && sample.authorGender !== genderFilter) {
      showNotice(`当前性别筛选为“${genderFilter === 'female' ? '女' : '男'}”，这条作者未核验或性别不符，不能关注或发私信`, 'err')
      return
    }
    const url = `https://www.douyin.com/user/${authorId}`
    if (S.library.approachBusy) { showNotice('上一条关注/私信还没结束，请稍候', 'err'); return }
    S.library.approachBusy = true
    try {
      showNotice(`正在为 ${name} 生成第一句…`)
      const preview = await api.friendship.approachPreview({ url, name, commentText: sample.text || '', videoTitle: sample.videoTitle || '' })
      if (!preview?.ok) throw new Error(preview?.error || '生成第一句失败')
      const text = await askApproach({ name, comment: sample.text || '', text: preview.text || '' })
      if (!text) { showNotice('已取消，没有关注，也没有发送私信'); return }
      showNotice(`正在关注 ${name} 并发送第一句…`)
      let result = await api.friendship.approach({ url, name, text, confirmed: true })
      // P2-15：评论只表达一般交友意愿时，必须由操作者单独确认为主动私信，不能自动升级。
      if (!result?.ok && result.code === 'INVITATION_NOT_EXPLICIT') {
        const acknowledged = window.confirm(`这条评论没有被判定为“明确邀请私信”。\n\n评论：${String(sample.text || '').slice(0, 80)}\n\n一般交友意愿不等于私信许可。确认仍要关注并发送这条私信？`)
        if (!acknowledged) { showNotice('已取消，没有关注，也没有发送私信'); return }
        result = await api.friendship.approach({ url, name, text, confirmed: true, invitationAcknowledged: true })
      }
      if (!result?.ok) throw new Error(result?.reason || result?.error || '关注或发送失败')
      if (sample.ai?.intent && sample.ai.intent !== 'UNKNOWN') {
        await learningAnnotate(key, { intent: sample.ai.intent, reason: '已关注并发第一句，确认这条评论值得联系', useForTraining: true }, '').catch(() => {})
      }
      S.library.skipped = [...new Set([...(S.library.skipped || []), key])]
      await loadLibrary().catch(() => {})
      patchContainer('review-queue', () => reviewQueueView())
      showNotice(`已关注 ${name} 并发送第一句${result.followPending ? '（对方开启了关注验证，关注待通过）' : ''}`)
    } catch (error) {
      showNotice(error.message || String(error), 'err')
    } finally { S.library.approachBusy = false }
  },
  // 一键清空素材库：删除已收集的视频/评论与收集断点，并清空未判断的学习样本。
  // 账号、聊天记录和已人工判断的学习案例都保留。
  async 'library-clear'(args, btn) {
    const stats = S.library.data?.stats || {}
    const videos = Number(stats.videos || 0), comments = Number(stats.comments || 0)
    if (!videos && !comments) { showNotice('素材库已经是空的'); return }
    if (!confirm(`确定清空素材库？将删除 ${videos} 个视频、${comments} 条评论和本次收集断点，未判断的待审评论也会清空。账号、聊天记录和已人工判断的学习案例不受影响。`)) return
    S.library.busy = true
    if (btn) btn.disabled = true
    patchContainer('library-body', () => libraryBodyView())
    try {
      const result = await api.library.clear()
      if (!result?.ok) throw new Error(result?.error || '清空素材库失败')
      if (result.library) S.library.data = result.library
      if (result.learning) S.library.learning = result.learning
      S.library.review = []
      S.library.skipped = []
      patchContainer('discover-home', () => discoverHomeView())
      patchContainer('collector-panel', () => collectorView())
      patchContainer('review-queue', () => reviewQueueView())
      patchContainer('learning-panel', () => discoveryWorkspaceTab() === 'labels' && !selectedGoal() ? workspaceTrainingView() : learningView())
      patchContainer('library-body', () => libraryBodyView())
      showNotice(`已清空素材库：${videos} 个视频、${comments} 条评论，收集断点也已重置`)
    } catch (error) {
      showNotice(error.message || String(error), 'err')
    } finally {
      S.library.busy = false
      patchContainer('library-body', () => libraryBodyView())
    }
  },
  // 核验作者公开性别：逐个打开作者主页，只认主页公开显示的男/女。
  // 读完后“只看女性”才会显示对应评论；男性不会被关注或私信。
  async 'verify-genders'(args, btn) {
    if (S.library.verifying) return
    S.library.verifying = true
    patchContainer('review-queue', () => reviewQueueView())
    showNotice('正在逐个读取作者公开主页核验性别，每人约几秒，请勿关闭弹出的交友窗口…')
    try {
      const result = await api.learning.verifyGenders({ limit: 12 })
      if (!result?.ok) throw new Error(result?.error || '核验作者性别失败')
      if (result.learning) S.library.learning = result.learning
      // 本次收集的 review 列表可能还是旧数据，清掉后统一用学习库里的性别结果。
      S.library.review = []
      patchContainer('review-queue', () => reviewQueueView())
      refreshLearningPanel()
      const message = result.checked
        ? `已核验 ${result.checked} 位：女 ${result.female} · 男 ${result.male} · 未读到 ${result.unknown}${result.blocked ? `。${result.blocked}` : ''}`
        : '没有需要核验的作者'
      showNotice(message, result.blocked ? 'err' : undefined)
    } catch (error) {
      showNotice(error.message || String(error), 'err')
    } finally {
      S.library.verifying = false
      patchContainer('review-queue', () => reviewQueueView())
    }
  },
  // 一键清空：只把还没人工判断的样本移出审核列表，不删除评论、不影响已判断的样本。
  async 'review-clear'(args, btn) {
    if (S.library.clearing) return
    S.library.clearing = true
    if (btn) btn.disabled = true
    try {
      const result = await api.learning.clearPending({ reason: '人工一键清空，未逐条判断' })
      if (!result?.ok) throw new Error(result?.error || '清空审核列表失败')
      if (result.learning) S.library.learning = result.learning
      S.library.review = []
      S.library.skipped = []
      patchContainer('review-queue', () => reviewQueueView())
      refreshLearningPanel()
      patchContainer('library-body', () => libraryBodyView())
      S.library.analyzeMessage = `已清空 ${result.changed || 0} 条待审评论，它们不会再出现在审核列表`
      showNotice(`已清空 ${result.changed || 0} 条待审评论；原始评论仍在素材库，只是不用于训练`)
    } catch (error) {
      showNotice(error.message || String(error), 'err')
    } finally { S.library.clearing = false }
  },
  async 'discover-more'(args, btn) {
    const collector = S.library.data?.collector || {}
    const text = collector.videoUrl || collector.videoId || ''
    if (!text) { showNotice('没有可继续的视频，请先粘贴链接开始分析', 'err'); return }
    const videoId = collector.videoId || null
    const stored = (S.library.data?.comments || []).filter(item => videoId && item.video_id === videoId).length
    // 继续寻找：提高本次数量与页数上限，并从上次停下的位置继续往下读。
    await collectCommentsOperation(btn, {
      text, videoId, videoUrl: collector.videoUrl || null, title: collector.title || '',
      limit: Math.max(stored + 50, Number(collector.targetLimit || 50) + 50),
      maxPages: Math.max((Number(collector.pages) || 0) + 6, Number(collector.maxPages) || 8),
      resume: true,
    })
  },
  async 'review-set'({ key }) {
    const value = document.getElementById('review-fix-select')?.value || ''
    if (!value) { showNotice('请先选择正确类别', 'err'); return }
    S.library.fixKey = ''
    await learningAnnotate(key, { intent: value, reason: '人工纠正 AI 分类', useForTraining: true }, `已改为「${LIBRARY_INTENT_LABELS[value] || value}」并存入学习案例库`)
  },
  'review-skip'({ key }) {
    S.library.skipped = [...new Set([...(S.library.skipped || []), key])]
    S.library.fixKey = ''
    patchContainer('review-queue', () => reviewQueueView())
  },
  async 'library-collect-comments'(args, btn) {
    let payload = null
    try { payload = collectPayloadFromInputs() } catch (error) { showNotice(error.message, 'err'); return }
    await collectCommentsOperation(btn, payload)
  },
  async 'library-resume-collect'(args, btn) {
    const collector = S.library.data?.collector || {}
    const limit = Number(document.getElementById('library-collect-limit')?.value) || collector.targetLimit || 50
    const maxPages = Number(document.getElementById('library-collect-pages')?.value) || collector.maxPages || 8
    await collectCommentsOperation(btn, {
      text: document.getElementById('library-collect-input')?.value.trim() || collector.videoUrl || collector.videoId || '',
      videoId: collector.videoId || null,
      videoUrl: collector.videoUrl || null,
      title: collector.title || '',
      limit, maxPages, resume: true,
    })
  },
  async 'library-collect-from-video'(args, btn) {
    const field = document.getElementById('library-collect-input')
    if (field && args?.text) field.value = args.text
    const collector = S.library.data?.collector || {}
    await collectCommentsOperation(btn, {
      text: args?.text || '', title: args?.title || '',
      limit: Number(document.getElementById('library-collect-limit')?.value) || collector.targetLimit || 50,
      maxPages: Number(document.getElementById('library-collect-pages')?.value) || collector.maxPages || 8,
    })
  },
  async 'library-classify'(args, btn) {
    await libraryOperation(btn, () => api.library.classify({ maxAiCalls: null }), result => `评论分析完成：处理 ${result.result?.processed || 0} 条，模型调用 ${result.result?.aiCalls || 0} 次${result.result?.pending ? `，剩余 ${result.result.pending} 条待下次` : ''}`)
  },
  async 'library-paste-import'(args, btn) {
    const field = document.getElementById('library-paste')
    const text = field?.value.trim()
    if (!text) throw new Error('请先粘贴评论内容')
    await libraryOperation(btn, () => api.library.import({ text, filename: 'paste.txt' }), result => {
      const log = result.log || {}
      if (!(log.addedVideos + log.addedComments)) return `没有新增条目：重复 ${(log.duplicateVideos || 0) + (log.duplicateComments || 0)}，无效 ${log.invalid || 0}`
      if (field) field.value = ''
      return `粘贴导入：新增视频 ${log.addedVideos || 0}，新增评论 ${log.addedComments || 0}，重复 ${(log.duplicateVideos || 0) + (log.duplicateComments || 0)}，无效 ${log.invalid || 0}`
    })
  },
  async 'library-candidates'(args, btn) {
    await libraryOperation(btn, () => api.library.candidates(), result => `已加入候选池 ${result.added || 0} 人，合并 ${result.merged || 0} 人，未入选 ${result.unmapped || 0} 条；未关注、未发送消息。`)
  },
  // ── P2-09 评论学习 ────────────────────────────────────────────────────────
  async 'learning-refresh'(args, btn) {
    await learningOperation(btn, () => api.learning.get(), () => '学习样本已刷新（素材库评论已同步）')
  },
  async 'learning-classify-rule'(args, btn) {
    await learningOperation(btn, () => api.learning.classify({ mode: 'rule', scope: 'all', maxAiCalls: 0 }),
      result => `① 规则分类完成：处理 ${result.task?.processed || 0}/${result.task?.total || 0} 条，规则明确 ${result.task?.rulesDecided || 0} 条，0 次模型调用`)
  },
  async 'learning-classify-model'(args, btn) {
    await learningOperation(btn, () => api.learning.classify({ mode: 'model', scope: 'all', maxAiCalls: 12 }),
      result => `② 规则 + 豆包完成：模型调用 ${result.task?.aiCalls || 0} 次，token ${result.task?.tokens || 0}${result.task?.errors?.length ? `；${result.task.errors[0].reason}` : ''}`)
  },
  async 'learning-classify-cases'(args, btn) {
    await learningOperation(btn, () => api.learning.classify({ mode: 'model_cases', scope: 'all', maxAiCalls: 12 }),
      result => `③ 规则 + 豆包 + 相似案例完成：模型调用 ${result.task?.aiCalls || 0} 次，token ${result.task?.tokens || 0}${result.task?.errors?.length ? `；${result.task.errors[0].reason}` : ''}`)
  },
  async 'learning-confirm'({ key }, btn) {
    const sample = learningSampleOf(key)
    if (!sample?.ai) return
    await learningAnnotate(key, { intent: sample.ai.intent, reason: '确认 AI 分类正确' }, '已确认为人工标签')
  },
  async 'learning-unknown'({ key }) {
    await learningAnnotate(key, { intent: 'UNKNOWN', reason: '人工判断为无法判断' }, '已标记为无法判断')
  },
  async 'learning-exclude'({ key }, btn) {
    const reason = window.prompt('排除该评论的原因（可留空）', '人工排除：不用于学习') ?? null
    if (reason === null) return
    await learningOperation(btn, () => api.learning.exclude({ key, excluded: true, reason }), '已排除该样本，不进入复核、训练案例与评估')
  },
  async 'learning-batch-confirm'(args, btn) {
    const keys = (S.library.learning?.pending || [])
      .filter(sample => sample.ai && !sample.ai.needsReview && Number(sample.ai.confidence) >= 0.9)
      .map(sample => sample.key)
    if (!keys.length) { showNotice('没有置信度 ≥ 0.9 且不需复核的样本', 'err'); return }
    if (!window.confirm(`确认把 ${keys.length} 条高置信评论标记为人工正确？`)) return
    await learningOperation(btn, () => api.learning.annotateBatch({ keys, reason: '批量确认高置信样本' }),
      result => `已批量确认 ${result.changed || 0} 条`)
  },
  async 'learning-splits'(args, btn) {
    await learningOperation(btn, () => api.learning.splits({}),
      result => `按视频划分完成：训练 ${result.train || 0} 条，独立评估 ${result.eval || 0} 条（评估视频 ${(result.evalVideos || []).length} 个）`)
  },
  async 'learning-evaluate'(args, btn) {
    await learningOperation(btn, () => api.learning.evaluate({}), result => {
      S.library.evaluation = result.evaluation
      return `评估完成：独立评估样本 ${result.evaluation?.evalCount || 0} 条，已人工标注 ${result.evaluation?.sampleCount || 0} 条`
    })
  },
  async 'learning-version-create'(args, btn) {
    await learningOperation(btn, () => api.learning.version({ action: 'create', note: '界面记录', useCases: true, topK: 3 }),
      result => `已保存分类配置 ${result.learning?.activeVersion?.id || ''}`)
  },
  async 'learning-version-rollback'(args, btn) {
    await learningOperation(btn, () => api.learning.version({ action: 'rollback' }),
      result => `已回滚到 ${result.learning?.activeVersion?.id || '上一版本'}`)
  },
  async 'library-intro'({ id }, btn) {
    if (S.library.busy) return
    const account = S.accounts.active
    S.library.busy = true
    if (btn) btn.disabled = true
    try {
      const result = await api.library.intro({ candidateId: id })
      if (S.accounts.active !== account) return
      S.library.intro = { candidateId: id, ...result }
      if (!result?.ok) showNotice(result?.error || '无法生成开场白', 'err')
      else showNotice('开场白已生成，请确认并修改后再使用')
    } catch (error) { if (S.accounts.active === account) showNotice(error.message || String(error), 'err') }
    finally { S.library.busy = false; if (btn) btn.disabled = false; if (S.accounts.active === account) patchContainer('discovery-detail', discoveryDetailView()) }
  },
  async 'library-write-origin'({ id }, btn) {
    if (S.library.busy) return
    const account = S.accounts.active
    S.library.busy = true
    if (btn) btn.disabled = true
    try {
      const result = await api.library.writeOrigin({ candidateId: id })
      if (S.accounts.active !== account) return
      if (!result?.ok) throw new Error(result?.error || '写入认识来源失败')
      showNotice('来源已写入联系人资料，标记为“未确认”，不会冒充已确认来源')
    } catch (error) { if (S.accounts.active === account) showNotice(error.message || String(error), 'err') }
    finally { S.library.busy = false; if (btn) btn.disabled = false }
  },
  async 'library-intro-copy'() {
    const text = document.getElementById('library-intro-text')?.value.trim()
    if (!text) throw new Error('请先生成开场白')
    await navigator.clipboard.writeText(text)
    showNotice('已复制开场白，可在对方私信里粘贴发送')
  },
  'discovery-select'({ id }) {
    if (!discoveryCandidates().some(item => item.id === id)) return
    S.discovery.selected = id
    patchContainer('discovery-candidates', discoveryListView())
    const detail = document.getElementById('discovery-detail')
    if (detail) detail.innerHTML = discoveryDetailView()
  },
  async 'discovery-config'(args, btn) {
    await discoveryOperation(btn, accountId => api.discovery.updateConfig({ accountId, config: readDiscoveryConfig() }), '搜索设置已保存')
  },
async 'discovery-start'(args, btn) {

    if (discoveryRunning()) return
    const local = S.discovery
    await discoveryOperation(btn, async accountId => {
      const config = readDiscoveryConfig(true)
      const saved = await api.discovery.updateConfig({ accountId, config })
      if (S.accounts.active !== accountId || S.discovery !== local) return { ok: false, error: '当前账号已切换，本次未启动发现' }
      if (!saved.ok) return saved
      if (saved.discovery) S.data.discovery = saved.discovery
      return api.discovery.start({ accountId })
    }, '发现已启动，请查看进度与候选池')
  },
  async 'discovery-stop'(args, btn) {
    const local = S.discovery, accountId = S.accounts.active
    if (btn) btn.disabled = true
    try {
      const result = await api.discovery.stop({ accountId })
      if (S.accounts.active !== accountId || S.discovery !== local) return
      if (result.discovery) S.data.discovery = result.discovery
      if (!result.ok) throw new Error(result.error || '停止发现失败')
      showNotice('已请求停止发现')
    } catch (error) { if (S.accounts.active === accountId && S.discovery === local) showNotice(error.message || String(error), 'err') }
    finally { if (btn) btn.disabled = false; if (S.accounts.active === accountId && S.discovery === local) refreshDiscovery() }
  },
  async 'discovery-open'({ id }, btn) {
    await discoveryOperation(btn, accountId => api.discovery.open({ accountId, id }))
  },
  async 'discovery-inspect'({ id }, btn) {
    await discoveryOperation(btn, accountId => api.discovery.inspect({ accountId, id }), '公开简介已读取')
  },
  async 'discovery-intent-save'({ id }, btn) {
    const intent = document.getElementById('discovery-intent')?.value
    await discoveryOperation(btn, accountId => api.discovery.intent({ accountId, id, intent }), '意愿等级已保存；没有关注或发送消息')
  },
  async 'workspace-approach'({ id }, btn) {
    await discoveryOperation(btn, async accountId => {
      const local = S.discovery, candidate = discoveryCandidates().find(c => c.id === id)
      if (!candidate) throw new Error('找不到候选人')
      if (candidate.status === 'REJECTED' || candidate.action?.firstMessageStatus === 'sent' || candidate.action?.needsReview || candidate.review?.realContact?.messageStatus === 'sent' || candidate.review?.realContact?.needsReview) throw new Error('已排除、已发送或发送结果待核实，请先查看联系记录')
      const goal = candidateGoalRef(candidate), match = candidateGoalMatch(candidate)
      let text = goal || S.data.settings?.openingMode === 'fixed' || String(S.data.settings?.openingRequirements || '').trim() ? '' : candidate.review?.draftOpening || ''
      if (!text) {
        const r = await api.discovery.batchDraft({ accountId, id, ...(goal ? { goal } : {}) })
        if (!r?.ok) throw new Error(r?.error || '生成首句失败；请先配置模型和我的介绍')
        text = r.text
      }
      if (S.accounts.active !== accountId || S.discovery !== local) return { ok: false }
      const confirmedText = await askApproach({ name: candidate.nickname, comment: match?.text || candidate.firstComment, text })
      if (!confirmedText || S.accounts.active !== accountId || S.discovery !== local) return { ok: true }
      const r = await api.discovery.batchContact({ accountId, id, text: confirmedText, confirmed: true, origin: 'workspace', ...(goal ? { goal } : {}) })
      if (S.accounts.active !== accountId || S.discovery !== local) return { ok: false }
      return r
    }, '')
  },
  async 'discovery-review'({ id, status }, btn) {
    if (!['APPROVED', 'DEFERRED', 'REJECTED', 'REVIEW_PENDING'].includes(status)) return
    const note = S.discovery.notes[id] ?? discoveryCandidates().find(item => item.id === id)?.review?.note ?? ''
    await discoveryOperation(btn, accountId => api.discovery.review({ accountId, id, status, note, ...discoveryReviewEvidence(id) }), '审核标记已保存，未关注或发送消息')
  },
  async 'discovery-parse'(args, btn) {
    const text = document.getElementById('discovery-requirements')?.value || ''
    const local = S.discovery
    await discoveryOperation(btn, async accountId => {
      const result = await api.discovery.parse({ accountId, text })
      if (S.accounts.active !== accountId || S.discovery !== local) return result
      if (result.ok && result.unsupported?.length) throw new Error(`这些要求尚不支持自动核验，请修改后重试：${result.unsupported.join('；')}`)
      if (result.ok && result.config) {
        const search = readDiscoverySearch()
        S.data.discovery.config = { ...result.config, ...search }
        local.videoTagsText = document.getElementById('discovery-video-tags')?.value ?? discoverySearchValues().videoTagsText
        local.videoKeywordsText = document.getElementById('discovery-video-keywords')?.value ?? discoverySearchValues().videoKeywordsText
        local.requirementsText = text; render()
      }
      return result
    }, '解析完成，请检查条件并保存或开始发现')
  },
  async 'event-scan'(args, btn) {
    await eventOperation(btn, accountId => api.events.scan({ accountId }), result => `检查完成，生成 ${result.generatedCount || 0} 条事件跟进草稿${result.deferredCount ? `，暂缓 ${result.deferredCount} 项` : ''}。请到草稿页查看`)
  },
  async 'event-send'({ id }, btn) {
    const draft = (S.data.pendingDrafts || []).find(item => item.id === id && item.source === 'event_followup')
    if (!draft) return
    if (['sending', 'uncertain'].includes(draft.status)) { showNotice('发送结果未确认或正在发送，请检查抖音记录', 'err'); return }
    const box = [...document.querySelectorAll('[data-draft-text]')].find(el => el.dataset.draftText === id)
    const text = box ? box.value.trim() : draft.text
    if (!text) { showNotice('内容为空', 'err'); return }
    await eventOperation(btn, accountId => api.events.send({ id, text, accountId }), '事件跟进已发送')
  },
  async 'event-rewrite'({ id }, btn) {
    const draft = (S.data.pendingDrafts || []).find(item => item.id === id && item.source === 'event_followup')
    if (!draft || ['sending', 'uncertain'].includes(draft.status)) return
    await eventOperation(btn, accountId => api.events.rewrite({ id, accountId }), result => result.skipped ? 'Planner建议暂缓跟进，已撤下草稿' : '事件跟进草稿已改写')
  },
  async 'event-skip'({ id }, btn) {
    const draft = (S.data.pendingDrafts || []).find(item => item.id === id && item.source === 'event_followup')
    if (!draft || draft.status === 'sending') return
    await eventOperation(btn, accountId => api.events.skip({ id, accountId }), '已跳过本次事件跟进')
  },
  async 'video-create'({ name }, btn) {
    await run(btn, async () => {
      const account = S.accounts.active
      showNotice('AI 正在找视频、读取评论并配文…')
      const result = await api.videoOpenings.create(name)
      if (S.accounts.active !== account) return
      if (!result.ok) { const progress = document.getElementById('video-opening-progress'); if (progress && S.selected === name) progress.textContent = result.error; throw new Error(result.error) }
      S.data = await api.automation.getState()
      if (S.selected === name) patchContainer('video-opening-preview', videoOpeningPreview(name))
      showNotice('视频和一句话已就绪，点击直接分享即可发送')
    })
  },
  async 'video-open'({ id }, btn) { await run(btn, async () => { const result = await api.videoOpenings.open(id); if (!result.ok) throw new Error(result.error) }) },
  async 'video-send'({ id }, btn) {
    await run(btn, async () => {
      const account = S.accounts.active
      const result = await api.videoOpenings.send({ id, text: document.querySelector(`[data-video-caption="${id}"]`)?.value.trim() })
      if (S.accounts.active !== account) return
      S.data = await api.automation.getState()
      patchContainer('video-opening-preview', videoOpeningPreview(S.selected))
      if (!result.ok) throw new Error(result.error)
      showNotice('视频链接和配文已分两条发送')
    })
  },
  async 'video-discard'({ id }, btn) {
    await run(btn, async () => {
      const result = await api.videoOpenings.discard(id)
      if (!result.ok) throw new Error(result.error)
      S.data = await api.automation.getState()
      patchContainer('video-opening-preview', videoOpeningPreview(S.selected))
      showNotice('已丢弃，可重新找一个视频')
    })
  },
  nav({ section }) { if (section === 'drafts') section = 'chat'; if (section === 'friends') section = 'discovery'; S.section = section; render(); if (section === 'discovery') { loadDiscoveryMode(); loadBatch() } else batchPoll() },
  'select-contact'({ name, id }) { S.selected = name; S.selectedContactId = id ? String(id) : ''; render() },
  async 'toggle-auto'() {
    await saveState({ automation: { ...S.data.automation, autoReply: !S.data.automation.autoReply } })
  },
  async 'toggle-pause'() {
    await saveState({ automation: { ...S.data.automation, paused: !S.data.automation.paused } })
  },
  async 'open-login'() {
    try {
      const result = await api.douyin.openLogin()
      if (result?.ok === false) showNotice(`打开登录窗口失败：${result.error || '未知原因'}`, 'err')
      else if (result?.loaded === false) showNotice('登录窗口已打开，但抖音页面没有加载成功，请检查网络后再点一次', 'err')
      else showNotice('登录窗口已打开（如被遮挡请在任务栏查找）')
    } catch (error) {
      showNotice(`打开登录窗口失败：${error?.message || error}`, 'err')
    }
  },
  async 'sync-contacts'(args, btn) {
    await run(btn, async () => {
      await api.douyin.syncContacts()
      showNotice('联系人已同步')
    })
  },
  async 'toggle-contact-ai'({ name }) {
    const list = new Set(S.data.automation.aiDisabledContacts || [])
    list.has(name) ? list.delete(name) : list.add(name)
    await saveState({ automation: { ...S.data.automation, aiDisabledContacts: [...list] } })
  },
  async 'toggle-contact-black'({ name }) {
    const list = new Set(S.data.automation.blacklist || [])
    list.has(name) ? list.delete(name) : list.add(name)
    await saveState({ automation: { ...S.data.automation, blacklist: [...list] } })
  },
  async 'learn-contact'({ name }, btn) {
    await run(btn, async () => {
      await api.douyin.learnContact(name)
      showNotice(`已学习 ${name} 的聊天记录`)
    })
  },
  async 'clear-learning'({ name }) {
    if (!confirm(`确定清除 ${name} 的全部学习数据？`)) return
    await api.ai.clearLearning(name)
    S.data = await api.automation.getState()
    showNotice('学习数据已清除')
    render()
  },
  async 'save-profile'(args, btn) {
    await run(btn, async () => {
      const contact = (S.data.contacts || []).find((c) => c.name === S.selected)
      if (!contact) return
      const profile = { ...(contact.profile || {}) }
      document.querySelectorAll('[data-cf]').forEach((el) => {
        const key = el.dataset.cf
        profile[key] = key === 'examples' ? el.value.split('\n').map((v) => v.trim()).filter(Boolean) : el.value.trim()
      })
      // 认识来源只写当前联系人的 profile.contact_origin，其他联系人与既有记忆都不动。
      if (document.querySelector('[data-cfo]')) {
        const field = (key) => document.querySelector(`[data-cfo="${key}"]`)
        const previous = profile.contact_origin || {}
        const ref = (field('video_ref')?.value || '').trim()
        profile.contact_origin = {
          platform: field('platform')?.value || 'douyin',
          source_type: field('source_type')?.value || 'other',
          video_topic: (field('video_topic')?.value || '').trim() || null,
          video_id: ref && /^\d+$/.test(ref) ? ref : null,
          video_url: ref && /^https?:\/\//i.test(ref) ? ref : null,
          video_title: previous.video_title || null,
          comment_text: previous.comment_text || null,
          note: (field('note')?.value || '').trim() || null,
          verified_by_user: Boolean(field('verified')?.checked),
        }
      }
      const contacts = (S.data.contacts || []).map((c) => (c.name === S.selected ? { ...c, profile } : c))
      await saveState({ contacts }, true)
      showNotice('资料已保存')
    })
  },
  async 'manual-send'(args, btn) {
    await run(btn, async () => {
      const text = document.getElementById('manual-text')?.value.trim()
      if (!text) throw new Error('内容为空')
      await api.douyin.sendMessage(S.selected, text)
      document.getElementById('manual-text').value = ''
      showNotice('已发送')
    })
  },
  async 'ai-draft'(args, btn) {
    await run(btn, async () => {
      const contact = (S.data.contacts || []).find((c) => c.name === S.selected)
      const account = S.accounts.active
      const result = await api.ai.draft({ contact, incoming: contact?.preview || '' })
      if (S.accounts.active !== account || S.selected !== contact?.name) return
      S.data = await api.automation.getState()
      const latest = (S.data.contacts || []).find(c => c.name === contact?.name)
      if (latest) {
        const facts = document.getElementById('contact-confirmed-facts')
        if (facts) facts.textContent = confirmedFactTexts(latest).join('；') || '聊天中透露的信息会逐步记入长期记忆'
        patchContainer('contact-social-memory', socialMemoryView(latest))
        const plan = document.getElementById('contact-relationship-plan')
        if (plan) plan.textContent = latest.learning?.relationshipPlan ? `本轮话题：${latest.learning.relationshipPlan.selectedTopic || ''} · ${latest.learning.relationshipPlan.reason || ''}` : ''
      }
      if (result?.skipped) { showNotice(result.rejected ? 'AI 拒绝生成该回复' : 'AI 判断当前不适合回复', 'err'); return }
      if (!result?.text) throw new Error(result?.error || 'AI 没有返回内容')
      const box = document.getElementById('manual-text')
      if (!box) return
      box.value = result.text
      showNotice(`已生成草稿（${result.model}），请确认后发送`)
    })
  },
  async 'draft-send'({ id }, btn) {
    if ((S.data.pendingDrafts || []).find(item => item.id === id)?.source === 'event_followup') { await ACTIONS['event-send']({ id }, btn); return }
    await run(btn, async () => {
      const draft = (S.data.pendingDrafts || []).find((d) => d.id === id)
      if (!draft) return
      if (draft.status === 'outdated') throw new Error(draft.outdatedReason || '对方在该草稿生成后发送了新消息，草稿已过期。')
      if (draftExpressionBlocked(draft)) throw new Error('此草稿已开始发送或结果未确认，请查看发送记录。')
      const account = S.accounts.active
      const text = document.querySelector(`[data-draft-text="${id}"]`)?.value.trim() || draft.text
      let sendResult
      if (draft.videoOpeningId) {
        const result = await api.videoOpenings.send({ id: draft.videoOpeningId, text })
        if (!result.ok) throw new Error(result.error)
      } else sendResult = await api.douyin.sendMessage(draft.name, text, { draftId: draft.id })
      if (S.accounts.active !== account) return
      const state = await api.automation.getState()
      if (S.accounts.active !== account) return
      S.data = state
      queueDynamic()
      if (sendResult?.ok === false && sendResult.status !== 'UNKNOWN') throw new Error(sendResult.error?.message || sendResult.reason || '剩余项目尚未发送成功，请查看发送记录。')
      showNotice(sendResult?.status === 'UNKNOWN' ? '发送结果未确认，已暂停；请检查抖音记录，程序不会自动重发。' : '草稿已发送', sendResult?.status === 'UNKNOWN' ? 'err' : 'ok')
    })
  },
  async 'expression-resume'({ id }, btn) {
    await run(btn, async () => {
      const batch = (S.data.expressionBatches || []).find(item => item.id === id)
      if (!batch || !['pending', 'failed'].includes(batch.status) || (batch.items || []).some(item => ['unknown', 'sending'].includes(item.status))) throw new Error('此任务不能继续发送，请先检查发送记录。')
      const account = S.accounts.active
      const result = await api.douyin.resumeExpression(id)
      if (S.accounts.active !== account) return
      S.data = await api.automation.getState()
      if (S.accounts.active !== account) return
      queueDynamic()
      if (result?.status === 'UNKNOWN') showNotice('发送结果未确认，已暂停；请先检查抖音记录。', 'err')
      else if (result?.ok !== true) throw new Error(result?.error || '剩余项目尚未发送成功')
      else showNotice('剩余项目已发送')
    })
  },
  async 'draft-discard'({ id }, btn) {
    if ((S.data.pendingDrafts || []).find(item => item.id === id)?.source === 'event_followup') { await ACTIONS['event-skip']({ id }, btn); return }
    if (!confirm('丢弃这条草稿？')) return
    const draft = (S.data.pendingDrafts || []).find(item => item.id === id)
    if (!draft) return
    const account = S.accounts.active
    if (draft.videoOpeningId) { const result = await api.videoOpenings.discard(draft.videoOpeningId); if (!result.ok) throw new Error(result.error) }
    else { const result = await api.ai.discardDraft(id); if (result?.ok === false) throw new Error(result.error || '丢弃草稿失败') }
    if (S.accounts.active !== account) return
    const state = await api.automation.getState()
    if (S.accounts.active !== account) return
    S.data = state
    queueDynamic()
  },
  'spark-new'() { S.sparkEditing = 'new'; render() },
  async 'spark-preview'(args, btn) {
    await run(btn, async () => {
      const sparks = S.data.automation.sparks || []
      const name = await askText('为谁预览 AI 问候？（不会发送）', sparks[0]?.name || S.selected || '')
      if (!name) return
      const history = (S.data.contacts || []).find((c) => c.name === name)?.learning?.messages || []
      const r = await api.ai.draftSpark({ name, history })
      if (!r?.ok) throw new Error(r?.error || '生成失败')
      showNotice(`今日播报预览：${r.text}`)
    })
  },
  'spark-cancel'() { S.sparkEditing = null; render() },
  'spark-edit'({ id }) { S.sparkEditing = id; render() },
  async 'spark-save'({ id }, btn) {
    await run(btn, async () => {
      const name = document.getElementById('spark-name').value.trim()
      if (!name) throw new Error('联系人名称不能为空')
      const task = {
        kind: document.getElementById('spark-kind').value,
        name,
        time: document.getElementById('spark-time').value.trim() || '09:00',
        message: document.getElementById('spark-message').value.trim(),
        emojiName: document.getElementById('spark-emoji').value.trim() || '早上好',
        aiNote: document.getElementById('spark-note').value.trim(),
        enabled: true,
      }
      const sparks = [...(S.data.automation.sparks || [])]
      if (id === 'new') sparks.push(task)
      else {
        const index = sparks.findIndex((t, i) => String(t.__id ?? t.name ?? i) === String(id))
        if (index >= 0) sparks[index] = { ...sparks[index], ...task }
        else sparks.push(task)
      }
      S.sparkEditing = null
      await saveState({ automation: { ...S.data.automation, sparks } })
      render()
    })
  },
  async 'spark-toggle'({ index }) {
    const sparks = [...(S.data.automation.sparks || [])]
    sparks[index] = { ...sparks[index], enabled: !sparks[index].enabled }
    await saveState({ automation: { ...S.data.automation, sparks } }, true)
  },
  async 'spark-delete'({ index }) {
    if (!confirm('删除这个任务？')) return
    const sparks = (S.data.automation.sparks || []).filter((_, i) => i !== index)
    await saveState({ automation: { ...S.data.automation, sparks } }, true)
  },
  async 'spark-send-now'({ index }, btn) {
    await run(btn, async () => {
      const task = (S.data.automation.sparks || [])[index]
      if (!task) return
      await api.douyin.sendTask(task.name, task)
      showNotice(`已向 ${task.name} 发送`)
    })
  },
  'provider-new'() { S.providerEditing = -1; S.modelOptions = []; S.modelFetchMsg = ''; render() },
  'provider-cancel'() { S.providerEditing = null; S.modelOptions = []; S.modelFetchMsg = ''; render() },
  'provider-edit'({ index }) { S.providerEditing = index; S.modelOptions = []; S.modelFetchMsg = ''; render() },
  async 'provider-fetch-models'(_, btn) {
    const baseInput = document.getElementById('pv-base')
    if (!baseInput) return
    const baseUrl = baseInput.value.trim()
    const apiKey = document.getElementById('pv-key')?.value || ''
    const index = S.providerEditing
    if (!baseUrl) { setModelStatus('请先填写接口地址', 'err'); return }
    if (btn) { btn.disabled = true; btn.textContent = '获取中…' }
    setModelStatus('正在获取模型列表…')
    try {
      const result = await api.ai.fetchModels({ baseUrl, apiKey, index: index >= 0 ? index : undefined })
      if (result?.ok) {
        S.modelOptions = result.models || []
        applyModelOptions(S.modelOptions)
        S.modelFetchMsg = result.message || `已获取 ${S.modelOptions.length} 个模型`
        setModelStatus(`${S.modelFetchMsg}，可下拉选择或手动输入`, 'ok')
      } else {
        S.modelFetchMsg = result?.message || '获取模型列表失败'
        setModelStatus(S.modelFetchMsg, 'err')
      }
    } catch (error) {
      setModelStatus(error?.message || '获取模型列表失败', 'err')
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '获取模型列表' }
    }
  },
  async 'provider-save'({ index }, btn) {
    await run(btn, async () => {
      const name = document.getElementById('pv-name').value.trim()
      const model = document.getElementById('pv-model').value.trim()
      const baseUrl = document.getElementById('pv-base').value.trim()
      const apiKey = document.getElementById('pv-key').value
      if (!name || !model || !baseUrl) throw new Error('名称、模型和接口地址不能为空')
      const capabilities = document.getElementById('pv-vision').checked ? ['vision'] : []
      const transcriptionModel = document.getElementById('pv-trans').value.trim()
      const result = await api.ai.saveProvider({ index: index >= 0 ? index : undefined, name, model, baseUrl, apiKey, capabilities, transcriptionModel })
      S.data.providers = result.providers
      S.providerEditing = null
      showNotice('模型已保存')
      render()
    })
  },
  async 'provider-test'({ index }, btn) {
    await run(btn, async () => {
      const result = await api.ai.testProvider(index)
      showNotice(result?.ok ? '连接成功' : `测试失败：${result?.message || '未知错误'}`, result?.ok ? 'ok' : 'err')
    })
  },
  async 'provider-primary'({ name }) {
    const result = await api.ai.setPrimaryProvider(name)
    S.data.providers = result.providers
    showNotice(`${name} 已设为主模型`)
    render()
  },
  async 'provider-delete'({ name }) {
    if (!confirm(`删除模型 ${name}？`)) return
    const result = await api.ai.deleteProvider(name)
    S.data.providers = result.providers
    render()
  },
  async 'account-add'() {
    if (!confirm('添加一个新账号？添加后请在登录窗口扫码登录。')) return
    resetSelfProfileUi()
    const result = await api.accounts.add()
    S.accounts = { active: result.active, accounts: result.accounts }
    S.data = await api.automation.getState()
    render()
  },
  async 'account-switch'({ id }) {
    const epoch = beginAccountUiTransition(id)
    const result = await api.accounts.switch(id).catch(async error => { if (S.accountEpoch === epoch) { S.accountSwitching = false; await loadAll() }; throw error })
    if (S.accountEpoch !== epoch) return
    const accounts = await api.accounts.list()
    if (S.accountEpoch !== epoch || accounts.active !== id) return
    S.accounts = accounts
    S.data = result.state
    S.accountSwitching = false
    S.selected = ''
    S.selectedContactId = ''
    S.showCachedConversations = false
    S.contactSearch = ''
    S.discovery = { selected: '', filter: 'pending', busy: false, notes: {} }
    S.library = {
    busy: false, data: null, message: '', intro: null, learning: null, learningBusy: false, learningMessage: '', evaluation: null,
    collecting: false, collectorMessage: '', review: [], skipped: [], fixKey: '', analyzeMessage: '', advanced: false,
    favoritesBusy: false, favoritesMessage: '', pipelineBusy: false, pipelineMessage: '',
    scheduler: null, schedulerBusy: false, schedulerMessage: '', candidateStats: null,
    benchmark: null, benchmarkEvaluation: null, benchmarkReference: null, benchmarkBusy: false, benchmarkMessage: '', benchmarkOffset: 0,
  }
    S.contact = { busy: false, config: null, metrics: {}, running: false, paused: false, contactState: {}, drafts: {} }
    if (api.contact?.getState) await refreshContactState(S.accounts.active)
    render()
    batchPoll()
    if (S.section === 'discovery') { loadDiscoveryMode(); loadBatch() }
  },
  async 'account-rename'({ id, name }) {
    const next = await askText('新的账号名称', name)
    if (!next || next === name) return
    const result = await api.accounts.rename(id, next)
    S.accounts = { active: S.accounts.active, accounts: result.accounts }
    render()
  },
  async 'account-logout'({ id }) {
    if (!confirm('退出该账号的抖音登录态？')) return
    await api.accounts.logout(id)
    S.status = await api.douyin.getStatus().catch(() => ({ connected: false }))
    showNotice('已退出登录')
    refreshDynamic()
  },
  async 'account-wipe'({ id }) {
    if (!confirm('删除该账号的全部数据（登录态、联系人、学习数据）？此操作不可恢复！')) return
    const result = await api.accounts.wipe(id)
    S.accounts = { active: result.active, accounts: result.accounts }
    S.data = await api.automation.getState()
    render()
  },
  // ---- 训练场 ----
  async 'train-new-contact'(args, btn) {
    await run(btn, async () => {
      const name = await askText('训练对象名称（虚拟联系人，不会真的发消息）', '训练·朋友')
      if (!name) return
      S.train.name = name
      S.train.log = []
      S.train.draft = null
      await api.trainLearn({ name, relationship: '训练对象' }).catch(() => null)
      S.data = await api.automation.getState()
      render()
    })
  },
  async 'train-incoming'(args, btn) {
    await run(btn, async () => {
      const text = document.getElementById('train-incoming')?.value.trim()
      if (!text) throw new Error('先输入对方要说的消息')
      S.train.log.push({ role: 'contact', text })
      S.train.lastIncoming = text
      S.train.draft = null
      const r = await api.trainLearn({ name: S.train.name, incoming: text })
      if (r?.historyCount !== undefined) {
        const contact = (S.data.contacts || []).find((c) => c.name === S.train.name)
        if (contact) contact.learning = contact.learning || {}
      }
      render()
      document.getElementById('train-incoming')?.focus()
    })
  },
  async 'train-draft'(args, btn) {
    await run(btn, async () => {
      const incoming = S.train.lastIncoming
      if (!incoming) throw new Error('先输入对方发的消息')
      const contact = (S.data.contacts || []).find((c) => c.name === S.train.name) || { id: S.train.name, name: S.train.name, profile: { relationship: '训练对象' }, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] } }
      const result = await api.ai.draft({ contact, incoming })
      if (result?.skipped) { showNotice(result.rejected ? 'AI 拒绝生成' : 'AI 没有生成内容', 'err'); return }
      if (!result?.text) throw new Error(result?.error || 'AI 没有返回内容')
      S.train.draft = result.text
      S.train.log.push({ role: 'ai', text: result.text })
      render()
    })
  },
  async 'train-learn'(args, btn) {
    await run(btn, async () => {
      const edited = document.getElementById('train-draft')?.value.trim()
      if (!edited) throw new Error('内容为空')
      const r = await api.trainLearn({ name: S.train.name, incoming: S.train.lastIncoming, userText: edited })
      S.train.log.push({ role: 'me', text: edited, learned: true })
      S.train.draft = null
      S.data = await api.automation.getState()
      render()
      showNotice(`已学习 ✓（样例 ${r?.examplesCount ?? '?'} 条 · 风格：${r?.styleSummary || '积累中'}）`)
    })
  },
  async 'train-accept'(args, btn) {
    await run(btn, async () => {
      const draft = document.getElementById('train-draft')?.value.trim()
      if (!draft) throw new Error('内容为空')
      await api.trainLearn({ name: S.train.name, acceptAiText: draft })
      S.train.log.push({ role: 'me', text: draft, learned: false })
      S.train.draft = null
      render()
      showNotice('已采用（语气未学习——AI 原文不进风格统计）')
    })
  },
  async 'train-redraft'(args, btn) {
    await run(btn, async () => {
      const incoming = S.train.lastIncoming
      if (!incoming) throw new Error('先输入对方发的消息')
      const contact = (S.data.contacts || []).find((c) => c.name === S.train.name) || { id: S.train.name, name: S.train.name, profile: { relationship: '训练对象' }, learning: { messages: [], facts: [], topicLog: [], mediaLog: [] } }
      const result = await api.ai.draft({ contact, incoming })
      if (!result?.text) throw new Error(result?.error || 'AI 没有返回内容')
      S.train.draft = result.text
      S.train.log.push({ role: 'ai', text: result.text })
      render()
    })
  },

  async 'test-weather'(args, btn) {
    await run(btn, async () => {
      const input = document.getElementById('setting-weather-city')
      const city = (input ? input.value : (S.data?.settings?.weatherCity || '')).trim()
      showNotice(city ? `正在查询「${city}」天气...` : '正在查询当前定位天气...')
      const res = await api.ai.getWeather(city)
      if ((res?.success || res?.ok) && res.text) {
        S.weatherPreview = `实时天气：${res.text}`
        showNotice(`获取成功：${res.text}`)
      } else {
        S.weatherPreview = `获取失败：${res?.error || '无法解析天气'}`
        showNotice(S.weatherPreview, 'err')
      }
      render()
    })
  },

  async 'check-update'(args, btn) {
    await run(btn, async () => {
      const result = await api.checkUpdate()
      showNotice(result?.hasUpdate ? `发现新版本 ${result.latestVersion}，请到 GitHub 下载` : '当前已是最新版本')
    })
  },
}

// 轻量文本输入弹层（Electron 不支持 window.prompt）
function askText(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:99'
    overlay.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;width:360px">
      <div style="margin-bottom:8px;font-weight:600">${esc(title)}</div>
      <input id="asktext-input" style="width:100%;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:7px 9px" value="${esc(defaultValue)}" />
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button class="btn" id="asktext-cancel">取消</button>
        <button class="btn primary" id="asktext-ok">确定</button>
      </div>
    </div>`
    document.body.appendChild(overlay)
    const input = overlay.querySelector('#asktext-input')
    input.focus(); input.select()
    const close = (value) => { overlay.remove(); resolve(value) }
    overlay.querySelector('#asktext-ok').onclick = () => close(input.value.trim())
    overlay.querySelector('#asktext-cancel').onclick = () => close(null)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim()); if (e.key === 'Escape') close(null) })
  })
}

// 关注并发第一句的确认弹层：必须让用户看清对象和正文后，才允许真正关注与发送。
function askApproach({ name, comment, text }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:99'
    overlay.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;width:440px">
      <div style="margin-bottom:8px;font-weight:600">关注并发第一句</div>
      <p class="muted" style="overflow-wrap:anywhere">对象：<b style="color:#333">${esc(name)}</b></p>
      <p class="muted" style="margin-top:4px;overflow-wrap:anywhere">对方评论：${esc(comment || '（未记录）')}</p>
      <div class="field" style="margin-top:10px"><label>将发送的第一句（可修改，1～80字）</label>
        <textarea id="approach-text" maxlength="80" style="width:100%;min-height:72px;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:7px 9px">${esc(text)}</textarea></div>
      <p class="muted" style="margin-top:6px">确认后会关注该主页，并以私信发送这句话；只针对这一个人，不会群发。</p>
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button class="btn" id="approach-cancel">取消</button>
        <button class="btn primary" id="approach-ok">确认关注并发送</button>
      </div>
    </div>`
    document.body.appendChild(overlay)
    const area = overlay.querySelector('#approach-text')
    if (area) { area.focus(); area.select() }
    const close = (value) => { overlay.remove(); resolve(value) }
    overlay.querySelector('#approach-ok').onclick = () => {
      const value = String(area?.value || '').trim()
      if (!value) return
      close(value)
    }
    overlay.querySelector('#approach-cancel').onclick = () => close(null)
    area?.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null) })
  })
}

// 记忆写入预览：真人填完结果后先看清将要写入哪段关系的哪些字段，再确认落盘
function askWriteback(preview) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:99'
    const fieldRow = (label = '', value = '') => `<div class="row" data-field style="margin-bottom:6px">
      <input class="wb-label" style="width:110px;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:6px 8px" value="${esc(label)}" placeholder="字段" />
      <input class="wb-value" style="flex:1;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:6px 8px" value="${esc(value)}" placeholder="内容" />
    </div>`
    const rows = (preview.fields || []).map(field => fieldRow(field.label, field.value)).join('')
    overlay.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;width:480px;max-height:82vh;overflow:auto">
      <div style="font-weight:600;margin-bottom:6px">确认写入记忆</div>
      <p class="muted" style="margin-bottom:10px">这条承诺的完成结果只会写进「${esc(preview.contactName)}」这段关系，不会写入其他联系人，也不会进入全局 Core Self。</p>
      <div class="panel" style="margin:0 0 10px"><h3>承诺</h3><p style="overflow-wrap:anywhere">${esc(preview.promise?.summary || '')}</p>
        <p class="muted" style="margin-top:6px">结果原文：${esc(preview.text)}</p></div>
      <div class="panel" style="margin:0 0 10px"><h3>将写入的结构化字段</h3>
        <div id="wb-fields">${rows || '<p class="muted">未识别出结构化字段，只保存结果原文</p>'}</div>
        <button class="btn small" id="wb-add" style="margin-top:6px">添加字段</button>
        <p class="muted" style="margin-top:6px">字段可以改标签或删掉，确认后按这里的内容写入。</p></div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn" id="wb-cancel">取消</button>
        <button class="btn primary" id="wb-ok">确认写入</button>
      </div>
    </div>`
    document.body.appendChild(overlay)
    const collect = () => [...overlay.querySelectorAll('[data-field]')]
      .map(row => ({ label: row.querySelector('.wb-label').value.trim(), value: row.querySelector('.wb-value').value.trim() }))
      .filter(field => field.label && field.value).slice(0, 8)
    const close = (value) => { overlay.remove(); resolve(value) }
    overlay.querySelector('#wb-add').onclick = () => {
      const box = overlay.querySelector('#wb-fields')
      if (box.querySelector('.muted')) box.innerHTML = ''
      box.insertAdjacentHTML('beforeend', fieldRow())
    }
    overlay.querySelector('#wb-ok').onclick = () => close({ text: preview.text, fields: collect() })
    overlay.querySelector('#wb-cancel').onclick = () => close(null)
  })
}

// 异步动作包装：执行期间禁用按钮
async function run(btn, fn) {
  if (btn) btn.disabled = true
  try {
    await fn()
  } catch (error) {
    showNotice(error.message || String(error), 'err')
  } finally {
    if (btn) btn.disabled = false
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]')
  if (!target || target.disabled) return
  const action = ACTIONS[target.dataset.act] || BATCH_ACTIONS[target.dataset.act]
  if (!action) return
  let args = {}
  try { args = target.dataset.args ? JSON.parse(target.dataset.args) : {} } catch { args = {} }
  Promise.resolve(action(args, target)).catch((error) => showNotice(error.message || String(error), 'err'))
})

// 设置项自动保存（data-path）
document.addEventListener('change', async (event) => {
  const el = event.target
  if (rememberSelfProfileField(el)) return
  if (el.matches('[data-contact-config]')) {
    S.contact.drafts[el.dataset.contactConfig] = el.dataset.contactConfig === 'enabled' ? el.value === 'on' : el.value
    return
  }
  if (el.matches('#discovery-brain-filter')) {
    S.discovery.brainFilter = el.value
    patchContainer('discovery-candidates', discoveryListView())
    return
  }
  if (el.matches('#review-gender-filter')) {
    S.library.genderFilter = ['female', 'male'].includes(el.value) ? el.value : 'any'
    try { localStorage.setItem('review-gender-filter', S.library.genderFilter) } catch { /* 本地记忆失败不影响筛选 */ }
    patchContainer('review-queue', () => reviewQueueView())
    const pending = S.library.review?.length ? S.library.review : (S.library.learning?.pending || [])
    // 选了男或女就自动开始核验，免得多点一次；选中后列表只会出现该性别且已核验的作者。
    if (S.library.genderFilter !== 'any' && !S.library.verifying && pending.some(sample => !sample.authorGender)) ACTIONS['verify-genders']()
    return
  }
  if (el.matches('#discovery-gender-confirmation')) {
    S.discovery.genders ||= {}
    S.discovery.genders[el.dataset.candidateId] = el.value
    return
  }
  if (el.matches('#discovery-filter')) {
    S.discovery.filter = el.value
    patchContainer('discovery-candidates', discoveryListView())
    return
  }
  if (el.matches('[data-library-video]') || el.matches('[data-library-comment]')) {
    const type = el.matches('[data-library-video]') ? 'video' : 'comment'
    const key = el.dataset.libraryVideo || el.dataset.libraryComment
    if (!el.value || !key) return
    const account = S.accounts.active
    S.library.busy = true
    try {
      const result = await api.library.review({ type, key, label: el.value })
      if (S.accounts.active !== account) return
      if (!result?.ok) throw new Error(result?.error || '标注保存失败')
      if (result.library) S.library.data = result.library
      S.library.message = '人工标注已保存'
      showNotice('人工标注已保存')
    } catch (error) { if (S.accounts.active === account) showNotice(error.message || String(error), 'err') }
    finally { S.library.busy = false; if (S.accounts.active === account) patchContainer('library-body', () => libraryBodyView()) }
    return
  }
  if (el.matches('[data-learning-intent]')) {
    const key = el.dataset.learningIntent
    if (!el.value || !key) return
    const oldValue = el.value
    el.disabled = true
    await learningAnnotate(key, { intent: el.value, reason: '人工修改 AI 分类' }, '人工修改已保存，后续模型不会覆盖')
    el.disabled = false
    if (!S.library.learningMessage) el.value = oldValue
    return
  }
  if (el.matches('[data-learning-training]') || el.matches('[data-learning-eval]')) {
    const key = el.dataset.learningTraining || el.dataset.learningEval
    const isTraining = el.matches('[data-learning-training]')
    if (!key) return
    const sample = learningSampleOf(key)
    const intent = sample?.human?.intent || sample?.ai?.intent
    if (!intent) { el.checked = !el.checked; showNotice('请先标注这条评论的意愿，再划分用途', 'err'); return }
    el.disabled = true
    await learningAnnotate(key, isTraining
      ? { intent, reason: '人工调整：用作训练案例', useForTraining: el.checked, independentEval: el.checked ? false : sample.independentEval }
      : { intent, reason: '人工调整：划入独立评估集', independentEval: el.checked, useForTraining: el.checked ? false : sample.useForTraining },
      isTraining ? '训练案例标记已保存' : '独立评估集标记已保存')
    el.disabled = false
    return
  }
  if (el.matches('#library-file')) {
    const file = el.files?.[0]
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { showNotice('素材文件超过 8MB，请拆分后再导入', 'err'); return }
    const text = await file.text()
    const account = S.accounts.active
    S.library.busy = true
    try {
      const result = await api.library.import({ text, filename: file.name })
      if (S.accounts.active !== account) return
      if (!result?.ok) throw new Error(result?.error || '导入失败')
      if (result.library) S.library.data = result.library
      const log = result.log || {}
      S.library.message = `导入 ${log.filename || file.name}：新增视频 ${log.addedVideos || 0}，新增评论 ${log.addedComments || 0}，重复 ${(log.duplicateVideos || 0) + (log.duplicateComments || 0)}，无效 ${log.invalid || 0}`
      showNotice('素材已导入')
    } catch (error) {
      if (S.accounts.active === account) S.library.message = error.message || String(error)
      showNotice(error.message || String(error), 'err')
    } finally { S.library.busy = false; el.value = ''; if (S.accounts.active === account) patchContainer('library-body', () => libraryBodyView()) }
    return
  }
  // 账号切换
  if (el.id === 'show-cached-conversations') {
    S.showCachedConversations = el.checked
    if (!selectedConversation()) { S.selected = ''; S.selectedContactId = '' }
    render(); return
  }
  if (el.id === 'opening-mode') {
    S.discovery.openingModeDraft = el.value
    const panel = document.getElementById('opening-requirements-panel')
    if (panel) panel.outerHTML = openingRequirementsView()
    return
  }
  if (el.matches('[data-act-change="switch-account"]')) {
    ACTIONS['account-switch']({ id: el.value })
    return
  }
  if (el.matches('#train-contact')) {
    S.train.name = el.value
    S.train.log = []
    S.train.draft = null
    render()
    return
  }
  if (el.matches('#log-type')) { S.logFilter.type = el.value; patchContainer('logs-list', logsList()); return }
  if (!el.matches('[data-path]')) return
  const path = el.dataset.path
  let value = el.value
  if (['settings.incomingBurstQuietWindowMs', 'settings.incomingBurstMaxWindowMs'].includes(path)) {
    const parsed = incomingBurstSetting(path, value, S.data.settings)
    if (parsed.error) { el.value = (S.data.settings[path.split('.').at(-1)] ?? (path.includes('Quiet') ? 4000 : 15000)) / 1000; showNotice(parsed.error, 'err'); return }
    value = parsed.value
  }
  if (path === 'automation.maxPerContactDaily') {
    const limit = Number(value)
    if (!Number.isSafeInteger(limit) || limit < 1) { el.value = S.data.automation.maxPerContactDaily ?? 10; showNotice('单联系人上限请填写大于0的整数', 'err'); return }
    value = limit
  }
  if (el.type === 'checkbox') value = el.checked
  else if (el.tagName === 'SELECT') value = value === 'on' ? true : value === 'off' ? false : value
  else if (/^\d+(\.\d+)?$/.test(value) && /Chance|Limit|Interval|Minutes|Retention|PerDay/.test(path)) value = Number(value)
  const patch = {}
  setPath(patch, path, value)
  await saveState(patch)
  if (path === 'automation.maxPerContactDailyEnabled') {
    const enabled = S.data.automation.maxPerContactDailyEnabled === true
    el.value = enabled ? 'on' : 'off'
    const limitInput = document.querySelector('[data-path="automation.maxPerContactDaily"]')
    if (limitInput) limitInput.disabled = !enabled
  }
})

// 文本输入实时过滤（只刷新列表容器，不打断输入）
document.addEventListener('input', (event) => {
  const el = event.target
  if (el.id === 'fixed-opening-text') { S.discovery.fixedOpeningDraft = el.value; return }
  if (el.id === 'opening-requirements') { S.discovery.openingRequirementsDraft = el.value; return }
  if (el.id === 'self-introduction') { selfProfileUi().introduction = el.value; return }
  // 批次卡片的首句：输入即落内存，轮询重建卡片时按这份内容回填，不丢用户编辑。
  if (el && typeof el.id === 'string' && el.id.startsWith('batch-text-')) {
    el.dataset.dirty = '1'
    batchState().texts[batchTextKey(el.id.slice('batch-text-'.length))] = el.value
    return
  }
  if (rememberSelfProfileField(el)) return
  if (el.matches('[data-contact-template]')) { S.contact.drafts.templates ||= {}; S.contact.drafts.templates[el.dataset.contactTemplate] = el.value; return }
  if (el.matches('[data-contact-config]')) { S.contact.drafts[el.dataset.contactConfig] = el.dataset.contactConfig === 'enabled' ? el.value === 'on' : el.value; return }
  if (el.matches('#discovery-age-confirmation')) { S.discovery.ages ||= {}; S.discovery.ages[el.dataset.candidateId] = el.value; return }
  if (el.matches('#discovery-requirements')) { S.discovery.requirementsText = el.value; return }
  if (el.matches('#discovery-video-tags')) { S.discovery.videoTagsText = el.value; return }
  if (el.matches('#discovery-video-keywords')) { S.discovery.videoKeywordsText = el.value; return }
  if (el.matches('#discovery-note')) {
    S.discovery.notes[el.dataset.candidateId] = el.value
    return
  }
  if (el.matches('#library-intro-text')) {
    if (S.library.intro) S.library.intro.text = el.value
    return
  }
  if (el.matches('#contact-search')) {
    S.contactSearch = el.value
    patchContainer('contact-list-scroll', contactListItems())
    return
  }
  if (el.matches('#log-keyword')) {
    S.logFilter.keyword = el.value
    patchContainer('logs-list', logsList())
    return
  }
  if (el.matches('#pv-base')) { queueBasePreview(); return }
})

// 接口地址 / API Key 失焦后自动拉取模型列表（防抖，不打断输入）
let modelAutoTimer = null
document.addEventListener('focusout', (event) => {
  const el = event.target
  if (!el || !el.matches || !el.matches('#pv-base, #pv-key')) return
  const baseUrl = (document.getElementById('pv-base')?.value || '').trim()
  const key = document.getElementById('pv-key')?.value || ''
  if (!baseUrl) return
  // 没有 Key、也不是编辑已有模型（可用已存 Key）时不自动拉取，避免无谓报错
  if (!key && !(S.providerEditing >= 0)) return
  clearTimeout(modelAutoTimer)
  modelAutoTimer = setTimeout(() => { ACTIONS['provider-fetch-models']({}, null) }, 400)
})

function setPath(root, path, value) {
  const keys = path.split('.')
  let node = root
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!node[keys[i]] || typeof node[keys[i]] !== 'object') node[keys[i]] = {}
    node = node[keys[i]]
  }
  node[keys.at(-1)] = value
}

function incomingBurstSetting(path, value, settings = {}) {
  const seconds = String(value).trim() === '' ? NaN : Number(value)
  const isQuiet = path === 'settings.incomingBurstQuietWindowMs'
  const limit = isQuiet ? 15 : 60
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > limit) return { error: `请填写 1～${limit} 秒之间的等待时间` }
  const milliseconds = Math.round(seconds * 1000)
  const quiet = isQuiet ? milliseconds : Number(settings.incomingBurstQuietWindowMs ?? 4000)
  const maximum = isQuiet ? Number(settings.incomingBurstMaxWindowMs ?? 15000) : milliseconds
  if (maximum < quiet) return { error: '最长聚合时间不能小于停顿等待时间' }
  return { value: milliseconds }
}

loadAll()
