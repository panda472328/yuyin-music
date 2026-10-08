import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountSession, type AccountSessionState } from '../src/bilibili-account-session'
import type { BilibiliAccountStatus } from '../electron/types'

const loggedIn: BilibiliAccountStatus = { loggedIn: true, account: { mid: 42, username: '测试听众', avatar: 'https://i0.hdslb.com/bfs/face/avatar.png' } }
const loggedOut: BilibiliAccountStatus = { loggedIn: false, account: null }
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
  assert.equal(states.at(-1)?.phase, 'loggedIn', 'Playback pause precedes tearing down the music UI')
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
    getAccount: () => { calls++; return response.promise }, pause: async () => {}, onState: state => states.push(state),
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
