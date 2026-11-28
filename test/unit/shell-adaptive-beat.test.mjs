/**
 * 手机端：按桌面下发的 `beatMs` 推导三个静默阈值（本轮的核心红线）。
 *
 * 事故模型：桌面把心跳从 8 s 拉长到 30 s 之后，手机端若还按「8 s 心跳」的
 * 10 s / 26 s / 16 s 判静默，就会把**正常的长间隔**判成「下行静默」⇒
 * `restart()` 拆掉 ws 隧道、作废正在拼的分片（误重建）。
 *
 * 这一组钉四件事：
 *  1. 公式：`wake ≥ 2×beat`、`PC_STALE ≥ 3×beat`、`RPC_STALL ≥ 1.25×beat`；
 *  2. **红线**：任何档位下 `RPC_STALL_REBUILD_MS` 都必须**长于一个心跳**；
 *  3. 向下兼容：`beatMs = 8_000` 时逐值等于 1.0.10 的三个常量；字段缺失/脏值
 *     时退回同一组常量（老桌面行为不变）；
 *  4. 行为：`remote/remote.js` 里切出来的 `noteBeatMs()` / `startStaleWatch()`
 *     真跑 —— 30 s 心跳下 10 分钟不重建，而老阈值在同一段时间里会重建多次。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HEARTBEAT_MS, PC_STALE_MS, RPC_STALL_REBUILD_MS, WAKE_SILENT_MS,
  deriveThresholds, wakeDecision,
} from '../../web/lib/shell-retry.js';
import { readRepoFile, runSlices, sliceConst, sliceMethod } from '../support/shell-source.mjs';

const SOURCE = readRepoFile('remote/remote.js');

/** 从外壳源码里读一个字面量（与 `shell-stall-rebuild.test.mjs` 同一种写法）。 */
function shellConst(name) {
  const hit = new RegExp(`const ${name} = ([\\d_]+);`, 'u').exec(SOURCE);
  return hit === null ? Number.NaN : Number(hit[1].replaceAll('_', ''));
}

/* ------------------------------ 1. 公式 ------------------------------ */

test('阈值公式：beatMs=30_000 ⇒ 60_000 / 97_500 / 37_500，且三个都按倍数抬上去', () => {
  const derived = deriveThresholds(30_000);
  assert.deepEqual(derived, {
    beatMs: 30_000,
    known: true,
    wakeSilentMs: 60_000,
    pcStaleMs: 97_500,
    rpcStallRebuildMs: 37_500,
  });
  // 公式本身（换个值也得成立，避免被硬编码蒙过去）。
  for (const beat of [8_000, 12_000, 20_000, 30_000]) {
    const item = deriveThresholds(beat);
    assert.ok(item.wakeSilentMs >= 2 * beat, `WAKE_SILENT 必须 ≥ 2×${beat}`);
    assert.ok(item.pcStaleMs >= 3 * beat, `PC_STALE 必须 ≥ 3×${beat}`);
    assert.ok(item.rpcStallRebuildMs >= 1.25 * beat, `RPC_STALL 必须 ≥ 1.25×${beat}`);
  }
});

test('红线：任何档位下 RPC_STALL_REBUILD_MS 都**长于一个心跳**（否则正常链路会被误杀）', () => {
  // 桌面可能上报的每一个值都要过这条：阈值 ≤ 一个心跳 ⇒ 下一拍没赶上就重建。
  for (const beat of [1_000, 4_000, 8_000, 8_001, 12_000, 20_000, 30_000, 60_000]) {
    const { rpcStallRebuildMs, pcStaleMs } = deriveThresholds(beat);
    assert.ok(rpcStallRebuildMs > beat,
      `beatMs=${beat} 时重建阈值 ${rpcStallRebuildMs}ms 必须 > 一个心跳，否则误重建`);
    assert.ok(pcStaleMs > rpcStallRebuildMs,
      `「电脑端已离线」的门槛 ${pcStaleMs} 必须晚于「在途请求静默」的 ${rpcStallRebuildMs}，否则横幅会先亮`);
  }
});

/* --------------------------- 2. 向下兼容 --------------------------- */

