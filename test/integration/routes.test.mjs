/**
 * HTTP 路由矩阵：每个真实存在的路由 × {方法对/方法错, 未授权/已授权}。
 *
 * 路由表不是猜的，是照着 lib/server.mjs 的 handleApi / handle 分支逐条抄下来的：
 *  - 未授权 401 的判定点在 `requireAuth`，它在**任何** /api/v1 业务分支之前；
 *  - 回环路由（pairing / devices / cloud / download / pair 页）走的是
 *    `requireLoopback`，不是令牌闸，因此不在 401 表里；
 *  - 只有 `/devices/:id/revoke` 与 `/cloud/*` 自己实现了 405，其余路由对错误方法
 *    按设计回落到 404（带令牌）或 401（无令牌）—— 测试按真实行为断言，
 *    不编造 405，否则就是假红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  expectSecurityHeaders, jsonResponse, request, requestJson, samePath, startBridge,
} from './support/harness.mjs';

/** health 的版本断言以包版本为准，不在测试里写死。 */
const PKG_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const SECRET_TITLE = '机密任务标题-9f2c7a';

let ctx;
let token;
let mainDeviceId;
let taskId;
let cloud;

before(async () => {
  ctx = await startBridge();
  // 假中继：只实现 server.mjs 真正调用的方法，让 /cloud/* 全分支可达。
  cloud = {
    enabled: false,
    rotated: 0,
    broker: 'mqtt://broker.initial:8083',
    state: 'idle',
    status() {
      return {
        enabled: cloud.enabled,
        state: cloud.state,
        url: 'https://relay.example/room/integration',
        broker: cloud.broker,
        phone: null,
        lastPhoneAt: 0,
        appBase: 'https://relay.example/app',
        lastError: '',
        port: 443,
      };
    },
    rotate() { cloud.rotated += 1; },
    setBroker(value) { cloud.broker = value; return cloud.broker; },
    setEnabled(value) { cloud.enabled = value; return value; },
    authInfo() { return { required: true, configured: true, enabled: true }; },
  };
  ctx.core.setCloud(cloud);

  const paired = await requestJson(ctx.port, '/api/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: ctx.core.state.pairing.code,
      deviceId: 'dev_it_routes',
      name: '路由矩阵手机',
      platform: 'test',
      appVersion: '9.9.9',
    }),
  });
  assert.equal(paired.status, 200, `预置配对失败：${paired.body.slice(0, 200)}`);
  token = paired.json.data.token;
  mainDeviceId = paired.json.data.device.id;
});

after(async () => {
  await ctx?.close();
});

