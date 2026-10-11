import test from 'node:test'
import assert from 'node:assert/strict'
import { bilibiliResultText, isSearchMode, normalizeSongName, parseSearchSuggestions, rankSongTitleResults, songTitleRelevance, titleMatchesSongName } from '../src/shared/search-mode'

test('song name matching ignores Unicode spacing, punctuation, case and width', () => {
  assert.equal(normalizeSongName('  Ｈｅｌｌｏ，ＷＯＲＬＤ！ '), 'helloworld')
  assert.equal(titleMatchesSongName('Hello, World！', ' Ｈｅｌｌｏ ｗｏｒｌｄ '), true)
  assert.equal(titleMatchesSongName('《光 年，之 外》', '光年之外'), true)
  assert.equal(titleMatchesSongName('晴天，周杰伦', '晴天 周杰伦'), true)
})

test('song name matching requires equal complete normalized keys without inferred metadata', () => {
  for (const title of ['【现场】光年之外', '光年之外 Live', '《光年之外》纯音乐', '光年之外 邓紫棋', '前奏 光年之外', '光年之外和晴天合集']) {
    assert.equal(titleMatchesSongName(title, '光年之外'), false, title)
  }
  assert.equal(titleMatchesSongName('光年中途之外', '光年之外'), false)
  assert.equal(titleMatchesSongName('夜曲和晴天合集', '晴天夜曲'), false)
  assert.equal(titleMatchesSongName('推荐一首歌曲', '晴天'), false)
  assert.equal(titleMatchesSongName('听见夏天', '晴天'), false)
  assert.equal(titleMatchesSongName('歌曲晴天', '晴天 周杰伦'), false, 'Multiple typed words are not interpreted as artist metadata')
  assert.equal(titleMatchesSongName('晴天', '， ！'), false)
  assert.equal(titleMatchesSongName('Title', ''), false)
})

test('mode validation accepts only the public contract', () => {
  assert.equal(isSearchMode('song'), true)
  assert.equal(isSearchMode('video'), true)
  for (const value of [undefined, null, '', 'SONG', 'songs', 1, {}, ['song']]) assert.equal(isSearchMode(value), false)
})

test('official title markup and entity decoding are shared by desktop and preview matching', () => {
  const title = bilibiliResultText('<em>光&#x5e74;</em>&nbsp;&#20043;外 &amp; Live')
  assert.equal(title, '光年 之外 & Live')
  assert.equal(titleMatchesSongName(title, '光年之外'), false)
  assert.equal(titleMatchesSongName(bilibiliResultText('<em>光&#x5e74;</em>&nbsp;&#20043;外'), '光年之外'), true)
  assert.equal(bilibiliResultText(null), '')
})

test('song relevance keeps all official results and stable ties while prioritizing title relations', () => {
  const items = ['无关标题', '现场 光年之外', '光年之外 Live', '《光 年，之 外》', '光年之外 翻唱', '别的节目'].map((title, id) => ({ title, id }))
  assert.deepEqual(rankSongTitleResults(items, '光年之外').map(item => item.id), [3, 2, 4, 1, 0, 5])
  assert.deepEqual(items.map(item => item.id), [0, 1, 2, 3, 4, 5], 'source array is never mutated')
  assert.deepEqual(rankSongTitleResults(items, '， ！').map(item => item.id), [0, 1, 2, 3, 4, 5])
  assert.equal(songTitleRelevance('光年之外', '光年之外 邓紫棋'), 4)
})

test('multiple typed words and version terms work in either order without treating uploader as artist', () => {
  const items = ['无关节目', '晴天', '周杰伦 现场 晴天', '晴天 周杰伦 Live', '周杰伦'].map((title, id) => ({ title, id }))
  assert.deepEqual(rankSongTitleResults(items, '晴天 周杰伦').map(item => item.id), [3, 2, 1, 4, 0])
  assert.deepEqual(rankSongTitleResults(items, '周杰伦 晴天').map(item => item.id), [2, 3, 1, 4, 0])
  assert.deepEqual(rankSongTitleResults(items, '晴天 Live').map(item => item.id), [3, 1, 2, 0, 4])
  assert.equal(songTitleRelevance('ＷＯＲＬＤ / ＨＥＬＬＯ live', 'hello world'), 3)
})

test('official suggestions are plain bounded deduplicated strings from known tag fields', () => {
  const result = parseSearchSuggestions({ result: { tag: [
    { value: '<em>晴天</em>' }, { value: '晴天' }, { value: '  &lt;b&gt;夜曲&lt;/b&gt;\u0000\u200b ' },
    { value: 1 }, { label: '不接受未知字段' }, null, { value: 'x'.repeat(120) },
    ...Array.from({ length: 15 }, (_, index) => ({ value: `建议${index}` })),
  ] } })
  assert.equal(result.length, 10)
  assert.deepEqual(result.slice(0, 3), ['晴天', '夜曲', 'x'.repeat(100)])
  assert.deepEqual(parseSearchSuggestions({ data: { tag: [{ value: '备用结构' }] } }), ['备用结构'])
  assert.deepEqual(parseSearchSuggestions({ result: { tag: ['text'] } }), [])
  assert.deepEqual(parseSearchSuggestions({ result: { tag: [] } }), [])
  assert.deepEqual(parseSearchSuggestions({ data: { tag: [] } }), [])
  for (const value of [null, [], 'unsafe', {}, { result: {} }, { result: { tag: null } }, { result: { unknown: [{ value: '不接受' }] } }]) {
    assert.throws(() => parseSearchSuggestions(value), /响应格式异常/)
  }
})
