export const LOCAL_PREFERENCE_KEYS = [
  'yuyin-lyrics-source-v1', 'yuyin-lyrics-v1', 'yuyin-bilibili-subtitles-v1',
  'yuyin-ui-settings-v1', 'yuyin-lyric-calibrations-v1',
] as const
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Desktop preferences use fixed files; explicit injected storage and web previews stay portable. */
export function preferenceStorage(storage?: PreferenceStorage): PreferenceStorage {
  if (storage) return storage
  const desktop = typeof window !== 'undefined' ? window.musicAPI : undefined
  if (!desktop) return globalThis.localStorage
  return {
    getItem(key) {
      const saved = desktop.readLocalPreference(key)
      if (saved !== null) return saved
      const legacy = globalThis.localStorage?.getItem(key) ?? null
      if (legacy !== null) desktop.writeLocalPreference(key, legacy)
      return legacy
    },
    setItem(key, value) { desktop.writeLocalPreference(key, value) },
  }
}

export function migrateLocalPreferences(): string | null {
  if (typeof window === 'undefined' || !window.musicAPI) return null
  const storage = preferenceStorage()
  const errors = new Set<string>()
  // Migrate even unopened lyrics, so upgrading never loses an older song's calibration.
  for (const key of LOCAL_PREFERENCE_KEYS) {
    try { storage.getItem(key) }
    catch (error) { errors.add(error instanceof Error ? error.message : '设置文件读写失败。') }
  }
  return errors.size ? `部分设置未能读取或迁移：${[...errors].join(' ')}` : null
}
