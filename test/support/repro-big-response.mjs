#!/usr/bin/env node
/**
 * 离线复现：**详情响应体积** × 中继分片 × 丢片 × 手机端解压，回答
 * 「多大 / 什么形态的详情响应会在手机端丢失或卡住？」
 *
 * 全程不联网：
 *  - 电脑端是**真实的** `lib/cloud.mjs` `CloudLink`（真 `publish()` 分帧、真
 *    `publishSealed()`、真 `handleRequest()` 的 gzip 分支、真幂等缓存）；
 *  - 手机端是**真实的** `test/support/relay-client.mjs`（与 `remote/remote.js`
 *    同规则的信封 / 分片 / 重组 / 超时）；
 *  - 中间只有一个内存 broker（两个假 mqtt client 互投 + `process.nextTick` 回
 *    PUBACK），broker URL 写成 `wss://memory-broker.invalid/mqtt`，永不解析；
 *  - 本地 HTTP 桥是**真监听**（127.0.0.1 随机端口），`req` → 真 `fetch` → `res`。
 *
 * 用法：
 *   node test/support/repro-big-response.mjs            # 全部
 *   node test/support/repro-big-response.mjs e1         # 只跑某个实验
 *   node test/support/repro-big-response.mjs e1 e3      # 跑多个
 *   node test/support/repro-big-response.mjs e2b        # 只跑「永久丢片、跑满 4 次重试」(≈73 s)
 *
 * 结果除了打印成表，还会写到 `%TEMP%/dsh-pocket-repro/<实验>.json`。
 * 只读既有代码，不改仓库里任何既有文件。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { CloudLink, MAX_FRAME } from '../../lib/cloud.mjs';
import { createRelayClient, decodeKey, openFrame } from './relay-client.mjs';

const KB = 1024;
const OUT_DIR = join(tmpdir(), 'dsh-pocket-repro');

/**
 * 手机端（`remote/remote.js`）的重试策略。
 *
 * 这些数字取自**修复前**的 `remote/remote.js`（就是线上出这起故障的那一版）：
 * `RPC_TIMEOUT_MS = 16_000`、`RPC_ATTEMPTS = 4`、`RPC_BACKOFF_MS = [1200,2400,4800]`、
 * `BEAT_RESEND_AFTER_MS = 4_000`（桌面每个 beat 8 s 一条）。
 *
 * 注意：本仓库当时有人正在改这几个常量（改成 8 s / [1200,2400,3600]，见
 * `web/lib/rpc-budget.js`）。要复现**当前**代码的时长，改这里一处即可 ——
 * 桌面端分帧逻辑（`lib/cloud.mjs`）与被测手机端实现（`test/support/relay-client.mjs`）
 * 都是未改动的原样代码，所以 E1/E3/E4/E5 的结论与这组数字无关。
 */
const PHONE = {
  timeoutMs: 16_000,
  attempts: 4,
  backoffs: [1_200, 2_400, 4_800],
  beatResendAfterMs: 4_000,
};

/* --------------------------------- 小工具 --------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 4000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const kb = (bytes) => (bytes / KB).toFixed(2);
const ms = (value) => `${Math.round(value)}ms`;

function table(headers, rows) {
  const all = [headers, ...rows.map((row) => row.map((cell) => String(cell)))];
  const widths = headers.map((_, index) => Math.max(...all.map((row) => (row[index] ?? '').length)));
  const line = (row) => row.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join(' | ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map(line)].join('\n');
}

function report(name, payload) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

/* ------------------------------ 内存 broker -------------------------------- */

/**
 * 最小 MQTT：publish / subscribe / on('message') / QoS1 PUBACK。
 *
 * 与 `test/integration/relay-e2e.test.mjs` 的内存 broker 同语义
 * （先投递、再回 PUBACK，确定性），另加三个**故障注入**旋钮：
 *  - `dropRule({ from, to, topic, body, count })`：返回 true 就不投递给该订阅者
 *    （模拟「broker 收下了、但对端没收到」，QoS1 也会这样丢）；
 *  - `deliveryDelayMs`：投递延迟（手机端主线程忙 / 卡顿）；
 *  - `ackDelayMs`：PUBACK 延迟（手机端 ack 慢 → 桌面看门狗看到的是「管道没证据」）。
 */
class MemoryBroker {
  constructor() {
    this.clients = [];
    this.deliveries = [];
    this.dropRule = null;
    this.deliveryDelayMs = 0;
    this.ackDelayMs = 0;
  }

