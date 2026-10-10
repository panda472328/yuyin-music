import type { BilibiliAccount, BilibiliAccountStatus } from '../electron/types'

export interface AccountSessionState {
  phase: 'unverified' | 'loggedOut' | 'guest' | 'loggedIn'
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
  private guestRequest: Promise<void> | null = null
  private repeat = false
  private wasLoggedIn = false

  constructor(private readonly options: {
    getAccount: () => Promise<BilibiliAccountStatus>
    continueAsGuest: () => Promise<BilibiliAccountStatus>
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
    if (this.guestRequest) {
      if (invalidate) this.repeat = true
      return this.guestRequest
    }
    if (this.running) {
      // A timer need not schedule another check when the current one is still running.
      if (invalidate) this.repeat = true
      return this.running
    }
    const revision = this.revision
    this.running = this.perform(revision).finally(() => {
      this.running = null
      this.finishRequest()
    })
    return this.running
  }

  private finishRequest() {
    if (!this.active || this.running || this.guestRequest) return
    if (this.repeat) {
      this.repeat = false
      void this.check()
    } else this.publish({ checking: false })
  }

  continueAsGuest(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.guestRequest) return this.guestRequest
    const revision = ++this.revision
    this.repeat = false
    this.publish({ checking: true, error: null })
    this.guestRequest = this.options.continueAsGuest().then(result => this.applyResult(result, revision)).catch(error => {
      if (this.active && revision === this.revision) this.publish({ error: readableError(error) })
    }).finally(() => {
      this.guestRequest = null
      this.finishRequest()
    })
    return this.guestRequest
  }

  private async applyResult(result: BilibiliAccountStatus, revision: number) {
    if (!this.active || revision !== this.revision) return
    if (result.loggedIn) {
      this.wasLoggedIn = true
      this.publish({ phase: 'loggedIn', account: result.account, expired: false, error: null })
      return
    }
    // Identity loss still pauses the old account's playback; an existing guest
    // session remains mounted and can start anonymous playback afterwards.
    let pauseError: string | null = null
    if (this.state.account) {
      try { await this.options.pause() }
      catch (error) { pauseError = readableError(error) }
    }
    if (!this.active || revision !== this.revision) return
    this.publish({ phase: result.guest ? 'guest' : 'loggedOut', account: null, expired: this.wasLoggedIn, error: pauseError })
  }

  private async perform(revision: number) {
    this.publish({ checking: true })
    try {
      const result = await this.options.getAccount()
      await this.applyResult(result, revision)
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
