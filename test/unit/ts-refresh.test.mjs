/**
 * D3：每 30 s 的「相对时间戳刷新」以前是**全量无条件重写**。
 *
 * `web/app.js` 旧代码：
 *
 *     for (const node of document.querySelectorAll('[data-ts]')) {
 *       node.textContent = relTime(Number(node.dataset.ts));
 *     }
 *
 * 任务列表上限 5000 项（`lib/task-index.mjs` 的 maxTasks），绝大多数节点这一拍的
 * 文案和上一拍完全一样，却照样赋值一次 —— 写 `textContent` 会清空并重建子节点、
 * 让样式与布局失效。可见性也不判，折叠/滚出视口的节点一起陪着重排。
 *
 * 修法：判据抽成纯函数 `web/lib/ts-refresh.js`（本文件直接 import），`app.js`
 * 只负责「取节点 → 调纯函数 → 按返回的集合赋值」。去掉「记住上值」这一步，
 * 下面第二条用例立刻变红。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { isNodeVisible, planRelativeTimeUpdates } from '../../web/lib/ts-refresh.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFile(resolve(ROOT, relative), 'utf8');

/** 假节点：只当 Map 的键用，测试不关心它是不是真 DOM。 */
const node = (label) => ({ label });

const format = (ts) => (ts === 0 ? '' : `${ts} 分钟前`);

test('D3：第一拍写全部可见节点；第二拍值没变就一个字都不写', () => {
  const a = node('a');
  const b = node('b');
  const nodes = [
    { node: a, ts: 5, visible: true },
    { node: b, ts: 7, visible: true },
  ];

  const first = planRelativeTimeUpdates(nodes, new Map(), format);
  assert.deepEqual(first.writes, [
    { node: a, text: '5 分钟前' },
    { node: b, text: '7 分钟前' },
  ], '第一拍所有可见节点都要写一次');

  // 同一批节点、同样的时间戳：文案一个字都没变。
  const second = planRelativeTimeUpdates(nodes, first.next, format);
  assert.deepEqual(second.writes, [], '值没变时必须零写入（旧代码这里是 2 次 textContent 赋值）');
  assert.equal(second.next.size, 2, '没写的节点同样要留在记忆表里，否则下一拍又会重写一遍');
});

test('D3：只有值真的变了的节点才写', () => {
  const a = node('a');
  const b = node('b');
  const first = planRelativeTimeUpdates([
    { node: a, ts: 5, visible: true },
    { node: b, ts: 7, visible: true },
  ], new Map(), format);

  const second = planRelativeTimeUpdates([
    { node: a, ts: 5, visible: true },
    { node: b, ts: 8, visible: true }, // 只有 b 的文案变了
  ], first.next, format);

  assert.deepEqual(second.writes, [{ node: b, text: '8 分钟前' }], '只写变化的那一个');
});

test('D3：不可见节点这一拍跳过，变可见之后补写一次（不会永久空着）', () => {
  const shown = node('shown');
  const hidden = node('hidden');
  const first = planRelativeTimeUpdates([
    { node: shown, ts: 5, visible: true },
    { node: hidden, ts: 9, visible: false },
  ], new Map(), format);
  assert.deepEqual(first.writes, [{ node: shown, text: '5 分钟前' }], '不可见节点不许写');
  assert.equal(first.hidden, 1);
  assert.equal(first.next.has(hidden), false, '不可见节点不进记忆表：下次可见时才会补写');

  const second = planRelativeTimeUpdates([
    { node: shown, ts: 5, visible: true },
    { node: hidden, ts: 9, visible: true }, // 用户滚回来了
  ], first.next, format);
  assert.deepEqual(second.writes, [{ node: hidden, text: '9 分钟前' }], '刚变可见的节点必须补写（值没变也要写）');
});

