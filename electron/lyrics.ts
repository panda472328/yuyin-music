import type { Session } from 'electron';
import { buildLyricsQueries, selectLyricsMatch } from '../src/lyrics';
import type { LyricsLookupResult, LyricsRequest, LyricsTrack } from './lyrics-types';

const SEARCH_ENDPOINT = 'https://lrclib.net/api/search';
const TOTAL_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 200;
const FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 60_000;

export class LyricsError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LyricsError';
  }
}

interface CacheEntry {
  fingerprint: string;
  expiresAt: number;
  result: LyricsLookupResult;
}

interface PendingLookup {
  fingerprint: string;
  promise: Promise<LyricsLookupResult>;
}

function boundedString(value: unknown, maxLength: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}

function lyricsText(value: unknown): value is string | null {
  return value === null || boundedString(value, 100_000);
}

function parseTrack(value: unknown): LyricsTrack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const track = value as Record<string, unknown>;
  if (!Number.isSafeInteger(track.id) || (track.id as number) <= 0
    || !boundedString(track.trackName, 500, false)
    || !boundedString(track.artistName, 500)
    || !(track.albumName === null || boundedString(track.albumName, 500))
    || typeof track.duration !== 'number' || !Number.isFinite(track.duration)
    || track.duration < 0 || track.duration > 86_400
    || typeof track.instrumental !== 'boolean'
    || !lyricsText(track.syncedLyrics) || !lyricsText(track.plainLyrics)) return null;
  return {
    id: track.id as number,
    trackName: track.trackName,
    artistName: track.artistName,
    albumName: track.albumName ?? '',
    duration: track.duration,
    instrumental: track.instrumental,
    syncedLyrics: track.syncedLyrics,
    plainLyrics: track.plainLyrics,
  };
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new LyricsError('歌词服务返回的数据过大，请稍后重试。', 'LYRICS_RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new LyricsError('歌词服务返回了空响应，请稍后重试。', 'LYRICS_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LyricsError('歌词服务返回的数据过大，请稍后重试。', 'LYRICS_RESPONSE_TOO_LARGE');
      }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new LyricsError('歌词服务返回的数据格式异常，请稍后重试。', 'LYRICS_INVALID_RESPONSE');
  }
}

/** Reads the public LRCLIB search API independently of video playback. */
export class LyricsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingLookup>();

  constructor(private readonly session: Session) {}

  lookup(request: LyricsRequest): Promise<LyricsLookupResult> {
    if (!request || typeof request !== 'object' || !request.song
      || !boundedString(request.song.bvid, 12, false) || !/^BV[0-9a-zA-Z]{10}$/.test(request.song.bvid)
      || !boundedString(request.song.title, 1000, false)
      || !boundedString(request.song.artist, 500)
      || typeof request.song.duration !== 'number' || !Number.isFinite(request.song.duration)
      || request.song.duration < 0 || request.song.duration > 86_400
      || (request.query !== undefined && !boundedString(request.query, 200))
      || (request.force !== undefined && typeof request.force !== 'boolean')) {
      return Promise.reject(new LyricsError('歌曲信息无效，无法查询歌词。', 'LYRICS_INVALID_REQUEST'));
    }
    const bvid = request.song.bvid;
    // A different search term may improve a previous match for the same video.
    const fingerprint = JSON.stringify([request.song.title, request.song.duration, request.query?.trim() ?? '']);
    const cached = this.cache.get(bvid);
    if (!request.force && cached?.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.result);
    }
    if (cached) this.cache.delete(bvid);
    const existing = this.pending.get(bvid);
    if (existing?.fingerprint === fingerprint) return existing.promise;

    const promise = this.search(request).then((result) => {
      // Do not let an older request overwrite the latest query for this video.
      if (this.pending.get(bvid)?.promise === promise) {
        this.cache.set(bvid, {
          fingerprint,
          expiresAt: Date.now() + (result.match ? FOUND_TTL_MS : NOT_FOUND_TTL_MS),
          result,
        });
        while (this.cache.size > MAX_CACHE_ENTRIES) {
          this.cache.delete(this.cache.keys().next().value as string);
        }
      }
      return result;
    }).finally(() => {
      if (this.pending.get(bvid)?.promise === promise) this.pending.delete(bvid);
    });
    this.pending.set(bvid, { fingerprint, promise });
    return promise;
  }

  private async search(request: LyricsRequest): Promise<LyricsLookupResult> {
    const queries = [...new Set(buildLyricsQueries(request).map((query) => query.trim()))]
      .filter((query) => query.length > 0 && query.length <= 200).slice(0, 3);
    if (!queries.length) return { provider: 'lrclib', query: '', match: null };
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    let lastQuery = queries[0];
    const tracks = new Map<number, LyricsTrack>();
    for (const query of queries) {
      lastQuery = query;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LyricsError('歌词查询超时，请稍后重试。', 'LYRICS_TIMEOUT');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(remaining, REQUEST_TIMEOUT_MS));
      const url = new URL(SEARCH_ENDPOINT);
      url.searchParams.set('q', query);
      try {
        const response = await this.session.fetch(url.toString(), {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'YuyinMusic/0.4.4' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new LyricsError(
            response.status === 429
              ? '歌词服务请求过于频繁，请稍后重试。'
              : `歌词服务返回 HTTP ${response.status}，请稍后重试。`,
            response.status === 429 ? 'LYRICS_RATE_LIMITED' : 'LYRICS_HTTP_ERROR',
          );
        }
        const payload = await readLimitedJson(response);
        if (!Array.isArray(payload) || payload.length > 500) {
          throw new LyricsError('歌词服务返回的数据格式异常，请稍后重试。', 'LYRICS_INVALID_RESPONSE');
        }
        let validTracks = 0;
        for (const raw of payload) {
          const track = parseTrack(raw);
          if (track) {
            validTracks += 1;
            tracks.set(track.id, track);
          }
        }
        if (payload.length > 0 && validTracks === 0) {
          throw new LyricsError('歌词服务返回的数据格式异常，请稍后重试。', 'LYRICS_INVALID_RESPONSE');
        }
        const match = selectLyricsMatch(request, [...tracks.values()]);
        if (match) return { provider: 'lrclib', query, match };
      } catch (error) {
        if (error instanceof LyricsError) throw error;
        if (controller.signal.aborted) {
          throw new LyricsError('歌词查询超时，请检查网络后重试。', 'LYRICS_TIMEOUT');
        }
        throw new LyricsError('无法连接歌词服务，请检查网络后重试。', 'LYRICS_NETWORK_ERROR');
      } finally {
        clearTimeout(timeout);
      }
    }
    return { provider: 'lrclib', query: lastQuery, match: null };
  }
}
