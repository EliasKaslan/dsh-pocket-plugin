/**
 * 静态服务与「非 /api」出口：/app 外壳、/pair 资源、/download、根路径落地页、配对页。
 *
 * 穿越用例都配了「地面真值」：先证明哨兵文件真的存在且内容就是 SECRET，
 * 再去断言响应体里没有它 —— 否则「没读到」这件事本身可能只是因为文件不存在。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  FALLBACK, SECRET, expectSecurityHeaders, request, startBridge,
} from './support/harness.mjs';

let ctx;

before(async () => {
  ctx = await startBridge({
    downloadFiles: {
      'installer.exe': 'MZ-INSTALLER-BODY',
      'nested/tool.zip': 'PK-ZIP-BODY',
    },
  });
});

after(async () => {
  await ctx?.close();
});

/* --------------------------------------------------------------- app 外壳 */

test('/app、/app/、/index.html 都发 index.html，且都是 no-store', async () => {
  for (const target of ['/app', '/app/', '/index.html']) {
    const response = await request(ctx.port, target);
    assert.equal(response.status, 200, `${target} 应 200`);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store', `${target} 是入口，必须 no-store`);
    assert.equal(response.body, await readFile(path.join(ctx.webRoot, 'index.html'), 'utf8'));
    assert.match(String(response.headers.etag), /^"[0-9a-f]+-[0-9a-f]+"$/u);
    expectSecurityHeaders(response, target);
  }
});

test('未知 /app/ 路径回落到 index.html（SPA 路由），而不是 404 或 500', async () => {
  for (const target of ['/app/tasks', '/app/tasks/session-1', '/app/unknown.bin', '/app/pair']) {
    const response = await request(ctx.port, target);
    assert.equal(response.status, 200, `${target} 应回落 200`);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(response.body, new RegExp(FALLBACK, 'u'), `${target} 回落的不是 index.html`);
  }
  // `/app/pair` 是真实存在的目录：fileStat 有值但 isFile() 为假，也必须回落。
  assert.equal((await request(ctx.port, '/app/pair')).status, 200);
});

test('静态文件：Content-Type 与 Cache-Control 按扩展名区分', async () => {
  const cases = [
    ['/app/app.js', 'text/javascript; charset=utf-8', 'no-cache'],
    ['/app/logo.svg', 'image/svg+xml', 'public, max-age=86400'],
    ['/app/app.webmanifest', 'application/manifest+json; charset=utf-8', 'no-cache'],
    ['/pair/pair.css', 'text/css; charset=utf-8', 'no-store'],
    ['/pair/pair.js', 'text/javascript; charset=utf-8', 'no-store'],
  ];
  for (const [target, contentType, cache] of cases) {
    const response = await request(ctx.port, target);
    assert.equal(response.status, 200, `${target} 应 200`);
    assert.equal(response.headers['content-type'], contentType, `${target} 的 content-type`);
    assert.equal(response.headers['cache-control'], cache, `${target} 的 cache-control`);
    expectSecurityHeaders(response, target);
  }
});

test('/pair 下只有 pair.js / pair.css 被映射，其他文件名一律 404', async () => {
  for (const target of ['/pair/other.js', '/pair/pair.css.map', '/pair/../secret.txt']) {
    const response = await request(ctx.port, target);
    assert.equal(response.status, 404, `${target} 应 404`);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.body, 'Not Found');
    assert.equal(response.body.includes(SECRET), false);
    expectSecurityHeaders(response, target);
  }
});

test('favicon：/favicon.ico 与 /favicon.svg 都回落到 favicon.svg', async () => {
  for (const target of ['/favicon.ico', '/favicon.svg']) {
    const response = await request(ctx.port, target);
    assert.equal(response.status, 200, `${target} 应 200`);
    assert.equal(response.headers['content-type'], 'image/svg+xml');
    assert.match(response.body, /^<svg /u);
  }
});

test('不存在的非 API 路径：404 text/plain，不暴露文件系统路径', async () => {
  const response = await request(ctx.port, '/definitely-missing');
  assert.equal(response.status, 404);
  assert.equal(response.body, 'Not Found');
  assert.equal(response.body.includes(ctx.webRoot), false);
  assert.equal(response.body.includes(ctx.root), false);
});

/* ------------------------------------------------------------ HEAD / ETag */

