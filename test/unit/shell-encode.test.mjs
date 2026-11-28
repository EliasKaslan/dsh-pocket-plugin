/**
 * C8（前半）：`b64()` 必须**按块**转码，而不是逐字节拼接。
 *
 * 旧实现是 `for (…) text += String.fromCharCode(view[index])`：71 KB 的上行请求体
 * 就是 72 704 次字符串拼接 + 72 704 次单字符 `fromCharCode`（探针在手机端实测
 * 10.1 ms，而同体积的 `unb64` 只要 0.17 ms；桌面 V8 因为 cons string 只慢 2~3 倍，
 * 但机制一样，换到 WebKit 就是实打实的卡顿）。这条路径每次上行（含大 POST）都跑。
 *
 * 为什么不拿毫秒做门禁：同一台机器上两种实现的耗时只差 2~3 倍（0.41 ms vs
 * 0.16 ms），毫秒门禁会退化成抖动门禁 —— 而且"这机器快"并不能证明手机上快。
 * 真正能**变红**的判据是机制：一条 71 KB 的请求体只许几十次拼接，不许几万次。
 * 于是在 vm 沙箱里把 `String.fromCharCode` 换成记账版本，直接数它被调用了几次、
 * 每次拿了几个参数。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readRepoFile, runSlices, sliceConst, sliceFunction } from '../support/shell-source.mjs';

const SOURCE = readRepoFile('remote/remote.js');

/** 切出生产源码里的 `b64()`，并给沙箱里的 `String.fromCharCode` 装一个计数器。 */
function loadB64() {
  const slices = runSlices({
    declarations: [
      { name: 'B64_CHUNK_BYTES', source: sliceConst(SOURCE, 'B64_CHUNK_BYTES') },
      { name: 'b64', source: sliceFunction(SOURCE, 'b64') },
    ],
    prologue: `globalThis.__calls = [];
      (() => {
        const original = String.fromCharCode;
        String.fromCharCode = (...args) => {
          globalThis.__calls.push(args.length);
          return original.apply(String, args);
        };
      })();`,
  });
  return { b64: slices.b64, calls: () => slices.__context.__calls };
}

test('C8：71 KB 的请求体只许几十次拼接（旧实现逐字节 = 72 704 次 fromCharCode）', () => {
  const { b64, calls } = loadB64();
  const size = 71 * 1024;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31) & 0xff;

  const encoded = b64(bytes);
  assert.deepEqual(Buffer.from(encoded, 'base64'), Buffer.from(bytes), '转出来的字节必须逐字节相同');

  const made = calls();
  assert.equal(made.reduce((sum, count) => sum + count, 0), size, '每个字节都必须被转一次');
  assert.ok(made.length <= 32,
    `71 KB 只许几十次拼接：实际 ${made.length} 次（旧实现是 ${size} 次 —— 手机端 10.1 ms 就是它）`);
  assert.ok(made.every((count) => count <= 64 * 1024),
    '单次 apply 的参数个数必须在引擎上限内（8 KB 分块正是为此）');
});

test('C8：分块边界不许丢字节（空 / 一块整 / 一块多 1 字节 / 跨块的非 8 KB 倍数）', () => {
  const { b64 } = loadB64();
  for (const length of [0, 1, 8 * 1024, 8 * 1024 + 1, 65 * 1024 + 7, 71 * 1024 - 3]) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = index & 0xff;
    assert.deepEqual(Buffer.from(b64(bytes), 'base64'), Buffer.from(bytes), `${length} 字节的边界长度`);
  }
  // 非 Uint8Array 输入也要能吃（`b64()` 里那一行 `new Uint8Array(bytes)` 不是装饰）。
  assert.equal(b64([104, 105]), Buffer.from('hi').toString('base64'));
});
