/**
 * 自适应心跳（电脑端）：空闲 30 s / 有实时通道或在途请求 8 s。
 *
 * 为什么必须有这一组：心跳周期不只是"保活"，手机端所有静默阈值都是「心跳周期的
 * 倍数」（见 `web/lib/shell-retry.js` 的 `deriveThresholds()`）。电脑端单方面把
 * 心跳拉长而手机不知道，手机就会把正常的长间隔判成"下行静默"⇒ 拆 ws 隧道、
 * 作废正在拼的分片。所以这一组钉三件事：
 *
 *  1. **档位判据**：`sockets.size > 0 || pending.size > 0` ⇒ 8 s；否则 30 s，
 *     而且进 30 s 档有前置条件 —— 手机必须在 hello 里声明 `beatAck: true`
 *     （老外壳手里写死 26 s 阈值，拉长会把它变成每 40 秒重建一次的循环）。
 *  2. **切换立即生效**：换档必须 `clearInterval` + `setInterval` 重建定时器，
 *     不能等当前这一跳走完；并且立刻补一条 beat 把新的 `beatMs` 告诉手机。
 *  3. **两个数都在帧里**：hello 与 beat 都带 `beatMs`，且与实际定时器同值。
 *
 * 全部用注入的假 `setInterval` + 假时钟跑（真等 30 s 既慢又不稳定）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeAll, feed, makeLink, stubFetch } from './_support/fixtures.mjs';
import { installFakeTimers } from './_support/fake-timers.mjs';

/** hello：`beatAck` 决定能不能进空闲档（老外壳不带这个字段）。 */
function hello({ beatAck = true, name = 'Pixel 9' } = {}) {
  const message = { t: 'hello', name, ver: 2, ts: Date.now() };
  if (beatAck) message.beatAck = true;
  return message;
}

/** 把已发出的帧全解出来，只看最近 `from` 之后的那几条。 */
function newFrames(link, sent, from) {
  return decodeAll(link, sent.slice(from));
}

/** 造一台"已在线、可达"的电脑端 + 假时钟。 */
function env(startAt = 1_700_000_000_000) {
  const clock = installFakeTimers(startAt);
  const fixture = makeLink();
  return {
    ...fixture,
    clock,
    /** 上线：注册心跳定时器（真实现由 subscribe 回调里调）。 */
    online() {
      fixture.link.state = 'online';
      fixture.link.startBeat();
    },
    finish() { clock.restore(); },
  };
}

test('自适应心跳：没收到 beatAck 声明 ⇒ 永远留在 8 s 档（老外壳零回归）', () => {
  const { link, sent, clock, online, finish } = env();
  try {
    online();
    assert.deepEqual(clock.periods(), [8_000], '默认档必须是 8 s（与 1.0.10 一致）');

    // 老外壳的 hello：没有 beatAck 字段。
    const before = sent.length;
    feed(link, hello({ beatAck: false, name: 'OldShell' }));
    assert.equal(link.phoneBeatAck, false, '老外壳不许被当成"认识 beatMs"');
    assert.deepEqual(clock.periods(), [8_000], '老外壳在的时候不许进空闲档 —— 它的 26 s 阈值是写死的');

    const answers = newFrames(link, sent, before).filter((message) => message.t === 'hello' || message.t === 'beat');
    for (const message of answers) {
      assert.equal(message.beatMs, 8_000, `${message.t} 必须带当前生效值（老外壳也读得到，只是不用）`);
    }

    // 再验证一次"档位不会因为空闲时间自己变": 空转 10 分钟仍是 8 s。
    clock.advance(10 * 60_000);
    assert.deepEqual(clock.periods(), [8_000]);
  } finally {
    finish();
  }
});

test('自适应心跳：hello 带 beatAck ⇒ 立刻切 30 s 档，hello/beat 都带 beatMs', () => {
  const { link, sent, clock, online, finish } = env();
  try {
    online();
    const before = sent.length;
    feed(link, hello());
    assert.equal(link.phoneBeatAck, true);
    assert.equal(link.beatMs, 30_000, '手机声明之后生效值必须立刻是 30 s');
    assert.deepEqual(clock.periods(), [30_000], '定时器必须**立刻**重建为 30 s，不能等这一跳走完');

    const frames = newFrames(link, sent, before);
    const helloReply = frames.find((message) => message.t === 'hello' && message.name === 'DSH');
    assert.ok(helloReply !== undefined, 'hello 回声必须发出去');
    assert.equal(helloReply.beatMs, 30_000, 'hello 也必须带 beatMs（重连/新页面全靠它）');
    const beats = frames.filter((message) => message.t === 'beat');
    assert.ok(beats.length >= 1, '换档要补一条 beat，把新周期立刻告诉手机');
    assert.equal(beats.at(-1).beatMs, 30_000, '补的那条 beat 必须是新档位的值');

    // 30 s 之后才是下一条：中间不许有 8 s 的旧节拍残留。
    const beatCount = sent.length;
    clock.advance(30_000);
    const after = newFrames(link, sent.slice(beatCount)).filter((message) => message.t === 'beat');
    assert.equal(after.length, 1, '空闲档必须恰好 30 s 一条');
    assert.equal(after[0].beatMs, 30_000);
  } finally {
    finish();
  }
});

