/* ============================================================
   DSH Pocket · remote shell bootstrap (browser ESM)
   ------------------------------------------------------------
   This page is static. Everything dynamic is tunnelled through an
   AES-256-GCM sealed MQTT room to the desktop bridge, which is the only
   party that can open the seal. The UI itself (app.js) is untouched by the
   transport: we shim fetch / WebSocket / EventSource and let it talk to a
   fake origin that only exists inside this document.

   Boot order (must not be reordered):
     splash -> hash validation -> sealer -> relay connect -> hello ->
     login gate -> per-tab session -> shims -> __POCKET_SHELL__ ->
     await import('./app.js')

   Rules for this file:
   - No innerHTML / insertAdjacentHTML anywhere. Every dynamic string is
     written through textContent or set as a value/property, because the
     login gate renders data that comes from the desktop (user name, error
     reasons) and from the URL.
   - No absolute paths and no absolute asset URLs: the shell may live at a
     sub-path of any static host.
   - The device token never goes to localStorage. *.github.io shares one
     origin across every project page, so a token parked there is readable
     by any sibling page (and by any XSS on one).
   ============================================================ */

/* ------------------------------- constants ------------------------------ */

/** Fake origin the shimmed UI believes it is talking to. */
const REMOTE_ORIGIN = 'https://dsh-remote.local';

/** Fallback broker: only ever carries ciphertext. Real value comes from `#s=`. */
const DEFAULT_BROKERS = ['wss://broker-cn.emqx.io:8084/mqtt'];

/** Wire protocol version. 2 added `seq`/`ts`/`sid` and the `reject` frame. */
const PROTOCOL = 2;

const HELLO_TIMEOUT_MS = 12_000;
/** hello is rate-limited to one per 10 s so two peers cannot echo each other. */
const HELLO_MIN_GAP_MS = 10_000;
/**
 * Budget for the *last* attempt (early resends use the short backoffs below),
 * so a slow route is not cut off while a lost frame still gets repaired fast.
 * The desktop caches replies by request id, so a retry replays the answer
 * instead of re-running the request.
 */
const RPC_TIMEOUT_MS = 16_000;
const RPC_ATTEMPTS = 4;
const RPC_BACKOFF_MS = [1_200, 2_400, 4_800];
/** Desktop beats every 8 s; keep 3x headroom for mobile network jitter. */
const PC_STALE_MS = 26_000;
/** A request stalled longer than this may be re-sent on the next beat. */
const BEAT_RESEND_AFTER_MS = 4_000;
/** Fragment reassembly limits, mirroring the desktop side. */
const PART_MAX_TOTAL = 64;
const PART_MAX_OPEN = 8;
const PART_TTL_MS = 30_000;
/** Largest single plaintext frame before fragmentation. */
const MAX_FRAME = 64 * 1024;

/* Storage layout. Everything is namespaced with `pocket.` (or the historical
   `dsh.pocket.` prefix the in-app UI uses) so a neighbouring project on the
   same Pages origin cannot collide with our keys. */
const SS_SESSION = 'pocket.session.v1';
/** Key the in-app UI persists its device session under (see web/store.js). */
const APP_SESSION_KEY = 'dsh.pocket.session.v1';
const LS_AUTH = 'pocket.auth.v1';
const LS_AUTH_SECRET = 'pocket.auth.secret.v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* -------------------------------- helpers ------------------------------- */

const $ = (id) => document.getElementById(id);

/** Tiny element factory: attributes, properties and text, never HTML. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value') node.value = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
  return node;
}

/** Storage access that survives private mode / disabled cookies. */
function safeStorage(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readStorage(kind, key) {
  const store = safeStorage(kind);
  if (store === null) return null;
  try { return store.getItem(key); } catch { return null; }
}

function writeStorage(kind, key, value) {
  const store = safeStorage(kind);
  if (store === null) return false;
  try { store.setItem(key, value); return true; } catch { return false; }
}

function dropStorage(kind, key) {
  const store = safeStorage(kind);
  if (store === null) return;
  try { store.removeItem(key); } catch { /* ignore */ }
}

function b64(bytes) {
  let text = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) text += String.fromCharCode(view[index]);
  return btoa(text);
}

