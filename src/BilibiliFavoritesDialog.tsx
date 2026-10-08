import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDownToLine, Check, ExternalLink, FolderHeart, LoaderCircle, RefreshCw } from 'lucide-react'
import { api, isDesktop } from './api'
import type { Song } from '../electron/types'

type FoldersResult = Awaited<ReturnType<typeof api.getBilibiliFavoriteFolders>>
type Folder = FoldersResult['folders'][number]
export interface FavoritePlaylistImport {
  accountMid: number
  folderId: number
  name: string
  songs: Song[]
  skippedCount: number
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')

export default function BilibiliFavoritesDialog({ onImport }: { onImport: (result: FavoritePlaylistImport) => void }) {
  const [data, setData] = useState<FoldersResult | null>(null)
  const [selected, setSelected] = useState<Folder | null>(null)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadedCount, setLoadedCount] = useState(0)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const active = useRef(true)

  async function refresh() {
    const request = ++sequence.current
    setLoading(true); setError(''); setData(null); setSelected(null); setName('')
    try {
      const result = await api.getBilibiliFavoriteFolders()
      if (!active.current || request !== sequence.current) return
      setData(result)
    } catch (failure) {
      if (active.current && request === sequence.current) setError(errorText(failure))
    } finally {
      if (active.current && request === sequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    active.current = true
    if (isDesktop) void refresh()
    return () => { active.current = false; sequence.current++ }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selected || !data || !name.trim() || loading || importing) return
    setImporting(true); setLoadedCount(0); setError('')
    try {
      const songs = new Map<string, Song>()
      let nextPage = 1
      let total = selected.mediaCount
      for (;;) {
        const result = await api.getBilibiliFavoriteItems(selected.id, nextPage)
        if (!active.current) return
        total = result.total
        result.songs.forEach(song => songs.set(song.bvid, song))
        if (songs.size > 3_000) throw new Error('每份本地歌单最多支持 3000 首，请先在 Bilibili 将收藏夹拆分后导入。')
        setLoadedCount(songs.size)
        if (!result.hasMore) break
        nextPage++
        if (nextPage > 1_000) throw new Error('这个收藏夹太大，请在 Bilibili 拆分后再导入。')
      }
      if (!active.current) return
      onImport({ accountMid: data.mid, folderId: selected.id, name: name.trim(), songs: [...songs.values()], skippedCount: Math.max(0, total - songs.size) })
    } catch (failure) {
      if (active.current) setError(errorText(failure))
    } finally {
      if (active.current) setImporting(false)
    }
  }

  return <div className="bilibili-favorites-dialog">
    <span className="modal-symbol"><FolderHeart size={26} /></span>
    <h2>收藏夹变成歌单</h2>
    <p>选择你 Bilibili 账号的收藏夹，把其中的视频收进本地歌单。再次导入会合并新歌曲。</p>
    {!isDesktop ? <p className="bilibili-favorites-message">请在余音桌面客户端中使用 Bilibili 收藏夹。</p> : <>
      <div className="bilibili-favorites-account">
        <span>{data ? `当前账号：${data.username}` : '使用余音中已登录的 Bilibili 账号'}</span>
        <button className="text-button" type="button" disabled={loading || importing} onClick={() => void refresh()}><RefreshCw size={14} />刷新收藏夹</button>
      </div>
      <button className="text-button" type="button" disabled={importing} onClick={() => void api.login().then(() => { if (active.current) setError('登录完成后，点击“刷新收藏夹”。') }).catch(failure => { if (active.current) setError(errorText(failure)) })}><ExternalLink size={14} />打开 Bilibili 登录 / 切换账号</button>
      {error && <p className="bilibili-favorites-message" role="alert">{error}</p>}
      {loading ? <div className="bilibili-favorites-loading" role="status"><LoaderCircle size={22} className="spin" />正在读取收藏夹…</div> : data && <>
        {!data.folders.length ? <p className="bilibili-favorites-message">这个账号还没有收藏夹。到 Bilibili 创建后，再刷新这里。</p> : <form onSubmit={event => void submit(event)}>
          <div className="bilibili-folder-list" role="group" aria-label="选择 Bilibili 收藏夹">
            {data.folders.map(folder => <button type="button" className={`bilibili-folder ${selected?.id === folder.id ? 'selected' : ''}`} key={folder.id} disabled={importing} aria-pressed={selected?.id === folder.id} onClick={() => { setSelected(folder); setName(folder.title); setError('') }}>
              <span className="bilibili-folder-cover">{folder.cover ? <img src={folder.cover} alt="" referrerPolicy="no-referrer" /> : <FolderHeart size={22} />}</span>
              <span><strong>{folder.title}</strong><small>{folder.mediaCount} 个收藏视频</small></span>
              {selected?.id === folder.id && <Check size={18} />}
            </button>)}
          </div>
          <label htmlFor="bilibili-playlist-name">本地歌单名称</label>
          <input id="bilibili-playlist-name" value={name} maxLength={80} placeholder="先选择一个收藏夹" disabled={!selected || importing} onChange={event => setName(event.target.value)} required />
          <p className="bilibili-favorites-note">已失效视频及非视频内容会跳过。收藏夹后续新增内容，可再次导入更新。</p>
          <button className="button-primary" disabled={!selected || !name.trim() || importing} type="submit">{importing ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}{importing ? `正在导入…已读取 ${loadedCount} 首` : '导入为歌单'}</button>
        </form>}
      </>}
    </>}
  </div>
}
