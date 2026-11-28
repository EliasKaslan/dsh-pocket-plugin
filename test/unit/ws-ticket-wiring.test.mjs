/**
 * 「票随首屏下发 + 预热」这条链的**接线门禁**。
 *
 * 为什么需要它：收益靠三处配合才成立 ——
 *   1. 服务端在首屏 detail 里塞票（`lib/server.mjs` 签发、`lib/task-index.mjs` 组装）；
 *   2. 客户端把票收进缓存（`web/app.js` 的 `loadDetail`）；
 *   3. 建隧道时从缓存取票、隧道打开后**后台**补下一张（`web/lib/net.js`）。
 * 少接任何一处，功能不会报错，只会静默退回"每次现取"—— 那正是这次要省掉的那次
 * 往返。行为测试（`ws-ticket.test.mjs` / `ws-ticket-realtime.test.mjs` /
 * `detail-ws-ticket.test.mjs` / `open-session-rtt.test.mjs`）只覆盖其中每一段，
 * 断链子这种事只能靠这一条接线检查兜住。改坏任一处 → 本文件红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

/** 取某个函数/方法的源码片段（从 `header` 起，到下一个顶层 `}` 为止）。 */
function slice(source, header, { from = 0 } = {}) {
  const at = source.indexOf(header, from);
  assert.notEqual(at, -1, `源码里找不到 ${header}`);
  return source.slice(at, at + 4000);
}

test('app.js：缓存实例、开机预热、detail 收票、退登清票四处都接上了', () => {
  const app = read('web/app.js');
  assert.match(app, /import \{[^}]*WsTicketCache[^}]*\} from '\.\/lib\/net\.js';/u, 'app.js 必须从 net.js 取 WsTicketCache');
  assert.match(
    app,
    /new WsTicketCache\(\{\s*fetchTicket: \(\) => api\('\/api\/v1\/ws-ticket', \{ method: 'POST' \}\),?\s*\}\)/u,
    '缓存必须用真的 POST /api/v1/ws-ticket 取票',
  );
  // 建隧道时把缓存交进去（tickets 选项），否则 net.js 会退回每次现取。
  const realtimeOptions = slice(app, 'realtime = new Realtime({');
  assert.match(realtimeOptions, /^\s*tickets,$/mu, 'Realtime 的选项里必须传 tickets（否则又变成每次现取）');
  // 开机预热：与首屏 detail 并发，不额外占往返。
  const startRealtime = slice(app, 'function startRealtime() {');
  assert.match(startRealtime, /tickets\.start\(\);/u, 'startRealtime 必须先重新启用缓存');
  assert.match(startRealtime, /void tickets\.prewarm\(\);/u, 'startRealtime 必须预热一张票');
  // 首屏 detail 里下发的票直接收进缓存。
  const loadDetail = slice(app, 'async function loadDetail(id, { silent = false } = {}) {');
  assert.match(loadDetail, /tickets\.offer\(data\?\.wsTicket\);/u, 'loadDetail 必须把 detail 里的 wsTicket 收进缓存');
  // 退登要把还没用掉的票一起丢掉。
  const signOut = slice(app, 'function signOut() {');
  assert.match(signOut, /tickets\.stop\(\);/u, 'signOut 必须清掉缓存里的票');
});

test('net.js：建隧道从缓存取票，打开成功后在后台补下一张', () => {
  const net = read('web/lib/net.js');
  const reserve = slice(net, 'async reserveTicket() {');
  assert.match(reserve, /this\.tickets\.take\(\)/u, 'reserveTicket 必须优先向缓存要票');
  assert.match(reserve, /this\.api\('\/api\/v1\/ws-ticket'/u, '没有缓存时必须回退到现取（行为不变）');
  const onopen = slice(net, 'socket.onopen = () => {');
  assert.match(onopen, /void this\.tickets\?\.prewarm\?\.\(\);/u, '隧道一打开就要在后台补下一张票');
  // 一次性：出票即从缓存删除，同一张票不许发第二次。
  const takeOnce = slice(net, 'async #takeOnce() {');
  assert.match(takeOnce, /this\.#current = null;/u, 'take() 必须把票从缓存里删掉（一次性）');
});

test('task-index/server：票只在首屏那一页下发，且仍然由 createWsTicket 签发', () => {
  const server = read('lib/server.mjs');
  const route = slice(server, "const taskRoute = route.match(");
  assert.match(route, /createWsTicket\(device\)/u, '首屏票必须由 core.createWsTicket(鉴权设备) 签发');
  assert.match(route, /const firstPage = before\.length === 0 && after\.length === 0;/u, '只给首屏签票');
  assert.match(route, /firstPage \? \(\) => this\.core\.createWsTicket\(device\) : null/u, '签票要 lazy：读失败/404 不白签');
  assert.match(route, /wsTicket \}\)/u, '票要交给 index.detail() 一起组装');

  const index = read('lib/task-index.mjs');
  assert.match(index, /export function wsTicketPayload\(/u, 'task-index 负责把票收成对外形状');
  const detail = slice(index, 'async detail(id, { before = \'\', after = \'\', limit = 0, wsTicket = null } = {}) {');
  assert.match(detail, /after\.length > 0/u, '增量模式一律不带票');
  assert.match(detail, /wsTicketPayload\(typeof wsTicket === 'function' \? wsTicket\(\) : wsTicket\)/u, 'thunk 与对象两种形态都要接住');
});
