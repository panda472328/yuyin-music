import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const required = process.env.YUYIN_REQUIRE_INSTALLER_TESTS === '1'
const execute = (file, args, env) => new Promise(resolve => execFile(file, args, {
  cwd: root, windowsHide: true, timeout: 30_000, encoding: 'utf8', maxBuffer: 2_000_000,
  env: env ? { ...process.env, ...env } : process.env,
}, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))
// NSIS _?=, like /D=, must be last and unquoted even when it contains spaces.
const executeUninstaller = (file, target) => new Promise((resolve, reject) => {
  const child = spawn(file, ['/S', `_?=${target}`], { cwd: root, argv0: `"${file}"`,
    windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' })
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Test uninstaller timed out')) }, 30_000)
  child.once('error', error => { clearTimeout(timeout); reject(error) })
  child.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout: '', stderr: '' }) })
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = text => text.replaceAll('$', '$$').replaceAll('"', '$\\"')

function compilerIn(directory) {
  // electron-builder's legacy Windows bundle keeps the compiler in Bin, but
  // Include/Plugins and nsisconf.nsh remain at the bundle root. Match its
  // explicit NSISDIR instead of relying on a locally copied root executable.
  directory = path.resolve(directory)
  for (const file of [path.join(directory, 'Bin', 'makensis.exe'), path.join(directory, 'makensis.exe')]) {
    if (!existsSync(file)) continue
    const bundle = path.basename(path.dirname(file)).toLowerCase() === 'bin'
      ? path.dirname(path.dirname(file)) : directory
    return { path: file, env: { NSISDIR: bundle } }
  }
  return null
}

async function compilerPath() {
  if (process.env.YUYIN_NSIS_DIR) return compilerIn(process.env.YUYIN_NSIS_DIR)
  const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
  for (const name of await fs.readdir(cache).catch(() => [])) {
    if (!name.startsWith('nsis-')) continue
    const directory = path.join(cache, name)
    for (const child of ['', ...await fs.readdir(directory).catch(() => [])]) {
      const compiler = compilerIn(path.join(directory, child))
      if (compiler) return compiler
    }
  }
  return null
}

