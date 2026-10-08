import { useEffect, useRef, useState } from 'react'
import type { PlaybackStatus } from '../electron/types'
import { DESKTOP_LYRICS_DEFAULT_SETTINGS, type DesktopLyricsContent, type DesktopLyricsSettings, type DesktopLyricsSnapshot } from '../electron/desktop-lyrics-types'
import { api, isDesktop } from './api'
import { activeLyricIndex } from './lyrics'
import type { LyricsViewState } from './useLyrics'

export function useDesktopLyrics(status: PlaybackStatus, lyrics: LyricsViewState) {
  const available = isDesktop && typeof api.getDesktopLyricsSnapshot === 'function'
  const [settings, setSettings] = useState<DesktopLyricsSettings>({ ...DESKTOP_LYRICS_DEFAULT_SETTINGS })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const eventRevision = useRef(0)

  function receive(snapshot: DesktopLyricsSnapshot) {
    setSettings(snapshot.settings)
    setError(snapshot.error)
  }
  useEffect(() => {
    if (!available) return
    let canceled = false
    const unsubscribe = api.onDesktopLyricsSnapshot(snapshot => {
      eventRevision.current++
      if (!canceled) receive(snapshot)
    })
    const revision = eventRevision.current
    void api.getDesktopLyricsSnapshot().then(snapshot => {
      if (!canceled && revision === eventRevision.current) receive(snapshot)
    }).catch(failure => { if (!canceled) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { canceled = true; unsubscribe() }
  }, [available])

  const index = activeLyricIndex(lyrics.lines, status.currentTime, lyrics.offsetSeconds)
  const hasTimedWords = lyrics.lines.some(line => Boolean(line.text))
  const phase = !status.song ? 'idle' : status.state === 'loading' ? 'loading' : status.state === 'error' ? 'error'
    : lyrics.phase === 'ready' && !hasTimedWords ? 'empty' : lyrics.phase
  const current = phase === 'ready' ? index < 0 ? '前奏 · 等待第一句' : lyrics.lines[index]?.text || '间奏' : ''
  const next = phase === 'ready' ? lyrics.lines.slice(index + 1).find(line => Boolean(line.text))?.text ?? '' : ''
  const songTitle = lyrics.track?.trackName || status.song?.title.replace(/【[^】]*】/g, '').trim() || ''
  const bvid = status.song?.bvid ?? null
  const playing = status.state === 'playing'
  useEffect(() => {
    if (!available) return
    const content: DesktopLyricsContent = { bvid, title: songTitle.slice(0, 500), current: current.slice(0, 1000), next: next.slice(0, 1000), phase, playing }
    // Send only a changed line or playback state; both windows share one lyric lookup.
    void api.publishDesktopLyrics(content).catch(() => {})
  }, [available, bvid, songTitle, current, next, phase, playing])

  async function updateSettings(patch: Partial<DesktopLyricsSettings>) {
    if (!available) { setError('请在桌面客户端中使用桌面歌词。'); return }
    setBusy(true)
    const revision = eventRevision.current
    try {
      const snapshot = await api.updateDesktopLyricsSettings(patch)
      if (eventRevision.current === revision) receive(snapshot)
    } catch (failure) { setError((failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')) }
    finally { setBusy(false) }
  }
  return { settings, error, busy, available, updateSettings }
}