function unb64(text) {
  const raw = atob(String(text ?? ''));
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

function unb64u(text) {
  const raw = String(text ?? '').replace(/-/gu, '+').replace(/_/gu, '/');
  return unb64(raw + '='.repeat((4 - (raw.length % 4)) % 4));
}

function randomId(bytes = 8) {
  const view = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(view, (value) => value.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------- splash -------------------------------- */

const splash = $('pocket-splash');
const splashTitle = $('pocket-splash-text');
const splashSub = $('pocket-splash-sub');
const splashExtra = $('pocket-splash-extra');

function setSplash(text, sub) {
  if (splashTitle !== null && typeof text === 'string') splashTitle.textContent = text;
  if (splashSub !== null && typeof sub === 'string') splashSub.textContent = sub;
}

function hideSplash() {
  if (splash === null) return;
  splash.classList.add('is-hidden');
}

/**
 * Terminal failure: the shell cannot go on. Keep the splash mounted (the app
 * never loads, so it is the only surface we have) and offer a retry plus a
 * manual-entry escape hatch.
 */
function showFatal(title, detail) {
  if (splash === null) return;
  splash.classList.remove('is-hidden');
  splash.classList.add('is-error');
  setSplash(title, detail ?? '');
  if (splashExtra === null) return;
  splashExtra.replaceChildren(
    el('button', { class: 'pocket-btn pocket-btn-ghost', type: 'button', text: '重新加载', onclick: () => location.reload() }),
  );
}

/* --------------------------------- guard -------------------------------- */

/**
 * `#b=` used to be a free-form redirect target: `#b=javascript:...` executed in
 * this document's origin (a same-origin XSS that can read every token), and
 * `#b=https://evil.example` turned the hosted shell into an open redirector.
 *
 * It is now accepted only when it parses to http(s), carries no userinfo, and
 * points at *this* document's origin — i.e. the value can only ever describe
 * the page we are already on. Anything else is a hard error page; we never
 * navigate on an unvalidated string.
 */
function validateLegacyBase(raw) {
  let parsed;
  try {
    parsed = new URL(raw, location.href);
  } catch {
    return { ok: false, code: 'unparsable' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, code: 'scheme' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, code: 'userinfo' };
  if (parsed.origin !== location.origin) return { ok: false, code: 'cross-origin' };
  if (parsed.port !== '' && parsed.port !== location.port) return { ok: false, code: 'port' };
  return { ok: true, origin: parsed.origin };
}

const BASE_REJECT_TEXT = {
  unparsable: '这个链接的 b 参数无法解析。',
  scheme: '这个链接使用了不被接受的协议（只允许 http/https）。',
  userinfo: '这个链接在地址里内嵌了用户名或密码，已被拒绝。',
  'cross-origin': '这个链接试图跳转到另一台服务器，已被拒绝。',
  port: '这个链接使用了不匹配的端口，已被拒绝。',
};

/** Validate the broker hint from `#s=`; a bad hint just falls back to default. */
function resolveBrokerHint(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.protocol === 'wss:') return parsed.href;
  // Plain ws:// only for the loopback broker during local development.
  if (parsed.protocol === 'ws:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')) return parsed.href;
  return null;
}

/* ------------------------------- crypto --------------------------------- */

async function makeSealer(keyB64, room) {
  const keyBytes = unb64u(keyB64);
  if (keyBytes.length !== 32) throw new Error('密钥长度不正确');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return {
    async seal(object, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify(object));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, plaintext);
      return JSON.stringify({ v: 1, n: b64(iv), c: b64(new Uint8Array(sealed)) });
    },
    async unseal(text, aad) {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('信封版本不正确');
      const iv = unb64(parsed.n);
      const blob = unb64(parsed.c);
      if (iv.length !== 12 || blob.length <= 16) throw new Error('信封内容不正确');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, blob);
      return JSON.parse(decoder.decode(plaintext));
    },
    room,
  };
}

/* --------------------------- login token at rest ------------------------ */

/*
 * The 15-day login token is a bearer credential, so it is sealed with
 * AES-256-GCM before it touches localStorage. The wrapping key lives on the
 * same device: this defeats "open devtools, copy the string", not a script
 * already running on this origin — that is what the CSP and the no-innerHTML
 * rule are for. Sealing rather than session-scoping is deliberate: the product
 * promise is "登录一次，记住 15 天", and a per-tab key would break it every
 * time the browser is closed.
 */
async function deriveAuthKey(create) {
  let secret = readStorage('local', LS_AUTH_SECRET);
  if (secret === null && create) {
    secret = b64(crypto.getRandomValues(new Uint8Array(32)));
    if (!writeStorage('local', LS_AUTH_SECRET, secret)) return null;
  }
  if (secret === null) return null;
  if (crypto?.subtle === undefined) return null;
  const material = await crypto.subtle.importKey('raw', unb64(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('dsh-pocket/auth/v1'),
      info: encoder.encode('login-session'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function saveAuthSession(session) {
  const payload = encoder.encode(JSON.stringify({ ...session, at: Date.now() }));
  if (crypto?.subtle !== undefined) {
    try {
      const key = await deriveAuthKey(true);
      if (key !== null) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
        const record = { v: 1, iv: b64(iv), ct: b64(new Uint8Array(sealed)) };
        if (writeStorage('local', LS_AUTH, JSON.stringify(record))) return;
      }
    } catch { /* fall through to the session-only copy */ }
  }
  // No WebCrypto (or storage refused): keep the token in this tab only.
  writeStorage('session', `${LS_AUTH}.plain`, JSON.stringify(session));
}

async function loadAuthSession() {
  const raw = readStorage('local', LS_AUTH);
  if (raw === null) {
    const plain = readStorage('session', `${LS_AUTH}.plain`);
    return plain === null ? null : parseAuthSession(plain);
  }
  try {
    const record = JSON.parse(raw);
    if (record === null || typeof record !== 'object' || record.v !== 1) return null;
    const key = await deriveAuthKey(false);
    if (key === null) return null;
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, key, unb64(record.ct));
    return parseAuthSession(decoder.decode(plaintext));
  } catch {
    // Wrong key (fresh browser session) or tampered record: drop it.
    dropStorage('local', LS_AUTH);
    return null;
  }
}

function parseAuthSession(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.token !== 'string' || parsed.token.length < 20) return null;
    const expiresAt = Number(parsed.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt <= Date.now()) return null;
    return { token: parsed.token, expiresAt, user: String(parsed.user ?? '') };
  } catch {
    return null;
  }
}

function clearAuthSession() {
  dropStorage('local', LS_AUTH);
  dropStorage('session', `${LS_AUTH}.plain`);
}

/* ---------------------------- device session ---------------------------- */

