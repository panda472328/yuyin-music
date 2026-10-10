import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertAdvance, assertReleaseAsset, changelogNotes, compareVersions, createManifest, releaseConfig, validateManifest } from './release-utils.mjs'
import { publishRelease } from './release-publisher.mjs'

function fixture(t, mobile = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyin-release-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pkg = { name: mobile ? 'yuyin-music-mobile' : 'yuyin-music', version: '1.2.3' }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ ...pkg, packages: { '': pkg } }))
  if (mobile) fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version: pkg.version, androidVersionCode: 8 }))
  const config = releaseConfig(root, mobile ? 'android-v1.2.3' : 'pc-v1.2.3')
  return { root, config }
}

function manifest(config, version = config.version, versionCode = config.versionCode) {
  const tag = `${config.prefix}${version}`
  const filename = config.platform === 'windows' ? `Yuyin-${version}-Setup.exe` : `Yuyin-Mobile-${version}.apk`
  return { schemaVersion: 1, platform: config.platform, version, ...(config.platform === 'android' ? { versionCode } : {}),
    artifact: { url: `https://github.com/${config.repository}/releases/download/${tag}/${filename}`, sha256: 'a'.repeat(64), size: 128 },
    releaseNotesUrl: `https://github.com/${config.repository}/releases/tag/${tag}`, notes: '测试更新', publishedAt: '2026-10-08T00:00:00.000Z' }
}

test('标签、平台、锁文件和 Android 版本来源不一致时拒绝发布', t => {
  const pc = fixture(t)
  assert.throws(() => releaseConfig(pc.root, 'android-v1.2.3'), /标签/)
  assert.throws(() => releaseConfig(pc.root, 'pc-v1.2.4'), /标签/)
  fs.writeFileSync(path.join(pc.root, 'package-lock.json'), JSON.stringify({ version: '1.2.2', packages: { '': { version: '1.2.3' } } }))
  assert.throws(() => releaseConfig(pc.root, 'pc-v1.2.3'), /lock/)
  const mobile = fixture(t, true)
  fs.writeFileSync(path.join(mobile.root, 'version.json'), JSON.stringify({ version: '1.2.3', androidVersionCode: 0 }))
  assert.throws(() => releaseConfig(mobile.root, 'android-v1.2.3'), /versionCode/)
})

test('语义版本按数字比较，拒绝预发布和不规范版本', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1)
  for (const invalid of ['01.2.3', '1.2.3-beta', '1.2', '1000000.0.0']) assert.throws(() => compareVersions(invalid, '1.2.3'))
})

test('稳定通道阻止回退和同版本替换，允许同安装文件重试', t => {
  const { config } = fixture(t)
  const current = manifest(config, '1.2.2')
  assert.doesNotThrow(() => assertAdvance(current, manifest(config), config))
  assert.throws(() => assertAdvance(manifest(config, '1.3.0'), manifest(config), config), /旧版本/)
  const same = manifest(config)
  assert.doesNotThrow(() => assertAdvance(same, { ...same, publishedAt: '2026-10-09T00:00:00.000Z' }, config))
  assert.throws(() => assertAdvance(same, { ...same, artifact: { ...same.artifact, sha256: 'b'.repeat(64) } }, config), /替换/)
})

test('Android versionCode 不递增时不能推送新版', t => {
  const { config } = fixture(t, true)
  assert.throws(() => assertAdvance(manifest(config, '1.2.2', 8), manifest(config), config), /递增/)
  assert.doesNotThrow(() => assertAdvance(manifest(config, '1.2.2', 7), manifest(config), config))
})

test('更新清单拒绝跨仓库下载、混用版本、错误哈希和超限文件', t => {
  const { config } = fixture(t)
  const valid = manifest(config)
  for (const changed of [
    { ...valid, platform: 'android' },
    { ...valid, versionCode: 8 },
    { ...valid, artifact: { ...valid.artifact, url: valid.artifact.url.replace('/yuyin-music/', '/other/') } },
    { ...valid, releaseNotesUrl: valid.releaseNotesUrl.replace('1.2.3', '1.2.4') },
    { ...valid, artifact: { ...valid.artifact, sha256: 'A'.repeat(64) } },
    { ...valid, artifact: { ...valid.artifact, size: 500000001 } },
    { ...valid, notes: 'x'.repeat(8001) },
    { ...valid, publishedAt: '2026-10-08' }
  ]) assert.throws(() => validateManifest(changed, config))
})

test('生成器读取真实文件计算完整 SHA-256，拒绝便携版及伪装 APK', async t => {
  const { root, config } = fixture(t)
  const bytes = Buffer.from('MZ controlled installer fixture')
  const artifact = path.join(root, config.filename)
  fs.writeFileSync(artifact, bytes)
  const result = await createManifest(config, artifact, '说明', '2026-10-08T00:00:00.000Z')
  assert.equal(result.artifact.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.artifact.size, bytes.length)
  await assert.rejects(() => createManifest(config, path.join(root, 'Yuyin-1.2.3-Windows.exe'), '说明', result.publishedAt), /最终安装文件/)
  fs.writeFileSync(artifact, 'PK wrong platform')
  await assert.rejects(() => createManifest(config, artifact, '说明', result.publishedAt), /文件头/)
})

