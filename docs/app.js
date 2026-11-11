/**
 * DSH 随行 · phone client entry point.
 *
 * Boots the connect flow, owns the router, and is the single place that talks to
 * the host: every view gets its actions through `ctx` instead of importing the
 * network layer itself.
 *
 * 登录只有一种方式：中继外壳（`remote/remote.js`）用口令向电脑换一张设备
 * 令牌，再通过 `__POCKET_SHELL__` 交过来。拿到令牌就直接渲染任务列表，
 * 中间没有任何需要手输的码。
 */
import './lib/sprite.js';
import { $, empty, h, icon, raf } from './lib/dom.js';
import { ApiError, Realtime, createApi } from './lib/net.js';
import { relTime } from './lib/format.js';
import { toast } from './lib/ui.js';
import {
  LIMITS, applyTheme, baseUrl, isRelayShell, loadCache, loadPrefs, loadSession,
  saveCache, savePrefs, saveSession, serverName, sessionFromShell, shellDeviceError, store, token,
} from './store.js';
import { mountCompose } from './views/compose.js';
import { mountConnect } from './views/connect.js';
import { mountDetail } from './views/detail.js';
import { mountSettings } from './views/settings.js';
import { mountTasks } from './views/tasks.js';

const APP_VERSION = '1.0.0';
const SHELL = globalThis.__POCKET_SHELL__ ?? null;
const SESSION_CACHE = 'dsh.pocket.session.v1';

const app = document.getElementById('app');
const banner = createBanner();

let view = null;
let viewName = '';
let viewSeq = 0;
let realtime = null;
let lastBeatAt = 0;
let detailTimer = null;
let pollTimer = null;
let lastFrameAt = 0;
const tasksCache = new Map();

/* ---------------- api ---------------- */

const api = createApi({
  getBase: () => baseUrl(),
  getToken: token,
  onUnauthorized: (message) => {
    toast(message || '登录已失效，请重新用口令登录', { tone: 'danger' });
    signOut();
  },
});

/* ---------------- connection banner ---------------- */

function createBanner() {
  const el = h('div', { class: 'offline-banner', hidden: true },
    icon('alert', { size: 16 }),
    h('span', { class: 'offline-text' }),
    h('button', {
      class: 'offline-action', type: 'button', text: '重连',
      on: {
        click: () => {
          // force：卡在"正在连接"时那次尝试可能已经死了，必须打断它再重来。
          realtime?.kick(true);
          toast('正在重连…', { tone: 'info' });
          void loadTasks({ silent: true });
        },
      },
    }),
  );
  document.body.append(el);
  return el;
}

function setConn(state) {
  if (store.connState === state) return;
  store.connState = state;
  const online = state === 'online';
  banner.hidden = online || state === 'connecting' || store.session === null;
  if (!banner.hidden) {
    banner.querySelector('.offline-text').textContent = state === 'stale'
      ? '电脑那边没有响应，数据可能已经过期'
      : '与电脑的连接中断了，正在重试';
  }
  repaint();
}

/* ---------------- realtime ---------------- */

function startRealtime() {
  stopRealtime();
  if (store.session === null) return;
  lastBeatAt = Date.now();
  realtime = new Realtime({
    api,
    getBase: () => baseUrl(),
    getToken: token,
    // 中继外壳里禁止退回 SSE：中继只搬离散帧，SSE 那种长连接流一定拿不到。
    // 一旦回退，实时通道就永久死掉，用户只会看到"一直在重连"。
    allowSse: !isRelayShell(),
    onFrame,
    onBeat: () => { lastBeatAt = Date.now(); },
    onState: (state) => {
      if (state === 'online') setConn('online');
      else if (state === 'polling') setConn('polling');
      else if (store.connState !== 'stale') setConn(state === 'connecting' ? 'connecting' : 'offline');
    },
  });
  realtime.start();
}

function stopRealtime() {
  realtime?.stop();
  realtime = null;
}

