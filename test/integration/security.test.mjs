/**
 * 安全闸门：Host 校验（DNS rebinding）、中继标记、CSRF（头/表单/JSON）、
 * 请求体上限、畸形输入、限流。
 *
 * 每条负向断言都配了「对照组」：同一路由、同一进程，只要把闸门拿掉就必须变绿。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import { after, before, test } from 'node:test';

import {
  expectSecurityHeaders, jsonResponse, request, requestJson, startBridge,
} from './support/harness.mjs';

const MAX_BODY = 256 * 1024;
const MAX_FORM_BODY = 4096;
const MAX_PAIR_BODY = 16 * 1024;
const MAX_BROKER_BODY = 8 * 1024;

let ctx;
let token;
let cloud;

before(async () => {
  ctx = await startBridge();
  token = ctx.mint({ name: '安全测试设备' }).token;
  cloud = {
    enabled: false,
    rotated: 0,
    broker: 'mqtt://broker.before:8083',
    status() {
      return {
        enabled: cloud.enabled, state: 'idle', url: '', broker: cloud.broker,
        phone: null, lastPhoneAt: 0, appBase: '', lastError: '', port: 0,
      };
    },
    rotate() { cloud.rotated += 1; },
    setBroker(value) { cloud.broker = value; return cloud.broker; },
    setEnabled(value) { cloud.enabled = value; return value; },
    authInfo() { return { required: true, configured: true, enabled: true }; },
  };
  ctx.core.setCloud(cloud);
});

after(async () => {
  await ctx?.close();
});

function authed(extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

/* ------------------------------------------------------------ Host 校验 */

test('伪造 Host（DNS rebinding）→ 403；回环名与本机名 → 200', async () => {
  // 地面真值：evil.example 不在允许集合里，而 127.0.0.1 在。
  assert.equal(ctx.core.allowedHosts().has('evil.example'), false);
  assert.equal(ctx.core.hostAllowed('evil.example'), false);
  assert.equal(ctx.core.hostAllowed('127.0.0.1'), true);

  // v2 收紧：网卡内网 IPv4 不再被自动加进白名单。这三段是最可能被「顺手放行」的
  // 地址形态，只要白名单里出现一个，就说明 allowedHosts() 又去枚举网卡了。
  assert.equal(
    [...ctx.core.allowedHosts()].some((name) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(name)),
    false,
    `allowedHosts 里混进了内网地址：${JSON.stringify([...ctx.core.allowedHosts()])}`,
  );
  for (const lanHost of [`192.168.1.50:${ctx.port}`, `10.0.0.5:${ctx.port}`, `172.16.4.7:${ctx.port}`]) {
    assert.equal(ctx.core.hostAllowed(lanHost), false, `内网地址 ${lanHost} 不许自动进白名单`);
    const blocked = await request(ctx.port, '/api/v1/health', { headers: { host: lanHost } });
    assert.equal(jsonResponse(blocked, 403, `Host=${lanHost}`).error.code, 'bad_host', `Host=${lanHost} 必须 403`);
    const blockedPage = await request(ctx.port, '/pair', { headers: { host: lanHost } });
    assert.equal(blockedPage.status, 403, `Host=${lanHost} 的 /pair 必须 403`);
    assert.equal(blockedPage.body.includes(ctx.core.state.pairing.code), false, `Host=${lanHost} 的 403 里泄漏了配对码`);
  }

  for (const host of [
    `evil.example:${ctx.port}`,
    `127.0.0.1.evil.example:${ctx.port}`,
    `evil@127.0.0.1:${ctx.port}`,
    'evil.example',
  ]) {
    const api = await request(ctx.port, '/api/v1/health', { headers: { host } });
    const body = jsonResponse(api, 403, `Host=${host} 的 /api/v1/health`);
    assert.equal(body.error.code, 'bad_host', `Host=${host} 必须被 Host 闸拒绝`);
    assert.equal(body.ok, false);

    const page = await request(ctx.port, '/pair', { headers: { host } });
    assert.equal(page.status, 403, `Host=${host} 的 /pair`);
    assert.equal(page.body, 'Forbidden');
    assert.equal(page.body.includes(ctx.core.state.pairing.code), false);

    // Host 闸在所有路由之前：静态资源同样不能绕过。
    const asset = await request(ctx.port, '/app/index.html', { headers: { host } });
    assert.equal(asset.status, 403, `Host=${host} 的 /app/index.html`);
  }

  for (const host of [
    `127.0.0.1:${ctx.port}`,
    `localhost:${ctx.port}`,
    `[::1]:${ctx.port}`,
    '127.0.0.1',
    `${os.hostname()}:${ctx.port}`,
  ]) {
    const response = await request(ctx.port, '/api/v1/health', { headers: { host } });
    assert.equal(response.status, 200, `Host=${host} 应被允许，实际 ${response.status}`);
  }
});

