/**
 * 单帧丢失的自愈节奏：**既有的「同 id 退避重发」在 1.2 s 就已经把它吃掉**，
 * 不需要再加一层 2 s 级的补救（下称 nudge）。
 *
 * 为什么单独钉这一条：1.0.5 之后有人提议"任何在途请求超过 2 s 还没收到 `res`
 * 就用同一个 id 再要一次"，理由是"单帧丢失要等 8 s 的 RPC 超时"。实测不是这样：
 *
 *   - `request()` 的第 1 次重发距首发只有 `RPC_BACKOFF_MS[0] = 1.2 s`，且沿用
 *     同一个 request id（桌面按 id 命中 120 s 幂等缓存 → 回放整份响应，不重复执行）；
 *   - 所以"丢一帧"的恢复时间是 **1.2 s + 中继往返**，比 2 s 才可能被考虑到的
 *     nudge 更早 —— 再加上 nudge 只能搭在 2 s 一次的看门狗 tick 上，检测延迟
 *     实际是 2~4 s，永远追不上。
 *
 * 离线端到端实测（真实 `lib/cloud.mjs` 桌面 + 真实 `remote/remote.js` 手机端 +
 * 内存 broker，往返 600 ms）：单帧丢 1825 ms、2 片响应丢第 2 片 1832 ms；
 * 挂上 nudge 之后 1816 / 1821 ms（差值在噪声内），且 nudge 一次都没触发。
 * 复跑方式见 `test/domain/shell-lost-frame-bench.test.mjs`（`POCKET_BENCH=1`）。
 *
 * 这个文件的作用就是**把这条时间线钉住**：谁把退避表改慢、谁把重发换成新 id
 * （桌面会重新执行）、谁把 attempts 降到 1 —— 用例立刻红，那正是"单帧丢失又要
 * 干等 8 s"的时刻（实测 attempts=1 时单帧丢失 8005 ms 后以 `relay_timeout` 失败）。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { RPC_ATTEMPTS, RPC_BACKOFF_MS, rpcWorstCaseMs } from '../../web/lib/rpc-budget.js';
import { PART_STALL_MS } from '../../web/lib/shell-parts.js';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const encoder = new TextEncoder();

let out;
let Relay;

before(async () => {
  out = await mkdtemp(join(tmpdir(), 'pocket-lost-frame-'));
  await run(process.execPath, [join(ROOT, 'tools', 'build-shell.mjs'), '--out', out], { cwd: ROOT });
  ({ Relay } = await import(pathToFileURL(join(out, 'remote.js')).href));
});

after(async () => {
  await rm(out, { recursive: true, force: true });
});

const tick = () => new Promise((done) => setTimeout(done, 0));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

const stubSealer = () => ({
  scope: 'scope-test',
  room: 'roomtest',
  seal: async (object) => JSON.stringify(object),
  unseal: async (text) => JSON.parse(text),
});

/** 假 MQTT 客户端：把上行帧连同**发出时刻**记下来，下行用 `deliver()` 灌。 */
function harness() {
  const published = [];
  const relay = new Relay({ room: 'roomtest', sealer: stubSealer(), brokers: ['wss://broker.invalid:8084/mqtt'] });
  relay.ready = true;
  relay.client = { publish: (_topic, payload) => { published.push({ frame: JSON.parse(payload), at: Date.now() }); } };
  return { relay, published };
}

/** 记下 promise 的结局但不 await —— 用来断言"它现在还挂着 / 已经兑现"。 */
function track(promise) {
  const state = { kind: 'pending', reply: undefined, error: undefined };
  promise.then((reply) => { state.kind = 'resolved'; state.reply = reply; }, (error) => { state.kind = 'rejected'; state.error = error; });
  return state;
}

const deliver = (relay, message) => relay.onMessage(encoder.encode(JSON.stringify(message)), relay.client);

/* -------------------------------- 用例 -------------------------------- */

