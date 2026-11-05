/**
 * 外壳登录之后的行为：口令是唯一凭据，配对码那一套必须彻底消失。
 *
 * 五件事必须成立，缺一条「只用口令登录」就会退回「先口令、再输 8 位码」：
 *   1. 设备被电脑端移除 / 设备数已满，都要有一句明确的、不得静默的文案；
 *   2. 不在中继外壳里打开时，连接页只给提示、不发起任何请求；
 *   3. 连接页上不再有配对码（也没有任何输入框），主路径是「重新登录」；
 *   4. `__POCKET_SHELL__.deviceToken` 能直接变成一份可用会话 —— app.js 因此
 *      开机就渲染任务列表，不再经过连接页；
 *   5. `web/` 的源码里搜不到 `/api/v1/pair`，也搜不到 `配对码`；`remote/`
 *      的源码里能查到设备令牌的上行、吸收与下行。
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

const {
  DEVICE_MESSAGES, RELAY_REQUIRED_MESSAGE, SIGNED_OUT_MESSAGE, deviceIssueMessage, mountConnect,
} = await import('../../web/views/connect.js');
const store = await import('../../web/store.js');

/* ------------------------------------------------------------------ 工具 */

const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

function textOf(el) {
  let text = el.textContent ?? '';
  for (const child of el.children) {
    if (child instanceof FakeElement) text += textOf(child);
  }
  return text;
}

function collect(el, visit) {
  for (const child of el.children) {
    if (!(child instanceof FakeElement)) continue;
    visit(child);
    collect(child, visit);
  }
}

function inputsOf(screen) {
  const inputs = [];
  collect(screen, (el) => { if (el.tagName === 'INPUT') inputs.push(el); });
  return inputs;
}

function buttonOf(screen) {
  return screen.find((el) => String(el.className).includes('connect-submit'));
}

/** 任何一次 HTTP 都会让用例失败：连接页不该再有能发请求的控件。 */
function mountContext(calls = []) {
  return {
    appVersion: 'test',
    api: async (path, options) => {
      calls.push({ path, options });
      throw new Error('连接页不该再发起任何 HTTP 请求');
    },
    relogin: () => calls.push({ relogin: true }),
    reloadPage: () => calls.push({ reload: true }),
  };
}

function withShell(value) {
  if (value === undefined) delete globalThis.__POCKET_SHELL__;
  else globalThis.__POCKET_SHELL__ = value;
}

/* ------------------------------------------------- 1. 两种失败态的文案 */

test('被移除 / 设备数满都有明确文案，未知状态不冒充正常', () => {
  assert.equal(DEVICE_MESSAGES.revoked, '这台设备已被电脑端移除，请重新用口令登录');
  assert.equal(DEVICE_MESSAGES.limit, '设备数已达上限，请先在电脑上移除旧设备');
  assert.equal(deviceIssueMessage('revoked'), DEVICE_MESSAGES.revoked);
  assert.equal(deviceIssueMessage('limit'), DEVICE_MESSAGES.limit);
  for (const unknown of ['', 'unknown', undefined, null, 0]) {
    assert.equal(deviceIssueMessage(unknown), '', `${String(unknown)} 不该编一句文案出来`);
  }
});

/* --------------------------------------- 2. 只有中继外壳里才有登录的可能 */

test('非中继外壳：连接页给出「本页面必须从中继外壳打开」并禁用按钮', () => {
  withShell(undefined);
  const root = new FakeElement('div');
  const view = mountConnect(root, mountContext());

  const notice = view.screen.find((el) => el.className === 'connect-notice');
  assert.notEqual(notice, null, '必须有提示条');
  assert.equal(notice.hasAttribute('hidden'), false, '非中继外壳下提示条必须可见');
  assert.match(textOf(notice), /本页面必须从中继外壳打开/u);

  const submit = buttonOf(view.screen);
  assert.notEqual(submit, null, '必须有主按钮');
  assert.equal(submit.disabled, true, '非中继外壳下按钮必须禁用');
  assert.match(textOf(view.screen), /局域网直连已经删除/u, '要说明直连已经不存在');
  assert.deepEqual(inputsOf(view.screen), [], '连接页不该再有任何输入框');
});

test('非中继外壳：就算绕过按钮也不会偷偷直连', async () => {
  withShell(undefined);
  const calls = [];
  const root = new FakeElement('div');
  const view = mountConnect(root, mountContext(calls));

  buttonOf(view.screen).listeners.get('click')();
  await tick();

  assert.deepEqual(calls, [], '不该发出任何请求，也不该触发重新登录');
  const error = view.screen.find((el) => el.className === 'connect-error');
  assert.equal(error.hasAttribute('hidden'), false);
  assert.equal(error.textContent, RELAY_REQUIRED_MESSAGE);
});

/* ------------------------------------- 3. 中继外壳里的三种设备状态 */

test('中继外壳：设备已被电脑端移除 —— 说明白，并引导重新用口令登录', async () => {
  withShell({ mode: 'remote', baseUrl: 'https://dsh-remote.local', deviceToken: '', deviceError: 'revoked' });
  const calls = [];
  const view = mountConnect(new FakeElement('div'), mountContext(calls));

  const notice = view.screen.find((el) => el.className === 'connect-notice');
  assert.equal(notice.hasAttribute('hidden'), true, '中继外壳下不该出现「必须从中继外壳打开」');

  assert.match(textOf(view.screen), /这台设备已被电脑端移除，请重新用口令登录/u);
  assert.deepEqual(inputsOf(view.screen), [], '绝不能退回「手输 8 位码」');

  const submit = buttonOf(view.screen);
  assert.match(textOf(submit), /重新登录/u);
  submit.listeners.get('click')();
  await tick();
  assert.deepEqual(calls, [{ relogin: true }], '按钮必须回到口令闸门');
});