/* -------------------------------------------------------- 中继标记 / 回环 */

test('中继标记：伪造值与真值都换不来回环信任；真值不记伪造日志，伪造值必须记', async () => {
  const forgedStart = ctx.logs.length;
  const forged = await requestJson(ctx.port, '/api/v1/pairing', {
    headers: { 'x-pocket-relay': 'forged-nonce-000' },
  });
  assert.equal(jsonResponse(forged, 403, '伪造中继标记的 /pairing').error.code, 'loopback_only');
  assert.equal(forged.body.includes(ctx.core.state.pairing.code), false);
  assert.ok(
    ctx.logs.slice(forgedStart).some((line) => line.includes('relay 标记无效')),
    `伪造标记必须留日志，实际新增：${ctx.logs.slice(forgedStart).join(' | ')}`,
  );

  const genuineStart = ctx.logs.length;
  const genuine = await requestJson(ctx.port, '/api/v1/pairing', {
    headers: { 'x-pocket-relay': ctx.core.relayNonce },
  });
  assert.equal(jsonResponse(genuine, 403, '真中继标记的 /pairing').error.code, 'loopback_only');
  assert.equal(
    ctx.logs.slice(genuineStart).some((line) => line.includes('relay 标记无效')),
    false,
    '真中继标记不该被记成伪造',
  );

  // 对照组：同一个令牌打令牌路由仍然 200 —— 403 是回环闸造成的，不是令牌失效。
  const me = await request(ctx.port, '/api/v1/me', {
    headers: authed({ 'x-pocket-relay': ctx.core.relayNonce }),
  });
  assert.equal(me.status, 200, '令牌路由不受中继标记影响');
});

/* ------------------------------------------------------------ CSRF（头） */

test('CSRF：写操作缺正确信号一律 403，且被拒的请求不能产生副作用（配对码不变）', async () => {
  const cases = [
    // [headers, 期望状态, 说明]
    [{}, 200, '没有任何浏览器信号：仅限本机工具的既有分支'],
    [{ 'sec-fetch-site': 'same-origin' }, 200, '同源页面'],
    [{ 'sec-fetch-site': 'none' }, 200, '地址栏直接导航'],
    [{ 'sec-fetch-site': 'cross-site' }, 403, '跨站表单'],
    [{ 'sec-fetch-site': 'same-site' }, 403, '同站但不同源'],
    [{ origin: 'http://evil.example' }, 403, '陌生 Origin'],
    [{ origin: 'null' }, 403, 'Origin: null'],
    [{ origin: 'file:///tmp/x' }, 403, '非 http(s) 协议'],
    [{ origin: `http://127.0.0.1:${ctx.port}` }, 200, '本机 Origin'],
    [{ origin: `https://localhost:${ctx.port}` }, 200, 'localhost Origin'],
    [{ 'x-pocket-csrf': 'deadbeefdeadbeefdeadbeefdeadbeef' }, 403, 'CSRF 头错误'],
    [{ 'x-pocket-csrf': ctx.core.csrfToken }, 200, 'CSRF 头正确'],
    [{ 'sec-fetch-site': 'same-origin', 'x-pocket-csrf': 'wrong' }, 200, '浏览器信号优先于 token'],
    [{ 'sec-fetch-site': 'cross-site', 'x-pocket-csrf': ctx.core.csrfToken }, 403, '跨站时 token 也救不回来'],
  ];
  for (const [headers, expected, label] of cases) {
    const codeBefore = ctx.core.state.pairing.code;
    const response = await requestJson(ctx.port, '/api/v1/pairing/rotate', { method: 'POST', headers });
    const codeAfter = ctx.core.state.pairing.code;
    if (expected === 403) {
      const body = jsonResponse(response, 403, `CSRF 用例（${label}）`);
      assert.equal(body.error.code, 'csrf', `${label} 的拒绝原因必须是 csrf`);
      assert.match(body.error.message, /请求来源校验失败/u);
      assert.equal(codeAfter, codeBefore, `${label} 被拒后配对码却变了：拒绝必须无副作用`);
    } else {
      jsonResponse(response, 200, `CSRF 用例（${label}）`);
      assert.notEqual(codeAfter, codeBefore, `${label} 放行后应真的轮换配对码`);
    }
  }

  // token 也可以走查询串（CLI 用），但只在本机无浏览器信号时生效。
  const before = ctx.core.state.pairing.code;
  const viaQuery = await requestJson(ctx.port, `/api/v1/pairing/rotate?csrf=${ctx.core.csrfToken}`, { method: 'POST' });
  jsonResponse(viaQuery, 200, 'CSRF 查询串');
  assert.notEqual(ctx.core.state.pairing.code, before);

  const queryCrossSite = await requestJson(ctx.port, `/api/v1/pairing/rotate?csrf=${ctx.core.csrfToken}`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(jsonResponse(queryCrossSite, 403, '跨站 + 查询串 token').error.code, 'csrf');
});

test('CSRF：JSON 写操作（cloud/broker、cloud/toggle）缺正确信号必须 403 且不落到业务', async () => {
  const brokerBefore = cloud.broker;
  const rejected = await requestJson(ctx.port, '/api/v1/cloud/broker', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json', origin: 'http://evil.example' }),
    body: JSON.stringify({ broker: 'mqtt://attacker.example:1883' }),
  });
  assert.equal(jsonResponse(rejected, 403, 'JSON 写 + 陌生 Origin').error.code, 'csrf');
  assert.equal(cloud.broker, brokerBefore, '被拒的写操作不能改到 broker');

  const toggle = await requestJson(ctx.port, '/api/v1/cloud/toggle', {
    method: 'POST',
    headers: authed({ 'sec-fetch-site': 'cross-site' }),
  });
  assert.equal(jsonResponse(toggle, 403, 'cloud/toggle 跨站').error.code, 'csrf');
  assert.equal(cloud.enabled, false);
});

