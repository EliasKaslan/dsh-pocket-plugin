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
  assert.match(source, /Math\.max\(this\.pcSeenAt, this\.stats\.lastRxAt, this\.readyAt\)/u,
    '静默判定要带上 lastRxAt/readyAt');
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
