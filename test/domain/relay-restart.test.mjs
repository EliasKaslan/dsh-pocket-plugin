/**
 * 手机端中继"推倒重建"能力的守卫。
 *
 * 事故：手机显示「连不上电脑，请检查网络与插件状态」。实测链路探针（冒充手机连
 * 同一个房间）证明 broker、房间、加密、上下行全部健康 —— 问题在手机自己的 MQTT
 * 客户端：浏览器里 mqtt.js 遇到 WebSocket 半死（既不 close 也不 error）时，
 * 内部每 3 秒的自动重连**永远不会触发**，请求全部石沉大海。
 *
 * 而原来的 `startStaleWatch()` 只会把横幅改成"正在重连…"，**不做任何重连动作**，
 * 所以「重连」按钮与等待都无效。这里钉住四条修复。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

test('中继外壳：有 restart()，会真正丢掉旧客户端再连', () => {
  const source = read('remote/remote.js');
  assert.match(source, /async restart\(reason = ''\)/u, '必须能重建中继连接');
  assert.match(source, /previous\?\.end\?\.\(true\)/u, '必须把旧客户端强制关掉（半死的连接不会自己退场）');
  assert.match(source, /if \(this\.restarting === true\) return false;/u, '必须互斥，否则会同时开两条连接');
  assert.match(source, /this\.restartCount = 0;/u, '重建成功要清零计数');
});

test('下行静默看门狗：以前只改横幅，现在必须真的重建', () => {
  const source = read('remote/remote.js');
  assert.match(source, /void this\.restart\('下行静默'\)/u, '静默超时必须触发重建');
  assert.match(source, /RESTART_COOLDOWN_MS/u, '必须有冷却，避免抖动时狂重建');
  // 以前 pcSeenAt===0 直接 return，等于"连上了却一帧没收到"永远不重建
  assert.ok(!/if \(this\.pcSeenAt === 0\) return;/u.test(source), '不许再因为"从未收到下行"而跳过看门狗');
  assert.match(source, /Math\.max\(this\.pcSeenAt, this\.stats\.lastRxAt, this\.readyAt, this\.lastWakeAt\)/u,
    '静默判定要带上 lastRxAt/readyAt/lastWakeAt —— 少了 lastWakeAt，息屏或长时间后台回来那一刻会拿冻结前的时钟算静默，误判「电脑端已离线」');
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

/**
 * 首连自伤：`connectOne` 成功时只置 `ready = true`，不写 `readyAt`，
 * 于是 `idle = Date.now() - Math.max(pcSeenAt, lastRxAt, readyAt)` 里的 0 成了下界 ——
 * 首帧到达前 idle 恒等于「现在」，健康链路在 2 秒后必判 stale，被自己推倒重建
 * （实测 85 s 内建了 4 条隧道、slots 1→4）。
 */
test('握手超时必须长于它依赖的 RPC 预算（9 s 会变成 9 秒一问的重连环）', async () => {
  const fs = await import('node:fs/promises');
  const read = (rel) => fs.readFile(new URL(rel, import.meta.url), 'utf8');
  const pick = (source, name) => {
    const hit = new RegExp(`const ${name} = ([\\d_]+);`, 'u').exec(source);
    return hit === null ? Number.NaN : Number(hit[1].replaceAll('_', ''));
  };

  const net = await read('../../web/lib/net.js');
  const remote = await read('../../remote/remote.js');
  const connect = pick(net, 'CONNECT_TIMEOUT');
  const rpc = pick(remote, 'RPC_TIMEOUT_MS');

  assert.ok(Number.isFinite(connect) && Number.isFinite(rpc), '两个常量都要能解析出来');
  assert.ok(connect > rpc,
    `App 握手超时 ${connect}ms 必须大于单次 RPC 预算 ${rpc}ms —— 否则 ack 略慢就自断，`
    + `形成"每 ${connect / 1000} 秒重建一次隧道"的重连环`);
});

test('首连不许被自己的看门狗推倒重建：ready 那一刻就要写 readyAt / downSince', () => {
  const source = read('remote/remote.js');
  // 这条链路没有可分片的可加载入口（remote.js 是浏览器 ESM，顶部就是启动流程），
  // 所以沿用本文件既有的做法：结构断言。它钉的是「赋值点必须紧跟在 ready=true 之后」。
  assert.match(source, /this\.ready = true;[\s\S]{0,400}?this\.readyAt = Date\.now\(\);[\s\S]{0,120}?this\.downSince = 0;/u,
    'ready 置真时必须同时写上本次建链时刻，否则首帧到达前必判 stale');
  const writes = source.match(/this\.readyAt = Date\.now\(\);/gu) ?? [];
  assert.ok(writes.length >= 2, `connectOne 与 restart 两条成功路径都要写 readyAt（实际 ${writes.length} 处）`);
});

/**
 * 孤儿槽位：`close()` 会发 `ws.close`，但 `_close()` 不发 —— open timeout /
 * open failed / failAll / 电脑端主动关 这四条路都只删本地表，电脑端那条隧道
 * 没人认领，12 个槽位满了就是 `too many channels`（手机侧表现为「重连要很久」）。
 */
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
  const read = (rel) => fs.readFile(new URL(rel, import.meta.url), 'utf8');
  // 必须断言**构建真正使用的**源：web/sw.js 在 build-shell 的 WEB_SKIP 里，
  // 断在它身上得到的"通过"是假绿（真机仍旧 cache-first，已实际踩过一次）。
  const sw = await read('../../remote/sw.js');
  const app = await read('../../web/app.js');

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
  assert.ok(!/networkFirst\(/.test(shellBlock), '壳资源不该走 network-first（会让手机变慢）');
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

test('隧道埋点：关闭无条件记录，拒绝带路径，open 带存活时长', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../../lib/cloud.mjs', import.meta.url), 'utf8');
  const { readFileSync } = await import('node:fs');
  assert.match(src, /ws close[^\n]*known=\$/u, '关闭日志必须无条件记录（含 known 状态）');
  // replacedAge 已移除：它量的是「另一条仍在活的隧道」，不是被替换者的存活时长，属误导性埋点。\n  assert.match(src, /ws open[^\n]*psid=/u, 'open 日志必须带 psid');
  assert.match(src, /relay target refused code=[^\n]*path=/u, '拒绝日志必须带路径');
  void readFileSync;
});
