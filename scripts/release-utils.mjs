import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const repositories = {
  'yuyin-music': { platform: 'windows', repository: 'panda472328/yuyin-music', prefix: 'pc-v', maxSize: 500000000 },
  'yuyin-music-mobile': { platform: 'android', repository: 'panda472328/yuyin-music-mobile', prefix: 'android-v', maxSize: 200000000 }
}
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

export function compareVersions(left, right) {
  if (!versionPattern.test(left) || !versionPattern.test(right)) throw new Error('只允许无前导零的 X.Y.Z 稳定版本。')
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  return 0
}

export function releaseConfig(root, tag) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const config = repositories[pkg.name]
  if (!config) throw new Error('未知项目；PC 与 Android 必须在各自仓库发布。')
  compareVersions(pkg.version, pkg.version)
  if (tag !== `${config.prefix}${pkg.version}`) throw new Error('发布标签必须与本平台 package.json 的版本一致。')
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('package-lock.json 的版本必须与 package.json 一致。')
  const result = { ...config, version: pkg.version, tag }
  if (config.platform === 'android') {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'))
    if (version.version !== pkg.version || !Number.isInteger(version.androidVersionCode) || version.androidVersionCode < 1 || version.androidVersionCode > 2100000000) {
      throw new Error('Android version.json 的版本必须一致，versionCode 必须为有效正整数。')
    }
    result.versionCode = version.androidVersionCode
  }
  result.filename = config.platform === 'windows' ? `Yuyin-${pkg.version}-Setup.exe` : `Yuyin-Mobile-${pkg.version}.apk`
  result.url = `https://github.com/${config.repository}/releases/download/${tag}/${result.filename}`
  result.releaseNotesUrl = `https://github.com/${config.repository}/releases/tag/${tag}`
  return result
}

export function validateManifest(manifest, config) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.platform !== config.platform) throw new Error('更新清单 schema 或平台不匹配。')
  compareVersions(manifest.version, manifest.version)
  const tag = `${config.prefix}${manifest.version}`
  const filename = config.platform === 'windows' ? `Yuyin-${manifest.version}-Setup.exe` : `Yuyin-Mobile-${manifest.version}.apk`
  if (manifest.artifact?.url !== `https://github.com/${config.repository}/releases/download/${tag}/${filename}` || manifest.releaseNotesUrl !== `https://github.com/${config.repository}/releases/tag/${tag}`) {
    throw new Error('更新清单必须指向本平台、同版本的 GitHub 正式发布。')
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.artifact.sha256) || !Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 1 || manifest.artifact.size > config.maxSize) throw new Error('更新文件校验值或大小无效。')
  if (typeof manifest.notes !== 'string' || manifest.notes.length > 8000) throw new Error('更新说明必须是最多 8000 字的文本。')
  if (typeof manifest.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.publishedAt) || !Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error('发布时间必须是 UTC ISO 日期。')
  if (config.platform === 'android') {
    if (!Number.isInteger(manifest.versionCode) || manifest.versionCode < 1 || manifest.versionCode > 2100000000) throw new Error('Android versionCode 无效。')
  } else if ('versionCode' in manifest) throw new Error('Windows 清单不能含 Android versionCode。')
  return manifest
}

export function assertAdvance(current, candidate, config) {
  validateManifest(candidate, config)
  if (!current) return
  validateManifest(current, config)
  const comparison = compareVersions(candidate.version, current.version)
  if (comparison < 0) throw new Error('稳定通道不得退回旧版本。')
  if (comparison === 0) {
    if (candidate.artifact.sha256 !== current.artifact.sha256 || candidate.artifact.size !== current.artifact.size || candidate.artifact.url !== current.artifact.url || candidate.versionCode !== current.versionCode) {
      throw new Error('已发布版本不可替换成不同安装文件；请递增版本。')
    }
  } else if (config.platform === 'android' && candidate.versionCode <= current.versionCode) throw new Error('Android 新版本的 versionCode 必须递增。')
}

export async function fileDigest(filename) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export function changelogNotes(text, version) {
  const escaped = version.replaceAll('.', '\\.')
  const start = text.search(new RegExp(`^##\\s+v?${escaped}(?:\\s|$)`, 'm'))
  if (start < 0) throw new Error(`CHANGELOG.md 缺少 ${version} 的更新说明。`)
  const section = text.slice(start)
  const body = section.slice(section.indexOf('\n') + 1)
  const end = body.search(/^##\s/m)
  const notes = (end < 0 ? body : body.slice(0, end)).trim()
  if (!notes || notes.length > 8000) throw new Error('本次更新说明须为 1 到 8000 字。')
  return notes
}

export async function createManifest(config, artifact, notes, publishedAt) {
  if (path.basename(artifact) !== config.filename) throw new Error(`仅允许最终安装文件 ${config.filename}。`)
  const stat = fs.statSync(artifact)
  if (!stat.isFile() || stat.size < 2 || stat.size > config.maxSize) throw new Error('安装文件不是有效文件，或超出大小限制。')
  const file = fs.openSync(artifact, 'r')
  const header = Buffer.alloc(2)
  try { fs.readSync(file, header, 0, 2, 0) } finally { fs.closeSync(file) }
  if (header.toString('ascii') !== (config.platform === 'windows' ? 'MZ' : 'PK')) throw new Error('安装文件头与平台不匹配。')
  const manifest = { schemaVersion: 1, platform: config.platform, version: config.version,
    ...(config.platform === 'android' ? { versionCode: config.versionCode } : {}),
    artifact: { url: config.url, sha256: await fileDigest(artifact), size: stat.size },
    releaseNotesUrl: config.releaseNotesUrl, notes, publishedAt }
  return validateManifest(manifest, config)
}

export function assertReleaseAsset(release, config, manifest) {
  if (release.tag_name !== config.tag || release.prerelease || release.assets?.length !== 1) throw new Error('正式发布须与标签一致，且只能有一个安装文件附件。')
  const asset = release.assets[0]
  if (asset.name !== config.filename || asset.browser_download_url !== manifest.artifact.url || asset.size !== manifest.artifact.size || asset.state !== 'uploaded') throw new Error('GitHub 附件名称、地址、大小或上传状态不匹配。')
}
