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
  DECOMPRESS_TIMEOUT_MS, DETAIL_TIMEOUT_MS, RPC_ATTEMPTS, RPC_BACKOFF_MS, RPC_TIMEOUT_MS, rpcWorstCaseMs,
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
  assert.equal(pickNumber('DECOMPRESS_TIMEOUT_MS'), DECOMPRESS_TIMEOUT_MS,
    'DECOMPRESS_TIMEOUT_MS 两边必须相同：应用侧超时要把它算进"最坏耗时"里');
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

/** 在 vm 里跑生产源码切出来的 `decompressGzip()`，可换掉 `DecompressionStream`。 */
function loadDecompress(globals) {
  const slices = runSlices({
    declarations: [
      { name: 'DECOMPRESS_TIMEOUT_MS', source: sliceConst(SOURCE, 'DECOMPRESS_TIMEOUT_MS') },
      { name: 'decompressGzip', source: sliceFunction(SOURCE, 'decompressGzip') },
    ],
    globals: { DecompressionStream, ...globals },
  });
  return slices;
}

/**
 * 一个"读端永远不结束 / 直接报错"的 `DecompressionStream` 替身。
 *
 * 解压实现已经改成**直接写/读 `DecompressionStream`**（不再经 Blob → pipeThrough →
 * Response 中转，那是同一份数据的两次整缓冲搬运），所以这里伪造的坏法也跟着换成
 * "读写两端"：生产实现必须仍然（a）有截止时刻、（b）超时/失败后 `cancel()` 读端。
 */
function badStream({ failure = null } = {}) {
  const cancelled = { count: 0 };
  const reader = {
    read: () => (failure === null ? new Promise(() => {}) : Promise.reject(failure)),
    cancel: async () => { cancelled.count += 1; },
  };
  const writer = { write: () => Promise.resolve(), close: () => Promise.resolve() };
  return {
    cancelled,
    DecompressionStream: class {
      constructor(format) {
        this.format = format;
        return { readable: { getReader: () => reader }, writable: { getWriter: () => writer } };
      }
    },
  };
}

