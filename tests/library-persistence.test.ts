import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { MusicAPI } from '../src/api'
import { initializeLibrary, LIBRARY_STORAGE_KEY, loadLibrary, saveLibrary, toggleFavorite } from '../src/library'
import type { Song } from '../electron/types'

const song: Song = { id: 'BV0000000001', bvid: 'BV0000000001', title: '测试歌曲', artist: '测试音乐人', cover: '', duration: 180, playCount: 1, source: 'bilibili', url: 'https://www.bilibili.com/video/BV0000000001/' }
const empty = () => loadLibrary({ getItem: () => null, setItem() {} })

function withDesktop(t: TestContext, bridge: Pick<MusicAPI, 'readLibrary' | 'writeLibrary'>, legacy: string | null) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const browserWrites: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { musicAPI: bridge } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key: string) { assert.equal(key, LIBRARY_STORAGE_KEY); return legacy },
    setItem(_key: string, json: string) { browserWrites.push(json) },
  } })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  return browserWrites
}

test('desktop startup migrates the previous browser music library before displaying it', t => {
  const previous = toggleFavorite(empty(), song)
  let disk: string | null = null
  withDesktop(t, { readLibrary: () => disk, writeLibrary: json => { disk = json } }, JSON.stringify(previous))
  const result = initializeLibrary()
  assert.equal(result.error, null)
  assert.deepEqual(result.state, previous)
  assert.deepEqual(JSON.parse(disk!), previous)
})

test('an authoritative disk library preserves canceled favorites and empty playlists over stale browser data', t => {
  const deleted = { ...empty(), favorites: [], playlists: [] }
  const writes: string[] = []
  withDesktop(t, { readLibrary: () => JSON.stringify(deleted), writeLibrary: json => writes.push(json) }, JSON.stringify(toggleFavorite(empty(), song)))
  assert.deepEqual(initializeLibrary().state, deleted)
  assert.equal(writes.length, 0)
})

test('a failed read reports the error and never saves fallback defaults', t => {
  let writes = 0
  withDesktop(t, { readLibrary() { throw new Error('文件无法读取') }, writeLibrary() { writes++ } }, JSON.stringify(toggleFavorite(empty(), song)))
  assert.match(initializeLibrary().error!, /文件无法读取/)
  assert.equal(writes, 0)
})

test('failed initial migration keeps loaded songs available for export and reports the failure', t => {
  const previous = toggleFavorite(empty(), song)
  withDesktop(t, { readLibrary: () => null, writeLibrary() { throw new Error('磁盘空间不足') } }, JSON.stringify(previous))
  const result = initializeLibrary()
  assert.deepEqual(result.state, previous)
  assert.match(result.error!, /磁盘空间不足/)
})

test('desktop saves complete synchronously and never hide disk errors behind browser storage', t => {
  let disk = JSON.stringify(empty())
  const browserWrites = withDesktop(t, { readLibrary: () => disk, writeLibrary: json => { disk = json } }, null)
  const changed = toggleFavorite(empty(), song)
  assert.equal(saveLibrary(changed).ok, true)
  assert.equal(JSON.parse(disk).favorites[0].bvid, song.bvid)
  window.musicAPI!.writeLibrary = () => { throw new Error('文件夹只读') }
  const failed = saveLibrary(changed)
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.match(failed.error, /文件夹只读/)
  assert.equal(browserWrites.length, 0)
})

test('invalid legacy JSON is left untouched instead of migrating an empty library', t => {
  let writes = 0
  withDesktop(t, { readLibrary: () => null, writeLibrary() { writes++ } }, '{broken')
  assert.ok(initializeLibrary().error)
  assert.equal(writes, 0)
})
