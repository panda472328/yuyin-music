import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { buildSync } from 'esbuild'
import type { MusicAPI } from '../src/api'

const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/api.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text

function previewFixture(response?: (endpoint: URL) => unknown) {
  const calls: URL[] = []
  const loaded = { exports: {} }
  const fetch = async (url: string) => {
    const endpoint = new URL(url, 'https://preview.test')
    calls.push(endpoint)
    if (response) return new Response(JSON.stringify(response(endpoint)), { status: 200 })
    if (endpoint.pathname === '/bili-suggest/main/suggest') return new Response(JSON.stringify({ result: { tag: [{ value: '<em>晴天</em>' }, { value: '晴天' }, { value: '夜曲' }] } }), { status: 200 })
    return new Response(JSON.stringify({ code: 0, data: {
      page: Number(endpoint.searchParams.get('page')), numResults: 40, numPages: 2,
      result: [
        { bvid: 'BV0000000001', title: '<em>光&#x5e74;</em>&nbsp;&#20043;外', author: '跨区演唱', pic: '', duration: '3:20', play: 1 },
        { bvid: 'BV0000000002', title: '夏日推荐', description: '光年之外', author: '光年之外', pic: '', duration: '3:20', play: 9000 },
        { bvid: 'BV0000000003', title: '《光年之外》现场版', author: '跨区演唱', pic: '', duration: '3:20', play: 1 },
      ],
    } }), { status: 200 })
  }
  new Function('module', 'exports', 'window', 'fetch', bundle)(loaded, loaded.exports, {}, fetch)
  return { api: (loaded.exports as { api: MusicAPI }).api, calls }
}

test('preview song mode shares title relevance and preserves all official results and pagination', async () => {
  const { api, calls } = previewFixture()
  const result = await api.search(' 光年之外 ', 1, 'song')
  assert.deepEqual(result.songs.map(song => song.bvid), ['BV0000000001', 'BV0000000003', 'BV0000000002'])
  assert.equal(result.mode, 'song')
  assert.equal(result.query, '光年之外')
  assert.equal(result.total, 40)
  assert.equal(result.hasMore, true)
  assert.equal(calls[0].searchParams.get('keyword'), '光年之外')
  assert.equal(calls[0].searchParams.get('order'), 'totalrank')
})

test('preview suggestions use the dedicated official host proxy and clean returned values', async () => {
  const { api, calls } = previewFixture()
  assert.deepEqual(await api.searchSuggestions('  晴天  '), ['晴天', '夜曲'])
  assert.equal(calls[0].pathname, '/bili-suggest/main/suggest')
  assert.equal(calls[0].searchParams.get('term'), '晴天')
  assert.deepEqual(await api.searchSuggestions('  '), [])
  await assert.rejects(api.searchSuggestions('x'.repeat(201)), /搜索词过长/)
  assert.equal(calls.length, 1)
})

test('preview legacy search stays video mode and an invalid mode is rejected before fetching', async () => {
  const { api, calls } = previewFixture()
  const result = await api.search('光年之外', 2)
  assert.deepEqual(result.songs.map(song => song.bvid), ['BV0000000001', 'BV0000000002', 'BV0000000003'])
  assert.equal(result.mode, 'video')
  assert.equal(result.hasMore, false)
  await assert.rejects(api.search('光年之外', 1, null as never), /搜索模式不合法/)
  await assert.rejects(api.search('， ！', 1, 'song'), /请输入歌曲或视频名称/)
  assert.equal(calls.length, 1)
})

test('preview distinguishes malformed search containers from valid empty pages and skips invalid entries', async () => {
  for (const response of [null, [], { code: 0 }, { code: 0, data: {} }, { code: 0, data: [] }, { code: 0, data: { result: null } }, { code: 0, data: { result: {} } }]) {
    const { api } = previewFixture(() => response)
    await assert.rejects(api.search('晴天', 1, 'song'), /搜索结果格式已变化/)
  }
  const { api } = previewFixture(() => ({ code: 0, data: { result: [], numResults: 40, numPages: 2, pagesize: 20 } }))
  const empty = await api.search('晴天', 1, 'song')
  assert.deepEqual(empty.songs, [])
  assert.equal(empty.total, 40)
  assert.equal(empty.hasMore, true)
  assert.equal(empty.page, 1)
  const invalidEntries = previewFixture(() => ({ code: 0, data: { result: [null, {}, { bvid: 'invalid' }, { bvid: 'BV0000000001', title: '晴天' }] } }))
  assert.deepEqual((await invalidEntries.api.search('晴天')).songs.map(song => song.bvid), ['BV0000000001'])
})

test('preview distinguishes missing suggestion tags from valid empty primary and fallback arrays', async () => {
  for (const response of [null, [], {}, { code: 0 }, { result: {} }, { result: { tag: null } }, { data: { tag: {} } }]) {
    const { api } = previewFixture(() => response)
    await assert.rejects(api.searchSuggestions('晴天'), /响应格式异常/)
  }
  for (const response of [{ result: { tag: [] } }, { code: 0, data: { tag: [] } }]) {
    const { api } = previewFixture(() => response)
    assert.deepEqual(await api.searchSuggestions('晴天'), [])
  }
})
