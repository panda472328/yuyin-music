import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (process.platform !== 'win32' || !['build', 'run', 'start', 'test', 'test-native'].includes(mode)) throw new Error('Use build, run, start, test or test-native on Windows.')
const bundledDotnet = join(root, '.tools', 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')
const configuredDotnet = process.env.YUYIN_DOTNET_EXECUTABLE
const dotnet = configuredDotnet || (process.platform === 'win32' && existsSync(bundledDotnet) ? bundledDotnet : 'dotnet')
if (dotnet !== 'dotnet' && !isAbsolute(dotnet)) throw new Error('YUYIN_DOTNET_EXECUTABLE must be an absolute path.')
const executable = join(root, 'release', 'webview2', 'win-x64-self-contained', 'Yuyin.WindowsHost.exe')
if (mode === 'start' && !existsSync(executable)) throw new Error('Run npm run publish:webview2 before starting the published app.')
const args = mode === 'start' ? [] : mode === 'test-native'
  ? ['run', '--project', join(root, 'tests', 'windows-host-native', 'Yuyin.NativePlayerTests.csproj'), '-c', 'Release', `-p:Version=${version}`]
  : mode === 'test'
  ? ['run', '--project', join(root, 'tests', 'windows-host', 'Yuyin.HostTests.csproj'), '-c', 'Release', `-p:Version=${version}`]
  : mode === 'build'
  ? ['build', join(root, 'windows-host', 'Yuyin.WindowsHost.csproj'), '-c', 'Release', `-p:Version=${version}`]
  : ['run', '--project', join(root, 'windows-host', 'Yuyin.WindowsHost.csproj'), '-c', 'Debug', `-p:Version=${version}`]
const child = spawn(mode === 'start' ? executable : dotnet, args, {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, ...(mode === 'run' ? { YUYIN_RENDERER_DIR: join(root, 'out', 'webview2-renderer') } : {}) },
})
child.on('error', error => { console.error(mode === 'start' ? error.message : `.NET SDK 8 is required: ${error.message}`); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
