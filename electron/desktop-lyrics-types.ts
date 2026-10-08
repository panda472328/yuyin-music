export interface DesktopLyricsSettings {
  enabled: boolean
  locked: boolean
  font: 'sans' | 'serif' | 'kai' | 'rounded'
  fontSize: number
  color: 'white' | 'mint' | 'gold'
  opacity: number
}

export interface DesktopLyricsContent {
  bvid: string | null
  title: string
  current: string
  next: string
  phase: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  playing: boolean
}

export interface DesktopLyricsSnapshot {
  settings: DesktopLyricsSettings
  content: DesktopLyricsContent
  error: string | null
}

export const DESKTOP_LYRICS_DEFAULT_SETTINGS: Readonly<DesktopLyricsSettings> = {
  enabled: false, locked: false, font: 'sans', fontSize: 36, color: 'white', opacity: 1,
}

export const DESKTOP_LYRICS_DEFAULT_CONTENT: Readonly<DesktopLyricsContent> = {
  bvid: null, title: '', current: '', next: '', phase: 'idle', playing: false,
}

export const DESKTOP_LYRICS_FONT_OPTIONS: ReadonlyArray<{
  value: DesktopLyricsSettings['font']; label: string; fontFamily: string
}> = [
  { value: 'sans', label: '微软雅黑', fontFamily: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif' },
  { value: 'serif', label: '宋体', fontFamily: 'SimSun, "宋体", "Songti SC", serif' },
  { value: 'kai', label: '楷体', fontFamily: 'KaiTi, "楷体", "Kaiti SC", "Microsoft YaHei", serif' },
  { value: 'rounded', label: '幼圆', fontFamily: 'YouYuan, "幼圆", "Microsoft YaHei", "微软雅黑", sans-serif' },
]

export const DESKTOP_LYRICS_COLOR_OPTIONS: ReadonlyArray<{
  value: DesktopLyricsSettings['color']; label: string; color: string
}> = [
  { value: 'white', label: '月白', color: '#ffffff' },
  { value: 'mint', label: '薄荷', color: '#b9f2d0' },
  { value: 'gold', label: '暖金', color: '#ffe39c' },
]

export interface DesktopLyricsAPI {
  getSnapshot(): Promise<DesktopLyricsSnapshot>
  updateSettings(patch: Partial<DesktopLyricsSettings>): Promise<DesktopLyricsSnapshot>
  onSnapshot(callback: (snapshot: DesktopLyricsSnapshot) => void): () => void
  onPointerPresence(callback: (inside: boolean) => void): () => void
  close(): Promise<DesktopLyricsSnapshot>
}

declare global {
  interface Window { desktopLyricsAPI?: DesktopLyricsAPI }
}
