import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url))
const repository = 'panda472328/yuyin-music'
const tag = 'pc-v1.2.3'
const filename = 'Yuyin-1.2.3-Setup.exe'
const installerBytes = Buffer.from('MZ controlled CLI installer fixture')

// The child process receives only runtime paths and invented CI values. Git is
// confined to a newly initialized fixture with global/system configuration off.
function isolatedEnvironment(root) {
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-git-config'),
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2026-10-10T01:00:00Z', GIT_COMMITTER_DATE: '2026-10-10T01:00:00Z',
    GH_TOKEN: 'controlled-fixture-token', GITHUB_REPOSITORY: repository, YUYIN_CLI_FIXTURE: root }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyin-release-cli-test-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('yuyin-release-cli-test-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const env = isolatedEnvironment(root)
  const git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  fs.mkdirSync(path.join(root, 'scripts'))
  for (const name of ['release.mjs', 'release-utils.mjs', 'release-publisher.mjs']) {
    fs.copyFileSync(path.join(sourceDirectory, name), path.join(root, 'scripts', name))
  }
  const pkg = { name: 'yuyin-music', version: '1.2.3' }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ ...pkg, packages: { '': pkg } }))
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changes\n\n## 1.2.3\n\n- Controlled update.\n')
  fs.writeFileSync(path.join(root, filename), installerBytes)
  git(['-c', 'init.defaultBranch=main', 'init', '--quiet', '--template='])
  git(['config', '--local', 'user.name', 'Release CLI Fixture'])
  git(['config', '--local', 'user.email', 'release-fixture@example.invalid'])
  git(['add', '--', 'scripts', 'package.json', 'package-lock.json', 'CHANGELOG.md'])
  git(['commit', '--quiet', '-m', 'Controlled tagged source'])
  git(['tag', tag])
  const tagCommit = git(['rev-parse', `refs/tags/${tag}^{commit}`])
  fs.writeFileSync(path.join(root, 'head-marker.txt'), 'Controlled subsequent commit.\n')
  git(['add', '--', 'head-marker.txt'])
  git(['commit', '--quiet', '-m', 'Controlled later main head'])
  const headCommit = git(['rev-parse', 'HEAD'])
  assert.notEqual(headCommit, tagCommit)
  const sha256 = createHash('sha256').update(installerBytes).digest('hex')
  const url = `https://github.com/${repository}/releases/download/${tag}/${filename}`
  const currentManifest = { schemaVersion: 1, platform: 'windows', version: '1.2.3',
    artifact: { url, sha256, size: installerBytes.length },
    releaseNotesUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    notes: '- Controlled update.', publishedAt: '2026-10-10T02:00:00.000Z' }
  const release = { id: 987, tag_name: tag, draft: false, prerelease: false, name: 'Controlled PC 1.2.3',
    created_at: '2026-10-10T01:30:00Z', published_at: '2026-10-10T02:00:00Z', target_commitish: headCommit,
    body: `Controlled notes.\n\n实际构建提交：\`${headCommit}\`\n\nPreserve this section.\n`,
    assets: [{ id: 1234, name: filename, browser_download_url: url, size: installerBytes.length,
      digest: `sha256:${sha256}`, state: 'uploaded' }] }
  fs.writeFileSync(path.join(root, 'mock-state.json'), JSON.stringify({ release, manifest: currentManifest }))
  fs.writeFileSync(path.join(root, 'register-loader.mjs'),
    "import { register } from 'node:module'; register('./loader.mjs', import.meta.url);\n")
  fs.writeFileSync(path.join(root, 'loader.mjs'), `
    const stub = new URL('./stub-child-process.mjs', import.meta.url).href
    export function resolve(specifier, context, nextResolve) {
      if (specifier === 'node:child_process') return { url: stub, shortCircuit: true }
      return nextResolve(specifier, context)
    }
  `)
  fs.writeFileSync(path.join(root, 'stub-child-process.mjs'), `
    import fs from 'node:fs'
    import path from 'node:path'
    import { createRequire } from 'node:module'
    const real = createRequire(import.meta.url)('node:child_process')
    const root = process.env.YUYIN_CLI_FIXTURE
    const statePath = path.join(root, 'mock-state.json')
    export function execFileSync(command, args, options) {
      if (command === 'git') return real.execFileSync(command, args, options)
      if (command !== 'gh' && command !== 'gh.exe') throw new Error('Unexpected external executable.')
      const request = { args, body: options?.input ? JSON.parse(options.input) : null }
      fs.appendFileSync(process.env.YUYIN_CLI_TRACE, JSON.stringify(request) + '\\n')
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (args[0] === 'api') {
        const prefix = 'repos/${repository}/'
        if (!args[1].startsWith(prefix)) throw new Error('Unexpected repository.')
        const route = args[1].slice(prefix.length)
        const methodIndex = args.indexOf('--method')
        const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1]
        if (route === 'contents/updates/stable.json?ref=main' && method === 'GET') {
          return JSON.stringify({ sha: 'controlled-content-sha', encoding: 'base64',
            content: Buffer.from(JSON.stringify(state.manifest)).toString('base64') })
        }
        if (route === 'releases/tags/${tag}' && method === 'GET') return JSON.stringify(state.release)
        if (route === 'releases/987' && method === 'GET') return JSON.stringify(state.release)
        if (route === 'releases/987' && method === 'PATCH') {
          if (Object.keys(request.body).join(',') !== 'body') throw new Error('Only source text may be patched.')
          state.release.body = request.body.body
          fs.writeFileSync(statePath, JSON.stringify(state))
          return JSON.stringify(state.release)
        }
        throw new Error('Unexpected API operation; manifest writes and all other mutations are forbidden.')
      }
      if (args[0] === 'release' && args[1] === 'download' && args[2] === '${tag}' &&
          args[args.indexOf('--pattern') + 1] === '${filename}' &&
          args[args.indexOf('--repo') + 1] === '${repository}') {
        const directory = args[args.indexOf('--dir') + 1]
        fs.writeFileSync(path.join(directory, '${filename}'), fs.readFileSync(path.join(root, '${filename}')))
        return ''
      }
      throw new Error('Only the existing installer download is allowed; creation, upload and release edits are forbidden.')
    }
  `)
  let runIndex = 0
  function run(args, environment = {}) {
    const trace = path.join(root, `trace-${++runIndex}.jsonl`)
    const output = path.join(root, `forbidden-output-${runIndex}.json`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'register-loader.mjs')).href,
      path.join(root, 'scripts', 'release.mjs'), ...args, '--output', output],
    { cwd: root, env: { ...env, YUYIN_CLI_TRACE: trace, ...environment }, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.error, undefined)
    return { ...result, output, requests: fs.existsSync(trace)
      ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }
  }
  return { root, git, run, tagCommit, headCommit, release, currentManifest,
    state: () => JSON.parse(fs.readFileSync(path.join(root, 'mock-state.json'), 'utf8')) }
}

