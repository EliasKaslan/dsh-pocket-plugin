/**
 * 外壳的 RPC 生命周期：**预算有界**、**面包屑可读**、**重连能自愈**。
 *
 * 这一版的事故（"手机偶尔点进某个会话，加载半天也没有内容"）在手机侧留下了
 * 三个互相掩盖的洞，这个文件逐条钉住：
 *
 *   1. `request()` 的判死时刻不是"一个确定的上限"——心跳重发、重连重发、以及
 *      过期 attempt 的迟到失败都会重新装配计时器，最坏耗时因此无法与应用侧超时对账。
 *      （旧值算下来 24 400 ms > 应用侧 20 000 ms，于是先到点的总是应用层，
 *      用户拿到笼统的「请求超时」，外壳那套同 id 幂等重放还没跑完就被取消。）
 *   2. `resendPending()` 走 `retry()`，而 `retry()` 在 attempt 用尽后是**空操作**——
 *      一次多片响应在重组途中遇到重连时，半包被 `abortTransport()` 清掉、桌面
 *      重放的完整回包再也拼不出来，只能干等预算耗尽。
 *   3. 手机侧只有一个 `pending` 数字，看不出"哪条请求发了几次、有没有收到过回包"。
 *      桌面有 `rx / rpc / replays`，两边对不上时无从下手。
 *
 * 为什么在 `test/domain/`：它测的是真的 `Relay` 类（建一次产物再 import，
 * 注入假 sealer / MQTT）。只有 `decompressGzip` 是纯函数，用 `sliceFunction()`
 * 切出来在 vm 里真跑 —— 它没有任何 DOM 依赖，没必要靠"源码里有没有那行"来证明。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import {
  DETAIL_TIMEOUT_MS, RPC_ATTEMPTS, RPC_BACKOFF_MS, RPC_TIMEOUT_MS, rpcWorstCaseMs,
} from '../../web/lib/rpc-budget.js';
import {
  readRepoFile, runSlices, sliceConst, sliceFunction,
} from '../support/shell-source.mjs';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const encoder = new TextEncoder();
const SOURCE = readRepoFile('remote/remote.js');

let out;
let Relay;

before(async () => {
  out = await mkdtemp(join(tmpdir(), 'pocket-rpc-'));
  await run(process.execPath, [join(ROOT, 'tools', 'build-shell.mjs'), '--out', out], { cwd: ROOT });
  ({ Relay } = await import(pathToFileURL(join(out, 'remote.js')).href));
});

after(async () => {
  await rm(out, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

const stubSealer = () => ({
  scope: 'scope-test',
  room: 'roomtest',
  seal: async (object) => JSON.stringify(object),
  unseal: async (text) => JSON.parse(text),
});

/** 假 MQTT 客户端：把上行帧记下来（生产里这些是密文），下行用 `deliver()` 灌。 */
function harness() {
  const published = [];
  const relay = new Relay({ room: 'roomtest', sealer: stubSealer(), brokers: ['wss://broker.invalid:8084/mqtt'] });
  relay.ready = true;
  relay.client = { publish: (topic, payload) => { published.push(JSON.parse(payload)); } };
  return { relay, published };
}

/** 记下 promise 的结局但不 await —— 用来断言"它现在还挂着"。 */
function track(promise) {
  const state = { kind: 'pending', reply: undefined, error: undefined };
  promise.then((reply) => { state.kind = 'resolved'; state.reply = reply; }, (error) => { state.kind = 'rejected'; state.error = error; });
  return state;
}

const deliver = (relay, message) => relay.onMessage(encoder.encode(JSON.stringify(message)), relay.client);
const partFrame = (id, seq, total, text) => ({ t: 'part', id, seq, total, d: b64(text) });

/* ------------------------- 1) 常量不许漂开 ------------------------- */

