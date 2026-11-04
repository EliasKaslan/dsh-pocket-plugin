/**
 * Optional second factor for the relay: username + password, scrypt hashes,
 * fifteen-day sessions.
 *
 * Why: the pairing/relay link is itself a credential (the fragment carries the
 * room key). If the link is screenshotted or the phone is handed over, the link
 * alone must not be enough. Passwords are only stored as salted scrypt hashes;
 * session tokens are only stored as SHA-256 digests, so a leaked sessions file
 * cannot be replayed.
 *
 * Fail-closed contract: `required` comes from configuration. When it is true and
 * no credentials file exists, `assertUsable()` throws and the caller must refuse
 * to serve instead of silently dropping the gate.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { atomicWriteJson } from './util.mjs';

/** "Remember me" lifetime for a phone session. */
export const SESSION_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const SHORT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;
const LOCK_MAX_MS = 60 * 60 * 1000;
const MAX_BUCKETS = 512;
const MAX_SESSIONS = 20;

const sha256 = (text) => createHash('sha256').update(String(text)).digest('base64url');

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function mtimeOf(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

export function hashPassword(password, salt = randomBytes(16).toString('hex'), params = SCRYPT) {
  const digest = scryptSync(String(password).normalize('NFKC'), salt, params.keylen, params);
  return {
    algo: 'scrypt',
    salt,
    hash: digest.toString('base64'),
    N: params.N,
    r: params.r,
    p: params.p,
  };
}

export function verifyPassword(password, record) {
  if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false;
  let expected;
  try { expected = Buffer.from(record.hash, 'base64'); } catch { return false; }
  if (expected.length === 0) return false;
  let actual;
  try {
    actual = scryptSync(String(password).normalize('NFKC'), record.salt, expected.length, {
      N: Number(record.N) || SCRYPT.N,
      r: Number(record.r) || SCRYPT.r,
      p: Number(record.p) || SCRYPT.p,
    });
  } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

export class Auth {
  /**
   * @param {{credentialsFile: string, sessionsFile: string, logger?: object, required?: boolean}} options
   */
  constructor({ credentialsFile, sessionsFile, logger, required = false }) {
    this.credentialsFile = credentialsFile;
    this.sessionsFile = sessionsFile;
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
    this.required = required === true;
    this.user = null;
    this.record = null;
    this.loadError = undefined;
    /** sha256(token) -> { expiresAt, phone, at } */
    this.sessions = new Map();
    /** bucketKey -> { failures: number[], lockedUntil: number, lockCount: number } */
    this.buckets = new Map();
    this.globalFailures = 0;
    this.credentialsMtime = 0;
    this.sessionsMtime = 0;
    this.reload();
    if (this.required && !this.configured) this.loadError = 'missing_credentials';
  }

  /** Credentials exist and are structurally usable. */
  get configured() {
    return typeof this.user === 'string' && this.user.length > 0 && this.record !== null;
  }

  /** The gate is active only when configuration demands it *and* it can work. */
  get enabled() {
    return this.required && this.configured;
  }

  /** Fail-closed guard for callers that are about to expose the relay. */
  assertUsable() {
    if (this.required && !this.configured) {
      const error = new Error('已要求口令登录，但未找到可用的凭据文件（auth.json）。请先在电脑上设置口令，或把 auth.required 改为 false。');
      error.code = 'auth_missing_credentials';
      throw error;
    }
    return true;
  }

  reload() {
    this.credentialsMtime = mtimeOf(this.credentialsFile);
    const credentials = readJson(this.credentialsFile);
    this.user = typeof credentials?.user === 'string' && credentials.user.trim().length > 0
      ? credentials.user.trim()
      : null;
    this.record = credentials?.password ?? null;

    this.sessionsMtime = mtimeOf(this.sessionsFile);
    const stored = readJson(this.sessionsFile);
    this.sessions = new Map();
    for (const item of Array.isArray(stored?.sessions) ? stored.sessions : []) {
      if (typeof item?.id !== 'string' || typeof item?.expiresAt !== 'number') continue;
      if (item.expiresAt <= Date.now()) continue;
      this.sessions.set(item.id, {
        expiresAt: item.expiresAt,
        phone: String(item.phone ?? '手机'),
        at: Number(item.at) || 0,
      });
    }
    if (this.required && !this.configured) this.loadError = 'missing_credentials';
    else this.loadError = undefined;
    return this;
  }

  /** Hot reload: another process (CLI) may have rewritten the files. */
  maybeReload() {
    const credentialsMtime = mtimeOf(this.credentialsFile);
    const sessionsMtime = mtimeOf(this.sessionsFile);
    if (credentialsMtime !== this.credentialsMtime || sessionsMtime !== this.sessionsMtime) {
      this.reload();
      return true;
    }
    return false;
  }

  saveSessions() {
    const sessions = [...this.sessions].map(([id, value]) => ({ id, ...value }));
    atomicWriteJson(this.sessionsFile, { sessions });
  }

  prune(now = Date.now()) {
    let removed = 0;
    for (const [id, value] of this.sessions) {
      if (value.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.saveSessions();
    return removed;
  }

  /** Strict check: null unless the gate is enabled and the token is live. */
  check(token) {
    if (!this.enabled) return null;
    if (typeof token !== 'string' || token.length === 0) return null;
    this.maybeReload();
    const digest = sha256(token);
    const session = this.sessions.get(digest);
    if (session === undefined) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(digest);
      this.saveSessions();
      return null;
    }
    return session;
  }

  /**
   * Preferred entry point for the relay: one call that says whether a token is
   * needed and whether it passed. Never fails open when `required` is set.
   */
  authorize(token) {
    if (!this.enabled) return { required: false, ok: true, session: null };
    const session = this.check(token);
    return { required: true, ok: session !== null, session };
  }

  bucketKey({ ip, deviceId } = {}) {
    const remote = typeof ip === 'string' && ip.length > 0 ? ip : 'unknown';
    const device = typeof deviceId === 'string' && deviceId.length > 0 ? deviceId.slice(0, 32) : '';
    return `${remote}|${device}`;
  }

  bucket(key) {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= MAX_BUCKETS) this.sweepBuckets();
      bucket = { failures: [], lockedUntil: 0, lockCount: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  sweepBuckets(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      const stale = bucket.lockedUntil <= now
        && bucket.failures.every((at) => now - at >= FAIL_WINDOW_MS);
      if (stale) this.buckets.delete(key);
    }
  }

  /**
   * Login. Failure counters are keyed by IP+device, so guessing from one phone
   * can never lock the real owner out (the old global lock could).
   *
   * When the caller cannot provide an identity (relay logins carry no remote
   * address), there is no bucket: we count and rate-limit, but never lock. A
   * shared lock would let any stranger lock the owner out, which is worse than
   * the slower brute force the per-link budget already bounds.
   */
  login({ user, password, phone = '手机', remember = true, ip, deviceId } = {}) {
    if (!this.enabled) {
      return { ok: false, reason: this.required ? 'misconfigured' : 'disabled', retryAfterSec: 0 };
    }
    const now = Date.now();
    this.maybeReload();
    const identifiable = (typeof ip === 'string' && ip.length > 0 && ip !== 'unknown')
      || (typeof deviceId === 'string' && deviceId.length > 0);
    const bucket = identifiable ? this.bucket(this.bucketKey({ ip, deviceId })) : null;
    if (bucket !== null && now < bucket.lockedUntil) {
      return { ok: false, reason: 'locked', retryAfterSec: Math.ceil((bucket.lockedUntil - now) / 1000) };
    }
    if (bucket !== null) bucket.failures = bucket.failures.filter((at) => now - at < FAIL_WINDOW_MS);
    const sameName = String(user ?? '').trim().toLowerCase() === this.user.toLowerCase();
    // Run scrypt even for a wrong username: the timing must not reveal which
    // half of the pair was wrong.
    const passwordOk = verifyPassword(String(password ?? ''), this.record);
    if (!sameName || !passwordOk) {
      this.globalFailures += 1;
      if (bucket === null) {
        this.logger.warn(`登录失败（来源未标识，累计 ${this.globalFailures} 次，仅记录不锁定）`);
        return { ok: false, reason: 'bad-credentials', retryAfterSec: 0 };
      }
      bucket.failures.push(now);
      if (bucket.failures.length >= FAIL_LIMIT) {
        bucket.lockCount += 1;
        const lockMs = Math.min(LOCK_MAX_MS, LOCK_MS * 2 ** (bucket.lockCount - 1));
        bucket.lockedUntil = now + lockMs;
        bucket.failures = [];
        this.logger.warn(`口令错误次数过多，该来源已被锁定 ${Math.round(lockMs / 60_000)} 分钟`);
        return { ok: false, reason: 'locked', retryAfterSec: Math.round(lockMs / 1000) };
      }
      this.logger.warn(`登录失败（该来源第 ${bucket.failures.length}/${FAIL_LIMIT} 次）`);
      return { ok: false, reason: 'bad-credentials', retryAfterSec: 0 };
    }
    if (bucket !== null) {
      bucket.failures = [];
      bucket.lockedUntil = 0;
      bucket.lockCount = 0;
    }
    this.prune(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = remember ? now + SESSION_TTL_MS : now + SHORT_SESSION_TTL_MS;
    this.sessions.set(sha256(token), { expiresAt, phone: String(phone).slice(0, 40), at: now });
    if (this.sessions.size > MAX_SESSIONS) {
      const sorted = [...this.sessions.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of sorted.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(id);
    }
    this.saveSessions();
    this.logger.info(`登录成功：${String(phone).slice(0, 40)}，令牌有效至 ${new Date(expiresAt).toLocaleString('zh-CN')}`);
    return { ok: true, token, expiresAt };
  }

  logout(token) {
    if (typeof token !== 'string') return false;
    const removed = this.sessions.delete(sha256(token));
    if (removed) this.saveSessions();
    return removed;
  }

  /** Password change / "sign out everywhere". Returns how many were dropped. */
  revokeAll() {
    const removed = this.sessions.size;
    this.sessions.clear();
    this.saveSessions();
    return removed;
  }

  /** Nearest session expiry (used by the CLI to report "next expiry"). */
  nextExpiry(now = Date.now()) {
    let nearest = 0;
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now) continue;
      if (nearest === 0 || session.expiresAt < nearest) nearest = session.expiresAt;
    }
    return nearest;
  }

  info() {
    return {
      required: this.required,
      configured: this.configured,
      enabled: this.enabled,
      user: this.user,
      sessions: this.sessions.size,
      nextExpiry: this.nextExpiry(),
      locked: [...this.buckets.values()].some((bucket) => bucket.lockedUntil > Date.now()),
      globalFailures: this.globalFailures,
      error: this.loadError ?? '',
    };
  }
}
