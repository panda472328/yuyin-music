/** Public update contract. Each platform publishes its own stable manifest. */
export interface UpdateManifest {
  schemaVersion: 1
  platform: 'windows' | 'android'
  version: string
  versionCode?: number
  artifact: { url: string; sha256: string; size: number }
  releaseNotesUrl: string
  notes: string
  publishedAt: string
}

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  manifest: UpdateManifest | null
  /** Percentage of the complete installer downloaded, from 0 to 100. */
  progress: number | null
  error: string | null
  checkedAt: string | null
  canInstall: boolean
  installDisabledReason: string | null
}

export const UPDATE_REPOSITORIES = { windows: 'panda472328/yuyin-music', android: 'panda472328/yuyin-music-mobile' } as const
export const WINDOWS_UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/panda472328/yuyin-music/main/updates/stable.json'
export const MAX_UPDATE_BYTES = 500_000_000

export function validStableVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value)
}

export function compareVersions(left: string, right: string): number {
  if (!validStableVersion(left) || !validStableVersion(right)) throw new Error('更新版本号格式不正确。')
  const a = left.split('.').map(Number); const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function updateReleaseUrl(platform: UpdateManifest['platform'], version: string): string {
  if (!validStableVersion(version)) throw new Error('更新版本号格式不正确。')
  return `https://github.com/${UPDATE_REPOSITORIES[platform]}/releases/tag/${platform === 'windows' ? 'pc' : 'android'}-v${version}`
}

export function updateArtifactUrl(platform: UpdateManifest['platform'], version: string): string {
  const release = updateReleaseUrl(platform, version).replace('/tag/', '/download/')
  return `${release}/${platform === 'windows' ? `Yuyin-${version}-Setup.exe` : `Yuyin-Mobile-${version}.apk`}`
}

/** Reject paths, repositories and download filenames outside the maintained release. */
export function parseUpdateManifest(value: unknown, expectedPlatform: UpdateManifest['platform']): UpdateManifest {
  const input = record(value); const artifact = record(input?.artifact)
  if (!input || input.schemaVersion !== 1 || input.platform !== expectedPlatform || !validStableVersion(input.version) ||
    !artifact || artifact.url !== updateArtifactUrl(expectedPlatform, input.version) ||
    typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) || (artifact.size as number) < 1 || (artifact.size as number) > MAX_UPDATE_BYTES ||
    input.releaseNotesUrl !== updateReleaseUrl(expectedPlatform, input.version) ||
    typeof input.notes !== 'string' || input.notes.length > 8000 ||
    typeof input.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.publishedAt) || !Number.isFinite(Date.parse(input.publishedAt)) ||
    (expectedPlatform === 'android' && (!Number.isSafeInteger(input.versionCode) || (input.versionCode as number) < 1)) ||
    (expectedPlatform === 'windows' && input.versionCode !== undefined)) throw new Error('更新清单不合法，请稍后重试。')
  return { schemaVersion: 1, platform: expectedPlatform, version: input.version,
    ...(expectedPlatform === 'android' ? { versionCode: input.versionCode as number } : {}),
    artifact: { url: artifact.url as string, sha256: artifact.sha256, size: artifact.size as number },
    releaseNotesUrl: input.releaseNotesUrl as string, notes: input.notes, publishedAt: input.publishedAt }
}
