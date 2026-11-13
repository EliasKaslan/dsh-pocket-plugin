/**
 * 中继断因的翻译表：**手机屏幕上读到的那句话**到底准不准。
 *
 * 事故现场：WiFi 一切正常、切蜂窝流量就「一直连不上」，屏幕上停在外壳横幅
 * 「中继断开，正在重连…」。真实原因（socket 的 ECONNRESET、TLS 失败、connack 5）
 * 当时只进了 `console.warn` —— 手机上没有控制台，等于当场销毁证据。
 *
 * 这里逐条钉住 `web/lib/relay-diag.js` 的映射：每一条分支都必须能被"改错"抓出来
 * （映射改错或删掉一条分支，下面就有用例变红）。同时钉住诊断文本**不含**房间密钥
 * 与设备令牌 —— 它是给用户复制粘贴用的。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  NO_FAILURE_RAW,
  brokerPort,
  buildDiagText,
  describeAdvice,
  describeBrokerChoice,
  describeFailure,
  describeFailureShort,
  diagRows,
  formatAgo,
  formatClock,
  normalizeConnack,
  rawFailureText,
} from '../../web/lib/relay-diag.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/* --------------------------------- 1. connack -------------------------------- */

test('normalizeConnack：数字 / returnCode / reasonCode 三种写法都要认', () => {
  assert.equal(normalizeConnack(5), 5);
  assert.equal(normalizeConnack({ returnCode: 4 }), 4, 'v4 语义字段');
  assert.equal(normalizeConnack({ reasonCode: 5 }), 5, 'MQTT 5 字段');
  assert.equal(normalizeConnack({ returnCode: 0, reasonCode: 0 }), 0);
  assert.equal(normalizeConnack('5'), 5);
  // 拿不到返回码时必须是 null（而不是 0）——否则会被当成"中继接受了"。
  for (const bad of [undefined, null, {}, { returnCode: 'x' }, Number.NaN, '', true]) {
    assert.equal(normalizeConnack(bad), null, `${JSON.stringify(bad)} 不该给出返回码`);
  }
});

/* ------------------------------ 2. 断因映射 ------------------------------ */

test('ENOTFOUND / EAI_AGAIN → 域名解析失败（网络拦了 DNS）', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    assert.equal(describeFailure({ code }), '域名解析失败（当前网络可能拦了 DNS）');
  }
  // 浏览器里 code 常为空、线索只在小写 message 里
  assert.equal(describeFailure({ message: 'getaddrinfo eai_again broker-cn.emqx.io' }),
    '域名解析失败（当前网络可能拦了 DNS）');
});

test('ECONNREFUSED / ECONNRESET → 连接被对方重置（端口被干扰）', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET']) {
    assert.equal(describeFailure({ code }), '连接被对方重置（运营商/网络设备可能干扰了这个端口）');
  }
  // mqtt.js 的 websocket 错误：code 为空、ECONNRESET 只出现在 message 里
  assert.equal(describeFailure({ message: 'WebSocket connection failed: read ECONNRESET' }),
    '连接被对方重置（运营商/网络设备可能干扰了这个端口）');
});

test('ETIMEDOUT / 超时 → 连接超时（端口被挡住）', () => {
  assert.equal(describeFailure({ code: 'ETIMEDOUT' }), '连接超时（这个端口很可能被当前网络挡住了）');
  assert.equal(describeFailure({ message: '连接超时' }), '连接超时（这个端口很可能被当前网络挡住了）');
  assert.equal(describeFailure({ message: 'WebSocket opening handshake timeout' }),
    '连接超时（这个端口很可能被当前网络挡住了）');
});

