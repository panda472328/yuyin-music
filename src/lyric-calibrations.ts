import type { LyricsProvider, LyricsTrack } from '../electron/lyrics-types'
import { preferenceStorage, type PreferenceStorage } from './local-preferences'

export const CALIBRATIONS_KEY = 'yuyin-lyric-calibrations-v1'
interface Calibration { timeline: string; offsetSeconds: number }
type Result = { ok: true } | { ok: false; error: string }

function timeline(track: LyricsTrack): string {
  const text = track.syncedLyrics ?? ''
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 0x01000193)
    second = Math.imul(second ^ text.charCodeAt(index), 0x85ebca6b)
  }
  return `${track.id}:${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`
}

function entries(storage: PreferenceStorage): Record<string, Calibration> {
  const saved = storage.getItem(CALIBRATIONS_KEY)
  if (saved === null) return {}
  if (saved.length > 2 * 1024 * 1024) throw new Error('歌词校准设置文件过大，原记录已保留。')
  const parsed = JSON.parse(saved)
  if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('歌词校准设置格式异常，原记录已保留。')
  const valid: Record<string, Calibration> = {}
  for (const [key, value] of Object.entries(parsed.entries)) {
    const item = value as Partial<Calibration> | null
    if (/^(lrclib|bilibili):BV[0-9A-Za-z]{10}$/.test(key) && item && typeof item.timeline === 'string' && item.timeline.length < 100 &&
      typeof item.offsetSeconds === 'number' && Number.isFinite(item.offsetSeconds) && Math.abs(item.offsetSeconds) <= 180) {
      valid[key] = { timeline: item.timeline, offsetSeconds: item.offsetSeconds }
    }
  }
  return valid
}

/** User calibration does not expire when a cached lyric download expires or is evicted. */
export function readCalibration(bvid: string, provider: LyricsProvider, track: LyricsTrack, storage?: PreferenceStorage): number | null {
  try {
    const calibrated = entries(preferenceStorage(storage))[`${provider}:${bvid}`]
    return calibrated?.timeline === timeline(track) ? calibrated.offsetSeconds : null
  } catch { return null }
}

export function saveCalibration(bvid: string, provider: LyricsProvider, track: LyricsTrack, offsetSeconds: number, storage?: PreferenceStorage, onlyIfMissing = false): Result {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !['lrclib', 'bilibili'].includes(provider) || !Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > 180) return { ok: false, error: '歌词校准参数不合法。' }
  try {
    const target = preferenceStorage(storage)
    const saved = entries(target)
    const key = `${provider}:${bvid}`
    if (onlyIfMissing && saved[key]) return { ok: true }
    const stamp = timeline(track)
    if (saved[key]?.timeline === stamp && saved[key]?.offsetSeconds === offsetSeconds) return { ok: true }
    if (!saved[key] && Object.keys(saved).length >= 10_000) throw new Error('已保存 10000 份歌词校准，暂时无法新增。')
    saved[key] = { timeline: stamp, offsetSeconds }
    const json = JSON.stringify({ version: 1, entries: saved })
    if (json.length > 2 * 1024 * 1024) throw new Error('歌词校准设置过大。')
    target.setItem(CALIBRATIONS_KEY, json)
    return { ok: true }
  } catch (error) { return { ok: false, error: `保存歌词校准失败：${error instanceof Error ? error.message : '请检查存储权限。'}` } }
}
