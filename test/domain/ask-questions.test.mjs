/**
 * `ask_user_question` 手机端问答：领域层 + 前端纯逻辑。
 *
 * 这里**不**起 HTTP（路由矩阵在 test/integration/answer-route.test.mjs）：
 * TaskIndex 是纯内存领域对象，用手搓 services 桩才能精确走到
 * 「投影可读 / 投影不可读 / 服务缺失 / 宿主返回 false」这几条分支。
 *
 * 与仓库既有约定一致：不联网、不碰 ~/.dsh、不占端口、不写仓库目录。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  mergePending, normalizeQuestions, questionsFromCall, replyCallId, resultCallId, resultIsPending,
} from '../../lib/question-state.mjs';
import { TaskIndex } from '../../lib/task-index.mjs';
import {
  answerPayload, buildAnswers, draftOf, setCustom, toggleChoice, unanswered,
} from '../../web/lib/answers.js';

/* ------------------------------------------------------------------ 工具 */

const INDEX_HOME = 'C:\\dsh-pocket-questions-test';

function makeIndex(services = {}) {
  const emitted = [];
  const warnings = [];
  const index = new TaskIndex({
    logger: { info() {}, warn: (...args) => warnings.push(args), error() {} },
    emit: (type, payload) => emitted.push({ type, payload }),
    state: { touchDevice() {} },
    config: {},
    services,
    home: INDEX_HOME,
    dataDir: INDEX_HOME,
  });
  return { index, emitted, warnings };
}

/** 用一条 turn/start 让任务进索引（真实路径，不手搓 task 对象）。 */
function seedTask(index, id = 's1') {
  index.handleEvent({ id, header: { id } }, { type: 'turn/start', data: { turn: 1 } });
  return id;
}

function emit(index, id, event) {
  index.handleEvent({ id, header: { id } }, event);
}

const callEvent = (callId, questions, name = 'ask_user_question') => ({
  type: 'tool/call',
  data: { name, callId, arguments: JSON.stringify({ questions }) },
});
const replyEvent = (callId) => ({
  type: 'user/message',
  data: { source: { kind: 'user-question-reply', callId } },
});
const resultEvent = (callId, text) => ({
  type: 'tool/result',
  data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } },
});

function projectionService(view) {
  return {
    binding(id) {
      return {
        session: {
          projections: {
            faceOf(key) {
              assert.equal(key, 'userQuestions');
              return { getSnapshot: () => (typeof view === 'function' ? view(id) : view) };
            },
          },
        },
      };
    },
  };
}

const QUESTIONS = [
  { id: 'q1', question: '继续部署吗？', header: '部署', detail: '会重启服务', options: [{ label: '继续', description: '马上执行' }, { label: '停止' }] },
];

/* ------------------------------------------------- 事件归一化（宿主参数是 snake_case） */

test('normalizeQuestions：multi_select 归一化成 multiSelect，坏条目直接丢弃', () => {
  const [question] = normalizeQuestions([{
    id: 'q1',
    question: '选一个',
    header: ' 部署 ',
    detail: '会重启服务',
    multi_select: true,
    options: [{ label: 'A', description: '甲' }, { label: '' }, { description: '没有 label' }, null],
  }]);
  assert.deepEqual(question, {
    id: 'q1',
    question: '选一个',
    header: '部署',
    detail: '会重启服务',
    multiSelect: true,
    options: [{ label: 'A', description: '甲' }],
  });
  assert.deepEqual(normalizeQuestions([{ id: '', question: 'x' }, { id: 'q', question: '' }, null]), []);
  // 已经是驼峰的投影行原样认。
  assert.equal(normalizeQuestions([{ id: 'q2', question: 'x', multiSelect: true }])[0].multiSelect, true);
});

test('questionsFromCall：只认 ask_user_question，参数可以是字符串或对象', () => {
  const found = questionsFromCall(callEvent('c1', QUESTIONS));
  assert.equal(found.callId, 'c1');
  assert.equal(found.state, 'unknown');
  assert.equal(found.questions[0].options.length, 2);
  assert.equal(questionsFromCall({ type: 'tool/call', data: { name: 'read', callId: 'c2', arguments: '{}' } }), undefined);
  assert.equal(questionsFromCall({ type: 'tool/call', data: { name: 'ask_user_question', callId: '', arguments: '{}' } }), undefined);
  assert.equal(questionsFromCall({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'c3', arguments: 'not json' } }), undefined);
  assert.equal(questionsFromCall({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'c4', arguments: { questions: [] } } }), undefined);
});

