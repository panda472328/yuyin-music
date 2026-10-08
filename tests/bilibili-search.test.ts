import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildSync } from 'esbuild';
import type { Session } from 'electron';

// Load the real service with only Electron's unused window constructor replaced.
// Every account, homepage and search response comes from the isolated mock session.
const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../electron/bilibili.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
}).outputFiles[0].text;
const bundleModule = { exports: {} };
const requireDependency = createRequire(path.resolve(__dirname, 'bilibili-search.test.ts'));
new Function('module', 'exports', 'require', bundle)(bundleModule, bundleModule.exports, (name: string) =>
  name === 'electron' ? { BrowserWindow: class {} } : requireDependency(name));
const { BilibiliService, BilibiliError } = bundleModule.exports as typeof import('../electron/bilibili');

const video = (bvid: string, play: number) => ({
  bvid, play, title: `<em class="keyword">歌曲 ${bvid}</em>`, author: '歌手',
  pic: '//i0.hdslb.com/cover.jpg', duration: '3:20',
});
const first = video('BV0000000001', 7);
const popular = video('BV0000000002', 900_000);
const payload = (result: unknown[], pages = 1) => ({
  code: 0, data: { result, numResults: pages * 20, numPages: pages, pagesize: 20 },
});
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function fixture(t: TestContext, options: {
  loggedIn?: boolean;
  search?: (url: URL) => unknown | Promise<unknown>;
} = {}) {
  const calls: Array<{ url: URL; options: RequestInit }> = [];
  const cookies = new EventEmitter();
  const session = {
    cookies,
    fetch: async (url: string, init: RequestInit) => {
      const endpoint = new URL(url);
      calls.push({ url: endpoint, options: init });
      if (endpoint.pathname === '/x/web-interface/nav') return json(options.loggedIn === false
        ? { code: -101 }
        : { code: 0, data: { isLogin: true, mid: 42, uname: '测试账号', face: '//i0.hdslb.com/avatar.jpg' } });
      if (endpoint.hostname === 'www.bilibili.com' && endpoint.pathname === '/') return new Response('');
      assert.equal(endpoint.origin + endpoint.pathname, 'https://api.bilibili.com/x/web-interface/search/type');
      return json(await (options.search?.(endpoint) ?? payload([first, popular])));
    },
  } as unknown as Session;
  const service = new BilibiliService(session);
  t.after(() => service.dispose());
  return { service, calls, cookies, searchCalls: () => calls.filter(call => call.url.pathname.endsWith('/search/type')) };
}

test('official comprehensive ranking keeps the first video ahead of higher play counts and sends the original keyword', async t => {
  const { service, searchCalls } = fixture(t);
  const keyword = '光 年+之外 / & =?';
  const result = await service.search(`  ${keyword}  `);
  assert.deepEqual(result.songs.map(song => song.bvid), [first.bvid, popular.bvid]);
  assert.equal(result.songs[0].playCount, 7);
  assert.equal(result.songs[1].playCount, 900_000);
  assert.equal(result.query, keyword);
  assert.equal(result.songs[0].title, `歌曲 ${first.bvid}`);
  const [{ url, options }] = searchCalls();
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    search_type: 'video', keyword, order: 'totalrank', page: '1', page_size: '20',
  });
  assert.equal(options.credentials, 'include');
  assert.deepEqual(options.headers, { Accept: 'application/json', Referer: 'https://www.bilibili.com/' });
});

test('invalid video IDs are skipped without rearranging the remaining official results', async t => {
  const third = video('BV0000000003', 50);
  const { service } = fixture(t, { search: () => payload([
    { bvid: 'invalid', play: 999_999 }, first, {}, popular, { bvid: 123 }, third,
  ]) });
  const result = await service.search('测试歌曲');
  assert.deepEqual(result.songs.map(song => song.bvid), [first.bvid, popular.bvid, third.bvid]);
});

test('the second page retains official order and uses the official pagination metadata', async t => {
  const secondPage = [video('BV0000000003', 3), video('BV0000000004', 300_000)];
  const { service, searchCalls, calls } = fixture(t, {
    search: url => payload(url.searchParams.get('page') === '2' ? secondPage : [first, popular], 2),
  });
  const page1 = await service.search('测试歌曲');
  const page2 = await service.search('测试歌曲', 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.page, 2);
  assert.equal(page2.pageSize, 20);
  assert.equal(page2.total, 40);
  assert.deepEqual(page2.songs.map(song => song.bvid), secondPage.map(item => item.bvid));
  assert.deepEqual(Object.fromEntries(searchCalls()[1].url.searchParams), {
    search_type: 'video', keyword: '测试歌曲', order: 'totalrank', page: '2', page_size: '20',
  });
  assert.equal(calls.filter(call => call.url.pathname === '/x/web-interface/nav').length, 1);
});

test('a logged-out session cannot request search results', async t => {
  const { service, searchCalls, calls } = fixture(t, { loggedIn: false });
  await assert.rejects(service.search('测试歌曲'), error =>
    error instanceof BilibiliError && error.code === 'BILIBILI_LOGIN_REQUIRED' && error.requiresVerification);
  assert.equal(searchCalls().length, 0);
  assert.equal(calls.length, 1);
});

test('a cookie identity change during search rejects results from the old login', async t => {
  let resolve!: (value: unknown) => void;
  let started!: () => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const fetching = new Promise<void>(done => { started = done; });
  const { service, cookies } = fixture(t, { search: () => { started(); return pending; } });
  const search = service.search('测试歌曲');
  const rejection = assert.rejects(search, error =>
    error instanceof BilibiliError && error.code === 'BILIBILI_SESSION_CHANGED');
  await fetching;
  cookies.emit('changed', {}, { name: 'SESSDATA', domain: '.bilibili.com' });
  resolve(payload([first, popular]));
  await rejection;
});
