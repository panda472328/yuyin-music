import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { assertAdvance, changelogNotes, createManifest, releaseConfig } from './release-utils.mjs'
import { publishRelease } from './release-publisher.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flags = new Set(['--dry-run', '--publish', '--validate-version', '--existing-only', '--correct-build-source'])
const options = new Set(['--tag', '--artifact', '--notes', '--output', '--current-manifest', '--build-commit'])
const args = {}
for (let index = 0; index < argv.length; index++) {
  const name = argv[index]
  if (!flags.has(name) && !options.has(name) || name in args) throw new Error(`未知或重复参数：${name}`)
  if (flags.has(name)) args[name] = true
  else {
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数。`)
    args[name] = value
  }
}
if (['--dry-run', '--publish', '--validate-version'].filter(flag => args[flag]).length !== 1) throw new Error('选择 --dry-run、--publish 或 --validate-version。默认不执行发布。')
if (args['--existing-only'] && !args['--publish']) throw new Error('--existing-only 仅用于恢复已有文件的正式发布。')
if (args['--correct-build-source'] && (!args['--publish'] || !args['--existing-only'])) throw new Error('--correct-build-source 仅用于恢复已有 Release。')
if ((args['--build-commit'] || process.env.YUYIN_BUILD_COMMIT) && !args['--publish']) throw new Error('--build-commit 仅用于正式发布。')
if (args['--correct-build-source'] && !(args['--build-commit'] || process.env.YUYIN_BUILD_COMMIT)) throw new Error('来源校正必须提供 --build-commit 或 YUYIN_BUILD_COMMIT。')
const config = releaseConfig(root, args['--tag'])
if (args['--validate-version']) {
  console.log(`版本校验通过：${config.tag}${config.versionCode ? ` (${config.versionCode})` : ''}`)
} else {
  if (!args['--artifact']) throw new Error('必须提供 --artifact 最终安装文件。')
  const artifact = path.resolve(root, args['--artifact'])
  const notes = args['--notes'] ? fs.readFileSync(path.resolve(root, args['--notes']), 'utf8').trim() : changelogNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), config.version)
  const manifest = await createManifest(config, artifact, notes, new Date().toISOString())
  const output = args['--output'] ? path.resolve(root, args['--output']) : null
  if (output === path.join(root, 'updates', 'stable.json')) throw new Error('--output 不得直接覆盖稳定通道；使用发布流程或人工审核。')
  if (args['--dry-run']) {
    const currentPath = path.resolve(root, args['--current-manifest'] || 'updates/stable.json')
    const current = fs.existsSync(currentPath) ? JSON.parse(fs.readFileSync(currentPath, 'utf8')) : null
    assertAdvance(current, manifest, config)
    const json = `${JSON.stringify(manifest, null, 2)}\n`
    if (output) {
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, json)
    }
    console.log(json)
    console.log('Dry run：未连接 GitHub，未发布，未改动稳定通道。')
  } else {
    if (args['--current-manifest']) throw new Error('正式发布必须读取 GitHub 上实际的稳定通道。')
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('正式发布需要 GH_TOKEN 或 GITHUB_TOKEN。')
    if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== config.repository) throw new Error('Actions 仓库与发布平台不一致。')
    function gh(parameters, input) {
      try { return execFileSync(process.platform === 'win32' ? 'gh.exe' : 'gh', parameters, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }) }
      catch (error) {
        if (/\b404\b/.test(String(error.stderr))) { const missing = new Error('GitHub 资源不存在。'); missing.notFound = true; throw missing }
        throw new Error(`GitHub 操作失败：${parameters.slice(0, 2).join(' ')}。请检查 Actions 日志、权限和网络，不重建或替换已公开的安装文件。`)
      }
    }
    function api(route, body, method = body ? 'PUT' : 'GET') {
      return JSON.parse(gh(['api', `repos/${config.repository}/${route}`, ...(body ? ['--method', method, '--input', '-'] : [])], body ? JSON.stringify(body) : undefined))
    }
    const requestedCommit = args['--build-commit'] || process.env.YUYIN_BUILD_COMMIT
    let commit = requestedCommit || process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    if (requestedCommit) {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(requestedCommit)) throw new Error('--build-commit 必须是完整的 Git 提交哈希。')
      const tagCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${config.tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
      if (tagCommit !== requestedCommit) throw new Error('--build-commit 必须与本地发布标签解析到的提交一致。')
      commit = tagCommit
    }
    const result = await publishRelease({ config, manifest, artifact, notes, commit, api, gh, existingOnly: Boolean(args['--existing-only']), correctBuildSource: Boolean(args['--correct-build-source']) })
    console.log(result.updated ? `稳定通道已更新：${config.releaseNotesUrl}` : '稳定通道已包含相同安装文件，无需重复写入。')
    if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(result.manifest, null, 2)}\n`) }
  }
}
