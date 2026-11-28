/**
 * 离线时延基准：**单帧 `res` 丢失 / 2 片响应丢第 2 片 / 正常** 三种场景下
 * "用户看到内容"要多久。默认**跳过**，只在显式打开时跑（约 8 s）：
 *
 *     $env:POCKET_BENCH = '1'; node --test test/domain/shell-lost-frame-bench.test.mjs
 *     # bash: POCKET_BENCH=1 node --test test/domain/shell-lost-frame-bench.test.mjs
 *
 * 为什么需要它：「要不要给通信层再加一层 2 s 级的补救（nudge）」只能用数字回答，
 * 而这个数字必须能复跑。结论先写在这里（2026-11 实测，往返 600 ms）：
 *
 *   场景                     现状        挂上 nudge(2 s)   帧数（req）
 *   单帧 res 丢失            1825 ms     1816 ms           2 / 2
 *   2 片响应丢第 2 片        1832 ms     1821 ms           2 / 2
 *   正常（不丢帧）            624 ms      622 ms           1 / 1
 *   连续丢 2 帧（参考）       4244 ms     4228 ms           3 / 4（nudge 命中 1 次但没抢到）
 *
 * 差值全在噪声内、nudge 一次都没抢在既有退避前面 → 判定**不值得加**（详见
 * `test/domain/shell-lost-frame.test.mjs` 的说明）。同一份 harness 也是"如果哪天
 * 有人把退避表改慢"的复核工具。
 *
 * 组成（全程不联网，只用仓库已有资产）：
 *   - 电脑端：真实 `lib/cloud.mjs` 的 `CloudLink`（真分帧 / 真 120 s 幂等缓存 / 真 nack 补片）；
 *   - 手机端：真实 `remote/remote.js` 的 `Relay`（真 `request()` / 真 2 s 看门狗）；
 *   - 中间：内存 broker（可注入丢帧，单程 150 ms ≈ 实测 600 ms 往返）；
 *   - 本地 HTTP 桥真监听 127.0.0.1（`req` → 真 fetch → `res`）。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

// `lib/cloud.mjs` / `test/support/*` 一律**懒加载**：这个用例默认 skip，而 ES 模块
// 的顶层 import 在 skip 时照样会执行 —— 那等于让「默认跳过」仍然依赖别人的在途改动。
const ENABLED = process.env.POCKET_BENCH === '1';
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const POOL = randomBytes(2 * 1024 * 1024);
const ONE_WAY_MS = 150;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 最小 MQTT：publish / subscribe / on('message')；可注入丢帧与单程延迟。 */
class MemoryBroker {
  constructor() {
    this.clients = [];
    this.deliveries = [];
    this.dropRule = null;
  }
  createClient(label) {
    const broker = this;
    const listeners = new Map();
    const client = {
      label,
      subscriptions: new Set(),
      on(event, handler) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(handler); return client; },
      emit(event, ...args) { for (const handler of [...(listeners.get(event) ?? [])]) handler(...args); },
      subscribe(topic, _options, callback) {
        client.subscriptions.add(String(topic));
        setTimeout(() => callback?.(null), ONE_WAY_MS);
      },
      publish(topic, payload, options, callback) {
        const done = typeof options === 'function' ? options : callback;
        const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
        setTimeout(() => {
          const record = { from: label, topic: String(topic), body };
          broker.deliveries.push(record);
          const targets = broker.clients.filter((peer) => peer !== client && peer.subscriptions.has(String(topic)));
          setTimeout(() => {
            for (const peer of targets) {
              if (broker.dropRule?.({ from: label, to: peer.label, topic: record.topic }) === true) { record.dropped = true; continue; }
              peer.emit('message', record.topic, Buffer.from(body));
            }
            done?.(null);
          }, ONE_WAY_MS);
        }, ONE_WAY_MS);
        return true;
      },
      end() { const index = broker.clients.indexOf(client); if (index >= 0) broker.clients.splice(index, 1); },
    };
    broker.clients.push(client);
    setTimeout(() => client.emit('connect'), ONE_WAY_MS);
    return client;
  }
}

const waitFor = async (predicate, timeout = 6_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(2);
  }
  return true;
};

/**
 * 跑一个场景，返回「从发起请求到拿到并解出正文」的毫秒数 + 帧计数。
 *
 * @param {{textBytes: number, dropDownFrames: number[]}} spec 下行帧序号（从 1 数）不投递给手机
 */
