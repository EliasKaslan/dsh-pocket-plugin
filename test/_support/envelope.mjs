/**
 * 协议测试的辅助工具（不是测试用例文件）。
 *
 * 为什么需要它：`lib/cloud.mjs` 只导出常量与 `CloudLink`，`seal`/`unseal` 是模块私有的。
 * 想证明「手机 → 电脑」这一方向（AAD = `topics.up`）能被真实代码解开，测试必须
 * 自己按线上信封格式封一帧喂给 `CloudLink.onFrame()`；同时要证明「电脑 → 手机」
 * （AAD = `topics.down`）真的封成了密文，还得自己解回来。
 *
 * 所以这里的 `sealFrame` / `openFrame` 是**线上信封格式的镜像**，不是被测对象：
 *   v1 信封 = {"v":1,"n":base64(iv 12B),"c":base64(密文‖GCM tag 16B)}，AAD 为 utf8 主题串。
 * 格式一旦变动，本文件的用例会红——这正是想要的：信封格式是被测契约的一部分。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { CloudLink } from '../../lib/cloud.mjs';

/** 两把固定钥匙：错钥匙用例要可复现，不要每次随机。 */
export const KEY_A = Buffer.alloc(32, 0x11);
export const KEY_B = Buffer.alloc(32, 0x22);

/**
 * 明文哨兵。密文里出现它就是灾难级 bug（E2EE 失效），用它断言「线上只有密文」。
 * 用带 `-` 的短语是刻意的：base64 字母表没有 `-`，所以随机巧合不可能命中。
 */
export const CANARY = 'PLAINTEXT-CANARY-2b7e';

/** 与 `lib/cloud.mjs` 的 `topics()` 完全一致：方向靠主题的 u/d 后缀区分。 */
export function topicsOf(room) {
  return { up: `dshm/${room}/u`, down: `dshm/${room}/d` };
}

/** `CloudLink` 要求 identity.key 解码后正好 32 字节，所以要转成 base64url。 */
export function identityFor({ room = 'roomA', key = KEY_A } = {}) {
  return {
    room,
    key: Buffer.from(key).toString('base64url'),
    token: 'test-token-not-used',
    deviceId: 'dev_test',
  };
}

/** 按线上格式封一帧；`version` 故意可覆盖，用来喂非法信封。 */
export function sealFrame({ key, aad, plaintext, version = 1 }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return JSON.stringify({
    v: version,
    n: iv.toString('base64'),
    c: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  });
}

/** 反向：用指定 AAD 解一帧，AAD 不对时 node 会抛 unable to authenticate。 */
export function openFrame({ key, aad, envelope }) {
  const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  const iv = Buffer.from(String(parsed.n ?? ''), 'base64');
  const blob = Buffer.from(String(parsed.c ?? ''), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
}

/**
 * 造一个不连网的 `CloudLink`：
 *  - `allowAnonymous: true` 只是为了让构造函数不进入 blocked（与鉴权无关，本文件不测鉴权）；
 *  - `state = 'online'` + 假 client 让 `publish()` 走真实的 `seal` 分支并把密文收集起来；
 *  - 不调用 `start()`，因此永远不会连真实 MQTT broker。
 */
export function makeLink({ room = 'roomA', key = KEY_A } = {}) {
  const link = new CloudLink({
    localPort: 1,
    identity: identityFor({ room, key }),
    auth: null,
    allowAnonymous: true,
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
  return { link, sent };
}

/** 收方向的一帧：给 `link.onFrame()` 喂 Buffer，就像 mqtt client 收到消息那样。 */
export function upFrame(link, plaintext, { key = link.key, room } = {}) {
  const aad = topicsOf(room ?? link.identity.room).up;
  return Buffer.from(sealFrame({ key, aad, plaintext }), 'utf8');
}
