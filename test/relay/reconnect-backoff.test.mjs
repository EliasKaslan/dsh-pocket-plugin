/**
 * 重连退避（R4）—— `lib/cloud.mjs` 的 `retryDelay` / `noteLinkUp` / `scheduleRetry`。
 *
 * 旧实现有两处一起坏掉：
 *  1. 退避只有两档：`failures === 0` 走 400–550 ms，其余一律固定 `RETRY_MS`（2500 ms），
 *     **不随失败次数增长**；
 *  2. `client.on('connect')` 里第一件事就是 `this.stats.failures = 0`。
 *
 * 而 broker 接受 CONNECT、紧接着又把连接关掉时，`connect` 事件照样会触发 —— 于是
 * 计数永远归零、退避永远停在慢档起点，等于**永久 ~2 次/秒的重连风暴**：公共 broker
 * 上会被限流，宿主 CPU 与日志一起抖。
 *
 * 现在的规则：只有**稳定存活** ≥ `STABLE_LINK_MS`（10 s）的连接才把连续失败计数
 * 归零；否则逐次累计，`delay = min(RETRY_MS * 2^(n-1), RETRY_MAX_MS=60 s)`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RETRY_MAX_MS, STABLE_LINK_MS } from '../../lib/cloud.mjs';
import { makeLink } from './_support/fixtures.mjs';

/** 临时接管 setTimeout/clearTimeout：只记录，不真等（退避是 60 s 级的）。 */
function captureTimers(run) {
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay) => {
    const handle = { fn, delay, unref() {} };
    timers.push(handle);
    return handle;
  };
  globalThis.clearTimeout = () => {};
  try {
    run(timers);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return timers;
}

test('连续快速失败：退避逐次翻倍且单调不减', () => {
  const { link } = makeLink();
  const series = [];
  for (let failures = 0; failures <= 12; failures += 1) series.push(link.retryDelay(failures));

  // 第 0 次（第一次断线 / 插件重载）必须快：电脑端 ~4 s 就回来。
  assert.ok(series[0] >= 400, `首次退避不该比 400ms 还急（实际 ${series[0]}）`);
  assert.ok(series[0] < 1_000, `首次退避必须 < 1000ms（实际 ${series[0]}）`);
  // 之后每一档都不许比上一档小 —— 旧实现正是"永远 2500ms"。
  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index] >= series[index - 1], `第 ${index} 档退避不许变小：${series.join(',')}`);
  }
  assert.equal(series[1], 2_500, '第 1 档仍是 2500ms（与旧行为兼容）');
  assert.equal(series[2], 5_000, '第 2 档必须翻倍');
  assert.ok(series[4] > series[3], '连续失败要持续增长，不能封顶太早');
});

test('退避有上界：再多次失败也不会超过 RETRY_MAX_MS', () => {
  const { link } = makeLink();
  assert.equal(RETRY_MAX_MS, 60_000, '上界就是 60 s：连不上时最多每分钟试一次');
  for (const failures of [6, 7, 8, 12, 50, 1_000]) {
    assert.equal(link.retryDelay(failures), 60_000, `failures=${failures} 必须被封在 60 s`);
  }
  // 上界之前的最后一档仍然小于上界（说明封顶是"到达后持平"，不是提前砍断）。
  assert.ok(link.retryDelay(5) < RETRY_MAX_MS);
});

test('connect 事件本身不再把失败计数归零：要稳定存活 10 s 之后才归零', () => {
  const { link } = makeLink();
  captureTimers((timers) => {
    const client = { connected: true };
    link.client = client;
    link.stats.failures = 5;

    link.noteLinkUp(client);
    assert.equal(link.stats.failures, 5, 'CONNECT 成功不许立刻归零：broker 可以收下又马上关掉');
    assert.equal(timers.length, 1, '必须挂一个"稳定窗口"计时器');
    assert.equal(timers[0].delay, STABLE_LINK_MS, '窗口就是 STABLE_LINK_MS（10 s）');

    // 稳定窗口到期：这条连接真的活下来了，计数才归零。
    timers[0].fn();
    assert.equal(link.stats.failures, 0, '稳定存活之后才允许归零');
  });
});

test('旧连接的稳定计时器不许动新连接的失败计数', () => {
  const { link } = makeLink();
  captureTimers((timers) => {
    const oldClient = { id: 'old' };
    const newClient = { id: 'new' };

    link.client = oldClient;
    link.noteLinkUp(oldClient); // timers[0]
    link.client = newClient;
    link.stats.failures = 3;
    link.noteLinkUp(newClient); // timers[1]

    timers[0].fn(); // 旧连接的那一拍（它早就断了）
    assert.equal(link.stats.failures, 3, '旧连接的计时器不许把新连接的失败计数清零');

    timers[1].fn();
    assert.equal(link.stats.failures, 0, '当前连接的计时器才算数');
  });
});

test('scheduleRetry 用的就是增长过的退避：失败越多等得越久', () => {
  const { link } = makeLink();
  captureTimers((timers) => {
    link.stats.failures = 0;
    link.scheduleRetry();
    const first = timers.at(-1).delay;
    assert.ok(first >= 400 && first < 1_000, `首次应走快档（实际 ${first}）`);

    // 连续快速失败三轮：每一轮断线后重连计数 +1，等待时间必须跟着变长。
    const delays = [];
    for (const failures of [1, 2, 3]) {
      link.stats.failures = failures;
      link.scheduleRetry();
      delays.push(timers.at(-1).delay);
    }
    assert.deepEqual(delays, [2_500, 5_000, 10_000], `退避必须逐轮翻倍（实际 ${delays.join(',')}）`);
    assert.ok(delays.every((delay) => delay <= RETRY_MAX_MS), '不许越过上界');
    link.retryTimer = undefined;
  });
});
