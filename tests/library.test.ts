import test from 'node:test'
import assert from 'node:assert/strict'
import type { Song } from '../electron/types'
import {
  LIBRARY_STORAGE_KEY, loadLibrary, saveLibrary, toggleFavorite, createPlaylist,
  renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, recordHistory, getNextIndex, importBilibiliPlaylist,
  type LibraryStorage,
} from '../src/library'

function song(index = 0): Song {
  const bvid = `BV${String(index).padStart(10, '0')}`
  return { id: bvid, bvid, title: `歌曲 ${index}`, artist: '音乐人', cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
    duration: 240, playCount: 1000, source: 'bilibili', url: `https://www.bilibili.com/video/${bvid}/` }
}

function memoryStorage(initial?: string): LibraryStorage {
  const store = new Map<string, string>(initial === undefined ? [] : [[LIBRARY_STORAGE_KEY, initial]])
  return { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value) } }
}

test('favorite-folder imports preserve local additions, deduplicate and stay separate across accounts', () => {
  const initial = loadLibrary(memoryStorage())
  const first = importBilibiliPlaylist(initial, { accountMid: 123, folderId: 456, name: 'B 站收藏', songs: [song(1), song(1), song(2)] })
  assert.equal(first.count, 2)
  assert.equal(first.state.playlists.length, initial.playlists.length + 1)
  assert.equal(initial.playlists.length, 2)
  const edited = addToPlaylist(first.state, first.playlistId, song(3))
  const refreshed = importBilibiliPlaylist(edited, { accountMid: 123, folderId: 456, name: '新的名字', songs: [song(2), song(4)] })
  assert.equal(refreshed.playlistId, first.playlistId)
  assert.equal(refreshed.state.playlists.length, first.state.playlists.length)
  assert.deepEqual(refreshed.state.playlists.at(-1)!.songs.map(item => item.bvid), [song(1), song(2), song(3), song(4)].map(item => item.bvid))
  const differentAccount = importBilibiliPlaylist(refreshed.state, { accountMid: 789, folderId: 456, name: '另一个账号', songs: [song(5)] })
  assert.notEqual(differentAccount.playlistId, first.playlistId)
  const storage = memoryStorage()
  assert.equal(saveLibrary(differentAccount.state, storage).ok, true)
  assert.equal(loadLibrary(storage).playlists.find(item => item.id === first.playlistId)?.songs.length, 4)
})

test('favorite-folder imports reject oversized merges without removing existing songs', () => {
  const first = importBilibiliPlaylist(loadLibrary(memoryStorage()), { accountMid: 123, folderId: 456, name: '大歌单', songs: Array.from({ length: 3_000 }, (_, index) => song(index)) })
  assert.throws(() => importBilibiliPlaylist(first.state, { accountMid: 123, folderId: 456, name: '大歌单', songs: [song(3_001)] }), /3000/)
  assert.equal(first.state.playlists.at(-1)!.songs.length, 3_000)
})

test('new library has independent default playlists and settings', () => {
  const state = loadLibrary(memoryStorage())
  assert.deepEqual(state.playlists.map(item => item.name), ['我的歌单', '深夜耳机'])
  assert.deepEqual(state.settings, { volume: 0.7, playMode: 'sequence', autoPlayFirst: true })
  state.playlists[0].songs.push(song())
  assert.equal(loadLibrary(memoryStorage()).playlists[0].songs.length, 0)
})

test('favorites and playlist edits preserve the input library and avoid duplicates', () => {
  const initial = loadLibrary(memoryStorage())
  const favorite = toggleFavorite(initial, song())
  assert.equal(initial.favorites.length, 0)
  assert.equal(favorite.favorites.length, 1)
  assert.equal(toggleFavorite(favorite, song()).favorites.length, 0)
  let state = createPlaylist(initial, '  上班路上  ', '路上听')
  const id = state.playlists.at(-1)!.id
  assert.equal(state.playlists.at(-1)!.name, '上班路上')
  state = addToPlaylist(addToPlaylist(state, id, song()), id, song())
  assert.equal(state.playlists.at(-1)!.songs.length, 1)
  assert.equal(initial.playlists.length, 2)
  state = renamePlaylist(state, id, '通勤')
  assert.equal(state.playlists.at(-1)!.name, '通勤')
  state = removeFromPlaylist(state, id, song().id)
  assert.equal(state.playlists.at(-1)!.songs.length, 0)
  state = deletePlaylist(state, id)
  assert.equal(state.playlists.length, 2)
  assert.equal(createPlaylist(state, '  '), state)
})

