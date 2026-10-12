import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compareVersions, validateManifest } from './release-utils.mjs'

const repository = 'openmusic/openmusic'
const api = `https://gitee.com/api/v5/repos/${repository}`
export const domesticManifestUrl = `${api}/contents/updates/domestic.json?ref=main`
const manifestMaximum = 64 * 1024
const contentsMaximum = 128 * 1024
const legacyConfig = { platform: 'windows', repository: 'panda472328/yuyin-music', prefix: 'pc-v', maxSize: 500000000 }
const positiveId = value => Number.isInteger(value) && value > 0 && value <= 2147483647
export const domesticArtifactUrl = (releaseId, attachmentId) => {
  if (!positiveId(releaseId) || !positiveId(attachmentId)) throw new Error('Gitee Release/附件 ID 不合法。')
  return `${api}/releases/${releaseId}/attach_files/${attachmentId}/download`
}

/** Only the documented attachment API is trusted. Unknown CDNs are not inferred. */
async function publicRequest(url, maximum, fetcher = fetch, allowMissing = false) {
  const response = await fetcher(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(maximum > contentsMaximum ? 15 * 60 * 1000 : 30000),
    headers: { 'User-Agent': 'Yuyin-Release-Verify/1', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' } })
  if (allowMissing && response.status === 404) { await response.body?.cancel(); return null }
  if (response.status !== 200) { await response.body?.cancel(); throw new Error(`公开更新资源不可用（HTTP ${response.status}）。未知重定向不得用于发布。`) }
  const encoding = response.headers.get('content-encoding')
  if (encoding && encoding !== 'identity') { await response.body?.cancel(); throw new Error('公开更新资源编码异常。') }
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    await response.body?.cancel(); throw new Error('公开更新资源大小异常。')
  }
  return response
}

async function publicJson(url, fetcher, allowMissing = false, maximum = manifestMaximum) {
  const response = await publicRequest(url, maximum, fetcher, allowMissing)
  if (response === null) return null
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > maximum) { await response.body?.cancel().catch(() => {}); throw new Error('公开更新元数据过大。') }
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('公开更新元数据格式不正确。') }
}

/** Gitee's fixed public Contents endpoint avoids expiring raw-CDN redirects. */
export function decodeDomesticContents(value, allowMissing = false) {
  // The public API currently returns [] with HTTP 200 for an absent file.
  if (allowMissing && (value === null || (Array.isArray(value) && value.length === 0))) return null
  if (!value || Array.isArray(value) || value.type !== 'file' || value.encoding !== 'base64' || value.name !== 'domestic.json' ||
    value.path !== 'updates/domestic.json' || !Number.isInteger(value.size) || value.size < 1 || value.size > manifestMaximum ||
    typeof value.content !== 'string' || value.content.length > contentsMaximum) throw new Error('国内更新文件响应不合法。')
  const compact = value.content.replace(/[\r\n]/g, '')
  if (compact.length > Math.ceil(manifestMaximum / 3) * 4 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact))
    throw new Error('国内更新文件编码不合法。')
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length !== value.size || bytes.toString('base64') !== compact) throw new Error('国内更新文件大小或编码不合法。')
  let decoded
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('国内更新文件不是有效的 UTF-8。') }
  try { return JSON.parse(decoded) } catch { throw new Error('国内更新元数据格式不正确。') }
}

async function publicDomesticManifest() {
  return decodeDomesticContents(await publicJson(domesticManifestUrl, undefined, true, contentsMaximum), true)
}

export function validateDomesticManifest(value) {
  if (!value || value.schemaVersion !== 2 || value.platform !== 'windows' || value.provider !== 'gitee' || value.versionCode !== undefined ||
    !value.source || !positiveId(value.source.releaseId) || !positiveId(value.source.attachmentId)) throw new Error('国内更新清单身份不合法。')
  const expectedUrl = domesticArtifactUrl(value.source.releaseId, value.source.attachmentId)
  if (value.source.filename !== `Yuyin-${value.version}-Setup.exe` || value.artifact?.url !== expectedUrl ||
    value.releaseNotesUrl !== `https://gitee.com/${repository}/releases/tag/pc-v${value.version}`) throw new Error('国内更新地址不合法。')
  validateManifest({ ...value, schemaVersion: 1, artifact: { ...value.artifact, url: `https://github.com/panda472328/yuyin-music/releases/download/pc-v${value.version}/Yuyin-${value.version}-Setup.exe` },
    releaseNotesUrl: `https://github.com/panda472328/yuyin-music/releases/tag/pc-v${value.version}` }, legacyConfig)
  return value
}

