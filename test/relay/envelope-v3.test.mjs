/**
 * 信封 v3a：**二进制信封 + 版本协商**（本轮改动的唯一落点）。
 *
 * 线上形态（v3）：
 *
 *     [0x03]        1 字节版本
 *     [iv]          12 字节随机
 *     [ciphertext]  明文加密后的密文
 *     [tag]         16 字节 GCM tag
 *
 * AAD（主题串 utf8）/ 钥匙（32 字节原始）/ IV 随机性 / tag 长度全部与 v2 相同，
 * 变的只是"密文怎么装进 MQTT payload"：v2 是 `{"v":1,"n":b64(iv),"c":b64(ct‖tag)}`，
 * 多一层 base64（+33%）和一层 JSON 壳（收端多一次 `JSON.parse`）。
 *
 * 这一组钉四件事，其中每一条都能被"改坏"打红：
 *  1. **形状**：v3 就是这 29 字节开销的二进制；v2 路径的 JSON 形状仍然没变；
 *  2. **互开**：桌面 `publish()` 封的帧，手机端**生产源码切出来的** `makeSealer()`
 *     必须能解；反之亦然，且两个方向的明文逐字节相等；
 *  3. **分流**：入站 `0x7B`=v2 / `0x03`=v3 / 其它=丢弃+计数（不抛） / 截断=抛错；
 *  4. **协商矩阵**：老手机+新桌面、新手机+老桌面、双新、还没收到对端 `proto`
 *     —— 上行与下行**各自**判断，未协商一律 v2（保守优先）。
 *
 * 第 4 条是这次改动的真正风险面：桌面与手机是两份独立部署的代码（手机端是已经
 * 发到浏览器缓存里的外壳），任何一侧都可能是旧的。老外壳拿到二进制帧会当坏帧
 * 丢掉，整条链路就**静默**断掉 —— 所以能力必须显式声明、缺失必须降级。
 *
 * 手机端的实现不复制：用 `test/support/shell-source.mjs` 从 `remote/remote.js`
 * 切 `makeSealer()` / `send()` / `noteDesktopAlive()` 到 vm 里真跑。
 */
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { CloudLink, CLOUD_ENVELOPE_PROTOCOL, MAX_FRAME } from '../../lib/cloud.mjs';
import { deriveThresholds } from '../../web/lib/shell-retry.js';
import { openFrame } from '../_support/envelope.mjs';
import { readRepoFile, runSlices, sliceConst, sliceFunction, sliceMethod } from '../support/shell-source.mjs';
import { KEY, frameFor, identityFor, makeLogger } from './_support/fixtures.mjs';

const ROOM = 'room-v3-envelope';
const KEY_B64 = KEY.toString('base64url');
const SHELL = readRepoFile('remote/remote.js');
/** 明文哨兵：base64/二进制里都不可能随机出现（带 `-`，base64 字母表没有它）。 */
const CANARY = 'V3-ENVELOPE-PLAINTEXT-CANARY-c41d';

/* ------------------------------- 夹具 ---------------------------------- */

/**
 * 手机端：从**生产源码**切出信封与发送相关的那几段，在 vm 里真跑。
 *
 * 声明清单与 `test/support/relay-client.interop.test.mjs` 保持一致 —— 那份被
 * `shell-source.mjs` 钉着，这里不重复发明切片方式。
 */
function phoneEnv() {
  return runSlices({
    declarations: [
      { name: 'B64_CHUNK_BYTES', source: sliceConst(SHELL, 'B64_CHUNK_BYTES') },
      { name: 'b64', source: sliceFunction(SHELL, 'b64') },
      { name: 'unb64', source: sliceFunction(SHELL, 'unb64') },
      { name: 'unb64u', source: sliceFunction(SHELL, 'unb64u') },
      { name: 'randomId', source: sliceFunction(SHELL, 'randomId') },
      { name: 'encoder', source: 'const encoder = new TextEncoder();' },
      { name: 'decoder', source: 'const decoder = new TextDecoder();' },
      { name: 'makeSealer', source: sliceFunction(SHELL, 'makeSealer') },
      { name: 'send', source: sliceMethod(SHELL, 'send') },
      { name: 'noteBeatMs', source: sliceMethod(SHELL, 'noteBeatMs') },
      { name: 'noteDesktopAlive', source: sliceMethod(SHELL, 'noteDesktopAlive') },
      { name: 'PROTOCOL', source: sliceConst(SHELL, 'PROTOCOL') },
      { name: 'ENVELOPE_PROTOCOL', source: sliceConst(SHELL, 'ENVELOPE_PROTOCOL') },
      { name: 'MAX_FRAME', source: sliceConst(SHELL, 'MAX_FRAME') },
      { name: 'PART_MAX_TOTAL', source: sliceConst(SHELL, 'PART_MAX_TOTAL') },
    ],
    globals: { crypto: globalThis.crypto, deriveThresholds },
  });
}