function onFrame(frame) {
  lastFrameAt = Date.now();
  lastBeatAt = Date.now();
  const payload = frame.payload ?? {};
  switch (frame.type) {
    case 'hello': {
      store.me = { device: payload.device, server: payload.server };
      if (payload.server) store.bridge = { ...(store.bridge ?? {}), ...payload.server };
      setConn('online');
      void loadTasks({ silent: true });
      break;
    }
    case 'bridge.status': {
      store.bridge = { ...(store.bridge ?? {}), ...payload };
      if (payload.loading === false) store.loading = false;
      if (typeof payload.error === 'string' && payload.error.length > 0) store.loadError = payload.error;
      repaint();
      break;
    }
    case 'task.created':
    case 'task.updated': {
      upsertTask(payload);
      if (store.detailId === payload.id) {
        const detail = store.detail;
        if (detail !== null && detail !== undefined && detail.task) detail.task = payload;
        view?.updateHeader?.();
      }
      repaint();
      break;
    }
    case 'task.removed': {
      if (typeof payload.id === 'string') {
        store.tasks.delete(payload.id);
        store.order = store.order.filter((id) => id !== payload.id);
        repaint();
      }
      break;
    }
    case 'task.message': {
      // 列表只需要预览，而预览由 `task.updated` 带着；打开着的会话只向电脑端
      // **要新增的那几条**（`?after=<最后一条 id>`），不再整页重拉。
      // 整页重拉在流式输出时是 112 KB × 每 280ms，增量只有几 KB。
      if (store.detailId !== null && payload.taskId === store.detailId) scheduleDetailAppend(220);
      break;
    }
    case 'devices.changed': {
      if (store.screen === 'settings') void loadMe();
      break;
    }
    default: break;
  }
}

/* ---------------- data loading ---------------- */

async function loadMe() {
  try {
    const data = await api('/api/v1/me');
    store.me = data;
    if (data?.server) {
      store.bridge = { ...(store.bridge ?? {}), ...data.server };
      if (store.session !== null && !store.session.serverName) {
        saveSession({ ...store.session, serverName: data.server.name ?? '' });
      }
    }
    const started = performance.now();
    try {
      const health = await api('/api/v1/health', { auth: false, timeout: 6000 });
      store.latency = Math.max(1, Math.round(performance.now() - started));
      if (health !== null && typeof health === 'object') store.bridge = { ...(store.bridge ?? {}), ...health };
    } catch { /* latency is best effort */ }
  } catch (error) {
    if (error?.status !== 401) throw error;
  }
}

async function loadTasks({ silent = false } = {}) {
  if (store.session === null) return;
  if (!silent) store.loading = store.tasks.size === 0;
  try {
    const subagents = store.prefs.showSubagents === true ? '1' : '0';
    const data = await api(`/api/v1/tasks?limit=${LIMITS.taskPage}&subagents=${subagents}`, { timeout: 25_000 });
    const list = Array.isArray(data?.tasks) ? data.tasks : [];
    store.tasks = new Map(list.map((task) => [task.id, task]));
    store.order = list.map((task) => task.id);
    if (typeof data?.total === 'number') store.orderTotal = data.total;
    store.summary = { ...store.summary, ...(data?.summary ?? {}) };
    store.loadError = typeof data?.error === 'string' ? data.error : '';
    store.loading = false;
    saveCache();
    if (store.draft.cwd.length === 0) {
      const recent = list.find((task) => typeof task.cwd === 'string' && task.cwd.length > 0 && task.isSubagent !== true);
      if (recent !== undefined) store.draft.cwd = recent.cwd;
    }
    if (store.detailId !== null) {
      const fresh = store.tasks.get(store.detailId);
      if (fresh !== undefined && store.detail !== null) store.detail.task = fresh;
    }
  } catch (error) {
    store.loading = false;
    if (!silent) {
      store.loadError = error?.message ?? '读取任务失败';
      if (error?.status !== 401) toast(store.loadError, { tone: 'danger' });
    }
  }
  repaint();
  view?.updateHeader?.();
}

async function loadPresets() {
  try {
    const data = await api('/api/v1/presets');
    store.presets = Array.isArray(data?.presets) ? data.presets : [];
    if (store.draft.preset.length === 0 && typeof data?.defaultId === 'string') store.draft.preset = data.defaultId;
  } catch { /* optional capability */ }
}

async function loadWorkspaces() {
  try {
    const data = await api('/api/v1/workspaces');
    store.workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
    if (store.draft.cwd.length === 0) {
      const usable = store.workspaces.find((workspace) => workspace.available !== false);
      if (usable !== undefined) store.draft.cwd = usable.path;
    }
  } catch { /* optional capability */ }
}

