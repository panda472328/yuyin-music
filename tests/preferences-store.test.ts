import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPreferencesStore } from '../electron/preferences-store'

const SOURCE = 'yuyin-lyrics-source-v1'
const LYRICS = 'yuyin-lyrics-v1'
const BILIBILI = 'yuyin-bilibili-subtitles-v1'
const UI = 'yuyin-ui-settings-v1'
const CALIBRATIONS = 'yuyin-lyric-calibrations-v1'
const WINDOW = 'yuyin-window-state-v1'
const emptyEntries = JSON.stringify({ version: 1, entries: {} })
const ui = (volumeBeforeMute = 0.5, sleepUntil: number | null = null) => JSON.stringify({ version: 1, volumeBeforeMute, sleepUntil })
const file = (values: Record<string, string>) => JSON.stringify({ version: 1, values })

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'yuyin-preferences-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory, store: new LocalPreferencesStore(directory),
    primary: join(directory, 'preferences.json'), backup: join(directory, 'preferences.json.bak'),
  }
}

test('all settings and cache records survive new instances without sharing values between keys', t => {
  const { directory, store } = fixture(t)
  const records: Record<string, string> = {
    [SOURCE]: 'lrclib',
    [LYRICS]: JSON.stringify({ version: 1, entries: { BV0000000001: { query: '搜索歌词', offsetSeconds: 0.7 } } }),
    [BILIBILI]: JSON.stringify({ version: 1, entries: { BV0000000001: { query: 'AI 字幕', offsetSeconds: -0.4 } } }),
    [UI]: ui(0.7, 10_000),
    [CALIBRATIONS]: JSON.stringify({ version: 1, entries: { BV0000000001: { lrclib: 1, bilibili: -0.4 } } }),
    [WINDOW]: JSON.stringify({ version: 1, bounds: { x: -100, y: 50, width: 1280, height: 900 }, maximized: true }),
  }
  for (const [key, value] of Object.entries(records)) {
    assert.equal(store.read(key), null)
    store.write(key, value)
  }
  for (const [key, value] of Object.entries(records)) assert.equal(new LocalPreferencesStore(directory).read(key), value)
  const nested = new LocalPreferencesStore(join(directory, 'new', 'profile'))
  assert.equal(nested.read(SOURCE), null)
  nested.write(SOURCE, 'bilibili')
  assert.equal(new LocalPreferencesStore(join(directory, 'new', 'profile')).read(SOURCE), 'bilibili')
})

test('separate instances merge keys from disk instead of overwriting settings loaded earlier', t => {
  const { directory, store } = fixture(t)
  const other = new LocalPreferencesStore(directory)
  assert.equal(other.read(UI), null)
  store.write(SOURCE, 'lrclib')
  other.write(UI, ui())
  store.write(LYRICS, emptyEntries)
  assert.equal(other.read(SOURCE), 'lrclib')
  assert.equal(store.read(UI), ui())
  assert.equal(other.read(LYRICS), emptyEntries)
})

test('each save keeps the last valid prior file and leaves no temporary files', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(SOURCE, 'lrclib')
  assert.equal(existsSync(backup), false)
  const first = readFileSync(primary, 'utf8')
  store.write(UI, ui())
  assert.equal(readFileSync(backup, 'utf8'), first)
  const second = readFileSync(primary, 'utf8')
  store.write(SOURCE, 'bilibili')
  assert.equal(readFileSync(backup, 'utf8'), second)
  assert.deepEqual(readdirSync(directory).sort(), ['preferences.json', 'preferences.json.bak'])
})

test('a corrupt or missing primary recovers its valid backup and preserves that backup on repair', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(SOURCE, 'lrclib')
  store.write(SOURCE, 'bilibili')
  const previous = readFileSync(backup, 'utf8')
  writeFileSync(primary, '{broken JSON')
  const restarted = new LocalPreferencesStore(directory)
  assert.equal(restarted.read(SOURCE), 'lrclib')
  assert.equal(readFileSync(primary, 'utf8'), '{broken JSON')
  restarted.write(UI, ui())
  assert.equal(readFileSync(backup, 'utf8'), previous)
  assert.equal(new LocalPreferencesStore(directory).read(UI), ui())
  rmSync(primary)
  assert.equal(store.read(SOURCE), 'lrclib')
  store.write(SOURCE, 'bilibili')
  assert.equal(readFileSync(backup, 'utf8'), previous)
})

