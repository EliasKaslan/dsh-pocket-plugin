/**
 * lib/cloud-service.mjs —— 中继的生命周期、配置归一化与错误路径（补覆盖用）。
 *
 * 约束（与 test/relay/cloud-service-identity.test.mjs 同一条线）：
 *  - 全部目录在 os.tmpdir() 下，after() 统一清理；
 *  - **不联网**：broker 一律指向 `ws://127.0.0.1:9/...`（本机 closed 端口），
 *    只证明「连不上 → 状态里能看见原因」，绝不真的连任何外部 MQTT；
 *  - 不进 ~/.dsh、不占固定端口、不留常驻进程（每个用例结束都 stop/dispose）。
 *
 * 关键：`start()` 的「已存在 link」分支用假 link（localPort 相同即复用），
 * 只有必须验证 `new CloudLink` 之后那几步的用例才让真实 CloudLink 起一次，
 * 而且指向本机 closed 端口。
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { CloudService } from '../../lib/cloud-service.mjs';
import { makeLogger, tempDir } from './_support/fixtures.mjs';

const tmp = tempDir('dsh-pocket-cloud-lifecycle-');
const cores = [];
let counter = 0;

/** 本机 closed 端口：connect 必然失败，且不出网。 */
const DEAD_BROKER = 'ws://127.0.0.1:9/mqtt';
const APP_BASE = 'https://shell.example/app/';

function makeContext() {
  counter += 1;
  const home = path.join(tmp.dir, `home-${counter}`);
  const dataDir = path.join(home, 'pocket');
  mkdirSync(dataDir, { recursive: true });
  const logger = makeLogger();
  const core = new BridgeCore({}, { home, dataDir, port: 47901 }, logger);
  cores.push(core);
  return { core, dataDir, logger, home };
}

function makeService(context, config = {}, { auth, authRequired } = {}) {
  const service = new CloudService(context.core, {
    logger: context.logger, dataDir: context.dataDir, config, auth, authRequired,
  });
  context.service = service;
  return service;
}

const okAuth = (overrides = {}) => ({
  enabled: true,
  user: 'owner',
  assertUsable() {},
  check: () => null,
  login: () => ({ ok: false, reason: 'bad_credentials' }),
  logout: () => false,
  info: () => ({ enabled: true, user: 'owner', configured: true, required: true }),
  ...overrides,
});

/** 一个不碰网络的假 link：用来打「复用 / 端口变化 / 状态读取」这些分支。 */
function fakeLink({ localPort = 5000, startResult = true, state = 'online', status, stopThrows = false } = {}) {
  return {
    localPort,
    state,
    start() { return startResult; },
    stop() {
      if (stopThrows) throw new Error('stop exploded');
      this.stopped = true;
    },
    status() {
      if (typeof status === 'function') return status();
      return {
        state, broker: 'ws://fake', room: 'RoomFake', url: 'https://x/y', deviceId: 'dev_fake',
        stats: {}, lastError: '', guard: { blocked: null },
      };
    },
  };
}

after(() => {
  for (const core of cores) {
    try { core.dispose(); } catch { /* 已经关了 */ }
  }
  tmp.cleanup();
});

/* ------------------------------------------------------------------ */
/* 构造期：配置归一化                                                   */
/* ------------------------------------------------------------------ */

test('构造：broker 归一化（去重 / 跳过非字符串与非法 scheme / 空值回退默认 / 最多 4 个）', () => {
  const context = makeContext();

  const defaults = makeService(context, {});
  assert.deepEqual(defaults.config.broker, ['wss://broker-cn.emqx.io:8084/mqtt'], '没有配置时回退 DEFAULT_BROKERS');
  assert.equal(defaults.config.enabled, true, '默认启用');
  assert.equal(defaults.config.allowAnonymous, false, '匿名模式必须显式开启');
  assert.equal(defaults.state, 'idle');
  assert.equal(defaults.enabled, false);

  const list = makeService(context, {
    broker: [
      '  ws://a.example/mqtt  ', 'ws://a.example/mqtt', 42, null, '', '   ',
      'http://not-a-broker', 'mqtt://b.example:1883', 'mqtts://c.example', 'wss://d.example', 'ws://e.example',
    ],
  });
  assert.deepEqual(list.config.broker, [
    'ws://a.example/mqtt', 'mqtt://b.example:1883', 'mqtts://c.example', 'wss://d.example',
  ], '去重 + trim + 丢弃非法 scheme + 截到 4 个');

  const single = makeService(context, { broker: 'ws://only.example/mqtt' });
  assert.deepEqual(single.config.broker, ['ws://only.example/mqtt'], '单个字符串也接受');

  const allBad = makeService(context, { broker: ['http://x', 'gopher://y'] });
  assert.deepEqual(allBad.config.broker, ['wss://broker-cn.emqx.io:8084/mqtt'], '全部非法 → 回退默认');
});

