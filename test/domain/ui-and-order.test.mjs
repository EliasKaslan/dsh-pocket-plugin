/**
 * 手机端观感与列表顺序的回归测试（用户这一轮提的四条）。
 *
 * 1. 会话列表按时间倒序（最近的在前），不再"按状态分组"；
 * 2. 详情标题必须看得清：显式取色 + 不透明头部 + 两套主题的对比度达标；
 * 3. 进入会话后定位到最新一条；
 * 4. 加载会话时界面上有「加载中…」。
 *
 * 2/3/4 属于"浏览器里才看得出来"的行为，Node 起不了完整外壳（`web/store.js`
 * 顶层就碰 window/localStorage），所以这里用**源码断言 + 颜色对比度计算**来钉：
 * 对比度是真算的，不是比字符串。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { TaskIndex } from '../../lib/task-index.mjs';

const repo = path.join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

const roots = [];
after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 已经没了 */ }
  }
});

/* ------------------------------------------------- 1) 列表按时间倒序 ---- */

test('snapshot：严格按 updatedAt 倒序，不受状态影响（正在跑的老会话不再压在新会话上）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pocket-order-'));
  roots.push(root);
  const index = new TaskIndex({
    logger: { info() {}, warn() {}, error() {} },
    emit() {},
    state: { touchDevice() {} },
    config: {},
    services: {},
    home: root,
    dataDir: path.join(root, 'pocket'),
  });

  const row = (id, createdAt) => ({ header: { id, createdAt } });
  index.upsertRow(row('old-running', 1_000));
  index.upsertRow(row('new-done', 5_000));
  index.upsertRow(row('middle-error', 3_000));

  // 直接改内部行：模拟"老会话还在跑、新会话刚结束"这个最容易排错序的场景。
  index.getTask('old-running').status = 'running';
  index.getTask('old-running').updatedAt = 2_000;
  index.getTask('new-done').status = 'done';
  index.getTask('new-done').updatedAt = 9_000;
  index.getTask('middle-error').status = 'error';
  index.getTask('middle-error').updatedAt = 6_000;

  const order = index.snapshot({ limit: 50 }).tasks.map((task) => task.id);
  assert.deepEqual(order, ['new-done', 'middle-error', 'old-running'], '必须纯按 updatedAt 倒序');
  index.dispose();
});

test('snapshot：updatedAt 相同也能给出稳定顺序（分页不抖）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pocket-order-tie-'));
  roots.push(root);
  const index = new TaskIndex({
    logger: { info() {}, warn() {}, error() {} },
    emit() {},
    state: { touchDevice() {} },
    config: {},
    services: {},
    home: root,
    dataDir: path.join(root, 'pocket'),
  });
  index.upsertRow({ header: { id: 'b', createdAt: 1_000 } });
  index.upsertRow({ header: { id: 'a', createdAt: 1_000 } });
  index.getTask('a').updatedAt = 5_000;
  index.getTask('b').updatedAt = 5_000;
  const first = index.snapshot({ limit: 10 }).tasks.map((item) => item.id);
  const second = index.snapshot({ limit: 10 }).tasks.map((item) => item.id);
  assert.deepEqual(first, second, '同一毫秒必须稳定');
  assert.deepEqual(first, ['a', 'b'], '兜底用 id 升序');
  index.dispose();
});

/* ----------------------------------------------------- 2) 颜色对比度 ---- */

const css = read('web/app.css');

function tokensOf(prefix) {
  const at = css.indexOf(prefix);
  assert.ok(at >= 0, `找不到 ${prefix}`);
  const block = css.slice(at, css.indexOf('}', at));
  const out = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[match[1]] = match[2].trim();
  return out;
}

