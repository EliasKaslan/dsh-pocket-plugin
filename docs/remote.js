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
     login gate -> device token (from the login/auth reply) -> shims ->
     __POCKET_SHELL__ -> await import('./app.js')

   Rules for this file:
   - No innerHTML / insertAdjacentHTML anywhere. Every dynamic string is
     written through textContent or set as a value/property, because the
     login gate renders data that comes from the desktop (user name, error
     reasons) and from the URL.
   - No absolute paths and no absolute asset URLs: the shell may live at a
     sub-path of any static host.
   - 口令是唯一凭据：登录成功时桌面随应答下发这台手机**自己的**设备令牌，
     外壳把它交给 app.js（`__POCKET_SHELL__.deviceToken`）。令牌只写在 app
     自己的 `dsh.pocket.*` / `pocket.*` 键里，为的是刷新页面不用重新登记一台
     设备；它在电脑端「移除设备」后立即作废 —— 外壳会把本地那份一起丢掉，
     并要求重新用口令登录。
   - 但**链接本身会被明文记住**（见 `storeLink()` / `LINK_KEY`）：为了让 PWA
     从桌面图标启动（`manifest.start_url` 带不了 hash）与"浏览器退出再进来"还能
     直接进，外壳把整条 `#r=…&k=…&t=…` 存进本机 localStorage。`k` 就是房间里
     那把 AES-256-GCM 密钥，所以这是**把解密能力放到本机**：本页所在 origin 上
     的任何脚本都能读到它。这正是外壳必须与 app 同源托管、且不接任何第三方脚本
     的原因（见 `remote/index.html` 的 CSP `script-src 'self'`）。
     彻底作废的办法是电脑端「重置链接」——换房间后旧链接立即失效。
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
/**
 * 未就绪时发送前的等待窗口。
 *
 * App 启动后约 0.4 s 就会发起首次建联，而中继要等公共 broker 连上才算就绪
 * （实测真实环境 1~2 s）。没有这个窗口，首次请求必然撞上"中继尚未就绪"而失败，
 * 表现为**每次打开页面必定失败一次、第二次才秒连**。
 * 窗口内等到就绪就照常发；超时仍按原逻辑抛错，免得真断时一直挂着。
 */
const SEND_READY_WAIT_MS = 8_000;
const RPC_ATTEMPTS = 4;
const RPC_BACKOFF_MS = [1_200, 2_400, 4_800];
/** Desktop beats every 8 s; keep 3x headroom for mobile network jitter. */
const PC_STALE_MS = 26_000;
/**
 * 下行静默多久就允许重建一次中继连接（冷却，避免抖动时狂重建）。
 */
const RESTART_COOLDOWN_MS = 15_000;
/**
 * 连续重建这么多次仍然连不上，就交给外壳做最后一次兜底：刷新页面。
 *
 * 为什么需要它：浏览器里的 mqtt.js 有一种典型死法 —— WebSocket 半死（既不触发
 * close 也不触发 error），内部每 3 秒的自动重连**永远不会触发**，所有请求都石沉
 * 大海，界面只会显示「连不上电脑」。重建客户端能救大部分情况；救不回来时，只有
 * 重新加载页面能保证把 MQTT、WebSocket、定时器全部重来。
 */
const HARD_RESET_AFTER = 3;
/**
 * 但真正的判据是**持续离线时长**，不是失败次数。
 *
 * 加了指数退避重试之后，计数会很快涨到阈值，而"网络抖动 45 秒"远不该刷新页面 ——
 * 刷新会重下外壳与整个列表（143 KB），在手机上表现为"一直在重连 / 很卡"。
 */
const HARD_RESET_MIN_DOWN_MS = 180_000;
const HARD_RESET_MIN_GAP_MS = 120_000;
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
/** 这台手机的安装标识：只在本机生成一次，清数据/卸载才会变。 */
const LS_INSTALL = 'pocket.install.v1';

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

/**
 * 这台手机的安装标识 —— 电脑区分「同一台手机重连」与「另一台手机」的唯一依据。
 *
 * 以前电脑按 `name + platform` 认设备，而外壳恒发「手机 / web」，于是第二台
 * 手机首次登录会原地轮换掉第一台那条记录，第一台立刻被当成「已移除」掉登出。
 * 这里只生成一次并持久化，**不随登出 / 令牌失效清理**（清掉它等于把自己
 * 变成一台"新手机"）。取不到存储时退化成一次性随机值：宁可多登记一台设备，
 * 也不要两台手机互相顶掉。
 */
