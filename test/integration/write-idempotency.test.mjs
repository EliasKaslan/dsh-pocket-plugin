/**
 * R2：写请求的**跨端幂等**——中继把 request id 交给本地桥（`x-pocket-id`），
 * 桥对写方法做短期幂等缓存。
 *
 * 修的故障：中继在 `AbortSignal.timeout(30_000)` 超时或上游 5xx 时按「结果未知」
 * 处理，允许同一个 request id 重发；但旧的注释把安全性押在「宿主的 request id
 * 语义会去重」上 —— 这个假设**不成立**，手机端的 request id 从未转发给本地桥。
 * 于是任何 POST 在桥侧超过 30 s（起 agent、长 prompt）或先落库后返 5xx，重试就
 * 会把副作用做第二遍。
 *
 * 全部用真 BridgeCore + 真 BridgeServer + 真 HTTP（端口 0、临时目录），只在
 * 「让业务函数慢一点」这一处对 `core.index.promptTask` 做了实例级打桩。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { POCKET_ID_HEADER } from '../../lib/cloud.mjs';
import { BridgeServer } from '../../lib/server.mjs';
import { request, requestJson, startBridge } from './support/harness.mjs';

let ctx;
let token;

const HEADER = 'x-pocket-id';

before(async () => {
  ctx = await startBridge();
  token = ctx.mint({ name: '幂等测试设备' }).token;
});

after(async () => {
  await ctx?.close();
});

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** POST /api/v1/tasks（真实业务函数：会调 core.index.createTask → agents.create）。 */
function postTask(pocketId, { auth = true, extraHeaders = {} } = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (auth) headers.authorization = `Bearer ${token}`;
  if (pocketId !== undefined) headers[HEADER] = pocketId;
  return requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '幂等测试', cwd: ctx.workRoot }),
  });
}

test('两侧头名不许漂移：lib/cloud.mjs 的 POCKET_ID_HEADER 就是桥认的那个头', () => {
  assert.equal(POCKET_ID_HEADER, HEADER);
  // 桥侧常量不在导出里，行为由下面的用例钉住：用这个字面量发的写请求必须被去重。
});

test('R2b：同一个 x-pocket-id 的第二次 POST 回放同样的响应体，业务函数只调用一次', async () => {
  const createdBefore = ctx.fakes.created.length;
  const first = await postTask('pocket-1');
  assert.equal(first.status, 201, `第一次创建应 201，实际 ${first.status}: ${first.body.slice(0, 160)}`);
  assert.equal(first.json.ok, true);
  const taskId = first.json.data.task.id;

  const second = await postTask('pocket-1');
  assert.equal(second.status, 201, '回放必须连同 status 一起回放（不是重新执行后再回 200 reused）');
  assert.equal(second.body, first.body, '第二次必须逐字节回放同一份响应体');
  assert.equal(second.json.data.task.id, taskId, '必须指向同一个任务');
  assert.equal(ctx.fakes.created.length, createdBefore + 1, '业务函数（agents.create）只许被调用一次');
  assert.ok(ctx.server.idempotentReplays >= 1, '回放要计数，否则线上看不出这层在工作');
  assert.equal(ctx.server.idempotentPending.size, 0, '回放之后不许留下在途占位');
});

test('R2b：不同 x-pocket-id 各自执行（别把去重做成"只执行第一条"）', async () => {
  const createdBefore = ctx.fakes.created.length;
  const first = await postTask('pocket-2a');
  const second = await postTask('pocket-2b');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.json.data.task.id, second.json.data.task.id, '不同 id 是不同操作');
  assert.equal(ctx.fakes.created.length, createdBefore + 2);
});

test('R2b：没有 x-pocket-id（本机直连 / 旧客户端）时行为不变——两次都真的执行', async () => {
  const createdBefore = ctx.fakes.created.length;
  const first = await postTask(undefined);
  const second = await postTask(undefined);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body, second.body, '没有该头就不许去重');
  assert.equal(ctx.fakes.created.length, createdBefore + 2);
});

