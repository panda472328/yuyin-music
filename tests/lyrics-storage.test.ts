import test from 'node:test'
import assert from 'node:assert/strict'
import type { LyricsTrack } from '../electron/lyrics-types'
import { BILIBILI_LYRICS_STORAGE_KEY, LYRICS_STORAGE_KEY, readLyricsCache, saveLyricsCache, type SavedLyrics } from '../src/lyrics-storage'

const bvid = (index = 0) => `BV${String(index).padStart(10, '0')}`
const track: LyricsTrack = {
  id: 1, trackName: '晴天', artistName: '周杰伦', albumName: '叶惠美', duration: 269,
  instrumental: false, syncedLyrics: '[00:12.30]故事的小黄花', plainLyrics: '故事的小黄花',
}

function entry(overrides: Partial<SavedLyrics> = {}): SavedLyrics {
  return { track, query: '周杰伦 晴天', offsetSeconds: 0, updatedAt: Date.now(), ...overrides }
}

function memoryStorage(initial?: unknown) {
  const data = new Map<string, string>(initial === undefined ? [] : [[LYRICS_STORAGE_KEY, JSON.stringify(initial)]])
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

test('legacy LRCLIB cache remains readable without adding optional metadata fields', () => {
  const legacy = entry({ offsetSeconds: 2 })
  const storage = memoryStorage({ version: 1, entries: { [bvid()]: legacy } })
  assert.equal(LYRICS_STORAGE_KEY, 'yuyin-lyrics-v1')
  assert.deepEqual(readLyricsCache(bvid(), storage), legacy)
  assert.deepEqual(readLyricsCache(bvid(), storage, 'lrclib'), legacy)
  assert.equal(Object.hasOwn(readLyricsCache(bvid(), storage)!, 'subtitle'), false)
  assert.equal(Object.hasOwn(readLyricsCache(bvid(), storage)!, 'message'), false)
  assert.equal(Object.hasOwn(readLyricsCache(bvid(), storage)!, 'requiresLogin'), false)
  assert.deepEqual(saveLyricsCache(bvid(1), entry(), storage), { ok: true })
  assert.deepEqual(readLyricsCache(bvid(), storage), legacy)
})

test('provider caches keep lyrics and offsets independent for the same video', () => {
  const storage = memoryStorage()
  const lrclib = entry({ offsetSeconds: 3 })
  const bilibili = entry({
    track: { ...track, syncedLyrics: '[00:03.00]视频字幕', plainLyrics: '视频字幕' },
    offsetSeconds: -4,
    subtitle: { language: 'zh-CN', label: '中文（自动生成）', isAI: true },
  })
  assert.deepEqual(saveLyricsCache(bvid(), lrclib, storage), { ok: true })
  const originalLRCLIB = storage.getItem(LYRICS_STORAGE_KEY)
  assert.deepEqual(saveLyricsCache(bvid(), bilibili, storage, 'bilibili'), { ok: true })
  assert.equal(storage.getItem(LYRICS_STORAGE_KEY), originalLRCLIB)
  assert.ok(storage.getItem(BILIBILI_LYRICS_STORAGE_KEY))
  assert.deepEqual(readLyricsCache(bvid(), storage), lrclib)
  assert.deepEqual(readLyricsCache(bvid(), storage, 'bilibili'), bilibili)
  const originalBilibili = storage.getItem(BILIBILI_LYRICS_STORAGE_KEY)
  assert.deepEqual(saveLyricsCache(bvid(), entry({ offsetSeconds: 7 }), storage, 'lrclib'), { ok: true })
  assert.equal(storage.getItem(BILIBILI_LYRICS_STORAGE_KEY), originalBilibili)
  assert.equal(readLyricsCache(bvid(), storage, 'bilibili')?.offsetSeconds, -4)
})

test('subtitle metadata and result messages round-trip with a strict AI flag', () => {
  const storage = memoryStorage()
  const subtitle = entry({
    subtitle: { language: 'zh-CN', label: '中文', isAI: false },
    message: '当前视频的字幕可能包含对白。',
    requiresLogin: false,
  })
  assert.deepEqual(saveLyricsCache(bvid(), subtitle, storage, 'bilibili'), { ok: true })
  assert.deepEqual(readLyricsCache(bvid(), storage, 'bilibili'), subtitle)
  assert.equal(readLyricsCache(bvid(), storage, 'bilibili')?.subtitle?.isAI, false)
  const noSubtitle = entry({ track: null, message: '请登录 Bilibili 查看视频字幕。', requiresLogin: true })
  assert.deepEqual(saveLyricsCache(bvid(1), noSubtitle, storage, 'bilibili'), { ok: true })
  assert.deepEqual(readLyricsCache(bvid(1), storage, 'bilibili'), noSubtitle)
})

test('malformed or oversized subtitle metadata and messages are rejected without erasing valid entries', () => {
  const valid = entry({ subtitle: { language: 'zh-CN', label: '中文', isAI: false } })
  const invalidMetadata: unknown[] = [
    { subtitle: null },
    { subtitle: [] },
    { subtitle: { ...valid.subtitle, isAI: 'false' } },
    { subtitle: { ...valid.subtitle, isAI: 1 } },
    { subtitle: { ...valid.subtitle, language: 1 } },
    { subtitle: { ...valid.subtitle, language: ' ' } },
    { subtitle: { ...valid.subtitle, language: 'x'.repeat(81) } },
    { subtitle: { ...valid.subtitle, label: null } },
    { subtitle: { ...valid.subtitle, label: ' ' } },
    { subtitle: { ...valid.subtitle, label: 'x'.repeat(161) } },
    { message: null },
    { message: 1 },
    { message: 'x'.repeat(1_001) },
    { requiresLogin: null },
    { requiresLogin: 'false' },
    { requiresLogin: 1 },
  ]
  const invalidEntries = invalidMetadata.map((metadata) => ({ ...valid, ...metadata as object }))
  const storage = memoryStorage()
  storage.setItem(BILIBILI_LYRICS_STORAGE_KEY, JSON.stringify({ version: 1, entries: {
    [bvid()]: valid,
    ...Object.fromEntries(invalidEntries.map((value, index) => [bvid(index + 1), value])),
  } }))
  invalidEntries.forEach((value, index) => {
    assert.equal(readLyricsCache(bvid(index + 1), storage, 'bilibili'), null)
    assert.equal(saveLyricsCache(bvid(index + 1), value as SavedLyrics, storage, 'bilibili').ok, false)
  })
  assert.deepEqual(readLyricsCache(bvid(), storage, 'bilibili'), valid)
  assert.deepEqual(saveLyricsCache(bvid(20), entry(), storage, 'bilibili'), { ok: true })
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(BILIBILI_LYRICS_STORAGE_KEY)!).entries).sort(), [bvid(), bvid(20)])
})