function authed(extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

/* ------------------------------------------------------- 鉴权闸在路由之前 */

test('未授权时每个 /api 业务路由都在路由之前被 401 拦下，响应体不含任何业务数据', async () => {
  const targets = [
    ['GET', '/api/v1/me'],
    ['POST', '/api/v1/self/revoke'],
    ['POST', '/api/v1/ws-ticket'],
    ['GET', '/api/v1/tasks'],
    ['POST', '/api/v1/tasks'],
    ['GET', '/api/v1/tasks/session-any'],
    ['POST', '/api/v1/tasks/session-any/prompt'],
    ['POST', '/api/v1/tasks/session-any/cancel'],
    ['GET', '/api/v1/workspaces'],
    ['GET', '/api/v1/presets'],
    ['GET', '/api/v1/stats'],
    ['GET', '/api/v1/events'],
    // 不存在的路由也必须是 401：证明拦截发生在路由匹配之前，而不是「先 404」。
    ['GET', '/api/v1/definitely-not-a-route'],
    // 方法错了但没令牌：先鉴权，仍然 401（不是 404/405 泄漏路由存在性）。
    ['POST', '/api/v1/health'],
    ['GET', '/api/v1/pair'],
    ['POST', '/api/v1/pairing'],
  ];
  for (const [method, target] of targets) {
    const response = await request(ctx.port, target, { method });
    const body = jsonResponse(response, 401, `${method} ${target}`);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok'], `${target} 的 401 响应体键集合不对：${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(body.error.message, '未授权：请先扫码配对');
    assert.equal(response.body.includes('"data"'), false, `${target} 的 401 里出现了 data 字段`);
    assert.equal(response.body.includes('tokenHash'), false);
    assert.equal(response.body.includes(ctx.core.state.pairing.code), false, `${target} 的 401 里泄漏了配对码`);
  }
});

test('未知 /api 路由：无令牌 401、有令牌 404 —— 401 是鉴权造成的，不是路由造成的', async () => {
  const anonymous = await request(ctx.port, '/api/v1/nope');
  assert.equal(jsonResponse(anonymous, 401, 'GET /api/v1/nope 无令牌').error.code, 'unauthorized');

  const authorized = await requestJson(ctx.port, '/api/v1/nope', { headers: authed() });
  const body = jsonResponse(authorized, 404, 'GET /api/v1/nope 有令牌');
  assert.equal(body.error.code, 'not_found');
  assert.equal(body.ok, false);
});

/* ------------------------------------------------------------ 公开路由 */

test('/api/v1/health：200、只暴露公开字段、端口是实际监听端口', async () => {
  const response = await request(ctx.port, '/api/v1/health');
  const body = jsonResponse(response, 200, 'GET /api/v1/health');
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.data).sort(), [
    'ok', 'port', 'protocol', 'ready', 'requiresPairing', 'started', 'uptimeMs', 'version',
  ]);
  assert.equal(body.data.port, ctx.port);
  assert.equal(body.data.protocol, 1);
  assert.equal(body.data.requiresPairing, true);
  // 不要写死版本号：每次发版都得改测试，改漏了就是一条假红。以 package.json 为准，
  // 这样真正要钉的是「health 报的版本 = 包版本」，而不是某个具体数字。
  assert.equal(body.data.version, PKG_VERSION);
  // publicStatus 的注释承诺：没有路径、没有配对数据、没有错误细节。
  for (const forbidden of ['allowedRoots', 'devices', 'pairing', 'error', ctx.core.state.pairing.code]) {
    assert.equal(response.body.includes(forbidden), false, `health 泄漏了 ${forbidden}`);
  }
});

test('/api/v1/hello：200、不含配对码/二维码/链接，也不再广播任何连接地址', async () => {
  const response = await request(ctx.port, '/api/v1/hello');
  const body = jsonResponse(response, 200, 'GET /api/v1/hello');
  assert.equal(body.ok, true);
  assert.equal(body.data.requiresPairing, true);
  assert.equal(body.data.protocol, 1);
  assert.equal(body.data.pairing, undefined);
  assert.equal(body.data.code, undefined);
  assert.equal(body.data.qrSvg, undefined);
  assert.equal(body.data.link, undefined);
  assert.equal(body.data.deepLink, undefined);
  assert.equal(typeof body.data.fingerprint, 'string');
  assert.match(body.data.fingerprint, /^[0-9a-f]{10}$/u);
  // 字段集合钉死：v2 不再有任何「手机该连哪儿」的字段（局域网直连整条删除）。
  // 把字段曾用名重新加回来，这条就会红，不用再记住每个名字。
  assert.deepEqual(
    Object.keys(body.data).sort(),
    ['features', 'fingerprint', 'name', 'paired', 'platform', 'protocol', 'requiresPairing', 'time', 'version'],
    `hello 的字段集合变了：${JSON.stringify(body.data)}`,
  );
  assert.equal(/192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0/u.test(response.body), false, 'hello 里出现了内网地址形态');
  assert.equal(response.body.includes(ctx.core.state.pairing.code), false, 'hello 泄漏了配对码');
});

/*
 * 新契约的地基：桌面端只监听 IPv4 回环。
 * 断言打在**真的 listen 之后**的 server.address() 上，而不是配置值或常量 ——
 * 配置里写着 127.0.0.1、代码却 listen(port, '0.0.0.0') 的情况必须红。
 */
