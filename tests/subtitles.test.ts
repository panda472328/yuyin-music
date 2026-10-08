import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from 'electron';
import type { LyricsRequest } from '../electron/lyrics-types';
import { BilibiliSubtitlesService } from '../electron/subtitles';
import { buildWbiQuery, safeSubtitleUrl, selectSubtitle, subtitleBodyToLyrics, subtitleDescriptor } from '../electron/subtitles-utils';
import { activeLyricIndex, parseLrc } from '../src/lyrics';

const images = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
};
const request: LyricsRequest = {
  provider: 'bilibili', song: { id: 'BV1234567890', bvid: 'BV1234567890', title: '测试视频', artist: '测试 UP 主',
    cover: '', duration: 100, playCount: 1, source: 'bilibili', url: 'https://www.bilibili.com/video/BV1234567890/' },
};
const ai = { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/test.json' };
const manual = { lan: 'zh-CN', lan_doc: '中文（中国）', subtitle_url: 'https://i0.hdslb.com/bfs/subtitle/manual.json' };
const body = { body: [{ from: 2.25, to: 4, content: '第一段字幕' }, { from: 6, to: 8.5, content: '第二段字幕' }] };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function fixture(options: { candidates?: unknown[]; needsLogin?: boolean; playerCode?: number; payload?: unknown } = {}) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const session = { fetch: async (url: string, init: RequestInit) => {
    calls.push({ url, options: init });
    const endpoint = new URL(url);
    if (endpoint.pathname === '/x/web-interface/view') return json({ code: 0, data: { aid: 100, cid: 200, pages: [{ cid: 200, duration: 100 }] } });
    if (endpoint.pathname === '/x/web-interface/nav') return json({ code: -101, data: { isLogin: false, wbi_img: images } });
    if (endpoint.pathname === '/x/player/wbi/v2') return json({ code: options.playerCode ?? 0,
      data: { need_login_subtitle: options.needsLogin ?? false, subtitle: { subtitles: options.candidates ?? [manual, ai] } } });
    return json(options.payload ?? body);
  } } as unknown as Session;
  return { service: new BilibiliSubtitlesService(session), calls };
}

test('WBI signs sorted encoded parameters with a fixed timestamp and public image keys', () => {
  assert.equal(buildWbiQuery({ foo: '114', bar: '514', baz: '1919810' }, images.img_url, images.sub_url, 1702204169),
    'bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee');
  assert.equal(buildWbiQuery({ text: "!试'() *", w_rid: 'untrusted' }, images.img_url, images.sub_url, 1).split('&')[0], 'text=%E8%AF%95%20');
  assert.throws(() => buildWbiQuery({}, 'https://example.com/key.png', images.sub_url));
});