test('常量门禁：remote/remote.js 的字面量必须与 web/lib/rpc-budget.js 一致', () => {
  // 外壳里必须是数字字面量（`relay-restart` 的门禁按 `const X = <数字>;` 解析源码），
  // 所以这里也按同样的方式读，并逐字段比对 —— 改一边而忘了另一边必须红。
  const pickNumber = (name) => {
    const hit = new RegExp(`const ${name} = ([\\d_]+);`, 'u').exec(SOURCE);
    return hit === null ? Number.NaN : Number(hit[1].replaceAll('_', ''));
  };
  const pickList = (name) => {
    const hit = new RegExp(`const ${name} = \\[([^\\]]*)\\];`, 'u').exec(SOURCE);
    if (hit === null) return null;
    return hit[1].split(',').map((item) => Number(item.trim().replaceAll('_', '')));
  };
  assert.equal(pickNumber('RPC_TIMEOUT_MS'), RPC_TIMEOUT_MS, 'RPC_TIMEOUT_MS 两边必须相同');
  assert.equal(pickNumber('RPC_ATTEMPTS'), RPC_ATTEMPTS, 'RPC_ATTEMPTS 两边必须相同');
  assert.deepEqual(pickList('RPC_BACKOFF_MS'), RPC_BACKOFF_MS, 'RPC_BACKOFF_MS 两边必须相同');
  // 关系本身（最坏耗时 < 应用侧超时）由 test/unit/rpc-budget.test.mjs 钉住；
  // 这里顺带算一遍，好让"改了外壳常量"的失败信息直接指出现场。
  assert.ok(rpcWorstCaseMs() < DETAIL_TIMEOUT_MS,
    `外壳最坏 ${rpcWorstCaseMs()}ms 已经不小于详情超时 ${DETAIL_TIMEOUT_MS}ms`);
});

/* --------------------- 2) 判死时刻有界 + 面包屑 --------------------- */

test('判死用绝对截止时刻：没有回包时按预算结束，并标 pocketCode=relay_timeout', async () => {
  const { relay, published } = harness();
  const startedAt = Date.now();
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/abc?limit=40', headers: {}, gzip: false, attempts: 1, timeout: 120 }));
  await tick();
  assert.equal(published.length, 1, '首发一帧');
  assert.equal(state.kind, 'pending');
  // 不给任何 res：必须由外壳自己判死（旧实现里这条腿靠"补一个计时器"，
  // 而那条路会被迟到的 send 失败覆盖掉）。
  await new Promise((resolve) => setTimeout(resolve, 260));
  const elapsed = Date.now() - startedAt;
  assert.equal(state.kind, 'rejected', '没回包就必须结束，不能挂着');
  assert.match(String(state.error?.message), /中继请求超时/u);
  assert.equal(state.error?.pocketCode, 'relay_timeout', 'net.js 靠这个码把原因翻给界面、并拒绝换新 id 重试');
  assert.ok(elapsed < 2_000, `判死时刻必须贴着预算（实际 ${elapsed}ms）`);
  assert.equal(relay.pending.size, 0, 'pending 必须清干净');
  assert.equal(relay.stats.timeouts, 1, '"超时未收到 res"的次数要能被诊断读到');
  // 面包屑：路径去掉 query、冇收到过 res、以 timeout 收尾。
  const crumb = relay.rpcBreadcrumbs().at(-1);
  assert.equal(crumb.path, '/api/v1/tasks/abc', 'query 不进面包屑（那里是游标/参数，没有诊断价值）');
  assert.equal(crumb.sawRes, false);
  assert.equal(crumb.end, 'timeout');
  assert.equal(crumb.tries, 1);
  assert.ok(crumb.ms >= 100, '要记下这条请求活了多久');
});