test('CSRF：表单回落只认 application/x-www-form-urlencoded + 正确 csrf，且 4096 是硬边界', async () => {
  const formBase = `csrf=${ctx.core.csrfToken}&pad=`;
  const bodyOfSize = (size) => formBase + 'a'.repeat(size - Buffer.byteLength(formBase));

  const formHeaders = {
    'content-type': 'application/x-www-form-urlencoded',
    'sec-fetch-site': 'cross-site',
  };

  const noToken = await request(ctx.port, '/cloud/rotate', {
    method: 'POST', headers: formHeaders, body: 'pad=1',
  });
  assert.equal(jsonResponse(noToken, 403, '表单缺 csrf').error.code, 'csrf');

  const wrongToken = await request(ctx.port, '/cloud/rotate', {
    method: 'POST', headers: formHeaders, body: 'csrf=deadbeefdeadbeefdeadbeefdeadbeef',
  });
  assert.equal(jsonResponse(wrongToken, 403, '表单 csrf 错误').error.code, 'csrf');
  assert.equal(cloud.rotated, 0, '被拒的表单不能触发 rotate');

  const jsonNotForm = await request(ctx.port, '/cloud/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ csrf: ctx.core.csrfToken }),
  });
  assert.equal(jsonResponse(jsonNotForm, 403, 'JSON 冒充表单').error.code, 'csrf');

  const exact = await request(ctx.port, '/cloud/rotate', {
    method: 'POST', headers: formHeaders, body: bodyOfSize(MAX_FORM_BODY),
  });
  assert.equal(exact.status, 303, `正好 ${MAX_FORM_BODY} 字节的表单应放行，实际 ${exact.status}`);
  assert.equal(exact.headers.location, '/pair');
  assert.equal(cloud.rotated, 1);

  const over = await request(ctx.port, '/cloud/rotate', {
    method: 'POST', headers: formHeaders, body: bodyOfSize(MAX_FORM_BODY + 1),
  });
  assert.equal(jsonResponse(over, 403, `超过 ${MAX_FORM_BODY} 字节的表单`).error.code, 'csrf');
  assert.equal(cloud.rotated, 1, '超限表单不能被当成通过');
});

/* ---------------------------------------------------------- 请求体上限 */