test('certificate / TLS / SSL → TLS 握手失败', () => {
  assert.equal(describeFailure({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'TLS 握手失败');
  assert.equal(describeFailure({ message: 'unable to verify the first certificate' }), 'TLS 握手失败');
  assert.equal(describeFailure({ message: 'SSL routines: ssl3_get_server_certificate' }), 'TLS 握手失败');
});

test('connack 非 0 → 中继拒绝了连接；3/4/5 各有一句更具体的话', () => {
  assert.equal(describeFailure({ connack: 5 }), '中继拒绝了这次连接：没有授权（返回码 5）');
  assert.equal(describeFailure({ connack: { reasonCode: 4 } }), '中继不认这个账号或口令（返回码 4）');
  assert.equal(describeFailure({ connack: { returnCode: 3 } }), '中继服务暂时不可用（返回码 3）');
  // 其它返回码：只说返回码，不编原因
  assert.equal(describeFailure({ connack: 128 }), '中继拒绝了连接（返回码 128）');
  // connack 0 表示接受：不能当成拒绝，要继续看 code/message
  assert.equal(describeFailure({ connack: 0, code: 'ECONNRESET' }),
    '连接被对方重置（运营商/网络设备可能干扰了这个端口）');
});

test('code CLOSE（close 事件没带任何错误码）→ 连接被关闭', () => {
  assert.equal(describeFailure({ code: 'CLOSE' }), '底层连接被关闭（没有错误码，可能是线路被掐断或网络切换）');
});

test('其它原因 → 未知原因，但把原始 code / message 截断 40 字带上', () => {
  assert.equal(describeFailure({ code: 'EUNKNOWNTHING' }), '未知原因（EUNKNOWNTHING）');
  assert.equal(describeFailure({ message: 'socket hang up' }), '未知原因（socket hang up）');
  const long = 'Z'.repeat(80);
  const text = describeFailure({ code: long });
  assert.equal(text, `未知原因（${'Z'.repeat(40)}…）`, '长错误必须截断，否则横幅/诊断块被糊满');
  // 什么信息都没有：也要说清楚"没有信息"，不要冒充一个具体原因
  assert.equal(describeFailure({}), '未知原因（没有拿到任何错误信息）');
  assert.equal(describeFailure(undefined), '未知原因（没有拿到任何错误信息）');
});

test('横幅短标签：每类断因一个短标签，且互不重复（横幅只有一行）', () => {
  const cases = [
    [{ code: 'ENOTFOUND' }, '域名解析失败'],
    [{ code: 'ECONNRESET' }, '连接被重置'],
    [{ code: 'ETIMEDOUT' }, '连接超时'],
    [{ message: 'certificate has expired' }, 'TLS 握手失败'],
    [{ connack: 5 }, '没有授权'],
    [{ code: 'CLOSE' }, '连接被关闭'],
    [{ code: 'WAT' }, '未知原因'],
  ];
  const shorts = [];
  for (const [failure, short] of cases) {
    const actual = describeFailureShort(failure);
    assert.equal(actual, short, `${JSON.stringify(failure)} 的短标签`);
    shorts.push(actual);
  }
  // 两类断因共用一个短标签 = 横幅分辨不出来，等于没补原因。
  assert.equal(new Set(shorts).size, shorts.length, `短标签有重复：${shorts.join(' / ')}`);
});

/* ------------------------------ 3. 中继地址 ------------------------------ */

test('describeBrokerChoice：显示当前中继，多个备选要说清数量', () => {
  assert.equal(describeBrokerChoice('wss://broker-cn.emqx.io:8084/mqtt'),
    'wss://broker-cn.emqx.io:8084/mqtt');
  assert.equal(describeBrokerChoice(['wss://a.example:8084/mqtt']), 'wss://a.example:8084/mqtt');
  assert.equal(describeBrokerChoice(['wss://a.example:8084/mqtt', 'wss://b.example:8084/mqtt']),
    'wss://a.example:8084/mqtt（共 2 个备选）');
  for (const empty of [undefined, null, [], '', '   ', [null, 8]]) {
    assert.match(describeBrokerChoice(empty), /未知/u, `${JSON.stringify(empty)} 应显示未知`);
  }
});

test('中继地址里的 userinfo / query / fragment 必须剥掉（那是凭据，不是地址）', () => {
  const raw = 'wss://user:pass@broker-cn.emqx.io:8084/mqtt?token=secret#k=room-key';
  const shown = describeBrokerChoice(raw);
  assert.equal(shown, 'wss://broker-cn.emqx.io:8084/mqtt');
  for (const secret of ['user', 'pass', 'secret', 'room-key']) {
    assert.equal(shown.includes(secret), false, `地址展示里漏出了 ${secret}`);
  }
});

test('brokerPort：从地址里取出被挡住的到底是哪个端口', () => {
  assert.equal(brokerPort(['wss://broker-cn.emqx.io:8084/mqtt']), 8084);
  assert.equal(brokerPort('wss://relay.example/mqtt'), 443, 'wss 不写端口就是 443');
  assert.equal(brokerPort([]), null);
  assert.equal(brokerPort([null]), null);
});

/* ------------------------------- 4. 操作建议 ------------------------------ */

test('describeAdvice 按断因给出可执行的下一步（不是「再试一次」）', () => {
  const reset = describeAdvice({ brokers: ['wss://broker-cn.emqx.io:8084/mqtt'], lastFailure: { code: 'ECONNRESET' } });
  assert.match(reset, /8084/u, '必须说清挡住的是哪个端口');
  assert.match(reset, /WiFi/u, '必须给出换网络的动作');
  assert.match(reset, /INSTALL\.md/u);

  assert.match(describeAdvice({ lastFailure: { message: '连接超时' } }), /端口/u);
  assert.match(describeAdvice({ lastFailure: { code: 'ENOTFOUND' } }), /DNS|域名/u);
  assert.match(describeAdvice({ lastFailure: { message: 'certificate expired' } }), /TLS|代理/u);
  assert.match(describeAdvice({ lastFailure: { code: 'CLOSE' } }), /NAT|心跳/u);
  assert.match(describeAdvice({ lastFailure: { connack: 5 } }), /重新生成远程链接/u);
  assert.match(describeAdvice({ lastFailure: { connack: 4 } }), /口令/u);
  assert.match(describeAdvice({ lastFailure: { connack: 3 } }), /不可用/u);
  assert.match(describeAdvice({ lastFailure: { connack: 7 } }), /返回码 7/u);
  // 一次都没失败过：先把"电脑那边活着没有"讲清楚
  assert.match(describeAdvice({}), /DSH.*正在运行|远程访问/u);
  // 中继在线时不该再念断因
  assert.match(describeAdvice({ online: true, lastFailure: { code: 'ECONNRESET' } }), /在线/u);
  // 直接传扁平失败对象也认（两个入口同一个映射表）
  assert.match(describeAdvice({ code: 'ECONNRESET' }), /重置/u);
});

/* -------------------------------- 5. 时间 -------------------------------- */

test('formatAgo：相对时间，0/非法值说「没有记录」而不是 1970 年', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatAgo(0, now), '还没有记录');
  assert.equal(formatAgo(undefined, now), '还没有记录');
  assert.equal(formatAgo(Number.NaN, now), '还没有记录');
  assert.equal(formatAgo(now - 1_000, now), '刚刚');
  assert.equal(formatAgo(now - 37_000, now), '37 秒前');
  assert.equal(formatAgo(now - 90_000, now), '2 分钟前');
  assert.equal(formatAgo(now - 2 * 3_600_000, now), '2 小时前');
  assert.equal(formatAgo(now - 3 * 86_400_000, now), '3 天前');
  // 手机时钟回拨：差值会变成负数，不许显示「-5 秒前」
  assert.equal(formatAgo(now + 5_000, now), '刚刚');
  assert.equal(formatAgo(0, now, '还没有成功过'), '还没有成功过');
});

