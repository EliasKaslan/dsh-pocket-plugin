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
// 性能探针：必须在渲染代码之前加载，否则前几帧量不到。
import './lib/perf.js';
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
// 设置页要显示「前端版本」。它读的是 store，而 context 上的 appVersion 到不了那里，
// 所以直接暴露一个全局值——比在 store 里再加一个字段更不容易被后续重构漏掉。
globalThis.__POCKET_APP_VERSION__ = APP_VERSION;
const SHELL = globalThis.__POCKET_SHELL__ ?? null;
const SESSION_CACHE = 'dsh.pocket.session.v1';

const app = document.getElementById('app');
const banner = createBanner();

let view = null;
let viewName = '';
let viewSeq = 0;
let realtime = null;
let lastBeatAt = 0;
/** 断线横幅的去抖计时器：短抖动不打扰用户。 */
let bannerTimer = null;
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

/**
 * 断线横幅，带**去抖**。
 *
 * 手机上切后台再回来，浏览器往往已经把 WebSocket 挂掉；重连只要一两秒，但旧代码
 * 会在状态一变成 offline 的瞬间就把「连接中断」糊到用户脸上 —— 明明什么都没坏，
 * 用户看到的就是"每次切回来都提示断开"。
 *
 * 现在的规则：从 online 掉下去时**先等 6 秒**，期间若自己恢复了就完全不显示；
 * 只有真的持续断开才弹。显式的 stale（26 秒没有帧）仍然立即显示，因为那是真问题。
 */
