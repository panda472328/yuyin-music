import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliAccountSession, BilibiliError, isAuthenticationCookie, parseBilibiliAccountStatus, safeAccountAvatar } from '../electron/account';

const nav = (mid = 101, username = '测试账号') => ({ code: 0, data: { isLogin: true, mid, uname: username, face: '//i0.hdslb.com/bfs/face/avatar.jpg' } });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
};

test('official nav login fields produce only public account identity', () => {
  const result = parseBilibiliAccountStatus({ ...nav(), session: 'not-for-renderer', cookie: 'not-for-renderer' });
  assert.deepEqual(result, { loggedIn: true, account: { mid: 101, username: '测试账号', avatar: 'https://i0.hdslb.com/bfs/face/avatar.jpg' } });
  assert.deepEqual(parseBilibiliAccountStatus({ code: -101 }), { loggedIn: false, account: null });
  assert.deepEqual(parseBilibiliAccountStatus({ code: 0, data: { isLogin: false } }), { loggedIn: false, account: null });
});

test('malformed nav or a verification response is not classified as logged out', () => {
  for (const payload of [null, {}, { code: '0' }, { code: 0 }, { code: 0, data: { isLogin: true, mid: 0, uname: 'x' } },
    { code: 0, data: { isLogin: true, mid: 1.5, uname: 'x' } }, { code: 0, data: { isLogin: true, mid: 1, uname: '' } }]) {
    assert.throws(() => parseBilibiliAccountStatus(payload), error => error instanceof BilibiliError && error.code === 'BILIBILI_INVALID_RESPONSE');
  }
  assert.throws(() => parseBilibiliAccountStatus({ code: -352, data: { isLogin: false } }),
    error => error instanceof BilibiliError && error.requiresVerification && error.code === 'BILIBILI_VERIFICATION_REQUIRED');
  assert.throws(() => parseBilibiliAccountStatus({ code: -500, data: { isLogin: false } }),
    error => error instanceof BilibiliError && error.code === 'BILIBILI_API_ERROR');
});

test('avatars accept only HTTPS Bilibili/CDN hosts without credentials or custom ports', () => {
  assert.equal(safeAccountAvatar('//i0.hdslb.com/avatar.png'), 'https://i0.hdslb.com/avatar.png');
  assert.equal(safeAccountAvatar('https://www.bilibili.com/avatar.png'), 'https://www.bilibili.com/avatar.png');
  for (const url of ['http://i0.hdslb.com/avatar.png', 'https://hdslb.com.evil.test/avatar.png',
    'https://bilibili.com@evil.test/avatar.png', 'https://user@i0.hdslb.com/avatar.png',
    'https://i0.hdslb.com:8443/avatar.png', 'file:///avatar.png', 'data:image/png,abc', 'invalid']) assert.equal(safeAccountAvatar(url), '');
  assert.equal(parseBilibiliAccountStatus({ code: 0, data: { isLogin: true, mid: 1, uname: '<b>账号</b>\u0000', face: 'https://evil.test/a.png' } }).account?.avatar, '');
});

test('identity cookie detection ignores video preferences and unrelated origins', () => {
  assert.equal(isAuthenticationCookie({ name: 'SESSDATA', domain: '.bilibili.com' }), true);
  assert.equal(isAuthenticationCookie({ name: 'bili_jct', domain: '.passport.bilibili.com' }), true);
  assert.equal(isAuthenticationCookie({ name: 'SESSDATA', domain: '.bilibili.com.evil.test' }), false);
  assert.equal(isAuthenticationCookie({ name: 'SESSDATA' }), false);
  assert.equal(isAuthenticationCookie({ name: 'buvid3', domain: '.bilibili.com' }), false);
});

test('operation permits reuse a verified login for at most 30 seconds, UI checks remain fresh', async () => {
  let calls = 0; let time = 1000;
  const session = new BilibiliAccountSession(async () => { calls += 1; return nav(); }, () => {}, () => time);
  await session.getStatus();
  const permit = await session.requireLoggedIn();
  assert.equal(permit.account.mid, 101); assert.equal(calls, 1);
  time += 29_999; await session.requireLoggedIn(); assert.equal(calls, 1);
  time += 1; await session.requireLoggedIn(); assert.equal(calls, 2);
  await session.getStatus(); assert.equal(calls, 3);
});

test('a logged-out check cannot grant or cache a playback permit', async () => {
  let calls = 0;
  const session = new BilibiliAccountSession(async () => { calls += 1; return { code: -101 }; });
  await assert.rejects(session.requireLoggedIn(), error => error instanceof BilibiliError && error.code === 'BILIBILI_LOGIN_REQUIRED');
  await assert.rejects(session.requireLoggedIn());
  assert.equal(calls, 2);
});

test('concurrent checks share one request and cookie invalidation prevents old identity from being confirmed', async () => {
  const old = deferred(); const current = deferred(); let calls = 0; const confirmations: number[] = [];
  const session = new BilibiliAccountSession(() => (++calls === 1 ? old.promise : current.promise), status => {
    if (status.loggedIn) confirmations.push(status.account.mid);
  });
  const staleCheck = session.getStatus();
  assert.equal(session.getStatus(), staleCheck);
  await Promise.resolve();
  session.invalidate();
  const freshCheck = session.getStatus();
  const staleRejected = assert.rejects(staleCheck, error => error instanceof BilibiliError && error.code === 'BILIBILI_SESSION_CHANGED');
  current.resolve(nav(202));
  assert.equal((await freshCheck).account?.mid, 202);
  old.resolve(nav(101)); await staleRejected;
  assert.deepEqual(confirmations, [202]);
  assert.equal((await session.requireLoggedIn()).account.mid, 202);
});

test('cookie changes invalidate existing operation permits even when the account is the same', async () => {
  const session = new BilibiliAccountSession(async () => nav());
  const permit = await session.requireLoggedIn();
  session.invalidate();
  assert.throws(() => session.assertRevision(permit.revision), error => error instanceof BilibiliError && error.code === 'BILIBILI_SESSION_CHANGED');
  const fresh = await session.requireLoggedIn();
  session.assertRevision(fresh.revision);
  assert.notEqual(fresh.revision, permit.revision);
});

test('an official account switch invalidates old permits without requiring a local cookie event', async () => {
  let mid = 101;
  const session = new BilibiliAccountSession(async () => nav(mid));
  const old = await session.requireLoggedIn();
  mid = 202;
  assert.equal((await session.getStatus()).account?.mid, 202);
  assert.throws(() => session.assertRevision(old.revision));
  assert.equal((await session.requireLoggedIn()).account.mid, 202);
});

test('server-side expiration invalidates old permits and rejects playback', async () => {
  let loggedIn = true;
  const session = new BilibiliAccountSession(async () => loggedIn ? nav() : { code: -101 });
  const old = await session.requireLoggedIn();
  loggedIn = false;
  assert.deepEqual(await session.getStatus(), { loggedIn: false, account: null });
  assert.throws(() => session.assertRevision(old.revision));
  await assert.rejects(session.requireLoggedIn());
});

test('network failures throw while preserving the most recent confirmed account state', async () => {
  let failing = false; const confirmations: boolean[] = [];
  const session = new BilibiliAccountSession(async () => {
    if (failing) throw new Error('offline');
    return nav();
  }, status => { confirmations.push(status.loggedIn); });
  await session.getStatus(); failing = true;
  await assert.rejects(session.getStatus(), /offline/);
  assert.deepEqual(confirmations, [true]);
  assert.equal((await session.requireLoggedIn()).account.mid, 101);
});