export function assertDomesticAdvance(current, candidate) {
  validateDomesticManifest(candidate)
  if (!current) return
  validateDomesticManifest(current)
  const comparison = compareVersions(candidate.version, current.version)
  if (comparison < 0) throw new Error('国内稳定通道不得回退。')
  if (comparison === 0 && ['url', 'sha256', 'size'].some(key => current.artifact[key] !== candidate.artifact[key]))
    throw new Error('公开同版本不得替换附件身份或文件，请递增版本。')
}

/** Produces a candidate only after a complete anonymous Gitee download matches the published GitHub file. */
export async function prepareDomesticManifest({ githubManifest, release, attachments, fetcher, current = null }) {
  validateManifest(githubManifest, legacyConfig)
  const filename = `Yuyin-${githubManifest.version}-Setup.exe`
  if (!release || !positiveId(release.id) || release.tag_name !== `pc-v${githubManifest.version}` || release.prerelease !== false ||
    !Array.isArray(attachments) || attachments.length !== 1 || !positiveId(attachments[0].id) || attachments[0].name !== filename ||
    attachments[0].size !== githubManifest.artifact.size) throw new Error('Gitee 必须已有匹配标签的正式版本和唯一相同安装附件。')
  const url = domesticArtifactUrl(release.id, attachments[0].id)
  const response = await publicRequest(url, githubManifest.artifact.size, fetcher)
  const hash = createHash('sha256'); let bytes = 0
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) !== githubManifest.artifact.size) { await response.body?.cancel(); throw new Error('Gitee 安装附件大小与 GitHub 不一致。') }
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > githubManifest.artifact.size) throw new Error('Gitee 安装附件超过预期大小。')
    hash.update(chunk)
  }
  if (bytes !== githubManifest.artifact.size || hash.digest('hex') !== githubManifest.artifact.sha256)
    throw new Error('Gitee 安装附件与 GitHub 正式文件字节不一致。禁止更新清单。')
  const manifest = { ...githubManifest, schemaVersion: 2, provider: 'gitee', source: { releaseId: release.id, attachmentId: attachments[0].id, filename },
    artifact: { ...githubManifest.artifact, url }, releaseNotesUrl: `https://gitee.com/${repository}/releases/tag/pc-v${githubManifest.version}` }
  assertDomesticAdvance(current, manifest)
  return manifest
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[0] !== '--prepare' || args[1] !== '--output') throw new Error('用法：node scripts/prepare-domestic-update.mjs --prepare --output .qa/domestic-candidate.json')
  const output = path.resolve(root, args[2])
  if ([path.join(root, 'updates', 'stable.json'), path.join(root, 'updates', 'domestic.json')].includes(output)) throw new Error('不得直接覆盖客户端稳定通道；先生成候选并审核。')
  const githubManifest = await publicJson('https://raw.githubusercontent.com/panda472328/yuyin-music/main/updates/stable.json')
  validateManifest(githubManifest, legacyConfig)
  const release = await publicJson(`${api}/releases/tags/pc-v${githubManifest.version}`)
  if (!positiveId(release?.id)) throw new Error('Gitee Release ID 不合法。')
  const attachments = await publicJson(`${api}/releases/${release.id}/attach_files?per_page=100`)
  const remoteCurrent = await publicDomesticManifest()
  let current = remoteCurrent
  const existing = path.join(root, 'updates', 'domestic.json')
  if (fs.existsSync(existing)) {
    const localCurrent = JSON.parse(fs.readFileSync(existing, 'utf8'))
    validateDomesticManifest(localCurrent)
    if (current) assertDomesticAdvance(localCurrent, current)
    else current = localCurrent
  }
  const manifest = await prepareDomesticManifest({ githubManifest, release, attachments, current })
  // Re-read public identities after the full transfer; never silently advance a
  // channel if the maintainer changed attachment identity while it downloaded.
  const releaseAfter = await publicJson(`${api}/releases/${release.id}`)
  const attachmentsAfter = await publicJson(`${api}/releases/${release.id}/attach_files?per_page=100`)
  if (releaseAfter.id !== release.id || releaseAfter.tag_name !== release.tag_name || releaseAfter.prerelease !== false ||
    !Array.isArray(attachmentsAfter) || attachmentsAfter.length !== 1 || ['id', 'name', 'size'].some(key => attachmentsAfter[0][key] !== attachments[0][key]))
    throw new Error('下载期间 Gitee Release/安装附件改变；请重新核对，禁止推进清单。')
  const remoteAfter = await publicDomesticManifest()
  assertDomesticAdvance(remoteAfter, manifest)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Gitee 唯一安装附件已匿名完整下载并通过相同大小和 SHA-256 校验。候选清单：${output}`)
  console.log('未上传安装包、未提交或推送、未修改 stable.json/domestic.json。')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`国内更新候选生成失败：${String(error?.message ?? '未知错误').replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500)}`); process.exitCode = 1 })
}