function setConn(state) {
  if (store.connState === state) return;
  store.connState = state;
  const online = state === 'online';
  const paint = () => {
    banner.querySelector('.offline-text').textContent = store.connState === 'stale'
      ? '电脑那边没有响应，数据可能已经过期'
      : '与电脑的连接中断了，正在重试';
  };

  if (online || store.session === null) {
    // 只有"真的恢复了"才取消去抖；重连过程中的 connecting 不该取消它，
    // 否则长时间断线会因为一直在 connecting 而永远不提示用户。
    if (bannerTimer !== null) { clearTimeout(bannerTimer); bannerTimer = null; }
    banner.hidden = true;
  } else if (state === 'stale') {
    paint();
    banner.hidden = false;
  } else {
    banner.hidden = true;
    if (bannerTimer === null) {
      bannerTimer = setTimeout(() => {
        bannerTimer = null;
        if (store.connState !== 'online') { paint(); banner.hidden = false; repaint(); }
      }, 6_000);
    }
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

// 外壳在「被新页面接管」时要能立刻掐掉实时通道，否则旧页面会继续重连反抢。
globalThis.__POCKET_KILL_REALTIME__ = () => { stopRealtime(); };

function onFrame(frame) {
  lastFrameAt = Date.now();
  lastBeatAt = Date.now();
  const payload = frame.payload ?? {};
  // 提问（以及它的落定）需要一次**整页**静默刷新：`pendingQuestions` 只出现在
  // 完整详情里，增量帧按契约只带 messages/total/reset/hasMoreAfter。
  // 这只会发生在 `ask_user_question` 的两条工具消息上，不是流式路径的常态；
  // 千万别把它挪回下面的 task.message 分支 —— 那条分支必须保持"只追增量"。
  if (frame.type === 'task.message'
    && store.detailId !== null
    && payload.taskId === store.detailId
    && payload.message?.tool?.name === 'ask_user_question') {
    scheduleDetailRefresh(0);
  }
  switch (frame.type) {
    case 'hello': {
      store.me = { device: payload.device, server: payload.server };
      if (payload.server) store.bridge = { ...(store.bridge ?? {}), ...payload.server };
      setConn('online');
      void loadTasks({ silent: true });
      // 断线期间丢掉的帧补不回来（这段时间可能正好结束一轮）：
      // 顺手把当前打开的会话追一次尾部，避免"停在旧内容直到用户手动刷新"。
      if (store.detailId !== null) scheduleDetailAppend(0);
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
      // 只在"最近会话的目录确实是一个**已注册工作区**"时才预选它。
      // 以前无条件预选最近会话的 cwd：那个目录可能只是历史会话留下的、DSH 里并没有
      // 对应的工作区，于是新建的任务在电脑端被归到「未分组」（本机实测：注册工作区
      // 只有 1 个，而预选上的是另一个目录，任务就落到了未分组）。
      const normPath = (p) => String(p).replace(/[\\/]+$/u, '').toLowerCase();
      const registered = store.workspaces.filter((w) => w.recent !== true);
      const recentTask = list.find((task) => typeof task.cwd === 'string' && task.cwd.length > 0 && task.isSubagent !== true);
      if (recentTask !== undefined) {
        const hit = registered.find((w) => normPath(w.path) === normPath(recentTask.cwd));
        if (hit !== undefined) store.draft.cwd = hit.path;
      }
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
    const normPath = (p) => String(p).replace(/[\\/]+$/u, '').toLowerCase();
    // 已注册工作区（registry 里的）与"只是历史会话目录"（recent）要分开：
    // 后者在 DSH 里没有工作区，选它新建任务就会被归到「未分组」。
    const registered = store.workspaces.filter((workspace) => workspace.recent !== true);
    const usable = registered.find((workspace) => workspace.available !== false);
    if (store.draft.cwd.length === 0) {
      if (usable !== undefined) store.draft.cwd = usable.path;
      return;
    }
    const hit = store.workspaces.find((workspace) => normPath(workspace.path) === normPath(store.draft.cwd));
    if (hit === undefined || hit.recent === true) {
      // 草稿里指着一个未注册目录（多半是自动填充带进来的）：改回真正的注册工作区。
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
  if (store.detailAppending === true) {
    // 并发闸命中不能直接丢弃：掉线前最后一条消息最典型 —— 之后既没有新帧、
    // 也没有定时器，这条增量就永远补不回来了。记待办，收尾时立刻补一次。
    store.detailAppendPending = true;
    return;
  }

  /** 游标必须是服务端真实存在的消息 id；本地"发送中"的假 id 会让服务端 reset。 */
  const pickCursor = () => {
    const list = Array.isArray(detail.messages) ? detail.messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index]?.id;
      if (typeof candidate === 'string' && candidate.length > 0 && !candidate.startsWith('pending')) return candidate;
    }
    return '';
  };

  const cursor = pickCursor();
  if (cursor.length === 0) {
    if (store.detailLoading === true || store.detailLoadingOlder === true) return;
    void loadDetail(id, { silent: true });
    return;
  }

  store.detailAppending = true;
  try {
    const data = await api(`/api/v1/tasks/${encodeURIComponent(id)}?after=${encodeURIComponent(cursor)}`, { timeout: 20_000 });
    if (store.detailId !== id || store.detail !== detail) return;
    if (data?.reset === true) {
      // 游标失效：清掉本地假 id 再整页重载，避免"发送中"气泡永久卡住。
      detail.messages = (Array.isArray(detail.messages) ? detail.messages : [])
        .filter((message) => !String(message?.id ?? '').startsWith('pending'));
      void loadDetail(id, { silent: true });
      return;
    }
    const fresh = Array.isArray(data?.messages) ? data.messages : [];
    // 关键：用**此刻**的 messages。await 期间用户可能刚翻出更早一页，
    // 用 await 之前的快照重建会把那一整页覆盖掉。
    const current = Array.isArray(detail.messages) ? detail.messages : [];
    const known = new Set(current.map((message) => message.id));
    const added = fresh.filter((message) => !known.has(message.id));
    if (added.length === 0) {
      store.detailAppendFailures = 0;
      // 服务端对运行中会话的转录有 0.8 秒缓存，而在飞的这一条消息可能正好落在
      // 缓存窗口里 —— 若之后没有新帧，它就再也补不回来了。对同一个游标最多补拉一次。
      const running = detail?.task?.status === 'running';
      if (running && store.detailAppendRetryFor !== cursor) {
        store.detailAppendRetryFor = cursor;
        scheduleDetailAppend(900);
      }
      return;
    }
    store.detailAppendRetryFor = '';
    detail.messages = [...current, ...added];
    if (typeof data?.total === 'number') detail.total = data.total;
    store.detailAppendFailures = 0;
    if (store.screen === 'detail') {
      view?.paintChat?.();
      // 用户停在底部就跟进最新；正在往上翻历史时不要抢位置。
      if (store.chatAuto === true) view?.scrollToBottom?.(false);
    }
    if (data?.hasMoreAfter === true) scheduleDetailAppend(60);
  } catch {
    // 静默失败但记账：连续失败说明追新链路有问题，露在连接状态上。
    store.detailAppendFailures = (store.detailAppendFailures ?? 0) + 1;
    if (store.detailAppendFailures >= 3) setConn('offline');
  } finally {
    store.detailAppending = false;
    if (store.detailAppendPending === true) {
      store.detailAppendPending = false;
      scheduleDetailAppend(0);
    }
  }
}

/* ---------------- task helpers ---------------- */

function upsertTask(task, { repaint: shouldRepaint = true } = {}) {
  if (typeof task?.id !== 'string') return;
  // 合并而不是整条替换：task.updated 帧只带基础字段（不含 awaiting），
    // 整条替换会把刚点亮的「需要回答」徽标抹掉。
    store.tasks.set(task.id, { ...(store.tasks.get(task.id) ?? {}), ...task });
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

  // 离开会话必须清干净：否则再次进入同一个任务时 `detailId !== route.id` 为假，
  // 会直接复用旧转录、不重拉，而且定时器还在给没人看的会话发请求。
  if (next !== 'detail' && store.detailId !== null) {
    store.detailId = null;
    store.detail = null;
    store.detailError = '';
    store.detailAppendPending = false;
    if (appendTimer !== null) { clearTimeout(appendTimer); appendTimer = null; }
    if (detailTimer !== null) { clearTimeout(detailTimer); detailTimer = null; }
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
      // 把渲染耗时探针一并带出来：没有这组数字，"列表/详情渲染要不要优化"就只能
      // 靠猜。格式保持一行一条，方便直接贴回对话里。
      const perfLines = globalThis.__POCKET_PERF__?.snapshot?.() ?? [];
      const lines = [
        `DSH 随行 v${APP_VERSION}`,
        `地址：${baseUrl()}`,
        `连接：${store.connState}`,
        `延迟：${store.latency} ms`,
        `任务：${store.tasks.size} 条`,
        `设备：${store.session?.deviceName ?? '未知'}`,
        `服务端：${serverName()}`,
        `UA：${navigator.userAgent}`,
        ...(perfLines.length > 0 ? ['—— 渲染探针 ——', ...perfLines] : ['—— 渲染探针 ——', '（还没有数据，先滚动几次列表、打开一条会话）']),
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
    // 与外壳同一条纪律：醒来先把心跳时钟重置到此刻。
    // 冻结期间收不到帧是正常的，拿冻结前的 lastBeatAt 算 age 会在醒来瞬间
    // 判成「电脑那边没有响应」（age 轻松超过 26 s），而电脑其实一直是好的。
    lastBeatAt = Date.now();
    // 回前台不要无脑踢：健康的连接被踢一次，反而会闪一下「断开」。
    // 只有在不是 online 时才重建；online 时发一条 ping 探活即可。
    if (realtime?.state !== 'online') realtime?.kick();
    else {
      realtime?.probe?.();
      // 探活要有结论：醒来 10 秒内一帧都没到，就认定这条"看起来在线"的连接是半开的
      // （息屏/长时间后台被冻结后很常见），强制重建一次。
      // 不这么做就要等 DEAD_AFTER(75 s) 才判死，用户看到的就是"断了很久"。
      const wakeAt = Date.now();
      setTimeout(() => {
        // 空闲会话没有消息帧、只有 beat；只看 lastFrameAt 会把健康隧道判死，
        // 每次切回前台都白重建一条。取两者的较新者。
        if (Date.now() - Math.max(lastFrameAt, lastBeatAt) >= 10_000 && Date.now() - wakeAt >= 10_000) realtime?.forceKick?.();
      }, 10_000);
    }
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
    registration.addEventListener('updatefound', () => { /* 新外壳由下面的 controllerchange 接管 */ });
    // 新 SW 接管后自动刷新一次：否则用户要刷两遍（第一遍只是让新 SW 就位）。
    // hadController 用来排除"首次安装"——那种情况不该突然刷新。
    const hadController = navigator.serviceWorker.controller !== null;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    // 主动查一次更新：等用户手动刷新时才开始查，太晚了。
    void registration.update().catch(() => {});
    void checkShellFresh();
  } catch { /* 离线与安装到桌面是加分项，不是硬依赖 */ }
}

/**
 * 外壳自检：我跑的这一版，和线上那一版是不是同一版？
 *
 * 血证：手机端改了好几版，但手机一直跑着 Service Worker 缓存里的旧外壳，
 * 表现是"改了没反应"，而且现场只看到请求超时、看不到任何版本提示。
 * 判据用 **构建哈希**（sw.js 里的 `const BUILD`）与当前 cache 名比对，
 * 不一致就在界面上提示刷新——不再靠人猜。
 */
async function checkShellFresh() {
  try {
    if (typeof caches === 'undefined') return;
    const keys = await caches.keys();
    // 新旧两个缓存可能同时存在（新 SW 先预缓存、旧 SW 后才 activate 删除）：
    // 随手 find 一个可能拿到旧的，误报「界面是旧版本」。改为比对全部缓存。
    const mines = keys.filter((k) => k.startsWith('pocket-shell-'));
    if (mines.length === 0) return;
    const mineBuild = mine.slice('pocket-shell-'.length);
    const res = await fetch(swUrlOf(), { cache: 'no-store' });
    if (!res.ok) return;
    const text = await res.text();
    const liveBuild = /const BUILD = '([^']+)'/u.exec(text)?.[1];
    if (liveBuild === undefined) return;
    const stale = mines.map((k) => k.slice('pocket-shell-'.length)).filter((b) => b !== liveBuild);
    if (stale.length === 0) return;
    showStaleShellBanner(stale[0], liveBuild);
  } catch { /* 自检失败不影响使用 */ }
}

function swUrlOf() {
  try { return new URL(SHELL?.swUrl ?? '/app/sw.js', location.href).href; } catch { return '/app/sw.js'; }
}

/**
 * 硬刷新外壳：清掉壳缓存、注销 Service Worker，再带版本串重载。
 *
 * 为什么要这么重：普通刷新实测**不一定**能拿到新壳——导航可能命中 CDN 的旧 HTML，
 * 而 banner 的按钮晚一点再刷恰好赶上缓存过期，于是表现为"点按钮才行"。
 * 这个函数是用户显式点的，代价（多一次全量拉取）可以接受，换来确定性。
 */
async function hardRefreshShell() {
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names
        .filter((name) => name.startsWith('dsh-pocket-') || name.startsWith('pocket-shell-'))
        .map((name) => caches.delete(name)));
    }
  } catch { /* 清缓存失败也继续刷新 */ }
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.unregister();
  } catch { /* 注销失败也继续刷新 */ }
  const url = new URL(location.href);
  url.searchParams.set('v', String(Date.now()));
  location.replace(url.href);
}

