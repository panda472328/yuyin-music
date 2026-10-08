import type { Session } from 'electron';
import type { LyricsLookupResult, LyricsRequest } from './lyrics-types';
import { buildWbiQuery, selectSubtitle, subtitleBodyToLyrics, subtitleDescriptor } from './subtitles-utils';

const API_ORIGIN = 'https://api.bilibili.com';
const HOME = 'https://www.bilibili.com/';
const TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 100;

export class SubtitlesError extends Error {
  constructor(message: string, public readonly code: string, public readonly requiresVerification = false) {
    super(message);
    this.name = 'SubtitlesError';
  }
}

interface WbiKeys { imgUrl: string; subUrl: string; expiresAt: number }
interface CacheEntry { result: LyricsLookupResult; expiresAt: number; fingerprint: string }
interface PendingEntry { promise: Promise<LyricsLookupResult>; fingerprint: string }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function limitedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SubtitlesError('Bilibili 字幕响应过大，暂时无法读取。', 'SUBTITLES_TOO_LARGE');
  }
  if (!response.body) throw new SubtitlesError('Bilibili 返回了空响应，请稍后重试。', 'SUBTITLES_INVALID_RESPONSE');
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
        throw new SubtitlesError('Bilibili 字幕响应过大，暂时无法读取。', 'SUBTITLES_TOO_LARGE');
      }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(body) as unknown; }
  catch { throw new SubtitlesError('Bilibili 返回了异常页面，请打开源视频检查登录或验证。', 'SUBTITLES_INVALID_RESPONSE', true); }
}

