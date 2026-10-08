import { BrowserWindow, type Session } from 'electron';
import { EventEmitter } from 'node:events';
import type { BilibiliAccountStatus, BilibiliFavoriteFolder, BilibiliFavoriteFoldersResult, BilibiliFavoriteItemsResult, BilibiliFavoriteSongsResult, SearchResult, Song } from './types';
import { BilibiliAccountSession, BilibiliError, isAuthenticationCookie } from './account';
export { BilibiliError } from './account';

const SEARCH_ENDPOINT = 'https://api.bilibili.com/x/web-interface/search/type';
const NAV_ENDPOINT = 'https://api.bilibili.com/x/web-interface/nav';
const FAVORITE_FOLDER_ENDPOINT = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all';
const FAVORITE_RESOURCE_ENDPOINT = 'https://api.bilibili.com/x/v3/fav/resource/list';
const BILIBILI_HOME = 'https://www.bilibili.com/';
const BILIBILI_LOGIN = 'https://passport.bilibili.com/login';
const PAGE_SIZE = 20;

interface SearchVideo {
  bvid?: unknown;
  title?: unknown;
  author?: unknown;
  pic?: unknown;
  duration?: unknown;
  play?: unknown;
}

interface SearchResponse {
  code?: number;
  message?: string;
  data?: {
    result?: SearchVideo[];
    numResults?: number;
    numPages?: number;
    pagesize?: number;
  };
}

interface FavoriteFolderResponse {
  code?: number;
  message?: string;
  data?: { count?: number; list?: Array<Record<string, unknown>> };
}

interface FavoriteResourceResponse {
  code?: number;
  message?: string;
  data?: {
    info?: Record<string, unknown>;
    medias?: Array<Record<string, unknown>>;
  };
}

function plainText(value: unknown): string {
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

function durationSeconds(value: unknown): number {
  if (typeof value === 'number') return Math.max(0, value);
  if (typeof value !== 'string') return 0;
  const parts = value.split(':').map(Number);
  return parts.every(Number.isFinite)
    ? parts.reduce((total, part) => total * 60 + Math.max(0, part), 0)
    : 0;
}

function playCount(value: unknown): number {
  if (typeof value === 'number') return Math.max(0, value);
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value.replace(/,/g, ''));
  const scale = value.includes('亿') ? 100_000_000 : value.includes('万') ? 10_000 : 1;
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * scale)) : 0;
}

function videoToSong(item: SearchVideo): Song | null {
  if (typeof item.bvid !== 'string' || !/^BV[0-9a-zA-Z]{10}$/.test(item.bvid)) return null;
  let cover = typeof item.pic === 'string' ? item.pic : '';
  if (cover.startsWith('//')) cover = `https:${cover}`;
  if (!cover.startsWith('https://')) cover = '';
  return {
    id: item.bvid,
    bvid: item.bvid,
    title: plainText(item.title) || item.bvid,
    artist: plainText(item.author) || 'Bilibili UP 主',
    cover,
    duration: durationSeconds(item.duration),
    playCount: playCount(item.play),
    source: 'bilibili',
    url: `https://www.bilibili.com/video/${item.bvid}/`,
  };
}

function favoriteVideoToSong(item: Record<string, unknown>): Song | null {
  const bvid = typeof item.bvid === 'string' ? item.bvid : typeof item.bv_id === 'string' ? item.bv_id : '';
  if (!/^BV[0-9a-zA-Z]{10}$/.test(bvid)) return null;
  let cover = typeof item.cover === 'string' ? item.cover : typeof item.pic === 'string' ? item.pic : '';
  if (cover.startsWith('//')) cover = `https:${cover}`;
  if (!cover.startsWith('https://')) cover = '';
  const upper = item.upper && typeof item.upper === 'object' && !Array.isArray(item.upper)
    ? item.upper as Record<string, unknown> : null;
  const duration = durationSeconds(item.duration);
  const play = playCount(item.play);
  return {
    id: bvid, bvid,
    title: plainText(item.title) || bvid,
    artist: plainText(upper?.name) || plainText(item.author) || 'Bilibili UP 主',
    cover, duration, playCount: play, source: 'bilibili',
    url: `https://www.bilibili.com/video/${bvid}/`,
  };
}

export function isBilibiliUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'));
  } catch {
    return false;
  }
}

/** Uses the supplied persistent browser session; no third-party audio extraction or verification bypass. */
export class BilibiliService extends EventEmitter {
  private loginWindow: BrowserWindow | null = null;
  private sessionReady: Promise<void> | null = null;
  private readonly accountSession: BilibiliAccountSession;
  private sessionChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private confirmedMid: number | null | undefined;
  private readonly cookieChanged = (_event: Electron.Event, cookie: Electron.Cookie) => {
    if (!isAuthenticationCookie(cookie) || this.disposed) return;
    this.accountSession.invalidate();
    this.emit('session-invalidated');
    this.scheduleSessionChanged();
  };