test('退避表：第 1 次重发必须早于 2 s（这就是 2 s 级 nudge 永远追不上的原因）', () => {
  // 这三个数字不是"随手定的"：它们既是 `RPC_ATTEMPTS` 预算的组成部分（绝对截止
  // 15.2 s，见 test/domain/shell-rpc-budget），也是"丢一帧多久恢复"的唯一决定因素。
  // 改它等于改用户看到的等待时长 —— 必须同步复跑 bench，并重新回答"还要不要 nudge"。
  assert.deepEqual(RPC_BACKOFF_MS, [1_200, 2_400, 3_600], '第 1/2/3 次重发的等待');
  assert.equal(RPC_ATTEMPTS, 4, '同 id 重发总次数（首发 + 3 次重发）');
  assert.ok(RPC_BACKOFF_MS[0] < PART_STALL_MS,
    `第 1 次重发（${RPC_BACKOFF_MS[0]}ms）必须先于分片 stall 阈值（${PART_STALL_MS}ms）：`
    + '否则"丢一帧"真的要等 2 s 以上，才轮得到一层 tick 级补救');
  // 顺带钉住"预算没被偷偷放大"：绝对截止仍是 15.2 s。
  assert.equal(rpcWorstCaseMs(), 15_200);
});

test('单帧 res 丢失：1.2 s 的同 id 重发就自愈，全过程只多发一帧', async () => {
  const { relay, published } = harness();
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/lost-frame', headers: {}, gzip: false }));
  await tick();
  assert.equal(published.length, 1, '首发一帧');
  const requestId = published[0].frame.id;
  assert.equal(state.kind, 'pending');

  // 这一帧 res 在下行丢了（broker 收下、订阅方没收到）：什么都不投递。
  await sleep(1_450);
  assert.equal(published.length, 2, '2 s 之内必须已经用同一个 id 重发过一次');
  assert.equal(published[1].frame.id, requestId, '同一个 request id：桌面命中幂等缓存回放，不重复执行');
  const gap = published[1].at - published[0].at;
  assert.ok(gap >= 1_000, `重发时刻要贴着退避表（实测 ${gap}ms）`);
  assert.ok(gap < PART_STALL_MS,
    `第 1 次重发必须早于 ${PART_STALL_MS}ms 的 stall 阈值（实测 ${gap}ms）；`
    + '一旦比它晚，"单帧丢失"就真的需要额外的 2 s 级补救了');

  // 重发的回包到了 → 立刻兑现（用户看到内容）。
  const body = b64(JSON.stringify({ ok: true, data: { messages: [] } }));
  await deliver(relay, { t: 'res', id: requestId, status: 200, headers: {}, body });
  await tick();
  assert.equal(state.kind, 'resolved');
  assert.equal(state.reply.status, 200);
  // 只多发一帧：不许在看门狗 tick 上继续补帧。
  await sleep(120);
  assert.equal(published.length, 2, '重发一次就够，不许多余的重复');
  assert.equal(relay.pending.size, 0);
});

test('没有丢帧：只有一帧 req，任何补齐机制都不得引入额外上行帧', async () => {
  const { relay, published } = harness();
  const state = track(relay.request({ method: 'GET', path: '/api/v1/tasks/healthy', headers: {}, gzip: false }));
  await tick();
  assert.equal(published.length, 1);
  await deliver(relay, {
    t: 'res', id: published[0].frame.id, status: 200, headers: {}, body: b64(JSON.stringify({ ok: true })),
  });
  await tick();
  assert.equal(state.kind, 'resolved');
  assert.equal(published.length, 1, '正常路径的帧数不许因为"补齐机制"变多');
  assert.equal(relay.stats.timeouts, 0);
  // 面包屑里也不要出现任何"补发"计数：这条请求一次就成了。
  const crumb = relay.rpcBreadcrumbs().at(-1);
  assert.equal(crumb.tries, 1);
  assert.equal(crumb.resends, 0);
});