const correctionArgs = ['--publish', '--existing-only', '--correct-build-source', '--tag', tag, '--artifact', filename]

function assertSourceCorrection(f, result) {
  assert.equal(result.status, 0, result.stderr)
  const state = f.state()
  assert.equal(state.release.body, f.release.body.replace(f.headCommit, f.tagCommit))
  assert.deepEqual({ ...state.release, body: f.release.body }, f.release)
  assert.deepEqual(state.manifest, f.currentManifest)
  assert.deepEqual(fs.readFileSync(path.join(f.root, filename)), installerBytes)
  const patch = result.requests.filter(request => request.args.includes('PATCH'))
  assert.equal(patch.length, 1)
  assert.deepEqual(Object.keys(patch[0].body), ['body'])
  assert.equal(result.requests.filter(request => request.args[0] === 'release').length, 1)
  assert.equal(result.requests.find(request => request.args[0] === 'release').args[1], 'download')
  const downloadIndex = result.requests.findIndex(request => request.args[1] === 'download')
  const patchIndex = result.requests.findIndex(request => request.args.includes('PATCH'))
  assert.ok(downloadIndex >= 0 && downloadIndex < patchIndex, 'verify original bytes before source correction')
  assert.deepEqual(JSON.parse(fs.readFileSync(result.output, 'utf8')), f.currentManifest)
}

test('CLI 明确构建提交优先于 YUYIN_BUILD_COMMIT 与错误的 GITHUB_SHA，仅校正原 Release 来源', t => {
  const f = fixture(t)
  const result = f.run([...correctionArgs, '--build-commit', f.tagCommit],
    { YUYIN_BUILD_COMMIT: f.headCommit, GITHUB_SHA: f.headCommit })
  assertSourceCorrection(f, result)
})

