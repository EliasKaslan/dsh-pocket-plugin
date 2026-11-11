/**
 * DSH Pocket — cloud relay transport (cross-network channel).
 *
 * The desktop never listens on a public port. It opens one outbound MQTT/TLS
 * connection to a public broker and subscribes to a random 128-bit room topic.
 * The phone does the same from its own network. Everything that crosses the
 * broker is AES-256-GCM sealed with a key that only exists in the QR code, so
 * the broker (and anyone who guesses the topic) only sees ciphertext.
 *
 * Over that sealed channel we proxy the *existing* HTTP API and the /ws stream
 * of the local bridge, which means the phone UI needs no protocol changes.
 *
 * Security model (v2 — see docs/relay-protocol.md):
 *  1. Path allowlist. The proxy fetch always originates from 127.0.0.1, so the
 *     bridge's "loopback only" guards cannot tell a phone from the local user.
 *     Only the routes the phone UI actually needs are forwarded; anything else
 *     is refused here, with an explicit error code.
 *  2. Origin marker. Every forwarded request (HTTP and the WS handshake) carries
 *     an internal header whose value is a per-process nonce. The bridge treats
 *     any request bearing that header as *remote*, so pairing / device / cloud
 *     admin endpoints stay unreachable through the relay. Client-supplied
 *     copies of the header are stripped before injection, so the phone cannot
 *     forge or spoof it.
 *  3. Replay guard. `req` and `ws.open` carry a monotonic `seq` plus a `ts`
 *     (ms). Stale or replayed frames are answered with `{t:'reject',...}`.
 *     This is orthogonal to the id-keyed idempotency cache, which still makes
 *     a legitimate resend safe.
 *  4. Fail closed. Without a configured login gate the link refuses to start
 *     unless the caller explicitly opted into anonymous mode from config.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import mqtt from 'mqtt';
import WebSocket from 'ws';
import { RELAY_HEADER, redactBroker } from './util.mjs';

/** Bumped to 2: `seq`/`ts`/`sid` replay guard + explicit reject frames. */
export const CLOUD_PROTOCOL = 2;
export const SEAL_VERSION = 1;

/**
 * Plaintext bytes per MQTT message before we split into parts. Kept well under
 * the public brokers' packet ceilings: a 64 KiB plaintext seals to ~88 KiB,
 * still far under EMQX's 1 MiB limit.
 */
const MAX_FRAME = 64 * 1024;
/** Hard cap on a reassembled frame: 64 parts * 64 KiB. */
const MAX_FRAME_TOTAL = 64;
/**
 * 超过这个体量就记一条 info：手机端"点开会话打不开"时，先看日志里有没有它。
 * 不设成错误 —— 256 KB 是正常能发出去的，只是值得留痕。
 */
const LARGE_RESPONSE_BYTES = 256 * 1024;
const WS_FLUSH_MS = 40;
const WS_BATCH = 24;
const RPC_TIMEOUT_MS = 45_000;
const MAX_PENDING = 96;
/** Largest body we are willing to forward (base64 already inflated by the phone). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE = 8 * 1024;
const MAX_QUERY = 2 * 1024;
/**
 * 每部手机的一条 WS 隧道占一个槽位。手机被强杀 / 切后台 / 断网时不会发 close，
 * 隧道会变成僵尸占住槽位 —— 槽位满了以后手机还能拿到 HTTP 数据（每次都新建请求），
 * 但 WS 永远建不起来，界面就卡在「正在连接…」。所以：槽位放宽 + 按最近活动时间回收。
 */
const MAX_SOCKETS = 12;
const SOCKET_IDLE_MS = 60 * 60 * 1000;
/**
 * 满槽时只抢占「确实久未活动」的隧道。旧版是 10 s，且活动时间只由上行帧刷新，
 * 于是纯接收（看板播报）的健康隧道会被误踢；这里放宽到 90 s 并让下行帧也刷新。
 */
const SOCKET_EVICT_AFTER_MS = 90 * 1000;
const BEAT_MS = 8_000;
const HELLO_MIN_GAP_MS = 10_000;
/** Replay window: |now - ts| beyond this is treated as stale. */
export const STALE_WINDOW_MS = 120_000;
/** Idempotency cache lifetime for `res` frames (separate from the replay guard). */
const REPLAY_CACHE_MS = 120_000;
const REPLAY_CACHE_MAX = 128;
/** Partial-frame reassembly lives in its own table with a TTL. */
const PART_TTL_MS = 30_000;
const PART_MAX_OPEN = 8;
/** Per-`sid` highest accepted `seq`, keyed `${type}:${sid}`. */
const SEQ_TABLE_MAX = 64;
const SEQ_TABLE_TTL_MS = 10 * 60 * 1000;
/** Login attempts accepted from one relay link per minute (scrypt is blocking). */
const LOGIN_BUDGET = 10;
const LOGIN_BUDGET_MS = 60_000;

/**
 * Internal marker header, shared with the bridge so the two sides cannot drift
 * (see `lib/util.mjs`). The bridge's `isLoopbackRequest()` returns false
 * whenever this header is present and matching, which is only possible for
 * traffic that this module generated. The value is a per-process nonce so a
 * leaked log line cannot be replayed against the bridge.
 */
export { RELAY_HEADER };

/**
 * Default broker that only ever sees ciphertext. Overridable from config; kept
 * as an array for callers that still import the old name.
 */
export const DEFAULT_BROKERS = Object.freeze(['wss://broker-cn.emqx.io:8084/mqtt']);

/**
 * The hosted shell lives on static hosting chosen by the operator. There is
 * deliberately no owner-specific default: a hard-coded account here would tie
 * every install to one person's Pages site. Configure `cloud.appBase`.
 */
export const DEFAULT_APP_BASE = '';

/** @deprecated kept for source compatibility; configure `appBase` instead. */
export const PUBLIC_APP_BASE = DEFAULT_APP_BASE;

const INTERNAL_ORIGIN = 'http://127.0.0.1';

/** Accept `broker` as a string or a list; de-duplicate and drop empties. */
function normalizeBrokers(broker) {
  const list = Array.isArray(broker) ? broker : [broker];
  const seen = [];
  for (const entry of list) {
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (text.length === 0 || seen.includes(text)) continue;
    seen.push(text);
  }
  if (seen.length === 0) seen.push(DEFAULT_BROKERS[0]);
  return seen;
}

