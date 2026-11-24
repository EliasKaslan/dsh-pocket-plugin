/**
 * 手机端中继"推倒重建"能力的守卫。
 *
 * 事故：手机显示「连不上电脑，请检查网络与插件状态」。实测链路探针（冒充手机连
 * 同一个房间）证明 broker、房间、加密、上下行全部健康 —— 问题在手机自己的 MQTT
 * 客户端：浏览器里 mqtt.js 遇到 WebSocket 半死（既不 close 也不 error）时，
 * 内部每 3 秒的自动重连**永远不会触发**，请求全部石沉大海。
 *
 * 而原来的 `startStaleWatch()` 只会把横幅改成"正在重连…"，**不做任何重连动作**，
 * 所以「重连」按钮与等待都无效。
 *
 * 最值钱的两条（下行静默看门狗、首连自伤）以前是"对源码做正则"：把
 * `Math.max(...)` 改成 `Math.min(...)`、把 `> PC_STALE_MS` 改成 `>= 0`，正则照样绿。
 * 现在改成**真跑** `remote/remote.js` 里切出来的 `startStaleWatch()` / `noteRelayOk()`
 * （vm 沙箱 + 假时钟 + 假 setInterval，见 `test/support/shell-source.mjs`），
 * 断言的是"什么条件下会重建、带什么原因、冷却期内会不会重复建"。
 * 其余几条只做结构断言的部分都在注释里写清了为什么没法切片。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  readRepoFile, runSlices, sliceConst, sliceMethod,
} from '../support/shell-source.mjs';

const repo = path.join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

/**
 * 把 `startStaleWatch()` 真跑起来：假 `setInterval` 只记回调，假时钟由用例推进。
 * @param {number} startAt 假时钟起点（ms）
 */
function staleWatch(startAt) {
  const remote = readRepoFile('remote/remote.js');
  let now = startAt;
  const intervals = [];
  const api = runSlices({
    declarations: [
      { name: 'RESTART_COOLDOWN_MS', source: sliceConst(remote, 'RESTART_COOLDOWN_MS') },
      { name: 'PC_STALE_MS', source: sliceConst(remote, 'PC_STALE_MS') },
      { name: 'setInterval', source: 'const setInterval = globalThis.__setInterval;' },
      { name: 'startStaleWatch', source: sliceMethod(remote, 'startStaleWatch') },
    ],
    globals: {
      __setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    },
    clock: () => now,
  });
  return {
    ...api,
    intervals,
    /** 造一个"刚建好、一帧都还没收到"的中继实例。 */
    relay(overrides = {}) {
      const restarts = [];
      const staleEvents = [];
      const instance = {
        staleTimer: undefined,
        ready: true,
        pcSeenAt: 0,
        readyAt: now,
        lastWakeAt: 0,
        lastRestartAt: 0,
        pcStale: false,
        stats: { lastRxAt: now },
        restart: (reason = '') => { restarts.push(reason); instance.lastRestartAt = now; },
        onpcStale: (stale, text) => { staleEvents.push({ stale, text }); },
        ...overrides,
      };
      return { instance, restarts, staleEvents };
    },
    advance(ms) { now += ms; return now; },
    clockNow() { return now; },
    /** 手工触发一次巡检（真实现是 2 s 一次的 setInterval）。 */
    tick(instance) {
      assert.equal(intervals.length, 1, '看门狗必须只注册一个间隔');
      intervals[0].fn.call(instance);
    },
  };
}

test('下行静默看门狗（行为）：真跑 startStaleWatch() —— 静默超阈值才重建，冷却期内不重复建', () => {
  const watch = staleWatch(1_000_000);
  const online = watch.relay({});
  const { instance, restarts, staleEvents } = online;
  watch.startStaleWatch.call(instance);
  assert.equal(watch.intervals.length, 1, '看门狗必须只注册一个间隔');
  assert.equal(watch.intervals[0].ms, 2_000, '巡检周期必须是 2 s（手机端功耗与发现速度的折中）');

  // ① 首连自伤回归：`pcSeenAt === 0`（一帧都还没收到）但刚 ready —— 健康链路，不许自断。
  //    旧代码正是在这里把 `Date.now()` 当 idle 起点，2 s 后必判 stale、把自己推倒重建。
  watch.tick(instance);
  assert.deepEqual(restarts, [], '刚 ready 且 readyAt 是此刻时不许重建（首连自伤）');
  assert.deepEqual(staleEvents, [], '健康链路不许报 stale');

  // ② 静默超过 PC_STALE_MS（26 s）：必须真的重建，原因写「下行静默」，并把 stale 推给界面。
  watch.advance(watch.PC_STALE_MS + 1_000);
  watch.tick(instance);
  assert.deepEqual(restarts, ['下行静默'], '静默够久必须重建底层连接（只改横幅等于没修）');
  assert.equal(staleEvents.length, 1);
  assert.equal(staleEvents[0].stale, true, '界面要收到 stale=true（横幅「电脑端已离线 N 秒」）');
  assert.match(String(staleEvents[0].text), /电脑端已离线 \d+ 秒/u, '横幅文案要带秒数');

  // ③ 冷却期内不许反复重建（抖动时狂重建会把刚恢复的链路再打趴）。
  watch.advance(100);
  watch.tick(instance);
  assert.deepEqual(restarts, ['下行静默'], 'RESTART_COOLDOWN_MS 内不许再重建');

  // ④ 冷却过去之后才允许下一次重建。
  watch.advance(watch.RESTART_COOLDOWN_MS + 1);
  watch.tick(instance);
  assert.deepEqual(restarts, ['下行静默', '下行静默'], '冷却结束后仍静默 → 再重建一次');

  // ⑤ 未就绪（ready=false）走另一条兜底：冷却过了就重建，原因是「未就绪兜底」。
  //    注意：回调是箭头函数，`this` 在 `startStaleWatch()` 被调用的那一刻就绑定死了
  //    （真实现就是 `setInterval(() => ...)`），所以这里必须换一套「实例 + 看门狗」。
  const offlineWatch = staleWatch(watch.clockNow());
  const offline = offlineWatch.relay({ ready: false, lastRestartAt: 0 });
  offlineWatch.startStaleWatch.call(offline.instance);
  offlineWatch.advance(offlineWatch.RESTART_COOLDOWN_MS + 1);
  offlineWatch.tick(offline.instance);
  assert.deepEqual(offline.restarts, ['未就绪兜底'], 'ready=false 且过了冷却 → 必须兜底重建（否则重试链断在原地）');
});