test('history keeps the latest 100 distinct videos, updating repeats at the front', () => {
  let state = loadLibrary(memoryStorage())
  for (let index = 0; index < 105; index++) state = recordHistory(state, song(index), index)
  assert.equal(state.history.length, 100)
  assert.equal(state.history[0].song.bvid, song(104).bvid)
  assert.equal(state.history.at(-1)!.song.bvid, song(5).bvid)
  state = recordHistory(state, song(20), 999)
  assert.equal(state.history[0].song.bvid, song(20).bvid)
  assert.equal(state.history[0].playedAt, 999)
  assert.equal(state.history.length, 100)
  assert.equal(state.history.filter(item => item.song.bvid === song(20).bvid).length, 1)
})

test('library survives a save/load round trip including intentionally empty playlists', () => {
  const storage = memoryStorage()
  let state = loadLibrary(storage)
  state = recordHistory(toggleFavorite(state, song()), song(), 123)
  state.playlists = []
  state.queue = [song()]
  state.settings = { volume: 0.35, playMode: 'shuffle', autoPlayFirst: false }
  assert.deepEqual(saveLibrary(state, storage), { ok: true })
  assert.deepEqual(loadLibrary(storage), state)
})

test('oversized collections fail visibly without truncating or replacing the saved library', () => {
  const storage = memoryStorage()
  const original = toggleFavorite(loadLibrary(storage), song(1))
  assert.equal(saveLibrary(original, storage).ok, true)
  const tooMany = Array.from({ length: 3_001 }, (_, index) => song(index))
  const cases = [
    { ...original, favorites: tooMany },
    { ...original, queue: tooMany },
    { ...original, playlists: [{ ...original.playlists[0], songs: tooMany }] },
    { ...original, playlists: Array.from({ length: 101 }, (_, index) => ({ ...original.playlists[0], id: `playlist-${index}` })) },
  ]
  for (const oversized of cases) {
    const result = saveLibrary(oversized, storage)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /3000|100/)
    assert.deepEqual(loadLibrary(storage), original)
  }
})

test('damaged entries are removed while valid songs, playlists and settings survive', () => {
  const valid = song()
  const state = loadLibrary(memoryStorage(JSON.stringify({
    version: 1,
    favorites: [null, { ...valid, bvid: 'javascript:alert(1)' }, valid, valid],
    playlists: [{ id: 'safe-id', name: '完好的歌单', songs: [valid, {}] }, { id: '__ bad __', name: '坏歌单' }],
    queue: [{ ...song(1), url: 'javascript:alert(1)', cover: 'https://evil.example/track.jpg' }],
    history: [{ song: valid, playedAt: 10 }, { song: valid, playedAt: 30 }, { song: song(2), playedAt: 20 }],
    settings: { volume: 5, playMode: 'shuffle', autoPlayFirst: false },
  })))
  assert.deepEqual(state.favorites, [valid])
  assert.equal(state.playlists.length, 1)
  assert.equal(state.playlists[0].songs.length, 1)
  assert.equal(state.queue[0].url, song(1).url)
  assert.equal(state.queue[0].cover, '')
  assert.deepEqual(state.history.map(item => item.playedAt), [30, 20])
  assert.deepEqual(state.settings, { volume: 1, playMode: 'shuffle', autoPlayFirst: false })
})

test('corrupt JSON and inaccessible storage fall back without throwing', () => {
  assert.equal(loadLibrary(memoryStorage('{ broken')).favorites.length, 0)
  const storage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.doesNotThrow(() => loadLibrary(storage))
  assert.equal(saveLibrary(loadLibrary(memoryStorage()), storage).ok, false)
})

test('storage quota failures return a message for the UI and preserve prior saved data', () => {
  const state = loadLibrary(memoryStorage())
  const oldValue = JSON.stringify(state)
  const storage: LibraryStorage = {
    getItem: () => oldValue,
    setItem: () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }) },
  }
  const result = saveLibrary(toggleFavorite(state, song()), storage)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /空间已满/)
  assert.deepEqual(loadLibrary(storage), state)
})

test('queue handles wraparound, repeat, shuffle, empty and invalid positions', () => {
  const queue = [song(0), song(1), song(2)]
  assert.equal(getNextIndex([], 0, 'sequence'), -1)
  assert.equal(getNextIndex(queue, 2, 'sequence'), 0)
  assert.equal(getNextIndex(queue, 0, 'sequence', -1), 2)
  assert.equal(getNextIndex(queue, 1, 'repeat'), 1)
  assert.equal(getNextIndex(queue, -1, 'sequence'), 0)
  assert.equal(getNextIndex(queue, -1, 'sequence', -1), 2)
  assert.equal(getNextIndex(queue, 1, 'shuffle', 1, () => 0), 0)
  assert.equal(getNextIndex(queue, 1, 'shuffle', 1, () => 1), 2)
  assert.equal(getNextIndex([song()], 0, 'shuffle'), 0)
})
