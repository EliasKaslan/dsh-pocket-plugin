/**
 * 幂等缓存的**字节预算**与「已执行」账本（R5）—— `lib/cloud.mjs` 的
 * `respond` / `remember` / `trimReplayCache` / `handleRequest`。
 *
 * 旧缓存只有条数闸：`REPLAY_CACHE_MAX = 128`。单帧上限是 4 MiB
 * （`MAX_FRAME × MAX_FRAME_TOTAL`），于是最坏情况是 128 × 4 MiB ≈ 512 MiB 的
 * base64 响应体常驻 120 s —— 手机端"狂刷详情页"就能把宿主内存打穿。
 *
 * FIFO 淘汰还有第二层危害：写请求（POST/PUT/PATCH/DELETE）的响应体一旦被挤掉，
 * 手机重发同一个 id 时就找不到缓存 → **重新执行** → 副作用做第二遍。
 *
 * 所以现在有两本账：
 *  - `recent`：响应体，按 16 MiB 总字节预算 + 条数 + TTL 收口，超预算优先淘汰
 *    非写响应；
 *  - `executed`：写方法的"已执行 id"，与响应体分离，**不随响应体淘汰**。响应体
 *    被挤掉时，重放会拿到一条明确的 409 `duplicate-suppressed`，而不是重跑。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudLink } from '../../lib/cloud.mjs';
import { decodeAll, makeLink, stubFetch } from './_support/fixtures.mjs';

/** 总字节预算（见 lib/cloud.mjs 的 REPLAY_CACHE_BYTES）。 */
const BYTES_BUDGET = 16 * 1024 * 1024;
const MIB = 1024 * 1024;

/** 造一条"响应体约 `chars` 字节"的 res 帧（`body` 本身就是 base64 文本）。 */
function responseOf(id, chars, overrides = {}) {
  return {
    t: 'res',
    id,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    enc: '',
    body: 'y'.repeat(chars),
    ms: 7,
    ...overrides,
  };
}

/**
 * 用响应体把缓存填到超预算。
 *
 * 直接调 `respond()` 而不是发一次真请求：这里要测的是记账/淘汰，566 行差距全在
 * `remember` 里。缓存键必须与 `handleRequest` 的构造完全一致（`方法 路径#id`）。
 */
function fill(link, { method, path, entries, chars }) {
  // state 置空 → publish() 直接丢弃，避免把几十 MB 的分片塞进 fake client。
  const previous = link.state;
  link.state = 'idle';
  try {
    for (let index = 0; index < entries; index += 1) {
      const id = `${method.toLowerCase()}-${index}`;
      const key = `${method} ${path}#${id}`;
      link.respond(id, responseOf(id, chars), key, { method });
    }
  } finally {
    link.state = previous;
  }
}

test('超预算淘汰后，写请求重放仍然命中"已执行"：不重跑、回 409', async () => {
  const { link, sent } = makeLink();
  const path = '/api/v1/tasks/task_abc/prompt';

  // 5 × ~3.6 MiB 响应体 ≈ 18.9 MiB > 16 MiB 预算（单条仍远低于 4 MiB 分片预算）。
  fill(link, { method: 'POST', path, entries: 5, chars: 3.6 * MIB });
  assert.ok(link.recentBytes <= BYTES_BUDGET, `字节预算必须守住（实际 ${Math.round(link.recentBytes / MIB)} MiB）`);
  assert.ok(link.recent.size < 5, '超预算必须淘汰（条数闸 128 挡不住体积）');

  const oldestKey = `POST ${path}#post-0`;
  assert.equal(link.recent.has(oldestKey), false, '最旧的那条响应体应已被预算挤掉');
  assert.equal(link.executed.has(oldestKey), true, '"已执行"账本不许跟着响应体一起消失');

  // 手机重发同一个写请求（同 id、同方法、同路径）。
  const stub = stubFetch('{"ok":true}');
  try {
    sent.length = 0;
    await link.handleRequest({ id: 'post-0', method: 'POST', path, body: '' });
    assert.equal(stub.calls.length, 0, '已执行过的写请求绝不能再打到本机 API');
    const [reply] = decodeAll(link, sent);
    assert.equal(reply?.status, 409, '响应体没了也要明确回一条"已执行"，不能静默');
    assert.equal(reply?.id, 'post-0');
    const body = JSON.parse(Buffer.from(reply.body, 'base64').toString('utf8'));
    assert.equal(body.error.code, 'duplicate-suppressed');
    assert.equal(link.stats.replays, 1);
  } finally {
    stub.restore();
  }
});