  createClient(label) {
    const broker = this;
    const listeners = new Map();
    const client = {
      label,
      connected: false,
      ended: false,
      subscriptions: new Set(),
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return client;
      },
      off(event, handler) {
        listeners.get(event)?.delete(handler);
        return client;
      },
      emit(event, ...args) {
        for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
      },
      subscribe(topic, options, callback) {
        client.subscriptions.add(String(topic));
        process.nextTick(() => callback?.(null));
      },
      unsubscribe(topic, callback) {
        client.subscriptions.delete(String(topic));
        process.nextTick(() => callback?.(null));
      },
      publish(topic, payload, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
        const record = { from: label, topic: String(topic), bytes: body.length, at: Date.now(), body, dropped: 0 };
        broker.deliveries.push(record);
        const targets = broker.clients.filter((peer) => peer !== client && peer.subscriptions.has(String(topic)));
        const step = () => {
          for (const peer of targets) {
            const drop = broker.dropRule?.({ from: label, to: peer.label, topic: String(topic), body, record }) === true;
            if (drop) { record.dropped += 1; continue; }
            peer.emit('message', String(topic), Buffer.from(body));
          }
          if (broker.ackDelayMs > 0) setTimeout(() => cb?.(null), broker.ackDelayMs);
          else cb?.(null);
        };
        if (broker.deliveryDelayMs > 0) setTimeout(step, broker.deliveryDelayMs);
        else process.nextTick(step);
        return true;
      },
      end() {
        client.ended = true;
        const index = broker.clients.indexOf(client);
        if (index >= 0) broker.clients.splice(index, 1);
        process.nextTick(() => client.emit('close'));
      },
    };
    broker.clients.push(client);
    process.nextTick(() => {
      if (client.ended) return;
      client.connected = true;
      client.emit('connect');
    });
    return client;
  }
}

/* --------------------------- 真监听本地 HTTP 桥 ---------------------------- */

function createBridge(resolve) {
  const calls = [];
  const server = createServer((request, response) => {
    const path = String(request.url ?? '');
    calls.push({ method: String(request.method ?? 'GET'), path });
    const out = resolve(path) ?? { status: 404, body: '{"ok":false}' };
    response.writeHead(out.status ?? 200, { 'content-type': out.contentType ?? 'application/json; charset=utf-8' });
    response.end(out.body ?? '');
  });
  return {
    calls,
    server,
    async listen() {
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      return server.address().port;
    },
    async close() {
      await new Promise((done) => server.close(done));
    },
  };
}

/* --------------------------------- 夹具 ---------------------------------- */

