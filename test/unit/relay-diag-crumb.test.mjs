/**
 * RPC 面包屑要能被**人**读到，而且读出去的文本不能带凭据。
 *
 * 背景：桌面侧有 `rx / rpc / replays` 三个计数器，手机侧以前只有一个 `pending`
 * 数字。两边对不上时无从下手 —— "回包丢了"和"我们早就不等了"在手机侧看起来完全
 * 一样。现在外壳给每条在途 RPC 记一条面包屑（见 `remote/remote.js` 的 `openCrumb`），
 * 这段文本把它变成一行可粘贴的话，并且**只**按白名单读字段：
 * 「复制诊断」是要发到聊天窗口里求助的东西。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDiagText, crumbText, diagRows } from '../../web/lib/relay-diag.js';

const NOW = 1_700_000_000_000;
const rowMap = (snapshot) => Object.fromEntries(diagRows(snapshot).map((row) => [row.key, row.value]));

const FAILED = {
  id: 'a1b2c3d4',
  verb: 'GET',
  path: '/api/v1/tasks/abc',
  at: NOW - 15_200,
  tries: 4,
  resends: 1,
  sawRes: false,
  resId: '',
  resBytes: 0,
  resAt: 0,
  end: 'timeout',
  ms: 15_200,
};
const OK = {
  id: 'ff00ff00',
  verb: 'GET',
  path: '/api/v1/tasks',
  at: NOW - 300,
  tries: 1,
  resends: 0,
  sawRes: true,
  resId: 'ff00ff00',
  resBytes: 46_080,
  resAt: NOW - 286,
  end: '',
  ms: 14,
};

test('诊断块要能分清"回包没到"和"我们放弃得太早"', () => {
  const rows = rowMap({ online: true, pending: 2, timeouts: 7, resMiss: 3, now: NOW });
  assert.equal(rows.rpctimeout, '7 次');
  assert.equal(rows.resmiss, '3 次');
  // 缺字段（老外壳 / 局域网布局）时必须是 0，不能显示 undefined。
  const empty = rowMap({ online: true, now: NOW });
  assert.equal(empty.rpctimeout, '0 次');
  assert.equal(empty.resmiss, '0 次');
  assert.equal(empty.partsopen, '0 组');
  assert.equal(empty.partslost, '0 次');
  assert.equal(empty.partsnack, '0 次');
});

test('分片三件套：在途半包 / 没集齐 / 已补片 —— 丢片终于有痕迹', () => {
  const rows = rowMap({ online: true, partsOpen: 2, partsIncomplete: 5, partsNacked: 3, now: NOW });
  assert.equal(rows.partsopen, '2 组');
  assert.equal(rows.partslost, '5 次');
  assert.equal(rows.partsnack, '3 次');
  // 判据：NACK 在涨而没集齐不降 = 对端还不认识 nack（老桌面），得升级电脑端。
  assert.match(buildDiagText({ online: true, partsOpen: 1, partsIncomplete: 4, partsNacked: 6, now: NOW }),
    /已发补片请求：6 次/u);
});

test('面包屑一行话：发了几次、等了多久、有没有回包、多大', () => {
  const timeoutLine = crumbText(FAILED, NOW);
  assert.match(timeoutLine, /^GET \/api\/v1\/tasks\/abc/u);
  assert.match(timeoutLine, /发 4 次（其中重连补发 1 次）/u);
  assert.match(timeoutLine, /15\.2 s/u);
  assert.match(timeoutLine, /没收到回包 · 已判死（超时）/u);
  assert.match(timeoutLine, /#a1b2c3d4$/u, 'request id 要留着：电脑端日志记的是同一个 id');

  const okLine = crumbText(OK, NOW);
  assert.match(okLine, /已收到回包 45 KB/u, '体积按原始字节给（不是 base64 长度）');
  assert.match(okLine, /· 14 ms ·/u, '毫秒级的快响应就按毫秒说，别写成 0.0 s');
  assert.equal(/没收到回包/u.test(okLine), false);

  // 还在路上（end 为空、没收到 res）：文案要说"还在等"，不能冒充失败。
  const pending = crumbText({ ...FAILED, end: '', ms: 2_000 }, NOW);
  assert.match(pending, /还没回包（还在等）/u);
  // 脏输入不许抛：诊断永远不该影响主流程。
  assert.equal(typeof crumbText(null, NOW), 'string');
  assert.equal(typeof crumbText({}, NOW), 'string');
});

test('buildDiagText 带上最近几条 RPC，且顺序是"最新的在后面"', () => {
  const text = buildDiagText({
    online: true,
    pending: 1,
    timeouts: 2,
    resMiss: 0,
    rpcBudget: 15_200,
    crumb: [OK, FAILED],
    now: NOW,
    pwa: false,
    userAgent: 'test-agent',
  });
  assert.match(text, /最近在途 RPC（单条预算 15200 ms）：/u);
  assert.match(text, /GET \/api\/v1\/tasks · 发 1 次/u);
  assert.match(text, /GET \/api\/v1\/tasks\/abc · 发 4 次/u);
  assert.ok(text.indexOf('GET /api/v1/tasks · 发 1 次') < text.indexOf('GET /api/v1/tasks/abc'),
    '最新的那条要排在后面（与环形缓冲的写入顺序一致）');
  assert.match(text, /RPC 超时未回包：2 次/u);
  // 最多只印 5 条：粘贴出去的文本不能变成一堵墙。
  const many = buildDiagText({ online: true, crumb: Array.from({ length: 8 }, (_item, index) => ({ ...OK, path: `/api/v1/p${index}` })), now: NOW });
  assert.equal(many.split('\n').filter((line) => line.includes('/api/v1/p')).length, 5);
});

test('白名单：面包屑里的凭据类字段一个都不许进诊断文本', () => {
  const poisoned = {
    ...FAILED,
    token: 'device-token-should-never-appear',
    room: 'room-should-never-appear',
    key: 'k-should-never-appear',
    r: 'r-should-never-appear',
    t: 't-should-never-appear',
  };
  const text = buildDiagText({
    online: true,
    crumb: [poisoned],
    brokers: ['wss://user:pass@broker.example.com:8084/mqtt?x=1'],
    now: NOW,
    userAgent: 'ua',
  });
  for (const banned of ['device-token-should-never-appear', 'room-should-never-appear',
    'k-should-never-appear', 'r-should-never-appear', 't-should-never-appear',
    'user:pass', '?x=1']) {
    assert.equal(text.includes(banned), false, `诊断文本里不该出现 ${banned}`);
  }
});
