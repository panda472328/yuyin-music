import { writeFile, mkdir } from 'node:fs/promises'

const queries = ['晴天 周杰伦', '起风了 买辣椒也用券', '花海 周杰伦', '后来 刘若英', '稻香 周杰伦', '夜曲 周杰伦', 'City of Stars', '世界赠予我的 王菲']
const songs = []
for (const query of queries) {
  const url = new URL('https://api.bilibili.com/x/web-interface/search/type')
  url.search = new URLSearchParams({ search_type: 'video', keyword: query, order: 'click', page: '1', page_size: '5' }).toString()
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } })
  if (!response.ok) throw new Error(`Bilibili 返回 HTTP ${response.status}。请在桌面客户端中完成源站验证，当前推荐不会被覆盖。`)
  const body = await response.json()
  if (body.code !== 0 || !body.data?.result?.length) throw new Error(`无法获取推荐 ${query}：${body.message}`)
  const video = body.data.result.sort((a, b) => b.play - a.play)[0]
  const duration = String(video.duration).split(':').reduce((total, part) => total * 60 + Number(part), 0)
  songs.push({ id: video.bvid, bvid: video.bvid, title: video.title.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"'), artist: video.author, cover: video.pic.startsWith('//') ? `https:${video.pic}` : video.pic, duration, playCount: Number(video.play), source: 'bilibili', url: `https://www.bilibili.com/video/${video.bvid}/` })
}
await mkdir('src/data', { recursive: true })
await writeFile('src/data/recommendations.json', JSON.stringify([...new Map(songs.map(song => [song.bvid, song])).values()], null, 2) + '\n')
console.log(`已保存 ${songs.length} 首真实 Bilibili 推荐视频。`)
