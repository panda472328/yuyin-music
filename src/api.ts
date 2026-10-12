import type { BilibiliAccountStatus, BilibiliFavoriteFoldersResult, BilibiliFavoriteItemsResult, BilibiliFavoriteSongsResult, Song, PlaybackStatus, SearchResult } from '../electron/types'
import type { LyricsLookupResult, LyricsRequest, LyricsTrack } from '../electron/lyrics-types'
import { buildLyricsQueries, selectLyricsMatch } from './lyrics'
import type { DesktopLyricsContent, DesktopLyricsSettings, DesktopLyricsSnapshot } from '../electron/desktop-lyrics-types'
import { DESKTOP_LYRICS_DEFAULT_SETTINGS, DESKTOP_LYRICS_DEFAULT_CONTENT } from '../electron/desktop-lyrics-types'
import type { UpdateState } from './shared/update'
import type { CommentSort, VideoCommentsPage, VideoRepliesPage, CommentLikeResult, CommentCreateRequest, CommentCreateResult } from './shared/comments'
import { bilibiliResultText, isSearchMode, normalizeSongName, parseSearchSuggestions, rankSongTitleResults, type SearchMode } from './shared/search-mode'
import { createWebView2API, isWebView2Available } from './webview2-bridge'

export interface MusicAPI {
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<UpdateState>
  openUpdateRelease(): Promise<void>
  onUpdateState(callback: (state: UpdateState) => void): () => void
  search(query: string, page?: number, mode?: SearchMode): Promise<SearchResult>
  searchSuggestions(query: string): Promise<string[]>
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
  continueAsGuest(): Promise<BilibiliAccountStatus>
  openBilibiliProfile(): Promise<void>
  onBilibiliSessionChanged(callback: () => void): () => void
  getBilibiliFavoriteFolders(): Promise<BilibiliFavoriteFoldersResult>
  getBilibiliFavoriteItems(mediaId: number, page?: number): Promise<BilibiliFavoriteItemsResult>
  getBilibiliFavoriteSongs(mediaId: number): Promise<BilibiliFavoriteSongsResult>
  getVideoComments(bvid: string, sort: CommentSort, page?: number): Promise<VideoCommentsPage>
  getCommentReplies(bvid: string, rootId: string, page?: number): Promise<VideoRepliesPage>
  setCommentLike(bvid: string, id: string, liked: boolean, expectedMid: number): Promise<CommentLikeResult>
  createComment(request: CommentCreateRequest): Promise<CommentCreateResult>
  openSource(): Promise<void>
  openMV(): Promise<void>
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

const desktopRequired = async (): Promise<never> => { throw new Error('请在openmusic桌面客户端中播放，网页预览仅提供界面和音乐库功能。') }
const idle: PlaybackStatus = { state: 'idle', song: null, currentTime: 0, duration: 0, volume: .7, error: null }
const previewUpdate: UpdateState = { status: 'idle', currentVersion: '预览', manifest: null, progress: null, error: null,
  checkedAt: null, canInstall: false, installDisabledReason: '网页预览不支持软件更新，请使用openmusic Windows 安装版。' }

const previewAPI: MusicAPI = {
  async getUpdateState() { return { ...previewUpdate } },
  async checkForUpdates() { return { ...previewUpdate, status: 'error', error: previewUpdate.installDisabledReason } },
  downloadUpdate: desktopRequired, installUpdate: desktopRequired, openUpdateRelease: desktopRequired,
  onUpdateState() { return () => {} },
  async search(query, page = 1, mode = 'video') {
    if (!isSearchMode(mode)) throw new Error('搜索模式不合法。')
    const keyword = query.trim()
    if (!keyword || (mode === 'song' && !normalizeSongName(keyword))) throw new Error('请输入歌曲或视频名称。')
    const params = new URLSearchParams({ search_type: 'video', keyword, order: 'totalrank', page: String(page), page_size: '20' })
    const response = await fetch(`/bili-api/x/web-interface/search/type?${params}`)
    if (!response.ok) throw new Error('Bilibili 暂时无法访问，请稍后重试。')
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Bilibili 搜索结果格式已变化，请稍后重试。')
    const searchResponse = payload as { code?: unknown; data?: unknown }
    if (searchResponse.code !== 0) throw new Error('Bilibili 需要验证，请在桌面客户端中打开 Bilibili 登录后重试。')
    const data = searchResponse.data && typeof searchResponse.data === 'object' && !Array.isArray(searchResponse.data)
      ? searchResponse.data as Record<string, unknown> : null
    if (!data || !Array.isArray(data.result)) throw new Error('Bilibili 搜索结果格式已变化，请稍后重试。')
    const songs: Song[] = data.result.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item) && typeof item.bvid === 'string' && /^BV[0-9a-zA-Z]{10}$/.test(item.bvid),
    ).map(item => {
      const bvid = item.bvid as string
      let cover = typeof item.pic === 'string' ? item.pic : ''
      if (cover.startsWith('//')) cover = `https:${cover}`
      if (!cover.startsWith('https://')) cover = ''
      const parts = String(item.duration ?? '').split(':').map(Number)
      return {
        id: bvid, bvid, title: bilibiliResultText(item.title) || bvid,
        artist: bilibiliResultText(item.author) || 'Bilibili UP 主', cover,
        duration: parts.every(Number.isFinite) ? parts.reduce((total, part) => total * 60 + Math.max(0, part), 0) : 0,
        playCount: Math.max(0, Number(item.play) || 0), source: 'bilibili', url: `https://www.bilibili.com/video/${bvid}/`,
      }
    })
    const total = Math.max(0, Number(data.numResults) || songs.length)
    const pageSize = Math.max(1, Number(data.pagesize) || 20)
    const pages = Number(data.numPages) || Math.ceil(total / pageSize)
    return { query: keyword, mode, songs: mode === 'song' ? rankSongTitleResults(songs, keyword) : songs,
      page, pageSize, total, hasMore: page < pages }
  },
  async searchSuggestions(query) {
    const keyword = query.trim()
    if (!keyword) return []
    if (keyword.length > 200) throw new Error('搜索词过长。')
    const response = await fetch(`/bili-suggest/main/suggest?${new URLSearchParams({ term: keyword })}`)
    if (!response.ok) throw new Error('Bilibili 搜索建议暂时无法访问，请稍后重试。')
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Bilibili 搜索建议响应格式异常。')
    const code = (payload as { code?: unknown }).code
    if (code !== undefined && code !== 0) throw new Error('Bilibili 搜索建议暂时不可用。')
    return parseSearchSuggestions(payload)
  },
  play: desktopRequired, pause: desktopRequired, resume: desktopRequired, seek: desktopRequired,
  getBilibiliAccount: desktopRequired,
  async continueAsGuest() { return { loggedIn: false, account: null, guest: true } },
  openBilibiliProfile: desktopRequired,
  onBilibiliSessionChanged() { return () => {} },
  async getBilibiliFavoriteFolders() { throw new Error('请在openmusic桌面客户端中读取 Bilibili 收藏夹。') },
  async getBilibiliFavoriteItems() { throw new Error('请在openmusic桌面客户端中读取 Bilibili 收藏夹。') },
  async getBilibiliFavoriteSongs() { throw new Error('请在openmusic桌面客户端中读取 Bilibili 收藏夹。') },
  async getVideoComments() { throw new Error('请使用 Windows WebView2 客户端查看视频评论。') },
  async getCommentReplies() { throw new Error('请使用 Windows WebView2 客户端查看评论回复。') },
  async setCommentLike() { throw new Error('请在 Windows WebView2 客户端登录 Bilibili 后点赞。') },
  async createComment() { throw new Error('请在 Windows WebView2 客户端登录 Bilibili 后发表评论。') },
  async getDesktopLyricsSnapshot() { return { settings: { ...DESKTOP_LYRICS_DEFAULT_SETTINGS }, content: { ...DESKTOP_LYRICS_DEFAULT_CONTENT }, error: null } },
  updateDesktopLyricsSettings: desktopRequired,
  async publishDesktopLyrics() {},
  onDesktopLyricsSnapshot() { return () => {} },
  async getLyrics(request) {
    if (request.provider === 'bilibili') throw new Error('请在openmusic桌面客户端中获取 Bilibili 字幕，桌面端会使用你的 Bilibili 登录状态。')
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
  async setVolume() { return idle }, async getStatus() { return idle }, login: desktopRequired, openSource: desktopRequired, openMV: desktopRequired,
  minimize() {}, maximize() {}, close() {}, onStatus() { return () => {} }, onEnded() { return () => {} },
  readLibrary() { return localStorage.getItem('yuyin-library-v1') },
  writeLibrary(data) { localStorage.setItem('yuyin-library-v1', data) },
  readLocalPreference(key) { return localStorage.getItem(key) },
  writeLocalPreference(key, value) { localStorage.setItem(key, value) },
  onPreferenceError() { return () => {} },
  async exportLibrary(data) {
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); anchor.download = 'openmusic音乐库.json'; anchor.click(); URL.revokeObjectURL(anchor.href); return true
  },
  async importLibrary() {
    return new Promise(resolve => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
      input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null)
      input.addEventListener('cancel', () => resolve(null)); input.click()
    })
  }
}

const webView2API = createWebView2API()
// Keep the existing storage helpers compatible with the native renderer. The
// library and preference modules intentionally look up `window.musicAPI` so
// that they can persist data outside browser storage; WebView2 uses the same
// contract even though it does not expose Electron's preload.
if (webView2API && !window.musicAPI) window.musicAPI = webView2API
export const api = window.musicAPI ?? webView2API ?? previewAPI
export const isDesktop = Boolean(window.musicAPI) || isWebView2Available()
