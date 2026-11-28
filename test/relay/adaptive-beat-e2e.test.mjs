/**
 * 端到端：**桌面空闲档（beatMs=30 s）的链路不许触发一次误重建**。
 *
 * 这是本轮最重要的一条判据。链路是真的：电脑端用生产 `lib/cloud.mjs` 的
 * `CloudLink`（真密封信封、真 `hello`/`beat`/`req`/`res` 帧、真档位切换），
 * 手机端用**生产源码切出来的** `noteDesktopAlive()` / `noteBeatMs()` /
 * `startStaleWatch()`（`test/support/shell-source.mjs` 的 vm 切片）与真模块
 * `deriveThresholds()`。中间只把一个变量换成可控的：时间（假定时器 + 假时钟）。
 *
 * 判据三条：
 *  1. 空闲 10 分钟 / 一整天：`restart()` **调用次数必须为 0**；
 *  2. 但同一段时间里"最长静默"必须**超过老阈值 26 s**（否则这条用例只是在
 *     证明"没跑够长"，不能证明推导出来的阈值挡住了误判）；
 *  3. 期间发的每个请求都必须成功，并且桌面收到请求后会立刻把 `beatMs=8_000`
 *     补下来（手机阈值随即回到今天的 10 s/26 s）——"进入交互后不迟钝"。
 *
 * 这一条同时也是"改坏取证"的落点：把 `noteBeatMs()` 改回固定常量，或把
 * `hello`/`beat` 里的 `beatMs` 去掉，它都会在 t≈26 s 处红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';

import { PC_STALE_MS, RPC_STALL_REBUILD_MS, deriveThresholds } from '../../web/lib/shell-retry.js';
import { readRepoFile, runSlices, sliceConst, sliceMethod } from '../support/shell-source.mjs';
import { decodeAll, feed, makeLink, stubFetch } from './_support/fixtures.mjs';
import { installFakeTimers } from './_support/fake-timers.mjs';

const SOURCE = readRepoFile('remote/remote.js');
const T0 = 1_700_000_000_000;
const SID = 'aabbccdd11223344';

/**
 * 手机端实例 = 生产源码切出来的方法 + 用例自己准备的字段。
 *
 * 字段清单照着 `remote/remote.js` 的 `Relay` 构造函数来（多一个少一个都会让
 * 切片跑偏），`setInterval` 走假定时器 → 外壳看门狗与电脑端心跳共用一条时间线。
 */
function phoneStub(clock) {
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
    globals: { deriveThresholds, __setInterval: (fn, ms) => clock.register(fn, ms) },
    clock: () => clock.now,
  });

  const restarts = [];
  const events = { beats: 0, maxSilence: 0, responses: [] };
  const phone = {
    // ---- Relay 的字段（只留这些方法会碰的） ----
    staleTimer: undefined,
    ready: true,
    pending: new Map(),
    pcSeenAt: 0,
    readyAt: clock.now,
    lastWakeAt: 0,
    lastRestartAt: 0,
    pcStale: false,
    pcBeatMs: 0,
    pcStaleMs: PC_STALE_MS,
    rpcStallRebuildMs: RPC_STALL_REBUILD_MS,
    pcVersion: 0,
    pcHello: null,
    clockOffset: 0,
    supportsAuthReplyId: false,
    stats: { lastRxAt: 0, stallRebuilds: 0 },
    // ---- 生产方法（切片） ----
    noteBeatMs: api.noteBeatMs,
    noteDesktopAlive: api.noteDesktopAlive,
    // ---- 用例的钩子 ----
    onpc() {},
    onpcStale() {},
    sweepParts() {},
    restart(reason = '') {
      restarts.push({ reason, at: clock.now });
      phone.lastRestartAt = clock.now;
    },
    /** 起 2 s 一次的下行静默看门狗（真实现由 `main()` 调用）。 */
    startWatch() { api.startStaleWatch.call(phone); },
    /** 一条下行帧到达（真实现是 `onMessage` 解封之后的分发）。 */
    receive(message) {
      if (message.t === 'hello' || message.t === 'beat') {
        phone.stats.lastRxAt = clock.now;
        phone.noteDesktopAlive(message);
        events.beats += 1;
        return;
      }
      if (message.t === 'res') {
        const entry = phone.pending.get(String(message.id ?? ''));
        if (entry === undefined) return;
        phone.pending.delete(entry.id);
        events.responses.push({ id: entry.id, status: message.status, latencyMs: performance.now() - entry.wallAt });
        return;
      }
      assert.fail(`手机端不该收到 ${message.t} 帧（这条用例只有 beat/hello/res）`);
    },
    /** 记一次"巡检时看到的静默"（诊断用：证明这段时间真的超过老阈值）。 */
    noteSilence() {
      const lastDownAt = Math.max(phone.stats.lastRxAt, phone.pcSeenAt, phone.readyAt);
      events.maxSilence = Math.max(events.maxSilence, clock.now - lastDownAt);
    },
  };
  return { phone, restarts, events };
}

