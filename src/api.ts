import type { BilibiliAccountStatus, BilibiliFavoriteFoldersResult, BilibiliFavoriteItemsResult, BilibiliFavoriteSongsResult, Song, PlaybackStatus, SearchResult } from '../electron/types'
import type { LyricsLookupResult, LyricsRequest, LyricsTrack } from '../electron/lyrics-types'
import { buildLyricsQueries, selectLyricsMatch } from './lyrics'
import type { DesktopLyricsContent, DesktopLyricsSettings, DesktopLyricsSnapshot } from '../electron/desktop-lyrics-types'
import { DESKTOP_LYRICS_DEFAULT_SETTINGS, DESKTOP_LYRICS_DEFAULT_CONTENT } from '../electron/desktop-lyrics-types'

export interface MusicAPI {
  search(query: string, page?: number): Promise<SearchResult>
  play(song: Song): Promise<PlaybackStatus>
  pause(): Promise<PlaybackStatus>
  resume(): Promise<PlaybackStatus>
  seek(seconds: number): Promise<PlaybackStatus>
  setVolume(volume: number): Promise<PlaybackStatus>
  getStatus(): Promise<PlaybackStatus>
  getLyrics(request: LyricsRequest): Promise<LyricsLookupResult>
  getDesktopLyricsSnapshot(): Promise<DesktopLyricsSnapshot>
  updateDesktopLyricsSettings(patch: Partial<DesktopLyricsSettings>): Promise<DesktopLyricsSnapshot>
  publishDesktopLyrics(content: DesktopLyricsContent): Promise<void>
  onDesktopLyricsSnapshot(callback: (snapshot: DesktopLyricsSnapshot) => void): () => void
  login(): Promise<void>
  getBilibiliAccount(): Promise<BilibiliAccountStatus>
  openBilibiliProfile(): Promise<void>
  onBilibiliSessionChanged(callback: () => void): () => void
  getBilibiliFavoriteFolders(): Promise<BilibiliFavoriteFoldersResult>
  getBilibiliFavoriteItems(mediaId: number, page?: number): Promise<BilibiliFavoriteItemsResult>
  getBilibiliFavoriteSongs(mediaId: number): Promise<BilibiliFavoriteSongsResult>
  openSource(): Promise<void>
  minimize(): void
  maximize(): void
  close(): void
  onStatus(callback: (status: PlaybackStatus) => void): () => void
  onEnded(callback: () => void): () => void
  readLibrary(): string | null
  writeLibrary(data: string): void
  readLocalPreference(key: string): string | null
  writeLocalPreference(key: string, value: string): void
  onPreferenceError(callback: (message: string) => void): () => void
  exportLibrary(data: string): Promise<boolean>
  importLibrary(): Promise<string | null>
}

declare global { interface Window { musicAPI?: MusicAPI } }

const desktopRequired = async (): Promise<never> => { throw new Error('请在余音桌面客户端中播放，网页预览仅提供界面和音乐库功能。') }
const idle: PlaybackStatus = { state: 'idle', song: null, currentTime: 0, duration: 0, volume: .7, error: null }

