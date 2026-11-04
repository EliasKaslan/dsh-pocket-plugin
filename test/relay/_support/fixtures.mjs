/**
 * test/relay 的共享夹具（不是测试用例文件，文件名不以 .test.mjs 结尾）。
 *
 * 这里只做三件事，且全部落在**被测模块的真实导出**上：
 *  1. 造一个「在线但不联网」的 CloudLink：`state='online'` + 假 client，于是
 *     `publish()` 走真实的 seal 分支、`onFrame()` 走真实的 unseal 分支，
 *     而 `mqtt.connect()` / `new WebSocket()` 永远不会被调用（不连 broker）。
 *  2. 按线上信封格式封一帧喂给 `onFrame()`。`seal`/`unseal` 是 lib/cloud.mjs 的
 *     模块私有函数：想证明「手机方向」的帧能被真实代码解开，这一侧只能自己封。
 *     该镜像已在 test/_support/envelope.mjs 里维护（信封格式是被测契约的一部分），
 *     这里直接复用，不复制第二份。
 *  3. 一次性临时目录（os.tmpdir），供 cloud-service 的身份文件落盘用。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CloudLink } from '../../../lib/cloud.mjs';
import { openFrame, sealFrame } from '../../_support/envelope.mjs';

/** 固定钥匙：错误钥匙 / 篡改用例要可复现，不能每次随机。 */
export const KEY = Buffer.alloc(32, 0x5a);
export const OTHER_KEY = Buffer.alloc(32, 0xa5);

/** 明文哨兵：base64 字母表没有 `-`，出现即代表 E2EE 失效，不会随机撞上。 */
export const CANARY = 'RELAY-PLAINTEXT-CANARY-9f3a';

/** 记录全部日志行的假 logger：用于「密钥/令牌不落日志」的断言。 */
export function makeLogger() {
  const lines = [];
  const push = (level) => (...args) => {
    lines.push(`${level} ${args.map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.message;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' ')}`);
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

export function identityFor({
  room = 'RoomRelay42',
  key = KEY,
  token = 'dshb_relay_token_0123456789abcdef',
  deviceId = 'dev_relay',
} = {}) {
  return { room, key: Buffer.from(key).toString('base64url'), token, deviceId };
}

/**
 * CloudLink 一旦 `start()` 就会 `mqtt.connect()`。测试里绝不调用 start()：
 * 直接把内部状态摆成「已在线 + 有 client」，让 publish/onFrame 走真实代码路径。
 */
export function makeLink({
  identity = identityFor(),
  auth = null,
  allowAnonymous = true,
  relayNonce,
  localPort = 47801,
  logger = makeLogger(),
} = {}) {
  const link = new CloudLink({
    localPort, identity, auth, allowAnonymous, relayNonce, logger,
  });
  const sent = [];
  link.state = 'online';
  link.client = {
    publish(topic, payload, _options, callback) {
      sent.push({ topic, payload: String(payload) });
      if (typeof callback === 'function') callback();
      return true;
    },
    end() {},
  };
  return { link, sent, logger };
}

/** 换一个 client：publish 回调收到 error，用于覆盖「发送失败」的日志路径。 */
export function failPublish(link, message = 'broker rejected') {
  link.client = {
    publish(_topic, _payload, _options, callback) {
      if (typeof callback === 'function') callback(new Error(message));
      return true;
    },
    end() {},
  };
}

/** 按线上格式封一帧（默认 AAD = 上行主题，即「手机 → 电脑」方向）。 */
export function frameFor(link, plaintext, { key = link.key, aad, version = 1 } = {}) {
  return Buffer.from(sealFrame({
    key,
    aad: aad ?? link.topics.up,
    plaintext: typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext),
    version,
  }), 'utf8');
}

/** 把一条明文当作手机发来的帧喂给真实 `onFrame()`。 */
export function feed(link, plaintext, options) {
  link.onFrame(frameFor(link, plaintext, options));
}

/** 用线上格式解开一条我们发出去的密文（AAD = 下行主题）。 */
export function openAsPhone(link, payload, { key = link.key } = {}) {
  return openFrame({ key, aad: link.topics.down, envelope: String(payload) });
}

/** 解开最近一条 MQTT 消息里的明文对象。 */
export function decodeLast(link, sent) {
  return JSON.parse(openAsPhone(link, sent[sent.length - 1].payload).toString('utf8'));
}

/** 解开全部消息。 */
export function decodeAll(link, sent) {
  return sent.map((entry) => JSON.parse(openAsPhone(link, entry.payload).toString('utf8')));
}

/**
 * 「手机端镜像」：同一把钥匙，但收/发主题与电脑相反（手机订阅电脑的 down 主题）。
 * 用它可以证明「电脑 publish 的密文能被真实 unseal 还原」，而不需要再写一份 seal。
 */
export function makePeer(sender, { room = sender.identity.room, key = KEY } = {}) {
  const peer = new CloudLink({
    localPort: 1,
    identity: identityFor({ room, key }),
    allowAnonymous: true,
    logger: makeLogger(),
  });
  peer.topics = { up: sender.topics.down, down: sender.topics.up };
  peer.state = 'online';
  const seen = [];
  peer.client = { publish() {}, end() {} };
  peer.dispatch = (message) => { seen.push(message); };
  return { peer, seen };
}

/** 轮询等待一个异步副作用出现（handleRequest 是 async 的）。 */
export async function waitFor(predicate, { timeout = 3000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

/**
 * 桩掉 globalThis.fetch：handleRequest 只用全局 fetch，桩住它即可验证
 * 「哪些请求真的被转发、转发了什么头」，全程不出本机。
 */
export function stubFetch(body = '{"ok":true}', { status = 200, headers = { 'content-type': 'application/json' }, onCall } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (typeof onCall === 'function') onCall(call);
    return new Response(body, { status, headers });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 一次性临时目录；返回 dir 与幂等的清理函数（不碰 %USERPROFILE%\.dsh）。 */
export function tempDir(prefix = 'dsh-pocket-relay-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  let removed = false;
  return {
    dir,
    cleanup() {
      if (removed) return;
      removed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
