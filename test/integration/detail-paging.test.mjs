/**
 * 会话详情分页的 **HTTP 层**验收（真 server + 真路由 + 真鉴权）。
 *
 * 领域层（slicePage / detail）已有 test/domain/session-paging.test.mjs 覆盖；
 * 这里只验"接成 HTTP 之后"的事：游标校验、limit 生效、翻到最早、以及
 * 中继白名单是否放行带查询串的详情请求（上一轮就差点在这里翻车）。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { classifyRelayTarget } from '../../lib/cloud.mjs';
import { requestJson, startBridge } from './support/harness.mjs';

let ctx;
let authed;
let totalMessages;

function buildEvents(turns) {
  const events = [];
  let seq = 0;
  const t0 = 1_794_000_000_000;
  const push = (type, data) => { seq += 1; events.push({ type, seq, time: t0 + seq * 1000, data }); };
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn });
    push('user/message', { content: `第 ${turn} 轮提问` });
    push('assistant/message', { message: { content: `第 ${turn} 轮回答` } });
    push('turn/end', { reason: { kind: 'completed' } });
  }
  return events;
}

before(async () => {
  ctx = await startBridge({ services: true });
  const events = buildEvents(25); // 每轮 4 条消息 → 100 条
  totalMessages = 100;
  // 覆盖 harness 的假 sessionQuery：给它一段足够长的会话。
  ctx.core.bindService('sessionQuery', {
    async listSessions() { return []; },
    async readSurface() { return { events, capturedThroughSeq: events.length }; },
  });
  ctx.core.index.upsertRow({ header: { id: 'task-http', createdAt: 1 } });
  const minted = ctx.mint({ name: '分页测试手机', platform: 'test' });
  authed = { authorization: `Bearer ${minted.token}` };
});

after(async () => {
  await ctx?.close();
});

test('GET /tasks/:id?limit=2：严格遵守 limit，并给出 hasMore / nextBefore', async () => {
  const reply = await requestJson(ctx.port, '/api/v1/tasks/task-http?limit=2', { headers: authed });
  assert.equal(reply.status, 200);
  const data = reply.json.data;
  assert.ok(data.messages.length <= 2, `limit=2 最多两条，实际 ${data.messages.length}`);
  assert.equal(data.hasMore, true);
  assert.equal(typeof data.nextBefore, 'string');
  assert.ok(data.nextBefore.length > 0);
  assert.equal(data.total, totalMessages);
});

test('翻页：沿 nextBefore 一路走到最早，条数正好等于 total 且不重复', async () => {
  const first = (await requestJson(ctx.port, '/api/v1/tasks/task-http?limit=10', { headers: authed })).json.data;
  const ids = first.messages.map((message) => message.id);
  let page = first;
  let guard = 0;
  while (page.hasMore) {
    guard += 1;
    assert.ok(guard < 50, '翻页次数失控');
    const reply = await requestJson(
      ctx.port,
      `/api/v1/tasks/task-http?before=${encodeURIComponent(page.nextBefore)}&limit=10`,
      { headers: authed },
    );
    assert.equal(reply.status, 200);
    page = reply.json.data;
    assert.equal(page.cursorLost, false, '游标必须始终有效');
    ids.unshift(...page.messages.map((message) => message.id));
  }
  assert.equal(ids.length, totalMessages, `翻完必须等于 total，实际 ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, '不许重复');
});

test('非法游标 → 400 bad_cursor（不把任意长串透传进索引）', async () => {
  for (const bad of ['bad%20cursor', 'a%2Fb', 'x'.repeat(200)]) {
    const reply = await requestJson(ctx.port, `/api/v1/tasks/task-http?before=${bad}`, { headers: authed });
    assert.equal(reply.status, 400, `游标 ${bad.slice(0, 20)} 应被拒`);
    assert.equal(reply.json.error.code, 'bad_cursor');
  }
});

test('游标不存在（但合法）→ 200，并标记 cursorLost 回尾部一页', async () => {
  const reply = await requestJson(ctx.port, '/api/v1/tasks/task-http?before=not-a-real-id', { headers: authed });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.data.cursorLost, true);
  assert.ok(reply.json.data.messages.length > 0, 'reset 也要给一页可显示的内容');
});

test('不带参数就是首屏：尾部窗口、总量远小于 total、且带用户输入', async () => {
  const reply = await requestJson(ctx.port, '/api/v1/tasks/task-http', { headers: authed });
  const data = reply.json.data;
  assert.ok(data.messages.length < data.total, '首屏不该是全部');
  assert.equal(data.hasMore, true);
  assert.ok(data.messages.some((message) => message.role === 'user'), '必须带出用户输入');
  assert.equal(data.messages[data.messages.length - 1].kind, 'turn-end', '首屏贴着尾部');
});

test('中继白名单放行带查询串的详情请求（否则翻页在手机上全 403）', () => {
  const allowed = classifyRelayTarget('/api/v1/tasks/task-http?before=m-12&limit=40', 'GET');
  assert.equal(allowed.ok, true, `详情+查询串必须放行，实际 ${JSON.stringify(allowed)}`);
  assert.equal(allowed.route, 'tasks.get');
  // 但游标超长仍由中继的查询串上限拦住
  const tooLong = classifyRelayTarget(`/api/v1/tasks/task-http?before=${'x'.repeat(3000)}`, 'GET');
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'query-too-long');
});