test('matched lyrics survive 30 days and no-result entries expire after five minutes', () => {
  for (const provider of ['lrclib', 'bilibili'] as const) {
    const now = Date.now()
    const storage = memoryStorage()
    const key = provider === 'lrclib' ? LYRICS_STORAGE_KEY : BILIBILI_LYRICS_STORAGE_KEY
    storage.setItem(key, JSON.stringify({ version: 1, entries: {
      [bvid(0)]: entry({ updatedAt: now - 29 * 24 * 60 * 60 * 1_000 }),
      [bvid(1)]: entry({ updatedAt: now - 30 * 24 * 60 * 60 * 1_000 }),
      [bvid(2)]: entry({ track: null, requiresLogin: true, updatedAt: now - 4 * 60 * 1_000 }),
      [bvid(3)]: entry({ track: null, requiresLogin: true, updatedAt: now - 5 * 60 * 1_000 }),
    } }))
    assert.deepEqual(readLyricsCache(bvid(0), storage, provider)?.track, track)
    assert.equal(readLyricsCache(bvid(1), storage, provider), null)
    assert.equal(readLyricsCache(bvid(2), storage, provider)?.track, null)
    assert.ok(readLyricsCache(bvid(2), storage, provider)?.requiresLogin)
    assert.equal(readLyricsCache(bvid(3), storage, provider), null)
    assert.deepEqual(saveLyricsCache(bvid(4), entry(), storage, provider), { ok: true })
    const saved = JSON.parse(storage.data.get(key)!)
    assert.deepEqual(Object.keys(saved.entries).sort(), [bvid(0), bvid(2), bvid(4)])
  }
})

