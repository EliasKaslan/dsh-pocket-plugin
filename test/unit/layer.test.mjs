/**
 * 弹层与浏览器历史（C4）的守卫。
 *
 * 事故：`layer()` 每次弹层都 `history.pushState`，关闭时从来没人 `history.back()`
 * —— 历史里留一条幽灵记录。用户按一次返回**什么都不发生**（popstate 无监听、
 * hash 也没变），看起来像返回键坏了；弹几次就攒几条，要按同样多次才退得出去。
 *
 * 这里用最小 DOM 桩（不引 jsdom）把 `web/lib/ui.js` 真跑起来，断言的是**行为**：
 * 打开一次 → 历史多一条；代码关闭 → 退栈一次；按返回关闭 → 不再多退。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/* ---------------------------------------------------------------- DOM 桩 */

class FakeNode {}

class FakeClassList {
  constructor() { this.set = new Set(); }
  toggle(name, value) {
    if (value === undefined) { if (this.set.has(name)) this.set.delete(name); else this.set.add(name); return; }
    if (value) this.set.add(name); else this.set.delete(name);
  }
  contains(name) { return this.set.has(name); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.classList = new FakeClassList();
    this.style = { setProperty() {} };
    this.hidden = false;
  }
  // 真 DOM 里 className 与 classList 是同一份数据的两个视图，桩里必须同步，
  // 否则 `root.className = 'layer-root active'` 之后再问 classList 永远看不见。
  get className() { return [...this.classList.set].join(' '); }
  set className(value) { this.classList.set = new Set(String(value).split(/\s+/u).filter(Boolean)); }
  get firstChild() { return this.children.length > 0 ? this.children[0] : null; }
  append(...kids) { this.children.push(...kids.filter((kid) => kid !== null && kid !== undefined)); }
  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    return child;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
}

/** 迷你 history：够模拟 pushState / back / popstate 的先后关系。 */
class FakeHistory {
  constructor() {
    this.entries = [{ state: null }];
    this.index = 0;
    this.backCalls = 0;
  }
  get state() { return this.entries[this.index].state; }
  get length() { return this.entries.length; }
  pushState(state) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ state });
    this.index = this.entries.length - 1;
  }
  replaceState(state) { this.entries[this.index] = { state }; }
  /** 真浏览器里 back() 是异步的：先记账，稍后才是 popstate。 */
  back() {
    this.backCalls += 1;
    if (this.index === 0) return;
    this.index -= 1;
    queueMicrotask(() => dispatchPopstate());
  }
}

const modalRoot = new FakeElement('div');
const history = new FakeHistory();
const windowListeners = new Map();

function dispatchPopstate() {
  for (const handler of windowListeners.get('popstate') ?? []) handler({});
}

globalThis.Node = FakeNode;
globalThis.history = history;
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag),
  createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: String(text) }),
  querySelector: (selector) => (selector === '#modal-root' ? modalRoot : null),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
  documentElement: { classList: new FakeClassList(), style: { setProperty() {} } },
};
globalThis.window = {
  addEventListener(type, handler) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(handler);
  },
  removeEventListener(type, handler) {
    windowListeners.get(type)?.delete(handler);
  },
};

const { layer } = await import('../../web/lib/ui.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const isOpen = () => modalRoot.classList.contains('active') && modalRoot.children.length > 0;

/** 每条用例都从"只有基础条目"的历史开始，避免上一条用例的 forward 条目干扰断言。 */
function resetHistory() {
  history.entries = [{ state: null }];
  history.index = 0;
}

/* ------------------------------------------------------------------ 用例 */

test('打开弹层压一条历史；代码关闭时退栈一次，历史里不留幽灵条目', async () => {
  resetHistory();
  const baseBacks = history.backCalls;

  const close = layer(() => {});
  assert.equal(history.length, 2, '打开弹层必须压一条历史（Android 返回键靠它）');
  assert.equal(history.index, 1);
  assert.equal(isOpen(), true);

  close();
  await tick();
  assert.equal(isOpen(), false, '弹层已关闭');
  assert.equal(
    history.backCalls - baseBacks,
    1,
    '代码关闭必须退一次栈（修复前这里是 0：历史里留一条幽灵条目，按一次返回什么都不发生）',
  );
  assert.equal(history.index, 0, '关闭后应当回到打开前的历史条目');
});

test('按返回键关闭弹层：不再多退一次（不会一次吞掉两屏）', async () => {
  resetHistory();
  const baseBacks = history.backCalls;

  layer(() => {});
  assert.equal(history.index, 1);

  // 浏览器替我们退了一格，然后才派发 popstate
  history.index = 0;
  dispatchPopstate();
  await tick();

  assert.equal(isOpen(), false, '返回键必须关掉弹层');
  assert.equal(history.backCalls, baseBacks, '这次退栈是浏览器做的，代码不能再补一刀');
  assert.equal(history.index, 0);
});

test('换层只压一条历史记录，最后关掉只退一条（不用按两次返回）', async () => {
  resetHistory();
  const baseBacks = history.backCalls;

  layer(() => {});
  // 弹层里再弹一层（例如选单 → 确认框）
  const inner = layer(() => {});
  assert.equal(history.length, 2, `换层后历史只能有一条弹层记录，实际 ${history.length - 1} 条`);
  assert.equal(history.index, 1);
  assert.equal(history.backCalls, baseBacks, '换层过程中不该有任何退栈');

  inner();
  await tick();
  assert.equal(isOpen(), false);
  assert.equal(history.backCalls - baseBacks, 1, '关掉最后一层只退一条');
  assert.equal(history.index, 0);
});

test('代码关闭后紧接着开新层：新层不会被上一次退栈的回声顶掉', async () => {
  resetHistory();
  const baseBacks = history.backCalls;

  const first = layer(() => {});
  first();
  // 同一轮里立刻开新层（真实路径：actionSheet 选中「中断任务」→ cancelTask() 弹确认框）
  const second = layer(() => {});
  await tick();

  assert.equal(isOpen(), true, '新弹层必须还开着 —— 退栈回声不能把它当成"用户按了返回"直接关掉');

  second();
  await tick();
  assert.equal(isOpen(), false);
  assert.equal(history.index, 0, '最终仍然回到原处（没有攒下幽灵条目）');
  assert.equal(history.backCalls - baseBacks, 2, '两次关闭各退一条，没有多退');
});
