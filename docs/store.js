/**
 * Application state.
 *
 * One mutable object plus a tiny listener list — the app is small enough that a
 * framework would cost more than it saves, and explicit `store.emit()` calls
 * keep the places that can cause a repaint obvious.
 */

const NS = 'dsh.pocket';
const LS = {
  session: `${NS}.session.v1`,
  prefs: `${NS}.prefs.v1`,
  cache: `${NS}.cache.v1`,
  device: `${NS}.device.v1`,
};

export const LIMITS = {
  promptChars: 8000,
  taskPage: 300,
  /* 会话详情一页多少条：首屏与「往上翻」共用，服务端还会按字节预算二次收敛。 */
  detailPage: 40,
  cacheTasks: 120,
};

/* ---------------- storage helpers (never throw) ---------------- */

export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function removeKey(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function deviceId() {
  try {
    const stored = localStorage.getItem(LS.device);
    if (typeof stored === 'string' && stored.startsWith('dev_')) return stored;
    const random = crypto.getRandomValues(new Uint8Array(9));
    const created = `dev_${[...random].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16)}`;
    localStorage.setItem(LS.device, created);
    return created;
  } catch {
    return `dev_${Math.random().toString(36).slice(2, 14)}`;
  }
}

/* ---------------- the store ---------------- */

export const store = {
  screen: 'connect',
  session: null,
  me: null,
  bridge: null,

  tasks: new Map(),
  order: [],
  summary: { total: 0, running: 0, done: 0, error: 0, today: 0, subagents: 0 },
  loading: true,
  loadError: '',

  filter: 'all',
  query: '',
  searching: false,
  connState: 'connecting',
  latency: 0,

  detailId: null,
  detail: null,
  detailError: '',
  /* 「往上翻加载更早」是否有请求在飞：防止快速滑动打出并发重复页。 */
  detailLoadingOlder: false,
  chatAuto: true,

  workspaces: [],
  presets: [],
  draft: { text: '', cwd: '', preset: '', clientTaskId: '' },
  sending: false,
  creating: false,

  prefs: { theme: 'auto', notify: false, showSubagents: false, deviceName: '', lastCwd: '' },
  refreshing: false,
  flashId: '',
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (error) { console.error('listener failed', error); }
  }
}

/* ---------------- derived helpers ---------------- */

/**
 * 唯一通路是「静态外壳 + 加密中继」：只有 `remote/remote.js` 注入的
 * `mode: 'remote'` 才算外壳。桌面 `/app`（回环本机预览）不算 —— 那里没有
 * Service Worker 隧道，连不出去。
 */
export function isRelayShell() {
  return globalThis.__POCKET_SHELL__?.mode === 'remote';
}

/**
 * 请求前缀只有两个来源：已配对的会话，或中继外壳注入的 origin。
 *
 * 直连删除后**不再**回落到 `location.origin` —— 那个回落正是「在局域网里打开
 * 页面就直接连上电脑」的实现方式。拿不到就返回空串，让调用方显式报错。
 */
export function baseUrl() {
  const fromSession = store.session?.baseUrl;
  if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession;
  if (!isRelayShell()) return '';
  const shell = globalThis.__POCKET_SHELL__;
  return typeof shell.baseUrl === 'string' ? shell.baseUrl : '';
}

/* ---------------- shell hand-off ---------------- */

/**
 * 外壳（`remote/remote.js`）用口令换来的设备令牌。
 *
 * 口令登录是唯一入口：桌面在 `login` / `auth` 应答里把设备令牌一起发下来，
 * 外壳再通过 `__POCKET_SHELL__` 交给这里。拿不到就只有两种可能——这台手机
 * 还没登录，或者它的设备已经被电脑端移除。
 */
export function shellDeviceToken() {
  const shell = globalThis.__POCKET_SHELL__;
  if (shell?.mode !== 'remote') return '';
  return typeof shell.deviceToken === 'string' ? shell.deviceToken : '';
}

/** 外壳没给令牌的原因：'' 正常，'revoked' 已被移除，'limit' 设备数已满。 */
export function shellDeviceError() {
  const shell = globalThis.__POCKET_SHELL__;
  if (shell?.mode !== 'remote') return '';
  return typeof shell.deviceError === 'string' ? shell.deviceError : '';
}

/**
 * 外壳给的设备令牌 → 一份可以直接用的会话记录；没有令牌就返回 null。
 *
 * 令牌与设备 id 一律以外壳为准（手机重装后本地什么都没了，一次口令登录就
 * 应该马上能用），地址、设备名这类附带信息沿用旧记录。
 */
export function sessionFromShell(prior = store.session) {
  const token = shellDeviceToken();
  if (token.length === 0) return null;
  const shell = globalThis.__POCKET_SHELL__;
  const shellBase = typeof shell?.baseUrl === 'string' ? shell.baseUrl : '';
  const base = shellBase.length > 0 ? shellBase : (prior?.baseUrl ?? '');
  return normalizeSession({
    token,
    baseUrl: base,
    deviceId: shell?.deviceId || prior?.deviceId || '',
    deviceName: prior?.deviceName ?? '',
    serverName: prior?.serverName ?? '',
    pairedAt: prior?.pairedAt ?? Date.now(),
  });
}

