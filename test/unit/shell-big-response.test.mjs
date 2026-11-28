/**
 * 大响应端到端：**桌面真实发帧 → 外壳真实收帧/重组 → 应用真实读到对象**。
 *
 * 为什么不只是"测 `decompressGzip()` 一个函数"：手机端那份 jank 是"收包后这一段"
 * 整条链的账 —— 信封解封、分片重组、body base64、解压、Response、应用 `JSON.parse`。
 * 单测一个函数证明不了"改完还是同一份字节、而且真的少搬了一趟"。
 *
 * 这条用例里**没有一处是手抄的实现**：
 *   - 发：`_support/envelope.mjs` 的 `makeLink()` 造的是**真的 `CloudLink`**，
 *     `publish()` 走真的 `seal()`、真的 64 KiB 分片（`lib/cloud.mjs`）；
 *   - 收：`tools/build-shell.mjs` 的产物里真的 `Relay.onMessage()`（真 AES-GCM 解封 +
 *     真 `PartTable` 重组）；
 *   - 传：真的 `installFetch()`（真 base64 解码 + 真 `DecompressionStream`）；
 *   - 用：真的 `web/lib/net.js` 的 `createApi()`。
 *
 * 断言分两类：
 *   1. **正确性**：应用拿到的对象与原对象 deepEqual；解压后的字节 sha256 与原字节相同
 *      （单帧与两片两条路径都覆盖）；外壳自己的 Response 体也仍然等价（旧应用能用）。
 *   2. **计数**（改坏就变红）：`Blob` 构造 0 次、`Response` 从字节构造 0 次、
 *      `response.text()` 0 次（说明应用走的是 `pocketBytes` 零拷贝通道）；
 *      大字符串 `JSON.parse` 次数必须是协议下限（单帧 3 / 两片 6）。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { createApi } from '../../web/lib/net.js';
import { KEY_A, makeLink, openFrame, topicsOf } from '../_support/envelope.mjs';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const ROOM = 'roomjank';
const ORIGIN = 'https://dsh-remote.local';
const encoder = new TextEncoder();
const sha256 = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));
/** 原生 fetch：每条用例都从它重新包一层 shim，避免 shim 套 shim。 */
const nativeFetch = globalThis.fetch.bind(globalThis);

let out;
let Relay;
let installFetch;
let makeSealer;

before(async () => {
  out = await mkdtemp(join(tmpdir(), 'pocket-bigresp-'));
  await run(process.execPath, [join(ROOT, 'tools', 'build-shell.mjs'), '--out', out], { cwd: ROOT });
  ({ Relay, installFetch, makeSealer } = await import(pathToFileURL(join(out, 'remote.js')).href));
});

after(async () => {
  await rm(out, { recursive: true, force: true });
});

/* ------------------------------ 载荷 ------------------------------ */

/** 造一份"会话详情"正文，gzip 后接近 `targetGzip`。 */
function detailBodyFor(targetGzip) {
  const make = (count) => ({
    ok: true,
    data: {
      id: 'sess-jank',
      title: '会话详情',
      messages: Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `第 ${index} 条：这次会话要整理详情，重点看工具调用、分片重组与解压。`.repeat(3),
        at: 1_760_000_000_000 + index * 137,
      })),
    },
  });
  let lo = 1;
  let hi = 2;
  while (gzipSync(Buffer.from(JSON.stringify(make(hi)), 'utf8')).length < targetGzip) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (gzipSync(Buffer.from(JSON.stringify(make(mid)), 'utf8')).length >= targetGzip) hi = mid;
    else lo = mid + 1;
  }
  return make(lo);
}

/* --------------------------- 计数桩（全局，按需开） --------------------------- */

const meter = { on: false };
const counters = { blob: 0, responseFromBytes: 0, responseText: 0, bigParses: 0 };
const realBlob = globalThis.Blob;
const realResponse = globalThis.Response;
const realParse = JSON.parse;