test('非写响应优先被淘汰：写请求的响应体留在缓存里，重放直接回原回包', () => {
  const { link } = makeLink();
  const postPath = '/api/v1/tasks/task_abc/prompt';
  const getPath = '/api/v1/tasks/task_abc';

  // 先一条写响应，再四条读响应：总量同样超过 16 MiB。
  const previous = link.state;
  link.state = 'idle';
  try {
    link.respond('post-0', responseOf('post-0', 3.6 * MIB), `POST ${postPath}#post-0`, { method: 'POST' });
    for (let index = 0; index < 4; index += 1) {
      const id = `get-${index}`;
      link.respond(id, responseOf(id, 3.6 * MIB), `GET ${getPath}#${id}`, { method: 'GET' });
    }
  } finally {
    link.state = previous;
  }

  assert.ok(link.recentBytes <= BYTES_BUDGET, '淘汰之后必须回到预算之内');
  assert.equal(link.recent.has(`POST ${postPath}#post-0`), true, '写响应必须优先保留（它是最贵的证据）');
  assert.equal(link.recent.has(`GET ${getPath}#get-0`), false, '最旧的**非写**响应应当先被淘汰');
});

test('真实请求路径：写方法记进"已执行"，读方法不记', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":true}');
  try {
    await link.handleRequest({ id: 'w1', method: 'POST', path: '/api/v1/tasks/task_abc/prompt', body: '' });
    await link.handleRequest({ id: 'r1', method: 'GET', path: '/api/v1/health' });

    assert.equal(stub.calls.length, 2);
    assert.equal(link.executed.has('POST /api/v1/tasks/task_abc/prompt#w1'), true, '写请求必须留下已执行记录');
    assert.equal(link.executed.has('GET /api/v1/health#r1'), false, '读请求不需要已执行记录');

    // 正常重试（响应体还在）走缓存，不重复执行。
    sent.length = 0;
    await link.handleRequest({ id: 'w1', method: 'POST', path: '/api/v1/tasks/task_abc/prompt', body: '' });
    assert.equal(stub.calls.length, 2, '同 id 的写请求重发不许重复执行');
    const [reply] = decodeAll(link, sent);
    assert.equal(reply.status, 200, '响应体还在时应当直接回放原回包');
    assert.equal(link.stats.replays, 1);
  } finally {
    stub.restore();
  }
});

test('"已执行"账本有上限：写请求刷屏也不会无限增长', async () => {
  const { link } = makeLink();
  const stub = stubFetch('{"ok":true}');
  try {
    for (let index = 0; index < 600; index += 1) {
      await link.handleRequest({ id: `w${index}`, method: 'POST', path: '/api/v1/tasks/task_abc/prompt', body: '' });
      link.recent.clear(); // 只压"已执行"账本，避免响应体预算先淘汰掉它们
      link.recentBytes = 0;
    }
    assert.ok(link.executed.size <= 512, `已执行账本必须有上限（实际 ${link.executed.size}）`);
    assert.equal(link.executed.has('POST /api/v1/tasks/task_abc/prompt#w599'), true, '最新那条必须还在');
  } finally {
    stub.restore();
  }
});

test('CloudLink.isWriteMethod：只有会改状态的方法才算写', () => {
  for (const method of ['POST', 'post', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(CloudLink.isWriteMethod(method), true, `${method} 是写方法`);
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS', '', undefined, null]) {
    assert.equal(CloudLink.isWriteMethod(method), false, `${String(method)} 不是写方法`);
  }
});
