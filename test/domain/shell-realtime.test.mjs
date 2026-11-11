/**
 * 实时通道的"永久卡死"回归守卫。
 *
 * 事故：2026-11-11 一次插件热重载让桌面端短暂离线（日志 `publish failed:
 * Connection closed`），手机端连续失败两次后按原逻辑**退回 SSE**。而中继通道
 * 承载不了 SSE 长连接流 —— 于是一旦回退，实时通道永久死亡：界面永远"正在重连"，
 * 点「重连」也没反应（`kick()` 在 connecting 状态直接 return，且没有连接超时）。
 *
 * 这里钉住三条：
 *   1. 中继外壳里**不允许**退回 SSE；
 *   2. 每次连接有硬超时，状态不会永远停在 connecting；
 *   3. `kick(true)` 能强制打断卡死的连接（用户点「重连」必须真的有用）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

test('net.js：中继模式不退回 SSE，且连接有硬超时', () => {
  const source = read('web/lib/net.js');

  assert.match(source, /allowSse = true/u, '构造参数要有 allowSse');
  assert.match(source, /this\.allowSse = allowSse !== false/u);
  // 关键：SSE 回退必须受 allowSse 约束
  assert.match(source, /if \(this\.allowSse && this\.failures >= 2\) \{/u,
    'SSE 回退必须被 allowSse 挡住（中继外壳里它一定拿不到流）');

  assert.match(source, /const CONNECT_TIMEOUT = \d[\d_]*;/u, '必须有连接超时常量');
  // 超时到点要主动放弃这次尝试并计入失败
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]{0,400}?this\.failures \+= 1;[\s\S]{0,200}?this\.scheduleReconnect\(\);/u,
    '超时后必须计一次失败并安排重连');
  // onopen 与 onclose 都要清掉超时定时器，避免"连上了还被判失败"
  const clears = [...source.matchAll(/clearTimeout\(this\.connectTimer\)/gu)].length;
  assert.ok(clears >= 3, `connectTimer 至少要在 teardown/onopen/onclose 三处清理，实际 ${clears} 处`);
});

test('net.js：kick(true) 能打断 connecting，kick() 默认不打断', () => {
  const source = read('web/lib/net.js');
  assert.match(source, /kick\(force = false\)/u, 'kick 要接受 force 参数');
  assert.match(source, /if \(this\.state === 'connecting' && !force\) return;/u,
    '默认仍跳过 connecting，但 force 时必须继续');
  assert.match(source, /if \(this\.state === 'online'\) return;/u, 'online 时永远不重连（避免打断正常通道）');
});

test('外壳：中继模式显式关闭 SSE，且「重连」处处走强制路径', () => {
  const app = read('web/app.js');
  assert.match(app, /allowSse: !isRelayShell\(\)/u, '中继外壳必须关掉 SSE 回退');

  const forced = [...app.matchAll(/kick\(true\)/gu)].length;
  assert.ok(forced >= 2, `用户可见的重连入口都要 force（实际 ${forced} 处）`);
  // 顶栏「重连」按钮与 ctx.reconnect 都要强制
  assert.match(app, /click: \(\) => \{[\s\S]{0,200}?kick\(true\)/u, '顶栏按钮要强制重连');
  assert.match(app, /reconnect\(\) \{\s*\n\s*realtime\?\.kick\(true\);/u, 'ctx.reconnect 要强制重连');
});

test('桌面端：ws.open 的拒绝路径都要留日志（否则现场不可观测）', () => {
  const cloud = read('lib/cloud.mjs');
  for (const needle of ['ws.open 被拒（未授权）', 'ws.open 被拒（路径不合法）', 'ws.open 被拒（槽位已满）', 'ws 隧道出错']) {
    assert.ok(cloud.includes(needle), `缺少日志：${needle}`);
  }
});