test('解压流卡住时必须超时收场（否则界面永久停在「加载中…」）', async () => {
  // 读端永远不 resolve —— 这正是 WebKit 的 `DecompressionStream` 半死时的那种坏法。
  const fake = badStream();
  const { decompressGzip } = loadDecompress({ DecompressionStream: fake.DecompressionStream });
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

test('C5：解压超时/失败必须取消底层流（旧实现只 reject，45~108 KB 缓冲常驻且可叠加）', async () => {
  // `Promise.race` 只是**不再等**那条流：不留引用、不 cancel 的话，reader 与已解出的
  // 缓冲会跟着这个永远不 resolve 的 promise 一起常驻，每失败一次叠一份。
  // ① 卡住的流 → 超时 → 必须 cancel。
  const stalled = badStream();
  let caught = null;
  try {
    await loadDecompress({ DecompressionStream: stalled.DecompressionStream })
      .decompressGzip(new Uint8Array([1, 2, 3]), 120);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.pocketCode, 'decompress');
  assert.equal(stalled.cancelled.count, 1, '超时后必须 cancel 读端，否则缓冲永远不释放');

  // ② 坏字节 → 读端 reject → 同样必须 cancel（catch 里统一释放）。
  const broken = badStream({ failure: new Error('invalid gzip data') });
  caught = null;
  try {
    await loadDecompress({ DecompressionStream: broken.DecompressionStream })
      .decompressGzip(new Uint8Array([9, 9, 9]), 3_000);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.pocketCode, 'decompress');
  assert.equal(broken.cancelled.count, 1, '解压失败的路径也要释放底层流');
});

test('坏字节与正常 gzip：区分得开，且失败都标 pocketCode=decompress（不许被当成"连不上"）', async () => {
  const { decompressGzip } = loadDecompress({ DecompressionStream });
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

test('半包判失走生产真实路径：2 s 看门狗先花掉自救额度，8 s 判死时只能 parts_lost', async () => {
  // 【为什么这条用例被改写过】旧版本只调一次 `sweepParts(Date.now()+8_100)`，跳过了
  // 2 s 的看门狗 tick，于是它断言"判失时还来得及同 id 自救"。但生产上
  // `startStaleWatch()` 每 2 s 就跑一次 `sweepParts()`，那条 8 s 路径上的 heal 额度
  // 在 2 s 就已经被花掉 —— 旧断言描述的是一条**生产上跑不到的路径**（探针证据：
  // 受害者从丢片起一路挂到 15.2 s 预算耗尽，最后拿 `relay_timeout`）。改成按真实
  // 时序走两拍，钉住"2 s 自救一次 → 8 s 直接 parts_lost"这条真的会发生的路。
  const { relay, published } = harness();
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 4, timeout: 30_000 }));
  await tick();
  const requestId = published[0].id;
  const chunkId = 'abcdefabcdef';
  // 桌面把这条大响应拆成两片，`rid` 指向被拆的那条请求（新桌面才有；老桌面缺省）。
  await deliver(relay, { t: 'part', id: chunkId, seq: 0, total: 2, d: b64('{"half":'), rid: requestId });
  assert.equal(relay.parts.size, 1);

  // ① 第 1 拍：2 s 看门狗（生产上先跑的永远是这一拍）。
  relay.sweepParts(Date.now() + 2_500);
  await tick();
  assert.equal(published.filter((frame) => frame.t === 'nack').length, 1, '2 s 就该 nack 补片');
  assert.equal(published.filter((frame) => frame.t === 'req').length, 2, '2 s 也该同 id 自救一次（老桌面不认 nack）');
  assert.equal(state.kind, 'pending', '自救期间请求还活着');

  // ② 第 2 拍：8 s 还没集齐 → 判失。补片没回来，而 heal 额度已经在第 1 拍用掉。
  relay.sweepParts(Date.now() + 8_100);
  await tick();
  assert.equal(relay.parts.size, 0, '丢了就别再占着表位');
  assert.equal(relay.stats.partsIncomplete, 1, '要计入诊断（快照里的 partsIncomplete）');
  assert.equal(state.kind, 'rejected', '额度已空：不许让用户干等到预算耗尽');
  assert.equal(state.error?.pocketCode, 'parts_lost', 'net.js 据此换一个新 id 重试');
  assert.match(String(state.error?.message), /分片没到齐/u);
});

/* -------- 5.6) C1：丢片自救/判死必须精确到"受害者"那条请求 -------- */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 两条在途请求 + 一组"只到了第 0 片"的大响应（`rid` 指向**后发**的那条 B）。
 *
 * 为什么必须两条：C1 的病灶就是"救错对象"——而旧实现挑的是**最老**的在途请求。
 * 只有让"最老的那条"和"丢片受害者"是两条不同的请求，用例才能在救错时变红。
 */
async function twoPendingWithVictimParts() {
  const { relay, published } = harness();
  const older = track(relay.request({
    method: 'GET', path: '/api/v1/tasks/list', headers: {}, gzip: false, attempts: 4, timeout: 30_000,
  }));
  await tick();
  const olderId = published.at(-1).id;
  // 让两条请求的 `entry.at` 真的错开（旧实现的"最老"判据就是它）。
  await sleep(8);
  const victim = track(relay.request({
    method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 4, timeout: 30_000,
  }));
  await tick();
  const victimId = published.at(-1).id;
  assert.notEqual(olderId, victimId, '两条请求各有自己的 request id');
  const chunkId = 'abcdefabcdef';
  await deliver(relay, { t: 'part', id: chunkId, seq: 0, total: 2, d: b64('{"half":'), rid: victimId });
  assert.equal(relay.parts.size, 1);
  const reqFramesFrom = (id) => published.filter((frame) => frame.t === 'req' && frame.id === id).length;
  assert.equal(reqFramesFrom(olderId), 1);
  assert.equal(reqFramesFrom(victimId), 1);
  return { relay, published, older, victim, olderId, victimId, chunkId, reqFramesFrom };
}

test('C1：2 s 看门狗的自救必须给「丢片的那条请求」（按 rid 精确），而不是最老的那条', async () => {
  const ctx = await twoPendingWithVictimParts();
  const { relay, published, older, victim, olderId, victimId, chunkId, reqFramesFrom } = ctx;
  // 断言失败也必须把 Relay 停下来：断链的实例会自己排重连，`node --test` 的进程
  // 就永远不退出（这也是"用例变红"和"用例把整套门禁挂死"的区别）。
  try {
    relay.sweepParts(Date.now() + 2_500);
    await tick();

    const nacks = published.filter((frame) => frame.t === 'nack');
    assert.equal(nacks.length, 1, '卡住 2 s 要补片');
    assert.equal(nacks[0].id, chunkId, 'nack 指的仍是分片 id（补的是片，不是请求）');
    assert.equal(nacks[0].rid, victimId, 'nack 要带 rid：桌面据此把"补这一组"与"哪条请求"对上');

    // 这两条断言就是 C1 的核心：救的必须是受害者，而不能是"最老的那条"。
    assert.equal(reqFramesFrom(victimId), 2, '受害者必须被同 id 重发一次（桌面幂等回放整份响应）');
    assert.equal(reqFramesFrom(olderId), 1, '旁观者一帧都不许多发：旧实现救的就是它（谁最老救谁）');
    assert.equal(older.kind, 'pending');
    assert.equal(victim.kind, 'pending');
  } finally {
    relay.stop('用例收尾');
  }
});

test('C1：8 s 判失要判死「受害者」，不许误杀最老那条（旧实现挑最老 → 杀错）', async () => {
  const ctx = await twoPendingWithVictimParts();
  const { relay, older, victim, olderId, victimId, reqFramesFrom } = ctx;
  try {
    // 第 1 拍先花掉受害者那唯一一次 heal 额度（生产上 2 s 看门狗必然先跑）。
    relay.sweepParts(Date.now() + 2_500);
    await tick();
    assert.equal(reqFramesFrom(victimId), 2);
    assert.equal(victim.kind, 'pending');

    // 第 2 拍：8 s 还没集齐 → 判失 → 自救额度已空 → 判死的就是受害者。
    relay.sweepParts(Date.now() + 8_100);
    await tick();
    assert.equal(relay.parts.size, 0, '判失的组必须真的从表里删掉');
    assert.equal(relay.stats.partsIncomplete, 1);
    assert.equal(victim.kind, 'rejected', '受害者必须立刻拿到结论，而不是挂到 15.2 s 预算耗尽拿 relay_timeout');
    assert.equal(victim.error?.pocketCode, 'parts_lost', 'net.js 据此换一个新的 request id 重试');
    assert.equal(older.kind, 'pending', '旁观者不许被误杀：旧实现在这里挑最老，杀的就是它');
    assert.equal(reqFramesFrom(olderId), 1, '旁观者也不该被"救"');
  } finally {
    relay.stop('用例收尾');
  }
});

test('C2：一个 2 s tick 最多只花掉一条请求的自救额度（旧实现一次吞掉 4 条）', async () => {
  const { relay, published } = harness();
  try {
    for (let index = 0; index < 3; index += 1) {
      track(relay.request({
        method: 'GET', path: `/api/v1/tasks/t${index}`, headers: {}, gzip: false, attempts: 4, timeout: 30_000,
      }));
      await tick();
    }
    const before = published.filter((frame) => frame.t === 'req').length;
    assert.equal(before, 3);
    // 三组都卡住（老桌面：分片帧没有 rid，只能走启发式）。
    for (const chunk of ['111111111111', '222222222222', '333333333333']) {
      await deliver(relay, partFrame(chunk, 0, 2, '{"half":'));
    }
    relay.sweepParts(Date.now() + 2_500);
    await tick();
    assert.equal(published.filter((frame) => frame.t === 'nack').length, 3, '三组都该补片');
    // heal 额度是**每条请求唯一**的：一个 tick 只能花一条。旧实现把这个调用写在
    // nack 循环里，一次 tick 就吃掉三条无关请求各自的额度 —— 真正卡住的那条第二次
    // nack（≈7.5 s）时额度已空，8 s 判死只能直接 parts_lost。
    const resent = published.filter((frame) => frame.t === 'req').length - before;
    assert.equal(resent, 1, `一个 tick 只能自救一次（实际重发了 ${resent} 帧）`);
  } finally {
    relay.stop('用例收尾');
  }
});

test('C2：多组同时卡住时，自救优先给「持有最老半包」那条请求的 rid（而不是最老的请求）', async () => {
  const { relay, published } = harness();
  try {
    const olderReq = track(relay.request({
      method: 'GET', path: '/api/v1/tasks/older', headers: {}, gzip: false, attempts: 4, timeout: 30_000,
    }));
    await tick();
    const olderId = published.at(-1).id;
    await sleep(8);
    const newerReq = track(relay.request({
      method: 'GET', path: '/api/v1/tasks/newer', headers: {}, gzip: false, attempts: 4, timeout: 30_000,
    }));
    await tick();
    const newerId = published.at(-1).id;
    assert.notEqual(olderId, newerId);
    // 第 1 组（创建更早）属于**后发的** newer；第 2 组（创建更晚）属于**先发的** older。
    // 于是"挑最老的请求"和"挑持有最老半包的请求"给出完全相反的答案。
    await deliver(relay, { t: 'part', id: 'aaaa11111111', seq: 0, total: 2, d: b64('{"x":'), rid: newerId });
    await sleep(6);
    await deliver(relay, { t: 'part', id: 'bbbb22222222', seq: 0, total: 2, d: b64('{"y":'), rid: olderId });
    assert.equal(relay.parts.size, 2);

    relay.sweepParts(Date.now() + 2_500);
    await tick();
    assert.equal(published.filter((frame) => frame.t === 'nack').length, 2, '两组都要补片');
    const reqs = published.filter((frame) => frame.t === 'req');
    assert.equal(reqs.filter((frame) => frame.id === newerId).length, 2,
      '自救要按"持有最老半包"那组的 rid 走');
    assert.equal(reqs.filter((frame) => frame.id === olderId).length, 1,
      '"在途最老"在这里恰恰是错的那条（旧实现会挑它）');
    assert.equal(olderReq.kind, 'pending');
    assert.equal(newerReq.kind, 'pending');
  } finally {
    relay.stop('用例收尾');
  }
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

test('C4：restart() 不许自己先清半包表 —— 记账必须落在 abortTransport 上', async () => {
  const { relay } = harness();
  track(relay.request({ method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 2, timeout: 30_000 }));
  await tick();
  await deliver(relay, { t: 'part', id: '333333333333', seq: 0, total: 2, d: b64('{"half":') });
  assert.equal(relay.parts.size, 1);
  // 让这次重建注定失败：真实的 `connect()` 要连 broker，这里只需要走到 catch。
  relay.connect = async () => { throw new Error('broker 连不上'); };
  try {
    const ok = await relay.restart('用例：重建失败');
    assert.equal(ok, false);
    assert.equal(relay.parts.size, 0, '半包仍然要清（跨链路的那份已经废了）');
    assert.equal(relay.stats.partsIncomplete, 1,
      '记账必须由 abortTransport 完成：restart() 里先 parts.clear() 的话，生产重连路径永远绕过记账，'
      + 'partsIncomplete 恒 0 —— "网络恢复了页面还不动"在手机侧一点痕迹都没有');
  } finally {
    // 重建失败会排下一次重连；断言失败时不停掉它，`node --test` 会永远等这个自愈环。
    relay.stop('用例收尾');
  }
});

test('C6：heal 额度用尽要回退到 retry（旧实现是"二选一"，一帧都不再发）', async () => {
  const { relay, published } = harness();
  try {
    track(relay.request({ method: 'GET', path: '/api/v1/tasks/heal-then-retry', headers: {}, gzip: false, attempts: 3, timeout: 30_000 }));
    await tick();
    const id = published.at(-1).id;
    const entry = relay.pending.get(id);
    assert.equal(entry.heal(), true, '第一次自救（重连补发）应当成功');
    await tick();
    assert.equal(published.filter((frame) => frame.t === 'req').length, 2);
    assert.equal(entry.heal(), false, 'heal 额度只有一次');
    // 再有一次重连：heal 已经用尽，但 attempt 预算还剩 —— 必须回退到 retry。
    const before = published.filter((frame) => frame.t === 'req').length;
    relay.resendPending('用例：再连一次');
    await tick();
    const resent = published.filter((frame) => frame.t === 'req');
    assert.equal(resent.length, before + 1, 'heal 用尽时必须回退 retry，而不是什么都不做（探针：2→2 帧）');
    assert.equal(resent.at(-1).id, id, '同一个 request id（桌面按 id 幂等回放）');
  } finally {
    relay.stop('用例收尾');
  }
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
  // F3：失败文案必须带上"链路重建过没有 / 自动补过没有"两个标记，否则
  // 「链路刚重建过」与「电脑端没响应」在界面上长得一模一样。
  assert.match(app, /store\.detailError = detailFailureText\(\{[\s\S]{0,260}?message: error\?\.message/u,
    '失败文案要带"重试/返回列表"的指引，而不是把 error.message 直接丢给用户');
  assert.match(app, /rebuilt: error\?\.linkRebuilt === true/u,
    '要把 net.js 标的"这次失败之后链路重建过"传给文案（F3）');
  assert.match(app, /retried: error\?\.autoRetried === true/u,
    '要把"已经自动补过一次重试"传给文案（F3）');
  assert.match(app, /timeout: DETAIL_TIMEOUT_MS/u, '详情超时必须来自 rpc-budget.js（与外壳预算同源）');
});

test('半包卡住 2 秒：除 nack 之外还要同 id 重发（老桌面不认 nack 时的唯一自救）', async () => {
  const { relay, published } = harness();
  relay.session = { token: 'session-token-for-test' };
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/big', headers: {}, gzip: false, attempts: 2, timeout: 30_000 }));
  await tick();
  const requestId = published[0].id;
  await deliver(relay, { t: 'part', id: 'aabbccddeeff', seq: 0, total: 2, d: b64('{"half":') });
  assert.equal(relay.parts.size, 1);

  const before = published.filter((frame) => frame.t === 'req').length;
  relay.sweepParts(Date.now() + 2_500);
  await tick();

  // ① 新桌面：nack 指名补片。
  assert.equal(published.filter((frame) => frame.t === 'nack').length, 1, '2 秒仍要发 nack');
  // ② 老桌面（1.0.3 及更早）：nack 被忽略，所以必须同时用同 id 重发，靠 120s 幂等缓存回放整份响应。
  const reqs = published.filter((frame) => frame.t === 'req');
  assert.equal(reqs.length, before + 1, '老桌面不认识 nack：同一刻必须同 id 重发，否则只能干等 8 秒');
  assert.equal(reqs.at(-1).id, requestId, '必须同一个 request id（幂等回放，不重复执行）');
  assert.equal(state.kind, 'pending', '自救期间请求还活着');
});