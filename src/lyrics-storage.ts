import type { BilibiliSubtitleInfo, LyricsProvider, LyricsTrack } from '../electron/lyrics-types'
import { preferenceStorage } from './local-preferences'
import { readCalibration, saveCalibration } from './lyric-calibrations'

export interface SavedLyrics {
  track: LyricsTrack | null
  query: string
  /** Positive values delay the displayed lyrics. */
  offsetSeconds: number
  updatedAt: number
  subtitle?: BilibiliSubtitleInfo
  message?: string
  requiresLogin?: boolean
}

type LyricsStorage = Pick<Storage, 'getItem' | 'setItem'>
type SaveResult = { ok: true } | { ok: false; error: string }

export const LYRICS_STORAGE_KEY = 'yuyin-lyrics-v1'
export const BILIBILI_LYRICS_STORAGE_KEY = 'yuyin-bilibili-subtitles-v1'
const BVID = /^BV[0-9A-Za-z]{10}$/
const MATCH_TTL = 30 * 24 * 60 * 60 * 1_000
const NO_MATCH_TTL = 5 * 60 * 1_000
const MAX_ENTRIES = 50
// localStorage accounts for UTF-16 strings; this is conservative for JSON in any language.
const MAX_JSON_BYTES = 1.5 * 1024 * 1024
const MAX_LYRICS_LENGTH = 100_000

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function lyricsText(value: unknown): value is string | null {
  return value === null || boundedText(value, MAX_LYRICS_LENGTH)
}

function parseTrack(value: unknown): LyricsTrack | null {
  const entry = object(value)
  if (!entry || !Number.isSafeInteger(entry.id) || (entry.id as number) < 0 ||
    !boundedText(entry.trackName, 1_000) || !entry.trackName.trim() ||
    !boundedText(entry.artistName, 1_000) || !boundedText(entry.albumName, 1_000) ||
    !finiteNumber(entry.duration) || entry.duration < 0 || entry.duration > 7 * 24 * 60 * 60 ||
    typeof entry.instrumental !== 'boolean' || !lyricsText(entry.syncedLyrics) || !lyricsText(entry.plainLyrics)) return null
  return {
    id: entry.id as number,
    trackName: entry.trackName,
    artistName: entry.artistName,
    albumName: entry.albumName,
    duration: entry.duration,
    instrumental: entry.instrumental,
    syncedLyrics: entry.syncedLyrics,
    plainLyrics: entry.plainLyrics,
  }
}

function parseSubtitle(value: unknown): BilibiliSubtitleInfo | null {
  const subtitle = object(value)
  if (!subtitle || !boundedText(subtitle.language, 80) || !subtitle.language.trim() ||
    !boundedText(subtitle.label, 160) || !subtitle.label.trim() || typeof subtitle.isAI !== 'boolean') return null
  return { language: subtitle.language, label: subtitle.label, isAI: subtitle.isAI }
}

function parseEntry(value: unknown): SavedLyrics | null {
  const entry = object(value)
  if (!entry || !boundedText(entry.query, 160) || !finiteNumber(entry.offsetSeconds) ||
    !finiteNumber(entry.updatedAt) || entry.updatedAt < 0 || entry.updatedAt > Number.MAX_SAFE_INTEGER) return null
  const track = entry.track === null ? null : parseTrack(entry.track)
  if (entry.track !== null && !track) return null
  const subtitle = entry.subtitle === undefined ? undefined : parseSubtitle(entry.subtitle)
  if ((entry.subtitle !== undefined && !subtitle) ||
    (entry.message !== undefined && !boundedText(entry.message, 1_000)) ||
    (entry.requiresLogin !== undefined && typeof entry.requiresLogin !== 'boolean')) return null
  return {
    track,
    query: entry.query,
    offsetSeconds: Math.max(-180, Math.min(180, entry.offsetSeconds)),
    updatedAt: entry.updatedAt,
    ...(subtitle ? { subtitle } : {}),
    ...(entry.message !== undefined ? { message: entry.message as string } : {}),
    ...(entry.requiresLogin !== undefined ? { requiresLogin: entry.requiresLogin as boolean } : {}),
  }
}

function fresh(entry: SavedLyrics, now: number): boolean {
  const age = now - entry.updatedAt
  return age >= 0 && age < (entry.track ? MATCH_TTL : NO_MATCH_TTL)
}