export function b64u(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function unb64u(text) {
  const raw = String(text ?? '').replace(/-/gu, '+').replace(/_/gu, '/');
  return Buffer.from(raw + '='.repeat((4 - (raw.length % 4)) % 4), 'base64');
}

/** 128-bit room id + 256-bit key: the QR carries both, nothing else is secret. */
export function createIdentity() {
  return {
    room: b64u(randomBytes(16)),
    key: b64u(randomBytes(32)),
  };
}

/**
 * One nonce per plugin process. Generated by the plugin entry point (not here)
 * and handed to both the bridge and every CloudLink instance, so the bridge can
 * recognise relay traffic as remote.
 */
export function createRelayNonce() {
  return randomBytes(32).toString('base64url');
}

function topics(room) {
  return {
    up: `dshm/${room}/u`,
    down: `dshm/${room}/d`,
  };
}

/**
 * The link the phone opens. Everything after `#` never reaches a server.
 * `s` carries the broker so a self-hosted broker works without rebuilding the
 * shell; `r`/`k`/`t` are unchanged.
 */
export function buildLinkUrl({ appBase, room, key, token, name, broker }) {
  if (typeof appBase !== 'string' || appBase.length === 0) {
    const error = new Error('未配置手机端外壳地址（cloud.appBase）');
    error.code = 'app-base-missing';
    throw error;
  }
  let base;
  try {
    base = new URL(appBase);
  } catch {
    const error = new Error('手机端外壳地址不是合法 URL（cloud.appBase）');
    error.code = 'app-base-invalid';
    throw error;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    const error = new Error('手机端外壳地址必须是 http(s)（cloud.appBase）');
    error.code = 'app-base-invalid';
    throw error;
  }
  const params = new URLSearchParams({ r: room, k: key, t: token, n: name ?? 'DSH' });
  if (typeof broker === 'string' && broker.length > 0) params.set('s', broker);
  base.hash = params.toString();
  return base.href;
}

function seal(key, aad, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    v: SEAL_VERSION,
    n: iv.toString('base64'),
    c: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  });
}

function unseal(key, aad, envelope) {
  const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== SEAL_VERSION) throw new Error('bad envelope');
  const iv = Buffer.from(String(parsed.n ?? ''), 'base64');
  const blob = Buffer.from(String(parsed.c ?? ''), 'base64');
  if (iv.length !== 12 || blob.length <= 16) throw new Error('bad envelope body');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
}

/* ------------------------------------------------------------------ routes */

/**
 * The only HTTP routes the phone UI needs, spelled out one by one.
 *
 * Why a table instead of "starts with /api/v1": the bridge answers on
 * 127.0.0.1 and its own guards are socket-based, so *any* path we forward is
 * executed with local-user authority. Pairing (`/pair`, `/api/v1/pairing`,
 * `POST /api/v1/pair`), device management (`/api/v1/devices*`), relay admin
 * (`/cloud/*`), `/healthz` and `/download/*` all hand out credentials or let
 * the caller revoke the owner's device — none of them is needed by the phone
 * app, so none of them may cross the relay.
 *
 * `methods` doubles as CSRF-ish hardening: a GET-only route cannot be turned
 * into a write by a forged request, and the bridge's own handlers already
 * branch on method.
 */
export const RELAY_ROUTES = Object.freeze([
  { name: 'me', methods: Object.freeze(['GET']), pattern: /^\/api\/v1\/me$/u },
  { name: 'health', methods: Object.freeze(['GET']), pattern: /^\/api\/v1\/health$/u },
  { name: 'tasks.list', methods: Object.freeze(['GET', 'POST']), pattern: /^\/api\/v1\/tasks$/u },
  { name: 'tasks.get', methods: Object.freeze(['GET']), pattern: /^\/api\/v1\/tasks\/[A-Za-z0-9_-]{1,64}$/u },
  { name: 'tasks.prompt', methods: Object.freeze(['POST']), pattern: /^\/api\/v1\/tasks\/[A-Za-z0-9_-]{1,64}\/prompt$/u },
  { name: 'tasks.cancel', methods: Object.freeze(['POST']), pattern: /^\/api\/v1\/tasks\/[A-Za-z0-9_-]{1,64}\/cancel$/u },
  { name: 'presets', methods: Object.freeze(['GET']), pattern: /^\/api\/v1\/presets$/u },
  { name: 'workspaces', methods: Object.freeze(['GET']), pattern: /^\/api\/v1\/workspaces$/u },
  { name: 'self.revoke', methods: Object.freeze(['POST']), pattern: /^\/api\/v1\/self\/revoke$/u },
  { name: 'events', methods: Object.freeze(['GET']), pattern: /^\/api\/v1\/events$/u },
  { name: 'ws-ticket', methods: Object.freeze(['POST']), pattern: /^\/api\/v1\/ws-ticket$/u },
  { name: 'ws', methods: Object.freeze(['GET']), pattern: /^\/ws$/u },
]);

/**
 * Names for the paths we refuse *on purpose*, so the phone (and the logs) can
 * say why instead of a bare 403. Order does not matter: none of these overlaps
 * an allowed route, and the allowlist is consulted first anyway.
 *
 * `pairing` / `pair` 两条对应的路由已经随配对码一起从桥接里删除了。这里**故意
 * 保留**：拒绝清单比允许清单更容易长期安全 —— 万一以后有人把这类"发凭据"的
 * 路径加回来，中继也依然过不去，不用依赖他记得同步改这份清单。
 */
const DENIED_TARGETS = Object.freeze([
  { code: 'pair-page', pattern: /^\/pair(?:\/|$)/u },
  { code: 'pairing', pattern: /^\/api\/v1\/pairing(?:\/|$)/u },
  { code: 'pair', pattern: /^\/api\/v1\/pair$/u },
  { code: 'devices', pattern: /^\/api\/v1\/devices(?:\/|$)/u },
  { code: 'cloud-admin', pattern: /^\/cloud(?:\/|$)/u },
  { code: 'healthz', pattern: /^\/healthz$/u },
  { code: 'download', pattern: /^\/download(?:\/|$)/u },
]);

/**
 * Classify one relay target. Returns either
 *   `{ ok: true, path, route }` — `path` is the normalised request target,
 *   `{ ok: false, status, code }` — the response to send back untouched.
 *
 * Normalisation matters: `new URL()` collapses dot segments and resolves
 * protocol-relative input, and we forward the *normalised* path, so the string
 * we checked is the string the bridge sees.
 */
