import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AccountSession, initialAccountSession } from './bilibili-account-session'

export function useBilibiliAccount() {
  const [session, setSession] = useState(initialAccountSession)
  const [openingLogin, setOpeningLogin] = useState(false)
  const [enteringGuest, setEnteringGuest] = useState(false)
  const [watchingLogin, setWatchingLogin] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const controller = useRef<AccountSession | null>(null)
  const loginOpening = useRef<Promise<void> | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    const current = new AccountSession({ getAccount: () => api.getBilibiliAccount(), continueAsGuest: () => api.continueAsGuest(), pause: () => api.pause(), onState: setSession })
    controller.current = current
    const unsubscribe = api.onBilibiliSessionChanged(() => { void current.check(true) })
    const focus = () => { void current.check(true) }
    window.addEventListener('focus', focus)
    void current.check()
    return () => {
      mounted.current = false
      unsubscribe()
      window.removeEventListener('focus', focus)
      current.dispose()
      if (controller.current === current) controller.current = null
    }
  }, [])

  useEffect(() => {
    if (session.phase === 'loggedIn') setWatchingLogin(false)
  }, [session.phase, session.account])

  useEffect(() => {
    // Poll quickly while the official login window is in use; otherwise keep a
    // light periodic check for server-side expiry while playback remains open.
    if (!watchingLogin && session.phase !== 'loggedIn' && session.phase !== 'guest') return
    const interval = setInterval(() => { void controller.current?.check() }, watchingLogin ? 2500 : 60_000)
    return () => clearInterval(interval)
  }, [watchingLogin, session.phase])

  const refresh = useCallback(() => {
    setLoginError(null)
    void controller.current?.check(true)
  }, [])

  const continueAsGuest = useCallback(async () => {
    if (!controller.current) return
    setEnteringGuest(true)
    setLoginError(null)
    try { await controller.current.continueAsGuest() }
    finally { if (mounted.current) setEnteringGuest(false) }
  }, [])

  const openLogin = useCallback(async () => {
    if (loginOpening.current) return loginOpening.current
    setOpeningLogin(true)
    setLoginError(null)
    const operation = api.login().then(() => {
      if (!mounted.current) return
      setWatchingLogin(true)
      void controller.current?.check(true)
    }).catch(error => {
      if (mounted.current) setLoginError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''))
    }).finally(() => {
      loginOpening.current = null
      if (mounted.current) setOpeningLogin(false)
    })
    loginOpening.current = operation
    return operation
  }, [])

  return { ...session, error: loginError || session.error, openingLogin, watchingLogin, enteringGuest, refresh, openLogin, continueAsGuest }
}
