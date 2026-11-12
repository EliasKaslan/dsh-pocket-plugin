/**
 * 大响应的中继行为 —— 这次手机端「点开会话内容加载不出来，然后连接中断」的
 * 直接原因候选。
 *
 * 中继的发帧预算是 `MAX_FRAME × MAX_FRAME_TOTAL`（64 KiB × 64 = 4 MiB）。
 * 以前超过预算时 `publish()` 只记一条 warn 就返回 false，**一个字节都不发**：
 * 手机端只能等满 RPC 超时（16 s × 4 次），界面显示「连接中断」，
 * 而真正的原因（响应太大）永远送不到用户眼前。
 *
 * 现在：超预算就回一个明确的 413 JSON；没超预算则正常分片。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_FRAME } from '../../lib/cloud.mjs';
import {
  decodeAll, makeLink, makeLogger, stubFetch,
} from './_support/fixtures.mjs';

/** 造一份 base64 体积约为 `bytes` 的响应。 */
function responseOf(id, bytes) {
  return {
    t: 'res',
    id,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    enc: '',
    body: Buffer.alloc(Math.ceil(bytes / 3) * 4, 0x79).toString('base64'),
    ms: 12,
  };
}

test('超过分片预算：回 413 + 明确原因，绝不静默', () => {
  const logger = makeLogger();
  const { link, sent } = makeLink({ allowAnonymous: true, logger });

  // 5 MiB 明文 → 超出 4 MiB 预算。
  link.respond('big-1', responseOf('big-1', 5 * 1024 * 1024));

  // 关键：必须**有**东西发出去，而且只有一条（不是几十片）。
  assert.equal(sent.length, 1, `超预算时只能发一条兜底响应，实际发了 ${sent.length} 条`);

  const reply = decodeAll(link, sent)[0];
  assert.equal(reply.t, 'res');
  assert.equal(reply.id, 'big-1', 'id 必须原样回显，手机端靠它对上请求');
  assert.equal(reply.status, 413, '必须是 413，不能是 200');
  assert.equal(reply.enc, '', '兜底响应不压缩');

  const body = JSON.parse(Buffer.from(reply.body, 'base64').toString('utf8'));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'response_too_large');
  assert.match(body.error.message, /太大|超过/u, '要给用户看得懂的原因');
  assert.ok(logger.lines.some((line) => line.includes('warn') && line.includes('413')), '必须留一条 warn');
});

test('刚好在预算内的大响应：正常分片，不报错', () => {
  const logger = makeLogger();
  const { link, sent } = makeLink({ allowAnonymous: true, logger });

  // 约 1 MiB 明文：必须分片，但远在预算内。
  const bytes = 1024 * 1024;
  link.respond('big-2', responseOf('big-2', bytes));

  assert.ok(sent.length > 1, '超过单帧必须分片');
  const frames = decodeAll(link, sent);
  assert.ok(frames.every((frame) => frame.t === 'part'), '分片的每一帧都应是 part');
  assert.ok(frames.every((frame) => frame.id === frames[0].id), '同一批分片共用一个 chunk id');
  assert.equal(frames[0].total, sent.length, 'total 必须与实际片数一致');

  // 拼回去应当还原成原始响应。
  const merged = frames
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((frame) => Buffer.from(frame.d, 'base64'))
    .reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0));
  const reply = JSON.parse(merged.toString('utf8'));
  assert.equal(reply.t, 'res');
  assert.equal(reply.status, 200);
  assert.equal(reply.body, responseOf('big-2', bytes).body, '拼回的 body 必须逐字符一致');
  assert.ok(frames.reduce((sum, frame) => sum + frame.d.length, 0) > 0);
});

test('分片大小不超过 MAX_FRAME，且片数与内容长度匹配', () => {
  const { link, sent } = makeLink({ allowAnonymous: true });
  const bytes = 400 * 1024;
  link.respond('big-3', responseOf('big-3', bytes));

  const frames = decodeAll(link, sent);
  const plainBytesEach = frames.map((frame) => Buffer.byteLength(JSON.stringify({
    t: 'part', id: frame.id, seq: frame.seq, total: frame.total, d: frame.d,
  }), 'utf8'));
  // 明文分片本体（base64 部分）解码后不应超过 MAX_FRAME。
  for (const frame of frames) {
    assert.ok(Buffer.from(frame.d, 'base64').length <= MAX_FRAME, '单片明文不得超过 MAX_FRAME');
  }
  assert.ok(plainBytesEach.every((size) => size < MAX_FRAME * 2), '分片帧本身也不该无限大');
});

test('走完整请求路径：详情不能被压缩（gzip:false 的手机）时，超预算必须回 413', async () => {
  const logger = makeLogger();
  const { link, sent } = makeLink({ allowAnonymous: true, logger });
  // 真实场景：手机端没有 DecompressionStream 时 `remote.js` 会带 gzip:false，
  // 于是详情以明文过中继 —— 这正是最容易撞上 4 MiB 分片预算的路径。
  const big = 'z'.repeat(5 * 1024 * 1024);
  const stub = stubFetch(JSON.stringify({ ok: true, data: { messages: [big] } }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  try {
    await link.handleRequest({
      id: 'detail-1', method: 'GET', path: '/api/v1/tasks/task_abc', gzip: false,
    });
  } finally {
    stub.restore();
  }

  assert.equal(sent.length, 1, '超预算时不该发出半截分片');
  const reply = decodeAll(link, sent)[0];
  assert.equal(reply.status, 413);
  assert.equal(reply.id, 'detail-1');
  const body = JSON.parse(Buffer.from(reply.body, 'base64').toString('utf8'));
  assert.equal(body.error.code, 'response_too_large');

  // 诊断日志必须留下这次详情的真实体量，否则下次还是只能猜。
  assert.ok(logger.lines.some((line) => line.includes('详情响应')), '详情请求必须留一条体积日志');
});

test('同样的体积，能压缩时就正常送达（说明 gzip 是重要缓冲）', async () => {
  const { link, sent } = makeLink({ allowAnonymous: true });
  // 内容高度重复 → gzip 后很小 → 应当正常送达，而不是 413。
  const big = 'z'.repeat(5 * 1024 * 1024);
  const stub = stubFetch(JSON.stringify({ ok: true, data: { messages: [big] } }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  try {
    await link.handleRequest({ id: 'detail-2', method: 'GET', path: '/api/v1/tasks/task_abc' });
  } finally {
    stub.restore();
  }

  // 压缩后可能是一整帧（不超 MAX_FRAME），也可能仍然分片；两种都必须能还原。
  const frames = decodeAll(link, sent);
  let reply;
  if (frames.every((frame) => frame.t === 'part')) {
    const merged = frames
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((frame) => Buffer.from(frame.d, 'base64'))
      .reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0));
    reply = JSON.parse(merged.toString('utf8'));
  } else {
    assert.equal(frames.length, 1, '不分片时应当只有一帧');
    reply = frames[0];
  }
  assert.equal(reply.status, 200, '能压缩时不该回 413');
  assert.equal(reply.enc, 'gzip', '这种体量必须压缩后再发');
});