/** 桌面端：真的 `CloudLink`，但假 client 把**原始字节**记下来（v3 不是字符串）。 */
function makeWireLink({ room = ROOM, key = KEY } = {}) {
  const link = new CloudLink({
    localPort: 1,
    identity: identityFor({ room, key }),
    allowAnonymous: true,
    logger: makeLogger(),
  });
  const sent = [];
  link.state = 'online';
  link.client = {
    publish(topic, payload, _options, callback) {
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      sent.push({ topic, bytes });
      if (typeof callback === 'function') callback();
      return true;
    },
    end() {},
  };
  return { link, sent };
}

/** 线上信封 → 明文 Buffer。**镜像实现**（信封格式本身是被测契约）。 */
function openAny(key, aad, envelope) {
  const bytes = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  if (bytes.length > 0 && bytes[0] === 0x03) {
    const iv = bytes.subarray(1, 13);
    const blob = bytes.subarray(13);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
  }
  return openFrame({ key, aad, envelope: bytes.toString('utf8') });
}

function decodeDown(link, entry) {
  return JSON.parse(openAny(link.key, link.topics.down, entry.bytes).toString('utf8'));
}

/** 手机端「收到桌面 hello/beat 时学到了什么」—— 直接跑生产方法。 */
function phoneLearns(env, instance, message) {
  env.noteDesktopAlive.call(instance, message);
  return instance.pcProto;
}

/** 一个能跑切出来的 `send()` 的手机端替身：只留 `send` 会碰的字段。 */
function phoneRelayStub({ env, sealer, pcProto = 0 }) {
  const published = [];
  const relay = {
    ready: true,
    superseded: false,
    session: null,
    upTopic: `dshm/${ROOM}/u`,
    stats: { tx: 0 },
    sealer,
    pcProto,
    client: {
      publish(topic, payload) {
        // 注意 `ArrayBuffer.isView` 而不是 `instanceof`：payload 可能是 vm 沙箱里
        // 造出来的 Uint8Array，跨 realm 时 `instanceof` 为 false（会退化成字符串）。
        const bytes = ArrayBuffer.isView(payload) ? Buffer.from(payload) : Buffer.from(String(payload), 'utf8');
        published.push({ topic: String(topic), bytes });
        return true;
      },
    },
  };
  return { relay, published, send: (frame) => env.send.call(relay, frame) };
}

/** 手机端更像真外壳的最小实例（`noteDesktopAlive` 会碰这些字段）。 */
function phoneInstance(env) {
  return {
    pcProto: 0,
    pcVersion: 0,
    pcHello: null,
    pcSeenAt: 0,
    pcBeatMs: 0,
    pcStaleMs: 0,
    rpcStallRebuildMs: 0,
    supportsAuthReplyId: false,
    clockOffset: 0,
    noteBeatMs: env.noteBeatMs,
    onpc() {},
  };
}

/** 统计一次同步调用里 `JSON.parse` 被调用了几次（v2 信封每帧要多一次）。 */
function countJsonParses(fn) {
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = function counting(text, reviver) {
    calls += 1;
    return original.call(this, text, reviver);
  };
  try {
    return { result: fn(), calls };
  } finally {
    JSON.parse = original;
  }
}

/* ------------------------- 1. 信封形状（v3 / v2） ----------------------- */

