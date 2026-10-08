import type { BilibiliAccount, BilibiliAccountStatus } from '../electron/types'

export interface AccountSessionState {
  phase: 'unverified' | 'loggedOut' | 'loggedIn'
  account: BilibiliAccount | null
  checking: boolean
  expired: boolean
  error: string | null
}

export const initialAccountSession: AccountSessionState = {
  phase: 'unverified', account: null, checking: true, expired: false, error: null,
}

const readableError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')

/** Serializes checks and discards responses made before a cookie/focus change. */
export class AccountSession {
  private state: AccountSessionState = { ...initialAccountSession }
  private active = true
  private revision = 0
  private running: Promise<void> | null = null
  private repeat = false
  private wasLoggedIn = false

  constructor(private readonly options: {
    getAccount: () => Promise<BilibiliAccountStatus>
    pause: () => Promise<unknown>
    onState: (state: AccountSessionState) => void
  }) {}

  private publish(patch: Partial<AccountSessionState>) {
    if (!this.active) return
    this.state = { ...this.state, ...patch }
    this.options.onState(this.state)
  }

  check(invalidate = false): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (invalidate) this.revision++
    if (this.running) {
      // A timer need not schedule another check when the current one is still running.
      if (invalidate) this.repeat = true
      return this.running
    }
    const revision = this.revision
    this.running = this.perform(revision).finally(() => {
      this.running = null
      if (!this.active) return
      if (this.repeat) {
        this.repeat = false
        void this.check()
      } else this.publish({ checking: false })
    })
    return this.running
  }

  private async perform(revision: number) {
    this.publish({ checking: true })
    try {
      const result = await this.options.getAccount()
      if (!this.active || revision !== this.revision) return
      if (result.loggedIn) {
        this.wasLoggedIn = true
        this.publish({ phase: 'loggedIn', account: result.account, expired: false, error: null })
      } else {
        // The main process also pauses on an identity change. Await this renderer
        // fallback before unmounting playback so a lost session never keeps playing.
        let pauseError: string | null = null
        if (this.state.account) {
          try { await this.options.pause() }
          catch (error) { pauseError = readableError(error) }
        }
        if (!this.active || revision !== this.revision) return
        this.publish({ phase: 'loggedOut', account: null, expired: this.wasLoggedIn, error: pauseError })
      }
    } catch (error) {
      if (!this.active || revision !== this.revision) return
      // A failed network check provides no evidence that an existing session ended.
      this.publish({ error: readableError(error) })
    }
  }

  dispose() {
    this.active = false
    this.revision++
    this.repeat = false
  }
}
