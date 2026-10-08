import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MusicLibraryStore } from '../electron/library-store'

function library(index = 1): string {
  const song = { bvid: `BV${String(index).padStart(10, '0')}`, title: `收藏的歌 ${index}`, source: 'bilibili' }
  return JSON.stringify({
    version: 1, favorites: [song],
    playlists: [{ id: 'my-playlist', name: '通勤', songs: [song] }],
    history: [{ song, playedAt: index }], queue: [song],
    settings: { volume: 0.5, playMode: 'shuffle', autoPlayFirst: false },
  })
}
const emptyLibrary = JSON.stringify({ version: 1, favorites: [], playlists: [], history: [], queue: [], settings: {} })

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'yuyin-library-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory, store: new MusicLibraryStore(directory),
    primary: join(directory, 'library.json'), backup: join(directory, 'library.json.bak'),
  }
}

test('favorites, playlists, queue, history and settings survive new store instances', t => {
  const { directory, store, primary } = fixture(t)
  assert.equal(store.read(), null)
  const json = library()
  store.write(json)
  assert.equal(readFileSync(primary, 'utf8'), json)
  assert.equal(new MusicLibraryStore(directory).read(), json)
  const nested = new MusicLibraryStore(join(directory, 'new', 'profile'))
  assert.equal(nested.read(), null)
  nested.write(json)
  assert.equal(new MusicLibraryStore(join(directory, 'new', 'profile')).read(), json)
})

test('each committed save keeps only the last valid prior library and leaves no temporary files', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(library(1))
  assert.equal(existsSync(backup), false)
  store.write(library(2))
  assert.equal(readFileSync(backup, 'utf8'), library(1))
  store.write(library(3))
  assert.equal(readFileSync(backup, 'utf8'), library(2))
  assert.equal(readFileSync(primary, 'utf8'), library(3))
  assert.deepEqual(readdirSync(directory).sort(), ['library.json', 'library.json.bak'])
})

test('a corrupt primary recovers its valid backup and never replaces that backup with corrupt text', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(library(1))
  store.write(library(2))
  writeFileSync(primary, '{broken JSON')
  const restarted = new MusicLibraryStore(directory)
  assert.equal(restarted.read(), library(1))
  assert.equal(readFileSync(primary, 'utf8'), '{broken JSON')
  restarted.write(library(3))
  assert.equal(new MusicLibraryStore(directory).read(), library(3))
  assert.equal(readFileSync(backup, 'utf8'), library(1))
})

test('a missing primary recovers the backup, while intentionally deleted songs and playlists stay deleted', t => {
  const { directory, store, primary, backup } = fixture(t)
  writeFileSync(backup, library())
  assert.equal(store.read(), library())
  store.write(emptyLibrary)
  assert.equal(new MusicLibraryStore(directory).read(), emptyLibrary)
  assert.equal(readFileSync(backup, 'utf8'), library())
  writeFileSync(backup, '{bad backup')
  assert.equal(new MusicLibraryStore(directory).read(), emptyLibrary)
  assert.equal(readFileSync(primary, 'utf8'), emptyLibrary)
})

test('unreadable existing data blocks default saves until disk can be read successfully', t => {
  const { store, primary, backup } = fixture(t)
  writeFileSync(primary, '{broken primary')
  writeFileSync(backup, '{broken backup')
  assert.throws(() => store.read(), /读取失败.*保护已有收藏/)
  assert.throws(() => store.write(emptyLibrary), /读取失败/)
  assert.equal(readFileSync(primary, 'utf8'), '{broken primary')
  assert.equal(readFileSync(backup, 'utf8'), '{broken backup')
  writeFileSync(primary, library())
  assert.equal(store.read(), library())
  store.write(emptyLibrary)
  assert.equal(store.read(), emptyLibrary)
  assert.equal(readFileSync(backup, 'utf8'), library())
})

test('the first write also checks a corrupt lone primary or lone backup', t => {
  const { directory, primary, backup } = fixture(t)
  writeFileSync(primary, '{bad')
  assert.throws(() => new MusicLibraryStore(directory).write(emptyLibrary), /读取失败/)
  assert.equal(readFileSync(primary, 'utf8'), '{bad')
  rmSync(primary)
  writeFileSync(backup, '{bad')
  assert.throws(() => new MusicLibraryStore(directory).write(emptyLibrary), /读取失败/)
  assert.equal(existsSync(primary), false)
})

test('each write rechecks files so corruption after a successful read cannot erase data', t => {
  const { store, primary } = fixture(t)
  store.write(library())
  assert.equal(store.read(), library())
  writeFileSync(primary, '{damaged after load')
  assert.throws(() => store.write(emptyLibrary), /读取失败/)
  assert.equal(readFileSync(primary, 'utf8'), '{damaged after load')
})

test('invalid root fields, JSON and oversized text are rejected before touching saved files', t => {
  const { store, primary, backup } = fixture(t)
  store.write(library())
  const valid = JSON.parse(emptyLibrary)
  const invalid = [
    '{bad', 'null', '[]', '{}', JSON.stringify({ ...valid, version: 2 }),
    ...['favorites', 'playlists', 'history', 'queue'].map(key => JSON.stringify({ ...valid, [key]: {} })),
    ...[null, [], 'settings', 3].map(settings => JSON.stringify({ ...valid, settings })),
    JSON.stringify({ ...valid, extra: 'x'.repeat(8 * 1024 * 1024) }),
  ]
  for (const json of invalid) assert.throws(() => store.write(json), /音乐库/)
  assert.equal(readFileSync(primary, 'utf8'), library())
  assert.equal(existsSync(backup), false)
})

test('oversized disk files and non-file paths cannot be treated as an empty library', t => {
  const { directory, store, primary } = fixture(t)
  writeFileSync(primary, '')
  truncateSync(primary, 32 * 1024 * 1024 + 1)
  assert.throws(() => store.read(), /文件过大/)
  assert.throws(() => store.write(emptyLibrary), /文件过大/)
  rmSync(primary)
  mkdirSync(primary)
  assert.throws(() => new MusicLibraryStore(directory).read(), /不是文件/)
  assert.throws(() => new MusicLibraryStore(directory).write(emptyLibrary), /不是文件/)
})

test('a failed atomic backup replacement leaves the primary unchanged and cleans temporary files', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(library())
  mkdirSync(backup)
  assert.throws(() => store.write(emptyLibrary), /保存失败/)
  assert.equal(readFileSync(primary, 'utf8'), library())
  assert.equal(new MusicLibraryStore(directory).read(), library())
  assert.deepEqual(readdirSync(directory).sort(), ['library.json', 'library.json.bak'])
  rmSync(backup, { recursive: true })
  store.write(emptyLibrary)
  assert.equal(new MusicLibraryStore(directory).read(), emptyLibrary)
})
