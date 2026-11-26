const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMemoryStorage } = require('./setup.cjs')
const { DouyinService } = require('../electron/automation.cjs')
const { migrateLegacy } = require('../electron/storage.cjs')
const now = new Date('2026-10-10T12:00:00+08:00')
const history = count => Array.from({ length: count }, () => ({ name: '朋友', at: now.toISOString(), kind: 'text' }))

test('disabled or absent contact-limit switch ignores stored cap, keeping global daily limit', () => {
  for (const maxPerContactDailyEnabled of [false, undefined]) {
    const storage = createMemoryStorage({ automation: { dailyLimit: 20, maxPerContactDaily: 1, maxPerContactDailyEnabled }, sendHistory: history(15) })
    const service = new DouyinService({ storage, ai: {} })
    assert.equal(service.getSendAllowance('朋友', now).ok, true)
    storage.update({ sendHistory: history(20) })
    assert.match(service.getSendAllowance('朋友', now).reason, /达到每日上限 20 条/)
  }
})

test('enabled contact limit uses manual quantity and can be changed or switched off', () => {
  const storage = createMemoryStorage({ automation: { dailyLimit: 50, maxPerContactDaily: 10, maxPerContactDailyEnabled: true }, sendHistory: history(10) })
  const service = new DouyinService({ storage, ai: {} })
  assert.match(service.getSendAllowance('朋友', now).reason, /单联系人上限 10 条/)
  assert.equal(service.getSendAllowance('其他朋友', now).ok, true)
  storage.update({ automation: { maxPerContactDaily: 15 } })
  assert.equal(service.getSendAllowance('朋友', now).ok, true)
  storage.update({ automation: { maxPerContactDaily: 5 } })
  assert.equal(service.getSendAllowance('朋友', now).ok, false)
  storage.update({ automation: { maxPerContactDailyEnabled: false } })
  assert.equal(service.getSendAllowance('朋友', now).ok, true)
  assert.equal(storage.get().automation.maxPerContactDaily, 5)
})

test('migration defaults contact limit off and preserves manually enabled settings and history', () => {
  const migrated = migrateLegacy({ automation: { dailyLimit: 20, maxPerContactDaily: 17 }, sendHistory: history(12) })
  assert.equal(migrated.automation.maxPerContactDailyEnabled, false)
  assert.equal(migrated.automation.maxPerContactDaily, 17)
  assert.equal(migrated.sendHistory.length, 12)
  const enabled = migrateLegacy({ ...migrated, automation: { ...migrated.automation, maxPerContactDailyEnabled: true } })
  assert.equal(enabled.automation.maxPerContactDailyEnabled, true)
  assert.equal(enabled.automation.dailyLimit, 20)
})
