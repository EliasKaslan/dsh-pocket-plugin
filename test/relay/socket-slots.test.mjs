/**
 * 中继隧道槽位泄漏的回归测试。
 *
 * 实测发现：连续进入页面 5 次后，桌面端 `ws open … slots=` 只增不减
 * （3 → 3 → 4）。原因有两层：
 *   1. 每次进页面都会新开一条隧道，旧的那条在手机上被销毁却**永远不会发
 *      `ws.close`**（进程被杀、标签页被丢弃都不会通知）；
 *   2. 空闲回收阈值是 **1 小时**，`MAX_SOCKETS = 12`，于是一小时内进 12 次就会
 *      `too many channels` —— 手机上表现为永远卡在「正在连接…」。
 *
 * 这里直接驱动 `BridgeServer.onConnection`：同一设备连两条，第一条必须被关掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeServer } from '../../lib/server.mjs';

function makeServer() {
  const core = {
    seq: 1,
    deviceView: (device) => ({ id: device.id, name: device.name }),
    serverInfo: () => ({ name: 'test', version: '0' }),
    replay: () => [],
    subscribe: () => () => {},
    setServer: () => {},
    logger: { info() {}, warn() {}, error() {} },
    on: () => {},
  };
  const server = new BridgeServer(core, {
    logger: { info() {}, warn() {}, error() {} },
    webRoot: '.',
    downloadDirs: [],
  });
  return { server, core };
}

/** 一个够用的假 socket：记录 close/terminate 调用。 */
function makeSocket() {
  const calls = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    isAlive: true,
    close: (code, reason) => { calls.push(['close', code, reason]); socket.readyState = 3; },
    terminate: () => { calls.push(['terminate']); socket.readyState = 3; },
    send: () => {},
    on: () => {},
    removeListener: () => {},
    setMaxListeners: () => {},
    setTimeout: () => {},
  };
  return { socket, calls };
}

test('同一设备连第二次时，第一条隧道必须被关闭（槽位不累积）', () => {
  const { server, core } = makeServer();
  const device = { id: 'dev_test_same', name: '手机' };

  const first = makeSocket();
  server.onConnection(first.socket, { url: '/ws' }, device);
  const bucket = server.wsClients.get(device.id);
  assert.equal(bucket?.size, 1, '第一条必须登记');

  const second = makeSocket();
  server.onConnection(second.socket, { url: '/ws?since=1' }, device);

  const closed = first.calls.filter(([kind]) => kind === 'close' || kind === 'terminate');
  assert.ok(closed.length > 0, '旧隧道必须被关掉，否则槽位只增不减');
  assert.equal(server.wsClients.get(device.id)?.size, 1, '同一设备只保留一条');
  assert.ok(core !== undefined);
});

test('不同设备互不影响（各自的隧道都留着）', () => {
  const { server } = makeServer();
  const phoneA = { id: 'dev_a', name: '手机A' };
  const phoneB = { id: 'dev_b', name: '手机B' };

  const a = makeSocket();
  const b = makeSocket();
  server.onConnection(a.socket, { url: '/ws' }, phoneA);
  server.onConnection(b.socket, { url: '/ws' }, phoneB);

  assert.equal(a.calls.length, 0, 'A 的隧道不该被 B 顶掉');
  assert.equal(server.wsClients.get(phoneA.id)?.size, 1);
  assert.equal(server.wsClients.get(phoneB.id)?.size, 1);
});