test('自适应心跳：有在途请求 ⇒ 立刻回 8 s 档并补一条 beat（不等 30 s 走完）', async () => {
  const { link, sent, clock, online, finish } = env();
  const fetchStub = stubFetch('{"ok":true}');
  try {
    online();
    feed(link, hello());
    assert.deepEqual(clock.periods(), [30_000], '先进入空闲档');

    const before = sent.length;
    feed(link, {
      t: 'req', id: 'req-1', method: 'GET', path: '/api/v1/tasks',
      token: 't', seq: 1, sid: 'aabbccdd11223344', ts: Date.now(),
    });
    // handleRequest 是 async 的：先把微任务跑完（fetch 桩立刻 resolve）。
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.equal(link.pending.size, 0, '请求必须已经走完（否则下面断言的是"还在途"的另一段）');
    const frames = newFrames(link, sent, before);
    const beats = frames.filter((message) => message.t === 'beat');
    assert.deepEqual(beats.map((message) => message.beatMs), [8_000, 30_000],
      '请求到达 ⇒ 补一条 8 s 的 beat；请求结束（回到空闲）⇒ 再补一条 30 s 的');
    assert.ok(frames.some((message) => message.t === 'res' && message.status === 200), '请求必须成功');
    assert.deepEqual(clock.periods(), [30_000], '空闲档的定时器由 8 s 的临时档回到 30 s');

    // 关键是"立刻"：整个过程没有推进时钟，切档仍发生了 ⇒ 是重建定时器，不是等下一跳。
    assert.equal(clock.now, 1_700_000_000_000, '这一条用例一秒都没有推进时钟');
  } finally {
    fetchStub.restore();
    finish();
  }
});

test('自适应心跳：有实时通道（ws 隧道）⇒ 8 s；隧道关掉 ⇒ 立刻回 30 s', () => {
  const { link, sent, clock, online, finish } = env();
  try {
    online();
    feed(link, hello());
    assert.deepEqual(clock.periods(), [30_000]);

    // 用假 socket 走**真实**的 `handleSocketOpen`（不连本机 127.0.0.1）。
    const handlers = new Map();
    link.createSocket = () => ({
      readyState: 1,
      on(event, callback) { handlers.set(event, callback); return this; },
      send() {},
      close() {},
    });
    const before = sent.length;
    feed(link, { t: 'ws.open', id: 'abcdef12', path: '/ws', sid: 'aabbccdd11223344', ts: Date.now(), seq: 1 });
    assert.equal(link.sockets.size, 1);
    assert.deepEqual(clock.periods(), [8_000], '有实时通道必须回到快速档（手机在等 WS 帧）');
    const beats = newFrames(link, sent, before).filter((message) => message.t === 'beat');
    assert.deepEqual(beats.map((message) => message.beatMs), [8_000], '换档补的 beat 要带 8 s');

    // 手机主动关隧道：真实 `handleSocketClose` 路径。
    link.handleSocketClose({ id: 'abcdef12', token: 't' });
    assert.equal(link.sockets.size, 0);
    assert.equal(link.beatMs, 30_000, '没有人等 WS 帧了 ⇒ 立刻回到空闲档');
    assert.deepEqual(clock.periods(), [30_000]);
  } finally {
    finish();
  }
});

test('自适应心跳：空闲一整天 2880 条 beat（旧行为 10800 条）—— 量化被用例钉住', () => {
  const { link, sent, clock, online, finish } = env();
  try {
    online();
    feed(link, hello());
    const before = sent.length;
    clock.advance(24 * 60 * 60 * 1000);
    const frames = newFrames(link, sent, before);
    const beats = frames.filter((message) => message.t === 'beat');
    assert.equal(beats.length, 2_880, '86400 / 30 = 2880 条；旧行为是 86400 / 8 = 10800 条');
    // 信封长度稳定（只跟字段与 base64 对齐有关）：实测 189 B/条。
    // 2880 × 189 ≈ 532 KiB/天；旧行为 10800 × 189 ≈ 1.95 MiB/天。
    const sizes = frames
      .map((message, index) => (message.t === 'beat' ? Buffer.byteLength(sent[before + index].payload) : 0))
      .filter((size) => size > 0);
    assert.equal(sizes.length, 2_880);
    const wire = sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(sizes.every((size) => size >= 170 && size <= 230),
      `单条 beat 的密封报文应在 170~230 B（实测 ${Math.min(...sizes)}~${Math.max(...sizes)} B）`);
    assert.ok(wire >= 2_880 * 170 && wire <= 2_880 * 230,
      `空闲一天的 beat 报文总量应落在 2880×170~230 B（实测 ${wire} B，即 ${(wire / 1024).toFixed(1)} KiB）`);
  } finally {
    finish();
  }
});

test('自适应心跳：看门狗阈值跟着档位放宽（30 s 心跳下 20 s 无 ACK 不算死链）', () => {
  const { link, clock, online, finish } = env();
  try {
    online();
    feed(link, hello());
    assert.equal(link.beatMs, 30_000);
    assert.equal(link.linkStaleMs(), 60_000, '空闲档：2 × 30 s（保持与快速档同样的"2 个 beat"余量）');

    // 30 s 心跳下，一条健康链路的两次 ACK 相隔 30 s —— 17 s 的旧阈值会把它判死。
    link.client = { connected: true, publish() {}, end() {} };
    link.connect = () => { throw new Error('健康链路不许重建'); };
    link.connectedAt = clock.now - 60_000;
    link.lastRxAt = clock.now - 600_000;
    for (const at of [0, 3_000, 6_000, 9_000, 12_000, 15_000, 20_000, 25_000, 30_000]) {
      link.lastTxAckAt = clock.now - 20_000; // 最近 20 s 没有 ACK，但下一次 beat 还没到
      assert.equal(link.checkLink(clock.now + at), false,
        `第 ${at / 1000}s：20 s 无 ACK 在 30 s 档是正常的，不许判死`);
    }
    assert.equal(link.linkStrikes, 0);

    // 回到快速档时阈值也回到 17 s（不许把快速档的灵敏度弄丢）。
    link.phoneBeatAck = false;
    link.beatMs = 8_000;
    assert.equal(link.linkStaleMs(), 17_000);
  } finally {
    finish();
  }
});