test('an empty cache, reset setting or absent key in a valid primary never revives the backup value', t => {
  const { store, primary, backup } = fixture(t)
  store.write(LYRICS, JSON.stringify({ version: 1, entries: { BV0000000001: { offsetSeconds: 1 } } }))
  store.write(LYRICS, emptyEntries)
  assert.equal(store.read(LYRICS), emptyEntries)
  writeFileSync(primary, file({ [SOURCE]: 'bilibili', [UI]: ui(0.5, null) }))
  assert.equal(store.read(LYRICS), null)
  assert.equal(store.read(SOURCE), 'bilibili')
  assert.equal(store.read(UI), ui(0.5, null))
  writeFileSync(backup, '{bad backup')
  assert.equal(store.read(SOURCE), 'bilibili')
})

test('unreadable settings block writes and do not get replaced by defaults', t => {
  const { store, primary, backup } = fixture(t)
  writeFileSync(primary, '{broken primary')
  writeFileSync(backup, '{broken backup')
  assert.throws(() => store.read(SOURCE), /读取失败.*保护已有设置/)
  assert.throws(() => store.write(SOURCE, 'bilibili'), /读取失败/)
  assert.equal(readFileSync(primary, 'utf8'), '{broken primary')
  assert.equal(readFileSync(backup, 'utf8'), '{broken backup')
  writeFileSync(primary, file({ [SOURCE]: 'lrclib' }))
  store.write(SOURCE, 'bilibili')
  assert.equal(store.read(SOURCE), 'bilibili')
  assert.equal(readFileSync(backup, 'utf8'), file({ [SOURCE]: 'lrclib' }))
})

test('every write checks current disk state, including a corrupt lone primary or backup', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(SOURCE, 'lrclib')
  assert.equal(store.read(SOURCE), 'lrclib')
  writeFileSync(primary, '{damaged after load')
  assert.throws(() => store.write(SOURCE, 'bilibili'), /读取失败/)
  assert.equal(readFileSync(primary, 'utf8'), '{damaged after load')
  rmSync(primary)
  writeFileSync(backup, '{bad')
  assert.throws(() => new LocalPreferencesStore(directory).write(SOURCE, 'bilibili'), /读取失败/)
  assert.equal(existsSync(primary), false)
})

test('unknown keys, path-like keys and prototype keys cannot be read, written or loaded from disk', t => {
  const { store, primary } = fixture(t)
  store.write(SOURCE, 'lrclib')
  const original = readFileSync(primary, 'utf8')
  for (const key of ['unknown', '../library.json', '__proto__', 'prototype', 'constructor', 'toString']) {
    assert.throws(() => store.read(key), /不支持的设置/)
    assert.throws(() => store.write(key, 'bilibili'), /不支持的设置/)
    assert.equal(readFileSync(primary, 'utf8'), original)
  }
  writeFileSync(primary, '{"version":1,"values":{"__proto__":"bilibili"}}')
  assert.throws(() => store.read(SOURCE), /不支持的设置/)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})

test('invalid value types, envelopes, bounds and excessive cache data leave saved settings untouched', t => {
  const { store, primary, backup } = fixture(t)
  store.write(SOURCE, 'bilibili')
  const original = readFileSync(primary, 'utf8')
  const invalid: [string, unknown][] = [
    [SOURCE, 'other'], [SOURCE, null], [SOURCE, {}],
    [LYRICS, '{bad'], [LYRICS, 'null'], [LYRICS, '[]'], [LYRICS, '{}'],
    [LYRICS, JSON.stringify({ version: 2, entries: {} })],
    [LYRICS, JSON.stringify({ version: 1, entries: [] })],
    [LYRICS, JSON.stringify({ version: 1, entries: {}, extra: true })],
    [BILIBILI, JSON.stringify({ version: 1, entries: { padding: 'x'.repeat(786_432) } })],
    [LYRICS, JSON.stringify({ version: 1, entries: { padding: 'x'.repeat(786_432) } })],
    [CALIBRATIONS, JSON.stringify({ version: 1, entries: { padding: 'x'.repeat(2 * 1024 * 1024) } })],
    [UI, ui(-0.1)], [UI, ui(1.1)], [UI, ui(0.5, -1)], [UI, ui(0.5, 1.5)], [UI, ui(0.5, Number.MAX_SAFE_INTEGER + 1)],
    [UI, JSON.stringify({ version: 1, volumeBeforeMute: '0.5', sleepUntil: null })],
    [UI, JSON.stringify({ version: 1, volumeBeforeMute: 0.5 })],
    [WINDOW, JSON.stringify({ version: 1, bounds: { x: 0.1, y: 0, width: 1000, height: 700 }, maximized: false })],
    [WINDOW, JSON.stringify({ version: 1, bounds: { x: 0, y: 0, width: 1000 }, maximized: false })],
    [WINDOW, JSON.stringify({ version: 1, bounds: { x: 0, y: 0, width: 1000, height: 700 }, maximized: 'true' })],
  ]
  for (const [key, value] of invalid) assert.throws(() => store.write(key, value as string), /设置|歌词/)
  assert.equal(readFileSync(primary, 'utf8'), original)
  assert.equal(existsSync(backup), false)
})