function luminance(hex) {
  const value = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(value !== null, `不是 #rrggbb 颜色：${hex}`);
  const n = parseInt(value[1], 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

test('两套主题下正文/次要文字/强调色的对比度都达标', () => {
  for (const [label, tokens] of [
    ['深色', tokensOf(':root {')],
    ['浅色', tokensOf(':root[data-theme="light"] {')],
  ]) {
    // 正文 4.5；次要 3.0；强调色会当正文用，所以也要 4.5。
    const checks = [
      ['--text', '--bg', 4.5],
      ['--text', '--surface', 4.5],
      ['--text-2', '--bg', 4.5],
      ['--text-3', '--bg', 3.0],
      ['--accent', '--bg', 4.5],
      ['--accent', '--surface', 4.5],
    ];
    for (const [fgKey, bgKey, min] of checks) {
      const ratio = contrast(tokens[fgKey], tokens[bgKey]);
      assert.ok(ratio >= min, `${label}主题 ${fgKey} on ${bgKey} 只有 ${ratio.toFixed(2)}，要求 ≥ ${min}`);
    }
  }
});

test('详情标题：显式取色 + 头部不透明（不再靠继承/落在渐变上）', () => {
  const titleAt = css.indexOf('.detail-title {');
  assert.ok(titleAt >= 0, '找不到 .detail-title');
  const titleBlock = css.slice(titleAt, css.indexOf('}', titleAt));
  assert.match(titleBlock, /color:\s*var\(--text\)/u, '标题必须显式用 --text，不能只靠继承');

  const headerAt = css.indexOf('.detail-header {');
  assert.ok(headerAt >= 0, '找不到 .detail-header');
  const headerBlock = css.slice(headerAt, css.indexOf('}', headerAt));
  assert.match(headerBlock, /background:\s*var\(--bg\)/u, '头部要有实底，避免被页面渐变冲淡');
});

/* ------------------------------------------------ 3) 定位到最新一条 ---- */

test('详情视图：进入会话后跳到底部（双帧校正，等布局稳定）', () => {
  const source = read('web/views/detail.js');
  assert.match(source, /paintedDetailId/u, '要记住上一次渲染的会话，切换时才重新定位');
  assert.match(source, /bottomJumpPending/u);
  assert.match(source, /requestAnimationFrame\(\(\) => \{ settle\(\); requestAnimationFrame\(settle\); \}\)/u,
    '要连滚两帧：markdown/图片撑开高度后还能停在最新一条');
  assert.match(source, /scrollToBottom\(true\)/u, '定位用强制滚动');
});

/* --------------------------------------------------- 4) 加载中提示 ---- */

test('详情视图：拿不到详情时显示「加载中…」而不是空白', () => {
  const source = read('web/views/detail.js');
  assert.match(source, /kind: 'loading'/u, '空态要给出 loading 行');
  assert.match(source, /text: '加载中…'/u);
  assert.match(source, /case 'loading'/, 'messageNode 必须能渲染 loading 行');
  // 读失败时不要同时显示"加载中"和错误提示
  assert.match(source, /store\.detailError\s*\n?\s*\? \[\]/u, '出错时不该再显示加载中');
  assert.match(css, /\.msg-loading \{/u, '要有对应的样式');
});

/* ------------------------------------------------ 前端也做一次排序 ---- */

test('store.visibleTasks：前端再按 updatedAt 倒序排一次（unshift / 实时更新也守得住）', () => {
  const source = read('web/store.js');
  const at = source.indexOf('export function visibleTasks()');
  assert.ok(at >= 0, '找不到 visibleTasks');
  const body = source.slice(at, source.indexOf('\n}', at));
  assert.match(body, /out\.sort\(/u, 'visibleTasks 必须排序');
  assert.match(body, /right\.updatedAt \?\? 0\) - \(left\.updatedAt \?\? 0/u, '排序键必须是 updatedAt 倒序');
});

/* -------------------------------- 中继设备不可移除（两个渲染入口都要守） ---- */

test('配对页：中继设备不给「移除」按钮（它是本机凭据，不是手机）', () => {
  // 服务端渲染
  const page = read('lib/pair-page.mjs');
  assert.match(page, /isRelay/u, '服务端渲染要识别中继设备');
  assert.match(page, /本机 · 不可移除/u, '要给出不可移除的说明');
  const relayAt = page.indexOf('const isRelay');
  const buttonAt = page.indexOf('data-revoke=');
  assert.ok(relayAt > 0 && buttonAt > relayAt, '「移除」按钮必须出现在 isRelay 判断之后（即中继设备走不到它）');

  // 前端刷新
  const js = read('web/pair.js');
  assert.match(js, /const isRelay = device\.platform === 'relay'/u, '前端刷新也要识别');
  assert.match(js, /本机 · 不可移除/u);
});
