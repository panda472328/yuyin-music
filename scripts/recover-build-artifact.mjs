import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { changelogNotes } from './release-utils.mjs'
import { sanitizeDiagnostic } from './diagnose-release-failure.mjs'

export const recoveryIdentity = Object.freeze({
  repository: 'panda472328/yuyin-music',
  tag: 'pc-v0.4.14',
  commit: '023bec8ae0e7c3ccb4d5ca9667245313e8ef54e2',
  runId: 38109329998,
  artifactId: 11691332289,
  attempt: 1,
  artifactName: 'yuyin-pc-v0.4.14-installer',
  archiveSize: 113815898,
  archiveSha256: 'f8ae06fc2c47e4f7a93b70d2456db809f7fe600f7e157a68f41bde301304e528',
  filename: 'Yuyin-0.4.14-Setup.exe',
})

const expectedSteps = new Set([
  'Build only the Windows x64 NSIS installer',
  'Verify native installer guards without installing on the runner',
  'Back up the verified installer before publication',
])

export function assertRunIdentity(run, jobs) {
  if (!run || run.id !== recoveryIdentity.runId || run.event !== 'push' || run.head_branch !== recoveryIdentity.tag ||
      run.head_sha !== recoveryIdentity.commit || run.status !== 'completed' || run.conclusion !== 'failure' ||
      run.run_attempt !== recoveryIdentity.attempt || run.path !== '.github/workflows/release.yml' ||
      run.head_repository?.full_name !== recoveryIdentity.repository) {
    throw new Error('原构建运行身份、标签、提交或仓库不匹配。')
  }
  const releaseJobs = Array.isArray(jobs) ? jobs.filter(job => job.name === 'release') : []
  if (releaseJobs.length !== 1 || !Array.isArray(releaseJobs[0].steps)) throw new Error('原构建 release job 不唯一或步骤缺失。')
  const steps = new Map(releaseJobs[0].steps.map(step => [step.name, step]))
  if (steps.size !== releaseJobs[0].steps.length) throw new Error('原构建步骤名称重复。')
  for (const name of expectedSteps) if (steps.get(name)?.conclusion !== 'success') throw new Error('原构建步骤未成功：' + name)
  const publish = steps.get('Publish one installer, then advance stable channel')
  if (!publish || publish.conclusion !== 'failure') throw new Error('原构建不是唯一发布步骤失败，拒绝恢复。')
  if (releaseJobs[0].steps.filter(step => step.conclusion === 'failure').length !== 1) throw new Error('原构建存在额外失败步骤，拒绝恢复。')
}

