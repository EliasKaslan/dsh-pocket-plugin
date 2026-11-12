/**
 * 详情响应整形的守卫（流式追新的每帧体积就靠它）。
 *
 * `?after=` 模式下如果还把 task/children 一起发回去，空增量也有 ~3.6 KB；
 * 只回增量本身后约 0.2 KB。这条用例钉住"增量模式不再带任务头"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shapeDetailResponse } from '../../lib/server.mjs';

const full = {
  task: { id: 'task-1', title: '标题', status: 'running' },
  messages: [{ id: 'm1', role: 'assistant', text: 'hi' }],
  total: 1,
  offset: 0,
  hasMore: false,
  nextBefore: '',
  cursorLost: false,
  capturedThroughSeq: 1,
  children: [{ id: 'child-1' }],
  degraded: false,
  truncated: false,
  reset: false,
  hasMoreAfter: false,
};

test('完整模式原样返回（翻历史、首次加载要靠这些字段）', () => {
  const out = shapeDetailResponse(full, { incremental: false });
  assert.equal(out, full, '完整模式必须原样返回，不能丢字段');
  assert.equal(shapeDetailResponse(full).task.id, 'task-1', '不带参数时默认完整模式');
});

test('增量模式只留四个字段：不进 task/children，体积可控', () => {
  const out = shapeDetailResponse(full, { incremental: true });
  assert.deepEqual(Object.keys(out).sort(), ['hasMoreAfter', 'messages', 'reset', 'total']);
  assert.equal(out.total, 1);
  assert.equal(out.messages.length, 1);
  assert.equal(out.task, undefined, '增量模式不许带任务头');
  assert.equal(out.children, undefined, '增量模式不许带子任务列表');
});

test('增量模式对空消息与缺字段都稳（空增量是流式期间的常态）', () => {
  const empty = shapeDetailResponse({ messages: [], total: 0, reset: false, hasMoreAfter: false }, { incremental: true });
  assert.deepEqual(empty, {
    messages: [], total: 0, reset: false, hasMoreAfter: false,
  });
  const broken = shapeDetailResponse(null, { incremental: true });
  assert.deepEqual(broken, {
    messages: [], total: 0, reset: false, hasMoreAfter: false,
  });
  // 布尔位只认严格的 true，别的值一律当作 false，避免手机端拿"truthy"误判。
  const loose = shapeDetailResponse({ messages: [], reset: 'yes', hasMoreAfter: 1 }, { incremental: true });
  assert.equal(loose.reset, false);
  assert.equal(loose.hasMoreAfter, false);
});
