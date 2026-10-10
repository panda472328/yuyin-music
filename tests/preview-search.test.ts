import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { buildSync } from 'esbuild'
import type { MusicAPI } from '../src/api'

const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/api.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text

function previewFixture() {
  const calls: URL[] = []
  const loaded = { exports: {} }
  const fetch = async (url: string) => {
    const endpoint = new URL(url, 'https://preview.test')
    calls.push(endpoint)
    return new Response(JSON.stringify({ code: 0, data: {
      page: Number(endpoint.searchParams.get('page')), numResults: 40, numPages: 2,
      result: [
        { bvid: 'BV0000000001', title: '<em>光&#x5e74;</em>&nbsp;&#20043;外 演唱', author: '跨区演唱', pic: '', duration: '3:20', play: 1 },
        { bvid: 'BV0000000002', title: '夏日推荐', description: '光年之外', author: '光年之外', pic: '', duration: '3:20', play: 9000 },
      ],
    } }), { status: 200 })
  }
  new Function('module', 'exports', 'window', 'fetch', bundle)(loaded, loaded.exports, {}, fetch)
  return { api: (loaded.exports as { api: MusicAPI }).api, calls }
}

test('preview song mode shares complete title matching and source pagination without changing the query', async () => {
  const { api, calls } = previewFixture()
  const result = await api.search(' 光年之外 ', 1, 'song')
  assert.deepEqual(result.songs.map(song => song.bvid), ['BV0000000001'])
  assert.equal(result.mode, 'song')
  assert.equal(result.query, '光年之外')
  assert.equal(result.total, 40)
  assert.equal(result.hasMore, true)
  assert.equal(calls[0].searchParams.get('keyword'), '光年之外')
  assert.equal(calls[0].searchParams.get('order'), 'totalrank')
})

test('preview legacy search stays video mode and an invalid mode is rejected before fetching', async () => {
  const { api, calls } = previewFixture()
  const result = await api.search('光年之外', 2)
  assert.deepEqual(result.songs.map(song => song.bvid), ['BV0000000001', 'BV0000000002'])
  assert.equal(result.mode, 'video')
  assert.equal(result.hasMore, false)
  await assert.rejects(api.search('光年之外', 1, null as never), /搜索模式不合法/)
  await assert.rejects(api.search('， ！', 1, 'song'), /请输入歌曲或视频名称/)
  assert.equal(calls.length, 1)
})
