import type { BilibiliAccountStatus, BilibiliFavoriteFoldersResult, BilibiliFavoriteItemsResult, BilibiliFavoriteSongsResult, PlaybackStatus, SearchResult, Song } from '../electron/types'
import type { DesktopLyricsAPI, DesktopLyricsContent, DesktopLyricsDragRegions, DesktopLyricsSettings, DesktopLyricsSnapshot } from '../electron/desktop-lyrics-types'
import type { LyricsLookupResult, LyricsRequest, LyricsTrack } from '../electron/lyrics-types'
import { buildLyricsQueries, selectLyricsMatch } from './lyrics'
import type { MusicAPI } from './api'
import type { UpdateState } from './shared/update'

interface WebViewMessagePort {
  hostObjects?: { sync?: { localData?: NativeLocalData } }
  postMessage(value: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
}

interface NativeLocalData {
  ReadLibrary(): string | null
  WriteLibrary(value: string): void
  ReadPreference(key: string): string | null
  WritePreference(key: string, value: string): void
}

declare global {
  interface Window {
    chrome?: { webview?: WebViewMessagePort }
  }
}

interface BridgeResponse {
  type: 'response'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

interface BridgeEvent {
  type: 'event'
  name: string
  value?: unknown
}

type EventCallback = (value: unknown) => void

const REQUEST_TIMEOUT = 55_000
const bridge = () => window.chrome?.webview ?? null
const isResponse = (value: unknown): value is BridgeResponse => {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<BridgeResponse>
  return input.type === 'response' && Number.isSafeInteger(input.id) && typeof input.ok === 'boolean'
}
const isEvent = (value: unknown): value is BridgeEvent => {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<BridgeEvent>
  return input.type === 'event' && typeof input.name === 'string'
}

class WebView2Bridge {
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Map<string, Set<EventCallback>>()
  private readonly port: WebViewMessagePort
  private readonly receive = (event: MessageEvent<unknown>) => {
    if (isResponse(event.data)) {
      const pending = this.pending.get(event.data.id)
      if (!pending) return
      this.pending.delete(event.data.id)
      clearTimeout(pending.timer)
      if (event.data.ok) pending.resolve(event.data.value)
      else pending.reject(new Error(typeof event.data.error === 'string' ? event.data.error : '原生操作失败。'))
      return
    }
    if (!isEvent(event.data)) return
    for (const callback of this.listeners.get(event.data.name) ?? []) callback(event.data.value)
  }

  constructor(port: WebViewMessagePort) {
    this.port = port
    port.addEventListener('message', this.receive)
  }

  call<T>(method: string, args: unknown[] = []): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('原生操作超时，请稍后重试。'))
      }, method === 'update.download' ? 16 * 60_000 : REQUEST_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      try { this.port.postMessage({ type: 'invoke', id, method, args }) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  fire(method: string, args: unknown[] = []): void {
    try { this.port.postMessage({ type: 'invoke', id: 0, method, args }) } catch { /* Host may be closing. */ }
  }

  on(name: string, callback: EventCallback): () => void {
    let callbacks = this.listeners.get(name)
    if (!callbacks) { callbacks = new Set(); this.listeners.set(name, callbacks) }
    callbacks.add(callback)
    return () => { callbacks?.delete(callback); if (!callbacks?.size) this.listeners.delete(name) }
  }

  dispose(): void {
    this.port.removeEventListener('message', this.receive)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('原生窗口已关闭。')) }
    this.pending.clear()
    this.listeners.clear()
  }
}

let sharedBridge: WebView2Bridge | null = null
function getBridge(): WebView2Bridge | null {
  const port = bridge()
  if (!port) return null
  if (!sharedBridge) sharedBridge = new WebView2Bridge(port)
  return sharedBridge
}

function localData(): NativeLocalData {
  const data = bridge()?.hostObjects?.sync?.localData
  if (!data) throw new Error('本地保存服务尚未就绪，请重启软件后重试。')
  return data
}

const lyricsPending = new Map<string, Promise<LyricsLookupResult>>()
function lookupLyrics(native: WebView2Bridge, request: LyricsRequest): Promise<LyricsLookupResult> {
  if (request.provider === 'bilibili') return native.call<LyricsLookupResult>('music.lyrics', [request])
  const key = JSON.stringify([request.song.bvid, request.song.title, request.song.duration, request.query ?? ''])
  const pending = lyricsPending.get(key)
  if (pending) return pending
  const operation = (async (): Promise<LyricsLookupResult> => {
    const queries = [...new Set(buildLyricsQueries(request).map(query => query.trim()))]
      .filter(query => query.length > 0 && query.length <= 200).slice(0, 3)
    const deadline = Date.now() + 20_000
    const tracks = new Map<number, LyricsTrack>()
    let lastQuery = ''
    for (const query of queries) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('歌词查询超时，请检查网络后重试。')
      lastQuery = query
      let timer: ReturnType<typeof setTimeout> | undefined
      const candidates = await Promise.race([
        native.call<LyricsTrack[]>('music.lyricsCandidates', [query]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('歌词查询超时，请检查网络后重试。')), remaining) }),
      ]).finally(() => clearTimeout(timer))
      for (const track of candidates) tracks.set(track.id, track)
      const match = selectLyricsMatch(request, [...tracks.values()])
      if (match) return { provider: 'lrclib', query, match }
    }
    return { provider: 'lrclib', query: lastQuery, match: null }
  })().finally(() => { if (lyricsPending.get(key) === operation) lyricsPending.delete(key) })
  lyricsPending.set(key, operation)
  return operation
}

