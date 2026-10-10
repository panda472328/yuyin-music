import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpFromLine, AudioLines, Check, ChevronDown, ChevronRight, Clock3, Disc3, ExternalLink, Headphones, Heart, ListMusic, LoaderCircle, MoreHorizontal, Music2, Pause, Play, Plus, Repeat, Repeat1, Search, Settings2, Shuffle, SkipBack, SkipForward, Sparkles, Trash2, Volume1, Volume2, VolumeX, X } from 'lucide-react'
import type { PlaybackStatus, SearchResult, Song } from '../electron/types'
import type { SearchMode } from './shared/search-mode'
import { api, isDesktop } from './api'
import { addToPlaylist, createPlaylist, deletePlaylist, getNextIndex, importBilibiliPlaylist, initializeLibrary, loadLibrary, recordHistory, removeFromPlaylist, renamePlaylist, saveLibrary, toggleFavorite, type LibraryState } from './library'
import recommendations from './data/recommendations.json'
import LyricsView from './LyricsView'
import { useLyrics } from './useLyrics'
import { activeLyricIndex } from './lyrics'
import { useDesktopLyrics } from './useDesktopLyrics'
import DesktopLyricsSettings from './DesktopLyricsSettings'
import BilibiliFavoritesDialog, { type FavoritePlaylistImport } from './BilibiliFavoritesDialog'
import { Monitor } from 'lucide-react'
import { loadUISettings, saveUISettings, type UISettings } from './ui-settings'
import { useBilibiliAccount } from './useBilibiliAccount'
import { BilibiliAccountMenu, BilibiliLoginGate } from './BilibiliAccount'
import { UpdateProvider, UpdateSettings, useUpdates } from './Updates'
import packageInfo from '../package.json'

type Page = 'discover' | 'library' | 'favorites' | 'history' | 'search' | 'lyrics' | 'settings' | `playlist:${string}`
type Modal = { type: 'create' } | { type: 'bilibili' } | { type: 'rename', id: string, name: string } | { type: 'add', song: Song } | { type: 'delete', id: string, name: string } | null
const picks = recommendations as Song[]
const initialStatus: PlaybackStatus = { state: 'idle', song: null, currentTime: 0, duration: 0, volume: .7, error: null }
const formatTime = (seconds: number) => { const safe = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}` }
const formatCount = (count: number) => count >= 100_000_000 ? `${(count / 100_000_000).toFixed(1)}亿` : count >= 10_000 ? `${(count / 10_000).toFixed(1)}万` : String(count)
const title = (song: Song) => song.title.replace(/【[^】]*】/g, '').trim()
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')

function Cover({ song, className = '' }: { song?: Song | null, className?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [song?.cover])
  return <div className={`cover ${className}`}>
    {song?.cover && !failed ? <img src={song.cover} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Disc3 size={32} strokeWidth={1.2} />}
  </div>
}

function IconButton({ children, label, onClick, active = false, disabled = false, className = '' }: { children: ReactNode, label: string, onClick?: () => void, active?: boolean, disabled?: boolean, className?: string }) {
  return <button type="button" title={label} aria-label={label} className={`icon-button ${active ? 'active' : ''} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>
}

export default function App() {
  return <UpdateProvider>{isDesktop ? <DesktopAccountApp /> : <MusicApp />}</UpdateProvider>
}

function DesktopAccountApp() {
  const session = useBilibiliAccount()
  return session.phase === 'guest' || session.phase === 'loggedIn' && session.account
    ? <MusicApp accountSession={session} />
    : <BilibiliLoginGate session={session} />
}