test('beatMs=8_000 ⇒ 与 1.0.10 的三个常量逐值相等（新桌面快速档 = 今天的行为）', () => {
  assert.equal(HEARTBEAT_MS, 8_000);
  const derived = deriveThresholds(HEARTBEAT_MS);
  assert.equal(derived.wakeSilentMs, WAKE_SILENT_MS);
  assert.equal(derived.pcStaleMs, PC_STALE_MS);
  assert.equal(derived.rpcStallRebuildMs, RPC_STALL_REBUILD_MS);
  assert.deepEqual(
    [derived.wakeSilentMs, derived.pcStaleMs, derived.rpcStallRebuildMs],
    [16_000, 26_000, 10_000],
  );
  // 外壳里的那两个字面量必须与导出的常量同值（两边各写一份，最容易悄悄分叉）。
  assert.equal(shellConst('PC_STALE_MS'), PC_STALE_MS);
  assert.equal(shellConst('RPC_STALL_REBUILD_MS'), RPC_STALL_REBUILD_MS);
});

test('老桌面（没有 beatMs 字段 / 脏值）⇒ 退回 8 s 假设的三个常量，且 known=false', () => {
  for (const raw of [undefined, null, 0, -1, Number.NaN, '', 'abc', Infinity]) {
    const derived = deriveThresholds(raw);
    assert.equal(derived.known, false, `${String(raw)} 不是可用的心跳周期`);
    assert.deepEqual(
      [derived.beatMs, derived.wakeSilentMs, derived.pcStaleMs, derived.rpcStallRebuildMs],
      [HEARTBEAT_MS, WAKE_SILENT_MS, PC_STALE_MS, RPC_STALL_REBUILD_MS],
    );
  }
});

test('比 8 s 还小的 beatMs 按 8 s 算：阈值只能放大，不能比今天更激进', () => {
  for (const faster of [1_000, 2_000, 4_000, 7_999]) {
    const derived = deriveThresholds(faster);
    assert.equal(derived.pcStaleMs >= PC_STALE_MS, true);
    assert.equal(derived.rpcStallRebuildMs >= RPC_STALL_REBUILD_MS, true);
    assert.equal(derived.wakeSilentMs >= WAKE_SILENT_MS, true);
  }
});

/* ------------------------- 3. 回到前台（wake） ------------------------- */

test('回到前台：知道 beatMs 时门槛跟着放大（30 s 心跳 ⇒ 60 s 静默才算死链）', () => {
  const now = 1_700_000_000_000;
  const idle = (ms) => wakeDecision({ ready: true, now, lastRxAt: now - ms, beatMs: 30_000 });
  assert.equal(idle(59_999), 'none', '差 1 ms 没到门槛 ⇒ 不许重建（下一次心跳可能就在路上）');
  assert.equal(idle(60_000), 'restart-silent');
  // 老桌面（不给 beatMs）还是 16 s：行为与今天一致。
  assert.equal(wakeDecision({ ready: true, now, lastRxAt: now - 20_000 }), 'restart-silent');
});

/* --------------------- 4. 外壳真跑（vm 切片） --------------------- */

/**
 * 把 `remote/remote.js` 里的 `noteBeatMs()` / `noteDesktopAlive()` /
 * `startStaleWatch()` 切进 vm 跑：真时钟、真阈值、真重建判据。
 */