/**
 * 静默刷新时把新的尾部页合并进已有列表，**不要**把用户已经往上翻出来的
 * 历史冲掉。
 *
 * - 新尾页的第一条能在已有列表里找到 → 从那个位置往后整段替换；
 *   更早的部分原样保留，`hasMore` / `nextBefore` 也保持。
 * - 找不到锚点（会话被重建等）→ 保留已有，只把没见过的新消息追加到末尾。
 */
function mergeTailInto(previous, data) {
  const incoming = Array.isArray(data?.messages) ? data.messages : [];
  const existing = Array.isArray(previous?.messages) ? previous.messages : [];
  if (existing.length === 0) {
    return {
      messages: incoming,
      hasMore: data?.hasMore === true,
      nextBefore: typeof data?.nextBefore === 'string' ? data.nextBefore : '',
    };
  }
  const anchor = incoming.length > 0 ? existing.findIndex((message) => message.id === incoming[0].id) : -1;
  if (anchor >= 0) {
    return {
      messages: [...existing.slice(0, anchor), ...incoming],
      hasMore: previous.hasMore === true,
      nextBefore: typeof previous.nextBefore === 'string' ? previous.nextBefore : '',
    };
  }
  const known = new Set(existing.map((message) => message.id));
  const appended = incoming.filter((message) => !known.has(message.id));
  return {
    messages: appended.length > 0 ? [...existing, ...appended] : existing,
    hasMore: previous.hasMore === true,
    nextBefore: typeof previous.nextBefore === 'string' ? previous.nextBefore : '',
  };
}

async function loadDetail(id, { silent = false } = {}) {
  const seq = ++viewSeq;
  if (!silent) { store.detail = null; store.detailError = ''; }
  try {
    const data = await api(`/api/v1/tasks/${encodeURIComponent(id)}`, { timeout: 25_000 });
    if (seq !== viewSeq || store.detailId !== id) return;
    const previous = silent ? store.detail : null;
    store.detail = previous === null || previous === undefined
      ? data
      : { ...data, ...mergeTailInto(previous, data) };
    store.detailError = '';
    if (data?.task) upsertTask(data.task, { repaint: false });
  } catch (error) {
    if (seq !== viewSeq || store.detailId !== id) return;
    store.detailError = error?.message ?? '读取会话失败';
  }
  if (store.screen === 'detail') {
    view?.paint();
    if (!silent) view?.scrollToBottom?.(true);
  }
}

/**
 * 往上翻：取当前最早那条消息**之前**的一页。
 *
 * @returns {number} 新增条数；`-1` 表示游标失效、列表已被服务端重置成尾部一页。
 */
async function loadOlder(id) {
  const detail = store.detail;
  if (detail === null || detail === undefined) return 0;
  if (detail.hasMore !== true) return 0;
  const cursor = typeof detail.nextBefore === 'string' ? detail.nextBefore : '';
  if (cursor.length === 0) return 0;
  if (store.detailLoadingOlder === true) return 0;
  store.detailLoadingOlder = true;
  try {
    const query = `?before=${encodeURIComponent(cursor)}&limit=${LIMITS.detailPage}`;
    const data = await api(`/api/v1/tasks/${encodeURIComponent(id)}${query}`, { timeout: 25_000 });
    // 期间切走了会话 / 列表被换掉：这一页直接丢弃，别写进别人的详情。
    if (store.detailId !== id || store.detail !== detail) return 0;
    const older = Array.isArray(data?.messages) ? data.messages : [];
    if (data?.cursorLost === true) {
      detail.messages = older;
      detail.hasMore = data?.hasMore === true;
      detail.nextBefore = typeof data?.nextBefore === 'string' ? data.nextBefore : '';
      return -1;
    }
    if (older.length === 0) {
      detail.hasMore = false;
      detail.nextBefore = '';
      return 0;
    }
    detail.messages = [...older, ...(Array.isArray(detail.messages) ? detail.messages : [])];
    detail.hasMore = data?.hasMore === true;
    detail.nextBefore = typeof data?.nextBefore === 'string' ? data.nextBefore : '';
    return older.length;
  } finally {
    store.detailLoadingOlder = false;
  }
}

function scheduleDetailRefresh(delay = 320) {
  if (detailTimer !== null) clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    detailTimer = null;
    if (store.detailId !== null && store.session !== null) void loadDetail(store.detailId, { silent: true });
  }, delay);
}

/* ---------------- 会话增量追新 ---------------- */

let appendTimer = null;