test('resultIsPending / resultCallId / replyCallId：落定与关闭的判据', () => {
  assert.equal(resultIsPending(resultEvent('c1', '{"pending":true,"callId":"c1"}')), true);
  assert.equal(resultIsPending(resultEvent('c1', ' { "pending" : true } ')), true);
  assert.equal(resultIsPending(resultEvent('c1', '{"answers":[]}')), false);
  assert.equal(resultIsPending(resultEvent('c1', 'continue')), false);
  assert.equal(resultIsPending({ type: 'tool/call' }), false);
  assert.equal(resultCallId(resultEvent('c1', 'x')), 'c1');
  assert.equal(resultCallId({ type: 'tool/call', data: {} }), undefined);
  assert.equal(replyCallId(replyEvent('c1')), 'c1');
  assert.equal(replyCallId({ type: 'user/message', data: { source: { kind: 'user' } } }), undefined);
  assert.equal(replyCallId({ type: 'assistant/message', data: { source: { kind: 'user-question-reply', callId: 'c1' } } }), undefined);
});

test('mergePending：open 不可答、continued 可答、投影可用而缺失的（阻塞式）标 desktop-only', () => {
  const merged = mergePending({
    projected: [
      { callId: 'open-1', questions: [{ id: 'q1', question: '前台等待' }], state: 'open' },
      { callId: 'cont-1', questions: [{ id: 'q2', question: '可答' }], state: 'continued' },
    ],
    tracked: [
      { callId: 'cont-1', questions: [{ id: 'q2', question: '可答' }], state: 'unknown' },
      { callId: 'block-1', questions: [{ id: 'q3', question: '阻塞式' }], state: 'unknown' },
    ],
  });
  assert.deepEqual(merged.map((row) => [row.callId, row.state, row.answerable, row.reason]), [
    ['open-1', 'open', false, 'open'],
    ['cont-1', 'continued', true, undefined],
    ['block-1', 'unknown', false, 'desktop-only'],
  ]);
  // 投影不可读：状态未知但允许尝试（服务端会给出明确拒绝）。
  assert.deepEqual(
    mergePending({ projected: undefined, tracked: [{ callId: 'x', questions: [{ id: 'q', question: '?' }], state: 'unknown' }] }),
    [{ callId: 'x', questions: [{ id: 'q', question: '?' }], state: 'unknown', answerable: true }],
  );
});

/* ---------------------------------------------------- TaskIndex：待答状态来源 */

test('事件兜底：tool/call 入 active，user-question-reply 出 active', () => {
  const { index } = makeIndex({ userQuestions: { answer: () => true } });
  const id = seedTask(index);
  emit(index, id, callEvent('c1', QUESTIONS));
  const pending = index.pendingQuestions(id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].callId, 'c1');
  assert.equal(pending[0].state, 'unknown');
  assert.equal(pending[0].answerable, true);
  assert.equal(pending[0].questions[0].multiSelect, undefined);

  emit(index, id, replyEvent('c1'));
  assert.deepEqual(index.pendingQuestions(id), []);
});

test('事件兜底：{pending:true} 的 tool result 把状态变成 continued，普通 result 直接落定', () => {
  const { index } = makeIndex({ userQuestions: { answer: () => true } });
  const id = seedTask(index);
  emit(index, id, callEvent('c1', QUESTIONS));
  emit(index, id, resultEvent('c1', '{"pending":true,"callId":"c1"}'));
  const pending = index.pendingQuestions(id);
  assert.equal(pending.length, 1, '计时提问让出前台等待后仍然要能看到');
  assert.equal(pending[0].state, 'continued');

  emit(index, id, callEvent('c2', QUESTIONS));
  emit(index, id, resultEvent('c2', '{"answers":[{"id":"q1","selected":["继续"]}]}'));
  assert.deepEqual(index.pendingQuestions(id).map((row) => row.callId), ['c1']);
});

test('投影优先：open / continued 由投影决定，与事件推导无关', () => {
  const view = {
    active: [
      { callId: 'open-1', questions: [{ id: 'q1', question: '前台等待' }], state: 'open' },
      { callId: 'cont-1', questions: [{ id: 'q2', question: '可答' }], state: 'continued' },
    ],
    settled: [],
  };
  const { index } = makeIndex({ userQuestions: { answer: () => true }, sessions: projectionService(view) });
  const id = seedTask(index);
  emit(index, id, callEvent('open-1', [{ id: 'q0', question: '旧副本（投影说了算）' }]));
  const pending = index.pendingQuestions(id);
  assert.deepEqual(pending.map((row) => [row.callId, row.state, row.answerable]), [
    ['open-1', 'open', false],
    ['cont-1', 'continued', true],
  ]);
  assert.equal(pending[0].questions[0].question, '前台等待', '投影里的问题文案优先于事件里的旧副本');
});

