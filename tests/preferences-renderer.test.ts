import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { preferenceStorage } from '../src/local-preferences'
import { UI_SETTINGS_KEY, loadUISettings, saveUISettings } from '../src/ui-settings'
import { CALIBRATIONS_KEY, readCalibration, saveCalibration } from '../src/lyric-calibrations'
import { BILIBILI_LYRICS_STORAGE_KEY, LYRICS_STORAGE_KEY, readLyricsCache, saveLyricsCache, type SavedLyrics } from '../src/lyrics-storage'
import type { LyricsTrack } from '../electron/lyrics-types'

function memoryStorage() {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
const bvid = 'BV0000000001'
const track: LyricsTrack = { id: 2, trackName: '测试歌', artistName: '测试歌手', albumName: '', duration: 180, instrumental: false, syncedLyrics: '[00:01.00]第一句\n[00:04.00]第二句', plainLyrics: '第一句\n第二句' }

function bridge(t: TestContext, disk = memoryStorage(), legacy = memoryStorage()) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { musicAPI: {
    readLocalPreference: (key: string) => disk.getItem(key),
    writeLocalPreference: (key: string, value: string) => disk.setItem(key, value),
  } } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: legacy })
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  return { disk, legacy }
}

test('UI settings restore muted volume and future sleep deadline while expired timers stay cleared', () => {
  const storage = memoryStorage()
  const settings = { version: 1 as const, volumeBeforeMute: .37, sleepUntil: 2000 }
  assert.deepEqual(saveUISettings(settings, storage), { ok: true })
  assert.deepEqual(loadUISettings(0, storage, 1000).settings, settings)
  assert.deepEqual(loadUISettings(0, storage, 3000).settings, { ...settings, sleepUntil: null })
  assert.deepEqual(loadUISettings(.23, memoryStorage()).settings, { version: 1, volumeBeforeMute: .23, sleepUntil: null })
})

test('startup migrates all old lyric preferences and expired calibrations before any song is opened', t => {
  const { disk, legacy } = bridge(t)
  legacy.setItem('yuyin-lyrics-source-v1', 'lrclib')
  const old: SavedLyrics = { track, query: '测试歌', offsetSeconds: -2.5, updatedAt: Date.now() - 40 * 86400000 }
  legacy.setItem(LYRICS_STORAGE_KEY, JSON.stringify({ version: 1, entries: { [bvid]: old } }))
  legacy.setItem(BILIBILI_LYRICS_STORAGE_KEY, JSON.stringify({ version: 1, entries: { [bvid]: { ...old, offsetSeconds: .3 } } }))
  assert.equal(loadUISettings(.7).error, null)
  assert.equal(disk.getItem('yuyin-lyrics-source-v1'), 'lrclib')
  assert.ok(disk.getItem(LYRICS_STORAGE_KEY))
  assert.ok(disk.getItem(BILIBILI_LYRICS_STORAGE_KEY))
  assert.ok(disk.getItem(CALIBRATIONS_KEY))
  assert.equal(readLyricsCache(bvid), null, 'Downloaded lyric text still expires')
  assert.equal(readCalibration(bvid, 'lrclib', track), -2.5)
  assert.equal(readCalibration(bvid, 'bilibili', track), .3)
})

test('calibration survives cache expiry and eviction but applies only to its original provider and timeline', () => {
  const storage = memoryStorage()
  assert.equal(saveCalibration(bvid, 'lrclib', track, 1.8, storage).ok, true)
  assert.equal(saveCalibration(bvid, 'bilibili', track, -.3, storage).ok, true)
  storage.setItem(LYRICS_STORAGE_KEY, JSON.stringify({ version: 1, entries: {} }))
  assert.equal(readCalibration(bvid, 'lrclib', track, storage), 1.8)
  assert.equal(readCalibration(bvid, 'bilibili', track, storage), -.3)
  assert.equal(readCalibration(bvid, 'lrclib', { ...track, syncedLyrics: '[00:09.00]另一版本' }, storage), null)
  assert.equal(readCalibration(bvid, 'lrclib', { ...track, id: 3 }, storage), null)
})

test('fresh cache and permanent calibration agree and stale legacy cache cannot overwrite newer calibration', t => {
  const { disk, legacy } = bridge(t)
  const saved: SavedLyrics = { track, query: '测试歌', offsetSeconds: 4, updatedAt: Date.now() }
  assert.equal(saveLyricsCache(bvid, saved).ok, true)
  assert.equal(readCalibration(bvid, 'lrclib', track), 4)
  assert.equal(saveCalibration(bvid, 'lrclib', track, 7).ok, true)
  legacy.setItem(LYRICS_STORAGE_KEY, JSON.stringify({ version: 1, entries: { [bvid]: saved } }))
  loadUISettings(.7)
  assert.equal(readLyricsCache(bvid)?.offsetSeconds, 7)
  assert.ok(disk.getItem(CALIBRATIONS_KEY))
})

test('fixed preferences are authoritative over stale browser values and failed disk writes never fall back', t => {
  const { disk, legacy } = bridge(t)
  disk.setItem('yuyin-lyrics-source-v1', 'bilibili')
  legacy.setItem('yuyin-lyrics-source-v1', 'lrclib')
  assert.equal(preferenceStorage().getItem('yuyin-lyrics-source-v1'), 'bilibili')
  window.musicAPI!.writeLocalPreference = () => { throw new Error('磁盘只读') }
  const result = saveUISettings({ version: 1, volumeBeforeMute: .2, sleepUntil: null })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /磁盘只读/)
  assert.equal(legacy.getItem(UI_SETTINGS_KEY), null)
})

test('unreadable calibration settings are retained and save reports an error', () => {
  const storage = memoryStorage()
  storage.setItem(CALIBRATIONS_KEY, '{damaged')
  assert.equal(saveCalibration(bvid, 'lrclib', track, 1, storage).ok, false)
  assert.equal(storage.getItem(CALIBRATIONS_KEY), '{damaged')
})