test('面包屑：成功一条要能回答"发了几次 / 收到过多大的 res"', async () => {
  const { relay, published } = harness();
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/xyz', headers: {}, gzip: false }));
  await tick();
  const id = published[0].id;
  const body = b64(JSON.stringify({ ok: true, data: { messages: [] } }));
  await deliver(relay, { t: 'res', id, status: 200, headers: {}, body });
  await tick();
  assert.equal(state.kind, 'resolved');
  const crumb = relay.rpcBreadcrumbs().at(-1);
  assert.equal(crumb.id, id, '面包屑的 id 就是 request id（不是分片 id）');
  assert.equal(crumb.verb, 'GET');
  assert.equal(crumb.path, '/api/v1/tasks/xyz');
  assert.equal(crumb.sawRes, true);
  assert.equal(crumb.resId, id);
  assert.equal(crumb.resBytes, Math.round((body.length * 3) / 4), 'res 的体积按原始字节算');
  assert.ok(crumb.resAt >= crumb.at);
  assert.equal(crumb.end, '', '成功了不该被标成失败');
  assert.equal(relay.stats.resMiss, 0);
  // 面包屑里不许出现凭据类字段（快照会被用户复制出去）。
  for (const banned of ['token', 'room', 'key']) {
    assert.equal(Object.keys(crumb).some((key) => key.toLowerCase().includes(banned)), false, `面包屑不该有 ${banned}`);
  }
});

test('面包屑是环形的：只留最近 N 条，且每条都带结局', async () => {
  const { relay } = harness();
  for (let index = 0; index < 12; index += 1) {
    track(relay.request({ method: 'GET', path: `/api/v1/tasks/t${index}`, headers: {}, gzip: false, attempts: 1, timeout: 30 }));
    await tick();
  }
  await new Promise((resolve) => setTimeout(resolve, 160));
  const crumbs = relay.rpcBreadcrumbs();
  assert.equal(crumbs.length, 8, '只留最近 8 条（再多的记录对现场没有解释力，只会把诊断文本刷长）');
  assert.equal(crumbs.at(-1).path, '/api/v1/tasks/t11', '留下的必须是最新的那几条');
  assert.equal(crumbs.every((crumb) => crumb.end === 'timeout'), true);
  assert.equal(relay.stats.timeouts, 12, '计数不清零：环形只截显示，不截事实');
});

test('迟到的 res（请求已经判死）要计数，不再静默', async () => {
  const { relay } = harness();
  await deliver(relay, { t: 'res', id: 'nosuchid', status: 200, headers: {}, body: b64('{}') });
  assert.equal(relay.stats.resMiss, 1, 'resMiss 高 = 我们放弃得太早；为 0 而界面卡 = 回包真的没到');
});

/* ----------------- 3) 过期 attempt 的迟到失败不许改判死 ----------------- */

