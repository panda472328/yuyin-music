import { useEffect, useRef, useState } from 'react'
import { AudioLines, Crosshair, Disc3, LoaderCircle, Minus, Music2, Plus, RotateCcw } from 'lucide-react'
import type { PlaybackStatus } from '../electron/types'
import { activeLyricIndex } from './lyrics'
import { api } from './api'
import type { LyricsViewState } from './useLyrics'
import './lyrics.css'

interface Props {
  status: PlaybackStatus
  lyrics: LyricsViewState
  onSeek(seconds: number): void
}
const formatTime = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds)) % 60).padStart(2, '0')}`

export default function LyricsView({ status, lyrics, onSeek }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const [coverFailed, setCoverFailed] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [calibrating, setCalibrating] = useState(false)
  const [aligning, setAligning] = useState(false)
  const [alignmentMessage, setAlignmentMessage] = useState<string | null>(null)
  const alignmentRevision = useRef(0)
  const song = status.song
  const isBilibili = lyrics.provider === 'bilibili'
  const words = isBilibili ? '字幕' : '歌词'
  const offsetStep = isBilibili ? .1 : .5
  const hasTimedLyrics = lyrics.lines.some(line => Boolean(line.text))
  const subtitleLabel = lyrics.subtitle ? lyrics.subtitle.isAI ? 'AI 自动字幕' : 'UP 主字幕' : 'Bilibili 字幕'
  const activeIndex = activeLyricIndex(lyrics.lines, status.currentTime, lyrics.offsetSeconds)
  useEffect(() => setCoverFailed(false), [song?.cover])
  useEffect(() => setLoginError(null), [song?.bvid, lyrics.provider, lyrics.phase])
  useEffect(() => {
    alignmentRevision.current++
    setCalibrating(false); setAligning(false); setAlignmentMessage(null)
  }, [song?.bvid, lyrics.provider, lyrics.track?.id, lyrics.track?.syncedLyrics])
  useEffect(() => {
    if (calibrating) return
    const list = viewport.current
    const active = list?.querySelector<HTMLElement>('[data-active="true"]')
    if (list && active) list.scrollTo({ top: active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2, behavior: isBilibili ? 'auto' : 'smooth' })
    else if (activeIndex < 0) list?.scrollTo({ top: 0, behavior: isBilibili ? 'auto' : 'smooth' })
  }, [activeIndex, song?.bvid, lyrics.phase, lyrics.provider, lyrics.lines, calibrating, isBilibili])
  async function chooseLine(time: number) {
    if (!calibrating) { onSeek(Math.max(0, time + lyrics.offsetSeconds)); return }
    if (aligning) return
    const revision = alignmentRevision.current
    setAligning(true)
    try {
      await lyrics.alignLine(time)
      if (revision === alignmentRevision.current) {
        setCalibrating(false)
        setAlignmentMessage('已对齐这句歌词，后续歌词会沿用此时间差。')
      }
    } catch (error) {
      if (revision === alignmentRevision.current) setAlignmentMessage(error instanceof Error ? error.message : String(error))
    } finally { if (revision === alignmentRevision.current) setAligning(false) }
  }
  function openLogin() {
    setLoginError(null)
    void api.login().catch(error => setLoginError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')))
  }

  return <section className={`lyrics-page ${isBilibili ? 'is-bilibili' : ''}`} aria-label="歌词页面">
    <div className="page-heading"><div><div className="eyebrow">WORDS BEHIND THE MUSIC</div><h1>正在听<span className="heading-dot">.</span></h1><p>把旋律里的每一句，都留在眼前。</p></div>{lyrics.track && <span className="lyrics-provider"><span />{isBilibili ? subtitleLabel : hasTimedLyrics ? '同步歌词' : lyrics.track.instrumental ? '纯音乐' : '文字歌词'} · {isBilibili ? lyrics.subtitle?.label || lyrics.subtitle?.language || 'Bilibili' : 'LRCLIB'}</span>}</div>
    <div className="lyrics-source-settings"><div className="lyrics-source-switch" role="group" aria-label="歌词来源"><button type="button" aria-pressed={!isBilibili} onClick={() => lyrics.selectProvider('lrclib')}>搜索歌词</button><button type="button" aria-pressed={isBilibili} onClick={() => lyrics.selectProvider('bilibili')}>Bilibili 字幕</button></div><p className="lyrics-source-explanation">{isBilibili ? '读取当前视频已有的 AI 自动字幕或 UP 主字幕，不会为视频生成新字幕。' : 'LRCLIB 的歌词时间轴对应录音版本；MV 片头或剪辑有时间差时，可点「校准歌词」对齐。'}</p>{isBilibili && lyrics.subtitle?.isAI && <p className="lyrics-ai-note">AI 自动字幕可能误识别唱词，仅供参考。</p>}</div>
    <div className="lyrics-layout">
      <div className="lyrics-song-card"><div className="lyrics-art"><div className="lyrics-art-ring" />{song?.cover && !coverFailed ? <img src={song.cover} alt="当前歌曲封面" referrerPolicy="no-referrer" onError={() => setCoverFailed(true)} /> : <div className="lyrics-art-placeholder"><Disc3 size={74} strokeWidth={.7} /></div>}<span className="lyrics-art-label"><AudioLines size={16} />YUYIN · NOW LISTENING</span></div><h2>{lyrics.track?.trackName ?? song?.title.replace(/【[^】]*】/g, '').trim() ?? '音乐还未开始'}</h2><p>{lyrics.track?.artistName || song?.artist || '选一首歌，听听它的故事'}</p>{lyrics.track?.albumName && <small className="lyrics-album">{lyrics.track.albumName}</small>}{song && <div className="lyrics-source-caption"><span>BILIBILI 音源</span><p title={song.title}>{song.title}</p></div>}<div className="lyrics-card-footnote"><Music2 size={13} />声音在后台，歌词在眼前。</div></div>
      <div className={`lyrics-reading ${calibrating ? 'is-calibrating' : ''}`}>{calibrating && <p className="lyrics-calibration-note" role="status">{aligning ? '正在对齐…' : '听到一句开始时，点击对应歌词，对齐当前播放位置。'}</p>}<div className="lyrics-scroll" ref={viewport}>
        {lyrics.phase === 'idle' && <div className="lyrics-placeholder"><AudioLines size={35} strokeWidth={1} /><h3>等一首歌的时间</h3><p>播放歌曲后，{words}会自动出现在这里。</p></div>}
        {lyrics.phase === 'loading' && <div className="lyrics-placeholder"><LoaderCircle className="spin" size={27} /><h3>{isBilibili ? '正在读取视频字幕' : '正在寻找歌词'}</h3><p>音乐照常播放，{words}很快就来。</p></div>}
        {lyrics.phase === 'error' && <div className="lyrics-placeholder"><Music2 size={31} strokeWidth={1} /><h3>{words}暂时没能送达</h3><p>{lyrics.error}</p><button className="button-secondary" onClick={lyrics.retry}><RotateCcw size={14} />重新获取</button></div>}
        {lyrics.phase === 'empty' && <div className="lyrics-placeholder"><Music2 size={33} strokeWidth={1} /><h3>{isBilibili ? lyrics.requiresLogin ? '登录后查看字幕' : '这个视频还没有可用字幕' : '这首歌，先用耳朵听'}</h3><p>{lyrics.message || (isBilibili ? lyrics.requiresLogin ? 'Bilibili 要求登录后才能读取字幕。完成登录后，请重新获取。' : '没有找到这个视频已有的 AI 自动字幕或 UP 主字幕。' : '暂未找到匹配的歌词，音乐照常播放。MV、翻唱或合集可能还没有对应版本。')}</p><div className="lyrics-empty-actions">{isBilibili && lyrics.requiresLogin && <button className="button-secondary" onClick={openLogin}>打开 Bilibili 登录</button>}<button className="button-secondary" onClick={lyrics.retry}><RotateCcw size={14} />{isBilibili && lyrics.requiresLogin ? '登录后重新获取' : '重新查找'}</button>{isBilibili && <button className="button-secondary" onClick={() => lyrics.selectProvider('lrclib')}>切回搜索歌词</button>}</div>{isBilibili && lyrics.requiresLogin && <p className="lyrics-login-hint">打开登录窗口并完成登录后，再点击「登录后重新获取」。</p>}{loginError && <p role="status">{loginError}</p>}</div>}
        {lyrics.phase === 'ready' && (lyrics.track?.instrumental && !hasTimedLyrics && !lyrics.track.plainLyrics?.trim() ? <div className="lyrics-placeholder"><AudioLines size={37} strokeWidth={1} /><h3>纯音乐，也自有故事</h3><p>这一首没有歌词，让旋律慢慢说。</p></div> : hasTimedLyrics ? <div className={`lyrics-lines ${calibrating ? 'is-calibrating' : ''}`} aria-label={`同步${words}`}>{lyrics.lines.map((line, index) => <button key={`${index}:${line.time}`} className={`lyric-line ${index === activeIndex ? 'is-current' : ''} ${line.text ? '' : 'instrumental-line'}`} data-active={index === activeIndex} aria-current={index === activeIndex ? 'true' : undefined} disabled={aligning || calibrating && !line.text} title={calibrating ? '对齐这句歌词到当前播放时间' : `跳转到 ${formatTime(line.time + lyrics.offsetSeconds)}`} onClick={() => void chooseLine(line.time)}><span className="lyric-timestamp">{formatTime(line.time + lyrics.offsetSeconds)}</span><span>{line.text || '···'}</span></button>)}</div> : <div className="plain-lyrics" aria-label={`文字${words}`}>{lyrics.track?.plainLyrics?.trim() || `暂无可显示的${words}`}</div>)}
      </div><div className="lyrics-reading-footer">{lyrics.phase === 'ready' && hasTimedLyrics ? <><span className="lyrics-click-hint">{calibrating ? '点选正在唱的一句' : `点击一句${words}，跳转到那一刻`}</span><button className="lyrics-align" aria-pressed={calibrating} disabled={aligning || !calibrating && !['playing', 'paused'].includes(status.state)} onClick={() => { setCalibrating(value => !value); setAlignmentMessage(null) }}><Crosshair size={13} />{calibrating ? '取消校准' : '校准歌词'}</button><div className="lyrics-offset"><button aria-label={isBilibili ? "字幕提前零点一秒" : "歌词提前半秒"} title={`${words}提前 ${offsetStep} 秒`} disabled={aligning || lyrics.offsetSeconds <= -180} onClick={() => lyrics.setOffset(lyrics.offsetSeconds - offsetStep)}><Minus size={14} /></button><span aria-label="歌词时间偏移">{lyrics.offsetSeconds === 0 ? '时间微调' : `${lyrics.offsetSeconds > 0 ? '延后' : '提前'} ${Math.abs(lyrics.offsetSeconds).toFixed(1)}s`}</span><button aria-label={isBilibili ? "字幕延后零点一秒" : "歌词延后半秒"} title={`${words}延后 ${offsetStep} 秒`} disabled={aligning || lyrics.offsetSeconds >= 180} onClick={() => lyrics.setOffset(lyrics.offsetSeconds + offsetStep)}><Plus size={14} /></button><button aria-label="重置歌词时间" title="重置时间" disabled={aligning || !lyrics.offsetSeconds} onClick={() => lyrics.setOffset(0)}><RotateCcw size={13} /></button></div></> : lyrics.phase === 'ready' && <span className="lyrics-click-hint">{lyrics.track?.instrumental ? '此版本为纯音乐' : `此版本为文字${words}`}</span>}{lyrics.track && <button className="lyrics-refresh" disabled={lyrics.refreshing || aligning || calibrating} onClick={lyrics.retry} aria-label={`重新查询${words}`} title={`重新查询${words}`}>{lyrics.refreshing ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}</button>}</div>{alignmentMessage && <small className="lyrics-alignment-message" role="status">{alignmentMessage}</small>}{lyrics.phase === 'ready' && lyrics.error && <small className="lyrics-storage-warning" role="status">更新{words}失败，继续显示已有{words}。{lyrics.error}</small>}{lyrics.storageWarning && <small className="lyrics-storage-warning" role="status">{lyrics.storageWarning}</small>}
      </div>
    </div>
  </section>
}
