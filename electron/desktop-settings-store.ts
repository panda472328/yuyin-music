import { randomUUID } from 'node:crypto'
import {
  closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DESKTOP_LYRICS_DEFAULT_SETTINGS, type DesktopLyricsSettings } from './desktop-lyrics-types'

export const DESKTOP_SETTINGS_KEYS = ['enabled', 'locked', 'font', 'fontSize', 'color', 'opacity'] as const
const REQUIRED_SETTINGS_KEYS = ['enabled', 'font', 'fontSize', 'color'] as const
const MAX_FILE_BYTES = 8192

export interface SavedDesktopPosition { x: number; y: number }
export interface SavedDesktopSettings {
  version: 1
  settings: DesktopLyricsSettings
  bounds: (SavedDesktopPosition & { width: number; height: number }) | null
}
type SavedFile = { status: 'missing' } | { status: 'valid'; json: string; data: SavedDesktopSettings } | { status: 'error'; error: Error }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function desktopSettingsPatch(value: unknown): Partial<DesktopLyricsSettings> {
  const input = record(value)
  if (!input || Object.keys(input).some(key => !DESKTOP_SETTINGS_KEYS.includes(key as typeof DESKTOP_SETTINGS_KEYS[number])) ||
    ('enabled' in input && typeof input.enabled !== 'boolean') ||
    ('locked' in input && typeof input.locked !== 'boolean') ||
    ('font' in input && !['sans', 'serif', 'kai', 'rounded'].includes(input.font as string)) ||
    ('fontSize' in input && (typeof input.fontSize !== 'number' || !Number.isFinite(input.fontSize) || input.fontSize < 24 || input.fontSize > 56)) ||
    ('color' in input && !['white', 'mint', 'gold'].includes(input.color as string)) ||
    ('opacity' in input && (typeof input.opacity !== 'number' || !Number.isFinite(input.opacity) || input.opacity < .3 || input.opacity > 1))) {
    throw new Error('桌面歌词设置不合法。')
  }
  return { ...input } as Partial<DesktopLyricsSettings>
}

function parseSavedSettings(value: unknown): SavedDesktopSettings {
  const saved = record(value)
  if (!saved || saved.version !== 1 || Object.keys(saved).some(key => !['version', 'settings', 'bounds'].includes(key))) {
    throw new Error('设置文件格式不正确。')
  }
  const patch = desktopSettingsPatch(saved.settings)
  if (!REQUIRED_SETTINGS_KEYS.every(key => key in patch)) throw new Error('设置文件缺少必要字段。')
  let bounds: SavedDesktopSettings['bounds'] = null
  if (saved.bounds !== null) {
    const input = record(saved.bounds)
    if (!input || Object.keys(input).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
      typeof input.x !== 'number' || !Number.isFinite(input.x) || Math.abs(input.x) > 100000 ||
      typeof input.y !== 'number' || !Number.isFinite(input.y) || Math.abs(input.y) > 100000) {
      throw new Error('歌词窗口位置无效。')
    }
    // Older versions stored only the position; window dimensions are fixed by the controller.
    bounds = { x: Math.round(input.x), y: Math.round(input.y), width: 900, height: 200 }
  }
  return { version: 1, settings: { ...DESKTOP_LYRICS_DEFAULT_SETTINGS, ...patch }, bounds }
}

function errorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') return '磁盘空间不足。'
  if (code === 'EACCES' || code === 'EPERM') return '无法访问设置文件，请检查文件夹权限。'
  return error instanceof Error ? error.message : '文件操作失败。'
}

function readSavedFile(path: string): SavedFile {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('设置路径不是文件。')
    if (stat.size > MAX_FILE_BYTES) throw new Error('设置文件过大。')
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length > stat.size) throw new Error('设置文件正在变化，请稍后重试。')
    const json = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    return { status: 'valid', json, data: parseSavedSettings(JSON.parse(json)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { status: 'missing' }
    return { status: 'error', error: new Error(errorMessage(error)) }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function atomicWrite(path: string, json: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, json, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* Never load unfinished temporary writes. */ }
  }
}

/** Keep desktop preferences independent of portable-app extraction paths. */
export class DesktopSettingsStore {
  private readonly path: string
  private readonly backupPath: string

  constructor(private readonly directory: string) {
    this.path = join(directory, 'desktop-lyrics.json')
    this.backupPath = `${this.path}.bak`
  }

  private readFile(): SavedFile {
    const primary = readSavedFile(this.path)
    // A valid disabled window is authoritative, even if the backup had it enabled.
    if (primary.status === 'valid') return primary
    const backup = readSavedFile(this.backupPath)
    if (backup.status === 'valid') return backup
    if (primary.status === 'missing' && backup.status === 'missing') return primary
    const error = primary.status === 'error' ? primary.error : backup.status === 'error' ? backup.error : null
    return { status: 'error', error: new Error(`读取桌面歌词设置失败：${error?.message ?? '没有可用的设置文件。'}为保护已有设置，已停止自动保存。`) }
  }

  read(): { data: SavedDesktopSettings | null; error: string | null } {
    const saved = this.readFile()
    if (saved.status === 'error') return { data: null, error: saved.error.message }
    return { data: saved.status === 'valid' ? saved.data : null, error: null }
  }

  write(value: SavedDesktopSettings): void {
    const json = JSON.stringify(parseSavedSettings(value), null, 2)
    // Recheck before every save, so defaults never overwrite a corrupt/unreadable file.
    const previous = this.readFile()
    if (previous.status === 'error') throw previous.error
    try {
      mkdirSync(this.directory, { recursive: true })
      if (previous.status === 'valid') atomicWrite(this.backupPath, previous.json)
      atomicWrite(this.path, json)
    } catch (error) {
      throw new Error(`保存桌面歌词设置失败：${errorMessage(error)}`)
    }
  }
}
