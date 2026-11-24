/**
 * 连接层重试策略的行为测试（A2 / A3 / A7）。
 *
 * 这三个缺陷的共同点：**一次失败就再也不回来**。
 *   - A2 首次 `relay.connect()` 失败即 `showFatal` + `return`，唯一的按钮是
 *     `location.reload()`，而刷新回到的还是同一张死页；
 *   - A3 控制帧只发一次，8 秒无应答 → 整屏「未能确认登录状态」；
 *   - A7 回到前台先把 `lastWakeAt` 设成"现在"，静默永远判不出来，
 *     再叠上 20 秒 `justRestarted` 窗口，iOS 上"回到前台上不动"最长 ~40 秒。
 *
 * 断的是**次数、间隔、上限、回调看到什么**，所以这里直接跑 `connectWithRetry()`
 * 与 `wakeDecision()`，注入 `sleep` 把时间拿掉 —— 不是对源码做正则。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONNECT_RETRY_DELAYS,
  CONTROL_RESEND_DELAYS,
  HEARTBEAT_MS,
  WAKE_SILENT_MS,
  connectRetryDelay,
  connectWithRetry,
  wakeDecision,
} from '../../web/lib/shell-retry.js';

/* ---------------------------------- A2 ---------------------------------- */

test('A2：退避序列是 1/2/4/8 秒，4 次重试（总共 5 次尝试）', () => {
  assert.deepEqual(CONNECT_RETRY_DELAYS, [1_000, 2_000, 4_000, 8_000]);
  assert.equal(connectRetryDelay(1), 1_000);
  assert.equal(connectRetryDelay(4), 8_000);
  // 没有第 5 次了：调用方据此判断"要不要继续等"
  assert.equal(connectRetryDelay(5), null);
  assert.equal(connectRetryDelay(0), null);
  assert.equal(connectRetryDelay(Number.NaN), null);
});

test('A2：前三次失败后成功 → 一共 5 次里只做到第 4 次就停，sleep 是 1/2/4 秒', async () => {
  const attempts = [];
  const sleeps = [];
  const outcome = await connectWithRetry({
    connect: async (attempt) => {
      attempts.push(attempt);
      if (attempt < 4) throw new Error(`第 ${attempt} 次失败`);
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 4);
  assert.deepEqual(attempts, [1, 2, 3, 4]);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000], '成功之后不许再等');
  assert.equal(outcome.lastError, undefined);
});

test('A2：连续失败到上限才认输，最后一次 onRetry 的 delay 是 null（界面据此显示最终原因）', async () => {
  const seen = [];
  const sleeps = [];
  const outcome = await connectWithRetry({
    connect: async () => { throw new Error('连接超时'); },
    sleep: async (ms) => { sleeps.push(ms); },
    onRetry: ({ attempt, delay, error }) => seen.push({ attempt, delay, message: error.message }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 5, '1 次首发 + 4 次重试');
  assert.deepEqual(seen.map((item) => item.delay), [1_000, 2_000, 4_000, 8_000, null]);
  assert.deepEqual(seen.map((item) => item.attempt), [1, 2, 3, 4, 5]);
  assert.equal(sleeps.length, 4, '最后一次失败后不该再睡');
  assert.equal(outcome.lastError.message, '连接超时');
});

test('A2：onRetry 自己抛异常不许打断重试（界面回调不是主流程）', async () => {
  let calls = 0;
  const outcome = await connectWithRetry({
    connect: async () => { calls += 1; if (calls < 3) throw new Error('再试'); },
    sleep: async () => {},
    onRetry: () => { throw new Error('界面炸了'); },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 3);
});

/* ---------------------------------- A3 ---------------------------------- */

test('A3：控制帧重发窗口必须落在 checkAuth 的 8 秒预算之内', () => {
  // 3 次发送（首发 + 2 次重发）一共用掉这么久；超过 8 s 就等于"重发等于没发"，
  // 因为 checkAuth 早已经 fallback 成 unavailable 了。
  const span = CONTROL_RESEND_DELAYS.reduce((sum, ms) => sum + ms, 0);
  assert.deepEqual(CONTROL_RESEND_DELAYS, [1_500, 3_500]);
  assert.ok(span < 8_000, `重发总时长 ${span} ms 必须小于 checkAuth 的 8 s 预算`);
  assert.ok(CONTROL_RESEND_DELAYS.length >= 2, '至少要有两次重发，单发一次就是 1.0.2 的病');
});

/* ---------------------------------- A7 ---------------------------------- */

test('A7：心跳 8 秒，判死门槛是两个心跳周期（16 秒）', () => {
  assert.equal(HEARTBEAT_MS, 8_000);
  assert.equal(WAKE_SILENT_MS, 16_000);
});

test('A7：ready 但两个心跳周期没有下行 → 立刻重建（与 justRestarted 窗口无关）', () => {
  const now = 1_700_000_000_000;
  assert.equal(
    wakeDecision({ ready: true, now, lastRxAt: now - WAKE_SILENT_MS }),
    'restart-silent',
    '静默满 2 个心跳周期就必须重建，不能等 26 秒看门狗 + 15 秒冷却',
  );
  assert.equal(wakeDecision({ ready: true, now, lastRxAt: now - WAKE_SILENT_MS - 5_000 }), 'restart-silent');
  // 差 1 毫秒还没到门槛：不乱重建（抖动期拆链路更糟）
  assert.equal(wakeDecision({ ready: true, now, lastRxAt: now - WAKE_SILENT_MS + 1 }), 'none');
  // 边沿：刚 ready、还没收到第一帧时不能判静默
  assert.equal(wakeDecision({ ready: true, now, readyAt: now - 500, lastRxAt: 0 }), 'none');
  // 最近一次下行 / 电脑心跳 / ready 里任何一个新鲜就算活着
  assert.equal(
    wakeDecision({ ready: true, now, lastRxAt: now - 90_000, pcSeenAt: now - 1_000, readyAt: now - 90_000 }),
    'none',
  );
});

test('A7：没连上 → 交给调用方按原窗口决定；正在重建 → 什么都不做', () => {
  const now = 1_700_000_000_000;
  assert.equal(wakeDecision({ ready: false, now, lastRxAt: 0 }), 'restart-down');
  assert.equal(
    wakeDecision({ ready: true, now, lastRxAt: 0, restarting: true }),
    'none',
    '重建已经在进行时再拆一次会把刚建好的隧道顶掉',
  );
});