test('v3 信封形状：[0x03][iv 12][密文][tag 16]，payload 不再是 JSON', () => {
  const { link, sent } = makeWireLink();
  // 未协商 ⇒ 默认 v2（老格式）——这一条同时保证"默认路径没被偷偷换成 v3"。
  assert.equal(link.publish({ t: 'hello', name: CANARY }), true);
  assert.equal(sent[0].bytes[0], 0x7b, '未协商时必须还是 `{` 开头的 v2 JSON');
  assert.equal(JSON.parse(sent[0].bytes.toString('utf8')).v, 1);

  // 手机声明 proto:3 ⇒ 下行改用 v3。
  assert.equal(CLOUD_ENVELOPE_PROTOCOL, 3);
  link.onFrame(v2HelloFrame(link, { proto: CLOUD_ENVELOPE_PROTOCOL }));
  assert.equal(link.phoneProto, 3);
  assert.equal(link.wantsBinaryDownlink(), true);

  sent.length = 0;
  const frame = { t: 'hello', name: CANARY, nested: { text: '中文也要原样回来' } };
  const plaintext = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  assert.equal(link.publish(frame), true);
  const a = sent[0].bytes;
  assert.equal(a[0], 0x03, 'v3 首字节必须是 0x03');
  assert.equal(a.length, plaintext + 29, '长度必须是 明文 + 1 + 12 + 16');
  assert.equal(Buffer.from(a).includes(Buffer.from(CANARY)), false, '线上出现明文 = E2EE 失效');
  assert.throws(() => JSON.parse(a.toString('utf8')), 'v3 payload 不许是 JSON 文本');
  // 解出来的明文逐字节等于封进去的 JSON。
  assert.equal(openAny(link.key, link.topics.down, a).toString('utf8'), JSON.stringify(frame));

  // 同一份明文两次：IV 不同、密文不同（IV 随机性没有被协商动过）。
  assert.equal(link.publish(frame), true);
  const b = sent[1].bytes;
  assert.notEqual(a.subarray(1, 13).toString('hex'), b.subarray(1, 13).toString('hex'), '两次封装的 IV 必须不同');
  assert.notDeepEqual(a.subarray(13), b.subarray(13), 'IV 不同则密文不同');
  // tag 仍然是 16 字节：去掉 tag 后密文长度 = 明文长度。
  assert.equal(a.length - 13 - 16, plaintext, 'tag 必须正好 16 字节');
});

/* --------------------------- 2. 双向互开（逐字节） ---------------------- */

test('信封互开：桌面封 → 手机 unseal、手机 sealBinary → 桌面 onFrame，两向明文逐字节相等', async () => {
  const env = phoneEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const { link, sent } = makeWireLink();

  // ① 桌面 → 手机：协商后 publish 出来的是 v3，手机端生产 sealer 能解。
  link.onFrame(v2HelloFrame(link, { proto: 3 }));
  sent.length = 0;
  const frame = {
    t: 'res', id: 'a1b2c3d4e5f60718', status: 200, headers: { 'content-type': 'application/json' },
    enc: 'gzip', body: 'AQIDBA==', ms: 12, nested: { text: '中文也要原样回来' },
  };
  link.publish(frame);
  const phoneSaw = await sealer.unseal(sent[0].bytes, link.topics.down);
  assert.equal(JSON.stringify(phoneSaw), JSON.stringify(frame), '手机解出的明文必须与桌面封进去的逐字节一致');

  // ② 手机 → 桌面：手机 sealBinary 出来的是 v3，真实 onFrame 能解。
  const { link: peer, sent: peerSent } = makeWireLink();
  peer.topics = { up: link.topics.down, down: link.topics.up };
  const seen = [];
  peer.dispatch = (message) => { seen.push(message); };
  const upBytes = await sealer.sealBinary(frame, peer.topics.up);
  assert.equal(upBytes[0], 0x03);
  assert.equal(peerSent.length, 0, '手机这一侧不该有任何下行');
  peer.onFrame(Buffer.from(upBytes));
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen[0]), JSON.stringify(frame), '桌面解出的明文必须与手机封进去的逐字节一致');

  // ③ 两个方向的信封都只有密文：明文哨兵一个都不许出现。
  assert.equal(sent[0].bytes.includes(Buffer.from(CANARY)), false);
  assert.equal(Buffer.from(upBytes).includes(Buffer.from(CANARY)), false);
});

