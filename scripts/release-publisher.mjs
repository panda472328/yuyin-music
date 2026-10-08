import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { assertAdvance, assertReleaseAsset, fileDigest, validateManifest } from './release-utils.mjs'

/** Injecting the GitHub client lets tests exercise publication order without any remote writes. */
export async function publishRelease({ config, manifest, artifact, notes, commit, api, gh }) {
  function stable() {
    try {
      const content = api('contents/updates/stable.json?ref=main')
      if (!content.sha || content.encoding !== 'base64') throw new Error('稳定通道响应无效。')
      return { sha: content.sha, manifest: validateManifest(JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')), config) }
    } catch (error) { if (error.notFound) return { manifest: null }; throw error }
  }
  assertAdvance(stable().manifest, manifest, config)
  let release
  try { release = api(`releases/tags/${config.tag}`) } catch (error) { if (!error.notFound) throw error }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyin-release-'))
  try {
    if (!release || release.draft) {
      if (release && (release.prerelease || release.assets.some(asset => asset.name !== config.filename))) throw new Error('现有草稿包含其他附件或属于预发布；请先人工核对。')
      const bodyFile = path.join(temporary, 'release-notes.md')
      const body = `${notes}\n\n安装文件：\`${config.filename}\`\n\nSHA-256：\`${manifest.artifact.sha256}\`\n\n大小：${manifest.artifact.size} 字节\n\n实际构建提交：\`${commit}\`\n\n完整许可：[MIT](https://github.com/${config.repository}/blob/${config.tag}/LICENSE)、[第三方声明](https://github.com/${config.repository}/blob/${config.tag}/THIRD_PARTY_NOTICES.md)。\n`
      fs.writeFileSync(bodyFile, body)
      if (!release) gh(['release', 'create', config.tag, '--repo', config.repository, '--verify-tag', '--draft', '--title', `余音 ${config.platform === 'windows' ? 'PC' : 'Android'} ${config.version}`, '--notes-file', bodyFile])
      else gh(['release', 'edit', config.tag, '--repo', config.repository, '--notes-file', bodyFile])
      gh(['release', 'upload', config.tag, artifact, '--repo', config.repository, '--clobber'])
      release = api(`releases/tags/${config.tag}`)
    }
    assertReleaseAsset(release, config, manifest)
    gh(['release', 'download', config.tag, '--repo', config.repository, '--pattern', config.filename, '--dir', temporary])
    if (await fileDigest(path.join(temporary, config.filename)) !== manifest.artifact.sha256) throw new Error('GitHub 下载文件的 SHA-256 与构建产物不一致。')
    if (release.draft) {
      gh(['release', 'edit', config.tag, '--repo', config.repository, '--draft=false'])
      release = api(`releases/tags/${config.tag}`)
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