async function scenario({ textBytes, dropDownFrames }, { Relay, makeSealer, CloudLink, decodeKey, openFrame }) {
  const bodyText = JSON.stringify({
    ok: true,
    data: { id: 'sess-bench', messages: [{ role: 'assistant', text: POOL.subarray(0, textBytes).toString('base64') }] },
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(bodyText);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  const identity = {
    room: randomBytes(12).toString('hex'),
    key: Buffer.alloc(32, 0x5a).toString('base64url'),
    token: 'dshb_bench_device_token',
    deviceId: 'dev_bench',
  };
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const link = new CloudLink({
    localPort: server.address().port, identity, broker: 'wss://memory-broker.invalid/mqtt',
    name: 'bench-desktop', allowAnonymous: true, logger: silent,
  });
  const broker = new MemoryBroker();
  const desktop = broker.createClient('desktop');
  link.state = 'connecting';
  link.client = desktop;
  desktop.on('message', (_topic, payload) => { try { link.onFrame(payload); } catch { link.stats.errors += 1; } });
  desktop.on('connect', () => {
    link.stats.connects += 1;
    link.noteLinkUp(desktop);
    link.state = 'online';
    desktop.subscribe(link.topics.up, { qos: 1 });
    link.sayHello(true);
    link.startBeat();
  });
  assert.equal(await waitFor(() => link.state === 'online'), true, '桌面端没上线');
  await sleep(ONE_WAY_MS * 2); // 让 hello 先落地，别混进计数

  const relay = new Relay({ room: identity.room, sealer: await makeSealer(identity.key, identity.room), brokers: ['wss://memory-broker.invalid/mqtt'], phoneName: 'bench-phone' });
  const phone = broker.createClient('phone');
  phone.subscribe(link.topics.down, { qos: 1 });
  relay.ready = true;
  relay.readyAt = Date.now();
  relay.client = { publish: (topic, payload) => phone.publish(topic, payload, { qos: 1 }) };
  phone.on('message', (_topic, payload) => { void relay.onMessage(payload, relay.client); });
  relay.session = { token: identity.token };
  relay.announce = () => {};
  relay.startStaleWatch();
  await sleep(ONE_WAY_MS);

  const drop = new Set(dropDownFrames);
  let seen = 0;
  broker.dropRule = ({ from, topic }) => {
    if (from !== 'desktop' || topic !== link.topics.down) return false;
    seen += 1;
    return drop.has(seen);
  };

  const upMark = broker.deliveries.length;
  const startedAt = Date.now();
  let outcome = 'ok';
  try {
    const reply = await relay.request({ method: 'GET', path: '/api/v1/tasks/session-bench?limit=40', headers: {}, gzip: false });
    const parsed = JSON.parse(Buffer.from(String(reply.body ?? ''), 'base64').toString('utf8'));
    if (parsed?.ok !== true) outcome = 'bad-body';
  } catch (error) {
    outcome = `fail:${error?.pocketCode ?? error?.message ?? 'unknown'}`;
  }
  const elapsedMs = Date.now() - startedAt;

  let reqFrames = 0;
  let nackFrames = 0;
  for (const record of broker.deliveries.slice(upMark)) {
    if (record.from !== 'phone' || record.topic !== link.topics.up) continue;
    const frame = JSON.parse(openFrame(decodeKey(identity.key), link.topics.up, record.body.toString('utf8')).toString('utf8'));
    if (frame.t === 'req') reqFrames += 1;
    if (frame.t === 'nack') nackFrames += 1;
  }
  // 诊断计数（如果哪天真的加了 nudge，这里能直接看到它命中了几次）。
  const nudges = Number(relay.stats.nudges ?? 0);

  relay.stop('bench done');
  link.stop();
  await new Promise((done) => server.close(done));
  return { elapsedMs, outcome, reqFrames, nackFrames, nudges };
}

const SKIP = ENABLED ? undefined : '设置 POCKET_BENCH=1 才跑（约 8 s，真实定时器）';

test('丢帧自愈时延基准：单帧 / 丢片 / 正常', { skip: SKIP }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'pocket-bench-'));
  try {
    await run(process.execPath, [join(ROOT, 'tools', 'build-shell.mjs'), '--out', out], { cwd: ROOT });
    const { Relay, makeSealer } = await import(pathToFileURL(join(out, 'remote.js')).href);
    const { CloudLink } = await import(pathToFileURL(join(ROOT, 'lib', 'cloud.mjs')).href);
    const { decodeKey, openFrame } = await import(pathToFileURL(join(ROOT, 'test', 'support', 'relay-client.mjs')).href);
    const cases = [
      { name: 'S1 单帧 res 丢失', textBytes: 12 * 1024, dropDownFrames: [1], limitMs: 3_000 },
      { name: 'S2 2 片响应丢第 2 片', textBytes: 64 * 1024, dropDownFrames: [2], limitMs: 3_000 },
      { name: 'S3 正常（不丢帧）', textBytes: 64 * 1024, dropDownFrames: [], limitMs: 2_000 },
    ];
    const rows = [];
    for (const item of cases) {
      const result = await scenario(item, { Relay, makeSealer, CloudLink, decodeKey, openFrame });
      rows.push([item.name, `${result.elapsedMs} ms`, result.outcome, String(result.reqFrames), String(result.nackFrames), String(result.nudges)]);
      assert.equal(result.outcome, 'ok', `${item.name} 必须真的拿到内容（${result.outcome}）`);
      assert.ok(result.elapsedMs < item.limitMs,
        `${item.name} 用了 ${result.elapsedMs}ms，超过 ${item.limitMs}ms：丢一帧的自愈节奏退化了`
        + '（既有的第 1 次同 id 重发在 1.2 s，见 test/domain/shell-lost-frame.test.mjs）');
    }
    // 正常路径不许因为任何"补齐机制"多出上行帧。
    assert.equal(rows[2][3], '1', '正常请求只该发一帧 req');
    const header = ['场景', '耗时', '结果', 'req 帧', 'nack 帧', 'nudges'];
    const widths = header.map((_, column) => Math.max(header[column].length, ...rows.map((row) => row[column].length)));
    const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ');
    console.log([line(header), widths.map((width) => '-'.repeat(width)).join('-+-'), ...rows.map(line)].join('\n'));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