class CountingBlob extends realBlob {
  constructor(parts, options) {
    super(parts, options);
    if (meter.on) counters.blob += 1;
  }
}
class CountingResponse extends realResponse {
  constructor(body, init) {
    super(body, init);
    // 只有"把整段字节交给 Response"才算一次整缓冲拷贝；流是零拷贝的。
    if (meter.on && body !== null
      && (ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof realBlob)) {
      counters.responseFromBytes += 1;
    }
  }
  async text() {
    if (meter.on) counters.responseText += 1;
    return super.text();
  }
}
globalThis.Blob = CountingBlob;
globalThis.Response = CountingResponse;
JSON.parse = function countingParse(text, reviver) {
  if (meter.on && typeof text === 'string' && text.length > 1024) counters.bigParses += 1;
  return realParse(text, reviver);
};
const resetCounters = () => {
  counters.blob = 0;
  counters.responseFromBytes = 0;
  counters.responseText = 0;
  counters.bigParses = 0;
};

/* --------------------------- 端到端驱动 --------------------------- */

/**
 * 跑一次完整往返。返回 { data, plain, captured, frames, counters }。
 * `captured` 是外壳返回给应用的那个 Response（用来验 pocketBytes 与流体的等价性）。
 */
async function roundTrip({ targetGzip }) {
  const body = detailBodyFor(targetGzip);
  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  const { link, sent } = makeLink({ room: ROOM, key: KEY_A });
  const sealer = await makeSealer(Buffer.from(KEY_A).toString('base64'), ROOM);

  const relay = new Relay({ room: ROOM, sealer, brokers: ['wss://broker.invalid:8084/mqtt'] });
  const upFrames = [];
  relay.ready = true;
  relay.client = {
    publish(topic, payload) {
      upFrames.push({ topic, payload: String(payload) });
    },
  };
  // 外壳的 shim 装在 window 上（生产里就是同一个 realm），Node 里给它一个最小的 window。
  globalThis.window = { fetch: nativeFetch };
  globalThis.location = { href: `${ORIGIN}/`, origin: ORIGIN };
  installFetch(relay);
  const shimFetch = globalThis.window.fetch;
  let captured = null;
  globalThis.fetch = async (...args) => {
    captured = await shimFetch(...args);
    return captured;
  };

  const api = createApi({ getBase: () => ORIGIN, getToken: () => null, onUnauthorized: () => {} });
  const pending = api('/api/v1/tasks/sess-jank');
  for (let spin = 0; spin < 100 && upFrames.length === 0; spin += 1) await tick();
  assert.equal(upFrames.length, 1, '外壳应该已经发出 1 条 req');

  // 上行也是密文：用桌面侧的解封器取回请求 id（顺带证明两个方向的 AAD 都对）。
  const request = realParse(openFrame({ key: KEY_A, aad: topicsOf(ROOM).up, envelope: upFrames[0].payload }).toString('utf8'));
  assert.equal(request.t, 'req');

  // 桌面侧真实发帧：`publish()` 会按 MAX_FRAME 自动分片、每片单独封包。
  link.publish({
    t: 'res',
    id: request.id,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    enc: 'gzip',
    body: gzipSync(plain).toString('base64'),
    ms: 7,
  });
  const frames = sent.map((entry) => realParse(
    openFrame({ key: KEY_A, aad: topicsOf(ROOM).down, envelope: entry.payload }).toString('utf8'),
  ));

  resetCounters();
  meter.on = true;
  try {
    for (const entry of sent) await relay.onMessage(encoder.encode(entry.payload), relay.client);
    // 计量窗口必须一直开到 `pending` 落定：应用侧那次 JSON.parse 是在微任务里跑的。
    const data = await pending;
    return { data, plain, captured, frames, counters: { ...counters } };
  } finally {
    meter.on = false;
  }
}

/* ------------------------------ 用例 ------------------------------ */

