/**
 * 首屏 detail 里顺带下发的**一次性实时票**（`wsTicket`）。
 *
 * 要省掉的那次往返：手机端建隧道 = `POST /api/v1/ws-ticket` + `/ws` 升级，两次串行
 * 往返（单向 300 ms 下实测 648 + 632 ms）。打开会话本来就要发这条 detail，把票挂在
 * 它的应答里，客户端就不必再单独换一次票 —— 首屏这次「进入实时」少一次往返。
 *
 * 但票是**凭据**，所以这个文件同时钉住它的安全边界（一个字都不许放宽）：
 *   - 只在**首屏**（既无 `?before=` 也无 `?after=`）下发；翻历史/追增量不带；
 *   - 仍然是 `core.createWsTicket()` 签发的短时效（60 s）票；
 *   - 仍然**一次性**：同一张票第二次拿去升级必须 401；
 *   - 仍然**设备绑定**：票里记的就是这条 detail 的鉴权设备；
 *   - 分页契约字段一个都没动（`before`/`after`/`cursorLost`/`hasMore`/`nextBefore`）。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  jsonResponse, request, requestJson, startBridge, wsHandshake,
} from './support/harness.mjs';

let ctx;
let token;
let taskId;

before(async () => {
  ctx = await startBridge();
  const minted = ctx.mint({ name: '票据契约手机', platform: 'test' });
  token = minted.token;
  const created = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '首屏票契约', cwd: ctx.workRoot }),
  });
  taskId = jsonResponse(created, 201, 'POST /api/v1/tasks').data.task.id;
});

after(async () => {
  await ctx?.close();
});

const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const detail = (query = '') => requestJson(ctx.port, `/api/v1/tasks/${encodeURIComponent(taskId)}${query}`, { headers: authed() });

/* ------------------------------------------------------- 首屏带票 ---------- */

test('首屏 detail 的应答里带一张 60 s 内有效的一次性票（增量的新字段，没改名没删字段）', async () => {
  const response = await detail();
  const body = jsonResponse(response, 200, 'GET /api/v1/tasks/:id');
  const data = body.data;
  // 分页契约字段一个都不许少（这次只加 wsTicket）。
  for (const key of ['task', 'messages', 'total', 'offset', 'hasMore', 'nextBefore', 'cursorLost', 'degraded', 'truncated']) {
    assert.ok(key in data, `首屏 detail 少了既有字段 ${key}`);
  }
  assert.ok(data.wsTicket !== null && typeof data.wsTicket === 'object', '首屏 detail 必须带 wsTicket');
  assert.deepEqual(Object.keys(data.wsTicket).sort(), ['expiresAt', 'ticket'], 'wsTicket 只该有 ticket/expiresAt');
  assert.match(data.wsTicket.ticket, /^wst_[A-Za-z0-9_-]+$/u);
  // 短时效：与 POST /ws-ticket 同一本账（core.createWsTicket 的 60 s）。
  const left = Number(data.wsTicket.expiresAt) - Date.now();
  assert.ok(left > 0 && left <= 60_000, `票的有效期该在 (0, 60000] ms 内，实际 ${left} ms`);
});

test('首屏那张票能升级 /ws（真握手、真 hello），再拿它升一次必须是 401（一次性）', async () => {
  const { data } = jsonResponse(await detail(), 200, 'GET /api/v1/tasks/:id');
  const first = await wsHandshake(ctx.port, `/ws?ticket=${encodeURIComponent(data.wsTicket.ticket)}`);
  assert.equal(first.status, 101, '首屏票必须能升级成功');
  assert.equal(first.messages[0]?.type, 'hello', '升级后第一条应当是 hello');
  try { first.socket.terminate(); } catch { /* 已断 */ }

  const second = await wsHandshake(ctx.port, `/ws?ticket=${encodeURIComponent(data.wsTicket.ticket)}`);
  assert.equal(second.status, 401, '同一张票第二次必须被拒（一次性，消费即删）');
  assert.equal(second.messages.length, 0);
});