test('HEAD 不回正文但保留 content-length 与安全头', async () => {
  const full = await request(ctx.port, '/app/app.js');
  const head = await request(ctx.port, '/app/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '', 'HEAD 不能有正文');
  assert.equal(head.headers['content-length'], full.headers['content-length']);
  assert.equal(head.headers.etag, full.headers.etag);
  expectSecurityHeaders(head, 'HEAD /app/app.js');

  const download = await request(ctx.port, '/download/installer.exe', { method: 'HEAD' });
  assert.equal(download.status, 200);
  assert.equal(download.body, '');
  assert.equal(download.headers['content-length'], String(Buffer.byteLength('MZ-INSTALLER-BODY')));
});

test('ETag + If-None-Match → 304（GET 与 HEAD 都行），etag 不匹配 → 200 全量', async () => {
  const first = await request(ctx.port, '/app/app.js');
  const etag = first.headers.etag;
  assert.equal(typeof etag, 'string');

  for (const method of ['GET', 'HEAD']) {
    const cached = await request(ctx.port, '/app/app.js', { method, headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304, `${method} 条件请求应 304`);
    assert.equal(cached.body, '', '304 不能有正文');
    assert.equal(cached.headers.etag, etag);
    assert.equal(cached.headers['cache-control'], 'no-cache');
    expectSecurityHeaders(cached, `${method} 304`);
  }

  const stale = await request(ctx.port, '/app/app.js', { headers: { 'if-none-match': '"deadbeef-1"' } });
  assert.equal(stale.status, 200);
  assert.equal(stale.body, await readFile(path.join(ctx.webRoot, 'app.js'), 'utf8'));
});

test('service worker：__POCKET_BUILD__ 被内容哈希替换，两次一致，304/HEAD 都成立', async () => {
  const first = await request(ctx.port, '/app/sw.js');
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(first.headers['cache-control'], 'no-cache', 'worker 必须每次回源');
  assert.equal(first.body.includes('__POCKET_BUILD__'), false, '占位符没被替换，手机会永远停在旧外壳');
  const match = first.body.match(/const BUILD = "([0-9a-f]{16})";/u);
  assert.notEqual(match, null, `构建戳格式不对：${first.body.slice(0, 120)}`);
  assert.equal(first.body.includes(await readFile(path.join(ctx.webRoot, 'sw.js'), 'utf8')), false);

  const second = await request(ctx.port, '/app/sw.js');
  assert.equal(second.headers.etag, first.headers.etag, '同一份 webRoot 的构建戳必须稳定');
  assert.equal(second.body, first.body);
  assert.match(String(first.headers.etag), /^"w-[0-9a-f]{16}"$/u);

  const cached = await request(ctx.port, '/app/sw.js', { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, '');

  const head = await request(ctx.port, '/app/sw.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(first.body)));
});

/* -------------------------------------------------------------- 路径穿越 */

test('路径穿越：编码斜杠/反斜杠/双重编码/NUL 一律回落到 index.html，绝不泄漏 webRoot 外的哨兵', async () => {
  // 地面真值：哨兵真的在、内容真的是 SECRET。否则下面的「没泄漏」毫无意义。
  const sentinel = await readFile(ctx.secretPath, 'utf8');
  assert.equal(sentinel, SECRET);

  const fallbackTargets = [
    '/app/..%2fsecret.txt',
    '/app/..%2f..%2fsecret.txt',
    '/app/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/app/..%5c..%5csecret.txt',
    '/app/%2e%2e%5c%2e%2e%5csecret.txt',
    // 双重编码：pathname 解一次，safeJoin 内部还会再解一次。
    '/app/%252e%252e%252f%252e%252e%252fsecret.txt',
    '/app/x%00.txt',
    '/app/..%2f..%2f..%2fsecret.txt',
  ];
  for (const target of fallbackTargets) {
    const response = await request(ctx.port, target);
    assert.equal(response.body.includes(SECRET), false, `${target} 读到了 webRoot 外的哨兵`);
    assert.equal(response.status, 200, `${target} 应回落 index.html，实际 ${response.status}`);
    assert.match(response.body, new RegExp(FALLBACK, 'u'), `${target} 回落的不是 index.html`);
  }

  // 未编码的 `..` 会被 URL 解析器自己折叠掉，请求走不到 /app/ 分支，于是 404；
  // 结论同样是「拿不到哨兵」。
  for (const target of ['/app/../../secret.txt', '/app/%2e%2e/secret.txt', '/app/a/../../secret.txt']) {
    const response = await request(ctx.port, target);
    assert.equal(response.body.includes(SECRET), false, `${target} 读到了 webRoot 外的哨兵`);
    assert.equal(response.status, 404, `${target} 被解析器归一化后应是 404`);
    assert.equal(response.body.includes('root:'), false, `${target} 读到了 /etc/passwd`);
  }

  // `%2e%2e%2f` 大小写混写也必须被同样的规则挡住。
  const mixed = await request(ctx.port, '/app/%2E%2E%2F%2E%2E%2Fsecret.txt');
  assert.equal(mixed.body.includes(SECRET), false);
  assert.equal(mixed.status, 200);
});

test('/download：存在的文件 200、缺失 404、穿越 400、中继 403', async () => {
  const ok = await request(ctx.port, '/download/installer.exe');
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'MZ-INSTALLER-BODY');
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(ok.headers['cache-control'], 'no-store');

  const zip = await request(ctx.port, '/download/nested/tool.zip');
  assert.equal(zip.status, 200);
  assert.equal(zip.headers['content-type'], 'application/zip');
  // Windows 客户端会把分隔符写成反斜杠，服务端要归一化。
  const backslash = await request(ctx.port, '/download/nested%5Ctool.zip');
  assert.equal(backslash.status, 200);
  assert.equal(backslash.body, 'PK-ZIP-BODY');

  for (const target of ['/download/missing.exe', '/download/', '/download/nested']) {
    const response = await request(ctx.port, target);
    assert.equal(response.status, 404, `${target} 应 404`);
    assert.equal(response.body, '安装包尚未生成');
  }

  for (const target of ['/download/..%2fsecret.txt', '/download/%2e%2e%2fsecret.txt', '/download/a%00b.exe']) {
    const response = await request(ctx.port, target);
    assert.equal(response.status, 400, `${target} 应 400`);
    assert.equal(response.body, 'Bad Request');
    assert.equal(response.body.includes(SECRET), false);
  }

  const viaRelay = await request(ctx.port, '/download/installer.exe', {
    headers: { 'x-pocket-relay': ctx.core.relayNonce },
  });
  assert.equal(viaRelay.status, 403);
  assert.equal(JSON.parse(viaRelay.body).error.code, 'loopback_only');
});

/* ------------------------------------------------- 根路径 / 配对页 / 落地页 */

test('根路径：回环 302 到 /pair；中继请求拿到落地页，且既不含配对码也不给本地入口', async () => {
  const local = await request(ctx.port, '/');
  assert.equal(local.status, 302);
  assert.equal(local.headers.location, '/pair');
  assert.equal(local.body, '');
  expectSecurityHeaders(local, 'GET /（回环）');

  const remote = await request(ctx.port, '/', { headers: { 'x-pocket-relay': ctx.core.relayNonce } });
  assert.equal(remote.status, 200);
  assert.equal(remote.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(remote.body, /请在电脑上完成配对/u);
  // v2 起手机没有本地入口：落地页不能再给 /app 链接，只能指向中继。
  assert.equal(remote.body.includes('href="/app"'), false, '落地页不该再提供本地入口');
  assert.match(remote.body, /中继/u, '落地页必须指向中继这条唯一通路');
  assert.equal(remote.body.includes(ctx.core.state.pairing.code), false, '落地页泄漏了配对码');
  assert.equal(remote.body.includes(ctx.core.csrfToken), false, '落地页泄漏了 CSRF token');
});

test('配对页：回环 200 且给账号+口令指引（不再显示配对码）/ CSRF meta；中继 403 落地页', async () => {
  const page = await request(ctx.port, '/pair');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-store', '配对页不能被缓存');
  // v2.1 起凭据统一成「账号 + 口令」：配对码不再出现在页面上，
  // 手机登录成功时桌面端自动发设备令牌。
  assert.equal(page.body.includes(ctx.core.state.pairing.code), false, '配对码不该再显示在页面上');
  assert.match(page.body, /口令/u, '配对页必须告诉用户手机端用什么登录');
  assert.equal(page.body.includes(`<meta name="pocket-csrf" content="${ctx.core.csrfToken}">`), true);
  assert.match(page.body, /还没有配对设备/u);
  assert.match(page.body, /远程访问已停止/u, 'auth.required=true 且无凭据时必须给出「缺少口令」横幅');
  assert.match(page.body, /远程访问已暂停/u);
  expectSecurityHeaders(page, 'GET /pair');

  const code = ctx.core.state.pairing.code;
  const blocked = await request(ctx.port, '/pair', { headers: { 'x-pocket-relay': ctx.core.relayNonce } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(blocked.body, /配对页仅限电脑本机访问/u);
  assert.equal(blocked.body.includes(code), false, '被拒的配对页仍泄漏了配对码');
  assert.equal(blocked.body.includes(ctx.core.csrfToken), false);
  assert.ok(
    ctx.logs.some((line) => line.includes('pairing page blocked (relay)')),
    `拒绝必须留日志，实际：${ctx.logs.slice(-5).join(' | ')}`,
  );
});

test('配对页会列出已配对设备（名称/平台/地址/移除按钮）', async () => {
  const minted = ctx.mint({ name: '客厅平板', platform: 'harmonyos', appVersion: '2.3.4' });
  const page = await request(ctx.port, '/pair');
  assert.equal(page.status, 200);
  assert.equal(page.body.includes('还没有配对设备'), false, '有设备时不该再显示空态');
  assert.equal(page.body.includes('客厅平板'), true);
  assert.equal(page.body.includes('harmonyos'), true);
  assert.equal(page.body.includes('v2.3.4'), true);
  assert.equal(page.body.includes(`data-revoke="${minted.device.id}"`), true);
  assert.equal(page.body.includes('待吊销手机'), false);
});
