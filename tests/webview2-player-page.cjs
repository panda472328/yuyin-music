const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the exact page-side source shipped inside the WPF host, with an eventful
// controlled media element. These checks do not access Bilibili or a profile.
const source = fs.readFileSync(path.join(__dirname, '../windows-host/PlayerHost.cs'), 'utf8');
const rawScript = source.match(/return \$\$"""\s*([\s\S]*?)\s*""";/)?.[1];
assert.ok(rawScript, 'Production WebView2 page script must be found');
const bvid = 'BV1Qa0000001';
const script = args => rawScript.replace('{{parameters}}', JSON.stringify({ command: 'read', bvid, volume: .25, requestId: 1, generation: 1, controlSequence: 0, desiredPlaying: true, value: null, ...args }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function page(initialTime = 96) {
  let now = 1000;
  let controlSequence = 0;
  let current;
  const windowListeners = new Map();
  const starts = [];
  function media(initial) {
    const listeners = new Map();
    const result = {
      paused: true, ended: false, readyState: 4, duration: 269, playbackRate: 1, volume: 0, muted: true, error: null, seeking: false, position: initial,
      addEventListener(name, callback) { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
      emit(name) { for (const callback of listeners.get(name) || []) callback({ type: name, target: this }); },
      get currentTime() { return this.position; },
      set currentTime(value) { if (this.rejectSeek) throw new Error('Metadata unavailable'); if (this.position === value) return; this.position = value; this.ended = false; this.emit('seeking'); this.emit('seeked'); },
      play() {
        starts.push(this.position);
        const playing = () => { this.paused = false; this.emit('playing'); };
        if (this.pending) return this.pending.promise.then(playing);
        playing(); return Promise.resolve();
      },
      pause() { this.paused = true; this.emit('pause'); },
    };
    return result;
  }
  current = media(initialTime);
  const window = { addEventListener(name, callback) { const list = windowListeners.get(name) || []; list.push(callback); windowListeners.set(name, list); } };
  const location = { protocol: 'https:', pathname: `/video/${bvid}/` };
  const document = { querySelector: () => current, body: { innerText: '' } };
  const context = vm.createContext({ window, location, document, Date: { now: () => now }, setTimeout, clearTimeout, Number, Math, Promise, Error });
  return {
    get video() { return current; }, window, starts, location, document,
    run(args = {}) { const sequence = args.controlSequence ?? controlSequence; controlSequence = Math.max(controlSequence, sequence); return vm.runInContext(script({ ...args, controlSequence: sequence }), context); },
    elapse(ms, advance = true) { now += ms; if (advance && !current.paused) current.position += ms / 1000 * current.playbackRate; },
    interact(isTrusted = true) { for (const callback of windowListeners.get('pointerdown') || []) callback({ isTrusted }); },
    end() { current.ended = true; let stopped = false; for (const callback of windowListeners.get('ended') || []) callback({ target: current, stopImmediatePropagation() { stopped = true; } }); return stopped; },
    replace(initial) { current = media(initial); },
    detach() { current = null; },
  };
}

(async () => {
  let checks = 0;
  {
    const p = page(); const result = p.run({ command: 'play', controlSequence: 1 });
    assert.equal(result.currentTime, 0); assert.equal(typeof result.then, 'undefined', 'ExecuteScriptAsync receives a synchronous JSON snapshot');
    assert.deepEqual(p.starts, [0]);
    p.elapse(12100); p.run(); const trusted = p.video.currentTime;
    p.video.currentTime = 96; assert.equal(p.video.currentTime, trusted, 'Late history restore retains the last trusted clock');
    p.video.position = 2; p.video.emit('timeupdate'); assert.equal(p.video.currentTime, trusted, 'Source backward jump is rejected');
    p.run({ command: 'pause', generation: 2, controlSequence: 2, desiredPlaying: false });
    p.elapse(30000, false); p.video.position = 96;
    assert.equal(p.run({ generation: 2, desiredPlaying: false }).currentTime, trusted, 'Paused wall time cannot legitimize a history restore');
    p.run({ command: 'play', generation: 3, controlSequence: 3 });
    p.elapse(1000); assert.ok(p.run({ generation: 3 }).currentTime > trusted + .99, 'Resume naturally advances the same source request');
    p.run({ command: 'seek', generation: 3, controlSequence: 4, value: 42 });
    p.video.currentTime = 96; assert.equal(p.run({ generation: 3 }).currentTime, 96, 'App seek explicitly takes over the source timeline');
    assert.equal(p.run({ command: 'play', requestId: 2, generation: 4, controlSequence: 5 }).currentTime, 0, 'Selecting the same song again starts at zero');
    checks += 8;
  }
  {
    const p = page(); p.run({ command: 'play', controlSequence: 1 });
    p.elapse(3000); p.run(); p.interact(false); p.video.currentTime = 96;
    assert.equal(p.video.currentTime, 3, 'Synthetic input cannot disable the guard');
    p.interact(); p.video.currentTime = 42; assert.equal(p.run().currentTime, 42, 'Trusted source input can take over');
    const stale = p.run({ command: 'pause', generation: 0, controlSequence: 100, desiredPlaying: false });
    assert.equal(stale.stale, true); assert.equal(p.video.paused, false, 'Old operation cannot pause a newer one');
    p.run({ command: 'volume', controlSequence: 10, value: .4 });
    assert.equal(p.run({ command: 'seek', controlSequence: 9, value: 15 }).stale, true, 'Old control command cannot overwrite a newer command');
    checks += 4;
  }
  {
    const p = page(); const pending = deferred(); p.video.pending = pending;
    p.run({ command: 'play', controlSequence: 1 });
    p.run({ command: 'pause', generation: 2, controlSequence: 2, desiredPlaying: false });
    pending.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.video.paused, true, 'A buffered play completion cannot undo a later pause');
    assert.equal(p.run({ generation: 2, desiredPlaying: false }).playing, false);
    checks += 2;
  }
  {
    const p = page(); p.video.rejectSeek = true;
    assert.equal(p.run({ command: 'play', controlSequence: 1 }).restarting, true, 'Metadata-unavailable initial seek remains guarded');
    p.video.rejectSeek = false; p.video.emit('loadedmetadata'); assert.equal(p.video.currentTime, 0);
    p.elapse(2000); p.run(); p.replace(96);
    assert.equal(p.run().currentTime, 2, 'Replaced native element retains the trusted listening position');
    assert.equal(p.end(), true, 'Native completion is captured before Bilibili auto-next');
    assert.equal(p.video.paused, true); assert.equal(p.run().ended, true);
    p.location.pathname = '/video/BV1Qa0000002/'; assert.equal(p.run().navigationMismatch, true);
    p.location.pathname = `/video/${bvid}/`; p.detach(); p.document.body.innerText = '安全验证';
    assert.equal(p.run().blocked, '安全验证');
    checks += 8;
  }
  console.log(`${checks} WebView2 source timeline and cancellation checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
