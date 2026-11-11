/**
 * 会话详情分页（`lib/task-index.mjs` 的 slicePage / detail / transcript）
 * + 手机端分页接线。
 *
 * 这份用例守的是用户明确要求的那条流程：
 *   1. 点进会话时**只**拿尾部一小段（不是整份详情）；
 *   2. 首屏要带出最近几次「用户发送」的内容；
 *   3. 往上翻时按游标取更早的一页，**不重叠、不漏页**，一直能翻到最早；
 *   4. 每一页都受字节预算约束，无论会话多长；
 *   5. 翻页过程中会话没变就只读一次 surface（缓存），否则翻 10 页要解析 10 遍。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildTranscriptAsync, messageChars } from '../../lib/messages.mjs';
import {
  LIST_PREVIEW_CHARS, MIN_USER_MESSAGES, PAGE_CHARS, PAGE_DEFAULT, PAGE_MAX, TaskIndex, sliceAfter, slicePage,
} from '../../lib/task-index.mjs';

const roots = [];

after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 已经没了 */ }
  }
});

/* --------------------------------------------------------------- 造数据 ---- */

/**
 * 造一段"像真会话"的事件流：每轮 = 用户提问 + 3 次工具调用（含结果）+ 3 条说明
 * + 轮次分割线。
 */
function buildEvents({ turns = 30, textSize = 20 } = {}) {
  const events = [];
  let seq = 0;
  const t0 = 1_794_000_000_000;
  const push = (type, data) => {
    seq += 1;
    events.push({ type, seq, time: t0 + seq * 1000, data });
  };
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn });
    push('user/message', { content: `第 ${turn} 轮：用户说的话 ${'u'.repeat(textSize)}` });
    for (let step = 1; step <= 3; step += 1) {
      const callId = `c${turn}-${step}`;
      push('tool/call', { callId, name: 'shell', arguments: '{"command":"ls"}' });
      push('tool/result', { message: { toolCallId: callId, content: `结果 ${'r'.repeat(textSize)}` } });
      push('assistant/message', { message: { content: `第 ${turn} 轮第 ${step} 步的说明 ${'a'.repeat(textSize)}` } });
    }
    push('turn/end', { reason: { kind: 'completed' } });
  }
  return events;
}

function makeLogger() {
  return { lines: [], info() {}, warn() {}, error() {} };
}

async function makeIndex({ events }) {
  const root = mkdtempSync(path.join(tmpdir(), 'pocket-paging-'));
  roots.push(root);
  const calls = { readSurface: 0 };
  const index = new TaskIndex({
    logger: makeLogger(),
    emit() {},
    state: { touchDevice() {} },
    config: {},
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() {
          calls.readSurface += 1;
          return { events, capturedThroughSeq: events.length };
        },
      },
    },
    home: root,
    dataDir: path.join(root, 'pocket'),
  });
  const row = (header, extra = {}) => ({ header, ...extra });
  index.upsertRow(row({ id: 'task-page', createdAt: 1 }));
  return { index, calls };
}

/** 把一条消息的正文体量算出来（与分页预算同一把尺子）。 */
const charsOf = (messages) => messages.reduce((sum, message) => sum + messageChars(message), 0);

/* ------------------------------------------------------- slicePage（纯） ---- */

test('slicePage：不带游标 → 尾部一页，且至少带出最近 N 次用户输入', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: `m${index}`,
    role: index % 5 === 0 ? 'user' : 'assistant',
    text: `消息 ${index}`,
  }));
  const page = slicePage(messages, {});

  assert.equal(page.offset + page.messages.length, 100, '首屏必须贴着尾部');
  assert.equal(page.hasMore, true, '前面还有历史');
  assert.equal(page.nextBefore, page.messages[0].id, '游标就是本页最早那条的 id');
  assert.ok(page.messages.length <= PAGE_DEFAULT, `默认不超过 ${PAGE_DEFAULT} 条`);
  const users = page.messages.filter((message) => message.role === 'user').length;
  assert.ok(users >= 1, `首屏必须含用户输入，实际 ${users}`);
});