/* ----------------------------- 3. 入站分流 ----------------------------- */

test('入站分流：v2 JSON 与 v3 二进制都能解；未知首字节丢弃+计数不抛；截断/tag 缺失抛错', async () => {
  const env = phoneEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const { link } = makeWireLink();
  const dispatched = [];
  // 记下真的被 dispatch 的帧，但**不替掉**真实分支：hello 必须照常落到 dispatch 里
  // 才会更新 `phone` / `phoneProto`（否则这条用例只是在测自己的桩）。
  const realDispatch = link.dispatch.bind(link);
  link.dispatch = (message) => { dispatched.push(message); realDispatch(message); };

  // v2：手机用老信封发 hello（首字节 `{`）→ 必须解开并记录手机状态。
  const v2Hello = frameFor(link, { t: 'hello', name: '老手机', ver: 2, ts: Date.now() });
  assert.equal(v2Hello[0], 0x7b);
  link.onFrame(v2Hello);
  assert.equal(link.phone?.name, '老手机');
  assert.equal(dispatched.length, 1);

  // v3：同一个 dispatch 路径，二进制信封必须解开。
  const v3Bytes = await sealer.sealBinary({ t: 'hello', name: '新手机', ver: 2, proto: 3, ts: Date.now() }, link.topics.up);
  link.onFrame(Buffer.from(v3Bytes));
  assert.equal(link.phone?.name, '新手机');
  assert.equal(link.phone?.proto, 3, 'hello 里的 proto 必须记下来（协商状态可诊断）');
  assert.equal(dispatched.length, 2);

  // 未知首字节：丢弃 + 计数，**不抛**（公共主题上谁都能丢垃圾）。
  const junkBefore = link.stats.junk;
  for (const junk of [Buffer.from([0x00, 1, 2, 3]), Buffer.from('not json at all', 'utf8'), Buffer.alloc(0), Buffer.alloc(1024, 0x20)]) {
    assert.equal(link.onFrame(junk), undefined, `首字节 0x${junk[0]?.toString(16) ?? '空'} 的垃圾帧不许抛`);
  }
  assert.equal(link.stats.junk, junkBefore + 4, '每一个被丢弃的垃圾帧都要计数');
  assert.equal(dispatched.length, 2, '垃圾帧绝不能进 dispatch');
  assert.equal(link.stats.rx, 2, '垃圾帧不能计入接收统计');

  // 截断：只有 `[0x03][iv]`、或只有 tag 没有密文 —— 必须抛（且不崩）。
  const full = Buffer.from(v3Bytes);
  assert.throws(() => link.onFrame(full.subarray(0, 1 + 12)), /bad envelope body/u);
  assert.throws(() => link.onFrame(full.subarray(0, 1 + 12 + 16)), /bad envelope body/u);
  assert.equal(dispatched.length, 2, '解不开的帧不能留下半截状态');

  // 比任何合法信封都大的垃圾帧保留显式拒绝（既有边界契约，见 limits/envelope 用例）。
  assert.throws(
    () => link.onFrame(Buffer.alloc(2 * MAX_FRAME, 0x20)),
    (error) => !/frame too large/u.test(error.message),
    '2*MAX_FRAME 的垃圾帧不是被长度闸拦的（但它仍然必须是"显式拒绝"）',
  );
});

/* ---------------------------- 4. 协商矩阵 ----------------------------- */

test('协商 A：老手机 + 新桌面 —— 老手机不声明 proto ⇒ 下行一律 v2 JSON', () => {
  const { link, sent } = makeWireLink();
  link.onFrame(v2HelloFrame(link, { name: '老手机' })); // 没有 proto 字段
  assert.equal(link.phoneProto, 0, '老外壳不声明能力 ⇒ 记录 0');
  assert.equal(link.wantsBinaryDownlink(), false);
  assert.equal(link.phone?.proto, 0);

  sent.length = 0;
  link.publish({ t: 'beat', name: 'DSH', ver: 2, ts: Date.now() });
  const bytes = sent[0].bytes;
  assert.equal(bytes[0], 0x7b, '给老外壳的帧必须是 `{` 开头的 v2 JSON');
  const envelope = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(envelope).sort(), ['c', 'n', 'v'], 'v2 信封字段集合不变');
  assert.equal(envelope.v, 1);
  assert.equal(decodeDown(link, sent[0]).t, 'beat');
});