function saveDeviceSession(session) {
  const text = JSON.stringify(session);
  writeStorage('local', SS_SESSION, text);
  writeStorage('local', APP_SESSION_KEY, text);
}

function clearDeviceSession() {
  // Drop both prefixes and both storage kinds: an older build may have left a
  // copy anywhere among them.
  for (const kind of ['local', 'session']) {
    dropStorage(kind, SS_SESSION);
    dropStorage(kind, APP_SESSION_KEY);
    dropStorage(kind, 'dsh.bridge.session.v1');
  }
}

/* ------------------------------- 登录闸门 ------------------------------- */

const LOGIN_ERROR_TEXT = {
  locked: (reply) => `失败次数太多，请 ${Math.ceil(Number(reply.retryAfterSec ?? 300) / 60)} 分钟后再试`,
  timeout: () => '电脑端没有回应，检查网络后重试',
  'send-failed': () => '中继还没连上，稍后重试',
  disabled: () => '电脑端没有启用访问口令',
};

/**
 * The gate: no valid token, no UI. app.js is not imported until this resolves
 * true, so this is a real boundary rather than a visual overlay.
 */
function showLoginGate(relay, { user = '', reason = '' } = {}) {
  return new Promise((resolve) => {
    const errorBox = el('p', { class: 'pocket-error', role: 'alert', text: reason });
    const userInput = el('input', {
      class: 'pocket-input',
      id: 'pocket-user',
      type: 'text',
      name: 'username',
      autocomplete: 'username',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      placeholder: '电脑上设置的用户名',
      value: user,
    });
    const passInput = el('input', {
      class: 'pocket-input',
      id: 'pocket-pass',
      type: 'password',
      name: 'password',
      autocomplete: 'current-password',
      placeholder: '访问口令',
    });
    const revealButton = el('button', {
      class: 'pocket-reveal',
      type: 'button',
      'aria-label': '显示口令',
      text: '显示',
      onclick: () => {
        const shown = passInput.type === 'text';
        passInput.type = shown ? 'password' : 'text';
        revealButton.textContent = shown ? '显示' : '隐藏';
        revealButton.setAttribute('aria-label', shown ? '显示口令' : '隐藏口令');
        passInput.focus();
      },
    });
    const remember = el('input', { id: 'pocket-remember', type: 'checkbox', checked: 'checked' });
    const submit = el('button', { class: 'pocket-btn pocket-btn-primary', type: 'submit', text: '登录' });
    const form = el('form', { class: 'pocket-card pocket-login', id: 'pocket-login-form', novalidate: 'novalidate' }, [
      el('div', { class: 'pocket-mark', 'aria-hidden': 'true' }),
      el('h1', { class: 'pocket-title', text: '连接我的电脑' }),
      el('p', { class: 'pocket-sub', text: '这台手机还没有登录。输入电脑上设置的用户名和访问口令。' }),
      el('label', { class: 'pocket-label', for: 'pocket-user', text: '用户名' }),
      userInput,
      el('label', { class: 'pocket-label', for: 'pocket-pass', text: '访问口令' }),
      el('div', { class: 'pocket-passwrap' }, [passInput, revealButton]),
      el('label', { class: 'pocket-remember', for: 'pocket-remember' }, [remember, el('span', { text: '在这台手机上记住我 15 天' })]),
      el('p', { class: 'pocket-note', text: '登录凭据加密保存在本机，有效期 15 天；换设备或清理浏览器数据后需要重新登录。' }),
      errorBox,
      submit,
    ]);
    const layer = el('div', { class: 'pocket-gate', id: 'pocket-login', role: 'dialog', 'aria-modal': 'true' }, [form]);
    document.body.append(layer);
    if (userInput.value === '') userInput.focus(); else passInput.focus();

    let busy = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      const name = userInput.value.trim();
      const password = passInput.value;
      if (name.length === 0 || password.length === 0) {
        errorBox.textContent = '用户名和口令都要填';
        errorBox.classList.add('is-visible');
        (name.length === 0 ? userInput : passInput).focus();
        return;
      }
      busy = true;
      submit.disabled = true;
      submit.textContent = '登录中…';
      errorBox.textContent = '';
      errorBox.classList.remove('is-visible');
      const reply = await relay.login({ user: name, password, remember: remember.checked });
      if (reply.ok === true && typeof reply.token === 'string') {
        const session = { token: reply.token, expiresAt: Number(reply.expiresAt) || 0, user: name };
        await saveAuthSession(session);
        relay.session = session;
        layer.remove();
        resolve(true);
        return;
      }
      busy = false;
      submit.disabled = false;
      submit.textContent = '登录';
      passInput.value = '';
      const text = (LOGIN_ERROR_TEXT[String(reply.reason)] ?? (() => '用户名或口令不对'))(reply);
      errorBox.textContent = text;
      errorBox.classList.add('is-visible');
      passInput.focus();
    });
  });
}

/* ------------------------------ status chrome --------------------------- */

let bannerNode = null;

/** Offline / stale banner: the relay is up but the desktop stopped talking. */
function setBanner(text) {
  if (text === null || text === undefined) {
    if (bannerNode !== null) {
      bannerNode.remove();
      bannerNode = null;
    }
    return;
  }
  if (bannerNode === null) {
    bannerNode = el('div', { class: 'pocket-banner', id: 'pocket-banner', role: 'status', 'aria-live': 'polite' });
    document.body.append(bannerNode);
  }
  bannerNode.textContent = text;
}

/* ------------------------------ transport ------------------------------- */