test('过期 attempt 的迟到失败：不许重新装配计时器，也不许改结论', async () => {
  const { relay } = harness();
  // 受控 send：由用例决定每次 attempt 何时成功/失败。
  const sends = [];
  relay.send = () => new Promise((resolve, reject) => { sends.push({ resolve, reject }); });
  // 记下每一次装着"要等多久"的计时器，用来证明"迟到失败没有偷偷重装计时器"。
  // 0 ms 的（`tick()` / 微任务让位）不算：那不是请求预算。
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { if (Number(ms) > 0) delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
  try {
    const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/stale', headers: {}, gzip: false, attempts: 2, timeout: 777 }));
    await tick();
    assert.equal(sends.length, 1);
    const id = [...relay.pending.keys()][0];
    assert.ok(id !== undefined);
    // 不等 1.2 s 的退避：直接走"重连后补一次"这条路触发第 2 次发送。
    relay.pending.get(id).heal();
    await tick();
    assert.equal(sends.length, 2, 'heal 要真的再发一帧');
    const before = delays.length;
    // 第 1 次发送现在才失败（迟到的 transient）。它已经被第 2 次取代 ——
    // 旧实现会在这里 clearTimeout + 补一个 timeout 计时器，把当前 attempt 的
    // 退避链打断、判死时刻还随"迟到的回调什么时候到"漂移（最长能多出十几秒）。
    sends[0].reject(Object.assign(new Error('中继连接已更换'), { transient: true }));
    await tick();
    assert.equal(delays.length, before, '过期 attempt 的失败不许重新装配计时器');
    assert.equal(state.kind, 'pending', '更不许因此判死：当前这次 attempt 还在路上');
    // 结论由**当前** attempt 决定。
    sends[1].reject(new Error('中继拒绝了请求（replay）'));
    await tick();
    assert.equal(state.kind, 'rejected');
    assert.match(String(state.error?.message), /replay/u);
    assert.equal(relay.pending.size, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

/* --------------------- 4) 重连后必须能救回半包 --------------------- */

test('重连：attempt 用尽 + 半包被清时，resendPending 仍按同一个 id 重发并拼回完整响应', async () => {
  const { relay, published } = harness();
  // attempts=1：首发之后就没有重试预算了 —— 这正是旧实现"空操作"的现场。
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 1, timeout: 4_000 }));
  await tick();
  assert.equal(published.length, 1);
  const id = published[0].id;
  const reply = JSON.stringify({
    t: 'res', id, status: 200, headers: {}, body: b64(JSON.stringify({ ok: true, messages: [{ id: 'm1' }] })),
  });
  const half = Math.ceil(reply.length / 2);
  const chunkId = 'a1b2c3d4e5f6';
  await deliver(relay, partFrame(chunkId, 0, 2, reply.slice(0, half)));
  assert.equal(relay.parts.size, 1, '第 1 片到了，还没拼完');
  // 重连：半包表被清（这条大响应在这一轮已经废了），在途请求保留。
  relay.ready = false;
  relay.abortTransport('重连中');
  assert.equal(relay.parts.size, 0, 'abortTransport 清半包（旧行为）');
  assert.equal(relay.pending.size, 1, '但在途请求必须留着（1.0.2 的 failAll 已经改掉）');
  relay.ready = true;
  relay.resendPending();
  // `send()` 是异步的（要先 seal 再 publish），断言前必须让它跑完一拍。
  await tick();
  assert.equal(published.length, 2, 'attempts 用尽也必须重发一次 —— 否则这条请求永远拼不出回包');
  assert.equal(published[1].id, id, '同一个 request id：桌面按它命中幂等缓存重放，不会重复执行');
  // 桌面重放的完整回包（同样分成两片）到达 → 兑现。
  await deliver(relay, partFrame(chunkId, 0, 2, reply.slice(0, half)));
  await deliver(relay, partFrame(chunkId, 1, 2, reply.slice(half)));
  await tick();
  assert.equal(state.kind, 'resolved', '重连后必须能自愈，而不是让用户刷新页面');
  assert.equal(state.reply.status, 200);
  const crumb = relay.rpcBreadcrumbs().at(-1);
  assert.equal(crumb.resends, 1, '面包屑要记下"重连补发过一次"');
});

/* ------------------ 5) 大响应解压必须有截止时刻 ------------------ */

/** 在 vm 里跑生产源码切出来的 `decompressGzip()`，可换掉 Blob/Response/DecompressionStream。 */
function loadDecompress(globals) {
  const slices = runSlices({
    declarations: [
      { name: 'DECOMPRESS_TIMEOUT_MS', source: sliceConst(SOURCE, 'DECOMPRESS_TIMEOUT_MS') },
      { name: 'decompressGzip', source: sliceFunction(SOURCE, 'decompressGzip') },
    ],
    globals,
  });
  return slices;
}

test('解压流卡住时必须超时收场（否则界面永久停在「加载中…」）', async () => {
  // 假的 Blob/DecompressionStream/Response：拼出来的流永远不结束 ——
  // 这正是 `new Response(stream).arrayBuffer()` 不 resolve 的那种坏法。
  const fake = {
    Blob: class { constructor(parts) { this.parts = parts; } stream() { return { pipeThrough: (ds) => ({ stalled: true, ds }) }; } },
    DecompressionStream: class { constructor(format) { this.format = format; } },
    Response: class { constructor(stream) { this.stream = stream; } arrayBuffer() { return new Promise(() => {}); } },
  };
  const { decompressGzip } = loadDecompress(fake);
  const startedAt = Date.now();
  let caught = null;
  try {
    await decompressGzip(new Uint8Array([1, 2, 3]), 150);
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(caught !== null, '卡住的解压必须抛错，不能无限挂起');
  assert.equal(caught.pocketCode, 'decompress');
  assert.match(String(caught.message), /解压超时/u);
  assert.ok(elapsed < 2_000, `超时判定必须贴着传入的窗口（实际 ${elapsed}ms）`);
});

test('坏字节与正常 gzip：区分得开，且失败都标 pocketCode=decompress（不许被当成"连不上"）', async () => {
  const { decompressGzip } = loadDecompress({ Blob, Response, DecompressionStream });
  const original = encoder.encode(JSON.stringify({ ok: true, pad: 'x'.repeat(2048) }));
  const gz = new Uint8Array(gzipSync(Buffer.from(original)));
  const round = await decompressGzip(gz, 3_000);
  assert.deepEqual(Array.from(round), Array.from(original), '正常 gzip 必须解回原字节');
  // 截断的 gzip（真实故障形态：分片丢了半截）
  let caught = null;
  try {
    await decompressGzip(gz.subarray(0, Math.max(4, gz.length - 8)), 3_000);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, '截断的 gzip 必须报错');
  assert.equal(caught.pocketCode, 'decompress', '归类成 decompress，net.js 才不会换新 id 把整份响应重拉一遍');
});

/* --------------- 5.5) 分片丢失：主动 NACK + 不再静默 --------------- */

test('半包卡住 2 秒就发 nack 指名补片（老桌面忽略它，行为不更糟）', async () => {
  const { relay, published } = harness();
  // 桌面 `authorized()` 是**逐帧**验令牌的：nack 不带 token 会被当成未授权丢掉。
  relay.session = { token: 'session-token-for-test' };
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 2, timeout: 4_000 }));
  await tick();
  const chunkId = '0a1b2c3d4e5f';
  const head = b64(JSON.stringify({ t: 'res', id: published[0].id, status: 200, headers: {}, body: b64('{"ok":true}') }));
  await deliver(relay, { t: 'part', id: chunkId, seq: 0, total: 2, d: head });
  assert.equal(relay.parts.size, 1);
  const now = Date.now();
  // 还不到 2 秒：不许打扰对端。
  relay.sweepParts(now + 500);
  await tick();
  assert.equal(published.filter((frame) => frame.t === 'nack').length, 0);

  // 卡住 2 秒：发一条 nack，id 必须是**分片 id**（不是 request id）。
  relay.sweepParts(now + 2_500);
  await tick();
  const nacks = published.filter((frame) => frame.t === 'nack');
  assert.equal(nacks.length, 1, '丢片只能由收方发现：桌面侧 publishSealed 对"broker 收下但没送到"完全无感');
  assert.equal(nacks[0].id, chunkId, 'nack 要指名那个 chunkId');
  assert.equal(nacks[0].sid, relay.sid);
  assert.ok(Number.isSafeInteger(nacks[0].seq) && nacks[0].seq > 0, 'nack 也要过 seq 重放校验');
  assert.ok(Number.isFinite(nacks[0].ts), 'nack 也要带新鲜时间戳');
  assert.equal(nacks[0].token, 'session-token-for-test', 'nack 必须带令牌：桌面逐帧授权，不带就白发了');
  assert.equal(relay.stats.partsNacked, 1);
  assert.equal(relay.partsStats().partsOpen, 1);

  // 5 秒内不重复（弱网下会刷成上行风暴）。
  relay.sweepParts(now + 3_000);
  await tick();
  assert.equal(published.filter((frame) => frame.t === 'nack').length, 1);
  // 隔够 5 秒可以再要一次。
  relay.sweepParts(now + 2_500 + 5_100);
  await tick();
  assert.equal(published.filter((frame) => frame.t === 'nack').length, 2);
  assert.equal(relay.stats.partsNacked, 2);

  // 补齐之后立刻停止 NACK，并且回包照样兑现。
  const tail = b64(JSON.stringify({ t: 'res', id: published[0].id, status: 200, headers: {}, body: b64('{"ok":true}') }));
  const whole = JSON.parse(Buffer.from(head, 'base64').toString('utf8'));
  const full = JSON.stringify(whole);
  const cut = Math.ceil(full.length / 2);
  await deliver(relay, { t: 'part', id: chunkId, seq: 0, total: 2, d: b64(full.slice(0, cut)) });
  await deliver(relay, { t: 'part', id: chunkId, seq: 1, total: 2, d: b64(full.slice(cut)) });
  await tick();
  assert.equal(state.kind, 'resolved', '补片之后必须能拼回完整响应');
  assert.equal(relay.parts.size, 0);
  relay.sweepParts(Date.now() + 60_000);
  await tick();
  assert.equal(published.filter((frame) => frame.t === 'nack').length, 2, '集齐之后不许再 NACK');
  void tail;
});