test(`请求体上限：${MAX_BODY} 字节的 body 是合法边界，多 1 字节就是 413 body_too_large`, async () => {
  const payloadOfSize = (size) => `{"prompt":"${'a'.repeat(size - 13)}"}`;

  const exact = payloadOfSize(MAX_BODY);
  assert.equal(Buffer.byteLength(exact), MAX_BODY);
  const exactResponse = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: exact,
  });
  // 体积刚好没超，于是进到业务校验：prompt 太长（>20000）。
  const exactBody = jsonResponse(exactResponse, 413, '正好 MAX_BODY');
  assert.equal(exactBody.error.code, 'prompt_too_long', '边界内不该被 body 上限拦下');

  const over = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: payloadOfSize(MAX_BODY + 1),
  });
  const overBody = jsonResponse(over, 413, 'MAX_BODY + 1');
  assert.equal(overBody.error.code, 'body_too_large');
  assert.equal(overBody.error.message, '内容过大');

  const farOver = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: 'x'.repeat(300 * 1024),
  });
  assert.equal(jsonResponse(farOver, 413, '300KiB').error.code, 'body_too_large');

  // 追问路由用同一个 MAX_BODY，错误分支的文案不同（请求格式不正确）。
  const promptOver = await requestJson(ctx.port, '/api/v1/tasks/session-x/prompt', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json' }),
    body: 'x'.repeat(MAX_BODY + 1),
  });
  const promptBody = jsonResponse(promptOver, 413, '追问超限');
  assert.equal(promptBody.error.code, 'body_too_large');
  assert.equal(promptBody.error.message, '请求格式不正确');
});

test(`配对与 broker 的 body 上限分别是 ${MAX_PAIR_BODY} 与 ${MAX_BROKER_BODY} 字节`, async () => {
  const pairOver = await requestJson(ctx.port, '/api/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"code":"${'A'.repeat(MAX_PAIR_BODY)}"}`,
  });
  const pairBody = jsonResponse(pairOver, 413, '配对 body 超限');
  assert.equal(pairBody.error.code, 'body_too_large');
  assert.equal(pairBody.error.message, '请求格式不正确');

  const brokerOver = await requestJson(ctx.port, '/api/v1/cloud/broker', {
    method: 'POST',
    headers: authed({ 'content-type': 'application/json', 'x-pocket-csrf': ctx.core.csrfToken }),
    body: `{"broker":"${'b'.repeat(MAX_BROKER_BODY)}"}`,
  });
  assert.equal(jsonResponse(brokerOver, 413, 'broker body 超限').error.code, 'body_too_large');
  assert.equal(cloud.broker, 'mqtt://broker.before:8083', '超限请求不能改到 broker');
});

/* -------------------------------------------------------- 畸形 JSON / 缺字段 */

test('畸形 JSON 与缺字段：一律 4xx（不是 500），且 code 说得清是哪一类', async () => {
  const cases = [
    ['{"prompt":', 400, 'invalid_json'],
    ['not json at all', 400, 'invalid_json'],
    ['null', 400, 'empty_prompt'],
    ['[]', 400, 'empty_prompt'],
    ['"just a string"', 400, 'empty_prompt'],
    ['{}', 400, 'empty_prompt'],
    ['{"prompt":42}', 400, 'empty_prompt'],
    ['{"prompt":"   "}', 400, 'empty_prompt'],
    [`{"prompt":"${'x'.repeat(20_001)}"}`, 413, 'prompt_too_long'],
  ];
  for (const [body, status, code] of cases) {
    const response = await requestJson(ctx.port, '/api/v1/tasks', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body,
    });
    const parsed = jsonResponse(response, status, `tasks body=${body.slice(0, 24)}`);
    assert.equal(parsed.error.code, code, `body=${body.slice(0, 24)} 的 code 不对：${parsed.error.message}`);
    assert.ok(response.status >= 400 && response.status < 500, '必须是 4xx');
  }

  // 追问路由：空 prompt 的校验发生在任务查找之前，所以未知任务也是 400 而不是 404/500。
  for (const [body, status, code] of [
    ['{}', 400, 'empty_prompt'],
    ['{"prompt":""}', 400, 'empty_prompt'],
    ['{"prompt":', 400, 'invalid_json'],
  ]) {
    const response = await requestJson(ctx.port, '/api/v1/tasks/session-unknown/prompt', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body,
    });
    assert.equal(jsonResponse(response, status, `prompt body=${body}`).error.code, code);
  }

  // 配对：坏 JSON → 400；缺 code / 错 code → 403；都必须是 4xx。
  const badJson = await requestJson(ctx.port, '/api/v1/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":',
  });
  assert.equal(jsonResponse(badJson, 400, '配对坏 JSON').error.code, 'invalid_json');

  for (const body of ['{}', '{"code":"ZZZZ-ZZZZ"}', '{"code":""}']) {
    const response = await requestJson(ctx.port, '/api/v1/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const parsed = jsonResponse(response, 403, `配对 body=${body}`);
    assert.equal(parsed.error.code, 'pairing_invalid');
    assert.equal(parsed.ok, false);
  }
});

/* -------------------------------------------------------------- 限流 */