test('投影可用而 active 里没有的提问（阻塞式）标 desktop-only', () => {
  const { index } = makeIndex({
    userQuestions: { answer: () => true },
    sessions: projectionService({ active: [], settled: [] }),
  });
  const id = seedTask(index);
  emit(index, id, callEvent('block-1', QUESTIONS));
  const pending = index.pendingQuestions(id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].answerable, false);
  assert.equal(pending[0].reason, 'desktop-only');
});

test('投影读取抛错时退回事件推导，且只告警一次', () => {
  const { index, warnings } = makeIndex({
    userQuestions: { answer: () => true },
    sessions: { binding() { throw new Error('session gone'); } },
  });
  const id = seedTask(index);
  emit(index, id, callEvent('c1', QUESTIONS));
  assert.equal(index.pendingQuestions(id)[0].callId, 'c1');
  assert.equal(index.pendingQuestions(id)[0].callId, 'c1');
  assert.equal(warnings.length, 1, '投影不可用只该告警一次，不能每条详情刷一行');
});

test('userQuestions 服务缺失（老版本 DSH）：pendingQuestions 恒为空数组且不抛', () => {
  const { index } = makeIndex({});
  const id = seedTask(index);
  emit(index, id, callEvent('c1', QUESTIONS));
  assert.deepEqual(index.pendingQuestions(id), []);
});

/* ------------------------------------------------- TaskIndex：answerQuestion */

function answerFixture({ service, projection } = {}) {
  const calls = [];
  const agent = { id: 's1' };
  const userQuestions = service ?? {
    answer(target, callId, payload) {
      calls.push({ target, callId, payload });
      return true;
    },
  };
  const services = {
    userQuestions,
    agents: { get: (id) => (id === 's1' ? agent : undefined) },
  };
  if (projection !== undefined) services.sessions = projectionService(projection);
  const { index } = makeIndex(services);
  const id = seedTask(index);
  return { index, id, calls, agent };
}

const goodAnswers = [{ id: 'q1', selected: ['继续'] }];

test('answerQuestion：服务缺失 → unsupported（HTTP 层映射 501）', async () => {
  const { index } = makeIndex({});
  await assert.rejects(index.answerQuestion('s1', { callId: 'c1', answers: goodAnswers }), (error) => error.code === 'unsupported');
});

test('answerQuestion：answers 条数/问题 id/选项 label 不对 → bad_answer（400）', async () => {
  const { index, id } = answerFixture();
  emit(index, id, callEvent('c1', QUESTIONS));
  await assert.rejects(index.answerQuestion(id, { callId: 'c1', answers: [] }), (error) => error.code === 'bad_answer');
  await assert.rejects(
    index.answerQuestion(id, { callId: 'c1', answers: [{ id: 'other', selected: ['继续'] }] }),
    (error) => error.code === 'bad_answer',
  );
  await assert.rejects(
    index.answerQuestion(id, { callId: 'c1', answers: [{ id: 'q1', selected: ['不存在的选项'] }] }),
    (error) => error.code === 'bad_answer',
  );
  await assert.rejects(index.answerQuestion(id, { callId: '', answers: goodAnswers }), (error) => error.code === 'bad_answer');
});

test('answerQuestion：投影里 open → 明确拒绝（question_open），不会调宿主的 answer', async () => {
  const { index, id, calls } = answerFixture({
    projection: { active: [{ callId: 'c1', questions: QUESTIONS, state: 'open' }], settled: [] },
  });
  await assert.rejects(index.answerQuestion(id, { callId: 'c1', answers: goodAnswers }), (error) => error.code === 'question_open');
  assert.equal(calls.length, 0);
});

test('answerQuestion：投影里查不到但事件里有（阻塞式）→ desktop_only', async () => {
  const { index, id, calls } = answerFixture({ projection: { active: [], settled: [] } });
  emit(index, id, callEvent('block-1', QUESTIONS));
  await assert.rejects(index.answerQuestion(id, { callId: 'block-1', answers: goodAnswers }), (error) => error.code === 'desktop_only');
  assert.equal(calls.length, 0);
});

test('answerQuestion：投影里查不到且事件里也没有 → question_not_found（404）', async () => {
  const { index, id } = answerFixture({ projection: { active: [], settled: [] } });
  await assert.rejects(index.answerQuestion(id, { callId: 'ghost', answers: goodAnswers }), (error) => error.code === 'question_not_found');
});

