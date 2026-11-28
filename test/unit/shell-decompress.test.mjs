/**
 * 大响应解压：**逐字节等价** + **不再经过 Blob / Response**（少两次整缓冲搬运）。
 *
 * 背景：手机端真正让界面"顿一下"的是收包之后这一段（与网络无关）。旧实现是
 *
 *     new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
 *     new Response(stream).arrayBuffer()
 *
 * 同一份数据要搬三遍（gzip 字节拷进 Blob → Blob 流出 chunk → arrayBuffer 再拼一块），
 * 而解压本身只需要"写进去、读出来"。探针（Node 24，三档载荷 15 次中位）显示这三次
 * 搬运是解压阶段的主要开销：2 KB 档 0.31 ms → 0.15 ms，58 KB 档 0.88 ms → 0.77 ms，
 * 且 2 KB 的固定开销几乎全是它。
 *
 * 所以这里钉两件事：
 *   1. **行为等价**：解压结果与原始字节 sha256 完全相同（三档载荷 + 多 chunk 拼接）；
 *   2. **结构约束**：`Blob` / `Response` 在解压路径上**一次都不许出现**（下面注入的
 *      假实现会直接抛错）—— 谁把旧实现改回来，这两条会立刻变红。
 *
 * 走 `sliceFunction()` 从 `remote/remote.js` 切生产代码，不复制实现。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  readRepoFile, runSlices, sliceConst, sliceFunction,
} from '../support/shell-source.mjs';

const SOURCE = readRepoFile('remote/remote.js');
const sha256 = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/**
 * 在 vm 里跑生产源码切出来的 `decompressGzip()`。
 * `globals` 用来替换 `DecompressionStream`（超时 / 坏字节 / chunk 形状都要可控）。
 */
function loadDecompress(globals = {}) {
  return runSlices({
    declarations: [
      { name: 'DECOMPRESS_TIMEOUT_MS', source: sliceConst(SOURCE, 'DECOMPRESS_TIMEOUT_MS') },
      { name: 'decompressGzip', source: sliceFunction(SOURCE, 'decompressGzip') },
    ],
    globals: { DecompressionStream, ...globals },
  });
}

/** 可控的 `DecompressionStream` 替身：能按顺序吐 chunk、能永久卡住、能让读端报错。 */
function controllableStream({ chunks = null, stall = false, failure = null }) {
  const queue = Array.isArray(chunks) ? [...chunks] : null;
  const state = { cancelled: 0, written: [], closed: 0 };
  const reader = {
    read() {
      if (stall) return new Promise(() => {});
      if (failure !== null) return Promise.reject(failure);
      const next = queue.shift();
      if (next === undefined) return Promise.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: false, value: next });
    },
    async cancel() {
      state.cancelled += 1;
    },
  };
  const writer = {
    write(value) {
      state.written.push(value);
      return Promise.resolve();
    },
    close() {
      state.closed += 1;
      return Promise.resolve();
    },
  };
  return {
    state,
    factory: class {
      constructor(format) {
        this.format = format;
        return { readable: { getReader: () => reader }, writable: { getWriter: () => writer } };
      }
    },
  };
}

/** 三档载荷：2 / 45 / 58 KB（gzip 后），正文是中文会话详情。 */
function payloadForGzipSize(targetGzip) {
  const build = (count) => {
    const messages = [];
    for (let index = 0; index < count; index += 1) {
      messages.push({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `第 ${index} 条：这次会话的详情要整理一下，重点看工具调用与报错。`.repeat(3),
        at: 1_760_000_000_000 + index * 137,
      });
    }
    return Buffer.from(JSON.stringify({ ok: true, data: { id: 'sess-decompress', messages } }), 'utf8');
  };
  let lo = 1;
  let hi = 2;
  while (gzipSync(build(hi)).length < targetGzip) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (gzipSync(build(mid)).length >= targetGzip) hi = mid;
    else lo = mid + 1;
  }
  const plain = build(lo);
  return { plain, gzip: gzipSync(plain) };
}

/* --------------------- 1) 行为等价：逐字节相同 --------------------- */

test('解压结果必须逐字节等于原始字节（2 KB / 45 KB / 58 KB，sha256 断言）', async () => {
  const { decompressGzip } = loadDecompress();
  for (const target of [2 * 1024, 45 * 1024, 58 * 1024]) {
    const { plain, gzip } = payloadForGzipSize(target);
    const out = await decompressGzip(new Uint8Array(gzip), 5_000);
    // 注意：`out` 是 vm 沙箱里的 Uint8Array（跨 realm，`instanceof` 不成立），
    // 所以用类型标签断言，比不了原型就比字节。
    assert.equal(Object.prototype.toString.call(out), '[object Uint8Array]', '解压必须返回 Uint8Array');
    assert.equal(out.length, plain.length, `${target} 档：解压后长度必须一致`);
    assert.equal(sha256(out), sha256(plain), `${target} 档：解压后字节必须逐字节相同`);
  }
});