function readInstallId() {
  const existing = readStorage('local', LS_INSTALL);
  if (typeof existing === 'string' && /^[0-9a-f]{16,64}$/u.test(existing)) return existing;
  let id = '';
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) id += byte.toString(16).padStart(2, '0');
  } catch {
    id = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`.slice(0, 32);
  }
  writeStorage('local', LS_INSTALL, id);
  return id;
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

/**
 * 等电脑端的第一条 hello。
 *
 * 为什么要等而不是直接报错：电脑端重启 / 插件热重载期间，手机这边照旧能连上
 * 公共 broker（那是第三方服务），只是没人应答。旧代码在这里直接 `showFatal`
 * 并且 `return`，引导流程就此结束 —— 即使电脑 3 秒后回来了，页面也永远停在
 * 「电脑端没有响应」，用户只能手动刷新。实测这正是「断线后要折腾很久」的
 * 形态之一：页面开着、电脑已经好了，界面却还是死的。
 *
 * 手机侧的中继看门狗仍在跑，底层连接会自动重建；这里只需要把「等 hello」
 * 变成可继续的状态，而不是终点。
 */
function waitForDesktopHello(relay, timeoutMs) {
  return new Promise((resolve) => {
    if (relay.pcHello !== null) { resolve(true); return; }
    setSplash('正在等待电脑响应…', '电脑可能正在重启，连上后会自动继续');
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (relay.pcHello !== null) { clearInterval(timer); resolve(true); return; }
      if (Date.now() - startedAt >= timeoutMs) { clearInterval(timer); resolve(false); }
    }, 300);
  });
}

/** 这个界面已被新打开的页面接管：盖一层整屏提示，并阻止继续使用。 */
function showSupersededOverlay() {
  if (document.getElementById('pocket-superseded') !== null) return;
  const box = el('div', { id: 'pocket-superseded' }, [
    el('div', { class: 'pocket-mark', 'aria-hidden': 'true' }),
    el('h2', { text: '这个界面已失效' }),
    el('p', { text: '同一台手机只让最新打开的界面生效。' }),
    el('p', { class: 'pocket-sub', text: '请回到最新打开的那个页面继续使用；这个页面可以直接关掉。' }),
  ]);
  box.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:#0b0f14', 'color:#e6edf3', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:12px',
    'padding:28px', 'text-align:center', 'font:15px/1.7 system-ui,-apple-system,sans-serif',
  ].join(';');
  document.body.append(box);
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

/**
 * 这台手机上次拿到的设备令牌（可能没有）。
 *
 * 必须在 `auth` 之前读出来：带上它桌面才会「原样回显」而不是又登记一台新
 * 设备 —— 少了这一步，每刷新一次页面就会多出一台设备，直到撞上设备上限。
 */
function readDeviceSession() {
  for (const key of [SS_SESSION, APP_SESSION_KEY]) {
    const raw = readStorage('local', key);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw);
      const token = typeof parsed?.token === 'string' ? parsed.token : '';
      if (token.length === 0) continue;
      return { token, deviceId: typeof parsed?.deviceId === 'string' ? parsed.deviceId : '' };
    } catch { /* 坏了的那份跳过，别让一条脏记录挡住登录 */ }
  }
  return null;
}

/**
 * 把「这台手机的设备令牌」落盘 —— app.js 就是从这个键建会话的。
 *
 * 令牌为空时必须把旧副本清掉：一张已经作废的令牌比没有更糟，它会一直 401。
 */
function persistDeviceSession(token, deviceId, { name, room }) {
  if (typeof token !== 'string' || token.length === 0) {
    clearDeviceSession();
    return;
  }
  saveDeviceSession({
    baseUrl: REMOTE_ORIGIN,
    token,
    deviceId: typeof deviceId === 'string' ? deviceId : '',
    server: { name },
    remote: { room: String(room ?? '').slice(0, 6) },
    at: Date.now(),
  });
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
    const submit = el('button', { class: 'pocket-btn pocket-btn-primary', type: 'submit', text: '登录' });
    const form = el('form', { class: 'pocket-card pocket-login', id: 'pocket-login-form', novalidate: 'novalidate' }, [
      el('div', { class: 'pocket-mark', 'aria-hidden': 'true' }),
      el('h1', { class: 'pocket-title', text: '连接我的电脑' }),
      el('p', { class: 'pocket-sub', text: '这台手机还没有登录。输入电脑上设置的用户名和访问口令。' }),
      el('label', { class: 'pocket-label', for: 'pocket-user', text: '用户名' }),
      userInput,
      el('label', { class: 'pocket-label', for: 'pocket-pass', text: '访问口令' }),
      el('div', { class: 'pocket-passwrap' }, [passInput, revealButton]),
      // 不再提供「记住我」勾选框：登录一次就是 15 天，一直在用就一直续期。
      // 让用户在登录这一刻做「我到底想不想记住」的选择没有意义 —— 选不记住
      // 的唯一后果是 12 小时后被无缘无故踢回登录页。
      el('p', { class: 'pocket-note', text: '登录后这台手机会保持 15 天免密；只要还在用就会自动续期。清理浏览器数据后需要重新登录。' }),
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
      const reply = await relay.login({ user: name, password });
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
    /** 重建互斥 + 计数：连续失败到阈值就触发硬兜底。 */
    this.restarting = false;
    this.restartCount = 0;
    /** 连续离线的起点（0 = 当前在线）。硬兜底只看它，不看失败次数。 */
    this.downSince = 0;
    this.lastRestartAt = 0;
    this.readyAt = 0;
    /** 已被新页面接管：不再重连、界面失效。 */
    this.superseded = false;
    /** 共享就绪等待器（null = 无人等待）。 */
    this.readyWait = null;
    /**
     * 最近一次回到前台的时刻。
     *
     * 息屏 / 长时间后台时页面被冻结，心跳收不到是**正常现象**；醒来若仍用冻结前
     * 的时间戳算「多久没消息」，就会立刻判成「电脑端已离线」并触发重连——而电脑
     * 其实一直是好的。把它并入「活着的下界」，醒来重新起算。
     */
    this.lastWakeAt = 0;
    this.onhardreset = () => {};
    this.onpc = () => {};
    this.onstate = () => {};
    this.onpcStale = () => {};
    this.onunauthorized = () => {};
    /** 15-day login token, loaded before the first `auth` exchange. */
    this.session = null;
    /**
     * 这台手机**自己的**设备令牌：口令登录成功时由桌面随机下发，调用 HTTP API
     * 的 `Authorization: Bearer` 用的就是它（等价于以前 `/api/v1/pair` 发的 token）。
     */
    this.deviceToken = '';
    this.deviceId = '';
    /** 桌面为什么没给令牌：'' 正常，'revoked' 已被移除，'limit' 设备数已满。 */
    this.deviceIssue = '';
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
        // 6 s 足够（实测本地 broker 0.35 s、公共 broker 2–3 s）。原来 12 s 意味着
        // 一次重建在两个 broker 上最多烧掉 26 s，这是「重连很久」的主要来源。
        connectTimeout: 6_000,
        protocolVersion: 4,
      });
      this.client = client;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.debug(`[pocket-diag] connectOne TIMEOUT broker=${broker} ready=${this.ready}`);
        try { client.end(true); } catch { /* ignore */ }
        reject(new Error('连接超时'));
      }, 7_000);

      client.on('connect', () => {
        console.debug(`[pocket-diag] connectOne CONNECTED broker=${broker} settled=${settled}`);
        this.onstate('online');
        client.subscribe(this.downTopic, { qos: 1 }, (error) => {
          console.debug(`[pocket-diag] connectOne SUBSCRIBE ${error ? 'ERR ' + (error.message ?? error) : 'OK'} settled=${settled}`);
          if (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
            return;
          }
          this.ready = true;
    // 唤醒所有等待就绪的发送方（共享 promise，一次性放行）
    if (this.readyWait !== null) { this.readyWait.release(); this.readyWait = null; }
          // 看门狗用 Math.max(pcSeenAt, lastRxAt, readyAt) 当「最后一次活着的时刻」。
          // 没有 readyAt 时，首帧到达前这个下界是 0 → idle 恒等于 Date.now() → 刚建好
          // 的健康链路在头 2 秒里必判 stale，被自己推倒重建（实测 85 s 建了 4 条隧道）。
          this.readyAt = Date.now();
          this.downSince = 0;
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
        console.debug(`[pocket-diag] connectOne CLOSE same=${this.client === client} ready=${this.ready}`);
        // 旧 client 在重建时会被 end(true)，它触发的 close 不该再改状态。
        if (this.client !== client) return;
        const wasReady = this.ready;
        this.ready = false;
        this.onstate('offline');
        this.failAll('中继连接中断');
        // **立刻**安排重连。以前这里什么都不做，全靠 26 s 静默看门狗 + 15 s 冷却，
        // 而每次重建又要顺序等 2 个 broker 的超时 —— 一次网络抖动要几十秒才回来，
        // 用户体感就是「断了以后很久连不上，只能手动重连」。
        // 只对"本来连通过"的连接做快重连：首次连接失败仍走原有的退避。
        if (wasReady && this.superseded !== true && this.fastRetryTimer === undefined) {
          this.fastRetryTimer = setTimeout(() => {
            this.fastRetryTimer = undefined;
            void this.restart('底层连接关闭');
          }, 800);
        }
      });
    });
  }

  /**
   * 这个页面已被新打开的页面接管：停止一切重连并显示提示。
   *
   * 关键在「停止重连」——只关连接而不停重连，旧页面会立刻重新开隧道，
   * 把新页面顶掉，两边无限乒乓（这正是 1.0.2 修过的那个病）。
   */
  markSuperseded() {
    if (this.superseded === true) return;
    this.superseded = true;
    try {
      if (this.staleTimer !== undefined) { clearInterval(this.staleTimer); this.staleTimer = undefined; }
    } catch { /* ignore */ }
    try {
      if (this.fastRetryTimer !== undefined) { clearTimeout(this.fastRetryTimer); this.fastRetryTimer = undefined; }
    } catch { /* ignore */ }
    try {
      if (this.client !== undefined) { this.client.end(true); this.client = undefined; }
    } catch { /* ignore */ }
    this.ready = false;
    try { globalThis.__POCKET_KILL_REALTIME__?.(); } catch { /* ignore */ }
    showSupersededOverlay();
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
  /**
   * 推倒重建底层 MQTT 连接。
   *
   * 触发点：下行静默超时、手机从后台回到前台、用户点「重连」、连续失败兜底。
   * 返回是否重建成功；互斥，避免同时开两条。
   */
  async restart(reason = '') {
    // 已被新页面接管：不再重连。这一条是防乒乓的关键 —— 被顶掉的旧页面
    // 若能自己重建，就会反过来把新页面顶掉。
    if (this.superseded === true) return false;
    if (this.restarting === true) return false;
    this.restarting = true;
    this.restartCount += 1;
    this.lastRestartAt = Date.now();
    console.warn('[pocket] 重建中继连接：' + reason + '（第 ' + this.restartCount + ' 次）');

    const previous = this.client;
    this.client = undefined;
    this.ready = false;
    this.readyAt = 0;
    this.pcHello = null;
    this.pcStale = false;
    this.parts.clear();
    this.failAll('中继连接重建中');
    try { this.onstate('connecting'); } catch { /* 界面回调不该影响重建 */ }
    try { previous?.end?.(true); } catch { /* 已经断了 */ }

    try {
      await this.connect();
      this.readyAt = Date.now();
      this.restartCount = 0;
      this.downSince = 0;
      // 上面直接把 pcStale 置了 false，true→false 的边沿被吞掉，onpcStale 不再
      // 触发，横幅「电脑端已离线 N 秒…」会永久挂着。显式通知一次已恢复。
      try { this.onpcStale(false, null); } catch { /* 界面回调不该影响重建 */ }
      this.announce(true);
      this.startStaleWatch();
      return true;
    } catch (error) {
      console.warn('[pocket] 重建失败', error?.message);
      try { this.onstate('offline'); } catch { /* ignore */ }
      // 失败后必须排下一次重试：看门狗在 ready=false 时会跳过（避免重建风暴），
      // 如果这里不排，自愈链就断在原地 —— 界面停在「中继断开，正在重连…」其实没在连。
      const retryDelay = Math.min(15_000, 1_000 * (2 ** Math.min(this.restartCount, 4)));
      setTimeout(() => { void this.restart('重建失败重试'); }, retryDelay);
      if (this.downSince === 0) this.downSince = Date.now();
      if (this.restartCount >= HARD_RESET_AFTER
        && Date.now() - this.downSince > HARD_RESET_MIN_DOWN_MS) {
        const key = 'dsh.pocket.hardreset';
        let last = 0;
        try { last = Number(globalThis.sessionStorage?.getItem(key) ?? 0) || 0; } catch { last = 0; }
        if (Date.now() - last > HARD_RESET_MIN_GAP_MS) {
          try { globalThis.sessionStorage?.setItem(key, String(Date.now())); } catch { /* 隐私模式 */ }
          try { this.onhardreset(); } catch { /* ignore */ }
        }
      }
      return false;
    } finally {
      this.restarting = false;
    }
  }

  startStaleWatch() {
    if (this.staleTimer !== undefined) return;
    this.staleTimer = setInterval(() => {
      if (!this.ready) {
        // 未就绪也要管：重建失败后靠这里兜底（冷却期内不打扰）。
        if (Date.now() - this.lastRestartAt > RESTART_COOLDOWN_MS) void this.restart('未就绪兜底');
        return;
      }
      // 以前 pcSeenAt===0 就直接 return —— 而"连上了却一帧都没收到"恰恰是
      // 最需要重建的状态。改用以 readyAt 为下界。
      const idle = Date.now() - Math.max(this.pcSeenAt, this.stats.lastRxAt, this.readyAt, this.lastWakeAt);
      const stale = idle > PC_STALE_MS;
      if (stale !== this.pcStale) {
        this.pcStale = stale;
        this.onpcStale(stale, stale
          ? `电脑端已离线 ${Math.round(idle / 1000)} 秒 · 正在重连…（列表可能不是最新）`
          : null);
      // 只显示横幅是不够的：这条链路的坏法就是"看起来连着、其实发不出去"。
      // 静默够久就必须把底层客户端整个重建，否则永远等不到自动重连。
      if (stale && Date.now() - this.lastRestartAt > RESTART_COOLDOWN_MS) {
        void this.restart('下行静默');
      }
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
        const code = String(message.code);
        // 跳号必须放在"能否找到 pending 条目"之前：`ws.open` / `ws.msg` 走的是
        // send 而不是 request，没有 pending 条目；如果只在 request 分支里跳号，
        // 一旦被拒的是隧道帧，手机端就永远收不到 ack，实时通道再也开不起来。
        if (code === 'replay' || code === 'bad-seq') this.seq += 256;
        const entry = this.pending.get(String(message.id ?? ''));
        // 时钟自愈必须放在 pending 查找**之前**：迟到的 rejection 往往找不到 pending 条目，
        // 若在那之后再重置，错误的 clockOffset 会被一直沿用（实测 tsDelta 稳定 -142s）。
        if (code === 'bad-ts' || code === 'stale') {
          this.clockOffset = 0;
          void this.announce(true);
        }
        if (entry === undefined) return;
        this.stats.stale += 1;
        if (code === 'bad-ts' || code === 'stale' || code === 'replay' || code === 'bad-seq') {
          // Same id (idempotent), fresh seq/ts — exactly what a retry must do.
          entry.retry?.();
          return;
        }
        this.pending.delete(entry.id);
        clearTimeout(entry.timer);
        entry.reject(new Error(`中继拒绝了请求（${code === '' ? 'unknown' : code}）`));
        break;
      }
      case 'auth': {
        this.authRequired = message.required === true;
        this.authUser = typeof message.user === 'string' ? message.user : null;
        // 桌面顺手把设备令牌（或「被移除 / 设备数满」）一起写在应答里。
        this.absorbDevice(message);
        if (message.ok === true && Number(message.expiresAt) > 0 && this.session !== null) {
          this.session.expiresAt = Number(message.expiresAt);
          void saveAuthSession(this.session);
        }
        this.authWaiter?.({ required: this.authRequired, ok: message.ok === true, user: this.authUser });
        break;
      }
      case 'login': {
        this.absorbDevice(message);
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
        const id = String(message.id ?? '');
        const code = Number(message.code ?? 1001);
        const socket = this.sockets.get(id);
        // 4002 = 被**另一个页面**顶掉（同一台手机只让最新打开的界面生效）。
        //
        // 但下行是**广播**的：别的页面被顶掉时，那条 ws.close 也会到达本页。
        // 所以只有"被关的正是本页的隧道"（socket 存在）才算被接管；
        // 否则每个页面都会因为别人的关闭帧而自杀（实测三页全灭）。
        // 两个判据缺一不可：id 命中本页（常规），或 4002 帧上带的 psid 就是本页
        // （本页可能已经把这条 id 从表里删了，只按 id 会漏判 → 页面继续反抢）。
        const mine = socket !== undefined || (typeof message.psid === 'string' && message.psid !== '' && message.psid === this.sid);
        if (code === 4002 && mine) this.markSuperseded();
        if (socket !== undefined) socket._close(code, message.reason ?? message.message ?? '');
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

  /** 等中继就绪；所有等待者共享同一个 promise，就绪时一次性放行。 */
  waitReady(timeoutMs) {
    if (this.client !== undefined && this.ready) return Promise.resolve(true);
    if (this.readyWait === null) {
      let release = () => {};
      const promise = new Promise((resolve) => { release = resolve; });
      this.readyWait = { promise, release };
    }
    const waiter = this.readyWait;
    return Promise.race([
      waiter.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  async send(object) {
    if (this.client === undefined || !this.ready) {
      // 不立刻抛：刚打开页面时 App 往往比中继先发起连接，真实环境的公共 broker
      // 要 1~2 秒才连上。以前这里直接 throw，导致"每次都先失败一次、第二次才成功"。
      // 用**共享**的 ready promise：旧实现是每个调用方各开一个 50ms 轮询，
      // 掉线窗口里 N 个并发请求就是 N 个 20Hz 定时器、最多各 160 次唤醒。
      await this.waitReady(SEND_READY_WAIT_MS);
      if (this.client === undefined || !this.ready) throw new Error('中继尚未就绪');
    }
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

  /**
   * 这台手机自报的设备令牌。桌面据此区分「第一次登录」（登记一台新设备）和
   * 「上次那台还好不好用」。没有就不带这个字段 —— 带空串等于「自报了但无效」。
   */
  deviceClaim() {
    // 安装标识每次都要带：电脑靠它认出「还是这台手机」，从而原地轮换令牌
    // 而不是新登记一台。没令牌时只带标识，正好让电脑走「登记/复用」分支。
    const claim = { installId: readInstallId() };
    if (this.deviceToken.length > 0) claim.deviceToken = this.deviceToken;
    return claim;
  }

  /**
   * 口令应答（`login` / `auth`）里带回来的设备令牌：首次登录、续期、手机重装
   * 之后用同一个口令登录一次，都走这里刷新本地那一份。
   *
   * 桌面只在「手机自报了令牌却用不了」时回 revoked / deviceLimit，并且明确
   * 不自动补发 —— 所以客户端这份必须一起丢掉，别让下一次继续拿它去撞。
   */
  absorbDevice(reply) {
    const token = typeof reply?.deviceToken === 'string' ? reply.deviceToken : '';
    if (token.length > 0) {
      this.deviceToken = token;
      this.deviceId = typeof reply.deviceId === 'string' ? reply.deviceId : '';
      this.deviceIssue = '';
      return;
    }
    if (reply?.revoked === true) this.dropDevice('revoked');
    else if (reply?.deviceLimit === true) this.dropDevice('limit');
  }

  /** 忘掉这台手机的设备令牌（被移除 / 设备数满 / 主动重新登录）。 */
  dropDevice(issue = '') {
    this.deviceToken = '';
    this.deviceId = '';
    this.deviceIssue = issue;
    clearDeviceSession();
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
      // `phone` 只在桌面需要新登记一台设备时用到（还没登录过 / 本地没有令牌）。
      this.send({ t: 'auth', phone: this.phoneName, platform: 'web', ...this.deviceClaim() })
        .catch(() => done({ required: false, ok: true }));
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
      this.send({ t: 'login', user, password, remember, phone: this.phoneName, platform: 'web', ...this.deviceClaim() })
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
    // 带上 seq/ts：否则这条帧无法通过服务端的新鲜度/重放校验（见 cloud.mjs 的 ws.close 分支）。
    return this.send({ t: 'ws.close', id, sid: this.sid, seq: this.nextSeq(), ts: this.serverNow() }).catch(() => {});
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
  // 装 shim 之前先留住原生实现。mqtt.js 也在同一个 window 里 `new WebSocket(...)`，
  // 它连的是 broker（公网或自建），**不是**本机的 /ws 隧道。
  const RealWebSocket = window.WebSocket;
  /**
   * 这个地址是不是「本机 App 的实时通道」？
   *
   * 只有同源、且路径是 /ws 的才该走中继隧道。其余（也就是 broker 的 ws/wss 地址）
   * 必须交回原生 WebSocket —— 否则 mqtt 每次重连都会把「连 broker」变成「开中继
   * 隧道」，而隧道本身又要依赖中继：中继一断，mqtt 就永远连不上。
   * 实测症状：broker 恢复后旧页面 0 次 CONNECTED、连本地 broker 也 7s 超时，
   * 而新页面首次连接正常（那时 mqtt 拿到的是原生构造函数）。
   */
  const isAppTunnel = (raw) => {
    try {
      const url = new URL(String(raw), REMOTE_ORIGIN);
      const appOrigin = new URL(REMOTE_ORIGIN);
      return url.host === appOrigin.host && url.pathname.startsWith('/ws');
    } catch {
      return false;
    }
  };
  class PocketWebSocket extends EventTarget {
    constructor(url, protocols) {
      if (!isAppTunnel(url)) return new RealWebSocket(url, protocols);
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
      // 兜底超时**必须长于** openSocket 那次 RPC 的最坏预算（16 s × 4 次 + 退避
      // ≈ 24.4 s）。原先写 12 s，比 RPC 自己判死还早：ack 一旦丢一帧，握手还在
      // 重试中就先被这里掐掉，于是整条隧道重建一次。实测开 3 个标签页建了 5 条
      // 隧道，第 2、3 页各多建一条，界面在「正在连接…」多挂 10 s 以上。
      this.openTimer = setTimeout(() => {
        if (this.readyState === PocketWebSocket.CONNECTING) this._close(1006, 'open timeout');
      }, 30_000);
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
      // close() 自己已经发过 ws.close，这里只补它不发的那几条路：open timeout /
      // open failed / 电脑端主动关 / failAll。以前这些路径只删本地表，电脑端那条
      // 隧道没人认领 —— 12 个槽位占满后新隧道永远 too many channels，只能等
      // 10 分钟空闲 sweep 自愈，手机侧就表现为「有时重连要很久」。
      const asked = this.readyState >= PocketWebSocket.CLOSING;
      this.readyState = PocketWebSocket.CLOSED;
      if (!asked) void relay.closeSocket(this.id);
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
        // 同 ws.close：带上 seq/ts，服务端才能拒掉被录下来重放的隧道帧。
      await relay.send({ t: 'ws.msg', id: this.id, bin, data, sid: relay.sid, seq: relay.nextSeq(), ts: relay.serverNow() });
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
  // 预填：优先用本次地址栏的链接，其次用上次记住的。以前这里是空框，而空框 +
  // 「连接」按钮 = 什么都不发生（提交处理里遇到空值直接静默返回）。
  const fromHash = new URLSearchParams(location.hash.slice(1)).toString();
  input.value = fromHash.length > 0 ? fromHash : (readStoredLink() ?? '');
  const note = el('small', {
    class: 'pocket-note',
    text: '链接在电脑端「配对页 → 远程访问」里，形如 …/#r=…&k=…&t=…',
  });
  const form = el('form', { class: 'pocket-card', id: 'pocket-manual-form' }, [
    el('h1', { class: 'pocket-title', text: '连接你的电脑' }),
    el('p', { class: 'pocket-sub', text: reason }),
    input,
    el('button', { class: 'pocket-btn pocket-btn-primary', type: 'submit', text: '连接' }),
    note,
  ]);
  const layer = el('div', { class: 'pocket-gate', id: 'pocket-manual' }, [form]);
  document.body.append(layer);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const next = value.includes('#') ? value.slice(value.indexOf('#') + 1) : value.replace(/^#/u, '');
    const parsed = new URLSearchParams(next);
    // 链接必须包含房间、密钥、初始凭据三件套；不完整就明确说出来，
    // 而不是像以前那样静默 return —— 用户只会觉得"点了没反应"。
    if (next.length === 0 || !parsed.get('r') || !parsed.get('k') || !parsed.get('t')) {
      note.textContent = value.length === 0
        ? '还没有填链接：请从电脑端「配对页 → 远程访问」复制完整链接（形如 …/#r=…&k=…&t=…）。'
        : '这段链接不完整：需要同时包含 r、k、t 三段参数，请从电脑端重新复制。';
      note.classList.add('pocket-note-error');
      input.focus();
      return;
    }
    location.hash = next;
    location.reload();
  });
}

/* --------------------------------- boot --------------------------------- */

function closeChannels(relay) {
  for (const [, socket] of relay.sockets) void relay.closeSocket(socket.id);
}

/**
 * 链接记忆：把 `#r=…&k=…&t=…` 存进 localStorage，供"裸启动"恢复。
 *
 * 只存链接本身（房间、密钥、初始设备凭据），不存登录会话 —— 登录态仍由内层
 * 应用自己保管。桌面端「重置链接」后房间会变，旧值失效时外壳会照常报连不上，
 * 重新扫码即可覆盖。
 *
 * **这条取舍必须写在这里，不能只写在文档里**：`k` 是房间的 AES-256-GCM 密钥，
 * `storeLink()` 把它连同整条明文链接写进本机 localStorage。这样做换来的是
 * 「PWA 从桌面图标启动 / 浏览器丢掉 hash 之后还能直接进」，而 `manifest.start_url`
 * 带不了 hash，除此之外没有别的办法。代价是：**本页所在 origin 上的任何脚本
 * 都能读到这把密钥**（localStorage 没有 origin 内的隔离）。所以边界是硬的：
 *   - 外壳必须与本页同源托管，不引第三方脚本（CSP `script-src 'self'`）；
 *   - 能在这台手机上执行脚本的人 = 能解开这个房间的流量的人；密钥泄露的处置
 *     方式是电脑端「重置链接」换一个房间，而不是删本地文件（删了也只是本机删掉）；
 *   - 解除配对时一并清掉（见 `forgetSession()`），别把密钥留给下一个用这台手机的人。
 */
const LINK_KEY = 'dsh.pocket.link.v1';

function readStoredLink() {
  try {
    const value = globalThis.localStorage?.getItem(LINK_KEY);
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
    const parsed = new URLSearchParams(value);
    if (!parsed.get('r') || !parsed.get('k') || !parsed.get('t')) return null;
    return value;
  } catch {
    return null;
  }
}

function storeLink(value) {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return;
    globalThis.localStorage?.setItem(LINK_KEY, value);
  } catch { /* 隐私模式：不记住也能用，只是下次要重新扫码 */ }
}

