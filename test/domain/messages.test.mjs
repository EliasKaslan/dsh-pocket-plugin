/**
 * 消息/对话结构转换（lib/messages.mjs）——纯函数，不需要任何服务或文件。
 *
 * 这一层决定「手机上看到什么」：哪些 user/message 是真人打字（其余是注入的
 * prompt 脚手架，泄出去就是泄漏系统提示词），工具的哪一部分该显示，以及一段
 * 事件流怎么折成气泡。断言全部钉在真实导出上，不 mock 被测逻辑。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTranscript, contentReasoning, contentText, isHumanPrompt, normalizeEvent,
  reasonText, safeUsage, sourceKind,
} from '../../lib/messages.mjs';

/* --------------------------------------------------------------- contentText */

test('contentText：字符串原样返回，数组只取 text 段并用换行连接', () => {
  assert.equal(contentText('直接给字符串'), '直接给字符串');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(contentText([{ type: 'text', text: '  前后空白  ' }]), '前后空白');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: '' }]), 'a');
  assert.equal(contentText([{ type: 'text', text: '  ' }]), '', '只有空白 → 空串');
  // 非 text 段必须被忽略，否则会把推理链/图片当正文发到手机上。
  assert.equal(contentText([{ type: 'reasoning', text: '思考' }, { type: 'text', text: '答案' }]), '答案');
  assert.equal(contentText([{ type: 'image', data: 'xxx' }]), '');
  assert.equal(contentText([{ type: 'text' }, { text: '没有 type' }]), '', '缺 type 的段不算文本');
  assert.equal(contentText([null, 42, 'bare string', { type: 'text', text: 'ok' }]), 'ok');
});

test('contentText：非法类型一律空串，不抛异常', () => {
  for (const bad of [undefined, null, 0, 42, true, {}, new Map(), () => {}]) {
    assert.equal(contentText(bad), '', `contentText(${String(bad)}) 必须是空串`);
  }
});

test('contentText：Unicode（中文/emoji/组合字符/换行）不被改写', () => {
  const text = '第一行\n第二行 🚀 e\u0301 全角：ＡＢＣ';
  assert.equal(contentText([{ type: 'text', text }]), text);
  assert.equal(contentText([{ type: 'text', text: '🚀🚀' }, { type: 'text', text: '中文' }]), '🚀🚀\n中文');
});

/* ---------------------------------------------------------- contentReasoning */

test('contentReasoning：只收 reasoning 段，非数组一律空串', () => {
  assert.equal(contentReasoning([{ type: 'reasoning', text: '想' }, { type: 'reasoning', text: '再想' }]), '想\n再想');
  assert.equal(contentReasoning([{ type: 'text', text: '正文' }]), '');
  assert.equal(contentReasoning([{ type: 'reasoning', text: '   ' }]), '');
  assert.equal(contentReasoning([null, { type: 'reasoning', text: 'x' }]), 'x');
  assert.equal(contentReasoning('字符串不算'), '');
  assert.equal(contentReasoning(undefined), '');
  assert.equal(contentReasoning({}), '');
});

/* --------------------------------------------------------------- sourceKind */

test('sourceKind：只认对象上的字符串 kind', () => {
  assert.equal(sourceKind({ kind: 'user' }), 'user');
  assert.equal(sourceKind({ kind: '' }), '', '空字符串仍算“有 kind”，调用方要自己处理');
  assert.equal(sourceKind({ kind: 5 }), undefined);
  assert.equal(sourceKind({ kind: null }), undefined);
  assert.equal(sourceKind({}), undefined);
  assert.equal(sourceKind('user'), undefined, '字符串不是 source 对象');
  assert.equal(sourceKind(null), undefined);
  assert.equal(sourceKind(undefined), undefined);
  assert.equal(sourceKind(42), undefined);
});

/* ------------------------------------------------------------ isHumanPrompt */

