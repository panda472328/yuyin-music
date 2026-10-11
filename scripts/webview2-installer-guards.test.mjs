import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execute = (file, args, env) => new Promise(resolveResult => execFile(file, args, {
  cwd: root, windowsHide: true, timeout: 30_000, env: { ...process.env, ...env }, encoding: 'utf8',
}, (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, stdout, stderr })))
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"')
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

test('WebView2 native installer guards stop before replacement without touching unrelated files', async t => {
  if (process.platform !== 'win32') {
    if (process.env.YUYIN_REQUIRE_INSTALLER_TESTS === '1') throw new Error('Native installer tests require Windows.')
    return t.skip('Windows-only native installer guards')
  }
  const require = createRequire(import.meta.url)
  const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows')
  const compiler = await getMakeNsisPath('0.0.0')
  const csc = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  await mkdir(join(root, '.qa'), { recursive: true })
  const qa = await mkdtemp(join(root, '.qa', 'webview2-installer-guards-'))
  const fixture = join(qa, 'lock.exe')
  await writeFile(join(qa, 'lock.cs'), 'using System; using System.IO; class Fixture { static void Main(string[] args) { using(var file = new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.None)) { File.WriteAllText(args[1], "ready"); Console.ReadLine(); } } }')
  const built = await execute(csc, ['/nologo', `/out:${fixture}`, join(qa, 'lock.cs')])
  assert.equal(built.code, 0, built.stdout + built.stderr)

  async function guard(name, target) {
    const installer = join(qa, `${name}.exe`)
    const proof = join(qa, `${name}.passed`)
    const source = join(qa, `${name}.nsi`)
    await writeFile(source, `\ufeffUnicode true\nName "Yuyin guard fixture"\nOutFile "${quote(installer)}"\nRequestExecutionLevel user\nSilentInstall silent\nVar ProbePath\n!include "${quote(join(root, 'build', 'webview2-installer-guards.nsh'))}"\n!insertmacro YuyinWebViewCheckFile ""\nSection\nStrCpy $ProbePath "${quote(target)}"\nCall CheckFile\nFileOpen $0 "${quote(proof)}" w\nFileWrite $0 "passed"\nFileClose $0\nSectionEnd\n`)
    const compile = await execute(compiler.path, ['-V2', source], compiler.env)
    assert.equal(compile.code, 0, compile.stdout + compile.stderr)
    const run = await execute(installer, ['/S'])
    const passed = await access(proof).then(() => true, () => false)
    return { ...run, passed }
  }
  const target = join(qa, '虚构 程序文件.dll')
  const original = Buffer.from('invented payload, must not be changed')
  await writeFile(target, original)
  await t.test('unlocked payload passes without changing bytes', async () => {
    const result = await guard('unlocked', target)
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(result.passed, true)
    assert.deepEqual(await readFile(target), original)
  })
  await t.test('missing payload passes', async () => {
    const result = await guard('missing', join(qa, 'missing.dll'))
    assert.equal(result.code, 0)
    assert.equal(result.passed, true)
  })
  const ready = join(qa, 'fixture-ready')
  const holder = spawn(fixture, [target, ready], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
  try {
    for (let attempts = 0; attempts < 100 && !await access(ready).then(() => true, () => false); attempts++) await delay(50)
    await access(ready)
    await t.test('exclusive lock stops with exit 2 and keeps holder alive', async () => {
      const result = await guard('locked', target)
      assert.equal(result.code, 2)
      assert.equal(result.passed, false)
      assert.equal(holder.exitCode, null)
    })
    await t.test('an unrelated locked file does not block a missing exact payload', async () => {
      const result = await guard('unrelated', join(qa, 'other.dll'))
      assert.equal(result.code, 0)
      assert.equal(result.passed, true)
      assert.equal(holder.exitCode, null)
    })
  } finally {
    holder.stdin.end('\n')
    await new Promise(resolveExit => holder.once('exit', resolveExit))
  }
  assert.deepEqual(await readFile(target), original)
})
