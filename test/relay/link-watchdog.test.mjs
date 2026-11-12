/**
 * 电脑端链路自愈的回归测试（lib/cloud.mjs）。
 *
 * 三条真实缺陷：
 *  1. `client.on('error'/'close')` 一行日志都不写 —— broker 侧断连在日志里天然不可见；
 *  2. `keepalive:40` 让 mqtt.js 最坏 60 s 才判死，这段时间里 PC 照旧 publish 进死管道，
 *     手机侧一片死寂却没有任何自救动作；
 *  3. `scheduleRetry` 固定 2500ms —— 插件重载后电脑端 ~4 s 就回来了，手机多半刚好错过。
 *
 * 这里用 `checkLink(now)` 注入假时钟（生产里由 3 s 的 interval 调用），绝不真等。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_PROTOCOL } from '../../lib/cloud.mjs';
import { decodeAll, feed, makeLink } from './_support/fixtures.mjs';

/** 造一个「已在线」的 link，并把三个存活时间戳都钉在 now。 */
function onlineLink(now = Date.now()) {
  const fixture = makeLink();
  fixture.link.client = { connected: true, publish() {}, end() {} };
  fixture.link.connectedAt = now;
  fixture.link.lastTxAckAt = now;
  fixture.link.lastRxAt = now;
  return fixture;
}

test('看门狗：connected=false 要连续 2 个周期才重建（1 个周期算抖动）', () => {
  const now = Date.now();
  const { link, logger } = onlineLink(now);
  let connects = 0;
  link.connect = () => { connects += 1; };

  link.client = { connected: false, publish() {}, end() {} };
  assert.equal(link.checkLink(now), false, '第 1 个异常周期只记账');
  assert.equal(link.linkStrikes, 1);
  assert.equal(connects, 0, '一个周期是抖动，不许重建');

  assert.equal(link.checkLink(now + 10_000), true, '第 2 个异常周期必须重建');
  assert.equal(connects, 1);
  assert.equal(link.linkStrikes, 0, '动手之后计数归零，避免连着重启');
  assert.ok(logger.lines.some((line) => line.includes('cloud link watchdog: rebuild')));
});

test('看门狗：connected 仍为 true 但上行超阈值没 ACK，同样要判死', () => {
  const now = Date.now();
  const { link } = onlineLink(now);
  let connects = 0;
  link.connect = () => { connects += 1; };

  // 关键场景：TCP/WS 还在（connected=true），但 qos1 一个 ACK 都回不来 ——
  // 旧代码在这 60 s 里只会一直 publish 进死管道。
  link.connectedAt = now - 120_000;
  link.lastTxAckAt = now - 40_000;
  link.lastRxAt = now - 40_000;

  assert.equal(link.checkLink(now), false);
  assert.equal(link.checkLink(now + 10_000), true);
  assert.equal(connects, 1);
});

test('看门狗：ACK 按 beat 节奏刷新时永不误判（手机静默但下行仍在推）', () => {
  const now = Date.now();
  const { link } = onlineLink(now);
  link.connect = () => { throw new Error('健康链路不许重建'); };

  // 只有下行（beat）没有上行：lastRxAt 可能极旧，但 qos1 ACK 每 8 s 回一次。
  // 逐拍模拟 5 个 beat（跨过阈值两轮），任何一拍都不许判死 —— 判死阈值是 17 s，
  // 单一拍的间隔 8 s 必须留有余量，否则公共 broker 的抖动就会引发重建风暴。
  link.lastRxAt = now - 600_000;
  for (const at of [0, 8_000, 16_000, 24_000, 32_000]) {
    link.lastTxAckAt = now + at - 8_000;
    assert.equal(link.checkLink(now + at), false, `第 ${at / 1000}s 不该判死`);
  }
  assert.equal(link.linkStrikes, 0);
});

test('看门狗：离线期间不计数（重连交给 close 事件与 scheduleRetry）', () => {
  const now = Date.now();
  const { link } = onlineLink(now);
  link.state = 'reconnecting';
  link.linkStrikes = 1;

  assert.equal(link.checkLink(now + 60_000), false);
  assert.equal(link.linkStrikes, 0, '非 online 状态要归零，否则重连后立刻误杀');
});

