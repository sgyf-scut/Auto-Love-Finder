const { AsyncLocalStorage } = require('node:async_hooks')

// One lease per service/account. Nested sends made by a polling round reuse its
// lease; detached timers cannot reuse an owner once that round has finished.
class ChatWindowCoordinator {
  constructor({ timeoutMs = 120000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.scope = new AsyncLocalStorage()
    this.timeoutMs = timeoutMs
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.queue = []
    this.owner = null
    this.closed = false
  }

  current() {
    const owner = this.scope.getStore()
    return owner?.active ? owner : null
  }

  assertActive() {
    const owner = this.scope.getStore()
    // A successful round may have launched legitimate deferred memory work.
    // Only a revoked lease is forbidden from resuming after its deadline.
    if (owner?.revoked) throw owner.error
    return owner
  }

  run(kind, operation, { timeoutMs = this.timeoutMs, onTimeout } = {}) {
    try {
      this.assertActive()
      if (this.closed) throw this.expiredError(kind, '聊天窗口服务已停止')
      if (this.current()) return Promise.resolve().then(operation)
    } catch (error) { return Promise.reject(error) }
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, operation, timeoutMs, onTimeout, resolve, reject })
      this.pump()
    })
  }

  expiredError(kind, message = '聊天窗口操作已超时，旧任务已失效') {
    const error = new Error(message)
    error.code = kind === 'automation' ? 'AUTOMATION_ROUND_TIMEOUT' : 'CHAT_WINDOW_LEASE_EXPIRED'
    error.sendAttempted = false
    return error
  }

  pump() {
    if (this.owner || this.closed) return
    const task = this.queue.shift()
    if (!task) return
    const owner = { kind: task.kind, active: true, revoked: false, stage: 'starting', task }
    this.owner = owner
    owner.timer = this.setTimer(() => {
      if (this.owner !== owner || !owner.active) return
      owner.revoked = true
      owner.error = this.expiredError(owner.kind)
      // Recovery must finish before another lease is allowed to select or send.
      // Execute it outside the revoked AsyncLocalStorage context.
      this.scope.exit(() => {
        try { task.onTimeout?.(owner) }
        catch (error) { owner.error.recoveryError = error.message }
        this.finish(owner, owner.error)
      })
    }, Math.max(1, Number(task.timeoutMs) || this.timeoutMs))
    this.scope.run(owner, () => Promise.resolve().then(task.operation))
      .then(value => this.finish(owner, null, value), error => this.finish(owner, error))
  }

  finish(owner, error, value) {
    if (!owner.active) return // A late completion must not release a newer lease.
    owner.active = false
    this.clearTimer(owner.timer)
    if (this.owner === owner) this.owner = null
    if (error) owner.task.reject(error)
    else owner.task.resolve(value)
    this.pump()
  }

  close() {
    this.closed = true
    if (this.owner) {
      const owner = this.owner
      owner.revoked = true
      owner.error = this.expiredError(owner.kind, '聊天窗口服务已停止，旧任务已失效')
      this.finish(owner, owner.error)
    }
    for (const task of this.queue.splice(0)) task.reject(this.expiredError(task.kind, '聊天窗口服务已停止'))
  }
}

function chatWindowDeferred(name = '') {
  const error = new Error('抖音窗口正在由本人操作，其他会话暂缓，隐藏窗口后恢复')
  error.code = 'CHAT_WINDOW_MANUAL_CONTROL'
  error.nameOfContact = name
  error.sendAttempted = false
  return error
}

module.exports = { ChatWindowCoordinator, chatWindowDeferred }