function shell(startAt = 1_700_000_000_000) {
  let now = startAt;
  const intervals = [];
  const api = runSlices({
    declarations: [
      { name: 'RESTART_COOLDOWN_MS', source: sliceConst(SOURCE, 'RESTART_COOLDOWN_MS') },
      { name: 'PC_STALE_MS', source: sliceConst(SOURCE, 'PC_STALE_MS') },
      { name: 'RPC_STALL_REBUILD_MS', source: sliceConst(SOURCE, 'RPC_STALL_REBUILD_MS') },
      { name: 'setInterval', source: 'const setInterval = globalThis.__setInterval;' },
      { name: 'noteBeatMs', source: sliceMethod(SOURCE, 'noteBeatMs') },
      { name: 'noteDesktopAlive', source: sliceMethod(SOURCE, 'noteDesktopAlive') },
      { name: 'startStaleWatch', source: sliceMethod(SOURCE, 'startStaleWatch') },
    ],
    globals: {
      // 生产里这两个方法是类方法，切片后靠 `this` 调；`deriveThresholds` 走真模块。
      deriveThresholds,
      __setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    },
    clock: () => now,
  });
  return {
    ...api,
    intervals,
    advance(ms) { now += ms; return now; },
    clockNow() { return now; },
    relay(overrides = {}) {
      const restarts = [];
      const instance = {
        staleTimer: undefined,
        ready: true,
        pending: new Map(),
        pcSeenAt: 0,
        readyAt: now - 600_000,
        lastWakeAt: 0,
        lastRestartAt: 0,
        pcStale: false,
        pcBeatMs: 0,
        pcStaleMs: PC_STALE_MS,
        rpcStallRebuildMs: RPC_STALL_REBUILD_MS,
        stats: { lastRxAt: 0, stallRebuilds: 0 },
        pcVersion: 0,
        clockOffset: 0,
        supportsAuthReplyId: false,
        pcHello: null,
        onpc() {},
        onpcStale() {},
        sweepParts() {},
        restart(reason = '') { restarts.push(reason); instance.lastRestartAt = now; },
        ...overrides,
      };
      instance.noteBeatMs = api.noteBeatMs;
      instance.noteDesktopAlive = api.noteDesktopAlive;
      return { instance, restarts };
    },
    /** 起看门狗（真实现是 2 s 一次的 setInterval）。 */
    start(instance) {
      api.startStaleWatch.call(instance);
      assert.equal(intervals.length, 1, '看门狗只注册一个间隔');
      assert.equal(intervals[0].ms, 2_000, '巡检周期必须是 2 s');
    },
    tick(instance) {
      assert.equal(intervals.length, 1);
      intervals[0].fn.call(instance);
    },
  };
}

test('外壳行为：收到 beatMs=30_000 后三个字段按公式抬高，缺字段时清零/缩小都不许发生', () => {
  const { relay } = shell();
  const { instance } = relay();
  // 一开始（老桌面）：三个字段就是老常量。
  assert.deepEqual(
    [instance.pcBeatMs, instance.pcStaleMs, instance.rpcStallRebuildMs],
    [0, PC_STALE_MS, RPC_STALL_REBUILD_MS],
  );

  instance.noteDesktopAlive({ t: 'beat', name: 'DSH', ts: 1_700_000_000_000, beatMs: 30_000 });
  assert.deepEqual(
    [instance.pcBeatMs, instance.pcStaleMs, instance.rpcStallRebuildMs],
    [30_000, 97_500, 37_500],
    '30 s 档必须把 PC_STALE 抬到 97.5 s、把 RPC_STALL 抬到 37.5 s（红线：> 一个心跳）',
  );
  assert.ok(instance.rpcStallRebuildMs > instance.pcBeatMs, '红线：重建阈值必须长于一个心跳');

  // 下一帧没有 beatMs（例如桌面某次只发了老字段 / 半截帧）：**不许**回落到 26 s/10 s。
  instance.noteDesktopAlive({ t: 'beat', name: 'DSH', ts: 1_700_000_000_000 + 30_000 });
  assert.deepEqual(
    [instance.pcBeatMs, instance.pcStaleMs, instance.rpcStallRebuildMs],
    [30_000, 97_500, 37_500],
    '拿不准时沿用已知档位（保守优先）：不能因为一帧缺字段就把阈值调小',
  );

  // 桌面切回快速档（有实时通道了）：阈值回到今天的三个数（不会更低）。
  instance.noteDesktopAlive({ t: 'beat', name: 'DSH', ts: 1_700_000_000_000 + 60_000, beatMs: 8_000 });
  assert.deepEqual(
    [instance.pcBeatMs, instance.pcStaleMs, instance.rpcStallRebuildMs],
    [8_000, PC_STALE_MS, RPC_STALL_REBUILD_MS],
  );
});

