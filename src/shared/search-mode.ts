import preferredMusicUploaders from './preferred-music-uploaders.json'

/** Fixed, public uploader identities; the registry does not supply audio quality guarantees. */
export const preferredMusicUploaderMids: readonly number[] = [...new Set(preferredMusicUploaders
  .map(item => (item as { mid?: unknown }).mid)
  .filter((mid): mid is number => typeof mid === 'number' && Number.isSafeInteger(mid) && mid > 0))].slice(0, 4)

/** Search modes share the same Bilibili query and source pagination. */
export type SearchMode = 'song' | 'video'

export function isSearchMode(value: unknown): value is SearchMode {
  return value === 'song' || value === 'video'
}

/** Compare the complete typed song name without punctuation, spacing or case differences. */
export function normalizeSongName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}]/gu, '')
}

/** Exact normalized keys: do not infer songs or strip artist/version text from a title. */
export function titleMatchesSongName(title: string, query: string): boolean {
  const songName = normalizeSongName(query)
  return songName.length > 0 && normalizeSongName(title) === songName
}

/** Only title relationships count; uploader names and descriptions are not song metadata. */
export function songTitleRelevance(title: string, query: string): number {
  const songName = normalizeSongName(query)
  const titleName = normalizeSongName(title)
  if (!songName || !titleName) return 7
  if (titleName === songName) return 0
  if (titleName.startsWith(songName)) return 1
  if (titleName.includes(songName)) return 2
  const tokens = [...new Set(query.normalize('NFKC').toLowerCase().split(/[\p{White_Space}\p{P}]+/u).filter(Boolean))]
  const matched = tokens.filter(token => titleName.includes(token)).length
  if (tokens.length > 1 && matched === tokens.length) return 3
  if (songName.includes(titleName)) return 4
  if (matched > 0) return 5 + (tokens.length - matched) / tokens.length
  return 7
}

/** Preserve every official result and Bilibili order inside each relevance group. */
export function rankSongTitleResults<T extends { title: string }>(items: readonly T[], query: string): T[] {
  return items.map((item, index) => ({ item, index, relevance: songTitleRelevance(item.title, query) }))
    .sort((left, right) => left.relevance - right.relevance || left.index - right.index)
    .map(entry => entry.item)
}

export type SongSearchCategory = 'single' | 'collection' | 'other'

/** These are source labels, not verified audio quality or artist metadata. */
export interface SongSearchCandidate {
  title: string
  duration?: number
  playCount?: number
  uploaderMid?: number
  searchTags?: string
}

const danceVersion = /(?:^|[^a-z0-9])(?:dj|remix|bootleg|mashup|club\s*mix)(?:$|[^a-z0-9])|慢摇|电音版|蹦迪|夜店版|车载版|舞曲版|加速版|降速版|重低音版|混音版/iu
const collectionTitle = /合集|合辑|歌单|串烧|连播|全集|全辑|精选集|现场集|整张专辑|完整专辑|专辑完整版|(?:[2-9]|\d{2,})\s*(?:首|曲|songs?\b|tracks?\b)|(?:^|[^a-z])(?:playlist|compilation|medley|full\s*album)(?:$|[^a-z])/iu
const otherTitle = /教程|教学|解析|解说|乐评|测评|吐槽|采访|广告|伴奏|卡拉\s*ok|舞蹈|(?:^|[^a-z])(?:reaction|tutorial|review|karaoke)(?:$|[^a-z])/iu
const qualityLabel = /无损|高音质|高品质|高质量|原版|原曲|官方|母带|(?:^|[^a-z0-9])(?:flac|lossless|hi[\s-]?res|hq|official)(?:$|[^a-z0-9])/iu

/** Respect an explicitly requested dance version instead of hiding that intent. */
export function requestsDanceVersion(query: string): boolean {
  return danceVersion.test(query.normalize('NFKC'))
}

/** Conservative title grouping; tags never make an unrelated video a song match. */
export function classifySongSearchResult(item: SongSearchCandidate, query: string): SongSearchCategory {
  const title = item.title.normalize('NFKC')
  // A match of only the artist / one typed word is not enough to promote an
  // unrelated recording from a preferred uploader.
  if (songTitleRelevance(title, query) > 4 || otherTitle.test(title)) return 'other'
  if (!requestsDanceVersion(query) && danceVersion.test(title)) return 'other'
  const quotedSongNames = new Set([...title.matchAll(/《([^《》]+)》/gu)]
    .map(match => normalizeSongName(match[1])).filter(Boolean))
  if (collectionTitle.test(title) || quotedSongNames.size >= 2) return 'collection'
  // Long loops / broadcasts are not presented as one recording. Explicit
  // collection titles above remain collections, even when very short.
  if (Number.isFinite(item.duration) && (item.duration ?? 0) >= 20 * 60) return 'other'
  return 'single'
}

/** Labels can improve a tie, but never assert quality or use popularity as proof. */
export function hasSongQualityLabel(item: SongSearchCandidate): boolean {
  return qualityLabel.test(`${item.title}\n${item.searchTags ?? ''}`.normalize('NFKC'))
}

/** Rank one continuous list; preferred single recordings are ordered by views. */
export function rankSongSearchResults<T extends SongSearchCandidate>(
  items: readonly T[], query: string, preferredUploaderMids: readonly number[] = preferredMusicUploaderMids,
): T[] {
  const preferred = new Set(preferredUploaderMids.filter(mid => Number.isSafeInteger(mid) && mid > 0))
  const categories: Record<SongSearchCategory, number> = { single: 0, collection: 1, other: 2 }
  return items.map((item, index) => {
    const category = classifySongSearchResult(item, query)
    return { item, index, category: categories[category],
      preferred: category === 'single' && !danceVersion.test(item.title.normalize('NFKC'))
        && Number.isSafeInteger(item.uploaderMid) && preferred.has(item.uploaderMid!) ? 0 : 1,
      relevance: songTitleRelevance(item.title, query), quality: category === 'single' && hasSongQualityLabel(item) ? 0 : 1,
      views: typeof item.playCount === 'number' && Number.isFinite(item.playCount) ? Math.max(0, item.playCount) : 0,
    }
  }).sort((left, right) => left.category - right.category || left.preferred - right.preferred
    || (left.preferred === 0 && right.preferred === 0 ? right.views - left.views : 0)
    || left.relevance - right.relevance || left.quality - right.quality || left.index - right.index)
    .map(entry => entry.item)
}

/** Read only the official tag/value shape, never arbitrary nested response fields. */
export function parseSearchSuggestions(payload: unknown): string[] {
  const invalid = () => new Error('Bilibili 搜索建议响应格式异常。')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid()
  const response = payload as { result?: unknown; data?: unknown }
  const result = response.result && typeof response.result === 'object' && !Array.isArray(response.result)
    ? response.result as { tag?: unknown } : null
  const data = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? response.data as { tag?: unknown } : null
  const tags = Array.isArray(result?.tag) ? result.tag : Array.isArray(data?.tag) ? data.tag : null
  if (!tags) throw invalid()
  const suggestions: string[] = []
  const seen = new Set<string>()
  for (const tag of tags.slice(0, 100)) {
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) continue
    const value = bilibiliResultText((tag as { value?: unknown }).value)
      .replace(/<[^>]*>/g, '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
    const text = Array.from(value).slice(0, 100).join('').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    suggestions.push(text)
    if (suggestions.length === 10) break
  }
  return suggestions
}

/** Decode the official result title before comparing or displaying it. */
export function bilibiliResultText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? '';
    const numeric = entity[1]?.toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : '';
  }).trim();
}
