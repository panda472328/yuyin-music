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
  suggestions?: (url: URL) => unknown | Promise<unknown>;
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
      if (endpoint.hostname === 's.search.bilibili.com' && endpoint.pathname === '/main/suggest') return json(options.suggestions ? await options.suggestions(endpoint) : { result: { tag: [] } });
      assert.equal(endpoint.origin + endpoint.pathname, 'https://api.bilibili.com/x/web-interface/search/type');
      return json(options.search ? await options.search(endpoint) : payload([first, popular]));
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

test('a logged-out session without guest opt-in cannot request search results', async t => {
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


test('an explicit guest can search with official ranking while account-only favorite folders remain protected', async t => {
  const { service, searchCalls, calls } = fixture(t, { loggedIn: false });
  assert.deepEqual(service.continueAsGuest(), { loggedIn: false, account: null, guest: true });
  const result = await service.search('游客歌曲');
  assert.deepEqual(result.songs.map(song => song.bvid), [first.bvid, popular.bvid]);
  assert.equal(searchCalls()[0].url.searchParams.get('order'), 'totalrank');
  assert.equal(calls.filter(call => call.url.pathname === '/x/web-interface/nav').length, 0);
  for (const accountOperation of [() => service.listFavoriteFolders(), () => service.listFavoriteItems(1),
    () => service.listFavoriteSongs(1), () => service.openProfile()]) {
    await assert.rejects(accountOperation(), error => error instanceof BilibiliError && error.code === 'BILIBILI_LOGIN_REQUIRED');
  }
  assert.deepEqual(await service.getAccount(), { loggedIn: false, account: null, guest: true });
});

test('guest search rejects an old response after an identity cookie change while future public requests remain available', async t => {
  let resolve!: (value: unknown) => void;
  let started!: () => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const fetching = new Promise<void>(done => { started = done; });
  let delay = true;
  const { service, cookies } = fixture(t, { loggedIn: false, search: () => {
    if (delay) { started(); return pending; }
    return payload([first]);
  } });
  service.continueAsGuest();
  const search = service.search('游客歌曲');
  const rejection = assert.rejects(search, error => error instanceof BilibiliError && error.code === 'BILIBILI_SESSION_CHANGED');
  await fetching;
  cookies.emit('changed', {}, { name: 'SESSDATA', domain: '.bilibili.com' });
  resolve(payload([first, popular]));
  await rejection;
  delay = false;
  assert.equal((await service.search('新请求')).songs[0].bvid, first.bvid);
});


test('song mode keeps all official results and ranks title relevance without uploader or description metadata', async t => {
  const { service, searchCalls } = fixture(t, { search: () => payload([
    { ...first, title: '《光 年，之 外》', tid: 1, description: '跨分区演唱' },
    { ...popular, title: '听见夏天', description: '光年之外', author: '光年之外' },
    { ...video('BV0000000003', 3000), title: '光年中途之外' },
    { ...video('BV0000000004', 40), title: '光年之外', tid: 999 },
    { ...video('BV0000000005', 40), title: '《光年之外》纯音乐' },
    { ...video('BV0000000006', 40), title: '【现场】光年之外' },
    { ...video('BV0000000007', 40), title: '光年之外 邓紫棋' },
  ], 3) });
  const result = await service.search('  光年之外  ', 1, 'song');
  assert.equal(result.mode, 'song');
  assert.equal(result.query, '光年之外');
  assert.deepEqual(result.songs.map(song => song.bvid), [first.bvid, 'BV0000000004', 'BV0000000005', 'BV0000000007', 'BV0000000006', popular.bvid, 'BV0000000003']);
  assert.equal(searchCalls()[0].url.searchParams.get('keyword'), '光年之外');
  assert.equal(searchCalls()[0].url.searchParams.get('order'), 'totalrank');
  assert.equal(searchCalls()[0].url.searchParams.has('tids'), false, 'Song matching must not remove cross-category videos');
  assert.equal(result.total, 60, 'Total remains the source count, not the title match count');
  assert.equal(result.hasMore, true);
});

test('song mode preserves official pagination and supports split query words', async t => {
  const { service, searchCalls } = fixture(t, { search: url => payload([
    { ...first, title: url.searchParams.get('page') === '1' ? '晴天' : '《晴天》周杰伦' },
  ], 2) });
  const firstPage = await service.search('晴天 周杰伦', 1, 'song');
  const secondPage = await service.search('晴天 周杰伦', 2, 'song');
  assert.deepEqual(firstPage.songs.map(song => song.bvid), [first.bvid]);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.total, 40);
  assert.deepEqual(secondPage.songs.map(song => song.bvid), [first.bvid]);
  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.hasMore, false);
  assert.equal(searchCalls()[1].url.searchParams.get('keyword'), '晴天 周杰伦');
});

test('song title ranking supports reversed words and version terms while video mode stays untouched', async t => {
  const entries = [
    { ...first, title: '无关节目', author: '晴天 周杰伦 Live' },
    { ...popular, title: '晴天' },
    { ...video('BV0000000003', 1), title: '晴天 周杰伦 Live' },
    { ...video('BV0000000004', 1), title: '周杰伦 现场 晴天' },
  ];
  const { service } = fixture(t, { search: () => payload(entries) });
  assert.deepEqual((await service.search('周杰伦 晴天', 1, 'song')).songs.map(song => song.bvid), ['BV0000000003', 'BV0000000004', popular.bvid, first.bvid]);
  assert.deepEqual((await service.search('晴天 Live', 1, 'song')).songs.map(song => song.bvid), ['BV0000000003', popular.bvid, 'BV0000000004', first.bvid]);
  assert.deepEqual((await service.search('晴天 Live', 1, 'video')).songs.map(song => song.bvid), entries.map(entry => entry.bvid));
});