test('单帧（gzip ≈45 KB）：对象等价、字节 sha256 相同、且没多搬一趟', async () => {
  const { data, plain, captured, frames, counters } = await roundTrip({ targetGzip: 45 * 1024 });
  assert.equal(frames.filter((frame) => frame.t === 'part').length, 0, '这一档必须走单帧路径（否则用例覆盖的就不是它）');
  assert.equal(frames.filter((frame) => frame.t === 'res').length, 1);

  // ① 正确性：应用拿到的就是原始对象
  assert.deepEqual(data, realParse(plain.toString('utf8')).data);
  // ② 逐字节：外壳交出的解压字节与桌面 gzip 之前那份完全相同
  assert.equal(Object.prototype.toString.call(captured?.pocketBytes), '[object Uint8Array]', '外壳必须挂 pocketBytes');
  assert.equal(captured.pocketBytes.length, plain.length);
  assert.equal(sha256(captured.pocketBytes), sha256(plain), '解压后字节必须逐字节相同（sha256）');
  // ③ 旧应用也还能用：外壳自己的 Response 体与 pocketBytes 等价
  assert.equal(sha256(new Uint8Array(await captured.arrayBuffer())), sha256(plain));
  // ④ 计数：这三项是"少搬一趟"的证据，改回去就变红
  assert.equal(counters.blob, 0, '解压路径不许再建 Blob（gzip 字节的整份拷贝）');
  assert.equal(counters.responseFromBytes, 0, 'Response 不许从字节构造（那是解压后 payload 的整份拷贝）');
  assert.equal(counters.responseText, 0, '应用必须走 pocketBytes，不许再 response.text() 读流拼一块');
  assert.equal(counters.bigParses, 3, '大字符串 JSON.parse 只能是协议下限：信封 1 + 信封内层 1 + 应用 payload 1');
});

test('两片（gzip ≈58 KB）：分片重组路径同样逐字节相同、计数不退化', async () => {
  const { data, plain, captured, frames, counters } = await roundTrip({ targetGzip: 58 * 1024 });
  assert.equal(frames.filter((frame) => frame.t === 'part').length, 2, '这一档必须走两片路径');
  assert.equal(frames.filter((frame) => frame.t === 'res').length, 0, '分片时不许再单独发一条 res');

  assert.deepEqual(data, realParse(plain.toString('utf8')).data);
  assert.equal(captured.pocketBytes.length, plain.length);
  assert.equal(sha256(captured.pocketBytes), sha256(plain), '两片重组后解压的字节必须逐字节相同（sha256）');
  assert.equal(sha256(new Uint8Array(await captured.arrayBuffer())), sha256(plain));
  assert.equal(counters.blob, 0);
  assert.equal(counters.responseFromBytes, 0);
  assert.equal(counters.responseText, 0);
  // 两片：每片 2 次（信封 + 片帧）+ 合并 1 次 + 应用 payload 1 次。
  assert.equal(counters.bigParses, 6, '大字符串 JSON.parse 只能是协议下限：2 片 × 2 + 合并 1 + 应用 1');
});

test('旧外壳兼容：没有 pocketBytes 时必须回落到 response.text()，结果一样', async () => {
  const payload = { ok: true, data: { id: 'old-shell', messages: [{ role: 'user', text: '旧外壳' }] } };
  globalThis.fetch = async () => new CountingResponse(encoder.encode(JSON.stringify(payload)), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  resetCounters();
  meter.on = true;
  let data;
  try {
    data = await createApi({ getBase: () => ORIGIN, getToken: () => null, onUnauthorized: () => {} })('/api/v1/tasks/legacy');
  } finally {
    meter.on = false;
  }
  assert.deepEqual(data, payload.data, '旧外壳（无 pocketBytes）必须照旧能解析');
  assert.equal(counters.responseText, 1, '没有快速通道时必须走 response.text()');
});
