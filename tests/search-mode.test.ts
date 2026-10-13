import test from 'node:test'
import assert from 'node:assert/strict'
import { bilibiliResultText, classifySongSearchResult, hasSongQualityLabel, isSearchMode, normalizeSongName, parseSearchSuggestions, preferredMusicUploaderMids, rankSongSearchResults, rankSongTitleResults, requestsDanceVersion, songTitleRelevance, titleMatchesSongName } from '../src/shared/search-mode'

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

test('public preferred uploader registry preserves large safe identities without int32 truncation', () => {
  assert.ok(preferredMusicUploaderMids.length > 0 && preferredMusicUploaderMids.length <= 4)
  assert.ok(preferredMusicUploaderMids.every(mid => Number.isSafeInteger(mid) && mid > 0))
  assert.equal(new Set(preferredMusicUploaderMids).size, preferredMusicUploaderMids.length)
  assert.ok(preferredMusicUploaderMids.includes(3493093607213343))
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

test('song results group relevant non-DJ singles, then collections, then remaining videos without dropping anything', () => {
  const items = [
    { id: 'dj', title: '晴天 DJ版', uploaderMid: 101 },
    { id: 'collection', title: '晴天与夜曲 合集', uploaderMid: 101 },
    { id: 'popular', title: '晴天', playCount: 9_000_000 },
    { id: 'preferred', title: '【高音质】晴天', uploaderMid: 101 },
    { id: 'tutorial', title: '晴天 吉他教学' },
    { id: 'unrelated', title: '夏日闲聊', uploaderMid: 101, searchTags: '晴天 无损' },
  ]
  const ranked = rankSongSearchResults(items, '晴天', [101])
  assert.deepEqual(ranked.map(item => item.id), ['preferred', 'popular', 'collection', 'dj', 'tutorial', 'unrelated'])
  assert.deepEqual(ranked.map(item => classifySongSearchResult(item, '晴天')), ['single', 'single', 'collection', 'other', 'other', 'other'])
  assert.equal(ranked.length, items.length)
  assert.deepEqual(items.map(item => item.id), ['dj', 'collection', 'popular', 'preferred', 'tutorial', 'unrelated'])
})

test('preferred singles from several uploaders sort by views before title relevance and quality labels', () => {
  const items = [
    { id: 'exactLow', title: '晴天', uploaderMid: 101, playCount: 10, searchTags: '无损' },
    { id: 'popularLive', title: '现场 晴天', uploaderMid: 202, playCount: 1000 },
    { id: 'middle', title: '晴天 翻唱', uploaderMid: 101, playCount: 100 },
    { id: 'ordinary', title: '晴天', uploaderMid: 999, playCount: 9_000_000 },
    { id: 'collection', title: '晴天 合集', uploaderMid: 202, playCount: 9_000_000 },
  ]
  assert.deepEqual(rankSongSearchResults(items, '晴天', [101, 202]).map(item => item.id),
    ['popularLive', 'middle', 'exactLow', 'ordinary', 'collection'])
  assert.deepEqual(items.map(item => item.id), ['exactLow', 'popularLive', 'middle', 'ordinary', 'collection'])
})

test('preferred view ties retain relevance and stable order, with missing or invalid views treated as zero', () => {
  const items = [
    { id: 'live', title: '现场 晴天', uploaderMid: 101, playCount: 100 },
    { id: 'exactA', title: '晴天', uploaderMid: 202, playCount: 100 },
    { id: 'exactB', title: '晴天', uploaderMid: 101, playCount: 100 },
    { id: 'missing', title: '晴天', uploaderMid: 101 },
    { id: 'nan', title: '晴天', uploaderMid: 202, playCount: NaN },
    { id: 'infinity', title: '晴天', uploaderMid: 202, playCount: Infinity },
    { id: 'negative', title: '晴天', uploaderMid: 101, playCount: -1 },
  ]
  assert.deepEqual(rankSongSearchResults(items, '晴天', [101, 202]).map(item => item.id),
    ['exactA', 'exactB', 'live', 'missing', 'nan', 'infinity', 'negative'])
})

test('uploader preference applies only to related non-DJ single videos and never uses plays as quality evidence', () => {
  const items = [
    { id: 'ordinaryCollection', title: '晴天 合集' },
    { id: 'preferredCollection', title: '晴天 合集', uploaderMid: 101 },
    { id: 'ordinaryOther', title: '晴天 DJ版' },
    { id: 'preferredOther', title: '晴天 DJ版', uploaderMid: 101 },
    { id: 'plain', title: '晴天 演唱', playCount: 9_000_000 },
    { id: 'labeled', title: '晴天 演唱', searchTags: 'FLAC 高音质', playCount: 1 },
  ]
  assert.deepEqual(rankSongSearchResults(items, '晴天', [101, -1, 1.5]).map(item => item.id),
    ['labeled', 'plain', 'ordinaryCollection', 'preferredCollection', 'ordinaryOther', 'preferredOther'])
  assert.equal(hasSongQualityLabel({ title: '普通单曲', searchTags: 'music' }), false)
})

test('explicit DJ or Remix requests retain that version and generic words do not falsely trigger it', () => {
  for (const query of ['晴天 DJ', '晴天 Remix', '晴天 慢摇']) assert.equal(requestsDanceVersion(query), true)
  for (const query of ['晴天', 'Django', 'Adjective']) assert.equal(requestsDanceVersion(query), false)
  assert.equal(classifySongSearchResult({ title: '晴天 DJ版', duration: 200 }, '晴天 DJ'), 'single')
  assert.equal(classifySongSearchResult({ title: '晴天 Remix 串烧', duration: 200 }, '晴天 Remix'), 'collection')
  assert.equal(classifySongSearchResult({ title: '晴天 DJ版', duration: 200 }, '晴天'), 'other')
})

test('collections require title signals while long loops and nonmusic tutorials remain other', () => {
  for (const title of ['晴天 30首经典歌曲', '晴天 Full Album', '晴天 Playlist', '晴天精选集']) {
    assert.equal(classifySongSearchResult({ title, duration: 100 }, '晴天'), 'collection', title)
  }
  assert.equal(classifySongSearchResult({ title: '晴天 单曲', searchTags: '音乐合集', duration: 180 }, '晴天'), 'single')
  assert.equal(classifySongSearchResult({ title: '晴天 单曲循环', duration: 3600 }, '晴天'), 'other')
  assert.equal(classifySongSearchResult({ title: '晴天 无损', duration: 200 }, '， ！'), 'other')
  assert.equal(classifySongSearchResult({ title: '无关内容', searchTags: '晴天' }, '晴天'), 'other')
})

test('matching only an artist token cannot promote another song from a preferred uploader', () => {
  const items = [
    { id: 'differentSong', title: '林俊杰 修炼爱情', uploaderMid: 101 },
    { id: 'requestedSong', title: '林俊杰 江南' },
    { id: 'reverseWords', title: '江南 林俊杰 高音质', uploaderMid: 101 },
  ]
  assert.equal(classifySongSearchResult(items[0], '林俊杰 江南'), 'other')
  assert.deepEqual(rankSongSearchResults(items, '林俊杰 江南', [101]).map(item => item.id),
    ['reverseWords', 'requestedSong', 'differentSong'])
})

test('live videos naming several distinct songs remain collections even for a preferred uploader', () => {
  const mixed = { title: '【现场直拍】林忆莲《为你我受冷风吹》《至少还有你》《词不达意》演唱会新现场', duration: 225, uploaderMid: 101 }
  assert.equal(classifySongSearchResult(mixed, '至少还有你'), 'collection')
  assert.equal(classifySongSearchResult({ title: '《晴天》与《晴天》现场演唱', duration: 225 }, '晴天'), 'single')
  assert.equal(classifySongSearchResult({ title: '《晴天》与《晴 天！》现场演唱', duration: 225 }, '晴天'), 'single')
  for (const title of ['晴天 现场集', '晴天 高光现场集']) {
    assert.equal(classifySongSearchResult({ title, duration: 225 }, '晴天'), 'collection')
  }
  assert.deepEqual(rankSongSearchResults([mixed, { title: '至少还有你', duration: 225 }], '至少还有你', [101]).map(item => item.title),
    ['至少还有你', mixed.title])
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