/** 造一条真实链路：电脑端 CloudLink（真帧）+ 手机端切片 + 假时间。 */
function makeEnv({ beatAck = true } = {}) {
  const clock = installFakeTimers(T0);
  const { link, sent, logger } = makeLink();
  const fetchStub = stubFetch('{"ok":true}');
  const { phone, restarts, events } = phoneStub(clock);

  let cursor = 0;
  let seq = 0;
  const env = {
    clock, link, sent, logger, phone, restarts, events, fetchStub,
    /** 把电脑端新发出的帧投递给手机（"网络"这一层，按顺序）。 */
    pump() {
      while (cursor < sent.length) {
        const entry = sent[cursor];
        cursor += 1;
        const message = decodeAll(link, [entry])[0];
        assert.notEqual(message.t, 'part', '本用例的响应都很小，不该出现分片帧');
        phone.receive(message);
      }
    },
    /** 手机上线（真外壳在 connect 之后调 `announce()`）。 */
    announce() {
      const hello = { t: 'hello', name: 'Pixel 9', ver: 2, ts: clock.now, beatAck };
      feed(link, hello);
    },
    /** 发一条 RPC（真外壳的 `request()` 只差 mqtt 那一层）。 */
    request(id, path = '/api/v1/tasks') {
      seq += 1;
      const entry = { id, at: clock.now, startedAt: clock.now, wallAt: performance.now() };
      phone.pending.set(id, entry);
      feed(link, {
        t: 'req', id, method: 'GET', path, token: 'devtoken', seq, sid: SID, ts: clock.now,
      });
      return entry;
    },
    /** 推进假时间，2 s 一步（手机看门狗的巡检周期），每步之后投递新帧。 */
    run(ms) {
      const step = 2_000;
      let left = ms;
      while (left > 0) {
        clock.advance(Math.min(step, left));
        env.pump();
        phone.noteSilence();
        left -= step;
      }
    },
    finish() {
      fetchStub.restore();
      clock.restore();
    },
  };
  return env;
}

/** 让 microtask / `setImmediate` 跑完（`handleRequest` 是 async 的）。 */
async function settle() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

test('端到端：桌面空闲档 30 s 跑 10 分钟，restart 次数为 0 且最长静默已超过老阈值', async () => {
  const env = makeEnv();
  try {
    env.link.startBeat();
    assert.deepEqual(env.clock.periods(), [8_000], '还没收到 hello：先按老节奏 8 s');

    env.announce();
    env.pump();
    assert.equal(env.link.phoneBeatAck, true, '桌面必须记住手机声明过 beatAck');
    assert.equal(env.link.beatMs, 30_000, '声明之后立刻进空闲档');
    assert.deepEqual(env.clock.periods(), [30_000], '定时器立刻重建（不等这一跳走完）');

    // 手机学到了 30 s 档，三个阈值按公式抬高。
    assert.equal(env.phone.pcBeatMs, 30_000);
    assert.equal(env.phone.pcStaleMs, 97_500);
    assert.equal(env.phone.rpcStallRebuildMs, 37_500);
    assert.ok(env.phone.rpcStallRebuildMs > env.phone.pcBeatMs, '红线：重建阈值必须长于一个心跳');

    env.phone.startWatch();
    env.run(10 * 60_000);

    assert.deepEqual(env.restarts, [], '空闲档 30 s 的间隔是正常的：一次重建都不许发生');
    assert.equal(env.phone.stats.stallRebuilds, 0);
    assert.ok(env.events.beats >= 20,
      `10 分钟应收到约 20 条 beat（实际 ${env.events.beats}）—— 说明链路真的在跑，不是"没数据所以没重建"`);
    assert.ok(env.events.maxSilence > PC_STALE_MS,
      `最长静默 ${env.events.maxSilence}ms 必须超过老阈值 ${PC_STALE_MS}ms：`
      + '否则这条用例证明不了"推导把误判挡住了"（老代码会在 26 s 处重建）');
    assert.ok(env.events.maxSilence <= 32_000,
      `最长静默不该超过一个空闲间隔太多（实际 ${env.events.maxSilence}ms）`);
  } finally {
    env.finish();
  }
});

