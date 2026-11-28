/**
 * 列表里「多久之前」这类相对时间戳的**刷新计划**（纯逻辑，Node 可直接 import）。
 *
 * 修的是 D3：`web/app.js` 每 30 s 跑一次
 *
 *     for (const node of document.querySelectorAll('[data-ts]')) node.textContent = relTime(ts);
 *
 * 两个毛病叠在一起：
 *  1. **无条件写**：任务列表最多 5000 项（`lib/task-index.mjs` 的 maxTasks），
 *     绝大多数节点这一拍的文案和上一拍一模一样，却照样 `textContent =` 一次。
 *     写 `textContent` 会清空并重建子节点、触发样式/布局失效 —— 一屏 5000 个
 *     文本节点每 30 s 排一次队，后台被切回来时尤其明显。
 *  2. **不跳过不可见节点**：`display:none` / 折叠起来 / 在视口外的节点一个字都
 *     没人看，却也在同一批里被重写。
 *
 * 这里只回答一个纯问题：「这一拍到底要给哪些节点写什么」。DOM 侧的取节点、
 * 判可见、赋 `textContent` 留在 `web/app.js`，因为那部分没法在 Node 里测。
 *
 * 判据是**按节点记住上次写进去的字符串**：
 *  - 值和上次一样 → 不写（这是 D3 的核心，去掉它这条用例立刻红）；
 *  - 节点不可见 → 不写也不记住（下次可见时一定会写一次，不会永久空着）；
 *  - 节点从列表里消失 → 从记忆里淘汰（长会话里任务会一直增删，记忆表不能只增不减）。
 */

/**
 * 算一次刷新计划。
 *
 * @param {Iterable<{node: object, ts: number, visible?: boolean}>} nodes
 *   这一拍看到的节点。`node` 只当作 Map 的键（真 DOM 元素、测试里的假对象都行）。
 * @param {Map<object, string>} [previous] 上一拍写进 DOM 的字符串（本函数返回的那张表）
 * @param {(ts: number) => string} format 时间戳 → 文案（生产里是 `relTime`）
 * @returns {{writes: Array<{node: object, text: string}>, next: Map<object, string>, hidden: number}}
 *   `writes` 是**这次真的需要赋值**的节点；`next` 是下一拍的记忆表（只含这一拍可见的节点）。
 */
export function planRelativeTimeUpdates(nodes, previous, format) {
  const before = previous instanceof Map ? previous : new Map();
  const next = new Map();
  const writes = [];
  let hidden = 0;
  if (typeof format !== 'function') return { writes, next, hidden };
  for (const entry of nodes ?? []) {
    const node = entry?.node;
    if (node === undefined || node === null) continue;
    if (entry.visible === false) {
      hidden += 1;
      continue;
    }
    const ts = Number(entry.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    let text;
    try {
      text = String(format(ts));
    } catch {
      continue; // 格式化抛错就跳过这一项，绝不能因此让整次刷新中断
    }
    next.set(node, text);
    if (before.get(node) === text) continue; // 值没变：这一拍一个字都不写
    writes.push({ node, text });
  }
  return { writes, next, hidden };
}

/**
 * 一个节点这一拍算不算「用户看得见」。
 *
 * 为什么不是 `offsetParent === null`：`position: fixed` 的元素 `offsetParent` 也是
 * `null`，而列表里确有固定定位的浮层；反过来 `getClientRects().length === 0` 对
 * 真正 `display:none` 的节点是 0，对 fixed 元素是 1。两者取或，既覆盖"被隐藏"，
 * 又不误伤 fixed；再叠一个 `isConnected` 挡掉已经从文档里摘下来、还挂在
 * `querySelectorAll` 结果里的节点（Detached 节点布局全零，`offsetParent` 也是 null）。
 *
 * @param {Element} node
 */
export function isNodeVisible(node) {
  if (node === null || typeof node !== 'object') return false;
  if (node.isConnected === false) return false;
  // 真实浏览器都有这两个属性；没有（测试桩/极老环境）时按"可见"处理，宁可多写一次。
  if (node.offsetParent !== undefined) {
    if (node.offsetParent !== null) return true;
    if (typeof node.getClientRects === 'function' && node.getClientRects().length > 0) return true;
    return false;
  }
  return true;
}