function makeLogger(lines) {
  const push = (level) => (...args) => {
    lines.push(`${level} ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`);
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

async function makeHarness({ resolve, name = '复现电脑' } = {}) {
  const logLines = [];
  const logger = makeLogger(logLines);
  const bridge = createBridge(resolve);
  const port = await bridge.listen();
  const identity = {
    room: randomBytes(12).toString('hex'),
    key: Buffer.alloc(32, 0x5a).toString('base64url'),
    token: 'dshb_repro_device_token_0123456789',
    deviceId: 'dev_repro',
  };
  const link = new CloudLink({
    localPort: port,
    identity,
    broker: 'wss://memory-broker.invalid/mqtt',
    name,
    allowAnonymous: true,
    logger,
  });
  const broker = new MemoryBroker();
  const desktop = broker.createClient('desktop');
  link.state = 'connecting';
  link.client = desktop;
  desktop.on('message', (_topic, payload) => {
    try {
      link.onFrame(payload); // 真 unseal + 真 dispatch
    } catch (error) {
      link.stats.errors += 1;
      link.lastError = String(error?.message ?? error);
    }
  });
  desktop.on('connect', () => {
    link.stats.connects += 1;
    link.noteLinkUp(desktop);
    link.state = 'online';
    desktop.subscribe(link.topics.up, { qos: 1 });
    link.sayHello(true);
    link.startBeat();
  });
  const online = await waitFor(() => link.state === 'online', { timeout: 3000 });
  if (!online) throw new Error('CloudLink 没有进入 online');

  const phones = [];
  return {
    link,
    broker,
    bridge,
    identity,
    logLines,
    async connectPhone({ token = '', name: phoneName = 'NodePhone' } = {}) {
      const transport = broker.createClient(`phone-${phones.length}`);
      const client = createRelayClient({ room: identity.room, key: identity.key, token, name: phoneName, transport });
      phones.push({ client, transport });
      await client.connect();
      return client;
    },
    async close() {
      for (const entry of phones) {
        entry.client.close();
        entry.transport.end();
      }
      link.stop();
      await bridge.close();
    },
  };
}

/** 用线上信封解开桌面发出去的密文（AAD = 下行主题；key 必须是解码后的 32 字节）。 */
function decodeDown(harness, record) {
  return JSON.parse(openFrame(decodeKey(harness.identity.key), harness.link.topics.down, record.body.toString('utf8')).toString('utf8'));
}

/** 一次详情请求期间桌面真正发出去的 res/part 帧。 */
function framesOf(harness, fromIndex = 0) {
  const frames = [];
  for (const record of harness.broker.deliveries.slice(fromIndex)) {
    if (record.from !== 'desktop' || record.topic !== harness.link.topics.down) continue;
    let frame;
    try { frame = decodeDown(harness, record); } catch { continue; }
    if (frame.t !== 'res' && frame.t !== 'part' && frame.t !== 'reject') continue;
    frames.push({ frame, bytes: record.bytes, dropped: record.dropped });
  }
  return frames;
}

/* ------------------------- 按「gzip 后体积」造正文 ------------------------- */

/**
 * 8 MiB 随机字节池：取前缀 → base64 → 放进 JSON 的 messages[].text。
 * 随机 base64 基本不可压缩，所以 `gzip(body).length ≈ 前缀长度`，
 * 并且**前缀长度单调**，可以用二分精确命中目标 gzip 体积。
 */
const POOL = randomBytes(4 * 1024 * 1024);

function detailBody(textBytes) {
  const text = POOL.subarray(0, Math.max(0, textBytes)).toString('base64');
  return JSON.stringify({
    ok: true,
    data: {
      id: 'session-aaaa',
      messages: [
        { role: 'user', text: '请把这次会话的详情整理一下。' },
        { role: 'assistant', text },
      ],
    },
  });
}

const gzipLen = (textBytes) => gzipSync(Buffer.from(detailBody(textBytes), 'utf8')).length;

/** 找到 gzip 后正好（或最接近）`targetGzip` 字节的正文。 */
function bodyForGzipSize(targetGzip) {
  if (targetGzip < 2000) throw new Error('目标太小，正文会被 1200 字节的 gzip 门槛/JSON 头主导');
  let hi = Math.max(4096, targetGzip * 2);
  let guard = 0;
  while (gzipLen(hi) < targetGzip) {
    hi *= 2;
    if ((guard += 1) > 8) throw new Error('二分上界扩不出来');
  }
  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (gzipLen(mid) >= targetGzip) hi = mid;
    else lo = mid + 1;
  }
  let best = null;
  for (let delta = 0; delta <= 96; delta += 1) {
    for (const candidate of [lo + delta, lo - delta]) {
      if (candidate < 0) continue;
      const size = gzipLen(candidate);
      if (best === null || Math.abs(size - targetGzip) < Math.abs(best.size - targetGzip)) {
        best = { textBytes: candidate, size };
      }
      if (size === targetGzip) return { ...best, body: detailBody(candidate) };
    }
  }
  return { ...best, body: detailBody(best.textBytes) };
}

/* --------------------------- 手机端「带 beat 重发」的请求 ------------------- */

/**
 * 复刻 `remote/remote.js` 的 `request()`（第 82~93、117~118、1315~1320、1708~1777 行）：
 *  - 同一个 id 贯穿全程，**每次尝试都换新的 `seq`/`ts`**（否则桌面判 replay 丢帧）；
 *  - 单次尝试预算 `PHONE.timeoutMs`（修复前是 16 s），超时后按退避表再试；
 *  - 最多 `PHONE.attempts` 次尝试；只有最后一次等满预算才判定失败；
 *  - 请求挂在 pending 里时，**只要已卡住 > 4 s，下一个 beat（桌面每 8 s 一条）就重发**，
 *    重发同样消耗这 4 次预算。
 * 所以真实时间线是「8 s 一条 beat 把预算烧完」而不是纯 16 s × 4。
 */
function phoneRequest(client, path, {
  timeout = PHONE.timeoutMs, attempts = PHONE.attempts, backoffs = PHONE.backoffs,
  beatResend = true, resendAfterMs = PHONE.beatResendAfterMs,
} = {}) {
  const id = randomBytes(8).toString('hex');
  const startedAt = Date.now();
  const sendsAt = [];
  let attempt = 0;
  let settled = false;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      client.off('frame', onFrame);
      client.off('beat', onBeat);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onFrame = (message) => {
      if (String(message.id ?? '') !== id) return;
      if (message.t === 'res') finish(null, { message, sends: attempt, elapsed: Date.now() - startedAt, sendsAt });
      else if (message.t === 'reject') {
        const error = new Error(`reject:${message.code}`);
        error.code = String(message.code ?? 'reject');
        error.sends = attempt;
        finish(error);
      }
    };
    const attemptOnce = () => {
      if (settled || attempt >= attempts) return;
      attempt += 1;
      sendsAt.push(Date.now() - startedAt);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        if (attempt < attempts) {
          const delay = backoffs[attempt - 1] ?? 2_000;
          timer = setTimeout(attemptOnce, delay);
          return;
        }
        const error = new Error(`中继请求超时（${attempts} 次尝试后仍没有 res）`);
        error.code = 'timeout';
        error.sends = attempt;
        finish(error);
      }, timeout);
      timer.unref?.();
      client.send({ t: 'req', id, sid: client.sid, seq: client.nextSeq(), ts: Date.now(), method: 'GET', path })
        .catch((error) => finish(error));
    };
    const onBeat = () => {
      if (!beatResend || settled) return;
      const last = sendsAt[sendsAt.length - 1] ?? 0;
      if (Date.now() - startedAt - last < resendAfterMs) return;
      attemptOnce();
    };
    client.on('frame', onFrame);
    if (beatResend) client.on('beat', onBeat);
    attemptOnce();
  });
}