/**
 * 忘掉记住的链接（解除配对时用）。
 *
 * 只删本机这一份；真正让旧链接作废的是电脑端「重置链接」——房间变了，
 * 别人手里那条旧链接连房间都进不去。
 */
function dropStoredLink() {
  try { globalThis.localStorage?.removeItem(LINK_KEY); } catch { /* 隐私模式 */ }
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

  /**
   * 一次成功的链接必须被记住。
   *
   * 为什么：手机的 PWA 从桌面图标启动时，`manifest.start_url` 里带不了 hash，
   * 浏览器也可能在"退出后再进来"时丢掉 `#r=…&k=…&t=…`。参数一没，外壳就判定
   * "不是中继外壳"，把用户丢到「粘贴链接」页面 —— 那个页面的按钮只是把框里的
   * 内容塞回 hash，框里没有完整链接时自然点了没反应。
   */
  const savedLink = readStoredLink();
  let link = params;
  if (!params.get('r') || !params.get('k') || !params.get('t')) {
    if (savedLink !== null) {
      link = new URLSearchParams(savedLink);
      // 把地址栏也补回完整链接，后续任何读 location.hash 的代码都一致。
      try { history.replaceState(null, '', '#' + savedLink); } catch { /* 老浏览器 */ }
    }
  }

  let room = link.get('r');
  let key = link.get('k');
  // `t` 只用来判断「这是不是一个完整的远程链接」。它以前被当成手机的 API
  // 凭据；现在凭据只有一条路——口令登录换来的 deviceToken（见 persistDeviceSession）。
  let token = link.get('t');
  const name = link.get('n') ?? 'DSH';

  if (!room || !key || !token) {
    renderManualEntry('这个页面需要电脑端生成的远程链接才能工作。');
    return;
  }
  // 记住这次可用的链接，下次裸启动直接进。
  storeLink(link.toString());

  const hint = resolveBrokerHint(link.get('s'));
  // broker 是**房间身份的一部分**：电脑和手机必须连同一个 broker 才能见面。
  // 以前这里会 `[hint, ...DEFAULT_BROKERS]`，即链接指定了自建 broker 时还挂一个
  // 公共默认值当回退 —— 一旦回退过去，手机就永久留在另一个 broker 上：它自己
  // `ready=true`、界面以为"连着"，却永远收不到电脑的帧（实测就是「电脑那边没有
  // 响应」且怎么等都不恢复）。所以有 hint 时**只认 hint**；没有 hint 的旧链接才
  // 退回默认值。
  const brokers = hint === null ? DEFAULT_BROKERS.slice() : [hint];

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
  // 上次拿到的设备令牌先装上：`auth` 靠它判断「还是那台设备」还是「新登记一台」。
  const known = readDeviceSession();
  if (known !== null) {
    relay.deviceToken = known.token;
    relay.deviceId = known.deviceId;
  }
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
  /** 中继层横幅的去抖计时器：短抖动不打扰。 */
  let relayBannerTimer = null;
  let staleText = null;
  const renderBanner = () => {
    if (relayOffline) { setBanner('中继断开，正在重连…'); return; }
    setBanner(staleText);
  };
  relay.onstate = (state) => {
    const wasOffline = relayOffline;
    relayOffline = state === 'offline';
    // 与 App 侧同一条纪律：**短抖动不打扰**。
    // MQTT 一 close 就立刻弹「中继断开」，用户看到的就是"切后台回来必报断开"——
    // 而实际重连只要几秒。给 6 秒自愈窗口：期间恢复就完全不显示。
    if (relayOffline) {
      if (relayBannerTimer === null && !wasOffline) {
        relayBannerTimer = setTimeout(() => {
          relayBannerTimer = null;
          if (relayOffline) { setSplash('中继断开，正在重连…', '网络切换后会自行恢复'); renderBanner(); }
        }, 6_000);
      }
      return;
    }
    if (relayBannerTimer !== null) { clearTimeout(relayBannerTimer); relayBannerTimer = null; }
    renderBanner();
  };
  relay.onpcStale = (stale, text) => {
    staleText = stale ? text : null;
    renderBanner();
  };

  // 首屏：没有本地会话时**先把登录框画出来**，不要让人对着 splash 等 MQTT 握手。
  // 实测公共 broker 的握手要 ≈2.1 s，而这段时间用户完全可以开始输口令；
  // 提交按钮先禁用，等鉴权结果回来再启用（真不需要登录时直接把框摘掉）。
  const earlyGate = relay.session === null ? showLoginGate(relay, {}) : null;
  const earlyForm = earlyGate === null ? null : document.getElementById('pocket-login-form');
  let earlyHint = null;
  let earlySubmit = null;
  if (earlyForm !== null) {
    hideSplash();
    earlySubmit = earlyForm.querySelector('button[type="submit"]');
    if (earlySubmit !== null) earlySubmit.disabled = true;
    earlyHint = el('p', { class: 'pocket-sub', text: '正在连接电脑…' });
    earlyForm.append(earlyHint);
  }

  try {
    await relay.connect();
  } catch (error) {
    if (earlyForm !== null) { earlyForm.closest('.pocket-login')?.remove() ?? earlyForm.remove(); }
    showFatal('无法建立中继连接', String(error?.message ?? error));
    return;
  }
  relay.startStaleWatch();
  // 用户可见的「重连」、以及手机从后台回到前台，都要能把底层连接推倒重建。
  // 只重开 WS 隧道救不了"MQTT 已死但自以为活着"的状态。
  globalThis.__POCKET_RELAY_RESTART__ = (reason) => relay.restart(reason || '手动重连');
  relay.onhardreset = () => { location.reload(); };

  // ---- 同一台手机只让"最新打开的界面"生效：localStorage 抢主 ----
  //
  // 为什么不放在服务端：实测服务端拿到的页面身份（psid）不可靠 —— 同一个页面
  // 重连时会带上不同的 psid，服务端会把它的新隧道当成"别的页面"顶掉，页面被
  // 自己反复杀死。而这个需求本质是"同一台设备上哪个标签页最新"，localStorage
  // 天然是**同源跨标签共享**的，最可靠。
  //
  // 规则：每个页面启动时把自己的 id 写进去；每 1.5 s 检查一次，发现不是自己就
  // 认输（停止重连 + 整屏提示）。抢输的页面自己停，所以不会再发生互相反抢。
  const TAB_KEY = 'dsh.pocket.activeTab';
  const tabId = randomId(6);
  let tabTimer = null;
  const readActiveTab = () => {
    try {
      const raw = localStorage.getItem(TAB_KEY);
      return raw === null ? null : JSON.parse(raw);
    } catch { return null; }
  };
  try {
    localStorage.setItem(TAB_KEY, JSON.stringify({ id: tabId, at: Date.now() }));
  } catch { /* 隐私模式：退化为多页并存 */ }
  tabTimer = setInterval(() => {
    const active = readActiveTab();
    if (active === null || active.id === tabId) return;
    if (tabTimer !== null) { clearInterval(tabTimer); tabTimer = null; }
    relay.markSuperseded();
  }, 1_500);
  // 主动关闭时让出位置，别把"最新"这个名字带走（否则别的页面永远等不到）。
  window.addEventListener('pagehide', () => {
    const active = readActiveTab();
    if (active !== null && active.id === tabId) {
      try { localStorage.removeItem(TAB_KEY); } catch { /* ignore */ }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // 醒来第一件事：把「活着的下界」重置到此刻。冻结期间收不到心跳是正常的，
    // 不重置就会拿冻结前的时间戳算静默 → 立刻判「电脑端已离线」并重连。
    relay.lastWakeAt = Date.now();
    // 顺带主动探一次：活着的话电脑会立刻回 hello+beat，把静默清零；
    // 真断了就由 26 s 看门狗在醒来之后重新计时接管。
    relay.announce(true);
    // 只有真的没连上才重建。
    const justRestarted = Date.now() - (relay.lastRestartAt ?? 0) < 20_000;
    if (!justRestarted && !relay.ready) void relay.restart('回到前台');
  });

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
    // 不在这里终结引导流程：电脑端可能正重启/热重载，等它回来就继续。
    const arrived = await waitForDesktopHello(relay, 60_000);
    if (!arrived) {
      showFatal('电脑端没有响应', '确认电脑上的 DSH 正在运行，且「远程访问」已开启');
      return;
    }
  }
  if (relay.pcVersion > 0 && relay.pcVersion < PROTOCOL) {
    console.warn(`[pocket] desktop speaks protocol ${relay.pcVersion}, shell speaks ${PROTOCOL}`);
  }

  // Login gate: no valid token, no UI. The 15-day token is encrypted at rest.
  //
  // 这里**必须串行**：之前为了省一个公网往返，把 checkAuth 提前到 connect 之后
  // 就发，结果是「电脑端还没起来」时那次请求收不到应答，超时重发后落到了另一条
  // 分支，最终显示的是 App 自己的 /connect 页（只有「重新登录」按钮、没有账号
  // 密码框），与「电脑一直在」时的登录闸门不一致。省 0.8 s 不值得换来两套界面。
  const authState = await relay.checkAuth();
  if (authState.required && !authState.ok) {
    relay.onunauthorized = () => {
      clearAuthSession();
      relay.session = null;
      // 设备被移除 / 会话失效时，**直接给出口令框**，而不是让 App 自己跳到
      // /connect 那个只有「重新登录」按钮、没有输入框的页面（实测被判无效后
      // 落到的就是那个页面，用户还得再点一次才看得到输入框）。
      if (document.getElementById('pocket-login-form') === null) {
        void showLoginGate(relay, { reason: '登录已过期，请重新登录' })
          .then((ok) => { if (ok) location.reload(); });
      } else if (earlySubmit !== null) {
        earlySubmit.disabled = false;
      }
    };
    hideSplash();
    if (earlyGate !== null) {
      // 早期就画好的那个框直接启用，不用再画一遍。
      if (earlyHint !== null) earlyHint.remove();
      if (earlySubmit !== null) earlySubmit.disabled = false;
    }
    const passed = earlyGate !== null
      ? await earlyGate
      : await showLoginGate(relay, {
        user: authState.user ?? '',
        reason: relay.session === null ? '' : '登录已过期，请重新登录',
      });
    if (!passed) {
      showFatal('需要登录', '没有登录就无法访问这台电脑');
      return;
    }
  } else if (authState.required) {
    // 不需要登录（已持有有效会话）：把早期预报的登录框摘掉，别让它挡着界面。
    if (earlyForm !== null) { earlyForm.closest('.pocket-login')?.remove() ?? earlyForm.remove(); }
    relay.onunauthorized = () => {
      clearAuthSession();
      relay.session = null;
      void showLoginGate(relay, { user: authState.user ?? '', reason: '登录已过期，请重新登录' })
        .then((ok) => { if (ok) location.reload(); });
    };
  }

  // 设备令牌：口令登录成功时桌面已经随应答一起下发（首次登录会自动登记一台）。
  // 被移除 / 设备数满时桌面明确回 deviceToken:null，并且**不会**自动补发 ——
  // 这两种情况绝不能再拿链接里的令牌顶上，否则「移除设备」就形同虚设。
  if (relay.deviceIssue === 'revoked') {
    // 设备被移除 = 这台手机的凭据作废：连 15 天登录会话一起清掉，
    // 下一次真正走一遍口令登录（口令是唯一凭据）。
    clearAuthSession();
    relay.session = null;
  }
  // 设备令牌只有一个来源：口令登录成功时桌面随应答下发的这张。
  // 拿不到就是拿不到 —— 链接里的 `t` 是电脑自己的中继身份，用它顶替等于让
  // 电脑端的「移除设备」形同虚设，所以这里不做任何回落。
  const deviceToken = relay.deviceToken;

  // Device session: app.js needs a record to build its Authorization header.
  persistDeviceSession(deviceToken, relay.deviceId, { name, room });

  installShims(relay);
  hideSplash();
  registerShellWorker();

  // Contract with web/app.js: set before the import, read at module evaluation.
  globalThis.__POCKET_SHELL__ = {
    mode: 'remote',
    baseUrl: REMOTE_ORIGIN,
    swUrl: './sw.js',
    assetBase: './',
    /** 口令登录换来的设备令牌：app.js 拿到它就直接渲染任务列表。 */
    deviceToken,
    deviceId: relay.deviceId,
    /** 为什么没有令牌：'revoked' 已被电脑端移除，'limit' 设备数已达上限。 */
    deviceError: relay.deviceIssue,
    /** 重新登录：清掉登录会话与设备令牌，回到口令闸门（口令是唯一凭据）。 */
    relogin() {
      clearAuthSession();
      relay.session = null;
      relay.dropDevice('');
      void showLoginGate(relay, { user: relay.authUser ?? '', reason: '请重新登录' })
        .then((ok) => {
          if (!ok) return;
          // 闸门刚换到的新设备令牌得先落盘，否则刷新后又要重新登记一台。
          persistDeviceSession(relay.deviceToken, relay.deviceId, { name, room });
          location.reload();
        });
    },
    /**
     * 彻底忘掉这台手机与当前电脑的配对（设置页「换一台电脑」/ 解除配对）。
     *
     * 必须由外层调用：app.js 只清得掉自己的 `dsh.pocket.session.v1`，而设备
     * 令牌的真身在**外壳**这里 —— `persistDeviceSession()` 同时写了
     * `pocket.session.v1`，`main()` 开头又会 `readDeviceSession()` 把它读回来
     * 塞进 `relay.deviceToken`。不在这里清，用户确认"已断开"之后一刷新，
     * `adoptShellSession()` 就把旧令牌重新采纳，等于没解除配对。
     *
     * 一起清掉的三样东西，缺一样都能把旧配对"复活"：
     *   1. 设备令牌（两份键名 + 历史键）—— 否则刷新即复活；
     *   2. 登录会话（口令换来的凭据）—— 设置页对用户的承诺是"登录信息会被清除"；
     *   3. 记住的链接（含房间密钥）—— 否则下一个用这台手机的人还能进这个房间。
     */
    forgetSession() {
      clearDeviceSession();
      clearAuthSession();
      relay.dropDevice('');
      dropStoredLink();
      // 地址栏里那段 `#r=…&k=…` 也一起去掉：留着的话它仍是可分享、可恢复的入口。
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* 老浏览器 */ }
    },
  };

  try {
    await import('./app.js');
  } catch (error) {
    clearDeviceSession();
    showFatal('界面加载失败', String(error?.message ?? error));
  }
}

void main();
