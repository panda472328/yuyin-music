import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountSession, type AccountSessionState } from '../src/bilibili-account-session'
import type { BilibiliAccountStatus } from '../electron/types'

const loggedIn: BilibiliAccountStatus = { loggedIn: true, account: { mid: 42, username: '测试听众', avatar: 'https://i0.hdslb.com/bfs/face/avatar.png' } }
const loggedOut: BilibiliAccountStatus = { loggedIn: false, account: null }
const guest: BilibiliAccountStatus = { loggedIn: false, account: null, guest: true }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('an initial connection failure stays unverified and retry can authenticate', async () => {
  const states: AccountSessionState[] = []
  let calls = 0
  const session = new AccountSession({
    getAccount: async () => { if (calls++ === 0) throw new Error('网络暂时不可用'); return loggedIn },
    continueAsGuest: async () => guest,
    pause: async () => {}, onState: state => states.push(state),
  })
  await session.check()
  assert.equal(states.at(-1)?.phase, 'unverified')
  assert.equal(states.at(-1)?.error, '网络暂时不可用')
  assert.equal(states.at(-1)?.checking, false)
  await session.check()
  assert.equal(states.at(-1)?.account?.mid, 42)
  assert.equal(states.at(-1)?.error, null)
  session.dispose()
})

test('network errors preserve a confirmed account; confirmed logout waits for playback pause', async () => {
  const states: AccountSessionState[] = []
  let response: BilibiliAccountStatus | Error = loggedIn
  const paused = deferred<void>()
  let pauseCalls = 0
  const session = new AccountSession({
    getAccount: async () => { if (response instanceof Error) throw response; return response },
    continueAsGuest: async () => guest,
    pause: () => { pauseCalls++; return paused.promise }, onState: state => states.push(state),
  })
  await session.check()
  response = new Error('验证服务连接失败')
  await session.check()
  assert.equal(states.at(-1)?.phase, 'loggedIn')
  assert.equal(states.at(-1)?.account?.mid, 42)
  response = loggedOut
  const check = session.check()
  await turn()
  assert.equal(pauseCalls, 1)
  assert.equal(states.at(-1)?.phase, 'loggedIn', 'Playback pause precedes exposing the anonymous session')
  paused.resolve()
  await check
  assert.equal(states.at(-1)?.phase, 'loggedOut')
  assert.equal(states.at(-1)?.expired, true)
  assert.equal(states.at(-1)?.account, null)
  session.dispose()
})

test('a response started before cookie changes never opens the app, and events coalesce into one fresh check', async () => {
  const first = deferred<BilibiliAccountStatus>()
  const second = deferred<BilibiliAccountStatus>()
  const states: AccountSessionState[] = []
  let calls = 0
  const session = new AccountSession({
    getAccount: () => ++calls === 1 ? first.promise : second.promise,
    continueAsGuest: async () => guest,
    pause: async () => {}, onState: state => states.push(state),
  })
  const pending = session.check()
  void session.check(true)
  void session.check(true)
  void session.check()
  assert.equal(calls, 1)
  first.resolve(loggedIn)
  await pending
  await turn()
  assert.equal(calls, 2)
  assert.ok(states.every(state => state.phase === 'unverified'))
  second.resolve(loggedOut)
  await turn()
  assert.equal(states.at(-1)?.phase, 'loggedOut')
  session.dispose()
})

test('disposing a StrictMode controller prevents late check results and queued reruns reaching the new UI', async () => {
  const response = deferred<BilibiliAccountStatus>()
  const states: AccountSessionState[] = []
  let calls = 0
  const session = new AccountSession({
    getAccount: () => { calls++; return response.promise }, continueAsGuest: async () => guest, pause: async () => {}, onState: state => states.push(state),
  })
  const pending = session.check()
  void session.check(true)
  session.dispose()
  const count = states.length
  response.resolve(loggedIn)
  await pending
  await turn()
  assert.equal(states.length, count)
  assert.equal(calls, 1)
})

test('explicit guest entry survives an older signed-out result and creates no fake account', async () => {
  const response = deferred<BilibiliAccountStatus>()
  const states: AccountSessionState[] = []
  let pauseCalls = 0
  const session = new AccountSession({
    getAccount: () => response.promise, continueAsGuest: async () => guest,
    pause: async () => { pauseCalls++ }, onState: state => states.push(state),
  })
  const pending = session.check()
  await session.continueAsGuest()
  assert.equal(states.at(-1)?.phase, 'guest')
  assert.equal(states.at(-1)?.account, null)
  response.resolve(loggedOut)
  await pending
  assert.equal(states.at(-1)?.phase, 'guest', 'The check preceding explicit guest entry cannot close the music UI')
  assert.equal(states.at(-1)?.checking, false)
  assert.equal(pauseCalls, 0)
  session.dispose()
})

