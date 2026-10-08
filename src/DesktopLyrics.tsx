import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { AudioLines, GripVertical, Lock, Minus, Plus, Unlock, X } from 'lucide-react'
import {
  DESKTOP_LYRICS_COLOR_OPTIONS,
  DESKTOP_LYRICS_DEFAULT_CONTENT,
  DESKTOP_LYRICS_DEFAULT_SETTINGS,
  DESKTOP_LYRICS_FONT_OPTIONS,
  type DesktopLyricsSettings,
  type DesktopLyricsSnapshot,
} from '../electron/desktop-lyrics-types'

const initialSnapshot: DesktopLyricsSnapshot = {
  settings: { ...DESKTOP_LYRICS_DEFAULT_SETTINGS },
  content: { ...DESKTOP_LYRICS_DEFAULT_CONTENT },
  error: null,
}

function shortError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '').trim()
  return text.length > 90 ? `${text.slice(0, 89)}…` : text || '操作暂未完成，请重试。'
}

/** Fit both the width and available height, so long lyrics remain complete. */
function useFittedText(text: string, maximumSize: number, fontFamily: string) {
  const area = useRef<HTMLDivElement>(null)
  const line = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const container = area.current
    const element = line.current
    if (!container || !element) return
    let disposed = false
    let frame = 0
    const fit = () => {
      if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return
      const fits = (size: number) => {
        element.style.fontSize = `${size}px`
        return element.scrollWidth <= container.clientWidth && element.getBoundingClientRect().height <= container.clientHeight - 2
      }
      if (fits(maximumSize)) return
      let lower = 1
      let upper = maximumSize
      for (let step = 0; step < 12; step++) {
        const middle = (lower + upper) / 2
        if (fits(middle)) lower = middle
        else upper = middle
      }
      element.style.fontSize = `${Math.floor(lower * 4) / 4}px`
    }
    fit()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    observer.observe(container)
    void document.fonts.ready.then(fit)
    return () => { disposed = true; observer.disconnect(); cancelAnimationFrame(frame) }
  }, [text, maximumSize, fontFamily])
  return { area, line }
}

