/**
 * D4：配对页两个定时器永不清除、不看 `document.hidden`，且每 4 s 把整张设备列表
 * `replaceChildren()` 重建一遍。
 *
 * 旧 `web/pair.js`：
 *   setInterval(refresh, 4000);
 *   setInterval(refreshRemote, 5000);
 *   ...renderDevices() 里 deviceList.replaceChildren() 然后全量重造。
 *
 * 页面放着不管 24 h = 21600 次 HTTP + 21600 次全量 DOM 重建，切后台照跑。
 *
 * 修法：纯逻辑（行模型 / 差异计划 / 轮询门）抽到本文件 import 的
 * `web/lib/pair-diff.js`；`web/pair.js` 只做 DOM 与定时器，并且：
 *  - 每拍都被 `shouldPoll` 门住（不可见/在途/已停用就跳过）；
 *  - 定时器全部登记、`pagehide` / `beforeunload` 一次清掉；
 *  - 设备行按 id 差异更新，文本比对后才写。
 *
 * 最后几条是**源码门禁**：这些行为没法在 Node 里跑真 DOM，但把它们改回去必须变红。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  deviceModel, deviceModels, planDeviceRows, sameDeviceModel, sameOrder, shouldPoll,
} from '../../web/lib/pair-diff.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFile(resolve(ROOT, relative), 'utf8');

/* ------------------------------------------------ 行模型 */

test('D4：行模型与旧渲染逐字一致（改成差异更新后界面一个像素都不变）', () => {
  assert.deepEqual(deviceModel({
    id: 'dev_1', platform: 'android', name: '我的手机', appVersion: '1.0.7', lastIp: '192.168.1.9',
  }), {
    id: 'dev_1', icon: '设', name: '我的手机', meta: 'android · v1.0.7 · 192.168.1.9', relay: false,
  });

  // 鸿蒙画「鸿」，其余画「设」
  assert.equal(deviceModel({ id: 'dev_h', platform: 'harmonyos', name: 'hm' }).icon, '鸿');

  // 中继不是手机：不显示版本号，标注「中继通道」。
  const relay = deviceModel({ id: 'relay', localRelay: true, name: '本机中继', platform: 'android', appVersion: '1.0.7', lastIp: '127.0.0.1' });
  assert.deepEqual(relay, {
    id: 'relay', icon: '设', name: '本机中继', meta: '中继通道 · 127.0.0.1', relay: true,
  });

  // 缺字段时的默认文案与旧代码一致。
  const bare = deviceModel({ id: 'dev_bare' });
  assert.equal(bare.name, '未命名设备');
  assert.equal(bare.meta, 'unknown · 未知地址');
});

test('D4：deviceModels 丢掉没有 id 的、去掉重复 id', () => {
  const models = deviceModels([
    { id: 'a', name: 'A' },
    { id: 'a', name: 'A2' }, // 重复 id：保留第一条
    { name: '没有 id' },
    null,
    { id: 'b', name: 'B' },
  ]);
  assert.deepEqual(models.map((model) => model.id), ['a', 'b'], '重复/无 id 的行必须去掉（否则会出现两行同一台设备）');
  assert.equal(models[0].name, 'A', '重复 id 保留第一条');
  assert.deepEqual(deviceModels(undefined), [], '非数组输入返回空列表，不许抛');
});

/* ------------------------------------------------ 差异计划 */

