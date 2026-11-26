const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

// Every order runs in a fresh process: a previously populated require.cache or
// a synthetic event-engine fixture cannot hide a partial startup dependency.
const orders = {
  'real main startup order': ['storage.cjs', 'providers-store.cjs', 'automation.cjs', 'friendship.cjs', 'auto-friendship.cjs',
    'discovery/discovery-engine.cjs', 'contact-engine.cjs', 'video-openings.cjs', 'ai-service.cjs'],
  'automation loaded before storage': ['automation.cjs', 'storage.cjs', 'ai-service.cjs'],
  'AI loaded before automation': ['ai-service.cjs', 'storage.cjs', 'automation.cjs'],
}

for (const [name, order] of Object.entries(orders)) {
  test(`runtime event contract: ${name}`, () => {
    const script = `
      const assert = require('node:assert/strict')
      const path = require('node:path')
      const { createMemoryStorage } = require(${JSON.stringify(path.join(__dirname, 'setup.cjs'))})
      const root = ${JSON.stringify(path.resolve(__dirname, '../electron'))}
      for (const file of ${JSON.stringify(order)}) require(path.join(root, file))
      const memory = require(path.join(root, 'social-brain/memory-manager.cjs'))
      for (const name of ['clean', 'messageList', 'normalizeEvent', 'advanceEventLifecycle', 'relationMetrics', 'summarizeMemory']) {
        assert.equal(typeof memory[name], 'function', 'missing actual startup export: ' + name)
      }
      const { ProactiveEngine, scanDueEvents } = require(path.join(root, 'social-brain/proactive-engine.cjs'))
      const { DouyinService } = require(path.join(root, 'automation.cjs'))
      const now = new Date('2026-10-13T12:00:00+08:00')
      const contact = { id: 'event-contract', name: '虚构事件朋友', profile: { chatMode: 'friendship', aiEnabled: true },
        learning: { messages: [{ id: 'verified-event-source', role: 'contact', text: '我下周一面试', at: '2026-10-10T12:00:00+08:00' }] } }
      contact.socialBrain = memory.syncMemory(contact, { now })
      assert.equal(contact.socialBrain.events.length, 1)
      const candidates = scanDueEvents([contact], now)
      assert.equal(candidates.length, 1, 'a real due event must survive the startup contract')
      assert.equal(candidates[0].type, 'event_followup')
      assert.deepEqual(candidates[0].event.sourceMessageIds, ['verified-event-source'])
      const future = new Date(Date.parse(candidates[0].event.followUpWindow.endAt) + 1)
      const expired = memory.advanceEventLifecycle(contact.socialBrain.events, future)
      assert.equal(expired[0].status, 'stale')
      assert.equal(scanDueEvents([{ ...contact, socialBrain: { ...contact.socialBrain, events: expired } }], future).length, 0)
      const storage = createMemoryStorage({ contacts: [contact], settings: { longTermMemory: true, eventFollowup: { enabled: true }, quietHours: false } })
      const ds = new DouyinService({ storage, partition: 'persist:event-contract', emit() {} })
      const engine = new ProactiveEngine({ storage: ds.storage, douyin: ds, accountId: 'event-contract', clock: () => now })
      ds.eventFollowups = engine
      engine.reconcile(now)
      assert.equal(storage.get().contacts[0].socialBrain.events[0].status, 'due')
      let statusChecks = 0
      ds.getStatus = async () => { statusChecks++; return { connected: false } }
      ds.runAutomation().then(() => {
        assert.equal(statusChecks, 1, 'real runAutomation must get past the event lifecycle preflight')
        ds.destroy()
        console.log(JSON.stringify({ exportsValid: true, dueCandidates: candidates.length, statusChecks }))
      }).catch(error => { ds.destroy(); console.error(error.stack); process.exitCode = 1 })
    `
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    assert.deepEqual(JSON.parse(output.trim()), { exportsValid: true, dueCandidates: 1, statusChecks: 1 })
  })
}
