import { useEffect, useMemo, useRef, useState } from 'react'
import type { Song } from '../electron/types'
import type { BilibiliSubtitleInfo, LyricsProvider, LyricsTrack } from '../electron/lyrics-types'
import { api } from './api'
import { parseLrc } from './lyrics'
import { readLyricsCache, saveLyricsCache, type SavedLyrics } from './lyrics-storage'
import { readCalibration } from './lyric-calibrations'
import { preferenceStorage } from './local-preferences'

type LyricsPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
interface LyricsState {
  bvid: string | null
  provider: LyricsProvider
  phase: LyricsPhase
  track: LyricsTrack | null
  query: string
  offsetSeconds: number
  updatedAt: number
  error: string | null
  storageWarning: string | null
  refreshing: boolean
  subtitle?: BilibiliSubtitleInfo
  message?: string
  requiresLogin?: boolean
}
const emptyState: LyricsState = { bvid: null, provider: 'bilibili', phase: 'idle', track: null, query: '', offsetSeconds: 0, updatedAt: 0, error: null, storageWarning: null, refreshing: false }
const SOURCE_STORAGE_KEY = 'yuyin-lyrics-source-v1'
function preferredProvider(): { provider: LyricsProvider; warning: string | null } {
  try { return { provider: preferenceStorage()?.getItem(SOURCE_STORAGE_KEY) === 'lrclib' ? 'lrclib' : 'bilibili', warning: null } }
  catch (error) { return { provider: 'bilibili', warning: `歌词来源未能读取：${errorMessage(error)}` } }
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')

export function useLyrics(song: Song | null) {
  const [state, setState] = useState(emptyState)
  const [initialSource] = useState(preferredProvider)
  const [provider, setProvider] = useState<LyricsProvider>(initialSource.provider)
  const [sourceStorageWarning, setSourceStorageWarning] = useState<string | null>(initialSource.warning)
  const [revision, setRevision] = useState(0)
  const forceFor = useRef<{ bvid: string; provider: LyricsProvider } | null>(null)
  const stateRef = useRef(state)
  const currentSong = useRef(song)
  const providerRef = useRef(provider)
  const alignmentContext = useRef(0)
  if (currentSong.current?.bvid !== song?.bvid) alignmentContext.current++
  stateRef.current = state; currentSong.current = song; providerRef.current = provider

  useEffect(() => {
    let canceled = false
    const base = { ...emptyState, provider }
    if (!song) { setState(base); return }
    const isCurrent = () => !canceled && currentSong.current?.bvid === song.bvid && providerRef.current === provider
    const force = forceFor.current?.bvid === song.bvid && forceFor.current.provider === provider
    forceFor.current = null
    const cached = readLyricsCache(song.bvid, undefined, provider)
    const isPrevious = stateRef.current.bvid === song.bvid && stateRef.current.provider === provider
    const previousOffset = isPrevious ? stateRef.current.offsetSeconds : cached?.offsetSeconds ?? 0
    if (cached && !force) {
      setState({ ...base, ...cached, bvid: song.bvid, phase: cached.track ? 'ready' : 'empty' })
      return
    }
    const previous = stateRef.current
    const fallback = isPrevious && previous.phase === 'ready' ? previous : cached?.track ? { ...base, ...cached, bvid: song.bvid, phase: 'ready' as const } : null
    setState(fallback ? { ...fallback, refreshing: true, error: null } : { ...base, bvid: song.bvid, phase: 'loading', offsetSeconds: previousOffset })
    void api.getLyrics({ song, query: song.searchQuery, force, provider }).then(result => {
      if (!isCurrent()) return
      if (result.provider !== provider) throw new Error('歌词来源返回不一致，请重新获取。')
      const latest = stateRef.current
      const latestIsCurrent = latest.bvid === song.bvid && latest.provider === provider
      const previousTrack = latestIsCurrent ? latest.track : fallback?.track
      const sameTimeline = previousTrack && result.match && previousTrack.id === result.match.id && previousTrack.syncedLyrics === result.match.syncedLyrics
      if (!sameTimeline) alignmentContext.current++
      const retainedOffset = result.match ? readCalibration(song.bvid, provider, result.match) : null
      const offsetSeconds = retainedOffset ?? (sameTimeline ? latestIsCurrent ? latest.offsetSeconds : previousOffset : 0)
      const saved: SavedLyrics = { track: result.match, query: result.query, offsetSeconds, updatedAt: Date.now(), ...(result.subtitle ? { subtitle: result.subtitle } : {}), ...(result.message ? { message: result.message } : {}), ...(result.requiresLogin !== undefined ? { requiresLogin: result.requiresLogin } : {}) }
      const persisted = saveLyricsCache(song.bvid, saved, undefined, provider)
      setState({ ...base, ...saved, bvid: song.bvid, phase: result.match ? 'ready' : 'empty', storageWarning: persisted.ok ? null : persisted.error })
    }).catch(error => {
      if (!isCurrent()) return
      const latest = stateRef.current
      const latestIsCurrent = latest.bvid === song.bvid && latest.provider === provider
      const offsetSeconds = latestIsCurrent ? latest.offsetSeconds : previousOffset
      setState(fallback ? { ...fallback, offsetSeconds, storageWarning: latestIsCurrent ? latest.storageWarning : fallback.storageWarning, refreshing: false, error: errorMessage(error) } : { ...base, bvid: song.bvid, phase: 'error', offsetSeconds: previousOffset, error: errorMessage(error) })
    })
    return () => { canceled = true }
  }, [song?.bvid, song?.title, song?.searchQuery, provider, revision])

  // A new song or source must never display the previous request's words before its effect runs.
  const visible = state.bvid === song?.bvid && state.provider === provider ? state : { ...emptyState, provider, bvid: song?.bvid ?? null, phase: song ? 'loading' as const : 'idle' as const }
  const lines = useMemo(() => parseLrc(visible.track?.syncedLyrics ?? ''), [visible.track?.syncedLyrics])
  function setOffset(value: number) {
    const latest = stateRef.current
    if (!Number.isFinite(value) || !latest.bvid || latest.bvid !== currentSong.current?.bvid || latest.provider !== providerRef.current || latest.phase !== 'ready') return
    const offsetSeconds = Math.max(-180, Math.min(180, Math.round(value * 10) / 10))
    const result = saveLyricsCache(latest.bvid, { track: latest.track, query: latest.query, offsetSeconds, updatedAt: latest.updatedAt, ...(latest.subtitle ? { subtitle: latest.subtitle } : {}), ...(latest.message ? { message: latest.message } : {}), ...(latest.requiresLogin !== undefined ? { requiresLogin: latest.requiresLogin } : {}) }, undefined, latest.provider)
    setState(current => current.bvid === latest.bvid && current.provider === latest.provider ? { ...current, offsetSeconds, storageWarning: result.ok ? null : result.error } : current)
  }
  function retry() { if (currentSong.current) { forceFor.current = { bvid: currentSong.current.bvid, provider: providerRef.current }; setRevision(current => current + 1) } }
  async function alignLine(lineTime: number) {
    const before = stateRef.current
    const context = alignmentContext.current
    if (before.phase !== 'ready' || !before.track || !parseLrc(before.track.syncedLyrics ?? '').some(line => line.time === lineTime && line.text)) throw new Error('请选择有文字的同步歌词。')
    const playback = await api.getStatus()
    const latest = stateRef.current
    if (alignmentContext.current !== context || playback.song?.bvid !== before.bvid || currentSong.current?.bvid !== before.bvid || providerRef.current !== before.provider || latest.bvid !== before.bvid || latest.provider !== before.provider || latest.track?.id !== before.track.id || latest.track?.syncedLyrics !== before.track.syncedLyrics) throw new Error('歌曲或歌词已切换，请重新校准。')
    if (!['playing', 'paused'].includes(playback.state) || !Number.isFinite(playback.currentTime)) throw new Error('请在歌曲播放或暂停时校准。')
    const offset = Math.round((playback.currentTime - lineTime) * 10) / 10
    if (Math.abs(offset) > 180) throw new Error('时间差超过 3 分钟，请选择此刻正在唱的歌词；当前歌词也可能是另一演唱版本。')
    setOffset(offset)
  }
  function selectProvider(next: LyricsProvider) {
    if ((next !== 'lrclib' && next !== 'bilibili') || next === providerRef.current) return
    alignmentContext.current++
    providerRef.current = next
    forceFor.current = null
    setProvider(next)
    try {
      preferenceStorage().setItem(SOURCE_STORAGE_KEY, next)
      setSourceStorageWarning(null)
    } catch (error) { setSourceStorageWarning(`歌词来源偏好暂时无法保存：${errorMessage(error)}`) }
  }
  return { ...visible, storageWarning: [visible.storageWarning, sourceStorageWarning].filter(Boolean).join(' ') || null, lines, setOffset, alignLine, retry, selectProvider }
}

export type LyricsViewState = ReturnType<typeof useLyrics>
