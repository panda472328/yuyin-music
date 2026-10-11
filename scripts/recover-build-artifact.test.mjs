import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { assertArtifactIdentity, assertRunIdentity, recoverBuildArtifact, recoveryIdentity as id, reportRecoveryFailure, verifiedInstallerBytes, verifyArchive } from './recover-build-artifact.mjs'

const steps = [
  ...['Build only the Windows x64 NSIS installer', 'Verify native installer guards without installing on the runner', 'Back up the verified installer before publication'].map(name => ({ name, conclusion: 'success' })),
  { name: 'Publish one installer, then advance stable channel', conclusion: 'failure' },
]
const run = { id: id.runId, event: 'push', head_branch: id.tag, head_sha: id.commit, status: 'completed', conclusion: 'failure',
  run_attempt: id.attempt, path: '.github/workflows/release.yml', head_repository: { full_name: id.repository } }
const artifact = { id: id.artifactId, name: id.artifactName, size_in_bytes: id.archiveSize, digest: 'sha256:' + id.archiveSha256,
  expired: false, expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: id.runId, head_sha: id.commit, head_branch: id.tag } }

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(entries = [{ name: id.filename, bytes: Buffer.from('MZ controlled fixture'), method: 0 }]) {
  const locals = [], centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const bytes = entry.bytes
    const compressed = entry.method === 8 ? deflateRawSync(bytes) : bytes
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(entry.method, 10)
    central.writeUInt32LE(entry.crc ?? crc32(bytes), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.size ?? bytes.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(entry.attributes ?? 0, 38); central.writeUInt32LE(offset, 42)
    const localRecord = Buffer.concat([local, name, compressed]); locals.push(localRecord); centrals.push(Buffer.concat([central, name])); offset += localRecord.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

function expected(bytes) { return { archiveSize: bytes.length, archiveSha256: createHash('sha256').update(bytes).digest('hex'), filename: id.filename } }

function zip64Archive(classic) {
  const eocd = classic.length - 22
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4)
  record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14)
  record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32)
  record.writeBigUInt64LE(BigInt(classic.readUInt32LE(eocd + 12)), 40)
  record.writeBigUInt64LE(BigInt(classic.readUInt32LE(eocd + 16)), 48)
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(eocd), 8); locator.writeUInt32LE(1, 16)
  const trailer = Buffer.from(classic.subarray(eocd))
  trailer.writeUInt16LE(0xffff, 8); trailer.writeUInt16LE(0xffff, 10)
  trailer.writeUInt32LE(0xffffffff, 12); trailer.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([classic.subarray(0, eocd), record, locator, trailer])
}

test('ZIP64 EOCD与locator兼容但仍拒绝跨磁盘、偏移和计数不一致', () => {
  const original = Buffer.from('MZ controlled ZIP64 installer')
  const bytes = zip64Archive(zip([{ name: id.filename, bytes: original, method: 8 }]))
  assert.deepEqual(verifiedInstallerBytes(bytes, expected(bytes)), original)
  for (const mutate of [
    b => b.writeUInt32LE(2, b.length - 22 - 4),
    b => b.writeBigUInt64LE(0n, b.length - 22 - 12),
    b => b.writeBigUInt64LE(2n, b.length - 22 - 20 - 56 + 32),
    b => b.writeBigUInt64LE(1n, b.length - 22 - 20 - 56 + 48),
  ]) {
    const changed = Buffer.from(bytes); mutate(changed)
    assert.throws(() => verifiedInstallerBytes(changed, expected(changed)), /ZIP64|ZIP/)
  }
})

