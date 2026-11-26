// P2-16 盲评可用性：60 条必须能被完整翻到，"跳过"不能卡在同一条。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildView } = require('../electron/social-brain/library-benchmark.cjs')

const KEYS = Array.from({ length: 60 }, (_, index) => `k${String(index + 1).padStart(2, '0')}`)
const state = { activeSet: { id: 'bm_test', createdAt: '2026-11-05T00:00:00.000Z', status: 'open', size: 60, requestedSize: 60, keys: KEYS } }
const learning = { samples: KEYS.map(key => ({ key, text: `${key} 的评论原文`, videoTitle: '视频标题' })) }

test('P2-16-30 首批返回 12 条并标明范围', () => {
  const view = buildView(state, learning, { limit: 12, offset: 0 })
  assert.equal(view.queue.length, 12)
  assert.equal(view.queue[0].position, 1)
  assert.equal(view.queue[11].position, 12)
  assert.deepEqual(view.range, { from: 1, to: 12, of: 60 })
  assert.equal(view.offset, 0)
  assert.equal(view.remaining, 60)
})

test('P2-16-31 翻页可以覆盖到第 60 条', () => {
  const seen = new Set()
  for (let offset = 0; offset < 60; offset += 12) {
    const view = buildView(state, learning, { limit: 12, offset })
    for (const item of view.queue) seen.add(item.key)
  }
  assert.equal(seen.size, 60, '五批合计必须覆盖全部 60 条')
})

test('P2-16-32 越界偏移会被收敛，不会返回空队列', () => {
  const view = buildView(state, learning, { limit: 12, offset: 999 })
  assert.equal(view.queue.length, 1, '越界时至少给出最后一条')
  assert.equal(view.queue[0].position, 60)
  assert.equal(view.offset, 59)
  assert.deepEqual(view.range, { from: 60, to: 60, of: 60 })
})

test('P2-16-33 标注后剩余减少，偏移量不会跳过未标注样本', () => {
  const labeled = { samples: learning.samples.map((item, index) => index < 3 ? { ...item, human: { intent: 'ORDINARY', source: 'user' } } : item) }
  const view = buildView(state, labeled, { limit: 12, offset: 0 })
  assert.equal(view.labeled, 3)
  assert.equal(view.remaining, 57)
  assert.equal(view.queue.length, 12)
  assert.equal(view.queue.some(item => ['k01', 'k02', 'k03'].includes(item.key)), false, '已标注的不再出现')
})

test('P2-16-34 跳过后同一条不再占住首位', () => {
  const first = buildView(state, learning, { limit: 12, offset: 0 })
  const skippedKey = first.queue[0].key
  const afterSkip = buildView(state, learning, { limit: 12, offset: 1 })
  assert.notEqual(afterSkip.queue[0].key, skippedKey)
  // 跳过不写标签，所以它仍在剩余队列里，翻回来还能看到。
  const back = buildView(state, learning, { limit: 12, offset: 0 })
  assert.equal(back.queue[0].key, skippedKey)
  assert.equal(back.remaining, 60)
})

test('P2-16-35 盲评队列不含模型分类、置信度与作者身份', () => {
  const view = buildView(state, learning, { limit: 60, offset: 0 })
  const banned = ['intent', 'classification', 'confidence', 'prediction', 'evidence', 'authorId', 'authorName', 'label']
  for (const item of view.queue) for (const field of banned) assert.equal(item[field], undefined, `不应返回 ${field}`)
})
