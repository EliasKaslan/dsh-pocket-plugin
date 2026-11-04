/**
 * 纯函数工具（lib/util.mjs）：HTML 转义、路径穿越防护、常量时间比较、原子写。
 * 这些都在请求路径上，最贵的两个 bug 是「转义漏一个字符」和「safeJoin 放行 ..」。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  atomicWriteJson, escapeHtml, randomHex, redactUrl, safeEqual, safeJoin,
} from '../../lib/util.mjs';

test('escapeHtml 覆盖 & < > " 和单引号五个字符', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  // 典型 XSS 载荷：单引号必须也被转义，否则属性里能逃逸。
  assert.equal(escapeHtml(`' onmouseover='alert(1)`), '&#39; onmouseover=&#39;alert(1)');
  // 不能二次转义失败（& 先被换成 &amp;，后续不会再被当成 & 处理）。
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('safeJoin 拒绝 ../ 穿越与绝对路径', () => {
  const root = path.resolve(tmpdir(), 'dsh-pocket-safejoin-root');
  assert.equal(safeJoin(root, '../etc/passwd'), undefined);
  assert.equal(safeJoin(root, '../../secret.txt'), undefined);
  assert.equal(safeJoin(root, '..'), undefined);
  assert.equal(safeJoin(root, '..\\..\\windows\\win.ini'), undefined, '反斜杠也是分隔符');
  // 盘符路径是个平台相关的坑：safeJoin 会先把 \ 归一成 /（util.mjs:287），
  // 于是 win32 上 'C:/...' 仍是绝对路径 → 必须拒；POSIX 上它只是"根内一个带
  // 冒号的文件名"，落进根里是安全的。这里只钉平台真正保证的结论。
  const driveAbs = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  const driveOut = safeJoin(root, driveAbs);
  if (process.platform === 'win32') {
    assert.equal(driveOut, undefined, '盘符路径在 win32 上是绝对路径，必须拒');
  } else {
    assert.ok(driveOut !== undefined && driveOut.startsWith(`${root}${path.sep}`), `POSIX 上必须被关在根内：${driveOut}`);
  }
  assert.equal(safeJoin(root, '/etc/passwd'), path.join(root, 'etc', 'passwd'), '前导 / 被当作根内相对路径');
  // 平台无关的硬不变量：不管输入长什么样，结果要么被拒（undefined），要么必须落在根内。
  for (const probe of ['/etc/passwd', 'C:\\Windows\\win.ini', '../x', '..\\x', 'a/../../x', '/..\\/x']) {
    const out = safeJoin(root, probe);
    assert.ok(out === undefined || out === root || out.startsWith(`${root}${path.sep}`), `逃出了根：${probe} -> ${out}`);
  }
  // 同名前缀的兄弟目录不能被当成根内路径（prefix 攻击）。
  assert.equal(safeJoin(root, '../dsh-pocket-safejoin-root-evil/x.txt'), undefined);
});

test('safeJoin 拒绝编码穿越、NUL 与畸形百分号编码', () => {
  const root = path.resolve(tmpdir(), 'dsh-pocket-safejoin-root');
  assert.equal(safeJoin(root, '%2e%2e%2f%2e%2e%2fetc%2fpasswd'), undefined, '编码后的 ../ 也必须拒');
  assert.equal(safeJoin(root, '..%2fsecret.txt'), undefined);
  assert.equal(safeJoin(root, 'a%00b.txt'), undefined, 'NUL 截断必须拒');
  assert.equal(safeJoin(root, '%zz'), undefined, '畸形编码是客户端错误，返回 undefined 而不是抛');
});

test('safeJoin 放行根目录内的普通路径', () => {
  const root = path.resolve(tmpdir(), 'dsh-pocket-safejoin-root');
  assert.equal(safeJoin(root, 'index.html'), path.join(root, 'index.html'));
  assert.equal(safeJoin(root, 'a/b/c.js'), path.join(root, 'a', 'b', 'c.js'));
  assert.equal(safeJoin(root, './a/b.js'), path.join(root, 'a', 'b.js'));
  assert.equal(safeJoin(root, 'a/./b/../c.js'), path.join(root, 'a', 'c.js'), '根内的 .. 允许规范化');
  // 空路径返回根本身（调用方还要自己判断是不是文件），这里钉住这个约定。
  assert.equal(safeJoin(root, ''), root);
});

test('safeEqual 常量时间比较：等长不等值返回 false，长度不同也不抛', () => {
  assert.equal(safeEqual('dshb_abc', 'dshb_abc'), true);
  assert.equal(safeEqual('dshb_abc', 'dshb_abd'), false);
  assert.equal(safeEqual('short', 'longer-value'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(12345, '12345'), true, '非字符串按 String() 比较');
  assert.equal(safeEqual('0', ''), false);
});

test('randomHex 给的是定长小写十六进制，且两次不重复', () => {
  assert.match(randomHex(16), /^[0-9a-f]{32}$/u);
  assert.match(randomHex(32), /^[0-9a-f]{64}$/u);
  assert.equal(randomHex(0), '');
  assert.notEqual(randomHex(16), randomHex(16));
});

test('atomicWriteJson 落盘可解析、自动建目录、不留临时文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-atomic-'));
  try {
    const file = path.join(dir, 'nested', 'state.json');
    const value = { version: 1, devices: [{ id: 'dev_1', tokenHash: 'a'.repeat(64) }] };
    atomicWriteJson(file, value);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), value);
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
    assert.deepEqual(readdirSync(path.dirname(file)), ['state.json'], '临时文件必须被 rename 掉');

    // 覆盖写：旧内容被整体替换，不能残留尾部。
    atomicWriteJson(file, { version: 2 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redactUrl 去掉 query 与 fragment，日志里不泄漏令牌', () => {
  assert.equal(redactUrl('/api/v1/me?token=dshb_secret'), '/api/v1/me?…');
  assert.equal(redactUrl('http://127.0.0.1:47901/pair#pair=abc'), '/pair?…');
  assert.equal(redactUrl('http://127.0.0.1:47901/api/v1/tasks'), '/api/v1/tasks');
  assert.equal(redactUrl(''), '(empty)');
  assert.equal(redactUrl(undefined), '(empty)');
  assert.ok(!redactUrl('http://x/y?token=SUPERSECRET').includes('SUPERSECRET'));
});