function MusicApp({ accountSession }: { accountSession?: ReturnType<typeof useBilibiliAccount> }) {
  const { setBannerBlocked } = useUpdates()
  const [initialLibrary] = useState(() => initializeLibrary())
  const [library, setLibrary] = useState<LibraryState>(initialLibrary.state)
  const [initialUI] = useState(() => loadUISettings(initialLibrary.state.settings.volume))
  const [uiSettings, setUISettings] = useState(initialUI.settings)
  const uiSettingsRef = useRef(uiSettings)
  uiSettingsRef.current = uiSettings
  const [page, setPage] = useState<Page>('discover')
  const [previousPage, setPreviousPage] = useState<Page>('discover')
  const [searchInput, setSearchInput] = useState('')
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchMode = library.settings.searchMode
  const [status, setStatus] = useState(initialStatus)
  const lyrics = useLyrics(status.song)
  const desktopLyrics = useDesktopLyrics(status, lyrics)
  const [queueOpen, setQueueOpen] = useState(false)
  const [modal, setModal] = useState<Modal>(null)
  useEffect(() => { setBannerBlocked(Boolean(modal)); return () => setBannerBlocked(false) }, [modal, setBannerBlocked])
  const [modalName, setModalName] = useState('')
  const [toast, setToast] = useState([initialLibrary.error, initialUI.error].filter(Boolean).join(' '))
  const [menuSong, setMenuSong] = useState<string | null>(null)
  const sleepUntil = uiSettings.sleepUntil
  const searchRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef(library)
  const statusRef = useRef(status)
  const searchSequence = useRef(0)
  // Keep the text and mode that started a request available synchronously. A
  // mode click can happen before React has committed the last input event.
  const searchInputRef = useRef(searchInput)
  const searchModeRef = useRef<SearchMode>(searchMode)
  const searchResultRef = useRef<SearchResult | null>(searchResult)
  const searchQueryRef = useRef(searchQuery)
  const recordedSong = useRef<string | null>(null)
  const playRef = useRef<(song: Song) => Promise<void>>(async () => {})
  const nextRef = useRef<(direction?: number) => void>(() => {})
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const [libraryFilter, setLibraryFilter] = useState('')
  const removedQueuePosition = useRef<number | null>(null)
  const mounted = useRef(true)
  libraryRef.current = library; statusRef.current = status
  searchInputRef.current = searchInput; searchModeRef.current = searchMode
  searchResultRef.current = searchResult; searchQueryRef.current = searchQuery

  const notify = (message: string) => setToast(message)
  const navigate = (target: Page) => { setPreviousPage(page); setPage(target); setLibraryFilter(''); setMenuSong(null) }
  const favorite = (song: Song) => library.favorites.some(item => item.bvid === song.bvid)
  const changeSearchInput = (value: string) => { searchInputRef.current = value; setSearchInput(value) }
  const replaceSearchResult = (value: SearchResult | null) => { searchResultRef.current = value; setSearchResult(value) }
  const replaceSearchQuery = (value: string) => { searchQueryRef.current = value; setSearchQuery(value) }
  const changeUISettings = (patch: Partial<Omit<UISettings, 'version'>>) => {
    if (initialUI.error) { notify(`${initialUI.error} 请解决后重新打开播放器。`); return false }
    const updated = { ...uiSettingsRef.current, ...patch }
    const result = saveUISettings(updated)
    if (!result.ok) { notify(result.error); return false }
    uiSettingsRef.current = updated
    setUISettings(updated)
    return true
  }
  const setSleepUntil = (value: number | null) => changeUISettings({ sleepUntil: value })
  const changeLibrary = (change: (state: LibraryState) => LibraryState) => {
    if (initialLibrary.error) { notify(`${initialLibrary.error} 请解决后重新打开播放器。`); return false }
    const updated = change(libraryRef.current)
    if (updated === libraryRef.current) return true
    // Finish saving before updating the UI, including a favorite click just before exit.
    const result = saveLibrary(updated)
    if (!result.ok) { notify(result.error); return false }
    libraryRef.current = updated
    setLibrary(updated)
    return true
  }

  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timeout) }, [toast])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; searchSequence.current++ }
  }, [])
  useEffect(() => { if (accountSession?.error) setToast(`账号状态检查未完成：${accountSession.error}`) }, [accountSession?.error])
  useEffect(() => { if (desktopLyrics.error) setToast(desktopLyrics.error) }, [desktopLyrics.error])
  useEffect(() => api.onPreferenceError(message => setToast(message)), [])
  useEffect(() => setScrubbing(null), [status.song?.bvid])
  useEffect(() => {
    const disposeStatus = api.onStatus(next => {
      setStatus(next)
      if (next.state === 'loading') recordedSong.current = null
      if (next.state === 'playing' && next.song && recordedSong.current !== next.song.bvid) {
        if (changeLibrary(current => recordHistory(current, next.song!))) recordedSong.current = next.song.bvid
      }
    })
    const disposeEnded = api.onEnded(() => nextRef.current(1))
    void api.getStatus().then(setStatus).catch(() => {})
    void api.setVolume(libraryRef.current.settings.volume).catch(() => {})
    return () => { disposeStatus(); disposeEnded() }
  }, [])

  async function play(song: Song) {
    if (!mounted.current) return
    if (statusRef.current.state === 'loading' && statusRef.current.song?.bvid === song.bvid) return
    removedQueuePosition.current = null
    setMenuSong(null); recordedSong.current = null
    try { await api.play(song) } catch (error) { const message = errorText(error); if (!message.includes('已切换') && !message.includes('播放请求已取消')) notify(message) }
  }
  playRef.current = play
  function playCollection(songs: Song[], first?: Song) {
    if (!songs.length) return
    removedQueuePosition.current = null
    if (!changeLibrary(current => ({ ...current, queue: songs }))) return
    void play(first ?? songs[0])
  }
  function next(direction = 1, manual = false) {
    const current = libraryRef.current; const queue = current.queue
    const index = queue.findIndex(song => song.bvid === statusRef.current.song?.bvid)
    if (index === -1 && removedQueuePosition.current !== null && queue.length) {
      const rememberedIndex = direction > 0 ? removedQueuePosition.current : removedQueuePosition.current - 1
      removedQueuePosition.current = null
      void playRef.current(queue[(rememberedIndex + queue.length) % queue.length]); return
    }
    const mode = manual && current.settings.playMode === 'repeat' ? 'sequence' : current.settings.playMode
    const nextIndex = getNextIndex(queue, index, mode, direction)
    if (nextIndex >= 0) void playRef.current(queue[nextIndex])
  }
  nextRef.current = direction => next(direction)
  function removeFromQueue(song: Song) {
    const queue = libraryRef.current.queue; const index = queue.findIndex(item => item.bvid === song.bvid)
    if (statusRef.current.song?.bvid === song.bvid) removedQueuePosition.current = index
    else if (removedQueuePosition.current !== null && index < removedQueuePosition.current) removedQueuePosition.current = Math.max(0, removedQueuePosition.current - 1)
    changeLibrary(current => ({ ...current, queue: current.queue.filter(item => item.bvid !== song.bvid) }))
  }
  async function togglePlayback() {
    try {
      if (statusRef.current.state === 'playing') await api.pause()
      else if (statusRef.current.state === 'paused') await api.resume()
      else if (statusRef.current.song) await playRef.current(statusRef.current.song)
      else if (libraryRef.current.queue.length) await playRef.current(libraryRef.current.queue[0])
      else notify('先选一首喜欢的歌吧')
    } catch (error) { notify(errorText(error)) }
  }
  function changeSearchMode(mode: SearchMode) {
    if (mode === searchModeRef.current) return
    if (!changeLibrary(current => ({ ...current, settings: { ...current.settings, searchMode: mode } }))) return
    // changeLibrary persists before painting. Update the request guard now so an
    // old response cannot repaint the previous mode in that short interval.
    searchModeRef.current = mode
    searchSequence.current++
    replaceSearchResult(null); setSearchLoading(false); setSearchError('')
    const query = searchInputRef.current
    if (query.trim()) void search(query, 1, mode)
    else replaceSearchQuery('')
  }
  async function search(query: string, nextPage = 1, mode = searchModeRef.current) {
    const trimmed = query.trim(); if (!trimmed) { searchRef.current?.focus(); return }
    if (nextPage > 1 && (searchResultRef.current?.mode !== mode || searchQueryRef.current !== trimmed)) return
    const sequence = ++searchSequence.current
    if (nextPage === 1) { navigate('search'); replaceSearchQuery(trimmed); replaceSearchResult(null) }
    setSearchLoading(true); setSearchError('')
    try {
      const response = await api.search(trimmed, nextPage, mode)
      const result = { ...response, mode, songs: response.songs.map(song => ({ ...song, searchQuery: trimmed })) }
      if (sequence !== searchSequence.current || mode !== searchModeRef.current) return
      const current = searchResultRef.current
      const next = nextPage === 1 ? result : current?.mode === mode && searchQueryRef.current === trimmed
        ? { ...result, songs: [...current.songs, ...result.songs].filter((song, index, all) => all.findIndex(item => item.bvid === song.bvid) === index) }
        : current
      replaceSearchResult(next)
    } catch (error) { if (sequence === searchSequence.current && mode === searchModeRef.current) setSearchError(errorText(error)) }
    finally { if (sequence === searchSequence.current && mode === searchModeRef.current) setSearchLoading(false) }
  }
  function cycleMode() {
    const modes = ['sequence', 'shuffle', 'repeat'] as const
    const nextMode = modes[(modes.indexOf(library.settings.playMode) + 1) % modes.length]
    if (!changeLibrary(current => ({ ...current, settings: { ...current.settings, playMode: nextMode } }))) return
    notify({ sequence: '列表循环', shuffle: '随机播放', repeat: '单曲循环' }[nextMode])
  }
  async function setVolume(value: number) {
    if (value > 0 && value !== uiSettingsRef.current.volumeBeforeMute && !changeUISettings({ volumeBeforeMute: value })) return
    if (!changeLibrary(current => ({ ...current, settings: { ...current.settings, volume: value } }))) return
    try { await api.setVolume(value) } catch (error) { notify(errorText(error)) }
  }
  function mute() {
    if (library.settings.volume > 0 && !changeUISettings({ volumeBeforeMute: library.settings.volume })) return
    void setVolume(library.settings.volume > 0 ? 0 : uiSettingsRef.current.volumeBeforeMute)
  }

  useEffect(() => {
    if (!modal) return
    const previousFocus = document.activeElement as HTMLElement | null
    const backgrounds = [...document.querySelectorAll<HTMLElement>('.sidebar, .main-shell, .player-bar, .queue-panel')]
    backgrounds.forEach(element => { element.inert = true })
    const dialog = document.querySelector<HTMLElement>('.modal')
    if (!dialog?.contains(document.activeElement)) dialog?.querySelector<HTMLElement>('input, button')?.focus()
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')]
      const first = controls[0]; const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', trapFocus)
    return () => { backgrounds.forEach(element => { element.inert = false }); window.removeEventListener('keydown', trapFocus); previousFocus?.focus() }
  }, [modal])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); return }
      if (event.key === 'Escape') { setModal(null); setQueueOpen(false); setMenuSong(null) }
      const target = event.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable || modal || target.tagName === 'BUTTON') return
      if (event.code === 'Space') { event.preventDefault(); void togglePlayback() }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); next(1, true) }
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); next(-1, true) }
    }
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener)
  }, [modal])
  useEffect(() => {
    if (!sleepUntil) return
    const timer = setTimeout(() => { void api.pause().catch(() => {}); if (setSleepUntil(null)) notify('定时已到，晚安。') }, Math.max(0, sleepUntil - Date.now()))
    return () => clearTimeout(timer)
  }, [sleepUntil])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (status.song) navigator.mediaSession.metadata = new MediaMetadata({ title: title(status.song), artist: status.song.artist, album: '余音 · Bilibili', artwork: status.song.cover ? [{ src: status.song.cover }] : [] })
    navigator.mediaSession.playbackState = status.state === 'playing' ? 'playing' : 'paused'
    navigator.mediaSession.setActionHandler('play', () => { void api.resume().catch(() => {}) })
    navigator.mediaSession.setActionHandler('pause', () => { void api.pause().catch(() => {}) })
    navigator.mediaSession.setActionHandler('previoustrack', () => next(-1, true))
    navigator.mediaSession.setActionHandler('nexttrack', () => next(1, true))
  }, [status.song?.bvid, status.state])

  function openModal(nextModal: Modal) {
    if (nextModal?.type === 'bilibili' && accountSession && !accountSession.account) {
      notify('请先登录 Bilibili，再导入账号收藏夹。')
      void accountSession.openLogin()
      return
    }
    setModal(nextModal); setModalName(nextModal?.type === 'rename' ? nextModal.name : ''); setMenuSong(null)
  }
  function submitName(event: FormEvent) {
    event.preventDefault(); if (!modalName.trim()) return
    if (modal?.type === 'create') { if (!changeLibrary(current => createPlaylist(current, modalName))) return; notify('歌单已创建') }
    if (modal?.type === 'rename') { if (!changeLibrary(current => renamePlaylist(current, modal.id, modalName))) return; notify('歌单已重命名') }
    setModal(null)
  }
  function importFavoritePlaylist(input: FavoritePlaylistImport) {
    if (initialLibrary.error) throw new Error(`${initialLibrary.error} 请解决后重新打开播放器。`)
    const result = importBilibiliPlaylist(libraryRef.current, input)
    const saved = saveLibrary(result.state)
    if (!saved.ok) throw new Error(saved.error)
    setLibrary(result.state)
    libraryRef.current = result.state
    setModal(null)
    navigate(`playlist:${result.playlistId}`)
    notify(`已导入「${input.name}」：${result.count} 首${input.skippedCount ? `，跳过 ${input.skippedCount} 个失效、重复或非视频内容` : ''}`)
  }
  async function importBackup() {
    try {
      const data = await api.importLibrary(); if (!data) return
      const parsed = JSON.parse(data)
      if (parsed.version !== 1 || !Array.isArray(parsed.favorites) || !Array.isArray(parsed.playlists) || !Array.isArray(parsed.history) || !Array.isArray(parsed.queue)) throw new Error('这不是有效的余音音乐库备份。')
      const imported = loadLibrary({ getItem: () => data, setItem: () => {} })
      // Merge collections so restoring a backup cannot erase songs added since it was exported.
      const saved = changeLibrary(current => ({ ...current,
        favorites: [...new Map([...current.favorites, ...imported.favorites].map(song => [song.bvid, song])).values()],
        playlists: [...new Map([...current.playlists, ...imported.playlists].map(playlist => [playlist.id, { ...playlist, songs: [...new Map([...(current.playlists.find(item => item.id === playlist.id)?.songs ?? []), ...playlist.songs].map(song => [song.bvid, song])).values()] }])).values()],
        history: [...current.history, ...imported.history].sort((a, b) => b.playedAt - a.playedAt).filter((entry, index, all) => all.findIndex(item => item.song.bvid === entry.song.bvid) === index).slice(0, 100)
      }))
      if (!saved) return
      notify('音乐库已导入，已有收藏和歌单已保留')
    } catch (error) { notify(errorText(error)) }
  }

  const selectedPlaylist = page.startsWith('playlist:') ? library.playlists.find(item => `playlist:${item.id}` === page) : null
  const allLibrarySongs = [...new Map([...library.favorites, ...library.playlists.flatMap(item => item.songs)].map(song => [song.bvid, song])).values()]
  let visibleSongs: Song[] = page === 'favorites' ? library.favorites : page === 'history' ? library.history.map(entry => entry.song) : page === 'search' ? searchResult?.songs ?? [] : selectedPlaylist ? selectedPlaylist.songs : allLibrarySongs
  if (libraryFilter) visibleSongs = visibleSongs.filter(song => `${song.title} ${song.artist}`.toLowerCase().includes(libraryFilter.toLowerCase()))
  const currentSong = status.song
  const currentLyric = lyrics.lines[activeLyricIndex(lyrics.lines, status.currentTime, lyrics.offsetSeconds)]?.text
  const duration = status.duration || currentSong?.duration || 0
  const navItems = [{ id: 'discover', label: '发现音乐', icon: Disc3 }, { id: 'library', label: '我的音乐库', icon: ListMusic }, { id: 'favorites', label: '我喜欢的', icon: Heart }, { id: 'history', label: '最近播放', icon: Clock3 }, { id: 'lyrics', label: '正在听 · 歌词', icon: AudioLines }] as const

  function songActions(song: Song, removable = false) {
    return <div className="song-actions">
      <IconButton label={favorite(song) ? '取消收藏' : '收藏歌曲'} active={favorite(song)} onClick={() => changeLibrary(current => toggleFavorite(current, song))}><Heart size={17} fill={favorite(song) ? 'currentColor' : 'none'} /></IconButton>
      <div className="song-menu-anchor"><IconButton label="歌曲操作" onClick={() => setMenuSong(menuSong === song.bvid ? null : song.bvid)}><MoreHorizontal size={19} /></IconButton>
        {menuSong === song.bvid && <div className="dropdown-menu">
          <button onClick={() => openModal({ type: 'add', song })}><Plus size={15} />添加到歌单</button>
          <button onClick={() => { if (!changeLibrary(current => ({ ...current, queue: [...current.queue.filter(item => item.bvid !== song.bvid), song] }))) return; setMenuSong(null); notify('已加入播放队列') }}><ListMusic size={15} />加入播放队列</button>
          {removable && selectedPlaylist && <button className="danger" onClick={() => { changeLibrary(current => removeFromPlaylist(current, selectedPlaylist.id, song.bvid)); setMenuSong(null) }}><Trash2 size={15} />从歌单移除</button>}
        </div>}
      </div>
    </div>
  }
  function songTable(songs: Song[]) {
    return <div className="song-table" role="table" aria-label="歌曲列表">
      <div className="song-table-header" role="row"><span>#</span><span>歌曲 / 视频</span><span>UP 主</span><span>{page === 'history' ? '播放时间' : '播放量'}</span><span>时长</span><span /></div>
      {songs.map((song, index) => <div key={song.bvid} className={`song-row ${status.song?.bvid === song.bvid ? 'current' : ''}`} role="row" onDoubleClick={() => playCollection(songs, song)}>
        <button className="row-index" aria-label={`播放 ${title(song)}`} onClick={() => playCollection(songs, song)} onDoubleClick={event => event.stopPropagation()}>{status.song?.bvid === song.bvid && status.state === 'playing' ? <AudioLines size={16} /> : <><span>{String(index + 1).padStart(2, '0')}</span><Play className="row-play" size={14} fill="currentColor" /></>}</button>
        <button className="song-identity" onClick={() => playCollection(songs, song)} onDoubleClick={event => event.stopPropagation()}><Cover song={song} /><span><strong title={song.title}>{title(song)}</strong><small><span className="bili-chip">bilibili</span>{page === 'search' && index === 0 && <span className="highest">首条结果</span>}</small></span></button>
        <span className="song-artist" title={song.artist}>{song.artist}</span>
        <span className="song-meta">{page === 'history' ? new Date(library.history.find(entry => entry.song.bvid === song.bvid)?.playedAt ?? 0).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : formatCount(song.playCount)}</span>
        <span className="song-duration">{formatTime(song.duration)}</span>{songActions(song, Boolean(selectedPlaylist))}
      </div>)}
    </div>
  }
  function emptyState(heading: string, description: string) {
    return <div className="empty-state"><div className="empty-icon"><Music2 size={29} strokeWidth={1.2} /></div><h3>{heading}</h3><p>{description}</p><button className="button-primary" onClick={() => { navigate('discover'); searchRef.current?.focus() }}><Search size={16} />去发现音乐</button></div>
  }

  return <div className={`app-shell ${queueOpen ? 'queue-visible' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><AudioLines size={26} strokeWidth={2.3} /></span><span>余音<small>YUYIN MUSIC</small></span></div>
      <div className="sidebar-label">听见喜欢</div>
      <nav>{navItems.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.label}</span>{item.id === 'favorites' && library.favorites.length > 0 && <small>{library.favorites.length}</small>}{page === item.id && <i />}</button>)}</nav>
      <div className="playlist-heading"><span className="sidebar-label">我的歌单</span><IconButton label="新建歌单" onClick={() => openModal({ type: 'create' })}><Plus size={17} /></IconButton></div>
      <div className="sidebar-playlists">{library.playlists.map((playlist, index) => <button key={playlist.id} className={`sidebar-playlist ${page === `playlist:${playlist.id}` ? 'selected' : ''}`} onClick={() => navigate(`playlist:${playlist.id}`)}><span className={`playlist-symbol tone-${index % 3}`}>{index % 2 ? <Headphones size={16} /> : <Music2 size={16} />}</span><span>{playlist.name}<small>{playlist.songs.length} 首歌曲</small></span></button>)}{library.playlists.length === 0 && <button className="subtle-text" onClick={() => openModal({ type: 'create' })}>+ 建立第一份歌单</button>}</div>
      <div className="sidebar-footer"><div className="source-status"><span /><span>声音来自 Bilibili<small>你的音乐，自己的空间</small></span></div><button className={`nav-item ${page === 'settings' ? 'selected' : ''}`} onClick={() => navigate('settings')}><Settings2 size={18} />设置与音乐库备份</button></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="navigation-arrows"><IconButton label="返回" onClick={() => { const old = page; setPage(previousPage); setPreviousPage(old) }}><ArrowLeft size={19} /></IconButton><IconButton label="发现音乐" onClick={() => navigate('discover')}><ArrowRight size={19} /></IconButton></div>
        <form className="search-box" onSubmit={event => { event.preventDefault(); void search(searchInputRef.current) }}><div className="search-mode" role="group" aria-label="搜索模式"><button type="button" aria-pressed={searchMode === 'song'} onClick={() => changeSearchMode('song')}>歌名搜索</button><button type="button" aria-pressed={searchMode === 'video'} onClick={() => changeSearchMode('video')}>视频搜索</button></div><Search size={16} /><input ref={searchRef} aria-label={searchMode === 'song' ? '搜索完整歌名' : '搜索 Bilibili 视频'} maxLength={80} placeholder={searchMode === 'song' ? '输入完整歌名' : '搜索视频、歌手'} value={searchInput} onChange={event => changeSearchInput(event.target.value)} /><kbd>Ctrl K</kbd>{searchInput && <button type="button" aria-label="清空搜索" onClick={() => changeSearchInput('')}><X size={14} /></button>}</form>
        <div className="topbar-right"><span className="local-badge"><span />本地音乐空间</span>{accountSession?.account ? <BilibiliAccountMenu account={accountSession.account} checking={accountSession.checking} error={accountSession.error} openingLogin={accountSession.openingLogin} onRefresh={accountSession.refresh} onLogin={accountSession.openLogin} onFavorites={() => openModal({ type: 'bilibili' })} onSettings={() => navigate('settings')} onError={notify} /> : accountSession ? <button className="button-secondary guest-login" type="button" aria-label="登录 Bilibili" onClick={() => void accountSession.openLogin()} disabled={accountSession.openingLogin}>{accountSession.openingLogin ? <LoaderCircle size={15} className="spin" /> : <ExternalLink size={15} />}{accountSession.openingLogin ? '正在打开登录' : accountSession.watchingLogin ? '继续 Bilibili 登录' : '登录 Bilibili'}</button> : <button className="profile" title="设置" onClick={() => navigate('settings')}>余</button>}</div>
      </header>

      <main className="main-content" onClick={event => { if (!(event.target as Element).closest('.song-menu-anchor')) setMenuSong(null) }}>
        {page === 'lyrics' && <LyricsView status={status} lyrics={lyrics} onSeek={seconds => void api.seek(seconds).catch(error => notify(errorText(error)))} />}
        {page === 'discover' && <>
          <div className="page-heading"><div><div className="eyebrow">YOUR EVERYDAY SOUNDTRACK</div><h1>发现音乐<span className="heading-dot">.</span></h1><p>让熟悉的旋律，遇见今天的心情。</p></div><span className="date-label"><Sparkles size={15} />给生活一点好声音</span></div>
          <section className="hero"><div className="hero-content"><span className="hero-kicker"><span />A LITTLE MUSIC, A BETTER DAY</span><h2>把日子，听成<br />喜欢的样子。</h2><p>一首歌，一点留白。<br />在这里，找到属于你的声音。</p><button className="button-primary" onClick={() => playCollection(picks)}><Play size={15} fill="currentColor" />开始听歌<ArrowRight size={16} /></button><span className="hero-footnote">精选声音 · 随时收藏 · 自由聆听</span></div><div className="hero-art" aria-hidden="true"><div className="hero-ring ring-one" /><div className="hero-ring ring-two" /><span className="art-sparkle">✳</span><div className="record"><div className="record-grooves" /><div className="record-label"><AudioLines size={26} /><span>GOOD<br />VIBES ONLY</span></div></div><div className="art-cover"><Cover song={picks[0]} /><div><span>ON REPEAT</span><strong>留一首歌的时间</strong><AudioLines size={18} /></div></div><span className="floating-note note-one">♪</span><span className="floating-note note-two">♫</span><div className="art-caption">SLOW DOWN & LISTEN.</div></div></section>
          <section className="picks-section"><div className="section-heading"><div><h2>今日拾音 <span>FOR YOU</span></h2><p>从熟悉的歌开始，给耳朵放个小假。</p></div><button className="text-button" onClick={() => playCollection(picks)}>播放全部<Play size={13} /></button></div><div className="song-cards">{picks.slice(0, 5).map((song, index) => <article className={`song-card card-${index}`} key={song.bvid}><div className="card-image" onDoubleClick={() => playCollection(picks, song)}><Cover song={song} /><span className="card-source">BILIBILI</span><IconButton className="card-favorite" label={favorite(song) ? '取消收藏' : '收藏歌曲'} active={favorite(song)} onClick={() => changeLibrary(current => toggleFavorite(current, song))}><Heart size={16} fill={favorite(song) ? 'currentColor' : 'none'} /></IconButton><button className="card-play" aria-label={`播放 ${title(song)}`} onClick={() => playCollection(picks, song)}><Play size={19} fill="currentColor" /></button><span className="card-listens"><Headphones size={12} />{formatCount(song.playCount)}</span></div><button className="card-title" onClick={() => playCollection(picks, song)} title={song.title}>{title(song)}</button><p>{song.artist}</p></article>)}</div></section>
          <section className="my-playlists-section"><div className="section-heading"><div><h2>把喜欢，收进歌单 <span>YOUR COLLECTION</span></h2></div><button className="text-button" onClick={() => openModal({ type: 'create' })}><Plus size={15} />新建歌单</button></div><div className="playlist-cards">{library.playlists.slice(0, 3).map((playlist, index) => <button key={playlist.id} className="playlist-card" onClick={() => navigate(`playlist:${playlist.id}`)}><span className={`playlist-art tone-${index % 3}`}>{playlist.songs.length ? <Cover song={playlist.songs[0]} /> : index % 2 ? <Headphones size={28} strokeWidth={1.4} /> : <Music2 size={28} strokeWidth={1.4} />}</span><span><strong>{playlist.name}</strong><small>{playlist.songs.length} 首歌曲 · 私人歌单</small></span><ChevronRight size={18} /></button>)}<button className="playlist-card create-card" onClick={() => openModal({ type: 'create' })}><span className="playlist-art"><Plus size={24} strokeWidth={1.3} /></span><span><strong>新的声音故事</strong><small>创建一份属于你的歌单</small></span></button></div></section>
          <div className="page-bottom">音乐响起，世界安静了一点。<AudioLines size={14} /></div>
        </>}

        {page === 'search' && <><div className="page-heading"><div><div className="eyebrow">FIND YOUR SOUND</div><h1>搜索结果<span className="heading-dot">.</span></h1><p>“{searchQuery}” <span className="inline-divider">/</span> {searchResult ? searchMode === 'song' ? `已找到 ${searchResult.songs.length.toLocaleString()} 个标题匹配视频` : `${searchResult.total.toLocaleString()} 个 Bilibili 视频` : searchMode === 'song' ? '按完整歌名匹配标题' : '在 Bilibili 寻找声音'}</p></div><span className="sort-badge"><ChevronDown size={14} />{searchMode === 'song' ? '歌名匹配 · 综合排序' : 'Bilibili 综合排序'}</span></div><div className="search-notice"><span className="notice-icon"><AudioLines size={18} /></span><span>点击一首歌曲开始播放<small>{searchMode === 'song' ? '标题匹配完整歌名的视频，MV、翻唱或合辑都可能出现在结果中。' : '音源来自原视频，MV、翻唱或合辑都可能出现在结果中。'}</small></span><button onClick={() => navigate('settings')}>偏好设置<ChevronRight size={14} /></button></div>
          {searchError && <div className="error-state"><h3>这次没能连接到 Bilibili</h3><p>{searchError}</p><div><button className="button-primary" onClick={() => { void (accountSession ? accountSession.openLogin() : api.login().catch(error => notify(errorText(error)))) }}><ExternalLink size={15} />打开 Bilibili 登录 / 验证</button><button className="button-secondary" onClick={() => void search(searchQuery)}>重新搜索</button></div></div>}
          {searchLoading && !searchResult ? <div className="loading-state"><LoaderCircle size={26} className="spin" /><h3>{searchMode === 'song' ? '正在寻找这首歌' : '正在搜索视频'}</h3><p>{searchMode === 'song' ? '正在按完整歌名匹配视频标题。' : '正在按 Bilibili 综合排序获取结果。'}</p></div> : visibleSongs.length ? songTable(visibleSongs) : !searchError && emptyState(searchMode === 'song' ? '还没有找到匹配的歌名' : '还没有找到这个声音', searchMode === 'song' ? searchResult?.hasMore ? '当前页面没有标题匹配视频，可继续加载。' : '没有标题包含这个完整歌名的视频。' : '试试完整歌名，或者加上歌手的名字。')}
          {searchResult?.hasMore && <button className="load-more button-secondary" disabled={searchLoading} onClick={() => void search(searchQuery, searchResult.page + 1)}>{searchLoading ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}加载更多</button>}
        </>}

        {(['favorites', 'history', 'library'].includes(page) || selectedPlaylist) && <>
          <div className="collection-header"><div className={`collection-art ${page === 'favorites' ? 'favorites-art' : page === 'history' ? 'history-art' : ''}`}>{selectedPlaylist?.songs[0] ? <Cover song={selectedPlaylist.songs[0]} /> : page === 'favorites' ? <Heart size={50} strokeWidth={1.1} /> : page === 'history' ? <Clock3 size={50} strokeWidth={1.1} /> : <ListMusic size={50} strokeWidth={1.1} />}</div><div><div className="eyebrow">{selectedPlaylist ? 'MY PLAYLIST' : page === 'favorites' ? 'LOVED & SAVED' : page === 'history' ? 'RECENTLY PLAYED' : 'YOUR MUSIC LIBRARY'}</div><h1>{selectedPlaylist?.name ?? { favorites: '我喜欢的', history: '最近播放', library: '我的音乐库' }[page as 'favorites']}<span className="heading-dot">.</span></h1><p>{selectedPlaylist?.description || (page === 'favorites' ? '那些让你忍不住单曲循环的声音。' : page === 'history' ? '每一次听见，都留下一个小小的记忆。' : '收藏与歌单里的音乐，都在这里。')}</p><span className="collection-count">{visibleSongs.length} 首歌曲{page === 'history' ? ' · 保留最近 100 首' : ' · 保存在本机'}</span></div></div>
          <div className="collection-toolbar"><button className="button-primary" disabled={!visibleSongs.length} onClick={() => playCollection(visibleSongs)}><Play size={15} fill="currentColor" />播放全部</button>{selectedPlaylist && <><button className="button-secondary" onClick={() => openModal({ type: 'rename', id: selectedPlaylist.id, name: selectedPlaylist.name })}>重命名</button><IconButton label="删除歌单" onClick={() => openModal({ type: 'delete', id: selectedPlaylist.id, name: selectedPlaylist.name })}><Trash2 size={17} /></IconButton></>}{(page === 'library' || selectedPlaylist) && <button className="button-secondary" onClick={() => openModal({ type: 'bilibili' })}><ArrowDownToLine size={15} />导入 Bilibili 收藏夹</button>}<div className="collection-search"><Search size={15} /><input placeholder="在列表中查找" aria-label="在列表中查找" value={libraryFilter} onChange={event => setLibraryFilter(event.target.value)} /></div></div>
          {visibleSongs.length ? songTable(visibleSongs) : emptyState(page === 'history' ? '下一首，会留下记忆' : libraryFilter ? '没有匹配的歌曲' : '留个位置，给下一首喜欢', page === 'history' ? '成功开始播放的歌曲会自动记录在这里。' : '搜索喜欢的歌曲，点亮爱心或添加到歌单。')}
        </>}

        {page === 'settings' && <><div className="page-heading"><div><div className="eyebrow">MAKE YOURSELF AT HOME</div><h1>听歌偏好<span className="heading-dot">.</span></h1><p>按你的习惯，布置这个音乐空间。</p></div><span className="version">余音 v{packageInfo.version}</span></div><div className="settings-panel"><h2>播放与音源</h2><div className="setting-row"><span><strong>Bilibili 账号与验证</strong><small>在独立窗口登录。会话保存在本机，余音不会读取你的密码。</small></span><button className="button-secondary" onClick={() => void (accountSession ? accountSession.openLogin() : api.login().catch(error => notify(errorText(error))))}>打开 Bilibili<ExternalLink size={14} /></button></div><div className="setting-row"><span><strong>睡眠定时</strong><small>{sleepUntil ? `将在 ${new Date(sleepUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 暂停播放` : '给今晚的音乐留一个安静的结尾。'}</small></span><select aria-label="睡眠定时" value={sleepUntil ? 'active' : 'off'} onChange={event => { const value = event.target.value; setSleepUntil(value === 'off' ? null : Date.now() + Number(value) * 60_000) }}><option value="off">关闭</option>{sleepUntil && <option value="active">已设定</option>}<option value="15">15 分钟后</option><option value="30">30 分钟后</option><option value="60">60 分钟后</option><option value="90">90 分钟后</option></select></div></div><UpdateSettings /><DesktopLyricsSettings desktop={desktopLyrics} /><div className="settings-panel"><h2>我的音乐库</h2><div className="setting-row"><span><strong>导出音乐库备份</strong><small>保存歌单、收藏、历史和听歌偏好，不包含音频文件。</small></span><button className="button-secondary" onClick={() => void api.exportLibrary(JSON.stringify(library, null, 2)).then(saved => { if (saved) notify('音乐库已导出') }).catch(error => notify(errorText(error)))}><ArrowDownToLine size={15} />导出备份</button></div><div className="setting-row"><span><strong>恢复我的收藏</strong><small>导入余音 JSON 备份，与当前歌单和收藏合并。</small></span><button className="button-secondary" onClick={() => void importBackup()}><ArrowUpFromLine size={15} />导入备份</button></div><div className="library-stats"><span><strong>{library.favorites.length}</strong>首收藏</span><span><strong>{library.playlists.length}</strong>份歌单</span><span><strong>{library.history.length}</strong>条历史</span><span className="storage-note"><Check size={14} />{initialLibrary.error ? "音乐库读取失败，保存已暂停" : "更改后立即保存到本机"}</span></div></div><div className="settings-panel shortcut-panel"><h2>顺手的快捷键</h2><span>搜索<kbd>Ctrl K</kbd></span><span>播放 / 暂停<kbd>Space</kbd></span><span>上一首 / 下一首<kbd>Alt ← / →</kbd></span></div><div className="about-note"><AudioLines size={22} /><p>余音是一扇自己的音乐窗口。播放由后台浏览器中的 Bilibili 原视频提供，<br />音质和可用性随原视频而定；部分内容可能需要在源站登录或完成验证。</p>{!isDesktop && <small>当前为网页预览，请运行桌面客户端使用后台播放。</small>}</div></>}
      </main>
    </div>

    {queueOpen && <aside className="queue-panel"><div className="queue-heading"><div><h2>正在播放</h2><span>{library.queue.length} 首歌曲 · {({ sequence: '列表循环', shuffle: '随机播放', repeat: '单曲循环' })[library.settings.playMode]}</span></div><IconButton label="关闭播放队列" onClick={() => setQueueOpen(false)}><X size={19} /></IconButton></div>{library.queue.length ? <><div className="queue-list">{library.queue.map((song, index) => <div key={song.bvid} className={`queue-song ${currentSong?.bvid === song.bvid ? 'current' : ''}`}><span className="queue-index">{currentSong?.bvid === song.bvid ? <AudioLines size={15} /> : index + 1}</span><button onClick={() => void play(song)}><Cover song={song} /><span><strong title={song.title}>{title(song)}</strong><small>{song.artist}</small></span></button><IconButton label="从队列移除" onClick={() => removeFromQueue(song)}><X size={14} /></IconButton></div>)}</div><button className="queue-clear" onClick={() => { if (!changeLibrary(current => ({ ...current, queue: [] }))) return; notify('播放队列已清空') }}><Trash2 size={14} />清空队列</button></> : <div className="queue-empty"><ListMusic size={32} strokeWidth={1} /><p>听见喜欢的，加入这里。</p></div>}</aside>}

    <footer className="player-bar"><div className="now-playing"><Cover song={currentSong} /><div className="now-playing-text"><strong title={currentSong?.title}>{currentSong ? title(currentSong) : '把喜欢的声音留在身边'}</strong><span>{status.state === 'loading' ? '正在连接 Bilibili…' : status.state === 'error' ? '暂时无法播放 · 点击查看源站' : (status.state === 'playing' ? currentLyric : null) || currentSong?.artist || '选一首歌，让音乐开始'}</span></div>{currentSong && <IconButton label={favorite(currentSong) ? '取消收藏' : '收藏当前歌曲'} active={favorite(currentSong)} onClick={() => changeLibrary(current => toggleFavorite(current, currentSong))}><Heart size={19} fill={favorite(currentSong) ? 'currentColor' : 'none'} /></IconButton>}</div><div className="playback-center"><div className="playback-controls"><IconButton label={library.settings.playMode === 'shuffle' ? '随机播放' : library.settings.playMode === 'repeat' ? '单曲循环' : '列表循环'} active={library.settings.playMode !== 'sequence'} onClick={cycleMode}>{library.settings.playMode === 'shuffle' ? <Shuffle size={18} /> : library.settings.playMode === 'repeat' ? <Repeat1 size={19} /> : <Repeat size={18} />}</IconButton><IconButton label="上一首" disabled={!library.queue.length} onClick={() => next(-1, true)}><SkipBack size={20} fill="currentColor" /></IconButton><button className="main-play" aria-label={status.state === 'playing' ? '暂停' : '播放'} onClick={() => void togglePlayback()} disabled={status.state === 'loading'}>{status.state === 'loading' ? <LoaderCircle size={21} className="spin" /> : status.state === 'playing' ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><IconButton label="下一首" disabled={!library.queue.length} onClick={() => next(1, true)}><SkipForward size={20} fill="currentColor" /></IconButton><IconButton label="添加当前歌曲到歌单" disabled={!currentSong} onClick={() => { if (currentSong) openModal({ type: 'add', song: currentSong }) }}><Plus size={19} /></IconButton></div><div className="timeline"><span>{formatTime(scrubbing ?? status.currentTime)}</span><input type="range" aria-label="播放进度" min="0" max={duration || 1} step="1" value={Math.min(scrubbing ?? status.currentTime, duration || 1)} disabled={!currentSong || status.state === 'loading'} style={{ '--progress': `${duration ? (scrubbing ?? status.currentTime) / duration * 100 : 0}%` } as React.CSSProperties} onChange={event => setScrubbing(Number(event.target.value))} onPointerUp={event => { const seconds = Number(event.currentTarget.value); setScrubbing(null); void api.seek(seconds).catch(error => notify(errorText(error))) }} onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') { setScrubbing(null); void api.seek(Number(event.currentTarget.value)).catch(error => notify(errorText(error))) } }} /><span>{formatTime(duration)}</span></div></div><div className="player-tools"><button className={`lyrics-toggle ${page === 'lyrics' ? 'active' : ''}`} aria-label="显示歌词" title="显示歌词" onClick={() => { navigate(page === 'lyrics' ? previousPage : 'lyrics'); setQueueOpen(false) }}>词</button><IconButton label={desktopLyrics.settings.enabled ? "关闭桌面歌词" : "开启桌面歌词"} active={desktopLyrics.settings.enabled} disabled={!desktopLyrics.available || desktopLyrics.busy} onClick={() => void desktopLyrics.updateSettings({ enabled: !desktopLyrics.settings.enabled })}><Monitor size={17} /></IconButton><IconButton label="查看 Bilibili 源视频" disabled={!currentSong} onClick={() => void api.openSource().catch(error => notify(errorText(error)))}><ExternalLink size={17} /></IconButton><span className="tool-divider" /><IconButton label={library.settings.volume === 0 ? '取消静音' : '静音'} onClick={mute}>{library.settings.volume === 0 ? <VolumeX size={19} /> : library.settings.volume < .5 ? <Volume1 size={19} /> : <Volume2 size={19} />}</IconButton><input className="volume-slider" type="range" aria-label="音量" min="0" max="1" step="0.01" value={library.settings.volume} onChange={event => void setVolume(Number(event.target.value))} style={{ '--progress': `${library.settings.volume * 100}%` } as React.CSSProperties} /><IconButton label="播放队列" active={queueOpen} onClick={() => setQueueOpen(!queueOpen)}><ListMusic size={21} /></IconButton></div></footer>

    {status.state === 'error' && status.error && <div className="playback-error" role="alert"><span>{status.error}</span><button onClick={() => void api.openSource().catch(error => notify(errorText(error)))}>打开源视频<ExternalLink size={13} /></button></div>}
    {toast && <div className="toast" role="status"><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className={`modal ${modal.type === 'bilibili' ? 'bilibili-modal' : ''}`} role="dialog" aria-modal="true" aria-label={modal.type === 'bilibili' ? '导入 Bilibili 收藏夹' : modal.type === 'add' ? '添加到歌单' : modal.type === 'delete' ? '删除歌单' : modal.type === 'rename' ? '重命名歌单' : '新建歌单'} onClick={event => event.stopPropagation()}><IconButton className="modal-close" label="关闭弹窗" onClick={() => setModal(null)}><X size={20} /></IconButton>
      {modal.type === 'bilibili' ? <BilibiliFavoritesDialog onImport={importFavoritePlaylist} /> : modal.type === 'create' || modal.type === 'rename' ? <><span className="modal-symbol"><Music2 size={26} /></span><h2>{modal.type === 'create' ? '新的声音故事' : '为歌单换个名字'}</h2><p>{modal.type === 'create' ? '给喜欢的音乐，找一个自己的归处。' : '好名字，让每一次打开都更有心情。'}</p><form onSubmit={submitName}><label htmlFor="playlist-name">歌单名称</label><input id="playlist-name" autoFocus placeholder="例如：下班路上的好心情" value={modalName} maxLength={40} onChange={event => setModalName(event.target.value)} required /><button className="button-primary" disabled={!modalName.trim()} type="submit">{modal.type === 'create' ? '创建歌单' : '保存名称'}<Check size={16} /></button></form></> : modal.type === 'add' ? <><h2>收藏进哪份歌单？</h2><p className="add-song-name">{title(modal.song)}</p><div className="add-playlist-list">{library.playlists.map(playlist => { const added = playlist.songs.some(song => song.bvid === modal.song.bvid); return <button key={playlist.id} disabled={added} onClick={() => { if (!changeLibrary(current => addToPlaylist(current, playlist.id, modal.song))) return; notify(`已添加到「${playlist.name}」`); setModal(null) }}><span className="playlist-symbol tone-0"><Music2 size={18} /></span><span><strong>{playlist.name}</strong><small>{playlist.songs.length} 首歌曲</small></span>{added ? <Check size={18} /> : <Plus size={18} />}</button> })}</div><button className="text-button" onClick={() => openModal({ type: 'create' })}><Plus size={16} />新建一份歌单</button></> : <><span className="modal-symbol delete-symbol"><Trash2 size={25} /></span><h2>删除「{modal.name}」？</h2><p>歌单会从本机移除，收藏与播放历史仍然保留。</p><div className="modal-buttons"><button className="button-secondary" onClick={() => setModal(null)}>再想想</button><button className="button-danger" onClick={() => { if (!changeLibrary(current => deletePlaylist(current, modal.id))) return; setModal(null); navigate('library'); notify('歌单已删除') }}>删除歌单</button></div></>}
    </section></div>}
  </div>
}