test('首连/重建两条成功路径都要写 readyAt 与 downSince（只能结构断言）', () => {
  const source = read('remote/remote.js');
  // 这两处在 `connectOne()` / `restart()` 内部 —— 它们要真的建 MQTT 连接，切不出可执行入口，
  // 所以只能钉"赋值点紧跟 ready=true"。行为侧的核心（首连不被看门狗自断）已由上面的
  // startStaleWatch 用例真跑覆盖。
  assert.match(source, /this\.ready = true;[\s\S]{0,400}?this\.readyAt = Date\.now\(\);[\s\S]{0,120}?this\.downSince = 0;/u,
    'ready 置真时必须同时写上本次建链时刻，否则首帧到达前必判 stale');
  const writes = source.match(/this\.readyAt = Date\.now\(\);/gu) ?? [];
  assert.ok(writes.length >= 2, `connectOne 与 restart 两条成功路径都要写 readyAt（实际 ${writes.length} 处）`);
});

test('noteRelayOk（行为）：成功把连续失败清零、记下最后成功，但保留上次断因', () => {
  const remote = readRepoFile('remote/remote.js');
  let now = 2_000_000;
  const api = runSlices({
    declarations: [{ name: 'noteRelayOk', source: sliceMethod(remote, 'noteRelayOk') }],
    clock: () => now,
  });
  const instance = { lastOkAt: 0, failureStreak: 3, lastFailure: { code: 'ECONNRESET', message: '' } };
  api.noteRelayOk.call(instance);
  assert.equal(instance.lastOkAt, now, '最后成功时刻必须更新（诊断里显示「最后成功」）');
  assert.equal(instance.failureStreak, 0, '成功必须把连续失败清零');
  assert.deepEqual(JSON.parse(JSON.stringify(instance.lastFailure)), { code: 'ECONNRESET', message: '' },
    '故意不清 lastFailure：断过之后再连上，「上次为什么断」仍然是最有用的线索');
});

test('中继外壳：有 restart()，会真正丢掉旧客户端再连', () => {
  const source = read('remote/remote.js');
  assert.match(source, /async restart\(reason = ''\)/u, '必须能重建中继连接');
  assert.match(source, /previous\?\.end\?\.\(true\)/u, '必须把旧客户端强制关掉（半死的连接不会自己退场）');
  assert.match(source, /if \(this\.restarting === true\) return false;/u, '必须互斥，否则会同时开两条连接');
  assert.match(source, /this\.restartCount = 0;/u, '重建成功要清零计数');
});

