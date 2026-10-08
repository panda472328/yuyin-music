import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { DesktopSettingsStore, desktopSettingsPatch, type SavedDesktopSettings } from '../electron/desktop-settings-store'

function settings(enabled = true): SavedDesktopSettings {
  return {
    version: 1,
    settings: { enabled, locked: true, font: 'kai', fontSize: 44, color: 'gold', opacity: .6 },
    bounds: { x: 287, y: 631, width: 900, height: 200 },
  }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'yuyin-desktop-settings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory, store: new DesktopSettingsStore(directory),
    primary: join(directory, 'desktop-lyrics.json'), backup: join(directory, 'desktop-lyrics.json.bak'),
  }
}

test('desktop style, lock, opacity, visibility and position survive a new store instance', t => {
  const { directory, store } = fixture(t)
  assert.deepEqual(store.read(), { data: null, error: null })
  store.write(settings())
  assert.deepEqual(new DesktopSettingsStore(directory).read(), { data: settings(), error: null })
  assert.deepEqual(readdirSync(directory), ['desktop-lyrics.json'])
})

test('older version 1 desktop settings retain style and position while defaulting optional fields', t => {
  const { store, primary } = fixture(t)
  writeFileSync(primary, JSON.stringify({
    version: 1,
    settings: { enabled: true, font: 'serif', fontSize: 32, color: 'mint' },
    bounds: { x: 12, y: 400 },
  }))
  assert.deepEqual(store.read(), {
    data: {
      version: 1,
      settings: { enabled: true, locked: false, font: 'serif', fontSize: 32, color: 'mint', opacity: 1 },
      bounds: { x: 12, y: 400, width: 900, height: 200 },
    }, error: null,
  })
})

test('a corrupt primary recovers the last valid backup and preserves it on repair', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(settings())
  store.write(settings(false))
  writeFileSync(primary, '{broken')
  const restarted = new DesktopSettingsStore(directory)
  assert.deepEqual(restarted.read().data, settings())
  assert.equal(readFileSync(primary, 'utf8'), '{broken')
  restarted.write(settings(false))
  assert.deepEqual(new DesktopSettingsStore(directory).read().data, settings(false))
  assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), settings())
})

test('a saved disabled overlay stays disabled even if a backup was enabled', t => {
  const { directory, store } = fixture(t)
  store.write(settings())
  store.write(settings(false))
  assert.deepEqual(new DesktopSettingsStore(directory).read().data, settings(false))
})

test('unrecoverable corrupt files cannot be overwritten by defaults or later changes', t => {
  const { store, primary, backup } = fixture(t)
  writeFileSync(primary, '{broken primary')
  writeFileSync(backup, '{broken backup')
  assert.match(store.read().error!, /保护已有设置.*停止自动保存/)
  assert.throws(() => store.write(settings(false)), /保护已有设置/)
  assert.equal(readFileSync(primary, 'utf8'), '{broken primary')
  assert.equal(readFileSync(backup, 'utf8'), '{broken backup')
  writeFileSync(primary, JSON.stringify(settings()))
  store.write(settings(false))
  assert.deepEqual(store.read().data, settings(false))
})

test('every write rechecks files and blocks corruption that happened after loading', t => {
  const { store, primary } = fixture(t)
  store.write(settings())
  assert.deepEqual(store.read().data, settings())
  writeFileSync(primary, '{damaged after load')
  assert.throws(() => store.write(settings(false)), /读取.*设置失败/)
  assert.equal(readFileSync(primary, 'utf8'), '{damaged after load')
})

test('oversized files, invalid schemas and non-file paths remain intact', t => {
  const { store, primary } = fixture(t)
  for (const data of ['x'.repeat(8193), '{}', JSON.stringify({ ...settings(), bounds: { x: 'bad', y: 5 } })]) {
    writeFileSync(primary, data)
    assert.notEqual(store.read().error, null)
    assert.throws(() => store.write(settings(false)))
    assert.equal(readFileSync(primary, 'utf8'), data)
  }
  rmSync(primary)
  mkdirSync(primary)
  assert.notEqual(store.read().error, null)
  assert.throws(() => store.write(settings(false)))
})

test('failed backup writes retain primary preferences and clean temporary files', t => {
  const { directory, store, primary, backup } = fixture(t)
  store.write(settings())
  mkdirSync(backup)
  assert.throws(() => store.write(settings(false)), /保存.*设置失败/)
  assert.deepEqual(JSON.parse(readFileSync(primary, 'utf8')), settings())
  assert.deepEqual(readdirSync(directory).sort(), ['desktop-lyrics.json', 'desktop-lyrics.json.bak'])
})

test('desktop setting patches reject invalid fields and ranges', () => {
  for (const patch of [{ opacity: .1 }, { opacity: NaN }, { locked: 'yes' }, { font: 'unknown' }, { fontSize: 100 }, { surprise: true }]) {
    assert.throws(() => desktopSettingsPatch(patch), /设置不合法/)
  }
  assert.deepEqual(desktopSettingsPatch({ opacity: .3, locked: false }), { opacity: .3, locked: false })
})

let controllerBundle: Promise<string> | undefined
const requireModule = createRequire(import.meta.url)