/** 合并短时间内的多条新消息，只发一次增量请求。 */
function scheduleDetailAppend(delay = 220) {
  if (appendTimer !== null) clearTimeout(appendTimer);
  appendTimer = setTimeout(() => {
    appendTimer = null;
    void appendDetailTail();
  }, delay);
}

/**
 * 只取「当前最后一条之后」的新消息，追加到已加载的转录末尾。
 *
 * 与整页重拉的区别：首屏 112 KB / 80 条，增量通常 1~3 条 / 2~4 KB。
 * 服务端给出 `reset`（游标失效）时退回整页重载，绝不把两段拼接。
 */
async function appendDetailTail() {
  const id = store.detailId;
  const detail = store.detail;
  if (id === null || detail === null || detail === undefined) return;
  if (store.detailAppending === true) return;

  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  const tail = messages.length > 0 ? messages[messages.length - 1] : null;
  const cursor = typeof tail?.id === 'string' ? tail.id : '';
  // 连一条都没有（页面刚进、首屏还没到）：走正常加载，别发无游标的增量请求。
  if (cursor.length === 0) {
    if (store.detailLoading === true || store.detailLoadingOlder === true) return;
    void loadDetail(id, { silent: true });
    return;
  }

  store.detailAppending = true;
  try {
    const data = await api(`/api/v1/tasks/${encodeURIComponent(id)}?after=${encodeURIComponent(cursor)}`, { timeout: 20_000 });
    // 期间用户切走了会话 / 详情被替换：这一批已经过时，直接丢弃。
    if (store.detailId !== id || store.detail !== detail) return;
    if (data?.reset === true) {
      void loadDetail(id, { silent: true });
      return;
    }
    const fresh = Array.isArray(data?.messages) ? data.messages : [];
    const known = new Set(messages.map((message) => message.id));
    const added = fresh.filter((message) => !known.has(message.id));
    if (added.length === 0) return;
    detail.messages = [...messages, ...added];
    if (typeof data?.total === 'number') detail.total = data.total;
    if (store.screen === 'detail') {
      view?.paintChat?.();
      // 用户停在底部就跟进最新；他正在往上翻历史时不要抢位置。
      if (store.chatAuto === true) view?.scrollToBottom?.(false);
    }
    // 这一批被预算截断了，说明还有更新的，继续追。
    if (data?.hasMoreAfter === true) scheduleDetailAppend(60);
  } catch { /* 增量失败静默：下一条消息或手动刷新会补上 */ } finally {
    store.detailAppending = false;
  }
}

/* ---------------- task helpers ---------------- */

function upsertTask(task, { repaint: shouldRepaint = true } = {}) {
  if (typeof task?.id !== 'string') return;
  store.tasks.set(task.id, task);
  if (!store.order.includes(task.id)) store.order.unshift(task.id);
  if (shouldRepaint) repaint();
}

/* ---------------- routing ---------------- */

function parseRoute(hash) {
  const raw = String(hash ?? location.hash ?? '').replace(/^#/u, '');
  if (raw.startsWith('/task/')) return { name: 'detail', id: decodeURIComponent(raw.slice(6)) };
  if (raw === '/new') return { name: 'new' };
  if (raw === '/settings') return { name: 'settings' };
  if (raw === '/connect') return { name: 'connect' };
  if (raw === '/tasks' || raw.length === 0) return { name: 'tasks' };
  return { name: 'tasks' };
}

function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (location.hash === target) { void applyRoute(); return; }
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) void applyRoute();
}

function destroyView() {
  if (view === null) return;
  if (viewName === 'tasks') {
    // Keep the list alive so returning from a task restores scroll position.
    view.screen.remove();
  } else {
    view.destroy?.();
    view.screen.remove();
    view = null;
  }
  viewName = '';
}

async function applyRoute() {
  const route = parseRoute();
  if (route.name !== 'connect' && store.session === null) {
    store.screen = 'connect';
  } else if (route.name === 'connect' && store.session !== null) {
    navigate('/tasks', { replace: true });
    return;
  } else {
    store.screen = route.name;
  }

  const next = store.screen;
  if (viewName !== next) {
    destroyView();
    viewName = next;
    view = mountFor(next, route);
    if (view.screen !== undefined && !view.screen.isConnected) app.append(view.screen);
  }

  if (next === 'detail' && store.detailId !== route.id) {
    store.detailId = route.id;
    store.detail = null;
    store.detailError = '';
    store.chatAuto = true;
    view.paint();
    void loadDetail(route.id);
  }
  if (next === 'new') {
    if (store.draft.cwd.length === 0) {
      store.draft.cwd = store.prefs.lastCwd || store.workspaces.find((w) => w.available !== false)?.path || '';
    }
    void Promise.all([loadWorkspaces(), loadPresets()]).then(() => view?.paint());
  }
  if (next === 'settings') {
    void loadMe().then(() => view?.paint());
  }

  view?.paint?.();
  updateTabbarState();
  window.scrollTo(0, 0);
}