test('协商 B：新手机 + 老桌面 —— 桌面不声明 proto ⇒ 上行一律 v2；收到新桌面 beat 才切 v3', async () => {
  const env = phoneEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const phone = phoneInstance(env);
  const stub = phoneRelayStub({ env, sealer });
  const frame = { t: 'req', id: 'a1b2c3d4e5f60718', sid: 'abcdef01', seq: 1, ts: Date.now(), method: 'GET', path: '/api/v1/me' };

  // 老桌面：hello/beat 里没有 `proto`（老版本的构造就是这些字段）。
  assert.equal(phoneLearns(env, phone, { t: 'hello', name: '老桌面', ver: 2, ts: Date.now(), beatAck: true }), 0);
  assert.equal(phoneLearns(env, phone, { t: 'beat', name: '老桌面', ver: 2, ts: Date.now() }), 0);
  await stub.send(frame);
  assert.equal(stub.published.length, 1);
  assert.equal(stub.published[0].bytes[0], 0x7b, '对老桌面只能发 v2 JSON');
  assert.equal(JSON.parse(stub.published[0].bytes.toString('utf8')).v, 1);

  // 换成一个新桌面（同一页面重新学到 ≥3）⇒ 立刻切 v3。
  const learned = phoneLearns(env, phone, { t: 'beat', name: 'DSH', ver: 2, proto: 3, ts: Date.now() });
  assert.equal(learned, 3);
  stub.relay.pcProto = learned;
  await stub.send(frame);
  assert.equal(stub.published[1].bytes[0], 0x03, '对声明过 proto≥3 的桌面才发 v3');
  const opened = JSON.parse(openAny(KEY, stub.relay.upTopic, stub.published[1].bytes).toString('utf8'));
  assert.deepEqual({ ...opened, token: undefined }, { ...frame, token: undefined });
});

test('协商 C：双新 —— 两个方向都是 v3，端到端各一条', async () => {
  const env = phoneEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const { link, sent } = makeWireLink();
  const phone = phoneInstance(env);
  const stub = phoneRelayStub({ env, sealer });

  // ① 手机 announce：未协商 ⇒ 上行 hello 仍是 v2，但已经带上 `proto: 3` 声明。
  await stub.send({ t: 'hello', name: '新手机', ver: env.PROTOCOL, proto: env.ENVELOPE_PROTOCOL, beatAck: true, ts: Date.now() });
  const helloBytes = stub.published[0].bytes;
  assert.equal(helloBytes[0], 0x7b, '第一帧 hello 必须仍是 v2（此时还没收到桌面声明）');
  assert.equal(JSON.parse(openAny(KEY, stub.relay.upTopic, helloBytes).toString('utf8')).proto, 3);

  // ② 桌面收到 hello 后才允许多发 v3：phoneProto=3。
  link.onFrame(helloBytes);
  assert.equal(link.phoneProto, 3);
  assert.ok(sent.length >= 1);
  for (const entry of sent) assert.equal(entry.bytes[0], 0x03, '双新之后桌面下行必须是 v3');

  // ③ 手机从桌面的应答里学到 proto ⇒ 上行也切 v3。
  const learned = phoneLearns(env, phone, decodeDown(link, sent[0]));
  assert.equal(learned, 3);
  stub.relay.pcProto = learned;

  sent.length = 0;
  const req = { t: 'req', id: 'ffeeddccbbaa9988', sid: 'abcdef01', seq: 7, ts: Date.now(), method: 'GET', path: '/api/v1/tasks' };
  await stub.send(req);
  const upBytes = stub.published[1].bytes;
  assert.equal(upBytes[0], 0x03, '双新之后上行必须是 v3');

  // ④ 桌面真实 onFrame 能解开这条 v3 上行，并真的 dispatch 到 req。
  const dispatched = [];
  link.dispatch = (message) => { dispatched.push(message); };
  link.onFrame(upBytes);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].t, 'req');
  assert.equal(dispatched[0].id, req.id);
  assert.equal(dispatched[0].path, '/api/v1/tasks');
});