class Relay {
  constructor({ room, sealer, brokers, phoneName = '手机' }) {
    this.room = room;
    this.sealer = sealer;
    this.brokers = brokers;
    this.phoneName = phoneName;
    this.upTopic = `dshm/${room}/u`;
    this.downTopic = `dshm/${room}/d`;
    this.client = undefined;
    this.ready = false;
    this.pending = new Map();
    this.parts = new Map();
    this.sockets = new Map();
    this.pcHello = null;
    this.pcSeenAt = 0;
    this.pcStale = false;
    this.pcVersion = 0;
    this.staleTimer = undefined;
    /** Monotonic per-page-load request sequence + the session id it belongs to. */
    this.sid = randomId(4);
    this.seq = 0;
    /** `ts` is sent in the desktop's clock domain to survive phone clock skew. */
    this.clockOffset = 0;
    this.lastHelloAt = 0;
    this.onpc = () => {};
    this.onstate = () => {};
    this.onpcStale = () => {};
    this.onunauthorized = () => {};
    /** 15-day login token, loaded before the first `auth` exchange. */
    this.session = null;
    this.authRequired = false;
    this.authUser = null;
    this.authWaiter = undefined;
    this.loginWaiter = undefined;
    this.stats = { rx: 0, tx: 0, err: 0, stale: 0, lastError: '', lastRxAt: 0 };
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  /** Best estimate of the desktop's clock, in ms. */
  serverNow() {
    return Date.now() + this.clockOffset;
  }

  async connect() {
    let lastError;
    for (const broker of this.brokers) {
      try {
        await this.connectOne(broker);
        return broker;
      } catch (error) {
        lastError = error;
        console.warn('[pocket] broker failed', broker, error?.message);
      }
    }
    throw lastError ?? new Error('无法连接云端中继，请检查网络');
  }

  connectOne(broker) {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(broker, {
        clientId: `pocket_${randomId(6)}`,
        clean: true,
        keepalive: 40,
        reconnectPeriod: 3_000,
        connectTimeout: 12_000,
        protocolVersion: 4,
      });
      this.client = client;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { client.end(true); } catch { /* ignore */ }
        reject(new Error('连接超时'));
      }, 13_000);