test('R2b：401 不进缓存——未授权请求不许"借"到已成功请求的响应', async () => {
  // 先用合法令牌把 pocket-3 成功执行一次（响应会进缓存）。
  const ok = await postTask('pocket-3');
  assert.equal(ok.status, 201);
  const cachedCount = ctx.server.idempotent.size;

  // 同一个 pocket id，但令牌无效：必须重新鉴权 → 401，且不许动缓存。
  const replaysBefore = ctx.server.idempotentReplays;
  const unauthorized = await postTask('pocket-3', { auth: false });
  assert.equal(unauthorized.status, 401, `401 必须原样返回，实际 ${unauthorized.status}`);
  assert.equal(ctx.server.idempotent.size, cachedCount, '401 不许进幂等缓存');
  assert.equal(ctx.server.idempotentReplays, replaysBefore, '401 也不许命中别人的缓存（凭据指纹在键里）');

  // 再换一个没有历史记录的 id：401 依然不能被缓存下来挡后续的合法请求。
  const before = ctx.server.idempotent.size;
  const firstAnon = await postTask('pocket-3a', { auth: false });
  const secondAnon = await postTask('pocket-3a', { auth: false });
  assert.equal(firstAnon.status, 401);
  assert.equal(secondAnon.status, 401);
  assert.equal(ctx.server.idempotent.size, before, '两次 401 都不许留下缓存条目');
  const authorized = await postTask('pocket-3a');
  assert.equal(authorized.status, 201, '同 id + 合法令牌必须真的执行，而不是回放 401');
});

test('R2b：403（凭据/来源状态）同样不进缓存', async () => {
  const before = ctx.server.idempotent.size;
  const post = () => request(ctx.port, '/api/v1/devices/dev_x/revoke', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      [HEADER]: 'pocket-403',
      // 中继标记 → 桥把它当远程请求，回环专用写入口回 403 loopback_only。
      'x-pocket-relay': ctx.core.relayNonce,
    },
  });
  const first = await post();
  const second = await post();
  for (const response of [first, second]) {
    assert.equal(response.status, 403, `回环专用写入口应 403，实际 ${response.status}`);
  }
  assert.equal(ctx.server.idempotent.size, before, '403 不许进幂等缓存');
});

test('R2b：第一份还在执行时收到同 id 重发（30 s 超时场景）→ 等结果回放，不再执行一遍', async () => {
  // 先建一个任务，然后用一个"慢"的 prompt 业务函数模拟起 agent / 长 prompt。
  const taskId = (await postTask('pocket-4')).json.data.task.id;
  const agent = ctx.fakes.agents.get(taskId);
  assert.notEqual(agent, undefined);

  const original = ctx.core.index.promptTask.bind(ctx.core.index);
  let calls = 0;
  ctx.core.index.promptTask = async (id, prompt, options) => {
    calls += 1;
    await delay(400); // 中继 30 s 超时的缩微版：第一份还没返回
    return original(id, prompt, options);
  };
  try {
    const prompt = () => requestJson(ctx.port, `/api/v1/tasks/${taskId}/prompt`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        [HEADER]: 'pocket-4-prompt',
      },
      body: JSON.stringify({ prompt: '慢 prompt' }),
    });
    const firstPromise = prompt();
    // 等第一份真的进到"在途"里（中继 30 s 超时后重发时，第一份早已在跑）。
    await delay(100);
    const secondPromise = prompt();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body, second.body, '重发必须拿到与第一份完全相同的响应体');
    assert.equal(calls, 1, '在途期间的重发不许并行再执行一遍（否则副作用做两次）');
  } finally {
    ctx.core.index.promptTask = original;
  }
});

test('D2：同键等待有上界 —— 默认 32 s（有限、且明显大于中继的 30 s 超时）', () => {
  const wait = ctx.server.idempotentWaitMs;
  assert.equal(typeof wait, 'number', '等待上限必须是可读的数字');
  assert.ok(
    Number.isFinite(wait) && wait >= 30_000 && wait <= 120_000,
    `同键重发最多等第一份多久必须有上界（且要大于中继 30 s 的 requestTimeout，否则会先被自己的超时打断），实际 ${wait}`,
  );
});