test('isHumanPrompt：只看类型与来源，空文本仍然算“人发的”', () => {
  assert.equal(isHumanPrompt({ type: 'user/message', data: { content: '你好' } }), true);
  assert.equal(isHumanPrompt({ type: 'assistant/message', data: { content: '你好' } }), false);
  // 文本长度只用来决定“要不要跑注入前缀正则”，不是准入条件：
  // 空内容的 user/message 仍是 true，真正丢空消息的是 normalizeEvent（messages.mjs:111）。
  assert.equal(isHumanPrompt({ type: 'user/message', data: { content: [] } }), true, '空数组内容仍算 human');
  assert.equal(isHumanPrompt({ type: 'user/message', data: {} }), true);
  assert.equal(normalizeEvent({ type: 'user/message', data: {} }), undefined, '空消息最终由 normalizeEvent 丢掉');
  assert.equal(isHumanPrompt(null), false);
  assert.equal(isHumanPrompt(undefined), false);
  assert.equal(isHumanPrompt('user/message'), false);
});

test('isHumanPrompt：注入型 source.kind 全部被挡（含宽松正则兜底）', () => {
  const prompt = { type: 'user/message', data: { content: '正文', source: { kind: 'user' } } };
  assert.equal(isHumanPrompt(prompt), true);

  for (const kind of ['plugin', 'skill-catalog', 'runtime-context', 'time-context', 'goal-context',
    'todo-context', 'system', 'compaction']) {
    assert.equal(isHumanPrompt({ ...prompt, data: { content: '正文', source: { kind } } }), false, `${kind} 必须被挡`);
  }
  // INJECTED_RE（/(?:context|plugin|skill|system|compaction|catalog)/i）兜住未列出的新名字。
  for (const kind of ['my-context', 'Skill-Whatever', 'system-prompt', 'compaction-x', 'catalog', 'unknown-context']) {
    assert.equal(isHumanPrompt({ ...prompt, data: { content: '正文', source: { kind } } }), false, `${kind} 必须被正则兜住`);
  }
  for (const kind of ['user', 'user-question-reply', 'delegated', 'subagent']) {
    assert.equal(isHumanPrompt({ ...prompt, data: { content: '正文', source: { kind } } }), true, `${kind} 是真人来源`);
  }
  // 认不出来的来源不放行；source 不是对象时按“无来源”处理（历史日志就是这样）。
  assert.equal(isHumanPrompt({ ...prompt, data: { content: '正文', source: { kind: 'assistant' } } }), false);
  assert.equal(isHumanPrompt({ ...prompt, data: { content: '正文', source: { kind: '' } } }), false);
  assert.equal(isHumanPrompt({ ...prompt, data: { content: '正文', source: 'user' } }), true);
  assert.equal(isHumanPrompt({ ...prompt, data: { content: '正文', source: null } }), true);
});

test('isHumanPrompt：没有 source 时靠文本前缀识别注入脚手架', () => {
  const raw = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });
  for (const text of [
    'Time sampled while preparing turn 1, step 1: 2026-11-04',
    'Current runtime context snapshot',
    'A skill is a reusable set of task-specific instructions.',
    '<system-reminder>\n注意',
    'Tokens prefixed with @ are paths',
    'You are an AI agent powered by DeepSeek Harness.',
    '# AGENTS\n规则',
    'Current working directory: D:\\workspace',
  ]) {
    assert.equal(isHumanPrompt(raw(text)), false, `必须识别为注入：${text.slice(0, 24)}`);
  }
  assert.equal(isHumanPrompt(raw('帮我看看这个 bug')), true);
  // 只检查前 400 个字符：长文里后面偶然出现的字样不算注入（否则正常长提示词会被吞）。
  const long = `${'正常内容'.repeat(100)}Current runtime context`;
  assert.ok(long.length > 400);
  assert.equal(isHumanPrompt(raw(long)), true, '第 400 字符之后的字样不该影响判定');
});

/* ---------------------------------------------------------------- safeUsage */

