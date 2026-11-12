import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clock,
  compactNumber,
  inFilter,
  oneLine,
  plainText,
  relTime,
  safeHref,
  shortModel,
  statusMeta,
} from '../../web/lib/format.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 固定“现在”，避免测试随真实时钟漂移。 */
const NOW = new Date(2026, 10, 4, 15, 30, 0).getTime();

test('relTime 覆盖刚刚 / 分钟 / 小时 / 昨天 / 日期', () => {
  assert.equal(relTime(NOW - 5_000, NOW), '刚刚');
  assert.equal(relTime(NOW - 5 * MINUTE, NOW), '5 分钟前');
  assert.equal(relTime(NOW - 3 * HOUR, NOW), '3 小时前');
  assert.equal(relTime(NOW - 4 * HOUR - 3 * DAY, NOW), '11月1日');
  assert.equal(relTime(NOW + 10_000, NOW), '刚刚', '时钟略快时不能出现“-1 分钟前”');
  assert.equal(relTime(0, NOW), '');
  assert.equal(relTime('nope', NOW), '');
});

test('relTime：24 小时内仍说小时，跨过一天才说“昨天”', () => {
  assert.equal(relTime(NOW - 20 * HOUR, NOW), '20 小时前');
  const yesterday = new Date(2026, 10, 3, 13, 30, 0).getTime();
  assert.equal(relTime(yesterday, NOW), '昨天');
});

test('clock 补零且拒绝非法值', () => {
  assert.equal(clock(new Date(2026, 10, 4, 9, 5).getTime()), '09:05');
  assert.equal(clock(new Date(2026, 10, 4, 23, 59).getTime()), '23:59');
  assert.equal(clock(-1), '');
  assert.equal(clock(undefined), '');
});

test('oneLine 折叠空白并按长度截断', () => {
  assert.equal(oneLine('  a\n\n b\t c  '), 'a b c');
  assert.equal(oneLine('abcdef', 4), 'abc…');
  assert.equal(oneLine('abcd', 4), 'abcd');
  assert.equal(oneLine(null), '');
});

test('plainText 去掉标题、列表、强调、代码与链接标记', () => {
  assert.equal(plainText('## 结论 **很好**'), '结论 很好');
  assert.equal(plainText('- 一条\n- 两条'), '一条\n两条');
  assert.equal(plainText('看 `src/a.ts` 这个文件'), '看 src/a.ts 这个文件');
  assert.equal(plainText('前面 [链接](https://example.com) 后面'), '前面 链接 后面');
  assert.equal(plainText('![图](a.png) 说明'), '说明');
  assert.equal(plainText('```ts\nconst a = 1;\n```'), '');
  assert.equal(plainText('a ~~删除~~ b'), 'a 删除 b');
});

test('plainText 不吞掉单个井号（C# / issue 编号）', () => {
  assert.equal(plainText('用 C# 写的，见 #42'), '用 C# 写的，见 #42');
});

test('shortModel 只留最后一段并限长', () => {
  assert.equal(shortModel('volcengine/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(shortModel(''), '');
  assert.equal(shortModel('a'.repeat(40)).length, 22);
});

test('statusMeta 对未知状态有兜底', () => {
  assert.equal(statusMeta('running').label, '运行中');
  assert.equal(statusMeta('cancelled').label, '已中断');
  assert.equal(statusMeta('whatever').cls, 'idle');
});

test('inFilter 把 cancelled / idle 归到“已完成”', () => {
  assert.equal(inFilter({ status: 'running' }, 'running'), true);
  assert.equal(inFilter({ status: 'cancelled' }, 'done'), true);
  assert.equal(inFilter({ status: 'idle' }, 'done'), true);
  assert.equal(inFilter({ status: 'error' }, 'done'), false);
  assert.equal(inFilter({ status: 'error' }, 'error'), true);
  assert.equal(inFilter({ status: 'error' }, 'all'), true);
});

test('compactNumber', () => {
  assert.equal(compactNumber(0), '0');
  assert.equal(compactNumber(999), '999');
  assert.equal(compactNumber(1000), '1k');
  assert.equal(compactNumber(1500), '1.5k');
  assert.equal(compactNumber(12_345), '12k');
});

test('safeHref 只放行 http(s)', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('/relative'), 'https://placeholder.invalid/relative');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref(''), 'https://placeholder.invalid/');
});
