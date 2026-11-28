/**
 * F1：「有请求在途 + 下行静默」必须**早于**请求预算烧完就重建链路。
 *
 * 事故（用户实测，桌面日志已定位）：锁屏唤醒后一切正常，点开会话 A 要 10+ 秒，
 * 再点会话 B 很久不出、最后报「中继请求超时」。桌面日志里那两条详情请求**都收到了、
 * 8–30 ms 就答完**，`nackRepairs=0` —— 就是回包丢失，链路处在"上行通、下行半死"。
 *
 * 根因是两个各自合理的数字叠在一起：
 *   - 请求的**绝对**预算是 `rpcBudgetMs(4, 8_000)` = 15.2 s（见 `web/lib/rpc-budget.js`）；
 *   - 看门狗只认 `PC_STALE_MS`（26 s）才 `restart('下行静默')`。
 *   ⇒ 15.2 s < 26 s，**每一次**半死都必然是请求先判死报 `relay_timeout`（而
 *   `web/lib/net.js` 又把它当不可重试的定论），救它的重建还在 10.8 s 之外。
 *
 * 修法在 `remote/remote.js` 的 `startStaleWatch()` 里加了第二条判据：
 * `ready && pending.size>0 && 静默 > RPC_STALL_REBUILD_MS && 过了冷却 ⇒ restart`。
 *
 * 这里**真跑**生产源码切出来的 `startStaleWatch()`（vm 沙箱 + 假时钟 + 假 setInterval，
 * 见 `test/support/shell-source.mjs`）：判据写成 `Math.min`、漏掉冷却、把 pending 判空
 * 去掉，都会在这里变红 —— 对源码做正则只能证明"某行还在"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rpcWorstCaseMs } from '../../web/lib/rpc-budget.js';
import { HEARTBEAT_MS, RPC_STALL_REBUILD_MS } from '../../web/lib/shell-retry.js';
import { readRepoFile, runSlices, sliceConst, sliceMethod } from '../support/shell-source.mjs';

const SOURCE = readRepoFile('remote/remote.js');

/**
 * 把 `startStaleWatch()` 真跑起来：假 `setInterval` 只记回调，假时钟由用例推进。
 * @param {number} startAt 假时钟起点（ms）
 */
function stallWatch(startAt) {
  let now = startAt;
  const intervals = [];
  const api = runSlices({
    declarations: [
      { name: 'RESTART_COOLDOWN_MS', source: sliceConst(SOURCE, 'RESTART_COOLDOWN_MS') },
      { name: 'PC_STALE_MS', source: sliceConst(SOURCE, 'PC_STALE_MS') },
      { name: 'RPC_STALL_REBUILD_MS', source: sliceConst(SOURCE, 'RPC_STALL_REBUILD_MS') },
      { name: 'setInterval', source: 'const setInterval = globalThis.__setInterval;' },
      { name: 'startStaleWatch', source: sliceMethod(SOURCE, 'startStaleWatch') },
    ],
    globals: {
      __setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    },
    clock: () => now,
  });
  return {
    ...api,
    intervals,
    /**
     * 造一个「已经在线、有 pending 表」的中继实例。
     *
     * `readyAt` 默认在 60 s 前：真实链路是几分钟前建好的，这时「最后一次下行」才是
     * 唯一的下界（首连空窗由单独一条用例覆盖）。
     */
    relay(overrides = {}) {
      const restarts = [];
      const staleEvents = [];
      const instance = {
        staleTimer: undefined,
        ready: true,
        pending: new Map(),
        pcSeenAt: 0,
        readyAt: now - 60_000,
        lastWakeAt: 0,
        lastRestartAt: 0,
        pcStale: false,
        stats: { lastRxAt: now, stallRebuilds: 0 },
        // 与生产 `restart()` 一样：立刻记下"上一次重建时刻"，冷却据此生效。
        restart: (reason = '') => { restarts.push(reason); instance.lastRestartAt = now; },
        onpcStale: (stale, text) => { staleEvents.push({ stale, text }); },
        ...overrides,
      };
      return { instance, restarts, staleEvents };
    },
    /** 起看门狗（真实现是 2 s 一次的 setInterval）。 */
    start(instance) {
      api.startStaleWatch.call(instance);
      assert.equal(intervals.length, 1, '看门狗必须只注册一个间隔');
      assert.equal(intervals[0].ms, 2_000, '巡检周期必须是 2 s');
    },
    /** 手工触发一次巡检。 */
    tick(instance) {
      assert.equal(intervals.length, 1, '看门狗必须只注册一个间隔');
      intervals[0].fn.call(instance);
    },
    advance(ms) { now += ms; return now; },
    clockNow() { return now; },
  };
}

