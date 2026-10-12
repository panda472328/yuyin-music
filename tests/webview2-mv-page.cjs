const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the exact presentation script shipped in the native host. No media
// commands, navigation, Bilibili account or browser profile are involved.
const source = fs.readFileSync(path.join(__dirname, '../windows-host/BilibiliMV.cs'), 'utf8');
const raw = source.match(/return \$\$"""\s*([\s\S]*?)\s*""";/)?.[1];
assert.ok(raw, 'Production MV script must be found');
const bvid = 'BV1Qa0000001';
function page({ full = false, native = false, ready = true, media = true, controls = true, semantic = false, blocked = '' } = {}) {
  let clicks = 0, nativeExits = 0;
  const video = { readyState: ready ? 4 : 0, play() { throw new Error('MV must not play'); }, pause() { throw new Error('MV must not pause'); }, load() { throw new Error('MV must not load'); } };
  Object.defineProperty(video, 'currentTime', { get() { throw new Error('MV must not read a different clock'); }, set() { throw new Error('MV must not seek'); } });
  const button = { disabled: false, getAttribute(key) { return key === 'title' && semantic ? '网页全屏' : null; }, click() { clicks++; full = !full; } };
  const location = { protocol: 'https:', pathname: `/video/${bvid}/`, assign() { throw new Error('MV must not navigate'); } };
  const document = {
    body: { innerText: blocked },
    get fullscreenElement() { return native ? {} : null; },
    exitFullscreen() { nativeExits++; native = false; return Promise.resolve(); },
    querySelector(selector) {
      if (selector.includes('bpx-state-web')) return full ? {} : null;
      if (selector.includes('video') && !selector.includes('web-fullscreen')) return media ? video : null;
      if (selector === '.bpx-player-ctrl-web') return controls && !semantic ? button : null;
      return null;
    },
    querySelectorAll() { return controls && semantic ? [button] : []; },
  };
  const window = {};
  const context = vm.createContext({ window, document, location, Promise });
  return { window, location, get clicks() { return clicks; }, get nativeExits() { return nativeExits; }, get full() { return full; },
    run(command = 'enter', requestId = 1) { return vm.runInContext(raw.replace('{{parameters}}', JSON.stringify({ command, bvid, requestId })), context); }, exitByUser() { full = false; } };
}
let checks = 0;
{
  const p = page();
  assert.equal(p.run().state, 'entering');
  const entered = p.run();
  assert.equal(entered.webFullscreen, true); assert.equal(entered.entered, true); assert.equal(p.clicks, 1);
  p.run('enter', 2); assert.equal(p.clicks, 1, 'Already full presentation is not toggled off');
  p.run('exit', 3); assert.equal(p.full, false); assert.equal(p.clicks, 2);
  p.run('enter', 2); assert.equal(p.full, false, 'Stale enter cannot undo a later exit');
  checks += 7;
}
{
  const p = page({ semantic: true }); p.run(); assert.equal(p.full, true, 'Semantic fallback only searches official player-control area'); checks++;
  const already = page({ full: true }); assert.equal(already.run().webFullscreen, true); assert.equal(already.clicks, 0); checks += 2;
  const missing = page({ controls: false }); assert.equal(missing.run().state, 'controls-missing'); checks++;
  const loading = page({ ready: false }); assert.equal(loading.run().state, 'loading'); assert.equal(loading.clicks, 0); checks += 2;
}
{
  const p = page({ media: false, blocked: '请完成安全验证后重试' }); assert.equal(p.run().blocked, '安全验证'); assert.equal(p.clicks, 0); checks += 2;
  const wrong = page(); wrong.location.pathname = '/video/BV1Qa0000002/'; assert.equal(wrong.run().state, 'navigation-mismatch'); assert.equal(wrong.clicks, 0); checks += 2;
  const native = page({ native: true }); assert.equal(native.run().state, 'native-exiting'); assert.equal(native.nativeExits, 1); native.run(); assert.equal(native.full, true); assert.equal(native.clicks, 1); checks += 4;
}
{
  const p = page(); p.run(); p.run(); p.exitByUser(); assert.equal(p.run('read').entered, true); assert.equal(p.run('read').webFullscreen, false); assert.equal(p.clicks, 1, 'Read observes user exit without re-entering'); checks += 3;
  const full = page({ full: true, native: true }); full.run('exit'); assert.equal(full.full, false); assert.equal(full.nativeExits, 1); checks += 2;
}
console.log(`${checks} WebView2 MV presentation checks passed without media commands or navigation.`);