function mountFor(name, route) {
  empty(app);
  const ctx = makeContext();
  switch (name) {
    case 'connect': return mountConnect(app, ctx);
    case 'detail': return mountDetail(app, ctx);
    case 'new': return mountCompose(app, ctx);
    case 'settings': return mountSettings(app, ctx);
    default: {
      const cached = tasksCache.get('tasks');
      if (cached !== undefined) {
        app.append(cached.screen);
        return cached;
      }
      const created = mountTasks(app, ctx);
      tasksCache.set('tasks', created);
      return created;
    }
  }
}

function updateTabbarState() {
  for (const tab of document.querySelectorAll('.tabbar .tab')) {
    const label = tab.textContent ?? '';
    const active = (store.screen === 'tasks' && label.includes('任务'))
      || (store.screen === 'settings' && label.includes('我的'));
    tab.classList.toggle('active', active);
  }
}

/* ---------------- context handed to views ---------------- */

function makeContext() {
  return {
    appVersion: APP_VERSION,
    api,
    navigate,
    back() {
      if (history.length > 1) history.back();
      else navigate('/tasks', { replace: true });
    },
    reframe() {},
    repaintAll() { repaint(); },
    paint: repaint,
    refresh() { void loadTasks(); },
    reloadTasks() { void loadTasks(); },
    openTask(id) { navigate(`/task/${encodeURIComponent(id)}`); },
    setFilter(filter) { store.filter = filter; repaint(); },
    setQuery(query) { store.query = query; repaint(); },
    clearFilters() { store.filter = 'all'; store.query = ''; repaint(); },
    toggleSearch(force) {
      const show = force ?? (store.searching !== true);
      store.searching = show;
      if (show) view?.focusSearch?.();
      else { view?.hideSearch?.(); store.query = ''; repaint(); }
    },
    reconnect() {
      realtime?.kick(true);
      void loadTasks();
      toast('正在重连…', { tone: 'info' });
    },
    async copyDiagnostics() {
      const lines = [
        `DSH 随行 v${APP_VERSION}`,
        `地址：${baseUrl()}`,
        `连接：${store.connState}`,
        `延迟：${store.latency} ms`,
        `任务：${store.tasks.size} 条`,
        `设备：${store.session?.deviceName ?? '未知'}`,
        `服务端：${serverName()}`,
        `UA：${navigator.userAgent}`,
      ].join('\n');
      try {
        await navigator.clipboard.writeText(lines);
        toast('诊断信息已复制', { tone: 'ok' });
      } catch {
        toast('复制失败，请手动长按选择', { tone: 'danger' });
      }
    },
    async requestNotifications() {
      if (typeof Notification === 'undefined') { toast('这个浏览器不支持通知', { tone: 'danger' }); return; }
      try {
        const result = await Notification.requestPermission();
        if (result !== 'granted') { savePrefs({ notify: false }); toast('没有拿到通知授权', { tone: 'danger' }); view?.paint(); }
      } catch { /* ignore */ }
    },
    unpair() { signOut({ forget: true }); },
    /** 回到口令闸门：清掉登录会话与设备令牌，由中继外壳重新弹登录页。 */
    relogin() {
      const shell = globalThis.__POCKET_SHELL__;
      if (typeof shell?.relogin === 'function') { shell.relogin(); return; }
      location.reload();
    },
    reloadPage() { location.reload(); },
    savedCwd(cwd) { savePrefs({ lastCwd: cwd }); },
    reloadDetail() { if (store.detailId !== null) void loadDetail(store.detailId); },
    refreshDetailSoon() { scheduleDetailRefresh(400); },
    /** 会话详情往上翻一页；返回新增条数（-1 = 游标失效已重置）。 */
    loadOlder(id) { return loadOlder(id); },
  };
}

/* ---------------- paint ---------------- */

