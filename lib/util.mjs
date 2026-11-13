/**
 * Dependency-free helpers shared by the whole plugin.
 *
 * Everything here is deliberately defensive: the plugin runs inside the DSH
 * host process, so a throw on the request path, an unbounded read or a second
 * `writeHead` on the same response must never be able to take the host down.
 * Callers still decide what a failure means.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  statSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const PROTOCOL_VERSION = 1;
export const PLUGIN_VERSION = '1.0.1';

/**
 * Internal header the in-process relay uses to identify itself. It is stripped
 * from every inbound request at the HTTP entry point and re-attached only by
 * the same-process relay link, so a phone can never fake it.
 */
export const RELAY_HEADER = 'x-pocket-relay';

/**
 * Symbol used to remember "this request carried the relay header". Symbol
 * properties cannot be set over HTTP and are invisible to JSON serialisation.
 */
export const RELAY_MARK = Symbol.for('dsh-pocket.relay');

export function randomBytes32() {
  return randomBytes(32);
}

export function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

export function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

export function fromB64url(text) {
  const normalized = String(text).replace(/-/gu, '+').replace(/_/gu, '/');
  return Buffer.from(normalized, 'base64');
}

export function randomToken(prefix = 'dshb_') {
  return `${prefix}${b64url(randomBytes32())}`;
}

export function randomId(prefix = '') {
  return `${prefix}${b64url(randomBytes(16))}`;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Log-safe rendering of a secret: first six characters plus the length. Never
 * print a whole device token, key or room into a log line or an error message.
 */
export function redactSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '(empty)';
  return `${value.slice(0, 6)}…(len=${value.length})`;
}

/** Log-safe rendering of a URL: drop the query string and the fragment. */
export function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return '(empty)';
  try {
    const url = new URL(value, 'http://127.0.0.1');
    const hasQuery = url.search.length > 0;
    const hasFragment = url.hash.length > 0;
    const suffix = hasQuery || hasFragment ? '?…' : '';
    return `${url.pathname}${suffix}`;
  } catch {
    return redactSecret(value);
  }
}

/**
 * Log-safe broker address: keep scheme/host/port/path (that is the useful part
 * when debugging "why is the relay down"), drop any `user:pass@` userinfo.
 * `redactUrl` is the wrong tool here — it throws the host away, which is
 * exactly what a broker log line is for.
 */
export function redactBroker(value) {
  if (typeof value !== 'string' || value.length === 0) return '(empty)';
  try {
    const url = new URL(value);
    const hasUserInfo = url.username.length > 0 || url.password.length > 0;
    const query = url.search.length > 0 ? '?…' : '';
    return `${url.protocol}//${hasUserInfo ? '***@' : ''}${url.host}${url.pathname}${query}`;
  } catch {
    return redactSecret(value);
  }
}

export function nowMs() {
  return Date.now();
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

/** UTF-16 高代理项（U+D800–U+DBFF）：一个增补字符的编码前一半。 */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 按码元把字符串截到 `max`，但**不切在代理对中间**。
 *
 * 为什么不用"先 Array.from 再切码点"：这两个函数在列表热路径上（一次快照就要
 * 跑几百行，`lastText` 每条都过一遍），`Array.from` 会为整串分配一个码点数组，
 * 而这里只需要在切点处检查一个码元是不是高代理项 —— 是就退一位，O(1)。
 *
 * 后果举例：`'a😀b'` 按 3 个码元切会得到 `'a\ud83d'`（孤立高代理项），手机端
 * 渲染成 `�`；本函数退一位，得到 `'a'`。
 */
export function sliceCodePoints(value, max) {
  const text = typeof value === 'string' ? value : '';
  const keep = Number.isFinite(max) ? Math.trunc(max) : 0;
  if (keep <= 0) return '';
  if (text.length <= keep) return text;
  // 切点（keep）前一个码元是高代理项 ⇒ 正好切在代理对中间，退一位。
  return text.slice(0, isHighSurrogate(text.charCodeAt(keep - 1)) ? keep - 1 : keep);
}

export function truncate(value, max) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  return `${sliceCodePoints(text, Math.max(0, max - 1))}…`;
}

export function oneLine(value, max = 240) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return truncate(text, max);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Atomic JSON write with 0600 from the first byte. A crash mid-write leaves the
 * previous file readable, which matters because the state file owns the device
 * token hashes. The old file is never unlinked: if the rename fails the caller
 * gets an error and the previous state still exists.
 */
export function atomicWriteJson(file, value, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomHex(4)}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(temp, 'w', mode);
  try {
    writeFileSync(fd, body, 'utf8');
    try { fsyncSync(fd); } catch { /* best effort */ }
  } finally {
    closeSync(fd);
  }
  try { chmodSync(temp, mode); } catch { /* Windows ACLs */ }
  renameSync(temp, file);
  try { chmodSync(file, mode); } catch { /* Windows ACLs */ }
}