test('safeUsage：只保留有限数字与短字符串，其它键一律丢', () => {
  assert.equal(safeUsage(undefined), undefined);
  assert.equal(safeUsage(null), undefined);
  assert.equal(safeUsage('nope'), undefined);
  assert.equal(safeUsage(0), undefined);
  assert.equal(safeUsage({}), undefined, '一个可用键都没有 → undefined');
  assert.equal(safeUsage({ unknownKey: 1 }), undefined, '白名单外的键不进结果');

  assert.deepEqual(safeUsage({ inputTokens: 12, outputTokens: 3 }), { inputTokens: 12, outputTokens: 3 });
  assert.equal(safeUsage({ inputTokens: Number.NaN }), undefined);
  assert.equal(safeUsage({ inputTokens: Infinity }), undefined);
  assert.equal(safeUsage({ inputTokens: -Infinity }), undefined);
  assert.deepEqual(safeUsage({ inputTokens: '12' }), { inputTokens: '12' }, '≤8 字符的字符串（如货币）保留');
  assert.equal(safeUsage({ inputTokens: '123456789' }), undefined, '超过 8 字符的字符串不要');
  assert.deepEqual(safeUsage({ currency: 'CNY' }), { currency: 'CNY' });
  assert.deepEqual(safeUsage({ costUsd: 0.5 }), { costUsd: 0.5 }, '0.5 是有限数字');
  // 上限 8 个键：9 个白名单键全给时，最后一个 currency 会被 break 掉。
  const all = {
    inputTokens: 1, outputTokens: 2, totalTokens: 3, cachedInputTokens: 4, cacheReadTokens: 5,
    cacheWriteTokens: 6, reasoningTokens: 7, costUsd: 8, currency: 'CNY',
  };
  const kept = safeUsage(all);
  assert.equal(Object.keys(kept).length, 8);
  assert.equal(kept.currency, undefined, '第 9 个键被上限截断');
  assert.equal(kept.costUsd, 8);
});

/* ------------------------------------------------------------ normalizeEvent */

test('normalizeEvent：非对象与未知类型返回 undefined', () => {
  for (const bad of [undefined, null, 'user/message', 42, true]) {
    assert.equal(normalizeEvent(bad), undefined);
  }
  assert.equal(normalizeEvent({ type: 'session/title', data: { title: 'x' } }), undefined);
  assert.equal(normalizeEvent({ data: {} }), undefined);
});

test('normalizeEvent：user/message 的 id 回退与 at/turn/seq', () => {
  const withSeq = normalizeEvent({ type: 'user/message', seq: 7, time: 1000, data: { content: 'hi' } });
  assert.equal(withSeq.id, 'u-7');
  assert.equal(withSeq.role, 'user');
  assert.equal(withSeq.text, 'hi');
  assert.equal(withSeq.at, 1000);
  assert.equal(withSeq.seq, 7);
  assert.equal(withSeq.turn, undefined);

  assert.equal(normalizeEvent({ type: 'user/message', time: 500, data: { content: 'x' } }).id, 'u-500');
  const fromNow = normalizeEvent({ type: 'user/message', data: { content: 'x' } }, { now: 42 });
  assert.equal(fromNow.id, 'u-42', '没有 seq/time 时用 context.now');
  assert.equal(fromNow.at, 42);

  const byId = normalizeEvent({ type: 'user/message', seq: 1, data: { id: 'msg-1', content: 'x', turn: 3 } });
  assert.equal(byId.id, 'msg-1', 'data.id 优先于 seq');
  assert.equal(byId.turn, 3);

  const noTime = normalizeEvent({ type: 'user/message', data: { content: 'x' } });
  assert.equal(typeof noTime.at, 'number');
  assert.ok(noTime.at > 0);
});

test('normalizeEvent：user/message 的注入过滤与 includeInjected', () => {
  const injected = { type: 'user/message', seq: 2, data: { content: '系统注入', source: { kind: 'system' } } };
  assert.equal(normalizeEvent(injected), undefined, '默认丢掉注入消息');
  assert.equal(normalizeEvent(injected, { includeInjected: true }).text, '系统注入');
  assert.equal(normalizeEvent({ type: 'user/message', data: { content: '' } }), undefined, '空字符串没消息体');
  // 字符串分支不 trim（数组分支才 trim），所以纯空白字符串会被当成一条消息保留。
  assert.equal(normalizeEvent({ type: 'user/message', data: { content: '   ' } }).text, '   ', '空白字符串直接透传');
});