test('监听地址恒为 127.0.0.1，绝不是 0.0.0.0 —— 读真实 server.address()', async () => {
  const bound = ctx.httpServer.address();
  assert.equal(typeof bound, 'object', `server 没有真的 listen：${JSON.stringify(bound)}`);
  assert.equal(bound.address, '127.0.0.1', `必须只监听回环，实际监听 ${bound.address}`);
  assert.notEqual(bound.address, '0.0.0.0', '监听 0.0.0.0 等于把面板暴露到整个局域网');
  assert.notEqual(bound.address, '::', '监听 :: 同样会覆盖所有网卡');
  assert.equal(bound.family, 'IPv4');
  assert.equal(bound.port, ctx.port, '读回的端口必须与 core 认的一致');

  // 老配置里残留 host 也不能改变监听地址：host 已不是配置项，监听地址是常量。
  const legacy = await startBridge({ config: { host: '0.0.0.0' } });
  try {
    const legacyBound = legacy.httpServer.address();
    assert.equal(legacyBound.address, '127.0.0.1', `旧配置的 host:0.0.0.0 不许真的生效，实际 ${legacyBound.address}`);
    assert.ok(
      legacy.logs.some((line) => line.includes('host 配置已废弃')),
      `旧配置必须留告警，实际日志：${legacy.logs.slice(0, 6).join(' | ')}`,
    );
  } finally {
    await legacy.close();
  }
});

test('/healthz：与 /api/v1/health 同一份 publicStatus，不需要令牌', async () => {
  const response = await request(ctx.port, '/healthz');
  const body = jsonResponse(response, 200, 'GET /healthz');
  assert.equal(body.ok, true);
  assert.equal(body.data.protocol, 1);
  assert.equal(body.data.port, ctx.port);
  assert.equal(body.data.requiresPairing, true);
});

/* ------------------------------------------------------------ 方法错误 */

test('实现了 405 的路由：405 + allow 头 + 指明该用哪个方法', async () => {
  const revoke = await request(ctx.port, `/api/v1/devices/${mainDeviceId}/revoke`, { method: 'PUT' });
  const revokeBody = jsonResponse(revoke, 405, 'PUT /api/v1/devices/:id/revoke');
  assert.equal(revokeBody.error.code, 'method');
  assert.equal(revokeBody.error.message, '请使用 POST');
  assert.equal(revoke.headers.allow, 'POST');

  for (const target of ['/api/v1/cloud/rotate', '/api/v1/cloud/toggle', '/api/v1/cloud/broker']) {
    const response = await request(ctx.port, target, { method: 'GET' });
    const body = jsonResponse(response, 405, `GET ${target}`);
    assert.equal(body.error.code, 'method', `${target} 必须说明是方法问题`);
    assert.equal(response.headers.allow, 'POST');
  }
});

test('其余路由对错误方法按设计回落到 404（带令牌）/ 401（无令牌），且没有 5xx', async () => {
  for (const target of [
    ['POST', '/api/v1/health'],
    ['PUT', '/api/v1/hello'],
    ['POST', '/api/v1/me'],
    ['GET', '/api/v1/pair'],
    ['POST', '/api/v1/pairing'],
    ['DELETE', '/api/v1/tasks'],
    ['PUT', '/api/v1/stats'],
    ['GET', '/api/v1/self/revoke'],
  ]) {
    const [method, pathname] = target;
    const authorized = await request(ctx.port, pathname, { method, headers: authed() });
    const body = jsonResponse(authorized, 404, `${method} ${pathname}（带令牌）`);
    assert.equal(body.error.code, 'not_found', `${method} ${pathname} 应回落到 404 not_found`);
    assert.equal(body.ok, false);

    const anonymous = await request(ctx.port, pathname, { method });
    assert.equal(anonymous.status, 401, `${method} ${pathname}（无令牌）必须先 401`);
  }
});

test('OPTIONS 预检：204 + allow，任何路由都不返回业务数据', async () => {
  for (const target of ['/api/v1/tasks', '/api/v1/nope', '/app/index.html']) {
    const response = await request(ctx.port, target, { method: 'OPTIONS' });
    assert.equal(response.status, 204, `OPTIONS ${target}`);
    assert.equal(response.headers.allow, 'GET, POST, OPTIONS');
    assert.equal(response.body, '', `OPTIONS ${target} 不应有正文`);
    assert.equal(response.headers['content-type'], undefined, `OPTIONS ${target} 不应有 content-type`);
  }
});

/* --------------------------------------------------------- 任务生命周期 */