test('formatClock：本地时间戳可读，非法值给空串（不显示 1970）', () => {
  assert.equal(formatClock(0), '');
  assert.equal(formatClock(Number.NaN), '');
  assert.match(formatClock(1_700_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
});

test('rawFailureText：原始 code 与 message 都要留痕（这是可搜索的证据）', () => {
  assert.equal(rawFailureText({ code: 'ECONNRESET', message: 'read ECONNRESET' }),
    'code=ECONNRESET · message=read ECONNRESET');
  assert.equal(rawFailureText({ code: 'ECONNRESET', message: 'ECONNRESET' }), 'code=ECONNRESET',
    'message 与 code 相同时不重复');
  assert.equal(rawFailureText({}), NO_FAILURE_RAW);
  assert.equal(rawFailureText(null), NO_FAILURE_RAW);
});

/* ------------------------------ 6. 表格行 -------------------------------- */

test('diagRows：离线时每一行也有值，且带上原因 + 原始 code', () => {
  const now = 1_700_000_000_000;
  const rows = diagRows({
    brokers: ['wss://broker-cn.emqx.io:8084/mqtt'],
    online: false,
    attempts: 3,
    lastOkAt: now - 37_000,
    lastAttemptAt: now - 2_000,
    lastFailure: { code: 'ECONNRESET', message: 'read ECONNRESET', connack: null, at: now - 2_000, attempts: 3, okAt: now - 37_000 },
    now,
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.broker, 'wss://broker-cn.emqx.io:8084/mqtt');
  assert.equal(byKey.state, '离线');
  assert.equal(byKey.attempts, '3 次');
  assert.match(byKey.ok, /37 秒前/u);
  assert.match(byKey.ok, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u, '相对时间旁边要有绝对时刻');
  assert.equal(byKey.attempt, '刚刚');
  assert.equal(byKey.failure, '连接被对方重置（运营商/网络设备可能干扰了这个端口）');
  assert.equal(byKey.raw, 'code=ECONNRESET · message=read ECONNRESET');
  assert.match(byKey.advice, /8084/u);
  // 每一行都必须有 label，UI 直接把 label 当键渲染
  for (const row of rows) assert.ok(row.label.length > 0, `${row.key} 缺 label`);
});

test('diagRows：没有任何失败记录时也要能渲染（不冒充具体原因）', () => {
  const rows = diagRows({ brokers: [], online: false, attempts: 0, lastFailure: null, now: 1_700_000_000_000 });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.failure, '（还没有失败过）');
  assert.equal(byKey.attempts, '0 次');
  assert.equal(byKey.ok, '还没有成功过');
  assert.equal(byKey.attempt, '还没有尝试过');
  assert.equal('raw' in byKey, false, '没有失败就不该有原始信息行');
});

/* ---------------------------- 7. 复制诊断文本 ---------------------------- */

test('buildDiagText：中继地址、失败次数、最后成功、原因与原始 code、是否在线、PWA 齐全', () => {
  const now = 1_700_000_000_000;
  const text = buildDiagText({
    brokers: ['wss://broker-cn.emqx.io:8084/mqtt'],
    online: false,
    attempts: 4,
    lastOkAt: now - 60_000,
    lastAttemptAt: now - 1_000,
    lastFailure: { code: 'ECONNRESET', message: 'read ECONNRESET', connack: null, at: now - 1_000, attempts: 4, okAt: now - 60_000 },
    now,
    pwa: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1',
  });
  assert.match(text, /中继诊断/u);
  assert.match(text, /wss:\/\/broker-cn\.emqx\.io:8084\/mqtt/u, '中继地址可以显示');
  assert.match(text, /连续失败：4 次/u);
  assert.match(text, /最后成功：1 分钟前/u);
  assert.match(text, /连接被对方重置/u);
  assert.match(text, /code=ECONNRESET/u, '必须带原始 code —— 这是唯一可搜索的证据');
  assert.match(text, /当前状态：离线/u);
  assert.match(text, /PWA/u);
  assert.match(text, /iPhone/u);
  assert.match(text, /建议：/u);
});

test('buildDiagText：房间密钥 / 设备令牌 / 链接里的 r、t 一个字都不许进去', () => {
  const now = 1_700_000_000_000;
  const diag = {
    // 快照里被塞了各种敏感字段（真实链路里这些值就在同一个对象附近）
    room: 'r_room_0123456789',
    key: 'k_aes256_secret_value',
    deviceToken: 'dshb_device_token_secret',
    token: 't_relay_identity_secret',
    link: 'https://example/#r=r_room_0123456789&k=k_aes256_secret_value&t=t_relay_identity_secret',
    brokers: ['wss://user:pass@broker-cn.emqx.io:8084/mqtt?token=query_secret#k=k_aes256_secret_value'],
    online: false,
    attempts: 1,
    lastFailure: { code: 'ECONNRESET', message: 'read ECONNRESET', connack: null },
    now,
    pwa: false,
    userAgent: 'Mozilla/5.0',
  };
  const text = buildDiagText(diag);
  for (const secret of [
    'r_room_0123456789', 'k_aes256_secret_value', 'dshb_device_token_secret',
    't_relay_identity_secret', 'query_secret', 'user:pass', 'pass@',
  ]) {
    assert.equal(text.includes(secret), false, `诊断文本里漏出了 ${secret}`);
  }
  // 但地址本身要留下（排障没有它等于没用）
  assert.match(text, /wss:\/\/broker-cn\.emqx\.io:8084\/mqtt/u);
});

test('buildDiagText：空诊断也能生成一段可粘贴的文本（不抛、不留 undefined）', () => {
  const text = buildDiagText();
  assert.match(text, /DSH 随行 · 中继诊断/u);
  assert.equal(text.includes('undefined'), false);
  assert.equal(text.includes('null'), false);
  assert.match(text, /浏览器标签页/u);
});

/* ---------------------------- 8. 纯逻辑的边界 ---------------------------- */

test('这个模块必须能在 Node 里直接 import：不碰 DOM、不碰 mqtt', async () => {
  const source = await readFile(join(ROOT, 'web', 'lib', 'relay-diag.js'), 'utf8');
  // 只扫代码，不扫注释：注释里解释"手机上没有控制台"是正当的。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[ \t]*\/\/.*$/gmu, '');
  for (const banned of ['document.', 'window.', 'mqtt', 'navigator.', 'localStorage', 'fetch(']) {
    assert.equal(code.includes(banned), false, `relay-diag.js 的代码里不该出现 ${banned}`);
  }
  // 房间密钥这类名字出现在代码里就意味着它会被读——这里一条都不许有
  for (const banned of ['deviceToken', "get('k')", 'room']) {
    assert.equal(code.includes(banned), false, `relay-diag.js 的代码里不该出现 ${banned}`);
  }
  // 导入即用：本文件顶部的静态 import 已经证明它可加载；这里再确认导出齐全。
  for (const name of ['describeFailure', 'describeBrokerChoice', 'buildDiagText']) {
    assert.equal(typeof (await import('../../web/lib/relay-diag.js'))[name], 'function');
  }
});
