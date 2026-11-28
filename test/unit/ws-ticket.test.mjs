/**
 * 实时票缓存（`WsTicketCache`）：**预热 + 按过期刷新 + 出票即作废**。
 *
 * 为什么要有这些用例（数字来自 `test/support/bench-harness.mjs` 的实测，单向 300 ms）：
 * 建隧道是两次串行往返 —— 换票 p50 648 ms + 升级 p50 632 ms = **1275 ms**；票 60 s
 * 有效、用掉即作废，所以"开机预热一张、用掉再补下一张"能把重建降到一次往返
 * （629 ms）。收益全在"票还在不在、还能不能用、会不会被用第二次"这三件事上，
 * 所以每一条都单独钉住：
 *
 *   - 同一张票绝不发两次（电脑端消费即删，重发只会撞 401）；
 *   - 离过期不足安全余量的票**不许**用（送到时已过期 = 白丢一次握手）；
 *   - 没有 `expiresAt` 的票不可用（推不出寿命就按过期处理）；
 *   - 并发取票单飞（开机预热与 connect 同时要票时，只跑一次往返）；
 *   - 按过期时间自动补票（否则缓存里的票会烂掉，等于没预热）。
 *
 * 时钟与定时器全部注入，用例不睡觉、不依赖真实时间。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TICKET_REFRESH_RATIO, TICKET_SAFETY_MS, WsTicketCache,
} from '../../web/lib/net.js';

/** 可控时钟 + 可控定时器：`fire()` 只跑到点的那一个。 */
function harness({ tickets = [], now = 1_000_000 } = {}) {
  const state = {
    now,
    timers: new Map(),
    nextId: 0,
    queue: [...tickets],
    fetches: 0,
    errors: [],
  };
  const clock = {
    now: () => state.now,
    advance(ms) {
      state.now += ms;
      for (const [id, timer] of [...state.timers]) {
        if (timer.at <= state.now) {
          state.timers.delete(id);
          timer.fn();
        }
      }
    },
  };
  const cache = new WsTicketCache({
    now: () => state.now,
    safetyMs: TICKET_SAFETY_MS,
    fetchTicket: () => {
      state.fetches += 1;
      const next = state.queue.shift();
      if (next === undefined) return Promise.resolve(null);
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    setTimer: (fn, ms) => {
      state.nextId += 1;
      state.timers.set(state.nextId, { fn, at: state.now + ms, ms });
      return state.nextId;
    },
    clearTimer: (id) => { state.timers.delete(id); },
    onError: (error) => { state.errors.push(error); },
  });
  return { cache, state, clock };
}

/** 一张还有 `leftMs` 寿命的票。 */
const mint = (state, ticket, leftMs = 60_000) => ({ ticket, expiresAt: state.now + leftMs });

test('预热一次就够：连着预热只跑一次取票', async () => {
  const { cache, state } = harness({ tickets: [mint({ now: 1_000_000 }, 'wst_a')] });
  assert.equal(await cache.prewarm(), true);
  assert.equal(await cache.prewarm(), true);
  assert.equal(state.fetches, 1, '两次预热只该跑一次取票（缓存里那张还能用）');
  assert.equal(cache.stats.fetches, 1);
});

test('预热好的票被 take() 用掉：0 次现取，且票立刻从缓存里消失', async () => {
  const { cache, state } = harness({ tickets: [mint({ now: 1_000_000 }, 'wst_a')] });
  await cache.prewarm();
  assert.equal(await cache.take(), 'wst_a');
  assert.equal(state.fetches, 1, 'take() 不该再跑一次取票');
  assert.equal(cache.stats.cached, false, '出票即作废：缓存里必须已经清掉');
});

test('同一张票绝不发第二次：连取两张就会再去换一次', async () => {
  const { cache, state } = harness({
    tickets: [mint({ now: 1_000_000 }, 'wst_a'), mint({ now: 1_000_000 }, 'wst_b')],
  });
  await cache.prewarm();
  assert.equal(await cache.take(), 'wst_a');
  assert.equal(await cache.take(), 'wst_b', '第二张票必须是重新取的，不能是同一张');
  assert.notEqual('wst_a', 'wst_b');
  assert.equal(state.fetches, 2);
});

test('并发 take()：绝不给同一张票（缓存出票串行化）', async () => {
  const { cache, state } = harness({
    tickets: [mint({ now: 1_000_000 }, 'wst_a'), mint({ now: 1_000_000 }, 'wst_b')],
  });
  await cache.prewarm();
  const [first, second] = await Promise.all([cache.take(), cache.take()]);
  assert.deepEqual([first, second], ['wst_a', 'wst_b']);
  assert.equal(state.fetches, 2, '第一张用完就没有了，第二张必须重新取');
});

test('并发预热单飞：开机时 prewarm 与 connect 同时要票，只跑一次往返', async () => {
  const { cache, state } = harness({
    tickets: [mint({ now: 1_000_000 }, 'wst_a'), mint({ now: 1_000_000 }, 'wst_b')],
  });
  await Promise.all([cache.prewarm(), cache.prewarm(), cache.prewarm()]);
  assert.equal(state.fetches, 1, '并发预热必须共享同一条在飞的取票请求');
});

test('快过期的票不许用：缓存里那张剩不到安全余量就丢掉重取', async () => {
  const { cache, state, clock } = harness({
    tickets: [mint({ now: 1_000_000 }, 'wst_old'), mint({ now: 1_000_000 }, 'wst_fresh')],
  });
  await cache.prewarm();
  // 时间往前走，旧票只剩 5 s 寿命（< 安全余量 10 s）。
  clock.advance(55_000);
  assert.equal(await cache.take(), 'wst_fresh', '只剩不到安全余量的票必须被丢掉重取');
  assert.equal(state.fetches, 2);
});

test('刚取回来的票即便寿命短也照用（否则会无限重取）', async () => {
  const { cache, state } = harness({ tickets: [mint({ now: 1_000_000 }, 'wst_short', 9_000)] });
  // 电脑端只给了 9 s：安全余量是给"缓存里放着"的票用的，刚到手的不重取。
  assert.equal(await cache.take(), 'wst_short');
  assert.equal(state.fetches, 1);
});

test('没有 expiresAt 的票不可用（推不出寿命就按过期处理）', async () => {
  const { cache, state } = harness({
    tickets: [{ ticket: 'wst_no_expiry' }, { ticket: '', expiresAt: 9_999_999_999 }, null],
  });
  cache.start();
  // 取票应答不合法 → 视为失败，返回 null（调用方按"无法获取票据"处理）。
  assert.equal(await cache.take(), null);
  assert.equal(cache.stats.cached, false);
  assert.equal(state.errors.length, 1, '失败要交给 onError，界面不该被抛崩');
});

test('取票失败不抛：返回 null 并在 retryMs 后自动再试', async () => {
  const { cache, state, clock } = harness({ tickets: [new Error('中继抖动')] });
  assert.equal(await cache.prewarm(), false);
  assert.equal(state.errors.length, 1);
  const retry = [...state.timers.values()][0];
  assert.ok(retry !== undefined, '失败之后必须排一次重试，否则票永远补不上');
  // 到点后这次取票成功（队列里再放一张）。
  state.queue.push(mint({ now: state.now }, 'wst_retry'));
  clock.advance(retry.ms);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.stats.cached, true, '重试成功之后缓存里应当有票');
});

