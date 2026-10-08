import { randomUUID } from 'node:crypto'
import {
  closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const MAX_JSON_CHARACTERS = 8 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_LYRICS_CHARACTERS = 786_432
const MAX_CALIBRATION_CHARACTERS = 2 * 1024 * 1024
const ALLOWED_KEYS = new Set([
  'yuyin-lyrics-source-v1',
  'yuyin-lyrics-v1',
  'yuyin-bilibili-subtitles-v1',
  'yuyin-ui-settings-v1',
  'yuyin-lyric-calibrations-v1',
  'yuyin-window-state-v1',
])

interface PreferencesData {
  version: 1
  values: Record<string, string>
}
type SavedFile =
  | { status: 'missing' }
  | { status: 'valid'; json: string; data: PreferencesData }
  | { status: 'error'; error: Error }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function exactFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(record).length === fields.length && fields.every(key => Object.hasOwn(record, key))
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) throw new Error('不支持的设置项目。')
}

function parseJSON(json: string, maximum = MAX_JSON_CHARACTERS): unknown {
  if (typeof json !== 'string' || json.length > maximum || Buffer.byteLength(json, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('设置数据过大或不是有效的文本。')
  }
  try { return JSON.parse(json) } catch { throw new Error('设置 JSON 已损坏。') }
}

function validateValue(key: string, value: string): void {
  validateKey(key)
  if (key === 'yuyin-lyrics-source-v1') {
    if (value !== 'lrclib' && value !== 'bilibili') throw new Error('歌词来源设置不正确。')
    return
  }
  const maximum = key === 'yuyin-lyrics-v1' || key === 'yuyin-bilibili-subtitles-v1'
    ? MAX_LYRICS_CHARACTERS : key === 'yuyin-lyric-calibrations-v1'
      ? MAX_CALIBRATION_CHARACTERS : MAX_JSON_CHARACTERS
  const record = object(parseJSON(value, maximum))
  if (!record || record.version !== 1) throw new Error('设置数据格式不正确。')
  if (key === 'yuyin-ui-settings-v1') {
    if (!exactFields(record, ['version', 'volumeBeforeMute', 'sleepUntil']) ||
      typeof record.volumeBeforeMute !== 'number' || !Number.isFinite(record.volumeBeforeMute) ||
      record.volumeBeforeMute < 0 || record.volumeBeforeMute > 1 ||
      (record.sleepUntil !== null && (!Number.isSafeInteger(record.sleepUntil) || (record.sleepUntil as number) < 0))) {
      throw new Error('播放界面设置格式不正确。')
    }
    return
  }
  if (key === 'yuyin-window-state-v1') {
    const bounds = object(record.bounds)
    if (!exactFields(record, ['version', 'bounds', 'maximized']) || typeof record.maximized !== 'boolean' ||
      !bounds || !exactFields(bounds, ['x', 'y', 'width', 'height']) ||
      !Object.values(bounds).every(number => typeof number === 'number' && Number.isFinite(number) && Number.isInteger(number))) {
      throw new Error('窗口位置设置格式不正确。')
    }
    return
  }
  if (!exactFields(record, ['version', 'entries']) || !object(record.entries)) {
    throw new Error('歌词设置格式不正确。')
  }
}

function parsePreferences(json: string): PreferencesData {
  const root = object(parseJSON(json))
  const values = root ? object(root.values) : null
  if (!root || !exactFields(root, ['version', 'values']) || root.version !== 1 || !values) {
    throw new Error('设置文件格式不正确。')
  }
  const safeValues: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') throw new Error('设置项目不是有效的文本。')
    validateValue(key, value)
    safeValues[key] = value
  }
  return { version: 1, values: safeValues }
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
    // The extra byte detects a file growing during the read without allocating unbounded memory.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length > stat.size) throw new Error('设置文件正在变化，请稍后重试。')
    let json: string
    try { json = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) }
    catch { throw new Error('设置文件的文本编码已损坏。') }
    return { status: 'valid', json, data: parsePreferences(json) }
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
    try { unlinkSync(temporary) } catch { /* Only committed primary/backup files are ever read. */ }
  }
}

/** Fixed per-profile settings shared by every portable-app extraction. */
export class LocalPreferencesStore {
  private readonly path: string
  private readonly backupPath: string

  constructor(private readonly directory: string) {
    this.path = join(directory, 'preferences.json')
    this.backupPath = join(directory, 'preferences.json.bak')
  }

  private readFile(): Extract<SavedFile, { status: 'valid' }> | null {
    const primary = readSavedFile(this.path)
    if (primary.status === 'valid') return primary
    const backup = readSavedFile(this.backupPath)
    if (backup.status === 'valid') return backup
    if (primary.status === 'missing' && backup.status === 'missing') return null
    const error = primary.status === 'error' ? primary.error : backup.status === 'error' ? backup.error : null
    throw new Error(`设置读取失败：${error?.message ?? '没有可用的设置文件。'}为保护已有设置，已停止自动保存，请修复文件后重试。`)
  }

  read(key: string): string | null {
    validateKey(key)
    return this.readFile()?.data.values[key] ?? null
  }

  write(key: string, value: string): void {
    validateValue(key, value)
    // Re-read before every write so separately constructed stores preserve each other's keys.
    // An unreadable file must never be silently replaced by default settings.
    const previous = this.readFile()
    const values: Record<string, string> = Object.assign(Object.create(null), previous?.data.values)
    values[key] = value
    const json = JSON.stringify({ version: 1, values })
    parsePreferences(json)
    try {
      mkdirSync(this.directory, { recursive: true })
      if (previous) atomicWrite(this.backupPath, previous.json)
      atomicWrite(this.path, json)
    } catch (error) {
      throw new Error(`设置保存失败：${errorMessage(error)}本次保存未完成，请检查磁盘空间和文件夹权限。`)
    }
  }
}
