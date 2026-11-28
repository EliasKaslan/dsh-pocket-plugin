/**
 * 桌面配对页（`/pair`）设备列表的**纯逻辑**：行模型 + 差异更新计划 + 轮询门。
 *
 * 修的是 D4：旧 `web/pair.js` 每 4 s 把整张设备列表 `replaceChildren()` 重建一遍
 * （24 h = 21600 次全量 DOM 重建），且两个 `setInterval` 永不清除、不看
 * `document.hidden` —— 配对页放在后台也照样发 HTTP、重建 DOM。
 *
 * 为什么单独抽成模块：`web/pair.js` 是 `<script src="/pair/pair.js" defer>` 的
 * **经典脚本**（页面 HTML 在 `lib/pair-page.mjs` 里，本轮不可改），不能写静态
 * `import`；但差异更新的判据必须能被 `node --test` 直接测。所以纯逻辑放这里，
 * 由页面用动态 `import()` 取（同源，CSP `script-src 'self'` 允许）。
 *
 * 约定：这里的函数**不碰 DOM**。DOM 那一侧只做 "拿到计划 → remove / update /
 * create / 必要时重排"，文本一律按行模型比对后再写。
 */

const PLATFORM_FALLBACK = 'unknown';
const IP_FALLBACK = '未知地址';
const NAME_FALLBACK = '未命名设备';

/**
 * 一台设备在列表里长什么样。
 *
 * 字段与旧 `renderDevices` 逐字一致（同样的图标字、同样的 `·` 拼接、同样的
 * 「本机 · 不可移除」语义），这样改成差异更新之后**界面一个像素都不变**。
 *
 * @param {object} device `/api/v1/devices` 里的一条
 * @returns {{id: string, icon: string, name: string, meta: string, relay: boolean}}
 */
export function deviceModel(device) {
  const source = device !== null && typeof device === 'object' ? device : {};
  const relay = source.localRelay === true;
  const platform = typeof source.platform === 'string' && source.platform.length > 0
    ? source.platform
    : PLATFORM_FALLBACK;
  const parts = [relay ? '中继通道' : platform];
  if (source.appVersion && !relay) parts.push(`v${source.appVersion}`);
  parts.push(typeof source.lastIp === 'string' && source.lastIp.length > 0 ? source.lastIp : IP_FALLBACK);
  return {
    id: String(source.id ?? ''),
    icon: source.platform === 'harmonyos' ? '鸿' : '设',
    name: typeof source.name === 'string' && source.name.length > 0 ? source.name : NAME_FALLBACK,
    meta: parts.join(' · '),
    relay,
  };
}

/**
 * 把接口返回的设备数组变成行模型数组：丢掉没有 id 的、去掉重复 id（保留第一条）。
 *
 * 重复 id 必须去重：否则同一台设备会出现两行，点哪一行的「移除」都可能失败。
 *
 * @param {unknown} devices
 * @returns {Array<{id: string, icon: string, name: string, meta: string, relay: boolean}>}
 */
export function deviceModels(devices) {
  if (!Array.isArray(devices)) return [];
  const seen = new Set();
  const models = [];
  for (const device of devices) {
    const model = deviceModel(device);
    if (model.id === '' || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/** 两行模型是否渲染成完全一样的东西（一样就一个字都不用写）。 */
export function sameDeviceModel(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  return left.icon === right.icon
    && left.name === right.name
    && left.meta === right.meta
    && left.relay === right.relay;
}

/**
 * 算这一轮要动哪些行。
 *
 * @param {Map<string, object>} [previous] 上一轮真的写进 DOM 的行模型（id -> model）
 * @param {Array<object>} models 这一轮的行模型（顺序即期望的展示顺序）
 * @returns {{
 *   order: string[], next: Map<string, object>, create: string[], update: string[], remove: string[],
 * }}
 *   `create`/`update`/`remove` 都是 id 数组；`next` 是下一轮的"已渲染"快照。
 */
export function planDeviceRows(previous, models) {
  const before = previous instanceof Map ? previous : new Map();
  const next = new Map();
  const order = [];
  const create = [];
  const update = [];
  for (const model of Array.isArray(models) ? models : []) {
    if (model === null || typeof model !== 'object') continue;
    const id = String(model.id ?? '');
    if (id === '') continue;
    order.push(id);
    next.set(id, model);
    const seen = before.get(id);
    if (seen === undefined) create.push(id);
    else if (!sameDeviceModel(seen, model)) update.push(id);
  }
  const remove = [];
  for (const id of before.keys()) {
    if (!next.has(id)) remove.push(id);
  }
  return { order, next, create, update, remove };
}

/** 期望顺序与当前 DOM 顺序是否一致（一致就不碰 DOM，避免无意义的重排）。 */
export function sameOrder(order, current) {
  const left = Array.isArray(order) ? order : [];
  const right = Array.isArray(current) ? current : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 这一拍该不该刷新。
 *
 * 三条门依次是：**已停用/被拒**（403 之后不再打）、**上一拍还没回来**（4 s 定时器
 * 撞上慢网络会叠出一串并发请求）、**页面不可见**（切后台/最小化/息屏时一个请求
 * 都不该发 —— D4 的 21600 次就是这么来的）。
 *
 * @param {{stopped?: boolean, busy?: boolean, hidden?: boolean, visibility?: string}} [state]
 * @returns {boolean}
 */
export function shouldPoll(state) {
  const source = state !== null && typeof state === 'object' ? state : {};
  if (source.stopped === true) return false;
  if (source.busy === true) return false;
  if (source.hidden === true) return false;
  if (source.visibility === 'hidden' || source.visibility === 'prerender') return false;
  return true;
}