test('POST /api/v1/tasks：合法请求 201、任务进列表、详情可读、cwd 落在 allowedRoots 内', async () => {
  const created = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt: SECRET_TITLE, cwd: ctx.workRoot, clientTaskId: 'client-it-1' }),
  });
  const body = jsonResponse(created, 201, 'POST /api/v1/tasks');
  assert.equal(body.ok, true);
  const task = body.data.task;
  assert.match(task.id, /^session-[0-9a-f-]{36}$/u);
  assert.equal(task.title, SECRET_TITLE);
  assert.equal(task.status, 'running');
  assert.equal(task.origin, 'user');
  assert.equal(task.isSubagent, false);
  assert.ok(samePath(task.cwd, ctx.workRoot), `cwd 应解析成 allowedRoots 里的真实目录，实际 ${task.cwd}`);
  taskId = task.id;

  const list = jsonResponse(await requestJson(ctx.port, '/api/v1/tasks', { headers: authed() }), 200, 'GET /api/v1/tasks');
  assert.equal(list.data.total, 1);
  assert.equal(list.data.tasks.length, 1);
  assert.equal(list.data.tasks[0].id, taskId);
  assert.equal(list.data.hasMore, false);
  assert.equal(list.data.summary.total, 1);
  assert.equal(list.data.summary.running, 1);

  const detail = jsonResponse(await requestJson(ctx.port, `/api/v1/tasks/${taskId}`, { headers: authed() }), 200, 'GET /api/v1/tasks/:id');
  assert.equal(detail.data.task.id, taskId);
  assert.deepEqual(detail.data.messages, [], '假 sessionQuery 没有事件，详情应是空消息而不是报错');
  assert.deepEqual(detail.data.children, []);
  assert.equal(detail.data.degraded, false);
  assert.equal(detail.data.capturedThroughSeq, 0);
});

test('POST /api/v1/tasks 幂等：同一 clientTaskId 第二次回 200 reused，且只创建一次 agent', async () => {
  const createdBefore = ctx.fakes.created.length;
  const again = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt: SECRET_TITLE, cwd: ctx.workRoot, clientTaskId: 'client-it-1' }),
  });
  const body = jsonResponse(again, 200, 'POST /api/v1/tasks（重放）');
  assert.equal(body.data.reused, true);
  assert.equal(body.data.task.id, taskId, '重放必须命中同一个任务');
  assert.equal(ctx.fakes.created.length, createdBefore, '重放不应再调 agents.create');
});

