/**
 * 写请求**永久丢失**的三个入口（R1 / R3 / R9）—— `lib/cloud.mjs` 的
 * `handleRequest` / `respond` / `remember` / `sweepExecuted`。
 *
 * R1（P1）：失败的写请求不能记成"已执行"。旧代码在 transport 失败（fetch reject
 *    / 超时 / 连接被拒）与上游 5xx 时也走 `remember()` → `executed.set()`，并把
 *   502 缓进 `recent`：
 *     手机同 id 重试 → 永远拿到缓存里的 502（120 s）；
 *     120 s 后响应体被字节预算/TTL 淘汰 → 变 409 `duplicate-suppressed`；
 *     于是写操作**永不重试**、副作用彻底消失，而两侧都以为"处理过了"。
 *   修法：只有确定的业务结果（2xx/3xx/4xx）才进两本账；transport 失败与 5xx 只
 *   留一条"不确定"标记，同 id 重试**允许再执行一次**。
 *
 * R3：`executed` 满 512 后旧代码在准入处硬拒 503，而且没有 `retryAfterSec` ——
 *   刷屏一次就把后面的写操作全废掉。现在按「最旧未过期」淘汰；仍然拒绝时必须
 *   带可重试语义。
 *
 * R9：`executed` 的键含会话令牌。写请求在途时"全部登出 → 401 → 重新登录"，同
 *   一个 id 会算出另一个键 → 同一个写操作被重新执行。修法是额外记一条**不含
 *   凭据**的 `(method, path, id)` 账。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { CloudLink } from '../../lib/cloud.mjs';
import {
  decodeAll, makeLink, stubFetch, waitFor,
} from './_support/fixtures.mjs';

const PROMPT = '/api/v1/tasks/task_abc/prompt';
const BODY = Buffer.from('{"text":"hi"}', 'utf8').toString('base64');

let restoreFetch;
afterEach(() => {
  if (typeof restoreFetch === 'function') restoreFetch();
  restoreFetch = undefined;
});

/**
 * 按次数决定行为的 fetch 桩：`handler(callIndex)` 返回 Response 或抛错。
 * `stubFetch()`（fixtures）只能固定一种结果，这里要"第一次失败、第二次成功"。
 */
function scriptFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, calls[calls.length - 1]);
  };
  restoreFetch = () => { globalThis.fetch = original; };
  return calls;
}

const json = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'application/json' },
});