test('CLI YUYIN_BUILD_COMMIT 优先于错误的 GITHUB_SHA，复用附件且不改稳定清单', t => {
  const f = fixture(t)
  const result = f.run(correctionArgs, { YUYIN_BUILD_COMMIT: f.tagCommit, GITHUB_SHA: f.headCommit })
  assertSourceCorrection(f, result)
})

test('CLI 来源与参数错误在任何 GitHub 调用、写入输出之前拒绝', async t => {
  const f = fixture(t)
  const originalState = f.state()
  const cases = [
    { name: '完整提交与标签不一致', args: [...correctionArgs, '--build-commit', f.headCommit], error: /本地发布标签/ },
    { name: '环境构建提交与标签不一致', args: correctionArgs, env: { YUYIN_BUILD_COMMIT: f.headCommit }, error: /本地发布标签/ },
    { name: '短提交哈希', args: [...correctionArgs, '--build-commit', f.tagCommit.slice(0, 7)], error: /完整的 Git/ },
    { name: '非法构建参数文本', args: [...correctionArgs, '--build-commit', 'main; gh release upload'], error: /完整的 Git/ },
    { name: '非法环境来源', args: correctionArgs, env: { YUYIN_BUILD_COMMIT: 'main' }, error: /完整的 Git/ },
    { name: '只有 GITHUB_SHA 不满足明确来源', args: correctionArgs, env: { GITHUB_SHA: f.tagCommit }, error: /来源校正必须提供/ },
    { name: '缺少明确来源', args: correctionArgs, error: /来源校正必须提供/ },
    { name: '重复构建参数', args: [...correctionArgs, '--build-commit', f.tagCommit, '--build-commit', f.tagCommit], error: /重复参数/ },
    { name: '未知参数', args: [...correctionArgs, '--unknown', 'x'], error: /未知或重复参数/ },
    { name: '构建参数没有值', args: [...correctionArgs, '--build-commit'], error: /缺少参数/ },
    { name: '发布标签与版本不一致', args: ['--publish', '--existing-only', '--correct-build-source', '--tag', 'pc-v1.2.4', '--artifact', filename, '--build-commit', f.tagCommit], error: /标签必须/ },
    { name: '来源校正缺少 existing-only', args: ['--publish', '--correct-build-source', '--tag', tag, '--artifact', filename, '--build-commit', f.tagCommit], error: /仅用于恢复/ },
    { name: 'dry-run 不允许来源校正', args: ['--dry-run', '--correct-build-source', '--tag', tag, '--artifact', filename, '--build-commit', f.tagCommit], error: /仅用于恢复/ },
    { name: 'dry-run 不允许构建来源参数', args: ['--dry-run', '--tag', tag, '--artifact', filename, '--build-commit', f.tagCommit], error: /仅用于正式发布/ },
    { name: 'validate-version 不允许环境来源', args: ['--validate-version', '--tag', tag], env: { YUYIN_BUILD_COMMIT: f.tagCommit }, error: /仅用于正式发布/ },
    { name: 'dry-run 不允许 existing-only', args: ['--dry-run', '--existing-only', '--tag', tag, '--artifact', filename], error: /仅用于恢复/ },
    { name: '没有发布模式', args: ['--tag', tag], error: /选择 --dry-run/ },
    { name: '多个发布模式', args: ['--publish', '--dry-run', '--tag', tag], error: /选择 --dry-run/ }
  ]
  for (const item of cases) await t.test(item.name, () => {
    const result = f.run(item.args, item.env)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, item.error)
    assert.deepEqual(result.requests, [])
    assert.equal(fs.existsSync(result.output), false)
    assert.deepEqual(f.state(), originalState)
    assert.deepEqual(fs.readFileSync(path.join(f.root, filename)), installerBytes)
  })
})

test('CLI 本地标签缺失时拒绝来源校正，绝不访问 GitHub 或写出清单', t => {
  const f = fixture(t)
  f.git(['tag', '--delete', tag])
  const result = f.run([...correctionArgs, '--build-commit', f.tagCommit], { GITHUB_SHA: f.headCommit })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /rev-parse|single revision|Needed a single revision/)
  assert.deepEqual(result.requests, [])
  assert.equal(fs.existsSync(result.output), false)
  assert.deepEqual(f.state(), { release: f.release, manifest: f.currentManifest })
})