test('协商 D：还没收到对端 proto（刚连上）⇒ 两侧都默认 v2', async () => {
  const env = phoneEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const { link, sent } = makeWireLink();
  const stub = phoneRelayStub({ env, sealer, pcProto: undefined });

  // 桌面：还没收到任何 hello。
  assert.equal(link.phoneProto, 0);
  assert.equal(link.phone, null);
  assert.equal(link.wantsBinaryDownlink(), false);
  assert.equal(link.publish({ t: 'beat', name: 'DSH', ver: 2, ts: Date.now() }), true);
  assert.equal(sent[0].bytes[0], 0x7b);

  // 手机：还没收到任何桌面帧（`pcProto` 甚至不存在，模拟更老的代码路径）。
  await stub.send({ t: 'hello', name: '新手机', ver: 2, proto: 3, ts: Date.now() });
  assert.equal(stub.published[0].bytes[0], 0x7b, '拿不准时上行必须 v2（老桌面 100% 能解）');
});

test('协商回落：新手机 hello 之后老手机 hello 到达 ⇒ 桌面必须退回 v2（不做"学会就一直记得"）', () => {
  const { link, sent } = makeWireLink();
  link.onFrame(v2HelloFrame(link, { name: '新手机', proto: 3 }));
  assert.equal(link.phoneProto, 3);
  sent.length = 0;
  link.publish({ t: 'beat', name: 'DSH', ver: 2, ts: Date.now() });
  assert.equal(sent[0].bytes[0], 0x03);

  // 老外壳（没有 proto）重新 announce：同一房间换了另一部老手机 / 手机降级。
  link.onFrame(v2HelloFrame(link, { name: '老手机' }));
  assert.equal(link.phoneProto, 0, '老外壳的 hello 必须把协商压回 0');
  sent.length = 0;
  link.publish({ t: 'beat', name: 'DSH', ver: 2, ts: Date.now() });
  assert.equal(sent[0].bytes[0], 0x7b, '协商回落之后不许再发二进制（老外壳会全丢）');
});

/* ------------------- 5. 字节 / JSON.parse 次数 / 耗时 ------------------- */

