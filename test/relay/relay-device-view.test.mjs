/**
 * 本机中继设备的判据（R10）—— `lib/core.mjs` 的 `deviceView()` / `isLocalRelayDevice()`。
 *
 * 旧判据只看 `cloud.identity.deviceId`，可是 `mintDevice()` 在 identity 赋值**之前**
 * 就 `emit('devices.changed', devicesView())`：那一刻 `cloud.identity` 还是上一份
 * （首次生成时就是 undefined），于是刚生成的中继设备会短暂显示成「可移除的普通
 * 设备」—— 界面据此给用户一个按下去就会弄坏自己二维码的按钮（pair-page 用的正是
 * `device.localRelay === true`）。
 *
 * 判据现在回退为 `platform === 'relay' || localRelay === true`（再并上 identity
 * 匹配），与 identity 是否已经就位无关。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { makeLogger, tempDir } from './_support/fixtures.mjs';

const tmp = tempDir('dsh-pocket-relay-device-');
const cores = [];
let counter = 0;

function makeCore() {
  counter += 1;
  const home = path.join(tmp.dir, `home-${counter}`);
  const logger = makeLogger();
  const core = new BridgeCore({}, { home, dataDir: path.join(home, 'pocket'), port: 47901 }, logger);
  cores.push(core);
  return core;
}

/** 录下每一次 devices.changed 的 payload —— 要验的正是「emit 那一刻」的样子。 */
function recordViews(core) {
  const views = [];
  core.subscribe((frame) => {
    if (frame.type === 'devices.changed') views.push(frame.payload);
  });
  return views;
}

after(() => {
  for (const core of cores) {
    try { core.dispose(); } catch { /* 已经关了 */ }
  }
  tmp.cleanup();
});

test('R10：mintDevice 在 identity 赋值之前 emit 的视图里，中继设备已经是 localRelay', () => {
  const core = makeCore();
  const views = recordViews(core);
  assert.equal(core.cloud, undefined, '前提：此刻还没有 CloudService / identity');

  const minted = core.mintDevice({ name: '远程中继', platform: 'relay', appVersion: '1' });
  assert.equal(views.length, 1, 'mintDevice 必须 emit 一次 devices.changed');
  const atEmit = views[0].find((device) => device.id === minted.device.id);
  assert.notEqual(atEmit, undefined);
  assert.equal(atEmit.localRelay, true, 'emit 那一刻就必须标成本机中继（旧代码这里没有 localRelay）');

  // 与 identity 是否就位无关：补上 identity 之后依旧是本机中继。
  core.cloud = { identity: { deviceId: minted.device.id } };
  assert.equal(core.deviceView(core.state.devices[0]).localRelay, true);
});

test('R10：手机设备不会被误判成本机中继（判据不能放大）', () => {
  const core = makeCore();
  const phone = core.provisionDevice({ name: '手机', platform: 'web', installId: 'install-1' });
  const view = core.deviceView(core.state.devices.find((device) => device.id === phone.device.id));
  assert.equal(view.localRelay, undefined, '普通手机不许带 localRelay');
  assert.equal(core.isLocalRelayDevice({ id: 'dev_x', platform: 'web' }), false);
  assert.equal(core.isLocalRelayDevice({ id: 'dev_x', platform: 'relay' }), true);
  assert.equal(core.isLocalRelayDevice({ id: 'dev_x', localRelay: true }), true);
  assert.equal(core.isLocalRelayDevice(undefined), false);
});

test('R10：provisionDevice 的「同名同平台」回落不会把中继设备顶掉', () => {
  const core = makeCore();
  // 中继设备的 platform 恒为 'relay'；而手机端自报的 platform 也是客户端可控的
  // （`provisionFor` 用 `message?.platform ?? 'relay'`），两边确实可能同名同平台。
  const relay = core.mintDevice({ name: '手机', platform: 'relay' });
  const fresh = core.provisionDevice({ name: '手机', platform: 'relay' });
  assert.notEqual(fresh.device.id, relay.device.id, '中继设备不是一台手机，不能被同名回落复用');
  // 自报 platform='relay' 的客户端会被判成本机中继（宁可显示成"不可移除"，也不
  // 让用户点掉自己的二维码）—— 这是判据回退的既定方向，不是副作用。
  assert.equal(core.deviceView(core.state.devices.find((device) => device.id === relay.device.id)).localRelay, true);
});
