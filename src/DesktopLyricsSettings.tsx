import type { CSSProperties } from 'react'
import { DESKTOP_LYRICS_COLOR_OPTIONS, DESKTOP_LYRICS_FONT_OPTIONS } from '../electron/desktop-lyrics-types'
import type { useDesktopLyrics } from './useDesktopLyrics'
import LyricStylePicker from './LyricStylePicker'
import { PIXEL_FONT_FAMILY } from './shared/lyric-styles'

export default function DesktopLyricsSettings({ desktop }: { desktop: ReturnType<typeof useDesktopLyrics> }) {
  const { settings, busy, available, updateSettings } = desktop
  return <div className="settings-panel desktop-lyrics-settings">
    <h2>桌面歌词</h2>
    <p className="appearance-description">独立选择桌面上的歌词外观，保留你习惯的字体、颜色和透明度。</p>
    <LyricStylePicker desktop value={settings.style} label="桌面歌词样式" disabled={busy || !available} onChange={style => void updateSettings({ style })} />
    <div className="setting-row"><span><strong>显示桌面歌词</strong><small>置顶显示当前句和下一句，最小化播放器后继续跟随。{!available && '请在桌面客户端中使用。'}</small></span><button role="switch" aria-checked={settings.enabled} aria-label="显示桌面歌词" className={`switch ${settings.enabled ? 'on' : ''}`} disabled={busy || !available} onClick={() => void updateSettings({ enabled: !settings.enabled })}><span /></button></div>
    <div className="setting-row"><span><strong>字体款式</strong><small>{settings.style === 'minecraft' ? '我的世界使用内置像素字体；切换其他外观后恢复原字体。' : '选择喜欢的文字风格，使用电脑本机字体。'}</small></span><select aria-label="桌面歌词字体" value={settings.style === 'minecraft' ? 'pixel' : settings.font} disabled={busy || !available || settings.style === 'minecraft'} onChange={event => void updateSettings({ font: event.target.value as typeof settings.font })}>{settings.style === 'minecraft' && <option value="pixel">像素字体</option>}{DESKTOP_LYRICS_FONT_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></div>
    <div className="setting-row"><span><strong>字体大小</strong><small>较长的句子会自动调整到窗口内。</small></span><div className="desktop-lyrics-size"><input type="range" aria-label="桌面歌词字号" min="24" max="56" step="2" value={settings.fontSize} disabled={!available || busy} onChange={event => void updateSettings({ fontSize: Number(event.target.value) })} /><output>{settings.fontSize}px</output></div></div>
    <div className="setting-row"><span><strong>文字颜色</strong><small>带描边和阴影，在浅色与深色桌面上都清晰。</small></span><select aria-label="桌面歌词颜色" value={settings.color} disabled={busy || !available} onChange={event => void updateSettings({ color: event.target.value as typeof settings.color })}>{DESKTOP_LYRICS_COLOR_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></div>
    <div className="desktop-style-sample" data-lyric-style={settings.style} style={{ fontFamily: settings.style === 'minecraft' ? PIXEL_FONT_FAMILY : DESKTOP_LYRICS_FONT_OPTIONS.find(option => option.value === settings.font)?.fontFamily, '--sample-color': DESKTOP_LYRICS_COLOR_OPTIONS.find(option => option.value === settings.color)?.color } as CSSProperties}><span>桌面效果预览 · 当前字体与颜色</span><p>把喜欢的声音，留在身边。</p></div>
    <p className="desktop-lyrics-setting-note">在这里选择外观，桌面工具栏可调整字体、字号、颜色与透明度。拖动歌词、空白或工具栏左侧可移动位置；外观与位置自动保存。</p>
    {desktop.error && <p className="desktop-lyrics-setting-error" role="status">{desktop.error}</p>}
  </div>
}