test('publishSealed：只有 qos1 ACK 成功才刷新 lastTxAckAt', () => {
  const { link, logger } = makeLink();
  link.lastTxAckAt = 0;
  link.publish({ t: 'beat', ts: Date.now() });
  const ackedAt = link.lastTxAckAt;
  assert.ok(ackedAt > 0, '成功回调必须刷新 ACK 时间，否则看门狗没有「管道通」的证据');

  // 失败分支：ACK 带 error。这时绝不能刷新，否则看门狗被假 ACK 喂饱、永远不动手。
  link.client = {
    publish(_topic, _payload, _options, callback) {
      callback(new Error('broker rejected'));
      return true;
    },
    end() {},
  };
  link.publish({ t: 'beat', ts: Date.now() });
  assert.equal(link.lastTxAckAt, ackedAt, '失败不许刷新 ACK 时间');
  assert.ok(logger.lines.some((line) => line.includes('publish failed')));
});

test('scheduleRetry：首次 400ms(+0~150ms 抖动)，连续失败回到 2500ms 档位', () => {
  const { link } = makeLink();
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (_fn, delay) => { delays.push(delay); return { unref() {} }; };
  globalThis.clearTimeout = () => {};
  try {
    // 刚 connect 成功（failures 归零）→ 第一次断线：必须快。
    link.stats.failures = 0;
    link.scheduleRetry();
    assert.ok(delays[0] >= 400, `首次重试不该比 400ms 还急（实际 ${delays[0]}）`);
    assert.ok(delays[0] < 1_000, `首次重试必须 < 1000ms（实际 ${delays[0]}）`);

    // 已经连不上一轮：回到 2500ms，避免在公共 broker 上打重连风暴。
    link.stats.failures = 1;
    link.scheduleRetry();
    assert.equal(delays[1], 2_500);

    link.stats.failures = 2;
    link.scheduleRetry();
    assert.equal(delays[2], 2_500);

    // 快慢只认「连续失败次数」：closes 只增不减，拿它当依据就永远走慢档。
    link.stats.closes = 5_000;
    link.stats.failures = 0;
    link.scheduleRetry();
    assert.ok(delays[3] < 1_000, 'closes 与快慢无关');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    link.retryTimer = undefined;
  }
});

test('收到 hello 立刻回一条 beat：不等 8s 周期的定时器，且 peers 与槽位数一致', () => {
  const { link, sent } = makeLink();
  link.sockets.set('11111111', { readyState: 1, send() {}, close() {} });

  feed(link, { t: 'hello', name: 'Pixel 9', ver: 2 });
  const answers = decodeAll(link, sent);
  assert.deepEqual(answers.map((message) => message.t), ['hello', 'beat']);
  assert.equal(answers[1].ver, CLOUD_PROTOCOL);
  assert.equal(answers[1].peers, 1);
  assert.ok(answers[1].ts > 0);

  // 10s 限流只压 hello 回声，不该压掉即时 beat 的意义（横幅消失速度）。
  feed(link, { t: 'hello', name: 'Pixel 9', ver: 2 });
  assert.deepEqual(decodeAll(link, sent).slice(2).map((message) => message.t), ['beat']);
});

/**
 * 这是「探测顺序」不变量，别把它当普通常量检查删掉。
 *
 * 手机端在 26 s 静默后就会认定「电脑端已离线」并自行重建；如果电脑这边判死更慢，
 * 那么每一次半死链路都必然是手机先喊、先折腾，电脑只是被动挨拆 —— 这正是用户看到
 * 的「经常中断 + 重连很久」。所以两边阈值的关系必须被测试钉死，而不是靠注释。
 */
test('探测顺序：电脑端判死上界必须小于手机端 26 s 阈值', async () => {
  const fs = await import('node:fs/promises');
  const read = (relative) => fs.readFile(new URL(relative, import.meta.url), 'utf8');
  const pick = (source, name) => {
    const hit = new RegExp(`const ${name} = ([\\d_]+);`, 'u').exec(source);
    return hit === null ? Number.NaN : Number(hit[1].replaceAll('_', ''));
  };

  const cloud = await read('../../lib/cloud.mjs');
  const remote = await read('../../remote/remote.js');
  const watch = pick(cloud, 'LINK_WATCH_MS');
  const stale = pick(cloud, 'LINK_STALE_MS');
  const phone = pick(remote, 'PC_STALE_MS');

  assert.ok(Number.isFinite(watch) && Number.isFinite(stale) && Number.isFinite(phone),
    '三个常量都要能被解析出来（改名了就把这里一起改）');
  assert.ok(stale > 8_000, '阈值必须大于 1 个 beat（8 s），否则正常抖动就会重建');
  // 连续 2 个 strike 才动手：时间上界 = 阈值 + 2 个采样周期。
  const worst = stale + 2 * watch;
  assert.ok(worst < phone, `电脑端判死上界 ${worst}ms 必须小于手机端 ${phone}ms`);
});
