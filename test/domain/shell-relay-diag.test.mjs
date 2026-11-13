/**
 * 中继断线诊断的「接线」守卫：证据真的从 socket 一路走到了屏幕上。
 *
 * 事故现场：WiFi 正常、切蜂窝流量就「一直连不上」，屏幕上只有一句
 * 「中继断开，正在重连…」。真实断因当时只进了 `console.warn` —— 手机上没有
 * 控制台，于是每一次现场都不可诊断。修法有四段，这里按链路顺序逐段钉住：
 *
 *   1. `connectOne()` 捕获 error / connack / close，并累计连续失败、最后成功、
 *      最后尝试时刻；
 *   2. 心跳从 40 s 缩到 20 s（运营商 NAT / DPI 的空闲窗口）；
 *   3. 反复失败的重试要带 ±20% 抖动，且**不改**既有指数退避语义；
 *   4. 横幅保留主句并补上短原因，6 秒去抖不变；连接页有诊断块与复制按钮。
 *
 * 纯函数（映射表本身）由 `test/unit/relay-diag.test.mjs` 覆盖，这里只做接线断言。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(path.join(repo, relative), 'utf8');

/** 取一段源码（用于"某个结构里不许出现某个字段"这类断言）。 */
function slice(source, from, length = 900) {
  const at = source.indexOf(from);
  assert.ok(at >= 0, `源码里找不到 ${from}`);
  return source.slice(at, at + length);
}

/* ------------------------- 1. 断因捕获（error / connack / close） ------------------------- */

