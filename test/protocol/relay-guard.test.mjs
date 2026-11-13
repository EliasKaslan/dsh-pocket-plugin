/**
 * 中继白名单与重放闸（lib/cloud.mjs 的纯函数/纯状态部分）。
 *
 * 这两层是「手机能远程用 API」和「手机不能拿中继当跳板进管理面」的分界线：
 * classifyRelayTarget 决定哪些路径能过中继，checkFreshness 决定录下来的帧还能不能用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_PROTOCOL, STALE_WINDOW_MS, classifyRelayTarget } from '../../lib/cloud.mjs';
import { makeLink } from '../_support/envelope.mjs';

test('classifyRelayTarget 放行手机 UI 真正需要的路由', () => {
  assert.deepEqual(classifyRelayTarget('/api/v1/health', 'GET'),
    { ok: true, path: '/api/v1/health', route: 'health' });
  assert.deepEqual(classifyRelayTarget('/api/v1/tasks?limit=5', 'GET'),
    { ok: true, path: '/api/v1/tasks?limit=5', route: 'tasks.list' });
  assert.equal(classifyRelayTarget('/api/v1/tasks', 'POST').route, 'tasks.list');
  assert.equal(classifyRelayTarget('/api/v1/tasks/task_1/prompt', 'POST').route, 'tasks.prompt');
  assert.equal(classifyRelayTarget('/api/v1/tasks/task_1/cancel', 'POST').route, 'tasks.cancel');
  assert.equal(classifyRelayTarget('/api/v1/ws-ticket', 'POST').route, 'ws-ticket');
  assert.equal(classifyRelayTarget('/ws', 'GET').route, 'ws');
  // HEAD 视为 GET 的一种（探活/缓存走 HEAD 是常态）。
  assert.equal(classifyRelayTarget('/api/v1/me', 'HEAD').route, 'me');
});

test('配对页 / 配对接口 / 设备管理 / 中继管理都不许过中继', () => {
  // `pairing` / `pair` 这两条路由已经从桥接里删掉了（配对码不复存在），但拒绝
  // 清单仍然保留它们作为纵深防御：手机方向永远不该能碰到"发凭据"这类路径。
  const denied = [
    ['/pair', 'pair-page'],
    ['/pair/pair.js', 'pair-page'],
    ['/api/v1/pairing', 'pairing'],
    ['/api/v1/pairing/rotate', 'pairing'],
    ['/api/v1/pair', 'pair'],
    ['/api/v1/devices', 'devices'],
    ['/api/v1/devices/dev_1/revoke', 'devices'],
    ['/cloud/status', 'cloud-admin'],
    ['/cloud/rotate', 'cloud-admin'],
    ['/healthz', 'healthz'],
    ['/download/app.apk', 'download'],
  ];
  for (const [target, code] of denied) {
    const result = classifyRelayTarget(target, 'POST');
    assert.equal(result.ok, false, `${target} 不该被放行`);
    assert.equal(result.status, 403, `${target} 的状态码`);
    assert.equal(result.code, code, `${target} 的拒绝原因`);
  }
  // 未列在白名单里的路径：默认拒绝，且不泄漏「存在/不存在」的区别。
  assert.deepEqual(classifyRelayTarget('/api/v1/admin', 'GET'), { ok: false, status: 403, code: 'not-allowed' });
  assert.deepEqual(classifyRelayTarget('/', 'GET'), { ok: false, status: 403, code: 'not-allowed' });
});

test('路径归一化先于放行判断：../ 走私与绝对形式都过不去', () => {
  // URL 解析会折叠 dot segment：注意一个 `..` 只弹一层，
  // `/api/v1/../pair` 归一化后是 `/api/pair`（不是 `/pair`），照样不在白名单里。
  assert.equal(classifyRelayTarget('/api/v1/../pair', 'GET').code, 'not-allowed');
  // 弹两层的 `/api/v1/../../pair` 归一化后才是 `/pair`，必须按配对页拒。
  assert.equal(classifyRelayTarget('/api/v1/../../pair', 'GET').code, 'pair-page');
  assert.equal(classifyRelayTarget('/api/v1/tasks/../../../cloud/status', 'GET').code, 'cloud-admin');
  // 绝对形式与协议相对形式会换掉 host，一律按坏路径拒。
  assert.deepEqual(classifyRelayTarget('http://evil.example/api/v1/health', 'GET'),
    { ok: false, status: 400, code: 'bad-path' });
  assert.equal(classifyRelayTarget('//evil.example/api/v1/health', 'GET').code, 'bad-path');
  // 控制字符、反斜杠、空路径。
  assert.equal(classifyRelayTarget('/api/v1/health\u0000x', 'GET').code, 'bad-path');
  assert.equal(classifyRelayTarget('/api\\v1\\health', 'GET').code, 'bad-path');
  assert.equal(classifyRelayTarget('', 'GET').code, 'bad-path');
  assert.equal(classifyRelayTarget(undefined, 'GET').code, 'bad-path');
  // 超长 query 用 414，而不是把 URL 拼进 fetch。
  const longQuery = `/api/v1/tasks?q=${'x'.repeat(3000)}`;
  assert.deepEqual(classifyRelayTarget(longQuery, 'GET'), { ok: false, status: 414, code: 'query-too-long' });
});

test('方法不允许时回 405，并说明是哪个路由', () => {
  assert.deepEqual(classifyRelayTarget('/api/v1/health', 'POST'),
    { ok: false, status: 405, code: 'method-not-allowed', route: 'health' });
  assert.equal(classifyRelayTarget('/api/v1/ws-ticket', 'GET').status, 405);
  assert.equal(classifyRelayTarget('/ws', 'POST').status, 405);
});

test('重放闸：STALE_WINDOW_MS 之外的 ts 一律 stale', () => {
  const { link } = makeLink();
  assert.equal(STALE_WINDOW_MS, 120_000);
  const now = Date.now();
  const sid = 'a1b2c3d4';

  assert.deepEqual(link.checkFreshness('req', { seq: 1, ts: now, sid }), { ok: true });
  // 注意：闸门比的是**检查那一刻**的 Date.now()（cloud.mjs:779），测试里没法把
  // now 钉死。所以不能断言「正好 WINDOW+1 就 stale」—— 只要检查晚 1ms 执行，
  // 未来方向的那个差值就从 WINDOW+1 掉回 WINDOW，断言会随机翻成 pass/fail
  // （CI 上真翻过一次）。这里只钉「明显超出窗口」与「明显在窗口内」。
  assert.equal(link.checkFreshness('req', { seq: 2, ts: now - STALE_WINDOW_MS - 60_000, sid }).code, 'bad-ts', '过去方向超窗');
  assert.equal(link.checkFreshness('req', { seq: 3, ts: now + STALE_WINDOW_MS + 60_000, sid }).code, 'bad-ts', '未来方向超窗');
  // 窗口内留足余量，避免「跑得慢」把一条本该通过的断言拖成 stale。
  assert.equal(link.checkFreshness('req', { seq: 4, ts: now - STALE_WINDOW_MS / 2, sid }).ok, true, '窗口内应放行');
  // 非法 seq / 非法 sid / 超窗 ts / 重放各有独立 code，而不是「放行后崩溃」。
  assert.equal(link.checkFreshness('req', { seq: 0, ts: now, sid }).code, 'bad-seq');
  assert.equal(link.checkFreshness('req', { seq: 1.5, ts: now, sid }).code, 'bad-seq');
  assert.equal(link.checkFreshness('req', { seq: 5, ts: 'now', sid }).code, 'bad-ts');
  assert.equal(link.checkFreshness('req', { seq: 5, ts: now }).code, 'bad-sid');
  assert.equal(link.checkFreshness('req', { seq: 5, ts: now, sid: 'ABCDEF' }).code, 'bad-sid');
});

test('同一个 sid 内 seq 必须严格递增；换 sid 可以从小 seq 重新开始', () => {
  const { link } = makeLink();
  const now = Date.now();
  assert.equal(link.checkFreshness('req', { seq: 7, ts: now, sid: 'aaaaaaaa' }).ok, true);
  assert.equal(link.checkFreshness('req', { seq: 7, ts: now, sid: 'aaaaaaaa' }).code, 'replay', '重放同一 seq');
  // 契约变更（v1.1.11）：新鲜的低 seq 视为客户端计数器重置 ⇒ 自愈放行（否则旧外壳永久卡死）。
  // 同 seq 的即时重放仍然拒绝（上一行），重放防护没有被削弱。
  assert.equal(link.checkFreshness('req', { seq: 6, ts: now, sid: 'aaaaaaaa' }).ok, true, '新鲜回退 seq 自愈');
  // 再变更（1.0.1 安全修复）：自愈**不再下调水位**。旧实现把水位从 7 拉到 6，于是已经执行过的
  // seq=7 可以再来一次——攻击者只要先重放一条 seq≤64 的旧帧把水位压低，就能按升序重放整段录制
  // 窗口，无需密钥。现在水位单调不减，且每个低 seq 只自愈放行一次。
  assert.equal(link.checkFreshness('req', { seq: 6, ts: now, sid: 'aaaaaaaa' }).code, 'replay', '同一个低 seq 只自愈一次');
  assert.equal(link.checkFreshness('req', { seq: 7, ts: now, sid: 'aaaaaaaa' }).code, 'replay', '水位没被下调：已执行的 seq=7 不能再执行一次');
  // "自愈"要保住的其实是这件事：计数器继续往前递增不能被卡死。
  assert.equal(link.checkFreshness('req', { seq: 8, ts: now, sid: 'aaaaaaaa' }).ok, true, '高于水位的新 seq 照常放行');
  // 重新加载页面 = 新 sid，seq 从 1 开始是合法的。
  assert.equal(link.checkFreshness('req', { seq: 1, ts: now, sid: 'bbbbbbbb' }).ok, true);
  // 不同类型的帧各自一条 seq 序列。
  assert.equal(link.checkFreshness('ws.open', { seq: 1, ts: now, sid: 'aaaaaaaa' }).ok, true);
});

test('登录预算：每分钟只放行 LOGIN_BUDGET 次 scrypt 校验', () => {
  const { link } = makeLink();
  const now = Date.now();
  const results = [];
  for (let index = 0; index < 12; index += 1) results.push(link.loginAllowed(now));

  const allowed = results.filter((entry) => entry.ok).length;
  // LOGIN_BUDGET 没有导出（见交付说明），这里用行为把 10 这个数值钉住。
  assert.equal(allowed, 10, '预算内的前 10 次放行');
  assert.equal(results[10].ok, false);
  assert.ok(results[10].retryAfterSec > 0, '限流时要告诉调用方还要等多久');
  assert.equal(results[11].ok, false);

  // 窗口过去之后重新放行。
  assert.equal(link.loginAllowed(now + 60_001).ok, true);
  assert.equal(CLOUD_PROTOCOL, 2, '这层重放/预算属于中继 v2 协议');
});

test('提问回答路由必须能经中继（否则手机端提交得到 403）', () => {
  // 手机端提交回答走的就是这条；本地桥有路由但中继漏放行过一次真实故障。
  const ok = classifyRelayTarget('/api/v1/tasks/session-abc123/answer', 'POST');
  assert.equal(ok.ok, true, 'POST /answer 应在中继白名单内');
  assert.equal(String(ok.route?.name ?? ok.route), 'tasks.answer');

  // 只允许 POST：GET 不能变成写操作。
  const wrong = classifyRelayTarget('/api/v1/tasks/session-abc123/answer', 'GET');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'method-not-allowed');

  // 设备管理这条仍然必须被拒（白名单不能因为新增路由而放宽）。
  assert.equal(classifyRelayTarget('/api/v1/devices', 'GET').ok, false);
});
