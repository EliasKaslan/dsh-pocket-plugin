/* ============================================================
   DSH Pocket · remote shell bootstrap (browser ESM)
   ------------------------------------------------------------
   This page is static. Everything dynamic is tunnelled through an
   shared AES-256-GCM room to the desktop bridge. Holders of the room key
   can read room traffic. The UI itself (app.js) is untouched by the
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
     直接进，外壳把整条 `#r=…&k=…&t=1` 存进本机 localStorage。`k` 就是房间里
     那把 AES-256-GCM 密钥，所以这是**把解密能力放到本机**：本页所在 origin 上
     的任何脚本都能读到它。这正是外壳必须与 app 同源托管、且不接任何第三方脚本
     的原因（见 `remote/index.html` 的 CSP `script-src 'self'`）。
     彻底作废的办法是电脑端「重置链接」——换房间后旧链接立即失效。
   ============================================================ */

/*
 * 断因的翻译表（纯函数，见 `web/lib/relay-diag.js`）。
 *
 * 源码在 `web/lib/`，构建后落在外壳根目录的 `./lib/relay-diag.js` —— 与下面
 * `await import('./app.js')` 同一个规则：`web/` 与 `remote/` 的**产物**在同一层，
 * 所以外壳里写的相对路径按产物布局来。
 *
 * 为什么不让连接页自己去 import 它：`web/sw.js` 的 ASSETS 是一份手写清单
 * （那文件不在本次可改范围内），新加一条相对 import 而清单没跟上，装过 SW 的手机
 * 首次离线打开就是模块 404、整屏白 —— `test/unit/client-guards.test.mjs` 专门钉着
 * 这条。所以纯逻辑由外壳 import，UI 通过 `__POCKET_DIAG__` 只读地拿到它。
 */
import {
  buildDiagText, describeAdvice, describeBrokerChoice, describeFailure, describeFailureShort,
  diagRows, normalizeConnack,
} from './lib/relay-diag.js';
/*
 * 连接层的重试策略与分片重组表同样放在 `web/lib/`（纯逻辑，Node 可直接 import）：
 * 这一段以前是浏览器代码里的内联循环，只能靠对源码做正则断言；抽出去之后
 * `test/unit/shell-retry` / `test/unit/shell-parts` 测的是行为（失败几次、隔多久、
 * 谁被淘汰），而不是"某个字符串还在不在"。
 */
import { CONTROL_RESEND_DELAYS, connectWithRetry, deriveThresholds, wakeDecision } from './lib/shell-retry.js';
import { PartTable } from './lib/shell-parts.js';import { adoptScope, scopeVerdict } from './lib/shell-session.js';

/* ------------------------------- constants ------------------------------ */

/** Fake origin the shimmed UI believes it is talking to. */
const REMOTE_ORIGIN = 'https://dsh-remote.local';

/** Fallback broker: only ever carries ciphertext. Real value comes from `#s=`. */
const DEFAULT_BROKERS = ['wss://broker-cn.emqx.io:8084/mqtt'];

/** Wire protocol version. 2 added `seq`/`ts`/`sid` and the `reject` frame. */
const PROTOCOL = 2;
/**
 * 信封协议版本（v3 = 二进制信封 `[0x03][iv 12][ct][tag 16]`）。
 *
 * **与 `PROTOCOL` 分开**：`PROTOCOL` 是帧协议（`hello.ver`，老桌面只会看它），
 * 这个号只表示「我认识二进制信封」，靠 `hello.proto` 交换。实际用哪一版由
 * `send()` 按**桌面声明的** `proto` 决定（见 `this.pcProto`），未协商一律 v2。
 *
 * 为什么不干脆把 `PROTOCOL` 加到 3：老桌面按 `ver` 判断兼容性（`pcVersion`），
 * 改它等于宣布"这是另一套帧协议"，而实际上帧格式一个字节都没变 —— 变的只是
 * 密文怎么装进 MQTT payload。两个编号各管一层，和 `SEAL_VERSION` 与 `ver` 的关系一样。
 */
const ENVELOPE_PROTOCOL = 3;

const HELLO_TIMEOUT_MS = 12_000;
/** hello is rate-limited to one per 10 s so two peers cannot echo each other. */
const HELLO_MIN_GAP_MS = 10_000;
/**
 * Budget for the *last* attempt (early resends use the short backoffs below),
 * so a slow route is not cut off while a lost frame still gets repaired fast.
 * The desktop caches replies by request id, so a retry replays the answer
 * instead of re-running the request.
 *
 * **一条请求的总预算 = Σ backoff + 这一次的 timeout**（不是 timeout × attempts：
 * 每次 attempt 都会清掉上一个计时器，`entry.timer` 是单个的）：
 *
 *     1200 + 2400 + 3600 + 8000 = 15 200 ms
 *
 * 这组数字必须与 `web/lib/rpc-budget.js` 一致，并被 `test/domain/shell-rpc-budget`
 * 拿三条关系钉住：① 与纯逻辑模块的常量相同；② 总预算 **+ `DECOMPRESS_TIMEOUT_MS`
 * 一起**小于应用侧 `DETAIL_TIMEOUT_MS`（否则"解压超时"这个原因永远显示不出来，
 * 手机还白跑一整段解压）；③ 判死用的是**绝对截止时刻**，任何一条路径（心跳重发、
 * 重连重发、过期 attempt 的迟到失败）都不能把它拖长。
 *
 * 旧值 16_000 / [1_200, 2_400, 4_800] 一共 24 400 ms，已经比应用侧的 20 s 长 ——
 * 于是先到点的永远是应用层：用户看到笼统的「请求超时」，外壳的同 id 重放还没跑完
 * 就被取消，net.js 再从头重试一轮，界面上的「加载中…」一停就是几十秒。
 */
const RPC_TIMEOUT_MS = 8_000;
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
const RPC_BACKOFF_MS = [1_200, 2_400, 3_600];
/**
 * 重连成功后**额外**允许的重发次数（不受 `RPC_ATTEMPTS` 约束）。
 *
 * 为什么需要它：一次多片响应在重组途中遇到重连时，`abortTransport()` 会清掉
 * 半包表但保留在途请求。此时如果四次 attempt 已经用尽，`entry.retry()` 是个
 * **空操作** —— 桌面按同一个 id 重放的完整回包再也拼不出来，只能干等预算耗尽。
 * 重连一次就多给一次重发（桌面命中幂等缓存，不会重复执行），把这条路救回来。
 */
const RPC_HEAL_RESENDS = 1;
/** 在途 RPC 面包屑的条数上限（只给诊断块读，不参与任何决策）。 */
const RPC_LOG_MAX = 8;
/**
 * 解压一条 gzip 大响应的上限。
 *
 * `new Response(stream).arrayBuffer()` **没有**任何超时：解压流一旦卡住（手机端
 * 解密出的字节被截断、或 WebKit 的 DecompressionStream 半死），这个 promise
 * 永远不 resolve，而应用侧的 AbortSignal 已经传不进来了（外壳的 request 早就
 * resolve 了）—— 界面于是**永久**停在「加载中…」。这是整条链上唯一没有兜底的
 * 一步，所以单独给它一个截止时刻。
 */
const DECOMPRESS_TIMEOUT_MS = 10_000;

/**
 * 一条请求的最坏耗时。**必须与 `web/lib/rpc-budget.js` 的 `rpcWorstCaseMs()` 同义**
 * （那边有用例逐字段比对）：前 `attempts-1` 次各等一个 backoff，最后一次等满 `timeout`。
 */
function rpcBudgetMs(attempts = RPC_ATTEMPTS, timeout = RPC_TIMEOUT_MS) {
  let total = Math.max(1, Number(timeout) || RPC_TIMEOUT_MS);
  for (let index = 0; index < Math.max(1, attempts) - 1; index += 1) {
    const value = Number(RPC_BACKOFF_MS[index]);
    total += Number.isFinite(value) && value >= 0 ? value : 2_000;
  }
  return total;
}

/**
 * 判死用的错误：带上 `pocketCode`，让 `web/lib/net.js` 能把它原样翻给界面，
 * 而不是一律说成「连不上电脑」（链路明明是通的，只是回包没送到）。
 */
function rpcTimeoutError(timeout) {
  const error = new Error('中继请求超时');
  error.pocketCode = 'relay_timeout';
  error.timeoutMs = Number(timeout) || RPC_TIMEOUT_MS;
  return error;
}

/**
 * 下行分片凑不齐（这一组回包不可能再拼回来了）。
 *
 * 与"超时"分开是因为**处置不同**：超时说明"回声慢/可能还在路上"，而同 id 重放
 * 已经跑完就该认输；丢片则是"这一份响应的字节再也凑不齐了"，换一个新的请求
 * （重新切一份响应）更可能成功 —— `web/lib/net.js` 把它当**可重试**处理。
 */
function partsLostError(count) {
  const error = new Error('大响应的分片没到齐（下行丢了片）');
  error.pocketCode = 'parts_lost';
  error.partsLost = Math.max(1, Number(count) || 1);
  return error;
}

/**
 * 面包屑里的路径：只留 pathname 并截断。
 *
 * query 里是游标 / 分页参数，对"为什么没回包"没有解释力；而诊断文本会被用户
 * 复制粘贴出去，能少一个字段就少一个泄露面（房间密钥、设备令牌、链接里的
 * `r`/`t` 一个都不许进快照 —— 见 `test/domain/shell-relay-diag`）。
 */
function breadcrumbPath(path) {
  const text = String(path ?? '');
  const cut = text.indexOf('?');
  const only = cut >= 0 ? text.slice(0, cut) : text;
  return only.slice(0, 48);
}
/**
 * 离线横幅 + 重建的静默阈值（**老桌面**下的值：8 s 一跳的老假设）。
 *
 * 1.1.0 起桌面按活跃度自适应心跳（空闲 30 s / 有实时通道或在途请求 8 s），并在
 * hello / beat 里下发当前周期 `beatMs`。本实例真正用的是 `this.pcStaleMs`
 * （由 `noteBeatMs()` 按 `deriveThresholds()` 推导）；这个常量只在**收不到**
 * `beatMs`（老桌面 / 脏值）时兜底，行为与 1.0.10 逐字等价。
 */
const PC_STALE_MS = 26_000;
/**
 * 下行静默多久就允许重建一次中继连接（冷却，避免抖动时狂重建）。
 */
const RESTART_COOLDOWN_MS = 15_000;
/**
 * 「有请求在途 + 下行静默」多久就重建（**早于**请求预算烧完）。
 *
 * 15.2 s（`rpcBudgetMs(4, 8_000)`）< 26 s（上面那个 `PC_STALE_MS`），所以只靠
 * 「下行静默 26 s」那一条时，每一次下行半死都必然是请求先判死、拿 `relay_timeout`
 * 交给界面（`web/lib/net.js` 还把它当成不可重试的定论），而救它的重建还在 10.8 s 之外。
 * 桌面每 8 s 一条 beat：10 s 一帧下行都没有，说明回包根本进不来，此时重建最便宜。
 *
 * 与 `web/lib/shell-retry.js` 的导出常量 `RPC_STALL_REBUILD_MS` 同值（各写一份，
 * 由 `test/unit/shell-stall-rebuild.test.mjs` 逐字段比对）：外壳这边必须是数字字面量，
 * 看门狗的行为用例才能把常量切进 vm 沙箱真跑。
 *
 * **但这只是「已知心跳 8 s」时的值**：桌面把心跳拉长到 30 s 之后，10 s 的静默是
 * 完全正常的（下一次 beat 还没到），照 10 s 判就会误重建 —— 每次重建都要拆掉
 * ws 隧道、作废正在拼的分片。所以运行时用 `this.rpcStallRebuildMs`（由下发的
 * `beatMs` 按 `deriveThresholds()` 推导，永不小于这个常量）；这个字面量只在
 * 收不到 `beatMs` 的老桌面下生效（红线由 `test/unit/shell-adaptive-beat.test.mjs`
 * 钉住：任何档位下推导值都必须**长于一个心跳**）。
 */
const RPC_STALL_REBUILD_MS = 10_000;
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
/**
 * Largest single plaintext frame before fragmentation. The reassembly limits
 * (`PART_MAX_TOTAL` / `PART_MAX_OPEN` / `PART_TTL_MS`) live in
 * `web/lib/shell-parts.js` next to the table that enforces them.
 */
const MAX_FRAME = 64 * 1024;
/** Uplink fragment budget: how many parts one request body may be split into. */
const PART_MAX_TOTAL = 64;

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

const $ = (id) => globalThis.document?.getElementById(id) ?? null;

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

/**
 * 一次转成字符串的字节数。
 *
 * `String.fromCharCode.apply` 的参数个数有上限（各引擎 64K 级），8 KB 远在安全区内；
 * 分块的意义不是"绕过上限"，而是让下面那个 `text +=` 只在 n/8192 次上加长，
 * 而不是每个字节都重抄一遍整串。
 */
const B64_CHUNK_BYTES = 8 * 1024;

function b64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 旧实现是逐字节 `text += String.fromCharCode(...)`：71 KB 就是 72 704 次拼接
  // （探针在手机端实测 10.1 ms，而同样体积的 `unb64` 只要 0.17 ms；桌面 V8 因为有
  // cons string 只慢 2~3 倍，但机制一样，换到 WebKit 就是实打实的卡顿）。
  // 改成按 8 KB 分块 `String.fromCharCode.apply` 之后只有 9 次拼接，O(n)。
  let text = '';
  for (let offset = 0; offset < view.length; offset += B64_CHUNK_BYTES) {
    text += String.fromCharCode.apply(null, view.subarray(offset, offset + B64_CHUNK_BYTES));
  }
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
/**
 * 「复制诊断信息」按钮：任何一条 `showFatal` 都带上它。
 *
 * 为什么连致命页也要给：最难受的场景恰恰是**一次都没连上**（这时连连接页都到不了，
 * 只有 splash），而这一屏过去只给一个「重新加载」。用户能提供的唯一有效信息就是
 * 截图，而截图里没有 `error.code`。把可粘贴的文本放在这里，用户长按复制一次就能把
 * 真正的原因带出来 —— 否则永远只能靠猜是 DNS、TLS 还是被掐。
 *
 * 复制失败（http 页面 / 旧浏览器没有 clipboard）时退回一个可选中的只读文本框：
 * 手机上"长按选中"比"点一下"更可靠。
 */