test('按过期时间自动补票：刷新点 = (过期 - 安全余量) × 比例', async () => {
  const { cache, state, clock } = harness({
    tickets: [mint({ now: 1_000_000 }, 'wst_a'), mint({ now: 1_000_000 }, 'wst_b')],
  });
  await cache.prewarm();
  const timer = [...state.timers.values()][0];
  assert.ok(timer !== undefined, '预热之后必须排一次刷新，否则票在缓存里会烂掉');
  const expected = Math.round((60_000 - TICKET_SAFETY_MS) * TICKET_REFRESH_RATIO);
  assert.ok(Math.abs(timer.ms - expected) <= 1, `刷新间隔该是 ${expected}ms，实际 ${timer.ms}ms`);
  clock.advance(timer.ms);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.fetches, 2, '到点之后要补下一张');
  assert.equal(cache.stats.cached, true);
});

test('detail 里顺带下发的票直接收下：0 次额外往返，且只在这一页有效的那张能用', async () => {
  const { cache, state } = harness({ tickets: [mint({ now: 1_000_000 }, 'wst_background')] });
  await cache.prewarm();
  const accepted = cache.offer(mint({ now: 1_000_000 }, 'wst_from_detail', 45_000));
  // 缓存里那张更耐放（60 s > 45 s）：不该被 detail 那张顶掉。
  assert.equal(accepted, false, '手里有更耐放的票时不要换');
  assert.equal(await cache.take(), 'wst_background');

  // 缓存空着时，detail 那张必须被收下并可直接用于握手（0 次现取）。
  const second = harness({ now: 2_000_000 });
  assert.equal(second.cache.offer(mint({ now: 2_000_000 }, 'wst_detail_only', 45_000)), true);
  assert.equal(await second.cache.take(), 'wst_detail_only');
  assert.equal(second.state.fetches, 0, 'detail 下发的票必须省掉整次取票往返');
  assert.equal(state.fetches, second.state.fetches + 1);
});