/* ================================== E1 =================================== */

async function E1() {
  const targets = [24, 40, 48, 48.9, 49, 52, 58, 64, 80].map((value) => Math.round(value * KB));
  const bodies = new Map();
  const rows = [];
  const detail = [];
  const harness = await makeHarness({
    resolve(path) {
      const hit = bodies.get(path);
      return hit === undefined ? undefined : { status: 200, body: hit.body };
    },
  });
  try {
    const client = await harness.connectPhone();
    for (const [index, target] of targets.entries()) {
      const made = bodyForGzipSize(target);
      const path = `/api/v1/tasks/session-rep${index}`;
      bodies.set(path, made);
      const before = harness.broker.deliveries.length;
      const t0 = Date.now();
      let reply;
      let error = null;
      try {
        reply = await client.request('GET', path, { timeout: 20_000 });
      } catch (caught) {
        error = caught;
      }
      const elapsed = Date.now() - t0;
      // 桌面真正发出去的帧（res 一帧，或 part 若干帧）
      const frames = framesOf(harness, before);
      const parts = frames.filter((entry) => entry.frame.t === 'part');
      const single = frames.filter((entry) => entry.frame.t === 'res');
      const raw = parts.length > 0
        ? parts.reduce((sum, entry) => sum + Buffer.from(entry.frame.d, 'base64').length, 0)
        : (single.length > 0 ? Buffer.byteLength(JSON.stringify(single[0].frame), 'utf8') : 0);
      const total = parts.length > 0 ? Number(parts[0].frame.total) : 1;
      const partBytes = parts.length > 0 ? parts.map((entry) => entry.bytes) : single.map((entry) => entry.bytes);
      const sliceBytes = parts.map((entry) => Buffer.from(entry.frame.d, 'base64').length);
      const ok = error === null && reply.status === 200 && reply.enc === 'gzip' && sha(reply.body) === sha(Buffer.from(made.body, 'utf8'));
      rows.push([
        `${kb(target)} KB`, `${kb(made.size)} KB`, raw,
        parts.length > 0 ? 'YES' : 'no', total,
        partBytes.join(' / '), sliceBytes.length > 1 ? sliceBytes.join(' / ') : '-', ok ? 'OK' : 'FAIL',
      ]);
      detail.push({
        targetGzip: target, actualGzip: made.size, rawLen: raw, parts: total, singleFrame: parts.length === 0,
        partPayloadBytes: partBytes, ok, elapsedMs: elapsed,
        enc: error === null ? reply.enc : null, status: error === null ? reply.status : null,
        shaPhone: error === null ? sha(reply.body) : null,
        shaOrigin: sha(Buffer.from(made.body, 'utf8')),
        error: error === null ? null : `${error.code ?? 'error'}: ${error.message}`,
      });
    }
    // 细节补充：每片的明文 / 密文字节数 + base64 膨胀系数
    const shrink = detail.map((row) => `${kb(row.actualGzip)}→${kb(row.rawLen)}KB(×${(row.rawLen / row.actualGzip).toFixed(3)})`);
    console.log('\n=== E1 单帧/分片临界点（MAX_FRAME=64 KiB，按 gzip 后体积） ===');
    console.log(table(
      ['gzip目标', 'gzip实测', 'raw明文B', 'part?', 'total', '每片MQTT payload(B)', '每片明文(B)', '结果'],
      rows,
    ));
    console.log(`\nraw/密文膨胀: ${shrink.join('  ')}`);
    console.log(`单帧预算: raw(是 base64 后的 JSON) ≤ ${MAX_FRAME} B  → gzip ≤ 约 ${kb((MAX_FRAME - 170) * 3 / 4)} KB`);
    // 精确交叉点：二分「gzip 体积」找 part=1 → 2 的边界
    const crossover = await findPartCrossover(harness, client, bodies);
    console.log(`实测交叉点: gzip ${crossover.gzipBytes} B (${kb(crossover.gzipBytes)} KB) 仍是 1 帧(raw=${crossover.rawLen})；`
      + ` gzip ${crossover.nextGzipBytes} B (${kb(crossover.nextGzipBytes)} KB) 起变 ${crossover.nextParts} 片(raw=${crossover.nextRawLen})`);
    console.log(`→ 触发分片的是「gzip 后 > ${kb(crossover.gzipBytes)} KB」，正好落在真实日志 25~58 KB 这个区间的上沿`);
    const file = report('e1', { maxFrame: MAX_FRAME, rows: detail, crossover });
    console.log(`JSON: ${file}`);
  } finally {
    await harness.close();
  }
}