test('半包判定丢失：立刻同 id 自救（命中幂等缓存），额度用完就带原因失败', async () => {
  const { relay, published } = harness();
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 1, timeout: 30_000 }));
  await tick();
  const requestId = published[0].id;
  const chunkId = 'abcdefabcdef';
  await deliver(relay, { t: 'part', id: chunkId, seq: 0, total: 2, d: b64('{"half":') });
  assert.equal(relay.parts.size, 1);

  // 8 秒还没集齐 → 判定丢失 → 同 id 自救（桌面命中幂等缓存，回的是缓存里那份完整响应）。
  const resentBefore = published.filter((frame) => frame.t === 'req').length;
  relay.sweepParts(Date.now() + 8_100);
  await tick();
  assert.equal(relay.parts.size, 0, '丢了就别再占着表位');
  assert.equal(relay.stats.partsIncomplete, 1, '要计入诊断（快照里的 partsIncomplete）');
  const resent = published.filter((frame) => frame.t === 'req');
  assert.equal(resent.length, resentBefore + 1, '先自救：同 id 再要一次');
  assert.equal(resent.at(-1).id, requestId, '同一个 request id（幂等）');
  assert.equal(state.kind, 'pending', '自救期间请求还活着');

  // 再来一组又丢了：自救额度已用尽 → 立刻失败，带 pocketCode=parts_lost（net.js 据此换新 id 重试）。
  await deliver(relay, { t: 'part', id: '111111111111', seq: 0, total: 2, d: b64('{"half":') });
  relay.sweepParts(Date.now() + 8_200);
  await tick();
  assert.equal(state.kind, 'rejected', '不许让用户干等到预算耗尽');
  assert.equal(state.error?.pocketCode, 'parts_lost');
  assert.match(String(state.error?.message), /分片没到齐/u);
  assert.equal(relay.stats.partsIncomplete, 2);
});

