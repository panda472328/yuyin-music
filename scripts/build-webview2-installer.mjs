import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.')
if (process.argv.slice(2).some(arg => !['--x64', '--publish', 'never'].includes(arg))) throw new Error('The installer currently targets Windows x64 only.')
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const payload = join(root, 'release', 'webview2', 'win-x64-self-contained')
const marker = JSON.parse(await readFile(join(payload, '.yuyin-webview2-output.json'), 'utf8'))
if (marker.kind !== 'yuyin-webview2-publish' || marker.runtime !== 'win-x64' || marker.selfContained !== true || marker.version !== version) {
  throw new Error('Publish the current self-contained host first with npm run publish:webview2.')
}

async function filesIn(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const local = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error('Installer payload cannot contain symlinks.')
    if (entry.isDirectory()) result.push(...await filesIn(join(directory, entry.name), local + '/'))
    else if (entry.isFile()) result.push(local)
    else throw new Error('Installer payload contains an unsupported file type.')
  }
  return result.sort()
}
const files = await filesIn(payload)
for (const required of ['Yuyin.WindowsHost.exe', 'bridge.js', 'renderer/index.html', 'renderer/desktop-lyrics.html', 'System.Private.CoreLib.dll', 'Microsoft.Windows.SDK.NET.dll', 'WinRT.Runtime.dll']) {
  if (!files.includes(required)) throw new Error(`Incomplete self-contained payload: ${required}`)
}
if (files.some(file => /(^|\/)(?:electron\.exe|msedgewebview2\.exe|chrome_elf\.dll|icudtl\.dat|app\.asar)$/i.test(file))) {
  throw new Error('WebView2 payload must not bundle a browser engine.')
}
const staging = await mkdtemp(join(root, 'release', 'webview2', '.installer-'))
const installer = join(root, 'release', `Yuyin-${version}-Setup.exe`)
const temporaryInstaller = join(staging, `Yuyin-${version}-Setup.exe`)
const quoteNsis = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"').replaceAll('/', '\\')
const windowsFiles = files.map(quoteNsis)
const guards = windowsFiles.map(file => `StrCpy $ProbePath "$INSTDIR\\${file}"\nCall CheckFile`).join('\n')
const uninstallGuards = windowsFiles.map(file => `StrCpy $ProbePath "$INSTDIR\\${file}"\nCall un.CheckFile`).join('\n')
const directories = new Set()
for (const file of files) {
  let current = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  while (current) {
    directories.add(current)
    current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : ''
  }
}
const uninstall = windowsFiles.map(file => `Delete "$INSTDIR\\${file}"`).concat(
  [...directories].sort((a, b) => b.length - a.length).map(directory => `RMDir "$INSTDIR\\${quoteNsis(directory)}"`),
).join('\n')

try {
  await writeFile(join(staging, 'guards.nsh'), guards + '\n', 'utf8')
  await writeFile(join(staging, 'uninstall-guards.nsh'), uninstallGuards + '\n', 'utf8')
  await writeFile(join(staging, 'uninstall-files.nsh'), uninstall + '\n', 'utf8')
  // Legacy NSIS detects UTF-8 reliably from a BOM. This also preserves Chinese
  // repository paths in include/File directives on non-UTF8 Windows systems.
  await writeFile(join(staging, 'installer.nsi'), '\ufeff' + await readFile(join(root, 'build', 'webview2-installer.nsi'), 'utf8'), 'utf8')

  const bootstrapper = join(staging, 'MicrosoftEdgeWebview2Setup.exe')
  console.log('Downloading the Microsoft Evergreen bootstrapper (no browser engine is embedded).')
  const response = await fetch('https://go.microsoft.com/fwlink/p/?LinkId=2124703', { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Microsoft bootstrapper download returned HTTP ${response.status}.`)
  const chunks = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 5_000_000) throw new Error('WebView2 bootstrapper exceeds the 5MB limit; refuse a runtime bundle.')
    chunks.push(chunk)
  }
  const binary = Buffer.concat(chunks)
  if (binary.length < 2 || binary.subarray(0, 2).toString() !== 'MZ') throw new Error('Microsoft bootstrapper is not a Windows executable.')
  await writeFile(bootstrapper, binary)
  const signatureEnvironment = { ...process.env, YUYIN_BOOTSTRAPPER_PATH: bootstrapper }
  // PowerShell 7's inherited module path is incompatible with the Windows
  // PowerShell 5.1 Security module. Let that child initialize its own defaults.
  delete signatureEnvironment.PSModulePath
  const signature = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    "$runtimeSignature = Get-AuthenticodeSignature -LiteralPath $env:YUYIN_BOOTSTRAPPER_PATH; if ($runtimeSignature.Status -ne 'Valid' -or $runtimeSignature.SignerCertificate.Subject -notmatch '(^|,\\s*)O=Microsoft Corporation(,|$)') { Write-Error 'Microsoft bootstrapper signature validation failed'; exit 2 }"],
    { env: signatureEnvironment, stdio: 'inherit', windowsHide: true })
  if (signature.error || signature.status !== 0) throw new Error('The WebView2 bootstrapper must have a valid Microsoft Authenticode signature.')
  console.log(`Verified Microsoft bootstrapper: ${bytes} bytes, SHA256 ${createHash('sha256').update(binary).digest('hex')}`)

  const require = createRequire(import.meta.url)
  const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows')
  const compiler = await getMakeNsisPath('0.0.0')
  const result = spawnSync(compiler.path, [
    '-V2', `-DYUYIN_ROOT=${root}`, `-DYUYIN_VERSION=${version}`,
    `-DYUYIN_PAYLOAD=${payload}`, `-DYUYIN_INSTALLER=${temporaryInstaller}`,
    `-DYUYIN_BOOTSTRAPPER=${bootstrapper}`, `-DYUYIN_GUARDS=${join(staging, 'guards.nsh')}`,
    `-DYUYIN_UNINSTALL_GUARDS=${join(staging, 'uninstall-guards.nsh')}`,
    `-DYUYIN_UNINSTALL_FILES=${join(staging, 'uninstall-files.nsh')}`,
    join(staging, 'installer.nsi'),
  ], { cwd: root, env: { ...process.env, ...compiler.env }, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`NSIS compilation failed (${result.status ?? result.signal}).`)
  const { copyFile } = await import('node:fs/promises')
  await copyFile(temporaryInstaller, installer)
  const size = (await lstat(installer)).size
  console.log(`Windows WebView2 installer: ${installer} (${size} bytes)`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