test('构造：appBase 归一化（去 query/fragment、拒绝非 http(s) 与非空 userinfo、空值给默认）', () => {
  const context = makeContext();
  const cases = [
    [{}, ''],
    [{ appBase: '' }, ''],
    [{ appBase: '   ' }, ''],
    [{ appBase: 42 }, ''],
    [{ appBase: 'https://shell.example/app/?a=1#frag' }, 'https://shell.example/app/'],
    [{ appBase: 'https://shell.example' }, 'https://shell.example/'],
    [{ appBase: 'not a url' }, ''],
    [{ appBase: 'ftp://shell.example/app/' }, ''],
    [{ appBase: 'javascript:alert(1)' }, ''],
    [{ appBase: 'https://user:pass@shell.example/' }, ''],
    [{ appBase: 'https://user@shell.example/' }, ''],
    [{ appBase: '  https://shell.example/app/  ' }, 'https://shell.example/app/'],
  ];
  for (const [config, expected] of cases) {
    const service = makeService(context, config);
    assert.equal(service.appBase, expected, `appBase=${JSON.stringify(config.appBase)} 应归一化为 ${JSON.stringify(expected)}`);
    assert.equal(service.config.appBase, expected);
  }
});

test('构造：enabled=false 直接落 disabled 状态；非对象 config 当作空对象', () => {
  const context = makeContext();
  const off = makeService(context, { enabled: false, appBase: APP_BASE });
  assert.equal(off.state, 'disabled');
  assert.equal(off.config.enabled, false);

  for (const config of [null, undefined, 'nope', 42, []]) {
    const service = makeService(context, config);
    assert.equal(service.config.enabled, true, `config=${String(config)} 不该把服务搞崩`);
    assert.equal(service.state, 'idle');
  }
});

test('构造：core.setCloud 被调用（宿主能从 core 反查到云服务）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE });
  assert.equal(context.core.cloud, service);
});

/* ------------------------------------------------------------------ */
/* start()：每一道闸                                                     */
/* ------------------------------------------------------------------ */

test('start：端口非法（0 / 负数 / 小数 / 越界 / 非数字）→ error，不抛', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  for (const port of [0, -1, 1.5, 65_536, 100_000, Number.NaN, '8080', null, undefined]) {
    const state = service.start(port);
    assert.equal(state, 'error', `port=${String(port)} 应该是 error`);
    assert.equal(service.state, 'error');
    assert.equal(service.lastError, '监听端口无效，远程访问未启动');
    assert.equal(service.port, 0, '非法端口不许写进 this.port');
  }
  assert.equal(service.link, undefined, '非法端口不许建链');
});

test('start：enabled=false → disabled（且不生成身份、不建链）', () => {
  const context = makeContext();
  const service = makeService(context, { enabled: false, appBase: APP_BASE }, { auth: okAuth() });
  assert.equal(service.start(47901), 'disabled');
  assert.equal(service.state, 'disabled');
  assert.equal(service.port, 47_901, '合法端口仍然要记下来（供 setEnabled 复用）');
  assert.equal(service.identity, undefined);
  assert.equal(service.link, undefined);
});

test('start：appBase 为空 → unconfigured，且只告警一次（warnedOnce）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: '' }, { auth: okAuth() });
  assert.equal(service.start(47901), 'unconfigured');
  assert.match(service.lastError, /未配置 cloud\.appBase/u);
  assert.equal(service.warnedOnce, true);
  assert.equal(context.logger.lines.filter((line) => line.includes('cloud.appBase')).length, 1);

  assert.equal(service.start(47902), 'unconfigured');
  assert.equal(context.logger.lines.filter((line) => line.includes('cloud.appBase')).length, 1,
    '第二次启动不许重复刷同一条告警');

  // 非法 URL 和「没配」走同一个出口（都是空字符串）
  const invalid = makeService(makeContext(), { appBase: 'not a url' }, { auth: okAuth() });
  assert.equal(invalid.start(47901), 'unconfigured');
});

