/**
 * 跨实现互操作：`test/support/relay-client.mjs`（Node 版「手机端」探测器）
 * ↔ `docs/remote.js`（真正发到手机上、由浏览器执行的外壳）。
 *
 * 为什么要这一组：仓库里有**两份**协议实现——外壳一份（`docs/remote.js`，
 * `makeSealer()` / `send()`），电脑端一份（`lib/cloud.mjs`）。探测器是第三份
 * （独立重写，这样才能在格式漂移时打红）。前两份只要有一份改了信封细节
 * （AAD 取值、base64 变体、`v` 号、分片边界），探测器就会**静默地测错东西**：
 * 它的用例仍然绿，但它测的不再是线上协议。所以这里让外壳的真实代码与探测器
 * 直接对撞：
 *
 *   1. 外壳 `makeSealer().seal()` 封的帧，探测器必须解得开；反之亦然；
 *   2. AAD 必须真的绑定到方向上（拿 up 的帧去解 down 必须失败）；
 *   3. 常量（协议版本 / MAX_FRAME / 分片上限 / RPC 预算）与主题模板必须一致；
 *   4. 上行帧的字段集合、令牌挂载规则、> MAX_FRAME 的分片形状必须一致。
 *
 * 全部离线：不 import `mqtt`、不连 broker、不读 `~/.dsh`。外壳的 `send()` 与
 * `makeSealer()` 是从 `docs/remote.js` 里**切出来真跑**的（见 `shell-source.mjs`），
 * 不是对源码做正则。`docs/remote.js` 与 `remote/remote.js` 的同步由
 * `node tools/build-shell.mjs --check` 负责（CI 必跑）。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  CLOUD_PROTOCOL, MAX_FRAME, PART_MAX_TOTAL, RPC_TIMEOUT_MS, SEAL_VERSION,
  createRelayClient, openFrame, sealFrame, topicsOf,
} from './relay-client.mjs';
import {
  plain, readRepoFile, runSlices, sliceConst, sliceFunction, sliceMethod,
} from './shell-source.mjs';

const shell = readRepoFile('docs/remote.js');
const ROOM = 'interop-room-7f';
const KEY_B64 = Buffer.alloc(32, 0x5a).toString('base64url');
const KEY = Buffer.from(KEY_B64, 'base64url');
const TOPICS = topicsOf(ROOM);

/** 外壳里与信封/分片/帧构造有关的那几段，切出来在 vm 里执行。 */
function shellEnv() {
  return runSlices({
    declarations: [
      { name: 'b64', source: sliceFunction(shell, 'b64') },
      { name: 'unb64', source: sliceFunction(shell, 'unb64') },
      { name: 'unb64u', source: sliceFunction(shell, 'unb64u') },
      { name: 'randomId', source: sliceFunction(shell, 'randomId') },
      { name: 'encoder', source: 'const encoder = new TextEncoder();' },
      { name: 'decoder', source: 'const decoder = new TextDecoder();' },
      { name: 'makeSealer', source: sliceFunction(shell, 'makeSealer') },
      { name: 'PROTOCOL', source: sliceConst(shell, 'PROTOCOL') },
      { name: 'MAX_FRAME', source: sliceConst(shell, 'MAX_FRAME') },
      { name: 'PART_MAX_TOTAL', source: sliceConst(shell, 'PART_MAX_TOTAL') },
      { name: 'RPC_TIMEOUT_MS', source: sliceConst(shell, 'RPC_TIMEOUT_MS') },
      { name: 'SEND_READY_WAIT_MS', source: sliceConst(shell, 'SEND_READY_WAIT_MS') },
      { name: 'send', source: sliceMethod(shell, 'send') },
    ],
    // 外壳的 makeSealer 用 crypto.getRandomValues + crypto.subtle；Node 24 自带。
    globals: { crypto: globalThis.crypto },
  });
}

