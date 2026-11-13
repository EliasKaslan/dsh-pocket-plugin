/**
 * 触摸屏上的两件事：输入框字号、触控目标尺寸（C5 / C10）。
 *
 * 这两条都没有"能跑的单测"（要真浏览器量布局），但它们**都能用源码钉住判据**：
 *   - C5：输入框字号 < 16px 时 iPhone Safari 聚焦会放大整页，把固定底栏、
 *     `--composer-h`、`--kb` 的定位全部顶飞。正确解法是字号 ≥ 16px，
 *     不是禁止缩放（`maximum-scale=1` / `user-scalable=no` 会破坏可访问性）。
 *   - C10：`.switch` 46×28、`.segment-item` ≈28 高、`.icon-btn.sm` 32×32，
 *     手机上很难点中；视觉尺寸不变，命中区靠透明 `::after` 撑到 44×44。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFile(join(ROOT, relative), 'utf8');

/** 取出某个选择器的规则体（第一条同名规则，含其中的注释）。 */
function ruleBody(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `app.css 里找不到 ${selector} 的规则`);
  const end = css.indexOf('}', at);
  assert.notEqual(end, -1, `${selector} 的规则没有闭合`);
  return css.slice(at, end);
}

/** 命中区高度 = 元素高度 + 上下各一份 inset。 */
function hitHeight(css, selector, baseHeight) {
  const after = ruleBody(css, `${selector}::after`);
  const inset = /inset:\s*(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/u.exec(after);
  assert.notEqual(inset, null, `${selector}::after 必须用 inset 撑开命中区`);
  const vertical = Math.abs(Number(inset[1]));
  return baseHeight + vertical * 2;
}

test('C5：所有真输入框字号都是 16px（iOS 不放大整页）', async () => {
  const css = await read('web/app.css');
  // 四个输入控件：搜索框、会话输入框、提问的自定义回答、新建任务的大输入框。
  const inputs = [
    ['.search-input', '列表搜索框'],
    ['.composer-input', '会话详情底部输入框'],
    ['.q-custom', '提问弹层里的自定义输入'],
    ['.prompt-input', '新建任务的主输入框'],
  ];
  for (const [selector, label] of inputs) {
    const body = ruleBody(css, selector);
    const size = /font-size:\s*([\d.]+)px/u.exec(body);
    assert.notEqual(size, null, `${selector}（${label}）必须显式写 font-size`);
    assert.ok(
      Number(size[1]) >= 16,
      `${selector}（${label}）字号只有 ${size[1]}px：iPhone 聚焦 < 16px 的输入框会自动放大整页，`
      + '固定底栏与 --composer-h / --kb 全部错位',
    );
  }
});

test('C5：两个入口页都没禁用缩放（可访问性红线）', async () => {
  for (const file of ['web/index.html', 'remote/index.html']) {
    const html = await read(file);
    assert.ok(!/maximum-scale/iu.test(html), `${file} 不许出现 maximum-scale（那会禁止用户缩放）`);
    assert.ok(!/user-scalable\s*=\s*['"]?no/iu.test(html), `${file} 不许出现 user-scalable=no`);
    assert.match(html, /viewport-fit=cover/u, `${file} 要保持 viewport-fit=cover`);
  }
});

test('C10：开关 / 分段按钮 / 小图标按钮的命中区都撑到 44px', async () => {
  const css = await read('web/app.css');
  // 视觉尺寸来自各自的规则；命中区来自 ::after 的 inset。
  assert.ok(hitHeight(css, '.switch', 28) >= 44, `.switch 命中区只有 ${hitHeight(css, '.switch', 28)}px`);
  assert.ok(hitHeight(css, '.segment-item', 28) >= 44, `.segment-item 命中区只有 ${hitHeight(css, '.segment-item', 28)}px`);
  assert.ok(hitHeight(css, '.icon-btn.sm', 32) >= 44, `.icon-btn.sm 命中区只有 ${hitHeight(css, '.icon-btn.sm', 32)}px`);

  // 视觉尺寸没有跟着变大（要求是"外层撑命中区，视觉不变"）。
  assert.match(ruleBody(css, '.icon-btn.sm'), /width:\s*32px/u, '.icon-btn.sm 视觉尺寸应保持 32px');
  assert.match(ruleBody(css, '.switch'), /height:\s*28px/u, '.switch 视觉高度应保持 28px');
});
