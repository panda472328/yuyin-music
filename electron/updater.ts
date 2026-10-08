import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { compareVersions, parseUpdateManifest, WINDOWS_UPDATE_MANIFEST_URL, type UpdateManifest, type UpdateState } from '../src/shared/update'
import { requestUpdate, UPDATE_MANIFEST_MAX_BYTES, type UpdateTransport } from './update-transport'

const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const CHECK_TIMEOUT = 30_000
const DOWNLOAD_TIMEOUT = 15 * 60 * 1000
const message = (error: unknown) => error instanceof Error ? error.message : '更新操作失败，请稍后重试。'

export interface UpdaterOptions {
  currentVersion: string
  cacheDirectory: string
  canInstall: boolean
  installDisabledReason: string | null
  onState(state: UpdateState): void
  /** Enqueue installation through the application's normal save-and-quit flow. */
  install(file: string, manifest: UpdateManifest): Promise<void>
  transport?: UpdateTransport
  now?: () => Date
}

export async function verifyUpdateFile(file: string, manifest: UpdateManifest): Promise<boolean> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.artifact.size) return false
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length
      if (bytes > manifest.artifact.size) return false
      hash.update(chunk)
    }
    return bytes === manifest.artifact.size && hash.digest('hex') === manifest.artifact.sha256
  } catch { return false }
}

export class AppUpdater {
  private state: UpdateState
  private operation: Promise<UpdateState> | null = null
  private controller: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private downloadedFile: string | null = null
  private readonly transport: UpdateTransport

  constructor(private readonly options: UpdaterOptions) {
    this.transport = options.transport ?? requestUpdate
    this.state = { status: 'idle', currentVersion: options.currentVersion, manifest: null, progress: null, error: null,
      checkedAt: null, canInstall: options.canInstall, installDisabledReason: options.installDisabledReason }
  }

  getState(): UpdateState { return structuredClone(this.state) }

  start(): void {
    if (this.timer || this.disposed) return
    void this.check()
    this.timer = setInterval(() => {
      if (!this.operation && !['downloaded', 'installing'].includes(this.state.status)) void this.check()
    }, CHECK_INTERVAL)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.controller?.abort()
  }

  /** A failed save or launcher authorization cancels quitting and leaves the app usable. */
  reportInstallationFailure(error: unknown): void {
    if (!this.disposed) this.publish({ status: 'error', error: message(error) })
  }

  private publish(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    if (!this.disposed) this.options.onState(this.getState())
  }

  private run(operation: (signal: AbortSignal) => Promise<void>, timeout: number): Promise<UpdateState> {
    if (this.operation) return this.operation
    if (this.disposed || this.state.status === 'installing') return Promise.resolve(this.getState())
    const controller = new AbortController(); this.controller = controller
    const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.()
    const pending = Promise.resolve().then(() => operation(controller.signal)).catch(error => {
      if (!this.disposed) this.publish({ status: 'error', progress: null, error: controller.signal.aborted ? '更新请求超时，请稍后重试。' : message(error) })
    }).finally(() => {
      clearTimeout(timer)
      if (this.operation === pending) this.operation = null
      if (this.controller === controller) this.controller = null
    }).then(() => this.getState())
    this.operation = pending
    return pending
  }