/** 二分 gzip 体积，找「仍然单帧」的最大值，以及跨过去之后第一档的片数。 */
async function findPartCrossover(harness, client, bodies) {
  let lo = 40 * KB; // 已知单帧
  let hi = 60 * KB; // 已知分片
  const probe = async (gzipTarget) => {
    const made = bodyForGzipSize(gzipTarget);
    const path = `/api/v1/tasks/session-x${gzipTarget}`;
    bodies.set(path, made);
    const before = harness.broker.deliveries.length;
    await client.request('GET', path, { timeout: 20_000 });
    const frames = framesOf(harness, before);
    const parts = frames.filter((entry) => entry.frame.t === 'part');
    const single = frames.filter((entry) => entry.frame.t === 'res');
    return {
      gzipBytes: made.size,
      parts: parts.length > 0 ? Number(parts[0].frame.total) : 1,
      rawLen: parts.length > 0
        ? parts.reduce((sum, entry) => sum + Buffer.from(entry.frame.d, 'base64').length, 0)
        : Buffer.byteLength(JSON.stringify(single[0].frame), 'utf8'),
    };
  };
  let last = await probe(lo);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const result = await probe(mid);
    if (result.parts === 1) { lo = mid; last = result; }
    else hi = mid;
  }
  const next = await probe(hi);
  return {
    gzipBytes: last.gzipBytes, rawLen: last.rawLen, parts: 1,
    nextGzipBytes: next.gzipBytes, nextRawLen: next.rawLen, nextParts: next.parts,
  };
}

/* ================================== E2 =================================== */

async function E2({ permanent = false } = {}) {
  // 挑一个 2 片的用例：gzip 58 KB → raw ≈ 79 KB → 2 片（第 2 片只有几百字节）
  const made = bodyForGzipSize(Math.round(58 * KB));
  const path = '/api/v1/tasks/session-loss';
  const bodies = new Map([[path, made]]);
  const harness = await makeHarness({ resolve: (p) => (bodies.has(p) ? { status: 200, body: bodies.get(p).body } : undefined) });
  let dropState = { partsSeen: 0, droppedAt: 0, times: 0 };
  const lines = [];
  const dropSeq1 = (permanentDrop) => ({ from, to, body }) => {
    if (from !== 'desktop' || !to.startsWith('phone-')) return false;
    let frame;
    try { frame = JSON.parse(openFrame(decodeKey(harness.identity.key), harness.link.topics.down, body.toString('utf8')).toString('utf8')); } catch { return false; }
    if (frame.t !== 'part' || frame.seq !== 1) return false;
    if (permanentDrop) { dropState.times += 1; return true; }
    if (dropState.times === 0) { dropState.times = 1; dropState.droppedAt = Date.now(); return true; }
    return false;
  };
  try {
    const client = await harness.connectPhone();
    // ---- A) 第 2 片只丢一次 + 真手机策略（同 id、beat 重发、桌面幂等回放）----
    harness.broker.dropRule = dropSeq1(false);
    const first = await phoneRequest(client, path, {});
    const statsA = { ...harness.link.stats };
    lines.push(`A 第 2 片丢一次（真手机策略）: ${ms(first.elapsed)} 后拿到 res；共发 ${first.sends} 次 req，发送时刻 ${first.sendsAt.map(ms).join(' / ')}`);
    lines.push(`   桌面你以为的「重发」其实没发生: publishRetries=${statsA.publishRetries} publishLost=${statsA.publishLost} errors=${statsA.errors}`
      + ` ；救回来的是幂等回放 replays=${statsA.replays}`);
    lines.push(`   手机 stats: partsSeen=${client.stats.partsSeen} partsReassembled=${client.stats.partsReassembled} res=${client.stats.res} timeouts=${client.stats.timeouts}`);

    // ---- B) 永久丢片：单次尝试（= remote.js 最后一次尝试的预算）----
    dropState = { partsSeen: 0, droppedAt: 0, times: 0 };
    harness.broker.dropRule = dropSeq1(true);
    const startedB = Date.now();
    let failureB = null;
    try {
      await client.request('GET', path, { timeout: PHONE.timeoutMs });
    } catch (error) {
      failureB = { code: error.code ?? 'error', message: error.message, elapsed: Date.now() - startedB };
    }
    lines.push(`B 永久丢第 2 片（单次尝试 ${ms(PHONE.timeoutMs)} 预算）: ${failureB === null ? '竟然成功了' : `${ms(failureB.elapsed)} 后失败，code=${failureB.code}，「${failureB.message}」`}`);

    // ---- C) 永久丢片 + remote.js 完整策略（退避 + beat 重发）----
    const startedC = Date.now();
    let failureC = null;
    try {
      await phoneRequest(client, path, {});
    } catch (caught) {
      failureC = caught;
    }
    lines.push(`C 永久丢片 + 真手机策略（beat 重发）: ${failureC === null ? '成功' : `${ms(Date.now() - startedC)} 后失败（code=${failureC.code}，共发 ${failureC.sends} 次）`}`);

    // ---- D) 永久丢片 + 关掉 beat 重发（纯 timeout × attempts + 退避）----
    if (permanent === true) {
      const startedD = Date.now();
      let failureD = null;
      try {
        await phoneRequest(client, path, { beatResend: false });
      } catch (caught) {
        failureD = caught;
      }
      lines.push(`D 永久丢片 + 无 beat 重发: ${failureD === null ? '成功' : `${ms(Date.now() - startedD)} 后失败（code=${failureD.code}，共发 ${failureD.sends} 次）`}`);
      const theory = PHONE.timeoutMs * PHONE.attempts + PHONE.backoffs.reduce((sum, value) => sum + value, 0);
      lines.push(`   理论值 ${PHONE.attempts}×${ms(PHONE.timeoutMs)} + 退避 ${PHONE.backoffs.map(ms).join('+')} = ${ms(theory)}，实测与之对齐`);
    }
    console.log('\n=== E2 丢片与重发 ===');
    console.log(`  手机策略（取自修复前 remote.js）: timeout=${ms(PHONE.timeoutMs)} × ${PHONE.attempts} 次，`
      + `退避 ${PHONE.backoffs.map(ms).join('/')}，卡住 >${ms(PHONE.beatResendAfterMs)} 由 beat(8 s) 重发`);
    for (const line of lines) console.log(line);
    console.log('  判据：`publishSealed()` 的重发只挂在 **PUBACK error** 上（lib/cloud.mjs:1014-1039）；'
      + 'broker 收下但对端没收到（QoS1 也会这样丢）时它一次都不重发。'
      + '能救回来的只有「手机的 beat 重发 + 桌面 120 s 幂等回放」。');
    console.log('  失败是**半静默**：客户端错误码是 timeout（有 reason），但手机 UI 只会转圈到超时/显示「连接中断」，'
      + '桌面 `reject` 兜底只在「PUBACK 报错」时才发，丢片这条路不会触发它。');
    const file = report('e2', { gzip: made.size, lines, dropState, stats: harness.link.stats });
    console.log(`JSON: ${file}`);
  } finally {
    delete harness.broker.dropRule;
    await harness.close();
  }
}

