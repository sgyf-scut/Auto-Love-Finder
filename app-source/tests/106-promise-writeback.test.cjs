const { test } = require('node:test')
const assert = require('node:assert/strict')
const { extractPromiseResult } = require('../electron/social-brain/promise-result-extractor.cjs')
const { normalizePromises, resolvePromise } = require('../electron/social-brain/promise.cjs')
const { extractPromises } = require('../electron/social-brain/promise-extractor.cjs')

const at = (d = 1, m = 0) => `2026-10-${String(d).padStart(2, '0')}T12:${String(m).padStart(2, '0')}:00+08:00`
const now = d => Date.parse(at(d, 59))
const person = (id = 'a') => ({ id, name: `联系人${id}`, profile: {} })
const row = (id, role, text, { d = 1, m = 0, contactId = 'a' } = {}) => ({ id, contactId, role, text, at: at(d, m),
  source: role === 'me' ? 'platform_send_confirmed' : 'platform_observed', ...(role === 'me' ? { confirmedSent: true, status: 'sent' } : {}) })
const pending = (contactId = 'a') => extractPromises({ contact: person(contactId), messages: [row('m1', 'me', '我这两天建个号过去', { contactId })], now: now(1) }).promises.items[0]

test('a server and an account number survive the acceptance-case writeback', () => {
  const { fields } = extractPromiseResult(pending(), '黑色玫瑰，ID 546124')
  assert.deepEqual(fields, [{ label: '账号', value: '546124' }, { label: '区服', value: '黑色玫瑰' }])
})

test('explicit labelled pairs are read as written', () => {
  assert.deepEqual(extractPromiseResult(pending(), '区服：黑色玫瑰，账号：abc123').fields,
    [{ label: '区服', value: '黑色玫瑰' }, { label: '账号', value: 'abc123' }])
  assert.deepEqual(extractPromiseResult(pending(), '服务器:艾欧尼亚').fields, [{ label: '区服', value: '艾欧尼亚' }])
})

test('a bare account token is recognised without any label', () => {
  assert.deepEqual(extractPromiseResult(pending(), '546124').fields, [{ label: '账号', value: '546124' }])
})

test('connector wording such as 叫/是 attaches to the keyword it follows', () => {
  assert.deepEqual(extractPromiseResult(pending(), '名字叫小明').fields, [{ label: '名称', value: '小明' }])
  assert.deepEqual(extractPromiseResult(pending(), '段位是黄金').fields, [{ label: '段位', value: '黄金' }])
})

test('prose with no structure produces no fields instead of guessing', () => {
  for (const text of ['时间不早了', '已经弄好了', '搞定了', '嗯']) {
    assert.deepEqual(extractPromiseResult(pending(), text).fields, [], text)
  }
})

test('an empty or private result never produces a field', () => {
  assert.deepEqual(extractPromiseResult(pending(), '').fields, [])
  assert.deepEqual(extractPromiseResult(pending(), '   ').fields, [])
  assert.deepEqual(extractPromiseResult(pending(), '手机号 13800138000').fields, [])
})

test('one label is written once even when it is repeated', () => {
  assert.deepEqual(extractPromiseResult(pending(), '账号：a1，账号：b2').fields, [{ label: '账号', value: 'a1' }])
})

test('leftover prose becomes an extra field only beside real structure', () => {
  assert.deepEqual(extractPromiseResult(pending(), '已建好，段位是黄金').fields,
    [{ label: '段位', value: '黄金' }, { label: '其他', value: '已建好' }])
})

test('the writeback never exceeds eight fields', () => {
  const text = '账号：a1，x1，x2，x3，x4，x5，x6，x7，x8'
  assert.equal(extractPromiseResult(pending(), text).fields.length, 8)
})

test('topics merge the promise topics with the extracted labels', () => {
  const promise = { ...pending(), topics: ['游戏', '账号'] }
  assert.deepEqual(extractPromiseResult(promise, '黑色玫瑰，ID 546124').topics, ['游戏', '账号', '区服'])
})

test('extracted fields persist onto the promise resolution and survive normalization', () => {
  const stored = extractPromises({ contact: person('a'), messages: [row('m1', 'me', '我这两天建个号过去')], now: now(1) }).promises
  const contact = { ...person('a'), promises: stored }
  const { fields } = extractPromiseResult(stored.items[0], '黑色玫瑰，ID 546124')
  const resolved = resolvePromise(contact, stored.items[0].id, { text: '黑色玫瑰，ID 546124', fields, now: now(3) })
  assert.deepEqual(resolved.items[0].resolution.fields, fields)
  const renormalized = normalizePromises({ ...person('a'), promises: resolved }, { now: now(3) })
  assert.equal(renormalized.items[0].status, 'done')
  assert.deepEqual(renormalized.items[0].resolution.fields, fields)
  assert.equal(renormalized.items[0].resolution.text, '黑色玫瑰，ID 546124')
})

test('a writeback stays scoped to its own contact and never reaches another', () => {
  const storedA = extractPromises({ contact: person('a'), messages: [row('m1', 'me', '我这两天建个号过去')], now: now(1) }).promises
  const resolvedA = resolvePromise({ ...person('a'), promises: storedA }, storedA.items[0].id,
    { text: '黑色玫瑰，ID 546124', fields: extractPromiseResult(storedA.items[0], '黑色玫瑰，ID 546124').fields, now: now(3) })
  assert.equal(resolvedA.items[0].status, 'done')
  assert.deepEqual(normalizePromises(person('b'), { now: now(3) }).items, [])
})

test('a result carrying private data is never written into the resolution', () => {
  const stored = extractPromises({ contact: person('a'), messages: [row('m1', 'me', '我这两天建个号过去')], now: now(1) }).promises
  const contact = { ...person('a'), promises: stored }
  const resolved = resolvePromise(contact, stored.items[0].id, { text: '手机号 13800138000', now: now(3) })
  assert.equal(resolved.items[0].status, 'pending')
  assert.equal(resolved.items[0].resolution, null)
  assert.equal(resolved.revision, stored.revision)
})
