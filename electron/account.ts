import type { BilibiliAccount, BilibiliAccountStatus } from './types';

export class BilibiliError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requiresVerification = false,
  ) {
    super(message);
    this.name = 'BilibiliError';
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Account avatars may only come from Bilibili's own HTTPS origins/CDN. */
export function safeAccountAvatar(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['bilibili.com', 'hdslb.com'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return '';
    return url.toString();
  } catch { return ''; }
}

/** A transport failure or challenge must never be represented as a logged-out account. */
export function parseBilibiliAccountStatus(payload: unknown): BilibiliAccountStatus {
  const input = record(payload);
  if (!input || typeof input.code !== 'number' || !Number.isSafeInteger(input.code)) {
    throw new BilibiliError('Bilibili 登录状态响应格式异常，请稍后重试。', 'BILIBILI_INVALID_RESPONSE');
  }
  if (input.code === -101) return { loggedIn: false, account: null };
  if (input.code !== 0) {
    const restricted = [-111, -352, -403, -412, -509].includes(input.code);
    throw new BilibiliError(
      restricted ? 'Bilibili 需要验证，请打开登录窗口完成验证后重试。' : `Bilibili 登录状态验证失败（${input.code}），请稍后重试。`,
      restricted ? 'BILIBILI_VERIFICATION_REQUIRED' : 'BILIBILI_API_ERROR', restricted,
    );
  }
  const data = record(input.data);
  if (data?.isLogin === false) return { loggedIn: false, account: null };
  if (data?.isLogin !== true || typeof data.mid !== 'number' || !Number.isSafeInteger(data.mid) || data.mid <= 0 ||
      typeof data.uname !== 'string' || !data.uname.trim()) {
    throw new BilibiliError('Bilibili 账号信息响应格式异常，请稍后重试。', 'BILIBILI_INVALID_RESPONSE');
  }
  const username = data.uname.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128);
  if (!username) throw new BilibiliError('Bilibili 账号名称响应格式异常，请稍后重试。', 'BILIBILI_INVALID_RESPONSE');
  return { loggedIn: true, account: { mid: data.mid, username, avatar: safeAccountAvatar(data.face) } };
}

export interface AccountPermit { account: BilibiliAccount; revision: number }

export function isAuthenticationCookie(cookie: { name: string; domain?: string }): boolean {
  const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
  return (domain === 'bilibili.com' || domain.endsWith('.bilibili.com')) &&
    ['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct'].includes(cookie.name);
}

/** Only successful official checks are cached, and a cookie change invalidates pending checks immediately. */
export class BilibiliAccountSession {
  private revision = 0;
  private cached: { status: BilibiliAccountStatus; checkedAt: number } | null = null;
  private pending: { revision: number; result: Promise<BilibiliAccountStatus> } | null = null;

  constructor(
    private readonly fetchPayload: () => Promise<unknown>,
    private readonly onConfirmed: (status: BilibiliAccountStatus) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void { this.revision += 1; this.cached = null; this.pending = null; }
  getRevision(): number { return this.revision; }

  assertRevision(revision: number): void {
    if (revision !== this.revision) throw new BilibiliError('Bilibili 账号已发生变化，请重新验证后重试。', 'BILIBILI_SESSION_CHANGED');
  }

  getStatus(): Promise<BilibiliAccountStatus> {
    if (this.pending?.revision === this.revision) return this.pending.result;
    const revision = this.revision;
    const result = Promise.resolve().then(this.fetchPayload).then(payload => {
      this.assertRevision(revision);
      const status = parseBilibiliAccountStatus(payload);
      const previous = this.cached?.status;
      const identity = (value: BilibiliAccountStatus) => value.loggedIn ? value.account.mid : null;
      // The server may expire a session without a local cookie event. A new confirmed
      // identity also invalidates operations already using the previous positive check.
      if (previous && identity(previous) !== identity(status)) this.revision += 1;
      this.cached = { status, checkedAt: this.now() };
      this.onConfirmed(status);
      return status;
    }).finally(() => { if (this.pending?.result === result) this.pending = null; });
    this.pending = { revision, result };
    return result;
  }

  async requireLoggedIn(): Promise<AccountPermit> {
    const revision = this.revision;
    const age = this.cached ? this.now() - this.cached.checkedAt : Infinity;
    const status = this.cached?.status.loggedIn && age >= 0 && age < 30_000
      ? this.cached.status : await this.getStatus();
    this.assertRevision(revision);
    if (!status.loggedIn) throw new BilibiliError('请先登录 Bilibili 账号，再使用播放器。', 'BILIBILI_LOGIN_REQUIRED', true);
    return { account: { ...status.account }, revision };
  }
}