      client.on('connect', () => {
        this.onstate('online');
        client.subscribe(this.downTopic, { qos: 1 }, (error) => {
          if (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
            return;
          }
          this.ready = true;
          // Every (re)connect announces: the desktop may have restarted and
          // forgotten us. announce() self-throttles to one hello per 10 s.
          this.announce();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(broker);
        });
      });
      client.on('message', (_topic, payload) => { void this.onMessage(payload); });
      client.on('error', (error) => { console.warn('[pocket] mqtt error', error?.message); });
      client.on('close', () => {
        this.ready = false;
        this.onstate('offline');
        this.failAll('中继连接中断');
      });
    });
  }

  /** Rate-limited presence ping (<= 1 per 10 s) to avoid a hello echo storm. */
  announce(force = false) {
    const now = Date.now();
    if (!force && now - this.lastHelloAt < HELLO_MIN_GAP_MS) return;
    this.lastHelloAt = now;
    void this.send({ t: 'hello', name: this.phoneName, ver: PROTOCOL, ts: this.serverNow() }).catch(() => {});
  }

  /**
   * The desktop beats every 8 s. While the broker connection itself is up the
   * MQTT 'close' event never fires, so "desktop is dead" is only observable as
   * silence on the downlink.
   */
  startStaleWatch() {
    if (this.staleTimer !== undefined) return;
    this.staleTimer = setInterval(() => {
      if (this.pcSeenAt === 0) return;
      const idle = Date.now() - this.pcSeenAt;
      const stale = idle > PC_STALE_MS;
      if (stale !== this.pcStale) {
        this.pcStale = stale;
        this.onpcStale(stale, stale
          ? `电脑端已离线 ${Math.round(idle / 1000)} 秒 · 正在重连…（列表可能不是最新）`
          : null);
      }
    }, 2_000);
  }

  async onMessage(payload) {
    let message;
    try {
      message = await this.sealer.unseal(decoder.decode(payload), this.downTopic);
    } catch (error) {
      this.stats.err += 1;
      this.stats.lastError = `unseal: ${error?.message}`;
      return; // wrong key / corrupted frame: ignore
    }
    this.stats.rx += 1;
    this.stats.lastRxAt = Date.now();
    if (message === null || typeof message !== 'object') return;

    if (message.t === 'part') {
      const merged = this.collectPart(message);
      if (merged === null) return;
      message = merged;
    }
    if (message === null || typeof message !== 'object') return;

    switch (message.t) {
      case 'hello':
      case 'beat': {
        this.noteDesktopAlive(message);
        // The heartbeat is proof the downlink works: re-send anything that has
        // been waiting, but only if it is genuinely stalled (the desktop is
        // idempotent per request id, so a re-send cannot double-execute).
        for (const [, pending] of this.pending) {
          if (Date.now() - pending.at > BEAT_RESEND_AFTER_MS) pending.retry?.();
        }
        break;
      }
      case 'res': {
        const entry = this.pending.get(String(message.id ?? ''));
        if (entry === undefined) return;
        this.pending.delete(entry.id);
        clearTimeout(entry.timer);
        // Expired/revoked token: the desktop answers 401, so drop the local
        // session and go back to the gate instead of spinning.
        if (Number(message.status) === 401) this.onunauthorized?.();
        entry.resolve(message);
        break;
      }
      case 'reject': {
        const entry = this.pending.get(String(message.id ?? ''));
        if (entry === undefined) return;
        this.stats.stale += 1;
        if (String(message.code) === 'stale') {
          // Same id (idempotent), fresh seq/ts — exactly what a retry must do.
          entry.retry?.();
          return;
        }
        this.pending.delete(entry.id);
        clearTimeout(entry.timer);
        entry.reject(new Error(`中继拒绝了请求（${String(message.code ?? 'unknown')}）`));
        break;
      }
      case 'auth': {
        this.authRequired = message.required === true;
        this.authUser = typeof message.user === 'string' ? message.user : null;
        if (message.ok === true && Number(message.expiresAt) > 0 && this.session !== null) {
          this.session.expiresAt = Number(message.expiresAt);
          void saveAuthSession(this.session);
        }
        this.authWaiter?.({ required: this.authRequired, ok: message.ok === true, user: this.authUser });
        break;
      }
      case 'login': {
        this.loginWaiter?.(message);
        break;
      }
      case 'ws.open': {
        const socket = this.sockets.get(String(message.id ?? ''));
        if (socket !== undefined) socket._open();
        break;
      }
      case 'ws.msg': {
        const socket = this.sockets.get(String(message.id ?? ''));
        if (socket === undefined) break;
        if (Array.isArray(message.frames)) {
          for (const frame of message.frames) socket._message(frame);
        } else {
          socket._message(message);
        }
        break;
      }
      case 'ws.close':
      case 'ws.error': {
        const socket = this.sockets.get(String(message.id ?? ''));
        if (socket !== undefined) socket._close(message.code ?? 1001, message.reason ?? message.message ?? '');
        break;
      }
      default:
        break;
    }
  }

  noteDesktopAlive(message) {
    this.pcHello = { name: String(message.name ?? '电脑'), at: Date.now() };
    this.pcSeenAt = Date.now();
    // `beat` carries `ver` too; keep the last known value when it is absent so
    // a heartbeat cannot erase what the hello told us.
    const ver = Number(message.ver);
    if (Number.isFinite(ver) && ver > 0) this.pcVersion = ver;
    const serverTs = Number(message.ts);
    if (Number.isFinite(serverTs) && serverTs > 0) {
      const offset = serverTs - Date.now();
      // Only correct the clock domain when it actually moved: a jittery offset
      // would otherwise shift every `ts` we send.
      if (Math.abs(offset - this.clockOffset) > 500) this.clockOffset = offset;
    }
    this.onpc(this.pcHello);
  }

  /** Reassemble a fragmented payload; null means "not complete yet". */
  collectPart(message) {
    const id = String(message.id ?? '');
    if (!/^[0-9a-f]{12}$/u.test(id)) return null;
    const seq = Number(message.seq);
    const total = Number(message.total);
    if (!Number.isInteger(seq) || !Number.isInteger(total)) return null;
    if (total < 1 || total > PART_MAX_TOTAL || seq < 0 || seq >= total) return null;
    const now = Date.now();
    for (const [key, entry] of this.parts) {
      if (now - entry.at > PART_TTL_MS) this.parts.delete(key);
    }
    const key = `part:${id}`;
    let entry = this.parts.get(key);
    if (entry === undefined) {
      if (this.parts.size >= PART_MAX_OPEN) return null;
      entry = { chunks: new Array(total), total, at: now };
      this.parts.set(key, entry);
    }
    if (entry.total !== total) return null;
    entry.chunks[seq] = unb64(message.d);
    entry.at = now;
    for (const chunk of entry.chunks) if (chunk === undefined) return null;
    this.parts.delete(key);
    const merged = new Uint8Array(entry.chunks.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of entry.chunks) {
      merged.set(part, offset);
      offset += part.length;
    }
    try {
      return JSON.parse(decoder.decode(merged));
    } catch {
      return null;
    }
  }

  async send(object) {
    if (this.client === undefined || !this.ready) throw new Error('中继尚未就绪');
    // The token rides on every uplink message: the desktop validates each one
    // statelessly, so a relay restart cannot lose the login.
    const payload = this.session !== null && object.token === undefined
      ? { ...object, token: this.session.token }
      : { ...object };
    const raw = encoder.encode(JSON.stringify(payload));
    this.stats.tx += 1;
    if (raw.length <= MAX_FRAME) {
      this.client.publish(this.upTopic, await this.sealer.seal(payload, this.upTopic), { qos: 1 });
      return;
    }
    // Uplink fragmentation: the old shell published large frames as a single
    // packet, which the public broker silently dropped.
    const chunkId = randomId(6);
    const total = Math.ceil(raw.length / MAX_FRAME);
    if (total > PART_MAX_TOTAL) throw new Error('请求体过大');
    for (let index = 0; index < total; index += 1) {
      const slice = raw.subarray(index * MAX_FRAME, (index + 1) * MAX_FRAME);
      const part = {
        t: 'part',
        id: chunkId,
        seq: index,
        total,
        d: b64(slice),
      };
      this.client.publish(this.upTopic, await this.sealer.seal(part, this.upTopic), { qos: 1 });
    }
  }

  /** Ask the desktop whether this link needs a login and whether ours works. */
  checkAuth(timeoutMs = 8_000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        this.authWaiter = undefined;
        resolve(value);
      };
      this.authWaiter = done;
      this.send({ t: 'auth' }).catch(() => done({ required: false, ok: true }));
      setTimeout(() => done({ required: this.authRequired, ok: !this.authRequired }), timeoutMs);
    });
  }

  /** Trade a password for a session token. */
  login({ user, password, remember = true, timeoutMs = 15_000 }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        this.loginWaiter = undefined;
        resolve(value);
      };
      this.loginWaiter = done;
      this.send({ t: 'login', user, password, remember, phone: this.phoneName })
        .catch((error) => done({ ok: false, reason: 'send-failed', message: String(error?.message ?? error) }));
      setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs);
    });
  }

  failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.parts.clear();
    for (const [, socket] of this.sockets) socket._close(1001, reason);
  }

  /**
   * fetch()-lookalike over the relay with same-id retries. The desktop keeps a
   * short response cache keyed by request id, so a resend after a lost frame
   * replays the answer instead of re-running the request (POST included).
   *
   * Every attempt mints a *new* `seq`/`ts` (replay guard) while keeping the
   * same `id` (idempotency) — the two mechanisms are independent.
   */
  async request({ method, path, headers, body, gzip, signal, timeout = RPC_TIMEOUT_MS, attempts = RPC_ATTEMPTS }) {
    const id = randomId(8);
    let encoded = '';
    if (typeof body === 'string') encoded = b64(encoder.encode(body));
    else if (body instanceof Uint8Array) encoded = b64(body);
    return new Promise((resolve, reject) => {
      let attempt = 0;
      let settled = false;
      const entry = { id, at: Date.now(), timer: undefined, resolve: undefined, reject: undefined, retry: undefined };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        fn(value);
      };
      entry.resolve = (message) => finish(resolve, message);
      entry.reject = (error) => finish(reject, error);
      this.pending.set(id, entry);

      const abort = () => entry.reject(new DOMException('请求已取消', 'AbortError'));
      if (signal !== undefined && signal !== null) {
        if (signal.aborted === true) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      }

      // 前几次重发要快：首个请求常常正好撞上电脑端重连，4 s 才重试会把冷启动拖到 20 s+。
      const attemptOnce = () => {
        attempt += 1;
        entry.at = Date.now();
        // Single timer per request: the old build left the previous timeout
        // armed and burned through the attempt budget.
        clearTimeout(entry.timer);
        this.send({
          t: 'req',
          id,
          sid: this.sid,
          seq: this.nextSeq(),
          ts: this.serverNow(),
          method,
          path,
          headers,
          body: encoded,
          gzip,
        }).catch((error) => entry.reject(error));
        // Early duplicates repair a lost frame in a second or two; the *last*
        // attempt still gets the full per-request budget, because a slow route
        // (a long task list, a POST that spawns an agent) is not a lost frame.
        const delay = attempt < attempts ? (RPC_BACKOFF_MS[attempt - 1] ?? 2_000) : timeout;
        entry.timer = setTimeout(() => {
          if (settled) return;
          if (attempt < attempts) attemptOnce();
          else entry.reject(new Error('中继请求超时'));
        }, delay);
      };
      entry.retry = () => { if (!settled && attempt < attempts) attemptOnce(); };
      attemptOnce();
    });
  }

  openSocket(id, path) {
    return this.send({
      t: 'ws.open',
      id,
      sid: this.sid,
      seq: this.nextSeq(),
      ts: this.serverNow(),
      path,
    });
  }

  closeSocket(id) {
    return this.send({ t: 'ws.close', id }).catch(() => {});
  }
}

