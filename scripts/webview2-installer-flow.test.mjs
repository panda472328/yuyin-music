import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, readFile, access, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"')
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const exists = file => access(file).then(() => true, () => false)
const execute = (file, args, env) => new Promise(resolveResult => execFile(file, args, {
  cwd: root, windowsHide: true, timeout: 30_000, env: { ...process.env, ...env }, encoding: 'utf8',
}, (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, stdout, stderr })))

test('WebView2 installer performs controlled install, update wait and exact uninstall', async t => {
  if (process.platform !== 'win32') return t.skip('Windows-only native NSIS integration')
  const require = createRequire(import.meta.url)
  const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows')
  const compiler = await getMakeNsisPath('0.0.0')
  await mkdir(join(root, '.qa'), { recursive: true })
  const qa = await mkdtemp(join(root, '.qa', 'webview2-installer-flow-'))
  const payload = join(qa, 'payload')
  const target = join(qa, '安装 测试')
  const shell = join(qa, 'shell')
  const desktop = join(shell, 'Desktop')
  const programs = join(shell, 'Programs')
  const csc = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const shortcutTool = join(qa, 'shortcut.exe')
  const shortcutBuild = await execute(csc, ['/nologo', `/out:${shortcutTool}`, join(root, 'scripts', 'fixtures', 'windows-shortcut.cs')])
  assert.equal(shortcutBuild.code, 0, shortcutBuild.stdout + shortcutBuild.stderr)
  const writeLinks = async entries => {
    for (const entry of entries) {
      await mkdir(dirname(entry.path), { recursive: true })
      const result = await execute(shortcutTool, ['write', qa, entry.path, entry.target])
      assert.equal(result.code, 0, result.stdout + result.stderr)
    }
  }
  const linkTarget = async file => {
    const result = await execute(shortcutTool, ['read', qa, file])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    return result.stdout.trim()
  }
  const application = join(target, 'Yuyin.WindowsHost.exe')
  const otherApplication = join(qa, 'other install', 'Yuyin.WindowsHost.exe')
  const legacyDesktop = join(desktop, 'openmusic音乐播放器.lnk')
  const newDesktop = join(desktop, 'open音乐.lnk')
  const otherDesktop = join(desktop, 'openmusic.lnk')
  const electronDesktop = join(desktop, '余音音乐播放器.lnk')
  const caseDesktop = join(desktop, '余音.lnk')
  const customDesktop = join(desktop, '我的音乐.lnk')
  const malformedLink = join(programs, '余音', '余音音乐播放器.lnk')
  // Keep all simulated legacy installations inside this QA directory. The
  // Unicode native helper avoids locale-dependent WScript COM conversions.
  const previousApplication = Buffer.from('MZ controlled previous application fixture')
  for (const file of [application, otherApplication, join(qa, 'electron install', '余音.exe'),
    join(target, 'Uninstall Yuyin.exe'), join(qa, 'other install', 'Uninstall Yuyin.exe')]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, previousApplication)
  }
  await writeLinks([
    { path: legacyDesktop, target: application },
    { path: otherDesktop, target: otherApplication },
    { path: electronDesktop, target: join(qa, 'electron install', '余音.exe') },
    { path: caseDesktop, target: application.toLowerCase() },
    { path: customDesktop, target: application },
    { path: join(programs, 'openmusic', 'openmusic音乐播放器.lnk'), target: application },
    { path: join(programs, 'openmusic', '卸载openmusic.lnk'), target: join(target, 'Uninstall Yuyin.exe') },
    { path: join(programs, '余音', '卸载余音.lnk'), target: join(qa, 'other install', 'Uninstall Yuyin.exe') },
  ])
  await t.test('Unicode shortcut fixtures round trip and reject paths outside QA', async () => {
    assert.equal((await linkTarget(legacyDesktop)).toLowerCase(), application.toLowerCase())
    const escaped = await execute(shortcutTool, ['write', qa, legacyDesktop, join(root, '.qa', 'outside-fixture.exe')])
    assert.equal(escaped.code, 1)
    assert.match(escaped.stderr, /must stay inside its QA directory/)
    assert.equal((await linkTarget(legacyDesktop)).toLowerCase(), application.toLowerCase())
  })
  await writeFile(malformedLink, 'controlled unreadable shortcut')
  const protectedFiles = [otherDesktop, electronDesktop, customDesktop, malformedLink, join(programs, '余音', '卸载余音.lnk')]
  const originalProtectedBytes = new Map(await Promise.all(protectedFiles.map(async file => [file, await readFile(file)])))
  await mkdir(join(payload, 'renderer'), { recursive: true })
  await writeFile(join(payload, 'Yuyin.WindowsHost.exe'), 'MZ controlled application fixture')
  await writeFile(join(payload, 'renderer', 'index.html'), 'controlled renderer fixture')
  const fixture = join(qa, 'lock.exe')
  await writeFile(join(qa, 'lock.cs'), 'using System; using System.IO; class Fixture { static void Main(string[] args) { using(var file = new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.None)) { File.WriteAllText(args[1], "ready"); Console.ReadLine(); } } }')
  const built = await execute(csc, ['/nologo', `/out:${fixture}`, join(qa, 'lock.cs')])
  assert.equal(built.code, 0, built.stdout + built.stderr)
  const installer = join(qa, 'installer.exe')
  const source = join(qa, 'installer.nsi')
  await writeFile(source, '\ufeff' + await readFile(join(root, 'build', 'webview2-installer.nsi'), 'utf8'))
  await writeFile(join(qa, 'guards.nsh'), 'StrCpy $ProbePath "$INSTDIR\\Yuyin.WindowsHost.exe"\nCall CheckFile\nStrCpy $ProbePath "$INSTDIR\\renderer\\index.html"\nCall CheckFile\n')
  await writeFile(join(qa, 'uninstall-guards.nsh'), 'StrCpy $ProbePath "$INSTDIR\\Yuyin.WindowsHost.exe"\nCall un.CheckFile\nStrCpy $ProbePath "$INSTDIR\\renderer\\index.html"\nCall un.CheckFile\n')
  await writeFile(join(qa, 'uninstall-files.nsh'), 'Delete "$INSTDIR\\Yuyin.WindowsHost.exe"\nDelete "$INSTDIR\\renderer\\index.html"\nRMDir "$INSTDIR\\renderer"\n')
  const compile = await execute(compiler.path, [
    '-V2', `-DYUYIN_ROOT=${root}`, '-DYUYIN_VERSION=0.0.1', `-DYUYIN_QA=${basename(qa)}`,
    `-DYUYIN_QA_INSTALLDIR=${target}`, `-DYUYIN_QA_SHELLROOT=${shell}`, `-DYUYIN_PAYLOAD=${payload}`, `-DYUYIN_INSTALLER=${installer}`,
    `-DYUYIN_BOOTSTRAPPER=${fixture}`, `-DYUYIN_GUARDS=${join(qa, 'guards.nsh')}`,
    `-DYUYIN_UNINSTALL_GUARDS=${join(qa, 'uninstall-guards.nsh')}`,
    `-DYUYIN_UNINSTALL_FILES=${join(qa, 'uninstall-files.nsh')}`, source,
  ], compiler.env)
  assert.equal(compile.code, 0, compile.stdout + compile.stderr)

  await t.test('invalid updater PID stops before extraction', async () => {
    for (const pid of ['abc', '0', '9999999999', '0001']) {
      const result = await execute(installer, ['/S', `/YUYINPID=${pid}`])
      assert.equal(result.code, 2, result.stdout + result.stderr)
      assert.equal(await exists(join(target, 'installed.marker')), false)
      assert.deepEqual(await readFile(application), previousApplication)
    }
  })
  await t.test('unrelated shortcut with the new display name blocks before extraction', async () => {
    await writeLinks([{ path: newDesktop, target: otherApplication }])
    const result = await execute(installer, ['/S'])
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.equal(await exists(join(target, 'installed.marker')), false)
    assert.deepEqual(await readFile(application), previousApplication)
    assert.equal((await linkTarget(newDesktop)).toLowerCase(), otherApplication.toLowerCase())
    assert.equal(await exists(legacyDesktop), true)
    // A shortcut belonging to this install can be replaced by the installer.
    await writeLinks([{ path: newDesktop, target: application }])
  })
  await t.test('failed desktop shortcut directory preserves the old Start Menu entry', async () => {
    const legacyMenu = join(programs, 'openmusic', 'openmusic音乐播放器.lnk')
    const legacyBytes = await readFile(legacyMenu)
    const parkedDesktop = join(shell, 'Desktop-parked')
    await rename(desktop, parkedDesktop)
    await writeFile(desktop, 'controlled obstruction')
    try {
      const result = await execute(installer, ['/S'])
      assert.equal(result.code, 2, result.stdout + result.stderr)
      assert.deepEqual(await readFile(legacyMenu), legacyBytes)
      assert.equal(await exists(join(programs, 'open音乐', 'open音乐.lnk')), false)
    } finally {
      await unlink(desktop)
      await rename(parkedDesktop, desktop)
    }
  })
  await t.test('first install writes scoped marker and exact fixture files', async () => {
    const result = await execute(installer, ['/S'])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(await readFile(join(target, 'installed.marker'), 'utf8'), 'yuyin-webview2-installed-v1')
    assert.equal(await readFile(join(target, 'renderer', 'index.html'), 'utf8'), 'controlled renderer fixture')
    assert.equal(await exists(join(target, 'Uninstall Yuyin.exe')), true)
  })
  await t.test('migration replaces managed same-target links and preserves unrelated links', async () => {
    for (const file of [legacyDesktop, caseDesktop, join(programs, 'openmusic', 'openmusic音乐播放器.lnk'), join(programs, 'openmusic', '卸载openmusic.lnk')]) {
      assert.equal(await exists(file), false, `Old owned shortcut remained: ${file}`)
    }
    for (const [file, bytes] of originalProtectedBytes) {
      assert.deepEqual(await readFile(file), bytes, `Unrelated shortcut was changed: ${file}`)
    }
    assert.equal(await readFile(malformedLink, 'utf8'), 'controlled unreadable shortcut')
    for (const file of [newDesktop, join(programs, 'open音乐', 'open音乐.lnk')]) {
      assert.equal((await linkTarget(file)).toLowerCase(), application.toLowerCase())
    }
    assert.equal((await linkTarget(join(programs, 'open音乐', '卸载open音乐.lnk'))).toLowerCase(), join(target, 'Uninstall Yuyin.exe').toLowerCase())
  })
  const unrelated = join(target, 'leave-this-user-file.txt')
  await writeFile(unrelated, 'controlled unrelated file')
  const ready = join(qa, 'fixture-ready')
  const holder = spawn(fixture, [join(target, 'Yuyin.WindowsHost.exe'), ready], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
  try {
    for (let attempt = 0; attempt < 100 && !await exists(ready); attempt++) await delay(50)
    assert.equal(await exists(ready), true)
    await t.test('occupied exact payload stops without killing the fixture', async () => {
      const result = await execute(installer, ['/S'])
      assert.equal(result.code, 2)
      assert.equal(holder.exitCode, null)
    })
    await t.test('update waits for the supplied process to exit naturally', async () => {
      await writeLinks([{ path: legacyDesktop, target: application }])
      const resultPromise = execute(installer, ['/S', `/YUYINPID=${holder.pid}`])
      await delay(350)
      assert.equal(holder.exitCode, null)
      const exited = new Promise(resolveExit => holder.once('exit', resolveExit))
      holder.stdin.end('\n')
      await exited
      const result = await resultPromise
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.equal(await readFile(unrelated, 'utf8'), 'controlled unrelated file')
      assert.equal(await exists(legacyDesktop), false)
      assert.equal((await linkTarget(newDesktop)).toLowerCase(), application.toLowerCase())
    })
  } finally {
    if (holder.exitCode === null) {
      const exited = new Promise(resolveExit => holder.once('exit', resolveExit))
      holder.stdin.end('\n')
      await exited
    }
  }
  await t.test('uninstall removes bundled files and keeps unrelated data', async () => {
    // If the user changes a managed link to another installation after setup,
    // uninstall must leave it intact while removing still-owned menu links.
    await writeLinks([{ path: newDesktop, target: otherApplication }])
    const file = join(target, 'Uninstall Yuyin.exe')
    const child = spawn(file, ['/S', `_?=${target}`], { cwd: root, argv0: `"${file}"`, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' })
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', resolveExit)
    })
    assert.equal(code, 0)
    assert.equal(await exists(join(target, 'Yuyin.WindowsHost.exe')), false)
    assert.equal(await exists(join(target, 'installed.marker')), false)
    assert.equal(await readFile(unrelated, 'utf8'), 'controlled unrelated file')
    assert.equal((await linkTarget(newDesktop)).toLowerCase(), otherApplication.toLowerCase())
    assert.equal(await exists(join(programs, 'open音乐', 'open音乐.lnk')), false)
    assert.equal(await exists(join(programs, 'open音乐', '卸载open音乐.lnk')), false)
    for (const [file, bytes] of originalProtectedBytes) assert.deepEqual(await readFile(file), bytes)
  })
})