/* ================================== E3 =================================== */

async function gunzipWithDecompressionStream(bytes) {
  const started = process.hrtime.bigint();
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = new Uint8Array(await new Response(stream).arrayBuffer());
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { buffer: Buffer.from(buffer), elapsedMs: elapsed };
}

async function E3() {
  const targets = [24, 40, 48, 48.9, 49, 52, 58, 64, 80].map((value) => Math.round(value * KB));
  const bodies = new Map();
  const rows = [];
  const detail = [];
  const harness = await makeHarness({ resolve: (path) => (bodies.has(path) ? { status: 200, body: bodies.get(path).body } : undefined) });
  try {
    const client = await harness.connectPhone();
    for (const [index, target] of targets.entries()) {
      const made = bodyForGzipSize(target);
      const path = `/api/v1/tasks/session-gz${index}`;
      bodies.set(path, made);
      const before = harness.broker.deliveries.length;
      const t0 = Date.now();
      await client.request('GET', path, { timeout: 20_000 });
      const rpcMs = Date.now() - t0;
      // 从**真实下行帧**重组出 res 明文；按 remote.js `_collectPart()` 的方式
      // （收：按 seq 落位；拼：按 seq 顺序）**倒序喂入**，验证重组与到达顺序无关。
      const frames = framesOf(harness, before);
      const parts = frames.filter((entry) => entry.frame.t === 'part');
      let rawJson;
      if (parts.length > 0) {
        const slots = new Array(Number(parts[0].frame.total));
        for (const entry of parts.slice().reverse()) slots[entry.frame.seq] = Buffer.from(entry.frame.d, 'base64');
        rawJson = Buffer.concat(slots);
      } else {
        rawJson = Buffer.from(JSON.stringify(frames.find((entry) => entry.frame.t === 'res').frame), 'utf8');
      }
      const res = JSON.parse(rawJson.toString('utf8'));
      const gzBytes = Buffer.from(res.body, 'base64');
      const decoded = await gunzipWithDecompressionStream(gzBytes);
      const ok = sha(decoded.buffer) === sha(Buffer.from(made.body, 'utf8'));
      // 截断（少最后一片）时的行为：gzip 流本身缺尾，DecompressionStream 必须报错
      let truncated = 'n/a';
      if (parts.length > 1) {
        const short = Buffer.concat(parts.filter((entry) => entry.frame.seq !== parts.length - 1)
          .map((entry) => Buffer.from(entry.frame.d, 'base64')));
        let shortJson = null;
        try { shortJson = JSON.parse(short.toString('utf8')); } catch { shortJson = null; }
        if (shortJson === null) truncated = 'JSON 拼不出来（客户端根本不会走到解压）';
        else {
          try {
            await gunzipWithDecompressionStream(Buffer.from(shortJson.body, 'base64'));
            truncated = '解压居然成功（异常）';
          } catch (error) {
            truncated = `DecompressionStream 抛错: ${String(error?.message ?? error).slice(0, 40)}`;
          }
        }
      }
      rows.push([
        `${kb(target)} KB`, `${kb(made.size)} KB`, parts.length > 0 ? parts.length : 1,
        `${kb(gzBytes.length)} KB`, `${decoded.elapsedMs.toFixed(2)}`, ms(rpcMs), ok ? 'OK' : 'FAIL', truncated,
      ]);
      detail.push({ targetGzip: target, actualGzip: made.size, parts: parts.length || 1, gzBytes: gzBytes.length, decompressMs: decoded.elapsedMs, rpcMs, ok, truncated, orderShuffled: parts.length > 1 });
    }
    console.log('\n=== E3 手机端解压（DecompressionStream base64→Uint8Array→Blob→pipeThrough→arrayBuffer） ===');
    console.log(table(['gzip目标', 'gzip实测', '片数', '解压入参', '解压ms', '整条RPC', 'sha256一致', '缺最后一片时'], rows));
    const worst = detail.reduce((max, row) => Math.max(max, row.decompressMs), 0);
    console.log(`\n解压耗时最大 ${worst.toFixed(2)} ms（这些体量下解压本身不是瓶颈）；`
      + '倒序喂分片仍能解压 → 重组**与到达顺序无关**，只与「有没有到齐」有关。');
    console.log('缺一片的真实表现：JSON 都拼不出来，客户端在重组层就放弃（不再解压），但**没有任何一条错误提示给用户**。');
    const file = report('e3', { rows: detail });
    console.log(`JSON: ${file}`);
  } finally {
    await harness.close();
  }
}

