/**
 * 外壳连接页：直连（局域网 baseUrl）删除之后的行为。
 *
 * 三件事必须成立，缺一条这条路就可能悄悄长回来：
 *   1. `readPairFragment` 不再返回 baseUrl —— 老二维码里还带着地址字段也不报错；
 *   2. 不在中继外壳里打开时，连接页只给提示、不发起任何配对请求；
 *   3. `web/` 与 `remote/` 的源码里搜不到任何直连残留。
 *
 * 为了让 `web/views/connect.js` 能在 Node 里加载，这里给了一份最小的 DOM 桩
 * （只实现连接页真的用到的那几个方法），不引入 jsdom 之类的依赖。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WEB = join(ROOT, 'web');
const REMOTE = join(ROOT, 'remote');

/* ------------------------------------------------------------ 最小 DOM 桩 */

class FakeNode {}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.dataset = {};
    this.style = {};
  }

  setAttribute(name, value) { this.attrs.set(String(name), String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  /** `el.hidden = true/false` 在真 DOM 里是反射属性，桩里要同步到 attributes。 */
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(value) {
    if (value) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener(type, handler) { this.listeners.set(String(type), handler); }
  focus() {}
  remove() {}

  /** 深度优先找第一个满足条件的后代。 */
  find(predicate) {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested !== null) return nested;
    }
    return null;
  }

  querySelector(selector) {
    const tag = String(selector).toUpperCase();
    return this.find((el) => el.tagName === tag);
  }
}

if (globalThis.Node === undefined) globalThis.Node = FakeNode;
if (globalThis.document === undefined) {
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: String(text) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { dataset: {}, classList: { toggle() {} } },
  };
}
// store.js 在模块求值时就订阅了 prefers-color-scheme。
if (globalThis.window === undefined) {
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
}

const { mountConnect, readPairFragment, RELAY_REQUIRED_MESSAGE } = await import('../../web/views/connect.js');
const store = await import('../../web/store.js');

/* ------------------------------------------------------------------ 工具 */