/** 把一段 `this.xxxTopic = ...;` 的右值切出来（主题模板在类构造函数里）。 */
function topicTemplate(field) {
  const line = shell.split(/\r?\n/u).find((item) => item.includes(`this.${field} =`));
  assert.ok(line !== undefined, `外壳里找不到 this.${field} 的赋值`);
  return line.slice(line.indexOf('=') + 1, line.lastIndexOf(';')).trim();
}

test('信封互通：外壳 makeSealer() 与 relay-client 的 seal/open 双向互开，AAD 绑定方向', async () => {
  const env = shellEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const frame = { t: 'req', id: 'a1b2c3d4e5f60718', sid: 'abcdef01', seq: 3, ts: 1_700_000_000_000, method: 'GET', path: '/api/v1/tasks' };

  // ① 外壳封 → 探测器解
  const fromShell = await sealer.seal(frame, TOPICS.up);
  const opened = openFrame(KEY, TOPICS.up, fromShell);
  assert.deepEqual(plain(JSON.parse(opened.toString('utf8'))), frame, '外壳封的帧，探测器必须解出同一份明文');

  // ② 探测器封 → 外壳解
  const fromProbe = sealFrame(KEY, TOPICS.down, JSON.stringify(frame));
  const unsealed = await sealer.unseal(fromProbe, TOPICS.down);
  assert.deepEqual(plain(unsealed), frame, '探测器封的帧，外壳必须解出同一份明文');

  // ③ 信封字段：v 号一致、IV 12 字节、密文含 16 字节 GCM tag、`n`/`c` 是标准 base64
  const parsed = JSON.parse(fromShell);
  assert.deepEqual(Object.keys(parsed).sort(), ['c', 'n', 'v'], '信封字段集合必须是 {v,n,c}');
  assert.equal(parsed.v, SEAL_VERSION, '信封版本必须与探测器的 SEAL_VERSION 一致');
  assert.equal(Buffer.from(parsed.n, 'base64').length, 12, 'IV 必须是 12 字节（GCM 标准 nonce）');
  assert.equal(Buffer.from(parsed.c, 'base64').length, Buffer.byteLength(JSON.stringify(frame), 'utf8') + 16,
    '密文长度必须是明文 + 16 字节 GCM tag');
  for (const field of ['n', 'c']) {
    assert.equal(/[-_]/u.test(parsed[field]), false, `信封的 ${field} 是标准 base64（不带 -/_），与探测器一致`);
  }
  // 外壳自己的信封与探测器的信封必须同构：把探测器封的那帧再拆一遍。
  const probeParsed = JSON.parse(fromProbe);
  assert.deepEqual(Object.keys(probeParsed).sort(), Object.keys(parsed).sort(), '两份实现封出来的信封字段必须同构');
  assert.equal(probeParsed.v, parsed.v);

  // ④ AAD 绑定方向：拿 up 的帧按 down 去解必须失败（否则上下行可以互相串）
  assert.throws(() => openFrame(KEY, TOPICS.down, fromShell), /unable to authenticate|bad/i,
    '探测器用错 AAD 必须解不开（AAD = 主题串）');
  await assert.rejects(() => sealer.unseal(fromShell, TOPICS.down), '外壳用错 AAD 也必须解不开');
  // 换错密钥同样必须失败。
  assert.throws(() => openFrame(Buffer.alloc(32, 0x11), TOPICS.up, fromShell), /unable to authenticate|bad/i);
});

test('常量与主题模板：协议版本 / MAX_FRAME / 分片上限 / RPC 预算 / dshm 主题与外壳逐字一致', () => {
  const env = shellEnv();
  assert.equal(CLOUD_PROTOCOL, env.PROTOCOL, 'CLOUD_PROTOCOL 必须等于外壳的 PROTOCOL');
  assert.equal(MAX_FRAME, env.MAX_FRAME, 'MAX_FRAME 必须与外壳一致（分片边界靠它）');
  assert.equal(PART_MAX_TOTAL, env.PART_MAX_TOTAL, 'PART_MAX_TOTAL 必须与外壳一致');
  assert.equal(RPC_TIMEOUT_MS, env.RPC_TIMEOUT_MS, 'RPC 预算必须与外壳一致（超时语义靠它）');

  const topics = runSlices({
    declarations: [
      { name: 'room', source: `const room = ${JSON.stringify(ROOM)};` },
      { name: 'up', source: `const up = ${topicTemplate('upTopic')};` },
      { name: 'down', source: `const down = ${topicTemplate('downTopic')};` },
    ],
  });
  assert.deepEqual({ up: topics.up, down: topics.down }, TOPICS, '主题模板必须是 dshm/<room>/u 与 dshm/<room>/d');
});