/* --------------------------- 常量与关系（先钉数字） --------------------------- */

test('F1：重建阈值必须「长于一个心跳」且「短于请求预算 15.2 s」，外壳字面量同值', () => {
  // 长于一个 beat：正常链路每 8 s 一条下行，阈值比它短就会误杀健康链路。
  assert.ok(RPC_STALL_REBUILD_MS >= HEARTBEAT_MS,
    `阈值 ${RPC_STALL_REBUILD_MS}ms 必须 ≥ 一个心跳 ${HEARTBEAT_MS}ms，否则正常链路也会被判静默`);
  // 短于请求预算：这才是事故本身 —— 15.2 s 的预算先烧完，重建永远晚一步。
  assert.ok(RPC_STALL_REBUILD_MS < rpcWorstCaseMs(),
    `阈值 ${RPC_STALL_REBUILD_MS}ms 必须 < 外壳请求预算 ${rpcWorstCaseMs()}ms，`
    + '否则"救它的重建"永远发生在请求判死之后（等于没修）');
  assert.equal(RPC_STALL_REBUILD_MS, 10_000, '取"约一个心跳周期"：10 s 没有下行帧才是明确信号');

  // 外壳里那份是数字字面量（看门狗用例按名字切进 vm），两边必须同值；
  // 只改一边而忘了另一边，生产行为与 web/lib 的常量就会悄悄分叉。
  const hit = /const RPC_STALL_REBUILD_MS = ([\d_]+);/u.exec(SOURCE);
  const shellValue = hit === null ? Number.NaN : Number(hit[1].replaceAll('_', ''));
  assert.equal(shellValue, RPC_STALL_REBUILD_MS, 'remote/remote.js 的字面量必须与 shell-retry.js 的导出同值');
});

/* ------------------------------ 行为：会触发 ------------------------------ */

test('F1：有请求在途 + 下行静默 ≥ 阈值 → 立刻重建一次（不再等 26 s）', () => {
  const watch = stallWatch(1_700_000_000_000);
  const { instance, restarts, staleEvents } = watch.relay();
  // 一条详情请求在途，而最后一次下行帧还在阈值之外（半死链路：上行照发、回包进不来）。
  instance.pending.set('req-detail', { id: 'req-detail' });
  instance.stats.lastRxAt = watch.clockNow() - RPC_STALL_REBUILD_MS - 1;
  watch.start(instance);
  watch.tick(instance);

  assert.deepEqual(restarts, ['请求在途但下行静默'],
    '静默一个心跳多 + 有请求在途 → 必须重建（旧实现要等 26 s，请求 15.2 s 就判死了）');
  assert.equal(instance.stats.stallRebuilds, 1, '诊断计数器必须记一次（快照里的「静默重建」）');
  assert.deepEqual(staleEvents, [], '还没到 26 s：不许顺带把「电脑端已离线」横幅点亮');
  assert.equal(instance.pcStale, false);
});

test('F1：pcSeenAt（hello / beat 落点）新鲜时同样算"下行活着"，不许重建', () => {
  const watch = stallWatch(1_700_000_000_000);
  const { instance, restarts } = watch.relay();
  instance.pending.set('req-1', { id: 'req-1' });
  // `lastRxAt` 是解封成功的帧，`pcSeenAt` 是电脑端心跳的落点：任一新都说明下行通。
  instance.stats.lastRxAt = 0;
  instance.pcSeenAt = watch.clockNow() - 1_000;
  watch.start(instance);
  watch.tick(instance);
  assert.deepEqual(restarts, [], '一分钟前的 lastRxAt 但刚收到 hello：链路是好的');
});