test('official suggestions use the browser session and original term with bounded sanitized results', async t => {
  const { service, calls } = fixture(t, { suggestions: () => ({ result: { tag: [
    { value: '<em>晴天</em>' }, { value: '晴天' }, { value: '&lt;b&gt;夜曲&lt;/b&gt;\u0000' },
    { value: 1 }, { value: 'x'.repeat(150) }, ...Array.from({ length: 20 }, (_, index) => ({ value: `建议${index}` })),
  ] } }) });
  const result = await service.searchSuggestions('  晴天 + Live  ');
  assert.equal(result.length, 10);
  assert.deepEqual(result.slice(0, 3), ['晴天', '夜曲', 'x'.repeat(100)]);
  const request = calls.find(call => call.url.hostname === 's.search.bilibili.com')!;
  assert.equal(request.url.origin + request.url.pathname, 'https://s.search.bilibili.com/main/suggest');
  assert.deepEqual(Object.fromEntries(request.url.searchParams), { term: '晴天 + Live' });
  assert.equal(request.options.credentials, 'include');
  assert.deepEqual(request.options.headers, { Accept: 'application/json', Referer: 'https://www.bilibili.com/' });
  const count = calls.length;
  assert.deepEqual(await service.searchSuggestions('  '), []);
  await assert.rejects(service.searchSuggestions('x'.repeat(201)), error => error instanceof BilibiliError && error.code === 'INVALID_QUERY');
  assert.equal(calls.length, count);
});

test('suggestions reject malformed payloads and surface restricted API responses', async t => {
  for (const response of [null, [], {}, { code: 0 }, { result: {} }, { result: { tag: null } }, { data: { tag: {} } }]) {
    const malformed = fixture(t, { suggestions: () => response });
    malformed.service.continueAsGuest();
    await assert.rejects(malformed.service.searchSuggestions('晴天'), error => error instanceof BilibiliError && error.code === 'BILIBILI_INVALID_RESPONSE');
  }
  for (const response of [{ result: { tag: [] } }, { code: 0, data: { tag: [] } }]) {
    const empty = fixture(t, { suggestions: () => response });
    empty.service.continueAsGuest();
    assert.deepEqual(await empty.service.searchSuggestions('晴天'), []);
  }
  const restricted = fixture(t, { suggestions: () => ({ code: -412, message: '验证' }) });
  restricted.service.continueAsGuest();
  await assert.rejects(restricted.service.searchSuggestions('晴天'), error => error instanceof BilibiliError && error.code === 'BILIBILI_VERIFICATION_REQUIRED' && error.requiresVerification);
});

test('search distinguishes malformed result containers from valid empty official pages', async t => {
  for (const response of [null, [], { code: 0 }, { code: 0, data: {} }, { code: 0, data: [] }, { code: 0, data: { result: null } }, { code: 0, data: { result: {} } }]) {
    const { service } = fixture(t, { search: () => response });
    service.continueAsGuest();
    await assert.rejects(service.search('晴天', 1, 'song'), error => error instanceof BilibiliError && error.code === 'BILIBILI_INVALID_RESPONSE');
  }
  const { service } = fixture(t, { search: () => payload([], 2) });
  service.continueAsGuest();
  const result = await service.search('晴天', 1, 'song');
  assert.deepEqual(result.songs, []);
  assert.equal(result.total, 40);
  assert.equal(result.hasMore, true);
});

test('suggestions from an old identity are rejected and guest opt-in remains required', async t => {
  const loggedOut = fixture(t, { loggedIn: false });
  await assert.rejects(loggedOut.service.searchSuggestions('晴天'), error => error instanceof BilibiliError && error.code === 'BILIBILI_LOGIN_REQUIRED');
  assert.equal(loggedOut.calls.some(call => call.url.hostname === 's.search.bilibili.com'), false);
  loggedOut.service.continueAsGuest();
  assert.deepEqual(await loggedOut.service.searchSuggestions('晴天'), []);
  let resolve!: (value: unknown) => void;
  let started!: () => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const fetching = new Promise<void>(done => { started = done; });
  const { service, cookies } = fixture(t, { suggestions: () => { started(); return pending; } });
  const request = service.searchSuggestions('晴天');
  const rejected = assert.rejects(request, error => error instanceof BilibiliError && error.code === 'BILIBILI_SESSION_CHANGED');
  await fetching;
  cookies.emit('changed', {}, { name: 'SESSDATA', domain: '.bilibili.com' });
  resolve({ result: { tag: [{ value: '晴天' }] } });
  await rejected;
});

test('video mode preserves unrelated title results and invalid modes never start a request', async t => {
  const { service, calls } = fixture(t, { search: () => payload([
    { ...first, title: '描述中匹配', description: '光年之外' },
    { ...popular, title: '另一个标题' },
  ]) });
  const result = await service.search('光年之外', 1, 'video');
  assert.equal(result.mode, 'video');
  assert.deepEqual(result.songs.map(song => song.bvid), [first.bvid, popular.bvid]);
  const requests = calls.length;
  await assert.rejects(service.search('光年之外', 1, 'invalid' as never), error => error instanceof BilibiliError && error.code === 'INVALID_SEARCH_MODE');
  await assert.rejects(service.search('， ！', 1, 'song'), error => error instanceof BilibiliError && error.code === 'INVALID_QUERY');
  assert.equal(calls.length, requests);
});
