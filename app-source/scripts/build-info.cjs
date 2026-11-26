// 生成可追溯构建标识：阶段号 + 提交号 + 逐文件 sha256 清单。
// 输出清单：node scripts/build-info.cjs --stage=P2-15.1
// 生产 staging：node scripts/build-info.cjs --stage=P2-18 --stage-output=../../staging/P2-18/app
// 目的：package.json 版本号长期固定（1.1.0），无法区分阶段；本文件让"运行的是哪一版"可被逐字节核对。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const INCLUDE = ['dist', 'electron']
const FILES = ['package.json']

function argValue(name, fallback = '') {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function walk(target) {
  const stat = fs.statSync(target)
  if (stat.isFile()) return [target]
  const result = []
  for (const name of fs.readdirSync(target).sort()) {
    if (name === 'node_modules' || name.endsWith('.tmp')) continue
    result.push(...walk(path.join(target, name)))
  }
  return result
}

let commit = 'unknown'
let dirty = null
let dirtyPaths = []
try {
  commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()
  dirtyPaths = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).split('\n').map(line => line.trim()).filter(Boolean)
  dirty = dirtyPaths.length > 0
} catch { /* 非 git 环境：保留 unknown，不伪造提交号 */ }

// With --stage-output, write a fresh production app directory and its exact manifest.
const stageOutput = argValue('stage-output')
const stageRoot = stageOutput ? path.resolve(stageOutput) : null
if (stageRoot && fs.existsSync(stageRoot)) throw new Error(`staging 目标目录已存在：${stageRoot}`)
if (stageRoot && INCLUDE.some(dir => {
  const relative = path.relative(path.join(root, dir), stageRoot)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
})) throw new Error('staging 目标不能位于运行源码目录内')
const isDevFile = name => /^electron\/dev-(?:ipc|diag-.+|exp-.+)\.cjs$/.test(name)

const files = []
for (const item of [...INCLUDE, ...FILES]) {
  const target = path.join(root, item)
  if (!fs.existsSync(target)) continue
  for (const file of walk(target)) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (stageRoot && isDevFile(relative)) continue
    const bytes = fs.readFileSync(file)
    if (stageRoot) {
      const destination = path.join(stageRoot, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, bytes)
    }
    files.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
}
files.sort((a, b) => a.path.localeCompare(b.path))

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const info = {
  stage: argValue('stage', 'unlabeled'),
  appVersion: pkg.version,
  commit,
  worktreeDirty: dirty,
  dirtyPaths,
  generatedAt: new Date().toISOString(),
  fileCount: files.length,
  totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  // 清单指纹：只对路径+哈希再取一次，便于人眼比对两个构建是否同一份。
  manifestDigest: crypto.createHash('sha256').update(files.map(file => `${file.path}:${file.sha256}`).join('\n')).digest('hex'),
  files,
}

const output = path.join(stageRoot || root, 'build-info.json')
fs.writeFileSync(output, JSON.stringify(info, null, 2), 'utf8')
process.stdout.write(`build-info: ${info.stage} ${info.commit.slice(0, 7)} files=${info.fileCount} digest=${info.manifestDigest.slice(0, 12)} -> ${output}\n`)