test('start：鉴权组件缺失 → error；assertUsable 抛 auth_missing_credentials → blocked；其它错误 → error', () => {
  const missing = makeService(makeContext(), { appBase: APP_BASE });
  assert.equal(missing.start(47901), 'error');
  assert.equal(missing.lastError, '鉴权组件缺失，远程访问未启动');
  assert.equal(missing.link, undefined);

  const noPassword = makeService(makeContext(), { appBase: APP_BASE }, {
    auth: okAuth({ assertUsable() { const error = new Error('还没有设置访问口令'); error.code = 'auth_missing_credentials'; throw error; } }),
  });
  assert.equal(noPassword.start(47901), 'blocked', '没口令是「待设置」，不是「坏了」');
  assert.equal(noPassword.lastError, '还没有设置访问口令');
  assert.equal(noPassword.link, undefined);

  const broken = makeService(makeContext(), { appBase: APP_BASE }, {
    auth: okAuth({ assertUsable() { throw new Error('auth 模块自检失败'); } }),
  });
  assert.equal(broken.start(47901), 'error');
  assert.equal(broken.lastError, 'auth 模块自检失败');
  assert.equal(broken.link, undefined);
});

test('start：已有同端口 link 时复用（不重建、不重新建连）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  const link = fakeLink({ localPort: 5000, startResult: true, state: 'online' });
  service.link = link;
  service.port = 5000;

  assert.equal(service.start(5000), 'online');
  assert.equal(service.link, link, '必须复用同一个 link 实例');
  assert.equal(service.enabled, true);
  assert.equal(link.stopped, undefined, '复用时不许 stop');

  // 复用但 start() 失败 → enabled=false 且状态跟着 link
  const failing = makeService(makeContext(), { appBase: APP_BASE }, { auth: okAuth() });
  failing.link = fakeLink({ localPort: 6000, startResult: false, state: 'blocked' });
  assert.equal(failing.start(6000), 'blocked');
  assert.equal(failing.enabled, false);
});

test('start：端口变化 → 先 stop 旧 link 再重建（旧 link 不残留）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  const oldLink = fakeLink({ localPort: 5000 });
  service.link = oldLink;
  service.port = 5000;

  // 让重建这一步停在「生成身份失败」，这样既能验证 stop 也被执行，
  // 又完全不用真的起一条 MQTT 连接。
  service.ensureIdentity = () => { throw new Error('device limit reached'); };
  assert.equal(service.start(6000), 'error');
  assert.equal(oldLink.stopped, true, '端口变化必须停掉旧 link');
  assert.equal(service.link, undefined);
  assert.equal(service.state, 'error');
  assert.match(service.lastError, /无法生成中继身份：device limit reached/u);
  assert.equal(service.port, 6000);
});

test('start：生成身份抛错（设备上限/写盘失败）不冒泡，只把状态标成 error', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  service.ensureIdentity = () => { throw new Error('device_limit'); };
  assert.equal(service.start(47901), 'error', 'start() 只回报状态，不许把异常抛给调用方');
  assert.match(service.lastError, /无法生成中继身份：device_limit/u);
  assert.ok(context.logger.lines.some((line) => line.startsWith('error 无法生成中继身份')));
});

test('start：真实 CloudLink 建链后立即 stop（broker 指向本机 closed 端口，不出网）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE, broker: DEAD_BROKER, allowAnonymous: true }, { auth: okAuth() });
  const state = service.start(47901);
  try {
    assert.equal(state, 'connecting', '刚建链时状态是 connecting（还没连上）');
    assert.equal(service.enabled, true);
    assert.notEqual(service.link, undefined);
    assert.equal(service.link.localPort, 47_901);
    assert.equal(service.lastError, '');
    assert.ok(context.logger.lines.some((line) => line.includes('远程访问已启动')), '成功路径必须留 info');
  } finally {
    service.stop();
  }
  assert.equal(service.link, undefined, 'stop 之后不许残留 link');
  assert.equal(service.enabled, false);
  assert.equal(service.state, 'disabled');
});

