#!/usr/bin/env node
/**
 * 端到端：起**真实**的 BridgeServer（lib/server.mjs + lib/core.mjs），用真 HTTP 打它，
 * 静态根是**真实构建产物 `docs/`**（由 `node tools/build-shell.mjs` 生成）。
 *
 *   node tools/build-shell.mjs && node test/e2e/run.mjs
 *
 * 与单测的分工：单测证明纯函数对，这里证明「装起来之后」的行为对——
 * 鉴权闸在路由之前、CSP 真的下发、回环信任不可伪造、静态目录不会穿出去，
 * 以及**发出去的确实是那份产物**：`/app/sw.js` 的 BUILD 与 docs/sw.js 一致、
 * 预缓存清单里每个文件都能 200。
 *
 * 为什么不再手写一份 index.html 当 webRoot：那样只能证明「服务器会发文件」，
 * 证明不了产物可用——sw.js 的版本戳、PRECACHE 的完整、mqtt.min.js 是否真的在
 * 产物里，全都被绕过去了。这里直接读仓库里的 docs/，e2e 和线上托管同一份字节。
 *
 * 约束（都是刻意的）：
 *  - dataDir/home 全在 os.tmpdir() 下的一次性目录，跑完删掉，不往仓库里写任何东西；
 *  - 监听 127.0.0.1 的临时端口（port 0 + 读回实际端口），不占用固定端口；
 *  - 不连 MQTT，不碰 ~/.dsh，不 profile 任何真实 DSH 服务（services 为空）；
 *  - after() 里关服务、断连接、删目录，不留常驻进程。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { BridgeCore } from '../../lib/core.mjs';
import { BridgeServer } from '../../lib/server.mjs';
import { PROTOCOL_VERSION } from '../../lib/util.mjs';

const runFile = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** 真实构建产物：e2e 的静态根。**不是**临时手写页。 */
const DOCS = path.join(ROOT, 'docs');
/**
 * webRoot 之外、必须不可达的真实文件——穿越用例的地面真值。
 *
 * 以前在 tmp 里种一个 secret.txt；现在静态根是仓库里的 docs/，
 * 于是"外部文件"就该用真东西：docs/../package.json 确实存在且含一段 HTML 里不可能出现的 JSON。
 */
const OUTSIDE = path.join(ROOT, 'package.json');
const OUTSIDE_MARK = '"main": "lib/index.mjs"';

let tmp;
let core;
let server;
let port;
let logs;
let httpServer;
/** docs/ 的原始字节与由此解析出的版本戳/预缓存清单，用来和 HTTP 面比对。 */
let shellHtml;
let shellSw;
let shellBuild;
let precache;

/* ------------------------------------------------------------------ helpers */

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buffer.toString('utf8'), buffer });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function payload(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）：${response.body.slice(0, 120)}`);
  }
}

/** sw.js 里的 16 位十六进制版本戳。 */
function parseBuild(source) {
  const hit = /const BUILD = '([0-9a-f]{16})';/u.exec(source);
  assert.notEqual(hit, null, 'sw.js 里找不到 `const BUILD = \'<16 hex>\';`');
  return hit[1];
}

/** sw.js 里的预缓存清单（与构建脚本、单测用的同一个正则）。 */
function parsePrecache(source) {
  const hit = /const PRECACHE = ([\s\S]*?);\n/u.exec(source);
  assert.notEqual(hit, null, 'sw.js 里找不到 PRECACHE');
  const list = JSON.parse(hit[1]);
  assert.ok(Array.isArray(list) && list.length >= 5, 'PRECACHE 必须是长度 ≥5 的数组');
  return list;
}

/** 递归列出相对路径（产物有 lib/ views/ icons/ 三层）。 */
async function walk(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full, base));
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found.sort();
}

/* --------------------------------------------------------------------- setup */