test('换链路把半包清掉时也要记账（旧实现静默 clear）', async () => {
  const { relay } = harness();
  track(relay.request({ method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 2, timeout: 4_000 }));
  await tick();
  await deliver(relay, { t: 'part', id: '222222222222', seq: 0, total: 2, d: b64('{"half":') });
  assert.equal(relay.parts.size, 1);
  relay.ready = false;
  relay.abortTransport('重连中');
  assert.equal(relay.stats.partsIncomplete, 1, '跨链路作废的半包必须计入诊断，否则"网络恢复了页面还不动"没有痕迹');
});

test('诊断快照里有分片三件套（partsOpen / partsIncomplete / partsNacked）', async () => {
  const source = await readFile(join(ROOT, 'remote', 'remote.js'), 'utf8');
  const block = source.slice(source.indexOf('globalThis.__POCKET_DIAG__ = {'), source.indexOf('globalThis.__POCKET_DIAG__ = {') + 1_200);
  for (const field of ['crumb:', 'timeouts:', 'resMiss:', 'rpcBudget:', 'partsOpen:', 'partsIncomplete:', 'partsNacked:']) {
    assert.match(block, new RegExp(field, 'u'), `快照必须提供 ${field}`);
  }
  // 白名单照旧：房间密钥 / 设备令牌 / 链接里的 r、t 一个都不许进快照。
  for (const banned of ['deviceToken', 'this.room', "get('k')", "get('r')"]) {
    assert.equal(block.includes(banned), false, `快照里不该出现 ${banned}`);
  }
  assert.match(source, /inflight: \(\) => relay\.inflight\(\)/u, '界面要靠它显示"正在重试第几次"');
});