test('R1：transport 失败（fetch 抛错）不许记为"已执行"，同 id 重试必须真的再执行一次', async () => {
  const { link, sent, logger } = makeLink();
  const calls = scriptFetch((index) => {
    if (index === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:47901');
    return json('{"ok":true,"src":"SECOND"}');
  });
  const key = CloudLink.requestKey('POST', PROMPT, 'w1');
  const bare = CloudLink.bareRequestKey('POST', PROMPT, 'w1');

  await link.handleRequest({ id: 'w1', method: 'POST', path: PROMPT, body: BODY });
  assert.equal(decodeAll(link, sent).at(-1).status, 502, 'fail-closed：仍要明确回一条失败');
  assert.equal(link.executed.has(key), false, 'transport 失败绝不许写「已执行」（否则重试永远拿 502/409）');
  assert.equal(link.executedBare.has(bare), false, '无凭据账也不许写');
  assert.equal(link.recent.has(key), false, '失败的 502 不许进幂等缓存（否则同 id 重试永远回 502）');
  assert.equal(link.uncertain.has(key), true, '要留一条「不确定」标记，供状态页与日志排查');
  assert.equal(link.stats.uncertain, 1);

  // 手机重发同一个 id（协议里重试就是同 id + 新 seq）。
  sent.length = 0;
  await link.handleRequest({ id: 'w1', method: 'POST', path: PROMPT, body: BODY });
  assert.equal(calls.length, 2, '同 id 重试必须真的打到本机 API（旧代码只回放缓存里的 502）');
  assert.equal(decodeAll(link, sent).at(-1).status, 200, '重试要拿到真实结果，而不是缓存的 502');
  assert.equal(link.executed.has(key), true, '第二次是确定的 2xx，才记「已执行」');
  assert.equal(link.uncertain.has(key), false, '成功之后清掉不确定标记');
  assert.ok(logger.lines.some((line) => line.includes('不确定的上次尝试')), '允许重试这件事要可诊断');
});

test('R1：上游 5xx 不许记为"已执行"，也不许把 5xx 缓存 120 秒', async () => {
  const { link, sent } = makeLink();
  let status = 502;
  const calls = scriptFetch(() => json('{"ok":false}', status));
  const key = CloudLink.requestKey('POST', PROMPT, 'w2');

  await link.handleRequest({ id: 'w2', method: 'POST', path: PROMPT, body: BODY });
  const failure = decodeAll(link, sent).at(-1);
  assert.equal(failure.status, 502, '上游的 5xx 要如实回给手机');
  assert.equal(link.executed.has(key), false, '5xx 不等于执行成功');
  assert.equal(link.recent.has(key), false, '5xx 不许进幂等缓存');
  assert.equal(link.uncertain.has(key), true);

  // 上游恢复：同一个 id 重试必须重新执行并拿到真实结果。
  status = 200;
  sent.length = 0;
  await link.handleRequest({ id: 'w2', method: 'POST', path: PROMPT, body: BODY });
  assert.equal(calls.length, 2, '上游恢复后重试必须重新执行（这正是旧代码永久丢失写操作的那一步）');
  assert.equal(decodeAll(link, sent).at(-1).status, 200);
  assert.equal(link.executed.has(key), true);

  // 再重发一次：这次是真的执行过了 → 回放缓存，不再执行。
  sent.length = 0;
  await link.handleRequest({ id: 'w2', method: 'POST', path: PROMPT, body: BODY });
  assert.equal(calls.length, 2, '成功之后的重发必须命中幂等缓存');
  assert.equal(link.stats.replays, 1);
});

test('R1：4xx 是确定的业务结果，照样记「已执行」（别把修复做成"永远重试"）', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":false,"error":{"code":"bad_request"}}', { status: 400 });
  try {
    const key = CloudLink.requestKey('POST', PROMPT, 'w4');
    await link.handleRequest({ id: 'w4', method: 'POST', path: PROMPT, body: BODY });
    assert.equal(link.executed.has(key), true, '400 说明上游收到了请求并做了判断');
    assert.equal(link.recent.has(key), true, '4xx 是确定的业务结果，可以回放');
    sent.length = 0;
    await link.handleRequest({ id: 'w4', method: 'POST', path: PROMPT, body: BODY });
    assert.equal(stub.calls.length, 1, '同 id 的 4xx 结果不许被重试成第二次副作用');
    assert.equal(decodeAll(link, sent).at(-1).status, 400);
  } finally {
    stub.restore();
  }
});

test('R3：已执行账本满 512 之后新写请求仍然执行（按最旧淘汰），不再一律 503', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":true}');
  try {
    for (let index = 0; index < 600; index += 1) {
      await link.handleRequest({ id: `w${index}`, method: 'POST', path: PROMPT, body: BODY });
      // 只压「已执行」账本，避免响应体预算先把它挤掉。
      link.recent.clear();
      link.recentBytes = 0;
    }
    assert.equal(stub.calls.length, 600, '每一次写请求都必须真的执行（旧代码在 512 条之后全部 503）');
    assert.ok(link.executed.size <= 512, `账本必须有上限（实际 ${link.executed.size}）`);
    assert.equal(link.executed.has(CloudLink.requestKey('POST', PROMPT, 'w599')), true, '最新的一条必须在');
    assert.equal(link.executed.has(CloudLink.requestKey('POST', PROMPT, 'w0')), false, '被淘汰的是最旧的');
    const refusals = decodeAll(link, sent).filter((message) => message.t === 'res' && message.status === 503);
    assert.equal(refusals.length, 0, '账本满不许变成 "503 且无 retryAfter"');
  } finally {
    stub.restore();
  }
});

