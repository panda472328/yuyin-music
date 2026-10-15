import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ALargeSmall, ChevronLeft, Eye, GripVertical, Lock, Minus, Palette, Plus, Type, Unlock, X } from 'lucide-react'
import { PIXEL_FONT_FAMILY } from './shared/lyric-styles'
import {
  DESKTOP_LYRICS_COLOR_OPTIONS,
  DESKTOP_LYRICS_DEFAULT_CONTENT,
  DESKTOP_LYRICS_DEFAULT_SETTINGS,
  DESKTOP_LYRICS_FONT_OPTIONS,
  type DesktopLyricsDragRegions,
  type DesktopLyricsSettings,
  type DesktopLyricsSnapshot,
} from '../electron/desktop-lyrics-types'

const initialSnapshot: DesktopLyricsSnapshot = {
  settings: { ...DESKTOP_LYRICS_DEFAULT_SETTINGS },
  content: { ...DESKTOP_LYRICS_DEFAULT_CONTENT },
  error: null,
}

type DesktopLyricsSettingsPanel = 'font' | 'size' | 'color' | 'opacity'

function shortError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '').trim()
  return text.length > 90 ? `${text.slice(0, 89)}…` : text || '操作暂未完成，请重试。'
}

/** Fit both the width and available height, so long lyrics remain complete. */
function useFittedText(text: string, maximumSize: number, fontFamily: string, preset: string) {
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
    document.fonts.addEventListener('loadingdone', fit)
    return () => { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); document.fonts.removeEventListener('loadingdone', fit) }
  }, [text, maximumSize, fontFamily, preset])
  return { area, line }
}