/* ------------- 6) 界面：进度文案 / 失败出口（DOM 路径的结构门禁） ------------- */
test('详情视图：3 秒后的进度文字会真的刷新到界面上', async () => {
  const source = await readFile(join(ROOT, 'web', 'views', 'detail.js'), 'utf8');
  // `store.detailWaitText` 是 app.js 每秒算出来的进度文案；占位行必须读它。
  assert.match(source, /wait: String\(store\.detailWaitText/u, '加载占位要把进度文案带下去');
  // loading 行的 update 必须真的改文字（旧实现是 `update: () => {}`，永远停在「加载中…」）。
  const loadingCase = source.slice(source.indexOf("case 'loading'"), source.indexOf("case 'divider'"));
  assert.match(loadingCase, /update\(entry\)/u);
  assert.match(loadingCase, /loadingText\(next\?\.message\)/u, '占位行要经过 loadingText()（进度文案优先）');
  assert.match(loadingCase, /textContent = text/u, 'messageNode 的 loading 行要能更新文字');
  assert.match(loadingCase, /update\(entry\)[\s\S]{0,200}return \{ el, update \};/u, 'update 必须真的返回出去，不能是死代码');
  // 一条"防退化"的直白门禁：`update` 一进门就 return 等于回到旧实现（永不更新文案）。
  assert.equal(/const update = \([^)]*\) => \{\s*return;/u.test(loadingCase), false,
    'loading 行的 update 不许是空实现');
});

test('详情视图：读失败时提示条一定会画出来（含重试 + 返回列表），不许停在加载态', async () => {
  const source = await readFile(join(ROOT, 'web', 'views', 'detail.js'), 'utf8');
  const headerAt = source.indexOf('function updateHeader()');
  // 这个早退在本文件里出现不止一次（`send()` / `openMenu()` 里也有同形的判空），
  // 必须限定在 updateHeader 之内找，否则测的根本不是那一处。
  const earlyReturnAt = source.indexOf('if (task === undefined || task === null)', headerAt);
  const noticeAt = source.indexOf('paintNotice();', headerAt);
  assert.ok(headerAt > 0 && earlyReturnAt > headerAt && noticeAt > 0);
  assert.ok(noticeAt < earlyReturnAt,
    '提示条必须画在"没有缓存任务就 return"之前：深链直接进会话时 store.tasks 里没有这个 id，'
    + '旧实现在这里提前 return，界面是一片空白（既没字也没按钮）');
  assert.match(source, /text: '重试'/u);
  assert.match(source, /text: '返回列表'/u, '失败要给出可操作的第二个出口');
  const app = await readFile(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /store\.detailError = detailFailureText\(\{ message: error\?\.message, code: error\?\.code \}\)/u,
    '失败文案要带"重试/返回列表"的指引，而不是把 error.message 直接丢给用户');
  assert.match(app, /timeout: DETAIL_TIMEOUT_MS/u, '详情超时必须来自 rpc-budget.js（与外壳预算同源）');
});
