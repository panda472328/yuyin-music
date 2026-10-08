import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react'
import packageInfo from '../package.json'
import type { UpdateState } from './shared/update'
import { api, isDesktop } from './api'

type UpdateAction = 'check' | 'download' | 'install' | 'release'
interface UpdateContextValue {
  state: UpdateState | null
  pending: UpdateAction | null
  failure: string | null
  run: (action: UpdateAction) => Promise<void>
  bannerBlocked: boolean
  setBannerBlocked: (blocked: boolean) => void
}
const UpdateContext = createContext<UpdateContextValue | null>(null)
export function useUpdates() {
  const context = useContext(UpdateContext)
  if (!context) throw new Error('更新界面未初始化。')
  return context
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null)
  const [pending, setPending] = useState<UpdateAction | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [bannerBlocked, setBannerBlocked] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    mounted.current = true
    if (!isDesktop) return () => { mounted.current = false }
    const dispose = api.onUpdateState(next => { revision.current++; setState(next); setFailure(null) })
    const initialRevision = revision.current
    void api.getUpdateState().then(next => {
      if (mounted.current && revision.current === initialRevision) setState(next)
    }).catch(() => {})
    return () => { mounted.current = false; dispose() }
  }, [])
  const run = useCallback(async (action: UpdateAction) => {
    if (busy.current) return
    busy.current = true; setPending(action); setFailure(null)
    const operationRevision = revision.current
    try {
      const result = action === 'check' ? await api.checkForUpdates()
        : action === 'download' ? await api.downloadUpdate()
        : action === 'install' ? await api.installUpdate()
        : await api.openUpdateRelease()
      if (mounted.current && result && revision.current === operationRevision) setState(result)
    } catch (error) {
      if (mounted.current) setFailure((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''))
    } finally {
      busy.current = false
      if (mounted.current) setPending(null)
    }
  }, [])
  return <UpdateContext.Provider value={{ state, pending, failure, run, bannerBlocked, setBannerBlocked }}>{children}<UpdateBanner /></UpdateContext.Provider>
}

function updateMessage(state: UpdateState | null) {
  if (!isDesktop) return '更新功能在 Windows 安装版中使用。'
  if (!state) return '正在读取更新状态…'
  switch (state.status) {
    case 'checking': return '正在检查最新版本…'
    case 'up-to-date': return '已经是最新版本。'
    case 'available': return `发现新版本 v${state.manifest?.version ?? ''}，可以选择下载。`
    case 'downloading': return `正在下载安装包${state.progress === null ? '…' : `，${Math.round(state.progress)}%`}`
    case 'downloaded': return '下载完成，安装前会退出播放器。'
    case 'installing': return '正在退出播放器并安装更新…'
    case 'error': return state.error || '暂时无法检查更新，请稍后重试。'
    default: return '启动时自动检查，运行期间每 6 小时检查一次。'
  }
}

function UpdateActions({ check = false }: { check?: boolean }) {
  const { state, pending, run } = useUpdates()
  const busy = pending !== null || state?.status === 'checking' || state?.status === 'downloading' || state?.status === 'installing'
  return <div className="update-actions">
    {state?.manifest && !state.canInstall && <button type="button" className="button-primary" disabled={busy} onClick={() => void run('release')}><ExternalLink size={15} />下载安装版</button>}
    {state?.manifest && state.canInstall && (state.status === 'available' || state.status === 'error') && <button type="button" className="button-primary" disabled={busy} onClick={() => void run('download')}><ArrowDownToLine size={15} />{state.status === 'error' ? '重新下载' : '下载更新'}</button>}
    {state?.canInstall && state.status === 'downloaded' && <button type="button" className="button-primary" disabled={busy} onClick={() => void run('install')}>退出并安装</button>}
    {check && <button type="button" className="button-secondary" disabled={!isDesktop || busy} onClick={() => void run('check')}><RefreshCw size={15} className={state?.status === 'checking' || pending === 'check' ? 'spin' : ''} />{state?.status === 'checking' || pending === 'check' ? '正在检查' : '检查更新'}</button>}
  </div>
}

export function UpdateSettings({ compact = false }: { compact?: boolean }) {
  const { state, failure } = useUpdates()
  const version = state?.currentVersion || packageInfo.version
  return <section className={compact ? 'login-update' : 'settings-panel update-settings'} aria-label="软件更新">
    {!compact && <h2>软件更新</h2>}
    <div className="setting-row update-setting-row"><span><strong>余音 v{version}</strong><small role="status">{updateMessage(state)}</small>{state?.installDisabledReason && <small>{state.installDisabledReason}</small>}</span><UpdateActions check /></div>
    {state?.status === 'downloading' && <progress className="update-progress" aria-label="更新下载进度" max={100} value={state.progress ?? undefined} />}
    {(failure || state?.status === 'error') && <p className="update-error" role="alert">{failure || state?.error}</p>}
    {!compact && <p className="update-hint">自动发现 GitHub 正式新版，由你选择下载和安装。安装后继续使用原来的音乐库与设置。</p>}
  </section>
}

function UpdateBanner() {
  const { state, failure, pending, bannerBlocked, run } = useUpdates()
  const [dismissed, setDismissed] = useState('')
  const key = `${state?.manifest?.version}:${state?.status}`
  const show = state?.manifest && ['available', 'downloading', 'downloaded', 'installing', 'error'].includes(state.status)
  if (!isDesktop || !show || bannerBlocked || dismissed === key) return null
  return <aside className="update-banner" aria-label="新版本更新提示">
    <div className="update-banner-heading"><strong>余音 v{state.manifest!.version}</strong><button className="icon-button" type="button" aria-label="稍后更新" title="稍后更新" onClick={() => setDismissed(key)}><X size={17} /></button></div>
    <p role="status">{updateMessage(state)}</p>
    {state.status === 'available' && state.manifest!.notes && <p className="update-notes">{state.manifest!.notes}</p>}
    {state.installDisabledReason && <p className="update-hint">{state.installDisabledReason}</p>}
    {state.status === 'downloading' && <progress className="update-progress" aria-label="更新下载进度" max={100} value={state.progress ?? undefined} />}
    {failure && <p className="update-error" role="alert">{failure}</p>}
    <div className="update-banner-footer">{pending && <LoaderCircle className="spin" size={15} />}<UpdateActions />{state.manifest && <button className="text-button" type="button" disabled={pending !== null} onClick={() => void run('release')}>更新说明<ExternalLink size={13} /></button>}</div>
  </aside>
}
