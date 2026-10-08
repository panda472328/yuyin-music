import type { LyricsRequest, LyricsTrack } from '../electron/lyrics-types'

export interface LyricLine { time: number; text: string }

const TIME_TAG = /\[((?:\d{1,3}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?)\]/g
const LINE_TIMES = /^\s*((?:\[(?:\d{1,3}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?\]\s*)+)(.*)$/

/** LRC's positive metadata offset makes lyrics appear earlier. UI offsets are separate. */
export function parseLrc(text: string): LyricLine[] {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let offset = 0
  for (const row of rows) {
    const match = row.trim().match(/^\[offset:\s*([+-]?\d+)\s*\]$/i)
    if (match) offset = Number(match[1]) / 1000
  }
  const lines: LyricLine[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const match = row.match(LINE_TIMES)
    if (!match) continue
    const lyric = match[2].replace(/<(?:\d{1,3}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?>/g, '').trim()
    if (/^\[(?:ti|ar|al|by|re|ve|offset):/i.test(lyric)) continue
    for (const tag of match[1].matchAll(TIME_TAG)) {
      const parts = tag[1].replace(',', '.').split(':').map(Number)
      if (parts.length === 3 && parts[1] >= 60) continue
      const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
      const time = Math.round((seconds - offset) * 1000) / 1000
      const key = `${time}\u0000${lyric}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push({ time, text: lyric })
    }
  }
  return lines.sort((left, right) => left.time - right.time)
}

/** Positive offset delays lyrics; binary search also handles backwards seeks. */
export function activeLyricIndex(lines: readonly LyricLine[], currentTime: number, offsetSeconds = 0): number {
  if (!Number.isFinite(currentTime)) return -1
  const time = currentTime - (Number.isFinite(offsetSeconds) ? offsetSeconds : 0)
  let low = 0
  let high = lines.length - 1
  let result = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (lines[middle].time <= time) { result = middle; low = middle + 1 }
    else high = middle - 1
  }
  return result
}

const TECH = /(?:\b(?:\d[48]k|\d{3,4}p|uhd|hd|hq|fps|hi-?res)\b|\d{3,4}P|[248]K|修复版|修復版|修复|修復|高清|超清|画质|畫質|杜比|无损|無損|音质|音質|帧率|幀率|\d+帧|\d+幀)/gi
const DECORATION = /(?:official\s*(?:music\s*)?(?:video|audio|mv)|music\s*video|lyric(?:s)?\s*video|(?:完整版|高音质|高音質|超治愈|超治癒|官方|完整|原版|中英|中文|英文|双语|雙語|字幕|歌词|歌詞|纯享|純享|音频|音頻|音乐|音樂|治愈|治癒|经典|經典|神曲|视听|視聽|单曲|單曲)|\bmv\b|MV)/gi
const LIVE = /(?:\blive\b|现场|現場|演唱会|演唱會|音乐会|音樂會|巡演|演唱版本)/i
const COLLECTION = /(?:合集|串烧|串燒|歌单|歌單|歌曲大全|歌曲集|全专辑|全專輯|\b(?:medley|compilation|playlist)\b)/i

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function clean(value: string): string {
  return value.normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(TECH, ' ').replace(DECORATION, ' ')
    .replace(/[|｜~～!！?？…]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function withoutVersion(value: string): string {
  return value.replace(/[（(][^）)]*(?:live|version|remaster|现场|現場|演唱会|演唱會|版)[^）)]*[）)]/gi, '')
    .replace(/\b(?:live|remastered?|acoustic|studio|version)\b/gi, '')
    .replace(/(?:翻唱版|现场版|現場版|现场|現場|演唱会|演唱會|录音室|錄音室|原唱|翻唱)/g, '').trim()
}

function containsName(text: string, name: string): boolean {
  if (normalize(text) === normalize(name)) return true
  const source = text.normalize('NFKC').toLowerCase()
  const target = name.normalize('NFKC').toLowerCase().trim()
  let at = source.indexOf(target)
  while (at >= 0) {
    const before = source[at - 1]
    const after = source[at + target.length]
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) return true
    at = source.indexOf(target, at + target.length)
  }
  return false
}

function videoSongName(value: string): string {
  // Everything after the video-format marker can be promotion for another album.
  const name = value.split(/\b(?:official|music\s*video|lyric(?:s)?\s*video)\b|MV|\d{3,4}P|[248]K/gi)[0]
  return clean(name).replace(/[\s(（【\[]+$/g, '').trim()
}

function plausibleArtist(value: string): string {
  return value.length > 50 || /(?:打开|打開|混剪|音源|海绵宝宝|海綿寶寶|感动|感動|推荐|推薦|盘点|盤點|一起来|一起來)/.test(value) ? '' : value
}

interface Identity { names: string[]; artist: string; title: string; live: boolean; collection: boolean; explicitName: boolean }

function identity(request: LyricsRequest): Identity {
  const raw = request.song.title.normalize('NFKC').replace(/<[^>]*>/g, ' ')
  // Bracketed video labels are common on Bilibili; retain brackets that contain song names.
  const rawTitle = raw.replace(/【[^】]*(?:修复|修復|高清|超清|私藏|音乐馆|音樂館|[248]K|\d{3,4}P)[^】]*】/gi, ' ')
  const title = clean(rawTitle)
  const quotes = [...title.matchAll(/[《「『]([^》」』]+)[》」』]/g)]
  const names: string[] = []
  let artist = ''
  const dashParts = rawTitle.split(/\s*[-–—―]+\s*/).map(part => part.trim()).filter(Boolean)
  if (dashParts.length >= 2) {
    // Movie names often follow a song title: City of Stars — 《爱乐之城》MV.
    if (/^[《「『]/.test(dashParts[1])) names.push(videoSongName(dashParts[0]))
    else { artist = plausibleArtist(clean(dashParts[0])); names.push(videoSongName(dashParts[1])) }
  }
  if (!names.length && quotes.length === 1) {
    names.push(clean(quotes[0][1]))
    artist = plausibleArtist(clean(title.slice(0, quotes[0].index)).replace(/^[【\[][^】\]]*[】\]]\s*/, '').trim())
  }
  const bracket = title.match(/【([^】]+)】/)
  if (!names.length && bracket && bracket.index! > 0) {
    names.push(clean(bracket[1]))
    artist = plausibleArtist(clean(title.slice(0, bracket.index)))
  }
  const explicitName = names.length > 0
  if (!names.length) names.push(title.replace(/^[【\[][^】\]]*[】\]]\s*/, '').trim())
  const query = clean(request.query ?? '')
  // Search text helps plain titles, but cannot override a clearly different playing video.
  if (query && containsName(title, query)) names.push(query)
  if (!names.some(name => normalize(name).length >= 2) && query) names.push(query)
  if (!artist && query) {
    const matchingName = names.find(name => containsName(query, name))
    if (matchingName) {
      const prefix = query.slice(0, query.toLowerCase().indexOf(matchingName.toLowerCase())).replace(/[\s\-–—]+$/g, '').trim()
      if (normalize(prefix).length >= 2 && prefix.length < 40) artist = prefix
    }
  }
  return {
    names: [...new Set(names.map(withoutVersion).filter(name => normalize(name).length >= 2))],
    artist, title, live: LIVE.test(raw),
    collection: COLLECTION.test(raw) || quotes.length > 1 && request.song.duration > 600, explicitName,
  }
}

export function buildLyricsQueries(request: LyricsRequest): string[] {
  const info = identity(request)
  const queries: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const query = value.replace(/[《》「」『』【】\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    const key = normalize(query)
    if (key.length < 2 || seen.has(key) || queries.length >= 3) return
    seen.add(key); queries.push(query)
  }
  for (const name of info.names) {
    if (info.artist) add(`${info.artist} ${name}`)
    add(name)
  }
  if (request.query && (!info.names.length || info.names.some(name => containsName(clean(request.query!), name)) || containsName(info.title, clean(request.query)))) add(clean(request.query))
  return queries
}

function nameScore(name: string, candidates: string[], explicitName: boolean): number {
  const key = normalize(withoutVersion(clean(name)))
  if (key.length < 2) return 0
  let score = 0
  for (const candidate of candidates) {
    const expected = normalize(candidate)
    if (key === expected) score = Math.max(score, 100)
    // A full track name may occur within a video's descriptive title. Never accept the
    // reverse containment (e.g. matching "晴天" to "晴天的你") or a one-character name.
    else if (!explicitName && containsName(candidate, withoutVersion(clean(name)))) score = Math.max(score, 65)
  }
  return score
}

export function selectLyricsMatch(request: LyricsRequest, tracks: readonly LyricsTrack[]): LyricsTrack | null {
  const info = identity(request)
  if (info.collection || !info.names.length) return null
  const titleKey = normalize(info.title)
  const artistKey = normalize(info.artist)
  let best: LyricsTrack | null = null
  let bestScore = -Infinity
  for (const track of tracks) {
    if (!track || typeof track.trackName !== 'string' || typeof track.artistName !== 'string') continue
    const hasSynced = typeof track.syncedLyrics === 'string' && parseLrc(track.syncedLyrics).some(line => line.text.length > 0)
    const hasPlain = typeof track.plainLyrics === 'string' && track.plainLyrics.trim().length > 0
    if (!hasSynced && !hasPlain && !track.instrumental) continue
    const songScore = nameScore(track.trackName, info.names, info.explicitName)
    if (!songScore) continue
    const key = normalize(track.artistName)
    const artistMatches = key.length >= 2 && (titleKey.includes(key) || artistKey.includes(key))
    const versionLive = LIVE.test(`${track.trackName} ${track.albumName}`)
    const durationDifference = Number.isFinite(track.duration) && track.duration > 0 && request.song.duration > 0
      ? Math.abs(track.duration - request.song.duration) : Infinity
    // Song identity, singer and version outweigh MV intro/outro duration differences.
    const score = songScore + (artistMatches ? 90 : 0) + (versionLive === info.live ? 45 : -45)
      + (hasSynced ? 8 : hasPlain ? 3 : 0) + Math.max(0, 12 - durationDifference / 10)
    if (score > bestScore) { bestScore = score; best = track }
  }
  return best
}
