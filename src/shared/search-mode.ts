/** Search modes share the same Bilibili query and source pagination. */
export type SearchMode = 'song' | 'video'

export function isSearchMode(value: unknown): value is SearchMode {
  return value === 'song' || value === 'video'
}

/** Compare the complete typed song name without punctuation, spacing or case differences. */
export function normalizeSongName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}]/gu, '')
}

/** Title-only filtering: never infer a song from description, author, split words or related names. */
export function titleMatchesSongName(title: string, query: string): boolean {
  const songName = normalizeSongName(query)
  return songName.length > 0 && normalizeSongName(title).includes(songName)
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
