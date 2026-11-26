// P2-15 原子写入：Windows 上 rename 覆盖目标文件时，杀软/索引/资源管理器可能短暂占用句柄并抛 EPERM。
// 统一改为「唯一临时文件 + 有限退避重试 + 复制兜底」，并保留唯一临时文件名避免并发写互相覆盖。
const fs = require('node:fs')
const path = require('node:path')

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const DEFAULT_RETRIES = 6
const DEFAULT_DELAY = 12
let sequence = 0

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 极端环境不支持时直接继续 */ }
}

function tempNameOf(filePath) {
  sequence += 1
  return `${filePath}.${process.pid}.${sequence}.tmp`
}

function backupNameOf(filePath) {
  return `${filePath}.bak`
}

// 复制文件的稳健实现：语义等同 fs.copyFileSync（字节一致），但对环境更宽容。
// 原因：某些受限环境（沙箱/安全软件/部分网络盘）会允许 rename 而 copyFileSync 直接 EPERM，
// 反过来也有只允许 copy 的。逐层兜底：读内容 → 原子写(rename+重试) → 原生 copy → 都失败才抛。
// 这里不允许原子写再走"复制兜底"，否则两者互相递归。
function copyFileRobustSync(src, dest) {
  let payload
  try {
    payload = fs.readFileSync(src)
  } catch (readError) {
    throw readError
  }
  let firstError = null
  try {
    writeFileAtomicSync(dest, payload, { allowCopyFallback: false })
    if (verifyCopy(dest, payload)) return { ok: true, via: 'atomic', bytes: payload.length }
    firstError = Object.assign(new Error('复制校验失败：目标内容与源不一致'), { code: 'EVERIFY' })
  } catch (error) {
    firstError = error
  }
  try {
    fs.copyFileSync(src, dest)
    if (verifyCopy(dest, payload)) return { ok: true, via: 'copy', bytes: payload.length }
    firstError = Object.assign(new Error('复制校验失败：目标内容与源不一致'), { code: 'EVERIFY' })
  } catch (copyError) {
    if (!firstError) firstError = copyError
  }
  // 最后一级：直接写（非原子，等价于 copy 的覆盖语义；调用方若要可回退会先留备份）。
  // 有些环境 rename 与 copyFileSync 都受限，但普通写仍可用。
  try {
    fs.writeFileSync(dest, payload)
    if (verifyCopy(dest, payload)) return { ok: true, via: 'direct', bytes: payload.length }
    firstError = Object.assign(new Error('直写校验失败：目标内容与源不一致'), { code: 'EVERIFY' })
  } catch (writeError) {
    if (!firstError) firstError = writeError
  }
  throw firstError
}

// 降级复制前的保护：先留一份上一代完整文件，复制失败或进程中断时可以回退。
function preserveBackup(filePath) {
  const backup = backupNameOf(filePath)
  try {
    if (fs.existsSync(filePath)) copyFileRobustSync(filePath, backup)
  } catch { /* 备份失败不阻断写入，但降低可恢复性 */ }
  return backup
}

// 复制后校验：字节长度一致且内容可读回，才认为这次降级写入成功。
function verifyCopy(filePath, expected) {
  const actual = fs.readFileSync(filePath)
  return Buffer.compare(actual, Buffer.isBuffer(expected) ? expected : Buffer.from(expected)) === 0
}

function writeFileAtomicSync(filePath, data, { retries = DEFAULT_RETRIES, delay = DEFAULT_DELAY, encoding = 'utf8', allowCopyFallback = true } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = tempNameOf(filePath)
  fs.writeFileSync(temp, data, encoding)
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding)
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      fs.renameSync(temp, filePath)
      return { ok: true, attempts: attempt + 1, fallback: false, code: null }
    } catch (error) {
      lastError = error
      if (!RETRYABLE_CODES.has(error?.code)) break
      if (attempt < retries) sleepSync(delay * (attempt + 1))
    }
  }
  // 只有"被占用"这类可恢复错误才降级复制覆盖；容量不足等真实错误必须原样抛出。
  if (!RETRYABLE_CODES.has(lastError?.code) || !allowCopyFallback) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch { /* 清理失败忽略 */ }
    throw lastError
  }
  // 重试仍被占用时退回复制覆盖：先备份上一代，复制后校验内容，失败则回退。
  const backup = preserveBackup(filePath)
  try {
    copyFileRobustSync(temp, filePath)
    if (!verifyCopy(filePath, payload)) throw Object.assign(new Error('降级写入校验失败：文件内容与预期不一致'), { code: 'EVERIFY' })
    try { fs.unlinkSync(temp) } catch { /* 临时文件清理失败不影响结果 */ }
    return { ok: true, attempts: retries + 1, fallback: true, backup, code: lastError?.code || null }
  } catch (copyError) {
    // 复制或校验失败：用备份还原，避免留下半个文件。
    try { if (fs.existsSync(backup)) copyFileRobustSync(backup, filePath) } catch { /* 还原失败忽略，向上抛原始错误 */ }
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch { /* 清理失败忽略 */ }
    throw copyError
  }
}

// 读取时容错：主文件不可用或内容损坏时退回上一代备份，并把备份恢复成主文件。
function readJsonWithRecoverySync(filePath, encoding = 'utf8') {
  const attempt = file => {
    try { return { ok: true, data: JSON.parse(fs.readFileSync(file, encoding)), source: file === filePath ? 'main' : 'backup' } }
    catch { return { ok: false } }
  }
  const main = attempt(filePath)
  if (main.ok) return main
  const backup = attempt(backupNameOf(filePath))
  if (!backup.ok) return { ok: false, data: null, source: 'none' }
  try { copyFileRobustSync(backupNameOf(filePath), filePath) } catch { /* 恢复失败不阻断读取 */ }
  return { ...backup, recovered: true }
}

module.exports = { writeFileAtomicSync, readJsonWithRecoverySync, copyFileRobustSync, backupNameOf, RETRYABLE_CODES, DEFAULT_RETRIES }
