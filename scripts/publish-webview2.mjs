import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowedRuntimes = new Set(['win-x64', 'win-arm64'])
const args = process.argv.slice(2)
let runtime = 'win-x64'
let selfContained = true
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (flag === '--runtime') {
    runtime = args[++index]
    if (!allowedRuntimes.has(runtime)) throw new Error('Use --runtime win-x64 or win-arm64.')
  } else if (flag === '--self-contained') selfContained = true
  else if (flag === '--framework-dependent') selfContained = false
  else throw new Error(`Unknown WebView2 publish option: ${flag}`)
}
if (process.platform !== 'win32') throw new Error('Publish the WPF host on Windows.')

const bundledDotnet = join(root, '.tools', 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')
const configuredDotnet = process.env.YUYIN_DOTNET_EXECUTABLE
const dotnet = configuredDotnet || (process.platform === 'win32' && (await lstat(bundledDotnet).catch(() => null))?.isFile() ? bundledDotnet : 'dotnet')
if (dotnet !== 'dotnet' && !isAbsolute(dotnet)) throw new Error('YUYIN_DOTNET_EXECUTABLE must be an absolute path to dotnet.exe.')
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const renderer = join(root, 'out', 'webview2-renderer')
for (const file of ['index.html', 'desktop-lyrics.html']) {
  if (!(await lstat(join(renderer, file)).catch(() => null))?.isFile()) {
    throw new Error('Build the renderer first with npm run build:webview2.')
  }
}

const publishRoot = join(root, 'release', 'webview2')
const outputName = `${runtime}${selfContained ? '-self-contained' : ''}`
const output = join(publishRoot, outputName)
const marker = '.yuyin-webview2-output.json'
await mkdir(publishRoot, { recursive: true })
const repositoryRealPath = await realpath(root)
const publishRealPath = await realpath(publishRoot)
const publishWithinRepository = relative(repositoryRealPath, publishRealPath)
if (!publishWithinRepository || publishWithinRepository === '..' || publishWithinRepository.startsWith(`..${sep}`) || isAbsolute(publishWithinRepository)) {
  throw new Error('WebView2 publish directory resolves outside the repository.')
}

// A rerun may only replace this script's own output. Never clear an arbitrary
// directory selected by a CLI option or follow a symlink outside the repo.
function requireOwnedPath(path) {
  const child = relative(publishRoot, path)
  if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('Unsafe WebView2 output path.')
}
requireOwnedPath(output)
const previous = await lstat(output).catch(error => {
  if (error.code === 'ENOENT') return null
  throw error
})
if (previous) {
  if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('WebView2 output is not an owned directory.')
  const owned = JSON.parse(await readFile(join(output, marker), 'utf8'))
  if (owned.kind !== 'yuyin-webview2-publish' || owned.runtime !== runtime || owned.selfContained !== selfContained) {
    throw new Error('Existing output was not created by this publish command.')
  }
}

const staging = await mkdtemp(join(publishRoot, '.staging-'))
requireOwnedPath(staging)
try {
  const result = spawnSync(dotnet, [
    'publish', join(root, 'windows-host', 'Yuyin.WindowsHost.csproj'),
    '-c', 'Release', '-r', runtime, '--self-contained', String(selfContained),
    '-p:DebugType=None', '-p:DebugSymbols=false', `-p:Version=${packageInfo.version}`,
    '-o', staging,
  ], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw new Error(`.NET SDK 8 is required: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`dotnet publish failed (${result.status ?? result.signal}).`)
  await cp(renderer, join(staging, 'renderer'), { recursive: true })
  await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'))
  await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(staging, 'THIRD_PARTY_NOTICES.md'))
  await cp(join(root, 'licenses'), join(staging, 'licenses'), { recursive: true })
  // Preserve the original terms for the WebView2 SDK and any bundled .NET
  // runtime packages. Package assets only point at dependency caches.
  const assets = JSON.parse(await readFile(join(root, 'windows-host', 'obj', 'project.assets.json'), 'utf8'))
  for (const [name, info] of Object.entries(assets.libraries)) {
    if (!/^Microsoft\.(Web\.WebView2|Windows\.SDK\.NET\.Ref|NETCore\.App\.Runtime\.|WindowsDesktop\.App\.Runtime\.)/i.test(name)) continue
    for (const folder of Object.keys(assets.packageFolders)) {
      const dependencyRoot = join(folder, info.path)
      for (const file of info.files ?? []) {
        if (!/^(?:LICENSE(?:\.txt|\.TXT)?|NOTICE(?:\.txt|\.TXT)?|THIRD-PARTY-NOTICES(?:\.txt|\.TXT)?)$/i.test(file)) continue
        const dependencyLicense = join(dependencyRoot, file)
        if (!(await lstat(dependencyLicense).catch(() => null))?.isFile()) continue
        await cp(dependencyLicense, join(staging, 'licenses', `${name.replaceAll('/', '-')}-${file}`))
      }
    }
  }
  // Framework runtime packs are resolved by the SDK and are not ordinary
  // entries in project.assets.json. Read the exact versions in the published
  // runtimeconfig, then copy their package-root license texts.
  if (selfContained) {
    const runtimeConfig = JSON.parse(await readFile(join(staging, 'Yuyin.WindowsHost.runtimeconfig.json'), 'utf8'))
    for (const framework of runtimeConfig.runtimeOptions.includedFrameworks ?? []) {
      const packageName = `${framework.name}.Runtime.${runtime}`.toLowerCase()
      let copied = 0
      for (const folder of Object.keys(assets.packageFolders)) {
        for (const file of ['LICENSE', 'LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT', 'NOTICE.txt']) {
          const license = join(folder, packageName, framework.version, file)
          if (!(await lstat(license).catch(() => null))?.isFile()) continue
          await cp(license, join(staging, 'licenses', `${framework.name}-${framework.version}-${file}`))
          copied++
        }
      }
      if (copied === 0) throw new Error(`Runtime license not found for ${framework.name} ${framework.version}.`)
    }
  }
  await cp(join(root, 'windows-host', 'README.md'), join(staging, 'WEBVIEW2-README.md'))
  await writeFile(join(staging, marker), JSON.stringify({
    kind: 'yuyin-webview2-publish', runtime, selfContained, version: packageInfo.version,
  }, null, 2) + '\n', 'utf8')
  if (previous) await rm(output, { recursive: true })
  await rename(staging, output)
  console.log(`WebView2 migration output: ${output}`)
  console.log(selfContained
    ? 'Includes the .NET runtime; requires the system WebView2 Evergreen Runtime.'
    : 'Requires .NET 8 Desktop Runtime and the system WebView2 Evergreen Runtime.')
} finally {
  await rm(staging, { recursive: true, force: true })
}