test('D2：第一份永久不返回时，第二份也在上限内拿到明确结果（不是永久挂起）', async () => {
  const taskId = (await postTask('pocket-hang')).json.data.task.id;
  const agent = ctx.fakes.agents.get(taskId);
  assert.notEqual(agent, undefined);

  const originalPrompt = ctx.core.index.promptTask.bind(ctx.core.index);
  const originalWait = ctx.server.idempotentWaitMs;
  const waitTimeoutsBefore = ctx.server.idempotentWaitTimeouts;
  // 32 s 的缩微版：这条用例要证明的是「有超时 + 超时后给出明确答复」，不是等满 32 s。
  ctx.server.idempotentWaitMs = 150;

  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  ctx.core.index.promptTask = async (id, prompt, options) => {
    calls += 1;
    await gate; // 第一份挂在这里（模拟宿主 agents.create / followup 永不返回）
    return originalPrompt(id, prompt, options);
  };
  try {
    const prompt = () => requestJson(ctx.port, `/api/v1/tasks/${taskId}/prompt`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        [HEADER]: 'pocket-hang-prompt',
      },
      body: JSON.stringify({ prompt: '永不返回的 prompt' }),
    });

    const first = prompt(); // 永不 settle，直到 releaseFirst()
    await delay(120);
    assert.equal(ctx.server.idempotentPending.size, 1, '第一份在执行期间必须占着同键占位');

    const startedAt = Date.now();
    const second = await prompt();
    const elapsed = Date.now() - startedAt;

    assert.equal(second.status, 503, `第二份必须有明确结果，实际 ${second.status}：${second.body.slice(0, 160)}`);
    assert.equal(second.json.ok, false);
    assert.equal(second.json.error.code, 'in-progress', '要能区分于「重复执行被抑制」（409 duplicate-suppressed）');
    assert.equal(second.json.error.retryable, true, '结果未知但可重试，手机端才有重试依据');
    assert.equal(second.headers['retry-after'], '1', 'HTTP 语义上的 retry-after 也要给');
    assert.ok(elapsed >= 100 && elapsed < 5000, `第二份必须在上限量级返回（旧代码永久挂起），实际 ${elapsed}ms`);
    assert.equal(calls, 1, '等待期间绝不许并行执行第二遍（否则副作用做两次）');
    assert.equal(ctx.server.idempotentWaitTimeouts, waitTimeoutsBefore + 1, '超时要计数，线上才看得出这层在兜底');

    // 收尾：让第一份真的执行完，证明「第二份只是等待超时，第一份仍然有效」。
    releaseFirst();
    const settled = await first;
    assert.equal(settled.status, 200, '第一份自己的结果不受第二份超时影响');
    assert.equal(ctx.server.idempotentPending.size, 0, '第一份结束后同键占位必须清掉');

    // 第一份已经落库的响应能被同 id 回放 —— 手机丢了那条 503 之后再重试也不会重做副作用。
    const callsBeforeReplay = calls;
    const replay = await prompt();
    assert.equal(replay.status, 200);
    assert.equal(replay.body, settled.body, '第一份完成之后同 id 必须回放它的响应');
    assert.equal(calls, callsBeforeReplay, '回放不许再执行一次业务函数');
  } finally {
    releaseFirst();
    ctx.core.index.promptTask = originalPrompt;
    ctx.server.idempotentWaitMs = originalWait;
  }
});