/* -------------------------------- shims --------------------------------- */

function installFetch(relay) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function pocketFetch(input, init = {}) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const raw = typeof input === 'string' ? input : (isRequest ? input.url : String(input?.url ?? input));
    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      return nativeFetch(input, init);
    }
    // Only *our* origins are tunnelled. The old build keyed on
    // `pathname.startsWith('/api/')` alone, which turned any third-party
    // absolute URL into a request against the local bridge.
    const isRelayOrigin = url.origin === REMOTE_ORIGIN;
    const isShellOriginApi = url.origin === location.origin
      && (url.pathname.startsWith('/api/') || url.pathname === '/healthz');
    if (!isRelayOrigin && !isShellOriginApi) return nativeFetch(input, init);

    const headers = {};
    const source = init.headers ?? (isRequest ? input.headers : undefined);
    if (source instanceof Headers) source.forEach((value, name) => { headers[name] = value; });
    else if (source !== undefined) for (const [name, value] of Object.entries(source)) if (typeof value === 'string') headers[name] = value;

    let body;
    const rawBody = init.body;
    if (typeof rawBody === 'string') body = rawBody;
    else if (rawBody instanceof URLSearchParams) body = rawBody.toString();
    else if (rawBody instanceof Uint8Array) body = rawBody;
    else if (rawBody instanceof ArrayBuffer) body = new Uint8Array(rawBody);
    else if (typeof Blob !== 'undefined' && rawBody instanceof Blob) body = new Uint8Array(await rawBody.arrayBuffer());

    const reply = await relay.request({
      method: String(init.method ?? (isRequest ? input.method : 'GET')).toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers,
      body,
      signal: init.signal,
      gzip: typeof DecompressionStream === 'function',
    });
    let bytes = unb64(reply.body ?? '');
    if (reply.enc === 'gzip' && typeof DecompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const outHeaders = new Headers();
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      try { outHeaders.set(name, value); } catch { /* forbidden header name */ }
    }
    const status = Number(reply.status) || 200;
    const noBody = status === 204 || status === 205 || status === 304;
    return new Response(noBody ? null : bytes, { status, statusText: '', headers: outHeaders });
  };
}

