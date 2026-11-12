/**
 * 安全性质 2：重放闸（lib/cloud.mjs 的 `checkFreshness` + `dispatch`）。
 *
 * 公网 broker 上的任何一条帧都可能被人录下来再放一遍。所以 `req` / `ws.open`
 * 必须同时满足：`seq` 在同一 `sid`+类型内严格递增、`ts` 在 STALE_WINDOW_MS 内、
 * `sid` 形状合法；任何一条不满足都要回 `{t:'reject', code:'<对应原因>'}` 且**不执行**
 * 请求。这里是端到端地测：帧真的被封成密文喂进 `onFrame()`，不是直接调纯函数。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STALE_WINDOW_MS } from '../../lib/cloud.mjs';
import { decodeAll, feed, frameFor, makeLink, stubFetch, waitFor } from './_support/fixtures.mjs';

const SID = 'a1b2c3d4';

function resFrames(link, sent) {
  return decodeAll(link, sent).filter((message) => message.t === 'res');
}
function rejectFrames(link, sent) {
  return decodeAll(link, sent).filter((message) => message.t === 'reject');
}
function req(overrides = {}) {
  return {
    t: 'req',
    id: 'req-under-test',
    seq: 1,
    ts: Date.now(),
    sid: SID,
    path: '/api/v1/health',
    method: 'GET',
    ...overrides,
  };
}

test('合法帧通过（正例）：seq/ts/sid 齐备的 req 真的被转发并回 res', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":true}');
  try {
    feed(link, req({ id: 'req-ok', seq: 1 }));
    assert.equal(stub.calls.length, 1, '合法帧必须被转发，而不是在闸门处被拦');
    assert.equal(stub.calls[0].url, 'http://127.0.0.1:47801/api/v1/health');

    assert.ok(await waitFor(() => resFrames(link, sent).length === 1));
    const [response] = resFrames(link, sent);
    assert.equal(response.id, 'req-ok');
    assert.equal(response.status, 200);
    assert.equal(link.stats.stale, 0);
    assert.equal(rejectFrames(link, sent).length, 0);
  } finally {
    stub.restore();
  }
});

test('重复 seq（同 sid 同类型）→ 拒绝且不执行第二次', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    const now = Date.now();
    feed(link, req({ id: 'first', seq: 5, ts: now }));
    assert.ok(await waitFor(() => resFrames(link, sent).length === 1));
    const fetchesAfterFirst = stub.calls.length;
    assert.equal(fetchesAfterFirst, 1);

    // 同一 seq 再来一次（新 id）：这是录放，不是重试。
    feed(link, req({ id: 'replayed', seq: 5, ts: now }));
    assert.equal(stub.calls.length, fetchesAfterFirst, '被拒的帧不能再打到本机 API');
    const rejects = rejectFrames(link, sent);
    assert.equal(rejects.length, 1, '过期帧必须得到显式的 reject 帧');
    assert.equal(rejects[0].id, 'replayed', 'reject 要带上 id，手机才知道是哪条重试');
    assert.equal(rejects[0].code, 'replay');
    assert.equal(link.stats.stale, 1);
  } finally {
    stub.restore();
  }
});

test('seq 不递增（归零 / 负数 / 小数 / 缺失）→ 全部拒绝；新鲜的低 seq 触发水位自愈', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    const now = Date.now();
    assert.equal(link.checkFreshness('req', { seq: 9, ts: now, sid: SID }).ok, true);

    // 形状非法一律拒（这些不是"计数器重置"，是真错误）。
    for (const [label, seq] of [['归零', 0], ['负数', -1], ['小数', 2.5], ['缺失', undefined]]) {
      const before = stub.calls.length;
      feed(link, req({ id: `bad-seq-${label}`, seq, ts: now }));
      assert.equal(stub.calls.length, before, `seq=${label} 不该被执行`);
      assert.ok(
        rejectFrames(link, sent).some((message) => message.id === `bad-seq-${label}`),
        `seq=${label} 没有回 reject`,
      );
    }
    assert.equal(link.stats.stale, 4);

    // 契约变更：**新鲜**的低 seq 视为客户端计数器重置，自愈放行（否则旧外壳永久卡死）。
    const beforeHeal = stub.calls.length;
    feed(link, req({ id: 'heal-low-seq', seq: 8, ts: now }));
    assert.ok(stub.calls.length > beforeHeal, '新鲜低 seq 应被放行');
    assert.equal(link.lastSeq.get(`req:${SID}`)?.seq, 8, '水位应重置到 8');
  } finally {
    stub.restore();
  }
});

test('同一份密文原样再放一遍 → 拒绝', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    const frame = frameFor(link, JSON.stringify(req({ id: 'recorded', seq: 3, ts: Date.now() })));
    link.onFrame(frame);
    assert.ok(await waitFor(() => resFrames(link, sent).length === 1));
    const before = stub.calls.length;

    link.onFrame(frame); // 逐字节重放
    assert.equal(stub.calls.length, before);
    assert.equal(rejectFrames(link, sent).length, 1);
    assert.equal(link.stats.stale, 1);
  } finally {
    stub.restore();
  }
});

test('ts 超出 STALE_WINDOW_MS（过去与未来）→ 拒绝且不执行', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    assert.equal(STALE_WINDOW_MS, 120_000);
    const now = Date.now();
    for (const [label, ts] of [
      ['过去', now - STALE_WINDOW_MS - 60_000],
      ['未来', now + STALE_WINDOW_MS + 60_000],
    ]) {
      feed(link, req({ id: `stale-${label}`, seq: 1, ts, sid: `${label === '过去' ? 'aaaa' : 'bbbb'}1111` }));
      assert.equal(stub.calls.length, 0, `ts ${label} 超窗的帧被执行了`);
      assert.ok(rejectFrames(link, sent).some((message) => message.id === `stale-${label}`));
    }
    // 窗口内的（留一半余量）必须放行：证明拒的是「过期」而不是「有 ts 就拒」。
    feed(link, req({ id: 'in-window', seq: 1, ts: now - STALE_WINDOW_MS / 2, sid: 'cccc1111' }));
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('ts 非数字（字符串 / undefined / NaN / 对象）→ 拒绝', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    const values = [['字符串', 'now'], ['缺失', undefined], ['NaN', Number.NaN], ['对象', {}]];
    for (const [label, ts] of values) {
      feed(link, req({ id: `bad-ts-${label}`, seq: 1, ts, sid: 'dddd1111' }));
      assert.equal(stub.calls.length, 0, `ts=${label} 被执行了`);
    }
    assert.equal(rejectFrames(link, sent).length, values.length);
    assert.equal(link.stats.stale, values.length);
  } finally {
    stub.restore();
  }
});

test('sid 缺失 / 形状非法（太短、非 hex、数字）→ 拒绝', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    const now = Date.now();
    const values = [['缺失', undefined], ['太短', 'abc'], ['非hex', 'ZZZZZZZZ'], ['数字', 12345678], ['太长', 'a'.repeat(40)]];
    for (const [label, sid] of values) {
      feed(link, req({ id: `bad-sid-${label}`, seq: 1, ts: now, sid }));
      assert.equal(stub.calls.length, 0, `sid=${label} 被执行了`);
    }
    assert.equal(rejectFrames(link, sent).length, values.length);
  } finally {
    stub.restore();
  }
});

test('换 sid = 新的一页：seq 可以重新从 1 开始；但换 sid 不能绕过 ts 窗口', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    const now = Date.now();
    feed(link, req({ id: 'page-1', seq: 10, ts: now, sid: 'aaaaaaaa' }));
    assert.equal(stub.calls.length, 1);
    // 新页面加载：新 sid，seq 从 1 开始，ts 新鲜 → 放行。
    feed(link, req({ id: 'page-2', seq: 1, ts: now, sid: 'bbbbbbbb' }));
    assert.equal(stub.calls.length, 2, '换 sid 后 seq 重置是设计允许的');
    // 但新 sid 也救不了过期的 ts。
    feed(link, req({ id: 'page-3', seq: 1, ts: now - STALE_WINDOW_MS - 1, sid: 'cccccccc' }));
    assert.equal(stub.calls.length, 2, '换 sid 不能绕过 ts 窗口');
    assert.ok(rejectFrames(link, sent).some((message) => message.id === 'page-3'));
  } finally {
    stub.restore();
  }
});

test('ws.open 不受 seq 重放闸限制（否则 ack 被丢，隧道永远开不起来）', async () => {
  const { link, sent } = makeLink();
  const now = Date.now();
  // path 不是 /ws：handleSocketOpen 会回 ws.error('bad path')，不会 new WebSocket。
  const frame = (overrides) => ({
    t: 'ws.open', id: 'ab12cd34', seq: 1, ts: now, sid: SID, path: '/api/v1/health', ...overrides,
  });
  feed(link, frame({}));
  const messages = decodeAll(link, sent);
  assert.ok(messages.some((message) => message.t === 'ws.error' && message.message === 'bad path'));
  assert.equal(link.sockets.size, 0, '不该有真实 WS 被创建');

  // 同一个 seq 再来一次：**不再判重放**。ws.open 由令牌授权、按隧道 id 幂等，
  // 拦它没有安全收益，却会把 ack 丢掉，导致前端反复重开隧道（实测 1~8 秒一次）。
  const before = sent.length;
  feed(link, frame({}));
  const rejects = decodeAll(link, sent).slice(before).filter((message) => message.t === 'reject');
  assert.equal(rejects.length, 0, 'ws.open 不该因 seq 重放被拒');

  // 时间戳与 sid 仍然校验：这两条才是真正防重放的判据。
  assert.equal(link.checkFreshness('ws.open', { seq: 9, ts: now - 600_000, sid: SID }).code, 'bad-ts');
  assert.equal(link.checkFreshness('ws.open', { seq: 9, ts: now, sid: 'nope' }).code, 'bad-sid');

  // 水位只增不减：低 seq 不能把 ws.open 的水位拉回去。
  const key = `ws.open:${SID}`;
  assert.equal(link.lastSeq.get(key)?.seq, 1, '低 seq 的放行不得降低水位');

  // req 的 seq 序列与 ws.open 互不影响：req seq=1 仍然有效。
  assert.equal(link.checkFreshness('req', { seq: 1, ts: now, sid: SID }).ok, true);
});

test('幂等缓存：同 id 的合法重试不会二次执行，直接回缓存', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch('{"ok":true,"n":1}');
  try {
    feed(link, req({ id: 'same-id', seq: 1 }));
    assert.ok(await waitFor(() => resFrames(link, sent).length === 1));
    assert.equal(stub.calls.length, 1);

    // 合法重试：新 seq、新 ts、同 id。
    feed(link, req({ id: 'same-id', seq: 2, ts: Date.now() }));
    assert.equal(stub.calls.length, 1, '同 id 的重试不能重复产生副作用');
    assert.equal(link.stats.replays, 1);
    const responses = resFrames(link, sent);
    assert.equal(responses.length, 2, '重试也必须拿到回复（否则手机会一直重试）');
    assert.equal(responses[1].id, 'same-id');
    assert.equal(responses[0].body, responses[1].body);
  } finally {
    stub.restore();
  }
});

test('新鲜帧 + 大幅回退 seq ⇒ 水位自愈；即时重放与陈旧帧仍然拒绝', () => {
  const { link } = makeLink();
  const sid = '0a1b2c3d';
  const now = Date.now();
  // 把水位打到 100
  assert.equal(link.checkFreshness('req', { seq: 100, ts: now, sid }).ok, true);
  // 计数器被重置（seq 回到 5）且时间戳新鲜 ⇒ 自愈放行，水位重置到 5
  assert.equal(link.checkFreshness('req', { seq: 5, ts: now, sid }).ok, true, '大幅回退 + 新鲜帧应自愈');
  assert.equal(link.checkFreshness('req', { seq: 6, ts: now, sid }).ok, true, '自愈后应能继续递增');
  // 同一 seq 的即时重放仍然拒绝（这才是重放防护要挡的）
  assert.equal(link.checkFreshness('req', { seq: 6, ts: now, sid }).code, 'replay', '同一 seq 仍判重放');
  // 陈旧帧仍然拒绝
  assert.equal(link.checkFreshness('req', { seq: 3, ts: now - 60_000, sid }).ok, false);
});