function diagCopyButton() {
  const diag = globalThis.__POCKET_DIAG__;
  if (diag === undefined || typeof diag.snapshot !== 'function' || typeof diag.buildDiagText !== 'function') return null;
  const text = () => {
    try { return diag.buildDiagText(diag.snapshot()); } catch { return '诊断信息读取失败'; }
  };
  const button = el('button', {
    class: 'pocket-btn pocket-btn-ghost',
    type: 'button',
    text: '复制诊断信息',
    onclick: () => {
      const value = text();
      const fallback = () => {
        if (splashExtra === null) return;
        button.remove();
        splashExtra.append(el('textarea', {
          class: 'pocket-diag-raw',
          readonly: 'readonly',
          rows: '6',
          spellcheck: 'false',
        }));
        const box = splashExtra.querySelector('.pocket-diag-raw');
        if (box !== null) { box.value = value; box.focus(); box.select?.(); }
      };
      try {
        const pending = globalThis.navigator?.clipboard?.writeText(value);
        if (pending === undefined) { fallback(); return; }
        pending.then(() => { button.textContent = '已复制'; }, fallback);
      } catch { fallback(); }
    },
  });
  return button;
}

/**
 * 致命页上「重新连接」的动作。
 *
 * 引导流程一装好就把它接上（见 main() 里的 `retryBoot`），在那之前是 null ——
 * 早期那几条 fatal（链接参数不合法 / 密钥无效）此时什么都还没启动，重连没有意义。
 *
 * 为什么要有它：1.0.2 的失败页只有一个「重新加载」，而刷新回到的**还是同一张
 * 死页**（首连失败的现场就是这样）。失败页必须是可恢复的入口，不是终点。
 */
let retryBootAction = null;

/**
 * 失败页上的「重新连接」按钮（引导流程还没接上时返回 null）。
 *
 * 抽成独立函数而不是写在 `showFatal()` 里：致命页的按钮顺序是
 * 重连 → 重载 → 复制诊断，而复制按钮的降级逻辑（clipboard 不可用时退回可选中
 * 的只读文本框）已经单独测着，别让两段长逻辑缠在一起。
 */
function fatalRetryButton() {
  if (typeof retryBootAction !== 'function') return null;
  return el('button', {
    class: 'pocket-btn pocket-btn-primary',
    type: 'button',
    text: '重新连接',
    onclick: () => {
      const retry = retryBootAction;
      try { retry(); } catch { location.reload(); }
    },
  });
}

function showFatal(title, detail) {
  if (splash === null) return;
  splash.classList.remove('is-hidden');
  splash.classList.add('is-error');
  setSplash(title, detail ?? '');
  if (splashExtra === null) return;
  const children = [];
  const retry = fatalRetryButton();
  if (retry !== null) children.push(retry);
  children.push(el('button', {
    class: 'pocket-btn pocket-btn-ghost',
    type: 'button',
    text: retry === null ? '重新加载' : '重新加载页面',
    onclick: () => location.reload(),
  }));
  const copy = diagCopyButton();
  if (copy !== null) children.push(copy);
  splashExtra.replaceChildren(...children);
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
  const scopeBytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([room, keyB64])));
  /**
   * 解一条 **v2 JSON 信封**（`{"v":1,"n":b64(iv),"c":b64(ct‖tag)}`）。
   *
   * 内层闭包是刻意的：`test/support/relay-client.interop.test.mjs` 用
   * `shell-source.mjs` 把 `makeSealer` 这一个函数整体切进 vm 里跑，任何**模块级**
   * 新符号都会在沙箱里变成 ReferenceError（信封号/魔数只能写成函数内的字面量）。
   */
  const openJson = async (text, aad) => {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('信封版本不正确');
    const iv = unb64(parsed.n);
    const blob = unb64(parsed.c);
    if (iv.length !== 12 || blob.length <= 16) throw new Error('信封内容不正确');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, blob);
    return JSON.parse(decoder.decode(plaintext));
  };
  /** 解一条 **v3 二进制信封**；`iv` 必须正好 12 字节、`blob` 必须含 16 字节 tag。 */
  const openBinary = async (view, aad) => {
    if (view.length <= 1 + 12 + 16) throw new Error('信封内容不正确');
    const iv = view.subarray(1, 13);
    const blob = view.subarray(13);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, blob);
    return JSON.parse(decoder.decode(plaintext));
  };
  return {
    scope: b64(new Uint8Array(scopeBytes)),
    /** v2 JSON 信封（老桌面唯一认识的那一版，也是未协商时的默认）。 */
    async seal(object, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify(object));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, plaintext);
      return JSON.stringify({ v: 1, n: b64(iv), c: b64(new Uint8Array(sealed)) });
    },
    /**
     * v3 二进制信封：`[0x03][iv 12][ct][tag 16]`。
     *
     * 安全参数与 `seal()` **逐项相同**（同一把 key、AAD = 主题串、IV 每次 12 字节
     * 随机、tag 16 字节）；区别只是不再 base64 + 套 JSON。返回 `Uint8Array` 而不是
     * 字符串：mqtt.js 的 payload 直接收 ArrayBufferView，浏览器会按二进制发出去。
     */
    async sealBinary(object, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify(object));
      const sealed = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
        key,
        plaintext,
      ));
      const out = new Uint8Array(1 + 12 + sealed.length);
      out[0] = 0x03;
      out.set(iv, 1);
      out.set(sealed, 13);
      return out;
    },
    /**
     * 按线上形态解封（**收方向唯一入口**）：字符串 = v2 JSON 文本；
     * `Uint8Array`/`Buffer` = 二进制信封，首字节决定 v2（`{`）还是 v3（`0x03`）。
     *
     * 首字节不认识 ⇒ 抛错（调用方 `onMessage()` 只计数、不崩溃）。这里不能"猜"：
     * 猜错会把密文当明文喂给 JSON.parse，错误信息就再也指不到真正的原因。
     */
    async unseal(envelope, aad) {
      if (typeof envelope === 'string') return openJson(envelope, aad);
      const view = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
      const magic = view.length > 0 ? view[0] : -1;
      if (magic === 0x03) return openBinary(view, aad);
      // 老桌面把 v2 JSON 文本当二进制递过来（mqtt.js 两种都可能给 Uint8Array）。
      if (magic === 0x7b) return openJson(decoder.decode(view), aad);
      throw new Error('信封版本不正确');
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

let authSaveGeneration = 0;
async function saveAuthSession(session) {
  const generation = ++authSaveGeneration;
  const payload = encoder.encode(JSON.stringify({ ...session, at: Date.now() }));
  if (crypto?.subtle !== undefined) {
    try {
      const key = await deriveAuthKey(true);
      if (key !== null) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
        const record = { v: 1, iv: b64(iv), ct: b64(new Uint8Array(sealed)) };
        if (generation !== authSaveGeneration) return;
        if (writeStorage('local', LS_AUTH, JSON.stringify(record))) {
          dropStorage('session', `${LS_AUTH}.plain`);
          return;
        }
      }
    } catch { /* fall through to the session-only copy */ }
  }
  // No WebCrypto (or storage refused): keep the token in this tab only.
  if (generation !== authSaveGeneration) return;
  dropStorage('local', LS_AUTH);
  writeStorage('session', `${LS_AUTH}.plain`, JSON.stringify(session));
}

async function loadAuthSession(scope) {
  const raw = readStorage('local', LS_AUTH);
  if (raw === null) {
    const plain = readStorage('session', `${LS_AUTH}.plain`);
    return plain === null ? null : parseAuthSession(plain, scope);
  }
  try {
    const record = JSON.parse(raw);
    if (record === null || typeof record !== 'object' || record.v !== 1) return null;
    const key = await deriveAuthKey(false);
    if (key === null) return null;
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, key, unb64(record.ct));
    return parseAuthSession(decoder.decode(plaintext), scope);
  } catch {
    // Wrong key (fresh browser session) or tampered record: drop it.
    dropStorage('local', LS_AUTH);
    return null;
  }
}

function parseAuthSession(text, scope) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.token !== 'string' || parsed.token.length < 20) return null;
    const expiresAt = Number(parsed.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt <= Date.now()) return null;
    // v1.0.2 写下的记录没有 `scope`：按 legacy 接受（判据见 web/lib/shell-session.js）。
    // 强校验一上，升级后的每台手机都会把本地有效令牌当"不是这个房间的"丢掉，
    // 于是所有人都被踢回口令登录一次 —— 那是升级事故，不是安全收益。
    const verdict = scopeVerdict(parsed.scope, scope);
    if (verdict === 'mismatch') return null;
    const record = adoptScope(parsed, scope);
    return { token: record.token, scope, expiresAt, user: String(parsed.user ?? '') };
  } catch {
    return null;
  }
}