/** Reads only captions already offered to the current Bilibili session. */
export class BilibiliSubtitlesService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingEntry>();
  private keys: WbiKeys | null = null;
  private pendingKeys: Promise<WbiKeys> | null = null;

  constructor(private readonly session: Session) {}

  lookup(request: LyricsRequest): Promise<LyricsLookupResult> {
    const song = request?.song;
    if (!song || song.source !== 'bilibili' || typeof song.bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(song.bvid)
      || typeof song.title !== 'string' || !song.title.trim() || song.title.length > 1000
      || typeof song.duration !== 'number' || !Number.isFinite(song.duration) || song.duration < 0 || song.duration > 86_400
      || (request.force !== undefined && typeof request.force !== 'boolean')) {
      return Promise.reject(new SubtitlesError('歌曲信息无效，无法读取 Bilibili 字幕。', 'SUBTITLES_INVALID_REQUEST'));
    }
    const fingerprint = JSON.stringify([song.title, song.duration]);
    const cached = this.cache.get(song.bvid);
    if (!request.force && cached?.fingerprint === fingerprint && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
    if (cached) this.cache.delete(song.bvid);
    const existing = this.pending.get(song.bvid);
    if (existing?.fingerprint === fingerprint) return existing.promise;
    const promise = this.readSubtitles(request).then(result => {
      if (this.pending.get(song.bvid)?.promise === promise && !result.requiresLogin) {
        this.cache.set(song.bvid, {
          result, fingerprint,
          expiresAt: Date.now() + (result.match ? 6 * 60 * 60 * 1000 : 60_000),
        });
        while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
      }
      return result;
    }).finally(() => { if (this.pending.get(song.bvid)?.promise === promise) this.pending.delete(song.bvid); });
    this.pending.set(song.bvid, { promise, fingerprint });
    return promise;
  }

  private async fetchJson(url: string, deadline: number, api = true): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SubtitlesError('Bilibili 字幕查询超时，请稍后重试。', 'SUBTITLES_TIMEOUT');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(remaining, REQUEST_TIMEOUT_MS));
    try {
      const response = await this.session.fetch(url, {
        method: 'GET', credentials: api ? 'include' : 'omit', redirect: 'error', cache: 'no-store',
        signal: controller.signal, headers: { Accept: 'application/json', Referer: HOME },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const restricted = [401, 403, 412, 429].includes(response.status);
        throw new SubtitlesError(restricted
          ? `Bilibili 暂时限制字幕读取（HTTP ${response.status}），请打开源视频完成登录或验证后重试。`
          : `Bilibili 字幕服务返回 HTTP ${response.status}，请稍后重试。`,
        restricted ? 'SUBTITLES_VERIFICATION_REQUIRED' : 'SUBTITLES_HTTP_ERROR', restricted);
      }
      const payload = record(await limitedJson(response));
      if (!payload) throw new SubtitlesError('Bilibili 字幕响应格式异常，请稍后重试。', 'SUBTITLES_INVALID_RESPONSE');
      return payload;
    } catch (error) {
      if (error instanceof SubtitlesError) throw error;
      throw new SubtitlesError(controller.signal.aborted
        ? 'Bilibili 字幕查询超时，请检查网络后重试。'
        : '无法连接 Bilibili 字幕服务，请检查网络后重试。',
      controller.signal.aborted ? 'SUBTITLES_TIMEOUT' : 'SUBTITLES_NETWORK_ERROR');
    } finally { clearTimeout(timeout); }
  }

  private apiData(payload: Record<string, unknown>): Record<string, unknown> {
    if (payload.code !== 0) {
      const restricted = [-101, -111, -352, -403, -412, -509].includes(Number(payload.code));
      throw new SubtitlesError(restricted
        ? `Bilibili 需要登录或验证（${String(payload.code)}），请打开源视频完成后重试。`
        : `Bilibili 无法读取该视频字幕（${typeof payload.code === 'number' ? payload.code : '响应异常'}），请打开源视频检查。`,
      restricted ? 'SUBTITLES_VERIFICATION_REQUIRED' : 'SUBTITLES_API_ERROR', restricted);
    }
    const data = record(payload.data);
    if (!data) throw new SubtitlesError('Bilibili 字幕信息格式异常。', 'SUBTITLES_INVALID_RESPONSE');
    return data;
  }

  private getWbiKeys(deadline: number): Promise<WbiKeys> {
    if (this.keys && this.keys.expiresAt > Date.now()) return Promise.resolve(this.keys);
    if (this.pendingKeys) return this.pendingKeys;
    const promise = this.fetchJson(`${API_ORIGIN}/x/web-interface/nav`, deadline).then(payload => {
      // Anonymous nav legitimately returns -101 while exposing public WBI image keys.
      if (payload.code !== 0 && payload.code !== -101) this.apiData(payload);
      const images = record(record(payload.data)?.wbi_img);
      if (typeof images?.img_url !== 'string' || images.img_url.length > 2048
        || typeof images.sub_url !== 'string' || images.sub_url.length > 2048) {
        throw new SubtitlesError('Bilibili 未返回可用的字幕签名信息，请稍后重试。', 'SUBTITLES_INVALID_RESPONSE');
      }
      try { buildWbiQuery({}, images.img_url, images.sub_url); }
      catch { throw new SubtitlesError('Bilibili 字幕签名信息格式异常，请稍后重试。', 'SUBTITLES_INVALID_RESPONSE'); }
      const keys = { imgUrl: images.img_url, subUrl: images.sub_url, expiresAt: Date.now() + 30 * 60 * 1000 };
      this.keys = keys;
      return keys;
    }).finally(() => { if (this.pendingKeys === promise) this.pendingKeys = null; });
    this.pendingKeys = promise;
    return promise;
  }

  private async readSubtitles(request: LyricsRequest): Promise<LyricsLookupResult> {
    const deadline = Date.now() + TIMEOUT_MS;
    const { song } = request;
    const view = this.apiData(await this.fetchJson(`${API_ORIGIN}/x/web-interface/view?bvid=${song.bvid}`, deadline));
    const pages = view.pages;
    const firstPage = Array.isArray(pages) && pages.length > 0 ? record(pages[0]) : null;
    const cid = firstPage?.cid ?? view.cid;
    if (!positiveInteger(cid) || !positiveInteger(view.aid)) throw new SubtitlesError('Bilibili 未返回有效的视频分段信息。', 'SUBTITLES_INVALID_RESPONSE');
    const keys = await this.getWbiKeys(deadline);
    const query = buildWbiQuery({ bvid: song.bvid, cid, aid: view.aid }, keys.imgUrl, keys.subUrl);
    const player = this.apiData(await this.fetchJson(`${API_ORIGIN}/x/player/wbi/v2?${query}`, deadline));
    const subtitle = record(player.subtitle);
    const candidates = subtitle?.subtitles;
    if (!Array.isArray(candidates) || candidates.length > 100) throw new SubtitlesError('Bilibili 字幕列表格式异常，请稍后重试。', 'SUBTITLES_INVALID_RESPONSE');
    const items = candidates.map(subtitleDescriptor).filter(item => item !== null);
    const selected = selectSubtitle(items);
    if (!selected) {
      if (player.need_login_subtitle === true) return {
        provider: 'bilibili', query: '', match: null, requiresLogin: true,
        message: 'Bilibili 要求登录后才能读取该视频字幕，请打开源视频登录后重试。这里只读取已有字幕，不会为视频自动生成字幕。',
      };
      if (candidates.length > 0) throw new SubtitlesError('Bilibili 提供的字幕地址或格式暂不支持，无法安全读取。', 'SUBTITLES_UNSUPPORTED');
      return { provider: 'bilibili', query: '', match: null, message: 'Bilibili 暂未向当前会话提供该视频的可用字幕。这里只读取已有字幕，无法为视频自动生成字幕；也可以登录后重试。' };
    }
    const payload = await this.fetchJson(selected.url, deadline, false);
    let lyrics;
    try { lyrics = subtitleBodyToLyrics(payload); }
    catch (error) { throw new SubtitlesError(error instanceof Error ? error.message : 'Bilibili 字幕内容格式异常。', 'SUBTITLES_INVALID_RESPONSE'); }
    const info = { language: selected.language, label: selected.label, isAI: selected.isAI };
    if (!lyrics.plainLyrics) return { provider: 'bilibili', query: '', match: null, subtitle: info, message: '该视频的字幕文件没有可显示的文字。这里只读取已有字幕，不会自动生成字幕。' };
    const duration = typeof firstPage?.duration === 'number' && Number.isFinite(firstPage.duration) && firstPage.duration > 0 && firstPage.duration <= 86_400
      ? firstPage.duration : song.duration || lyrics.duration;
    return {
      provider: 'bilibili', query: '', subtitle: info,
      message: selected.isAI ? undefined : '该视频提供的是 UP 主字幕。',
      match: { id: cid, trackName: song.title, artistName: '', albumName: '', duration,
        instrumental: false, syncedLyrics: lyrics.syncedLyrics, plainLyrics: lyrics.plainLyrics },
    };
  }
}