test('normalizeEvent：assistant/message 的正文、推理、模型与 usage', () => {
  const full = normalizeEvent({
    type: 'assistant/message',
    seq: 9,
    time: 2000,
    data: {
      step: 2,
      usage: { inputTokens: 10, outputTokens: 20 },
      message: {
        id: 'a1',
        content: [{ type: 'text', text: '答案' }, { type: 'reasoning', text: '推理' }],
        source: { provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
  });
  assert.equal(full.id, 'a1');
  assert.equal(full.role, 'assistant');
  assert.equal(full.text, '答案');
  assert.equal(full.reasoning, '推理');
  assert.deepEqual(full.model, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(full.usage, { inputTokens: 10, outputTokens: 20 });
  assert.equal(full.step, 2);
  assert.equal(full.turn, undefined);

  // 只有推理没有正文也算一条消息（手机上要能看到“它在想”）。
  const onlyReasoning = normalizeEvent({ type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'reasoning', text: '嗯' }] } } });
  assert.equal(onlyReasoning.text, '');
  assert.equal(onlyReasoning.reasoning, '嗯');
  assert.equal(onlyReasoning.id, 'a-3', '没有 message.id 时用 seq');

  // 既无正文也无推理 → 不产生气泡。
  assert.equal(normalizeEvent({ type: 'assistant/message', data: { message: { content: [] } } }), undefined);
  assert.equal(normalizeEvent({ type: 'assistant/message', data: {} }), undefined);

  // 推理链上限 6000（截断后补一个省略号，长度正好 6000）。
  const long = normalizeEvent({
    type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'x'.repeat(7000) }] } },
  });
  assert.equal(long.reasoning.length, 6000);
  assert.ok(long.reasoning.endsWith('…'));

  // source 不是对象 / model 不是字符串 → 不报错、不给 model。
  assert.equal(normalizeEvent({ type: 'assistant/message', data: { message: { content: 'x', source: null } } }).model, undefined);
  assert.equal(normalizeEvent({ type: 'assistant/message', data: { message: { content: 'x', source: { model: 5 } } } }).model, undefined);
  assert.deepEqual(
    normalizeEvent({ type: 'assistant/message', data: { message: { content: 'x', source: { model: 'm' } } } }).model,
    { provider: undefined, model: 'm' },
  );
});

test('normalizeEvent：tool/call 的参数摘要只挑人能认出来的字段', () => {
  const call = (data) => normalizeEvent({ type: 'tool/call', seq: 5, time: 10, data });
  assert.deepEqual(call({ callId: 'c1', name: 'shell', arguments: '{"command":"ls -la","description":"列目录"}' }).tool, {
    callId: 'c1', name: 'shell', args: '列目录', status: 'running',
  });
  assert.equal(call({ arguments: '{"command":"npm test"}' }).tool.args, 'npm test');
  assert.equal(call({ arguments: '{"path":"/a/b"}' }).tool.args, '/a/b');
  assert.equal(call({ arguments: '{"file_path":"C:\\\\x"}' }).tool.args, 'C:\\x');
  assert.equal(call({ arguments: '{"query":"搜索词"}' }).tool.args, '搜索词');
  assert.equal(call({ arguments: '{"pattern":"a.*b"}' }).tool.args, 'a.*b');
  assert.equal(call({ arguments: '{"url":"http://x/y"}' }).tool.args, 'http://x/y');
  // 没有可识别字段 → 报前 4 个键名，让用户知道调了什么形状。
  assert.equal(call({ arguments: '{"aaa":1,"bbb":2,"ccc":3,"ddd":4,"eee":5}' }).tool.args, 'aaa, bbb, ccc, ddd');
  assert.equal(call({ arguments: '{}' }).tool.args, '');
  // 数组也满足 `typeof === 'object'`，于是走“报键名”分支：显示的是下标。
  assert.equal(call({ arguments: '[1,2,3]' }).tool.args, '0, 1, 2', '数组被当成对象取键名（现状）');
  assert.equal(call({ arguments: 'not json at all' }).tool.args, 'not json at all');
  assert.equal(call({ arguments: { a: 1 } }).tool.args, '{"a":1}', '非字符串参数走 JSON.stringify');
  assert.equal(call({ arguments: undefined }).tool.args, '""');
  const circular = {};
  circular.self = circular;
  assert.equal(call({ arguments: circular }).tool.args, '', '循环引用不能让请求路径抛异常');

  const unnamed = call({ callId: 'c2' });
  assert.equal(unnamed.tool.name, 'tool', '没有名字时用占位名');
  assert.equal(unnamed.id, 't-c2');
  assert.equal(call({}).id, 't-5', '没有 callId 时用 seq');
  assert.equal(call({ arguments: '{"description":"  "}' }).tool.args, 'description',
    '空白值不算可识别内容 → 退回到键名列表');
});