test('票是设备绑定的：另一台设备拿不到、也换不掉这张票（鉴权闸没放宽）', async () => {
  const { data } = jsonResponse(await detail(), 200, 'GET /api/v1/tasks/:id');
  const ticket = data.wsTicket.ticket;
  // 票本身不含设备信息（只是随机 id），但它记的是**签发时那台设备**：
  // 另一台设备的令牌看不见这张票，也就无法伪造一张同名的。
  const other = ctx.mint({ name: '另一台手机', platform: 'test' });
  const listed = await requestJson(ctx.port, '/api/v1/me', { headers: { authorization: `Bearer ${other.token}` } });
  assert.equal(jsonResponse(listed, 200, 'GET /api/v1/me').data.device.id, other.device.id);
  assert.equal(JSON.stringify(listed.body ?? listed).includes(ticket), false, '别的设备的应答里不该出现这张票');

  // 未鉴权的 detail 直接 401：票不会跟着无鉴权的请求漏出去。
  const anonymous = await request(ctx.port, `/api/v1/tasks/${encodeURIComponent(taskId)}`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.includes('wst_'), false, '401 的应答里不许出现票');
});

/* --------------------------------------------------- 其余页面不带票 --------- */

test('增量（?after=）与翻历史（?before=）都不带票：票据只在首屏那一页', async () => {
  // 假宿主没有真实事件流，转录为空 —— 这里要的只是"这条路由的应答里没有票"，
  // 游标用任意合法字符集即可（服务端对找不到的游标走 reset/cursorLost 分支）。
  const cursor = 'm-does-not-exist';

  const incremental = jsonResponse(await detail(`?after=${encodeURIComponent(cursor)}`), 200, '?after=');
  assert.deepEqual(
    Object.keys(incremental.data).sort(),
    ['hasMoreAfter', 'messages', 'reset', 'total'],
    '增量应答的契约只有四个字段（[?after=] 的形状不许被新字段污染）',
  );
  assert.equal(incremental.data.wsTicket, undefined, '增量不许带票');

  const older = jsonResponse(await detail(`?before=${encodeURIComponent(cursor)}&limit=5`), 200, '?before=');
  assert.equal(older.data.wsTicket, undefined, '翻历史页不许带票（高频小请求，没必要每页签票）');
  assert.ok('hasMore' in older.data && 'nextBefore' in older.data, '翻页契约字段仍在');
});

test('POST /api/v1/ws-ticket 照旧可用（老客户端/回退路径没被改坏）', async () => {
  const body = jsonResponse(
    await requestJson(ctx.port, '/api/v1/ws-ticket', { method: 'POST', headers: authed() }),
    200,
    'POST /api/v1/ws-ticket',
  );
  assert.match(body.data.ticket, /^wst_/u);
  assert.ok(Number(body.data.expiresAt) > Date.now());
  const handshake = await wsHandshake(ctx.port, `/ws?ticket=${encodeURIComponent(body.data.ticket)}`);
  assert.equal(handshake.status, 101);
  try { handshake.socket.terminate(); } catch { /* 已断 */ }
});

test('票不跟着 404 / 错误游标漏出去', async () => {
  const missing = await requestJson(
    ctx.port,
    '/api/v1/tasks/session-00000000-0000-0000-0000-000000000000',
    { headers: authed() },
  );
  assert.equal(jsonResponse(missing, 404, '不存在的会话').ok, false);
  assert.equal(missing.body.includes('wst_'), false);

  const badCursor = await requestJson(ctx.port, `/api/v1/tasks/${encodeURIComponent(taskId)}?after=${encodeURIComponent('非法 游标')}`, { headers: authed() });
  assert.equal(jsonResponse(badCursor, 400, '非法游标').ok, false);
  assert.equal(badCursor.body.includes('wst_'), false);
});
