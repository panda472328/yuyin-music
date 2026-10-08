import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { UpdateManifest } from '../src/shared/update'

/** No shell expansion; NSIS requires /D to be the final, unquoted argument. */
export function nsisUpdateArguments(directory: string): string[] {
  if (!directory || /[\u0000\r\n"]/.test(directory)) throw new Error('安装目录不合法。')
  return ['/S', '--updated', '--force-run', `/D=${directory}`]
}

export function installationSupport(packaged: boolean, platform: string, executable: string, portable: boolean) {
  if (!packaged) return { canInstall: false, installDisabledReason: '开发预览支持检查更新；请安装正式版后使用应用内更新。' }
  if (platform !== 'win32') return { canInstall: false, installDisabledReason: '应用内安装更新目前只支持 Windows 安装版。' }
  const uninstaller = join(dirname(executable), `Uninstall ${basename(executable, '.exe')}.exe`)
  if (portable || !existsSync(uninstaller)) return { canInstall: false, installDisabledReason: '便携版不支持覆盖更新。请在发布页下载安装版，之后即可在应用内更新。' }
  return { canInstall: true, installDisabledReason: null }
}

// This trusted, fixed helper runs in Electron's Node mode. It cannot start the installer
// until the parent authorizes it after saving, and the parent process has actually exited.
export const UPDATE_LAUNCHER_SOURCE = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const path = require('node:path');
const [file, expectedSize, expectedHash, parentPid, directory] = process.argv.slice(1);
let authorized = false; let prepared = false; let ended = false;
const cleanEnv = { ...process.env }; delete cleanEnv.ELECTRON_RUN_AS_NODE; delete cleanEnv.NODE_OPTIONS; delete cleanEnv.NODE_PATH;
function fail() {
  if (ended) return; ended = true;
  if (process.connected) process.send({ error: '更新安装器启动失败，请重新下载后重试。' });
  else {
    try { fs.writeFileSync(path.join(path.dirname(file), 'update-failed.txt'), 'Update installation failed. Reopen Yuyin and retry.\n', { mode: 0o600 }); } catch {}
    try {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const ps = cp.spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('更新安装失败，请重新打开余音并重试，或从 GitHub 发布页下载最新安装包。','余音更新') | Out-Null"], { windowsHide: true, detached: true, stdio: 'ignore', env: cleanEnv });
      ps.on('error', () => {}); ps.unref();
    } catch {}
  }
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
async function verify() {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(expectedSize)) throw new Error('size');
  const hash = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of fs.createReadStream(file)) { size += chunk.length; if (size > Number(expectedSize)) throw new Error('size'); hash.update(chunk); }
  if (size !== Number(expectedSize) || hash.digest('hex') !== expectedHash) throw new Error('hash');
}
function parentExists() { try { process.kill(Number(parentPid), 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
async function waitForExit() {
  if (!prepared || !authorized || ended) return;
  const deadline = Date.now() + 120000;
  while (parentExists()) { if (Date.now() > deadline) return fail(); await new Promise(resolve => setTimeout(resolve, 250)); }
  try {
    await verify();
    // With verbatim arguments Node also leaves argv[0] unquoted. Quote the executable
    // explicitly so NSIS can find the real switches when the cache path has spaces.
    const child = cp.spawn(file, ['/S', '--updated', '--force-run', '/D=' + directory], { argv0: '"' + file + '"', detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: cleanEnv });
    child.once('error', fail);
    child.once('spawn', () => { child.unref(); ended = true; process.exit(0); });
  } catch { fail(); }
}
process.on('message', message => { if (message && message.start === true && !authorized) { authorized = true; void waitForExit(); } });
process.on('disconnect', () => { if (!authorized) process.exit(0); });
void verify().then(() => { prepared = true; if (!process.connected) return process.exit(0); process.send({ ready: true }); }).catch(fail);
`

export interface PreparedUpdateInstaller {
  startAfterExit(): Promise<void>
  cancel(): void
}

export async function prepareUpdateInstaller(executable: string, file: string, manifest: UpdateManifest): Promise<PreparedUpdateInstaller> {
  const directory = dirname(executable)
  nsisUpdateArguments(directory)
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS; delete environment.NODE_PATH
  const child = spawn(executable, ['-e', UPDATE_LAUNCHER_SOURCE, '--', file, String(manifest.artifact.size), manifest.artifact.sha256, String(process.pid), directory], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: environment,
  })
  await awaitLauncher(child)
  return {
    startAfterExit: () => new Promise<void>((resolve, reject) => {
      if (!child.connected) { child.kill(); reject(new Error('更新安装器已退出，请重试。')); return }
      child.send({ start: true }, error => {
        if (error) { child.kill(); reject(new Error('更新安装器启动失败，请重试。')); return }
        child.disconnect(); child.unref(); resolve()
      })
    }),
    cancel: () => { if (child.connected) child.disconnect(); child.kill() },
  }
}

function awaitLauncher(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), 30_000)
    const cleanup = () => { clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', fail); child.removeListener('message', receive) }
    const fail = () => { cleanup(); child.kill(); reject(new Error('更新安装器启动失败，请重试。')) }
    const receive = (value: unknown) => {
      if (value && typeof value === 'object' && 'ready' in value && value.ready === true) { cleanup(); child.on('error', () => undefined); resolve() }
      else fail()
    }
    child.once('error', fail); child.once('exit', fail); child.on('message', receive)
  })
}
