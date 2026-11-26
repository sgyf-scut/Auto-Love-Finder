// P2-14D 动作适配层：validate → prepare → execute → verify → record。
// 本阶段只提供 Mock 与 Dry Run 适配器；真实外发适配器必须另行实现并取得平台权限与对方许可。
// 适配器本身不读页面、不点关注、不发消息；真实副作用只能出现在显式注入的 execute 实现里。
const ADAPTER_VERSION = 'P2-14.1'
const HARD_STOP_CODES = new Set(['PERMISSION_DENIED', 'CHALLENGE_REQUIRED', 'RATE_LIMITED', 'LOGIN_REQUIRED', 'ACCESS_RESTRICTED'])
const ADAPTER_NAMES = ['mock', 'dryRun']
const clean = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : ''

function taskKey(task = {}) {
  return clean(task.taskId, 120) || `${clean(task.action, 30)}:${clean(task.platformUserId, 120)}`
}

class ActionAdapter {
  constructor(name) { this.name = name; this.version = ADAPTER_VERSION; this.simulated = true }
  async validate() { return { ok: true } }
  async prepare(context) { return { ok: true, prepared: { taskId: taskKey(context?.task) } } }
  async execute() { throw new Error('execute 必须在子类实现；真实适配器不得在本阶段启用') }
  async verify() { return { ok: true, verified: true } }
  async record(context, outcome) {
    return { ok: true, record: { adapter: this.name, action: clean(context?.task?.action, 30), taskId: taskKey(context?.task), platformUserId: clean(context?.task?.platformUserId, 120), status: outcome?.record?.status || 'unknown', simulated: this.simulated, at: new Date().toISOString() } }
  }
  // 统一控制流；任何硬停错误都会阻止后续动作，且不确定结果不允许重试。
  async run(context = {}) {
    const task = context.task || {}
    const key = taskKey(task)
    const executed = context.executed || {}
    const previous = executed[key]
    if (previous?.status === 'done') return { ok: false, status: 'skipped', reasonCode: 'DUPLICATE_TASK', reason: '同一动作已完成，跳过重复执行', adapter: this.name, simulated: this.simulated }
    if (previous?.status === 'uncertain') return { ok: false, status: 'blocked', reasonCode: 'UNCERTAIN_STATE_NO_RETRY', reason: '上次执行结果不确定，禁止盲目重发', adapter: this.name, simulated: this.simulated }
    const validated = await this.validate({ ...context, task })
    if (!validated?.ok) return { ok: false, status: 'blocked', reasonCode: validated?.reasonCode || 'VALIDATION_FAILED', reason: validated?.reason || '', adapter: this.name, simulated: this.simulated, hardStop: HARD_STOP_CODES.has(validated?.reasonCode) }
    const prepared = await this.prepare({ ...context, task })
    if (!prepared?.ok) return { ok: false, status: 'blocked', reasonCode: prepared?.reasonCode || 'PREPARE_FAILED', reason: prepared?.reason || '', adapter: this.name, simulated: this.simulated, hardStop: HARD_STOP_CODES.has(prepared?.reasonCode) }
    let outcome
    try { outcome = await this.execute({ ...context, task, prepared: prepared.prepared || {} }) } catch (error) {
      outcome = { ok: false, reasonCode: 'EXECUTOR_ERROR', reason: clean(error?.message, 300), status: 'uncertain' }
    }
    if (!outcome?.ok) {
      const status = outcome?.status === 'uncertain' || outcome?.reasonCode === 'OUTCOME_UNCERTAIN' || outcome?.reasonCode === 'EXECUTOR_ERROR' ? 'uncertain' : 'failed'
      return { ok: false, status, reasonCode: outcome?.reasonCode || 'EXECUTE_FAILED', reason: outcome?.reason || '', adapter: this.name, simulated: this.simulated, hardStop: HARD_STOP_CODES.has(outcome?.reasonCode), record: (await this.record({ ...context, task }, { record: { status } })).record }
    }
    const verified = await this.verify({ ...context, task, outcome })
    if (!verified?.ok) return { ok: false, status: 'uncertain', reasonCode: 'VERIFY_FAILED', reason: '执行后无法确认结果，停止而不是重试', adapter: this.name, simulated: this.simulated }
    const recorded = await this.record({ ...context, task }, outcome)
    return { ok: true, status: 'done', adapter: this.name, simulated: this.simulated, record: recorded.record, outcome }
  }
}

class DryRunAdapter extends ActionAdapter {
  constructor() { super('dryRun'); this.simulated = true }
  async validate({ task, audit }) {
    if (!task?.platformUserId) return { ok: false, reasonCode: 'MISSING_AUTHOR_ID', reason: '缺少作者 ID' }
    if (audit && audit.action && audit.action.allowed === false && audit.action.reasons?.includes('REJECTED_PROTECTED')) return { ok: false, reasonCode: 'REJECTED_PROTECTED', reason: '已拒绝联系' }
    return { ok: true }
  }
  async execute() { return { ok: true, status: 'dry-run', followed: false, sent: false, dryRun: true } }
}

class MockAdapter extends ActionAdapter {
  constructor(options = {}) {
    super('mock')
    this.simulated = true
    this.plan = Array.isArray(options.outcomes) ? [...options.outcomes] : []
    this.failUntil = Number(options.failUntil) || 0
    this.calls = 0
  }
  async validate({ task, audit, permissionGranted = true }) {
    if (!task?.platformUserId) return { ok: false, reasonCode: 'MISSING_AUTHOR_ID', reason: '缺少作者 ID' }
    if (!permissionGranted) return { ok: false, reasonCode: 'PERMISSION_DENIED', reason: '权限不足' }
    if (audit?.action?.allowed === false && audit.action.reasons?.includes('REJECTED_PROTECTED')) return { ok: false, reasonCode: 'REJECTED_PROTECTED', reason: '已拒绝联系' }
    return { ok: true }
  }
  async execute() {
    this.calls++
    if (this.failUntil && this.calls <= this.failUntil) return { ok: false, reasonCode: 'RATE_LIMITED', reason: '模拟限频' }
    const next = this.plan.shift()
    if (next === 'uncertain') return { ok: false, reasonCode: 'OUTCOME_UNCERTAIN', reason: '模拟结果不确定', status: 'uncertain' }
    if (next === 'fail') return { ok: false, reasonCode: 'EXECUTE_FAILED', reason: '模拟执行失败' }
    return { ok: true, followed: true, sent: true, mock: true }
  }
}

function createActionAdapter(name = 'dryRun', options = {}) {
  if (name === 'dryRun' || name === 'dry-run' || name === 'DryRun') return new DryRunAdapter(options)
  if (name === 'mock' || name === 'Mock') return new MockAdapter(options)
  throw new Error(`未支持的动作适配器：${name}；本阶段只允许 mock/dryRun`)
}

module.exports = {
  ADAPTER_VERSION, HARD_STOP_CODES, ADAPTER_NAMES,
  ActionAdapter, DryRunAdapter, MockAdapter, createActionAdapter, taskKey,
}