before(async () => {
  // 先读产物：这份字节既是"服务端该发什么"的标准答案，也是本进程里唯一的静态根。
  shellHtml = await readFile(path.join(DOCS, 'index.html'));
  shellSw = await readFile(path.join(DOCS, 'sw.js'));
  const source = shellSw.toString('utf8');
  shellBuild = parseBuild(source);
  precache = parsePrecache(source);

  tmp = await mkdtemp(path.join(tmpdir(), 'dsh-pocket-e2e-'));
  const home = path.join(tmp, 'home');
  const dataDir = path.join(home, 'pocket');
  await mkdir(dataDir, { recursive: true });

  logs = [];
  const push = (level) => (...args) => logs.push(`${level} ${args.map(String).join(' ')}`);
  const logger = { info: push('info'), warn: push('warn'), error: push('error') };

  core = new BridgeCore({}, {
    home,
    dataDir,
    host: '127.0.0.1',
    port: 1,
    // 与线上一致：默认 fail-closed，必须有口令才允许中继；这里只测本机 HTTP 面。
    authRequired: true,
  }, logger);
  // 静态根 = 真实产物 docs/，不做任何拷贝：发出去的字节必须就是托管出去的那份。
  server = new BridgeServer(core, { logger, webRoot: DOCS });
  // normalizeConfig 把 0 当非法端口回退到 47901；测试必须用临时端口，所以显式改 0，
  // 让 core.start() 走真实的 listen(0) → 读回实际端口。
  core.config.port = 0;
  await core.start();

  port = core.port;
  httpServer = server.http;
  assert.ok(Number.isInteger(port) && port > 0, `没有拿到实际端口：${port}`);
});