test('normalizeEvent：tool/result 折叠字段、错误标记与 1200 字符截断', () => {
  const ok = normalizeEvent({
    type: 'tool/result', seq: 6, time: 11,
    data: { message: { toolCallId: 'c1', content: '结果' } },
  });
  assert.equal(ok.id, 'tr-c1');
  assert.equal(ok.role, 'tool-result');
  assert.equal(ok.text, '结果');
  assert.deepEqual(ok.tool, { callId: 'c1', name: undefined, status: 'done', isError: false });

  const failed = normalizeEvent({ type: 'tool/result', data: { toolCallId: 'c2', name: 'shell', message: { isError: true, content: '炸了' } } });
  assert.equal(failed.tool.status, 'error');
  assert.equal(failed.tool.isError, true);
  assert.equal(failed.tool.name, 'shell');

  const fallbackId = normalizeEvent({ type: 'tool/result', seq: 3, data: { toolCallId: 'c3' } });
  assert.equal(fallbackId.id, 'tr-c3');
  assert.equal(normalizeEvent({ type: 'tool/result', seq: 4, data: {} }).id, 'tr-4');

  const long = normalizeEvent({ type: 'tool/result', data: { message: { content: 'y'.repeat(2000) } } });
  assert.equal(long.text.length, 1200);
  assert.ok(long.text.endsWith('…'));
});

test('normalizeEvent：turn/end 的四种状态与 reason 文案', () => {
  const end = (reason) => normalizeEvent({ type: 'turn/end', seq: 8, time: 12, data: { reason, turn: 2 } });
  assert.equal(end({ kind: 'completed' }).status, 'done');
  assert.equal(end({ kind: 'aborted' }).status, 'stopped');
  assert.equal(end({ kind: 'interrupted' }).status, 'stopped');
  assert.equal(end({ kind: 'error' }).status, 'error');
  assert.equal(end({ kind: 'max-tokens' }).status, 'error');
  assert.equal(end({ kind: 'blocked' }).status, 'error');
  assert.equal(end({ kind: 'forked' }).status, 'error', 'forked 不是正常结束（在 transcript 里按错误色更安全）');
  assert.equal(end({ kind: 'weird' }).status, 'error');
  assert.equal(end(null).status, 'error');
  assert.equal(end(null).reason, '状态未知');
  assert.equal(end({ kind: 'completed' }).role, 'divider');
  assert.equal(end({ kind: 'completed' }).kind, 'turn-end');
  assert.equal(end({ kind: 'completed' }).turn, 2);
  assert.equal(end({ kind: 'error', error: { message: '上下文超限' } }).reason, '执行出错：上下文超限');
  assert.equal(end({ kind: 'completed' }).id, 'turn-8');
});