export function assertArtifactIdentity(artifact) {
  if (!artifact || artifact.id !== recoveryIdentity.artifactId || artifact.name !== recoveryIdentity.artifactName ||
      artifact.size_in_bytes !== recoveryIdentity.archiveSize || artifact.digest !== 'sha256:' + recoveryIdentity.archiveSha256 ||
      artifact.expired !== false || artifact.workflow_run?.id !== recoveryIdentity.runId ||
      artifact.workflow_run?.head_sha !== recoveryIdentity.commit || artifact.workflow_run?.head_branch !== recoveryIdentity.tag ||
      !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= Date.now()) {
    throw new Error('构建 artifact 身份、大小、摘要或来源不匹配。')
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function zipEntries(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('artifact 不是有效 ZIP。')
  let count = buffer.readUInt16LE(eocd + 10)
  let centralSize = buffer.readUInt32LE(eocd + 12)
  let centralOffset = buffer.readUInt32LE(eocd + 16)
  let centralEnd = eocd
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) ||
      eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) throw new Error('ZIP 必须是单磁盘、单文件的原始 artifact。')
  const locator = eocd - 20
  if (locator >= 0 && buffer.readUInt32LE(locator) === 0x07064b50) {
    const safe64 = offset => {
      const value = buffer.readBigUInt64LE(offset)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP64 数值超出安全范围。')
      return Number(value)
    }
    const zip64 = safe64(locator + 8)
    if (buffer.readUInt32LE(locator + 4) !== 0 || buffer.readUInt32LE(locator + 16) !== 1 ||
        zip64 + 56 > locator || buffer.readUInt32LE(zip64) !== 0x06064b50 ||
        zip64 + 12 + safe64(zip64 + 4) !== locator || safe64(zip64 + 4) < 44 ||
        buffer.readUInt32LE(zip64 + 16) || buffer.readUInt32LE(zip64 + 20)) throw new Error('ZIP64 尾部边界或磁盘信息无效。')
    const zipCount = safe64(zip64 + 32)
    const zipSize = safe64(zip64 + 40)
    const zipOffset = safe64(zip64 + 48)
    if (safe64(zip64 + 24) !== zipCount || zipCount !== 1 ||
        ![zipCount, 0xffff].includes(count) || ![zipCount, 0xffff].includes(buffer.readUInt16LE(eocd + 8)) ||
        ![zipSize, 0xffffffff].includes(centralSize) || ![zipOffset, 0xffffffff].includes(centralOffset)) {
      throw new Error('ZIP64 与普通尾部目录信息不一致。')
    }
    count = zipCount; centralSize = zipSize; centralOffset = zipOffset; centralEnd = zip64
  }
  if (count !== 1 || (centralEnd === eocd && buffer.readUInt16LE(eocd + 8) !== count) ||
      centralOffset + centralSize !== centralEnd) throw new Error('ZIP 必须是单磁盘、单文件的原始 artifact。')
  const entries = []
  let offset = centralOffset
  for (let i = 0; i < count; i++) {
    if (offset + 46 > centralEnd) throw new Error('ZIP 中央目录越界。')
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录条目无效。')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameSize = buffer.readUInt16LE(offset + 28)
    const extraSize = buffer.readUInt16LE(offset + 30)
    const commentSize = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    if (buffer.readUInt16LE(offset + 34) || offset + 46 + nameSize + extraSize + commentSize > centralEnd) throw new Error('ZIP 条目名称或磁盘信息越界。')
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString('utf8')
    if (!name || name.includes('\\') || name.includes('/') || name.includes(':') || name.includes('\0')) throw new Error('ZIP 条目必须是根目录文件。')
    const unixType = (externalAttributes >>> 16) & 0xf000
    if (flags & 1 || ![0, 8].includes(method) || uncompressedSize < 2 || uncompressedSize > 500000000 ||
        compressedSize < 1 || (externalAttributes & 0x10) || unixType && unixType !== 0x8000) throw new Error('ZIP 条目类型、加密或大小无效。')
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset, centralOffset })
    offset += 46 + nameSize + extraSize + commentSize
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP 中央目录大小不一致。')
  return entries
}

function extractEntry(buffer, entry) {
  const offset = entry.localOffset
  if (offset + 30 > entry.centralOffset) throw new Error('ZIP 本地条目越界。')
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('ZIP 本地条目无效。')
  const nameSize = buffer.readUInt16LE(offset + 26)
  const extraSize = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameSize + extraSize
  if (start + entry.compressedSize > entry.centralOffset ||
      buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8') !== entry.name ||
      buffer.readUInt16LE(offset + 6) !== entry.flags || buffer.readUInt16LE(offset + 8) !== entry.method) {
    throw new Error('ZIP 本地文件信息与中央目录不一致。')
  }
  const compressed = buffer.subarray(start, start + entry.compressedSize)
  const data = entry.method === 0 ? Buffer.from(compressed) : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize }) : null
  if (!data || data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) throw new Error('ZIP 条目校验失败。')
  return data
}

export function verifiedInstallerBytes(bytes, expected = recoveryIdentity) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== expected.archiveSize) throw new Error('artifact ZIP 大小与原构建不一致。')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== expected.archiveSha256) throw new Error('artifact ZIP SHA-256 与原构建不一致。')
  const entries = zipEntries(bytes)
  const files = entries.filter(entry => !entry.name.endsWith('/'))
  if (files.length !== 1 || files[0].name !== expected.filename) throw new Error('artifact 必须只含唯一目标安装 EXE。')
  const exe = extractEntry(bytes, files[0])
  if (exe.length < 2 || exe.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('恢复文件不是 Windows PE 安装包。')
  return exe
}

export async function verifyArchive(archivePath, outputDirectory) {
  const stat = await fsp.stat(archivePath)
  if (!stat.isFile() || stat.size !== recoveryIdentity.archiveSize) throw new Error('artifact ZIP 大小与原构建不一致。')
  const exe = verifiedInstallerBytes(await fsp.readFile(archivePath))
  await fsp.mkdir(outputDirectory, { recursive: true })
  const output = path.join(outputDirectory, recoveryIdentity.filename)
  await fsp.writeFile(output, exe, { flag: 'wx' })
  return { path: output, size: exe.length, sha256: createHash('sha256').update(exe).digest('hex'), sourceCommit: recoveryIdentity.commit }
}

function execute(file, args, options) {
  return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
    maxBuffer: 16 * 1024 * 1024, ...options })
}

