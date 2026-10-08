import { EventEmitter } from 'node:events';
import { BrowserWindow, type Session } from 'electron';
import { isBilibiliUrl } from './bilibili';
import type { PlaybackStatus, Song } from './types';

export class PlaybackError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requiresVerification = false,
  ) {
    super(message);
    this.name = 'PlaybackError';
  }
}

export interface BackgroundPlayerOptions {
  session: Session;
  parent?: BrowserWindow;
  onStatus?: (status: PlaybackStatus) => void;
  onEnded?: (song: Song) => void;
}

type PageCommand = 'read' | 'play' | 'pause' | 'seek' | 'volume';

interface PageSnapshot {
  found: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  playing: boolean;
  mediaError: number;
  playError?: string;
  blocked?: string;
  navigationMismatch?: boolean;
}

interface PlaybackWaiter {
  generation: number;
  resolve: (status: PlaybackStatus) => void;
  reject: (error: PlaybackError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs in a sandboxed Bilibili page. It reads the native media element rather than
 * extracting media URLs. The capture handler keeps Bilibili's own auto-next from
 * competing with the application's queue after this video finishes.
 */
function pageScript(command: PageCommand, bvid: string, volume: number, value?: number): string {
  const parameters = JSON.stringify({ command, bvid, volume, value });
  return `(async () => {
    const args = ${parameters};
    const empty = { found: false, paused: true, ended: false, currentTime: 0, duration: 0, readyState: 0, playing: false, mediaError: 0 };
    if (!location.pathname.includes('/video/' + args.bvid)) return { ...empty, navigationMismatch: true };
    const key = '__biliMusicNativeMedia';
    const memory = window[key] || (window[key] = { video: null, ended: false, error: 0, volume: args.volume, playing: false, lastTime: 0 });
    if (!memory.captureInstalled) {
      window.addEventListener('ended', (event) => {
        if (event.target !== memory.video) return;
        memory.ended = true;
        memory.video.pause();
        event.stopImmediatePropagation();
      }, true);
      memory.captureInstalled = true;
    }
    const video = document.querySelector('.bpx-player-video-wrap video')
      || document.querySelector('.bilibili-player-video video')
      || document.querySelector('video');
    if (!video) {
      const body = (document.body?.innerText || '').slice(0, 12000);
      const reasons = ['412 Precondition Failed', '403 Forbidden', '安全验证', '人机验证', '访问异常', '访问受限', '请求被拦截', '登录后观看', '视频已失效', '视频已删除', '视频不见了', '应版权方要求', '所在地区不可用'];
      return { ...empty, blocked: reasons.find((reason) => body.includes(reason)) };
    }
    if (memory.video !== video) {
      memory.video = video;
      memory.ended = false;
      memory.error = 0;
      memory.playing = false;
      memory.lastTime = video.currentTime;
      video.volume = memory.volume;
      video.addEventListener('error', () => { if (memory.video === video) memory.error = video.error?.code || 0; });
      video.addEventListener('playing', () => { if (memory.video === video) memory.playing = true; });
      for (const event of ['pause', 'waiting', 'stalled', 'ended']) {
        video.addEventListener(event, () => { if (memory.video === video) memory.playing = false; });
      }
    }
    if (args.command === 'volume') {
      memory.volume = args.value;
      video.volume = args.value;
    }
    if (args.command === 'pause') video.pause();
    if (args.command === 'seek') {
      const maximum = Number.isFinite(video.duration) ? video.duration : args.value;
      video.currentTime = Math.max(0, Math.min(args.value, maximum));
      memory.ended = false;
    }
    let playError;
    if (args.command === 'play') {
      memory.ended = false;
      memory.volume = args.volume;
      video.volume = args.volume;
      video.muted = false;
      let playTimer;
      try {
        await Promise.race([
          video.play(),
          new Promise((_, reject) => { playTimer = setTimeout(() => reject(new Error('视频仍在缓冲，请稍后重试。')), 8000); })
        ]);
        memory.playing = !video.paused;
      } catch (error) { playError = error?.message || String(error); }
      finally { clearTimeout(playTimer); }
    }
    if (!video.paused && video.currentTime > memory.lastTime + 0.01) memory.playing = true;
    memory.lastTime = video.currentTime;
    return {
      found: true,
      paused: video.paused,
      ended: memory.ended || video.ended,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      readyState: video.readyState,
      playing: memory.playing,
      mediaError: video.error?.code || memory.error,
      playError,
    };
  })()`;
}

/** Independent remote window: the app's own renderer never loads Bilibili scripts. */
export class BackgroundPlayer extends EventEmitter {
  private window: BrowserWindow | null = null;
  private generation = 0;
  // Seeking does not start a new playback request or invalidate its waiter.
  // It does invalidate media snapshots captured before the new position.
  private positionRevision = 0;
  private disposed = false;
  private desiredPlayback = false;
  private startAttempted = false;
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiter: PlaybackWaiter | null = null;
  private lastPublished = '';
  private missingSince: number | null = null;
  private stalledSince: number | null = null;
  private status: PlaybackStatus = {
    state: 'idle', song: null, currentTime: 0, duration: 0, volume: 0.75, error: null,
  };

  constructor(private readonly options: BackgroundPlayerOptions) {
    super();
    if (options.onStatus) this.on('status', options.onStatus);
    if (options.onEnded) this.on('ended', options.onEnded);
  }

  getStatus(): PlaybackStatus {
    return { ...this.status, song: this.status.song ? { ...this.status.song } : null };
  }

  private publish(force = false): void {
    const signature = JSON.stringify({ ...this.status, currentTime: Math.round(this.status.currentTime * 20) / 20 });
    if (!force && signature === this.lastPublished) return;
    this.lastPublished = signature;
    this.emit('status', this.getStatus());
  }

  private createWindow(): BrowserWindow {
    if (this.disposed) throw new PlaybackError('播放器已关闭。', 'PLAYER_DISPOSED');
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 1100, height: 760, minWidth: 760, minHeight: 560, show: false,
      title: 'Bilibili · 音频来源', autoHideMenuBar: true,
      ...(this.options.parent ? { parent: this.options.parent } : {}),
      webPreferences: {
        session: this.options.session,
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.window = window;
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(({ url }) => {
      // Source links never get privileged app windows. Open a Bilibili login page
      // only on an explicit click and retain the shared browser session.
      if (isBilibiliUrl(url)) {
        this.desiredPlayback = false;
        window.webContents.setAudioMuted(true);
        if (this.status.song) this.fail(new PlaybackError('源视频页面已切换，请重新选择歌曲播放。', 'SOURCE_PAGE_CHANGED'), this.generation);
        void window.loadURL(url).catch(() => undefined);
        window.show();
      }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!isBilibiliUrl(url)) event.preventDefault();
      else if (this.status.song && !url.includes(`/video/${this.status.song.bvid}`)) {
        this.fail(new PlaybackError('源视频页面已切换，请重新选择歌曲播放。', 'SOURCE_PAGE_CHANGED'), this.generation);
      }
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (!isBilibiliUrl(url)) event.preventDefault();
      else if (this.status.song && !url.includes(`/video/${this.status.song.bvid}`)) {
        this.fail(new PlaybackError('Bilibili 跳转到了其他页面，请打开源视频检查登录或验证。', 'SOURCE_PAGE_CHANGED', true), this.generation);
      }
    });
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !this.status.song || !url.includes(this.status.song.bvid)) return;
      this.fail(new PlaybackError(`Bilibili 视频页加载失败：${description}（${code}）。`, 'PAGE_LOAD_FAILED'), this.generation);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.fail(new PlaybackError(`Bilibili 播放进程已退出（${details.reason}），请重新播放。`, 'MEDIA_PROCESS_EXITED'), this.generation);
    });
    window.on('close', (event) => {
      if (this.disposed) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => { if (this.window === window) this.window = null; });
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.poll(); }, 100);
    return window;
  }

  private rejectWaiter(error: PlaybackError): void {
    const pending = this.waiter;
    this.waiter = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private awaitPlayback(generation: number): Promise<PlaybackStatus> {
    this.rejectWaiter(new PlaybackError('已切换到新的播放请求。', 'PLAYBACK_INTERRUPTED'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new PlaybackError(
          '视频未能在 45 秒内开始播放。请打开 Bilibili 源视频检查登录、验证、版权限制或网络情况。',
          'PLAYBACK_TIMEOUT', true,
        ), generation);
      }, 45_000);
      this.waiter = { generation, resolve, reject, timer };
    });
  }

  private async readPage(command: PageCommand = 'read', value?: number): Promise<PageSnapshot | null> {
    const window = this.window;
    const song = this.status.song;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !song) return null;
    // executeJavaScript otherwise waits behind a navigation and can hold pause
    // or the polling lock indefinitely while an unreachable page is loading.
    if (window.webContents.isLoadingMainFrame()) return null;
    const script = pageScript(command, song.bvid, this.status.volume, value);
    return await window.webContents.executeJavaScript(script, command === 'play') as PageSnapshot;
  }

  private fail(error: PlaybackError, generation: number): void {
    if (generation !== this.generation || this.disposed) return;
    this.desiredPlayback = false;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.setAudioMuted(true);
    this.status = { ...this.status, state: 'error', error: error.message, errorCode: error.code };
    this.rejectWaiter(error);
    this.publish();
    void this.readPage('pause').catch(() => undefined);
  }

  private async startNativePlayback(generation: number): Promise<void> {
    const positionRevision = this.positionRevision;
    this.startAttempted = true;
    try {
      const snapshot = await this.readPage('play');
      if (generation !== this.generation || !this.desiredPlayback || this.disposed) return;
      if (positionRevision !== this.positionRevision) {
        this.startAttempted = false;
        return;
      }
      if (snapshot?.playError && snapshot.paused) {
        this.fail(new PlaybackError(
          `Bilibili 视频无法开始播放：${snapshot.playError}。可打开源视频完成登录或手动播放后重试。`,
          'AUTOPLAY_FAILED', true,
        ), generation);
        return;
      }
      if (snapshot) await this.consume(snapshot, generation);
    } catch {
      // During navigation the JavaScript context can disappear. The main-frame
      // load handler or the bounded playback wait supplies the final error.
      if (generation === this.generation) this.startAttempted = false;
    }
  }

  private async consume(snapshot: PageSnapshot, generation: number): Promise<void> {
    if (generation !== this.generation || this.disposed || !this.status.song) return;
    if (snapshot.navigationMismatch) {
      if (!this.window?.webContents.isLoadingMainFrame() && !['idle', 'error', 'ended'].includes(this.status.state)) {
        this.fail(new PlaybackError('源视频页面已切换，请重新选择歌曲播放。', 'SOURCE_PAGE_CHANGED'), generation);
      }
      return;
    }
    if (!snapshot.found) {
      if (snapshot.blocked && this.desiredPlayback) {
        this.fail(new PlaybackError(`Bilibili 提示「${snapshot.blocked}」，请打开源视频处理后重试。`, 'SOURCE_RESTRICTED', true), generation);
      } else if (!this.waiter) {
        this.missingSince ??= Date.now();
        if (Date.now() - this.missingSince > 12_000) {
          this.fail(new PlaybackError('Bilibili 页面中的播放器已不可用，请重新播放或打开源视频检查。', 'MEDIA_DISAPPEARED'), generation);
        }
      }
      return;
    }
    this.missingSince = null;
    if (snapshot.mediaError) {
      const causes: Record<number, string> = {
        1: '播放被中断', 2: '音视频网络请求失败', 3: '浏览器无法解码此视频', 4: '视频源不可用或当前浏览器不支持该格式',
      };
      this.fail(new PlaybackError(`Bilibili ${causes[snapshot.mediaError] || '媒体播放失败'}，请在源视频页面检查。`, 'MEDIA_ERROR'), generation);
      return;
    }
    this.status.currentTime = snapshot.currentTime;
    if (snapshot.duration > 0) this.status.duration = snapshot.duration;
    if (snapshot.ended) {
      if (this.status.state === 'ended') return;
      this.desiredPlayback = false;
      const song = { ...this.status.song };
      this.status = { ...this.status, state: 'ended', error: null, errorCode: undefined };
      this.rejectWaiter(new PlaybackError('视频已经结束。', 'MEDIA_ENDED'));
      this.publish();
      this.emit('ended', song);
      return;
    }
    if (this.desiredPlayback && !snapshot.paused && snapshot.readyState >= 2 && snapshot.playing) {
      this.stalledSince = null;
      if (this.window && !this.window.isDestroyed()) this.window.webContents.setAudioMuted(false);
      this.status = { ...this.status, state: 'playing', error: null, errorCode: undefined };
      const pending = this.waiter;
      if (pending?.generation === generation) {
        clearTimeout(pending.timer);
        this.waiter = null;
        pending.resolve(this.getStatus());
      }
      this.publish();
      return;
    }
    if (this.desiredPlayback && this.waiter && !this.startAttempted) {
      void this.startNativePlayback(generation);
      return;
    }
    if (this.desiredPlayback && !snapshot.paused && !snapshot.playing) {
      this.stalledSince ??= Date.now();
      this.status.state = 'loading';
      if (Date.now() - this.stalledSince > 30_000) {
        this.fail(new PlaybackError('Bilibili 视频长时间缓冲，请检查网络或打开源视频后重试。', 'MEDIA_BUFFER_TIMEOUT'), generation);
      }
    } else {
      this.stalledSince = null;
    }
    if (!this.desiredPlayback && !snapshot.paused) {
      await this.readPage('pause');
      return;
    }
    if (snapshot.paused && this.desiredPlayback && !this.waiter && ['playing', 'loading'].includes(this.status.state)) {
      // Honor a pause made in the visible source player too.
      this.desiredPlayback = false;
      this.status.state = 'paused';
    }
    this.publish();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed || !this.status.song || ['idle', 'error', 'ended'].includes(this.status.state)) return;
    const generation = this.generation;
    const positionRevision = this.positionRevision;
    this.polling = true;
    try {
      const snapshot = await this.readPage();
      if (snapshot && positionRevision === this.positionRevision) await this.consume(snapshot, generation);
    } catch {
      // Loading/navigating a page temporarily destroys its execution context.
      if (generation === this.generation && positionRevision === this.positionRevision && !this.waiter) {
        this.missingSince ??= Date.now();
        if (Date.now() - this.missingSince > 12_000) {
          this.fail(new PlaybackError('无法读取 Bilibili 播放状态，请重新播放。', 'MEDIA_UNREACHABLE'), generation);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async play(song: Song): Promise<PlaybackStatus> {
    if (!song || song.source !== 'bilibili' || !/^BV[0-9a-zA-Z]{10}$/.test(song.bvid)) {
      throw new PlaybackError('这首歌曲没有有效的 Bilibili 视频编号。', 'INVALID_SONG');
    }
    const window = this.createWindow();
    const generation = ++this.generation;
    window.webContents.setAudioMuted(true);
    this.missingSince = null;
    this.stalledSince = null;
    this.desiredPlayback = true;
    this.startAttempted = false;
    this.status = {
      state: 'loading', song: { ...song, url: `https://www.bilibili.com/video/${song.bvid}/` },
      currentTime: 0, duration: song.duration, volume: this.status.volume, error: null,
    };
    const playing = this.awaitPlayback(generation);
    this.publish(true);
    void window.loadURL(this.status.song!.url).then(() => {
      if (generation === this.generation) void this.poll();
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.fail(new PlaybackError(`Bilibili 视频页加载失败：${error instanceof Error ? error.message : '网络错误'}。`, 'PAGE_LOAD_FAILED'), generation);
      }
    });
    return await playing;
  }

  async pause(): Promise<PlaybackStatus> {
    const generation = ++this.generation;
    const positionRevision = this.positionRevision;
    this.desiredPlayback = false;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.setAudioMuted(true);
    this.rejectWaiter(new PlaybackError('播放已暂停。', 'PLAYBACK_INTERRUPTED'));
    if (this.status.song && this.status.state !== 'error') this.status.state = 'paused';
    this.publish();
    try {
      const snapshot = await this.readPage('pause');
      if (generation === this.generation && positionRevision === this.positionRevision && snapshot?.found) {
        this.status.currentTime = snapshot.currentTime;
      }
    } catch {
      // A pause requested during page loading is retained by desiredPlayback.
    }
    if (generation === this.generation && this.status.song && this.status.state !== 'error') this.status.state = 'paused';
    this.publish();
    return this.getStatus();
  }

  async resume(): Promise<PlaybackStatus> {
    if (!this.status.song) throw new PlaybackError('请先选择歌曲。', 'NO_SONG');
    if (this.disposed) throw new PlaybackError('播放器已关闭。', 'PLAYER_DISPOSED');
    if (this.status.state === 'playing') return this.getStatus();
    if (this.status.state === 'error') return this.play(this.status.song);
    if (!this.window || this.window.isDestroyed()) return this.play(this.status.song);
    if (!this.window.webContents.getURL().includes(`/video/${this.status.song.bvid}`)) return this.play(this.status.song);
    const previousGeneration = this.generation;
    if (this.status.state === 'ended') await this.seek(0);
    if (previousGeneration !== this.generation) throw new PlaybackError('已切换到新的播放请求。', 'PLAYBACK_INTERRUPTED');
    const generation = ++this.generation;
    this.missingSince = null;
    this.stalledSince = null;
    this.desiredPlayback = true;
    this.startAttempted = false;
    this.status = { ...this.status, state: 'loading', error: null, errorCode: undefined };
    const playing = this.awaitPlayback(generation);
    this.publish();
    void this.poll();
    return await playing;
  }

  async seek(seconds: number): Promise<PlaybackStatus> {
    if (!Number.isFinite(seconds) || seconds < 0) throw new PlaybackError('播放位置无效。', 'INVALID_POSITION');
    const generation = this.generation;
    const positionRevision = ++this.positionRevision;
    let snapshot: PageSnapshot | null;
    try { snapshot = await this.readPage('seek', seconds); }
    catch { throw new PlaybackError('视频尚未加载，暂时无法调整进度。', 'MEDIA_NOT_READY'); }
    if (!snapshot?.found) throw new PlaybackError('视频尚未加载，暂时无法调整进度。', 'MEDIA_NOT_READY');
    if (generation === this.generation && positionRevision === this.positionRevision) {
      // Also invalidate reads started while the seek was still in flight.
      ++this.positionRevision;
      this.status.currentTime = snapshot.currentTime;
      if (this.status.state === 'ended') this.status.state = 'paused';
      this.publish();
    }
    return this.getStatus();
  }

  async setVolume(volume: number): Promise<PlaybackStatus> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new PlaybackError('音量应在 0 到 1 之间。', 'INVALID_VOLUME');
    this.status.volume = volume;
    try { await this.readPage('volume', volume); }
    catch { /* The stored volume is applied as soon as the media element appears. */ }
    this.publish();
    return this.getStatus();
  }

  openSourceWindow(): BrowserWindow {
    const window = this.createWindow();
    if (!this.status.song && !window.webContents.getURL()) {
      void window.loadURL('https://www.bilibili.com/').catch(() => undefined);
    }
    window.show();
    window.focus();
    return window;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    this.desiredPlayback = false;
    this.rejectWaiter(new PlaybackError('播放器已关闭。', 'PLAYER_DISPOSED'));
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.removeAllListeners();
  }
}