/** 确定性伪随机（不引依赖）：用来造不可压缩正文。 */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function randomChars(size, seed) {
  const next = prng(seed);
  let out = '';
  for (let index = 0; index < size; index += 1) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

/** 造一个 gzip 后体积≈`targetBytes` 的正文（不可压缩随机基64，与 bench 同一手法）。 */
function gzipOfSize(targetBytes, seed) {
  let size = Math.round(targetBytes / 0.75);
  let gzipped = gzipSync(Buffer.from(randomChars(size, seed), 'utf8'));
  for (let round = 0; round < 8 && Math.abs(gzipped.length - targetBytes) / targetBytes > 0.02; round += 1) {
    size = Math.max(64, Math.round((size * targetBytes) / Math.max(1, gzipped.length)));
    gzipped = gzipSync(Buffer.from(randomChars(size, seed + round + 1), 'utf8'));
  }
  return gzipped;
}

/** 详情页量级的 `res` 帧：gzip 正文装进 base64 的 `body`（与线上形状一致）。 */
function gzipResponseFrame(gzipBytes, id, seed) {
  return {
    t: 'res',
    id,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    enc: 'gzip',
    body: gzipOfSize(gzipBytes, seed).toString('base64'),
    ms: 18,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 在同一个（未协商的）链路上量：先 v2，再声明 proto:3 量 v3。 */
function measure({ gzipBytes, id, seed }) {
  const frame = gzipResponseFrame(gzipBytes, id, seed);
  const plaintext = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  const { link, sent } = makeWireLink();

  // v2
  sent.length = 0;
  assert.equal(link.publish(frame), true);
  const v2Messages = sent.map((entry) => entry.bytes);
  // v3
  link.onFrame(v2HelloFrame(link, { proto: 3 }));
  sent.length = 0;
  assert.equal(link.publish(frame), true);
  const v3Messages = sent.map((entry) => entry.bytes);
  assert.equal(v3Messages.length, v2Messages.length, '信封版本不该改变分片数（v3a 只省字节，不减少分片）');

  // JSON.parse 次数：真实 onFrame 反方向解一遍（同 id 的组，peer 主题对调）。
  const { link: peer } = makeWireLink();
  peer.topics = { up: link.topics.down, down: link.topics.up };
  peer.dispatch = () => {};
  const v2Parses = countJsonParses(() => { for (const bytes of v2Messages) peer.onFrame(bytes); }).calls;
  const v3Parses = countJsonParses(() => { for (const bytes of v3Messages) peer.onFrame(bytes); }).calls;

  // 耗时：封 = 真实 publish（含 JSON.stringify），解 = 真实 onFrame（含 JSON.parse）。
  const runs = 101;
  const sealV2 = [];
  const sealV3 = [];
  for (let index = 0; index < runs; index += 1) {
    link.phoneProto = 0;
    sent.length = 0;
    let started = process.hrtime.bigint();
    link.publish(frame);
    sealV2.push(Number(process.hrtime.bigint() - started) / 1e6);
    link.phoneProto = 3;
    sent.length = 0;
    started = process.hrtime.bigint();
    link.publish(frame);
    sealV3.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const openV2 = [];
  const openV3 = [];
  for (let index = 0; index < runs; index += 1) {
    let started = process.hrtime.bigint();
    for (const bytes of v2Messages) peer.onFrame(bytes);
    openV2.push(Number(process.hrtime.bigint() - started) / 1e6);
    started = process.hrtime.bigint();
    for (const bytes of v3Messages) peer.onFrame(bytes);
    openV3.push(Number(process.hrtime.bigint() - started) / 1e6);
  }

  const sum = (list) => list.reduce((total, item) => total + item.length, 0);
  // 每条消息里的明文字节（v2/v3 相同：分片切的是明文，信封在外层）。
  const partPlaintextBytes = v2Messages
    .map((bytes) => openAny(link.key, link.topics.down, bytes).length)
    .reduce((total, size) => total + size, 0);
  return {
    plaintext,
    messages: v2Messages.length,
    partPlaintextBytes,
    v2Bytes: sum(v2Messages),
    v3Bytes: sum(v3Messages),
    ratio: sum(v3Messages) / sum(v2Messages),
    v2Parses,
    v3Parses,
    sealV2: median(sealV2),
    sealV3: median(sealV3),
    openV2: median(openV2),
    openV3: median(openV3),
  };
}

test('字节与 JSON.parse 收益：45 KB / 58 KB(gzip) 载荷上 v3 payload < v2 的 0.8 倍', (t) => {
  const kb45 = measure({ gzipBytes: 45 * 1024, id: 'session-45k', seed: 11 });
  const kb58 = measure({ gzipBytes: 58 * 1024, id: 'session-58k', seed: 23 });

  // 载荷形状必须与基准表一致：45 KB 单帧（1 条 MQTT 消息），58 KB 必须分 2 片。
  assert.equal(kb45.messages, 1, '45 KB(gzip) 响应是单帧');
  assert.equal(kb58.messages, 2, '58 KB(gzip) 响应必须分 2 片（分片阈值 MAX_FRAME 未动）');

  for (const [label, row] of [['45 KB', kb45], ['58 KB', kb58]]) {
    // 每条 MQTT 消息只多 1（版本）+ 12（IV）+ 16（tag）字节，没有 base64、没有 JSON 壳。
    assert.equal(row.v3Bytes, row.partPlaintextBytes + 29 * row.messages, `${label}：每条消息只多 1+12+16 字节`);
    assert.ok(row.v3Bytes < row.v2Bytes * 0.8, `${label}：v3 线上字节必须 < v2 的 0.8 倍（实测 ${row.v3Bytes}/${row.v2Bytes}）`);
    // 每条 MQTT 消息少一次 `JSON.parse`（v2 要先把信封当 JSON 解一层）。
    assert.equal(row.v2Parses - row.v3Parses, row.messages, `${label}：每条消息必须少一次 JSON.parse`);
    // v2：每消息 2 次（信封 + 帧），分片组再 +1 次（拼回来的整帧）；v3：每消息 1 次。
    const reassembly = row.messages > 1 ? 1 : 0;
    assert.equal(row.v2Parses, 2 * row.messages + reassembly, `${label}：v2 = 每消息 1 次信封 + 1 次帧`);
    assert.equal(row.v3Parses, row.messages + reassembly, `${label}：v3 = 只有帧本身那一次`);
    if (row.messages === 1) {
      assert.equal(row.partPlaintextBytes, row.plaintext, `${label}：单帧的明文就是整帧 JSON`);
    } else {
      assert.ok(row.partPlaintextBytes > row.plaintext, `${label}：分片会多出 part 壳（{t,id,rid,seq,total,d}）`);
    }
    t.diagnostic(
      `${label}(gzip)：明文 ${row.plaintext} B → v2 ${row.v2Bytes} B / v3 ${row.v3Bytes} B `
      + `（${((1 - row.ratio) * 100).toFixed(1)}% 更少，${row.messages} 条消息）；`
      + `JSON.parse ${row.v2Parses} → ${row.v3Parses}；`
      + `封 ${row.sealV2.toFixed(2)}→${row.sealV3.toFixed(2)} ms，解 ${row.openV2.toFixed(2)}→${row.openV3.toFixed(2)} ms`,
    );
  }
});

/* --------------------------- 6. AAD / 钥匙绑定 -------------------------- */

test('v3 的 AAD 与钥匙绑定：换方向 / 换房间 / 换钥匙都解不开（安全参数一个没放宽）', async () => {
  const env = phoneEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const { link, sent } = makeWireLink();
  link.onFrame(v2HelloFrame(link, { proto: 3 }));
  const phoneBefore = link.phone;
  sent.length = 0;
  link.publish({ t: 'hello', name: 'from-desktop' });
  const downBytes = sent[0].bytes;

  // 对照：本方向（AAD = down 主题）能解。
  assert.equal(JSON.parse(openAny(KEY, link.topics.down, downBytes).toString('utf8')).t, 'hello');

  // 反例 1：拿 down 方向封的 v3 帧当上行喂给 `onFrame()`（AAD 是 up）→ 必须抛。
  assert.throws(() => link.onFrame(downBytes), /unable to authenticate|bad decrypt|Unsupported state/iu);

  // 反例 2：换房间（主题变了 ⇒ AAD 变了）。
  const { link: bob } = makeWireLink({ room: 'room-bob' });
  const otherRoom = await sealer.sealBinary({ t: 'hello' }, `dshm/${ROOM}/u`);
  assert.throws(() => bob.onFrame(Buffer.from(otherRoom)), /unable to authenticate|bad decrypt|Unsupported state/iu);

  // 反例 3：换钥匙封出来的 v3 帧。
  const forged = await (await env.makeSealer(Buffer.alloc(32, 0x77).toString('base64url'), ROOM))
    .sealBinary({ t: 'hello', name: 'attacker' }, link.topics.up);
  assert.throws(() => link.onFrame(Buffer.from(forged)), /unable to authenticate|bad decrypt|Unsupported state/iu);

  // 反例 4：手机端 sealer 用错 AAD 解桌面帧也必须失败。
  await assert.rejects(() => sealer.unseal(downBytes, link.topics.up));
  assert.equal(link.phone, phoneBefore, '失败的解封不能破坏已有状态');
});

/* ------------------------------- 小工具 -------------------------------- */

/**
 * 造一条手机发来的 v2 hello（`feed()` 的等价物）：`proto` 缺省 = 老外壳。
 *
 * 用真实的 v2 信封（而不是直接调 dispatch）是为了顺带证明「入站 v2 分支永远可用」
 * —— 这也是老手机 + 新桌面这个组合能跑的全部理由。
 */
function v2HelloFrame(link, { name = '手机', proto } = {}) {
  const message = { t: 'hello', name, ver: 2, ts: Date.now(), ...(proto === undefined ? {} : { proto }) };
  return frameFor(link, message);
}