after(async () => {
  try { core?.dispose(); } catch { /* 已经关了 */ }
  try { httpServer?.closeAllConnections?.(); } catch { /* 已断 */ }
  try { server?.close(); } catch { /* 已经关了 */ }
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- tests */

test('服务监听在临时端口上，不是写死的 47901', () => {
  assert.ok(port > 0 && port < 65536, `端口不合法：${port}`);
  assert.notEqual(port, 47901, '测试不许占用默认端口');
  assert.equal(core.started, true);
  assert.equal(core.port, port);
});

test('/api/v1/health 无令牌返回 200 且 ok===true', async () => {
  const response = await request('/api/v1/health');
  assert.equal(response.status, 200);
  const body = payload(response);
  assert.equal(body.ok, true);
  assert.equal(body.data.protocol, PROTOCOL_VERSION, 'HTTP 面报的是 PROTOCOL_VERSION');
  assert.equal(body.data.requiresLogin, true);
});

test('/api/v1/health 的响应头带 CSP 与安全头', async () => {
  const response = await request('/api/v1/health');
  const csp = String(response.headers['content-security-policy'] ?? '');
  assert.match(csp, /default-src 'self'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.match(csp, /base-uri 'none'/u);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
});

test('/api/v1/status 与 /api/v1/tasks 不带令牌都是 401', async () => {
  for (const target of ['/api/v1/status', '/api/v1/tasks', '/api/v1/me']) {
    const response = await request(target);
    assert.equal(response.status, 401, `${target} 必须 401`);
    const body = payload(response);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(String(response.headers['content-type']), 'application/json; charset=utf-8');
  }
});

test('/api/v1/devices 不是令牌闸而是回环闸：本机 200，带中继标记 403', async () => {
  // 设备列表属于桌面管理面：本机浏览器该能看，一旦来自中继就必须拒。
  const local = await request('/api/v1/devices', { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(local.status, 200);
  assert.deepEqual(payload(local).data.devices, []);

  const viaRelay = await request('/api/v1/devices', {
    headers: { host: `127.0.0.1:${port}`, 'x-pocket-relay': core.relayNonce },
  });
  assert.equal(viaRelay.status, 403);
  assert.equal(payload(viaRelay).error.code, 'loopback_only');
});

test('连接页在非回环 Host 下被拒（Host 闸）', async () => {
  const response = await request('/pair', { headers: { host: 'evil.example:47901' } });
  assert.equal(response.status, 403);
  assert.equal(response.body, 'Forbidden');
  assert.ok(logs.some((line) => line.includes('untrusted Host')), '拒绝必须留日志');
});

test('连接页被中继标记挡住（requireLoopback：回环 socket 也不算本机）', async () => {
  const response = await request('/pair', {
    headers: { host: `127.0.0.1:${port}`, 'x-pocket-relay': core.relayNonce },
  });
  // 回环 socket + 合法 Host，只因为带了中继标记就被降级成远程。
  assert.equal(response.status, 403);
  assert.match(response.body, /连接页仅限电脑本机访问/u);
  assert.ok(logs.some((line) => line.includes('pairing page blocked (relay)')), `实际日志：${logs.slice(-3).join(' | ')}`);
});

test('中继标记伪造与真值都换不来回环信任（/api/v1/devices 403 loopback_only）', async () => {
  for (const marker of [core.relayNonce, 'forged-nonce-000']) {
    const response = await request('/api/v1/devices', {
      headers: { host: `127.0.0.1:${port}`, 'x-pocket-relay': marker },
    });
    assert.equal(response.status, 403, `marker=${marker.slice(0, 6)}… 不该放行`);
    assert.equal(payload(response).error.code, 'loopback_only');
  }
});

test('对照组：本机不带中继标记时 /pair 正常返回 200', async () => {
  const response = await request('/pair', { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(response.status, 200, '这条不过就说明前面的 403 没有意义');
  assert.match(String(response.headers['content-type']), /text\/html/u);
  // 用页面上真正稳定的锚点：页面标题是「手机连接」，而且必然教用户用口令登录。
  assert.match(response.body, /手机连接/u);
  assert.match(response.body, /口令/u);
});

test('safeJoin 挡住真实 HTTP 穿越：/app/..%2fpackage.json 拿不到 docs/ 之外的文件', async () => {
  // 地面真值：被穿越的文件确实存在且含可判别的标记，否则这条用例就没有证明力。
  assert.ok((await stat(OUTSIDE)).isFile());
  assert.ok((await readFile(OUTSIDE, 'utf8')).includes(OUTSIDE_MARK), 'package.json 变了，请更新这条用例的地面真值');

  // 这几条真的走到了 safeJoin（URL 解析不会折叠 `%2f`），服务端必须回落到真实 index.html。
  for (const target of [
    '/app/..%2fpackage.json',
    '/app/%2e%2e%2fpackage.json',
    '/app/..%2f..%2fpackage.json',
    '/app/..%2f..%2f..%2fpackage.json',
  ]) {
    const response = await request(target);
    assert.ok(!response.body.includes(OUTSIDE_MARK), `${target} 读到了 webRoot 外的文件`);
    assert.equal(response.status, 200, `${target} 应回落到 index.html`);
    assert.ok(response.buffer.equals(shellHtml), `${target} 的回落内容不是真实 docs/index.html`);
  }
  // `%2e%2e` 与裸 `../` 会被 URL 解析器自己折叠掉（`/app/%2e%2e/x` 变成 `/x`），
  // 请求根本走不到 /app/ 分支，于是 404 —— 同样拿不到 webRoot 外的文件。
  for (const target of ['/app/%2e%2e/package.json', '/app/../../package.json', '/app/a/../../package.json']) {
    const response = await request(target);
    assert.ok(!response.body.includes(OUTSIDE_MARK), `${target} 读到了 webRoot 外的文件`);
    assert.equal(response.status, 404, `${target} 被解析器归一化后应是 404`);
    assert.ok(!response.body.includes('root:'));
  }
});

test('铸出真令牌后同样的路由不再 401（证明前面的 401 是鉴权造成的）', async () => {
  // 配对码接口已删除：设备令牌直接由 core 铸，不再经过任何 HTTP 配对步骤。
  const minted = core.mintDevice({ name: 'E2E 手机', platform: 'test' });
  const token = minted.token;
  assert.match(token, /^dshb_/u);

  const me = await request('/api/v1/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal(payload(me).data.device.id, minted.device.id);

  const tasks = await request('/api/v1/tasks', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(tasks.status, 200);
  const list = payload(tasks);
  assert.equal(list.ok, true);
  assert.deepEqual(list.data.tasks, [], '没有宿主服务时任务列表应为空而不是 500');

  // 令牌错了还是 401，鉴权和内容无关。
  const wrong = await request('/api/v1/me', { headers: { authorization: 'Bearer dshb_wrong_token_000000000000' } });
  assert.equal(wrong.status, 401);
});

/* ------------------------------------------------ 真实产物：docs/ 就是静态根 */

test('静态根是真实产物：docs/ 齐全且与源码同步（build-shell --check 通过）', async (t) => {
  const files = await walk(DOCS);
  assert.ok(files.length >= 20, `docs/ 只有 ${files.length} 个文件，看起来没构建过`);
  for (const required of [
    'index.html', 'sw.js', 'app.js', 'app.css', 'remote.js', 'store.js', 'mqtt.min.js',
    'lib/net.js', 'views/tasks.js', 'icons/icon-192.png', '.nojekyll',
  ]) {
    assert.ok(files.includes(required), `docs/ 缺少 ${required}`);
  }
  assert.equal(shellSw.toString('utf8').includes('__POCKET_BUILD__'), false, 'docs/sw.js 还是源码占位符，没有构建过');

  // 产物与源码漂移时，e2e 会静悄悄地在测旧字节。所以把 --check 也跑一遍（只读，不写盘），
  // 并要求它报的 build 号就是磁盘上 sw.js 里那个——把「服务端发的字节」钉回源码。
  let check;
  try {
    check = await runFile(process.execPath, [path.join(ROOT, 'tools', 'build-shell.mjs'), '--check'], { cwd: ROOT });
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    // 没装依赖时 build-shell 连 mqtt.min.js 都读不到，此时"产物是否最新"根本无从判断：
    // e2e 本身不依赖 node_modules（lib/core.mjs 不 import mqtt），所以这里只降级成诊断，不改判。
    if (/mqtt[\\/]dist[\\/]mqtt\.min\.js|Cannot find (?:package|module) 'mqtt'/u.test(detail)) {
      t.diagnostic(`跳过产物新鲜度校验（缺 node_modules/mqtt，先 npm install）：${detail.split('\n')[0]}`);
      return;
    }
    assert.fail(`docs/ 与源码不一致，先运行 node tools/build-shell.mjs\n${detail}`);
  }
  assert.match(String(check.stdout), new RegExp(`docs/ 已是最新（build ${shellBuild}`, 'u'),
    `--check 报的 build 与 docs/sw.js 里的 ${shellBuild} 不一致`);
});

test('/app/sw.js 就是 docs/sw.js：BUILD 一致且逐字节相同', async () => {
  const response = await request('/app/sw.js');
  assert.equal(response.status, 200);
  assert.match(String(response.headers['content-type']), /javascript/u);
  assert.equal(response.headers['cache-control'], 'no-cache', 'worker 必须每次回源');
  // 逐字节比对，而不是"响应里含 BUILD"：手写 sw.js 或运行时改写版本戳都会含这两个字。
  assert.ok(response.buffer.equals(shellSw), '/app/sw.js 与 docs/sw.js 不一致：服务端可能回落到 index.html，或改写了版本戳');
  const served = response.buffer.toString('utf8');
  assert.equal(parseBuild(served), shellBuild, '匹配 /app/sw.js 返回的 BUILD 与 docs/sw.js 不一致');
  assert.equal(served.includes('__POCKET_BUILD__'), false, '发出去的 sw.js 不得残留占位符');
  assert.deepEqual(parsePrecache(served), precache, 'HTTP 面的 PRECACHE 与磁盘产物不一致');
});

test('precache 清单里每个文件都能从 /app/ 取到 200，且字节与产物一致', async () => {
  assert.equal(precache.includes('./'), true, '清单必须包含壳入口 ./');
  const problems = [];
  let checked = 0;
  for (const entry of precache) {
    const relative = entry.replace(/^\.\//u, '');
    assert.equal(relative.startsWith('/'), false, `清单里不该有绝对路径：${entry}`);
    assert.equal(relative.includes('..'), false, `清单里不该有跳出产物目录的路径：${entry}`);
    const target = relative === '' ? '/app/' : `/app/${relative}`;
    const response = await request(target);
    if (response.status !== 200) { problems.push(`${target} → HTTP ${response.status}`); continue; }
    // 缓存清单是从产物列表生成的；清单里的每一项都必须对应真实产物里的真实字节。
    const onDisk = await readFile(path.join(DOCS, relative === '' ? 'index.html' : relative));
    if (!response.buffer.equals(onDisk)) { problems.push(`${target} 内容与 docs/${relative} 不一致`); continue; }
    if (Number(response.headers['content-length']) !== onDisk.length) {
      problems.push(`${target} 的 content-length 与产物大小不符`);
      continue;
    }
    checked += 1;
  }
  assert.deepEqual(problems, [], `预缓存清单里有取不到的文件：${problems.join('；')}`);
  assert.equal(checked, precache.length, `只有 ${checked}/${precache.length} 项通过`);
});