test('POST /tasks/:id/prompt 与 /cancel 真的作用到 agent，而不是回 200 空转', async () => {
  const agent = ctx.fakes.agents.get(taskId);
  assert.notEqual(agent, undefined, '创建任务时应注册 agent');

  const prompted = await requestJson(ctx.port, `/api/v1/tasks/${taskId}/prompt`, {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt: '追加一句' }),
  });
  const promptBody = jsonResponse(prompted, 200, 'POST /api/v1/tasks/:id/prompt');
  assert.equal(promptBody.data.task.id, taskId);
  assert.equal(promptBody.data.task.lastText, '追加一句');
  assert.equal(promptBody.data.task.status, 'running');
  assert.equal(agent.messages.length, 2, '创建时的 prompt + 追加的 prompt 都应进 agent');
  assert.equal(agent.messages[1].content[0].text, '追加一句');
  assert.deepEqual(agent.messages[1].source, { kind: 'user', client: 'mobile' });

  const cancelled = await requestJson(ctx.port, `/api/v1/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: authed(),
  });
  const cancelBody = jsonResponse(cancelled, 200, 'POST /api/v1/tasks/:id/cancel');
  assert.equal(cancelBody.data.task.status, 'cancelled');
  assert.equal(agent.cancelled, true, 'cancel 必须真的调到 agent.cancel');
  assert.deepEqual(agent.cancelReason, { kind: 'user' });
});

test('未知任务的详情/追问/中断：404、404、409，不是 500', async () => {
  const detail = await requestJson(ctx.port, '/api/v1/tasks/session-missing', { headers: authed() });
  assert.equal(jsonResponse(detail, 404, 'GET 未知任务').error.code, 'not_found');

  const prompt = await requestJson(ctx.port, '/api/v1/tasks/session-missing/prompt', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt: '在吗' }),
  });
  assert.equal(jsonResponse(prompt, 404, 'POST 未知任务追问').error.code, 'not_found');

  const cancel = await requestJson(ctx.port, '/api/v1/tasks/session-missing/cancel', {
    method: 'POST',
    headers: authed(),
  });
  assert.equal(jsonResponse(cancel, 409, 'POST 未知任务中断').error.code, 'not_running');
});

test('创建任务：越界/相对/UNC/NUL/不存在的 cwd 全部 4xx 且带具体 code', async () => {
  const outside = path.join(ctx.root, 'outside-workspace');
  await mkdir(outside, { recursive: true });

  const cases = [
    [{ cwd: outside }, 403, 'cwd_forbidden'],
    [{ cwd: 'relative/workspace' }, 400, 'bad_cwd'],
    [{ cwd: '\\\\server\\share' }, 400, 'bad_cwd'],
    [{ cwd: path.join(ctx.root, 'nope-does-not-exist') }, 400, 'bad_cwd'],
    [{ cwd: `${ctx.workRoot}\u0000x` }, 400, 'bad_cwd'],
  ];
  for (const [fields, status, code] of cases) {
    const response = await requestJson(ctx.port, '/api/v1/tasks', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prompt: '越界测试', ...fields }),
    });
    const body = jsonResponse(response, status, `cwd=${JSON.stringify(fields.cwd)}`);
    assert.equal(body.error.code, code, `cwd=${JSON.stringify(fields.cwd)} 的 code 不对：${body.error.message}`);
    assert.equal(body.ok, false);
  }
});

test('不传 cwd 时落在第一个 allowedRoot，而不是任意目录', async () => {
  const response = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt: '不传 cwd' }),
  });
  const body = jsonResponse(response, 201, 'POST /api/v1/tasks（无 cwd）');
  assert.ok(samePath(body.data.task.cwd, ctx.workRoot));
});

test('allowedRoots 为空时创建任务 fail-closed：403 cwd_forbidden', async () => {
  const isolated = await startBridge({ allowedRoots: false });
  try {
    const token2 = isolated.mint().token;
    const response = await requestJson(isolated.port, '/api/v1/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${token2}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '没有允许的工作区' }),
    });
    const body = jsonResponse(response, 403, 'POST /api/v1/tasks（无 allowedRoots）');
    assert.equal(body.error.code, 'cwd_forbidden');
    const stats = jsonResponse(await requestJson(isolated.port, '/api/v1/stats', {
      headers: { authorization: `Bearer ${token2}` },
    }), 200, '有令牌');
    assert.deepEqual(stats.data.allowedRoots, { mode: 'closed', count: 0 }, '空 roots 必须是 closed，不能变成「任意目录」');
  } finally {
    await isolated.close();
  }
});

/* ------------------------------------------------------ 令牌路由的响应体 */

test('GET /api/v1/me：200、设备视图不含 tokenHash、不含配对码', async () => {
  const response = await request(ctx.port, '/api/v1/me', { headers: authed() });
  const body = jsonResponse(response, 200, 'GET /api/v1/me');
  assert.deepEqual(Object.keys(body.data.device).sort(), [
    'appVersion', 'createdAt', 'id', 'lastIp', 'lastSeenAt', 'name', 'platform',
  ]);
  assert.equal(body.data.device.id, mainDeviceId);
  assert.equal(body.data.device.name, '路由矩阵手机');
  assert.equal(body.data.device.platform, 'test');
  assert.equal(body.data.device.appVersion, '9.9.9');
  assert.equal(body.data.server.protocol, 1);
  assert.equal(body.data.stats.port, ctx.port);
  // v2：status() 里已经没有 baseUrl（只有回环监听，没有「手机该打开的地址」）。
  assert.equal(body.data.baseUrl, undefined, '/me 不该再带 baseUrl');
  assert.equal(body.data.stats.baseUrl, undefined, 'stats 就是 status()，同样不许带 baseUrl');
  assert.equal(response.body.includes('tokenHash'), false);
  assert.equal(response.body.includes(token), false, '/me 不应把令牌再回显出来');
  assert.equal(response.body.includes(ctx.core.state.pairing.code), false);
});

test('GET /api/v1/workspaces：200，当前任务的 cwd 作为 recent 工作区出现', async () => {
  const body = jsonResponse(await requestJson(ctx.port, '/api/v1/workspaces', { headers: authed() }), 200, 'GET /api/v1/workspaces');
  assert.ok(Array.isArray(body.data.workspaces));
  const entry = body.data.workspaces.find((item) => samePath(item.path, ctx.workRoot));
  assert.notEqual(entry, undefined, `工作区列表里应有 ${ctx.workRoot}：${JSON.stringify(body.data.workspaces)}`);
  assert.equal(entry.recent, true);
  assert.equal(entry.available, true);
  assert.equal(entry.title, path.basename(ctx.workRoot));
});

test('GET /api/v1/presets：200，默认预设被标记，没有默认模型时字段缺省而不是报错', async () => {
  const body = jsonResponse(await requestJson(ctx.port, '/api/v1/presets', { headers: authed() }), 200, 'GET /api/v1/presets');
  assert.equal(body.data.defaultId, 'it-default');
  assert.deepEqual(body.data.presets.map((preset) => preset.id), ['it-default', 'it-other']);
  assert.equal(body.data.presets[0].isDefault, true);
  assert.equal(body.data.presets[0].name, '集成默认');
  assert.equal(body.data.presets[1].isDefault, false);
  assert.equal(body.data.model, undefined);
});

test('GET /api/v1/stats：200，端口/ready/设备数/allowedRoots 与真实状态一致', async () => {
  const body = jsonResponse(await requestJson(ctx.port, '/api/v1/stats', { headers: authed() }), 200, 'GET /api/v1/stats');
  assert.equal(body.data.port, ctx.port);
  assert.equal(body.data.ready, true);
  assert.equal(body.data.started, true);
  assert.equal(body.data.protocol, 1);
  assert.equal(body.data.devices, ctx.core.devicesView().length);
  assert.deepEqual(body.data.allowedRoots, { mode: 'config', count: 1 });
  assert.deepEqual(body.data.auth, { required: true });
});

test('POST /api/v1/ws-ticket：200、ticket 前缀与过期时间；ticket 只发一次（消费逻辑在 realtime 里测）', async () => {
  const body = jsonResponse(await requestJson(ctx.port, '/api/v1/ws-ticket', {
    method: 'POST',
    headers: authed(),
  }), 200, 'POST /api/v1/ws-ticket');
  assert.match(body.data.ticket, /^wst_[A-Za-z0-9_-]{20,}$/u);
  assert.ok(body.data.expiresAt > Date.now());
  assert.ok(body.data.expiresAt <= Date.now() + 61_000);
});

/* ---------------------------------------------------------- 回环管理面 */

test('GET /api/v1/pairing：200，配对码与设备列表一起下发（回环可用）', async () => {
  const response = await requestJson(ctx.port, '/api/v1/pairing');
  const body = jsonResponse(response, 200, 'GET /api/v1/pairing');
  assert.match(body.data.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/u);
  assert.equal(body.data.code, ctx.core.state.pairing.code);
  assert.equal(body.data.available, true);
  assert.ok(body.data.expiresAt > Date.now());
  assert.equal(body.data.maxUses, 10);
  assert.equal(body.data.maxDevices, 8);
  assert.equal(body.data.ttlMs, 600_000);
  assert.match(body.data.fingerprint, /^[0-9a-f]{10}$/u);
  assert.ok(Array.isArray(body.data.devices));
  assert.ok(body.data.devices.some((device) => device.id === mainDeviceId));
  // v2：配对视图只剩「码 + 计数 + 指纹」，二维码/链接/路由地址全部删除。
  // 字段集合钉死，任何一处「顺手加回来」都会红。
  assert.deepEqual(
    Object.keys(body.data).sort(),
    ['available', 'code', 'createdAt', 'devices', 'expiresAt', 'fingerprint', 'maxDevices', 'maxUses', 'ttlMs', 'uses'],
    `配对视图的字段集合变了：${JSON.stringify(Object.keys(body.data))}`,
  );
  assert.equal('qrSvg' in body.data, false, '配对视图不该再有二维码');
  assert.equal('link' in body.data, false, '配对视图不该再有链接');
  assert.equal('deepLink' in body.data, false, '配对视图不该再有深链');
  assert.equal('baseUrl' in body.data, false, '配对视图不该再有 baseUrl');
});

/*
 * spec 第 2 条：pairingView() 序列化后不许含任何内网地址形态。
 * 直接对「方法返回值」断言（而不是某个路由的响应），这样以后新增调用方也覆盖到。
 */
test('pairingView()：序列化后不含任何内网地址形态，也不含任何 URL', () => {
  const view = ctx.core.pairingView();
  const text = JSON.stringify(view);

  for (const [label, pattern] of [
    ['192.168.x.x', /192\.168\./u],
    ['10.x.x.x', /10\.\d+\./u],
    ['172.16-31.x.x', /172\.(1[6-9]|2\d|3[01])\./u],
    ['0.0.0.0', /0\.0\.0\.0/u],
    ['localhost', /localhost/u],
    ['任何 http(s) URL', /https?:\/\//u],
  ]) {
    assert.equal(pattern.test(text), false, `pairingView 序列化后出现了 ${label}：${text}`);
  }

  // 配对码本身只是 8 位字符，不暗示任何地址。
  assert.match(view.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/u);
  assert.deepEqual(
    Object.keys(view).sort(),
    ['available', 'code', 'createdAt', 'expiresAt', 'fingerprint', 'maxDevices', 'maxUses', 'ttlMs', 'uses'],
    'pairingView 只该有这 9 个键',
  );
});

test('POST /api/v1/pairing/rotate：200，配对码与有效期一起刷新，且不吐二维码/链接', async () => {
  const before = ctx.core.pairingView();
  const body = jsonResponse(await requestJson(ctx.port, '/api/v1/pairing/rotate', {
    method: 'POST',
    headers: authed(),
  }), 200, 'POST /api/v1/pairing/rotate');
  assert.notEqual(body.data.code, before.code, 'rotate 必须换码');
  assert.match(body.data.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/u);
  assert.equal(body.data.available, true);
  assert.equal(body.data.uses, 0);
  assert.ok(body.data.expiresAt >= before.expiresAt, '换码必须把有效期重新顺延');
  // 写路径（rotate）同样走 pairingView()，二维码/链接不许借这条路径回流。
  for (const gone of ['qrSvg', 'link', 'deepLink', 'baseUrl']) {
    assert.equal(gone in body.data, false, `rotate 响应里出现了已删除的 ${gone}`);
  }
});

test('GET /api/v1/devices：200，只列出未吊销设备，视图与 /pairing 一致', async () => {
  const body = jsonResponse(await requestJson(ctx.port, '/api/v1/devices'), 200, 'GET /api/v1/devices');
  const ids = body.data.devices.map((device) => device.id);
  assert.ok(ids.includes(mainDeviceId));
  assert.equal(new Set(ids).size, ids.length, '设备列表不能有重复');
});

test('设备吊销：200 → 令牌立刻 401 → 再吊销 404；吊销后列表里不再出现', async () => {
  const victim = ctx.mint({ name: '待吊销手机', platform: 'android' });
  const me = await requestJson(ctx.port, '/api/v1/me', { headers: { authorization: `Bearer ${victim.token}` } });
  jsonResponse(me, 200, '吊销前的 /me');

  const revoked = await requestJson(ctx.port, `/api/v1/devices/${victim.device.id}/revoke`, {
    method: 'POST',
    headers: authed(),
  });
  const body = jsonResponse(revoked, 200, 'POST /api/v1/devices/:id/revoke');
  assert.deepEqual(body.data, { revoked: true });

  const afterRevoke = await request(ctx.port, '/api/v1/me', { headers: { authorization: `Bearer ${victim.token}` } });
  assert.equal(jsonResponse(afterRevoke, 401, '吊销后的 /me').error.code, 'unauthorized');

  const again = await requestJson(ctx.port, `/api/v1/devices/${victim.device.id}/revoke`, {
    method: 'POST',
    headers: authed(),
  });
  assert.equal(jsonResponse(again, 404, '重复吊销').error.code, 'not_found');

  const list = jsonResponse(await requestJson(ctx.port, '/api/v1/devices'), 200, 'GET /api/v1/devices');
  assert.equal(list.data.devices.some((device) => device.id === victim.device.id), false, '吊销后的设备不该再出现在列表里');
});

test('POST /api/v1/self/revoke：200 → 自己的令牌随即失效', async () => {
  const self = ctx.mint({ name: '自吊销手机' });
  const body = jsonResponse(await requestJson(ctx.port, '/api/v1/self/revoke', {
    method: 'POST',
    headers: { authorization: `Bearer ${self.token}` },
  }), 200, 'POST /api/v1/self/revoke');
  assert.deepEqual(body.data, { revoked: true });

  const after = await request(ctx.port, '/api/v1/me', { headers: { authorization: `Bearer ${self.token}` } });
  assert.equal(jsonResponse(after, 401, '自吊销后的 /me').error.code, 'unauthorized');
});

/* ------------------------------------------------------------- 云中继面 */

test('GET /api/v1/cloud/status：200、只读（不触发 rotate）、带二维码与口令状态', async () => {
  const rotatedBefore = cloud.rotated;
  const response = await requestJson(ctx.port, '/api/v1/cloud/status', { headers: authed() });
  const body = jsonResponse(response, 200, 'GET /api/v1/cloud/status');
  assert.equal(body.data.state, 'idle');
  assert.equal(body.data.broker, 'mqtt://broker.initial:8083');
  assert.equal(body.data.url, 'https://relay.example/room/integration');
  assert.match(body.data.qrSvg, /^<svg /u);
  assert.deepEqual(body.data.auth, { required: true, configured: true, enabled: true });
  assert.equal(cloud.rotated, rotatedBefore, '只读状态查询不能有副作用');
  assert.equal(ctx.logs.some((line) => line.includes('cloud relay link rotated')), false);
});

test('POST /api/v1/cloud/rotate|toggle|broker：200 且真作用到 cloud；API 出口不带二维码', async () => {
  const rotated = jsonResponse(await requestJson(ctx.port, '/api/v1/cloud/rotate', {
    method: 'POST',
    headers: authed(),
  }), 200, 'POST /api/v1/cloud/rotate');
  assert.equal(cloud.rotated, 1);
  assert.equal(rotated.data.qrSvg, undefined, 'API 出口应剥掉 qrSvg');
  assert.equal(rotated.data.state, 'idle');

  const toggled = jsonResponse(await requestJson(ctx.port, '/api/v1/cloud/toggle', {
    method: 'POST',
    headers: authed(),
  }), 200, 'POST /api/v1/cloud/toggle');
  assert.equal(toggled.data.enabled, true);
  assert.equal(cloud.enabled, true);

  const broker = jsonResponse(await requestJson(ctx.port, '/api/v1/cloud/broker', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: JSON.stringify({ broker: 'mqtts://broker.changed:8883' }),
  }), 200, 'POST /api/v1/cloud/broker');
  assert.equal(cloud.broker, 'mqtts://broker.changed:8883');
  assert.equal(broker.data.broker, 'mqtts://broker.changed:8883');
});

test('未知的 /cloud 动作：桌面挂载 404「未知的远程操作」；/api 别名是固定白名单，未知动作落 404「接口不存在」', async () => {
  const desktop = await requestJson(ctx.port, '/cloud/selfdestruct', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: '{}',
  });
  const body = jsonResponse(desktop, 404, 'POST /cloud/selfdestruct');
  assert.equal(body.error.code, 'not_found');
  assert.equal(body.error.message, '未知的远程操作');

  // API 别名只映射 cloud/status|rotate|toggle|broker 四条，别的一律当未知接口 ——
  // 这条断言把「别名白名单」和「cloud 内部动作」两件事分开，避免误以为漏了 404。
  const api = await requestJson(ctx.port, '/api/v1/cloud/selfdestruct', {
    method: 'POST',
    headers: authed(),
  });
  const apiBody = jsonResponse(api, 404, 'POST /api/v1/cloud/selfdestruct');
  assert.equal(apiBody.error.code, 'not_found');
  assert.equal(apiBody.error.message, '接口不存在');
});

test('桌面表单挂载 /cloud/rotate：CSRF 通过后 303 回 /pair，API 挂载返回 JSON —— 两个挂载同一实现', async () => {
  const form = await request(ctx.port, '/cloud/rotate', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    },
    body: `csrf=${ctx.core.csrfToken}`,
  });
  assert.equal(form.status, 303);
  assert.equal(form.headers.location, '/pair');
  expectSecurityHeaders(form, 'POST /cloud/rotate（表单）');
  assert.equal(cloud.rotated, 2, '表单挂载也必须真的调到 cloud.rotate');
});
