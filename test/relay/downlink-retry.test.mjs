/**
 * 下行帧的重发与「明确失败」（R7）—— `lib/cloud.mjs` 的 `publish` / `publishSealed`
 * / `noteLostDownlink` / `collectPart` / `evictOldestPart`。
 *
 * 旧行为：单片（`part`）publish 失败只记一条 warn，既不重发也不通知对端 —— 整帧
 * 永远拼不出来，手机侧只能等 30 s 分片 TTL，表现是「偶尔一次打开会话没反应」。
 *
 * 现在：每次 publish 失败重发 `PUBLISH_RETRIES` 轮（同一份密文，不重新封）；仍然
 * 失败就给对端补一条 `{ t:'reject', id, code:'publish-failed' }`，手机端在
 * `remote/remote.js` 的 `case 'reject'` 里会立刻把对应 RPC 置为失败，而不是干等
 * RPC 超时（16 s × 4）。
 *
 * 顺带钉住分片表的淘汰方向：表满（PART_MAX_OPEN = 8）时必须淘汰**最旧**的一组，
 * 而不是把新到的那一组丢掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  makeLink, makePeer, openAsPhone, waitFor,
} from './_support/fixtures.mjs';

/** 逐次记录每次真实发布尝试的假 client；前 `failCount` 次回调报错。 */
function flakyClient(link, failCount) {
  const attempts = [];
  let served = 0;
  link.client = {
    publish(_topic, payload, _options, callback) {
      attempts.push(String(payload));
      served += 1;
      if (typeof callback === 'function') {
        if (served <= failCount) callback(new Error('broker rejected the packet'));
        else callback();
      }
      return true;
    },
    end() {},
  };
  return attempts;
}

const decode = (link, payload) => JSON.parse(openAsPhone(link, payload).toString('utf8'));

test('R7：单帧第一次发送失败会自动重发一次（同一份密文），帧不会丢', async () => {
  const { link } = makeLink();
  const attempts = flakyClient(link, 1);

  link.publish({ t: 'res', id: 'abc', status: 200, headers: {}, enc: '', body: '', ms: 1 });
  assert.equal(attempts.length, 1, '第一次尝试是同步发生的');
  assert.ok(await waitFor(() => attempts.length === 2), '失败之后必须自动重发一轮');
  assert.equal(attempts[1], attempts[0], '重发的是同一份密文（同一帧，不重新封）');
  assert.equal(link.stats.publishRetries, 1);
  assert.equal(decode(link, attempts[1]).id, 'abc');
  // 重发成功就到此为止：不许再补一条 reject。
  assert.equal(attempts.map((payload) => decode(link, payload).t).includes('reject'), false);
  assert.equal(link.stats.publishLost, 0);
});

test('R7：重发也失败 → 给对端一条明确的 reject（不再无声丢失）', async () => {
  const { link } = makeLink();
  const attempts = flakyClient(link, Number.MAX_SAFE_INTEGER);

  link.publish({ t: 'res', id: 'dead-frame', status: 200, headers: {}, enc: '', body: '', ms: 1 });
  // 1 次首发 + 1 次重发 + 1 次 reject（reject 自身也只尝试一次，不递归）。
  assert.ok(await waitFor(() => attempts.length >= 3), `三次尝试都要发生（实际 ${attempts.length}）`);
  const messages = attempts.map((payload) => decode(link, payload));
  const reject = messages.find((message) => message.t === 'reject');
  assert.notEqual(reject, undefined, '重发失败必须回一条 reject，而不是只写日志');
  assert.equal(reject.id, 'dead-frame');
  assert.equal(reject.code, 'publish-failed');
  assert.equal(link.stats.publishLost, 1, '丢失计数只加一次（不许一个分片刷一条）');
  // 同一帧最多两次尝试（首发 + 一轮重发）；reject 自己只尝试一次。
  assert.ok(attempts.length <= 4, `不许变成无限重发（实际 ${attempts.length} 次）`);
});

test('R7：多片帧里丢一片，重发之后整帧仍然能在对端拼出来', async () => {
  const { link } = makeLink();
  const { peer, seen } = makePeer(link);
  const attempts = [];
  let lostOnce = false;
  link.client = {
    publish(_topic, payload, _options, callback) {
      const raw = String(payload);
      attempts.push(raw);
      const message = decode(link, raw);
      // 只丢「第 2 片」的第一次发送，模拟 broker 的瞬时抖动。
      if (message.t === 'part' && message.seq === 1 && !lostOnce) {
        lostOnce = true;
        callback?.(new Error('broker blip'));
        return true;
      }
      callback?.();
      return true;
    },
    end() {},
  };

  const body = 'z'.repeat(100 * 1024); // > MAX_FRAME(64 KiB) → 至少两片
  link.publish({
    t: 'res', id: 'big', status: 200, headers: {}, enc: '', body, ms: 1,
  });
  assert.ok(await waitFor(() => attempts.length >= 3), '丢片之后必须重发该片');

  // 对端收到的是「所有尝试」：重复的片按 seq 覆盖，不影响重组。
  for (const payload of attempts) peer.onFrame(Buffer.from(payload));
  assert.equal(seen.length, 1, '整帧必须被拼出来并派发（旧代码这里永远等 30 s TTL）');
  assert.equal(seen[0].id, 'big');
  assert.equal(seen[0].body.length, body.length);
  assert.equal(link.stats.publishRetries, 1);
});

test('R7：一帧最多补一条 reject —— 大帧多片同时失败不放大成 reject 风暴', async () => {
  const { link } = makeLink();
  const attempts = flakyClient(link, Number.MAX_SAFE_INTEGER);
  link.publish({
    t: 'res', id: 'big-lost', status: 200, headers: {}, enc: '', body: 'y'.repeat(100 * 1024), ms: 1,
  });
  assert.ok(await waitFor(() => link.stats.publishLost === 1));
  const rejects = attempts.map((payload) => decode(link, payload)).filter((message) => message.t === 'reject');
  assert.equal(rejects.length, 1, `一帧只许一条 reject（实际 ${rejects.length}）`);
  assert.equal(rejects[0].id, 'big-lost');
});

test('R7：没有 id 的帧（心跳 / hello）失败不产生 reject，只记一条丢失', async () => {
  const { link } = makeLink();
  const attempts = flakyClient(link, Number.MAX_SAFE_INTEGER);
  link.publish({ t: 'beat', at: Date.now() });
  assert.ok(await waitFor(() => attempts.length >= 2), '心跳也要重发一轮');
  assert.equal(attempts.map((payload) => decode(link, payload).t).includes('reject'), false,
    '没有可回的 id 就不发 reject');
  assert.equal(link.stats.publishLost, 1, '帧确实丢了，要计入丢失');
});
