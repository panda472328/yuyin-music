import { migrateLocalPreferences, preferenceStorage, type PreferenceStorage } from './local-preferences'
import { preserveCachedCalibrations } from './lyrics-storage'
import { isLyricStyle, type LyricStyle } from './shared/lyric-styles'

export const UI_SETTINGS_KEY = 'yuyin-ui-settings-v1'
export type UITheme = 'classic' | 'bilibili' | 'system' | 'pixel'
export interface UISettings { version: 1; volumeBeforeMute: number; sleepUntil: number | null; theme: UITheme; lyricStyle: LyricStyle }

const themes: readonly UITheme[] = ['classic', 'bilibili', 'system', 'pixel']
const validTheme = (value: unknown): value is UITheme => themes.includes(value as UITheme)

export function loadUISettings(volume: number, storage?: PreferenceStorage, now = Date.now()): { settings: UISettings; error: string | null } {
  const fallback: UISettings = { version: 1, volumeBeforeMute: volume > 0 ? volume : .7, sleepUntil: null, theme: 'classic', lyricStyle: 'classic' }
  const migrationError = storage ? null : [migrateLocalPreferences(), preserveCachedCalibrations()].filter(Boolean).join(' ') || null
  try {
    const saved = preferenceStorage(storage)?.getItem(UI_SETTINGS_KEY)
    if (!saved) return { settings: fallback, error: migrationError }
    const parsed = JSON.parse(saved)
    if (parsed?.version !== 1 || typeof parsed.volumeBeforeMute !== 'number' || !Number.isFinite(parsed.volumeBeforeMute) || parsed.volumeBeforeMute < 0 || parsed.volumeBeforeMute > 1 ||
      !(parsed.sleepUntil === null || Number.isSafeInteger(parsed.sleepUntil) && parsed.sleepUntil >= 0)) throw new Error('听歌设置格式异常，原记录已保留。')
    const settings: UISettings = { version: 1, volumeBeforeMute: volume > 0 ? volume : parsed.volumeBeforeMute, sleepUntil: parsed.sleepUntil !== null && parsed.sleepUntil > now ? parsed.sleepUntil : null, theme: validTheme(parsed.theme) ? parsed.theme : 'classic', lyricStyle: isLyricStyle(parsed.lyricStyle) ? parsed.lyricStyle : 'classic' }
    if (settings.sleepUntil !== parsed.sleepUntil || settings.volumeBeforeMute !== parsed.volumeBeforeMute || settings.theme !== parsed.theme || settings.lyricStyle !== parsed.lyricStyle) {
      const saved = saveUISettings(settings, storage)
      if (!saved.ok) return { settings, error: saved.error }
    }
    return { settings, error: migrationError }
  } catch (error) { return { settings: fallback, error: error instanceof Error ? error.message : '读取听歌设置失败。' } }
}

export function saveUISettings(settings: UISettings, storage?: PreferenceStorage): { ok: true } | { ok: false; error: string } {
  try {
    if (!validTheme(settings.theme)) throw new Error('主题设置不正确。')
    if (!isLyricStyle(settings.lyricStyle)) throw new Error('歌词样式设置不正确。')
    preferenceStorage(storage).setItem(UI_SETTINGS_KEY, JSON.stringify(settings))
    return { ok: true }
  } catch (error) { return { ok: false, error: `保存听歌设置失败：${error instanceof Error ? error.message : '请检查磁盘空间与文件权限。'}` } }
}