function showStaleShellBanner(mineBuild, liveBuild) {
  if (document.getElementById('pocket-stale-shell') !== null) return;
  const box = h('div', { id: 'pocket-stale-shell' },
    h('span', { text: `界面是旧版本（${mineBuild.slice(0, 8)}），线上已是 ${liveBuild.slice(0, 8)}` }),
    h('button', {
      class: 'offline-action', type: 'button', text: '立即刷新',
      on: { click: () => void hardRefreshShell() },
    }),
  );
  box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483600';
  box.style.background = '#7a3d00';
  box.style.color = '#fff';
  box.style.padding = '10px 14px';
  box.style.display = 'flex';
  box.style.gap = '10px';
  box.style.alignItems = 'center';
  box.style.justifyContent = 'space-between';
  box.style.font = '13px/1.5 system-ui,sans-serif';
  document.body.append(box);
}

/* ---------------- boot ---------------- */

function stripCacheBuster() {
  // hardRefreshShell 用 ?v=<ts> 绕缓存；用完就清掉，否则会进书签/分享链接，
  // 且与 PWA 的 start_url（./）不是同一个 URL，两种启动路径行为分叉。
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('v')) return;
    url.searchParams.delete('v');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch { /* 地址栏 API 不可用就保持原样 */ }
}

async function boot() {
  stripCacheBuster();
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
