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
  const windowListeners = new Map();
  const pendingEvents = [];
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
      if (this.asyncSeek) {
        this.seeking = true;
        pendingEvents.push(() => this.emit('seeking'), () => { this.seeking = false; this.emit('seeked'); });
      } else { this.emit('seeking'); this.emit('seeked'); }
    },
    async play() { starts.push(this.position); this.paused = false; this.emit('playing'); },
    pause() { this.paused = true; this.emit('pause'); },
  };
  const window = { addEventListener(name, listener) {
    const list = windowListeners.get(name) || []; list.push(listener); windowListeners.set(name, list);
  } };
  const location = { pathname: '/video/' + song.bvid + '/' };
  let currentMedia = media;
  const context = vm.createContext({
    window, location, document: { querySelector: () => currentMedia, body: { innerText: '' } },
    Date: { now: () => now }, setTimeout, clearTimeout, Number, Math, Promise, Error,
  });
  return {
    media, starts, window, context,
    run(command = 'read', requestId = 1, value) { return vm.runInContext(pageScript(command, song.bvid, 0.25, requestId, value), context); },
    elapse(ms, advance = true) { now += ms; if (advance && !media.paused) media.position += ms / 1000 * media.playbackRate; },
    flushSeekEvents() { while (pendingEvents.length) pendingEvents.shift()(); },
    interact(type = 'pointerdown', isTrusted = true) {
      for (const listener of windowListeners.get(type) || []) listener({ type, isTrusted });
    },
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
    page.media.asyncSeek = true;
    const starting = await page.run('play');
    assert.equal(starting.restarting, true, 'Initial correction must remain pending until asynchronous native seek events finish');
    assert.equal(starting.currentTime, 0);
    page.flushSeekEvents();
    assert.equal((await page.run()).restarting, false);
    page.elapse(9100); await page.run();
    assert.equal(page.media.currentTime, 9.1);
    page.media.seeking = true; page.media.emit('seeking');
    const buffering = await page.run();
    assert.equal(buffering.currentTime, 9.1, 'Normal asynchronous seeking without a discontinuity must not reset playback');
    assert.equal(buffering.restarting, false, 'A buffering seek must not masquerade as a source-position correction');
    page.media.seeking = false; page.media.emit('seeked');
    page.elapse(500); await page.run();
    const trustedPosition = page.media.currentTime;
    assert.ok(trustedPosition > 9.5);
    page.media.currentTime = 96;
    page.flushSeekEvents();
    assert.equal(page.media.currentTime, trustedPosition, 'An asynchronous late restore must recover the last listening position');
    assert.equal((await page.run()).restarting, false, 'Delayed correction events must settle without repeating the correction');
    page.media.position = 2; page.media.emit('timeupdate');
    assert.equal(page.media.currentTime, trustedPosition, 'An untrusted backward source jump must preserve the listening position too');
    page.flushSeekEvents();
    page.media.pause(); page.elapse(15000, false); page.media.position = 96;
    assert.equal((await page.run()).currentTime, trustedPosition, 'Elapsed wall time while paused must not legitimize a late history jump');
    page.flushSeekEvents();
    await page.run('play'); page.elapse(1000);
    assert.ok((await page.run()).currentTime > trustedPosition + 0.99, 'Resume must naturally continue after an asynchronous recovery');
  }
  {
    const page = sourcePage(96);
    await page.run('play'); page.elapse(3000); await page.run();
    page.interact('pointerdown', false); page.media.currentTime = 96;
    assert.equal(page.media.currentTime, 3, 'Synthetic page interaction must not release the source timeline guard');
    page.interact('pointerdown', true); page.media.currentTime = 42;
    assert.equal((await page.run()).currentTime, 42, 'Trusted source-player interaction must honor its explicit timeline takeover');
    page.elapse(1000); assert.equal((await page.run()).currentTime, 43);
  }
  {
    const page = sourcePage(96);
    await page.run('play'); page.media.playbackRate = 0.5; page.elapse(1000);
    assert.equal((await page.run()).currentTime, 0.5, 'Slow natural playback must remain valid');
    page.media.playbackRate = 2; page.elapse(1000);
    assert.equal((await page.run()).currentTime, 2.5, 'Fast natural playback must remain valid');
    page.media.emit('waiting'); page.elapse(60000, false); page.media.position = 96;
    assert.equal((await page.run()).currentTime, 2.5, 'Wall time spent stalled must not legitimize a late source jump');
  }

  {
    const instance = player(); const oldStart = deferred();
    instance.status.state = 'loading'; instance.desiredPlayback = true;
    const waiting = instance.awaitPlayback(instance.generation);
    instance.readPage = command => command === 'play' ? oldStart.promise : Promise.resolve(snapshot(9, false));
    const starting = instance.startNativePlayback(instance.generation);
    await instance.poll(); await waiting;
    oldStart.resolve(snapshot(0, true)); await starting;
    assert.equal(instance.getStatus().currentTime, 9, 'An older start command must not overwrite a newer poll position');
    assert.equal(instance.getStatus().state, 'playing', 'An older paused start snapshot must not pause already confirmed playback');
    assert.equal(instance.desiredPlayback, true);
    instance.dispose();
  }
  {
    const instance = player(); const oldStart = deferred();
    instance.status.state = 'loading'; instance.desiredPlayback = true;
    const waiting = instance.awaitPlayback(instance.generation);
    instance.readPage = command => command === 'play' ? oldStart.promise : Promise.resolve(snapshot(9, false));
    const starting = instance.startNativePlayback(instance.generation);
    await instance.poll(); await waiting;
    oldStart.resolve({ ...snapshot(0, true), playError: 'Stale autoplay failure' }); await starting;
    assert.equal(instance.getStatus().state, 'playing', 'An obsolete start error must not fail a newer confirmed playback snapshot');
    instance.dispose();
  }
  {
    const instance = player(); const oldPoll = deferred();
    instance.status.state = 'loading'; instance.desiredPlayback = true;
    const waiting = instance.awaitPlayback(instance.generation);
    instance.readPage = command => command === 'play' ? Promise.resolve(snapshot(9, false)) : oldPoll.promise;
    const polling = instance.poll();
    await instance.startNativePlayback(instance.generation); await waiting;
    oldPoll.resolve(snapshot(0, true)); await polling;
    assert.equal(instance.getStatus().currentTime, 9, 'An older poll must not overwrite a newer completed start');
    assert.equal(instance.getStatus().state, 'playing');
    instance.dispose();
  }
  {
    const instance = player(); const oldStart = deferred();
    instance.status.state = 'loading'; instance.desiredPlayback = true;
    const waiting = instance.awaitPlayback(instance.generation).catch(error => error);
    instance.readPage = command => command === 'play' ? oldStart.promise : Promise.resolve(snapshot(0, true));
    const starting = instance.startNativePlayback(instance.generation);
    await instance.poll();
    oldStart.resolve({ ...snapshot(0, true), playError: 'Controlled autoplay rejection' }); await starting;
    assert.equal((await waiting).code, 'AUTOPLAY_FAILED', 'Newer paused polls must not suppress a real startup error');
    assert.equal(instance.getStatus().state, 'error');
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
    assert.equal(page.media.currentTime, 1.2, 'A delayed source history seeking event must return to the latest trusted listening position');
    page.elapse(1000); await page.run();
    page.media.position = 80;
    assert.equal((await page.run()).currentTime, 2.2, 'Polling must also reject a delayed history jump without losing the listening position');
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
    page.media.position = 96;
    assert.equal((await page.run()).currentTime, 0.7, 'A late source history jump after pause must return to the paused position');
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
    assert.equal(page.media.currentTime, 9, 'Natural playback must continue after the former timeout boundary');
    page.media.position = 96;
    assert.equal((await page.run()).currentTime, 9, 'A late source history jump must return to the latest trusted position after extended playback');
    page.media.position = 52;
    assert.equal((await page.run()).currentTime, 9, 'Repeated source history restores must preserve the listening position');
    await page.run('seek', 1, 42);
    assert.equal(page.media.currentTime, 42, 'A manual seek must explicitly take over the timeline');
    page.elapse(1000);
    assert.equal((await page.run()).currentTime, 43, 'Natural playback must continue after manual takeover');
    const instance = player(); instance.desiredPlayback = true; instance.status.state = 'loading';
    const waiting = instance.awaitPlayback(instance.generation);
    let muted = true; instance.window.webContents.setAudioMuted = value => { muted = value; };
    await instance.consume({ ...snapshot(96, false), ended: true, restarting: true, guardPosition: 0 }, instance.generation);
    assert.equal(instance.status.state, 'loading', 'Startup positioning must not publish playing or release audio');
    assert.equal(muted, true); assert.ok(instance.waiter, 'A transient ended flag during the initial seek must not reject playback');
    await instance.consume({ ...snapshot(0, false), restarting: false }, instance.generation);
    assert.equal((await waiting).currentTime, 0); assert.equal(muted, false);
    await instance.consume(snapshot(9, false), instance.generation);
    await instance.consume({ ...snapshot(96, false), restarting: true, guardPosition: 9 }, instance.generation);
    assert.equal(instance.getStatus().currentTime, 9, 'A pending late correction must publish the trusted position rather than zero or restored history');
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
  console.log('PASS: 10 playback race checks and 8 source-timeline regression groups (late forward/backward restores, trusted-position recovery, async media events, pause/stall/resume, playback rate, manual takeover, repeat/switch, obsolete snapshots and startup audio)');
})().catch(error => { console.error(error); process.exitCode = 1; });