test('guest refresh and connection failure preserve anonymous playback; login upgrades to a real account', async () => {
  const states: AccountSessionState[] = []
  let response: BilibiliAccountStatus | Error = guest
  let pauseCalls = 0
  const session = new AccountSession({
    getAccount: async () => { if (response instanceof Error) throw response; return response },
    continueAsGuest: async () => guest, pause: async () => { pauseCalls++ }, onState: state => states.push(state),
  })
  await session.continueAsGuest()
  await session.check(true)
  assert.equal(states.at(-1)?.phase, 'guest')
  response = new Error('网络暂时不可用')
  await session.check()
  assert.equal(states.at(-1)?.phase, 'guest')
  assert.equal(states.at(-1)?.account, null)
  assert.equal(pauseCalls, 0)
  response = loggedIn
  await session.check(true)
  assert.equal(states.at(-1)?.phase, 'loggedIn')
  assert.equal(states.at(-1)?.account?.mid, 42)
  assert.equal(states.at(-1)?.error, null)
  assert.equal(pauseCalls, 0)
  response = guest
  await session.check(true)
  assert.equal(states.at(-1)?.phase, 'guest')
  assert.equal(states.at(-1)?.expired, true)
  assert.equal(states.at(-1)?.account, null)
  assert.equal(pauseCalls, 1, 'Identity expiry pauses old account playback while keeping guest access')
  session.dispose()
})

test('guest command failures remain visible and a subsequent command may retry', async () => {
  const states: AccountSessionState[] = []
  let calls = 0
  const session = new AccountSession({
    getAccount: async () => loggedOut,
    continueAsGuest: async () => { if (calls++ === 0) throw new Error('游客进入失败'); return guest },
    pause: async () => {}, onState: state => states.push(state),
  })
  await session.check()
  await session.continueAsGuest()
  assert.equal(states.at(-1)?.phase, 'loggedOut')
  assert.equal(states.at(-1)?.error, '游客进入失败')
  assert.equal(states.at(-1)?.checking, false)
  await session.continueAsGuest()
  assert.equal(states.at(-1)?.phase, 'guest')
  assert.equal(states.at(-1)?.error, null)
  session.dispose()
})

test('guest commands coalesce and cookie changes schedule an authoritative follow-up', async () => {
  const guestResponse = deferred<BilibiliAccountStatus>()
  const states: AccountSessionState[] = []
  let guestCalls = 0
  let checks = 0
  const session = new AccountSession({
    getAccount: async () => { checks++; return loggedIn },
    continueAsGuest: () => { guestCalls++; return guestResponse.promise },
    pause: async () => {}, onState: state => states.push(state),
  })
  const pending = session.continueAsGuest()
  assert.equal(session.continueAsGuest(), pending)
  void session.check(true)
  guestResponse.resolve(guest)
  await pending
  await turn()
  assert.equal(guestCalls, 1)
  assert.equal(checks, 1)
  assert.equal(states.at(-1)?.phase, 'loggedIn')
  assert.ok(!states.some(state => state.phase === 'guest'), 'A cookie change invalidates the earlier guest response')
  session.dispose()
})

test('disposing prevents late guest commands from opening a replacement UI', async () => {
  const response = deferred<BilibiliAccountStatus>()
  const states: AccountSessionState[] = []
  const session = new AccountSession({
    getAccount: async () => loggedOut, continueAsGuest: () => response.promise,
    pause: async () => {}, onState: state => states.push(state),
  })
  const pending = session.continueAsGuest()
  session.dispose()
  const count = states.length
  response.resolve(guest)
  await pending
  assert.equal(states.length, count)
})


test('overlapping startup checks and guest entry retain a queued cookie refresh until both complete', async () => {
  const oldAccount = deferred<BilibiliAccountStatus>()
  const guestResponse = deferred<BilibiliAccountStatus>()
  const states: AccountSessionState[] = []
  let checks = 0
  const session = new AccountSession({
    getAccount: () => ++checks === 1 ? oldAccount.promise : Promise.resolve(loggedIn),
    continueAsGuest: () => guestResponse.promise, pause: async () => {}, onState: state => states.push(state),
  })
  const check = session.check()
  const entering = session.continueAsGuest()
  void session.check(true)
  guestResponse.resolve(guest)
  await entering
  assert.equal(checks, 1)
  oldAccount.resolve(loggedOut)
  await check
  await turn()
  assert.equal(checks, 2)
  assert.equal(states.at(-1)?.phase, 'loggedIn')
  assert.equal(states.at(-1)?.checking, false)
  assert.ok(!states.some(state => state.phase === 'guest' || state.phase === 'loggedOut'))
  session.dispose()
})