test('Windows installer guards stop before file replacement, without killing unrelated processes', async t => {
  if (process.platform !== 'win32') {
    if (required) throw new Error('Installer guard verification requires Windows.')
    return t.skip('Windows-only native NSIS verification')
  }
  const nsis = await compilerPath()
  const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!nsis || !existsSync(nsis.path) || !existsSync(csc)) {
    if (required) throw new Error('Build the Windows installer first to cache NSIS; .NET Framework csc.exe is also required.')
    return t.skip('NSIS/.NET compiler unavailable; run after dist:installer')
  }
  await fs.mkdir(path.join(root, '.qa'), { recursive: true })
  const qa = await fs.mkdtemp(path.join(root, '.qa', 'installer-guards-'))
  const fixtureSource = path.join(qa, 'Fixture.cs')
  const fixtureExe = path.join(qa, 'fixture.exe')
  await fs.writeFile(fixtureSource, `using System; using System.IO;
class Fixture { static void Main(string[] args) {
  FileStream held = args.Length > 1 ? new FileStream(args[1], FileMode.Open, FileAccess.Read, FileShare.None) : null;
  File.WriteAllText(args[0], "ready"); Console.ReadLine(); if (held != null) held.Dispose();
} }`)
  const compiled = await execute(csc, ['/nologo', '/target:exe', `/out:${fixtureExe}`, fixtureSource])
  assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr)
  let count = 0
  const children = new Set()
  const evidence = { scope: 'Real compiled repository NSIS macros and harmless owned processes. No installation, registry write, shortcuts, account or user profile access.', checks: [] }
  const save = () => fs.writeFile(path.join(qa, 'evidence.json'), JSON.stringify(evidence, null, 2))
  async function startFixture(file, heldFile) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.copyFile(fixtureExe, file)
    const ready = path.join(qa, `ready-${++count}.txt`)
    const child = spawn(file, [ready, ...(heldFile ? [heldFile] : [])], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    children.add(child)
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
    for (let i = 0; i < 100 && !existsSync(ready) && child.exitCode === null; i++) await delay(50)
    assert.ok(existsSync(ready), 'Fixture failed to start: ' + stderr)
    return child
  }
  async function closeFixture(child) {
    if (child.exitCode !== null) { children.delete(child); return }
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.stdin.end('\n')
    await Promise.race([exited, delay(4000).then(() => { if (child.exitCode === null) child.kill() })])
    children.delete(child)
  }
  async function runHarness(name, { target, instructions = '!insertmacro customCheckAppRunning', inside = false, uninstall = false, pageHook = false } = {}) {
    const number = ++count
    target ||= path.join(qa, `target-${number} 安装 余音`)
    await fs.mkdir(target, { recursive: true })
    const out = inside ? path.join(target, `harness-${number}.exe`) : path.join(qa, `harness-${number}.exe`)
    const marker = path.join(qa, `passed-${number}.txt`)
    const source = path.join(qa, `harness-${number}.nsi`)
    const uninstaller = path.join(target, 'Uninstall 余音.exe')
    const writeMarker = `FileOpen $0 "${quote(marker)}" w\nFileWrite $0 "guard passed"\nFileClose $0\nSetErrorLevel 0`
    const main = uninstall ? `Section\nWriteUninstaller "${quote(uninstaller)}"\nSectionEnd
Section "Uninstall"
StrCpy $INSTDIR "${quote(target)}"
${instructions}
${writeMarker}
SectionEnd` : `Section
StrCpy $INSTDIR "${quote(target)}"
StrCpy $installMode CurrentUser
${instructions}
${writeMarker}
SectionEnd`
    await fs.writeFile(source, '\ufeff' + `Unicode true
Name "Yuyin isolated guard verification"
OutFile "${quote(out)}"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
AutoCloseWindow true
!include LogicLib.nsh
!include FileFunc.nsh
!define APP_EXECUTABLE_FILENAME "余音.exe"
!define UNINSTALL_FILENAME "Uninstall 余音.exe"
!define INSTALL_REGISTRY_KEY "Software\\YuyinGuardTest-${path.basename(qa)}"
!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\YuyinGuardTest-${path.basename(qa)}"
!define SHELL_CONTEXT HKCU
!define UAC_IsAdmin "1 == 1"
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
Var installMode
!include "${quote(path.join(root, 'build', 'installer.nsh'))}"
${pageHook ? `!define allowToChangeInstallationDirectory
!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre
Function instFilesPre
StrCpy $INSTDIR "$INSTDIR\\sanitized"
FunctionEnd
!insertmacro customPageAfterChangeDir` : ''}
${main}`)
    const build = await execute(nsis.path, ['/V2', source], nsis.env)
    assert.equal(build.code, 0, build.stdout + build.stderr)
    const generated = await execute(out, ['/S'])
    const result = uninstall ? await executeUninstaller(uninstaller, target) : generated
    evidence.checks.push({ name, code: result.code, payloadReached: existsSync(marker) })
    await save()
    return { ...result, passed: existsSync(marker), target }
  }
  async function expectStop(name, options) {
    const result = await runHarness(name, options)
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.equal(result.passed, false, 'Failed guard continued to replacement marker')
  }
  try {
    await t.test('fresh writable target passes', async () => {
      const r = await runHarness('fresh target'); assert.equal(r.code, 0); assert.equal(r.passed, true)
      assert.deepEqual(await fs.readdir(r.target), [], 'Write probe was not cleaned up')
    })
    await t.test('exact installed executable is locked, stopped, and never killed', async () => {
      const target = path.join(qa, 'live target')
      const child = await startFixture(path.join(target, '余音.exe'))
      try { await expectStop('exact live app', { target }); assert.equal(child.exitCode, null) }
      finally { await closeFixture(child) }
      const after = await runHarness('app closed normally', { target }); assert.equal(after.code, 0); assert.equal(after.passed, true)
    })
    await t.test('same image elsewhere and a prefix sibling survive', async () => {
      const target = path.join(qa, 'prefix target')
      const other = await startFixture(path.join(qa, 'other directory', '余音.exe'))
      const sibling = await startFixture(path.join(qa, 'prefix target-other', '余音.exe'))
      const helper = await startFixture(path.join(target, 'unrelated.exe'))
      try {
        const r = await runHarness('unrelated processes', { target }); assert.equal(r.code, 0); assert.equal(r.passed, true)
        for (const child of [other, sibling, helper]) assert.equal(child.exitCode, null)
      } finally { await Promise.all([other, sibling, helper].map(closeFixture)) }
    })
    await t.test('installer executing inside target stops before replacement', () => expectStop('installer in target', { inside: true }))
    await t.test('silent initialization checks before any install section action', () => expectStop('silent initialization inside target', {
      inside: true, instructions: '!insertmacro customInit',
    }))
    await t.test('visible page callback preserves upstream path sanitization and checks the final path', async () => {
      const target = path.join(qa, 'page callback target')
      const r = await runHarness('visible sanitized target', { target, pageHook: true, instructions: 'Call YuyinInstFilesPre' })
      assert.equal(r.code, 0); assert.equal(r.passed, true)
      assert.deepEqual(await fs.readdir(target), ['sanitized'])
      const file = path.join(target, 'sanitized', 'Uninstall 余音.exe')
      await fs.writeFile(file, 'controlled')
      await fs.chmod(file, 0o444)
      try { await expectStop('visible callback locked final path', { target, pageHook: true, instructions: 'Call YuyinInstFilesPre' }) }
      finally { await fs.chmod(file, 0o666) }
    })
    await t.test('exclusive uninstaller lock stops without changing its bytes', async () => {
      const target = path.join(qa, 'locked uninstaller'); await fs.mkdir(target)
      const file = path.join(target, 'Uninstall 余音.exe'); const bytes = Buffer.from('controlled uninstaller fixture')
      await fs.writeFile(file, bytes)
      const holder = await startFixture(path.join(qa, 'lock holder.exe'), file)
      try { await expectStop('locked uninstaller', { target }); assert.equal(holder.exitCode, null) }
      finally { await closeFixture(holder) }
      assert.deepEqual(await fs.readFile(file), bytes)
    })
    await t.test('read-only uninstaller stops before replacement', async () => {
      const target = path.join(qa, 'read-only uninstaller'); await fs.mkdir(target)
      const file = path.join(target, 'Uninstall 余音.exe'); await fs.writeFile(file, 'controlled')
      await fs.chmod(file, 0o444)
      try { await expectStop('read-only uninstaller', { target }) }
      finally { await fs.chmod(file, 0o666) }
      assert.equal(await fs.readFile(file, 'utf8'), 'controlled')
    })
    await t.test('old uninstaller launch failure, nonzero exit and false success all stop', async () => {
      await expectStop('uninstaller launch failure', { instructions: 'StrCpy $R0 0\nSetErrors\n!insertmacro customUnInstallCheck' })
      await expectStop('uninstaller nonzero', { instructions: 'StrCpy $R0 2\nClearErrors\n!insertmacro customUnInstallCheckCurrentUser' })
      const target = path.join(qa, 'failed old removal'); await fs.mkdir(target)
      await fs.writeFile(path.join(target, '余音.exe'), 'old payload')
      await expectStop('false uninstall success', { target, instructions: 'StrCpy $YuyinOldShellDirectory $INSTDIR\nStrCpy $R0 0\nClearErrors\n!insertmacro customUnInstallCheck' })
      assert.equal(await fs.readFile(path.join(target, '余音.exe'), 'utf8'), 'old payload')
    })
    await t.test('successful old removal passes', async () => {
      const r = await runHarness('old removal succeeded', { instructions: 'StrCpy $YuyinOldUserDirectory $INSTDIR\nStrCpy $R0 0\nClearErrors\n!insertmacro customUnInstallCheckCurrentUser' })
      assert.equal(r.code, 0); assert.equal(r.passed, true)
    })
    await t.test('missing old install location falls back to a quoted absolute uninstall path', async () => {
      for (const expected of [path.join(qa, '旧版 中文与空格'), 'C:\\', '\\\\server\\share\\余音']) {
        const resultFile = path.join(qa, `parsed-${++count}.txt`)
        const command = `"${path.win32.join(expected, 'Uninstall 余音.exe')}" /currentuser`
        const r = await runHarness('old uninstall path fallback', { instructions: `StrCpy $YuyinOldUninstallCommand "${quote(command)}"
Call YuyinParseOldUninstallDirectory
FileOpen $0 "${quote(resultFile)}" w
FileWriteUTF16LE $0 "$YuyinParsedDirectory"
FileClose $0` })
        assert.equal(r.code, 0); assert.equal(r.passed, true)
        assert.equal(await fs.readFile(resultFile, 'utf16le'), expected)
      }
      for (const command of ['unquoted.exe /currentuser', '"relative\\Uninstall 余音.exe"', '"C:\\missing closing quote.exe']) {
        await expectStop('invalid old uninstall path', { instructions: `StrCpy $YuyinOldUninstallCommand "${quote(command)}"\nCall YuyinParseOldUninstallDirectory` })
      }
    })
    await t.test('new uninstaller excludes its own executable', async () => {
      const r = await runHarness('uninstaller self excluded', { uninstall: true }); assert.equal(r.code, 0); assert.equal(r.passed, true)
    })
  } finally {
    await Promise.all([...children].map(closeFixture))
    await save()
    t.diagnostic(`Evidence: ${path.relative(root, path.join(qa, 'evidence.json'))}`)
  }
})