async function controllerHarness(directory: string) {
  controllerBundle ??= build({
    entryPoints: [join(process.cwd(), 'electron', 'desktop-lyrics.ts')],
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
  }).then(result => result.outputFiles[0].text)
  const windows: FakeWindow[] = []
  class FakeWindow extends EventEmitter {
    destroyed = false
    bounds: { x: number; y: number; width: number; height: number }
    webContents = Object.assign(new EventEmitter(), {
      id: windows.length + 1,
      send() {}, setWindowOpenHandler() {},
    })
    constructor(options: { x: number; y: number; width: number; height: number }) {
      super()
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    getPosition() { return [this.bounds.x, this.bounds.y] }
    getBounds() { return { ...this.bounds } }
    setPosition(x: number, y: number) { this.bounds.x = x; this.bounds.y = y; this.emit('move') }
    async loadFile() {}
    async loadURL() {}
    showInactive() {}
    hide() {}
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  const fakeElectron = {
    app: { getPath: () => directory }, BrowserWindow: FakeWindow,
    ipcMain: { handle() {}, removeHandler() {} },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    screen: Object.assign(new EventEmitter(), {
      getDisplayMatching: () => display, getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: -1, y: -1 }),
    }),
  }
  const module = { exports: {} as { DesktopLyricsController: new (options: object) => any } }
  new Function('require', 'module', 'exports', '__dirname', await controllerBundle)(
    (id: string) => id === 'electron' ? fakeElectron : requireModule(id), module, module.exports, directory,
  )
  return { controller: new module.exports.DesktopLyricsController({ isMainSender: () => true, getCurrentBvid: () => null }), windows }
}

test('early settings requests wait for saved settings before applying a patch', async t => {
  const { directory, store } = fixture(t)
  store.write(settings(false))
  const { controller } = await controllerHarness(directory)
  t.after(() => controller.dispose())
  const changing = controller.updateSettings({ font: 'rounded' })
  await controller.initialize()
  const snapshot = await changing
  assert.deepEqual(snapshot.settings, { ...settings(false).settings, font: 'rounded' })
  assert.deepEqual(new DesktopSettingsStore(directory).read().data?.settings, snapshot.settings)
})

test('immediate disposal completes accepted setting changes and rejects new ones', async t => {
  const { directory, store } = fixture(t)
  store.write(settings(false))
  const { controller } = await controllerHarness(directory)
  await controller.initialize()
  const changing = controller.updateSettings({ opacity: .45, font: 'serif', enabled: true })
  const disposing = controller.dispose()
  await assert.rejects(controller.updateSettings({ color: 'white' }), /已退出/)
  await Promise.all([changing, disposing])
  assert.deepEqual(new DesktopSettingsStore(directory).read().data?.settings, {
    ...settings().settings, opacity: .45, font: 'serif',
  })
})

test('closing before initialization applies early patches onto stored preferences', async t => {
  const { directory, store } = fixture(t)
  store.write(settings(false))
  const { controller, windows } = await controllerHarness(directory)
  const changing = controller.updateSettings({ opacity: .5 })
  await Promise.all([changing, controller.dispose()])
  assert.equal(windows.length, 0)
  assert.deepEqual(new DesktopSettingsStore(directory).read().data?.settings, {
    ...settings(false).settings, opacity: .5,
  })
})

test('closing during a pending drag keeps final position and settings on next controller', async t => {
  const { directory, store } = fixture(t)
  store.write(settings())
  const first = await controllerHarness(directory)
  await first.controller.initialize()
  first.windows[0].setPosition(415, 742)
  const changing = first.controller.updateSettings({ locked: false, fontSize: 40 })
  await Promise.all([changing, first.controller.dispose()])
  const second = await controllerHarness(directory)
  t.after(() => second.controller.dispose())
  await second.controller.initialize()
  assert.deepEqual(second.windows[0].getPosition(), [415, 742])
  assert.deepEqual(second.controller.getSnapshot().settings, { ...settings().settings, locked: false, fontSize: 40 })
  assert.equal(existsSync(join(directory, 'desktop-lyrics.json.bak')), true)
})

test('the login gate hides an enabled overlay without changing its saved preference', async t => {
  const { directory, store } = fixture(t)
  store.write(settings())
  const { controller, windows } = await controllerHarness(directory)
  t.after(() => controller.dispose())
  await controller.setSessionAvailable(false)
  await controller.initialize()
  assert.equal(windows.length, 0)
  assert.deepEqual(controller.getSnapshot().settings, settings().settings)
  assert.deepEqual(store.read().data, settings())
  await controller.setSessionAvailable(true)
  assert.equal(windows.length, 1)
  assert.deepEqual(windows[0].getPosition(), [287, 631])
})

test('losing login flushes a pending drag and restores the enabled overlay at the same position', async t => {
  const { directory, store } = fixture(t)
  store.write(settings())
  const { controller, windows } = await controllerHarness(directory)
  t.after(() => controller.dispose())
  await controller.initialize()
  windows[0].setPosition(411, 622)
  await controller.setSessionAvailable(false)
  assert.equal(windows[0].isDestroyed(), true)
  assert.equal(store.read().data?.settings.enabled, true)
  assert.deepEqual(store.read().data?.bounds, { x: 411, y: 622, width: 900, height: 200 })
  await controller.setSessionAvailable(true)
  assert.equal(windows.length, 2)
  assert.deepEqual(windows[1].getPosition(), [411, 622])
  assert.deepEqual(controller.getSnapshot().settings, settings().settings)
})