export function readJsonFile(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const text = readFileSync(file, 'utf8');
    if (text.trim().length === 0) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function fileStat(file) {
  try {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Remote address without the IPv4-mapped IPv6 prefix. */
export function normalizeIp(value) {
  const text = String(value ?? '');
  if (text === '::1') return '127.0.0.1';
  if (text.startsWith('::ffff:')) return text.slice(7);
  return text;
}

export function isLoopback(ip) {
  const value = normalizeIp(ip);
  return value === '127.0.0.1' || value === '::1';
}

/** True when the literal is a valid IPv4/IPv6 address. */
export function isValidIp(value) {
  return typeof value === 'string' && value.length > 0 && net.isIP(value) !== 0;
}

/**
 * Normalise a Host header to a comparable hostname. IPv6 literals keep their
 * brackets so they can be compared with the allow-list without guessing.
 */
export function hostHeaderName(header) {
  if (typeof header !== 'string') return undefined;
  const text = header.trim().toLowerCase();
  if (text.length === 0) return undefined;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    return end > 0 ? text.slice(0, end + 1) : undefined;
  }
  const first = text.indexOf(':');
  const last = text.lastIndexOf(':');
  if (first > 0 && first === last) return text.slice(0, first);
  return text;
}

/** Hostnames that always mean "this machine" regardless of configuration. */
export function isLoopbackHostname(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const value = name.toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1';
}

export function clientIp(req) {
  return normalizeIp(req?.socket?.remoteAddress ?? '');
}

const CONTENT_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
}));

export function contentType(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
}

/** Resolve a URL path inside a root without allowing traversal or NUL tricks. */
export function safeJoin(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(requestPath ?? ''));
  } catch {
    // Malformed percent-encoding is a client error, not a 500.
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const normalized = decoded.replace(/\\/gu, '/').replace(/^\/+/u, '');
  const base = path.resolve(root);
  const target = path.resolve(base, normalized);
  const relative = path.relative(base, target);
  if (relative === '') return target;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return target;
}

/** Consume a request body we are not going to parse (keeps keep-alive clean). */
export function drainRequest(req) {
  try { req.resume(); } catch { /* already consumed or destroyed */ }
}

export async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('request body too large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    const error = new Error('invalid JSON body');
    error.code = 'invalid_json';
    throw error;
  }
}

function destroyResponse(res) {
  try { res.destroy(); } catch { /* already gone */ }
}

export function sendJson(res, status, value, extraHeaders = {}) {
  if (res === undefined || res === null || res.headersSent || res.writableEnded) {
    destroyResponse(res);
    return;
  }
  let body;
  try {
    body = Buffer.from(JSON.stringify(value));
  } catch {
    body = Buffer.from('{"ok":false,"error":{"code":"internal","message":"响应序列化失败"}}');
    status = 500;
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  } catch {
    destroyResponse(res);
  }
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  if (res === undefined || res === null || res.headersSent || res.writableEnded) {
    destroyResponse(res);
    return;
  }
  const body = Buffer.from(String(text));
  try {
    res.writeHead(status, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  } catch {
    destroyResponse(res);
  }
}

/** Fixed-window limiter: enough to blunt brute force without an external store. */
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  take(key, limit, windowMs) {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
    }
    if (bucket.count >= limit) {
      return { ok: false, remaining: 0, retryAfterMs: Math.max(1, bucket.resetAt - now) };
    }
    bucket.count += 1;
    return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
  }

  peek(key) {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= Date.now()) return { count: 0, retryAfterMs: 0 };
    return { count: bucket.count, retryAfterMs: Math.max(0, bucket.resetAt - Date.now()) };
  }

  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

/** Append-only logger with size rotation and 0600 from creation. */
export class FileLogger {
  constructor(file, { maxBytes = 2 * 1024 * 1024, mirror = true } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.mirror = mirror;
    ensureDir(path.dirname(file));
    try {
      if (!existsSync(file)) writeFileSync(file, '', { encoding: 'utf8', mode: 0o600 });
      chmodSync(file, 0o600);
    } catch { /* Windows ACLs or read-only volume */ }
    this.rotateIfNeeded();
  }

  rotateIfNeeded() {
    try {
      const stat = statSync(this.file);
      if (stat.size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
    } catch { /* absent */ }
  }

  write(level, args) {
    const line = `${new Date().toISOString()} [${level}] ${args.map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' ')}\n`;
    try {
      this.rotateIfNeeded();
      const fd = openSync(this.file, 'a', 0o600);
      try { writeFileSync(fd, line, 'utf8'); } finally { closeSync(fd); }
    } catch { /* disk full or read-only */ }
    if (this.mirror) {
      try { process.stdout.write(line); } catch { /* closed stdout */ }
    }
  }

  info(...args) { this.write('info', args); }
  warn(...args) { this.write('warn', args); }
  error(...args) { this.write('error', args); }
}

/** Relative Chinese time for the list; stable across devices. */
export function relativeTime(ms, now = Date.now()) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function durationText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