test('原构建身份拒绝不同标签、提交、仓库、attempt、workflow 与失败步骤', () => {
  assert.doesNotThrow(() => assertRunIdentity(run, [{ name: 'release', steps }]))
  for (const change of [{ id: 1 }, { event: 'workflow_dispatch' }, { head_branch: 'pc-v0.4.15' }, { head_sha: 'a'.repeat(40) },
    { conclusion: 'success' }, { run_attempt: 2 }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'other/repo' } }]) {
    assert.throws(() => assertRunIdentity({ ...run, ...change }, [{ name: 'release', steps }]), /身份/)
  }
  assert.throws(() => assertRunIdentity(run, [{ name: 'release', steps: steps.map((step, i) => i === 0 ? { ...step, conclusion: 'failure' } : step) }]), /未成功/)
  assert.throws(() => assertRunIdentity(run, [{ name: 'release', steps: [...steps, { name: 'Extra', conclusion: 'failure' }] }]), /额外失败/)
  assert.throws(() => assertRunIdentity(run, [{ name: 'release', steps }, { name: 'release', steps }]), /不唯一/)
})

test('artifact 身份钉住原运行、完整ZIP摘要和有效期', () => {
  assert.doesNotThrow(() => assertArtifactIdentity(artifact))
  for (const change of [{ id: 1 }, { name: 'other' }, { size_in_bytes: id.archiveSize + 1 }, { digest: 'sha256:' + 'a'.repeat(64) },
    { expired: true }, { expires_at: '2000-01-01T00:00:00Z' }, { workflow_run: { ...artifact.workflow_run, id: 1 } },
    { workflow_run: { ...artifact.workflow_run, head_sha: 'b'.repeat(40) } }]) assert.throws(() => assertArtifactIdentity({ ...artifact, ...change }), /不匹配/)
})

test('唯一根目录安装EXE在store与deflate ZIP通过CRC并提取原字节', () => {
  const original = Buffer.from('MZ controlled installer fixture')
  for (const method of [0, 8]) {
    const bytes = zip([{ name: id.filename, bytes: original, method }])
    assert.deepEqual(verifiedInstallerBytes(bytes, expected(bytes)), original)
  }
})

test('ZIP拒绝路径、重复项、目录、符号链接、加密、错误CRC、非MZ与摘要', () => {
  const original = Buffer.from('MZ controlled fixture')
  for (const entry of [
    { name: '../' + id.filename }, { name: 'nested/' + id.filename }, { name: 'C:' + id.filename }, { name: 'bad\\' + id.filename },
    { name: id.filename, attributes: 0xa0000000 }, { name: id.filename, flags: 1 }, { name: id.filename, crc: 0 },
    { name: id.filename, bytes: Buffer.from('PK fake exe') }, { name: id.filename, size: 500000001 },
  ]) {
    const bytes = zip([{ bytes: original, method: 0, ...entry }]); assert.throws(() => verifiedInstallerBytes(bytes, expected(bytes)))
  }
  const double = zip([{ name: id.filename, bytes: original, method: 0 }, { name: id.filename, bytes: original, method: 0 }])
  assert.throws(() => verifiedInstallerBytes(double, expected(double)), /单文件/)
  const good = zip(); assert.throws(() => verifiedInstallerBytes(good, { ...expected(good), archiveSha256: 'a'.repeat(64) }), /SHA-256/)
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyin-recover-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'yuyin-music', version: '0.4.14' }))
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: id.repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
    GH_TOKEN: 'controlled-token', RUNNER_TEMP: root, GITHUB_OUTPUT: path.join(root, 'outputs.txt') }
  const calls = [], state = { run, jobs: [{ name: 'release', steps }], artifact }
  function command(executable, args, options) {
    calls.push({ executable, args, options })
    assert.equal(options.env, env)
    if (executable === 'git') {
      if (args[0] === 'rev-parse') return id.commit
      if (args[1] === id.commit + ':package.json') return JSON.stringify({ name: 'yuyin-music', version: '0.4.14' })
      if (args[1] === id.commit + ':package-lock.json') return JSON.stringify({ version: '0.4.14', packages: { '': { version: '0.4.14' } } })
      if (args[1] === id.commit + ':CHANGELOG.md') return '## 0.4.14\n\n- Original tagged release notes\n\n## 0.4.13\nOlder'
      throw new Error('Unexpected git command')
    }
    assert.ok(['gh', 'gh.exe'].includes(executable)); assert.deepEqual(args.slice(0, 3), ['api', '--method', 'GET'])
    if (args.includes('--header')) { assert.equal(options.encoding, null); return Buffer.from('controlled archive') }
    if (args[3].endsWith('/actions/runs/' + id.runId)) return JSON.stringify(state.run)
    if (args[3].includes('/attempts/1/jobs?')) return JSON.stringify({ jobs: state.jobs })
    if (args[3].endsWith('/actions/artifacts/' + id.artifactId)) return JSON.stringify(state.artifact)
    throw new Error('Unexpected API')
  }
  async function verify(archive, directory) {
    assert.equal((await fs.readFile(archive)).toString(), 'controlled archive')
    const output = path.join(directory, id.filename)
    const exe = Buffer.from('MZ controlled installer'); await fs.writeFile(output, exe)
    return { path: output, size: exe.length, sha256: createHash('sha256').update(exe).digest('hex'), sourceCommit: id.commit }
  }
  return { root, env, calls, state, recover: () => recoverBuildArtifact({ root, env, command, verify }) }
}

