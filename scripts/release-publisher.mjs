import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { assertAdvance, assertReleaseAsset, fileDigest, validateManifest } from './release-utils.mjs'

/** Injecting the GitHub client lets tests exercise publication order without any remote writes. */
export async function publishRelease({ config, manifest, artifact, notes, commit, api, gh, existingOnly = false }) {
  function releaseId(release) {
    if (!Number.isSafeInteger(release?.id) || release.id < 1 || release.tag_name !== config.tag) throw new Error('Release ID 或标签无效。')
    return release.id
  }
  function findRelease() {
    try {
      const release = api(`releases/tags/${config.tag}`)
      releaseId(release)
      return release
    } catch (error) { if (!error.notFound) throw error }
    // The tag endpoint can return 404 for a draft even with an authenticated token.
    let found
    for (let page = 1; page <= 100; page++) {
      const releases = api(`releases?per_page=100&page=${page}`)
      if (!Array.isArray(releases)) throw new Error('Release 列表响应无效。')
      for (const release of releases) {
        if (release.tag_name !== config.tag) continue
        releaseId(release)
        if (found) throw new Error('同一标签存在多个 Release；请先人工核对。')
        found = release
      }
      if (releases.length < 100) return found
    }
    throw new Error('Release 列表超过校验范围，请人工核对。')
  }
  function readRelease(id) {
    const release = api(`releases/${id}`)
    if (releaseId(release) !== id) throw new Error('Release 回读 ID 不匹配。')
    return release
  }
  function assertAsset(release) {
    if (!release.draft) return assertReleaseAsset(release, config, manifest)
    const asset = release.assets?.[0]
    const prefix = `https://github.com/${config.repository}/releases/download/untagged-`
    const temporaryPath = typeof asset?.browser_download_url === 'string' && asset.browser_download_url.startsWith(prefix)
      ? asset.browser_download_url.slice(prefix.length).split('/') : []
    const temporaryUrl = temporaryPath.length === 2 && /^[A-Za-z0-9_-]+$/.test(temporaryPath[0]) && temporaryPath[1] === config.filename
    if (asset?.browser_download_url !== manifest.artifact.url && !temporaryUrl) throw new Error('草稿附件地址必须属于同一仓库和最终安装文件。')
    // GitHub assigns a temporary untagged URL until a draft is made public.
    assertReleaseAsset({ ...release, assets: release.assets.map(item => ({ ...item, browser_download_url: manifest.artifact.url })) }, config, manifest)
  }
  function stable() {
    try {
      const content = api('contents/updates/stable.json?ref=main')
      if (!content.sha || content.encoding !== 'base64') throw new Error('稳定通道响应无效。')
      return { sha: content.sha, manifest: validateManifest(JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')), config) }
    } catch (error) { if (error.notFound) return { manifest: null }; throw error }
  }
  assertAdvance(stable().manifest, manifest, config)
  let release = findRelease()
  if (existingOnly && (!release || release.assets?.length !== 1)) throw new Error('恢复发布只允许复用已有 Release 的唯一安装附件。')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyin-release-'))
  try {
    const bodyFile = path.join(temporary, 'release-notes.md')
    if (!release || release.draft) {
      if (release && (release.prerelease || !Array.isArray(release.assets) || release.assets.length > 1 || release.assets.some(asset => asset.name !== config.filename))) throw new Error('现有草稿包含其他附件或属于预发布；请先人工核对。')
      const body = `${notes}\n\n安装文件：\`${config.filename}\`\n\nSHA-256：\`${manifest.artifact.sha256}\`\n\n大小：${manifest.artifact.size} 字节\n\n实际构建提交：\`${commit}\`\n\n完整许可：[MIT](https://github.com/${config.repository}/blob/${config.tag}/LICENSE)、[第三方声明](https://github.com/${config.repository}/blob/${config.tag}/THIRD_PARTY_NOTICES.md)。\n`
      fs.writeFileSync(bodyFile, body)
      if (!release) {
        gh(['release', 'create', config.tag, '--repo', config.repository, '--verify-tag', '--draft', '--title', `余音 ${config.platform === 'windows' ? 'PC' : 'Android'} ${config.version}`, '--notes-file', bodyFile])
        release = findRelease()
        if (!release?.draft || release.prerelease || release.assets?.length !== 0) throw new Error('新建草稿回读异常，禁止覆盖附件。')
      }
      // A failed publication may already have uploaded the final file. Reuse it and verify its bytes.
      if (release.assets.length === 0) gh(['release', 'upload', config.tag, artifact, '--repo', config.repository])
      release = readRelease(releaseId(release))
    }
    assertAsset(release)
    gh(['release', 'download', config.tag, '--repo', config.repository, '--pattern', config.filename, '--dir', temporary])
    if (await fileDigest(path.join(temporary, config.filename)) !== manifest.artifact.sha256) throw new Error('GitHub 下载文件的 SHA-256 与构建产物不一致。')
    if (release.draft) {
      gh(['release', 'edit', config.tag, '--repo', config.repository, '--notes-file', bodyFile, '--draft=false'])
      release = readRelease(releaseId(release))
    }
    assertReleaseAsset(release, config, manifest)
    if (release.draft || !release.published_at) throw new Error('Release 尚未公开，禁止更新客户端通道。')
    manifest.publishedAt = new Date(release.published_at).toISOString()
    validateManifest(manifest, config)
    // A publisher may have advanced main while the artifact was uploading.
    const current = stable()
    assertAdvance(current.manifest, manifest, config)
    if (current.manifest?.version === manifest.version) return { manifest: current.manifest, updated: false }
    try {
      api('contents/updates/stable.json', { branch: 'main', ...(current.sha ? { sha: current.sha } : {}),
        message: `chore: update stable channel to ${config.tag}`, content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString('base64') })
    } catch (failure) {
      // A manual publisher and the release.published workflow may write the same immutable file concurrently.
      const after = stable().manifest
      assertAdvance(after, manifest, config)
      if (after?.version === manifest.version) return { manifest: after, updated: false }
      throw failure
    }
    const written = stable().manifest
    if (JSON.stringify(written) !== JSON.stringify(manifest)) throw new Error('稳定通道回读校验失败，请人工检查。')
    return { manifest: written, updated: true }
  } finally {
    // The resolved directory was created above and contains only our notes/download.
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
