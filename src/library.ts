import type { Song } from '../electron/types'

export type PlayMode = 'sequence' | 'repeat' | 'shuffle'
export interface Playlist {
  id: string
  name: string
  description: string
  createdAt: number
  songs: Song[]
}
export interface HistoryEntry { song: Song; playedAt: number }
export interface LibraryState {
  version: 1
  favorites: Song[]
  playlists: Playlist[]
  history: HistoryEntry[]
  // Keep the legacy auto-play value for older backups; search playback is always explicit.
  settings: { volume: number; playMode: PlayMode; autoPlayFirst: boolean }
  queue: Song[]
}
export type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'>
export type SaveResult = { ok: true } | { ok: false; error: string }
export interface LibraryLoadResult { state: LibraryState; error: string | null }

export const LIBRARY_STORAGE_KEY = 'yuyin-library-v1'
const MAX_SONGS = 3_000
const MAX_PLAYLISTS = 100
const MAX_HISTORY = 100
const MAX_JSON_LENGTH = 8 * 1024 * 1024
const BVID = /^BV[0-9A-Za-z]{10}$/

function defaultLibrary(): LibraryState {
  return {
    version: 1,
    favorites: [],
    playlists: [
      { id: 'playlist-default', name: '我的歌单', description: '把喜欢的声音留在这里', createdAt: Date.now(), songs: [] },
      { id: 'playlist-late-night', name: '深夜耳机', description: '夜深了，听一会儿音乐', createdAt: Date.now(), songs: [] },
    ],
    history: [],
    settings: { volume: 0.7, playMode: 'sequence', autoPlayFirst: true },
    queue: [],
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function cleanText(value: unknown, limit: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) || fallback
}

function number(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback
}

function coverUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) return ''
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password &&
      (host === 'hdslb.com' || host.endsWith('.hdslb.com') || host === 'bilibili.com' || host.endsWith('.bilibili.com'))
      ? url.href : ''
  } catch { return '' }
}

function parseSong(value: unknown): Song | null {
  const entry = object(value)
  if (!entry || typeof entry.bvid !== 'string' || !BVID.test(entry.bvid) || entry.source !== 'bilibili') return null
  return {
    id: entry.bvid,
    bvid: entry.bvid,
    title: cleanText(entry.title, 300, entry.bvid),
    artist: cleanText(entry.artist, 150, 'Bilibili'),
    cover: coverUrl(entry.cover),
    duration: Math.round(number(entry.duration, 0, 0, 7 * 24 * 60 * 60)),
    playCount: Math.round(number(entry.playCount, 0)),
    source: 'bilibili',
    url: `https://www.bilibili.com/video/${entry.bvid}/`,
    ...(typeof entry.searchQuery === 'string' ? { searchQuery: cleanText(entry.searchQuery, 80) } : {}),
  }
}

function parseSongs(value: unknown, limit = MAX_SONGS): Song[] {
  if (!Array.isArray(value)) return []
  const songs: Song[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_SONGS * 2)) {
    const song = parseSong(entry)
    if (song && !seen.has(song.bvid)) {
      songs.push(song)
      seen.add(song.bvid)
      if (songs.length >= limit) break
    }
  }
  return songs
}

function parseLibrary(value: unknown): LibraryState {
  const base = defaultLibrary()
  const entry = object(value)
  if (!entry) return base
  const settings = object(entry.settings)
  const playlists: Playlist[] = []
  const playlistIds = new Set<string>()
  if (Array.isArray(entry.playlists)) {
    for (const candidate of entry.playlists.slice(0, MAX_PLAYLISTS)) {
      const playlist = object(candidate)
      if (!playlist || typeof playlist.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(playlist.id) || playlistIds.has(playlist.id)) continue
      const name = cleanText(playlist.name, 80)
      if (!name) continue
      playlists.push({
        id: playlist.id,
        name,
        description: cleanText(playlist.description, 300),
        createdAt: number(playlist.createdAt, 0),
        songs: parseSongs(playlist.songs),
      })
      playlistIds.add(playlist.id)
    }
  }
  const history: HistoryEntry[] = []
  const historyIds = new Set<string>()
  if (Array.isArray(entry.history)) {
    const candidates = entry.history.slice(0, MAX_HISTORY * 10)
      .map(candidate => {
        const item = object(candidate)
        const song = item && parseSong(item.song)
        return item && song ? { song, playedAt: number(item.playedAt, 0) } : null
      })
      .filter((item): item is HistoryEntry => item !== null)
      .sort((a, b) => b.playedAt - a.playedAt)
    for (const item of candidates) {
      if (historyIds.has(item.song.bvid)) continue
      history.push(item)
      historyIds.add(item.song.bvid)
      if (history.length === MAX_HISTORY) break
    }
  }
  return {
    version: 1,
    favorites: parseSongs(entry.favorites),
    // An intentionally empty list must stay empty after the user deletes every playlist.
    playlists: Array.isArray(entry.playlists) ? playlists : base.playlists,
    history,
    settings: {
      volume: number(settings?.volume, base.settings.volume, 0, 1),
      playMode: settings?.playMode === 'repeat' || settings?.playMode === 'shuffle' ? settings.playMode : 'sequence',
      autoPlayFirst: typeof settings?.autoPlayFirst === 'boolean' ? settings.autoPlayFirst : true,
    },
    queue: parseSongs(entry.queue),
  }
}

