import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, ExternalLink, Headphones, LoaderCircle, RefreshCw, Settings2, ShieldCheck, UserRound, X } from 'lucide-react'
import type { BilibiliAccount } from '../electron/types'
import { api } from './api'
import type { useBilibiliAccount } from './useBilibiliAccount'
import { UpdateSettings } from './Updates'

type AccountState = ReturnType<typeof useBilibiliAccount>

export function BilibiliLoginGate({ session }: { session: AccountState }) {
  const checking = session.phase === 'unverified' && session.checking
  const failedInitialCheck = session.phase === 'unverified' && Boolean(session.error)
  return <div className="login-shell">
    <header className="login-titlebar"><div className="brand"><span className="brand-icon"><AudioLines size={25} /></span><span>余音<small>YUYIN MUSIC</small></span></div><button className="icon-button login-close" aria-label="关闭程序" title="关闭程序" onClick={() => api.close()}><X size={19} /></button></header>
    <main className="login-layout" aria-label="Bilibili 登录验证">
      <section className="login-intro"><div className="eyebrow">YOUR MUSIC, YOUR SPACE</div><h1>熟悉的声音，<br />从这里开始<span className="heading-dot">.</span></h1><p>连接你的 Bilibili 账号，<br />把喜欢的旋律，留在自己的音乐空间。</p><div className="login-illustration" aria-hidden="true"><div className="login-orbit" /><div className="login-disc"><div className="login-disc-center"><AudioLines size={34} /><span>GOOD VIBES</span></div></div><span className="login-note login-note-one">♪</span><span className="login-note login-note-two">♫</span><span className="login-art-caption">A LITTLE MUSIC, A BETTER DAY.</span></div></section>
      <section className="login-card"><div className="login-card-icon">{checking ? <LoaderCircle className="spin" size={26} /> : <Headphones size={26} strokeWidth={1.6} />}</div><span className="login-card-kicker">BILIBILI ACCOUNT</span><h2>{checking ? '正在验证登录状态' : failedInitialCheck ? '暂时无法验证账号' : session.expired ? '请重新登录 Bilibili' : '登录 Bilibili'}</h2><p className="login-description">{checking ? '正在检查本机保存的 Bilibili 会话，请稍候。' : failedInitialCheck ? '可以重新检查账号，或暂不登录进入听歌。' : session.expired ? '当前登录状态已失效。可重新登录，也可暂不登录；音乐库和听歌设置会继续保留。' : '在 Bilibili 官方窗口完成登录，可导入账号收藏夹；也可以暂不登录，直接进入听歌。'}</p>
        <div className="login-actions"><button className="button-primary" aria-label="去 Bilibili 登录" onClick={() => void session.openLogin()} disabled={session.openingLogin || checking}>{session.openingLogin ? <LoaderCircle size={17} className="spin" /> : <ExternalLink size={17} />} {session.openingLogin ? '正在打开登录窗口' : session.watchingLogin ? '继续 Bilibili 登录' : '去 Bilibili 登录'}<ArrowRight size={16} /></button><button className="button-secondary" onClick={session.refresh} disabled={session.checking}><RefreshCw size={15} className={session.checking ? 'spin' : ''} />{session.checking ? '正在检查' : failedInitialCheck ? '重新检查登录状态' : '我已登录，重新检查'}</button></div>
        <button className="text-button login-guest" type="button" aria-label="暂不登录，先听歌" onClick={() => void session.continueAsGuest()} disabled={session.enteringGuest}>{session.enteringGuest ? <LoaderCircle size={15} className="spin" /> : <Headphones size={15} />}{session.enteringGuest ? '正在进入' : '暂不登录，先听歌'}<ArrowRight size={14} /></button>
        {session.watchingLogin && !session.error && <div className="login-watch" role="status"><span />等待登录完成，完成后会自动进入</div>}
        {session.error && <div className="login-error" role="alert">{session.error}</div>}
        <div className="login-privacy"><ShieldCheck size={16} /><span>登录在 Bilibili 官方页面完成<small>会话保存在本机，无需每次重新登录</small></span></div>
        <UpdateSettings compact />
      </section>
    </main><footer className="login-footer"><AudioLines size={14} />让音乐有自己的归处</footer>
  </div>
}

export function BilibiliAccountMenu({ account, checking, error, openingLogin, onRefresh, onLogin, onFavorites, onSettings, onError }: {
  account: BilibiliAccount
  checking: boolean
  error: string | null
  openingLogin: boolean
  onRefresh: () => void
  onLogin: () => Promise<void>
  onFavorites: () => void
  onSettings: () => void
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const hoverSuppressed = useRef(false)
  useEffect(() => setImageFailed(false), [account.avatar])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  function close() { setOpen(false) }
  function choose(action: () => void) { close(); action() }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      hoverSuppressed.current = true
      close()
      trigger.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setOpen(true)
    requestAnimationFrame(() => {
      const items = [...(anchor.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      const index = items.findIndex(item => item === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' || index < 0 && event.key === 'ArrowUp' ? items.length - 1 : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : (index + 1) % items.length
      items[next]?.focus()
    })
  }

  return <div className="account-menu-anchor" ref={anchor} onMouseEnter={() => { hoverSuppressed.current = false; setOpen(true) }} onMouseLeave={() => { hoverSuppressed.current = false; if (!anchor.current?.contains(document.activeElement)) close() }} onFocus={() => { if (!hoverSuppressed.current) setOpen(true) }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close() }} onKeyDown={keyDown}>
    <button ref={trigger} className={`account-trigger ${open ? 'expanded' : ''}`} type="button" aria-label={`Bilibili 账号：${account.username}`} aria-haspopup="menu" aria-expanded={open} aria-controls="bilibili-account-menu" title={account.username} onClick={() => { hoverSuppressed.current = false; setOpen(true) }}><span className="account-avatar">{account.avatar && !imageFailed ? <img src={account.avatar} alt={`${account.username}的 Bilibili 头像`} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <span>{Array.from(account.username.trim())[0] || '哔'}</span>}</span><ChevronDown size={12} /></button>
    {open && <div className="account-menu-position"><section className="account-menu" role="menu" id="bilibili-account-menu" aria-label="Bilibili 账号菜单"><div className="account-menu-header"><strong>{account.username}</strong><span><Check size={12} />已登录 Bilibili</span></div><button role="menuitem" onClick={() => choose(() => { void api.openBilibiliProfile().catch(failure => onError(failure instanceof Error ? failure.message : String(failure))) })}><UserRound size={16} /><span>个人空间</span><ExternalLink size={12} /></button><button role="menuitem" onClick={() => choose(onFavorites)}><ArrowDownToLine size={16} /><span>Bilibili 收藏夹</span></button><button role="menuitem" onClick={() => choose(onSettings)}><Settings2 size={16} /><span>听歌设置</span></button><div className="account-menu-divider" /><button role="menuitem" disabled={openingLogin} onClick={() => choose(() => { void onLogin() })}><ExternalLink size={16} /><span>{openingLogin ? '正在打开' : '切换 / 管理账号'}</span></button><button role="menuitem" disabled={checking} onClick={() => choose(onRefresh)}><RefreshCw size={15} className={checking ? 'spin' : ''} /><span>{checking ? '正在检查账号' : '刷新账号状态'}</span></button>{error && <div className="account-menu-error" role="alert">暂时无法验证账号，请稍后重试。</div>}</section></div>}
  </div>
}
