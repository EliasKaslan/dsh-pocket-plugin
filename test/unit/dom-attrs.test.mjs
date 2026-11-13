/**
 * `h()` 的 `type` 兜底（C9）。
 *
 * `<button>` 不写 `type` 时浏览器默认按 `submit` 处理。这类漏写在 review 里
 * 几乎看不见（`h('button', { class: …, on: … })` 看起来很完整），所以修法不是
 * 逐个调用点补，而是在工厂函数里兜底。这里钉住兜底本身：
 *   - 不写 type 的 button → `type="button"`；
 *   - 显式写了（submit/reset/button）→ 原样保留，不许被覆盖；
 *   - 非 button 元素 → 不多加任何属性。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/* ------------------------------------------------------------- 最小 DOM 桩 */

class MiniNode {}

class MiniElement extends MiniNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.value = '';
  }
  setAttribute(name, value) { this.attrs.set(String(name), String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  addEventListener() {}
  append(child) { this.children.push(child); }
}

globalThis.Node = MiniNode;
globalThis.document = {
  createElement: (tag) => new MiniElement(tag),
  createTextNode: (text) => Object.assign(new MiniElement('#text'), { textContent: String(text) }),
};

const { elementAttrs, h } = await import('../../web/lib/dom.js');

/* ------------------------------------------------------------------ 用例 */

test('elementAttrs：没写 type 的 button 补 type=button', () => {
  assert.equal(elementAttrs('button', { class: 'x' }).type, 'button');
  assert.equal(elementAttrs('button', {}).type, 'button');
  // 连 attrs 都没给（h('button')）也要补
  assert.deepEqual(elementAttrs('button', null), { type: 'button' });
  assert.deepEqual(elementAttrs('button', undefined), { type: 'button' });
  // 其它属性一个不少
  const attrs = elementAttrs('button', { class: 'x', 'aria-label': 'y' });
  assert.equal(attrs.class, 'x');
  assert.equal(attrs['aria-label'], 'y');
});

test('elementAttrs：显式写了的 type 不被覆盖（调用方是想清楚过的）', () => {
  for (const type of ['submit', 'reset', 'button']) {
    assert.equal(elementAttrs('button', { type }).type, type);
  }
  // 显式写 type 时返回同一个对象，不额外拷贝
  const source = { type: 'submit' };
  assert.equal(elementAttrs('button', source), source);
  // 条件式写出来的 undefined / 空串 == 没给，照补默认值（不能因为键存在就放过）
  assert.equal(elementAttrs('button', { type: undefined }).type, 'button');
  assert.equal(elementAttrs('button', { type: '' }).type, 'button');
});

test('elementAttrs：非 button 元素一律不动（div/input/a 不加任何默认属性）', () => {
  assert.equal(elementAttrs('div', null), null);
  assert.equal(elementAttrs('div', undefined), null);
  const attrs = { class: 'x' };
  assert.equal(elementAttrs('div', attrs), attrs);
  assert.equal(elementAttrs('INPUT', { name: 'n' }).type, undefined, 'input 的 type 有别的语义，不能乱补');
});

test('h()：真实建出来的 button 元素带 type="button"', () => {
  const el = h('button', { class: 'btn', text: '确定' });
  assert.equal(el.getAttribute('type'), 'button');
  assert.equal(el.className, 'btn');
  assert.equal(el.textContent, '确定');

  // 只给事件、什么都不给的按钮同样要带 type
  const bare = h('button', { on: { click: () => {} } });
  assert.equal(bare.getAttribute('type'), 'button');

  // 显式 submit 不被改写
  assert.equal(h('button', { type: 'submit' }).getAttribute('type'), 'submit');
  // 非按钮不受影响
  assert.equal(h('div', { class: 'x' }).getAttribute('type'), null);
});