test('offsets preserve their direction and clamp to plus or minus 180 seconds', () => {
  const storage = memoryStorage()
  assert.deepEqual(saveLyricsCache(bvid(), entry({ offsetSeconds: 1.5 }), storage), { ok: true })
  assert.equal(readLyricsCache(bvid(), storage)?.offsetSeconds, 1.5)
  saveLyricsCache(bvid(), entry({ offsetSeconds: -500 }), storage)
  assert.equal(readLyricsCache(bvid(), storage)?.offsetSeconds, -180)
  saveLyricsCache(bvid(), entry({ offsetSeconds: 500 }), storage)
  assert.equal(readLyricsCache(bvid(), storage)?.offsetSeconds, 180)
  assert.equal(saveLyricsCache(bvid(), entry({ offsetSeconds: NaN }), storage).ok, false)
})

test('malformed entries do not erase valid cache entries or the independent music library', () => {
  const valid = entry()
  const storage = memoryStorage({ version: 1, entries: {
    [bvid()]: valid,
    [bvid(1)]: { ...valid, track: { ...track, syncedLyrics: 'x'.repeat(100_001) } },
    [bvid(2)]: { ...valid, track: { ...track, instrumental: 'false' } },
    [bvid(3)]: { ...valid, track: {} },
    [bvid(4)]: null,
    ['__proto__']: valid,
  } })
  storage.setItem('yuyin-library-v1', 'original library')
  assert.deepEqual(readLyricsCache(bvid(), storage), valid)
  for (const index of [1, 2, 3, 4]) assert.equal(readLyricsCache(bvid(index), storage), null)
  assert.deepEqual(saveLyricsCache(bvid(5), entry({ track: null }), storage), { ok: true })
  assert.deepEqual(readLyricsCache(bvid(), storage), valid)
  assert.equal(storage.getItem('yuyin-library-v1'), 'original library')
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(LYRICS_STORAGE_KEY)!).entries).sort(), [bvid(), bvid(5)])
  storage.setItem(LYRICS_STORAGE_KEY, '{broken json')
  assert.equal(readLyricsCache(bvid(), storage), null)
  assert.deepEqual(saveLyricsCache(bvid(), valid, storage), { ok: true })
})

test('quota failure returns a usable message and leaves the saved lyrics untouched', () => {
  const original = entry({ offsetSeconds: 2 })
  const storage = memoryStorage({ version: 1, entries: { [bvid()]: original } })
  const failing = {
    getItem: storage.getItem,
    setItem: () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }) },
  }
  const result = saveLyricsCache(bvid(), entry({ offsetSeconds: 3 }), failing)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /空间已满/)
  assert.deepEqual(readLyricsCache(bvid(), failing), original)
  assert.equal(readLyricsCache(bvid(), { getItem: () => { throw new Error('denied') }, setItem: () => {} }), null)
})

test('cache evicts old videos to fit 50 entries and the safe 1.5 MiB total size', () => {
  const now = Date.now()
  const entries = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [bvid(index), entry({ updatedAt: now - 100 + index })]))
  const storage = memoryStorage({ version: 1, entries })
  saveLyricsCache(bvid(50), entry(), storage)
  assert.equal(Object.keys(JSON.parse(storage.getItem(LYRICS_STORAGE_KEY)!).entries).length, 50)
  assert.equal(readLyricsCache(bvid(0), storage), null)
  assert.ok(readLyricsCache(bvid(50), storage))
  const largeTrack = { ...track, syncedLyrics: 'x'.repeat(100_000), plainLyrics: '歌词'.repeat(50_000) }
  for (let index = 51; index < 56; index++) {
    assert.deepEqual(saveLyricsCache(bvid(index), entry({ track: largeTrack }), storage), { ok: true })
  }
  assert.ok(storage.getItem(LYRICS_STORAGE_KEY)!.length * 2 <= 1.5 * 1024 * 1024)
  assert.ok(readLyricsCache(bvid(55), storage))
  assert.equal(readLyricsCache(bvid(51), storage), null)
})
