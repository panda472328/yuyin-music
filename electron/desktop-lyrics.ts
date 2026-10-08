import { app, BrowserWindow, ipcMain, screen, session, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import {
  DESKTOP_LYRICS_DEFAULT_CONTENT, DESKTOP_LYRICS_DEFAULT_SETTINGS,
  type DesktopLyricsContent, type DesktopLyricsSettings, type DesktopLyricsSnapshot,
} from './desktop-lyrics-types'
import {
  DesktopSettingsStore, DESKTOP_SETTINGS_KEYS as SETTINGS_KEYS,
  desktopSettingsPatch as settingsPatch, type SavedDesktopPosition as SavedPosition,
} from './desktop-settings-store'

interface DesktopLyricsControllerOptions {
  isMainSender: (event: IpcMainInvokeEvent) => boolean
  getCurrentBvid: () => string | null
}
const WIDTH = 900
const HEIGHT = 200
const CONTENT_KEYS = ['bvid', 'title', 'current', 'next', 'phase', 'playing'] as const
const CHANNELS = ['music:desktop-lyrics:get', 'music:desktop-lyrics:settings', 'music:desktop-lyrics:publish', 'desktop-lyrics:close'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function validateContent(value: unknown): DesktopLyricsContent {
  const input = record(value)
  if (!input || Object.keys(input).length !== CONTENT_KEYS.length || Object.keys(input).some(key => !CONTENT_KEYS.includes(key as typeof CONTENT_KEYS[number])) ||
    !(input.bvid === null || typeof input.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(input.bvid)) ||
    typeof input.title !== 'string' || input.title.length > 500 ||
    typeof input.current !== 'string' || input.current.length > 1000 ||
    typeof input.next !== 'string' || input.next.length > 1000 ||
    !['idle', 'loading', 'ready', 'empty', 'error'].includes(input.phase as string) || typeof input.playing !== 'boolean') {
    throw new Error('桌面歌词内容不合法。')
  }
  return { ...input } as unknown as DesktopLyricsContent
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** One independent, sandboxed lyrics window. Playback and lyric lookup remain in the main UI. */
export class DesktopLyricsController extends EventEmitter {
  private readonly options: DesktopLyricsControllerOptions
  private readonly settingsStore = new DesktopSettingsStore(app.getPath('userData'))
  private settings: DesktopLyricsSettings = { ...DESKTOP_LYRICS_DEFAULT_SETTINGS }
  private content: DesktopLyricsContent = { ...DESKTOP_LYRICS_DEFAULT_CONTENT }
  private position: SavedPosition | null = null
  private window: BrowserWindow | null = null
  private registered = false
  private initialized = false
  private disposed = false
  private closing = false
  private disposal: Promise<void> | null = null
  private persistenceError: string | null = null
  private windowError: string | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private mutationQueue: Promise<void> = Promise.resolve()
  private flushQueue: Promise<void> = Promise.resolve()
  private initialization: Promise<void> | null = null
  private ready: Promise<void>
  private resolveReady!: () => void
  private moveTimer: ReturnType<typeof setTimeout> | null = null
  private pointerTimer: ReturnType<typeof setInterval> | null = null
  private pointerInside = false
  private sessionAvailable = true
  private saveSequence = 0
  private displayListener = () => this.correctPosition()

  constructor(options: DesktopLyricsControllerOptions) {
    super()
    this.options = options
    this.ready = new Promise(resolve => { this.resolveReady = resolve })
  }

  registerIPC(): void {
    if (this.registered || this.disposed) return
    this.registered = true
    ipcMain.handle('music:desktop-lyrics:get', event => {
      this.requireSender(event)
      return this.getSnapshot()
    })
    ipcMain.handle('music:desktop-lyrics:settings', (event, patch: unknown) => {
      this.requireSender(event)
      return this.updateSettings(settingsPatch(patch))
    })
    ipcMain.handle('music:desktop-lyrics:publish', (event, content: unknown) => {
      if (!this.isMainFrame(event) || !this.options.isMainSender(event)) throw new Error('未授权发布桌面歌词。')
      this.publish(validateContent(content))
      return this.getSnapshot()
    })
    ipcMain.handle('desktop-lyrics:close', event => {
      if (!this.isOverlaySender(event)) throw new Error('未授权关闭桌面歌词。')
      return this.updateSettings({ enabled: false })
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) return this.initialization ?? Promise.resolve()
    this.initialized = true
    this.initialization = this.initializeState().finally(() => this.resolveReady())
    await this.initialization
  }

  private async initializeState(): Promise<void> {
    const saved = this.settingsStore.read()
    this.persistenceError = saved.error
    if (saved.data) {
      this.settings = saved.data.settings
      this.position = saved.data.bounds ? { x: saved.data.bounds.x, y: saved.data.bounds.y } : null
    }
    if (this.disposed || this.closing) return
    screen.on('display-removed', this.displayListener)
    screen.on('display-metrics-changed', this.displayListener)
    await this.reconcileWindow()
    this.notify()
  }

  getSnapshot(): DesktopLyricsSnapshot {
    return { settings: { ...this.settings }, content: { ...this.content }, error: [this.persistenceError, this.windowError].filter(Boolean).join(' ') || null }
  }

  /** Login gates visibility for this session without changing the saved enabled preference. */
  async setSessionAvailable(available: boolean): Promise<void> {
    if (this.disposed || this.closing || this.sessionAvailable === available) return
    this.sessionAvailable = available
    if (!this.initialized) return
    if (!available) {
      this.stopPointerTracking()
      if (this.window && !this.window.isDestroyed()) this.window.hide()
      await this.flush()
    }
    await this.reconcileWindow()
  }

  async updateSettings(patch: Partial<DesktopLyricsSettings>): Promise<DesktopLyricsSnapshot> {
    const safePatch = settingsPatch(patch)
    if (this.disposed || this.closing) throw new Error('桌面歌词已退出。')
    const operation = this.mutationQueue.then(async () => {
      // Early renderer requests wait for persisted preferences, so a slow read cannot overwrite a newer choice.
      await this.ready
      if (this.disposed) throw new Error('桌面歌词已退出。')
      const changed = SETTINGS_KEYS.some(key => key in safePatch && safePatch[key] !== this.settings[key])
      if (!changed) return this.getSnapshot()
      this.settings = { ...this.settings, ...safePatch }
      await this.reconcileWindow()
      await this.save()
      this.notify()
      return this.getSnapshot()
    })
    this.mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  publish(content: DesktopLyricsContent): void {
    if (this.disposed) return
    const safeContent = validateContent(content)
    if (safeContent.bvid !== this.options.getCurrentBvid()) throw new Error('歌曲已切换，已忽略旧歌的桌面歌词。')
    if (CONTENT_KEYS.every(key => safeContent[key] === this.content[key])) return
    this.content = safeContent
    this.notify()
  }

  flush(): Promise<void> {
    let pendingPosition = false
    if (this.moveTimer) {
      clearTimeout(this.moveTimer)
      this.moveTimer = null
      pendingPosition = true
      if (this.window && !this.window.isDestroyed()) {
        const [x, y] = this.window.getPosition()
        this.position = { x, y }
      }
    }
    const operation = this.flushQueue.then(async () => {
      await this.mutationQueue
      if (pendingPosition) await this.save()
      await this.writeQueue
    })
    this.flushQueue = operation.catch(() => undefined)
    return operation
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closing = true
    // Closing can happen while the main renderer is still loading. Read saved settings
    // before releasing accepted early patches, so they cannot apply onto defaults.
    if (!this.initialization) void this.initialize()
    const flushing = this.flush()
    if (this.initialized) {
      screen.removeListener('display-removed', this.displayListener)
      screen.removeListener('display-metrics-changed', this.displayListener)
    }
    this.stopPointerTracking()
    if (this.registered) {
      for (const channel of CHANNELS) ipcMain.removeHandler(channel)
      this.registered = false
    }
    const window = this.window
    this.window = null
    if (window && !window.isDestroyed()) window.destroy()
    // Already accepted settings requests must finish before marking the controller disposed.
    this.disposal = flushing.finally(() => { this.disposed = true; this.removeAllListeners() })
    return this.disposal
  }

  private isMainFrame(event: IpcMainInvokeEvent): boolean {
    return !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame
  }
  private isOverlaySender(event: IpcMainInvokeEvent): boolean {
    return this.isMainFrame(event) && !!this.window && !this.window.isDestroyed() && event.sender.id === this.window.webContents.id
  }
  private requireSender(event: IpcMainInvokeEvent): void {
    if (!this.isMainFrame(event) || !(this.options.isMainSender(event) || this.isOverlaySender(event))) throw new Error('未授权访问桌面歌词。')
  }

  private notify(): void {
    if (this.disposed) return
    const snapshot = this.getSnapshot()
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('desktop-lyrics:snapshot', snapshot)
    this.emit('snapshot', snapshot)
  }

  private stopPointerTracking(): void {
    if (this.pointerTimer) clearInterval(this.pointerTimer)
    this.pointerTimer = null
    this.pointerInside = false
  }

  private updatePointerPresence(window: BrowserWindow): void {
    if (this.disposed || this.window !== window || window.isDestroyed()) return
    const bounds = window.getBounds()
    const { x, y } = screen.getCursorScreenPoint()
    const inside = x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height
    const changed = inside !== this.pointerInside
    this.pointerInside = inside
    if (!inside && !changed) return
    window.webContents.send('desktop-lyrics:pointer-presence', inside)
  }

  private windowBounds(): Rectangle {
    const workArea = this.position ? screen.getDisplayMatching({ ...this.position, width: WIDTH, height: HEIGHT }).workArea : screen.getPrimaryDisplay().workArea
    const initial = this.position ?? { x: workArea.x + (workArea.width - WIDTH) / 2, y: workArea.y + workArea.height - HEIGHT - 32 }
    return {
      x: Math.round(Math.min(Math.max(initial.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - WIDTH))),
      y: Math.round(Math.min(Math.max(initial.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - HEIGHT))),
      width: WIDTH, height: HEIGHT,
    }
  }

  private async reconcileWindow(): Promise<void> {
    if (this.disposed || this.closing) return
    if (!this.settings.enabled || !this.sessionAvailable) {
      this.stopPointerTracking()
      const window = this.window
      this.window = null
      if (window && !window.isDestroyed()) window.destroy()
      return
    }
    if (this.window && !this.window.isDestroyed()) return
    let createdWindow: BrowserWindow | null = null
    try {
      const bounds = this.windowBounds()
      this.position = { x: bounds.x, y: bounds.y }
      const overlaySession = session.fromPartition('desktop-lyrics')
      overlaySession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      overlaySession.setPermissionCheckHandler(() => false)
      const window = new BrowserWindow({
        ...bounds, title: '余音 · 桌面歌词', show: false, frame: false, thickFrame: false, transparent: true,
        backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true,
        resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
        webPreferences: {
          preload: join(__dirname, '../preload/desktop-lyrics.js'), session: overlaySession,
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
          allowRunningInsecureContent: false, backgroundThrottling: false,
        },
      })
      createdWindow = window
      this.window = window
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-redirect', event => event.preventDefault())
      window.webContents.on('will-attach-webview', event => event.preventDefault())
      window.webContents.on('did-finish-load', () => {
        if (this.window === window && !this.disposed) this.notify()
      })
      window.on('move', () => {
        if (this.disposed || this.closing || this.window !== window || window.isDestroyed()) return
        const [x, y] = window.getPosition()
        this.position = { x, y }
        if (this.moveTimer) clearTimeout(this.moveTimer)
        this.moveTimer = setTimeout(() => { this.moveTimer = null; this.correctPosition() }, 250)
      })
      window.on('close', event => {
        if (this.disposed || this.window !== window) return
        event.preventDefault()
        void this.updateSettings({ enabled: false })
      })
      window.on('closed', () => {
        if (this.window !== window) return
        this.stopPointerTracking()
        this.window = null
        if (!this.disposed && this.settings.enabled) {
          this.settings = { ...this.settings, enabled: false }
          void this.save()
          this.notify()
        }
      })
      if (process.env.ELECTRON_RENDERER_URL) {
        const target = new URL('desktop-lyrics.html', process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : process.env.ELECTRON_RENDERER_URL + '/')
        if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('开发服务器地址无效。')
        await window.loadURL(target.href)
      } else await window.loadFile(join(__dirname, '../renderer/desktop-lyrics.html'))
      if (!this.disposed && !this.closing && this.window === window && this.settings.enabled && this.sessionAvailable && !window.isDestroyed()) {
        this.windowError = null
        this.correctPosition()
        window.showInactive()
        this.notify()
        this.stopPointerTracking()
        this.updatePointerPresence(window)
        this.pointerTimer = setInterval(() => this.updatePointerPresence(window), 100)
      }
    } catch (error) {
      // A deliberate disable/dispose while loadFile is pending is not a load failure.
      if (this.disposed || this.closing || createdWindow && this.window !== createdWindow) return
      const window = this.window
      this.stopPointerTracking()
      this.window = null
      if (window && !window.isDestroyed()) window.destroy()
      this.settings = { ...this.settings, enabled: false }
      this.windowError = `打开桌面歌词失败：${message(error)}`
      this.notify()
    }
  }

  private correctPosition(): void {
    if (this.disposed || this.closing || !this.window || this.window.isDestroyed()) return
    // Windows DPI rounding can make actual outer dimensions differ from requested dimensions.
    const current = this.window.getBounds()
    const workArea = screen.getDisplayMatching(current).workArea
    const x = Math.round(Math.min(Math.max(current.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - current.width)))
    const y = Math.round(Math.min(Math.max(current.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - current.height)))
    this.position = { x, y }
    if (current.x !== x || current.y !== y) this.window.setPosition(x, y)
    void this.save()
  }

  private async save(): Promise<void> {
    const sequence = ++this.saveSequence
    const data = { version: 1 as const, settings: { ...this.settings }, bounds: this.position ? { ...this.position, width: WIDTH, height: HEIGHT } : null }
    const operation = this.writeQueue.then(async () => {
      try {
        this.settingsStore.write(data)
        if (sequence === this.saveSequence && this.persistenceError) {
          this.persistenceError = null
          this.notify()
        }
      } catch (error) {
        this.persistenceError = message(error)
        this.notify()
      }
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }
}