export async function recoverBuildArtifact({ root = process.cwd(), env = process.env, command = execute, verify = verifyArchive } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== recoveryIdentity.repository ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== 'refs/heads/main' ||
      !env.GH_TOKEN || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP) || !env.GITHUB_OUTPUT ||
      env.REQUESTED_TAG && env.REQUESTED_TAG !== recoveryIdentity.tag) throw new Error('恢复仅允许主分支 Actions 和临时令牌，不接受本地凭据或任意来源。')
  const currentPackage = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  if (currentPackage.name !== 'yuyin-music' || 'pc-v' + currentPackage.version !== recoveryIdentity.tag) throw new Error('当前源码版本与原安装包不一致。')
  const options = { cwd: root, env }
  const git = args => command('git', args, options).trim()
  if (git(['rev-parse', '--verify', 'refs/tags/' + recoveryIdentity.tag + '^{commit}']) !== recoveryIdentity.commit) throw new Error('原标签提交已变化，拒绝恢复。')
  const sourcePackage = JSON.parse(git(['show', recoveryIdentity.commit + ':package.json']))
  const sourceLock = JSON.parse(git(['show', recoveryIdentity.commit + ':package-lock.json']))
  if (sourcePackage.name !== currentPackage.name || sourcePackage.version !== currentPackage.version ||
      sourceLock.version !== sourcePackage.version || sourceLock.packages?.['']?.version !== sourcePackage.version) throw new Error('原标签版本与锁文件不一致。')
  const notes = changelogNotes(git(['show', recoveryIdentity.commit + ':CHANGELOG.md']), sourcePackage.version)
  const gh = args => command(process.platform === 'win32' ? 'gh.exe' : 'gh', args, options)
  const api = route => JSON.parse(gh(['api', '--method', 'GET', 'repos/' + recoveryIdentity.repository + '/' + route]))
  const run = api('actions/runs/' + recoveryIdentity.runId)
  const jobs = api('actions/runs/' + recoveryIdentity.runId + '/attempts/' + recoveryIdentity.attempt + '/jobs?per_page=100')
  assertRunIdentity(run, jobs.jobs)
  const artifact = api('actions/artifacts/' + recoveryIdentity.artifactId)
  assertArtifactIdentity(artifact)
  const temporary = await fsp.mkdtemp(path.join(env.RUNNER_TEMP, 'yuyin-recover-'))
  try {
    const archive = path.join(temporary, 'original.zip')
    const bytes = command(process.platform === 'win32' ? 'gh.exe' : 'gh', ['api', '--method', 'GET',
      '--header', 'Accept: application/zip', 'repos/' + recoveryIdentity.repository + '/actions/artifacts/' + recoveryIdentity.artifactId + '/zip'],
      { ...options, encoding: null, maxBuffer: recoveryIdentity.archiveSize + 1024 })
    await fsp.writeFile(archive, bytes, { flag: 'wx' })
    const result = await verify(archive, temporary)
    if (result.sourceCommit !== recoveryIdentity.commit || path.resolve(result.path) !== path.join(temporary, recoveryIdentity.filename) ||
        !/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isSafeInteger(result.size) || result.size < 2 || result.size > 500000000) throw new Error('安装包最终验证结果无效。')
    const notesPath = path.join(temporary, 'original-notes.md')
    await fsp.writeFile(notesPath, notes, { flag: 'wx' })
    for (const [key, value] of Object.entries({ artifact: result.path, notes: notesPath, build_commit: recoveryIdentity.commit,
      tag: recoveryIdentity.tag, sha256: result.sha256, size: result.size })) {
      if (String(value).includes('\n') || String(value).includes('\r')) throw new Error('Actions 输出路径包含换行。')
      await fsp.appendFile(env.GITHUB_OUTPUT, key + '=' + value + '\n')
    }
    await fsp.unlink(archive)
    console.log('已验证原标签构建安装包：' + recoveryIdentity.tag + '，EXE SHA-256：' + result.sha256 + '，大小：' + result.size)
    return { ...result, notesPath, temporaryDirectory: temporary }
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export function reportRecoveryFailure(error, env = process.env, write = console.error) {
  const detail = sanitizeDiagnostic(error.stderr ?? error.message, [env.GH_TOKEN, env.GITHUB_TOKEN]).trim().slice(0, 1200) || '原构建恢复失败。'
  const escaped = detail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  write('::error title=Original build recovery stopped::' + escaped)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('恢复脚本不接受参数或来源覆盖。'); process.exitCode = 1 }
  else recoverBuildArtifact().catch(error => {
    reportRecoveryFailure(error)
    process.exitCode = 1
  })
}
