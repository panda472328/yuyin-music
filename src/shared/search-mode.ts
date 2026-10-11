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