test('helper仅GET下载原artifact并输出原源码notes/commit，不发布、不改标签、不重建', async t => {
  const f = await fixture(t); const result = await f.recover()
  assert.equal(result.sourceCommit, id.commit)
  assert.equal(await fs.readFile(result.notesPath, 'utf8'), '- Original tagged release notes')
  const output = await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8')
  assert.match(output, /build_commit=023bec8ae0e7c3ccb4d5ca9667245313e8ef54e2/)
  assert.equal(output.includes('controlled-token'), false)
  for (const { executable, args } of f.calls) {
    assert.ok(['git', 'gh', 'gh.exe'].includes(executable))
    assert.equal(args.some(value => ['POST', 'PUT', 'PATCH', 'DELETE', 'upload', 'create', 'edit', 'tag', 'npm', 'build'].includes(value)), false)
  }
})

test('无 Actions 临时认证、标签不同或原构建检查失败时下载前停止', async t => {
  for (const override of [{ GITHUB_ACTIONS: 'false' }, { GH_TOKEN: '' }, { GITHUB_REF: 'refs/tags/pc-v0.4.14' },
    { GITHUB_REPOSITORY: 'other/repo' }, { REQUESTED_TAG: 'pc-v0.4.12' }]) {
    const f = await fixture(t); Object.assign(f.env, override)
    await assert.rejects(f.recover, /恢复仅允许/); assert.equal(f.calls.length, 0)
  }
  const f = await fixture(t); f.state.artifact = { ...artifact, expired: true }
  await assert.rejects(f.recover, /不匹配/); assert.equal(f.calls.some(call => call.args.includes('--header')), false)
})

test('正式 archive 验证不允许通过测试注入的伪ZIP或不同摘要', async t => {
  const f = await fixture(t); const archive = path.join(f.root, 'fake.zip'); await fs.writeFile(archive, 'PK fake')
  await assert.rejects(() => verifyArchive(archive, f.root), /大小/)
})

test('恢复失败annotation脱敏凭据和全部URL，并转义Actions控制字符', () => {
  const outputs = []
  reportRecoveryFailure({ stderr: 'Error: token-secret https://signed.example/path-secret?sig=query-secret\n::error::injected%\nAuthorization: Bearer bearer-secret' },
    { GH_TOKEN: 'token-secret' }, line => outputs.push(line))
  assert.equal(outputs.length, 1)
  assert.match(outputs[0], /^::error title=Original build recovery stopped::/)
  for (const secret of ['token-secret', 'signed.example', 'path-secret', 'query-secret', 'bearer-secret']) assert.equal(outputs[0].includes(secret), false)
  assert.equal(outputs[0].includes('\n'), false)
  assert.match(outputs[0], /%0A::error::injected%25/)
})