  check(): Promise<UpdateState> {
    if (this.operation || this.state.status === 'installing') return this.operation ?? Promise.resolve(this.getState())
    return this.run(async signal => {
      this.publish({ status: 'checking', error: null })
      const response = await this.transport(WINDOWS_UPDATE_MANIFEST_URL, signal, 'manifest')
      let text: Buffer
      try {
        if (response.contentLength !== null && response.contentLength > UPDATE_MANIFEST_MAX_BYTES) throw new Error('更新清单过大。')
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of response.body) {
          if (signal.aborted) throw new Error('更新请求已取消。')
          size += chunk.byteLength
          if (size > UPDATE_MANIFEST_MAX_BYTES) throw new Error('更新清单过大。')
          chunks.push(Buffer.from(chunk))
        }
        text = Buffer.concat(chunks)
      } finally { response.dispose() }
      let input: unknown
      try { input = JSON.parse(text.toString('utf8')) } catch { throw new Error('更新清单格式不正确。') }
      const manifest = parseUpdateManifest(input, 'windows')
      if (signal.aborted || this.disposed) return
      const checkedAt = (this.options.now?.() ?? new Date()).toISOString()
      if (compareVersions(manifest.version, this.options.currentVersion) <= 0) {
        this.downloadedFile = null
        this.publish({ status: 'up-to-date', manifest: null, progress: null, checkedAt })
        return
      }
      const cachedFile = this.fileFor(manifest)
      const downloaded = this.options.canInstall && await verifyUpdateFile(cachedFile, manifest)
      if (signal.aborted || this.disposed) return
      this.downloadedFile = downloaded ? cachedFile : null
      this.publish({ status: downloaded ? 'downloaded' : 'available', manifest, progress: downloaded ? 100 : null, checkedAt })
    }, CHECK_TIMEOUT)
  }

  download(): Promise<UpdateState> {
    if (this.operation || this.state.status === 'installing') return this.operation ?? Promise.resolve(this.getState())
    return this.run(async signal => {
      if (!this.options.canInstall) throw new Error(this.options.installDisabledReason ?? '此构建不支持应用内安装更新。')
      const manifest = this.state.manifest
      if (!manifest || compareVersions(manifest.version, this.options.currentVersion) <= 0) throw new Error('请先检查是否有新版本。')
      const destination = this.fileFor(manifest)
      if (await verifyUpdateFile(destination, manifest)) {
        this.downloadedFile = destination
        this.publish({ status: 'downloaded', progress: 100, error: null })
        return
      }
      this.downloadedFile = null
      this.publish({ status: 'downloading', progress: 0, error: null })
      await mkdir(this.options.cacheDirectory, { recursive: true })
      const temporary = `${destination}.${randomUUID()}.part`
      let handle: Awaited<ReturnType<typeof open>> | null = null
      try {
        handle = await open(temporary, 'wx', 0o600)
        const response = await this.transport(manifest.artifact.url, signal, 'artifact')
        try {
          if (response.contentLength !== null && response.contentLength !== manifest.artifact.size) throw new Error('安装包大小与更新清单不一致。')
          let bytes = 0; let previousProgress = -1; const hash = createHash('sha256')
          for await (const chunk of response.body) {
            if (signal.aborted || this.disposed) throw new Error('更新下载已取消。')
            bytes += chunk.byteLength
            if (bytes > manifest.artifact.size) throw new Error('安装包超过预期大小。')
            hash.update(chunk)
            let written = 0
            while (written < chunk.byteLength) {
              const result = await handle.write(chunk, written, chunk.byteLength - written)
              if (result.bytesWritten === 0) throw new Error('写入更新安装包失败。')
              written += result.bytesWritten
            }
            const progress = Math.floor(bytes / manifest.artifact.size * 100)
            if (progress !== previousProgress) { previousProgress = progress; this.publish({ progress }) }
          }
          if (bytes !== manifest.artifact.size || hash.digest('hex') !== manifest.artifact.sha256) throw new Error('安装包校验失败，请重新下载。')
          await handle.sync()
        } finally { response.dispose() }
        await handle.close(); handle = null
        if (signal.aborted || this.disposed) throw new Error('更新下载已取消。')
        await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error })
        await rename(temporary, destination)
        this.downloadedFile = destination
        this.publish({ status: 'downloaded', progress: 100, error: null })
      } finally {
        await handle?.close()
        await unlink(temporary).catch(() => undefined)
      }
    }, DOWNLOAD_TIMEOUT)
  }

  install(): Promise<UpdateState> {
    if (this.operation || this.state.status === 'installing') return this.operation ?? Promise.resolve(this.getState())
    return this.run(async signal => {
      if (!this.options.canInstall) throw new Error(this.options.installDisabledReason ?? '此构建不支持应用内安装更新。')
      const manifest = this.state.manifest; const file = this.downloadedFile
      if (!manifest || !file || !await verifyUpdateFile(file, manifest)) {
        this.downloadedFile = null
        throw new Error('安装包尚未下载或校验失败，请重新下载。')
      }
      if (signal.aborted || this.disposed) return
      this.publish({ status: 'installing', error: null })
      await this.options.install(file, structuredClone(manifest))
    }, DOWNLOAD_TIMEOUT)
  }

  private fileFor(manifest: UpdateManifest): string {
    return join(this.options.cacheDirectory, `${manifest.artifact.sha256}-${basename(new URL(manifest.artifact.url).pathname)}`)
  }
}