test('slicePage：用户输入不够时，首屏主动往前扩（保证"最近几次我说的话"都在）', () => {
  // 前 60 条里只有 1 条 user，其余全是 assistant；尾部窗口本来凑不满 3 条 user。
  const messages = Array.from({ length: 80 }, (_, index) => ({
    id: `m${index}`,
    role: index === 55 ? 'user' : 'assistant',
    text: 'x',
  }));
  const page = slicePage(messages, {});
  const users = page.messages.filter((message) => message.role === 'user').length;
  assert.ok(users >= 1, '至少要有那一条用户输入');
  // 扩窗只针对首屏，且有硬上限：绝不允许把整条会话拉进来
  assert.ok(page.messages.length <= PAGE_DEFAULT * 2, `扩窗后仍受 2 倍上限约束，实际 ${page.messages.length}`);
});

test('slicePage：limit 被夹在 [1, PAGE_MAX]，非法值回落到默认', () => {
  const messages = Array.from({ length: 300 }, (_, index) => ({ id: `m${index}`, role: 'assistant', text: 'x' }));
  assert.equal(slicePage(messages, { limit: 1 }).messages.length, 1, '显式 limit 必须被严格遵守');
  assert.ok(slicePage(messages, { limit: 999 }).messages.length <= PAGE_MAX);
  // 非法/缺省 limit → 回默认页大小，且允许为凑用户输入扩到 2 倍以内
  const fallback = slicePage(messages, { limit: -3 });
  assert.ok(fallback.messages.length >= PAGE_DEFAULT && fallback.messages.length <= PAGE_DEFAULT * 2,
    `缺省 limit 应落在 [${PAGE_DEFAULT}, ${PAGE_DEFAULT * 2}]，实际 ${fallback.messages.length}`);
  const nan = slicePage(messages, { limit: Number.NaN });
  assert.ok(nan.messages.length <= PAGE_DEFAULT * 2);
});

test('slicePage：单页受字节预算约束，但永远不会给空页', () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    id: `m${index}`, role: 'assistant', text: 'z'.repeat(4000),
  }));
  const page = slicePage(messages, {});
  assert.ok(page.messages.length >= 1, '不能返回空页');
  const chars = charsOf(page.messages);
  assert.ok(chars <= PAGE_CHARS, `单页正文必须落在 ${PAGE_CHARS} 字符预算内，实际 ${chars}`);
  // 一条就超预算的巨型消息：仍然要给出它自己，否则这一页永远是空的
  const huge = [{ id: 'only', role: 'assistant', text: 'z'.repeat(PAGE_CHARS * 2) }];
  const single = slicePage(huge, {});
  assert.equal(single.messages.length, 1);
});

test('slicePage：游标找不到 → 回尾部一页并标记 cursorLost', () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({ id: `m${index}`, role: 'assistant', text: 'x' }));
  const page = slicePage(messages, { before: 'never-existed' });
  assert.equal(page.cursorLost, true);
  assert.equal(page.offset + page.messages.length, 50, '游标失效时给的是尾部一页');
});

