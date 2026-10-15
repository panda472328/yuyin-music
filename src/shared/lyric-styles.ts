/** Stable preset IDs shared by both lyric renderers and preference validation. */
export const LYRIC_STYLE_OPTIONS = [
  { value: 'classic', label: '经典', description: '清透文字 · 跟随主题' },
  { value: 'focus', label: '聚光', description: '醒目字重 · 专注此刻' },
  { value: 'paper', label: '手札', description: '楷体细线 · 留住诗意' },
  { value: 'minecraft', label: '我的世界', description: '像素字形 · 方块标记' },
] as const

export type LyricStyle = typeof LYRIC_STYLE_OPTIONS[number]['value']
export const PIXEL_FONT_FAMILY = '"Fusion Pixel", "Consolas", "Microsoft YaHei", monospace'
export const isLyricStyle = (value: unknown): value is LyricStyle => LYRIC_STYLE_OPTIONS.some(option => option.value === value)