test('connectOne：error / connack / close 三个事件的断因都要落进 lastFailure', () => {
  const source = read('remote/remote.js');

  assert.match(source, /client\.on\('error', \(error\) => \{/u, 'error 必须被捕获（原来只有 console.warn）');
  // 原来那一行就是问题本体：手机上根本看不到 console.warn。
  assert.equal(
    source.includes("client.on('error', (error) => { console.warn('[pocket] mqtt error', error?.message); });"),
    false,
    'error 不许再只写成一句 console.warn',
  );
  assert.match(source, /client\.on\('connack', \(packet\) => \{/u, 'connack 返回码必须被捕获（4/5 是"中继拒绝"的唯一证据）');
  assert.match(source, /normalizeConnack\(packet\)/u, '返回码要兼容 returnCode / reasonCode 两种字段名');

  // 三个事件都走同一条记账路径
  const failureBody = slice(source, 'noteFailure({ code = \'\'', 700);
  for (const field of ['code', 'message', 'connack', 'at', 'attempts', 'okAt']) {
    assert.match(failureBody, new RegExp(`${field}:`, 'u'), `lastFailure 必须带 ${field}`);
  }

  // error 带 code（ENOTFOUND / ECONNRESET / ERR_TLS_… 都在 code 里）
  assert.match(slice(source, "client.on('error'", 400), /error\?\.code/u, 'error.code 必须被记下来');
  // close 可以不带参数：必须有兜底 code，否则界面上永远是「未知原因」
  assert.match(slice(source, "client.on('close', () => {", 800), /countedFailure|wasReady/u);
  assert.match(source, /code: 'CLOSE'/u, 'close 没有错误码时要补一个 CLOSE，界面才能说"被关闭"而不是"未知原因"');
  // 超时这条路没有 error / close 可等，必须单独记
  assert.match(source, /code: 'ETIMEDOUT'/u, '7 秒超时必须记成 ETIMEDOUT');
});

test('connectOne：连续失败 / 最后成功 / 最后尝试三个量都在维护', () => {
  const source = read('remote/remote.js');
  assert.match(source, /this\.lastAttemptAt = Date\.now\(\);/u, '最后一次尝试时刻');
  assert.match(source, /this\.failureStreak \+= 1;/u, '连续失败次数要累加');
  assert.match(source, /noteRelayOk\(\) \{/u, '必须有一个"成功"入口');
  const okBody = slice(source, 'noteRelayOk() {', 300);
  assert.match(okBody, /this\.lastOkAt = Date\.now\(\);/u, '最后一次成功（拿到 ready）的时刻');
  assert.match(okBody, /this\.failureStreak = 0;/u, '成功必须把连续失败清零');
  // 两条成功路径：connectOne 的 ready 与 restart 成功
  const calls = source.match(/this\.noteRelayOk\(\);/gu) ?? [];
  assert.ok(calls.length >= 2, `connectOne 与 restart 都要记成功（实际 ${calls.length} 处）`);
  // 每次尝试重新收集：上一轮的错误码不能冒充这一轮
  assert.match(source, /this\.lastErrorCode = '';/u);
  assert.match(source, /this\.lastErrorMessage = '';/u);
  assert.match(source, /this\.lastConnack = null;/u);
});

/* -------------------------------- 2. keepalive -------------------------------- */

test('心跳 40 s → 20 s：间隔必须短于运营商 NAT 的空闲窗口', () => {
  const source = read('remote/remote.js');
  assert.match(source, /keepalive: 20,/u, '心跳必须是 20 s（40 s 的静默窗口足够被掐掉整条流）');
  assert.equal(source.includes('keepalive: 40,'), false, '旧的 40 s 不许残留');
  // 理由要写在代码边上，否则下一个人会"顺手改回 40"
  const around = source.slice(source.indexOf('keepalive: 20,') - 700, source.indexOf('keepalive: 20,'));
  assert.match(around, /NAT|PINGREQ/u, '必须写明为什么是 20（NAT 空闲回收 / PINGREQ 间隔）');
});

/* ------------------------------ 3. 重试抖动 ------------------------------ */

test('重建失败的重试带 ±20% 抖动，但不动原有指数退避语义', () => {
  const source = read('remote/remote.js');
  // 原有语义逐个字符保留：1s→2s→4s→8s→16s，上限 15 s
  assert.match(source, /const backoff = Math\.min\(15_000, 1_000 \* \(2 \*\* Math\.min\(this\.restartCount, 4\)\)\);/u,
    '退避语义不许改（原来那一行只是被赋给了 backoff）');
  assert.match(source, /const retryDelay = Math\.round\(backoff \* \(0\.8 \+ Math\.random\(\) \* 0\.4\)\);/u,
    '只在既有退避上叠 ±20% 抖动');
  // "连通过又被关掉"的快重连必须保留原样（用户实测的断线恢复全靠它）
  assert.match(source, /this\.fastRetryTimer = setTimeout\(\(\) => \{[\s\S]{0,160}?\}, 800\);/u,
    'wasReady 之后的 800 ms 快重连必须保留');
});

/* ------------------------------ 4. 横幅与连接页 ------------------------------ */

test('横幅保留「中继断开，正在重连…」主句，后面补短原因，6 秒去抖不变', () => {
  const source = read('remote/remote.js');
  assert.match(source, /中继断开，正在重连…\$\{relayReasonSuffix\(\)\}/u,
    '主句必须还在，并在后面补上真实断因');
  assert.match(source, /const relayReasonSuffix = \(\) => \{/u, '断因要在渲染时现算（读 lastFailure）');
  assert.match(slice(source, 'const relayReasonSuffix', 500), /describeFailureShort/u, '横幅用短标签（一行放不下完整解释）');
  assert.match(source, /\}, 6_000\);/u, '6 秒去抖必须保留：短抖动不打扰用户');
});

test('连接页：诊断块 + 复制按钮，且不在 connect.js 里 import relay-diag（会打穿 web/sw.js）', () => {
  const source = read('web/views/connect.js');
  assert.match(source, /readDiagApi/u, '连接页必须读外壳交过来的诊断接口');
  assert.match(source, /globalThis\.__POCKET_DIAG__/u);
  assert.match(source, /diagApi\.diagRows\(/u, '行数据由纯函数生成（可在 Node 里测）');
  assert.match(source, /diagApi\.buildDiagText\(/u, '复制文本由纯函数生成（白名单字段）');
  assert.match(source, /复制诊断信息/u);
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/u, '复制走 clipboard');
  assert.match(source, /diagFallback/u, '剪贴板不可用时要降级成可选中的文本框');
  // 关键：不许在这个文件里 import 纯逻辑模块 —— web/sw.js 的 ASSETS 是手写清单，
  // 本仓不可改；多一条 import 而清单没跟上，装过 SW 的手机离线首次打开即白屏。
  assert.equal(/^import[^;]*relay-diag[^;]*;/mu.test(source), false,
    'connect.js 不许 import relay-diag.js（web/sw.js 的 ASSETS 会漏，离线打开白屏）');
  // 诊断块必须在 MQTT 成功之前就存在：mount 时就画一次
  assert.match(source, /paintDiag\(\);/u);
});

test('外壳把诊断快照挂到 __POCKET_DIAG__，且只含非敏感字段', () => {
  const source = read('remote/remote.js');
  const block = slice(source, 'globalThis.__POCKET_DIAG__ = {', 900);
  for (const field of ['brokers', 'online', 'attempts', 'lastFailure', 'lastOkAt', 'lastAttemptAt', 'now']) {
    assert.match(block, new RegExp(`${field}:`, 'u'), `快照必须提供 ${field}`);
  }
  for (const functionName of ['snapshot', 'diagRows', 'buildDiagText', 'describeFailure']) {
    assert.match(block, new RegExp(`${functionName}[,:]`, 'u'), `外壳要交出 ${functionName}`);
  }
  // 房间密钥 / 设备令牌 / 链接里的 r、t 一个都不许进快照
  for (const banned of ['deviceToken', 'this.room', 'key:', "get('k')", "get('r')"]) {
    assert.equal(block.includes(banned), false, `__POCKET_DIAG__ 快照里不该出现 ${banned}`);
  }
});

/* ------------------------- 5. 构建与产物：纯逻辑必须真的进 docs/ ------------------------- */

test('纯逻辑模块落在 web/lib/ 且构建后进产物（外壳按 ./lib/ 引用）', () => {
  const source = read('remote/remote.js');
  assert.match(source, /from '\.\/lib\/relay-diag\.js'/u,
    '外壳按产物布局引用 ./lib/relay-diag.js（与 await import(\'./app.js\') 同一规则）');
  // 构建会把 web/** 带进产物根目录；web/lib/relay-diag.js → docs/lib/relay-diag.js
  const docs = read('docs/lib/relay-diag.js');
  assert.match(docs, /export function describeFailure/u, 'docs/ 里必须有构建出来的副本');
});

/* ------------------- 6. 致命页：一次都没连上时也必须能带走断因 ------------------- */

test('一次都没连上时，showFatal 这条路也要带上断因与可复制的诊断', () => {
  const source = read('remote/remote.js');

  // 这条路径是"第一次 connect() 就失败"时唯一的界面：连接页渲染不出来，
  // 诊断块自然也没有。过去这里只有一句「连接超时」，截图都带不出 error.code。
  const fatal = slice(source, "showFatal('无法建立中继连接', because)", 120);
  assert.ok(fatal.length > 0, '致命页必须用带断因的 detail，而不是原始 error.message');

  // 断因来自 connectOne() 抓到的 lastFailure，不是壳话
  const branch = slice(source, 'await relay.connect();', 900);
  assert.match(branch, /describeFailure\(relay\.lastFailure\)/u,
    'catch 里要把 lastFailure 翻译出来，否则连接超时永远是结论');
  assert.equal(branch.includes('String(error?.message ?? error));'),
    false, '不能退回只显示原始 error.message');

  // 复制按钮：clipboard 失败要退回可选中的只读文本框（手机长按更可靠）
  assert.match(source, /function diagCopyButton\(\)/u, '必须有 diagCopyButton');
  const helper = slice(source, 'function diagCopyButton()', 1_600);
  assert.match(helper, /navigator\?\.clipboard\?\.writeText/u, '优先走 clipboard');
  assert.match(helper, /textarea/u, 'clipboard 不可用时退回 textarea');
  assert.match(helper, /readonly/u, '退回的文本框必须只读');

  // showFatal 要把按钮挂上去，且没装好时（早期调用）不能炸
  const showFatal = slice(source, 'function showFatal(title, detail)', 800);
  assert.match(showFatal, /diagCopyButton\(\)/u, 'showFatal 要挂复制按钮');
  assert.match(showFatal, /if \(copy !== null\)/u, '按钮缺失时不能把 splashExtra 弄坏');
  assert.match(read('remote/remote.css'), /\.pocket-diag-raw/u, '退回的文本框要有样式（能选、能读）');
});