import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { compareVersions, parseUpdateManifest, updateArtifactUrl, updateReleaseUrl, WINDOWS_UPDATE_MANIFEST_URL, type UpdateManifest, type UpdateState } from '../src/shared/update'
import { AppUpdater, verifyUpdateFile } from '../electron/updater'
import { isTrustedUpdateRedirect, type UpdateResponse, type UpdateTransport } from '../electron/update-transport'
import { installationSupport, nsisUpdateArguments, prepareUpdateInstaller } from '../electron/update-installer'

const installerBytes = Buffer.from('controlled installer fixture - never executable')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const manifest = (version = '0.5.0'): UpdateManifest => ({ schemaVersion: 1, platform: 'windows', version,
  artifact: { url: updateArtifactUrl('windows', version), sha256: sha(installerBytes), size: installerBytes.length },
  releaseNotesUrl: updateReleaseUrl('windows', version), notes: '受控更新说明', publishedAt: '2026-10-08T00:00:00Z' })
const response = (bytes: Uint8Array, length: number | null = bytes.byteLength): UpdateResponse => ({
  body: (async function* () { yield bytes.slice(0, 9); yield bytes.slice(9) })(), contentLength: length, dispose() {},
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t: TestContext, supplied?: UpdateTransport, canInstall = true) {
  const directory = mkdtempSync(join(tmpdir(), 'yuyin-update-test-'))
  const requests: { url: string; kind: string }[] = []; const installations: string[] = []; const states: UpdateState[] = []
  const transport: UpdateTransport = supplied ?? (async (url, _signal, kind) => {
    requests.push({ url, kind })
    return response(kind === 'manifest' ? Buffer.from(JSON.stringify(manifest())) : installerBytes)
  })
  const updater = new AppUpdater({ currentVersion: '0.4.9', cacheDirectory: directory, canInstall,
    installDisabledReason: canInstall ? null : '便携版请下载安装版。', transport, onState: state => states.push(state),
    now: () => new Date('2026-10-08T01:00:00Z'), install: async file => { installations.push(file) } })
  t.after(() => { updater.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { updater, directory, requests, installations, states }
}

test('manifest pins the platform, repository, tag, filename, digest and supported stable version', () => {
  assert.deepEqual(parseUpdateManifest(manifest(), 'windows'), manifest())
  for (const input of [
    { ...manifest(), platform: 'android' }, { ...manifest(), version: '00.5.0' }, { ...manifest(), version: '0.5.0-beta' },
    { ...manifest(), schemaVersion: 2 }, { ...manifest(), versionCode: 1 },
    { ...manifest(), artifact: { ...manifest().artifact, url: 'https://github.com/evil/repo/releases/download/pc-v0.5.0/a.exe' } },
    { ...manifest(), artifact: { ...manifest().artifact, url: manifest().artifact.url + '?redirect=other' } },
    { ...manifest(), artifact: { ...manifest().artifact, sha256: 'not-a-hash' } },
    { ...manifest(), artifact: { ...manifest().artifact, size: 500_000_001 } },
    { ...manifest(), artifact: { ...manifest().artifact, size: 1.5 } },
    { ...manifest(), releaseNotesUrl: 'https://evil.test/' }, { ...manifest(), notes: 'x'.repeat(8001) },
    { ...manifest(), publishedAt: 'invalid' },
  ]) assert.throws(() => parseUpdateManifest(input, 'windows'))
  const mobile = { ...manifest(), platform: 'android', versionCode: 4,
    artifact: { ...manifest().artifact, url: updateArtifactUrl('android', '0.5.0') }, releaseNotesUrl: updateReleaseUrl('android', '0.5.0') }
  assert.equal(parseUpdateManifest(mobile, 'android').versionCode, 4)
  assert.throws(() => parseUpdateManifest({ ...mobile, versionCode: 0 }, 'android'))
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.4.9', '0.4.9'), 0)
  assert.equal(compareVersions('0.4.8', '0.4.9'), -1)
})

test('network redirects remain anonymous HTTPS on the fixed manifest or release CDN', () => {
  assert.equal(isTrustedUpdateRedirect(new URL(WINDOWS_UPDATE_MANIFEST_URL), 'manifest'), true)
  assert.equal(isTrustedUpdateRedirect(new URL(manifest().artifact.url), 'artifact'), true)
  assert.equal(isTrustedUpdateRedirect(new URL('https://release-assets.githubusercontent.com/a?signature=fixture'), 'artifact'), true)
  for (const address of ['http://github.com/panda472328/yuyin-music/releases/download/a', 'https://user@github.com/panda472328/yuyin-music/releases/download/a',
    'https://github.com:8443/panda472328/yuyin-music/releases/download/a', 'https://github.com/evil/repo/releases/download/a',
    'https://release-assets.githubusercontent.com.evil.test/a', 'file:///setup.exe', 'https://api.bilibili.com/a']) {
    assert.equal(isTrustedUpdateRedirect(new URL(address), 'artifact'), false)
  }
  assert.equal(isTrustedUpdateRedirect(new URL(WINDOWS_UPDATE_MANIFEST_URL + '?x=1'), 'manifest'), false)
  assert.equal(isTrustedUpdateRedirect(new URL('https://release-assets.githubusercontent.com/a'), 'manifest'), false)
})

test('checking discovers a release without downloading or installing, and state copies cannot mutate the manifest', async t => {
  const { updater, requests, installations, states } = fixture(t)
  const state = await updater.check()
  assert.equal(state.status, 'available'); assert.equal(state.checkedAt, '2026-10-08T01:00:00.000Z')
  assert.deepEqual(requests, [{ url: WINDOWS_UPDATE_MANIFEST_URL, kind: 'manifest' }]); assert.deepEqual(installations, [])
  state.manifest!.artifact.url = 'https://evil.test/setup.exe'
  states.at(-1)!.manifest!.artifact.sha256 = 'bad'
  assert.equal(updater.getState().manifest?.artifact.url, manifest().artifact.url)
  assert.equal(updater.getState().manifest?.artifact.sha256, manifest().artifact.sha256)
})

test('equal or older manifests do not offer a downgrade', async t => {
  let version = '0.4.9'
  const { updater } = fixture(t, async () => response(Buffer.from(JSON.stringify(manifest(version)))))
  assert.equal((await updater.check()).status, 'up-to-date')
  version = '0.4.8'
  assert.equal((await updater.check()).status, 'up-to-date'); assert.equal(updater.getState().manifest, null)
})

test('concurrent checks and a download clicked during checking share the current operation', async t => {
  const pending = deferred<UpdateResponse>(); let calls = 0
  const { updater } = fixture(t, async () => { calls++; return pending.promise })
  const a = updater.check(); const b = updater.check(); const c = updater.download()
  assert.equal(a, b); assert.equal(a, c)
  pending.resolve(response(Buffer.from(JSON.stringify(manifest()))))
  assert.equal((await a).status, 'available'); assert.equal(calls, 1)
})

test('invalid or oversized manifests end loading and expose a retryable error without fetching an artifact', async t => {
  let kind = 'malformed'; let calls = 0
  const { updater } = fixture(t, async (_url, _signal, requestKind) => {
    calls++; assert.equal(requestKind, 'manifest')
    return kind === 'oversized' ? response(Buffer.alloc(65 * 1024), null) : response(Buffer.from('{bad json'))
  })
  assert.equal((await updater.check()).status, 'error')
  kind = 'oversized'
  assert.match((await updater.check()).error!, /过大/); assert.equal(calls, 2)
})

test('valid downloads are verified, atomically renamed and restored after application restart', async t => {
  const { updater, directory, installations, requests } = fixture(t)
  await updater.check()
  assert.equal((await updater.download()).status, 'downloaded')
  assert.equal(updater.getState().progress, 100)
  const files = readdirSync(directory)
  assert.equal(files.length, 1); assert.ok(files[0].endsWith('-Setup.exe')); assert.ok(!files[0].endsWith('.part'))
  assert.deepEqual(readFileSync(join(directory, files[0])), installerBytes)
  assert.deepEqual(installations, [])
  await updater.check()
  assert.equal(updater.getState().status, 'downloaded')
  assert.equal(requests.filter(item => item.kind === 'artifact').length, 1)
  assert.equal((await updater.install()).status, 'installing')
  assert.deepEqual(installations, [join(directory, files[0])])
  await updater.install(); assert.equal(installations.length, 1)
})

test('partial, oversized and wrong-digest downloads remove temporary files and never become installable', async t => {
  let mode = 'partial'
  const { updater, directory, installations } = fixture(t, async (_url, _signal, kind) => {
    if (kind === 'manifest') return response(Buffer.from(JSON.stringify(manifest())))
    if (mode === 'partial') return response(installerBytes.subarray(0, 10), null)
    if (mode === 'oversized') return response(Buffer.concat([installerBytes, Buffer.from('excess')]), null)
    if (mode === 'length') return response(installerBytes, installerBytes.length + 1)
    return response(Buffer.alloc(installerBytes.length), null)
  })
  await updater.check()
  for (mode of ['partial', 'oversized', 'length', 'digest']) {
    assert.equal((await updater.download()).status, 'error')
    assert.deepEqual(readdirSync(directory), [])
  }
  await updater.install(); assert.deepEqual(installations, [])
})

test('download failures retain the offer for retry, and install rechecks files changed after download', async t => {
  let offline = true
  const { updater, directory, installations } = fixture(t, async (_url, _signal, kind) => {
    if (kind === 'manifest') return response(Buffer.from(JSON.stringify(manifest())))
    if (offline) throw new Error('受控断网')
    return response(installerBytes)
  })
  await updater.check(); assert.equal((await updater.download()).status, 'error')
  assert.equal(updater.getState().manifest?.version, '0.5.0')
  offline = false; assert.equal((await updater.download()).status, 'downloaded')
  const file = join(directory, readdirSync(directory)[0]); writeFileSync(file, Buffer.alloc(installerBytes.length))
  assert.equal(await verifyUpdateFile(file, manifest()), false)
  assert.equal((await updater.install()).status, 'error'); assert.deepEqual(installations, [])
  assert.equal((await updater.download()).status, 'downloaded')
  assert.equal(await verifyUpdateFile(file, manifest()), true)
})

test('disposal prevents an old manifest response from publishing after shutdown', async t => {
  const pending = deferred<UpdateResponse>()
  const { updater, states } = fixture(t, async () => pending.promise)
  const checking = updater.check(); await Promise.resolve(); updater.dispose()
  pending.resolve(response(Buffer.from(JSON.stringify(manifest()))))
  await checking
  assert.equal(states.length, 1); assert.equal(states[0].status, 'checking')
  assert.equal(updater.getState().manifest, null)
})

test('portable and development builds can discover updates but cannot download or execute installers', async t => {
  const { updater, requests, installations } = fixture(t, undefined, false)
  assert.equal((await updater.check()).status, 'available')
  assert.equal((await updater.download()).status, 'error')
  assert.match(updater.getState().error!, /便携/)
  await updater.install()
  assert.equal(requests.filter(item => item.kind === 'artifact').length, 0); assert.deepEqual(installations, [])
  assert.equal(installationSupport(false, 'win32', process.execPath, false).canInstall, false)
  assert.equal(installationSupport(true, 'linux', process.execPath, false).canInstall, false)
  const directory = mkdtempSync(join(tmpdir(), 'yuyin-update-install-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const executable = join(directory, '余音.exe')
  assert.equal(installationSupport(true, 'win32', executable, false).canInstall, false)
  writeFileSync(join(directory, 'Uninstall 余音.exe'), 'controlled uninstaller marker')
  assert.equal(installationSupport(true, 'win32', executable, false).canInstall, true)
  assert.equal(installationSupport(true, 'win32', executable, true).canInstall, false)
})

test('the update launcher verifies its file before acknowledging readiness and can be cancelled without execution', async t => {
  const { directory } = fixture(t)
  const file = join(directory, 'controlled-Setup.exe'); writeFileSync(file, installerBytes)
  const launcher = await prepareUpdateInstaller(process.execPath, file, manifest())
  launcher.cancel()
  writeFileSync(file, Buffer.alloc(installerBytes.length))
  await assert.rejects(prepareUpdateInstaller(process.execPath, file, manifest()), /安装器启动失败/)
  assert.deepEqual(nsisUpdateArguments('D:\\余音 安装'), ['/S', '--updated', '--force-run', '/D=D:\\余音 安装'])
  assert.throws(() => nsisUpdateArguments('D:\\bad"path'))
  assert.equal(existsSync(join(directory, 'update-failed.txt')), false)
})

test('an installation canceled by the quit preparation retains the verified download and permits retry', async t => {
  const { updater, installations } = fixture(t)
  await updater.check(); await updater.download(); await updater.install()
  updater.reportInstallationFailure(new Error('受控窗口设置保存失败'))
  assert.equal(updater.getState().status, 'error')
  assert.match(updater.getState().error!, /保存失败/)
  assert.equal(updater.getState().manifest?.version, '0.5.0')
  assert.equal((await updater.download()).status, 'downloaded')
  assert.equal((await updater.install()).status, 'installing')
  assert.equal(installations.length, 2)
})