export function initializeLibrary(storage?: LibraryStorage): LibraryLoadResult {
  let state = defaultLibrary()
  try {
    const desktop = !storage && typeof window !== 'undefined' ? window.musicAPI : undefined
    if (desktop) {
      const disk = desktop.readLibrary()
      const saved = disk ?? globalThis.localStorage?.getItem(LIBRARY_STORAGE_KEY)
      if (saved) {
        if (saved.length > MAX_JSON_LENGTH) throw new Error('音乐库超过可读取的大小，原记录已保留。')
        const parsed = JSON.parse(saved)
        if (parsed?.version !== 1 || !Array.isArray(parsed.favorites) || !Array.isArray(parsed.playlists) || !Array.isArray(parsed.history) || !Array.isArray(parsed.queue)) throw new Error('音乐库格式异常，原记录已保留，请使用备份恢复。')
        state = parseLibrary(parsed)
      }
      // Migrate the previous browser library before any UI can replace it with defaults.
      if (disk === null) desktop.writeLibrary(JSON.stringify(state))
      return { state, error: null }
    }
    const target = storage ?? globalThis.localStorage
    const saved = target?.getItem(LIBRARY_STORAGE_KEY)
    if (saved && saved.length <= MAX_JSON_LENGTH) state = parseLibrary(JSON.parse(saved))
    return { state, error: null }
  } catch (error) {
    return { state, error: error instanceof Error ? `读取音乐库失败：${error.message}` : '读取音乐库失败，原记录已保留，请检查文件权限。' }
  }
}

export function loadLibrary(storage?: LibraryStorage): LibraryState {
  return initializeLibrary(storage).state
}

export function saveLibrary(state: LibraryState, storage?: LibraryStorage): SaveResult {
  try {
    if (state.favorites.length > MAX_SONGS || state.queue.length > MAX_SONGS || state.playlists.some(playlist => playlist.songs.length > MAX_SONGS)) {
      return { ok: false, error: '收藏、队列或每份歌单最多支持 3000 首，已保留原记录，请先减少内容再保存。' }
    }
    if (state.playlists.length > MAX_PLAYLISTS) return { ok: false, error: '最多支持 100 份歌单，已保留原记录，请先减少歌单再保存。' }
    const json = JSON.stringify(parseLibrary(state))
    if (json.length > MAX_JSON_LENGTH) return { ok: false, error: '音乐库过大，保存失败，请先导出备份后减少歌单内容。' }
    const desktop = !storage && typeof window !== 'undefined' ? window.musicAPI : undefined
    if (desktop) {
      desktop.writeLibrary(json)
      return { ok: true }
    }
    const target = storage ?? globalThis.localStorage
    if (!target) return { ok: false, error: '浏览器存储不可用，歌单暂时无法保存。' }
    target.setItem(LIBRARY_STORAGE_KEY, json)
    return { ok: true }
  } catch (error) {
    const name = object(error)?.name
    return { ok: false, error: name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
      ? '本地存储空间已满，请减少歌单内容后重试。'
      : typeof window !== 'undefined' && window.musicAPI && !storage
        ? `保存音乐库失败：${error instanceof Error ? error.message : '请检查磁盘空间与文件权限。'}`
        : '保存音乐库失败，请检查浏览器存储权限。' }
  }
}

export function toggleFavorite(state: LibraryState, song: Song): LibraryState {
  const exists = state.favorites.some(item => item.bvid === song.bvid)
  return { ...state, favorites: exists ? state.favorites.filter(item => item.bvid !== song.bvid) : [...state.favorites, song] }
}

