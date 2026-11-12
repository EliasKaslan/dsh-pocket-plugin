/**
 * `POST /api/v1/tasks/:id/answer` 与详情里的 `pendingQuestions`。
 *
 * 走真实的 BridgeCore + BridgeServer + 真 HTTP（与仓库既有集成测试同一套脚手架）：
 *  - 服务不可用（老版本 DSH 没有 `userQuestions`）：详情恒 `[]`，接口 501 `unsupported`；
 *  - 服务可用：合法提交 200，返回更新后的 `{ task, pendingQuestions }`；
 *  - 参数不合法 400 `bad_answer`，`open` 409 `question_open`，阻塞式 409 `desktop_only`；
 *  - 投影里已经没有的提问 404 `question_not_found`；
 *  - 宿主抛 `REPLY_QUEUED` → 409 `reply_queued`；
 *  - 回答落地后（`user-question-reply` 事件）详情里的 pendingQuestions 清空。
 *
 * 不联网、不碰 ~/.dsh、端口由 harness 用 0 现取。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { jsonResponse, requestJson, startBridge } from './support/harness.mjs';

const QUESTION = {
  id: 'q1',
  question: '要继续部署吗？',
  header: '部署',
  detail: '会重启服务',
  options: [{ label: '继续', description: '马上执行' }, { label: '停止' }],
};

const ASK_EVENT = (callId, questions = [QUESTION]) => ({
  type: 'tool/call',
  data: { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions }) },
});

const REPLY_EVENT = (callId) => ({
  type: 'user/message',
  data: { source: { kind: 'user-question-reply', callId } },
});

let ctx;
let token;
let taskId;
const answered = [];

const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const jsonAuth = () => authed({ 'content-type': 'application/json' });

function feed(callId, questions) {
  ctx.core.index.handleEvent({ id: taskId, header: { id: taskId } }, ASK_EVENT(callId, questions));
}

function feedback(callId) {
  ctx.core.index.handleEvent({ id: taskId, header: { id: taskId } }, REPLY_EVENT(callId));
}

async function detail() {
  const response = await requestJson(ctx.port, `/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: authed() });
  return jsonResponse(response, 200, 'GET /api/v1/tasks/:id').data;
}

async function postAnswer(body, { headers = jsonAuth() } = {}) {
  const response = await requestJson(ctx.port, `/api/v1/tasks/${encodeURIComponent(taskId)}/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return response;
}

before(async () => {
  ctx = await startBridge();
  token = ctx.mint({ name: '答题集成测试手机', platform: 'test' }).token;
  const created = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: jsonAuth(),
    body: JSON.stringify({ prompt: '提问测试任务', cwd: ctx.workRoot, clientTaskId: 'answer-it-1' }),
  });
  taskId = jsonResponse(created, 201, 'POST /api/v1/tasks').data.task.id;
});

after(async () => {
  await ctx?.close();
});

/* ------------------------------------------------- 服务不可用：优雅降级 */

test('没有 userQuestions 服务：详情 pendingQuestions 是空数组，接口 501 unsupported', async () => {
  feed('call-unsupported');
  const data = await detail();
  assert.deepEqual(data.pendingQuestions, [], '服务不可用时必须恒为空数组，不能省略字段');
  assert.ok(Array.isArray(data.pendingQuestions));

  const response = await postAnswer({ callId: 'call-unsupported', answers: [{ id: 'q1', selected: ['继续'] }] });
  const body = jsonResponse(response, 501, 'POST /tasks/:id/answer（服务不可用）');
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'unsupported');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);

  // 收尾：这条问题在真实宿主里最终会被桌面端回答掉，让索引恢复干净状态。
  feedback('call-unsupported');
  assert.deepEqual((await detail()).pendingQuestions, []);
});

/* --------------------------------------------------------- 服务可用：成功路径 */