function clearAuthSession() {
  authSaveGeneration += 1;
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
function readDeviceSession(scope) {
  for (const key of [SS_SESSION, APP_SESSION_KEY]) {
    const raw = readStorage('local', key);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw);
      const token = typeof parsed?.token === 'string' ? parsed.token : '';
      if (token.length === 0) continue;
      // 缺 `scope` 的旧记录按 legacy 接受（见 web/lib/shell-session.js 的
      // `scopeVerdict()`）：令牌真伪由电脑端校验，这里 fail-closed 只会让
      // 每一台升级上来的手机都被踢回口令登录。
      if (scopeVerdict(parsed?.scope, scope) === 'mismatch') continue;
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
function persistDeviceSession(token, deviceId, { name, room, scope }) {
  if (typeof token !== 'string' || token.length === 0) {
    clearDeviceSession();
    return;
  }
  saveDeviceSession({
    scope,
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
  revoked: () => '这台手机的配对已被移除，请重新输入口令配对。',
  expired: () => '登录已过期，请重新输入口令。',
  'device-unavailable': () => '电脑暂时无法登记这台手机，请检查电脑端状态后重试。',
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
      if (reply.ok === true && typeof reply.token === 'string' && relay.deviceToken) {
        const session = { token: reply.token, scope: relay.sealer.scope, expiresAt: Number(reply.expiresAt) || 0, user: name };
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

/* ------------------------------ 旧式握手提示 ----------------------------- */

/**
 * 电脑端插件版本落后（hello 里没有 `authReplyId`）时的降级提示。
 *
 * 1.0.2 在这里直接 `showFatal('需要更新电脑端插件')` —— 整屏硬拦，唯一的按钮是
 * 「重新加载」，而重新加载拿到的还是同一张死页。真实场景恰恰是**手机 SW 已经缓存
 * 了新外壳、电脑端插件还没升级**：用户什么也做不了，只能白屏等着两边版本对上。
 *
 * 协议本身没有变（`auth` / `login` 的帧格式一致），旧式握手仍然是可用的，缺的只是
 * 桌面端"我支持按 id 回控制帧"这个标记。所以检测保留、降级成可操作的提示：
 * 写清具体步骤，再给一个「仍然继续」。这个 Promise 只在用户点「仍然继续」时
 * resolve —— 点「重新加载」走的是真的刷新。
 *
 * @returns {Promise<void>}
 */
function promptLegacyDesktop() {
  return new Promise((resolve) => {
    const step = (text) => el('li', { class: 'pocket-step', text });
    const card = el('div', { class: 'pocket-card pocket-legacy', id: 'pocket-legacy' }, [
      el('div', { class: 'pocket-mark', 'aria-hidden': 'true' }),
      el('h1', { class: 'pocket-title', text: '电脑端插件版本较旧' }),
      el('p', {
        class: 'pocket-sub',
        text: '这个手机页面比电脑上的插件新。现在还能用，但建议把两边版本对齐，否则下次更新可能连不上。',
      }),
      el('ol', { class: 'pocket-steps' }, [
        step('在电脑上打开 DSH，进入「插件 / 市场」把 DSH Pocket 更新到最新版。'),
        step('更新完成后回到这个页面，点下面的「重新加载」。'),
        step('暂时不能更新就点「仍然继续」：旧式握手仍然可用，只是少一条更严格的校验。'),
      ]),
      el('div', { class: 'pocket-actions' }, [
        el('button', { class: 'pocket-btn pocket-btn-ghost', type: 'button', text: '重新加载', onclick: () => location.reload() }),
        el('button', { class: 'pocket-btn pocket-btn-primary', type: 'button', text: '仍然继续', onclick: () => resolve() }),
      ]),
    ]);
    document.body.append(el('div', { class: 'pocket-gate', role: 'dialog', 'aria-modal': 'true' }, [card]));
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
    // 下行分片表：满了就 LRU 淘汰最旧的半包（见 web/lib/shell-parts.js），
    // 而不是像 1.0.2 那样把新来的分片丢掉、让大响应干等 30 秒 TTL。
    this.parts = new PartTable();
    this.sockets = new Map();
    this.pcHello = null;
    this.pcSeenAt = 0;
    this.pcStale = false;
    this.pcVersion = 0;
    /**
     * 桌面在 `hello`/`beat` 里声明的**信封**协议版本（0 = 还没收到 / 老桌面不认识
     * `proto`）。这就是协商里的 "desktopProto"：
     *
     *  - 上行用哪一版**只由它决定**（`send()` 里 `Number(this.pcProto) >= 3`）；
     *  - 0 是刻意的保守默认值 —— 拿不准就发 v2，老桌面 100% 能解；
     *  - 每一帧 hello/beat 都重写（缺 `proto` 就写回 0），不做"学会就一直记得"：
     *    桌面被降级/换回老版本时必须立刻退回 v2，否则我们发出去的二进制帧老桌面
     *    一帧都解不开，而两边日志都只有"什么都没发生"；
     *  - `restart()` 里也清零：换了一条链路就从"不知道对面是谁"重新开始。
     */
    this.pcProto = 0;
    /**
     * 桌面下发的当前心跳周期（`hello` / `beat` 的增量字段 `beatMs`）。
     *
     * 0 = 还没学到（老桌面）：这时三个阈值全部用上面那几个常量（8 s 老假设），
     * 行为与 1.0.10 完全一致。学到之后由 `noteBeatMs()` 按
     * `web/lib/shell-retry.js` 的 `deriveThresholds()` 重算下面三个字段。
     * 只增不减：某一帧没有 `beatMs` 时**不清零、不缩小**（拿不准就沿用已知值，
     * 宁可晚一点重建，也不能把"反正可能是 8 s"当成理由去调小阈值）。
     */
    this.pcBeatMs = 0;
    /** 离线横幅 + 重建的静默阈值（有效值；见 `PC_STALE_MS` 的说明）。 */
    this.pcStaleMs = PC_STALE_MS;
    /** 「有请求在途 + 下行静默」的立即重建阈值（有效值，红线：必须 > 一个心跳）。 */
    this.rpcStallRebuildMs = RPC_STALL_REBUILD_MS;
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
    /**
     * 链路世代号：每进一次 `restart()` 就 +1（单调，永不清零）。
     *
     * 与 `lastRestartAt` 分开：那是"上一次重建的时刻"，会被时钟回拨、也会被
     * "重建成功"覆盖；应用层（`web/lib/net.js`）要回答的是「这条请求失败之后
     * 链路**换过没有**」——一个单调计数比时间戳可靠，也不受同毫秒多次重建影响。
     * 用途：GET 的 `relay_timeout` 允许补一次自动重试（F2），以及详情失败文案
     * 区分「链路刚重建过」与「电脑端没响应」（F3）。
     */
    this.linkEpoch = 0;
    this.readyAt = 0;
    /** 已被新页面接管：不再重连、界面失效。 */
    this.superseded = false;
    /**
     * 界面已经收摊（fatal / 重试重建前）：
     *
     * 与 `superseded` 分开是因为语义不同 —— 那个是"被新页面顶掉"，会盖一层
     * 「这个界面已失效」；这个只是"这一轮引导不要再往前跑了"，不该画任何覆盖层。
     */
    this.disposed = false;
    /**
     * 在途 RPC 面包屑（环形，只留最近 `RPC_LOG_MAX` 条）。
     *
     * 只给诊断读：`__POCKET_DIAG__.snapshot()` 与界面的"重试第几次"。
     * 事故现场最缺的正是这一层 —— 桌面侧有 `rx/rpc/replays` 计数器，手机侧却只有
     * 一个 `pending` 数字，看不出"哪条请求发了几次、有没有收到过回包"。
     */
    this.rpcLog = [];
    /** 共享就绪等待器（null = 无人等待）。 */
    this.readyWaiters = new Set();
    /**
     * 最近一次回到前台的时刻。
     *
     * 息屏 / 长时间后台时页面被冻结，心跳收不到是**正常现象**；醒来若仍用冻结前
     * 的时间戳算「多久没消息」，就会立刻判成「电脑端已离线」并触发重连——而电脑
     * 其实一直是好的。把它并入「活着的下界」，醒来重新起算。
     */
    this.lastWakeAt = 0;
    /* ---- 可诊断性：下面这些只给界面读，不参与任何连接决策 ---- */
    /** 最后一次成功拿到 ready 的时刻（0 = 本次打开页面还没成功过）。 */
    this.lastOkAt = 0;
    /** 最后一次发起建连尝试的时刻。 */
    this.lastAttemptAt = 0;
    /** 连续失败次数（拿到 ready 清零）。只用于诊断展示。 */
    this.failureStreak = 0;
    /** 本次尝试里 socket / TLS 层给的错误码；'' = 这次还没拿到。 */
    this.lastErrorCode = '';
    /** 本次尝试里最原始的错误信息（截断后展示，非敏感）。 */
    this.lastErrorMessage = '';
    /** 本次尝试里的 MQTT connack 返回码（null = 没收到 / 收到 0 表示接受）。 */
    this.lastConnack = null;
    /**
     * 界面直接读的结构：`{ code, message, connack, at, attempts, okAt }`。
     *
     * 只放非敏感信息 —— 连接页的「复制诊断信息」会把它原样复制出去（房间密钥、
     * 设备令牌、链接里的 `r`/`t` 一律不进来，诊断纯函数另有单测钉住）。
     */
    this.lastFailure = null;
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
    this.controlRequests = new Map();
    this.stats = {
      rx: 0, tx: 0, err: 0, stale: 0, lastError: '', lastRxAt: 0,
      /** RPC 次数 / 超时未收到 res 的次数 / 收到 res 但已放弃的次数。 */
      rpc: 0, timeouts: 0, resMiss: 0,
      /** 分片：累计没集齐的组数 / 累计发出的 nack 数（诊断三件套，见 partsStats）。 */
      partsIncomplete: 0, partsNacked: 0,
      /**
       * 「有请求在途但下行静默」触发的重建次数。
       *
       * 它涨而 `timeouts` 也涨 = 半死链路被看门狗逮住救了，但回包仍没回来；
       * 旧实现里这种情况**一次重建都不会发生**（要等 26 s），用户只看到
       * `relay_timeout`，诊断上也分不清"没救"与"救了没用"。
       */
      stallRebuilds: 0,
    };
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  /**
   * 记一次「拿到 ready」：连续失败清零，并记下时刻（诊断里显示「最后成功」）。
   *
   * 刻意**不**清 `lastFailure`：断过一次之后再连上，"上次为什么断"仍然是最有用的
   * 线索，界面靠 `online` 区分「现在是好的」和「刚才为什么坏」。
   */
  noteRelayOk() {
    this.lastOkAt = Date.now();
    this.failureStreak = 0;
  }

  /**
   * 把一次尝试的断因记进 `lastFailure`（UI 与「复制诊断信息」只读这一个结构）。
   *
   * 三个事件都会进来，字段互相补充（空值不覆盖已有的，因为 `error` 与 `close`
   * 往往成对到达，先到的那个才有真信息）：
   *   - `error`：socket / TLS 层的 code（ECONNRESET、ENOTFOUND、ERR_TLS_…）；
   *   - `connack`：MQTT 返回码（4/5 这类「中继拒绝」只有它知道）；
   *   - `close`：mqtt.js 的 close **可以没有参数**，所以它只负责"这次尝试确实
   *     失败了"的记账，没有 code 时补一个 `CLOSE`，让界面至少能说清是"被关闭"
   *     而不是「未知原因」。
   *
   * @param {{code?: string, message?: string, connack?: unknown}} [failure]
   */
  noteFailure({ code = '', message = '', connack = null } = {}) {
    if (typeof code === 'string' && code !== '') this.lastErrorCode = code.slice(0, 80);
    if (typeof message === 'string' && message !== '') this.lastErrorMessage = message.slice(0, 200);
    if (connack !== null && connack !== undefined) {
      // v4 语义叫 returnCode、MQTT 5 叫 reasonCode，两种写法都要认。
      const reasonCode = normalizeConnack(connack);
      if (reasonCode !== null) this.lastConnack = reasonCode;
    }
    this.lastFailure = {
      code: this.lastErrorCode,
      message: this.lastErrorMessage,
      connack: this.lastConnack,
      at: Date.now(),
      attempts: this.failureStreak,
      okAt: this.lastOkAt,
    };
  }

  /** Best estimate of the desktop's clock, in ms. */
  serverNow() {
    return Date.now() + this.clockOffset;
  }

  async connect() {
    let lastError;
    for (const broker of this.brokers) {
      if (this.superseded) throw new Error('页面已关闭');
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
        // 20 s（原来是 40 s）。心跳间隔必须短于运营商 NAT / DPI 的空闲回收窗口：
        // 40 s 才发一次 PINGREQ，蜂窝链路上这条流有 40 s 的"静默窗口"等着被掐，
        // 而 MQTT 只有在 1.5 倍 keepalive 无应答时才判死 —— 40 s 意味着最坏 60 s
        // 才知道链路已经死了。实测「WiFi 正常、蜂窝反复断」正是这个窗口造成的；
        // 20 s 既显著降低被掐概率，也让死链路早 20 s 被发现。
        keepalive: 20,
        reconnectPeriod: 0,
        // 6 s 足够（实测本地 broker 0.35 s、公共 broker 2–3 s）。原来 12 s 意味着
        // 一次重建在两个 broker 上最多烧掉 26 s，这是「重连很久」的主要来源。
        connectTimeout: 6_000,
        protocolVersion: 4,
      });
      this.client = client;
      // 每一次尝试都从零收集断因：上一轮的错误码不能冒充这一轮（诊断文本会被
      // 用户当成证据复制出去）。`lastFailure` 是快照对象，不受这里清空影响。
      this.lastAttemptAt = Date.now();
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
      this.lastConnack = null;
      /** 同一次尝试只记一次连续失败：mqtt.js 的 `error` 与 `close` 往往成对到达。 */
      let countedFailure = false;
      const recordFailure = ({ code = '', message = '', connack = null } = {}) => {
        if (countedFailure === false) {
          countedFailure = true;
          this.failureStreak += 1;
        }
        this.noteFailure({ code, message, connack });
      };
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.debug(`[pocket-diag] connectOne TIMEOUT broker=${broker} ready=${this.ready}`);
        // 超时这条路**没有** error / close 可等（连接卡在半路），必须在这里记一笔，
        // 否则手机界面上只剩「未知原因」。
        recordFailure({ code: 'ETIMEDOUT', message: '7 秒内没有收到中继的 connack（连接超时）' });
        if (this.client === client) this.client = undefined;
        try { client.end(true); } catch { /* ignore */ }
        reject(new Error('连接超时'));
      }, 7_000);

      client.on('connect', () => {
        if (this.client !== client || this.superseded) return;
        console.debug(`[pocket-diag] connectOne CONNECTED broker=${broker} settled=${settled}`);
        client.subscribe(this.downTopic, { qos: 1 }, (error, grants) => {
          if (this.client !== client || this.superseded || settled) return;
          if (!error && !grants?.some((grant) => grant.topic === this.downTopic && grant.qos < 128)) error = new Error('中继拒绝了主题订阅');
          console.debug(`[pocket-diag] connectOne SUBSCRIBE ${error ? 'ERR ' + (error.message ?? error) : 'OK'} settled=${settled}`);
          if (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // 连上了但订阅失败：也是这次尝试的断因，别让它只剩一个 CLOSE。
            recordFailure({
              code: typeof error?.code === 'string' ? error.code : '',
              message: String(error?.message ?? error),
            });
            this.client = undefined;
            client.end(true);
            reject(error);
            return;
          }
          this.onstate('online');
          this.ready = true;
          for (const ready of this.readyWaiters) ready(true);
          // 看门狗用 Math.max(pcSeenAt, lastRxAt, readyAt) 当「最后一次活着的时刻」。
          // 没有 readyAt 时，首帧到达前这个下界是 0 → idle 恒等于 Date.now() → 刚建好
          // 的健康链路在头 2 秒里必判 stale，被自己推倒重建（实测 85 s 建了 4 条隧道）。
          this.readyAt = Date.now();
          this.downSince = 0;
          // 诊断：记下「最后一次成功」并把连续失败清零。放在 downSince 之后是刻意的
          // —— 上面 `ready=true → readyAt → downSince` 这段顺序被
          // `test/domain/relay-restart` 用结构断言钉着（首连自伤那条）。
          this.noteRelayOk();
          // Every (re)connect announces: the desktop may have restarted and
          // forgotten us. announce() self-throttles to one hello per 10 s.
          this.announce();
          // **重连成功立刻重发在途请求**（同一个 request id，新的 seq/ts）。
          // 只靠 8 s 一跳的 beat 兜底的话，用户点进会话后要盯着"转圈"等一个
          // 心跳周期；这里把恢复时间压到一次 RTT。
          this.resendPending();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(broker);
        });
      });
      // WebCrypto resolves asynchronously. Deliver WS frames in MQTT arrival order.
      let incoming = Promise.resolve();
      client.on('message', (topic, payload) => {
        if (this.client !== client || topic !== this.downTopic) return;
        incoming = incoming.then(() => this.onMessage(payload, client)).catch(() => { this.stats.err += 1; });
      });
      client.on('error', (error) => {
        if (this.client !== client) return;
        // 以前这里只 `console.warn`，而手机上没有控制台 —— 真实断因当场销毁，
        // 用户能看到的只有一句「中继断开，正在重连…」。现在它同时落进
        // `lastFailure`，横幅与连接页的「中继诊断」都能直接读出来。
        const code = typeof error?.code === 'string' ? error.code : '';
        const message = String(error?.message ?? error ?? '');
        console.debug(`[pocket-diag] connectOne ERROR code=${code} message=${message}`);
        recordFailure({ code, message });
        console.warn('[pocket] mqtt error', error?.message);
      });
      client.on('packetreceive', (packet) => {
        if (packet.cmd !== 'connack' || this.client !== client) return;
        // mqtt.js v5 把 connack 作为事件抛出来；返回码字段两代协议不同名
        // （v4 语义 `returnCode`、MQTT 5 `reasonCode`），交给 normalizeConnack 认。
        // 这条是「网络明明是通的，但中继不收」（返回码 4/5）唯一的证据来源。
        const reasonCode = normalizeConnack(packet);
        console.debug(`[pocket-diag] connectOne CONNACK code=${reasonCode}`);
        if (reasonCode === null || reasonCode === 0) return; // 0 = 接受，正常路径
        recordFailure({ message: `中继返回 connack ${reasonCode}`, connack: reasonCode });
      });
      client.on('close', () => {
        console.debug(`[pocket-diag] connectOne CLOSE same=${this.client === client} ready=${this.ready}`);
        // 旧 client 在重建时会被 end(true)，它触发的 close 不该再改状态。
        if (this.client !== client) return;
        const wasReady = this.ready;
        this.ready = false;
        // close 事件在 mqtt.js 里**可以不带参数**，所以这条路只能自己兜一句话。
        // 两种情形分开记：
        //   - 本来就连通（用户报的正是这条：连着被掐断）→ 不算连续失败，但记原因；
        //     上一步的 error 若已给了具体 code（ECONNRESET…），绝不拿 CLOSE 覆盖它。
        //   - 一直没 ready（首次连接就反复失败）→ 记一次连续失败；若 error/connack
        //     已经记过这一次尝试，就不再重复计数。
        if (wasReady) {
          this.failureStreak = 0;
          this.noteFailure(this.lastErrorCode === '' && this.lastConnack === null
            ? { code: 'CLOSE', message: '连通的底层连接被关闭（close 事件没有错误码）' }
            : {});
        } else if (countedFailure === false) {
          countedFailure = true;
          this.failureStreak += 1;
          this.noteFailure({ code: 'CLOSE', message: '底层连接已关闭（close 事件没有错误码）' });
        }
        this.onstate('offline');
        // 传输断了，但**在途请求不 reject**：桌面按 request id 幂等，重发不会重复
        // 执行（见 request() 的注释）。1.0.2 在这里 failAll()，于是一次网络抖动就
        // 把「点进会话」的 detail 请求判死，界面立刻弹「连不上电脑」。800 ms 后
        // 重连成功也救不回来 —— 请求已经没了。
        this.abortTransport('中继连接中断');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.client = undefined;
          client.end(true);
          reject(new Error('底层连接已关闭'));
          return;
        }
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
    this.failAll('页面已被接管');
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
    // `beatAck: true`：告诉桌面「我认识 beatMs，可以按活跃度拉长心跳」。老桌面
    // 直接忽略这个字段；新桌面只有看到它才敢进空闲档 —— 否则老外壳手里写死的
    // 26 s 阈值会把 30 s 的正常间隔判成「电脑端已离线」，反复重建。
    void this.send({
      t: 'hello', name: this.phoneName, ver: PROTOCOL,
      // 信封能力声明（不是"我现在就发二进制"）：老桌面忽略它，行为不变；
      // 新桌面看到 `proto >= 3` 才会用 v3 二进制信封回我们。
      proto: ENVELOPE_PROTOCOL,
      ts: this.serverNow(), beatAck: true,
    }).catch(() => {});
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
    // 界面已经收摊（fatal 页 / 准备重跑引导）：计时器与客户端都停了，别再拉起来。
    if (this.disposed === true) return false;
    if (this.restarting === true) return false;
    clearTimeout(this.fastRetryTimer);
    this.fastRetryTimer = undefined;
    this.restarting = true;
    this.restartCount += 1;
    // 世代号先加：应用层（net.js）判断"失败后链路换过没有"只看它，越早可见越好。
    this.linkEpoch += 1;
    this.lastRestartAt = Date.now();
    console.warn('[pocket] 重建中继连接：' + reason + '（第 ' + this.restartCount + ' 次）');

    const previous = this.client;
    this.client = undefined;
    this.ready = false;
    this.readyAt = 0;
    this.pcHello = null;
    this.pcProto = 0;
    this.pcStale = false;
    // 半包表**不在这里清**：清表要记账（"一次重连把正在拼的大响应清掉了"必须能在
    // 诊断里看见），而记账点在 `abortTransport()` 里。旧实现先在上面 `parts.clear()`、
    // 再调 `abortTransport()`，于是生产上的重连路径永远绕过记账，`partsIncomplete`
    // 恒 0 —— "网络恢复了页面还不动"在手机侧一点痕迹都没有。
    // 重建不是终点：在途请求留着，连上之后按同一个 request id 重发。
    this.abortTransport('中继连接重建中');
    try { this.onstate('connecting'); } catch { /* 界面回调不该影响重建 */ }
    try { previous?.end?.(true); } catch { /* 已经断了 */ }

    try {
      await this.connect();
      this.readyAt = Date.now();
      this.restartCount = 0;
      this.downSince = 0;
      // 诊断：重建成功同样是「一次成功」，连续失败清零（与 connectOne 的 ready 一致）。
      this.noteRelayOk();
      // 上面直接把 pcStale 置了 false，true→false 的边沿被吞掉，onpcStale 不再
      // 触发，横幅「电脑端已离线 N 秒…」会永久挂着。显式通知一次已恢复。
      try { this.onpcStale(false, null); } catch { /* 界面回调不该影响重建 */ }
      this.announce(true);
      this.resendPending();
      this.startStaleWatch();
      return true;
    } catch (error) {
      console.warn('[pocket] 重建失败', error?.message);
      try { this.onstate('offline'); } catch { /* ignore */ }
      // 失败后必须排下一次重试：看门狗在 ready=false 时会跳过（避免重建风暴），
      // 如果这里不排，自愈链就断在原地 —— 界面停在「中继断开，正在重连…」其实没在连。
      //
      // 死页不许再排定时器：`markSuperseded()` / `stop()` 之后这个 catch 仍会被唤醒
      // （`connect()` 的失败是晚到一步的），旧实现照排 `fastRetryTimer` —— 于是被顶掉
      // 的页面继续自我重建，还会反过来把新页面顶掉（防乒乓的另一半就在这里）。
      if (this.superseded === true || this.disposed === true) return false;
      // 退避语义沿用原来的 1s→2s→4s→8s→16s（上限 15 s），**只**在上面叠 ±20%
      // 抖动：一群手机被同一个 broker / 同一台运营商设备同时掐断时，没有抖动
      // 它们会在同一毫秒一起回来，把刚恢复的中继再打趴一次（重连风暴）。
      const backoff = Math.min(15_000, 1_000 * (2 ** Math.min(this.restartCount, 4)));
      const retryDelay = Math.round(backoff * (0.8 + Math.random() * 0.4));
      this.fastRetryTimer = setTimeout(() => {
        this.fastRetryTimer = undefined;
        if (!this.ready) void this.restart('重建失败重试');
      }, retryDelay);
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
      // 半包扫描放在最前面：与"链路是否就绪"无关（过期组总要清掉、总要记账），
      // 而补片只在就绪时发（`sweepParts` 内部判断）。
      // `?.` 不是防御性编程的口癖：这段代码跑在 2 秒一次的看门狗里，任何一步抛错
      // 都会连带打断后面的保活判断（浏览器里就是每 2 秒一条未捕获异常）。
      this.sweepParts?.();
      if (!this.ready) {
        // 未就绪也要管：重建失败后靠这里兜底（冷却期内不打扰）。
        if (Date.now() - this.lastRestartAt > RESTART_COOLDOWN_MS) void this.restart('未就绪兜底');
        return;
      }
      // 以前 pcSeenAt===0 就直接 return —— 而"连上了却一帧都没收到"恰恰是
      // 最需要重建的状态。改用以 readyAt 为下界。
      const idle = Date.now() - Math.max(this.pcSeenAt, this.stats.lastRxAt, this.readyAt, this.lastWakeAt);
      /**
       * 阈值取**当前生效值**：桌面下发过 `beatMs` 就是推导出来的（空闲档 30 s
       * ⇒ 97.5 s），收不到就是老常量 26 s。`Number(...) > 0` 而不是 `??`：
       * 老测试替身 / 老快照里这个字段可能是 0 或缺失，两种都必须退回老行为，
       * 不能变成"阈值 0 ⇒ 每 2 秒重建一次"。
       */
      const staleMs = Number(this.pcStaleMs) > 0 ? this.pcStaleMs : PC_STALE_MS;
      const stale = idle > staleMs;
      if (stale !== this.pcStale) {
        this.pcStale = stale;
        this.onpcStale(stale, stale
          ? `电脑端已离线 ${Math.round(idle / 1000)} 秒 · 正在重连…（列表可能不是最新）`
          : null);
      }
      /*
       * F1：「有请求在途 + 下行静默」要**立即**重建，不能等 26 s。
       *
       * 15.2 s（`rpcBudgetMs(4, 8_000)`）< 26 s（`PC_STALE_MS`），所以只靠下面那条
       * `stale` 规则时，每一次下行半死都必然是**请求先烧完预算**、拿 `relay_timeout`
       * 交给界面（`web/lib/net.js` 把它当不可重试的定论），而救它的重建要等 26 s
       * —— 现场："详情请求桌面 8~30 ms 就答完了，手机 15.2 s 后报中继请求超时"。
       *
       * 判据只有三条：在线、有请求在途、`lastRxAt`/`pcSeenAt` 静默超过一个心跳多
       * （`this.rpcStallRebuildMs`：8 s 心跳下=10 s，空闲档 30 s 心跳下=37.5 s）。
       * **不误伤慢请求的前提**：正常但慢的请求（冷会话构建实测 4.4 s）期间 beat
       * 照旧按当前档位到、`lastRxAt` 一直新鲜 ⇒ 不会命中。
       *
       * 下界里带上 `readyAt`（写法与上面的 `idle` 一致）：刚 ready 的前 8 s 本来
       * 就一条 beat 都可能还没到，那是**首连空窗**不是"下行静默"，不带它就会在
       * 第一次巡检时把自己刚建的链路推倒（首连自伤）。`lastWakeAt` 故意**不**算：
       * 回到前台后 16 s 静默那条由 `wakeDecision()` 负责，这里要的是"有请求在途
       * 就别再等"。
       *
       * 重建后 `restart()` 的 `resendPending()` 会用**同一个 request id** 重发在途
       * 请求（桌面按 id 幂等回放），冷却沿用 `RESTART_COOLDOWN_MS` 防重建风暴。
       * 下界读 `this.pending?.size`：看门狗每 2 s 一拍，任一步抛错都会连带打断后面
       * 的保活判断（见本函数开头的注释），所以对测试替身也要能跑。
       */
      const lastDownAt = Math.max(this.stats.lastRxAt, this.pcSeenAt, this.readyAt);
      const silentFor = Date.now() - lastDownAt;
      /**
       * 只有"这条请求开始之后一帧下行都没收到"才重建。
       *
       * 为什么不能只看"静默 10 s"：桌面每 8 s 一条 beat，阈值离一个心跳周期只有
       * 2 s 余量 —— 正常链路上丢一拍 beat（我们就处在会丢帧的链路上）就会误判，
       * 而误判的代价是把 ws 隧道拆掉、把正在拼的分片作废。反过来，
       * `startedAt > lastDownAt` 表示"请求发出之后**一条下行都没有**"：
       * 健康链路不可能在"阈值"这么长的时间里连一拍 beat 都不来，所以这个判据在
       * 半死连接上成立、在只是"beat 丢了一拍"的链路上不成立。
       * （桌面空闲档把心跳拉长到 30 s 后，阈值跟着变成 37.5 s —— 否则这条判据
       * 本身就会在空闲链路上误命中，见 `this.rpcStallRebuildMs` 的赋值处。）
       *
       * 也不能改成"发 hello 探活"：桌面端 `sayHello()` 是 10 s 限流的
       * （见 `lib/cloud.mjs` 的 `case 'hello'`），被限流时**不会回 beat**，
       * 探针本身就会制造误判。
       */
      let oldestPendingAt = 0;
      for (const [, entry] of this.pending ?? []) {
        const startedAt = Number(entry.startedAt) || Number(entry.at) || 0;
        if (startedAt > 0 && (oldestPendingAt === 0 || startedAt < oldestPendingAt)) oldestPendingAt = startedAt;
      }
      if ((this.pending?.size ?? 0) > 0) {
        // 红线：这个阈值**必须长于一个心跳**（`this.pcBeatMs`）。桌面空闲档
        // 30 s 时它是 37.5 s（`deriveThresholds()`），照 10 s 判就是把正常的长
        // 间隔当静默 —— 会拆掉 ws 隧道、作废正在拼的分片。
        //
        // 为什么"变慢了"也不吃亏：有请求在途 ⇒ 桌面 `pending.size > 0` ⇒ 立刻
        // 切回 8 s 档并**马上补一条 beat**（`lib/cloud.mjs` 的 `applyBeatTier()`），
        // 手机收到它就把阈值压回今天的 10 s。所以下面这条判据在"桌面收到了请求"
        // 之后几乎立刻恢复原来的灵敏度；只有上行也一起坏掉（请求根本没到桌面）
        // 时才会晚一点重建 —— 那种情况下慢一点是保守，不是错误。
        const stallMs = Number(this.rpcStallRebuildMs) > 0 ? this.rpcStallRebuildMs : RPC_STALL_REBUILD_MS;
        if (silentFor > stallMs
          // 拿不到请求开始时刻（老替身 / 异常条目）时退回"只看静默"：宁可多建一次，
          // 也不要因为一条缺字段的条目把自救关上。
          && (oldestPendingAt === 0 || oldestPendingAt > lastDownAt)
          && Date.now() - this.lastRestartAt > RESTART_COOLDOWN_MS) {
          this.stats.stallRebuilds += 1;
          void this.restart('请求在途但下行静默');
          return;
        }
      }
      // 只显示横幅是不够的：这条链路的坏法就是"看起来连着、其实发不出去"。
      // 静默够久就必须把底层客户端整个重建，否则永远等不到自动重连。
      if (stale && Date.now() - this.lastRestartAt > RESTART_COOLDOWN_MS) {
        void this.restart('下行静默');
      }
    }, 2_000);
  }

  async onMessage(payload, client = this.client) {
    if (payload.byteLength > MAX_FRAME * 2 || client !== this.client) return;
    let message;
    try {
      // v2 是**文本**信封（首字节 `{`），v3 是二进制、必须原样保持字节（先 decode
      // 成字符串就把密文毁了）。这里只决定"交给 sealer 什么形态"，版本分流与
      // 校验在 sealer 里（它同时还管 AAD 与钥匙）。
      const envelope = payload.length > 0 && payload[0] === 0x7b ? decoder.decode(payload) : payload;
      message = await this.sealer.unseal(envelope, this.downTopic);
    } catch (error) {
      this.stats.err += 1;
      this.stats.lastError = `unseal: ${error?.message}`;
      return; // wrong key / corrupted frame: ignore
    }
    if (client !== this.client || this.superseded) return;
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
        // 迟到的 `res`（请求已经判死 / 页面已放弃）**不报错也不重放**，但要计数：
        // "回包其实到了、只是我们早就不等了"与"回包根本没到"是两种完全不同的故障，
        // 以前两者在手机侧看起来一模一样（都是静默）。
        if (entry === undefined) { this.stats.resMiss += 1; return; }
        this.pending.delete(entry.id);
        clearTimeout(entry.timer);
        // Expired/revoked token: the desktop answers 401, so drop the local
        // session and go back to the gate instead of spinning.
        if (Number(message.status) === 401 && entry.sessionToken === this.session?.token && entry.deviceToken === this.deviceToken) this.onunauthorized?.();
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
      case 'auth.reply':
      case 'login.reply': {
        const entry = this.controlRequests.get(message.id);
        if (entry && message.t === entry.type + '.reply') entry.finish(message);
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

  /**
   * 学一条桌面下发的心跳周期（`hello` / `beat` 的增量字段 `beatMs`），并据此
   * 重算本机的三个静默阈值。
   *
   * 为什么必须学：桌面的心跳按活跃度自适应（空闲 30 s）。手机的三个阈值都是
   * 「心跳周期的倍数」推导出来的 —— 不学就还在按 8 s 假设走，于是下一次
   * 正常的长间隔会被判成「下行静默」⇒ 拆 ws 隧道、作废正在拼的分片（误重建）。
   *
   * 保守语义（三处都别改）：
   *  1. 字段缺失 / 非数字 / ≤0 ⇒ **什么都不做**：沿用当前有效值（初始就是 8 s
   *     老假设）。不清零、不回退 —— 老桌面不会下发这个字段，行为与 1.0.10 一致；
   *  2. 比 8 s 还小的值按 8 s 算（`deriveThresholds()` 内部收口）：阈值只能放大，
   *     不能比今天更激进；
   *  3. 推导值一律 ≥ 老常量：桌面切回快速档（`beatMs = 8_000`）时阈值回到今天
   *     的三个数，不会更低。
   *
   * @param {unknown} raw 帧里的 `beatMs`
   * @returns {boolean} 是否真的更新了（诊断用）
   */
  noteBeatMs(raw) {
    const next = deriveThresholds(raw);
    if (next.known !== true) return false;
    this.pcBeatMs = next.beatMs;
    this.pcStaleMs = next.pcStaleMs;
    this.rpcStallRebuildMs = next.rpcStallRebuildMs;
    return true;
  }

  noteDesktopAlive(message) {
    this.supportsAuthReplyId = message.authReplyId === true;
    this.pcHello = { name: String(message.name ?? '电脑'), at: Date.now() };
    this.pcSeenAt = Date.now();
    // 心跳周期与 `ver` 一样是「增量、可缺」的字段：缺了就保持上一次学到的那一档。
    this.noteBeatMs(message.beatMs);
    // `beat` carries `ver` too; keep the last known value when it is absent so
    // a heartbeat cannot erase what the hello told us.
    const ver = Number(message.ver);
    if (Number.isFinite(ver) && ver > 0) this.pcVersion = ver;
    /**
     * 信封协议协商（desktopProto）。
     *
     * 与 `beatMs` / `ver` 的"缺了就沿用上次"**故意不同**：这里的缺失必须写回 0。
     * 场景是这个 bug 的真实来源：手机先连上新桌面（学到 3），桌面被降级/换回老版本，
     * 老桌面的 hello 不带 `proto` —— 若沿用 3，手机就会一直发二进制上行，老桌面
     * 一帧都解不开，界面表现成"连着但毫无反应"，两边日志都是干净的。
     * 写回 0 最坏只是让新桌面多收几帧 v2（它两种都认识），代价为零。
     */
    const proto = Number(message.proto);
    this.pcProto = Number.isFinite(proto) && proto > 0 ? proto : 0;
    const serverTs = Number(message.ts);
    if (Number.isFinite(serverTs) && serverTs > 0) {
      const offset = serverTs - Date.now();
      // Only correct the clock domain when it actually moved: a jittery offset
      // would otherwise shift every `ts` we send.
      if (Math.abs(offset - this.clockOffset) > 500) this.clockOffset = offset;
    }
    this.onpc(this.pcHello);
  }

  /**
   * 重组一条下行分片；null 表示"还没拼完 / 这一片不可用"。
   *
   * 具体规则在 `web/lib/shell-parts.js`（可被 Node 直接 import 并测行为）。
   * 这里只负责外壳才知道的三件事：
   *   1. 有半包**被迫淘汰 / TTL 过期 / 判定丢失**时记进诊断（旧实现是静默
   *      `delete`，于是"手机收不到大响应"在两边都查不出来）；
   *   2. 丢了就立刻把等它的那条请求送去自救（同 id 重发 → 桌面幂等重放）或重试，
   *      而不是让用户干等预算耗尽；
   *   3. 半包卡住超过 `PART_STALL_MS` 就发 `nack` 让电脑端补片（见 `sweepParts`）。
   */
  collectPart(message) {
    const result = this.parts.add(message);
    // `*Rids` 与 `*` 按位置一一对应：那是"哪一组丢了"精确对上"哪条请求受害"的唯一凭据。
    if (result.evicted.length > 0) this.noteLostParts(result.evicted.length, 'evicted', result.evictedRids ?? []);
    if (result.expired.length > 0) this.noteLostParts(result.expired.length, 'ttl', result.expiredRids ?? []);
    return result.kind === 'complete' ? result.value : null;
  }

  /**
   * 每 2 秒的看门狗 tick 顺手扫一遍半包：该 `nack` 的 `nack`，该判死的判死。
   *
   * 为什么必须在这里做（而不是等请求超时）：
   * 电脑端 `publishSealed()` 的重发**只在 PUBACK 报错时触发** —— "broker 收下了
   * 但订阅方没收到"这种丢法它完全感知不到（实测 `publishRetries/publishLost/errors`
   * 全是 0）。所以补片只能由**收方**发起：手机端发现某个 chunk 卡住，就发一条
   * `nack` 指名要它。老桌面不认识 `nack` 会忽略（`lib/cloud.mjs` 的 `default: break`），
   * 行为与现在一致，不会更糟。
   */
  sweepParts(now = Date.now()) {
    // TTL 过期的组连 `rid` 一起交回（组一旦从表里删掉就再也查不到了）。
    const expired = this.parts.expire(now);
    if (expired.length > 0) this.noteLostParts(expired.length, 'ttl', expired.map((group) => group.rid));
    // 先判死再补片：已经超时的那几组没必要再 nack（它们的回包不会来了）。
    for (const id of this.parts.lost(now)) {
      const rid = this.parts.ridOf(id);
      if (this.parts.drop(id)) this.noteLostParts(1, 'stall', rid === '' ? [] : [rid]);
    }
    if (this.ready !== true || this.client === undefined) return;
    const due = this.parts.nackDue(now);
    for (const id of due) {
      const rid = this.parts.ridOf(id);
      this.parts.markNacked(id, now);
      this.stats.partsNacked += 1;
      console.debug(`[pocket-diag] nack ${id}`);
      // ① 新桌面（≥1.0.4）：指名补片，一片一条，通常 2 秒内补齐。
      //    `rid` 一起带上：桌面据此能把"补这一组"与"哪条请求"对上（认不出的字段
      //    会被老桌面忽略，安全）。`id` 仍是分片 id —— 补的是片，不是请求。
      void this.send({
        t: 'nack', id, ...(rid === '' ? {} : { rid }), sid: this.sid, seq: this.nextSeq(), ts: this.serverNow(),
      }).catch(() => {});
      // ② 老桌面（1.0.3 及更早）：`nack` 会被 `default: break` 忽略。这时**同 id
      //    重发**是唯一的快速自救 —— 那帧响应已经在桌面的 120s 幂等缓存里，重发会让
      //    它把整条响应重新发一遍（含全部片）。放在这里而不是等 8 秒判失，是因为
      //    "卡住 2 秒"已经足够证明有片丢了，没必要再干等 6 秒。
      //    代价：每条请求每 5 秒最多多一帧（nack 自带同组间隔），而它救回的是
      //    用户正在盯着的那一屏。重复帧对桌面是幂等回放，不会重复执行。
    }
    // ③ 自救额度是**每条请求唯一**的（`RPC_HEAL_RESENDS`），一个 tick 最多用掉一次。
    //    旧实现把 `healOldestPending()` 写在上面那个 for 循环里：一个 2 s tick 里有
    //    几个组要 nack，就会同时吃掉几条**无关请求**各自的额度 —— 真正卡住的那条
    //    第二次 nack（≈7.5 s）时额度已空，8 s 判死只能直接 `parts_lost`。
    if (due.length > 0) this.healOnce(due);
  }

  /**
   * 一个 tick 只做一次自救，且**优先救"持有最老半包"那条请求**。
   *
   * 新桌面在 `part` 帧里给了 `rid`：受害者就是它，不用猜。
   * 老桌面没有 `rid`：只能退回 `healOldestPending()`（挑最老的在途请求）。
   * 两种情况的共同上限都是"每 tick 一次"，把救错的代价压到"一帧重复请求"。
   *
   * @param {string[]} ids 本 tick 要 nack 的组
   * @returns {boolean} 是否真的重发了
   */
  healOnce(ids = []) {
    const rid = typeof this.parts.oldestRid === 'function' ? this.parts.oldestRid(ids) : '';
    if (rid !== '') {
      const victim = this.pending.get(rid);
      // rid 精确命中一条在途请求：只救它。额度用尽也**不**转去救别人 ——
      // 那正是"救错对象"，这里宁可留给 nack 补片和 8 s 判死。
      return victim !== undefined && typeof victim.heal === 'function' && victim.heal() === true;
    }
    return this.healOldestPending();
  }

  /**
   * 用同一个 request id 重发**最老的在途请求**（桌面命中幂等缓存 → 回放整份响应）。
   *
   * 这条启发式现在只服务**老桌面**（`part` 帧里没有 `rid`）：收方无法把半包映射回
   * 请求，只能近似挑一条。新桌面走 `healOnce()` / `settleVictim()` 的精确路径。
   *
   * @returns {boolean} 是否真的重发了
   */
  healOldestPending() {
    let oldest = null;
    for (const [, entry] of this.pending) {
      if (oldest === null || entry.at < oldest.at) oldest = entry;
    }
    if (oldest === null) return false;
    return typeof oldest.heal === 'function' && oldest.heal() === true;
  }

  /**
   * 对"确认为受害者"的那条请求做处置：先自救（同 id 重放），额度用尽就**立刻判死**。
   *
   * 这是 C1 的落点：谁是受害者由 `rid` 说了算，不再靠"谁最老"猜。判死带
   * `parts_lost`，`web/lib/net.js` 据此换一个新的 request id 重试（重新切一份响应）。
   *
   * @param {string} rid 被丢那一组的 `rid`
   * @param {number} lost 这一批丢了几组（只用于错误里的计数）
   * @returns {boolean} 是否处理了它（`false` = 这不是一条在途请求）
   */
  settleVictim(rid, lost) {
    const id = typeof rid === 'string' ? rid : '';
    if (id === '') return false;
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    if (typeof entry.heal === 'function' && entry.heal() === true) return true;
    entry.reject?.(partsLostError(lost));
    return true;
  }

  /**
   * 一组下行分片彻底丢了：大响应已经不可能拼齐。
   *
   * 两步走（顺序很重要）：
   *   1. **先自救**：按同一个 request id 重发。桌面按 id 幂等，回的是缓存里那份
   *      完整响应，不会重复执行；比重试更快、更省。
   *   2. 自救预算用完了就**立刻判死**这条请求（`parts_lost`），交给 `web/lib/net.js`
   *      换一个新的 request id 重试 —— 那会重新切一份响应，比原样重放更可能成功。
   *
   * `targets` 是丢掉的每一组自带的 `rid`（= 被拆那一帧的 request id）。**有 rid 时
   * 只处理 rid 指向的那条请求**：旧实现一律挑"最老的在途请求"，而 `entry.at` 每次
   * attempt 都会刷新，"最老"其实是"最近没发过的"，于是丢片的受害者一路挂到预算
   * 耗尽（15.2 s）拿 `relay_timeout`，被误救的那条白拉一整份响应。
   *
   * @param {number} count 丢了几个半包（诊断计数）
   * @param {string} reason `evicted` / `ttl` / `stall`
   * @param {string[]} [targets] 每个丢失组自带的 `rid`（老桌面缺省为空串）
   */
  noteLostParts(count, reason, targets = []) {
    const lost = Math.max(0, Number(count) || 0);
    if (lost === 0) return;
    this.stats.partsIncomplete += lost;
    this.stats.err += lost;
    console.debug(`[pocket-diag] parts lost=${lost} (${reason}) open=${this.parts.size}`);
    // ① 精确路径：只看 rid 指向的那条请求。救不到（请求已经结束）就**什么都不做** ——
    //    绝不许退回启发式去误伤旁边那条无关请求，那正是"自救救错对象"的病灶。
    const precise = (Array.isArray(targets) ? targets : []).filter((rid) => typeof rid === 'string' && rid !== '');
    if (precise.length > 0) {
      for (const rid of precise) this.settleVictim(rid, lost);
      return;
    }
    // ② 老桌面（分片帧里没有 rid）：只能近似挑"最老的在途请求"。
    if (this.healOldestPending()) return;
    let oldest = null;
    for (const [, entry] of this.pending) {
      if (oldest === null || entry.at < oldest.at) oldest = entry;
    }
    if (oldest === null) return;
    oldest.reject?.(partsLostError(lost));
  }

  /** 半包表现状（诊断）：在途组数 / 累计没集齐 / 累计 nack。 */
  partsStats() {
    return {
      partsOpen: this.parts.size,
      partsIncomplete: this.stats.partsIncomplete,
      partsNacked: this.stats.partsNacked,
    };
  }

  /** 等中继就绪；所有等待者共享同一个 promise，就绪时一次性放行。 */
  waitReady(timeoutMs) {
    if (this.client !== undefined && this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (ready) => {
        clearTimeout(timer);
        this.readyWaiters.delete(finish);
        resolve(ready);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.readyWaiters.add(finish);
    });
  }

  async send(object, signal) {
    /**
     * 传输层暂时不可用：这是**可重试**的错误，必须和"请求被拒绝"区分开。
     *
     * `transient` 让 `request()` 不把它当成结论（不 reject，等重连后重发）；
     * `beforeSend` 进一步说明"这一帧一次都没发出去"——`web/lib/net.js` 只对
     * 这种失败才敢重试写方法（新的一次 fetch 会换 request id）。
     */
    const unavailable = (message, { beforeSend = true } = {}) => {
      const error = new Error(message);
      error.transient = true;
      if (beforeSend === true) error.beforeSend = true;
      return error;
    };
    if (!this.ready || !this.client) {
      if (!await this.waitReady(SEND_READY_WAIT_MS)) throw unavailable('中继尚未就绪');
    }
    const client = this.client;
    /**
     * 上行信封选择（**协商在这里收口**）：只有"自己也认识 v3 且桌面声明过 ≥3"
     * 才发二进制。`this.pcProto` 缺失 / 为 0（还没收到 hello/beat、或老桌面
     * 压根不带 `proto`）⇒ v2。整帧与分片走同一个 `publish()` 闭包，不会混。
     */
    const binary = Number(this.pcProto) >= 3;
    const publish = async (frame) => {
      signal?.throwIfAborted();
      const sealed = binary
        ? await this.sealer.sealBinary(frame, this.upTopic)
        : await this.sealer.seal(frame, this.upTopic);
      signal?.throwIfAborted();
      if (!client || this.client !== client || !this.ready || this.superseded) throw unavailable('中继连接已更换');
      client.publish(this.upTopic, sealed, { qos: 1 });
    };
    // The token rides on every uplink message: the desktop validates each one
    // statelessly, so a relay restart cannot lose the login.
    //
    // `nack` 也在这里：桌面 `lib/cloud.mjs` 的 `authorized()` 是**逐帧**验令牌的，
    // 不带 token 的补片请求会被当成未授权丢掉（而它就白发了）。
    const needsSession = object.t === 'auth' || object.t === 'req' || object.t === 'nack' || object.t.startsWith('ws.');
    const payload = needsSession && this.session !== null && object.token === undefined
      ? { ...object, token: this.session.token }
      : { ...object };
    const raw = encoder.encode(JSON.stringify(payload));
    this.stats.tx += 1;
    if (raw.length <= MAX_FRAME) {
      await publish(payload);
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
      await publish(part);
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

  /**
   * 发一条控制帧（`auth` / `login`）并等应答。
   *
   * 1.0.2 只 `send()` 一次：桌面热重载或弱网丢一帧，8 秒后就是
   * `{ok:false, reason:'timeout'}` → `checkAuth` 判 unavailable → 整屏
   * 「未能确认登录状态」。用户能做的只有刷新，而刷新大概率还是同一个结果。
   *
   * 现在复用普通请求那套重发：**同一份帧**再发 2 次（`CONTROL_RESEND_DELAYS`），
   * 全部没有应答才 fallback 成 timeout。重连成功时 `resendPending()` 也会
   * 通过 `entry.resend()` 再来一次。
   *
   * 必须逐字节相同：桌面 `handleControl()` 的幂等键是
   * `sha256(JSON.stringify(message))` —— 换 id 或加 seq/ts 都会被当成**一次新的
   * 登录**（重复跑 scrypt、甚至撞上登录限流），所以这里绝不重新构造帧。
   */
  exchangeControl(type, fields, timeoutMs) {
    const id = randomId(12);
    const controller = new AbortController();
    const frame = { t: type, id, ...fields, phone: this.phoneName, platform: 'web', ...this.deviceClaim() };
    return new Promise((resolve) => {
      let settled = false;
      let attempt = 0;
      let resendTimer;
      const finish = (reply) => {
        if (settled) return;
        settled = true;
        this.controlRequests.delete(id);
        controller.abort();
        if (resendTimer !== undefined) clearTimeout(resendTimer);
        clearTimeout(deadline);
        resolve(reply);
      };
      const deadline = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
      const sendOnce = () => {
        attempt += 1;
        this.send(frame, controller.signal).catch((error) => {
          // 传输层暂时不通：留着，等重连后由 resendPending() 重发（同一条帧）。
          // 其它失败（例如帧根本无法加密）才是结论。
          if (error?.transient === true) return;
          finish({ ok: false, reason: 'send-failed' });
        });
        if (resendTimer !== undefined) clearTimeout(resendTimer);
        const delay = CONTROL_RESEND_DELAYS[attempt - 1];
        if (delay === undefined) return;
        resendTimer = setTimeout(() => { if (!settled) sendOnce(); }, delay);
      };
      const resume = () => {
        if (settled) return;
        // 重连后的重发也照原有节奏走，不额外放宽总预算（deadline 不变）。
        if (attempt >= CONTROL_RESEND_DELAYS.length + 1) return;
        sendOnce();
      };
      this.controlRequests.set(id, { type, finish, resend: resume });
      sendOnce();
    });
  }

  async checkAuth(timeoutMs = 8_000) {
    const reply = await this.exchangeControl('auth', {}, timeoutMs);
    if (typeof reply.required !== 'boolean') return { ok: false, unavailable: true };
    this.authRequired = reply.required;
    this.authUser = typeof reply.user === 'string' ? reply.user : null;
    this.absorbDevice(reply);
    if (reply.ok && this.session && Number(reply.expiresAt) > 0) {
      this.session.expiresAt = Number(reply.expiresAt);
      void saveAuthSession(this.session);
    }
    return { required: this.authRequired, ok: reply.ok === true, user: this.authUser };
  }

  async login({ user, password, remember = true, timeoutMs = 15_000 }) {
    const reply = await this.exchangeControl('login', { user, password, remember }, timeoutMs);
    this.absorbDevice(reply);
    return reply;
  }

  /**
   * 底层传输断了（MQTT close / 重建）：**只收拾传输层，不 reject 在途请求**。
   *
   * 为什么不能 reject：桌面端对 `req` 是按 request id 幂等的（`lib/cloud.mjs` 的
   * 幂等缓存键 = 方法 + 路径 + id + 令牌），重发同一条 id 只会拿到缓存的回包，
   * 不会把动作做第二遍。而 reject 之后 `web/lib/net.js` 只会把它翻译成
   * 「连不上电脑，请检查网络与插件状态」—— 真实链路 800 ms 后就恢复了，
   * 用户的请求却已经没了。这是"网络抖一下，点进会话就白屏"的病根。
   *
   * 在途请求由 `resendPending()` 在重连成功后按同一个 id 重发，超时只由请求
   * 自身的 16 s 预算兜底（见 request()）。
   */
  abortTransport(reason) {
    for (const ready of this.readyWaiters) ready(false);
    // 跨链路的半包一律作废。**必须计入诊断**：旧实现在这里静默 clear，于是
    // "一次重连把正在拼的大响应清掉了"在手机侧完全不可见（而那正是
    // "网络恢复了、页面还是不动"的现场之一）。重发由 resendPending() 负责，
    // 这里只记账、不额外触发。
    if (this.parts.size > 0) this.stats.partsIncomplete += this.parts.size;
    this.parts.clear();
    for (const [, socket] of this.sockets) socket._close(1001, reason);
  }

  /**
   * 重连成功：把断线期间还活着的请求/控制帧按**同一个 id** 重发一遍。
   *
   * 控制帧在这里一起重发（A3）：`auth` / `login` 以前只 send 一次，8 秒没应答
   * 就整屏「未能确认登录状态」。它们的重发必须逐字节相同（桌面按整帧哈希去重），
   * 所以 `controlRequests` 里存的是可重放的 `resend()`，而不是重新构造一次帧。
   */
  resendPending(reason = '中继已恢复') {
    if (this.ready !== true || this.superseded === true || this.disposed === true) return;
    // 走 `heal()` 而不是 `retry()`：重连是"链路换了"，不是"第 N 次重试"。
    // `retry()` 在 attempt 用尽后是空操作 —— 而那恰恰是最需要它的一次
    // （半包被 `abortTransport()` 清掉、回包永远拼不齐，见 RPC_HEAL_RESENDS）。
    // 每条请求只多给一次，避免弱网来回抖动时把上行刷成风暴。
    //
    // 但 heal 额度用尽时**必须回退到 retry**：两者是"优先/兜底"而不是"二选一"。
    // 旧写法 `(entry.heal ?? entry.retry)?.()` 在 heal 存在但返回 false 时什么都不做 ——
    // 探针里"2→2 帧"：明明还剩 attempt 预算，却一帧都没重发。
    for (const [, entry] of this.pending) {
      if (entry.heal?.() !== true) entry.retry?.();
    }
    for (const [, entry] of this.controlRequests) entry.resend?.();
    console.debug(`[pocket-diag] resendPending ${reason} pending=${this.pending.size} control=${this.controlRequests.size}`);
  }

  /**
   * 界面收摊时的收尾：停掉一切会自己再跑起来的东西。
   *
   * 只关 MQTT 不够 —— 看门狗、快重连、在途请求都会在几百毫秒内把事情重新拉起来，
   * 于是"死页"其实还在跑，还会被新标签页的抢主逻辑覆盖成「这个界面已失效」，
   * 把本来有用的诊断页挡掉。
   */
  stop(reason = '界面已停止') {
    this.disposed = true;
    if (this.staleTimer !== undefined) { clearInterval(this.staleTimer); this.staleTimer = undefined; }
    if (this.fastRetryTimer !== undefined) { clearTimeout(this.fastRetryTimer); this.fastRetryTimer = undefined; }
    const client = this.client;
    this.client = undefined;
    this.ready = false;
    try { client?.end?.(true); } catch { /* 已经断了 */ }
    // 终结路径：页面不会再有人用这些回包了，连同控制帧一起收掉。
    this.failAll(reason);
  }

  /**
   * 终结路径：页面已被接管 / 已经收摊，在途请求与在途控制帧一起 reject。
   *
   * 与 `abortTransport()` 的唯一区别就在这里：那条路留着请求等重发，
   * 这条路是真的没人再等了。
   */
  failAll(reason) {
    this.abortTransport(reason);
    for (const entry of this.controlRequests.values()) entry.finish({ ok: false, reason: 'send-failed' });
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
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
    // 预算必须是**绝对截止时刻**，不能只是"每段等待各管各的"：旧实现里
    // ① 心跳重发与 reconnect 重发都会重新装配计时器，② 过期 attempt 的失败
    // 回调还会 clearTimeout 掉当前这次 attempt 的计时器 —— 两条路都能把总耗时
    // 拖过应用侧超时，且没有任何地方能证明"它一定会在 X 毫秒内结束"。
    const budget = rpcBudgetMs(attempts, timeout);
    const deadline = Date.now() + budget;
    const crumb = this.openCrumb({ id, path, method });
    return new Promise((resolve, reject) => {
      let attempt = 0;
      let healed = 0;
      let generation = 0;
      let settled = false;
      const controller = new AbortController();
      // `startedAt` 一经创建不再变（`at` 每次 attempt 都会刷新）：看门狗用它判断
      // "这条请求发出之后是否一条下行都没收到"（见 startStaleWatch 里的说明）。
      const startedAt = Date.now();
      const entry = { id, at: startedAt, startedAt, sessionToken: this.session?.token, deviceToken: this.deviceToken, timer: undefined, resolve: undefined, reject: undefined, retry: undefined, heal: undefined };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
        controller.abort();
        fn(value);
      };
      entry.resolve = (message) => {
        this.noteCrumbRes(crumb, message);
        finish(resolve, message);
      };
      entry.reject = (error) => {
        this.noteCrumbEnd(crumb, error);
        finish(reject, error);
      };
      this.pending.set(id, entry);
      this.stats.rpc += 1;

      const abort = () => entry.reject(new DOMException('请求已取消', 'AbortError'));
      if (signal !== undefined && signal !== null) {
        if (signal.aborted === true) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      }

      /**
       * 装一个**不超过绝对截止时刻**的计时器。
       *
       * 所有路径（backoff 到点、传输层失败补兜底、重连重发后）都走这里，
       * 于是"这条请求最晚什么时候结束"只由 `deadline` 决定。
       */
      const arm = (delay, fire) => {
        clearTimeout(entry.timer);
        const left = Math.max(0, deadline - Date.now());
        entry.timer = setTimeout(fire, Math.min(Math.max(0, delay), left));
      };
      const dieByDeadline = () => {
        if (settled) return;
        const left = deadline - Date.now();
        if (left > 0) { arm(left, dieByDeadline); return; }
        entry.reject(rpcTimeoutError(timeout));
      };

      // 前几次重发要快：首个请求常常正好撞上电脑端重连，4 s 才重试会把冷启动拖到 20 s+。
      const attemptOnce = (reason = 'backoff') => {
        attempt += 1;
        generation += 1;
        const myGeneration = generation;
        entry.at = Date.now();
        this.noteCrumbTry(crumb, attempt, reason);
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
        }, controller.signal).catch((error) => {
          if (settled) return;
          // **过期 attempt 的失败不是结论**：它已经被后面那次 attempt 取代了。
          // 旧实现在这里无条件 `clearTimeout(entry.timer)` 再补一个 16 s 计时器，
          // 等于把当前 attempt 的退避链打断、剩余重发预算作废，判死时刻还随
          // "迟到的 catch 什么时候到"漂移（最长能比预算多出十几秒）。
          if (myGeneration !== generation) return;
          // 传输层暂时不可用（断线 / 客户端换代）：**不判死**。请求还活着等
          // resendPending() 用同一个 id 重发；这条 catch 只保证"即使没人再重发，
          // 也有东西能在截止时刻结束它"。
          if (error?.transient !== true) { entry.reject(error); return; }
          arm(timeout, dieByDeadline);
        });
        // Early duplicates repair a lost frame in a second or two; the *last*
        // attempt still gets the full per-request budget, because a slow route
        // (a long task list, a POST that spawns an agent) is not a lost frame.
        const delay = attempt < attempts ? (RPC_BACKOFF_MS[attempt - 1] ?? 2_000) : timeout;
        arm(delay, () => {
          if (settled) return;
          if (attempt < attempts) { attemptOnce(); return; }
          dieByDeadline();
        });
      };
      entry.retry = () => { if (!settled && attempt < attempts) attemptOnce('beat'); };
      /**
       * 重连后的重发：允许**越过** `attempts` 上限一次（见 `RPC_HEAL_RESENDS`）。
       *
       * 典型现场：一条 45 KB 的回包被切成 2 片，第 1 片到了、第 2 片撞上重连，
       * `abortTransport()` 清掉半包表。此时只剩这条路能让桌面按同一 id 再放一遍，
       * 否则就只能干等预算耗尽 —— 用户看到的是"网络明明恢复了，页面还是不动"。
       *
       * @returns {boolean} 是否真的发出了这一帧（`false` = 额度已用尽）
       */
      entry.heal = () => {
        if (settled || healed >= RPC_HEAL_RESENDS) return false;
        healed += 1;
        attemptOnce('heal');
        return true;
      };
      attemptOnce('first');
    });
  }

  /* ------------------------ 在途 RPC 面包屑（诊断用） ------------------------ */

  /**
   * 开一条面包屑。
   *
   * 只记"这条请求到底走到哪一步了"：谁、要什么、发了几次、有没有收到过 `res`、
   * 最后那条 `res` 的 id / 体积 / 时刻、以及怎么结束的。**环形**只留最近
   * `RPC_LOG_MAX` 条，给 `__POCKET_DIAG__.snapshot()` 读。
   *
   * `path` 只留 pathname：query 里是游标、`limit` 之类的参数，没有诊断价值，
   * 而诊断文本是要用户复制给别人看的 —— 少一个字段就少一次泄露机会。
   */
  openCrumb({ id, path, method }) {
    const crumb = {
      id: String(id ?? ''),
      verb: String(method ?? 'GET').toUpperCase().slice(0, 6),
      path: breadcrumbPath(path),
      at: Date.now(),
      tries: 0,
      resends: 0,
      sawRes: false,
      resId: '',
      resBytes: 0,
      resAt: 0,
      end: '',
      ms: 0,
    };
    this.rpcLog.push(crumb);
    if (this.rpcLog.length > RPC_LOG_MAX) this.rpcLog.splice(0, this.rpcLog.length - RPC_LOG_MAX);
    return crumb;
  }

  noteCrumbTry(crumb, tries, reason) {
    crumb.tries = tries;
    if (reason === 'beat' || reason === 'heal') crumb.resends += 1;
  }

  noteCrumbRes(crumb, message) {
    const body = typeof message?.body === 'string' ? message.body : '';
    crumb.sawRes = true;
    crumb.resId = String(message?.id ?? '');
    // base64 → 原始字节数（诊断里要的是"那条大响应到底有多大"）。
    crumb.resBytes = Math.round((body.length * 3) / 4);
    crumb.resAt = Date.now();
  }

  noteCrumbEnd(crumb, error) {
    const timeout = error?.pocketCode === 'relay_timeout';
    crumb.end = timeout ? 'timeout' : (error?.name === 'AbortError' ? 'aborted' : 'error');
    crumb.ms = Math.max(0, Date.now() - crumb.at);
    if (timeout) this.stats.timeouts += 1;
  }

  /** 面包屑快照（只读副本；诊断块与界面进度都用它）。 */
  rpcBreadcrumbs() {
    return this.rpcLog.map((crumb) => ({ ...crumb }));
  }

  /** 在途请求的**极简**视图：界面拿它显示"正在重试第几次"。 */
  inflight() {
    const out = [];
    for (const crumb of this.rpcLog) {
      if (crumb.end !== '') continue;
      out.push({ path: crumb.path, verb: crumb.verb, tries: crumb.tries, ms: Math.max(0, Date.now() - crumb.at) });
    }
    return out;
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

/**
 * 解开一条回包的 body（必要时先解 gzip），**带截止时刻**。
 *
 * 为什么必须抽出来单独测（`test/domain/shell-rpc-budget` 用 `sliceFunction()` 在
 * vm 里真跑）：`new Response(stream).arrayBuffer()` 是整条链上唯一没有兜底的一步。
 * 一旦解压流卡住（回包字节被截断、WebKit 的 DecompressionStream 半死），这个
 * promise 永远不 resolve；而应用侧那个 AbortSignal 早就传不进来了（外壳的
 * `request()` 已经 resolve，监听器也摘了）。结果就是界面**永久**停在「加载中…」，
 * 刷新才恢复 —— 这比"超时报错"糟得多，因为它没有任何出路。
 *
 * 失败时打 `pocketCode: 'decompress'`：它既不是"连不上"（`network`）也不是
 * "读响应失败"（`read`），`web/lib/net.js` 据此**不再**用新的 request id 把整条
 * 108 KB 的响应重拉一遍（桌面日志里那些"同一会话被完整请求多次"就是那么来的）。
 *
 * @param {Uint8Array} bytes 回包原始字节（已是二进制，不是 base64）
 * @param {number} [timeoutMs]
 * @returns {Promise<Uint8Array>}
 */
async function decompressGzip(bytes, timeoutMs = DECOMPRESS_TIMEOUT_MS) {
  // 旧实现是 `new Blob([bytes]).stream().pipeThrough(DS)` → `new Response(...).arrayBuffer()`：
  // 同一份数据要搬三遍（gzip 字节拷进 Blob → Blob 流 chunk → arrayBuffer 再拼一块），
  // 而解压本身只需要"写进去、读出来"。手机端这条路径解压后是 150~200 KB，三份搬运
  // 全落在主线程上（探针 Node 24、15 次中位：2 KB 档 0.31 ms → 0.15 ms，58 KB 档
  // 0.88 ms → 0.77 ms，且 2 KB 的固定开销几乎全是它）。
  // 现在直接写 DecompressionStream，从 read 端收集 chunk：单 chunk 时零拷贝返回，
  // 多 chunk 才拼一次（这一步 `Response.arrayBuffer()` 本来也要做）。
  const stream = new DecompressionStream('gzip');
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  // 写端不 await：坏字节会让 write 与 read **同时**失败，而 read 端才是我们观察的
  // 通道。不接住 write 的 rejection 只会在控制台刷 "unhandled rejection"。
  void writer.write(bytes).catch(() => {});
  void writer.close().catch(() => {});
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('大响应解压超时');
      error.pocketCode = 'decompress';
      reject(error);
    }, Math.max(1, Number(timeoutMs) || DECOMPRESS_TIMEOUT_MS));
  });
  const drain = (async () => {
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.length > 0) {
        chunks.push(value);
        total += value.length;
      }
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  })();
  try {
    return await Promise.race([drain, guard]);
  } catch (error) {
    // 超时/坏字节都要把底层流取消掉：不取消的话这条 `DecompressionStream` 永远
    // 半开着（浏览器里表现为"解压一次卡一次"，内存只涨不落）。`Promise.race` 只是
    // 不再等它，读端还攥着已解出的缓冲。
    // `cancel()` 自己也可能抛（流已关闭 / 平台不支持），绝不能再盖掉原始错误。
    try { await reader.cancel?.(); } catch { /* 已关闭或平台不支持 */ }
    // 解压失败（坏字节 / 流卡住）都归成同一类：拿到的 body 不可用。
    if (error?.pocketCode === 'decompress') throw error;
    const failure = new Error(`大响应解压失败：${String(error?.message ?? error)}`);
    failure.pocketCode = 'decompress';
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把外壳这一侧的错误翻译成"能被 `web/lib/net.js` 认出原因"的形状。
 *
 * 旧实现里外壳抛什么都长一个样，于是 net.js 一律当成「连不上电脑」
 * （`code: 'network'`）→ **可重试** → 换一个新的 request id 把整棵请求重来一遍。
 * 用户因此从"一次 15 秒"变成"两次 15 秒"，而链路明明是通的。
 *
 * 只标两类：
 *   - `relay_timeout`：外壳自己的同 id 重放已经跑完预算（带 `timeoutMs`）；
 *   - `relay`：其它外壳侧结论（例如中继拒绝了这条帧）。
 * `AbortError` 原样放行 —— 那是**应用侧**取消的，翻译权在 net.js。
 */
function tagRelayFailure(error) {
  if (error === null || typeof error !== 'object') return error;
  if (error.name === 'AbortError') return error;
  if (typeof error.pocketCode === 'string' && error.pocketCode !== '') return error;
  error.pocketCode = Number(error.timeoutMs) > 0 ? 'relay_timeout' : 'relay';
  return error;
}

/**
 * 把一段字节包成 Response 能直接吃的**单 chunk 流**。
 *
 * 为什么不用 `new Response(bytes)`：那是"把字节交给 Response"，实现上要在构造时
 * 把整段 body 拷进自己的缓冲 —— 计数桩实测：对 58 KB 档（解压后 192 763 B）的响应，
 * 这一下就记到一次 192 763 B 的整份拷贝；之后应用 `text()` 还会把 body 流读成一块
 * （又一次 192 763 B）。改成流之后构造时不碰字节，谁真去读谁才付那一份，而应用侧
 * （`web/lib/net.js`）走 `pocketBytes` 更是连流都不读。
 *
 * 语义与 `new Response(bytes)` 完全一致（单 chunk、读一次即 EOF），只是把拷贝推迟。
 *
 * @param {Uint8Array} bytes
 * @returns {ReadableStream}
 */
function bytesBody(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

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

    const request = new Request(isRequest ? input : url, init);
    const method = request.method;
    const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
    let reply;
    try {
      reply = await relay.request({
        method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        body,
        signal: request.signal,
        gzip: typeof DecompressionStream === 'function',
      });
    } catch (error) {
      throw tagRelayFailure(error);
    }
    let bytes = unb64(reply.body ?? '');
    if (reply.enc === 'gzip' && typeof DecompressionStream === 'function') {
      bytes = await decompressGzip(bytes);
    }
    const outHeaders = new Headers();
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      try { outHeaders.set(name, value); } catch { /* forbidden header name */ }
    }
    const status = Number(reply.status) || 200;
    const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
    // body 走单 chunk 流（构造时零拷贝，见上方 `bytesBody()`）。
    const response = new Response(noBody ? null : bytesBody(bytes), { status, statusText: '', headers: outHeaders });
    // 给应用层留一条**不经过 Response/流**的取字节通道：`web/lib/net.js` 直接拿它
    // 解码，省掉 Response 读流再拼一块的整份拷贝。非枚举属性，不改变 Response 的任何
    // 标准行为；旧版应用不读它，行为不变。
    if (!noBody) {
      Object.defineProperty(response, 'pocketBytes', { value: bytes, configurable: true, enumerable: false });
    }
    return response;
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
      this.sendQueue = Promise.resolve();
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
      if (this.readyState !== PocketWebSocket.OPEN) return;
      let data = String(message.data ?? '');
      if (message.bin === true) {
        const bytes = unb64(data);
        data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
      }
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
      if (this.readyState === PocketWebSocket.CONNECTING) throw new DOMException('WebSocket 未连接', 'InvalidStateError');
      if (this.readyState !== PocketWebSocket.OPEN) return;
      const blob = data instanceof Blob;
      const binary = typeof data !== 'string';
      let payload = data;
      if (binary && !blob) {
        if (data instanceof ArrayBuffer) payload = b64(new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) payload = b64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        else throw new TypeError('WebSocket.send: 不支持的数据类型');
      }
      this.sendQueue = this.sendQueue.then(async () => {
        if (this.readyState === PocketWebSocket.CLOSED) return;
        if (blob) payload = b64(new Uint8Array(await data.arrayBuffer()));
        await relay.send({ t: 'ws.msg', id: this.id, bin: binary, data: payload, sid: relay.sid, seq: relay.nextSeq(), ts: relay.serverNow() });
      }).catch((error) => {
        console.warn('[pocket] ws send failed', error?.message);
        this._close(1006, 'send failed');
      });
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= PocketWebSocket.CLOSING) return;
      this.readyState = PocketWebSocket.CLOSING;
      void this.sendQueue.then(() => relay.closeSocket(this.id)).finally(() => this._close(code, reason));
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
    text: '链接在电脑端「配对页 → 远程访问」里，形如 …/#r=…&k=…&t=1',
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
    if (next.length === 0 || !parsed.get('r') || !parsed.get('k')) {
      note.textContent = value.length === 0
        ? '还没有填链接：请从电脑端「配对页 → 远程访问」复制完整链接（形如 …/#r=…&k=…&t=1）。'
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
 * 链接记忆：把 `#r=…&k=…&t=1` 存进 localStorage，供"裸启动"恢复。
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
    if (!parsed.get('r') || !parsed.get('k')) return null;
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
   * 浏览器也可能在"退出后再进来"时丢掉 `#r=…&k=…&t=1`。参数一没，外壳就判定
   * "不是中继外壳"，把用户丢到「粘贴链接」页面 —— 那个页面的按钮只是把框里的
   * 内容塞回 hash，框里没有完整链接时自然点了没反应。
   */
  const savedLink = readStoredLink();
  let link = params;
  const appRoute = location.hash.startsWith('#/');
  if (!location.hash.slice(1) || appRoute) {
    if (savedLink !== null) {
      link = new URLSearchParams(savedLink);
      // 把地址栏也补回完整链接，后续任何读 location.hash 的代码都一致。
      if (!appRoute) {
        try { history.replaceState(null, '', '#' + savedLink); } catch { /* 老浏览器 */ }
      }
    }
  }

  const room = link.get('r');
  const key = link.get('k');
  // `t` 只用来判断「这是不是一个完整的远程链接」。它以前被当成手机的 API
  // 凭据；现在凭据只有一条路——口令登录换来的 deviceToken（见 persistDeviceSession）。
  const name = link.get('n') ?? 'DSH';

  if (!room || !key) {
    renderManualEntry('这个页面需要电脑端生成的远程链接才能工作。');
    return;
  }
  // 记住这次可用的链接，下次裸启动直接进。

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
  if (link.has('t') && link.get('t') !== '1') {
    link.set('t', '1');
    if (!appRoute) {
      try { history.replaceState(null, '', '#' + link.toString()); } catch { /* private browsing */ }
    }
  }
  storeLink(link.toString());
  const scope = sealer.scope;
  const known = readDeviceSession(scope);
  if (known !== null) {
    relay.deviceToken = known.token;
    relay.deviceId = known.deviceId;
  }
  relay.session = await loadAuthSession(scope);
  window.__POCKET_RELAY__ = relay;

  /**
   * 中继诊断：只读快照 + 纯函数，交给内层 UI（连接页的「中继诊断」块）。
   *
   * 为什么走 global 而不是让 `web/views/connect.js` 直接 import：连接页同时被
   * 打进局域网布局，而 `web/sw.js` 的 ASSETS 是一份手写清单（不在本次可改范围），
   * 多一条 import 而清单没跟上，装过 SW 的手机首次离线打开就是模块 404 白屏
   * （`test/unit/client-guards` 钉着这条）。所以纯逻辑由外壳 import，UI 只读这里。
   *
   * 快照**只**含非敏感字段：没有房间密钥、没有设备令牌、没有链接里的 `r`/`t`。
   * 连接页「复制诊断信息」会把 `snapshot()` 的结果直接交给 `buildDiagText()`，
   * 那之后一个字节都不会再回到这里。
   *
   * 字段为什么是这些（事故里最缺的一层）：
   *   - 与 `online` 分开的 `pcStale`：中继在线 ≠ 电脑端在说话。同屏"一边在线、
   *     一边显示电脑端已离线"的矛盾就是这两件事挤在一个字段里造成的。
   *   - `stats`：只有 `online` 判断不了"手机收不到下行"这种坏法 —— 真实链路
   *     自认为在线、实际一帧都收不进来，收发计数与最后收帧时刻是唯一证据。
   *   - `crumb`：最近 8 条 RPC 走到哪一步（id / pathname / 发起时刻 / 发了几次 /
   *     有没有收到过 res / 最后那条 res 的 id·字节·时刻 / 怎么结束的）。桌面侧有
   *     `rx / rpc / replays` 三个计数器，手机侧以前只有一个 `pending` 数字，于是
   *     "回包丢了"和"我们早就不等了"在两边看起来一模一样。
   *   - `timeouts`：**超时未收到 res 的次数**；`resMiss`：收到了 res 但 pending 里
   *     已经没有它了（迟到的回包）。前者高 → 下行慢或丢；后者高 → 我们放弃得太早；
   *     两者都低而界面仍卡 → 去看解压（`decompressGzip`）。
   *   - `rpcBudget`：一条请求的**总**预算，用来和应用侧超时对账。
   */
  globalThis.__POCKET_DIAG__ = {
    snapshot: () => ({
      brokers: relay.brokers,
      online: relay.ready === true,
      pcStale: relay.pcStale === true,
      attempts: relay.failureStreak,
      lastFailure: relay.lastFailure,
      lastOkAt: relay.lastOkAt,
      lastAttemptAt: relay.lastAttemptAt,
      stats: { rx: relay.stats.rx, tx: relay.stats.tx, err: relay.stats.err, lastRxAt: relay.stats.lastRxAt },
      pending: relay.pending.size,
      restartCount: relay.restartCount,
      sockets: relay.sockets.size,
      now: Date.now(),
      crumb: relay.rpcBreadcrumbs(),
      timeouts: relay.stats.timeouts,
      resMiss: relay.stats.resMiss,
      rpcBudget: rpcBudgetMs(),
      partsOpen: relay.parts.size,
      partsIncomplete: relay.stats.partsIncomplete,
      partsNacked: relay.stats.partsNacked,
      stallRebuilds: relay.stats.stallRebuilds,
    }),
    describeFailure,
    diagRows,
    buildDiagText,
    describeFailureShort,
    describeBrokerChoice,
    describeAdvice,
    /** 在途请求的极简视图：应用层拿它显示"正在重试第几次"（不含任何 id）。 */
    inflight: () => relay.inflight(),
    /**
     * 链路世代号（每次 `restart()` +1，单调）。
     *
     * 内层 UI（`web/lib/net.js`）用它回答「这条失败之后链路换过没有」：
     *   - F2：换过才允许对 GET 的 `relay_timeout` 补一次自动重试（请求已经在一
     *     条刚重建的链路上白等过一次预算）；
     *   - F3：详情失败文案要区分「链路刚重建过」与「电脑端没响应」。
     * 没有外壳（局域网布局）时它根本不存在，调用方退化成 0 = 行为与以前一致。
     */
    linkEpoch: () => Number(relay.linkEpoch) || 0,
  };

  relay.onpc = (pc) => setSplash(`已连接 ${pc.name}`, '正在同步任务…');
  // One banner, two conditions: the relay link is down, or the desktop stopped
  // talking. The link being down always wins.
  let relayOffline = false;
  /** 中继层横幅的去抖计时器：短抖动不打扰。 */
  let relayBannerTimer = null;
  let staleText = null;
  /**
   * 横幅后半句：真实断因（读 `relay.lastFailure`，渲染时现算）。
   *
   * 主句保持用户已经认识的「中继断开，正在重连…」，只在后面补一个**短标签**
   * （`（连接被重置）`）—— 横幅只有一行，带括号的完整解释在连接页的中继诊断里。
   * 6 秒去抖照旧：短抖动期间 lastFailure 可能已经有了，但横幅根本不会显示。
   */
  const relayReasonSuffix = () => {
    const failure = relay.lastFailure;
    if (failure === null || failure === undefined) return '';
    try {
      return `（${describeFailureShort(failure)}）`;
    } catch {
      return ''; // 诊断永远不该影响主流程
    }
  };
  const renderBanner = () => {
    if (relayOffline) { setBanner(`中继断开，正在重连…${relayReasonSuffix()}`); return; }
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
          if (relayOffline) {
            // splash 上的标题同样补上断因：连接还没成功过时，这是唯一能看到的屏幕。
            setSplash(`中继断开，正在重连…${relayReasonSuffix()}`, '网络切换后会自行恢复');
            renderBanner();
          }
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

  /* ------------------------------------------------------------------------
     初始化脚手架：收尾 / 致命页 / 重试
     ------------------------------------------------------------------------
     为什么要先有这三样再谈引导流程：1.0.2 把 tabTimer 与 pagehide 监听写在
     4 条 `showFatal` 之前，于是"死页"其实还在跑（staleWatch / 快重连 / MQTT 都
     没停），而且会被新标签页的抢主逻辑覆盖成「这个界面已失效」，把唯一有用的
     诊断页挡掉。现在副作用一律在初始化成功之后注册，任何 fatal 都走 teardown。
     ------------------------------------------------------------------------ */

  const TAB_KEY = 'dsh.pocket.activeTab';
  const tabId = randomId(6);
  let tabTimer = null;
  const readActiveTab = () => {
    try {
      const raw = localStorage.getItem(TAB_KEY);
      return raw === null ? null : JSON.parse(raw);
    } catch { return null; }
  };
  /** 主动关闭时让出位置，别把"最新"这个名字带走（否则别的页面永远等不到）。 */
  const yieldActiveTab = () => {
    const active = readActiveTab();
    if (active !== null && active.id === tabId) {
      try { localStorage.removeItem(TAB_KEY); } catch { /* ignore */ }
    }
  };

  /** 已注册的监听器：[target, type, handler]，收尾时逐条摘掉。 */
  const lifecycle = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    lifecycle.push([target, type, handler]);
  };

  /** 停掉一切会自己再跑起来的东西（计时器、监听器、MQTT、在途请求）。 */
  const teardownShell = () => {
    if (tabTimer !== null) { clearInterval(tabTimer); tabTimer = null; }
    if (relayBannerTimer !== null) { clearTimeout(relayBannerTimer); relayBannerTimer = null; }
    yieldActiveTab();
    for (const [target, type, handler] of lifecycle.splice(0)) {
      try { target.removeEventListener(type, handler); } catch { /* 无关紧要 */ }
    }
    try { relay.stop('界面已停止'); } catch { /* 收尾不该再抛 */ }
  };

  /** 所有 fatal 路径的统一出口：先收尾，再画可恢复的失败页。 */
  const failBoot = (title, detail) => {
    teardownShell();
    document.getElementById('pocket-login')?.remove();
    showFatal(title, detail);
  };

  /**
   * 失败页上「重新连接」要做的事：把这一轮引导从头再跑一遍。
   *
   * 注意 `relay.stop()` 会把 relay 标成"已收摊"（防止看门狗 / 快重连在死页上
   * 继续跑），所以重跑前必须显式叫醒它；页面已被接管时不能重跑，只能刷新。
   */
  const retryBoot = () => {
    if (relay.superseded === true) { location.reload(); return; }
    relay.disposed = false;
    void boot();
  };

  /**
   * 引导流程本体（可以在致命页上被「重新连接」重跑）。
   *
   * 结构上刻意做成闭包而不是一条直线：1.0.2 的失败页只有 `location.reload()`，
   * 而刷新回到的还是同一张死页 —— 用户没有任何恢复路径。
   */
  const boot = async () => {
    // 上一轮（重试）可能留下了计时器与 MQTT 客户端：先收拾干净再开始。
    teardownShell();
    relay.disposed = false;
    document.getElementById('pocket-login')?.remove();
    // 失败页的按钮与红字也要收掉：这一轮是从「重新连接」点进来的，界面得回到
    // "正在连接"，而不是把上一轮的致命页留在 splash 上。
    splash?.classList.remove('is-error');
    splashExtra?.replaceChildren();
    retryBootAction = retryBoot;
    setSplash('正在连接电脑…', '通过加密中继建立通道');

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
    const removeGate = () => { document.getElementById('pocket-login')?.remove(); };

    /**
     * 首次建联失败**不是终局**（A2）。
     *
     * 1.0.2 在这里一次失败就 `showFatal` + `return`，而那页面上唯一的按钮是
     * 「重新加载」——刷新回到的还是同一张死页。公共 broker 的首次握手本来就
     * 常失败（实测 1/3 的概率第一次 connect 超时），退避重试能把"打开就白屏"
     * 变成"多等 1~2 秒就进去了"；只有连续 5 次都失败才落到可重试的失败页。
     */
    let lastBecause = '';
    const connected = await connectWithRetry({
      async connect() {
        await relay.connect();
      },
      onRetry: ({ attempt, delay, error }) => {
        const raw = String(error?.message ?? error);
        let because = raw;
        // 别把 `连接超时` 这种壳话当结论：真正有用的是 `connectOne` 抓到的
        // error.code / connack（见 `relay.lastFailure`）。这条路径是"一次都没
        // 连上"时**唯一**的界面，断因在这里丢掉就再也拿不回来了。
        try {
          const described = describeFailure(relay.lastFailure);
          if (typeof described === 'string' && described.length > 0 && described !== raw) because = `${described}（${raw}）`;
        } catch { /* 翻译表炸了也不能盖掉原始错误 */ }
        lastBecause = because;
        if (delay === null) return;
        // 界面上必须看得见"第 N 次重试 · 原因"：否则用户只会觉得页面卡住了。
        if (earlyHint !== null) earlyHint.textContent = `第 ${attempt} 次重试 · ${because}`;
        setSplash(`正在重试连接（第 ${attempt} 次）…`, `${because} · ${Math.round(delay / 1_000)} 秒后自动再试`);
      },
    });
    if (!connected.ok) {
      removeGate();
      teardownShell();
      const because = lastBecause || String(connected.lastError?.message ?? connected.lastError);
      showFatal('无法建立中继连接', because);
      return;
    }
    relay.startStaleWatch();
    // 用户可见的「重连」、以及手机从后台回到前台，都要能把底层连接推倒重建。
    // 只重开 WS 隧道救不了"MQTT 已死但自以为活着"的状态。
    relay.onhardreset = () => { location.reload(); };

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
        removeGate();
        failBoot('电脑端没有响应', '确认电脑上的 DSH 正在运行，且「远程访问」已开启');
        return;
      }
    }
    if (relay.pcVersion > 0 && relay.pcVersion < PROTOCOL) {
      console.warn(`[pocket] desktop speaks protocol ${relay.pcVersion}, shell speaks ${PROTOCOL}`);
    }

    // 旧式握手（A9）：桌面插件还没升级到会回 `authReplyId` 的版本。
    //
    // 1.0.2 在这里整屏硬拦「需要更新电脑端插件」，唯一的按钮是「重新加载」——
    // 而手机 SW 可能已经缓存了新外壳、电脑端还没升级，于是刷新还是这张死页，
    // 用户白屏且完全无从下手。协议本身没变（auth/login 帧格式一致），缺的只是
    // 桌面端一个"我支持按 id 回控制帧"的标记，所以降级成可操作的提示 + 继续。
    if (!relay.supportsAuthReplyId) {
      removeGate();
      await promptLegacyDesktop();
      hideSplash();
    }

    // Login gate: no valid token, no UI. The 15-day token is encrypted at rest.
    //
    // 这里**必须串行**：之前为了省一个公网往返，把 checkAuth 提前到 connect 之后
    // 就发，结果是「电脑端还没起来」时那次请求收不到应答，超时重发后落到了另一条
    // 分支，最终显示的是 App 自己的 /connect 页（只有「重新登录」按钮、没有账号
    // 密码框），与「电脑一直在」时的登录闸门不一致。省 0.8 s 不值得换来两套界面。
    const authState = await relay.checkAuth();
    if (authState.unavailable || (!authState.required && !authState.ok)) {
      removeGate();
      failBoot('未能确认登录状态', '电脑未确认这次登录检查，请检查连接后重新加载。');
      return;
    }
    if (authState.required && !authState.ok) {
      // A fresh password login provisions this installation again, including after revocation.
      clearAuthSession();
      relay.session = null;
      relay.dropDevice('');
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
        failBoot('需要登录', '没有登录就无法访问这台电脑');
        return;
      }
    } else {
      removeGate();
    }
    relay.onunauthorized = () => {
      clearAuthSession();
      relay.session = null;
      relay.dropDevice('');
      if (!relay.authRequired || document.getElementById('pocket-login-form') !== null) return;
      void showLoginGate(relay, { user: relay.authUser ?? '', reason: '登录已过期，请重新登录' })
        .then((ok) => { if (ok) location.reload(); });
    };

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
    persistDeviceSession(deviceToken, relay.deviceId, { name, room, scope });

    /* --------------------------------------------------------------------
       **到这里才算初始化成功**：下面这些副作用（定时器、监听器、抢主、shims）
       一律在这里注册，任何一条 fatal 都发生在它们之前，死页不会带着计时器跑。
       -------------------------------------------------------------------- */

    // 用户可见的「重连」，以及手机从后台回到前台，都要能把底层连接推倒重建。
    globalThis.__POCKET_RELAY_RESTART__ = (reason) => relay.restart(reason || '手动重连');

    // 页面被关掉 / 切到后台时，尽力把隧道关掉，别让电脑端留着僵尸槽位。
    // 手机被强杀时这段不会执行——所以电脑侧还有一层按活动时间的槽位回收。
    const release = () => closeChannels(relay);
    listen(window, 'pagehide', release);
    listen(window, 'beforeunload', release);
    listen(window, 'pagehide', yieldActiveTab);

    // ---- 同一台手机只让"最新打开的界面"生效：localStorage 抢主 ----
    //
    // 为什么不放在服务端：实测服务端拿到的页面身份（psid）不可靠 —— 同一个页面
    // 重连时会带上不同的 psid，服务端会把它的新隧道当成"别的页面"顶掉，页面被
    // 自己反复杀死。而这个需求本质是"同一台设备上哪个标签页最新"，localStorage
    // 天然是**同源跨标签共享**的，最可靠。
    //
    // 规则：每个页面启动时把自己的 id 写进去；每 1.5 s 检查一次，发现不是自己就
    // 认输（停止重连 + 整屏提示）。抢输的页面自己停，所以不会再发生互相反抢。
    try {
      localStorage.setItem(TAB_KEY, JSON.stringify({ id: tabId, at: Date.now() }));
    } catch { /* 隐私模式：退化为多页并存 */ }
    tabTimer = setInterval(() => {
      const active = readActiveTab();
      if (active === null || active.id === tabId) return;
      if (tabTimer !== null) { clearInterval(tabTimer); tabTimer = null; }
      relay.markSuperseded();
    }, 1_500);

    // 回到前台要立刻恢复（A7）：判据与动作都在 onVisible 里。
    document.addEventListener('visibilitychange', onVisible);
    lifecycle.push([document, 'visibilitychange', onVisible]);

    installShims(relay);
    hideSplash();
    registerShellWorker();

    // Contract with web/app.js: set before the import, read at module evaluation.
    globalThis.__POCKET_SHELL__ = {
      mode: 'remote',
      scope,
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
            persistDeviceSession(relay.deviceToken, relay.deviceId, { name, room, scope });
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
        const token = relay.session?.token;
        relay.session = null;
        if (token && relay.ready) void relay.send({ t: 'logout', token }).catch(() => {});
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
      failBoot('界面加载失败', String(error?.message ?? error));
    }
  };

  /**
   * 回到前台（A7）：**先算静默，再重置下界**。
   *
   * 1.0.2 先把 `lastWakeAt` 设成"现在"，而 idle 的下界里就含它 —— 冻结期间一条
   * 下行都没收到也判不出静默，只能等 26 秒看门狗 + 最多 15 秒冷却；`justRestarted`
   * 的 20 秒窗口还会把那次 kick 也跳掉。iOS 上的体感就是"回到前台后最长 ~40 秒
   * 页面不动"。现在只要 ready 且已经 2 个心跳周期没有下行，立刻重建。
   */
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    const decision = wakeDecision({
      ready: relay.ready,
      now,
      lastRxAt: relay.stats.lastRxAt,
      pcSeenAt: relay.pcSeenAt,
      readyAt: relay.readyAt,
      restarting: relay.restarting,
      // 桌面空闲档 30 s 时门槛放大到 60 s：不能让"下一次心跳还没到"变成一次重建。
      beatMs: relay.pcBeatMs,
    });
    relay.lastWakeAt = now;
    // 顺带主动探一次：活着的话电脑会立刻回 hello+beat，把静默清零。
    relay.announce(true);
    if (decision === 'restart-silent') { void relay.restart('回到前台后下行静默'); return; }
    if (decision !== 'restart-down') return;
    // 真的没连上：沿用 20 秒窗口，避免刚重建过又立刻拆一遍。
    const justRestarted = now - (relay.lastRestartAt ?? 0) < 20_000;
    if (!justRestarted) void relay.restart('回到前台');
  };

  await boot();
}

export { Relay, installFetch, installWebSocket, makeSealer };

if (typeof document !== 'undefined') void main().catch((error) => {
  document.getElementById('pocket-login')?.remove();
  showFatal('无法启动手机界面', String(error?.message ?? error));
});