test('start：中继被 guard 拒绝启动（无口令又没开匿名）→ 状态 blocked，lastError 取 guard 原因', () => {
  const context = makeContext();
  // auth.enabled === false + allowAnonymous !== true → CloudLink 自建时就带上 blocked
  const service = makeService(context, { appBase: APP_BASE, broker: DEAD_BROKER }, {
    auth: okAuth({ enabled: false }),
  });
  const state = service.start(47901);
  try {
    assert.equal(state, 'blocked');
    assert.equal(service.enabled, false);
    // this.lastError 是通用文案（CloudLink 的 blocked 原因不进 lastError），
    // 真正的原因靠 status() 从 guard.blocked 里取出来给配对页。
    assert.equal(service.lastError, '远程中继拒绝启动');
    assert.match(service.status().lastError, /未设置访问口令/u, 'blocked 的原因必须能透出到状态里');
    assert.ok(context.logger.lines.some((line) => line.startsWith('error 远程访问未启动：') && line.includes('未设置访问口令')),
      `guard 的原因必须进日志，实际：${context.logger.lines.filter((line) => line.includes('远程访问未启动')).join(' | ')}`);
  } finally {
    service.stop();
  }
});

/* ------------------------------------------------------------------ */
/* 真实连接失败（不联网：本机 closed 端口）                              */
/* ------------------------------------------------------------------ */

test('relay 连接失败：错误与 offline 状态会经 status() 透出，且 stop 后不再重连', async () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE, broker: DEAD_BROKER, allowAnonymous: true }, { auth: okAuth() });
  service.start(47901);
  try {
    const deadline = Date.now() + 4000;
    let status;
    while (Date.now() < deadline) {
      status = service.status();
      if (status.state === 'offline' && String(status.lastError).length > 0) break;
      // 被 await 的定时器不能 unref（Node 22 会因此取消整个文件）。
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    assert.equal(status.state, 'offline', `没连上必须落到 offline，实际 ${status.state}`);
    assert.match(String(status.lastError), /ECONNREFUSED|ECONNRESET|connect/u, `必须把真实原因带出来，实际 ${status.lastError}`);
    assert.ok(status.stats.errors >= 1, '失败计数必须增加');
    assert.equal(status.enabled, true, '还在启用状态（只是连不上）');
    assert.equal(status.guard.blocked, null);
  } finally {
    service.stop();
  }
  assert.equal(service.state, 'disabled');
  assert.equal(service.status().state, 'disabled');
});

/* ------------------------------------------------------------------ */
/* stop / dispose / setEnabled                                          */
/* ------------------------------------------------------------------ */

test('stop：没有 link 时安全；link.stop() 抛错只告警不冒泡', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE });
  assert.doesNotThrow(() => service.stop());
  assert.equal(service.state, 'disabled');

  service.link = fakeLink({ stopThrows: true });
  service.enabled = true;
  assert.doesNotThrow(() => service.stop());
  assert.equal(service.state, 'disabled');
  assert.equal(service.enabled, false);
  assert.equal(service.link, undefined, '即使 stop 抛错也必须把 link 清掉');
  assert.ok(context.logger.lines.some((line) => line.includes('停止远程中继时出错')));

  service.link = fakeLink();
  service.dispose();
  assert.equal(service.link, undefined, 'dispose 等价于 stop');
});

test('setEnabled：关掉时停链；打开但还没有端口时回 idle；有端口则真的 start', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });

  assert.equal(service.setEnabled(false), false);
  assert.equal(service.config.enabled, false);
  assert.equal(service.state, 'disabled');

  // port 还是 0 → 只回 idle
  assert.equal(service.setEnabled(true), false);
  assert.equal(service.state, 'idle');
  assert.equal(service.link, undefined);

  // 有端口 + 有可用 link → 走复用分支，返回 enabled
  service.port = 5000;
  service.link = fakeLink({ localPort: 5000, startResult: true, state: 'online' });
  assert.equal(service.setEnabled(true), true);
  assert.equal(service.state, 'online');
  assert.equal(service.enabled, true);

  assert.equal(service.setEnabled(false), false);
  assert.equal(service.link, undefined);
});

/* ------------------------------------------------------------------ */
/* setBroker / rotate                                                   */
/* ------------------------------------------------------------------ */

