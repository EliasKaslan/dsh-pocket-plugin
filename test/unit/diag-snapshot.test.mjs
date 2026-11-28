/**
 * 诊断快照必须能回答「手机为什么收不到东西」（A5）。
 *
 * 1.0.2 的 `__POCKET_DIAG__.snapshot()` 只有
 * `brokers / online / attempts / lastFailure / lastOkAt / lastAttemptAt / now`。
 * 这套字段判断不了最难受的一种坏法：**手机自认为在线、实际一帧都收不进来**
 * （`online` 只等于 `relay.ready`，而 ready 只看 MQTT 的 connack）。
 *
 * 同时「中继在线」与「电脑端在线」是两个判据，以前挤在同一个 `online` 字段里，
 * 屏幕上于是出现"一边显示在线、一边横幅说电脑端已离线"的自相矛盾。
 *
 * 这里只测纯数据层（`diagRows()` / `buildDiagText()`）：外壳把新字段填进
 * `snapshot()` 的部分由 `test/domain/shell-relay-diag.test.mjs` 做结构断言。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagRows, buildDiagText } from '../../web/lib/relay-diag.js';

const NOW = 1_700_000_000_000;

/** 现场：中继自认为在线，但一条下行都没收到过。 */
const SILENT_DOWNLINK = {
  brokers: ['wss://broker-cn.emqx.io:8084/mqtt'],
  online: true,
  pcStale: true,
  attempts: 0,
  lastFailure: null,
  lastOkAt: NOW - 30_000,
  lastAttemptAt: NOW - 20_000,
  stats: { rx: 0, tx: 37, err: 2, lastRxAt: 0 },
  pending: 3,
  restartCount: 4,
  sockets: 1,
  // F1：「有请求在途 + 下行静默」触发的重建次数（旧实现里这种坏法一次都不会记）。
  stallRebuilds: 6,
  now: NOW,
};

const rowMap = (snapshot) => Object.fromEntries(diagRows(snapshot).map((row) => [row.key, row.value]));

test('A5：能看出"一帧下行都没收到"（online=true 也救不了这种坏法）', () => {
  const rows = rowMap(SILENT_DOWNLINK);
  assert.equal(rows.state, '在线', '中继自认为在线');
  assert.match(rows.rx, /^0 帧/u, '收到下行必须是 0 帧');
  assert.match(rows.rx, /还没收到过/u, 'lastRxAt=0 要说"还没收到过"，不能显示 1970 年');
  assert.match(rows.tx, /^37 帧/u);
  assert.match(rows.err, /^2 次/u);
  assert.match(rows.pending, /^3 条/u);
  assert.match(rows.sockets, /^1 条/u);
  assert.match(rows.restart, /^4 次/u);
  assert.match(rows.stallrebuild, /^6 次/u, 'F1 的「静默重建」次数必须在诊断里（旧实现这种坏法一次都不会记）');
  assert.match(rows.rx, /还没收到过/u);
});

test('A5：中继状态与电脑端心跳分成两行，不再同屏自相矛盾', () => {
  const rows = rowMap(SILENT_DOWNLINK);
  assert.equal(rows.state, '在线');
  assert.match(rows.pc, /静默/u, '电脑端已经停止心跳就必须说出来，而不是被"当前状态：在线"盖住');
  assert.notEqual(rows.state, rows.pc, '两个判据不能共用同一行');

  // 反过来：中继离线时不该假装知道电脑端的状态
  const offline = rowMap({ ...SILENT_DOWNLINK, online: false, pcStale: false });
  assert.equal(offline.state, '离线');
  assert.match(offline.pc, /未连上/u);
});

test('A5：中继在线但电脑端静默 → 建议文案给出"先查电脑"的具体动作', () => {
  const rows = rowMap(SILENT_DOWNLINK);
  assert.match(rows.advice, /电脑端/u);
  assert.match(rows.advice, /心跳/u);
  // 中继在线且电脑端正常时，别再把断因念一遍
  const healthy = rowMap({
    ...SILENT_DOWNLINK, pcStale: false, stats: { rx: 120, tx: 8, err: 0, lastRxAt: NOW - 1_000 },
  });
  assert.match(healthy.advice, /在线/u);
});

test('A5：「复制诊断信息」带上新字段，且仍然不含密钥 / 令牌 / 房间号', () => {
  const text = buildDiagText({
    ...SILENT_DOWNLINK,
    // 快照周围真实存在的敏感值，一个都不许进文本
    room: 'r_room_0123456789',
    key: 'k_aes256_secret_value',
    deviceToken: 'dshb_device_token_secret',
    token: 't_relay_identity_secret',
    pwa: true,
    userAgent: 'Mozilla/5.0 (iPhone)',
  });
  for (const expected of ['收到下行：0 帧', '发出上行：37 帧', '解析 / 传输错误：2 次', '在途请求：3 条', '实时通道：1 条', '连接重建：4 次', '静默重建：6 次', '电脑端心跳：']) {
    assert.ok(text.includes(expected), `复制文本缺少「${expected}」`);
  }
  for (const secret of ['r_room_0123456789', 'k_aes256_secret_value', 'dshb_device_token_secret', 't_relay_identity_secret']) {
    assert.equal(text.includes(secret), false, `诊断文本里漏出了 ${secret}`);
  }
});

test('A5：新字段缺失 / 非法时给 0 与默认文案（不出现 NaN / undefined / null）', () => {
  const rows = rowMap({ online: false, attempts: 0, lastFailure: null, now: NOW });
  for (const value of Object.values(rows)) {
    assert.equal(String(value).includes('undefined'), false, `出现了 undefined：${value}`);
    assert.equal(String(value).includes('NaN'), false, `出现了 NaN：${value}`);
    assert.equal(String(value).includes('null'), false, `出现了 null：${value}`);
  }
  assert.match(rows.rx, /^0 帧/u);
  assert.match(rows.pending, /^0 条/u);
  assert.match(rows.restart, /^0 次/u);
  assert.match(rows.stallrebuild, /^0 次/u, '缺字段时必须是 0，不许 NaN / undefined');
  const text = buildDiagText({ now: NOW });
  assert.equal(text.includes('undefined'), false);
  assert.equal(text.includes('NaN'), false);
});
