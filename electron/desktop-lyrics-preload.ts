import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopLyricsAPI, DesktopLyricsSnapshot } from './desktop-lyrics-types'

const desktopLyricsAPI: DesktopLyricsAPI = {
  getSnapshot: () => ipcRenderer.invoke('music:desktop-lyrics:get'),
  updateSettings: patch => ipcRenderer.invoke('music:desktop-lyrics:settings', patch),
  onSnapshot(callback) {
    const listener = (_event: unknown, snapshot: DesktopLyricsSnapshot) => callback(snapshot)
    ipcRenderer.on('desktop-lyrics:snapshot', listener)
    return () => ipcRenderer.removeListener('desktop-lyrics:snapshot', listener)
  },
  onPointerPresence(callback) {
    const listener = (_event: unknown, inside: boolean) => callback(inside)
    ipcRenderer.on('desktop-lyrics:pointer-presence', listener)
    return () => ipcRenderer.removeListener('desktop-lyrics:pointer-presence', listener)
  },
  close: () => ipcRenderer.invoke('desktop-lyrics:close'),
}

contextBridge.exposeInMainWorld('desktopLyricsAPI', desktopLyricsAPI)