test('normalizeEvent：turn/start 与 error 事件', () => {
  const start = normalizeEvent({ type: 'turn/start', seq: 1, time: 5, data: { turn: 1 } });
  assert.deepEqual({ ...start }, {
    id: 'turn-1', role: 'divider', kind: 'turn-start', text: '', at: 5, turn: 1, seq: 1,
  });

  const withError = normalizeEvent({ type: 'session/error', seq: 2, data: { error: { message: '会话挂了' } } });
  assert.equal(withError.role, 'system');
  assert.equal(withError.kind, 'error');
  assert.equal(withError.text, '会话挂了');
  assert.equal(withError.id, 'e-2');

  assert.equal(normalizeEvent({ type: 'error', data: { message: '扁平消息' } }).text, '扁平消息');
  assert.equal(normalizeEvent({ type: 'error', data: {} }).text, '任务执行出错', '兜底文案');
  assert.equal(normalizeEvent({ type: 'error', data: { error: { message: 42 } } }).text, '42', '非字符串被 String() 化');
  // 空串不是 nullish，`??` 不会走到兜底文案 —— 钉住现状（空消息渲染成空气泡）。
  assert.equal(normalizeEvent({ type: 'error', seq: 3, data: { error: { message: '' } } }).text, '',
    '空字符串 message 会绕过兜底');
});

/* --------------------------------------------------------------- reasonText */

test('reasonText：八种 kind 的中文文案 + 未知 kind 原样透出', () => {
  assert.equal(reasonText(null), '状态未知');
  assert.equal(reasonText(undefined), '状态未知');
  assert.equal(reasonText('completed'), '状态未知', '非对象一律状态未知');
  assert.equal(reasonText({}), '状态未知');
  assert.equal(reasonText({ kind: 'completed' }), '已完成');
  assert.equal(reasonText({ kind: 'aborted' }), '已中断');
  assert.equal(reasonText({ kind: 'interrupted' }), '已中断');
  assert.equal(reasonText({ kind: 'error' }), '执行出错');
  assert.equal(reasonText({ kind: 'max-tokens' }), '达到 token 上限');
  assert.equal(reasonText({ kind: 'blocked' }), '被策略拦下');
  assert.equal(reasonText({ kind: 'forked' }), '已分叉');
  assert.equal(reasonText({ kind: 'unknown' }), '状态未知');
  assert.equal(reasonText({ kind: 'brand-new-kind' }), 'brand-new-kind', '没见过的 kind 也要能显示');
  assert.equal(reasonText({ kind: 42 }), '42');
});

test('reasonText：附加细节优先 error.message，其次 reason.message，并压成一行', () => {
  assert.equal(reasonText({ kind: 'error', error: { message: '第一行\n第二行' } }), '执行出错：第一行 第二行');
  // `??` 只跳过 null/undefined：空的 error.message 会挡住 reason.message 这条退路。
  assert.equal(reasonText({ kind: 'error', error: { message: '' }, reason: { message: '退路' } }), '执行出错',
    '空 error.message 挡住退路（现状）');
  assert.equal(reasonText({ kind: 'error', reason: { message: '只有 reason' } }), '执行出错：只有 reason');
  assert.equal(reasonText({ kind: 'error', error: { message: 42 } }), '执行出错', '非字符串细节丢掉');
  assert.equal(reasonText({ kind: 'error', error: { message: 'z'.repeat(300) } }).length, '执行出错：'.length + 160);
});

/* ------------------------------------------------------------ buildTranscript */

test('buildTranscript：非数组当空列表，工具结果折进对应调用', () => {
  assert.deepEqual(buildTranscript(undefined), []);
  assert.deepEqual(buildTranscript(null), []);
  assert.deepEqual(buildTranscript('nope'), []);
  assert.deepEqual(buildTranscript({}), []);

  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: '列一下目录' } },
    { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'shell', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'c1', content: 'a.txt\nb.txt' } } },
    { type: 'assistant/message', seq: 5, data: { message: { content: '有两个文件' } } },
    { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } },
  ];
  const messages = buildTranscript(events);
  assert.equal(messages.length, 5, 'tool/result 被折叠，不再单独占一条');
  const tool = messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'done');
  assert.equal(tool.tool.result, 'a.txt\nb.txt');
  assert.equal(tool.tool.isError, false);
  assert.deepEqual(messages.map((message) => message.role), ['divider', 'user', 'tool', 'assistant', 'divider'],
    '顺序必须保持「开始 → 提问 → 调用 → 回答 → 结束」');
});