function installWebSocket(relay) {
  class PocketWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = PocketWebSocket.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.id = randomId(8);
      this.binaryType = 'blob';
      this.protocol = '';
      this.extensions = '';
      relay.sockets.set(this.id, this);
      let path = '/ws';
      try {
        const parsed = new URL(this.url, REMOTE_ORIGIN);
        path = `${parsed.pathname}${parsed.search}`;
      } catch { /* keep /ws */ }
      relay.openSocket(this.id, path).catch(() => this._close(1006, 'open failed'));
      // A real WebSocket cannot hang in CONNECTING forever either: fail fast so
      // the upper layer retries instead of showing "connecting" indefinitely.
      this.openTimer = setTimeout(() => {
        if (this.readyState === PocketWebSocket.CONNECTING) this._close(1006, 'open timeout');
      }, 12_000);
    }

    _emit(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === 'function') {
        try { handler.call(this, event); } catch (error) { console.error(error); }
      }
      this.dispatchEvent(event);
    }

    _open() {
      if (this.readyState !== PocketWebSocket.CONNECTING) return;
      if (this.openTimer !== undefined) { clearTimeout(this.openTimer); this.openTimer = undefined; }
      this.readyState = PocketWebSocket.OPEN;
      this._emit('open', new Event('open'));
    }

    _message(message) {
      const data = message.bin === true ? unb64(message.data) : String(message.data ?? '');
      this._emit('message', new MessageEvent('message', { data }));
    }

    _close(code = 1000, reason = '') {
      if (this.readyState === PocketWebSocket.CLOSED) return;
      if (this.openTimer !== undefined) { clearTimeout(this.openTimer); this.openTimer = undefined; }
      this.readyState = PocketWebSocket.CLOSED;
      relay.sockets.delete(this.id);
      this._emit('close', new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
    }

    send(data) {
      if (this.readyState !== PocketWebSocket.OPEN) throw new Error('WebSocket 未连接');
      if (typeof data === 'string') {
        void this._sendFrame(false, data);
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        void data.arrayBuffer()
          .then((buffer) => this._sendFrame(true, b64(new Uint8Array(buffer))))
          .catch(() => {});
        return;
      }
      if (data instanceof ArrayBuffer) {
        void this._sendFrame(true, b64(new Uint8Array(data)));
        return;
      }
      const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (view === null) throw new TypeError('WebSocket.send: 不支持的数据类型');
      void this._sendFrame(true, b64(view));
    }

    async _sendFrame(bin, data) {
      try {
        await relay.send({ t: 'ws.msg', id: this.id, bin, data });
      } catch (error) {
        console.warn('[pocket] ws send failed', error?.message);
      }
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= PocketWebSocket.CLOSING) return;
      this.readyState = PocketWebSocket.CLOSING;
      void relay.closeSocket(this.id);
      setTimeout(() => this._close(code, reason), 0);
    }
  }

  PocketWebSocket.CONNECTING = 0;
  PocketWebSocket.OPEN = 1;
  PocketWebSocket.CLOSING = 2;
  PocketWebSocket.CLOSED = 3;
  window.WebSocket = PocketWebSocket;
  // The SSE fallback cannot work through the relay; make app.js go straight
  // back to the WebSocket reconnect path instead of failing twice.
  try { Object.defineProperty(window, 'EventSource', { value: undefined, writable: true, configurable: true }); } catch { window.EventSource = undefined; }
}

function installShims(relay) {
  installFetch(relay);
  installWebSocket(relay);
}

/* ---------------------------- offline shell ----------------------------- */

/**
 * app.js registers `/app/sw.js` — the LAN layout, where the UI is mounted under
 * /app/. In remote mode the shell *is* the root, so the worker has to come from
 * `./sw.js`. Registering it here keeps offline mode working even if the app
 * forgets to honour `__POCKET_SHELL__.swUrl`; registering the same URL twice is
 * a no-op, and a failure must never block the boot.
 */
function registerShellWorker() {
  if (!('serviceWorker' in navigator) || window.isSecureContext !== true) return;
  void navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.warn('[pocket] shell worker not registered', error?.message);
  });
}

/* ------------------------------ manual entry ---------------------------- */

function renderManualEntry(reason) {
  hideSplash();
  const input = el('input', {
    class: 'pocket-input',
    id: 'pocket-manual-input',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: '粘贴电脑上显示的远程链接',
  });
  // The hash is a value, never markup: URLSearchParams encodes it and we only
  // ever assign it to an input value.
  input.value = new URLSearchParams(location.hash.slice(1)).toString();
  const form = el('form', { class: 'pocket-card', id: 'pocket-manual-form' }, [
    el('h1', { class: 'pocket-title', text: '连接你的电脑' }),
    el('p', { class: 'pocket-sub', text: reason }),
    input,
    el('button', { class: 'pocket-btn pocket-btn-primary', type: 'submit', text: '连接' }),
    el('small', { class: 'pocket-note', text: '链接在电脑端「配对页 → 远程访问」里，形如 …/#r=…&k=…&t=…' }),
  ]);
  const layer = el('div', { class: 'pocket-gate', id: 'pocket-manual' }, [form]);
  document.body.append(layer);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value.length === 0) return;
    const next = value.includes('#') ? value.slice(value.indexOf('#') + 1) : value.replace(/^#/u, '');
    if (next.length === 0) return;
    location.hash = next;
    location.reload();
  });
  setTimeout(() => input.focus(), 50);
}

/* --------------------------------- boot --------------------------------- */