export function classifyRelayTarget(rawPath, method = 'GET') {
  const text = String(rawPath ?? '');
  if (text.length === 0) return { ok: false, status: 400, code: 'bad-path' };
  // Control characters and backslashes are either smuggling attempts or the
  // URL parser's idea of a path separator. Refuse instead of guessing.
  if (/[\u0000-\u001f\u007f\\]/u.test(text)) return { ok: false, status: 400, code: 'bad-path' };
  let parsed;
  try {
    parsed = new URL(text, INTERNAL_ORIGIN);
  } catch {
    return { ok: false, status: 400, code: 'bad-path' };
  }
  // Absolute-form (`http://evil/x`) and protocol-relative (`//evil/x`) input
  // would retarget the host; the fetch URL is built from our own origin, so
  // anything whose origin is not ours is simply not a path.
  if (parsed.origin !== INTERNAL_ORIGIN) return { ok: false, status: 400, code: 'bad-path' };
  if (parsed.search.length > MAX_QUERY) return { ok: false, status: 414, code: 'query-too-long' };

  const pathname = parsed.pathname;
  const verb = String(method ?? 'GET').toUpperCase();
  for (const route of RELAY_ROUTES) {
    if (!route.pattern.test(pathname)) continue;
    const allowed = route.methods.includes(verb) || (verb === 'HEAD' && route.methods.includes('GET'));
    if (!allowed) return { ok: false, status: 405, code: 'method-not-allowed', route: route.name };
    return { ok: true, path: `${pathname}${parsed.search}`, route: route.name };
  }
  for (const denied of DENIED_TARGETS) {
    if (denied.pattern.test(pathname)) return { ok: false, status: 403, code: denied.code };
  }
  return { ok: false, status: 403, code: 'not-allowed' };
}

export class CloudLink {
  /**
   * @param {object} options
   * @param {number} options.localPort  loopback port of the LAN bridge
   * @param {{room: string, key: string, token: string, deviceId: string}} options.identity
   * @param {string|string[]} [options.broker]
   * @param {string} [options.appBase]
   * @param {string} [options.name]
   * @param {{info: Function, warn: Function, error: Function}} [options.logger]
   * @param {{enabled: boolean, user: string, check: Function, login: Function, logout?: Function, info: Function}|null} [options.auth]
   * @param {boolean} [options.allowAnonymous] must come from config; anonymous mode is opt-in
   * @param {string} [options.relayNonce] per-process marker value injected into forwarded requests
   */
  constructor({
    localPort,
    identity,
    broker,
    appBase = DEFAULT_APP_BASE,
    name = 'DSH',
    logger,
    auth = null,
    allowAnonymous = false,
    relayNonce,
    core = null,
  }) {
    if (identity === null || typeof identity !== 'object') throw new Error('CloudLink: identity is required');
    this.localPort = localPort;
    this.identity = identity;
    /** 宿主 BridgeCore：登录成功后要在这里登记设备（登录即配对）。 */
    this.core = core;

    /** 登录闸门（lib/auth.mjs）。没有配置口令时为 null。 */
    this.auth = auth ?? null;
    this.authEnabled = auth?.enabled === true;
    /** Anonymous mode is a deliberate, configured decision — never a default. */
    this.allowAnonymous = allowAnonymous === true;
    this.brokers = normalizeBrokers(broker);
    this.brokerIndex = 0;
    this.broker = this.brokers[0];
    this.appBase = appBase ?? DEFAULT_APP_BASE;
    this.name = name;
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
    this.key = unb64u(identity.key);
    if (this.key.length !== 32) throw new Error('CloudLink: key must decode to 32 bytes');
    this.topics = topics(identity.room);
    /**
     * Marker value for forwarded requests. Never logged, never echoed back to
     * the phone: it is only meaningful to the local bridge.
     */
    this.relayNonce = typeof relayNonce === 'string' && relayNonce.length > 0 ? relayNonce : createRelayNonce();
    /**
     * True when the bridge handed us its own nonce (the normal wiring). A
     * generated one still fails closed in the bridge — it just cannot unlock
     * the loopback-only routes, which the relay allowlist refuses anyway.
     */
    this.relayNonceFromConfig = typeof relayNonce === 'string' && relayNonce.length > 0;
    this.client = undefined;
    this.state = 'idle';
    /** Set by stop(): a scheduled reconnect must not resurrect a stopped link. */
    this.disposed = false;
    this.startedAt = 0;
    this.lastError = '';
    this.pending = new Map();
    /** id -> { payload, at }: response cache, also the duplicate-request guard. */
    this.recent = new Map();
    /** part id -> { chunks, total, at }: reassembly, separate from RPC slots. */
    this.parts = new Map();
    /**
     * `${type}:${sid}` -> { seq, at }: replay guard. Keyed by the phone's
     * per-page-load `sid` as well as the message type, because a reloaded page
     * restarts `seq` at 1 and must not be mistaken for a replayed frame.
     */
    this.lastSeq = new Map();
    this.sockets = new Map();
    /** id -> 最后一次收到该隧道任一方向帧的时间，用于回收僵尸隧道的槽位。 */
    this.socketActivity = new Map();
    this.wsBuckets = new Map();
    this.socketSweeper = undefined;
    this.beatTimer = undefined;
    this.retryTimer = undefined;
    this.loginBudget = { windowAt: 0, used: 0 };
    this.stats = {
      rx: 0, tx: 0, rpc: 0, wsOpen: 0, lastPhoneAt: 0, connects: 0, errors: 0,
      replays: 0, stale: 0, blocked: 0, unauthorized: 0, failures: 0,
    };
    this.phone = null;
    /**
     * Fail closed: a relay with no login gate is a full-authority link for
     * anyone holding the URL. Refuse to start unless the operator explicitly
     * configured anonymous mode.
     */
    this.blocked = null;
    if (!this.authEnabled && !this.allowAnonymous) {
      this.blocked = {
        code: 'auth-required',
        message: '未设置访问口令，中继已拒绝启动。请先设置口令；确实需要无口令模式时在配置里显式开启 cloud.allowAnonymous。',
      };
    }
  }

  /** The URL the phone opens. Empty when the shell base is not configured. */
  get url() {
    try {
      return buildLinkUrl({
        appBase: this.appBase,
        room: this.identity.room,
        key: this.identity.key,
        token: this.identity.token,
        name: this.name,
        broker: this.broker,
      });
    } catch (error) {
      this.debug('link url unavailable', error?.code ?? error?.message);
      return '';
    }
  }

  status() {
    return {
      state: this.state,
      broker: this.broker,
      room: this.identity.room,
      url: this.url,
      deviceId: this.identity.deviceId,
      phone: this.phone,
      lastPhoneAt: this.stats.lastPhoneAt,
      stats: { ...this.stats },
      startedAt: this.startedAt,
      lastError: this.lastError,
      sockets: this.sockets.size,
      auth: this.authEnabled && typeof this.auth?.info === 'function' ? this.auth.info() : { enabled: false },
      /** Route guard summary for the status page — never includes the nonce. */
      guard: {
        routes: RELAY_ROUTES.length,
        anonymous: this.allowAnonymous,
        blocked: this.blocked === null ? null : { code: this.blocked.code, message: this.blocked.message },
      },
      appBaseConfigured: typeof this.appBase === 'string' && this.appBase.length > 0,
    };
  }

  start() {
    if (this.blocked !== null) {
      this.state = 'blocked';
      this.logger.error(`cloud relay not started: ${this.blocked.code} — ${this.blocked.message}`);
      return false;
    }
    if (this.client !== undefined) return true;
    // Reopening a stopped link (config toggle) has to clear the tombstone.
    this.disposed = false;
    this.debug('relay nonce source', this.relayNonceFromConfig ? 'bridge' : 'generated');
    this.startedAt = Date.now();
    if (this.socketSweeper === undefined) {
      this.socketSweeper = setInterval(() => this.sweep(), 60_000);
      this.socketSweeper.unref?.();
    }
    this.connect();
    return true;
  }