test('setBroker：非法输入一律 bad_broker（空 / 超 4 个 / 非字符串 / scheme 不对）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE });
  const invalid = [
    [], ['', '   '], [42, null], ['http://x'], ['no-scheme'], ['ws://a', 'ws://b', 'ws://c', 'ws://d', 'ws://e'],
  ];
  for (const value of invalid) {
    assert.throws(() => service.setBroker(value), (error) => {
      assert.equal(error.code, 'bad_broker');
      assert.match(error.message, /中转地址不合法/u);
      return true;
    }, `${JSON.stringify(value)} 应该被拒`);
  }
  assert.deepEqual(service.config.broker, ['wss://broker-cn.emqx.io:8084/mqtt'], '非法输入不许改坏现有配置');
});

test('setBroker：合法输入更新配置并去重；未启用时只改配置不重启', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE });
  const status = service.setBroker([' ws://a.example/mqtt ', 'ws://a.example/mqtt', 'wss://b.example']);
  assert.deepEqual(service.config.broker, ['ws://a.example/mqtt', 'wss://b.example']);
  assert.equal(status.broker, 'ws://a.example/mqtt');
  assert.equal(service.link, undefined, 'port=0 时不许建链');

  // 单值也接受
  service.setBroker('mqtts://c.example:8883');
  assert.deepEqual(service.config.broker, ['mqtts://c.example:8883']);
});

test('setBroker：已启用时换 broker 会停旧链并重建（重建失败也不抛）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  const oldLink = fakeLink({ localPort: 5000 });
  service.link = oldLink;
  service.port = 5000;
  service.config.enabled = true;

  service.ensureIdentity = () => { throw new Error('identity unavailable'); };
  const status = service.setBroker('ws://new.example/mqtt');
  assert.equal(oldLink.stopped, true, '换 broker 必须停掉旧链');
  assert.deepEqual(service.config.broker, ['ws://new.example/mqtt']);
  assert.equal(service.state, 'error', '重建失败只体现在状态里，setBroker 本身不抛');
  assert.match(status.lastError, /无法生成中继身份/u);

  // 没有 link、port>0 且 enabled：直接 start（同样失败进 error，不抛）
  const noLink = makeService(makeContext(), { appBase: APP_BASE }, { auth: okAuth() });
  noLink.port = 5000;
  noLink.ensureIdentity = () => { throw new Error('nope'); };
  assert.equal(noLink.setBroker('ws://x.example').state, 'error');
});

test('rotate：停链 + 撤身份 + 重新启用；port=0 时不启动；旧令牌失效', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  const first = service.ensureIdentity();
  const oldLink = fakeLink({ localPort: 5000 });
  service.link = oldLink;
  service.port = 0;

  const status = service.rotate();
  assert.equal(oldLink.stopped, true, 'rotate 必须先停链');
  assert.equal(service.link, undefined);
  assert.equal(context.core.authenticateToken(first.token), undefined, '旧令牌必须立刻失效');
  assert.equal(status.state, 'disabled');
  assert.equal(service.config.enabled, true, 'rotate 不该顺手把功能关掉');

  // 有端口时 rotate 会重新 start：让它停在身份生成失败，避免真的建链
  const withPort = makeService(makeContext(), { appBase: APP_BASE }, { auth: okAuth() });
  withPort.port = 5000;
  withPort.config.enabled = true;
  withPort.ensureIdentity = () => { throw new Error('blocked identity'); };
  assert.equal(withPort.rotate().state, 'error');
  assert.equal(withPort.port, 5000);
});

/* ------------------------------------------------------------------ */
/* status() / authInfo()                                                */
/* ------------------------------------------------------------------ */

test('status：没有 link 时给出完整基线（url 空、broker 首个、auth 三态）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth(), authRequired: true });
  const status = service.status();
  assert.equal(status.enabled, false);
  assert.equal(status.state, 'idle');
  assert.equal(status.port, 0);
  assert.equal(status.url, '');
  assert.equal(status.broker, 'wss://broker-cn.emqx.io:8084/mqtt');
  assert.equal(status.appBase, APP_BASE);
  assert.equal(status.allowAnonymous, false);
  assert.equal(status.phone, null);
  assert.equal(status.lastPhoneAt, 0);
  assert.deepEqual(status.stats, {});
  assert.equal(status.lastError, '');
  assert.deepEqual(status.auth, { enabled: true, user: 'owner', configured: true, required: true });

  const anonymous = makeService(makeContext(), { appBase: APP_BASE, allowAnonymous: true });
  assert.equal(anonymous.status().allowAnonymous, true);
  assert.deepEqual(anonymous.status().auth, { required: false, configured: false, enabled: false });
});