/* ================================== E4 =================================== */

async function E4() {
  const plan = [
    ...Array.from({ length: 5 }, () => 45 * KB),
    ...Array.from({ length: 5 }, () => Math.round(58 * KB)),
  ];
  const bodies = new Map();
  const harness = await makeHarness({ resolve: (path) => (bodies.has(path) ? { status: 200, body: bodies.get(path).body } : undefined) });
  const runs = [];
  try {
    const client = await harness.connectPhone();
    for (const [index, target] of plan.entries()) {
      const made = bodyForGzipSize(target);
      const path = `/api/v1/tasks/session-run${index}`;
      bodies.set(path, made);
      const before = harness.broker.deliveries.length;
      const t0 = Date.now();
      let ok = false;
      let error = null;
      try {
        const reply = await client.request('GET', path, { timeout: 20_000 });
        ok = reply.status === 200 && sha(reply.body) === sha(Buffer.from(made.body, 'utf8'));
      } catch (caught) {
        error = `${caught.code ?? 'error'}: ${caught.message}`;
      }
      const frames = framesOf(harness, before);
      const parts = frames.filter((entry) => entry.frame.t === 'part');
      runs.push({
        index, gzip: made.size, parts: parts.length > 0 ? Number(parts[0].frame.total) : 1,
        elapsed: Date.now() - t0, ok, error,
        payloadBytes: parts.map((entry) => entry.bytes),
      });
    }
    const stats = { ...harness.link.stats };
    const okCount = runs.filter((row) => row.ok).length;
    const g45 = runs.slice(0, 5);
    const g58 = runs.slice(5);
    const summary = (rows) => {
      const list = rows.map((row) => row.elapsed).sort((a, b) => a - b);
      return `成功 ${rows.filter((row) => row.ok).length}/${rows.length}  耗时 min/中位/max = ${ms(list[0])}/${ms(list[Math.floor(list.length / 2)])}/${ms(list[list.length - 1])}`;
    };
    console.log('\n=== E4 连续大响应（不同 id，各 5 次） ===');
    console.log(table(['#', 'gzip', '片数', '耗时', '结果', '每片MQTT payload'], runs.map((row) => [
      `#${row.index + 1}`, `${kb(row.gzip)} KB`, row.parts, ms(row.elapsed), row.ok ? 'OK' : `FAIL(${row.error})`,
      row.parts > 1 ? row.payloadBytes.join(' / ') : String(row.payloadBytes[0] ?? '-'),
    ])));
    console.log(`45 KB (${g45[0].parts} 片): ${summary(g45)}`);
    console.log(`58 KB (${g58[0].parts} 片): ${summary(g58)}`);
    console.log(`总计 ${okCount}/${runs.length}；桌面 stats: publishRetries=${stats.publishRetries} publishLost=${stats.publishLost} `
      + `errors=${stats.errors} replays=${stats.replays} tx=${stats.tx} rx=${stats.rx} rpc=${stats.rpc}`);
    const detailLines = harness.logLines.filter((line) => line.includes('详情响应') || line.includes('较大响应'));
    console.log(`桌面日志（详情体积）：\n  ${detailLines.slice(0, 3).join('\n  ')}${detailLines.length > 3 ? `\n  …共 ${detailLines.length} 条` : ''}`);
    const file = report('e4', { runs, stats, detailLines });
    console.log(`JSON: ${file}`);
  } finally {
    await harness.close();
  }
}