  constructor(private readonly session: Session) {
    super();
    this.accountSession = new BilibiliAccountSession(() => this.fetchAccountPayload(), status => {
      if (this.disposed) return;
      const mid = status.loggedIn ? status.account.mid : null;
      if (this.confirmedMid !== undefined && this.confirmedMid !== mid) this.emit('session-invalidated');
      this.confirmedMid = mid;
      this.emit('account-status', status);
    });
    this.session.cookies.on('changed', this.cookieChanged);
  }

  private scheduleSessionChanged(): void {
    if (this.disposed) return;
    if (this.sessionChangedTimer) clearTimeout(this.sessionChangedTimer);
    this.sessionChangedTimer = setTimeout(() => {
      this.sessionChangedTimer = null;
      if (!this.disposed) this.emit('session-changed');
    }, 250);
  }

  private async fetchAccountPayload(): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.session.fetch(NAV_ENDPOINT, {
        credentials: 'include', signal: controller.signal,
        headers: { Accept: 'application/json', Referer: BILIBILI_HOME },
      });
      if (!response.ok) {
        const restricted = [401, 403, 412, 429].includes(response.status);
        throw new BilibiliError(
          restricted ? `Bilibili 需要验证（HTTP ${response.status}），请打开登录窗口完成后重试。`
            : `Bilibili 登录状态服务返回 HTTP ${response.status}，请稍后重试。`,
          restricted ? 'BILIBILI_VERIFICATION_REQUIRED' : 'BILIBILI_HTTP_ERROR', restricted,
        );
      }
      try { return await response.json(); }
      catch { throw new BilibiliError('Bilibili 返回了验证页面，请打开登录窗口完成验证后重试。', 'BILIBILI_VERIFICATION_REQUIRED', true); }
    } catch (error) {
      if (error instanceof BilibiliError) throw error;
      throw new BilibiliError(controller.signal.aborted ? 'Bilibili 登录状态验证超时，请检查网络后重试。'
        : '无法连接 Bilibili 登录状态服务，请检查网络后重试。', controller.signal.aborted ? 'ACCOUNT_TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timeout); }
  }

  getAccount(): Promise<BilibiliAccountStatus> { return this.accountSession.getStatus(); }
  async requireLogin(): Promise<number> { return (await this.accountSession.requireLoggedIn()).revision; }
  getSessionRevision(): number { return this.accountSession.getRevision(); }
  assertSessionRevision(revision: number): void { this.accountSession.assertRevision(revision); }

  async openProfile(parent?: BrowserWindow): Promise<void> {
    const permit = await this.accountSession.requireLoggedIn();
    this.accountSession.assertRevision(permit.revision);
    this.openAccountWindow(parent, `https://space.bilibili.com/${permit.account.mid}`);
  }

  private initializeSession(): Promise<void> {
    if (!this.sessionReady) {
      this.sessionReady = (async () => {
        // The real website may set ordinary session cookies required by the public search API.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          await this.session.fetch(BILIBILI_HOME, {
            signal: controller.signal,
            credentials: 'include',
          });
        } catch {
          // Search still gets a chance to return its own actionable error.
        } finally {
          clearTimeout(timeout);
        }
      })();
    }
    return this.sessionReady;
  }

  async search(query: string, page = 1): Promise<SearchResult> {
    const keyword = query.trim();
    if (!keyword || keyword.length > 200) {
      throw new BilibiliError('请输入 1 到 200 个字符的歌曲或歌手名称。', 'INVALID_QUERY');
    }
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) {
      throw new BilibiliError('搜索页码无效。', 'INVALID_PAGE');
    }
    const revision = await this.requireLogin();
    await this.initializeSession();
    const url = new URL(SEARCH_ENDPOINT);
    url.search = new URLSearchParams({
      search_type: 'video', keyword, order: 'totalrank', page: String(page), page_size: String(PAGE_SIZE),
    }).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.session.fetch(url.toString(), {
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json', Referer: BILIBILI_HOME },
      });
      if (!response.ok) {
        const restricted = [401, 403, 412, 429].includes(response.status);
        throw new BilibiliError(
          restricted
            ? `Bilibili 暂时限制搜索（HTTP ${response.status}）。请打开 Bilibili 完成登录或验证后重试。`
            : `Bilibili 搜索服务返回 HTTP ${response.status}，请稍后重试。`,
          restricted ? 'BILIBILI_VERIFICATION_REQUIRED' : 'BILIBILI_HTTP_ERROR',
          restricted,
        );
      }
      let payload: SearchResponse;
      try {
        payload = await response.json() as SearchResponse;
      } catch {
        throw new BilibiliError('Bilibili 返回了验证页面，请打开 Bilibili 完成验证后重试。', 'BILIBILI_VERIFICATION_REQUIRED', true);
      }
      if (payload.code !== 0) {
        const restricted = [-101, -111, -352, -403, -412, -509].includes(payload.code ?? 0);
        throw new BilibiliError(
          restricted
            ? `Bilibili 需要登录或验证（${payload.code}），请打开源站完成后重试。`
            : `Bilibili 搜索失败：${plainText(payload.message) || '响应格式异常'}（${payload.code ?? '未知'}）。`,
          restricted ? 'BILIBILI_VERIFICATION_REQUIRED' : 'BILIBILI_API_ERROR',
          restricted,
        );
      }
      if (!payload.data || !Array.isArray(payload.data.result)) {
        throw new BilibiliError('Bilibili 搜索结果格式已变化，请稍后重试。', 'BILIBILI_INVALID_RESPONSE');
      }
      const songs = payload.data.result.map(videoToSong).filter((song): song is Song => song !== null);
      const total = Math.max(0, Number(payload.data.numResults) || songs.length);
      const pageSize = Math.max(1, Number(payload.data.pagesize) || PAGE_SIZE);
      const pages = Number(payload.data.numPages) || Math.ceil(total / pageSize);
      this.assertSessionRevision(revision);
      return { query: keyword, songs, page, pageSize, total, hasMore: page < pages };
    } catch (error) {
      if (error instanceof BilibiliError) throw error;
      const timedOut = controller.signal.aborted;
      throw new BilibiliError(
        timedOut ? 'Bilibili 搜索超时，请检查网络后重试。' : `无法连接 Bilibili：${error instanceof Error ? error.message : '网络错误'}。`,
        timedOut ? 'SEARCH_TIMEOUT' : 'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
    await this.initializeSession();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.session.fetch(url, {
        credentials: 'include', signal: controller.signal,
        headers: { Accept: 'application/json', Referer: BILIBILI_HOME },
      });
      if (!response.ok) {
        const restricted = [401, 403, 412, 429].includes(response.status);
        throw new BilibiliError(
          restricted
            ? `Bilibili 暂时限制收藏夹读取（HTTP ${response.status}），请打开 Bilibili 完成登录或验证后重试。`
            : `Bilibili 收藏夹服务返回 HTTP ${response.status}，请稍后重试。`,
          restricted ? 'BILIBILI_VERIFICATION_REQUIRED' : 'BILIBILI_HTTP_ERROR', restricted,
        );
      }
      try { return await response.json() as T; }
      catch { throw new BilibiliError('Bilibili 返回了验证页面，请打开 Bilibili 完成登录后重试。', 'BILIBILI_VERIFICATION_REQUIRED', true); }
    } catch (error) {
      if (error instanceof BilibiliError) throw error;
      throw new BilibiliError(controller.signal.aborted ? 'Bilibili 收藏夹查询超时，请稍后重试。' : '无法连接 Bilibili 收藏夹服务，请检查网络后重试。', controller.signal.aborted ? 'FAVORITES_TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timeout); }
  }

  private async loginInfo(): Promise<{ mid: number; username: string; revision: number }> {
    const permit = await this.accountSession.requireLoggedIn();
    return { mid: permit.account.mid, username: permit.account.username, revision: permit.revision };
  }

  async listFavoriteFolders(): Promise<BilibiliFavoriteFoldersResult> {
    const { revision, ...account } = await this.loginInfo();
    const url = new URL(FAVORITE_FOLDER_ENDPOINT);
    url.search = new URLSearchParams({ up_mid: String(account.mid), web_location: '333.1387' }).toString();
    const payload = await this.fetchJson<FavoriteFolderResponse>(url.toString());
    if (payload.code !== 0 || !Array.isArray(payload.data?.list)) {
      throw new BilibiliError(`Bilibili 收藏夹读取失败：${plainText(payload.message) || payload.code || '响应格式异常'}。`, 'FAVORITES_INVALID_RESPONSE');
    }
    const folders: BilibiliFavoriteFolder[] = [];
    for (const entry of payload.data.list.slice(0, 100)) {
      const id = Number(entry.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const title = plainText(entry.title);
      if (!title) continue;
      let cover = typeof entry.cover === 'string' ? entry.cover : '';
      if (cover.startsWith('//')) cover = `https:${cover}`;
      if (!cover.startsWith('https://')) cover = '';
      folders.push({
        id, title, mediaCount: Math.max(0, Number(entry.media_count) || 0), cover,
        description: plainText(entry.intro), isDefault: Number(entry.attr) === 22 || title === '默认收藏夹',
      });
    }
    this.assertSessionRevision(revision);
    return { ...account, account: { mid: account.mid, name: account.username }, folders };
  }

  async listFavoriteItems(mediaId: number, page = 1, pageSize = PAGE_SIZE): Promise<BilibiliFavoriteItemsResult> {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new BilibiliError('收藏夹参数无效。', 'INVALID_FAVORITE_FOLDER');
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new BilibiliError('收藏夹页码无效。', 'INVALID_PAGE');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 40) throw new BilibiliError('收藏夹每页数量无效。', 'INVALID_PAGE_SIZE');
    const { revision } = await this.loginInfo();
    const url = new URL(FAVORITE_RESOURCE_ENDPOINT);
    url.search = new URLSearchParams({ media_id: String(mediaId), pn: String(page), ps: String(pageSize), platform: 'web', web_location: '333.1387' }).toString();
    const payload = await this.fetchJson<FavoriteResourceResponse>(url.toString());
    if (payload.code !== 0 || !payload.data || !Array.isArray(payload.data.medias)) {
      throw new BilibiliError(`Bilibili 收藏夹内容读取失败：${plainText(payload.message) || payload.code || '响应格式异常'}。`, 'FAVORITES_INVALID_RESPONSE');
    }
    const info = payload.data.info ?? {};
    const title = plainText(info.title) || `收藏夹 ${mediaId}`;
    let cover = typeof info.cover === 'string' ? info.cover : '';
    if (cover.startsWith('//')) cover = `https:${cover}`;
    if (!cover.startsWith('https://')) cover = '';
    const folder: BilibiliFavoriteFolder = { id: mediaId, title, mediaCount: Math.max(0, Number(info.media_count) || 0), cover, description: plainText(info.intro), isDefault: Number(info.attr) === 22 || title === '默认收藏夹' };
    const songs = payload.data.medias.map(favoriteVideoToSong).filter((song): song is Song => song !== null);
    const total = folder.mediaCount || (page - 1) * pageSize + songs.length;
    this.assertSessionRevision(revision);
    return { folder, songs, page, pageSize, total, hasMore: page * pageSize < total };
  }

  async listFavoriteSongs(mediaId: number): Promise<BilibiliFavoriteSongsResult> {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new BilibiliError('收藏夹参数无效。', 'INVALID_FAVORITE_FOLDER');
    const revision = await this.requireLogin();
    const first = await this.listFavoriteItems(mediaId, 1, 40);
    const pages = Math.min(100, Math.max(1, Math.ceil(first.total / first.pageSize)));
    const songs = [...first.songs];
    for (let page = 2; page <= pages; page += 1) {
      const result = await this.listFavoriteItems(mediaId, page, first.pageSize);
      songs.push(...result.songs);
      if (!result.hasMore) break;
    }
    const unique: Song[] = [];
    const seen = new Set<string>();
    for (const song of songs) { if (!seen.has(song.bvid)) { seen.add(song.bvid); unique.push(song); } }
    this.assertSessionRevision(revision);
    return { folder: first.folder, songs: unique, skippedCount: Math.max(0, first.total - unique.length), total: first.total };
  }

  openLoginWindow(parent?: BrowserWindow): BrowserWindow {
    return this.openAccountWindow(parent, BILIBILI_LOGIN);
  }

  private openAccountWindow(parent: BrowserWindow | undefined, destination: string): BrowserWindow {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.show();
      this.loginWindow.focus();
      void this.loginWindow.loadURL(destination).catch(() => undefined);
      return this.loginWindow;
    }
    const window = new BrowserWindow({
      width: 1100, height: 760, minWidth: 760, minHeight: 560,
      title: 'Bilibili · 登录与验证',
      ...(parent ? { parent } : {}),
      autoHideMenuBar: true,
      webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.loginWindow = window;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isBilibiliUrl(url)) void window.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!isBilibiliUrl(url)) event.preventDefault();
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (!isBilibiliUrl(url)) event.preventDefault();
    });
    window.webContents.on('did-navigate', (_event, url) => {
      if (isBilibiliUrl(url) && new URL(url).hostname !== 'passport.bilibili.com') this.scheduleSessionChanged();
    });
    window.on('closed', () => {
      if (this.loginWindow === window) this.loginWindow = null;
      this.scheduleSessionChanged();
    });
    void window.loadURL(destination).catch(() => undefined);
    return window;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.accountSession.invalidate();
    this.session.cookies.removeListener('changed', this.cookieChanged);
    if (this.sessionChangedTimer) clearTimeout(this.sessionChangedTimer);
    this.sessionChangedTimer = null;
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.destroy();
    this.loginWindow = null;
    this.removeAllListeners();
  }
}