test('status：有 link 时合并 link 状态，并强制 enabled/port/appBase 以本服务为准', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  service.port = 5100;
  service.enabled = true;
  service.state = 'online';
  service.link = fakeLink({
    localPort: 5100,
    status: () => ({
      state: 'online',
      broker: 'ws://link.example',
      room: 'RoomLink',
      url: 'https://shell.example/app/#r',
      deviceId: 'dev_link',
      stats: { rx: 3 },
      lastError: '',
      guard: { blocked: null },
      enabled: false,
      port: 1,
      appBase: 'https://wrong.example/',
    }),
  });
  const status = service.status();
  assert.equal(status.room, 'RoomLink');
  assert.equal(status.url, 'https://shell.example/app/#r');
  assert.equal(status.stats.rx, 3);
  assert.equal(status.enabled, true, 'link 说 false 也以本服务为准');
  assert.equal(status.port, 5100);
  assert.equal(status.appBase, APP_BASE);
  assert.deepEqual(status.auth, { enabled: true, user: 'owner', configured: true, required: true });
});

test('status：link.status() 抛错 → 回落基线并告警，不把状态页搞崩', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  service.link = fakeLink({ status: () => { throw new Error('status exploded'); } });
  const status = service.status();
  assert.equal(status.state, 'idle', '回落到基线状态');
  assert.equal(status.url, '');
  assert.ok(context.logger.lines.some((line) => line.includes('读取远程中继状态失败')));
});

test('status：link 的 guard.blocked 原因在没有 lastError 时透出（配对页要能解释为什么拒启）', () => {
  const context = makeContext();
  const service = makeService(context, { appBase: APP_BASE }, { auth: okAuth() });
  service.link = fakeLink({
    status: () => ({
      state: 'blocked', broker: 'b', room: 'r', url: '', deviceId: 'd', stats: {},
      lastError: '', guard: { blocked: { code: 'auth-required', message: '未设置访问口令' } },
    }),
  });
  assert.equal(service.status().lastError, '未设置访问口令');
});

test('authInfo：auth 缺失 / info() 抛错 都回落到 required+未配置', () => {
  const context = makeContext();
  const missing = makeService(context, { appBase: APP_BASE }, { authRequired: true });
  assert.deepEqual(missing.authInfo(), { required: true, configured: false, enabled: false });

  const throwing = makeService(makeContext(), { appBase: APP_BASE }, {
    auth: okAuth({ info() { throw new Error('auth info exploded'); } }),
    authRequired: true,
  });
  assert.deepEqual(throwing.authInfo(), { required: true, configured: false, enabled: false });

  // status() 里也要能落到这个兜底
  const status = throwing.status();
  assert.deepEqual(status.auth, { required: true, configured: false, enabled: false });
});

/* ------------------------------------------------------------------ */
/* 身份文件的边界（与 identity 测试互补，不重复）                        */
/* ------------------------------------------------------------------ */

test('loadIdentity：token 太短 / deviceId 为空 → 视为损坏，重新生成并告警', () => {
  const context = makeContext();
  mkdirSync(context.dataDir, { recursive: true });
  writeFileSync(path.join(context.dataDir, 'cloud.json'), JSON.stringify({
    room: 'RoomShort1',
    key: Buffer.alloc(32, 3).toString('base64url'),
    token: 'short',
    deviceId: '',
  }), 'utf8');

  const service = makeService(context, { appBase: APP_BASE });
  assert.equal(service.loadIdentity(), undefined);
  assert.ok(context.logger.lines.some((line) => line.includes('内容不完整')));

  const identity = service.ensureIdentity();
  assert.equal(identity.room === 'RoomShort1', false);
  assert.equal(identity.token.length >= 20, true);
});

test('saveIdentity：写失败（目标路径是目录）只记录 error 日志，身份仍然可用', () => {
  const context = makeContext();
  mkdirSync(path.join(context.dataDir, 'cloud.json'), { recursive: true });
  const service = makeService(context, { appBase: APP_BASE });
  const identity = service.ensureIdentity();
  assert.equal(Buffer.from(identity.key, 'base64url').length, 32);
  assert.ok(context.logger.lines.some((line) => line.includes('远程链接身份写入失败')));
  assert.deepEqual(service.identity, identity);
});
