// A single favorites run owns its waits. Aborted/late work cannot start another
// stage, click, navigation or progress write after the user stops that run.
class FavoritesOperation {
  constructor() {
    this.controller = new AbortController()
    this.started = Date.now(); this.phaseStarted = this.started; this.phase = '正在准备收藏夹同步'; this.timings = []
  }
  assertCurrent() { if (this.controller.signal.aborted) throw Object.assign(new Error('收藏夹同步已停止'), { code: 'STOPPED' }) }
  setPhase(phase) {
    this.assertCurrent()
    if (phase === this.phase) return
    this.timings.push({ phase: this.phase, ms: Date.now() - this.phaseStarted })
    this.timings = this.timings.slice(-20); this.phase = phase; this.phaseStarted = Date.now()
  }
  diagnostics() { return { phaseStartedAt: new Date(this.phaseStarted).toISOString(), elapsedMs: Date.now() - this.started, stageTimings: [...this.timings, { phase: this.phase, ms: Date.now() - this.phaseStarted }].slice(-20) } }
  async run(fn, { timeoutMs = 6000, code = 'FAVORITES_STAGE_TIMEOUT' } = {}) {
    this.assertCurrent()
    let timer, onAbort
    try {
      return await Promise.race([
        Promise.resolve().then(() => { this.assertCurrent(); return fn() }),
        new Promise((_, reject) => {
          const fail = () => reject(Object.assign(new Error('收藏夹同步已停止'), { code: 'STOPPED' }))
          onAbort = fail; this.controller.signal.addEventListener('abort', onAbort, { once: true })
          timer = setTimeout(() => reject(Object.assign(new Error(`${this.phase}超过 ${Math.round(timeoutMs / 1000)} 秒等待上限`), { code, phase: this.phase })), timeoutMs)
        }),
      ])
    } finally { clearTimeout(timer); if (onAbort) this.controller.signal.removeEventListener('abort', onAbort) }
  }
  wait(ms) {
    this.assertCurrent()
    return new Promise((resolve, reject) => {
      const finish = fn => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', onAbort); fn() }
      const onAbort = () => finish(() => reject(Object.assign(new Error('收藏夹同步已停止'), { code: 'STOPPED' })))
      const timer = setTimeout(() => finish(resolve), ms)
      this.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  cancel() { this.controller.abort() }
}
module.exports = { FavoritesOperation }