test('回到前台与用户点重连都能触发重建', () => {
  const shell = read('remote/remote.js');
  assert.match(shell, /globalThis\.__POCKET_RELAY_RESTART__ = /u, '必须把重建能力暴露给内层外壳');
  assert.match(shell, /document\.addEventListener\('visibilitychange'/u, '手机回到前台要检查链路');
  assert.match(shell, /relay\.onhardreset = \(\) => \{ location\.reload\(\); \}/u, '实在救不回来要能刷新兜底');

  const net = read('web/lib/net.js');
  assert.match(net, /__POCKET_RELAY_RESTART__\?\.\('用户点重连'\)/u,
    '「重连」必须连底层中继一起重建，否则点了没用');
});

test('硬兜底有最小间隔，不会刷新风暴', () => {
  const source = read('remote/remote.js');
  assert.match(source, /HARD_RESET_AFTER = 3/u);
  assert.match(source, /HARD_RESET_MIN_GAP_MS = 120_000/u);
  assert.match(source, /sessionStorage\?\.setItem\(key, String\(Date\.now\(\)\)\)/u, '要记录上次兜底时间');
});

test('握手超时必须长于它依赖的 RPC 预算（9 s 会变成 9 秒一问的重连环）', async () => {
  const pick = (source, name) => {
    const hit = new RegExp(`const ${name} = ([\\d_]+);`, 'u').exec(source);
    return hit === null ? Number.NaN : Number(hit[1].replaceAll('_', ''));
  };

  const net = read('web/lib/net.js');
  const remote = read('remote/remote.js');
  const connect = pick(net, 'CONNECT_TIMEOUT');
  const rpc = pick(remote, 'RPC_TIMEOUT_MS');

  assert.ok(Number.isFinite(connect) && Number.isFinite(rpc), '两个常量都要能解析出来');
  assert.ok(connect > rpc,
    `App 握手超时 ${connect}ms 必须大于单次 RPC 预算 ${rpc}ms —— 否则 ack 略慢就自断，`
    + `形成"每 ${connect / 1000} 秒重建一次隧道"的重连环`);
});

test('_close() 也要通知电脑端关隧道（否则留下没人认领的孤儿槽位）', () => {
  const source = read('remote/remote.js');
  assert.match(source, /void relay\.closeSocket\(this\.id\);/u, '_close 里必须尽力发一条 ws.close');
  assert.match(source, /const asked = this\.readyState >= PocketWebSocket\.CLOSING;/u,
    'close() 已经发过的那条不要重复发，否则每次退页面都多一帧上行');
  // closeSocket 必须在 sockets.delete 之前发，否则极端时序下没人再关它。
  const closeBody = source.slice(source.indexOf('_close(code = 1000'), source.indexOf('_emit(\'close\''));
  assert.ok(closeBody.indexOf('relay.closeSocket') < closeBody.indexOf('relay.sockets.delete'),
    'ws.close 必须先于本地删除（时序保守）');
});

test('外壳更新：壳资源与导航必须 network-first，且新 SW 接管后自动刷新', async () => {
  const fs = await import('node:fs/promises');
  const readUrl = (rel) => fs.readFile(new URL(rel, import.meta.url), 'utf8');
  // 必须断言**构建真正使用的**源：web/sw.js 在 build-shell 的 WEB_SKIP 里，
  // 断在它身上得到的"通过"是假绿（真机仍旧 cache-first，已实际踩过一次）。
  const sw = await readUrl('../../remote/sw.js');
  const app = await readUrl('../../web/app.js');

  // helper 内部：fetch 必须出现在回退缓存之前。
  const helperAt = sw.indexOf('async function networkFirst');
  assert.ok(helperAt > 0, '缺少 networkFirst helper');
  const helper = sw.slice(helperAt, helperAt + 700);
  const fetchPos = helper.indexOf('await fetch(request');  // 允许带 options（no-store）
  const cachePos = helper.indexOf('caches.match(key)');
  assert.ok(fetchPos > 0, 'helper 必须先 fetch');
  assert.ok(cachePos > fetchPos, '缓存回退必须发生在网络失败之后');

  // 两个入口都必须走它：壳资源与导航。
  // 壳资源必须**不是** network-first：几十个资产逐个走网络会让手机明显变慢。
  const shellAt = sw.indexOf('SHELL_URLS.has(canonical)');
  const shellBlock = shellAt < 0 ? '' : sw.slice(shellAt, shellAt + 700);
  assert.ok(shellAt > 0, '缺少壳资源分支');
  assert.equal(/networkFirst\(/u.test(shellBlock), false, '壳资源不该走 network-first（会让手机变慢）');
  assert.match(shellBlock, /caches\.match\(canonical\)/u, '壳资源应缓存优先');
  assert.match(sw, /mode === 'navigate'[\s\S]{0,160}?networkFirst\(/u, '导航必须 network-first');

  // 新 SW 接管后自动刷新，且排除首次安装。
  assert.match(app, /addEventListener\('controllerchange'/u, '缺少 controllerchange 自动刷新');
  assert.match(app, /hadController/u, '缺少首次安装保护');
  assert.match(app, /registration\.update\(\)/u, '缺少主动更新检查');
  // 普通刷新拿不到新壳的两个真实原因，各钉一条断言。
  assert.match(sw, /fetch\(request, \{ cache: 'no-store' \}\)/u, '导航必须绕过 HTTP 缓存');
  assert.match(app, /hardRefreshShell/u, 'banner 必须有硬刷新动作');
  assert.match(app, /unregister\(\)/u, '硬刷新必须注销 SW');
  assert.match(app, /caches\.delete\(name\)/u, '硬刷新必须清壳缓存');
});

test('隧道埋点：关闭无条件记录，拒绝带路径，open 带存活时长', () => {
  const src = read('lib/cloud.mjs');
  assert.match(src, /ws close[^\n]*known=\$/u, '关闭日志必须无条件记录（含 known 状态）');
  // replacedAge 已移除：它量的是「另一条仍在活的隧道」，不是被替换者的存活时长，属误导性埋点。
  assert.match(src, /ws open[^\n]*psid=/u, 'open 日志必须带 psid');
  assert.match(src, /relay target refused code=[^\n]*path=/u, '拒绝日志必须带路径');
});
