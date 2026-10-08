import { app, BrowserWindow, dialog, ipcMain, screen, session } from 'electron'
import { isAbsolute, join } from 'node:path'
import { BilibiliService, BilibiliError } from './bilibili'
import { BackgroundPlayer } from './player'
import type { BilibiliAccountStatus, Song } from './types'
import { LyricsService } from './lyrics'
import { BilibiliSubtitlesService } from './subtitles'
import type { LyricsRequest } from './lyrics-types'
import { DesktopLyricsController } from './desktop-lyrics'
import { MusicLibraryStore } from './library-store'
import { LocalPreferencesStore } from './preferences-store'

const explicitDataPath = app.commandLine.getSwitchValue('user-data-dir')
app.setPath('userData', explicitDataPath && isAbsolute(explicitDataPath) ? explicitDataPath : join(app.getPath('appData'), 'YuyinMusic'))
const libraryStore = new MusicLibraryStore(app.getPath('userData'))
const preferencesStore = new LocalPreferencesStore(app.getPath('userData'))

let mainWindow: BrowserWindow | null = null
let service: BilibiliService
let player: BackgroundPlayer
let lyricsService: LyricsService
let subtitlesService: BilibiliSubtitlesService
let desktopLyrics: DesktopLyricsController
let quitCompleted = false
let quitting = false

const isTrustedSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
  !!mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === event.sender.id &&
  event.senderFrame === mainWindow.webContents.mainFrame
const validSong = (value: unknown): value is Song => {
  if (!value || typeof value !== 'object') return false
  const song = value as Partial<Song>
  return typeof song.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(song.bvid) && typeof song.title === 'string' && song.title.length < 500 && typeof song.url === 'string' && song.url === `https://www.bilibili.com/video/${song.bvid}/`
}
const numberInRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

function restoreWindowBounds(window: BrowserWindow, target: Electron.Rectangle): void {
  let requested = { ...target }
  // Native frame/DPI conversion may add pixels even to setBounds. Correct the measured error
  // so saving actual outer dimensions cannot make the window grow on every restart.
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setBounds(requested)
    const actual = window.getBounds()
    if (actual.x === target.x && actual.y === target.y && actual.width === target.width && actual.height === target.height) return
    requested = { x: requested.x + target.x - actual.x, y: requested.y + target.y - actual.y,
      width: Math.max(1080, requested.width + target.width - actual.width),
      height: Math.max(680, requested.height + target.height - actual.height) }
  }
}