export default function DesktopLyrics() {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toolbarVisible, setToolbarVisible] = useState(true)
  const [activeSettingsPanel, setActiveSettingsPanel] = useState<DesktopLyricsSettingsPanel | null>(null)
  const settingsButtons = useRef<Partial<Record<DesktopLyricsSettingsPanel, HTMLButtonElement | null>>>({})
  const panelFocus = useRef<DesktopLyricsSettingsPanel | null>(null)
  const restoreFocus = useRef<DesktopLyricsSettingsPanel | null>(null)
  const revision = useRef(0)
  const mounted = useRef(true)
  const toolbarTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nativePointerInside = useRef(false)
  const toolbarKeyboardFocus = useRef(false)
  const rootElement = useRef<HTMLElement>(null)
  const api = window.desktopLyricsAPI

  function clearToolbarTimer() {
    if (toolbarTimer.current) {
      clearTimeout(toolbarTimer.current)
      toolbarTimer.current = null
    }
  }
  function scheduleToolbarHide() {
    clearToolbarTimer()
    if (nativePointerInside.current) return
    toolbarTimer.current = setTimeout(() => {
      toolbarTimer.current = null
      const toolbar = rootElement.current?.querySelector('.desktop-lyrics-toolbar')
      if (toolbarKeyboardFocus.current && document.hasFocus() && toolbar?.contains(document.activeElement)) return
      setToolbarVisible(false)
    }, 2200)
  }
  function revealToolbar() {
    setToolbarVisible(true)
    scheduleToolbarHide()
  }
  function openSettingsPanel(panel: DesktopLyricsSettingsPanel) {
    if (toolbarKeyboardFocus.current) panelFocus.current = panel
    setActiveSettingsPanel(panel)
    revealToolbar()
  }
  function closeSettingsPanel(focusTrigger: boolean) {
    if (!activeSettingsPanel) return
    if (focusTrigger) restoreFocus.current = activeSettingsPanel
    setActiveSettingsPanel(null)
    revealToolbar()
  }

  useEffect(() => {
    mounted.current = true
    revealToolbar()
    if (!api) { setActionError('请从open音乐桌面播放器打开桌面歌词。'); return () => clearToolbarTimer() }
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
        revealToolbar()
      })
      window.addEventListener('blur', scheduleToolbarHide)
      const before = revision.current
      void api.getSnapshot().then(value => {
        if (!disposed && revision.current === before) accept(value)
      }).catch(error => { if (!disposed) setActionError(shortError(error)) })
    } catch (error) { setActionError(shortError(error)) }
    return () => { disposed = true; mounted.current = false; unsubscribe(); unsubscribePointer(); window.removeEventListener('blur', scheduleToolbarHide); clearToolbarTimer() }
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
  const fontFamily = settings.style === 'minecraft' ? PIXEL_FONT_FAMILY : DESKTOP_LYRICS_FONT_OPTIONS.find(option => option.value === settings.font)!.fontFamily
  const color = DESKTOP_LYRICS_COLOR_OPTIONS.find(option => option.value === settings.color)!.color
  const hasCurrent = connected && content.phase === 'ready' && Boolean(content.current.trim())
  let current = content.current
  let next = content.next
  if (!connected) { current = api ? 'open音乐 · 桌面歌词' : '桌面歌词暂不可用'; next = api ? '正在连接播放器…' : '请在open音乐桌面版中打开' }
  else if (content.phase === 'idle') { current = 'open音乐 · 桌面歌词'; next = '播放一首歌，让歌词随音乐流动' }
  else if (content.phase === 'loading') { current = '正在寻找歌词…'; next = '音乐照常播放' }
  else if (content.phase === 'empty') { current = '暂无同步歌词'; next = '可在播放器中切换歌词来源' }
  else if (content.phase === 'error') { current = '歌词暂时不可用'; next = '请在播放器中重新获取' }
  else if (!content.current.trim()) { current = '♪'; next = content.next || '静听旋律' }
  const currentMaximum = hasCurrent ? settings.fontSize : Math.min(settings.fontSize, 30)
  const nextMaximum = Math.min(24, Math.max(14, settings.fontSize * .55))
  const currentFit = useFittedText(current, currentMaximum, fontFamily, settings.style)
  const nextFit = useFittedText(next, nextMaximum, fontFamily, settings.style)
  const error = actionError || snapshot.error
  const settingsDisabled = !connected || !api
  const style = { '--lyrics-color': color, '--lyrics-font': fontFamily, '--lyrics-opacity': settings.opacity } as CSSProperties
  const settingsExpanded = activeSettingsPanel !== null && !settings.locked && toolbarVisible
  const rootClass = `desktop-lyrics ${error ? 'has-error' : ''} ${settings.locked ? 'is-locked' : ''} ${settingsExpanded ? 'settings-open' : ''} ${toolbarVisible ? 'toolbar-visible' : 'toolbar-hidden'}`

  useEffect(() => {
    if (settings.locked || !toolbarVisible) {
      panelFocus.current = null
      restoreFocus.current = null
      setActiveSettingsPanel(null)
    }
  }, [settings.locked, toolbarVisible])

  useLayoutEffect(() => {
    if (activeSettingsPanel && panelFocus.current === activeSettingsPanel) {
      panelFocus.current = null
      rootElement.current?.querySelector<HTMLButtonElement>(`#desktop-lyrics-${activeSettingsPanel}-panel button:not(:disabled)`)?.focus({ preventScroll: true })
      return
    }
    if (!activeSettingsPanel && restoreFocus.current) {
      const panel = restoreFocus.current
      restoreFocus.current = null
      settingsButtons.current[panel]?.focus({ preventScroll: true })
    }
  }, [activeSettingsPanel])

  useLayoutEffect(() => {
    const root = rootElement.current
    if (!root || !api) return
    const toolbar = root.querySelector<HTMLElement>('.desktop-lyrics-toolbar')
    const handle = root.querySelector<HTMLElement>('.desktop-lyrics-handle')
    if (!toolbar || !handle) return
    let frame = 0
    const report = () => {
      frame = 0
      const bounds = root.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) return
      const relative = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height }
      }
      const regions: DesktopLyricsDragRegions = {
        viewportWidth: bounds.width,
        viewportHeight: bounds.height,
        toolbarVisible,
        toolbar: relative(toolbar),
        handle: relative(handle),
      }
      api.setDragRegions(regions)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(report)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    observer.observe(toolbar)
    observer.observe(handle)
    window.addEventListener('resize', schedule)
    schedule()
    return () => { observer.disconnect(); window.removeEventListener('resize', schedule); if (frame) cancelAnimationFrame(frame) }
  }, [api, toolbarVisible])

  return <main ref={rootElement} className={rootClass} style={style} data-lyric-style={settings.style} data-font={settings.font} data-color={settings.color} data-phase={content.phase} data-locked={settings.locked} data-opacity={settings.opacity} aria-label="open音乐桌面歌词" onPointerMove={revealToolbar}>
    <div className="desktop-lyrics-toolbar" role="toolbar" aria-label="桌面歌词设置" aria-busy={busy} onFocusCapture={event => { toolbarKeyboardFocus.current = (event.target as HTMLElement).matches(':focus-visible'); revealToolbar() }} onBlurCapture={scheduleToolbarHide} onPointerDownCapture={() => { toolbarKeyboardFocus.current = false; revealToolbar() }} onKeyDownCapture={() => { toolbarKeyboardFocus.current = true; revealToolbar() }} onKeyDown={event => {
        if (event.key === 'Escape' && settingsExpanded) {
          event.stopPropagation()
          closeSettingsPanel(true)
        }
      }}>
      <div className="desktop-lyrics-handle" aria-label="拖动桌面歌词" title="拖动手柄、歌词或空白处可移动窗口"><GripVertical size={16} /></div>
      <div className="desktop-lyrics-settings">
        <div className="desktop-settings-launchers" hidden={settingsExpanded}>
          <button ref={element => { settingsButtons.current.font = element }} className="desktop-settings-trigger" aria-label="设置桌面歌词字体" title={settings.style === 'minecraft' ? '我的世界使用内置像素字体' : `字体：${DESKTOP_LYRICS_FONT_OPTIONS.find(option => option.value === settings.font)?.label}`} aria-expanded={activeSettingsPanel === 'font'} aria-controls="desktop-lyrics-font-panel" disabled={settingsDisabled || settings.style === 'minecraft'} onClick={() => openSettingsPanel('font')}><Type size={18} /></button>
          <button ref={element => { settingsButtons.current.size = element }} className="desktop-settings-trigger" aria-label="设置桌面歌词字号" title={`字号：${settings.fontSize}`} aria-expanded={activeSettingsPanel === 'size'} aria-controls="desktop-lyrics-size-panel" disabled={settingsDisabled} onClick={() => openSettingsPanel('size')}><ALargeSmall size={18} /></button>
          <button ref={element => { settingsButtons.current.color = element }} className="desktop-settings-trigger" aria-label="设置桌面歌词颜色" title={`颜色：${DESKTOP_LYRICS_COLOR_OPTIONS.find(option => option.value === settings.color)?.label}`} aria-expanded={activeSettingsPanel === 'color'} aria-controls="desktop-lyrics-color-panel" disabled={settingsDisabled} onClick={() => openSettingsPanel('color')}><Palette size={18} /></button>
          <button ref={element => { settingsButtons.current.opacity = element }} className="desktop-settings-trigger" aria-label="设置桌面歌词透明度" title={`透明度：${Math.round(settings.opacity * 100)}%`} aria-expanded={activeSettingsPanel === 'opacity'} aria-controls="desktop-lyrics-opacity-panel" disabled={settingsDisabled} onClick={() => openSettingsPanel('opacity')}><Eye size={18} /></button>
        </div>
        <div id="desktop-lyrics-font-panel" className="desktop-settings-panel desktop-font-panel" role="group" aria-label="桌面歌词字体" hidden={activeSettingsPanel !== 'font' || !settingsExpanded}>
          <button className="desktop-settings-back" aria-label="返回桌面歌词设置" title="返回" onClick={() => closeSettingsPanel(toolbarKeyboardFocus.current)}><ChevronLeft size={18} /></button>
          {DESKTOP_LYRICS_FONT_OPTIONS.map(option => <button className="desktop-font-option" key={option.value} aria-label={`歌词字体：${option.label}`} title={option.label} aria-pressed={settings.font === option.value} disabled={settingsDisabled || settings.style === 'minecraft'} onClick={() => void changeSettings({ font: option.value })}><span style={{ fontFamily: option.fontFamily }} aria-hidden="true">字</span></button>)}
        </div>
        <div id="desktop-lyrics-size-panel" className="desktop-settings-panel desktop-step-panel" role="group" aria-label="桌面歌词字号" hidden={activeSettingsPanel !== 'size' || !settingsExpanded}>
          <button className="desktop-settings-back" aria-label="返回桌面歌词设置" title="返回" onClick={() => closeSettingsPanel(toolbarKeyboardFocus.current)}><ChevronLeft size={18} /></button>
          <button aria-label="缩小桌面歌词字号" title="缩小字号" disabled={settingsDisabled || settings.fontSize <= 24} onClick={() => void changeSettings({ fontSize: Math.max(24, settings.fontSize - 2) })}><Minus size={16} /></button>
          <output aria-label="桌面歌词字号" title="歌词字号">{settings.fontSize}</output>
          <button aria-label="放大桌面歌词字号" title="放大字号" disabled={settingsDisabled || settings.fontSize >= 56} onClick={() => void changeSettings({ fontSize: Math.min(56, settings.fontSize + 2) })}><Plus size={16} /></button>
        </div>
        <div id="desktop-lyrics-color-panel" className="desktop-settings-panel desktop-color-panel" role="group" aria-label="桌面歌词颜色" hidden={activeSettingsPanel !== 'color' || !settingsExpanded}>
          <button className="desktop-settings-back" aria-label="返回桌面歌词设置" title="返回" onClick={() => closeSettingsPanel(toolbarKeyboardFocus.current)}><ChevronLeft size={18} /></button>
          {DESKTOP_LYRICS_COLOR_OPTIONS.map(option => <button key={option.value} aria-label={`歌词颜色：${option.label}`} title={option.label} aria-pressed={settings.color === option.value} disabled={settingsDisabled} onClick={() => void changeSettings({ color: option.value })}><span className="desktop-color-swatch" style={{ backgroundColor: option.color }} /></button>)}
        </div>
        <div id="desktop-lyrics-opacity-panel" className="desktop-settings-panel desktop-step-panel" role="group" aria-label="桌面歌词透明度" hidden={activeSettingsPanel !== 'opacity' || !settingsExpanded}>
          <button className="desktop-settings-back" aria-label="返回桌面歌词设置" title="返回" onClick={() => closeSettingsPanel(toolbarKeyboardFocus.current)}><ChevronLeft size={18} /></button>
          <button aria-label="降低桌面歌词透明度" title="降低透明度" disabled={settingsDisabled || settings.opacity <= .3} onClick={() => void changeSettings({ opacity: Math.max(.3, Number((settings.opacity - .05).toFixed(2))) })}><Minus size={16} /></button>
          <output aria-label="桌面歌词透明度" title="歌词透明度">{Math.round(settings.opacity * 100)}%</output>
          <button aria-label="提高桌面歌词透明度" title="提高透明度" disabled={settingsDisabled || settings.opacity >= 1} onClick={() => void changeSettings({ opacity: Math.min(1, Number((settings.opacity + .05).toFixed(2))) })}><Plus size={16} /></button>
        </div>
      </div>
      <button className="desktop-lyrics-lock" aria-label={settings.locked ? '解锁桌面歌词' : '锁定桌面歌词'} title={settings.locked ? '解锁后可移动歌词窗口' : '锁定后禁止移动歌词窗口'} aria-pressed={settings.locked} disabled={busy || !api} onClick={() => void changeSettings({ locked: !settings.locked })}>{settings.locked ? <Lock size={18} /> : <Unlock size={18} />}</button>
      <button className="desktop-lyrics-close" aria-label="关闭桌面歌词" title="关闭桌面歌词" disabled={busy || !api} onClick={() => void close()}><X size={18} /></button>
    </div>
    <section className={`desktop-lyrics-copy ${hasCurrent ? '' : 'is-placeholder'}`} aria-label={hasCurrent ? '同步歌词' : '歌词状态'}>
      <div className="desktop-current-area" ref={currentFit.area}><p ref={currentFit.line} className="desktop-lyric-current" style={{ fontSize: currentMaximum }} title={current}>{current}</p></div>
      <div className="desktop-next-area" ref={nextFit.area}><p ref={nextFit.line} className="desktop-lyric-next" style={{ fontSize: nextMaximum }} title={next}>{next || '\u00a0'}</p></div>
    </section>
    <div className="desktop-lyrics-caption">{content.title ? <><span className={`desktop-playing-dot ${content.playing ? 'is-playing' : ''}`} title={content.playing ? '播放中' : '已暂停'} /><span className="desktop-song-title" title={content.title}>{content.title}</span>{!content.playing && <span className="desktop-paused-label">已暂停</span>}</> : <span>open音乐 · 留住每一句喜欢</span>}</div>
    {error && <p className="desktop-lyrics-status" role="status" title={error}>{shortError(error)}</p>}
  </main>
}
