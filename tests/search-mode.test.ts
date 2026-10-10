import test from 'node:test'
import assert from 'node:assert/strict'
import { bilibiliResultText, isSearchMode, normalizeSongName, titleMatchesSongName } from '../src/shared/search-mode'

test('song name matching ignores Unicode spacing, punctuation, case and width', () => {
  assert.equal(normalizeSongName('  Ｈｅｌｌｏ，ＷＯＲＬＤ！ '), 'helloworld')
  assert.equal(titleMatchesSongName('【现场】Hello, World！｜完整版', ' Ｈｅｌｌｏ ｗｏｒｌｄ '), true)
  assert.equal(titleMatchesSongName('《光 年，之 外》完整演唱', '光年之外'), true)
  assert.equal(titleMatchesSongName('晴天，周杰伦', '晴天 周杰伦'), true)
})

test('song name matching requires the complete normalized input as consecutive title text', () => {
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
  assert.equal(titleMatchesSongName(title, '光年之外'), true)
  assert.equal(bilibiliResultText(null), '')
})
