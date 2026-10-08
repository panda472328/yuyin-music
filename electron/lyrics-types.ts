import type { Song } from './types'

export type LyricsProvider = 'lrclib' | 'bilibili'

export interface BilibiliSubtitleInfo {
  language: string
  label: string
  isAI: boolean
}

export interface LyricsTrack {
  id: number
  trackName: string
  artistName: string
  albumName: string
  duration: number
  instrumental: boolean
  syncedLyrics: string | null
  plainLyrics: string | null
}

export interface LyricsRequest {
  song: Song
  query?: string
  force?: boolean
  provider?: LyricsProvider
}

export interface LyricsLookupResult {
  provider: LyricsProvider
  query: string
  match: LyricsTrack | null
  subtitle?: BilibiliSubtitleInfo
  message?: string
  requiresLogin?: boolean
}