test('外壳行为：30 s 心跳跑 10 分钟，一次都不重建（老阈值在同一段时间里会重建多次）', () => {
  const shellApi = shell();
  const { instance, restarts } = shellApi.relay();
  // 先学到 30 s 档（真实路径：一帧带 beatMs 的 beat）。
  instance.noteDesktopAlive({ t: 'beat', name: 'DSH', ts: 1_700_000_000_000, beatMs: 30_000 });
  instance.stats.lastRxAt = shellApi.clockNow();
  instance.pcSeenAt = shellApi.clockNow();
  shellApi.start(instance);

  let maxSilence = 0;
  // 10 分钟 = 30 个心跳；每 2 s 巡检一次。心跳到达时才刷新"最后下行"。
  for (let step = 0; step < 300; step += 1) {
    shellApi.advance(2_000);
    const silence = shellApi.clockNow() - Math.max(instance.stats.lastRxAt, instance.pcSeenAt, instance.readyAt);
    maxSilence = Math.max(maxSilence, silence);
    if (silence >= 30_000) {
      // 桌面空闲档：30 s 一条 beat。
      instance.stats.lastRxAt = shellApi.clockNow();
      instance.pcSeenAt = shellApi.clockNow();
      instance.noteDesktopAlive({ t: 'beat', name: 'DSH', ts: shellApi.clockNow(), beatMs: 30_000 });
    }
    shellApi.tick(instance);
  }

  assert.deepEqual(restarts, [], '空闲档下 30 s 的间隔是正常的：一次重建都不许发生');
  assert.equal(instance.stats.stallRebuilds, 0);
  assert.ok(maxSilence > PC_STALE_MS,
    `这段时间里最长静默 ${maxSilence}ms 已超过老阈值 ${PC_STALE_MS}ms —— `
    + '说明"没重建"是靠推导出来的 97.5 s 挡住的，不是靠运气');
  assert.ok(maxSilence <= 30_000, '闲空档的间隔就是 30 s（不该出现更长的空档）');
});

test('外壳行为：30 s 档下"有请求在途"也要等到 > 一个心跳才重建（红线）', () => {
  const shellApi = shell();
  const { instance, restarts } = shellApi.relay();
  instance.noteDesktopAlive({ t: 'beat', name: 'DSH', ts: 1_700_000_000_000, beatMs: 30_000 });
  // 请求在最后一次下行**之后**才开始（这才是"发出去就再没收到任何东西"）。
  instance.stats.lastRxAt = shellApi.clockNow();
  instance.pcSeenAt = shellApi.clockNow();
  instance.pending.set('req-1', { id: 'req-1', at: shellApi.clockNow() + 1_000, startedAt: shellApi.clockNow() + 1_000 });
  shellApi.start(instance);

  // 静默 26 s（已经超过老的 10 s 与老的 26 s）：30 s 档下这仍然可能是正常的。
  shellApi.advance(RPC_STALL_REBUILD_MS * 2 + 6_000); // 26 s
  shellApi.tick(instance);
  assert.deepEqual(restarts, [],
    '在 30 s 心跳的链路上，26 s 没有下行还可能是"下一拍没到" —— 这里重建就是误重建');
  assert.equal(instance.pcStale, false, '同时不许把「电脑端已离线」横幅点亮');

  // 超过 37.5 s（≈1.25 个心跳）之后仍然是死的：这时才是真半死。
  shellApi.advance(37_500 - 26_000 + 2_000);
  shellApi.tick(instance);
  assert.deepEqual(restarts, ['请求在途但下行静默'],
    '超过推导阈值（37.5 s）仍静默 ⇒ 必须重建，否则在途请求只能烧完预算');
});

test('外壳行为：老桌面（没有 beatMs）仍是今天的 10 s 判据 —— 向下兼容', () => {
  const shellApi = shell();
  const { instance, restarts } = shellApi.relay();
  // 老桌面：每 8 s 一条 beat，且**不带** beatMs。
  instance.noteDesktopAlive({ t: 'beat', name: 'DSH', ts: 1_700_000_000_000 });
  assert.equal(instance.pcStaleMs, PC_STALE_MS);
  assert.equal(instance.rpcStallRebuildMs, RPC_STALL_REBUILD_MS);
  instance.stats.lastRxAt = shellApi.clockNow();
  instance.pcSeenAt = shellApi.clockNow();
  instance.pending.set('req-old', { id: 'req-old', at: shellApi.clockNow() + 1_000, startedAt: shellApi.clockNow() + 1_000 });
  shellApi.start(instance);

  shellApi.advance(RPC_STALL_REBUILD_MS + 2_000);
  shellApi.tick(instance);
  assert.deepEqual(restarts, ['请求在途但下行静默'],
    '老桌面必须保持 1.0.10 的灵敏度（10 s）：兼容不是"变迟钝"');
});
