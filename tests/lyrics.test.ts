import test from 'node:test'
import assert from 'node:assert/strict'
import type { Song } from '../electron/types'
import type { LyricsRequest, LyricsTrack } from '../electron/lyrics-types'
import { parseLrc, activeLyricIndex, buildLyricsQueries, selectLyricsMatch } from '../src/lyrics'

function request(title = '【4K修复】周杰伦 - 晴天MV2160P', query?: string, duration = 302): LyricsRequest {
  const song: Song = { id: 'BV1234567890', bvid: 'BV1234567890', title, artist: '私藏音乐馆',
    cover: '', duration, playCount: 100, source: 'bilibili', url: 'https://www.bilibili.com/video/BV1234567890/' }
  return { song, query }
}

function track(id: number, changes: Partial<LyricsTrack> = {}): LyricsTrack {
  return { id, trackName: '晴天', artistName: '周杰伦', albumName: '叶惠美', duration: 269,
    instrumental: false, syncedLyrics: '[00:12.30]故事的小黄花\n[00:17.00]从出生那年就飘着', plainLyrics: null, ...changes }
}

test('LRC parses repeated timestamps, fractions and hours, sorts and removes exact duplicates', () => {
  const lrc = '[ti:歌曲]\n[ar:歌手]\n[by:作者]\n[00:17.80][00:12.3]重复一句\n[01:02:03.045]小时\n[00:12.300]重复一句\n[99:88]非法\n普通歌词'
  assert.deepEqual(parseLrc(lrc), [
    { time: 12.3, text: '重复一句' }, { time: 17.8, text: '重复一句' }, { time: 3723.045, text: '小时' },
  ])
})

test('LRC keeps instrumental gaps, strips enhanced word timestamps and applies metadata offset', () => {
  const lrc = '\uFEFF[ti:test]\r\n[00:01.00]<00:01.00>第一<00:01.50>句\r\n[00:03.00]\r\n[offset:+500]\r\n[00:05.00][ar:ignored]'
  assert.deepEqual(parseLrc(lrc), [{ time: 0.5, text: '第一句' }, { time: 2.5, text: '' }])
  assert.equal(parseLrc('[offset:-1500]\n[00:01.00]延后')[0].time, 2.5)
  assert.deepEqual(parseLrc('[ti:标题]\n[ar:作者]\n没有时间'), [])
})

test('active lyric follows exact boundaries, forwards/backwards seeks and a positive UI delay', () => {
  const lines = parseLrc('[00:02]第一句\n[00:05]第二句\n[00:08]\n[00:10]第三句')
  assert.equal(activeLyricIndex(lines, 1.99), -1)
  assert.equal(activeLyricIndex(lines, 5), 1)
  assert.equal(activeLyricIndex(lines, 100), 3)
  assert.equal(activeLyricIndex(lines, 3), 0)
  assert.equal(activeLyricIndex(lines, 8), 2)
  assert.equal(activeLyricIndex(lines, 5, 1), 0)
  assert.equal(activeLyricIndex(lines, 4, -1), 1)
  assert.equal(activeLyricIndex([], 10), -1)
})

test('queries extract a song and singer while removing Bilibili quality and promotional labels', () => {
  assert.deepEqual(buildLyricsQueries(request()), ['周杰伦 晴天', '晴天'])
  assert.deepEqual(buildLyricsQueries(request('【4K修复】周杰伦 - 晴天MV 2160P修复版')), ['周杰伦 晴天', '晴天'])
  assert.deepEqual(buildLyricsQueries(request('【4K修复】周杰伦 - 夜曲 MV 2160P修复版 新专辑《最伟大的作品》即将发行')), ['周杰伦 夜曲', '夜曲'])
  assert.deepEqual(buildLyricsQueries(request('【私藏馆】周杰伦《稻香》超治愈...')), ['周杰伦 稻香', '稻香'])
  assert.deepEqual(buildLyricsQueries(request('City of Stars——《爱乐之城》MV')), ['City of Stars'])
  assert.deepEqual(buildLyricsQueries(request('《后来》海绵宝宝音源')), ['后来'])
  assert.deepEqual(buildLyricsQueries(request('用海绵宝宝来打开《后来》感动哭了！')), ['后来'])
  assert.deepEqual(buildLyricsQueries(request('晴天 MV', '周杰伦 晴天')), ['周杰伦 晴天', '晴天'])
  assert.deepEqual(buildLyricsQueries(request('【4K修复】周杰伦 - 晴天MV2160P', '稻香')), ['周杰伦 晴天', '晴天'])
})

test('song name is required; unrelated and longer same-prefix names never match', () => {
  assert.equal(selectLyricsMatch(request(), [track(1, { trackName: '稻香' })]), null)
  assert.equal(selectLyricsMatch(request(), [track(2, { trackName: '晴天的你' })]), null)
  assert.equal(selectLyricsMatch(request('晴天的你', '晴天'), [track(3)]), null)
  assert.equal(selectLyricsMatch(request('《后来》海绵宝宝音源'), [track(4, { trackName: '后来', artistName: '刘若英' })])?.id, 4)
})

test('the singer in the video title outweighs a shorter duration difference and the uploader', () => {
  const wrongSinger = track(1, { artistName: '私藏音乐馆', duration: 302 })
  const correctSinger = track(2, { duration: 269 })
  assert.equal(selectLyricsMatch(request(), [wrongSinger, correctSinger])?.id, 2)
  assert.equal(selectLyricsMatch(request('晴天 MV', '周杰伦 晴天'), [wrongSinger, correctSinger])?.id, 2)
})

test('a normal MV prefers studio lyrics even when a live recording is closer in duration', () => {
  const live = track(1, { trackName: '晴天 (Live)', albumName: '世界巡回演唱会', duration: 302 })
  const studio = track(2, { duration: 269 })
  assert.equal(selectLyricsMatch(request(), [live, studio])?.id, 2)
  assert.equal(selectLyricsMatch(request('周杰伦 - 晴天 现场版'), [studio, live])?.id, 1)
})

test('matching accepts plain lyrics and genuine instrumentals, ignores empty lyric records', () => {
  const empty = track(1, { syncedLyrics: null, plainLyrics: '' })
  const plain = track(2, { syncedLyrics: null, plainLyrics: '故事的小黄花' })
  assert.equal(selectLyricsMatch(request(), [empty, plain])?.id, 2)
  assert.equal(selectLyricsMatch(request(), [empty]), null)
  assert.equal(selectLyricsMatch(request(), [track(3, { syncedLyrics: null, instrumental: true })])?.id, 3)
  assert.equal(selectLyricsMatch(request(), [track(4, { syncedLyrics: '[ti:metadata only]', plainLyrics: null })]), null)
})

test('collection videos are not assigned the lyrics for just one contained song', () => {
  assert.equal(selectLyricsMatch(request('周杰伦歌曲合集《晴天》《稻香》', '晴天', 1800), [track(1)]), null)
  assert.equal(selectLyricsMatch(request('周杰伦 - 晴天、稻香串烧', '晴天'), [track(1)]), null)
  assert.equal(selectLyricsMatch(request('City of Stars——《爱乐之城》MV'), [track(2, { trackName: 'City of Stars', artistName: 'Ryan Gosling' })])?.id, 2)
})