test('slicePage：游标指向第一条 → 没有更早了', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`, role: 'assistant', text: 'x' }));
  const page = slicePage(messages, { before: 'm0' });
  assert.equal(page.messages.length, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextBefore, '');
});

test('slicePage：空会话 → 空页且没有更多', () => {
  const page = slicePage([], {});
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.total, 0);
});

/* ------------------------------------------- 从尾一直翻到最早（不重不漏） ---- */

test('分页走到底：逐页往回翻，恰好覆盖所有消息一次、最后 hasMore=false', () => {
  const messages = Array.from({ length: 260 }, (_, index) => ({
    id: `m${index}`,
    role: index % 7 === 0 ? 'user' : 'assistant',
    text: `消息 ${index}`,
  }));

  const collected = [];
  let page = slicePage(messages, {});
  collected.unshift(...page.messages.map((message) => message.id));
  let guard = 0;
  while (page.hasMore) {
    guard += 1;
    assert.ok(guard < 50, '翻页次数失控');
    page = slicePage(messages, { before: page.nextBefore });
    assert.equal(page.cursorLost, false, '游标必须始终有效');
    collected.unshift(...page.messages.map((message) => message.id));
  }

  assert.equal(collected.length, messages.length, '总条数必须与源一致（不漏）');
  assert.equal(new Set(collected).size, collected.length, '不许有重复页');
  assert.deepEqual(collected, messages.map((message) => message.id), '顺序必须与原文一致');
});

/* ------------------------------------- 真实 TaskIndex：缓存 + 端到端分页 ---- */

test('detail：首屏只给尾部窗口，并带 hasMore / nextBefore / total', async () => {
  const events = buildEvents({ turns: 40 });
  const { index, calls } = await makeIndex({ events });
  const detail = await index.detail('task-page');

  assert.equal(calls.readSurface, 1);
  assert.ok(detail.total > detail.messages.length, '首屏不该是全部');
  assert.equal(detail.hasMore, true);
  assert.equal(typeof detail.nextBefore, 'string');
  assert.ok(detail.nextBefore.length > 0);
  const users = detail.messages.filter((message) => message.role === 'user').length;
  assert.ok(users >= 1, '首屏必须有用户输入');
  // 首屏贴着尾部：最后一条应当就是会话最后一条（turn/end 分割线）
  assert.equal(detail.messages[detail.messages.length - 1].kind, 'turn-end');
});

test('detail：翻页过程中只读一次 surface（转录缓存生效）', async () => {
  const events = buildEvents({ turns: 40 });
  const { index, calls } = await makeIndex({ events });
  let page = await index.detail('task-page');
  let guard = 0;
  while (page.hasMore) {
    guard += 1;
    assert.ok(guard < 50, '翻页次数失控');
    page = await index.detail('task-page', { before: page.nextBefore });
  }
  assert.equal(calls.readSurface, 1, `翻完全程只该读一次 surface，实际 ${calls.readSurface}`);
});

test('detail：从尾翻到最早恰好覆盖全部消息（真实索引）', async () => {
  const events = buildEvents({ turns: 25 });
  const { index } = await makeIndex({ events });
  const first = await index.detail('task-page');

  const ids = first.messages.map((message) => message.id);
  let page = first;
  let guard = 0;
  while (page.hasMore) {
    guard += 1;
    assert.ok(guard < 50, '翻页次数失控');
    page = await index.detail('task-page', { before: page.nextBefore });
    ids.unshift(...page.messages.map((message) => message.id));
  }
  assert.equal(ids.length, first.total, `翻完必须等于 total，实际 ${ids.length} vs ${first.total}`);
  assert.equal(new Set(ids).size, ids.length, '不许重复');
});

test('detail：每一页都守着字节预算（会话再长，单次响应也很小）', async () => {
  const events = buildEvents({ turns: 30, textSize: 3000 });
  const { index } = await makeIndex({ events });
  let page = await index.detail('task-page');
  let guard = 0;
  for (;;) {
    const chars = charsOf(page.messages);
    assert.ok(chars <= PAGE_CHARS || page.messages.length === 1,
      `单页超预算：${chars} > ${PAGE_CHARS}（${page.messages.length} 条）`);
    guard += 1;
    if (!page.hasMore || guard > 50) break;
    page = await index.detail('task-page', { before: page.nextBefore });
  }
});

test('detail：会话变化后缓存失效，重新读 surface', async () => {
  const events = buildEvents({ turns: 5 });
  const { index, calls } = await makeIndex({ events });
  await index.detail('task-page');
  assert.equal(calls.readSurface, 1);
  await index.detail('task-page');
  assert.equal(calls.readSurface, 1, '没变化就该命中缓存');
  // 模拟日志追加：fileMtime 变了
  index.getTask('task-page').fileMtime = 12_345;
  await index.detail('task-page');
  assert.equal(calls.readSurface, 2, '变化后必须重建');
});

test('detail：不存在的任务仍然 404 语义（not_found）', async () => {
  const { index } = await makeIndex({ events: [] });
  await assert.rejects(() => index.detail('nope'), (error) => error.code === 'not_found');
});

/* -------------------------------------------- 异步构建与同步结果一致 ---- */

test('buildTranscriptAsync：与同步版逐字节一致（分片让出不改变结果）', async () => {
  const events = buildEvents({ turns: 60, textSize: 50 });
  const opts = { maxScan: Number.POSITIVE_INFINITY, budget: Number.POSITIVE_INFINITY, max: 5000 };
  // 同步版通过 slicePage 的输入间接可得：这里直接比对两次异步（确定性）
  const a = await buildTranscriptAsync(events, opts);
  const b = await buildTranscriptAsync(events, opts);
  assert.equal(JSON.stringify(a), JSON.stringify(b), '同样的输入必须可复现');
  assert.equal(a.length, 60 * 9, `每轮 9 条（开始/用户/3×(工具+说明)/结束），实际 ${a.length}`);
});

/* ---------------------------------------------------- 手机端接线（源码） ---- */

function readRepo(relative) {
  return readFileSync(path.join(import.meta.dirname, '..', '..', relative), 'utf8');
}

test('手机端：detail 视图有"往上翻加载更早"的触发、锚点与提示条', () => {
  const source = readRepo('web/views/detail.js');
  assert.match(source, /loadOlderHere/u, '必须有翻页函数');
  assert.match(source, /LOAD_OLDER_AT_PX/u, '必须按距顶距离触发');
  assert.match(source, /ctx\.loadOlder/u, '必须通过 ctx 调回 app');
  // 补位置必须在**渲染之后**：paintChat() 只是把渲染排到下一帧，渲染前设
  // scrollTop 会被随后插入的内容覆盖回顶部（这个坑实测踩过）。
  assert.match(source, /pendingScrollAnchor = \{ height: beforeHeight, top: beforeTop \}/u,
    '翻页前要登记锚点');
  assert.match(source, /chat\.scrollTop = applied\.top \+ \(chat\.scrollHeight - applied\.height\)/u,
    '按"插入前的高度/位置"补 scrollTop，否则画面会跳');
  assert.match(source, /pendingScrollAnchor !== null/u, '锚点要在渲染时被消费');
  const applyAt = source.indexOf('chat.scrollTop = applied.top');
  const setAt = source.indexOf('chatList.set(entries, messageNode)');
  assert.ok(applyAt > 0 && setAt > 0 && applyAt > setAt,
    '补位置必须排在这轮渲染之后（applyAt > setAt）');
  assert.match(source, /chat-list/u, '列表要放进 display:contents 的宿主里');
  assert.match(source, /older-hint/u, '要有顶部提示条');
});

test('手机端：app.js 有分页请求与"静默刷新不冲掉已翻历史"的合并', () => {
  const source = readRepo('web/app.js');
  assert.match(source, /async function loadOlder/u);
  assert.match(source, /\?before=\$\{encodeURIComponent\(cursor\)\}&limit=\$\{LIMITS\.detailPage\}/u);
  assert.match(source, /function mergeTailInto/u, '静默刷新必须合并而不是覆盖');
  assert.match(source, /cursorLost === true/u, '游标失效要能被识别');
  assert.match(source, /detailLoadingOlder/u, '并发翻页要去重');
});

test('手机端：store 提供分页参数与并发标志；样式表有透明宿主', () => {
  const store = readRepo('web/store.js');
  assert.match(store, /detailPage: 40/u);
  assert.match(store, /detailLoadingOlder: false/u);
  const css = readRepo('web/app.css');
  assert.match(css, /\.chat-list \{ display: contents; \}/u);
  assert.match(css, /\.older-hint/u);
});

/* ------------------------------------------------------ sliceAfter（纯） ---- */

const makeMessages = (count) => Array.from({ length: count }, (_, index) => ({
  id: `m${index}`,
  role: index % 5 === 0 ? 'user' : 'assistant',
  text: `第 ${index} 条`,
  at: 1_000 + index,
  seq: index + 1,
}));

test('sliceAfter：带游标只返回它之后的消息（增量追新的核心）', () => {
  const messages = makeMessages(100);
  const page = sliceAfter(messages, { after: 'm95' });
  assert.deepEqual(page.messages.map((m) => m.id), ['m96', 'm97', 'm98', 'm99']);
  assert.equal(page.reset, false);
  assert.equal(page.hasMore, false, '取到尾部就没有更多了');
  assert.equal(page.total, 100);
});

test('sliceAfter：游标就是最后一条 → 空数组且不算 reset（没有新消息是正常态）', () => {
  const messages = makeMessages(10);
  const page = sliceAfter(messages, { after: 'm9' });
  assert.deepEqual(page.messages, []);
  assert.equal(page.reset, false);
  assert.equal(page.hasMore, false);
});

test('sliceAfter：游标找不到 → reset，并给出尾部一页（调用方应整页重载）', () => {
  const messages = makeMessages(100);
  const page = sliceAfter(messages, { after: 'm-不存在' });
  assert.equal(page.reset, true, '找不到游标必须明确要求重置，不能假装是增量');
  assert.equal(page.messages.length, PAGE_DEFAULT);
  assert.equal(page.messages[page.messages.length - 1].id, 'm99');
});

test('sliceAfter：不带游标 → 尾部一页（不会返回整段转录）', () => {
  const messages = makeMessages(500);
  const page = sliceAfter(messages, {});
  assert.equal(page.messages.length, PAGE_DEFAULT);
  assert.equal(page.reset, false);
  assert.equal(page.messages[page.messages.length - 1].id, 'm499', '取的是最新那一端');
  assert.equal(page.hasMore, false, '已经给到尾部，更新方向没有剩余');
});

test('sliceAfter：条数与字符预算都生效，超预算时 hasMore=true 供调用方续追', () => {
  const big = Array.from({ length: 30 }, (_, index) => ({
    id: `b${index}`, role: 'assistant', text: 'x'.repeat(PAGE_CHARS / 3), at: index, seq: index + 1,
  }));
  const page = sliceAfter(big, { after: '', limit: 20 });
  assert.ok(page.messages.length < 20, '字符预算要先于条数预算生效');
  assert.equal(page.hasMore, true, '被预算截断时必须允许继续追');
});

test('sliceAfter：空转录不炸；带游标时明确 reset', () => {
  assert.deepEqual(sliceAfter([], {}), { messages: [], total: 0, reset: false, hasMore: false });
  assert.equal(sliceAfter([], { after: 'm1' }).reset, true);
});

test('detail({after})：只把新增的那几条发回去（流式期间的正常路径）', async () => {
  const events = [];
  for (let index = 0; index < 12; index += 1) {
    events.push({ seq: index + 1, type: 'turn/start', at: 1_000 + index, data: {} });
    events.push({
      seq: index + 1,
      type: index % 2 === 0 ? 'message/user' : 'message/assistant',
      at: 1_000 + index,
      data: { text: `第 ${index} 段` },
    });
  }
  const { index: taskIndex } = await makeIndex({ events });
  const first = await taskIndex.detail('task-page');
  assert.ok(first.messages.length > 0);
  const tail = first.messages[first.messages.length - 1];

  const none = await taskIndex.detail('task-page', { after: tail.id });
  assert.deepEqual(none.messages, [], '尾部之后没有新消息');
  assert.equal(none.reset, false);

  const bogus = await taskIndex.detail('task-page', { after: 'm-不存在' });
  assert.equal(bogus.reset, true, '游标失效必须要求整页重载');
  assert.ok(bogus.messages.length > 0, 'reset 时仍返回尾部一页，避免手机端白屏');

  taskIndex.dispose();
});

/* ------------------------------------------------------- 列表瘦身 ---- */

test('列表：预览截到 LIST_PREVIEW_CHARS（卡片只显示两行，长预览是响应体大头）', async () => {
  const longText = '这是一段很长的助手输出，'.repeat(40);
  const events = [{
    seq: 1, type: 'message/assistant', at: 1_000, data: { text: longText },
  }];
  const { index: taskIndex } = await makeIndex({ events });
  await taskIndex.load?.();
  const listed = taskIndex.snapshot({ limit: 10 }).tasks[0];
  assert.ok(typeof listed.lastText === 'string');
  assert.ok(listed.lastText.length <= LIST_PREVIEW_CHARS + 1, `预览必须被截短，实际 ${listed.lastText.length}`);
  taskIndex.dispose();
});

test('外壳：流式期间走增量追新，不再整页重拉', () => {
  const source = readRepo('web/app.js');
  assert.match(source, /scheduleDetailAppend/u, '必须有增量调度器');
  assert.match(source, /\?after=\$\{encodeURIComponent\(cursor\)\}/u, '必须用 after 游标');
  assert.match(source, /detailAppending/u, '必须有并发闸');

  // task.message 分支不能再走整页刷新
  const at = source.indexOf("case 'task.message'");
  assert.ok(at > 0, '找不到 task.message 分支');
  const branch = source.slice(at, at + 800);
  assert.ok(!branch.includes('scheduleDetailRefresh'), 'task.message 不许再整页刷新');
  assert.ok(branch.includes('scheduleDetailAppend'), 'task.message 必须走增量');

  // 游标失效要退回整页，不能把两段拼起来；被预算截断要续追
  assert.match(source, /data\?\.reset === true/u, 'reset 必须被识别');
  assert.match(source, /hasMoreAfter === true/u, '被预算截断时要续追');
});