test('D3：5000 项任务稳定之后每拍零写入；从列表里移除的节点会离开记忆表', () => {
  const nodes = Array.from({ length: 5000 }, (_unused, index) => ({ node: node(`t${index}`), ts: 100 + index, visible: true }));
  const first = planRelativeTimeUpdates(nodes, new Map(), format);
  assert.equal(first.writes.length, 5000, '第一拍全量写一遍（此时必须写）');

  const second = planRelativeTimeUpdates(nodes, first.next, format);
  assert.equal(second.writes.length, 0, '5000 项稳定时每 30 s 应该是零 DOM 写入');

  // 任务被删掉 4000 项：记忆表跟着缩小，不会只增不减。
  const remaining = nodes.slice(0, 1000);
  const third = planRelativeTimeUpdates(remaining, second.next, format);
  assert.equal(third.next.size, 1000, '记忆表只保留这一拍还在的节点（否则长会话里会一直涨）');
  assert.equal(third.writes.length, 0, '剩下的 1000 项文案没变，仍然零写入');
});

test('D3：ts 非法 / 格式化抛错的节点被跳过，不拖垮整次刷新', () => {
  const good = node('good');
  const plan = planRelativeTimeUpdates([
    { node: good, ts: 5, visible: true },
    { node: node('bad'), ts: 0, visible: true },
    { node: node('nan'), ts: Number.NaN, visible: true },
    { node: null, ts: 5, visible: true },
  ], new Map(), format);
  assert.deepEqual(plan.writes, [{ node: good, text: '5 分钟前' }]);

  const boom = planRelativeTimeUpdates([
    { node: good, ts: 5, visible: true },
  ], new Map(), () => { throw new Error('format failed'); });
  assert.deepEqual(boom.writes, [], '格式化抛错只跳过这一项，绝不能把整批刷新打断');
});

test('isNodeVisible：隐藏/已摘下的节点不可见，fixed 元素与普通节点可见', () => {
  // display:none 的真实形状：offsetParent = null 且没有任何 client rect。
  assert.equal(isNodeVisible({ offsetParent: null, getClientRects: () => [] }), false);
  assert.equal(isNodeVisible({ offsetParent: null }), false, 'offsetParent=null 且拿不到 rects 时按不可见处理');
  // 普通节点
  assert.equal(isNodeVisible({ offsetParent: {}, getClientRects: () => [] }), true);
  // position: fixed 的元素 offsetParent 也是 null，但一定有 client rect：
  // 只看 offsetParent 会把固定定位的浮层误判成隐藏。
  assert.equal(isNodeVisible({ offsetParent: null, getClientRects: () => [{}] }), true);
  // 已经从文档里摘掉的节点：布局全零，不许写。
  assert.equal(isNodeVisible({ offsetParent: {}, isConnected: false }), false);
  // 没有这些属性的宿主（测试桩 / 极老环境）：按可见处理，宁可多写一次。
  assert.equal(isNodeVisible({}), true);
  assert.equal(isNodeVisible(null), false);
});

test('D3 源码门禁：app.js 的 30 s 刷新走纯函数，不再无条件写 textContent', async () => {
  const app = await read('web/app.js');
  assert.match(app, /from '\.\/lib\/ts-refresh\.js';/u, 'app.js 必须 import 抽出来的纯函数模块');
  assert.match(app, /planRelativeTimeUpdates\(/u, 'app.js 必须用 planRelativeTimeUpdates 算"要写哪些节点"');
  assert.match(app, /isNodeVisible\(/u, '取节点时必须判可见性');
  assert.doesNotMatch(
    app,
    /node\.textContent = relTime\(/u,
    '旧的无条件写法（对每个 [data-ts] 节点直接 textContent = relTime(...)）不许回来',
  );
  assert.match(app, /renderedTimestamps = plan\.next/u, '记忆表必须被这一拍的结果替换（否则不会淘汰消失的节点）');
});

test('D3：新模块必须在 web/sw.js 的 ASSETS 里（否则首次离线打开模块 404 白屏）', async () => {
  const sw = await read('web/sw.js');
  assert.ok(sw.includes("'./lib/ts-refresh.js'"), 'web/sw.js 的 ASSETS 必须包含 ./lib/ts-refresh.js');
});