test('Release 只允许唯一已上传且同版本的最终附件', t => {
  const { config } = fixture(t)
  const candidate = manifest(config)
  const asset = { name: config.filename, browser_download_url: config.url, size: candidate.artifact.size, state: 'uploaded' }
  const release = { tag_name: config.tag, prerelease: false, assets: [asset] }
  assert.doesNotThrow(() => assertReleaseAsset(release, config, candidate))
  assert.throws(() => assertReleaseAsset({ ...release, assets: [asset, { name: 'latest.yml' }] }, config, candidate), /一个安装/)
  assert.throws(() => assertReleaseAsset({ ...release, assets: [{ ...asset, state: 'new' }] }, config, candidate), /上传状态/)
  assert.throws(() => assertReleaseAsset({ ...release, prerelease: true }, config, candidate))
})

test('从 CHANGELOG 只提取当前版本的说明', () => {
  const notes = changelogNotes('# 更新\n\n## 1.2.3 · 今天\n\n- 新版。\n\n## 1.2.2 — 昨天\n\n- 旧版。\n', '1.2.3')
  assert.equal(notes, '- 新版。')
  assert.throws(() => changelogNotes('## 1.2.30\n\n- 错版\n', '1.2.3'), /缺少/)
})

async function publisherFixture(t, options = {}) {
  const { root, config } = fixture(t)
  const bytes = Buffer.from('MZ controlled release publication fixture')
  const artifact = path.join(root, config.filename)
  fs.writeFileSync(artifact, bytes)
  const candidate = await createManifest(config, artifact, '新版', '2026-10-08T00:00:00.000Z')
  let current = options.sameVersion ? structuredClone(candidate) : manifest(config, '1.2.2')
  let sha = 'before-write'
  const releaseId = 987
  const asset = draft => ({ name: config.filename,
    browser_download_url: draft && options.draftUrl ? options.draftUrl === true ? `https://github.com/${config.repository}/releases/download/untagged-draft123/${config.filename}` : options.draftUrl : config.url,
    size: bytes.length, state: 'uploaded' })
  let release = options.published ? { id: releaseId, tag_name: config.tag, draft: false, prerelease: false, published_at: '2026-10-08T01:00:00Z', assets: [asset(false)] }
    : options.draft ? { id: releaseId, tag_name: config.tag, draft: true, prerelease: false, assets: [asset(true)] } : null
  const events = []
  const apiRoutes = []
  const api = (route, body) => {
    apiRoutes.push(route)
    if (route === 'contents/updates/stable.json?ref=main') return { sha, encoding: 'base64', content: Buffer.from(JSON.stringify(current)).toString('base64') }
    if (route.startsWith('releases/tags/')) {
      if (!release || release.draft && options.draftTag404) { const error = new Error('404'); error.notFound = true; throw error }
      return structuredClone(release)
    }
    if (route.startsWith('releases?per_page=100&page=')) {
      const page = Number(route.split('page=').at(-1))
      if (options.secondPage && page === 1) return Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, tag_name: `pc-v0.0.${index}`, draft: false }))
      return page === (options.secondPage ? 2 : 1) && release ? [structuredClone(release)] : []
    }
    if (route === `releases/${releaseId}`) return structuredClone(release)
    if (route === 'contents/updates/stable.json' && body) {
      assert.equal(release.draft, false, 'must publish before advancing clients')
      assert.equal(body.sha, sha, 'must use the latest GitHub content SHA')
      assert.equal(body.branch, 'main')
      if (options.sameFileConcurrentWrite) { current = structuredClone(candidate); sha = 'written-by-manual-publisher'; throw new Error('409 content SHA conflict') }
      if (options.denyWrite) throw new Error('branch protection denied write')
      events.push('manifest-write')
      current = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
      sha = 'after-write'
      return { content: { sha } }
    }
    throw new Error(`unexpected API route ${route}`)
  }
  const gh = args => {
    const operation = args[1]
    if (operation === 'create') {
      events.push('create')
      assert.ok(args.includes('--draft'))
      release = { id: releaseId, tag_name: config.tag, draft: true, prerelease: false, assets: [] }
    } else if (operation === 'upload') {
      events.push('upload')
      assert.equal(args.includes('--clobber'), false, 'never replace an already uploaded installer')
      release.assets = [asset(true)]
    } else if (operation === 'download') {
      events.push('download')
      const directory = args[args.indexOf('--dir') + 1]
      fs.writeFileSync(path.join(directory, config.filename), options.corruptDownload ? Buffer.from('MZ corrupted release publication fixture!') : bytes)
    } else if (operation === 'edit' && args.includes('--draft=false')) {
      events.push('publish')
      release.draft = false
      release.published_at = '2026-10-08T01:00:00Z'
      if (!options.keepDraftUrlAfterPublish) release.assets[0].browser_download_url = config.url
      if (options.newerDuringPublish) { current = manifest(config, '1.3.0'); sha = 'advanced-by-other-publisher' }
    } else throw new Error(`unexpected gh operation ${operation}`)
    return ''
  }
  return { events, apiRoutes, get current() { return current }, get release() { return release }, publish: () => publishRelease({ config, manifest: candidate, artifact, notes: '新版', commit: 'controlled-commit', api, gh }) }
}

