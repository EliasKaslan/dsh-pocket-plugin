/**
 * 手机端（外壳）信封 v3a 的行为测试 —— 全部从 `remote/remote.js` **切生产代码**跑。
 *
 * 覆盖这一侧真正会出错的地方：
 *  1. `makeSealer().sealBinary()` 的线上形状与安全参数（AAD / IV / tag 与 v2 完全一致）；
 *  2. `unseal()` 的分流：字符串 = v2、字节 = 按首字节选 v2/v3、坏首字节/截断必须抛；
 *  3. `announce()` 里 `proto: 3` 与 `ver: 2` **各自独立**（老桌面只看 `ver`）；
 *  4. `noteDesktopAlive()` 的协商状态：每帧重写、缺 `proto` 必须回落 0（保守 v2）；
 *  5. `send()` 按 `pcProto` 选信封，分片时每一片同版本；`restart()` 清零重来。
 *
 * 这些用例存在的理由：手机端是**已经发到浏览器缓存里的外壳**，升级不由我们控制。
 * 老外壳拿到二进制帧会当坏帧丢掉、链路静默断掉 —— 所以"默认 v2、声明才 v3、
 * 回落必须立刻生效"这三条得被钉死。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_ENVELOPE_PROTOCOL } from '../../lib/cloud.mjs';
import { deriveThresholds } from '../../web/lib/shell-retry.js';
import { plain, readRepoFile, runSlices, sliceConst, sliceFunction, sliceMethod } from '../support/shell-source.mjs';

const SOURCE = readRepoFile('remote/remote.js');
const ROOM = 'room-v3-shell';
const KEY = Buffer.alloc(32, 0x5a);
const KEY_B64 = KEY.toString('base64url');
const UP = `dshm/${ROOM}/u`;
const DOWN = `dshm/${ROOM}/d`;
/** 明文哨兵：base64 字母表里没有 `-`，随机撞不上。 */
const CANARY = 'SHELL-V3-PLAINTEXT-CANARY-77b1';

/** 一次切齐：信封 / 发送 / 协商 / 常量。切片方式与 `test/support` 里的一致。 */
function shellEnv() {
  return runSlices({
    declarations: [
      { name: 'B64_CHUNK_BYTES', source: sliceConst(SOURCE, 'B64_CHUNK_BYTES') },
      { name: 'b64', source: sliceFunction(SOURCE, 'b64') },
      { name: 'unb64', source: sliceFunction(SOURCE, 'unb64') },
      { name: 'unb64u', source: sliceFunction(SOURCE, 'unb64u') },
      { name: 'randomId', source: sliceFunction(SOURCE, 'randomId') },
      { name: 'encoder', source: 'const encoder = new TextEncoder();' },
      { name: 'decoder', source: 'const decoder = new TextDecoder();' },
      { name: 'makeSealer', source: sliceFunction(SOURCE, 'makeSealer') },
      { name: 'send', source: sliceMethod(SOURCE, 'send') },
      { name: 'announce', source: sliceMethod(SOURCE, 'announce') },
      { name: 'restart', source: sliceMethod(SOURCE, 'restart') },
      { name: 'noteBeatMs', source: sliceMethod(SOURCE, 'noteBeatMs') },
      { name: 'noteDesktopAlive', source: sliceMethod(SOURCE, 'noteDesktopAlive') },
      { name: 'PROTOCOL', source: sliceConst(SOURCE, 'PROTOCOL') },
      { name: 'ENVELOPE_PROTOCOL', source: sliceConst(SOURCE, 'ENVELOPE_PROTOCOL') },
      { name: 'HELLO_MIN_GAP_MS', source: sliceConst(SOURCE, 'HELLO_MIN_GAP_MS') },
      { name: 'MAX_FRAME', source: sliceConst(SOURCE, 'MAX_FRAME') },
      { name: 'PART_MAX_TOTAL', source: sliceConst(SOURCE, 'PART_MAX_TOTAL') },
    ],
    globals: { crypto: globalThis.crypto, deriveThresholds },
  });
}

const env = shellEnv();
const sealer = await env.makeSealer(KEY_B64, ROOM);

/** 桌面方向的帧（手机发出去的）：形状与线上 `req` 一致。 */
const FRAME = {
  t: 'req',
  id: 'a1b2c3d4e5f60718',
  sid: 'abcdef01',
  seq: 3,
  ts: 1_700_000_000_000,
  method: 'GET',
  path: '/api/v1/tasks',
  token: 'session-token',
};