  connect() {
    this.state = this.stats.connects === 0 ? 'connecting' : 'reconnecting';
    // Random client id only: the old one embedded the first ten characters of
    // the room, which let a broker observer correlate reconnects of one host.
    const clientId = `pocket_${randomBytes(6).toString('hex')}`;
    const client = mqtt.connect(this.broker, {
      clientId,
      clean: true,
      keepalive: 40,
      reconnectPeriod: 0,
      connectTimeout: 15_000,
      protocolVersion: 4,
    });
    this.client = client;

    client.on('connect', () => {
      const reconnected = this.stats.connects > 0;
      this.stats.connects += 1;
      this.stats.failures = 0;
      this.state = 'online';
      this.lastError = '';
      this.logger.info(`cloud link online broker=${redactBroker(this.broker)}${reconnected ? ' (reconnected)' : ''}`);
      client.subscribe(this.topics.up, { qos: 1 }, (error) => {
        if (error) this.logger.warn('cloud subscribe failed', error);
      });
      this.sayHello(true);
      this.startBeat();
    });

    client.on('message', (_topic, payload) => {
      try {
        this.onFrame(payload);
      } catch (error) {
        this.stats.errors += 1;
        this.logger.warn('cloud frame rejected', error?.message ?? error);
      }
    });

    client.on('error', (error) => {
      this.lastError = error?.message ?? String(error);
      this.stats.errors += 1;
    });

    client.on('close', () => {
      if (this.client !== client) return;
      this.stopBeat();
      this.state = 'offline';
      this.closeAllSockets('云端连接中断');
      this.clearPending('云端连接中断');
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.disposed === true) return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retry();
    }, 2500);
    this.retryTimer.unref?.();
  }

  retry() {
    if (this.disposed === true) return;
    if (this.client !== undefined) {
      try { this.client.end(true); } catch { /* ignore */ }
      this.client = undefined;
    }
    // Rotate only after a run of hard failures, not on every reconnect: the old
    // condition depended on a connect count that never resets.
    this.stats.failures = (this.stats.failures ?? 0) + 1;
    if (this.brokers.length > 1 && this.stats.failures % 3 === 0) {
      this.brokerIndex = (this.brokerIndex + 1) % this.brokers.length;
      this.broker = this.brokers[this.brokerIndex];
      this.logger.warn('cloud switching broker');
    }
    this.connect();
  }

  /** Emit our presence, rate-limited so a peer's hello cannot start a loop. */
  sayHello(force = false) {
    const now = Date.now();
    if (!force && now - (this.lastHelloAt ?? 0) < HELLO_MIN_GAP_MS) return;
    this.lastHelloAt = now;
    this.publish({
      t: 'hello',
      name: this.name,
      ver: CLOUD_PROTOCOL,
      ts: now,
      auth: this.authEnabled,
      user: this.authEnabled ? this.auth.user : null,
    });
  }

  startBeat() {
    this.stopBeat();
    this.beatTimer = setInterval(() => {
      this.publish({ t: 'beat', name: this.name, ver: CLOUD_PROTOCOL, ts: Date.now(), peers: this.sockets.size });
    }, BEAT_MS);
    this.beatTimer.unref?.();
  }

  stopBeat() {
    if (this.beatTimer !== undefined) clearInterval(this.beatTimer);
    this.beatTimer = undefined;
  }

  stop() {
    this.disposed = true;
    this.stopBeat();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.socketSweeper !== undefined) {
      clearInterval(this.socketSweeper);
      this.socketSweeper = undefined;
    }
    this.closeAllSockets('服务停止');
    this.clearPending('服务停止');
    if (this.client !== undefined) {
      try { this.client.end(true); } catch { /* ignore */ }
      this.client = undefined;
    }
    this.state = 'stopped';
  }

  /* ------------------------------ transport ------------------------------ */

  debug(...args) {
    if (process.env.DSH_CLOUD_DEBUG) this.logger.info('[debug]', ...args);
  }

  /** One code path for framing: split when the plaintext exceeds MAX_FRAME. */
  publish(object) {
    if (this.client === undefined || this.state !== 'online') {
      this.debug('drop publish (offline)', object.t);
      return false;
    }
    const raw = Buffer.from(JSON.stringify(object), 'utf8');
    if (raw.length <= MAX_FRAME) {
      this.publishSealed(raw);
      return true;
    }
    const total = Math.ceil(raw.length / MAX_FRAME);
    if (total > MAX_FRAME_TOTAL) {
      this.stats.errors += 1;
      this.lastError = `frame too large (${raw.length}B)`;
      this.logger.warn(`refusing to send ${object.t}: ${raw.length} bytes exceeds the part budget`);
      return false;
    }
    const chunkId = randomBytes(6).toString('hex');
    for (let index = 0; index < total; index += 1) {
      const slice = raw.subarray(index * MAX_FRAME, (index + 1) * MAX_FRAME);
      const part = Buffer.from(JSON.stringify({
        t: 'part',
        id: chunkId,
        seq: index,
        total,
        d: slice.toString('base64'),
      }), 'utf8');
      this.publishSealed(part);
    }
    return true;
  }

  publishSealed(raw) {
    if (this.client === undefined || this.state !== 'online') return;
    const sealed = seal(this.key, this.topics.down, raw);
    this.client.publish(this.topics.down, sealed, { qos: 1 }, (error) => {
      if (error === undefined || error === null) return;
      this.stats.errors += 1;
      this.lastError = `publish: ${error.message ?? error}`;
      this.logger.warn(`publish failed: ${error.message ?? error}`);
    });
    this.stats.tx += 1;
  }

  onFrame(payload) {
    // A sealed single frame is < ~120 KiB; anything much larger is junk.
    if (payload.length > MAX_FRAME * 2) throw new Error('frame too large');
    const plaintext = unseal(this.key, this.topics.up, payload.toString('utf8'));
    const message = JSON.parse(plaintext.toString('utf8'));
    if (message === null || typeof message !== 'object') return;

    if (message.t === 'part') {
      this.collectPart(message);
      return;
    }
    this.stats.rx += 1;
    this.dispatch(message);
  }

  /* --------------------------- fragment reassembly ------------------------ */

  collectPart(message) {
    const id = String(message.id ?? '');
    if (!/^[0-9a-f]{12}$/u.test(id)) return;
    const seq = Number(message.seq);
    const total = Number(message.total);
    if (!Number.isInteger(seq) || !Number.isInteger(total)) return;
    if (total < 1 || total > MAX_FRAME_TOTAL || seq < 0 || seq >= total) return;
    const data = typeof message.d === 'string' ? message.d : '';
    if (data.length > Math.ceil((MAX_FRAME * 4) / 3) + 16) return;

    const now = Date.now();
    this.sweepParts(now);
    const key = `part:${id}`;
    let entry = this.parts.get(key);
    if (entry === undefined) {
      if (this.parts.size >= PART_MAX_OPEN) {
        this.stats.errors += 1;
        return;
      }
      entry = { chunks: new Array(total), total, at: now };
      this.parts.set(key, entry);
    }
    if (entry.total !== total) return;
    entry.chunks[seq] = Buffer.from(data, 'base64');
    entry.at = now;
    for (const chunk of entry.chunks) if (chunk === undefined) return;
    this.parts.delete(key);
    const inner = JSON.parse(Buffer.concat(entry.chunks).toString('utf8'));
    this.stats.rx += 1;
    this.dispatch(inner);
  }

  sweepParts(now = Date.now()) {
    for (const [key, entry] of this.parts) {
      if (now - entry.at > PART_TTL_MS) this.parts.delete(key);
    }
  }

  /* ------------------------------ dispatch ------------------------------- */

  dispatch(message) {
    this.debug('recv', message.t, message.id ?? '');
    switch (message.t) {
      case 'hello':
        this.phone = { name: String(message.name ?? '手机').slice(0, 48), at: Date.now(), ver: Number(message.ver) || 0 };
        this.stats.lastPhoneAt = Date.now();
        // Answer at most once every 10s. Replying to every hello makes both
        // sides echo each other forever, which trips public-broker rate limits
        // and silently drops RPC responses.
        this.sayHello();
        break;
      case 'auth':
        this.handleAuthCheck(message);
        break;
      case 'login':
        this.handleLogin(message);
        break;
      case 'logout':
        this.handleLogout(message);
        break;
      case 'req': {
        if (!this.authorized('req', message)) { this.rejectRequest(message); break; }
        const fresh = this.checkFreshness('req', message);
        if (!fresh.ok) { this.rejectStale(message, fresh.code); break; }
        void this.handleRequest(message);
        break;
      }
      case 'ws.open': {
        if (!this.authorized('ws.open', message)) {
          this.publish({ t: 'ws.error', id: String(message.id ?? ''), message: 'unauthorized' });
          break;
        }
        const fresh = this.checkFreshness('ws.open', message);
        if (!fresh.ok) { this.rejectStale(message, fresh.code); break; }
        this.handleSocketOpen(message);
        break;
      }
      case 'ws.msg':
        if (!this.authorized('ws.msg', message)) break;
        this.handleSocketMessage(message);
        break;
      case 'ws.close':
        // Same gate as ws.open/ws.msg: knowing a tunnel id must not be enough
        // to tear somebody else's tunnel down.
        if (!this.authorized('ws.close', message)) break;
        this.handleSocketClose(message);
        break;
      default:
        break;
    }
  }

  /* ------------------------------- 登录闸门 ------------------------------- */

  /**
   * Every uplink message is checked on its own: stateless, survives restarts,
   * and cannot be confused by several tunnels sharing one link.
   */
  authorized(type, message) {
    if (this.blocked !== null) return false;
    if (!this.authEnabled) return this.allowAnonymous;
    const ok = this.auth.check(message?.token) !== null;
    if (!ok) {
      this.stats.unauthorized += 1;
      // Never log the token, its length, or anything derived from it.
      this.logger.warn(`拒绝未授权消息 t=${type}`);
    }
    return ok;
  }

  /**
   * Replay guard for state-changing messages.
   *
   * - `seq` must strictly increase within a `sid` (per page load) and type.
   * - `ts` must be within STALE_WINDOW_MS of our clock, which is what makes a
   *   frame recorded off the public broker useless minutes later.
   *
   * A legitimate retry reuses the request id (idempotency cache) but must mint
   * a fresh `seq` and `ts`, so it passes here.
   */
  checkFreshness(type, message) {
    const now = Date.now();
    const seq = Number(message?.seq);
    const ts = Number(message?.ts);
    if (!Number.isSafeInteger(seq) || seq <= 0) return { ok: false, code: 'stale' };
    if (!Number.isFinite(ts) || Math.abs(now - ts) > STALE_WINDOW_MS) return { ok: false, code: 'stale' };
    // The per-page-load `sid` is mandatory in protocol 2. Bucketing unknown
    // clients together would let one phone's high `seq` reject another phone's
    // first frame, so an unusable sid is refused instead of guessed at.
    if (typeof message?.sid !== 'string' || !/^[0-9a-f]{8,32}$/u.test(message.sid)) return { ok: false, code: 'stale' };
    const key = `${type}:${message.sid}`;
    const entry = this.lastSeq.get(key);
    if (entry !== undefined && seq <= entry.seq) return { ok: false, code: 'stale' };
    this.lastSeq.set(key, { seq, at: now });
    if (this.lastSeq.size > SEQ_TABLE_MAX) this.sweepSeq(now);
    return { ok: true };
  }

  sweepSeq(now = Date.now()) {
    for (const [key, entry] of this.lastSeq) {
      if (now - entry.at > SEQ_TABLE_TTL_MS) this.lastSeq.delete(key);
    }
    // Hard cap as well: a flood of fresh `sid`s must not grow this table.
    while (this.lastSeq.size > SEQ_TABLE_MAX) {
      this.lastSeq.delete(this.lastSeq.keys().next().value);
    }
  }

  /** Answer a stale/replayed frame. `id` is echoed so the phone can retry. */
  rejectStale(message, code = 'stale') {
    const id = String(message?.id ?? '');
    this.stats.stale += 1;
    // Throttled: a replayed frame is often repeated, and this is a public
    // broker, so an unthrottled log line would itself become a DoS vector.
    if (this.stats.stale === 1 || this.stats.stale % 20 === 0) {
      this.logger.warn(`拒绝重放/过期帧 t=${String(message?.t)} code=${code} 累计=${this.stats.stale}`);
    }
    if (id.length === 0) return;
    this.publish({ t: 'reject', id, code });
  }

  rejectRequest(message) {
    const id = String(message?.id ?? '');
    if (id.length === 0) return;
    // Deliberately NOT cached: after logging in, the phone retries the same id
    // and must reach the real handler, not a replayed 401.
    this.publish({
      t: 'res',
      id,
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      enc: '',
      body: Buffer.from(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '请先登录' } }), 'utf8').toString('base64'),
      ms: 0,
    });
  }

  /** 手机这次到底有没有自报设备令牌（用来区分"没配过"和"被吊销了"）。 */
  presentedToken(message) {
    return typeof message?.deviceToken === 'string' && message.deviceToken.length > 0;
  }

  provisionFor(message) {
    const presented = typeof message?.deviceToken === 'string' && message.deviceToken.length > 0
      ? message.deviceToken
      : undefined;
    // 整个方法都不许抛：它挂在 login/auth 的应答路径上，抛一次手机就永远收不到
    // 应答（表现为卡到 15s 超时）。core 缺失是接线错误，降级成"不发令牌"即可。
    try {
      if (this.core === null || this.core === undefined) {
        this.logger.warn('device provisioning skipped: CloudLink has no core');
        return null;
      }
      // 手机自报了令牌：有效就原样回显；无效/已吊销就什么都不发。
      // 这里绝不能"补发一台"——否则用户在电脑上移除设备之后，那台手机下一次
      // 登录就会被自动重新登记，吊销形同虚设。
      if (presented !== undefined) {
        const existing = this.core.authenticateToken(presented);
        if (existing === undefined) return null;
        return { token: presented, device: this.core.deviceView(existing) };
      }
      return this.core.provisionDevice({
        name: message?.phone ?? '手机',
        platform: message?.platform ?? 'relay',
        appVersion: message?.appVersion ?? '',
        // 手机自报的安装标识：同一台手机重连时复用它那条记录，另一台手机
        // 不会把这一台顶掉。缺失时 core 回落到「同名同平台」的老判据。
        installId: typeof message?.installId === 'string' ? message.installId : '',
      });
    } catch (error) {
      this.logger.warn('device provisioning failed', error?.message ?? error);
      return null;
    }
  }

  /**
   * 口令校验通过就顺带把设备令牌发下去：手机端从此只需要一个凭据。
   * 免口令部署（authRequired=false + allowAnonymous）走同一条路，
   * 否则那台机器上的手机会拿不到设备令牌、连 API 都调不动。
   */
  handleAuthCheck(message) {
    const session = this.authEnabled ? this.auth.check(message?.token) : { phone: '未启用口令', expiresAt: 0 };
    const ok = this.authEnabled ? session !== null : this.allowAnonymous;
    const provisioned = ok ? this.provisionFor(message) : null;
    this.publish({
      t: 'auth',
      required: this.authEnabled && !this.allowAnonymous,
      ok,
      user: this.authEnabled ? this.auth.user : null,
      expiresAt: session?.expiresAt ?? 0,
      phone: session?.phone ?? null,
      deviceToken: provisioned?.token ?? null,
      deviceId: provisioned?.device?.id ?? null,
      // 设备数量不设上限，所以没有「发不出令牌是因为名额满了」这种状态。
      // 只有一种失败要告诉手机：它自报了一个已吊销 / 无效的令牌（revoked）。
      revoked: ok && provisioned === null && this.presentedToken(message),
      ver: CLOUD_PROTOCOL,
    });
  }

  /** Cheap per-link throttle in front of the blocking scrypt verifier. */
  loginAllowed(now = Date.now()) {
    if (now - this.loginBudget.windowAt > LOGIN_BUDGET_MS) {
      this.loginBudget.windowAt = now;
      this.loginBudget.used = 0;
    }
    this.loginBudget.used += 1;
    if (this.loginBudget.used <= LOGIN_BUDGET) return { ok: true };
    return { ok: false, retryAfterSec: Math.ceil((this.loginBudget.windowAt + LOGIN_BUDGET_MS - now) / 1000) };
  }

  handleLogin(message) {
    if (this.blocked !== null) {
      this.publish({ t: 'login', ok: false, reason: 'disabled' });
      return;
    }
    if (this.auth === null || !this.authEnabled) {
      this.publish({ t: 'login', ok: false, reason: 'disabled' });
      return;
    }
    const budget = this.loginAllowed();
    if (!budget.ok) {
      this.publish({ t: 'login', ok: false, reason: 'locked', retryAfterSec: budget.retryAfterSec });
      return;
    }
    const result = this.auth.login({
      user: message?.user,
      password: message?.password,
      phone: message?.phone ?? '手机',
      remember: message?.remember !== false,
    });
    if (result.ok) {
      this.logger.info('手机端登录成功');
      const provisioned = this.provisionFor(message);
      this.publish({
        t: 'login',
        ok: true,
        token: result.token,
        expiresAt: result.expiresAt,
        user: this.auth.user,
        deviceToken: provisioned?.token ?? null,
        deviceId: provisioned?.device?.id ?? null,
        // 同上：上限已取消，不再下发「名额满」标记；revoked 语义保持不变。
        revoked: provisioned === null && this.presentedToken(message),
      });
      return;
    }
    this.publish({ t: 'login', ok: false, reason: result.reason, retryAfterSec: result.retryAfterSec ?? 0 });
  }

  handleLogout(message) {
    if (this.blocked !== null) return;
    const removed = this.auth?.logout?.(message?.token) ?? false;
    this.publish({ t: 'logout', ok: removed });
  }

  /* -------------------------------- http -------------------------------- */

  /**
   * Headers we never forward: hop-by-hop, the ones undici must own, spoofable
   * forwarding hints, and — most importantly — the relay marker, which is
   * injected below and nowhere else.
   */
  static isDroppedRequestHeader(name) {
    const exact = /^(?:host|connection|content-length|accept-encoding|transfer-encoding|upgrade|forwarded|via)$/iu;
    const prefix = /^(?:sec-websocket-|x-forwarded-|x-pocket-relay)/iu;
    return exact.test(name) || prefix.test(name);
  }

  buildForwardHeaders(source) {
    const headers = {};
    let count = 0;
    for (const [name, value] of Object.entries(source ?? {})) {
      if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE) continue;
      if (CloudLink.isDroppedRequestHeader(name)) continue;
      if (count >= MAX_HEADERS) break;
      headers[name.toLowerCase()] = value;
      count += 1;
    }
    // Trusted marker: a fresh copy from the process nonce, added after the
    // client headers have been copied (and after any same-named one was
    // dropped), so a phone-supplied value can never survive.
    headers[RELAY_HEADER] = this.relayNonce;
    return headers;
  }

  async handleRequest(message) {
    const id = String(message.id ?? '');
    if (id.length === 0) return;

    // The phone resends with the same id when a frame is lost. Replaying the
    // cached reply is both the retry answer *and* the duplicate-execution
    // guard: a resent POST must never run the side effect twice. This works
    // together with, not instead of, the seq/ts replay guard above.
    const cached = this.recent.get(id);
    if (cached !== undefined) {
      this.debug('replay', id);
      this.stats.replays += 1;
      this.publish(cached.payload);
      return;
    }

    const started = Date.now();
    const target = classifyRelayTarget(message.path, message.method);
    if (!target.ok) {
      this.stats.blocked += 1;
      this.logger.warn(`relay target refused code=${target.code}`);
      this.rejectTarget(id, target, started);
      return;
    }
    // 详情请求的"到达"时刻。和后面的"响应发出"配对，就能量出电脑端到底卡了多久
    // —— 手机端的 RPC 超时是 16 s，超过它就会重发，用户看到的是"连接中断"。
    if (target.route === 'tasks.get') {
      this.logger.info(`详情请求收到 ${target.path}（id=${id}）`);
    }

    const bodyText = typeof message.body === 'string' ? message.body : '';
    if (bodyText.length > 0 && bodyText.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) {
      this.rejectTarget(id, { status: 413, code: 'body-too-large' }, started);
      return;
    }
    // A duplicate that arrives while the first copy is still in flight is not
    // in the cache yet. Answering it by running the request again would fire
    // the side effect twice (a POST that starts an agent, for instance) — drop
    // it instead; the first copy's reply carries the same id.
    if (this.pending.has(id)) {
      this.debug('in-flight duplicate', id);
      return;
    }
    if (this.pending.size > MAX_PENDING) {
      this.publish({
        t: 'res',
        id,
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        enc: '',
        body: Buffer.from('{"ok":false,"error":{"code":"busy"}}', 'utf8').toString('base64'),
        ms: 0,
      });
      return;
    }

    const timer = setTimeout(() => this.pending.delete(id), RPC_TIMEOUT_MS);
    this.pending.set(id, { at: started, timer });
    this.stats.rpc += 1;
    try {
      const init = {
        method: String(message.method ?? 'GET').toUpperCase(),
        headers: this.buildForwardHeaders(message.headers),
        redirect: 'manual',
      };
      if (bodyText.length > 0) init.body = Buffer.from(bodyText, 'base64');
      const response = await fetch(`${INTERNAL_ORIGIN}:${this.localPort}${target.path}`, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
      let body = Buffer.from(await response.arrayBuffer());
      // 压缩会改写 body，诊断日志要的是压缩前那个数（它才代表手机端的真实体量压力）。
      const rawLength = body.length;
      const outHeaders = {};
      response.headers.forEach((value, name) => {
        // `set-cookie` is dropped too: the relay has no business planting
        // cookies on the local bridge.
        if (/^(?:connection|transfer-encoding|content-length|keep-alive|content-encoding|set-cookie)$/iu.test(name)) return;
        outHeaders[name] = value;
      });
      let enc = '';
      const wantsGzip = message.gzip !== false;
      if (wantsGzip && body.length > 1200 && /json|text|javascript|css|svg|xml/iu.test(String(outHeaders['content-type'] ?? ''))) {
        body = gzipSync(body);
        enc = 'gzip';
      }
      // 详情是手机端最容易"点开就没反应"的请求：它的体积跟会话长度直接相关。
      // 每次都留一条可诊断的痕迹，出问题时先看这一行，不用猜。
      if (target.route === 'tasks.get') {
        this.logger.info(`详情响应 原始 ${Math.round(rawLength / 1024)} KB → 发送 ${Math.round(body.length / 1024)} KB（${enc === 'gzip' ? 'gzip' : '明文'}），${Date.now() - started}ms`);
      }
      this.finishPending(id);
      this.debug('res', target.route, body.length, `${Date.now() - started}ms`);
      this.respond(id, {
        t: 'res',
        id,
        status: response.status,
        headers: outHeaders,
        enc,
        body: body.toString('base64'),
        ms: Date.now() - started,
      });
    } catch (error) {
      this.finishPending(id);
      const payload = Buffer.from(JSON.stringify({ ok: false, error: { code: 'relay', message: String(error?.message ?? error) } }), 'utf8');
      this.respond(id, {
        t: 'res',
        id,
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        enc: '',
        body: payload.toString('base64'),
        ms: Date.now() - started,
      });
    }
  }

  /** Structured 4xx for a refused target; never cached (see rejectRequest). */
  rejectTarget(id, target, started) {
    const messages = {
      'pair-page': '连接页不能经中继访问',
      pairing: '已下线的配对接口不能经中继访问',
      pair: '不能经中继登记新设备',
      devices: '设备管理不能经中继访问',
      'cloud-admin': '中继管理接口不能经中继访问',
      healthz: '该接口不能经中继访问',
      download: '文件下载不能经中继访问',
      'not-allowed': '该路径不在中继白名单内',
      'method-not-allowed': '该路径不允许使用此方法',
      'bad-path': '请求路径不合法',
      'query-too-long': '请求参数过长',
      'body-too-large': '请求体过大',
    };
    const payload = Buffer.from(JSON.stringify({
      ok: false,
      error: { code: target.code, message: messages[target.code] ?? '该请求被中继拒绝' },
    }), 'utf8');
    this.publish({
      t: 'res',
      id,
      status: target.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      enc: '',
      body: payload.toString('base64'),
      ms: Date.now() - started,
    });
  }

  respond(id, payload) {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const budget = MAX_FRAME * MAX_FRAME_TOTAL;
    if (raw.length > budget) {
      // 关键：绝不能什么都不发。`publish()` 超预算时只会记一条 warn 就返回
      // false —— 手机那边等满 RPC 超时（16 s × 4 次），界面显示「连接中断」，
      // 而真正的原因永远送不到用户眼前。这里改成一个明确的 413。
      this.stats.errors += 1;
      this.lastError = `response too large (${raw.length}B)`;
      this.logger.warn(`响应 ${Math.round(raw.length / 1024)} KB 超过中继上限 ${Math.round(budget / 1024)} KB，改为回 413 告知手机`);
      const body = Buffer.from(JSON.stringify({
        ok: false,
        error: {
          code: 'response_too_large',
          message: `这次的内容太大（${Math.round(raw.length / 1024)} KB），超过了中继能搬运的上限。请在电脑上查看完整内容，或只打开最近的部分。`,
        },
      }), 'utf8');
      payload = {
        t: 'res',
        id,
        status: 413,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        enc: '',
        body: body.toString('base64'),
        ms: Number(payload?.ms) || 0,
      };
    } else if (raw.length > LARGE_RESPONSE_BYTES) {
      // 留一条可诊断的痕迹：手机端"打不开详情"时先看这一行。
      this.logger.info(`较大响应 ${Math.round(raw.length / 1024)} KB（${Math.ceil(raw.length / MAX_FRAME)} 片）`);
    }
    this.recent.set(id, { payload, at: Date.now() });
    if (this.recent.size > REPLAY_CACHE_MAX) {
      const now = Date.now();
      for (const [key, value] of this.recent) {
        if (now - value.at > REPLAY_CACHE_MS) this.recent.delete(key);
      }
      while (this.recent.size > REPLAY_CACHE_MAX) this.recent.delete(this.recent.keys().next().value);
    }
    this.publish(payload);
  }

  finishPending(id) {
    const entry = this.pending.get(id);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  clearPending() {
    for (const [, entry] of this.pending) {
      if (entry?.timer !== undefined) clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.parts.clear();
  }

  /* ------------------------------ websocket ----------------------------- */

  handleSocketOpen(message) {
    const id = String(message.id ?? '');
    if (!/^[0-9a-f]{8,32}$/u.test(id)) return;
    // A retried ws.open (lost ack) must get the ack again, not be ignored.
    const existing = this.sockets.get(id);
    if (existing !== undefined) {
      if (existing.readyState === WebSocket.OPEN) this.publish({ t: 'ws.open', id });
      return;
    }
    const target = classifyRelayTarget(message.path, 'GET');
    if (!target.ok || target.route !== 'ws') {
      this.publish({ t: 'ws.error', id, message: 'bad path' });
      return;
    }
    this.sweepSockets();
    if (this.sockets.size >= MAX_SOCKETS) this.evictOldestSocket();
    if (this.sockets.size >= MAX_SOCKETS) {
      this.logger.warn(`ws refused id=${id.slice(0, 8)} slots=${this.sockets.size}`);
      this.publish({ t: 'ws.error', id, message: 'too many channels' });
      return;
    }
    const socket = new WebSocket(`ws://127.0.0.1:${this.localPort}${target.path}`, {
      maxPayload: 4 * 1024 * 1024,
      handshakeTimeout: 15_000,
      headers: { [RELAY_HEADER]: this.relayNonce },
    });
    this.sockets.set(id, socket);
    this.socketActivity.set(id, Date.now());
    this.stats.wsOpen += 1;

    socket.on('open', () => {
      this.logger.info(`ws open id=${id.slice(0, 8)} slots=${this.sockets.size}`);
      this.touchSocket(id);
      this.publish({ t: 'ws.open', id });
    });
    socket.on('message', (data, isBinary) => {
      this.touchSocket(id);
      this.queueSocketFrame(id, {
        data: isBinary ? data.toString('base64') : data.toString('utf8'),
        bin: Boolean(isBinary),
      });
    });
    socket.on('close', (code, reason) => {
      const known = this.sockets.delete(id);
      this.socketActivity.delete(id);
      if (known) this.logger.info(`ws close id=${id.slice(0, 8)} code=${code} slots=${this.sockets.size}`);
      this.flushSocket(id);
      // Only report a close the phone did not ask for; after an eviction or a
      // client-initiated close the frame would be a duplicate.
      if (known) this.publish({ t: 'ws.close', id, code, reason: String(reason ?? '').slice(0, 120) });
    });
    socket.on('error', (error) => {
      this.sockets.delete(id);
      this.socketActivity.delete(id);
      this.publish({ t: 'ws.error', id, message: String(error?.message ?? error).slice(0, 200) });
    });
  }

  /* --------------- 僵尸隧道回收：槽位不该被死掉的手机永久占住 --------------- */

  touchSocket(id) {
    if (!this.sockets.has(id)) return;
    this.socketActivity.set(id, Date.now());
  }

  evictSocket(id, reason, code = 1001) {
    const socket = this.sockets.get(id);
    this.sockets.delete(id);
    this.socketActivity.delete(id);
    this.flushSocket(id);
    try { socket?.close(code, reason); } catch { /* 已经断了 */ }
    this.publish({ t: 'ws.close', id, code, reason });
  }

  sweepSockets(now = Date.now()) {
    for (const [id] of this.sockets) {
      const at = this.socketActivity.get(id) ?? 0;
      if (now - at > SOCKET_IDLE_MS) {
        this.logger.warn(`cloud sweeping idle channel ${id.slice(0, 8)}`);
        this.evictSocket(id, 'idle timeout');
      }
    }
  }

  evictOldestSocket(now = Date.now()) {
    let oldestId;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id] of this.sockets) {
      const at = this.socketActivity.get(id) ?? 0;
      if (at < oldestAt) { oldestAt = at; oldestId = id; }
    }
    if (oldestId === undefined) return false;
    // 刚连上不久的不抢：那可能是正在握手的新手机。
    if (now - oldestAt < SOCKET_EVICT_AFTER_MS) return false;
    this.logger.warn(`cloud channel slots full — evicting stale channel ${oldestId.slice(0, 8)}`);
    this.evictSocket(oldestId, 'evicted for a new channel');
    return true;
  }

  /** Periodic housekeeping: sockets, partial frames, replay table. */
  sweep(now = Date.now()) {
    this.sweepSockets(now);
    this.sweepParts(now);
    this.sweepSeq(now);
  }

  /**
   * Replaying a session can emit hundreds of tiny WS frames. One MQTT message
   * per frame trips public-broker rate limits, so buffer for ~40ms and send
   * the batch in a single sealed frame.
   */
  queueSocketFrame(id, frame) {
    let bucket = this.wsBuckets.get(id);
    if (bucket === undefined) {
      bucket = { frames: [], timer: undefined };
      this.wsBuckets.set(id, bucket);
    }
    bucket.frames.push(frame);
    if (bucket.frames.length >= WS_BATCH) this.flushSocket(id);
    else if (bucket.timer === undefined) {
      bucket.timer = setTimeout(() => this.flushSocket(id), WS_FLUSH_MS);
      bucket.timer.unref?.();
    }
  }

  flushSocket(id) {
    const bucket = this.wsBuckets.get(id);
    if (bucket === undefined) return;
    if (bucket.timer !== undefined) clearTimeout(bucket.timer);
    bucket.timer = undefined;
    if (bucket.frames.length === 0) {
      // Empty bucket: drop it, otherwise every tunnel leaks one forever.
      this.wsBuckets.delete(id);
      return;
    }
    const frames = bucket.frames.splice(0, bucket.frames.length);
    this.wsBuckets.delete(id);
    // A downlink frame is activity too: a receive-only tunnel must not look
    // stale to the eviction heuristic.
    this.touchSocket(id);
    this.publish({ t: 'ws.msg', id, frames });
  }

  handleSocketMessage(message) {
    const id = String(message.id ?? '');
    const socket = this.sockets.get(id);
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    this.touchSocket(id);
    if (typeof message.data === 'string' && message.data.length > 4 * 1024 * 1024) return;
    try {
      socket.send(message.bin === true ? Buffer.from(String(message.data ?? ''), 'base64') : String(message.data ?? ''));
    } catch (error) {
      this.logger.warn('cloud ws send failed', error?.message ?? error);
    }
  }

  handleSocketClose(message) {
    const id = String(message.id ?? '');
    const socket = this.sockets.get(id);
    if (socket === undefined) return;
    this.sockets.delete(id);
    this.socketActivity.delete(id);
    this.flushSocket(id);
    try { socket.close(1000, 'client closed'); } catch { /* ignore */ }
  }

  closeAllSockets(reason) {
    for (const [id, socket] of this.sockets) {
      this.sockets.delete(id);
      this.socketActivity.delete(id);
      this.flushSocket(id);
      try { socket.close(1001, reason); } catch { /* ignore */ }
      this.publish({ t: 'ws.close', id, code: 1001, reason });
    }
  }
}

export { MAX_FRAME };