function registerIPC() {
  const withLogin = async <T>(operation: () => Promise<T>): Promise<T> => {
    const revision = await service.requireLogin()
    service.assertSessionRevision(revision)
    const result = await operation()
    service.assertSessionRevision(revision)
    return result
  }
  const handlePreference = (event: Electron.IpcMainEvent, key: unknown, write: boolean, value?: unknown) => {
    try {
      if (mainWindow?.webContents.id !== event.sender.id || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('未授权访问设置。')
      if (typeof key !== 'string') throw new Error('设置名称不合法。')
      if (write) {
        if (typeof value !== 'string') throw new Error('设置内容不合法。')
        preferencesStore.write(key, value)
        event.returnValue = { ok: true }
      } else event.returnValue = { ok: true, data: preferencesStore.read(key) }
    } catch (error) { event.returnValue = { ok: false, error: error instanceof Error ? error.message : '设置读写失败，请检查磁盘空间与文件权限。' } }
  }
  ipcMain.on('preferences:read', (event, key: unknown) => handlePreference(event, key, false))
  ipcMain.on('preferences:write', (event, key: unknown, value: unknown) => handlePreference(event, key, true, value))
  const handleLibrary = (event: Electron.IpcMainEvent, write: boolean, data?: unknown) => {
    try {
      if (mainWindow?.webContents.id !== event.sender.id || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('未授权访问音乐库。')
      if (write) {
        if (typeof data !== 'string') throw new Error('音乐库数据格式不合法。')
        libraryStore.write(data)
        event.returnValue = { ok: true }
      } else event.returnValue = { ok: true, data: libraryStore.read() }
    } catch (error) {
      event.returnValue = { ok: false, error: error instanceof Error ? error.message : '音乐库读写失败，请检查磁盘空间与文件权限。' }
    }
  }
  ipcMain.on('library:read', event => handleLibrary(event, false))
  ipcMain.on('library:write', (event, data: unknown) => handleLibrary(event, true, data))
  ipcMain.handle('music:search', async (event, query: unknown, page: unknown = 1) => {
    if (!isTrustedSender(event) || typeof query !== 'string' || query.trim().length < 1 || query.length > 80 || !numberInRange(page, 1, 200)) throw new BilibiliError('搜索参数不合法', 'INVALID_QUERY')
    return withLogin(() => service.search(query.trim(), Math.floor(page)))
  })
  ipcMain.handle('music:play', async (event, song: unknown) => { if (!isTrustedSender(event) || !validSong(song)) throw new Error('歌曲信息不合法'); return withLogin(() => player.play(song)) })
  ipcMain.handle('music:pause', event => { if (!isTrustedSender(event)) throw new Error('未授权'); return player.pause() })
  ipcMain.handle('music:resume', event => { if (!isTrustedSender(event)) throw new Error('未授权'); return withLogin(() => player.resume()) })
  ipcMain.handle('music:seek', (event, seconds: unknown) => { if (!isTrustedSender(event) || !numberInRange(seconds, 0, 24 * 60 * 60)) throw new Error('时间参数不合法'); return player.seek(seconds) })
  ipcMain.handle('music:volume', (event, volume: unknown) => { if (!isTrustedSender(event) || !numberInRange(volume, 0, 1)) throw new Error('音量参数不合法'); return player.setVolume(volume) })
  ipcMain.handle('music:status', event => { if (!isTrustedSender(event)) throw new Error('未授权'); return player.getStatus() })
  ipcMain.handle('music:lyrics', (event, request: unknown) => {
    if (!isTrustedSender(event) || !request || typeof request !== 'object') throw new Error('歌词查询参数不合法')
    const input = request as LyricsRequest
    if (!validSong(input.song) || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 80)) || (input.force !== undefined && typeof input.force !== 'boolean') || (input.provider !== undefined && !['lrclib', 'bilibili'].includes(input.provider))) throw new Error('歌词查询参数不合法')
    return input.provider === 'bilibili' ? subtitlesService.lookup(input) : lyricsService.lookup(input)
  })
  ipcMain.handle('music:login', event => { if (!isTrustedSender(event)) throw new Error('未授权'); service.openLoginWindow(mainWindow ?? undefined) })
  ipcMain.handle('music:bilibili-account', event => { if (!isTrustedSender(event)) throw new Error('未授权'); return service.getAccount() })
  ipcMain.handle('music:bilibili-profile', event => { if (!isTrustedSender(event)) throw new Error('未授权'); return service.openProfile(mainWindow ?? undefined) })
  ipcMain.handle('music:bilibili-favorite-folders', async event => { if (!isTrustedSender(event)) throw new Error('未授权'); return service.listFavoriteFolders() })
  ipcMain.handle('music:bilibili-favorite-items', async (event, mediaId: unknown, page: unknown = 1) => {
    if (!isTrustedSender(event) || !numberInRange(mediaId, 1, Number.MAX_SAFE_INTEGER) || !numberInRange(page, 1, 1000)) throw new Error('收藏夹参数不合法')
    return service.listFavoriteItems(Math.floor(mediaId), Math.floor(page))
  })
  ipcMain.handle('music:bilibili-favorite-songs', async (event, mediaId: unknown) => {
    if (!isTrustedSender(event) || !numberInRange(mediaId, 1, Number.MAX_SAFE_INTEGER)) throw new Error('收藏夹参数不合法')
    return service.listFavoriteSongs(Math.floor(mediaId))
  })
  ipcMain.handle('music:source', event => { if (!isTrustedSender(event)) throw new Error('未授权'); return withLogin(async () => { player.openSourceWindow() }) })
  ipcMain.handle('library:export', async (event, json: unknown) => {
    if (!isTrustedSender(event) || typeof json !== 'string' || json.length > 2_000_000) return false
    const result = await dialog.showSaveDialog(mainWindow!, { title: '导出我的音乐库', defaultPath: '余音音乐库.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return false
    const { writeFile } = await import('node:fs/promises'); await writeFile(result.filePath, json, 'utf8'); return true
  })
  ipcMain.handle('library:import', async event => {
    if (!isTrustedSender(event)) throw new Error('未授权')
    const result = await dialog.showOpenDialog(mainWindow!, { title: '导入我的音乐库', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const { readFile } = await import('node:fs/promises'); const json = await readFile(result.filePaths[0], 'utf8'); return json.length <= 2_000_000 ? json : null
  })
  ipcMain.on('window:minimize', event => { if (isTrustedSender(event)) mainWindow?.minimize() })
  ipcMain.on('window:maximize', event => { if (isTrustedSender(event)) mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize() })
  ipcMain.on('window:close', event => { if (isTrustedSender(event)) mainWindow?.close() })
}

async function createWindow() {
  let windowState: { bounds: Electron.Rectangle; maximized: boolean } | null = null
  try {
    const saved = preferencesStore.read('yuyin-window-state-v1')
    if (saved) {
      const parsed = JSON.parse(saved)
      const area = screen.getDisplayMatching(parsed.bounds).workArea
      const width = Math.max(1080, Math.min(parsed.bounds.width, area.width))
      const height = Math.max(680, Math.min(parsed.bounds.height, area.height))
      windowState = { bounds: { width, height,
        x: Math.min(Math.max(parsed.bounds.x, area.x), Math.max(area.x, area.x + area.width - width)),
        y: Math.min(Math.max(parsed.bounds.y, area.y), Math.max(area.y, area.y + area.height - height)),
      }, maximized: parsed.maximized }
    }
  } catch { /* Renderer startup reports unreadable preferences; existing files stay protected. */ }
  const biliSession = session.fromPartition('persist:bili-music')
  biliSession.setUserAgent(app.userAgentFallback.replace(/\sElectron\/\S+/g, '').replace(/\syuyin-music\/\S+/g, ''))
  biliSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow = new BrowserWindow({ width: 1440, height: 950, ...windowState?.bounds, minWidth: 1080, minHeight: 680, show: false, icon: join(__dirname, '../renderer/icon.png'), backgroundColor: '#f7f8f5', titleBarStyle: 'hidden', titleBarOverlay: { color: '#f7f8f5', symbolColor: '#667267', height: 34 }, webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  // Windows can add DPI-rounded frame pixels during construction; restore the measured outer bounds.
  if (windowState) restoreWindowBounds(mainWindow, windowState.bounds)
  if (windowState?.maximized) mainWindow.maximize()
  const window = mainWindow
  let windowSaveTimer: ReturnType<typeof setTimeout> | null = null
  const saveWindow = () => {
    if (windowSaveTimer) clearTimeout(windowSaveTimer)
    windowSaveTimer = null
    if (window.isDestroyed()) return
    try { preferencesStore.write('yuyin-window-state-v1', JSON.stringify({ version: 1, bounds: window.getNormalBounds(), maximized: window.isMaximized() })) }
    catch (error) { window.webContents.send('preferences:error', error instanceof Error ? error.message : '保存窗口位置失败。') }
  }
  const scheduleWindowSave = () => {
    if (windowSaveTimer) clearTimeout(windowSaveTimer)
    windowSaveTimer = setTimeout(saveWindow, 300)
  }
  window.on('move', scheduleWindowSave)
  window.on('resize', scheduleWindowSave)
  window.on('maximize', scheduleWindowSave)
  window.on('unmaximize', scheduleWindowSave)
  window.on('close', saveWindow)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  service = new BilibiliService(biliSession)
  lyricsService = new LyricsService(session.fromPartition('lyrics'))
  subtitlesService = new BilibiliSubtitlesService(biliSession)
  player = new BackgroundPlayer({ session: biliSession, parent: mainWindow })
  desktopLyrics = new DesktopLyricsController({ isMainSender: isTrustedSender, getCurrentBvid: () => player.getStatus().song?.bvid ?? null })
  await desktopLyrics.setSessionAvailable(false)
  const applySessionAvailability = (available: boolean) => {
    // Even a paused song can have resume() awaiting a native snapshot. Advance the
    // player's generation on invalidation so that pending resume cannot start later.
    if (!available && player.getStatus().song) void player.pause().catch(() => undefined)
    void desktopLyrics.setSessionAvailable(available).catch(error => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preferences:error', error instanceof Error ? error.message : '更新桌面歌词状态失败。')
    })
  }
  service.on('account-status', (status: BilibiliAccountStatus) => applySessionAvailability(status.loggedIn))
  service.on('session-invalidated', () => applySessionAvailability(false))
  service.on('session-changed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bilibili:session-changed') })
  desktopLyrics.on('snapshot', snapshot => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-lyrics:snapshot', snapshot) })
  desktopLyrics.registerIPC()
  player.on('status', status => mainWindow?.webContents.send('music:status', status))
  player.on('ended', () => mainWindow?.webContents.send('music:ended'))
  mainWindow.on('closed', () => { mainWindow = null; player.dispose(); service.dispose(); app.quit() })
  registerIPC()
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  await desktopLyrics.initialize()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })
  app.whenReady().then(createWindow).catch(error => { dialog.showErrorBox('余音无法启动', error instanceof Error ? error.message : String(error)); app.quit() })
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (quitCompleted) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  player?.dispose(); service?.dispose()
  void Promise.resolve(desktopLyrics?.dispose()).finally(() => { quitCompleted = true; app.quit() })
})
app.on('activate', () => { if (!mainWindow) void createWindow() })