/** 按线上形态解一帧（测试侧镜像，用来读 `send()` 真正发出去的字节）。 */
async function openAny(bytes, aad) {
  const buffer = ArrayBuffer.isView(bytes) ? Buffer.from(bytes) : Buffer.from(String(bytes), 'utf8');
  if (buffer.length > 0 && buffer[0] === 0x03) {
    const { createDecipheriv } = await import('node:crypto');
    const decipher = createDecipheriv('aes-256-gcm', KEY, buffer.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    const blob = buffer.subarray(13);
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
  }
  const { openFrame } = await import('../_support/envelope.mjs');
  return openFrame({ key: KEY, aad, envelope: buffer.toString('utf8') });
}

/** 能跑切出来的 `send()` 的手机替身。 */
function relayStub({ pcProto, published = [] } = {}) {
  const relay = {
    ready: true,
    superseded: false,
    session: { token: 'session-token' },
    upTopic: UP,
    stats: { tx: 0 },
    sealer,
    pcProto,
    client: {
      publish(topic, payload) {
        const bytes = ArrayBuffer.isView(payload) ? Buffer.from(payload) : Buffer.from(String(payload), 'utf8');
        published.push({ topic: String(topic), bytes, raw: payload });
        return true;
      },
    },
  };
  return { relay, published };
}

/** `noteDesktopAlive()` 会碰的字段（照 `Relay` 构造函数里的清单）。 */
function relayInstance() {
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

/* --------------------------- 1. 两端的编号各自独立 ---------------------- */

test('协议编号：信封 proto = 3，帧协议 ver 仍是 2；桌面导出值与外壳逐值一致', () => {
  assert.equal(env.ENVELOPE_PROTOCOL, 3, '外壳声明的信封协议必须是 3');
  assert.equal(env.PROTOCOL, 2, '帧协议仍是 2（老桌面只看 ver，改它等于换协议）');
  assert.equal(CLOUD_ENVELOPE_PROTOCOL, env.ENVELOPE_PROTOCOL, '桌面导出的信封协议号必须与外壳一致（防两端漂移）');
  assert.notEqual(env.ENVELOPE_PROTOCOL, env.PROTOCOL, '把信封号塞进 ver 就是协议漂移');
});

/* ------------------------------ 2. sealBinary --------------------------- */

test('sealBinary：v3 形状 [0x03][iv 12][ct][tag 16]，IV 每次随机，明文哨兵不上线', async () => {
  const frame = { ...FRAME, note: CANARY };
  const plaintext = Buffer.byteLength(JSON.stringify(frame), 'utf8');
  const bytes = Buffer.from(await sealer.sealBinary(frame, UP));

  assert.equal(bytes[0], 0x03, '首字节必须是版本号 0x03');
  assert.equal(bytes.length, plaintext + 1 + 12 + 16, '长度 = 1 + 12 + 明文 + 16');
  assert.equal(bytes.subarray(1, 13).length, 12, 'IV 必须 12 字节（GCM 标准 nonce）');
  assert.equal(bytes.includes(Buffer.from(CANARY)), false, 'payload 里出现明文 = E2EE 失效');

  const again = Buffer.from(await sealer.sealBinary(frame, UP));
  assert.notEqual(
    bytes.subarray(1, 13).toString('hex'),
    again.subarray(1, 13).toString('hex'),
    '两次封装必须用不同 IV（随机性没被协商动过）',
  );
  assert.notEqual(bytes.subarray(13).toString('hex'), again.subarray(13).toString('hex'));

  // 解出来逐字节相等；换 AAD 必须失败（AAD = 主题串，方向靠它钉住）。
  assert.equal(JSON.stringify(plain(await sealer.unseal(bytes, UP))), JSON.stringify(frame));
  await assert.rejects(() => sealer.unseal(bytes, DOWN), 'AAD 不对必须解不开');
  const wrongKey = await env.makeSealer(Buffer.alloc(32, 0x11).toString('base64url'), ROOM);
  await assert.rejects(() => wrongKey.unseal(bytes, UP), '钥匙不对必须解不开');
});

test('seal（v2）形状不变：{v:1,n,c} 标准 base64，与 v3 只差"怎么装"', async () => {
  const v2 = await sealer.seal(FRAME, UP);
  const envelope = JSON.parse(v2);
  assert.deepEqual(Object.keys(envelope).sort(), ['c', 'n', 'v']);
  assert.equal(envelope.v, 1, 'v2 信封自己的版本号仍是 1（与 SEAL_VERSION 一致）');
  assert.equal(Buffer.from(envelope.n, 'base64').length, 12);
  assert.equal(
    Buffer.from(envelope.c, 'base64').length,
    Buffer.byteLength(JSON.stringify(FRAME), 'utf8') + 16,
    'v2 密文 = 明文 + 16 字节 tag',
  );
  assert.equal(JSON.stringify(plain(await sealer.unseal(v2, UP))), JSON.stringify(FRAME));

  // 同一个明文，v3 的密文部分必须能对上 v2 的密文长度（tag 一样是 16 字节）。
  const binary = Buffer.from(await sealer.sealBinary(FRAME, UP));
  assert.equal(binary.length - 29, Buffer.from(envelope.c, 'base64').length - 16);
});

/* ------------------------------ 3. unseal 分流 -------------------------- */

test('unseal 分流：v2 字符串 / v2 字节 / v3 字节都能解；坏首字节、截断、空帧必须抛', async () => {
  const v2Text = await sealer.seal(FRAME, UP);
  const v3Bytes = await sealer.sealBinary(FRAME, UP);
  const expected = JSON.stringify(FRAME);

  // ① v2：字符串（老桌面在 mqtt.js 的 Node/浏览器两种 payload 上都会走到这两种形态）。
  assert.equal(JSON.stringify(plain(await sealer.unseal(v2Text, UP))), expected);
  // ② v2：字节（`onMessage` 不再先 decode，首字节 `{` 时由 sealer 自己解码）。
  assert.equal(JSON.stringify(plain(await sealer.unseal(Buffer.from(v2Text, 'utf8'), UP))), expected);
  // ③ v3：二进制。
  assert.equal(JSON.stringify(plain(await sealer.unseal(v3Bytes, UP))), expected);

  // ④ 坏首字节：必须抛（不许猜，猜错只会把密文当明文喂给 JSON.parse）。
  await assert.rejects(() => sealer.unseal(new Uint8Array([0x00, 1, 2, 3]), UP), /信封版本不正确/u);
  await assert.rejects(() => sealer.unseal(new Uint8Array(0), UP), /信封版本不正确/u);
  // ⑤ 截断：只有 [0x03][iv] 或只有 [0x03][iv][tag] —— 都必须抛，且不能崩。
  const full = Buffer.from(v3Bytes);
  await assert.rejects(() => sealer.unseal(full.subarray(0, 13), UP), /信封内容不正确/u);
  await assert.rejects(() => sealer.unseal(full.subarray(0, 29), UP), /信封内容不正确/u);
  // ⑥ 密文被改一个字节：GCM 校验必须失败。
  const tampered = Buffer.from(full);
  tampered[tampered.length - 1] ^= 0x01;
  await assert.rejects(() => sealer.unseal(tampered, UP));
});

/* ----------------------------- 4. announce ------------------------------ */

test('announce：hello 同时带 proto:3 与 ver:2（老桌面忽略 proto、行为不变）', () => {
  const sent = [];
  const relay = {
    lastHelloAt: 0,
    phoneName: '新手机',
    serverNow: () => 1_700_000_000_000,
    send(frame) {
      sent.push(frame);
      return Promise.resolve();
    },
  };
  env.announce.call(relay);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'hello');
  assert.equal(sent[0].ver, env.PROTOCOL, 'ver 语义不许变（老桌面只认它）');
  assert.equal(sent[0].proto, env.ENVELOPE_PROTOCOL, 'proto 是新字段，只表示"认识二进制信封"');
  assert.equal(sent[0].beatAck, true, '既有能力位不能被这次改动挤掉');

  // 10 s 内再 announce 必须被限流（既有行为不变）。
  env.announce.call(relay);
  assert.equal(sent.length, 1);
});

/* ------------------------ 5. noteDesktopAlive 协商状态 ------------------ */

test('noteDesktopAlive：学到 proto≥3 才用 v3；缺字段/脏值必须回落 0（保守 v2）', () => {
  const instance = relayInstance();
  const alive = (message) => { env.noteDesktopAlive.call(instance, message); return instance.pcProto; };

  assert.equal(alive({ t: 'hello', name: 'DSH', ver: 2, proto: 3, ts: Date.now() }), 3);
  // 每一帧都重写：老桌面（没有 proto）必须把状态压回 0。
  assert.equal(alive({ t: 'beat', name: 'DSH', ver: 2, ts: Date.now() }), 0, '缺 proto 必须回落 0');
  assert.equal(alive({ t: 'beat', name: 'DSH', ver: 2, proto: 2, ts: Date.now() }), 2);
  assert.equal(alive({ t: 'beat', name: 'DSH', ver: 2, proto: 0, ts: Date.now() }), 0);
  assert.equal(alive({ t: 'beat', name: 'DSH', proto: 'abc' }), 0, '脏值不许变成 NaN 之外的"看起来认识"');
  assert.equal(alive({ t: 'beat', name: 'DSH', proto: -1 }), 0);
  // `ver` 的学习不受影响（两个编号各管一层）。
  assert.equal(instance.pcVersion, 2);
});

/* ------------------------------ 6. send -------------------------------- */

test('send：pcProto < 3 / 缺失 ⇒ v2；≥ 3 ⇒ v3，且帧内容完全一样', async () => {
  for (const [label, pcProto, expected] of [
    ['还没收到桌面声明（缺失）', undefined, 0x7b],
    ['老桌面 0', 0, 0x7b],
    ['老桌面 2', 2, 0x7b],
    ['新桌面 3', 3, 0x03],
    ['新桌面 4（未来版本）', 4, 0x03],
  ]) {
    const { relay, published } = relayStub({ pcProto });
    await env.send.call(relay, { ...FRAME });
    assert.equal(published.length, 1, `${label}：一帧就该一条 MQTT 消息`);
    assert.equal(published[0].bytes[0], expected, `${label}：信封版本不对`);
    const opened = JSON.parse((await openAny(published[0].bytes, UP)).toString('utf8'));
    assert.equal(JSON.stringify({ ...opened, token: undefined }), JSON.stringify({ ...FRAME, token: undefined }),
      `${label}：帧内容必须与 v2 路径逐字节一致`);
  }
});

test('send 分片：> MAX_FRAME 时每一片同版本，v3 分片能被解出并拼回原始帧', async () => {
  const bigBody = 'A'.repeat(70 * 1024); // 70 KB → 一定超过 MAX_FRAME(64 KiB)
  const bigFrame = { ...FRAME, t: 'req', method: 'POST', body: bigBody };
  const raw = Buffer.byteLength(JSON.stringify(bigFrame), 'utf8');
  assert.ok(raw > env.MAX_FRAME);

  const { relay, published } = relayStub({ pcProto: 3 });
  await env.send.call(relay, bigFrame);
  assert.ok(published.length > 1, '必须分片');
  for (const entry of published) assert.equal(entry.bytes[0], 0x03, 'v3 协商后每一片都必须是 v3');

  const parts = [];
  for (const entry of published) parts.push(plain(await sealer.unseal(entry.bytes, UP)));
  assert.deepEqual(parts.map((part) => part.t), new Array(parts.length).fill('part'));
  assert.deepEqual(parts.map((part) => part.seq), parts.map((_item, index) => index));
  assert.equal(new Set(parts.map((part) => part.id)).size, 1);
  const reassembled = Buffer.concat(parts.map((part) => Buffer.from(part.d, 'base64'))).toString('utf8');
  assert.equal(reassembled, JSON.stringify({ ...bigFrame, token: 'session-token' }));

  // 同一个大帧在未协商时必须是 v2（老桌面要能解）。
  const legacy = relayStub({ pcProto: 0 });
  await env.send.call(legacy.relay, bigFrame);
  for (const entry of legacy.published) assert.equal(entry.bytes[0], 0x7b, '未协商时分片也必须 v2');
});

/* ----------------------------- 7. restart ------------------------------- */

test('restart：重建链路时把 pcProto 清零（换了一条链路就从"不知道对面"重新开始）', async () => {
  const relay = {
    superseded: false,
    disposed: false,
    restarting: false,
    fastRetryTimer: undefined,
    restartCount: 3,
    linkEpoch: 7,
    lastRestartAt: 0,
    client: { end() {} },
    ready: true,
    readyAt: 123,
    downSince: 0,
    pcHello: { name: 'DSH' },
    pcProto: 3,
    pcStale: true,
    abortTransport() {},
    onstate() {},
    async connect() {},
    noteRelayOk() {},
    onpcStale() {},
    announce() {},
    resendPending() {},
    startStaleWatch() {},
  };
  const result = await env.restart.call(relay, '测试');
  assert.equal(result, true);
  assert.equal(relay.pcProto, 0, 'restart 后必须回到"未协商"（默认 v2）');
  assert.equal(relay.pcHello, null);
  assert.equal(relay.restartCount, 0);
});
