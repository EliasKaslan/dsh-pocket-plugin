/**
 * 外壳"链接记忆"与「粘贴链接」页反馈的守卫。
 *
 * 事故：用户退出后再进来，页面停在「连接你的电脑」，链接框里有一段链接，
 * 点「连接」**毫无反应**。
 *
 * 两个原因：
 *   1. 从桌面图标启动 / 浏览器丢 hash 时，`#r=…&k=…&t=…` 没了，外壳判定
 *      "不是中继外壳"，把用户丢到手动页 —— 而链接从来没有被记住过。
 *   2. 手动页的提交处理是 `if (value.length === 0) return;`，空框点「连接」
 *      静默返回，用户只能看到"什么都没发生"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

test('外壳：成功的链接会被记住，裸启动时自动恢复', () => {
  const source = read('remote/remote.js');
  assert.match(source, /const LINK_KEY = 'dsh\.pocket\.link\.v1';/u);
  assert.match(source, /function readStoredLink\(\)/u);
  assert.match(source, /function storeLink\(value\)/u);
  assert.match(source, /storeLink\(link\.toString\(\)\);?/u, '校验通过后必须落盘');

  // 缺参数时要先尝试用记住的链接恢复，而不是直接进手动页
  const start = source.indexOf('const savedLink = readStoredLink();');
  const manual = source.indexOf("renderManualEntry('这个页面需要电脑端生成的远程链接才能工作。');");
  assert.ok(start > 0 && manual > start, '恢复逻辑必须排在手动页之前');
  assert.match(source, /history\.replaceState\(null, '', '#' \+ savedLink\)/u, '恢复后地址栏也要补回链接');
  // 之后一律用恢复出来的 link，不许再读裸 params
  assert.ok(!/resolveBrokerHint\(params\.get\('s'\)\)/u.test(source), 'broker 提示必须来自 link');
});

test('手动页：空/不完整链接要给出明确反馈，不许静默 return', () => {
  const source = read('remote/remote.js');
  assert.match(source, /const note = el\('small'/u, '需要一个可更新的提示元素');
  assert.match(source, /note\.classList\.add\('pocket-note-error'\)/u, '错误要标红');
  assert.match(source, /还没有填链接/u, '空框要有专门的提示');
  assert.match(source, /这段链接不完整/u, '缺参数要有专门的提示');
  // 以前的核心 bug：空框直接 return
  assert.ok(!/if \(value\.length === 0\) return;/.test(source), '不许再静默返回');
  // 完整性校验要同时看 r/k/t
  assert.match(source, /!parsed\.get\('r'\) \|\| !parsed\.get\('k'\) \|\| !parsed\.get\('t'\)/u);
});

test('手动页：输入框会预填上次的链接（可直接点连接）', () => {
  const source = read('remote/remote.js');
  assert.match(source, /input\.value = fromHash\.length > 0 \? fromHash : \(readStoredLink\(\) \?\? ''\);/u,
    '没有 hash 时用记住的链接预填');
});

test('样式：错误提示有可见的颜色', () => {
  const css = read('remote/remote.css');
  assert.match(css, /\.pocket-note-error \{[^}]*color:/u);
});