test('多 chunk 输出必须按顺序拼成活字节（只有这时才允许一次拼接）', async () => {
  const whole = Buffer.from('{"ok":true,"data":{"id":"concat"}}', 'utf8');
  const fake = controllableStream({
    chunks: [new Uint8Array(whole.subarray(0, 10)), new Uint8Array(whole.subarray(10, 27)), new Uint8Array(whole.subarray(27))],
  });
  const { decompressGzip } = loadDecompress({ DecompressionStream: fake.factory });
  const out = await decompressGzip(new Uint8Array([1, 2, 3]), 2_000);
  assert.equal(sha256(out), sha256(whole));
  assert.deepEqual(fake.state.written.map((item) => item.length), [3], '写端只该收到一次写入（不切片）');
  assert.equal(fake.state.closed, 1, '写完必须 close，否则解压流不会 flush 出尾部');
});

test('单 chunk 输出必须零拷贝返回（不为了"统一形状"再拼一块）', async () => {
  const chunk = new Uint8Array([0x7b, 0x7d]);
  const fake = controllableStream({ chunks: [chunk] });
  const { decompressGzip } = loadDecompress({ DecompressionStream: fake.factory });
  const out = await decompressGzip(new Uint8Array([9]), 2_000);
  assert.equal(out, chunk, '只有一个 chunk 时必须原样返回它，不能多拷一份');
});

/* ------------------- 2) 结构约束：Blob / Response 不许出现 ------------------- */

test('解压路径不许再建 Blob 或 Response（那是同一份数据的两次整缓冲搬运）', async () => {
  const forbidden = {
    Blob: class {
      constructor() {
        throw new Error('decompressGzip 不该再建 Blob：gzip 字节会被整份拷进 Blob');
      }
    },
    Response: class {
      constructor() {
        throw new Error('decompressGzip 不该再建 Response：Body 要再经过一次流中转');
      }
    },
  };
  const { decompressGzip } = loadDecompress(forbidden);
  const { plain, gzip } = payloadForGzipSize(45 * 1024);
  const out = await decompressGzip(new Uint8Array(gzip), 5_000);
  assert.equal(sha256(out), sha256(plain), '不许建 Blob/Response 的同时，结果必须仍然正确');
});

/* ------------------------- 3) 超时 / 坏字节的收场 ------------------------- */

test('解压流卡住时必须超时收场，并取消底层流（否则界面永久停在「加载中…」）', async () => {
  const fake = controllableStream({ stall: true });
  const { decompressGzip } = loadDecompress({ DecompressionStream: fake.factory });
  const startedAt = Date.now();
  let caught = null;
  try {
    await decompressGzip(new Uint8Array([1, 2, 3]), 150);
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(caught !== null, '卡住的解压必须抛错，不能无限挂起');
  assert.equal(caught.pocketCode, 'decompress');
  assert.match(String(caught.message), /解压超时/u);
  assert.ok(elapsed < 2_000, `超时判定必须贴着传入的窗口（实际 ${elapsed}ms）`);
  assert.equal(fake.state.cancelled, 1, '超时后必须 cancel reader，否则解压流与已解出的缓冲永远不释放');
});

test('坏字节：归类成 decompress（不许被当成"连不上"）且同样释放底层流', async () => {
  // ① 真实截断的 gzip（分片丢半截的真实故障形态）
  const { decompressGzip } = loadDecompress();
  const { gzip } = payloadForGzipSize(45 * 1024);
  let caught = null;
  try {
    await decompressGzip(new Uint8Array(gzip.subarray(0, Math.max(4, gzip.length - 8))), 3_000);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, '截断的 gzip 必须报错');
  assert.equal(caught.pocketCode, 'decompress', 'net.js 据此才不换新 id 把整份响应重拉一遍');

  // ② 读端报错：必须 cancel，且原始失败原因保留在 message 里
  const fake = controllableStream({ failure: new Error('incorrect header check') });
  const loaded = loadDecompress({ DecompressionStream: fake.factory });
  caught = null;
  try {
    await loaded.decompressGzip(new Uint8Array([9, 9, 9]), 3_000);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.pocketCode, 'decompress');
  assert.match(String(caught?.message), /incorrect header check/u, '原始失败原因不能被吞掉');
  assert.equal(fake.state.cancelled, 1, '解压失败的路径也要释放底层流');
});
