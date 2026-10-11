import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises'
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
  await mkdir(join(payload, 'renderer'), { recursive: true })
  await writeFile(join(payload, 'Yuyin.WindowsHost.exe'), 'MZ controlled application fixture')
  await writeFile(join(payload, 'renderer', 'index.html'), 'controlled renderer fixture')
  const fixture = join(qa, 'lock.exe')
  const csc = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
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
    `-DYUYIN_QA_INSTALLDIR=${target}`, `-DYUYIN_PAYLOAD=${payload}`, `-DYUYIN_INSTALLER=${installer}`,
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
    }
  })
  await t.test('first install writes scoped marker and exact fixture files', async () => {
    const result = await execute(installer, ['/S'])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(await readFile(join(target, 'installed.marker'), 'utf8'), 'yuyin-webview2-installed-v1')
    assert.equal(await readFile(join(target, 'renderer', 'index.html'), 'utf8'), 'controlled renderer fixture')
    assert.equal(await exists(join(target, 'Uninstall Yuyin.exe')), true)
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
      const resultPromise = execute(installer, ['/S', `/YUYINPID=${holder.pid}`])
      await delay(350)
      assert.equal(holder.exitCode, null)
      const exited = new Promise(resolveExit => holder.once('exit', resolveExit))
      holder.stdin.end('\n')
      await exited
      const result = await resultPromise
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.equal(await readFile(unrelated, 'utf8'), 'controlled unrelated file')
    })
  } finally {
    if (holder.exitCode === null) {
      const exited = new Promise(resolveExit => holder.once('exit', resolveExit))
      holder.stdin.end('\n')
      await exited
    }
  }
  await t.test('uninstall removes bundled files and keeps unrelated data', async () => {
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
  })
})