test('重放回来的同一张票不收：同一条 detail 应答被重放也不会变成死票', async () => {
  const { cache, state } = harness({});
  const carried = mint({ now: state.now }, 'wst_replayed', 45_000);
  assert.equal(cache.offer(carried), true);
  assert.equal(await cache.take(), 'wst_replayed');
  // 电脑端重放缓存把同一条 detail 应答又放了一遍（票已经用掉了）。
  assert.equal(cache.offer(mint({ now: state.now }, 'wst_replayed', 59_000)), false, '用过的票不许再进缓存');
  assert.equal(cache.stats.cached, false);
});

test('取票应答本身就是一张用过的票：按失败处理，不塞进握手', async () => {
  const { cache, state } = harness({
    tickets: [mint({ now: 1_000_000 }, 'wst_same'), mint({ now: 1_000_000 }, 'wst_same')],
  });
  assert.equal(await cache.take(), 'wst_same');
  assert.equal(await cache.take(), null, '第二张如果还是同一张（重放），必须当成失败');
  assert.equal(state.errors.length, 1);
});

test('detail 下发的票若已过期/形状不对一律不收（不许拿死票去握手）', () => {
  const { cache, state } = harness({});
  assert.equal(cache.offer({ ticket: 'wst_dead', expiresAt: state.now - 1 }), false);
  assert.equal(cache.offer({ ticket: 'wst_shrinking', expiresAt: state.now + TICKET_SAFETY_MS }), false);
  assert.equal(cache.offer({ ticket: '', expiresAt: state.now + 60_000 }), false);
  assert.equal(cache.offer({ expiresAt: state.now + 60_000 }), false);
  assert.equal(cache.offer(null), false);
  assert.equal(cache.offer('wst_string'), false, '只接受对象应答');
  assert.equal(cache.stats.cached, false);
});

test('stop() 之后票清空且不再取票（退登不许留着有效凭据）', async () => {
  const { cache, state } = harness({ tickets: [mint({ now: 1_000_000 }, 'wst_a')] });
  await cache.prewarm();
  cache.stop();
  assert.equal(cache.stats.cached, false, '退登必须把预热中的票一起丢掉');
  assert.equal(await cache.take(), null);
  assert.equal(await cache.prewarm(), false);
  assert.equal(state.fetches, 1, '停掉之后不该再有取票请求');
  // 重新开始时（换设备/重新配对）还能用。
  cache.start();
  state.queue.push(mint({ now: state.now }, 'wst_new'));
  assert.equal(await cache.take(), 'wst_new');
});

test('fetchTicket 缺失立刻报错（配置错不该拖到握手时才炸）', () => {
  assert.throws(() => new WsTicketCache({}), TypeError);
});