export default function DesktopLyrics() {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toolbarVisible, setToolbarVisible] = useState(true)
  const revision = useRef(0)
  const mounted = useRef(true)
  const toolbarTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nativePointerInside = useRef(false)
  const api = window.desktopLyricsAPI

  function clearToolbarTimer() {
    if (toolbarTimer.current) {
      clearTimeout(toolbarTimer.current)
      toolbarTimer.current = null
    }
  }
  function revealToolbar() {
    setToolbarVisible(true)
    clearToolbarTimer()
    if (nativePointerInside.current) return
    toolbarTimer.current = setTimeout(() => {
      toolbarTimer.current = null
      setToolbarVisible(false)
    }, 2200)
  }

  useEffect(() => {
    mounted.current = true
    revealToolbar()
    if (!api) { setActionError('请从余音桌面播放器打开桌面歌词。'); return () => clearToolbarTimer() }
    let disposed = false
    let unsubscribe = () => {}
    let unsubscribePointer = () => {}
    const accept = (value: DesktopLyricsSnapshot) => {
      if (disposed) return
      revision.current++
      setSnapshot(value)
      setConnected(true)
    }
    try {
      unsubscribe = api.onSnapshot(accept)
      unsubscribePointer = api.onPointerPresence(inside => {
        nativePointerInside.current = inside
        setToolbarVisible(true)
        clearToolbarTimer()
        if (!inside) {
          toolbarTimer.current = setTimeout(() => {
            toolbarTimer.current = null
            setToolbarVisible(false)
          }, 2200)
        }
      })
      const before = revision.current
      void api.getSnapshot().then(value => {
        if (!disposed && revision.current === before) accept(value)
      }).catch(error => { if (!disposed) setActionError(shortError(error)) })
    } catch (error) { setActionError(shortError(error)) }
    return () => { disposed = true; mounted.current = false; unsubscribe(); unsubscribePointer(); clearToolbarTimer() }
  }, [api])

  async function changeSettings(patch: Partial<DesktopLyricsSettings>) {
    if (!api || busy) return
    setBusy(true)
    setActionError(null)
    const before = revision.current
    try {
      const updated = await api.updateSettings(patch)
      if (mounted.current && revision.current === before) {
        revision.current++
        setSnapshot(updated)
        setConnected(true)
      }
    } catch (error) { if (mounted.current) setActionError(shortError(error)) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function close() {
    if (!api || busy) return
    setBusy(true)
    setActionError(null)
    try { await api.close() }
    catch (error) { if (mounted.current) setActionError(shortError(error)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const { settings, content } = snapshot
  const fontFamily = DESKTOP_LYRICS_FONT_OPTIONS.find(option => option.value === settings.font)!.fontFamily
  const color = DESKTOP_LYRICS_COLOR_OPTIONS.find(option => option.value === settings.color)!.color
  const hasCurrent = connected && content.phase === 'ready' && Boolean(content.current.trim())
  let current = content.current
  let next = content.next
  if (!connected) { current = api ? '余音 · 桌面歌词' : '桌面歌词暂不可用'; next = api ? '正在连接播放器…' : '请在余音桌面版中打开' }
  else if (content.phase === 'idle') { current = '余音 · 桌面歌词'; next = '播放一首歌，让歌词随音乐流动' }
  else if (content.phase === 'loading') { current = '正在寻找歌词…'; next = '音乐照常播放' }
  else if (content.phase === 'empty') { current = '暂无同步歌词'; next = '可在播放器中切换歌词来源' }
  else if (content.phase === 'error') { current = '歌词暂时不可用'; next = '请在播放器中重新获取' }
  else if (!content.current.trim()) { current = '♪'; next = content.next || '静听旋律' }
  const currentMaximum = hasCurrent ? settings.fontSize : Math.min(settings.fontSize, 30)
  const nextMaximum = Math.min(24, Math.max(14, settings.fontSize * .55))
  const currentFit = useFittedText(current, currentMaximum, fontFamily)
  const nextFit = useFittedText(next, nextMaximum, fontFamily)
  const error = actionError || snapshot.error
  const disabled = busy || !connected || !api
  const style = { '--lyrics-color': color, '--lyrics-font': fontFamily, '--lyrics-opacity': settings.opacity } as CSSProperties
  const rootClass = `desktop-lyrics ${error ? 'has-error' : ''} ${settings.locked ? 'is-locked' : ''} ${toolbarVisible ? 'toolbar-visible' : 'toolbar-hidden'}`

  return <main className={rootClass} style={style} data-font={settings.font} data-color={settings.color} data-phase={content.phase} data-locked={settings.locked} data-opacity={settings.opacity} aria-label="余音桌面歌词" onPointerMove={revealToolbar}>
    <div className="desktop-lyrics-toolbar" role="toolbar" aria-label="桌面歌词设置">
      <div className="desktop-lyrics-handle" title="拖动手柄、歌词或空白处可移动窗口"><GripVertical size={13} /><span className="desktop-lyrics-brand"><AudioLines size={15} />余音</span><span className="desktop-lyrics-label">桌面歌词</span></div>
      <span className="desktop-toolbar-divider" />
      <select className="desktop-font-select" aria-label="桌面歌词字体" title="切换歌词字体" value={settings.font} disabled={disabled} onChange={event => void changeSettings({ font: event.target.value as DesktopLyricsSettings['font'] })}>
        {DESKTOP_LYRICS_FONT_OPTIONS.map(option => <option key={option.value} value={option.value} style={{ fontFamily: option.fontFamily }}>{option.label}</option>)}
      </select>
      <div className="desktop-font-size"><button aria-label="缩小桌面歌词字号" title="缩小字号" disabled={disabled || settings.fontSize <= 24} onClick={() => void changeSettings({ fontSize: Math.max(24, settings.fontSize - 2) })}><Minus size={13} /></button><output aria-label="桌面歌词字号" title="歌词字号">{settings.fontSize}</output><button aria-label="放大桌面歌词字号" title="放大字号" disabled={disabled || settings.fontSize >= 56} onClick={() => void changeSettings({ fontSize: Math.min(56, settings.fontSize + 2) })}><Plus size={13} /></button></div>
      <span className="desktop-toolbar-divider" />
      <div className="desktop-lyrics-colors" role="group" aria-label="桌面歌词颜色">{DESKTOP_LYRICS_COLOR_OPTIONS.map(option => <button key={option.value} aria-label={`歌词颜色：${option.label}`} title={option.label} aria-pressed={settings.color === option.value} disabled={disabled} onClick={() => void changeSettings({ color: option.value })}><span style={{ backgroundColor: option.color }} /></button>)}</div>
      <span className="desktop-toolbar-divider" />
      <label className="desktop-opacity-control" title="歌词透明度"><span>透明度</span><input type="range" aria-label="桌面歌词透明度" min="0.3" max="1" step="0.05" value={settings.opacity} disabled={disabled} onChange={event => void changeSettings({ opacity: Number(event.target.value) })} /><output>{Math.round(settings.opacity * 100)}%</output></label>
      <button className="desktop-lyrics-lock" aria-label={settings.locked ? '解锁桌面歌词' : '锁定桌面歌词'} title={settings.locked ? '解锁后可移动歌词窗口' : '锁定后禁止移动歌词窗口'} aria-pressed={settings.locked} disabled={busy || !api} onClick={() => void changeSettings({ locked: !settings.locked })}>{settings.locked ? <Lock size={15} /> : <Unlock size={15} />}</button>
      <span className="desktop-toolbar-divider" />
      <button className="desktop-lyrics-close" aria-label="关闭桌面歌词" title="关闭桌面歌词" disabled={busy || !api} onClick={() => void close()}><X size={16} /></button>
    </div>
    <section className={`desktop-lyrics-copy ${hasCurrent ? '' : 'is-placeholder'}`} aria-label={hasCurrent ? '同步歌词' : '歌词状态'}>
      <div className="desktop-current-area" ref={currentFit.area}><p ref={currentFit.line} className="desktop-lyric-current" style={{ fontSize: currentMaximum }} title={current}>{current}</p></div>
      <div className="desktop-next-area" ref={nextFit.area}><p ref={nextFit.line} className="desktop-lyric-next" style={{ fontSize: nextMaximum }} title={next}>{next || '\u00a0'}</p></div>
    </section>
    <div className="desktop-lyrics-caption">{content.title ? <><span className={`desktop-playing-dot ${content.playing ? 'is-playing' : ''}`} title={content.playing ? '播放中' : '已暂停'} /><span className="desktop-song-title" title={content.title}>{content.title}</span>{!content.playing && <span className="desktop-paused-label">已暂停</span>}</> : <span>YUYIN · 留住每一句喜欢</span>}</div>
    {error && <p className="desktop-lyrics-status" role="status" title={error}>{shortError(error)}</p>}
  </main>
}