function parseCache(saved: string | null, now: number): Map<string, SavedLyrics> {
  if (!saved || saved.length * 2 > MAX_JSON_BYTES) return new Map()
  let parsed: unknown
  try { parsed = JSON.parse(saved) } catch { return new Map() }
  const cache = object(parsed)
  const entries = cache?.version === 1 ? object(cache.entries) : null
  if (!entries) return new Map()
  const valid: [string, SavedLyrics][] = []
  for (const [bvid, value] of Object.entries(entries)) {
    if (!BVID.test(bvid)) continue
    const entry = parseEntry(value)
    if (entry && fresh(entry, now)) valid.push([bvid, entry])
  }
  return new Map(valid.sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, MAX_ENTRIES))
}

function serialize(entries: readonly [string, SavedLyrics][]): string {
  return JSON.stringify({ version: 1, entries: Object.fromEntries(entries) })
}

function storageKey(provider: LyricsProvider): string {
  return provider === 'bilibili' ? BILIBILI_LYRICS_STORAGE_KEY : LYRICS_STORAGE_KEY
}

export function preserveCachedCalibrations(storage?: LyricsStorage): string | null {
  const target = preferenceStorage(storage)
  const errors = new Set<string>()
  for (const provider of ['lrclib', 'bilibili'] as const) {
    try {
      const saved = target?.getItem(storageKey(provider))
      if (!saved || saved.length * 2 > MAX_JSON_BYTES) continue
      const parsed = JSON.parse(saved)
      const cache = parsed?.version === 1 ? object(parsed.entries) : null
      if (!cache) continue
      for (const [bvid, raw] of Object.entries(cache)) {
        const entry = parseEntry(raw)
        if (!BVID.test(bvid) || !entry?.track?.syncedLyrics) continue
        const result = saveCalibration(bvid, provider, entry.track, entry.offsetSeconds, storage, true)
        if (!result.ok) errors.add(result.error)
      }
    } catch (error) { errors.add(error instanceof Error ? error.message : '读取旧歌词校准失败。') }
  }
  return errors.size ? [...errors].join(' ') : null
}

export function readLyricsCache(bvid: string, storage?: LyricsStorage, provider: LyricsProvider = 'lrclib'): SavedLyrics | null {
  if (!BVID.test(bvid)) return null
  try {
    const target = preferenceStorage(storage)
    const cached = target ? parseCache(target.getItem(storageKey(provider)), Date.now()).get(bvid) ?? null : null
    if (cached?.track) {
      const calibrated = readCalibration(bvid, provider, cached.track, storage)
      if (calibrated !== null) return { ...cached, offsetSeconds: calibrated }
    }
    return cached
  } catch { return null }
}

export function saveLyricsCache(bvid: string, entry: SavedLyrics, storage?: LyricsStorage, provider: LyricsProvider = 'lrclib'): SaveResult {
  const candidate = parseEntry(entry)
  if (!BVID.test(bvid) || !candidate) return { ok: false, error: '歌词数据不完整，暂时无法保存。' }
  try {
    const target = preferenceStorage(storage)
    if (!target) return { ok: false, error: '浏览器存储不可用，歌词设置暂时无法保存。' }
    const now = Date.now()
    const key = storageKey(provider)
    const entries = parseCache(target.getItem(key), now)
    // A future timestamp cannot turn into a cache entry that never expires.
    candidate.updatedAt = Math.min(candidate.updatedAt, now)
    entries.set(bvid, candidate)
    const newest = [...entries].filter(([, value]) => fresh(value, now))
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_ENTRIES)
    let json = serialize(newest)
    while (json.length * 2 > MAX_JSON_BYTES && newest.length > 1) {
      // Keep the entry being saved even when older than the other entries.
      let oldest = newest.length - 1
      while (oldest >= 0 && newest[oldest][0] === bvid) oldest--
      if (oldest < 0) break
      newest.splice(oldest, 1)
      json = serialize(newest)
    }
    if (json.length * 2 > MAX_JSON_BYTES) return { ok: false, error: '歌词内容过大，暂时无法保存。' }
    target.setItem(key, json)
    if (candidate.track?.syncedLyrics) {
      const calibrated = saveCalibration(bvid, provider, candidate.track, candidate.offsetSeconds, storage)
      if (!calibrated.ok) return calibrated
    }
    return { ok: true }
  } catch (error) {
    const name = object(error)?.name
    return { ok: false, error: name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
      ? '本地存储空间已满，歌词与时间调整暂时无法保存。'
      : `保存歌词失败：${error instanceof Error ? error.message : '请检查存储权限。'}` }
  }
}
