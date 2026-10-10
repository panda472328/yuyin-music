const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const bundlePath = path.join(__dirname, '../.qa/player-revision.cjs');
fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
require('esbuild').buildSync({ stdin: { contents: fs.readFileSync(path.join(__dirname, '../electron/player.ts'), 'utf8') + '\nexport { pageScript };', resolveDir: path.join(__dirname, '../electron'), sourcefile: 'player.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundlePath });
const load = Module._load;
Module._load = function (name, ...args) { return name === 'electron' ? { BrowserWindow: class {} } : load.call(this, name, ...args); };
const { BackgroundPlayer, pageScript } = require(bundlePath);
const vm = require('node:vm');
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

// Execute the production page script against a controlled, eventful media element.
// No Electron session, cookies or real source video is involved.
function sourcePage(initialTime = 0) {
  let now = 1000;
  const listeners = new Map();
  const starts = [];
  const media = {
    paused: true, ended: false, readyState: 4, duration: 269, playbackRate: 1,
    volume: 0, muted: true, error: null, seeking: false, position: initialTime,
    addEventListener(name, listener) {
      const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list);
    },
    emit(type) { for (const listener of listeners.get(type) || []) listener({ type, target: media }); },
    get currentTime() { return this.position; },
    set currentTime(value) {
      if (this.rejectSeek) throw new Error('Metadata unavailable');
      if (value === this.position) return;
      this.position = value; this.ended = false;
      this.emit('seeking'); this.emit('seeked');
    },
    async play() { starts.push(this.position); this.paused = false; this.emit('playing'); },
    pause() { this.paused = true; this.emit('pause'); },
  };
  const window = { addEventListener() {} };
  const location = { pathname: '/video/' + song.bvid + '/' };
  let currentMedia = media;
  const context = vm.createContext({
    window, location, document: { querySelector: () => currentMedia, body: { innerText: '' } },
    Date: { now: () => now }, setTimeout, clearTimeout, Number, Math, Promise, Error,
  });
  return {
    media, starts, window, context,
    run(command = 'read', requestId = 1, value) { return vm.runInContext(pageScript(command, song.bvid, 0.25, requestId, value), context); },
    elapse(ms, advance = true) { now += ms; if (advance && !media.paused) media.position += ms / 1000; },
    navigate(bvid, replacementTime) { location.pathname = '/video/' + bvid + '/'; media.position = replacementTime; window.__biliMusicNativeMedia = undefined; },
    detach() { currentMedia = null; }, attach() { currentMedia = media; },
  };
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

  {
    const page = sourcePage(96);
    const started = await page.run('play');
    assert.deepEqual(page.starts, [0], 'The media must seek to zero before native playback is requested');
    assert.equal(started.currentTime, 0);
    page.elapse(1200);
    await page.run();
    assert.equal(page.media.currentTime, 1.2, 'Ordinary initial playback must advance without repeated resets');
    page.media.currentTime = 96;
    assert.equal(page.media.currentTime, 0, 'A delayed source history seeking event must be cancelled');
    page.elapse(1000); await page.run();
    page.media.position = 80;
    assert.equal((await page.run()).currentTime, 0, 'Polling must also reject a delayed history jump without a seeking event');
  }
  {
    const page = sourcePage(72);
    page.media.readyState = 0; page.media.rejectSeek = true;
    assert.equal((await page.run()).restarting, true, 'A refused startup seek must remain pending');
    page.detach();
    assert.equal((await page.run('seek', 1, 42)).found, false, 'A seek without a video must remain a failure');
    page.attach(); page.elapse(15_000, false);
    page.media.rejectSeek = false; page.media.readyState = 4; page.media.emit('loadedmetadata');
    assert.equal(page.media.currentTime, 0, 'Metadata arriving late must still apply the initial zero position');
    await page.run('play');
    assert.deepEqual(page.starts, [0]);
  }
  {
    const page = sourcePage(96);
    await page.run('play'); page.elapse(700);
    await page.run('pause');
    assert.equal(page.media.currentTime, 0.7);
    await page.run('play');
    assert.deepEqual(page.starts, [0, 0.7], 'Pause and resume must retain the listening position, including during startup');
    await page.run('seek', 1, 42);
    assert.equal(page.media.currentTime, 42, 'A manual seek must disable the startup history guard');
    page.elapse(1000); assert.equal((await page.run()).currentTime, 43);
    await page.run('play', 2);
    assert.equal(page.media.currentTime, 0, 'A repeated selection of the same video must begin again');
    page.elapse(300); page.media.currentTime = 42;
    assert.equal(page.media.currentTime, 0, 'A repeat request must establish a new history guard');
    assert.equal((await page.run('seek', 1, 120)).found, false, 'An obsolete request script must not seek the newly selected song');
    assert.equal(page.media.currentTime, 0);
    const second = { ...song, bvid: 'BV1xx411T7Ex' };
    page.navigate(second.bvid, 66);
    const switched = await vm.runInContext(pageScript('play', second.bvid, 0.25, 3), vm.createContext({
      window: page.window, location: { pathname: '/video/' + second.bvid + '/' },
      document: { querySelector: () => page.media }, Date, setTimeout, clearTimeout,
    }));
    assert.equal(switched.currentTime, 0, 'A different video must also start from zero');
  }
  {
    const page = sourcePage(96);
    await page.run('play'); page.elapse(9000); await page.run();
    page.media.currentTime = 52;
    assert.equal(page.media.currentTime, 52, 'The history guard must end; it must not permanently seize the video timeline');
    const instance = player(); instance.desiredPlayback = true; instance.status.state = 'loading';
    const waiting = instance.awaitPlayback(instance.generation);
    let muted = true; instance.window.webContents.setAudioMuted = value => { muted = value; };
    await instance.consume({ ...snapshot(96, false), ended: true, restarting: true }, instance.generation);
    assert.equal(instance.status.state, 'loading', 'Startup positioning must not publish playing or release audio');
    assert.equal(muted, true); assert.ok(instance.waiter, 'A transient ended flag during the initial seek must not reject playback');
    await instance.consume({ ...snapshot(0, false), restarting: false }, instance.generation);
    assert.equal((await waiting).currentTime, 0); assert.equal(muted, false);
    instance.dispose();
  }

  {
    const page = sourcePage(96); const instance = player(); let loadedUrl = song.url;
    instance.window = {
      isDestroyed: () => false, destroy() {},
      async loadURL(url) { loadedUrl = url; page.context.location.pathname = new URL(url).pathname; },
      webContents: {
        isDestroyed: () => false, isLoadingMainFrame: () => false, setAudioMuted() {},
        getURL: () => loadedUrl,
        executeJavaScript: script => vm.runInContext(script, page.context),
      },
    };
    assert.equal((await instance.play(song)).currentTime, 0, 'Production play(song) must start a fresh zero-position source request');
    await instance.seek(42); await instance.pause();
    assert.equal((await instance.resume()).currentTime, 42, 'Production pause/resume must keep the source request ID and manual position');
    assert.equal((await instance.play(song)).currentTime, 0, 'Production same-song replay must increment the source request ID');
    page.media.position = 86;
    const next = { ...song, id: 'BV1xx411T7Ex', bvid: 'BV1xx411T7Ex' };
    assert.equal((await instance.play(next)).currentTime, 0, 'Production song switching must independently reset the source timeline');
    assert.equal(instance.getStatus().song.bvid, next.bvid);
    instance.dispose();
  }
  console.log('PASS: 6 playback race checks and 5 source-start regressions (saved progress, delayed history, metadata, pause/resume, seek, repeat/switch, stale requests, bounded guard and startup audio)');
})().catch(error => { console.error(error); process.exitCode = 1; });