test('buildTranscript：找不到对应调用的工具结果单独成条，不吞数据', () => {
  const messages = buildTranscript([
    { type: 'tool/result', seq: 1, data: { message: { toolCallId: 'ghost', content: '孤儿结果' } } },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'tool-result');
  assert.equal(messages[0].text, '孤儿结果');
});

test('buildTranscript：连续 assistant 步骤保持独立（思考→调用→结果 的顺序感）', () => {
  const messages = buildTranscript([
    { type: 'assistant/message', seq: 1, data: { step: 1, message: { content: '先想' } } },
    { type: 'assistant/message', seq: 2, data: { step: 2, message: { content: '再答' } } },
  ]);
  assert.deepEqual(messages.map((message) => message.text), ['先想', '再答']);
  assert.deepEqual(messages.map((message) => message.step), [1, 2]);
});

test('buildTranscript：max 只保留最后 N 条', () => {
  const events = Array.from({ length: 30 }, (_, index) => ({
    type: 'assistant/message', seq: index, data: { message: { content: `第${index}条` } },
  }));
  const messages = buildTranscript(events, { max: 10 });
  assert.equal(messages.length, 10);
  assert.equal(messages[0].text, '第20条');
  assert.equal(messages.at(-1).text, '第29条');
  // max=0 走的是 slice(-0) === slice(0)，等于“不裁”，不是“清空”。钉住现状，缺陷见报告。
  assert.equal(buildTranscript(events, { max: 0 }).length, 30, 'max=0 实际等于不限制');
  assert.equal(buildTranscript(events, { max: Number.NaN }).length, 30, 'NaN 不参与比较 → 不裁');
});

test('buildTranscript：只扫最后 2000 个事件，避免超长会话把一次 GET 拖死', () => {
  const total = 2100;
  const events = Array.from({ length: total }, (_, index) => ({
    type: 'assistant/message', seq: index, data: { message: { content: `m${index}` } },
  }));
  const messages = buildTranscript(events, { max: 100000 });
  assert.equal(messages.length, 2000, '扫描窗口是 2000');
  assert.equal(messages[0].seq, 100, '前 100 个事件被窗口裁掉');
  assert.equal(messages.at(-1).seq, 2099);
});

test('buildTranscript：includeInjected 打开后注入消息才会出现', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { content: '真人', source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: '注入', source: { kind: 'system' } } },
  ];
  assert.deepEqual(buildTranscript(events).map((message) => message.text), ['真人']);
  assert.deepEqual(buildTranscript(events, { includeInjected: true }).map((message) => message.text), ['真人', '注入']);
});

test('buildTranscript：没有 callId 的工具调用与结果会互相错配（现状记录）', () => {
  // toolIndex 用 undefined 当键（messages.mjs:240），两条缺 callId 的调用互相覆盖，
  // 结果最终折进**最后**一条调用。这里钉住现状，缺陷见报告。
  const messages = buildTranscript([
    { type: 'tool/call', seq: 1, data: { name: 'a' } },
    { type: 'tool/call', seq: 2, data: { name: 'b' } },
    { type: 'tool/result', seq: 3, data: { message: { content: '结果' } } },
  ]);
  assert.equal(messages.length, 2, '只有一条调用被填上结果');
  assert.equal(messages[0].tool.result, undefined, 'seq=1 的调用拿不到结果');
  assert.equal(messages[1].tool.result, '结果', '结果被折进 seq=2（最后一次写入 undefined 键的调用）');
  assert.equal(messages[1].tool.status, 'done');
});

test('buildTranscript：Unicode 文本与 emoji 原样进入气泡', () => {
  const messages = buildTranscript([
    { type: 'user/message', seq: 1, data: { content: '帮我改一下这个函数 🚀' } },
    { type: 'assistant/message', seq: 2, data: { message: { content: '好的，改好了 ✅' } } },
  ]);
  assert.equal(messages[0].text, '帮我改一下这个函数 🚀');
  assert.equal(messages[1].text, '好的，改好了 ✅');
});