test('malformed root fields, unknown disk keys and oversized disk files are never treated as missing settings', t => {
  const { directory, store, primary } = fixture(t)
  const invalid = [
    '{bad', 'null', '[]', '{}', JSON.stringify({ version: 2, values: {} }),
    JSON.stringify({ version: 1, values: [] }), JSON.stringify({ version: 1, values: null }),
    JSON.stringify({ version: 1, values: {}, extra: true }),
    JSON.stringify({ version: 1, values: { [SOURCE]: true } }),
    JSON.stringify({ version: 1, values: { unknown: 'bilibili' } }),
    JSON.stringify({ version: 1, values: {}, padding: 'x'.repeat(8 * 1024 * 1024) }),
  ]
  for (const json of invalid) {
    writeFileSync(primary, json)
    assert.throws(() => store.read(SOURCE), /读取失败/)
    assert.throws(() => store.write(SOURCE, 'bilibili'), /读取失败/)
    assert.equal(readFileSync(primary, 'utf8'), json)
  }
  writeFileSync(primary, '')
  truncateSync(primary, 32 * 1024 * 1024 + 1)
  assert.throws(() => store.read(SOURCE), /文件过大/)
  rmSync(primary)
  mkdirSync(primary)
  assert.throws(() => new LocalPreferencesStore(directory).read(SOURCE), /不是文件/)
})

test('a failed backup replacement preserves committed primary data and removes temporary files', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(SOURCE, 'lrclib')
  const original = readFileSync(primary, 'utf8')
  mkdirSync(backup)
  assert.throws(() => store.write(SOURCE, 'bilibili'), /保存失败/)
  assert.equal(readFileSync(primary, 'utf8'), original)
  assert.equal(new LocalPreferencesStore(directory).read(SOURCE), 'lrclib')
  assert.deepEqual(readdirSync(directory).sort(), ['preferences.json', 'preferences.json.bak'])
  rmSync(backup, { recursive: true })
  store.write(SOURCE, 'bilibili')
  assert.equal(store.read(SOURCE), 'bilibili')
})

test('a failed primary replacement leaves the valid recovery file available and removes temporary files', t => {
  const { directory, store, primary, backup } = fixture(t)
  const recovery = file({ [SOURCE]: 'lrclib', [UI]: ui(0.8) })
  writeFileSync(backup, recovery)
  mkdirSync(primary)
  assert.equal(store.read(SOURCE), 'lrclib')
  assert.throws(() => store.write(SOURCE, 'bilibili'), /保存失败/)
  assert.equal(readFileSync(backup, 'utf8'), recovery)
  assert.equal(new LocalPreferencesStore(directory).read(UI), ui(0.8))
  assert.deepEqual(readdirSync(directory).sort(), ['preferences.json', 'preferences.json.bak'])
  rmSync(primary, { recursive: true })
  store.write(SOURCE, 'bilibili')
  assert.equal(store.read(SOURCE), 'bilibili')
})

test('cache and calibration size limits allow complete records at the limit and reject one character more', t => {
  const { store } = fixture(t)
  const overhead = JSON.stringify({ version: 1, entries: { padding: '' } }).length
  for (const [key, maximum] of [[LYRICS, 786_432], [BILIBILI, 786_432], [CALIBRATIONS, 2 * 1024 * 1024]] as const) {
    const accepted = JSON.stringify({ version: 1, entries: { padding: 'x'.repeat(maximum - overhead) } })
    assert.equal(accepted.length, maximum)
    store.write(key, accepted)
    assert.equal(store.read(key), accepted)
    const rejected = JSON.stringify({ version: 1, entries: { padding: 'x'.repeat(maximum - overhead + 1) } })
    assert.throws(() => store.write(key, rejected), /数据过大/)
    assert.equal(store.read(key), accepted)
  }
})

test('invalid UTF-8 disk data cannot silently become default settings', t => {
  const { store, primary } = fixture(t)
  writeFileSync(primary, Buffer.from([0xff, 0xfe, 0xff]))
  assert.throws(() => store.read(SOURCE), /读取失败/)
  assert.throws(() => store.write(SOURCE, 'bilibili'), /读取失败/)
  assert.deepEqual(readFileSync(primary), Buffer.from([0xff, 0xfe, 0xff]))
})
