/**
 * D1：断线瞬间的在途**写**条目滞留在 `pending` 里，同 id 重发被静默丢弃。
 *
 * 旧代码的 `clearPending()`（断线/重建时调用）对 `entry.write` 直接 `continue`：
 * 这是有道理的（在途 POST 可能已经落地，杀早了只会丢结果），但它同时意味这条
 * 条目只能等转发请求自己的 `AbortSignal.timeout(30_000)` 去删。一旦那一步没跑到
 * （进程被冻结、连接半死），它就永久占着 `MAX_PENDING = 96` 的配额；而手机重发
 * 同一个 id 时，入口的 `if (this.pending.has(cacheKey)) return;` 把请求**静默**
 * 丢掉 —— 手机干等 15.2 s 预算，写操作谁也没做。
 *
 * 修法（`lib/cloud.mjs`）：
 *  - 条目带上 `at`，`sweepPending()` 按 `PENDING_STALE_MS = 35 s` 回收过期条目；
 *  - 入口发现「在途但已过期」时允许本次重发**接管**（回收旧条目后继续执行），
 *    保鲜期内的仍然照旧丢弃 —— 防重复副作用的那道闸不许拆。
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { CloudLink } from '../../lib/cloud.mjs';
import { decodeAll, makeLink, waitFor } from './_support/fixtures.mjs';

const PROMPT = '/api/v1/tasks/task_abc/prompt';
const BODY = Buffer.from('{"text":"hi"}', 'utf8').toString('base64');
const json = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'application/json' },
});

let restoreFetch;
afterEach(() => {
  if (typeof restoreFetch === 'function') restoreFetch();
  restoreFetch = undefined;
});

/** 固定一种结果的 fetch 桩。 */
function stubFetch(body = '{"ok":true}', { status = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(json(body, status));
  };
  restoreFetch = () => { globalThis.fetch = original; };
  return calls;
}

/**
 * 第一个请求「永不 settle，但可以被 abort 打断」—— 正是断线瞬间在途 POST 的形状；
 * 第二次起正常回 200。
 */
function hangFirstFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length > 1) return Promise.resolve(json('{"ok":true,"src":"RESEND"}'));
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  restoreFetch = () => { globalThis.fetch = original; };
  return calls;
}

test('D1：断线时在途写条目不再永久占配额 —— 35 s 后 sweep 回收，同 id 重发真的执行', async () => {
  const { link, sent, logger } = makeLink();
  const calls = hangFirstFetch();
  const key = CloudLink.requestKey('POST', PROMPT, 'w1');

  const inflight = link.handleRequest({ id: 'w1', method: 'POST', path: PROMPT, body: BODY });
  assert.ok(
    await waitFor(() => link.pending.size === 1 && calls.length === 1),
    '第一个 POST 必须真的进入在途表（否则这条用例没测到 D1）',
  );
  assert.equal(link.pending.get(key)?.write, true, '写请求要按写条目登记');
  assert.equal(typeof link.pending.get(key)?.at, 'number', '条目必须带时间戳，否则没东西可判过期');

  // 断线：既有语义不变 —— 写条目**不许**被 clearPending 杀掉（它可能已经落地）。
  link.clearPending('云端连接中断');
  assert.equal(link.pending.has(key), true, '断线不许把在途写条目从表里抹掉');
  assert.equal(link.pending.size, 1);

  // 断线后立刻同 id 重发：仍保鲜期内 → 仍然静默丢弃（修复不能顺手拆掉这道闸）。
  sent.length = 0;
  await link.handleRequest({ id: 'w1', method: 'POST', path: PROMPT, body: BODY });
  assert.equal(calls.length, 1, '保鲜期内的同 id 重发必须仍然被挡住');
  assert.equal(decodeAll(link, sent).length, 0, '被挡住的重发本来就没有任何回包（旧行为）');

  // 35 s 之后的那一拍 housekeeping。
  link.sweep(Date.now() + 36_000);
  assert.equal(link.pending.size, 0, '过期条目必须被 sweep 回收，不能永久占 MAX_PENDING 配额');
  assert.equal(link.stats.stalePending, 1, '回收次数要能被诊断读到');
  assert.ok(logger.lines.some((line) => line.includes('回收过期在途请求')), '收回收要留一条可排查的日志');

  // 配额真的回来了：同 id 重发必须进入执行，而不是继续被静默吞掉。
  sent.length = 0;
  await link.handleRequest({ id: 'w1', method: 'POST', path: PROMPT, body: BODY });
  assert.equal(calls.length, 2, '回收之后同 id 重发必须真的打到本机 API');
  const reply = decodeAll(link, sent).at(-1);
  assert.equal(reply.status, 200, '重发要拿到真实结果');
  assert.equal(link.pending.size, 0, '执行完必须把在途条目删掉');

  await inflight; // 收尾：被 abort 的第一条请求不许悬着
});

test('D1：入口发现「在途已超时」就直接允许同 id 重发接管（不必等下一拍 sweep）', async () => {
  const { link, sent } = makeLink();
  const calls = stubFetch('{"ok":true,"src":"TAKEOVER"}');
  const key = CloudLink.requestKey('POST', PROMPT, 'w2');
  const controller = new AbortController();
  // 一条「已经 36 s 没回来」的在途写条目（等价于断线后滞留的那条）。
  link.pending.set(key, { write: true, controller, at: Date.now() - 36_000 });

  await link.handleRequest({ id: 'w2', method: 'POST', path: PROMPT, body: BODY });

  assert.equal(controller.signal.aborted, true, '过期条目的转发请求要 abort 掉（它已经不可能再回来）');
  assert.equal(calls.length, 1, '同 id 重发必须接管执行，而不是被 pending.has 静默丢弃');
  assert.equal(decodeAll(link, sent).at(-1).status, 200);
  assert.equal(link.pending.size, 0, '接管之后这条在途条目属于新的执行，也必须在结束时删掉');
  assert.equal(link.stats.stalePending, 1);
});

test('D1：配额回落 —— 96 条过期在途条目清掉之后，新请求不再回 503 busy', async () => {
  const { link, sent } = makeLink();
  const calls = stubFetch('{"ok":true}');
  const now = Date.now();
  for (let index = 0; index < 96; index += 1) {
    link.pending.set(`stale-${index}`, { write: true, controller: new AbortController(), at: now - 36_000 });
  }

  // 清理前：在途表满额 → 503 busy（这条既有语义保持不变）。
  await link.handleRequest({ id: 'health-1', method: 'GET', path: '/api/v1/health' });
  const refusal = decodeAll(link, sent).find((message) => message.id === 'health-1');
  assert.equal(refusal.status, 503, '满额时仍要明确回 503（不是静默丢弃）');
  assert.equal(calls.length, 0);

  // 一拍 housekeeping 之后配额应当完全回落。
  link.sweep(now + 36_000);
  assert.equal(link.pending.size, 0, '全部过期条目都要被回收');
  assert.equal(link.stats.stalePending, 96);

  const before = sent.length;
  await link.handleRequest({ id: 'health-2', method: 'GET', path: '/api/v1/health' });
  assert.equal(calls.length, 1, '配额回来之后新请求必须真的执行');
  assert.equal(decodeAll(link, sent.slice(before)).at(-1).status, 200);
});