test('F1：刚 ready 的前 10 s 不许自伤（readyAt 是下界，首连空窗不是"静默"）', () => {
  const watch = stallWatch(1_700_000_000_000);
  const { instance, restarts } = watch.relay({ readyAt: watch.clockNow() });
  instance.pending.set('req-first', { id: 'req-first' });
  instance.stats.lastRxAt = 0; // 首连后一帧都还没收到（桌面的第一条 beat 还没到）
  instance.pcSeenAt = 0;
  watch.start(instance);

  watch.advance(2_000);
  watch.tick(instance);
  watch.advance(RPC_STALL_REBUILD_MS - 2_000 - 1); // ready 后 9.999 s
  watch.tick(instance);
  assert.deepEqual(restarts, [], '刚建好的链路本来就可能还没收到 beat：这时候重建就是首连自伤');

  // 链路建好超过阈值仍旧一帧下行都没有 → 这才是真的半死，该救了。
  watch.advance(2);
  watch.tick(instance);
  assert.deepEqual(restarts, ['请求在途但下行静默'], 'ready 满阈值还一条下行帧都没有 → 必须重建');
});

/* ------------------------------ 行为：不触发 ------------------------------ */

test('F1：正常但慢的请求（冷会话 4.4 s）期间 beat 照常刷新 lastRxAt → 一次都不重建', () => {
  const watch = stallWatch(1_700_000_000_000);
  const { instance, restarts } = watch.relay();
  instance.pending.set('req-cold', { id: 'req-cold' });
  watch.start(instance);
  // 桌面每 8 s 一条 beat；请求慢 4.4 s，跨过好几个巡检拍。
  for (const gap of [0, 8_000, 8_000, 4_400]) {
    if (gap > 0) watch.advance(gap);
    instance.stats.lastRxAt = watch.clockNow(); // 这一拍刚好收到 beat
    watch.tick(instance);
  }
  assert.deepEqual(restarts, [], '下行一直在动：慢请求不许被当成"链路半死"（这是不误伤的前提）');
  assert.equal(instance.stats.stallRebuilds, 0);
});

test('F1：没有在途请求时不许抢跑（26 s 的「下行静默」原有语义不变）', () => {
  const watch = stallWatch(1_700_000_000_000);
  // readyAt 就在此刻、之后一帧下行都没有：idle 只从 readyAt 起算。
  const { instance, restarts } = watch.relay({ readyAt: watch.clockNow() });
  instance.stats.lastRxAt = 0;
  instance.pcSeenAt = 0;
  watch.start(instance);
  watch.advance(12_000); // 超过 F1 阈值，但没到 26 s
  watch.tick(instance);
  assert.deepEqual(restarts, [], 'pending 为空时 F1 判据不成立：没有人等着回包，就别拆链路');

  watch.advance(watch.PC_STALE_MS); // 累到 38 s：旧规则该动手了
  watch.tick(instance);
  assert.deepEqual(restarts, ['下行静默'], '没有在途请求时仍按原来的 26 s 判据走，原因不许变');
});

/* ------------------------------ 行为：冷却 ------------------------------ */

test('F1：冷却窗口内不重复重建，冷却过后仍静默才再建一次（防重建风暴）', () => {
  const watch = stallWatch(1_700_000_000_000);
  const { instance, restarts } = watch.relay();
  instance.pending.set('req-cooldown', { id: 'req-cooldown' });
  instance.stats.lastRxAt = watch.clockNow() - RPC_STALL_REBUILD_MS - 1;
  watch.start(instance);
  watch.tick(instance);
  assert.equal(restarts.length, 1, '第一次必须重建');

  watch.advance(5_000); // 冷却 15 s 还没过，链路依旧静默
  watch.tick(instance);
  assert.equal(restarts.length, 1, 'RESTART_COOLDOWN_MS 内不许再建（抖动里狂重建会把刚恢复的链路再打趴）');

  watch.advance(watch.RESTART_COOLDOWN_MS);
  watch.tick(instance);
  assert.deepEqual(restarts, ['请求在途但下行静默', '请求在途但下行静默'],
    '冷却过后仍然静默 → 允许下一次重建');
  assert.equal(instance.stats.stallRebuilds, 2, '每次触发都要计数（诊断里要能看出"救了两次还是不通"）');
});