function closeChannels(relay) {
  for (const [, socket] of relay.sockets) void relay.closeSocket(socket.id);
}

async function main() {
  const params = new URLSearchParams(location.hash.slice(1));

  // Legacy `#b=`: validated, never trusted. Same-origin + http(s) only.
  const legacyBase = params.get('b');
  if (legacyBase !== null && legacyBase.length > 0) {
    const verdict = validateLegacyBase(legacyBase);
    if (verdict.ok !== true) {
      showFatal('链接参数无法验证', BASE_REJECT_TEXT[verdict.code] ?? '这个链接不被接受。');
      return;
    }
    // Accepted (it points back at this very origin): nothing to jump to, the
    // shell is the app. Fall through to the normal flow.
  }

  const room = params.get('r');
  const key = params.get('k');
  const token = params.get('t');
  const name = params.get('n') ?? 'DSH';

  if (!room || !key || !token) {
    renderManualEntry('这个页面需要电脑端生成的远程链接才能工作。');
    return;
  }

  const hint = resolveBrokerHint(params.get('s'));
  const brokers = hint === null ? DEFAULT_BROKERS.slice() : [hint, ...DEFAULT_BROKERS.filter((item) => item !== hint)];

  // The MQTT client is a classic script loaded before this module; without it
  // nothing below can work, so fail with a human sentence instead of a
  // ReferenceError deep inside connect().
  if (typeof globalThis.mqtt?.connect !== 'function') {
    showFatal('中继组件没有加载', '页面资源不完整（mqtt.min.js 未加载），请刷新重试');
    return;
  }

  setSplash('正在连接电脑…', '通过加密中继建立通道');
  let sealer;
  try {
    sealer = await makeSealer(key, room);
  } catch (error) {
    showFatal('链接密钥无效', String(error?.message ?? error));
    return;
  }

  const relay = new Relay({ room, sealer, brokers });
  relay.session = await loadAuthSession();
  window.__POCKET_RELAY__ = relay;

  // 页面被关掉 / 切到后台时，尽力把隧道关掉，别让电脑端留着僵尸槽位。
  // 手机被强杀时这段不会执行——所以电脑侧还有一层按活动时间的槽位回收。
  const release = () => closeChannels(relay);
  window.addEventListener('pagehide', release);
  window.addEventListener('beforeunload', release);

  relay.onpc = (pc) => setSplash(`已连接 ${pc.name}`, '正在同步任务…');
  // One banner, two conditions: the relay link is down, or the desktop stopped
  // talking. The link being down always wins.
  let relayOffline = false;
  let staleText = null;
  const renderBanner = () => {
    if (relayOffline) { setBanner('中继断开，正在重连…'); return; }
    setBanner(staleText);
  };
  relay.onstate = (state) => {
    relayOffline = state === 'offline';
    if (relayOffline) setSplash('中继断开，正在重连…', '网络切换后会自行恢复');
    renderBanner();
  };
  relay.onpcStale = (stale, text) => {
    staleText = stale ? text : null;
    renderBanner();
  };

  try {
    await relay.connect();
  } catch (error) {
    showFatal('无法建立中继连接', String(error?.message ?? error));
    return;
  }
  relay.startStaleWatch();

  await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (relay.pcHello !== null || Date.now() - started > HELLO_TIMEOUT_MS) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
    // Self-throttled (<= 1 per 10 s): connectOne() already announced, so this
    // normally becomes a no-op rather than a second hello.
    relay.announce();
  });

  if (relay.pcHello === null) {
    showFatal('电脑端没有响应', '确认电脑上的 DSH 正在运行，且「远程访问」已开启');
    return;
  }
  if (relay.pcVersion > 0 && relay.pcVersion < PROTOCOL) {
    console.warn(`[pocket] desktop speaks protocol ${relay.pcVersion}, shell speaks ${PROTOCOL}`);
  }

  // Login gate: no valid token, no UI. The 15-day token is encrypted at rest.
  const authState = await relay.checkAuth();
  if (authState.required && !authState.ok) {
    relay.onunauthorized = () => {
      clearAuthSession();
      relay.session = null;
    };
    hideSplash();
    const passed = await showLoginGate(relay, {
      user: authState.user ?? '',
      reason: relay.session === null ? '' : '登录已过期，请重新登录',
    });
    if (!passed) {
      showFatal('需要登录', '没有登录就无法访问这台电脑');
      return;
    }
  } else if (authState.required) {
    relay.onunauthorized = () => {
      clearAuthSession();
      relay.session = null;
      void showLoginGate(relay, { user: authState.user ?? '', reason: '登录已过期，请重新登录' })
        .then((ok) => { if (ok) location.reload(); });
    };
  }

  // Device session: per tab only. The device token comes from the link, so
  // nothing has to survive the tab; app.js needs a session record to build its
  // Authorization header.
  saveDeviceSession({
    baseUrl: REMOTE_ORIGIN,
    token,
    server: { name },
    remote: { room: room.slice(0, 6) },
    at: Date.now(),
  });

  installShims(relay);
  hideSplash();
  registerShellWorker();

  // Contract with web/app.js: set before the import, read at module evaluation.
  globalThis.__POCKET_SHELL__ = {
    mode: 'remote',
    baseUrl: REMOTE_ORIGIN,
    swUrl: './sw.js',
    assetBase: './',
  };

  try {
    await import('./app.js');
  } catch (error) {
    clearDeviceSession();
    showFatal('界面加载失败', String(error?.message ?? error));
  }
}

void main();