test('正式发布必须上传、下载复核、公开后，才以最新 SHA 更新客户端清单', async t => {
  const fixture = await publisherFixture(t)
  const result = await fixture.publish()
  assert.deepEqual(fixture.events, ['create', 'upload', 'download', 'publish', 'manifest-write'])
  assert.equal(result.updated, true)
  assert.equal(fixture.current.version, '1.2.3')
  assert.equal(fixture.current.publishedAt, '2026-10-08T01:00:00.000Z')
})

test('远程下载损坏时保持草稿，不推进客户端清单', async t => {
  const fixture = await publisherFixture(t, { corruptDownload: true })
  await assert.rejects(fixture.publish, /SHA-256/)
  assert.equal(fixture.release.draft, true)
  assert.equal(fixture.current.version, '1.2.2')
  assert.deepEqual(fixture.events, ['create', 'upload', 'download'])
})

test('草稿标签恒为 404 时分页查找，并按 ID 回读上传与公开结果', async t => {
  const fixture = await publisherFixture(t, { draftTag404: true, secondPage: true, draftUrl: true })
  assert.equal((await fixture.publish()).updated, true)
  assert.deepEqual(fixture.events, ['create', 'upload', 'download', 'publish', 'manifest-write'])
  assert.ok(fixture.apiRoutes.includes('releases?per_page=100&page=2'))
  assert.equal(fixture.apiRoutes.filter(route => route === 'releases/987').length, 2)
  assert.equal(fixture.release.assets[0].browser_download_url, fixture.current.artifact.url)
})

test('草稿下载校验失败后重试沿用已上传文件，不重复创建或覆盖附件', async t => {
  const options = { draftTag404: true, draftUrl: true, corruptDownload: true }
  const fixture = await publisherFixture(t, options)
  await assert.rejects(fixture.publish, /SHA-256/)
  assert.equal(fixture.release.draft, true)
  assert.equal(fixture.current.version, '1.2.2')
  options.corruptDownload = false
  assert.equal((await fixture.publish()).updated, true)
  assert.deepEqual(fixture.events, ['create', 'upload', 'download', 'download', 'publish', 'manifest-write'])
})

test('已有唯一原始安装文件的草稿直接下载复核后公开', async t => {
  const fixture = await publisherFixture(t, { draft: true, draftTag404: true, draftUrl: true, secondPage: true })
  assert.equal((await fixture.publish()).updated, true)
  assert.deepEqual(fixture.events, ['download', 'publish', 'manifest-write'])
})

test('草稿临时附件地址不能跨仓库或伪装文件，公开后不能保留临时地址', async t => {
  for (const draftUrl of ['https://github.com/other/project/releases/download/untagged-draft123/Yuyin-1.2.3-Setup.exe', 'https://github.com/panda472328/yuyin-music/releases/download/untagged-draft123/other.exe']) {
    const fixture = await publisherFixture(t, { draft: true, draftTag404: true, draftUrl })
    await assert.rejects(fixture.publish, /草稿附件地址/)
    assert.deepEqual(fixture.events, [])
  }
  const fixture = await publisherFixture(t, { draft: true, draftTag404: true, draftUrl: true, keepDraftUrlAfterPublish: true })
  await assert.rejects(fixture.publish, /附件名称、地址/)
  assert.equal(fixture.current.version, '1.2.2')
})

test('公开版本重试只复核原始安装文件，不替换附件或重复写清单', async t => {
  const fixture = await publisherFixture(t, { published: true, sameVersion: true })
  const result = await fixture.publish()
  assert.equal(result.updated, false)
  assert.deepEqual(fixture.events, ['download'])
})

test('上传期间另一发布者推进新版时，旧流程不得倒退清单', async t => {
  const fixture = await publisherFixture(t, { newerDuringPublish: true })
  await assert.rejects(fixture.publish, /旧版本/)
  assert.equal(fixture.current.version, '1.3.0')
  assert.equal(fixture.events.includes('manifest-write'), false)
})

test('清单写入权限失败不会替换已公开文件，也不伪报客户端收到更新', async t => {
  const fixture = await publisherFixture(t, { denyWrite: true })
  await assert.rejects(fixture.publish, /protection/)
  assert.equal(fixture.release.draft, false)
  assert.equal(fixture.current.version, '1.2.2')
  assert.equal(fixture.events.includes('manifest-write'), false)
})

test('手工与发布事件并发写入相同安装文件时，SHA 冲突可幂等收敛', async t => {
  const fixture = await publisherFixture(t, { sameFileConcurrentWrite: true })
  const result = await fixture.publish()
  assert.equal(result.updated, false)
  assert.equal(fixture.current.version, '1.2.3')
  assert.equal(fixture.events.includes('manifest-write'), false)
})