/**
 * 让探测器在**完全离线**的假 transport 上跑起来，返回它 publish 出去的信封。
 * 订阅/发布回调都同步触发，所以不依赖任何时钟。
 */
async function probeChannel({ token = '' } = {}) {
  const published = [];
  const transport = {
    connected: true,
    on() { return transport; },
    subscribe(_topic, _options, callback) { callback?.(null); return transport; },
    publish(topic, payload, _options, callback) {
      published.push({ topic: String(topic), envelope: String(payload) });
      callback?.(null);
      return true;
    },
    end() {},
  };
  const client = createRelayClient({ room: ROOM, key: KEY_B64, token, name: 'InteropPhone', transport });
  await client.connect({ announce: false });
  return { client, published };
}

/** 让外壳的真实 `send()` 跑起来：sealer 用外壳自己的实现，publish 只收集，不发网络。 */
async function shellChannel({ token = null } = {}) {
  const env = shellEnv();
  const sealer = await env.makeSealer(KEY_B64, ROOM);
  const published = [];
  const relay = {
    ready: true,
    superseded: false,
    session: token === null ? null : { token },
    upTopic: TOPICS.up,
    stats: { tx: 0 },
    client: {
      publish(topic, sealed) {
        published.push({ topic: String(topic), envelope: String(sealed) });
        return true;
      },
    },
    sealer,
  };
  const dispatch = async (object) => {
    await env.send.call(relay, object);
  };
  return { published, dispatch };
}

/** 把一侧 publish 出去的信封全部解成明文帧。 */
function unsealAll(published) {
  return published.map((entry) => {
    assert.equal(entry.topic, TOPICS.up, `上行只允许发到 ${TOPICS.up}`);
    return JSON.parse(openFrame(KEY, TOPICS.up, entry.envelope).toString('utf8'));
  });
}

test('上行帧一致：令牌只挂在 auth/req/ws.*、字段集合与外壳相同', async () => {
  const shellSide = await shellChannel({ token: 'SESSION-TOKEN-9f3a' });
  const probeSide = await probeChannel({ token: 'SESSION-TOKEN-9f3a' });
  try {
    const hello = { t: 'hello', name: '手机', ver: CLOUD_PROTOCOL, ts: 1_700_000_000_000 };
    const req = { t: 'req', id: 'a1b2c3d4e5f60718', sid: 'abcdef01', seq: 1, ts: 1_700_000_000_000, method: 'GET', path: '/api/v1/tasks' };
    const wsOpen = { t: 'ws.open', id: 'ffeeddccbbaa9988', sid: 'abcdef01', seq: 2, ts: 1_700_000_000_000, path: '/ws?ticket=t' };

    for (const frame of [hello, req, wsOpen]) {
      await shellSide.dispatch(frame);
      await probeSide.client.send(frame);
    }

    const shellFrames = unsealAll(shellSide.published);
    const probeFrames = unsealAll(probeSide.published);
    assert.equal(shellFrames.length, 3);
    assert.equal(probeFrames.length, 3);

    for (const [index, name] of ['hello', 'req', 'ws.open'].entries()) {
      assert.deepEqual(Object.keys(probeFrames[index]).sort(), Object.keys(shellFrames[index]).sort(),
        `${name} 帧的字段集合必须与外壳一致（多一个少一个都是协议漂移）`);
    }
    // 令牌规则：hello 不带，req / ws.open 带（电脑端逐帧无状态校验）。
    assert.equal(Object.hasOwn(shellFrames[0], 'token'), false, '外壳的 hello 不带令牌');
    assert.equal(Object.hasOwn(probeFrames[0], 'token'), false, '探测器的 hello 也不许带令牌（旧实现无条件挂令牌）');
    assert.equal(shellFrames[1].token, 'SESSION-TOKEN-9f3a');
    assert.equal(probeFrames[1].token, 'SESSION-TOKEN-9f3a', 'req 必须挂会话令牌');
    assert.equal(probeFrames[2].token, 'SESSION-TOKEN-9f3a', 'ws.open 必须挂会话令牌');

    // 非敏感字段要逐字一致；`sid` 必须是 8 位小写 hex（电脑端按它分页面实例）。
    for (const [index, frame] of probeFrames.entries()) {
      assert.equal(frame.t, shellFrames[index].t);
      assert.equal(frame.ts, shellFrames[index].ts);
      if (Object.hasOwn(frame, 'sid')) assert.match(frame.sid, /^[0-9a-f]{8}$/u, 'sid 必须是 8 位小写 hex');
      if (Object.hasOwn(frame, 'id')) assert.match(frame.id, /^[0-9a-f]{16}$/u, 'id 必须是 16 位小写 hex');
    }

    // 没有会话时两条实现都不许凭空造令牌。
    const shellAnon = await shellChannel({ token: null });
    const probeAnon = await probeChannel({ token: '' });
    await shellAnon.dispatch(req);
    await probeAnon.client.send(req);
    assert.equal(Object.hasOwn(unsealAll(shellAnon.published)[0], 'token'), false);
    assert.equal(Object.hasOwn(unsealAll(probeAnon.published)[0], 'token'), false);
  } finally {
    probeSide.client.close();
  }
});