test('subtitle URLs are limited to exact HTTPS Bilibili caption CDN hosts and paths', () => {
  assert.equal(safeSubtitleUrl(ai.subtitle_url), 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/test.json');
  assert.equal(safeSubtitleUrl(manual.subtitle_url), manual.subtitle_url);
  for (const url of [
    'http://i0.hdslb.com/bfs/subtitle/a.json', 'https://i0.hdslb.com.evil.test/bfs/subtitle/a.json',
    'https://i0.hdslb.com@127.0.0.1/bfs/subtitle/a.json', 'https://i0.hdslb.com:8443/bfs/subtitle/a.json',
    'https://aisubtitle.hdslb.com/other/a.json', 'https://i0.hdslb.com/bfs/subtitle/../../other/a.json',
    'https://i0.hdslb.com/bfs/subtitle/a.json#fragment', 'file:///local.json',
  ]) assert.equal(safeSubtitleUrl(url), null);
});

test('Chinese AI captions are preferred and manual captions retain their actual label', () => {
  const chineseAI = subtitleDescriptor(ai)!;
  const chineseManual = subtitleDescriptor({ ...manual, type: 1 })!;
  const englishAI = subtitleDescriptor({ ...ai, lan: 'ai-en', lan_doc: 'English (AI)' })!;
  assert.equal(selectSubtitle([chineseManual, englishAI, chineseAI]), chineseAI);
  assert.equal(selectSubtitle([englishAI, chineseManual]), chineseManual);
  assert.equal(selectSubtitle([chineseManual]), chineseManual);
  assert.equal(chineseManual.isAI, false);
  assert.equal(chineseManual.label, manual.lan_doc);
  assert.equal(subtitleDescriptor({ ...ai, lan: 'zh-CN', lan_doc: '中文' })!.isAI, true);
});

test('caption times are preserved with silent gaps and text cannot inject LRC metadata', () => {
  const lyrics = subtitleBodyToLyrics({ body: [
    { from: 6, to: 8.5, content: '第二段\n字幕' },
    { from: 2.25, to: 4, content: '[00:01]字面时间' },
  ] });
  const lines = parseLrc(lyrics.syncedLyrics);
  assert.deepEqual(lines.map(line => line.time), [2.25, 4, 6, 8.5]);
  assert.equal(lines[0].text, '［00:01］字面时间');
  assert.equal(lines[2].text, '第二段 字幕');
  assert.equal(lines[activeLyricIndex(lines, 5)].text, '');
  assert.equal(lyrics.duration, 8.5);
});

test('invalid caption timestamps and excessive payloads are rejected', () => {
  for (const row of [
    { from: -1, to: 2, content: 'x' }, { from: 3, to: 2, content: 'x' },
    { from: 0, to: Infinity, content: 'x' }, { from: 0, to: 100_000, content: 'x' },
    { from: '0', to: 1, content: 'x' }, { from: 0, to: 1, content: 'x'.repeat(2001) },
  ]) assert.throws(() => subtitleBodyToLyrics({ body: [row] }));
  assert.throws(() => subtitleBodyToLyrics({ body: Array.from({ length: 5001 }, () => ({ from: 0, to: 1, content: 'x' })) }));
});

test('service reads available AI captions, signs player metadata and omits cookies to the CDN', async () => {
  const { service, calls } = fixture();
  const pending = service.lookup(request);
  assert.equal(service.lookup(request), pending);
  const result = await pending;
  assert.equal(result.provider, 'bilibili');
  assert.equal(result.subtitle?.isAI, true);
  assert.equal(result.subtitle?.label, ai.lan_doc);
  assert.equal(result.match?.id, 200);
  assert.equal(result.match?.trackName, request.song.title);
  assert.equal(result.match?.artistName, '');
  assert.deepEqual(parseLrc(result.match!.syncedLyrics!).map(line => line.time), [2.25, 4, 6, 8.5]);
  const playerCall = calls.find(call => new URL(call.url).pathname === '/x/player/wbi/v2')!;
  assert.match(new URL(playerCall.url).searchParams.get('w_rid')!, /^[a-f0-9]{32}$/);
  assert.equal(new URL(playerCall.url).searchParams.get('cid'), '200');
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.redirect === 'error'));
  assert.equal(calls.at(-1)?.options.credentials, 'omit');
  const count = calls.length;
  assert.equal(await service.lookup(request), result);
  assert.equal(calls.length, count);
  await service.lookup({ ...request, force: true });
  assert.equal(calls.length, count + 3, 'Forced lookup rereads view, player metadata and caption text');
});

test('manual caption fallback is explicitly marked as human, with no artist inferred from the UP', async () => {
  const result = await fixture({ candidates: [manual] }).service.lookup(request);
  assert.equal(result.subtitle?.isAI, false);
  assert.equal(result.subtitle?.label, manual.lan_doc);
  assert.equal(result.match?.artistName, '');
  assert.match(result.message!, /UP 主字幕/);
});

test('login-required subtitles remain retryable and do not masquerade as generated captions', async () => {
  const { service, calls } = fixture({ candidates: [], needsLogin: true });
  const result = await service.lookup(request);
  assert.equal(result.match, null);
  assert.equal(result.requiresLogin, true);
  assert.match(result.message!, /登录/);
  assert.match(result.message!, /不会.*自动生成/);
  const count = calls.length;
  await service.lookup(request);
  assert.equal(calls.length, count + 2, 'Login-required results are not cached');
});

test('unavailable subtitles explain the capability limit and are briefly cached', async () => {
  const { service, calls } = fixture({ candidates: [] });
  const result = await service.lookup(request);
  assert.equal(result.match, null);
  assert.equal(result.requiresLogin, undefined);
  assert.match(result.message!, /无法.*自动生成/);
  const count = calls.length;
  assert.equal(await service.lookup(request), result);
  assert.equal(calls.length, count);
});

test('verification errors and untrusted subtitle URLs are rejected without an external fetch', async () => {
  const blocked = fixture({ playerCode: -352 });
  await assert.rejects(() => blocked.service.lookup(request), (error: Error & { code?: string }) => error.code === 'SUBTITLES_VERIFICATION_REQUIRED');
  const count = blocked.calls.length;
  await assert.rejects(() => blocked.service.lookup(request));
  assert.equal(blocked.calls.length, count + 2, 'API failures are not cached');
  const unsafe = fixture({ candidates: [{ ...ai, subtitle_url: 'https://evil.test/captions.json' }] });
  await assert.rejects(() => unsafe.service.lookup(request), (error: Error & { code?: string }) => error.code === 'SUBTITLES_UNSUPPORTED');
  assert.equal(unsafe.calls.length, 3);
});