test('POST /tasks/:id/answer：未授权 401（鉴权闸在路由之前）', async () => {
  const response = await requestJson(ctx.port, `/api/v1/tasks/${encodeURIComponent(taskId)}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-ok', answers: [{ id: 'q1', selected: ['继续'] }] }),
  });
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.body).error.code, 'unauthorized');
});

test('绑定 userQuestions 后：详情能看到待答问题，提交成功返回 { task, pendingQuestions }', async () => {
  ctx.core.bindService('userQuestions', {
    answer(agent, callId, payload) {
      answered.push({ agent, callId, payload });
      return true;
    },
  });
  feed('call-ok');
  const before = await detail();
  const row = before.pendingQuestions.find((item) => item.callId === 'call-ok');
  assert.ok(row !== undefined, `详情里必须有 call-ok：${JSON.stringify(before.pendingQuestions)}`);
  assert.equal(row.state, 'unknown');
  assert.equal(row.answerable, true);
  assert.deepEqual(row.questions, [QUESTION]);

  const response = await postAnswer({ callId: 'call-ok', answers: [{ id: 'q1', selected: ['继续'] }] });
  const body = jsonResponse(response, 200, 'POST /tasks/:id/answer');
  assert.equal(body.ok, true);
  assert.equal(body.data.task.id, taskId);
  assert.deepEqual(body.data.pendingQuestions.map((row) => row.callId), []);

  assert.equal(answered.length, 1);
  assert.equal(answered[0].callId, 'call-ok');
  // `answer` 收到的是 live agent（不是 id），并把 answers 原样交上去。
  assert.equal(answered[0].agent, ctx.fakes.agents.get(taskId));
  assert.deepEqual(answered[0].payload, { answers: [{ id: 'q1', selected: ['继续'] }] });

  const cleared = await detail();
  assert.deepEqual(cleared.pendingQuestions, [], '回答成功后问题必须从详情里消失');
});

test('提问被回答（user-question-reply 事件）后详情里的 pendingQuestions 清空', async () => {
  feed('call-reply');
  assert.deepEqual((await detail()).pendingQuestions.map((row) => row.callId), ['call-reply']);
  feedback('call-reply');
  assert.deepEqual((await detail()).pendingQuestions, []);
});

test('参数不合法：缺 callId / 空 answers / 条数不匹配 → 400 bad_answer，且不会调宿主', async () => {
  feed('call-bad');
  const before = answered.length;
  const attempts = [
    { answers: [{ id: 'q1', selected: ['继续'] }] },
    { callId: 'call-bad', answers: [] },
    { callId: 'call-bad', answers: [{ id: 'q1', selected: ['继续'] }, { id: 'q2', selected: [] }] },
    { callId: 'call-bad', answers: [{ id: 'q1', selected: ['不是选项'] }] },
  ];
  for (const attempt of attempts) {
    const body = jsonResponse(await postAnswer(attempt), 400, `POST /tasks/:id/answer ${JSON.stringify(attempt)}`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'bad_answer', `坏参数必须回 bad_answer：${JSON.stringify(attempt)}`);
  }
  assert.equal(answered.length, before, '坏参数一条都不该送到宿主的 answer()');
});

test('宿主抛 REPLY_QUEUED → 409 reply_queued（不是 500，也不是静默成功）', async () => {
  ctx.core.bindService('userQuestions', {
    answer() {
      const error = new Error('a reply is already queued for this question');
      error.code = 'REPLY_QUEUED';
      throw error;
    },
  });
  feed('call-queued');
  const body = jsonResponse(await postAnswer({ callId: 'call-queued', answers: [{ id: 'q1', selected: ['停止'] }] }), 409, '回复排队');
  assert.equal(body.error.code, 'reply_queued');
});

/* --------------------------------- 投影分支：open / 阻塞式 / 已落定（状态必须可区分） */

test('投影说 open：409 question_open；投影里没有但事件里有（阻塞式）：409 desktop_only', async () => {
  let view = { active: [{ callId: 'call-open', questions: [QUESTION], state: 'open' }], settled: [] };
  ctx.core.bindService('sessions', {
    binding(id) {
      return { session: { projections: { faceOf: (key) => (key === 'userQuestions' ? { getSnapshot: () => (id === taskId ? view : undefined) } : { getSnapshot: () => undefined }) } } };
    },
  });
  ctx.core.bindService('userQuestions', {
    answer() { throw new Error('open 不该走到 answer()'); },
  });
  feed('call-open');
  feed('call-block');

  const listed = await detail();
  const open = listed.pendingQuestions.find((row) => row.callId === 'call-open');
  assert.equal(open.state, 'open');
  assert.equal(open.answerable, false);
  assert.equal(open.reason, 'open');
  const blocking = listed.pendingQuestions.find((row) => row.callId === 'call-block');
  assert.equal(blocking.answerable, false, '阻塞式提问只能电脑端回答，但必须看得见');
  assert.equal(blocking.reason, 'desktop-only');
  assert.equal(typeof blocking.state, 'string', '每项都必须带 state');

  const openBody = jsonResponse(await postAnswer({ callId: 'call-open', answers: [{ id: 'q1', selected: ['继续'] }] }), 409, 'open');
  assert.equal(openBody.error.code, 'question_open');
  const blockBody = jsonResponse(await postAnswer({ callId: 'call-block', answers: [{ id: 'q1', selected: ['继续'] }] }), 409, '阻塞式');
  assert.equal(blockBody.error.code, 'desktop_only');

  const ghost = jsonResponse(await postAnswer({ callId: 'never-asked', answers: [{ id: 'q1', selected: ['继续'] }] }), 404, '不存在');
  assert.equal(ghost.error.code, 'question_not_found');
});

test('投影说 continued：提交入队成功（open 与 continued 两条分支行为不同）', async () => {
  const view = { active: [{ callId: 'call-cont', questions: [QUESTION], state: 'continued' }], settled: [] };
  const seen = [];
  ctx.core.bindService('sessions', {
    binding() {
      return { session: { projections: { faceOf: () => ({ getSnapshot: () => view }) } } };
    },
  });
  ctx.core.bindService('userQuestions', {
    answer(agent, callId, payload) { seen.push({ callId, payload }); return true; },
  });
  feed('call-cont');
  const body = jsonResponse(await postAnswer({ callId: 'call-cont', answers: [{ id: 'q1', selected: ['继续'] }] }), 200, 'continued');
  assert.equal(body.ok, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].payload, { answers: [{ id: 'q1', selected: ['继续'] }] });
  // 投影仍说 active：pendingQuestions 以投影为准（"刷新后仍在"是宿主的真实状态）。
  const row = body.data.pendingQuestions.find((item) => item.callId === 'call-cont');
  assert.equal(row.state, 'continued');
  assert.equal(row.answerable, true);
});