test('中继外壳：设备数已达上限 —— 说明白，按钮是重试而不是重新登录', async () => {
  withShell({ mode: 'remote', baseUrl: 'https://dsh-remote.local', deviceToken: '', deviceError: 'limit' });
  const calls = [];
  const view = mountConnect(new FakeElement('div'), mountContext(calls));

  assert.match(textOf(view.screen), /设备数已达上限，请先在电脑上移除旧设备/u);
  assert.deepEqual(inputsOf(view.screen), []);

  const submit = buttonOf(view.screen);
  assert.match(textOf(submit), /重试/u);
  submit.listeners.get('click')();
  await tick();
  assert.deepEqual(calls, [{ reload: true }], '手机端没有别的动作，只能等电脑上腾位置');
});

test('中继外壳：既没令牌也没错误 —— 提示先登录，不冒充已连接', async () => {
  withShell({ mode: 'remote', baseUrl: 'https://dsh-remote.local' });
  const view = mountConnect(new FakeElement('div'), mountContext());
  assert.ok(textOf(view.screen).includes(SIGNED_OUT_MESSAGE), '要说清楚「还没有登录」');
  assert.match(textOf(buttonOf(view.screen)), /重新登录/u);
});

/* ------------------------------- 4. 设备令牌直接变成可用会话 */

test('外壳给的设备令牌能直接建出会话：app.js 开机就进任务列表', () => {
  withShell({
    mode: 'remote',
    baseUrl: 'https://dsh-remote.local',
    deviceToken: 'dshb_device_token',
    deviceId: 'dev_phone_1',
  });
  const session = store.sessionFromShell(null);
  assert.notEqual(session, null);
  assert.equal(session.token, 'dshb_device_token');
  assert.equal(session.baseUrl, 'https://dsh-remote.local');
  assert.equal(session.deviceId, 'dev_phone_1');

  store.saveSession(session);
  assert.equal(store.token(), 'dshb_device_token', 'Authorization 用的就是这张令牌');
  assert.equal(store.isRelayShell(), true);
  assert.equal(store.shellDeviceError(), '');
  store.saveSession(null);
});

test('没有设备令牌时 sessionFromShell 返回 null，旧会话不会被当成本次登录', () => {
  for (const shell of [
    { mode: 'remote', deviceError: 'revoked' },
    { mode: 'remote', deviceError: 'limit' },
    { mode: 'remote' },
    { mode: 'local', deviceToken: 'dshb_should_be_ignored' },
    undefined,
  ]) {
    withShell(shell);
    assert.equal(store.sessionFromShell(null), null, `外壳 ${JSON.stringify(shell)} 不该给出会话`);
  }
  withShell(undefined);
});

/* ------------------------------------------- 5. 源码里搜不到直连 / 配对残留 */

test('store.js 不再导出最近的服务器列表（纯直连遗留）', () => {
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

test('web/ 里没有 /api/v1/pair 调用，也没有配对码入口', async () => {
  const PHONE_SHELL = ['app.js', 'store.js', 'lib/net.js', 'lib/dom.js', 'lib/ui.js', 'views/connect.js', 'views/tasks.js'];
  for (const relative of PHONE_SHELL) {
    const source = await readFile(join(WEB, relative), 'utf8');
    assert.equal(/\/api\/v1\/pair(?![a-z])/u.test(source), false, `${relative} 还在调 /api/v1/pair`);
    assert.equal(/配对码/u.test(source), false, `${relative} 还在提配对码`);
    assert.equal(/pair-code|readPairFragment/u.test(source), false, `${relative} 还留着配对码的 DOM / 解析`);
  }
});

test('app.js 开机用外壳令牌建会话，没有令牌才回连接页', async () => {
  const source = await readFile(join(WEB, 'app.js'), 'utf8');
  assert.match(source, /sessionFromShell\(/u, '必须从 __POCKET_SHELL__.deviceToken 建会话');
  assert.match(source, /adoptShellSession\(\)/u);
  assert.match(source, /if \(store\.session !== null\) \{\s*await enterApp\(\);/u, '有会话就直接进任务列表');
  for (const gone of ['tryAutoPair', 'readPairFragment', 'pendingPair']) {
    assert.equal(source.includes(gone), false, `app.js 里还留着 ${gone}`);
  }
});

test('外壳（remote.js）用口令换设备令牌，并把两种失败态透传下去', async () => {
  const source = await readFile(join(REMOTE, 'remote.js'), 'utf8');
  // 上行：auth 与 login 都要自报设备令牌
  assert.match(source, /this\.send\(\{ t: 'auth'[^\n]*deviceClaim\(\) \}\)/u);
  assert.match(source, /this\.send\(\{ t: 'login'[^\n]*deviceClaim\(\) \}\)/u);
  // 应答：两个字段都要被吸收，并丢掉本地那份
  assert.match(source, /reply\?\.revoked === true/u);
  assert.match(source, /reply\?\.deviceLimit === true/u);
  assert.match(source, /dropDevice\('revoked'\)/u);
  assert.match(source, /dropDevice\('limit'\)/u);
  // 下行：令牌与失败原因一起交给 app.js
  assert.match(source, /globalThis\.__POCKET_SHELL__ = \{[\s\S]*?deviceToken,[\s\S]*?deviceError: relay\.deviceIssue/u);
  // 口令闸门仍然在，且仍然在 import('./app.js') 之前
  assert.ok(source.indexOf('showLoginGate(relay') < source.indexOf("await import('./app.js');"));
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
});

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else if (/\.(?:js|mjs|css|html)$/u.test(entry.name)) found.push(full);
  }
  return found;
}