export function isWebView2Available(): boolean { return getBridge() !== null }

export function createWebView2API(): MusicAPI | null {
  const native = getBridge()
  if (!native) return null
  const on = <T>(name: string, callback: (value: T) => void) => native.on(name, value => callback(value as T))
  return {
    getUpdateState: () => native.call<UpdateState>('update.getState'),
    checkForUpdates: () => native.call<UpdateState>('update.check'),
    downloadUpdate: () => native.call<UpdateState>('update.download'),
    installUpdate: () => native.call<UpdateState>('update.install'),
    openUpdateRelease: () => native.call<void>('update.openRelease'),
    onUpdateState: callback => on('update.state', callback),
    search: (query, page, mode) => native.call<SearchResult>('music.search', [query, page, mode]),
    searchSuggestions: query => native.call<string[]>('music.suggestions', [query]),
    play: song => native.call<PlaybackStatus>('music.play', [song]),
    pause: () => native.call<PlaybackStatus>('music.pause'),
    resume: () => native.call<PlaybackStatus>('music.resume'),
    seek: seconds => native.call<PlaybackStatus>('music.seek', [seconds]),
    setVolume: volume => native.call<PlaybackStatus>('music.volume', [volume]),
    getStatus: () => native.call<PlaybackStatus>('music.status'),
    getLyrics: request => lookupLyrics(native, request),
    getDesktopLyricsSnapshot: () => native.call<DesktopLyricsSnapshot>('desktopLyrics.get'),
    updateDesktopLyricsSettings: patch => native.call<DesktopLyricsSnapshot>('desktopLyrics.settings', [patch]),
    publishDesktopLyrics: content => native.call<void>('desktopLyrics.publish', [content]),
    onDesktopLyricsSnapshot: callback => on('desktopLyrics.snapshot', callback),
    login: () => native.call<void>('account.login'),
    getBilibiliAccount: () => native.call<BilibiliAccountStatus>('account.status'),
    continueAsGuest: () => native.call<BilibiliAccountStatus>('account.guest'),
    openBilibiliProfile: () => native.call<void>('account.profile'),
    onBilibiliSessionChanged: callback => native.on('account.changed', () => callback()),
    getBilibiliFavoriteFolders: () => native.call<BilibiliFavoriteFoldersResult>('favorites.folders'),
    getBilibiliFavoriteItems: (mediaId, page) => native.call<BilibiliFavoriteItemsResult>('favorites.items', [mediaId, page]),
    getBilibiliFavoriteSongs: mediaId => native.call<BilibiliFavoriteSongsResult>('favorites.songs', [mediaId]),
    openSource: () => native.call<void>('music.source'),
    minimize: () => native.fire('window.minimize'),
    maximize: () => native.fire('window.maximize'),
    close: () => native.fire('window.close'),
    onStatus: callback => on('music.status', callback),
    onEnded: callback => native.on('music.ended', () => callback()),
    readLibrary: () => localData().ReadLibrary(),
    writeLibrary: data => localData().WriteLibrary(data),
    readLocalPreference: key => localData().ReadPreference(key),
    writeLocalPreference: (key, value) => localData().WritePreference(key, value),
    onPreferenceError: callback => on('preferences.error', callback),
    exportLibrary: data => native.call<boolean>('library.export', [data]),
    importLibrary: () => native.call<string | null>('library.import'),
  }
}

export function createWebView2DesktopLyricsAPI(): DesktopLyricsAPI | null {
  const native = getBridge()
  if (!native) return null
  return {
    getSnapshot: () => native.call<DesktopLyricsSnapshot>('desktopLyrics.window.get'),
    updateSettings: patch => native.call<DesktopLyricsSnapshot>('desktopLyrics.window.settings', [patch]),
    onSnapshot: callback => native.on('desktopLyrics.window.snapshot', value => callback(value as DesktopLyricsSnapshot)),
    onPointerPresence: callback => native.on('desktopLyrics.window.pointer', value => callback(value === true)),
    setDragRegions: (regions: DesktopLyricsDragRegions) => native.fire('desktopLyrics.window.dragRegions', [regions]),
    close: () => native.call<DesktopLyricsSnapshot>('desktopLyrics.window.close'),
  }
}

export type { DesktopLyricsContent, DesktopLyricsSettings, Song }
