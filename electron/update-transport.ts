import { request } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { WINDOWS_UPDATE_MANIFEST_URL } from '../src/shared/update'

export const UPDATE_MANIFEST_MAX_BYTES = 64 * 1024
export type UpdateBody = AsyncIterable<Uint8Array>
export interface UpdateResponse { body: UpdateBody; contentLength: number | null; dispose(): void }
export type UpdateTransport = (url: string, signal: AbortSignal, kind: 'manifest' | 'artifact') => Promise<UpdateResponse>

export function isTrustedUpdateRedirect(url: URL, kind: 'manifest' | 'artifact'): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
  if (kind === 'manifest') return url.href === WINDOWS_UPDATE_MANIFEST_URL
  if (url.hostname === 'github.com') return url.pathname.startsWith('/panda472328/yuyin-music/releases/download/') && !url.search
  return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
}

/** Node HTTPS has no browser cookies or Bilibili session. Only GitHub's release CDN may redirect. */
export const requestUpdate: UpdateTransport = async (address, signal, kind) => {
  let url = new URL(address)
  if (!isTrustedUpdateRedirect(url, kind)) throw new Error('更新地址不受信任。')
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(url, { method: 'GET', signal, headers: {
        'User-Agent': 'Yuyin-Update/1', Accept: kind === 'manifest' ? 'application/json' : 'application/octet-stream',
        'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache',
      } }, resolve)
      req.setTimeout(30_000, () => req.destroy(new Error('更新网络请求超时，请稍后重试。')))
      req.on('error', reject)
      req.end()
    })
    const status = response.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location
      response.destroy()
      if (!location || redirects === 5) throw new Error('更新下载重定向异常。')
      url = new URL(location, url)
      if (!isTrustedUpdateRedirect(url, kind)) throw new Error('更新下载跳转到不受信任的地址。')
      continue
    }
    if (status !== 200) { response.destroy(); throw new Error(status === 404 ? '暂时没有可用的更新清单或安装包。' : 'GitHub 更新服务暂时不可用，请稍后重试。') }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); throw new Error('更新服务返回的文件编码异常。') }
    const length = response.headers['content-length']
    const contentLength = typeof length === 'string' && /^\d+$/.test(length) ? Number(length) : null
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) { response.destroy(); throw new Error('更新文件大小异常。') }
    return { body: response, contentLength, dispose: () => response.destroy() }
  }
  throw new Error('更新下载重定向异常。')
}
