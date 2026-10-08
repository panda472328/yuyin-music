import { randomUUID } from 'node:crypto'
import {
  closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const MAX_JSON_CHARACTERS = 8 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024

type SavedFile = { status: 'missing' } | { status: 'valid'; json: string } | { status: 'error'; error: Error }

function validateJSON(json: string): void {
  if (typeof json !== 'string' || json.length > MAX_JSON_CHARACTERS || Buffer.byteLength(json, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('音乐库数据过大或不是有效的文本。')
  }
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('音乐库 JSON 已损坏。') }
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
  if (!record || record.version !== 1 ||
    !['favorites', 'playlists', 'history', 'queue'].every(key => Array.isArray(record[key])) ||
    record.settings === null || typeof record.settings !== 'object' || Array.isArray(record.settings)) {
    throw new Error('音乐库数据格式不正确。')
  }
}

function errorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') return '磁盘空间不足。'
  if (code === 'EACCES' || code === 'EPERM') return '无法访问音乐库文件，请检查文件夹权限。'
  return error instanceof Error ? error.message : '文件操作失败。'
}

/** Read a bounded file without allowing a growing file to allocate unbounded memory. */
function readSavedFile(path: string): SavedFile {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('音乐库路径不是文件。')
    if (stat.size > MAX_FILE_BYTES) throw new Error('音乐库文件过大。')
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length > stat.size) throw new Error('音乐库文件正在变化，请稍后重试。')
    const json = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    validateJSON(json)
    return { status: 'valid', json }
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
    // A failed cleanup must not hide the original save error or turn a committed save into a failure.
    try { unlinkSync(temporary) } catch { /* Best effort: temporary files are never read as a library. */ }
  }
}

/** One fixed, synchronous music library shared by every portable-app extraction. */
export class MusicLibraryStore {
  private readonly path: string
  private readonly backupPath: string

  constructor(private readonly directory: string) {
    this.path = join(directory, 'library.json')
    this.backupPath = join(directory, 'library.json.bak')
  }

  read(): string | null {
    const primary = readSavedFile(this.path)
    // An intentionally empty valid library is authoritative; never merge or revive its backup.
    if (primary.status === 'valid') return primary.json
    const backup = readSavedFile(this.backupPath)
    if (backup.status === 'valid') return backup.json
    if (primary.status === 'missing' && backup.status === 'missing') return null
    const error = primary.status === 'error' ? primary.error : backup.status === 'error' ? backup.error : null
    throw new Error(`音乐库读取失败：${error?.message ?? '没有可用的音乐库文件。'}为保护已有收藏，已停止自动保存，请修复文件后重试。`)
  }

  write(json: string): void {
    validateJSON(json)
    // Recheck disk before every write, including the first one. An unreadable library must never
    // be replaced by renderer defaults, even if a previous read or save succeeded.
    const previous = this.read()
    try {
      mkdirSync(this.directory, { recursive: true })
      if (previous !== null) atomicWrite(this.backupPath, previous)
      atomicWrite(this.path, json)
    } catch (error) {
      throw new Error(`音乐库保存失败：${errorMessage(error)}本次保存未完成，请检查磁盘空间和文件夹权限。`)
    }
  }
}