export function serverName() {
  return store.bridge?.serverName
    || store.session?.serverName
    || store.me?.server?.name
    || '我的电脑';
}

export function token() {
  return store.session?.token ?? '';
}

export function visibleTasks() {
  const query = store.query.trim().toLowerCase();
  const out = [];
  for (const id of store.order) {
    const task = store.tasks.get(id);
    if (task === undefined) continue;
    if (!isVisible(task)) continue;
    if (!matchesFilter(task)) continue;
    if (query.length > 0) {
      const haystack = `${task.title ?? ''}\n${task.lastText ?? ''}\n${task.cwdName ?? ''}\n${task.cwd ?? ''}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    out.push(task);
  }
  // 列表永远按"最近活动"倒序显示。
  //
  // 服务端已经排好序，这里再排一次是因为前端还有别的写入路径：新任务会被
  // `unshift` 到 `store.order` 前面，实时事件也会改 `updatedAt`。只靠服务端的
  // 顺序，这些路径会让某一行突然窜到不该在的位置。
  out.sort((left, right) => {
    const byUpdate = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    if (byUpdate !== 0) return byUpdate;
    return String(left.id).localeCompare(String(right.id));
  });
  return out;
}

function matchesFilter(task) {
  switch (store.filter) {
    case 'running': return task.status === 'running';
    case 'done': return task.status === 'done' || task.status === 'idle' || task.status === 'cancelled';
    case 'error': return task.status === 'error';
    default: return true;
  }
}

/**
 * 子代理会话不该占列表。宿主有时会在 `subagents=0` 之后仍推送
 * `task.created` 帧，所以本地也要过一遍，否则计数和卡片会对不上。
 */
function isVisible(task) {
  return store.prefs.showSubagents === true || task.isSubagent !== true;
}

export function filterCounts() {
  let running = 0;
  let done = 0;
  let error = 0;
  let all = 0;
  for (const task of store.tasks.values()) {
    if (!isVisible(task)) continue;
    all += 1;
    if (task.status === 'running') running += 1;
    else if (task.status === 'error') error += 1;
    else done += 1;
  }
  return { all, running, done, error };
}

/* ---------------- session ---------------- */

/**
 * The remote shell writes the session record itself (it knows the relay origin
 * before the UI loads) and nests device/server, so reading has to accept both
 * shapes. Writing always uses the flat one.
 */
function normalizeSession(value) {
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.token !== 'string' || value.token.length === 0) return null;
  return {
    token: value.token,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    deviceId: String(value.deviceId ?? value.device?.id ?? ''),
    deviceName: String(value.deviceName ?? value.device?.name ?? ''),
    serverName: String(value.serverName ?? value.server?.name ?? ''),
    pairedAt: Number(value.pairedAt ?? value.at) || 0,
  };
}

export function loadSession() {
  return normalizeSession(readJson(LS.session, null));
}

export function saveSession(session) {
  store.session = normalizeSession(session);
  if (store.session === null) removeKey(LS.session);
  else writeJson(LS.session, store.session);
}

/* ---------------- preferences ---------------- */

export function loadPrefs() {
  const saved = readJson(LS.prefs, {});
  store.prefs = { ...store.prefs, ...(saved !== null && typeof saved === 'object' ? saved : {}) };
}

export function savePrefs(patch = {}) {
  store.prefs = { ...store.prefs, ...patch };
  writeJson(LS.prefs, store.prefs);
}

/* ---------------- offline cache ---------------- */

export function loadCache() {
  const cache = readJson(LS.cache, null);
  if (cache === null || !Array.isArray(cache.tasks)) return false;
  if (cache.baseUrl !== baseUrl()) return false;
  store.tasks = new Map(cache.tasks.map((task) => [task.id, task]));
  store.order = cache.tasks.map((task) => task.id);
  store.summary = { ...store.summary, ...(cache.summary ?? {}) };
  store.loading = false;
  return true;
}

export function saveCache() {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  const tasks = store.order
    .map((id) => store.tasks.get(id))
    .filter((task) => task !== undefined && (task.status === 'running' || (Number(task.updatedAt) || 0) > cutoff))
    .slice(0, LIMITS.cacheTasks);
  writeJson(LS.cache, { baseUrl: baseUrl(), tasks, summary: store.summary, at: Date.now() });
}

/* ---------------- theme ---------------- */

const themeMedia = window.matchMedia('(prefers-color-scheme: light)');

export function resolvedTheme() {
  const pref = store.prefs.theme;
  if (pref === 'light' || pref === 'dark') return pref;
  return themeMedia.matches ? 'light' : 'dark';
}

export function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#070b16');
  return theme;
}

themeMedia.addEventListener('change', () => {
  if (store.prefs.theme === 'auto') { applyTheme(); emit(); }
});