export function createPlaylist(state: LibraryState, name: string, description = ''): LibraryState {
  const cleanName = cleanText(name, 80)
  if (!cleanName || state.playlists.length >= MAX_PLAYLISTS) return state
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID() : `playlist-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return { ...state, playlists: [...state.playlists, { id, name: cleanName, description: cleanText(description, 300), createdAt: Date.now(), songs: [] }] }
}

export function renamePlaylist(state: LibraryState, id: string, name: string): LibraryState {
  const cleanName = cleanText(name, 80)
  if (!cleanName) return state
  return { ...state, playlists: state.playlists.map(playlist => playlist.id === id ? { ...playlist, name: cleanName } : playlist) }
}

/** Import a favorite folder into one stable local playlist, preserving local additions. */
export function importBilibiliPlaylist(state: LibraryState, input: { accountMid: number; folderId: number; name: string; songs: Song[] }): { state: LibraryState; playlistId: string; count: number } {
  if (!Number.isSafeInteger(input.accountMid) || input.accountMid <= 0 || !Number.isSafeInteger(input.folderId) || input.folderId <= 0) throw new Error('收藏夹信息异常，请刷新后重试。')
  const name = cleanText(input.name, 80)
  if (!name) throw new Error('请填写歌单名称。')
  const playlistId = `bilibili-${input.accountMid}-${input.folderId}`
  const existing = state.playlists.find(playlist => playlist.id === playlistId)
  if (!existing && state.playlists.length >= MAX_PLAYLISTS) throw new Error('本地最多支持 100 份歌单，请删除不需要的歌单后重试。')
  const imported = parseSongs(input.songs)
  if (!imported.length && input.songs.length) throw new Error('收藏夹中没有可导入的视频，请刷新后重试。')
  const merged = [...new Map([...(existing?.songs ?? []), ...imported].map(song => [song.bvid, song])).values()]
  if (input.songs.length > MAX_SONGS || merged.length > MAX_SONGS) throw new Error('每份本地歌单最多支持 3000 首，请先缩小收藏夹或歌单后导入。')
  const playlist: Playlist = {
    id: playlistId, name,
    description: existing?.description || '来自 Bilibili 收藏夹 · 再次导入可合并新歌曲',
    createdAt: existing?.createdAt ?? Date.now(), songs: merged,
  }
  return {
    state: { ...state, playlists: existing ? state.playlists.map(item => item.id === playlistId ? playlist : item) : [...state.playlists, playlist] },
    playlistId,
    count: imported.length,
  }
}

export function deletePlaylist(state: LibraryState, id: string): LibraryState {
  return { ...state, playlists: state.playlists.filter(playlist => playlist.id !== id) }
}

export function addToPlaylist(state: LibraryState, id: string, song: Song): LibraryState {
  return { ...state, playlists: state.playlists.map(playlist => playlist.id === id &&
    playlist.songs.length < MAX_SONGS && !playlist.songs.some(item => item.bvid === song.bvid)
    ? { ...playlist, songs: [...playlist.songs, song] } : playlist) }
}

export function removeFromPlaylist(state: LibraryState, id: string, songId: string): LibraryState {
  return { ...state, playlists: state.playlists.map(playlist => playlist.id === id
    ? { ...playlist, songs: playlist.songs.filter(song => song.id !== songId && song.bvid !== songId) } : playlist) }
}

export function recordHistory(state: LibraryState, song: Song, playedAt = Date.now()): LibraryState {
  return { ...state, history: [{ song, playedAt: number(playedAt, Date.now()) },
    ...state.history.filter(item => item.song.bvid !== song.bvid)].slice(0, MAX_HISTORY) }
}

export function getNextIndex(
  queue: readonly unknown[], currentIndex: number, mode: PlayMode, direction = 1, random = Math.random,
): number {
  const length = queue.length
  if (length === 0) return -1
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= length) return direction < 0 ? length - 1 : 0
  if (mode === 'repeat' || length === 1) return currentIndex
  if (mode === 'shuffle') {
    const sample = number(random(), 0, 0, 1 - Number.EPSILON)
    const offset = Math.floor(sample * (length - 1))
    return offset >= currentIndex ? offset + 1 : offset
  }
  return (currentIndex + (direction < 0 ? -1 : 1) + length) % length
}