test('鉴权失败限流：40 次 401 后第 41 次 429，且合法令牌不受影响', async () => {
  const isolated = await startBridge();
  try {
    const validToken = isolated.mint().token;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await request(isolated.port, '/api/v1/me', {
        headers: { authorization: `Bearer dshb_${'x'.repeat(40)}` },
      });
      assert.equal(response.status, 401, `第 ${attempt + 1} 次失败尝试应 401`);
    }
    const limited = await request(isolated.port, '/api/v1/me', {
      headers: { authorization: `Bearer dshb_${'y'.repeat(40)}` },
    });
    const body = jsonResponse(limited, 429, '第 41 次失败尝试');
    assert.equal(body.error.code, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) >= 1, 'retry-after 必须是正整数秒');

    const valid = await request(isolated.port, '/api/v1/me', {
      headers: { authorization: `Bearer ${validToken}` },
    });
    assert.equal(valid.status, 200, '限流只该拦住猜令牌，不能误伤合法令牌');
  } finally {
    await isolated.close();
  }
});

test('配对限流：12 次/10 分钟后第 13 次 429，正确的配对码也不例外', async () => {
  const isolated = await startBridge();
  try {
    const wrong = 'ZZZZ-ZZZZ';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await requestJson(isolated.port, '/api/v1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: wrong }),
      });
      assert.equal(response.status, 403, `第 ${attempt + 1} 次错误配对应 403`);
      assert.equal(response.json.error.code, 'pairing_invalid');
    }
    const limited = await requestJson(isolated.port, '/api/v1/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: isolated.core.state.pairing.code }),
    });
    const body = jsonResponse(limited, 429, '第 13 次配对（码是对的）');
    assert.equal(body.error.code, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal(isolated.core.devicesView().length, 0, '被限流的请求不能顺手配对成功');
  } finally {
    await isolated.close();
  }
});

/* -------------------------------------------------------- 安全头覆盖矩阵 */

test('安全头与 content-type 覆盖所有出口：200/304/401/403/404/405/413/204', async () => {
  const asset = await request(ctx.port, '/app/app.js');
  const cached = await request(ctx.port, '/app/app.js', { headers: { 'if-none-match': asset.headers.etag } });
  assert.equal(cached.status, 304, '这一行不过，下面的 304 样本就不是 304');
  const samples = new Map(Object.entries({
    '200 静态': asset,
    '304 静态': cached,
    401: await request(ctx.port, '/api/v1/me'),
    '403 Host（API）': await request(ctx.port, '/api/v1/health', { headers: { host: 'evil.example' } }),
    '403 Host（页面）': await request(ctx.port, '/pair', { headers: { host: 'evil.example' } }),
    '403 CSRF': await request(ctx.port, '/api/v1/pairing/rotate', { method: 'POST', headers: { origin: 'http://evil.example' } }),
    '403 回环': await request(ctx.port, '/api/v1/pairing', { headers: { 'x-pocket-relay': 'bad' } }),
    '404 API': await request(ctx.port, '/api/v1/nope', { headers: authed() }),
    405: await request(ctx.port, '/api/v1/cloud/rotate', { method: 'GET' }),
    413: await request(ctx.port, '/api/v1/tasks', {
      method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: 'x'.repeat(MAX_BODY + 1),
    }),
    '404 非 API': await request(ctx.port, '/missing-page'),
    '204 OPTIONS': await request(ctx.port, '/api/v1/tasks', { method: 'OPTIONS' }),
  }));
  for (const [label, response] of samples) {
    expectSecurityHeaders(response, label);
  }

  // API 错误一律 JSON；非 API 错误一律纯文本 —— 手机端按 content-type 分流。
  for (const label of ['401', '403 Host（API）', '403 CSRF', '403 回环', '404 API', '405', '413']) {
    const response = samples.get(label);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8', `${label} 应是 JSON`);
    assert.equal(response.headers['cache-control'], 'no-store', `${label} 不能缓存`);
  }
  assert.equal(samples.get('200 静态').headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(samples.get('404 非 API').headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(samples.get('204 OPTIONS').body, '');

  // Host 闸的两种出口：API 给 JSON 错误码，页面给纯文本，都不能带出内部路径。
  assert.equal(JSON.parse(samples.get('403 Host（API）').body).error.code, 'bad_host');
  const forbidden = samples.get('403 Host（页面）');
  assert.equal(forbidden.body, 'Forbidden');
  assert.equal(forbidden.body.includes(ctx.webRoot), false);
  assert.equal(JSON.parse(samples.get('405').body).error.code, 'method');
  assert.equal(samples.get('405').headers.allow, 'POST');
  assert.equal(JSON.parse(samples.get('413').body).error.code, 'body_too_large');
});
