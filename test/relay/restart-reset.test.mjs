/**
 * `start()` 必须把「上一次的失败史」清零（R8）—— `lib/cloud.mjs` 的 `start()`。
 *
 * 现场：`stats.failures = 5` 时把中继关掉再打开，首轮退避是
 * `RETRY_MS * 2^(5-1)` = 40 s —— 用户看到的是「刚打开远程访问，40 秒连不上」。
 * `brokerIndex` 残留还会让重开先试上一次刚失败的那个 broker。
 *
 * 归零点必须在 `start()`（重开就是重新开始），而不是 `stop()`：`stop()` 之后
 * 状态页仍要能看到上一次的失败计数用于排障。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeLink } from './_support/fixtures.mjs';

test('R8：start() 归零 failures 与 brokerIndex，重开首轮走快档', () => {
  const { link } = makeLink();
  link.brokers = ['ws://a.example/mqtt', 'ws://b.example/mqtt', 'ws://c.example/mqtt'];
  link.stop(); // 关掉再打开（配置开关 / 管理动作）
  assert.equal(link.client, undefined, 'stop 之后没有 client，start 才会真的重连');

  link.stats.failures = 5;
  link.brokerIndex = 2;
  link.broker = link.brokers[2];
  assert.equal(link.retryDelay(), 40_000, '前提：failures=5 时首轮退避就是 40 秒（这就是旧缺陷的现场）');

  link.connect = () => { /* 不真连 broker：本用例只验计数 */ };
  assert.equal(link.start(), true);

  assert.equal(link.stats.failures, 0, '重开必须从最短退避开始');
  assert.equal(link.brokerIndex, 0, 'broker 索引也要回到第一个');
  assert.equal(link.broker, link.brokers[0], '重开要用回第一个 broker');
  assert.ok(link.retryDelay() < 1_000, `重开之后首轮必须是快档（实际 ${link.retryDelay()}ms）`);
  link.stop();
});

test('R8：重开之后连续失败仍然逐次翻倍（归零不是把退避关掉）', () => {
  const { link } = makeLink();
  link.stop();
  link.stats.failures = 0;
  link.connect = () => {};
  link.start();
  const delays = [];
  for (let index = 0; index < 4; index += 1) {
    link.stats.failures += 1;
    delays.push(link.retryDelay());
  }
  assert.deepEqual(delays, [2_500, 5_000, 10_000, 20_000], `退避必须仍然逐次翻倍（实际 ${delays.join(',')}）`);
  link.stop();
});
