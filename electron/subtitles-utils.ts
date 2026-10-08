import { createHash } from 'node:crypto';

const MIXIN_INDICES = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

export interface SubtitleDescriptor {
  language: string;
  label: string;
  isAI: boolean;
  url: string;
}

export interface SubtitleLyrics {
  syncedLyrics: string;
  plainLyrics: string;
  duration: number;
}

/** Only the known Bilibili subtitle CDN paths can be fetched. */
export function safeSubtitleUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !value.trim()) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const ai = url.hostname === 'aisubtitle.hdslb.com' && url.pathname.startsWith('/bfs/ai_subtitle/');
    const regular = /^i[0-3]\.hdslb\.com$/.test(url.hostname) && url.pathname.startsWith('/bfs/subtitle/');
    return ai || regular ? url.toString() : null;
  } catch {
    return null;
  }
}

export function subtitleDescriptor(value: unknown): SubtitleDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.lan !== 'string' || !item.lan.trim() || item.lan.length > 40
    || typeof item.lan_doc !== 'string' || !item.lan_doc.trim() || item.lan_doc.length > 100) return null;
  const url = safeSubtitleUrl(item.subtitle_url);
  if (!url) return null;
  return {
    language: item.lan,
    label: item.lan_doc,
    // A type number alone does not reliably distinguish community and AI subtitles.
    isAI: /^ai[-_]/i.test(item.lan) || /自动生成|自動生成|\bAI\b/i.test(item.lan_doc)
      || new URL(url).hostname === 'aisubtitle.hdslb.com',
    url,
  };
}

export function selectSubtitle(items: readonly SubtitleDescriptor[]): SubtitleDescriptor | null {
  const chinese = (item: SubtitleDescriptor) => /^(?:ai[-_])?(?:zh|cmn)(?:[-_]|$)/i.test(item.language) || /中文|汉语|漢語/.test(item.label);
  const score = (item: SubtitleDescriptor) => (item.isAI ? 100 : 0) + (chinese(item) ? 200 : 0);
  return items.reduce<SubtitleDescriptor | null>((selected, item) => !selected || score(item) > score(selected) ? item : selected, null);
}

function wbiImageKey(value: string): string {
  const filename = new URL(value).pathname.split('/').at(-1) ?? '';
  const match = filename.match(/^([a-f0-9]{32})\.[a-z0-9]+$/i);
  if (!match) throw new Error('Bilibili 签名信息格式异常。');
  return match[1];
}

/** The public WBI request signature used by Bilibili's own web player. */
export function buildWbiQuery(parameters: Readonly<Record<string, string | number>>, imgUrl: string, subUrl: string, timestamp = Math.floor(Date.now() / 1000)): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Bilibili 签名时间无效。');
  const original = wbiImageKey(imgUrl) + wbiImageKey(subUrl);
  const mixinKey = MIXIN_INDICES.map(index => original[index]).join('').slice(0, 32);
  const values: Record<string, string | number> = { ...parameters, wts: timestamp };
  delete values.w_rid;
  const query = Object.keys(values).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + mixinKey).digest('hex')}`;
}

function lrcTimestamp(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const minutes = Math.floor(milliseconds / 60_000);
  const remainder = milliseconds % 60_000;
  // LRC minutes beyond 999 are expressed as hours to fit the shared parser.
  const prefix = minutes > 999
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
    : String(minutes).padStart(2, '0');
  return `[${prefix}:${String(Math.floor(remainder / 1000)).padStart(2, '0')}.${String(remainder % 1000).padStart(3, '0')}]`;
}

/** Bilibili's caption timestamps already refer to this video, including its intro. */
export function subtitleBodyToLyrics(value: unknown): SubtitleLyrics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bilibili 字幕内容格式异常。');
  const body = (value as Record<string, unknown>).body;
  if (!Array.isArray(body) || body.length > 5000) throw new Error('Bilibili 字幕内容格式异常或过长。');
  const rows: Array<{ from: number; to: number; text: string }> = [];
  let textLength = 0;
  for (const raw of body) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Bilibili 字幕时间轴格式异常。');
    const row = raw as Record<string, unknown>;
    if (typeof row.from !== 'number' || !Number.isFinite(row.from) || row.from < 0
      || typeof row.to !== 'number' || !Number.isFinite(row.to) || row.to < row.from || row.to > 86_400
      || typeof row.content !== 'string' || row.content.length > 2000) throw new Error('Bilibili 字幕时间轴格式异常。');
    // Caption text is literal: brackets must not become additional LRC timestamps.
    const text = row.content.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/\[/g, '［').replace(/\]/g, '］').replace(/</g, '＜').replace(/>/g, '＞');
    if (!text) continue;
    textLength += text.length;
    if (textLength > 100_000) throw new Error('Bilibili 字幕内容过长，暂时无法显示。');
    rows.push({ from: row.from, to: row.to, text });
  }
  rows.sort((left, right) => left.from - right.from || left.to - right.to);
  const synced: string[] = [];
  let duration = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    synced.push(`${lrcTimestamp(row.from)}${row.text}`);
    duration = Math.max(duration, row.to);
    // Honor caption end times instead of showing speech throughout silent gaps.
    if (row.to > row.from && (!rows[index + 1] || row.to < rows[index + 1].from)) synced.push(lrcTimestamp(row.to));
  }
  const syncedLyrics = synced.join('\n');
  const plainLyrics = rows.map(row => row.text).join('\n');
  if (syncedLyrics.length > 100_000 || plainLyrics.length > 100_000) throw new Error('Bilibili 字幕内容过长，暂时无法显示。');
  return { syncedLyrics, plainLyrics, duration };
}
