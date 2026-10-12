import { contextBridge, ipcRenderer } from 'electron'
import type { MusicAPI } from '../src/api'

function libraryRequest(channel: string, ...args: unknown[]): string | null {
  const result = ipcRenderer.sendSync(channel, ...args)
  if (!result?.ok) throw new Error(result?.error || '音乐库保存服务不可用，请重新打开播放器。')
  return result.data ?? null
}

const musicAPI: MusicAPI = {
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdateRelease: () => ipcRenderer.invoke('update:release'),
  onUpdateState(callback) { const listener = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state); ipcRenderer.on('update:state', listener); return () => ipcRenderer.removeListener('update:state', listener) },
  search: (query, page, mode) => ipcRenderer.invoke('music:search', query, page, mode),
  searchSuggestions: query => ipcRenderer.invoke('music:search-suggestions', query),
  play: song => ipcRenderer.invoke('music:play', song),
  pause: () => ipcRenderer.invoke('music:pause'),
  resume: () => ipcRenderer.invoke('music:resume'),
  seek: seconds => ipcRenderer.invoke('music:seek', seconds),
  setVolume: volume => ipcRenderer.invoke('music:volume', volume),
  getStatus: () => ipcRenderer.invoke('music:status'),
  getLyrics: request => ipcRenderer.invoke('music:lyrics', request),
  getDesktopLyricsSnapshot: () => ipcRenderer.invoke('music:desktop-lyrics:get'),
  updateDesktopLyricsSettings: patch => ipcRenderer.invoke('music:desktop-lyrics:settings', patch),
  publishDesktopLyrics: content => ipcRenderer.invoke('music:desktop-lyrics:publish', content),
  onDesktopLyricsSnapshot(callback) { const listener = (_event: unknown, snapshot: Parameters<typeof callback>[0]) => callback(snapshot); ipcRenderer.on('desktop-lyrics:snapshot', listener); return () => ipcRenderer.removeListener('desktop-lyrics:snapshot', listener) },
  login: () => ipcRenderer.invoke('music:login'),
  getBilibiliAccount: () => ipcRenderer.invoke('music:bilibili-account'),
  continueAsGuest: () => ipcRenderer.invoke('music:guest'),
  openBilibiliProfile: () => ipcRenderer.invoke('music:bilibili-profile'),
  onBilibiliSessionChanged(callback) { const listener = () => callback(); ipcRenderer.on('bilibili:session-changed', listener); return () => ipcRenderer.removeListener('bilibili:session-changed', listener) },
  getBilibiliFavoriteFolders: () => ipcRenderer.invoke('music:bilibili-favorite-folders'),
  getBilibiliFavoriteItems: (mediaId, page) => ipcRenderer.invoke('music:bilibili-favorite-items', mediaId, page),
  getBilibiliFavoriteSongs: mediaId => ipcRenderer.invoke('music:bilibili-favorite-songs', mediaId),
  async getVideoComments() { throw new Error('历史 Electron 客户端不支持评论区，请使用 Windows WebView2 版。') },
  async getCommentReplies() { throw new Error('历史 Electron 客户端不支持评论区，请使用 Windows WebView2 版。') },
  async setCommentLike() { throw new Error('历史 Electron 客户端不支持评论点赞，请使用 Windows WebView2 版。') },
  async createComment() { throw new Error('历史 Electron 客户端不支持发表评论，请使用 Windows WebView2 版。') },
  openSource: () => ipcRenderer.invoke('music:source'),
  openMV: async () => { throw new Error('MV 模式需要使用 Windows WebView2 客户端。') },
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  onStatus(callback) { const listener = (_event: unknown, status: Parameters<typeof callback>[0]) => callback(status); ipcRenderer.on('music:status', listener); return () => ipcRenderer.removeListener('music:status', listener) },
  onEnded(callback) { const listener = () => callback(); ipcRenderer.on('music:ended', listener); return () => ipcRenderer.removeListener('music:ended', listener) },
  readLibrary: () => libraryRequest('library:read'),
  writeLibrary: data => { libraryRequest('library:write', data) },
  readLocalPreference: key => libraryRequest('preferences:read', key),
  writeLocalPreference: (key, value) => { libraryRequest('preferences:write', key, value) },
  onPreferenceError(callback) { const listener = (_event: unknown, message: string) => callback(message); ipcRenderer.on('preferences:error', listener); return () => ipcRenderer.removeListener('preferences:error', listener) },
  exportLibrary: data => ipcRenderer.invoke('library:export', data),
  importLibrary: () => ipcRenderer.invoke('library:import')
}
contextBridge.exposeInMainWorld('musicAPI', musicAPI)