test('R3：仍然拒绝时必须带 retryAfterSec / retryable，手机端才有重试依据', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":true}');
  try {
    // 在途槽位打满（MAX_PENDING = 96）：这是唯一还会回 503 的入口。
    for (let index = 0; index < 96; index += 1) {
      link.pending.set(`seed-${index}`, { controller: new AbortController() });
    }
    await link.handleRequest({ id: 'overflow', method: 'POST', path: PROMPT, body: BODY });
    assert.equal(stub.calls.length, 0);
    const refusal = decodeAll(link, sent).find((message) => message.id === 'overflow');
    assert.equal(refusal.status, 503);
    assert.equal(refusal.headers['retry-after'], '2', 'HTTP 语义上的 retry-after 也要给');
    const body = JSON.parse(Buffer.from(refusal.body, 'base64').toString('utf8'));
    assert.equal(body.error.code, 'busy');
    assert.equal(body.error.retryable, true, '必须明确告诉手机"可以重试"');
    assert.equal(body.error.retryAfterSec, 2);
    link.clearPending();
  } finally {
    stub.restore();
  }
});

test('R9：重登（会话令牌变了）之后同一个写 id 仍然被抑制，不会把副作用做第二遍', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":true,"n":1}');
  try {
    const request = { id: 'w9', method: 'POST', path: PROMPT, body: BODY };
    await link.handleRequest({ ...request, token: 'session-A' });
    assert.equal(stub.calls.length, 1);
    const bare = CloudLink.bareRequestKey('POST', PROMPT, 'w9');
    assert.equal(link.executedBare.has(bare), true, '必须另记一本不含令牌的账');

    // 写请求在途时"全部登出"→ 401 → 重新登录：令牌换了，请求语义没变。
    sent.length = 0;
    await link.handleRequest({ ...request, token: 'session-B' });
    assert.equal(stub.calls.length, 1, '令牌变了不等于换了一个操作，不许重新执行');
    const reply = decodeAll(link, sent).at(-1);
    assert.equal(reply.status, 409);
    assert.equal(JSON.parse(Buffer.from(reply.body, 'base64').toString('utf8')).error.code, 'duplicate-suppressed');

    // 反向对照：确实是**另一个** id 的写请求，必须照常执行（别过度抑制）。
    await link.handleRequest({ ...request, id: 'w10', token: 'session-B' });
    assert.equal(stub.calls.length, 2, '不同 id 是不同操作');
  } finally {
    stub.restore();
  }
});

test('R9：无凭据账与主账一样有上限与 TTL，不会无限增长', async () => {
  const { link } = makeLink();
  const stub = stubFetch('{"ok":true}');
  try {
    for (let index = 0; index < 520; index += 1) {
      link.markExecuted(CloudLink.requestKey('POST', PROMPT, `x${index}`), {
        method: 'POST', path: PROMPT, id: `x${index}`,
      });
    }
    assert.ok(link.executedBare.size <= 512, `无凭据账也要有上限（实际 ${link.executedBare.size}）`);
    link.sweepExecuted(Date.now() + 24 * 3600_000);
    assert.equal(link.executedBare.size, 0, 'TTL 之外的一律清掉');
    const before = link.executed.size;
    await link.handleRequest({ id: 'after-sweep', method: 'POST', path: PROMPT, body: BODY });
    assert.equal(link.executed.size, before + 1, '清理之后照常记账');
  } finally {
    stub.restore();
  }
});

test('R1：确定执行过（2xx）之后，响应体被淘汰仍回 409 —— 这条防线不能因为修复而消失', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":true}');
  try {
    await link.handleRequest({ id: 'once', method: 'POST', path: PROMPT, body: BODY });
    link.recent.clear(); // 模拟 120 s TTL / 字节预算把回包挤掉
    link.recentBytes = 0;
    sent.length = 0;
    await link.handleRequest({ id: 'once', method: 'POST', path: PROMPT, body: BODY });
    assert.equal(stub.calls.length, 1, '确定执行过的写请求不许重跑');
    assert.equal(decodeAll(link, sent).at(-1).status, 409);
    assert.ok(await waitFor(() => link.stats.replays >= 1));
  } finally {
    stub.restore();
  }
});