test('上行分片一致：> MAX_FRAME 时两者都拆 part，形状与重组结果逐字节一致', async () => {
  const shellSide = await shellChannel();
  const probeSide = await probeChannel();
  try {
    // 70 KB 的 base64 正文：算上 JSON 外壳一定超过 MAX_FRAME（64 KiB），必须分 2 片。
    const body = randomBytes(70 * 1024).toString('base64');
    const frame = { t: 'req', id: '00112233445566aa', sid: 'abcdef01', seq: 1, ts: 1_700_000_000_000, method: 'POST', path: '/api/v1/tasks', body };

    await shellSide.dispatch(frame);
    await probeSide.client.send(frame);

    const shellParts = unsealAll(shellSide.published);
    const probeParts = unsealAll(probeSide.published);
    assert.equal(shellParts.length > 1, true, '外壳自己必须分片');
    assert.equal(probeParts.length, shellParts.length, `分片数必须与外壳一致（外壳 ${shellParts.length} / 探测器 ${probeParts.length}）`);

    for (const [index, part] of probeParts.entries()) {
      assert.deepEqual(Object.keys(part).sort(), Object.keys(shellParts[index]).sort(),
        'part 帧的字段集合必须与外壳一致（{t,id,seq,total,d}）');
      assert.equal(part.t, 'part');
      assert.match(part.id, /^[0-9a-f]{12}$/u, '分片 id 必须是 12 位小写 hex（电脑端按它重组）');
      assert.equal(part.seq, index, 'seq 必须从 0 连续递增');
      assert.equal(part.total, probeParts.length);
      assert.equal(part.total, shellParts[index].total);
      assert.equal(Buffer.from(part.d, 'base64').length, Buffer.from(shellParts[index].d, 'base64').length,
        '每一片的明文字节数必须与外壳切在同一刀上');
      assert.equal(Buffer.from(part.d, 'base64').length <= MAX_FRAME, true, '单片明文不得超过 MAX_FRAME');
    }
    assert.equal(new Set(probeParts.map((part) => part.id)).size, 1, '同一次拆分的 id 必须相同');

    const reassembled = Buffer.concat(probeParts.map((part) => Buffer.from(part.d, 'base64'))).toString('utf8');
    assert.deepEqual(plain(JSON.parse(reassembled)), frame, '分片重组后必须还原成原始 req 帧');
  } finally {
    probeSide.client.close();
  }
});