test('D4：第一轮全部新建；第二轮一模一样 → 零 create / 零 update / 零 remove', () => {
  const first = deviceModels([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const plan1 = planDeviceRows(new Map(), first);
  assert.deepEqual(plan1.create, ['a', 'b'], '首次渲染必须建两行');
  assert.deepEqual(plan1.update, []);
  assert.deepEqual(plan1.remove, []);
  assert.deepEqual(plan1.order, ['a', 'b']);

  // 第二轮拿到同样的设备（只是数组是新对象）：一个 DOM 操作都不该有。
  const second = deviceModels([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const plan2 = planDeviceRows(plan1.next, second);
  assert.deepEqual(plan2.create, [], '同样的设备不许重建行');
  assert.deepEqual(plan2.update, [], '同样的内容不许重写文本');
  assert.deepEqual(plan2.remove, []);
});

test('D4：文本/性质变了的进 update，消失的进 remove，顺序按服务端给的来', () => {
  const base = planDeviceRows(new Map(), deviceModels([
    { id: 'a', name: 'A', lastIp: '1.1.1.1' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]));

  const next = planDeviceRows(base.next, deviceModels([
    { id: 'c', name: 'C' },                                  // 顺序变了
    { id: 'a', name: 'A', lastIp: '2.2.2.2' },               // meta 变了
    { id: 'd', name: 'D' },                                  // 新增；b 消失
  ]));

  assert.deepEqual(next.update, ['a'], '只有 a 的内容变了');
  assert.deepEqual(next.create, ['d'], 'd 是新的');
  assert.deepEqual(next.remove, ['b'], 'b 消失了');
  assert.deepEqual(next.order, ['c', 'a', 'd'], '顺序就是服务端给的顺序');
  assert.equal(sameOrder(next.order, ['c', 'a', 'd']), true);
  assert.equal(sameOrder(next.order, ['a', 'c', 'd']), false, '顺序不同要能判出来（否则不会重排）');
  assert.equal(sameOrder(['a'], ['a', 'b']), false);
});

test('D4：sameDeviceModel 只比会被渲染的字段', () => {
  const model = { id: 'a', icon: '设', name: 'A', meta: 'm', relay: false };
  assert.equal(sameDeviceModel(model, { ...model, id: 'ignored' }), true, 'id 由外层的 Map 键比对，不参与内容比对');
  assert.equal(sameDeviceModel(model, { ...model, name: 'A2' }), false);
  assert.equal(sameDeviceModel(model, { ...model, relay: true }), false, '中继/手机的性质变了要重建右侧动作');
  assert.equal(sameDeviceModel(undefined, model), false);
});

/* ------------------------------------------------ 轮询门 */

test('D4：页面不可见 / 上一拍未回 / 已停用时这一拍直接跳过（后台不再打 HTTP）', () => {
  assert.equal(shouldPoll({ hidden: false, busy: false }), true, '可见且空闲：正常刷新');
  assert.equal(shouldPoll({ hidden: true }), false, 'document.hidden → 不刷新（24 h 21600 次的根源）');
  assert.equal(shouldPoll({ hidden: false, busy: true }), false, '上一拍还没回来 → 不叠并发请求');
  assert.equal(shouldPoll({ hidden: false, stopped: true }), false, '已停用（例如 403）→ 不再撞墙');
  assert.equal(shouldPoll({ visibility: 'hidden' }), false);
  assert.equal(shouldPoll({ visibility: 'prerender' }), false);
  assert.equal(shouldPoll({ visibility: 'visible' }), true);
});

/* ------------------------------------------------ 源码门禁 */

test('D4 源码门禁：pair.js 不再整表重建，改用差异更新', async () => {
  const pair = await read('web/pair.js');
  assert.doesNotMatch(
    pair,
    /deviceList\.replaceChildren\(/u,
    '每 4 s 把整张设备列表 replaceChildren() 重建一遍是 D4 的主症状，不许回来',
  );
  assert.match(pair, /planDeviceRows\(/u, '设备列表必须走纯函数算出的差异计划');
  assert.match(pair, /deviceModels\(/u);
  assert.match(pair, /updateRow\(/u, '行内容要按比对结果增量更新');
  assert.match(
    pair,
    /adoptServerRows\(\)/u,
    '服务端已经渲染了一份初始列表：第一轮差异更新前必须摘掉它（否则界面出现两套设备行）',
  );
});

test('D4 源码门禁：定时器全部登记且可清理，并有 hidden 门', async () => {
  const pair = await read('web/pair.js');
  // 只看会被执行的代码行：注释里提到 setInterval 不算"又加了一个定时器"。
  const codeLines = pair.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
  const intervalLines = codeLines.filter((line) => line.includes('setInterval('));
  assert.equal(intervalLines.length, 2, `配对页只能有两个轮询定时器，实际 ${intervalLines.length}`);
  for (const line of intervalLines) {
    assert.match(
      line,
      /timers\.push\(setInterval\(/u,
      `定时器必须登记进 timers 数组，否则 pagehide 时清不掉：${line.trim()}`,
    );
    assert.match(line, /allowPoll\(/u, `每拍都要过 shouldPoll 门（不可见/在途/停用即跳过）：${line.trim()}`);
  }
  assert.match(pair, /window\.addEventListener\('pagehide', stopTimers\)/u, 'pagehide 必须清理定时器');
  assert.match(pair, /window\.addEventListener\('beforeunload', stopTimers\)/u, 'beforeunload 兜底清理定时器');
  assert.match(pair, /function stopTimers\(\)/u);
  assert.match(pair, /clearInterval\(timer\)/u, 'stopTimers 必须真的 clearInterval');
  assert.match(pair, /pure\.shouldPoll\(/u, 'hidden/在途门的判据必须来自纯函数模块（Node 单测覆盖）');
});

test('D4 源码门禁：配对页用动态 import 取纯逻辑模块（经典脚本不能静态 import）', async () => {
  const pair = await read('web/pair.js');
  assert.match(
    pair,
    /import\('\/app\/lib\/pair-diff\.js'\)/u,
    '配对页是 <script defer> 经典脚本，只能动态 import 同源模块；路径必须与 /app 静态路由一致',
  );
});

test('D4：新模块必须在 web/sw.js 的 ASSETS 里（否则首次离线打开模块 404 白屏）', async () => {
  const sw = await read('web/sw.js');
  assert.ok(sw.includes("'./lib/pair-diff.js'"), 'web/sw.js 的 ASSETS 必须包含 ./lib/pair-diff.js');
});