const previewAPI: MusicAPI = {
  async search(query, page = 1) {
    const params = new URLSearchParams({ search_type: 'video', keyword: query, order: 'totalrank', page: String(page), page_size: '20' })
    const response = await fetch(`/bili-api/x/web-interface/search/type?${params}`)
    if (!response.ok) throw new Error('Bilibili 暂时无法访问，请稍后重试。')
    const payload = await response.json()
    if (payload.code !== 0) throw new Error('Bilibili 需要验证，请在桌面客户端中打开 Bilibili 登录后重试。')
    const songs: Song[] = (payload.data?.result ?? []).map((item: any) => ({
      id: item.bvid, bvid: item.bvid,
      title: String(item.title).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"'),
      artist: item.author, cover: item.pic.startsWith('//') ? `https:${item.pic}` : item.pic,
      duration: String(item.duration).split(':').reduce((total: number, part: string) => total * 60 + Number(part), 0),
      playCount: Number(item.play), source: 'bilibili', url: `https://www.bilibili.com/video/${item.bvid}/`
    }))
    return { query, songs, page: payload.data.page, pageSize: 20, total: payload.data.numResults, hasMore: page < payload.data.numPages }
  },
  play: desktopRequired, pause: desktopRequired, resume: desktopRequired, seek: desktopRequired,
  getBilibiliAccount: desktopRequired,
  openBilibiliProfile: desktopRequired,
  onBilibiliSessionChanged() { return () => {} },
  async getBilibiliFavoriteFolders() { throw new Error('请在余音桌面客户端中读取 Bilibili 收藏夹。') },
  async getBilibiliFavoriteItems() { throw new Error('请在余音桌面客户端中读取 Bilibili 收藏夹。') },
  async getBilibiliFavoriteSongs() { throw new Error('请在余音桌面客户端中读取 Bilibili 收藏夹。') },
  async getDesktopLyricsSnapshot() { return { settings: { ...DESKTOP_LYRICS_DEFAULT_SETTINGS }, content: { ...DESKTOP_LYRICS_DEFAULT_CONTENT }, error: null } },
  updateDesktopLyricsSettings: desktopRequired,
  async publishDesktopLyrics() {},
  onDesktopLyricsSnapshot() { return () => {} },
  async getLyrics(request) {
    if (request.provider === 'bilibili') throw new Error('请在余音桌面客户端中获取 Bilibili 字幕，桌面端会使用你的 Bilibili 登录状态。')
    const queries = buildLyricsQueries(request)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      for (const query of queries) {
        const response = await fetch(`/lyrics-api/api/search?${new URLSearchParams({ q: query })}`, { signal: controller.signal })
        if (!response.ok) throw new Error('歌词服务暂时无法访问，请稍后重试。')
        const raw: unknown = await response.json()
        if (!Array.isArray(raw)) throw new Error('歌词服务返回的数据格式异常。')
        const tracks = raw.filter(item => item && typeof item === 'object' && typeof item.id === 'number' && typeof item.trackName === 'string' && typeof item.artistName === 'string').map(item => ({ ...item, albumName: typeof item.albumName === 'string' ? item.albumName : '', syncedLyrics: typeof item.syncedLyrics === 'string' ? item.syncedLyrics : null, plainLyrics: typeof item.plainLyrics === 'string' ? item.plainLyrics : null })) as LyricsTrack[]
        const match = selectLyricsMatch(request, tracks)
        if (match) return { provider: 'lrclib', query, match }
      }
      return { provider: 'lrclib', query: queries[0] ?? '', match: null }
    } catch (error) { if (controller.signal.aborted) throw new Error('歌词查询超时，请稍后重试。'); throw error }
    finally { clearTimeout(timeout) }
  },
  async setVolume() { return idle }, async getStatus() { return idle }, login: desktopRequired, openSource: desktopRequired,
  minimize() {}, maximize() {}, close() {}, onStatus() { return () => {} }, onEnded() { return () => {} },
  readLibrary() { return localStorage.getItem('yuyin-library-v1') },
  writeLibrary(data) { localStorage.setItem('yuyin-library-v1', data) },
  readLocalPreference(key) { return localStorage.getItem(key) },
  writeLocalPreference(key, value) { localStorage.setItem(key, value) },
  onPreferenceError() { return () => {} },
  async exportLibrary(data) {
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); anchor.download = '余音音乐库.json'; anchor.click(); URL.revokeObjectURL(anchor.href); return true
  },
  async importLibrary() {
    return new Promise(resolve => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
      input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null)
      input.addEventListener('cancel', () => resolve(null)); input.click()
    })
  }
}

export const api = window.musicAPI ?? previewAPI
export const isDesktop = Boolean(window.musicAPI)