test('D2：sweepIdempotent 回收孤儿的在途占位（第一份永远不返回时的兜底）', () => {
  const staleKey = BridgeServer.idempotencyKey('POST', '/api/v1/tasks', 'pocket-orphan', 'Bearer x');
  const freshKey = BridgeServer.idempotencyKey('POST', '/api/v1/tasks', 'pocket-orphan-fresh', 'Bearer x');
  const never = new Promise(() => {});
  ctx.server.idempotentPending.set(staleKey, { promise: never, at: Date.now() - 11 * 60_000 });
  ctx.server.idempotentPending.set(freshKey, { promise: never, at: Date.now() });
  const evictionsBefore = ctx.server.idempotentPendingEvictions;
  try {
    ctx.server.sweepIdempotent();
    assert.equal(
      ctx.server.idempotentPending.has(staleKey),
      false,
      '超过上界的孤儿占位必须被回收，否则这个 key 之后所有同键请求都只能等到超时拿 503',
    );
    assert.equal(ctx.server.idempotentPending.has(freshKey), true, '保鲜期内的占位不许动（那可能是在跑的第一份）');
    assert.equal(ctx.server.idempotentPendingEvictions, evictionsBefore + 1, '回收要计数');
  } finally {
    ctx.server.idempotentPending.delete(staleKey);
    ctx.server.idempotentPending.delete(freshKey);
  }
});

test('R2b 缓存上限：TTL 过了就重新执行；条数 ≤128；单条 >1 MiB 不缓存；总字节有界', async () => {
  // ① TTL：把条目时间戳推到 120 s 之外，sweep 之后同 id 必须重新执行。
  const before = ctx.server.idempotent.size;
  await postTask('pocket-ttl');
  assert.equal(ctx.server.idempotent.size, before + 1);
  const createdBefore = ctx.fakes.created.length;
  const [entry] = [...ctx.server.idempotent.values()].slice(-1);
  entry.at -= 121_000;
  ctx.server.sweepIdempotent();
  assert.equal(ctx.server.idempotent.size, before, 'TTL 之外的条目必须被清掉');
  const again = await postTask('pocket-ttl');
  assert.equal(again.status, 201);
  assert.equal(ctx.fakes.created.length, createdBefore + 1, 'TTL 过了要真的重新执行');

  // ② 条数：150 个不同 id 的写请求（ws-ticket 不触发创建限流）→ 只留 128 条。
  for (let index = 0; index < 150; index += 1) {
    await requestJson(ctx.port, '/api/v1/ws-ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, [HEADER]: `ticket-${index}` },
    });
  }
  assert.equal(ctx.server.idempotent.size, 128, '条数上限必须收口在 128');
  assert.ok(ctx.server.idempotentBytes <= 8 * 1024 * 1024, `总字节必须 ≤8 MiB，实际 ${ctx.server.idempotentBytes}`);

  // ③ 单条超过 1 MiB 的响应不进缓存（但仍在途回放）。
  const bigKey = BridgeServer.idempotencyKey('POST', '/api/v1/tasks', 'pocket-big', 'Bearer x');
  const big = Buffer.alloc(1024 * 1024 + 1, 0x20);
  ctx.server.rememberIdempotent(bigKey, { status: 200, headers: {}, body: big, bytes: big.length });
  assert.equal(ctx.server.idempotent.has(bigKey), false, '单条超过 1 MiB 不许进缓存');

  // ④ 总字节：塞几条接近上限的合法条目，超了按最旧淘汰。
  const chunk = Buffer.alloc(900 * 1024, 0x20);
  const bigKeys = [];
  for (let index = 0; index < 12; index += 1) {
    const key = BridgeServer.idempotencyKey('POST', '/api/v1/tasks', `pocket-limit-${index}`, 'Bearer x');
    bigKeys.push(key);
    ctx.server.rememberIdempotent(key, { status: 200, headers: {}, body: chunk, bytes: chunk.length });
  }
  assert.ok(ctx.server.idempotentBytes <= 8 * 1024 * 1024, `总字节必须被 8 MiB 收口，实际 ${ctx.server.idempotentBytes}`);
  assert.equal(ctx.server.idempotent.has(bigKeys[0]), false, '总字节超限时淘汰最旧的条目');
  assert.equal(ctx.server.idempotent.has(bigKeys[11]), true, '最新的一条必须还在（不许把刚写入的挤掉）');
  assert.equal(ctx.server.idempotent.size <= 128, true);
});