test('端到端：请求进来立刻切回 8 s（手机阈值随之回落），请求全部成功，之后回空闲档', async () => {
  const env = makeEnv();
  try {
    env.link.startBeat();
    env.announce();
    env.pump();
    env.phone.startWatch();
    env.run(5 * 60_000);
    assert.equal(env.phone.pcStaleMs, 97_500);

    for (let index = 0; index < 3; index += 1) {
      env.request(`req-${index}`);
      // 请求刚到达（同步，还没等 fetch）：桌面必须已经切回快速档并补了 beat。
      assert.equal(env.link.pending.size, 1, '请求应该还在途中');
      assert.equal(env.link.beatMs, 8_000, '请求一到就切快速档，不是等下一跳');
      env.pump();
      assert.equal(env.phone.pcBeatMs, 8_000, `第 ${index} 个请求：手机必须学到 8 s 档`);
      assert.equal(env.phone.rpcStallRebuildMs, RPC_STALL_REBUILD_MS,
        '阈值只能回到今天的 10 s，不能更低，也不能还停在 37.5 s');
      assert.equal(env.phone.pcStaleMs, PC_STALE_MS);

      await settle();
      env.pump();
      assert.equal(env.events.responses.length, index + 1, `第 ${index} 个请求必须有回包`);
      env.run(2_000);
      // 请求结束 ⇒ 回到空闲档；手机收到 beatMs=30_000 后阈值重新抬高。
      assert.equal(env.link.beatMs, 30_000);
      assert.equal(env.phone.pcStaleMs, 97_500, '回到空闲档后手机也必须跟着抬高（否则下一次长间隔会被误判）');
    }

    assert.equal(env.events.responses.length, 3, '三个请求必须都有回包');
    for (const response of env.events.responses) assert.equal(response.status, 200);
    assert.deepEqual(env.restarts, [], '请求期间也不许重建');

    // 请求结束、又没人等 WS 帧 ⇒ 回到空闲档（并补一条 beat 通知手机）。
    env.run(10_000);
    assert.equal(env.link.beatMs, 30_000, '没有在途请求了 ⇒ 回空闲档');
    assert.equal(env.phone.pcStaleMs, 97_500, '手机必须跟着学到 30 s（否则下一次长间隔会被它误判）');
    assert.deepEqual(env.restarts, []);
  } finally {
    env.finish();
  }
});

test('端到端：空闲一整天 2880 条 beat、0 次重建（量化口径与误重建在同一条链路上）', async () => {
  const env = makeEnv();
  try {
    env.link.startBeat();
    env.announce();
    env.pump();
    env.phone.startWatch();
    const before = env.events.beats;
    env.run(24 * 60 * 60 * 1000);
    const beats = env.events.beats - before;
    // 24 h / 30 s = 2880；边界上差一条是可接受的（最后一段不足一格）。
    assert.ok(beats >= 2_879 && beats <= 2_881,
      `空闲一天应约 2880 条 beat（86400/30），实际 ${beats} 条；旧行为是 10800 条`);
    assert.deepEqual(env.restarts, [], '一整天空闲也不许重建一次');
    assert.ok(env.events.maxSilence > PC_STALE_MS);
  } finally {
    env.finish();
  }
});

test('端到端：有请求时的开销不变（同一场景 120 次 RPC，自适应档 p95 不退化）', async () => {
  /** 跑一批请求，返回 `performance.now()` 量到的中继往返（不含模拟网络时延）。 */
  async function batch(env, count) {
    const latencies = [];
    for (let index = 0; index < count; index += 1) {
      const before = env.events.responses.length;
      env.request(`bench-${index}`);
      await settle();
      env.pump();
      const last = env.events.responses.at(-1);
      assert.ok(env.events.responses.length > before && last !== undefined, '请求必须有回包');
      latencies.push(last.latencyMs);
    }
    latencies.sort((a, b) => a - b);
    const pick = (p) => latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)];
    return { p50: pick(0.5), p95: pick(0.95), max: latencies.at(-1) };
  }

  // 两个环境**串行**建/拆：假定时器是进程级替换，嵌套安装会让 restore() 恢复成
  // 上一个假的（时钟冻住）。所以一批跑完再换下一批。
  let before;
  const legacy = makeEnv({ beatAck: false });
  try {
    // 改前：老外壳（桌面不认识 beatAck）⇒ 全程 8 s 档，与 1.0.10 的执行路径一致。
    legacy.link.startBeat();
    legacy.announce();
    legacy.pump();
    legacy.phone.startWatch();
    before = await batch(legacy, 120);
    assert.deepEqual(legacy.restarts, []);
  } finally {
    legacy.finish();
  }

  let after;
  const adaptive = makeEnv();
  try {
    // 改后：自适应（空闲 30 s，请求一来就回 8 s 档，并多补 2 条档位 beat）。
    adaptive.link.startBeat();
    adaptive.announce();
    adaptive.pump();
    adaptive.phone.startWatch();
    after = await batch(adaptive, 120);
    assert.deepEqual(adaptive.restarts, []);
  } finally {
    adaptive.finish();
  }

  assert.ok(after.p95 <= before.p95 + 5,
    `自适应档的 p95（${after.p95.toFixed(3)}ms）不许比改前（${before.p95.toFixed(3)}ms）退化`);
  // 数字留在断言消息里，`--test-reporter=spec` 失败时能直接看到口径。
  assert.ok(after.p95 < 20, `p95 绝对上界（实测 ${after.p95.toFixed(3)}ms）`);
  console.log(`[p95] 改前(8 s 档) p50=${before.p50.toFixed(3)}ms p95=${before.p95.toFixed(3)}ms `
    + `max=${before.max.toFixed(3)}ms；改后(自适应) p50=${after.p50.toFixed(3)}ms `
    + `p95=${after.p95.toFixed(3)}ms max=${after.max.toFixed(3)}ms`);
});
