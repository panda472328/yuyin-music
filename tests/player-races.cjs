const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const bundlePath = path.join(__dirname, '../.qa/player-revision.cjs');
fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../electron/player.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundlePath });
const load = Module._load;
Module._load = function (name, ...args) { return name === 'electron' ? { BrowserWindow: class {} } : load.call(this, name, ...args); };
const { BackgroundPlayer } = require(bundlePath);
Module._load = load;
const song = { id: 'BV1ux411T7Et', bvid: 'BV1ux411T7Et', title: 'Race check', artist: 'Test', duration: 269, cover: '', playCount: 0, source: 'bilibili', url: 'https://www.bilibili.com/video/BV1ux411T7Et/' };
const snapshot = (time, paused = true) => ({ found: true, paused, ended: false, currentTime: time, duration: 269, readyState: 4, playing: !paused, mediaError: 0 });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function player() {
  const instance = new BackgroundPlayer({ session: {} });
  instance.status = { state: 'paused', song, currentTime: 0, duration: 269, volume: 0, error: null };
  instance.window = { isDestroyed: () => false, destroy() {}, webContents: { setAudioMuted() {} } };
  return instance;
}
(async () => {
  {
    const instance = player(); const stale = deferred();
    instance.readPage = command => command === 'seek' ? Promise.resolve(snapshot(33.27)) : stale.promise;
    const poll = instance.poll();
    await instance.seek(33.27);
    stale.resolve(snapshot(0)); await poll;
    assert.equal(instance.getStatus().currentTime, 33.27, 'Old polling snapshot must not replace a seek');
    instance.dispose();
  }
  {
    const instance = player(); const seekSnapshot = deferred(); const stalePoll = deferred();
    instance.readPage = command => command === 'seek' ? seekSnapshot.promise : stalePoll.promise;
    const seeking = instance.seek(33.27);
    const poll = instance.poll();
    seekSnapshot.resolve(snapshot(33.27)); await seeking;
    stalePoll.resolve(snapshot(0)); await poll;
    assert.equal(instance.getStatus().currentTime, 33.27, 'Polling started during a seek must not replace its completed position');
    instance.dispose();
  }
  {
    const instance = player(); const old = deferred();
    instance.readPage = (command, value) => value === 60 ? old.promise : Promise.resolve(snapshot(value));
    const earlier = instance.seek(60);
    await instance.seek(120);
    old.resolve(snapshot(60)); await earlier;
    assert.equal(instance.getStatus().currentTime, 120, 'Only the latest concurrent seek may write back');
    instance.dispose();
  }
  {
    const instance = player(); const stale = deferred();
    instance.readPage = command => command === 'pause' ? stale.promise : Promise.resolve(snapshot(33.27));
    const pause = instance.pause();
    await instance.seek(33.27);
    stale.resolve(snapshot(0)); await pause;
    assert.equal(instance.getStatus().currentTime, 33.27, 'Old pause snapshot must not replace a later seek');
    assert.equal(instance.getStatus().state, 'paused');
    instance.dispose();
  }
  {
    const instance = player(); const stale = deferred();
    instance.status.state = 'loading'; instance.desiredPlayback = true;
    const generation = instance.generation;
    const waiting = instance.awaitPlayback(generation);
    instance.readPage = command => command === 'play' ? stale.promise : Promise.resolve(snapshot(33.27, false));
    const starting = instance.startNativePlayback(generation);
    await instance.seek(33.27);
    assert.equal(instance.generation, generation, 'Seek must retain the playback request generation');
    stale.resolve(snapshot(0, false)); await starting;
    assert.equal(instance.getStatus().currentTime, 33.27, 'Old start-play snapshot must not replace a seek');
    assert.ok(instance.waiter, 'Playback waiter must remain valid after a seek');
    await instance.poll();
    const started = await waiting;
    assert.equal(started.state, 'playing'); assert.equal(started.currentTime, 33.27);
    assert.equal(instance.waiter, null, 'The fresh snapshot must resolve the original loading waiter');
    instance.dispose();
  }
  console.log('PASS: old poll, poll during seek, concurrent seeks, old pause, stale start-play snapshot, loading waiter remains valid');
})().catch(error => { console.error(error); process.exitCode = 1; });