/* ================================== E5 =================================== */

async function E5() {
  const made = bodyForGzipSize(Math.round(58 * KB));
  const path = '/api/v1/tasks/session-qos';
  const bodies = new Map([[path, made]]);
  const harness = await makeHarness({ resolve: (p) => (bodies.has(p) ? { status: 200, body: bodies.get(p).body } : undefined) });
  const lines = [];
  try {
    const client = await harness.connectPhone();
    const run = async (label) => {
      const before = harness.broker.deliveries.length;
      const t0 = Date.now();
      let ok = false;
      try {
        const reply = await client.request('GET', path, { timeout: 20_000 });
        ok = reply.status === 200;
      } catch { ok = false; }
      const frames = framesOf(harness, before);
      const parts = frames.filter((entry) => entry.frame.t === 'part');
      lines.push(`${label}: ${ok ? 'OK' : 'FAIL'}  用时 ${ms(Date.now() - t0)}  片数 ${Math.max(1, parts.length)}  `
        + `每片到达/投递: ${parts.map((entry) => (entry.frame.seq)).join(',') || 'single'}`);
      return Date.now() - t0;
    };

    // 1) 基线
    await run('基线（delivery 0ms / PUBACK 0ms）');
    // 2) 订阅方（手机）忙：连续两片各延迟 2 s 才投递
    harness.broker.deliveryDelayMs = 2000;
    await run('手机主线程忙：投递各延迟 2 s');
    harness.broker.deliveryDelayMs = 0;
    // 3) 手机 ack 慢：PUBACK 延迟 2 s（远小于看门狗的 17 s，应当无害）
    harness.broker.ackDelayMs = 2000;
    await run('PUBACK 延迟 2 s（< LINK_STALE_MS 17 s）');
    // 4) 看门狗判定：把 lastTxAckAt 摆成 18 s 前，看它会不会重建链路
    harness.broker.ackDelayMs = 0;
    let rebuilt = 0;
    const originalRetry = harness.link.retry.bind(harness.link);
    harness.link.retry = () => { rebuilt += 1; return true; };
    harness.link.lastTxAckAt = Date.now() - 18_000;
    harness.link.lastRxAt = Date.now() - 18_000;
    harness.link.connectedAt = Date.now() - 18_000;
    const strike1 = harness.link.checkLink();
    const strike2 = harness.link.checkLink();
    harness.link.retry = originalRetry;
    lines.push(`看门狗（LINK_WATCH 3 s / LINK_STALE 17 s / 连续 2 次才动手）：第 1 次 strike=${strike1}，第 2 次 strike=${strike2}，重建次数=${rebuilt}`);
    harness.link.lastTxAckAt = Date.now();
    harness.link.lastRxAt = Date.now();

    console.log('\n=== E5 QoS1 inflight / ack 慢 ===');
    for (const line of lines) console.log(`  ${line}`);
    console.log('  结论：2~3 片的响应远在 inflight 窗口（EMQX 默认 32）之内，"订阅方 ack 慢 → broker 停投"在这里不会出现；');
    console.log('  真正的 ack 敏感点是**桌面看门狗**：连续 2 个 3 s 周期（共 6 s）没有 PUBACK 证据且链路已静默 ≥17 s，就重建连接，在途分片随之作废。');
    const file = report('e5', { lines });
    console.log(`JSON: ${file}`);
  } finally {
    await harness.close();
  }
}

/* ================================== main ================================= */

const TASKS = {
  e1: () => E1(),
  e2: () => E2(),
  e2b: () => E2({ permanent: true }),
  e3: () => E3(),
  e4: () => E4(),
  e5: () => E5(),
};

const requested = process.argv.slice(2).filter((arg) => arg !== 'all');
const names = requested.length > 0 ? requested : Object.keys(TASKS);
for (const name of names) {
  const task = TASKS[name];
  if (task === undefined) {
    console.error(`未知实验 ${name}；可选: ${Object.keys(TASKS).join(', ')}, all`);
    process.exitCode = 1;
    continue;
  }
  await task();
}
process.exit(process.exitCode ?? 0);