test('answerQuestion：continued → 调 answer() 成功，事件兜底行随之清空', async () => {
  const { index, id, calls, agent } = answerFixture({
    projection: { active: [{ callId: 'c1', questions: QUESTIONS, state: 'continued' }], settled: [] },
  });
  emit(index, id, callEvent('c1', QUESTIONS));
  const result = await index.answerQuestion(id, { callId: 'c1', answers: goodAnswers });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, agent);
  assert.equal(calls[0].callId, 'c1');
  assert.deepEqual(calls[0].payload, { answers: goodAnswers });
  assert.equal(result.task.id, id);
  assert.deepEqual(result.pendingQuestions.map((row) => row.callId), ['c1'], '投影仍说 active，就以投影为准');
});

test('answerQuestion：宿主返回 false（open 的静默失败）→ question_open，绝不当作成功', async () => {
  const { index, id } = answerFixture({ service: { answer: () => false } });
  emit(index, id, callEvent('c1', QUESTIONS));
  await assert.rejects(index.answerQuestion(id, { callId: 'c1', answers: goodAnswers }), (error) => error.code === 'question_open');
  assert.equal(index.pendingQuestions(id).length, 1, '被拒绝的答复不能把问题从列表里抹掉');
});

test('answerQuestion：宿主抛 REPLY_QUEUED / BAD_ANSWER 按错误码翻译', async () => {
  const queued = answerFixture({
    service: { answer() { const error = new Error('a reply is already queued'); error.code = 'REPLY_QUEUED'; throw error; } },
  });
  emit(queued.index, queued.id, callEvent('c1', QUESTIONS));
  await assert.rejects(
    queued.index.answerQuestion(queued.id, { callId: 'c1', answers: goodAnswers }),
    (error) => error.code === 'reply_queued',
  );

  const bad = answerFixture({
    service: { answer() { const error = new Error('must name each question exactly once'); error.code = 'BAD_ANSWER'; throw error; } },
  });
  emit(bad.index, bad.id, callEvent('c1', QUESTIONS));
  await assert.rejects(
    bad.index.answerQuestion(bad.id, { callId: 'c1', answers: goodAnswers }),
    (error) => error.code === 'bad_answer',
  );
});

test('answerQuestion：agent 不在 → not_running（409 一档）', async () => {
  const { index } = makeIndex({ userQuestions: { answer: () => true }, agents: { get: () => undefined } });
  const id = seedTask(index);
  emit(index, id, callEvent('c1', QUESTIONS));
  await assert.rejects(index.answerQuestion(id, { callId: 'c1', answers: goodAnswers }), (error) => error.code === 'not_running');
});

/* ------------------------------------------------------- 前端纯逻辑（web/lib/answers.js） */

test('toggleChoice：单选互斥、再点取消；多选可叠加', () => {
  const single = { id: 'q1', question: '?', options: [{ label: 'A' }, { label: 'B' }] };
  let draft = toggleChoice(single, { selected: [], custom: '' }, 'A');
  assert.deepEqual(draft.selected, ['A']);
  draft = toggleChoice(single, draft, 'B');
  assert.deepEqual(draft.selected, ['B']);
  draft = toggleChoice(single, draft, 'B');
  assert.deepEqual(draft.selected, []);
  const multi = { ...single, multiSelect: true };
  draft = toggleChoice(multi, { selected: ['A'], custom: '' }, 'B');
  assert.deepEqual(draft.selected, ['A', 'B']);
  assert.deepEqual(toggleChoice(multi, draft, 'A').selected, ['B']);
});

test('setCustom：单选写自定义会清空已选；多选保留', () => {
  const single = { id: 'q1', question: '?' };
  assert.deepEqual(setCustom(single, { selected: ['A'], custom: '' }, '别的'), { selected: [], custom: '别的' });
  assert.deepEqual(setCustom(single, { selected: ['A'], custom: 'x' }, '  '), { selected: ['A'], custom: '  ' });
  const multi = { id: 'q1', question: '?', multiSelect: true };
  assert.deepEqual(setCustom(multi, { selected: ['A'], custom: '' }, '补充'), { selected: ['A'], custom: '补充' });
});

