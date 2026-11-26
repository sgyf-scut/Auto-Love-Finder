// P2-15：调查 Windows 上间歇性 EPERM（rename 覆盖目标文件被占用），用可复现的方式验证重试与兜底。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { writeFileAtomicSync } = require('../electron/atomic-write.cjs')

function withRenameFailure(failures, run) {
  const original = fs.renameSync
  let calls = 0
  fs.renameSync = (from, to) => {
    calls++
    if (calls <= failures) {
      const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`)
      error.code = 'EPERM'
      throw error
    }
    return original(from, to)
  }
  try { return { result: run(), calls: () => calls } } finally { fs.renameSync = original }
}

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p215-atomic-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'state.json') }
}

test('P2-15-20 原子写入正常路径不留临时文件', t => {
  const { dir, file } = tempFile(t)
  const result = writeFileAtomicSync(file, '{"a":1}')
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 1)
  assert.equal(result.fallback, false)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
})

test('P2-15-21 rename 短暂 EPERM 后自动重试成功', t => {
  const { file } = tempFile(t)
  const { result, calls } = withRenameFailure(2, () => writeFileAtomicSync(file, '{"retry":true}', { delay: 1 }))
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 3)
  assert.equal(result.fallback, false)
  assert.equal(calls(), 3)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"retry":true}')
})

test('P2-15-22 持续被占用时降级复制写入，不丢更新也不留临时文件', t => {
  const { dir, file } = tempFile(t)
  fs.writeFileSync(file, '{"old":true}')
  const { result } = withRenameFailure(99, () => writeFileAtomicSync(file, '{"new":true}', { retries: 2, delay: 1 }))
  assert.equal(result.ok, true)
  assert.equal(result.fallback, true)
  assert.equal(result.code, 'EPERM')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}')
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
})

test('P2-15-23 非重试类错误直接抛出，不掩盖真实问题', t => {
  const { file } = tempFile(t)
  const original = fs.renameSync
  fs.renameSync = () => { const error = new Error('ENOSPC'); error.code = 'ENOSPC'; throw error }
  try { assert.throws(() => writeFileAtomicSync(file, '{}', { retries: 1, delay: 1 }), /ENOSPC/) } finally { fs.renameSync = original }
})

test('P2-15-24 主状态存储在瞬时 EPERM 下仍能完成写入', t => {
  const { JsonStorage } = require('../electron/storage.cjs')
  const { dir } = tempFile(t)
  const file = path.join(dir, 'account', 'state.json')
  const storage = new JsonStorage(file)
  const patches = withRenameFailure(1, () => storage.update({ selfPersona: { ...storage.get().selfPersona, name: '网络波动' } }))
  assert.equal(patches.result.selfPersona.name, '网络波动')
  const reopened = new JsonStorage(file)
  assert.equal(reopened.get().selfPersona.name, '网络波动')
})

test('P2-15-25 并发写入使用不同临时文件名，不互相覆盖', t => {
  const { dir, file } = tempFile(t)
  const before = fs.readdirSync(dir).length
  writeFileAtomicSync(file, '{"v":1}')
  writeFileAtomicSync(file, '{"v":2}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}')
  assert.equal(fs.readdirSync(dir).length, before + 1)
})