/** 现场的配对二维码：`#pair=<base64url json>`。 */
function fragment(payload) {
  const base64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `#pair=${base64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
}

function textOf(el) {
  let text = el.textContent ?? '';
  for (const child of el.children) {
    if (child instanceof FakeElement) text += textOf(child);
  }
  return text;
}

function mountContext(calls = []) {
  return {
    appVersion: 'test',
    api: async (path, options) => {
      calls.push({ path, options });
      return { token: 'dshb_test_token', server: { name: '书房的电脑' } };
    },
    paired: (session) => calls.push({ paired: session }),
  };
}

function withShell(value) {
  if (value === undefined) delete globalThis.__POCKET_SHELL__;
  else globalThis.__POCKET_SHELL__ = value;
}

/* ------------------------------------------------- 1. 老二维码里的地址被忽略 */

test('readPairFragment 不再返回 baseUrl：老二维码里的 u 被静默忽略', () => {
  const parsed = readPairFragment(fragment({
    u: 'http://192.168.1.23:47901',
    c: 'VX42-9NWA',
    n: '书房的电脑',
    f: 'qr',
  }));
  assert.notEqual(parsed, null, '带 u 的老二维码不该解析失败');
  assert.equal('baseUrl' in parsed, false, 'readPairFragment 不该再返回 baseUrl');
  // deepEqual 同时证明没有多出别的直连字段。
  assert.deepEqual(parsed, { code: 'VX42-9NWA', name: '书房的电脑', via: 'qr' });
  assert.equal(JSON.stringify(parsed).includes('192.168'), false, '不能把局域网地址带出来');
});

test('readPairFragment 对新二维码（只有配对码与设备名）同样成立', () => {
  assert.deepEqual(readPairFragment(fragment({ c: 'AB12-CD34', n: '客厅平板' })), {
    code: 'AB12-CD34', name: '客厅平板', via: '',
  });
  // 只有地址、没有配对码：字段缺省，仍然不报错、不给出地址。
  assert.deepEqual(readPairFragment(fragment({ u: 'https://dsh-remote.local' })), { code: '', name: '', via: '' });
});

test('readPairFragment 对垃圾输入返回 null 而不是抛错', () => {
  for (const bad of ['', '#', '#pair=', '#pair=!!!', '#pair=bm90LWpzb24', '#tasks', undefined, null]) {
    assert.equal(readPairFragment(bad), null, `输入 ${String(bad)} 应返回 null`);
  }
});

/* ----------------------------------- 2. 只有中继外壳里才允许发起配对 */

test('非中继外壳：连接页给出「本页面必须从中继外壳打开」并禁用输入', () => {
  withShell(undefined);
  const root = new FakeElement('div');
  const view = mountConnect(root, mountContext());

  const notice = view.screen.find((el) => el.className === 'connect-notice');
  assert.notEqual(notice, null, '必须有提示条');
  assert.equal(notice.hasAttribute('hidden'), false, '非中继外壳下提示条必须可见');
  assert.match(textOf(notice), /本页面必须从中继外壳打开/u);

  const code = view.screen.find((el) => el.getAttribute('id') === 'pair-code');
  const name = view.screen.find((el) => el.getAttribute('id') === 'device-name');
  const submit = view.screen.find((el) => String(el.className).includes('connect-submit'));
  assert.equal(code.disabled, true, '配对码输入必须禁用');
  assert.equal(name.disabled, true, '设备名输入必须禁用');
  assert.equal(submit.disabled, true, '连接按钮必须禁用');
  assert.match(textOf(view.screen), /局域网直连已经删除/u, '要说明直连已经不存在');
});

test('非中继外壳：就算绕过按钮也不会偷偷直连', async () => {
  withShell(undefined);
  const calls = [];
  const root = new FakeElement('div');
  const view = mountConnect(root, mountContext(calls));
  const code = view.screen.find((el) => el.getAttribute('id') === 'pair-code');
  const submit = view.screen.find((el) => String(el.className).includes('connect-submit'));
  code.value = 'VX42-9NWA';

  submit.listeners.get('click')();
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));

  assert.deepEqual(calls, [], '不该发出任何配对请求');
  const error = view.screen.find((el) => el.className === 'connect-error');
  assert.equal(error.hasAttribute('hidden'), false);
  assert.equal(error.textContent, RELAY_REQUIRED_MESSAGE);
});

test('中继外壳：提示条隐藏、输入可用，配对请求只打到外壳 origin', async () => {
  withShell({ mode: 'remote', baseUrl: 'https://dsh-remote.local', swUrl: './sw.js', assetBase: './' });
  const calls = [];
  const root = new FakeElement('div');
  const view = mountConnect(root, mountContext(calls));

  const notice = view.screen.find((el) => el.className === 'connect-notice');
  assert.equal(notice.hasAttribute('hidden'), true, '中继外壳下不该出现这条提示');

  const code = view.screen.find((el) => el.getAttribute('id') === 'pair-code');
  const submit = view.screen.find((el) => String(el.className).includes('connect-submit'));
  assert.notEqual(code.disabled, true);
  code.value = 'VX42-9NWA';

  submit.listeners.get('click')();
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));

  const request = calls.find((call) => call.path === '/api/v1/pair');
  assert.notEqual(request, undefined, '中继外壳里必须真的去配对');
  assert.equal(request.options.base, 'https://dsh-remote.local');
  assert.equal(request.options.body.code, 'VX42-9NWA');

  const paired = calls.find((call) => call.paired !== undefined);
  assert.notEqual(paired, undefined, '配对成功要写会话');
  assert.equal(paired.paired.baseUrl, 'https://dsh-remote.local');
  assert.equal(paired.paired.token, 'dshb_test_token');
});

test('中继外壳：配对码不足 8 位时本地就拒掉，不发请求', async () => {
  withShell({ mode: 'remote', baseUrl: 'https://dsh-remote.local' });
  const calls = [];
  const root = new FakeElement('div');
  const view = mountConnect(root, mountContext(calls));
  const code = view.screen.find((el) => el.getAttribute('id') === 'pair-code');
  const submit = view.screen.find((el) => String(el.className).includes('connect-submit'));
  code.value = 'VX42-9N';

  submit.listeners.get('click')();
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));

  assert.deepEqual(calls, []);
  const error = view.screen.find((el) => el.className === 'connect-error');
  assert.match(error.textContent, /8 位/u);
});

/* ------------------------------------------- 3. 源码里搜不到直连残留 */

test('store.js 不再导出最近的服务器列表（纯直连遗留）', async () => {
  for (const name of ['recentServers', 'rememberServer', 'forgetServers']) {
    assert.equal(name in store, false, `store.js 不该再导出 ${name}`);
  }
  assert.equal(store.LIMITS.recentServers, undefined, 'LIMITS.recentServers 也一并删掉');
  withShell(undefined);
  assert.equal(store.isRelayShell(), false);
  withShell({ mode: 'remote' });
  assert.equal(store.isRelayShell(), true);
  withShell(undefined);
});

test('web/ 与 remote/ 的源码里没有直连残留', async () => {
  const BANNED = [
    ['payload.u（局域网 baseUrl）', /payload\s*\.\s*u\b/u],
    ['recentServers', /recentServers/u],
    ['rememberServer', /rememberServer/u],
    ['forgetServers', /forgetServers/u],
    ['useBase（切 baseUrl）', /\buseBase\b/u],
    ['currentBase', /\bcurrentBase\b/u],
  ];

  const files = [];
  for (const dir of [WEB, REMOTE]) files.push(...await walk(dir));
  assert.ok(files.length > 20, `只扫到 ${files.length} 个文件，路径可能不对`);

  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [label, pattern] of BANNED) {
      if (pattern.test(source)) offenders.push(`${file.slice(ROOT.length + 1).split('\\').join('/')} 仍有 ${label}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('连接页里没有「手填地址」那套入口', async () => {
  const source = await readFile(join(WEB, 'views', 'connect.js'), 'utf8');
  for (const banned of [/normalizeBase/u, /recent-list/u, /recent-wrap/u, /row-button/u, /section-label/u]) {
    assert.equal(banned.test(source), false, `connect.js 里还有 ${banned}`);
  }
  assert.match(source, /本页面必须从中继外壳打开/u);

  // 结构上也只该剩下两个输入框：配对码 + 设备名。
  withShell(undefined);
  const view = mountConnect(new FakeElement('div'), mountContext());
  const inputs = [];
  collect(view.screen, (el) => { if (el.tagName === 'INPUT') inputs.push(el); });
  assert.deepEqual(
    inputs.map((el) => el.getAttribute('id')),
    ['pair-code', 'device-name'],
    '连接页只留配对码与设备名两个输入',
  );
});

function collect(el, visit) {
  for (const child of el.children) {
    if (!(child instanceof FakeElement)) continue;
    visit(child);
    collect(child, visit);
  }
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else if (/\.(?:js|mjs|css|html)$/u.test(entry.name)) found.push(full);
  }
  return found;
}
