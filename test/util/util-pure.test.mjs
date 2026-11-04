/**
 * lib/util.mjs 的纯函数面：常量、转义、脱敏、配对码、路径、编码、文本与时间。
 *
 * 为什么值得单独钉：这些函数都在 HTTP 请求路径上，一次「少转义一个字符」
 * 或「safeJoin 放行一次 ..」就是可利用的洞；而它们又极易在重构里被悄悄改坏
 * （返回值从 undefined 变成 null、从 '' 变成 '—'），所以断言全部落在
 * **外部输入能触发的具体输出**上，而不是「跑通不抛」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  PAIRING_CODE_LENGTH, PLUGIN_VERSION, PROTOCOL_VERSION, RELAY_HEADER, RELAY_MARK,
  b64url, clamp, contentType, durationText, escapeHtml, fromB64url, hostHeaderName,
  isLoopback, isLoopbackHostname, isPlainObject, isValidIp, normalizeCode, normalizeIp,
  nowMs, oneLine, pairingCode, randomBytes32, randomHex, randomId, randomToken,
  redactBroker, redactSecret, redactUrl, relativeTime, safeEqual, safeJoin, sha256, truncate,
} from '../../lib/util.mjs';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('协议常量：版本号与 package.json 不脱节，中继头是小写且带前缀', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(PLUGIN_VERSION, PKG.version, 'PLUGIN_VERSION 必须跟 package.json 的 version 一致，否则升级时忘改');
  // 头名必须全小写：HTTP 头大小写不敏感，但代码里是按小写键比较的。
  assert.equal(RELAY_HEADER, RELAY_HEADER.toLowerCase());
  assert.match(RELAY_HEADER, /^x-[a-z-]+$/u);
  // Symbol 必须走全局注册表，否则跨模块（server ↔ relay）拿不到同一个哨兵。
  assert.equal(RELAY_MARK, Symbol.for('dsh-pocket.relay'));
  assert.equal(typeof RELAY_MARK, 'symbol');
});

test('escapeHtml：五个元字符全部转义，任何载荷都不留裸 <> " \'', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  // 单引号不转义 = 属性值用单引号时可以直接逃逸，这是最常见的漏法。
  assert.equal(escapeHtml(`x' onclick='alert(1)`), 'x&#39; onclick=&#39;alert(1)');

  const payloads = [
    '"><script>alert(1)</script>',
    `'><img src=x onerror=alert(1)>`,
    '</title></div><svg/onload=alert(1)>',
    'javascript:alert(1)',
    '&amp;&lt;&gt;',
    '<!--><script>',
    '"><iframe src=//evil>',
  ];
  for (const payload of payloads) {
    const out = escapeHtml(payload);
    assert.doesNotMatch(out, /[<>"']/u, `载荷漏了裸元字符：${payload} -> ${out}`);
    // & 只允许作为实体开头出现，不能留下「裸 &」让浏览器把后面当实体解析。
    assert.equal(/&(?!(?:amp|lt|gt|quot|#39);)/u.test(out), false, `出现裸 &：${payload} -> ${out}`);
  }
});

test('escapeHtml：Unicode 原样保留，非字符串按 String() 处理，null/undefined 变空串', () => {
  const name = '设备 · 书房主机😀 中文';
  assert.equal(escapeHtml(name), name, '转义不能碰非 ASCII，否则中文设备名会乱码');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml({ toString: () => '<x>' }), '&lt;x&gt;', '对象必须先 String() 再转义');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
});

test('safeEqual：等长才比，长度不同直接 false 且不抛（timingSafeEqual 会抛）', () => {
  assert.equal(safeEqual('dshb_' + 'a'.repeat(43), 'dshb_' + 'a'.repeat(43)), true);
  assert.equal(safeEqual('dshb_' + 'a'.repeat(43), 'dshb_' + 'a'.repeat(42) + 'b'), false);
  assert.equal(safeEqual('short', 'much-longer-token'), false, '长度不等必须走短路，不能进 timingSafeEqual');
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('中文令牌', '中文令牌'), true, '按 UTF-8 字节比，多字节字符不能被截断误判');
  assert.equal(safeEqual('中文令牌', '中文令排'), false);
  assert.equal(safeEqual(42, '42'), true, '非字符串按 String() 归一');
});

test('redactSecret：只留前 6 字符 + 长度，尾部永不出现在日志里', () => {
  assert.equal(redactSecret('dshb_abcdefgh'), 'dshb_a…(len=13)');
  const secret = 'dshb_SUPERSECRETVALUE_0123456789';
  const line = `token=${redactSecret(secret)}`;
  assert.equal(line.includes('SUPERSECRET'), false, '日志行里不能出现令牌正文');
  assert.equal(line.includes(String(secret.length)), true, '长度要保留，否则排障时不知道是空还是被截断');
  assert.equal(redactSecret('abc'), 'abc…(len=3)', '短于 6 字符时整串就是前缀');
  assert.equal(redactSecret(''), '(empty)');
  assert.equal(redactSecret(null), '(empty)');
  assert.equal(redactSecret(undefined), '(empty)');
  assert.equal(redactSecret(123456789), '(empty)', '只接受字符串，数字当没给');
});

test('redactUrl：只留 path，query / fragment / userinfo / host 全部丢弃', () => {
  assert.equal(redactUrl('/api/v1/me?token=dshb_secret'), '/api/v1/me?…');
  assert.equal(redactUrl('http://user:pass@127.0.0.1:47901/pair#pair=abc'), '/pair?…');
  assert.equal(redactUrl('http://127.0.0.1:47901/api/v1/tasks'), '/api/v1/tasks', '没有 query 时不加省略号');
  assert.equal(redactUrl('http://127.0.0.1:47901/api/v1/tasks#x'), '/api/v1/tasks?…', '只有 fragment 也要打码');
  const redacted = redactUrl('https://broker.example/mqtt?user=alice&password=hunter2');
  assert.equal(redacted.includes('hunter2'), false);
  assert.equal(redacted.includes('alice'), false, 'query 里的用户名同样不能留');
  assert.equal(redacted.includes('broker.example'), false, 'redactUrl 的约定就是丢掉 host（要 host 用 redactBroker）');
  // URL 解析器对相对路径几乎不抛，畸形输入会退化成「按文件名转义」，总之不能把原文漏出来。
  assert.equal(redactUrl('not a url %%%'), '/not%20a%20url%20%%%');
  assert.equal(redactUrl(''), '(empty)');
  assert.equal(redactUrl(null), '(empty)');
});

test('redactBroker：保留 scheme/host/port/path（排障要看），只打码 userinfo 与 query', () => {
  assert.equal(
    redactBroker('mqtts://user:pass@broker.example:8883/mqtt?x=1'),
    'mqtts://***@broker.example:8883/mqtt?…',
  );
  assert.equal(redactBroker('wss://broker.example/mqtt'), 'wss://broker.example/mqtt');
  assert.equal(redactBroker('mqtt://broker.example'), 'mqtt://broker.example');
  assert.equal(redactBroker('mqtt://:secret@broker.example:1883'), 'mqtt://***@broker.example:1883', '只有密码也要打码');
  const masked = redactBroker('mqtts://alice:hunter2@broker.example/mqtt');
  assert.equal(masked.includes('hunter2'), false);
  assert.equal(masked.includes('alice'), false);
  assert.equal(redactBroker('::::'), '::::…(len=4)', '解析失败时退化成 redactSecret，而不是抛');
  assert.equal(redactBroker(''), '(empty)');
  assert.equal(redactBroker(undefined), '(empty)');
});

test('pairingCode：定长、含连字符、字符集排除易混字符，重复率不失控', () => {
  const code = pairingCode();
  assert.equal(code.length, PAIRING_CODE_LENGTH + 1, '8 位码 + 1 个连字符');
  assert.equal(code.indexOf('-'), 4, '连字符固定在中间，方便念');
  assert.equal(normalizeCode(code).length, PAIRING_CODE_LENGTH);
  assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/u);
  // 0/1/I/O 不能出现：屏幕上分不清，配对时必然打错。
  assert.equal(/[01IO]/u.test(code), false);
  // 位数受 clamp 保护：传 1 → 4 位，传 1000 → 32 位（防止 randomBytes 被撑爆）。
  assert.equal(pairingCode(1).length, 5);
  assert.equal(pairingCode(1000).length, 33);
  assert.equal(pairingCode(0).length, 5);
  const seen = new Set();
  for (let index = 0; index < 64; index += 1) seen.add(pairingCode());
  assert.ok(seen.size >= 62, `64 次只出了 ${seen.size} 个不同码，随机源可能坏了`);
});

test('normalizeCode：大小写、空格、连字符都归一，非字母数字一律丢掉', () => {
  assert.equal(normalizeCode(' ab-12 cd '), 'AB12CD');
  assert.equal(normalizeCode('ABCD-EFGH'), 'ABCDEFGH');
  assert.equal(normalizeCode('a_b/c.d'), 'ABCD');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
  assert.equal(normalizeCode(12345), '12345');
  assert.equal(normalizeCode('中文abc'), 'ABC', '非 ASCII 不能被当成码位');
});

test('b64url / fromB64url：URL 安全字符表、无 padding、可逆', () => {
  assert.equal(b64url(Buffer.from([251, 255, 190])), '-_--', '+/ 必须换成 -_ 且去掉 =');
  assert.equal(b64url(Buffer.from('hello')), 'aGVsbG8');
  assert.equal(/[+/=]/u.test(b64url(randomBytes32())), false);
  for (const bytes of [[0], [0, 0, 0], [255, 254, 253], [1, 2, 3, 4, 5], Array.from({ length: 64 }, (_, i) => i)]) {
    assert.deepEqual([...fromB64url(b64url(Buffer.from(bytes)))], bytes, `往返失败：${bytes}`);
  }
  assert.deepEqual([...fromB64url('-_')], [251], '标准与 url-safe 两种字母表都要能吃');
  assert.deepEqual([...fromB64url('+/8=')], [251, 255], '带 padding 的标准 base64 也要能吃');
});

test('sha256 / 随机串：已知向量 + 形状 + 不重复', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('abc'), sha256('abc'), '必须是确定性的，否则令牌哈希对不上');
  assert.notEqual(sha256('abc'), sha256('abd'));
  assert.equal(randomBytes32().length, 32);
  assert.match(randomHex(16), /^[0-9a-f]{32}$/u);
  assert.equal(randomToken().length, 'dshb_'.length + 43, '32 字节 base64url 无 padding = 43 字符');
  assert.match(randomToken('x_'), /^x_[A-Za-z0-9_-]{43}$/u);
  assert.match(randomId('dev_'), /^dev_[A-Za-z0-9_-]{22}$/u);
  assert.notEqual(randomToken(), randomToken());
  assert.ok(Math.abs(nowMs() - Date.now()) < 1_000);
});

test('clamp / truncate / oneLine：非数字、负数、超长、Unicode 空白', () => {
  assert.equal(clamp('5', 1, 3), 3);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp('abc', 2, 9), 2, '非法输入退回下界，而不是 NaN');
  assert.equal(clamp(NaN, 2, 9), 2);
  assert.equal(clamp(Infinity, 2, 9), 2, 'Infinity 不是有限数 → 与 NaN 一样退回下界（不是上限）');
  assert.equal(clamp(100, 2, 9), 9);
  assert.equal(clamp(undefined, 2, 9), 2);

  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcd', 4), 'abcd', '正好等长时不加省略号');
  assert.equal(truncate('abcde', 4), 'abc…', '结果长度必须 ≤ max');
  assert.equal(truncate(12345, 3), '', '非字符串视为空，绝不把数字当文本切');
  assert.equal(truncate('abcdef', 0), '…', 'max=0 时才有的怪值，记录在报告 F-1');

  assert.equal(oneLine('  a\n\tb  ', 10), 'a b', '换行/制表符折叠成单空格');
  assert.equal(oneLine('a\u00a0b', 10), 'a b', 'NBSP 也算空白');
  assert.equal(oneLine(123), '');
  assert.equal(oneLine('a'.repeat(500), 240).length, 240, '默认上限 240，日志行才不会失控');
});

test('isPlainObject：数组/ null 不算，Object.create(null) 与 Map 算（只拦数组与 null）', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('str'), false);
  assert.equal(isPlainObject(new Map()), true, '只用来挡住「顶层是数组」，不是严格原型检查');
});

test('safeJoin：编码穿越、反斜杠、UNC、NUL、深度回退一律关在根内', () => {
  const root = path.resolve(tmpdir(), 'pocket-safejoin-root');
  const inside = (out) => {
    if (out === undefined) return true;
    const rel = path.relative(root, out);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const probes = [
    'a/%2e%2e/%2e%2e/etc/passwd',
    '..%5c..%5cwindows',
    'a/b/../../../../../../etc/passwd',
    '%252e%252e%252fetc%252fpasswd',
    '\\\\server\\share\\x',
    'dir\\..\\..\\x',
    'a/\u0000/x',
  ];
  for (const probe of probes) {
    const out = safeJoin(root, probe);
    assert.ok(inside(out), `逃出根目录：${probe} -> ${out}`);
  }
  assert.equal(safeJoin(root, 'a/%2e%2e/%2e%2e/etc/passwd'), undefined, '一次解码后仍是 ../，必须拒');
  assert.equal(safeJoin(root, '%252e%252e%252fetc'), path.join(root, '%2e%2e%2fetc'), '二次编码只剩字面文件名，落在根内是安全的');
  assert.equal(safeJoin(root, 'dir/'), path.join(root, 'dir'), '尾斜杠被规范化掉');
  assert.equal(safeJoin(root, '图标/下载.png'), path.join(root, '图标', '下载.png'), 'Unicode 文件名必须原样放行');
});

test('网络工具：IPv4 映射、方括号 IPv6、Host 头与回环白名单', () => {
  assert.equal(normalizeIp('::1'), '127.0.0.1');
  assert.equal(normalizeIp('::ffff:192.168.1.9'), '192.168.1.9');
  assert.equal(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1', '映射前缀必须先剥掉再判回环，否则 IPv4 手机全被判成非本机');
  assert.equal(normalizeIp(undefined), '');
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('127.0.0.2'), false, '只认 127.0.0.1 这一条，别把整个 127/8 当成回环');
  assert.equal(isLoopback('192.168.1.9'), false);
  assert.equal(isValidIp('1.2.3.4'), true);
  assert.equal(isValidIp('::1'), true);
  assert.equal(isValidIp('999.1.1.1'), false);
  assert.equal(isValidIp('1.2.3'), false);
  assert.equal(isValidIp(''), false);
  assert.equal(isValidIp(42), false, '非字符串不能抛');

  assert.equal(hostHeaderName('Example.COM:8080'), 'example.com');
  assert.equal(hostHeaderName('  example.com  '), 'example.com');
  assert.equal(hostHeaderName('[::1]:9999'), '[::1]', 'IPv6 字面量保留方括号，便于与白名单逐字比较');
  assert.equal(hostHeaderName('[::1]'), '[::1]');
  assert.equal(hostHeaderName('[::1'), undefined, '坏的方括号必须给 undefined，不能把整段当主机名');
  assert.equal(hostHeaderName('a:b:c'), 'a:b:c', '带多个冒号又不是方括号 IPv6，原样返回');
  assert.equal(hostHeaderName(''), undefined);
  assert.equal(hostHeaderName('   '), undefined);
  assert.equal(hostHeaderName(undefined), undefined);

  assert.equal(isLoopbackHostname('LOCALHOST'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(isLoopbackHostname('[::1]'), true);
  assert.equal(isLoopbackHostname('localhost.'), false, '带点的是另一个 DNS 名，不放行');
  assert.equal(isLoopbackHostname('localhost.evil.com'), false);
  assert.equal(isLoopbackHostname(''), false);
});

test('contentType：扩展名表全覆盖、大小写无关、未知回退八位流', () => {
  const table = {
    'a.html': 'text/html; charset=utf-8',
    'a.js': 'text/javascript; charset=utf-8',
    'a.mjs': 'text/javascript; charset=utf-8',
    'a.css': 'text/css; charset=utf-8',
    'a.json': 'application/json; charset=utf-8',
    'a.webmanifest': 'application/manifest+json; charset=utf-8',
    'a.svg': 'image/svg+xml',
    'a.png': 'image/png',
    'a.jpg': 'image/jpeg',
    'a.jpeg': 'image/jpeg',
    'a.webp': 'image/webp',
    'a.ico': 'image/x-icon',
    'a.woff2': 'font/woff2',
    'a.woff': 'font/woff',
    'a.txt': 'text/plain; charset=utf-8',
    'a.md': 'text/markdown; charset=utf-8',
    'a.zip': 'application/zip',
  };
  for (const [file, mime] of Object.entries(table)) {
    assert.equal(contentType(file), mime, file);
    assert.equal(contentType(`/abs/path/${file}`), mime, `带目录时也要取对扩展名：${file}`);
  }
  assert.equal(contentType('UPPER.HTML'), 'text/html; charset=utf-8');
  assert.equal(contentType('x.tar.gz'), 'application/octet-stream', '只认最后一段扩展名');
  assert.equal(contentType('noext'), 'application/octet-stream');
  assert.equal(contentType(''), 'application/octet-stream');
  assert.equal(contentType('trailing.'), 'application/octet-stream');
});

test('relativeTime（util 版）：只接受数字，7 天以内说相对时间，超出给月日', () => {
  const now = new Date(2026, 10, 4, 15, 30, 0).getTime(); // 2026-11-04 15:30 本地时间
  assert.equal(relativeTime(now - 59_999, now), '刚刚');
  assert.equal(relativeTime(now - 60_000, now), '1 分钟前');
  assert.equal(relativeTime(now - 3_599_999, now), '59 分钟前');
  assert.equal(relativeTime(now - 3_600_000, now), '1 小时前');
  assert.equal(relativeTime(now - 86_399_999, now), '23 小时前');
  assert.equal(relativeTime(now - 86_400_000, now), '1 天前');
  assert.equal(relativeTime(now - 7 * 86_400_000, now), '10 月 28 日', '满 7 天改用月日');
  assert.equal(relativeTime(now - 40 * 86_400_000, now), '9 月 25 日');
  assert.equal(relativeTime(now + 60_000, now), '刚刚', '时钟略快不能出负数');
  // util 版比前端版严格：字符串时间戳不会被 Number() 兜住，返回空串由调用方兜底。
  assert.equal(relativeTime(String(now), now), '');
  assert.equal(relativeTime(0, now), '');
  assert.equal(relativeTime(-1, now), '');
  assert.equal(relativeTime(NaN, now), '');
  assert.equal(relativeTime(undefined, now), '');
});

test('durationText：四舍五入到秒，分钟/小时进位边界，负数与非法给空串', () => {
  assert.equal(durationText(0), '0 秒');
  assert.equal(durationText(999), '1 秒', '四舍五入到秒：不到 1 秒也可能显示 1 秒');
  assert.equal(durationText(1_000), '1 秒');
  assert.equal(durationText(59_000), '59 秒');
  assert.equal(durationText(59_600), '1 分 0 秒', '进位后秒数为 0 也要写出来，不能显示成「1 分」');
  assert.equal(durationText(61_000), '1 分 1 秒');
  assert.equal(durationText(3_600_000), '1 小时 0 分');
  assert.equal(durationText(7_300_000), '2 小时 1 分');
  assert.equal(durationText(86_400_000), '24 小时 0 分', '没有「天」这一档，一天就是 24 小时');
  assert.equal(durationText(-1), '');
  assert.equal(durationText(NaN), '');
  assert.equal(durationText('123'), '');
});