test('buildAnswers：单选自定义只发 custom（selected 空），多选可补 custom，未答会报错', () => {
  const questions = [
    { id: 'q1', question: '单选', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '多选', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
  ];
  const drafts = {
    q1: { selected: ['A'], custom: '自己写' },
    q2: { selected: ['X', 'Y'], custom: '再补一句' },
  };
  const built = buildAnswers(questions, drafts);
  assert.equal(built.ok, true);
  assert.deepEqual(built.answers, [
    { id: 'q1', selected: [], custom: '自己写' },
    { id: 'q2', selected: ['X', 'Y'], custom: '再补一句' },
  ]);
  assert.deepEqual(unanswered(questions, { q1: { selected: [], custom: '' } }), ['q1', 'q2']);
  const missing = buildAnswers(questions, { q1: { selected: ['A'], custom: '' } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /多选/u);
  assert.equal(draftOf(drafts, 'q1').selected.length, 1);
});

test('answerPayload / questionsOf：提交体形状与坏数据过滤', () => {
  assert.deepEqual(answerPayload('c1', goodAnswers), { callId: 'c1', answers: goodAnswers });
  assert.deepEqual(
    buildAnswers([{ id: 'q', question: '?' }], { q: { selected: [], custom: '只用自定义' } }).answers,
    [{ id: 'q', selected: [], custom: '只用自定义' }],
  );
});

/* ------------------------------------------------- 前端接线（详情页提交路径） */

const readRepo = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('详情页接线：调 /answer、提交中就禁用、按 callId 存未提交选择', () => {
  const detail = readRepo('web/views/detail.js');
  // 新接口与提交体：body 必须是 { callId, answers }（服务端契约）。
  assert.match(detail, /\/api\/v1\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/answer/u, '必须调新的 answer 接口');
  assert.match(detail, /answerPayload\(pending\.callId, built\.answers\)/u, '提交体必须是 { callId, answers }');
  // 防重复：提交中禁用按钮 + 记录未提交选择（callId 为键，刷新不清）。
  assert.match(detail, /answerSubmitting\.add\(pending\.callId\)/u, '提交中必须加锁');
  assert.match(detail, /disabled: submitting \|\| answerable !== true/u, '提交中/不可答时按钮必须禁用');
  assert.match(detail, /const answerDrafts = new Map\(\)/u, '未提交选择必须存在视图状态里（callId 为键）');
  assert.match(detail, /draftsFor\(row\.callId\)/u, '卡片按 callId 取草稿');
  // 卡片排在对话流末尾，且不可答时有可见文案（不许点了没反应）。
  assert.match(detail, /entries\.push\(\{ kind: 'question', key: `q:\$\{row\.callId\}`/u, '提问卡片必须排在对话流末尾');
  assert.match(detail, /电脑端仍在前台计时等待/u);
  assert.match(detail, /只能由电脑端回答/u);
  // 选项与自定义回答都要渲染；mtultiSelect 决定单选/多选。
  assert.match(detail, /question\.multiSelect === true/u);
  assert.match(detail, /setCustom\(question, draftOf\(drafts, question\.id\), custom\.value\)/u);
});

test('外壳接线：提问的工具消息触发一次整页静默刷新（不污染流式增量分支）', () => {
  const app = readRepo('web/app.js');
  assert.match(app, /payload\.message\?\.tool\?\.name === 'ask_user_question'/u, '必须识别提问工具消息');
  const at = app.indexOf("case 'task.message'");
  assert.ok(at > 0);
  const branch = app.slice(at, at + 800);
  assert.ok(!branch.includes('scheduleDetailRefresh'), '流式增量分支里不许整页重拉（外壳既有纪律）');
  assert.ok(branch.includes('scheduleDetailAppend'), '流式增量分支必须只追增量');
});

test('列表行带 awaiting：有挂起提问的会话可被置顶/高亮', () => {
  const { index } = makeIndex({ userQuestions: { answer: async () => true } });
  const id = seedTask(index, 'awaiting-1');

  // 事件兜底表里有该任务 ⇒ 视为待回答（O(1) 路径，不读投影）。
  index.questionCalls.set(id, new Map([['c1', { callId: 'c1', questions: [] }]]));
  assert.equal(index.hasPendingQuestion({ id, status: 'running' }), true);

  // 无挂起、且不是 running ⇒ 不必读投影，直接 false。
  assert.equal(index.hasPendingQuestion({ id: 'other', status: 'idle' }), false);

  // 服务缺失时天然降级。
  const noService = makeIndex({}).index;
  assert.equal(noService.hasPendingQuestion({ id, status: 'running' }), false);

  // publicTask 能把它带出去（extra 合并）。
  const row = index.publicTask({ id, children: [] }, { awaiting: true });
  assert.equal(row.awaiting, true);
  assert.equal(row.id, id);
});