const repaintScheduled = raf(() => {
  view?.paint?.();
  updateTabbarState();
});

function repaint() { repaintScheduled(); }

/* ---------------- session lifecycle ---------------- */

function signOut({ forget = false } = {}) {
  stopRealtime();
  saveSession(null);
  if (forget) store.tasks = new Map();
  store.order = [];
  store.detail = null;
  store.detailId = null;
  tasksCache.clear();
  navigate('/connect', { replace: true });
}

async function enterApp() {
  store.loading = store.tasks.size === 0;
  loadCache();
  store.screen = 'tasks';
  navigate('/tasks', { replace: true });
  startRealtime();
  const results = await Promise.allSettled([loadMe(), loadTasks(), loadPresets(), loadWorkspaces()]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined && failed.reason?.status !== 401) {
    setConn('offline');
  }
  repaint();
}

/* ---------------- timers ---------------- */

function startTimers() {
  setInterval(() => {
    if (store.session === null) return;
    const age = Date.now() - lastBeatAt;
    if (realtime?.state === 'online') {
      setConn(age > 26_000 ? 'stale' : 'online');
    }
    const running = [...store.tasks.values()].some((task) => task.status === 'running');
    if (running && document.visibilityState === 'visible' && realtime?.state !== 'online') {
      void loadTasks({ silent: true });
    }
  }, 5000);

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    for (const node of document.querySelectorAll('[data-ts]')) {
      const ts = Number(node.dataset.ts);
      if (ts > 0) node.textContent = relTime(ts);
    }
  }, 30_000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    realtime?.kick();
    if (Date.now() - lastFrameAt > 20_000) void loadTasks({ silent: true });
  });

  pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (store.connState === 'online' || store.session === null) return;
    void loadTasks({ silent: true });
    if (store.detailId !== null) scheduleDetailRefresh(0);
  }, 12_000);
}

/* ---------------- service worker ---------------- */

async function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const swUrl = SHELL?.swUrl ?? '/app/sw.js';
  const options = typeof SHELL?.scope === 'string' ? { scope: SHELL.scope } : undefined;
  try {
    const registration = await navigator.serviceWorker.register(swUrl, options);
    registration.addEventListener('updatefound', () => { /* 新外壳在下次启动生效 */ });
  } catch { /* 离线与安装到桌面是加分项，不是硬依赖 */ }
}

/* ---------------- boot ---------------- */

async function boot() {
  loadPrefs();
  applyTheme();
  // 唯一通路是加密中继：不是中继外壳（例如桌面 `/app` 本机预览）就清掉旧会话，
  // 免得残留一条不经中继的直连。
  store.session = isRelayShell() ? loadSession() : null;
  if (!isRelayShell()) saveSession(null);

  // 外壳刚用口令换到设备令牌：以它为准重建会话 —— 有令牌就直接进任务列表，
  // 中间不再有任何连接页。外壳明确说这台设备没有令牌可用
  // （被电脑端移除 / 设备数已满）时，本地那份旧会话一律作废。
  if (shellDeviceError().length > 0) saveSession(null);
  else adoptShellSession();

  window.addEventListener('hashchange', () => { void applyRoute(); });
  // 网络恢复、以及"下拉刷新"这类主动动作都要能打断卡死的连接。
  window.addEventListener('online', () => { realtime?.kick(true); void loadTasks({ silent: true }); });

  if (store.session !== null) {
    await enterApp();
  } else {
    navigate('/connect', { replace: true });
    await applyRoute();
  }
  startTimers();
  void registerWorker();
}

/** 用外壳给的设备令牌重建会话；没有令牌就什么也不做（返回 false）。 */
function adoptShellSession() {
  const adopted = sessionFromShell(store.session);
  if (adopted === null) return false;
  saveSession(adopted);
  return true;
}

boot().catch((error) => {
  console.error('boot failed', error);
  empty(app);
  app.append(
    h('div', { class: 'boot-failed' },
      h('div', { class: 'boot-failed-mark' }, icon('alert', { size: 28 })),
      h('h1', { text: '启动失败' }),
      h('p', { text: error?.message ?? '页面没能初始化' }),
      h('button', {
        class: 'btn btn-primary', type: 'button', text: '重试',
        on: { click: () => location.reload() },
      }),
    ),
  );
});

/** Exposed for the debug console and for the E2E harness. */
globalThis.__pocket = { store, api, navigate, loadTasks, LIMITS };
