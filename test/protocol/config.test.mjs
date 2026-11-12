/**
 * 配置与协议编号（lib/core.mjs + lib/cloud.mjs + lib/util.mjs 的纯函数部分）。
 *
 * 这里最重要的是两条回归：默认 authRequired 必须 fail-closed；
 * DEFAULT_APP_BASE 必须为空（不许把某个人的静态托管站写死成默认外壳）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  CLOUD_PROTOCOL, DEFAULT_APP_BASE, DEFAULT_BROKERS, PUBLIC_APP_BASE, SEAL_VERSION, buildLinkUrl,
} from '../../lib/cloud.mjs';
import { DEFAULT_CONFIG, normalizeConfig, resolvePaths } from '../../lib/core.mjs';
import { PROTOCOL_VERSION } from '../../lib/util.mjs';

/** 记录 warn 的假 logger：normalizeConfig 的降级路径要靠它断言。 */
function recorder() {
  const warnings = [];
  return { warnings, info() {}, error() {}, warn: (...args) => warnings.push(args.join(' ')) };
}

/*
 * 三个编号长得像，但**根本不是同一个东西**，混用就是线上事故：
 *   CLOUD_PROTOCOL   = 2 —— MQTT 中继的帧协议版本（hello/req/ws.open 的 `ver` 字段，
 *                            2 表示带 seq/ts/sid 重放防护与显式 reject 帧）。
 *   SEAL_VERSION     = 1 —— AES-256-GCM 信封格式版本（信封里的 `v` 字段）。
 *   PROTOCOL_VERSION = 1 —— 本机 HTTP/WS API 的协议版本（/hello、/api/v1/* 的 `protocol`）。
 * SEAL_VERSION 与 PROTOCOL_VERSION 恰好都等于 1 是巧合，不是同一个常量：
 * 改信封格式只该动 SEAL_VERSION，加 HTTP 路由只该动 PROTOCOL_VERSION。
 * 所以下面的断言分别盯着「值」和「谁在用我」两件事。
 */
test('三个协议编号各自独立：CLOUD_PROTOCOL=2 / SEAL_VERSION=1 / PROTOCOL_VERSION=1', () => {
  assert.equal(CLOUD_PROTOCOL, 2, '中继帧协议是 v2（带 seq/ts/sid 重放防护）');
  assert.equal(SEAL_VERSION, 1, 'AES-GCM 信封格式是 v1');
  assert.equal(PROTOCOL_VERSION, 1, '本机 HTTP/WS API 协议是 v1');

  // 至少有一对必须真的不同，否则「不许混用」就没有可验证的抓手。
  assert.notEqual(CLOUD_PROTOCOL, PROTOCOL_VERSION, '把中继帧版本当成 HTTP 协议版本就是 BUG');

  // 三个常量来自三个不同模块，不能用其中一个去顶另一个。
  assert.equal(typeof SEAL_VERSION, 'number');
  assert.equal(JSON.stringify({ ver: CLOUD_PROTOCOL, v: SEAL_VERSION, protocol: PROTOCOL_VERSION }),
    '{"ver":2,"v":1,"protocol":1}');
});

test('DEFAULT_APP_BASE 必须是空串：默认外壳地址不能指向任何第三方站点', () => {
  assert.equal(DEFAULT_APP_BASE, '');
  assert.equal(PUBLIC_APP_BASE, DEFAULT_APP_BASE, '已废弃的别名不能偷偷指向别处');
  // 中继 broker 有默认值是有意的（它只看到密文），但外壳地址没有默认值。
  assert.equal(DEFAULT_BROKERS.length, 1);
  assert.match(DEFAULT_BROKERS[0], /^wss:\/\//u);
});

test('appBase 为空时 buildLinkUrl 抛 app-base-missing，而不是编一个地址出来', () => {
  assert.throws(
    () => buildLinkUrl({ appBase: '', room: 'r1', key: 'k1', token: 't1' }),
    (error) => error.code === 'app-base-missing',
  );
  assert.throws(
    () => buildLinkUrl({ appBase: 'file:///tmp/x', room: 'r1', key: 'k1', token: 't1' }),
    (error) => error.code === 'app-base-invalid',
  );
  const url = buildLinkUrl({ appBase: 'https://shell.example/app', room: 'r1', key: 'k1', token: 't1' });
  assert.match(url, /^https:\/\/shell\.example\/app#/u);
  assert.match(url, /r=r1/u);
});

test('normalizeConfig({}).authRequired === true（fail-closed 回归）', () => {
  const logger = recorder();
  assert.equal(normalizeConfig({}, logger).authRequired, true);
  assert.equal(DEFAULT_CONFIG.authRequired, true, 'DEFAULT_CONFIG 本身就是 fail-closed 的');
  assert.equal(normalizeConfig(undefined, logger).authRequired, true, '未传配置也必须 fail-closed');
  assert.equal(normalizeConfig(null, logger).authRequired, true);
  assert.equal(logger.warnings.length, 0, '默认值不该触发任何告警');
});

test('只有显式的 false 能关掉 authRequired，别的一律当 true', () => {
  assert.equal(normalizeConfig({ authRequired: false }).authRequired, false);
  assert.equal(normalizeConfig({ authRequired: true }).authRequired, true);
  assert.equal(normalizeConfig({ authRequired: 0 }).authRequired, true, '0 不是显式 false');
  assert.equal(normalizeConfig({ authRequired: 'false' }).authRequired, true, '字符串不是显式 false');
  assert.equal(normalizeConfig({ authRequired: undefined }).authRequired, true);
  // 兼容旧配置形状：auth: { required: false } 等价于 authRequired:false。
  assert.equal(normalizeConfig({ auth: { required: false } }).authRequired, false);
  assert.equal(normalizeConfig({ auth: { required: true } }).authRequired, true);
  assert.equal(normalizeConfig({ auth: {} }).authRequired, true);
});

test('resolvePaths 用显式目录，绝不推断到真实 home', () => {
  const home = path.resolve('C:/tmp/e2e-home');
  const dataDir = path.resolve('C:/tmp/e2e-data');
  const paths = resolvePaths({ home, dataDir });
  assert.equal(paths.home, home);
  assert.equal(paths.dataDir, dataDir);
  // 只给 home 时，dataDir 落在 home/pocket。
  assert.equal(resolvePaths({ home }).dataDir, path.join(home, 'pocket'));
  // 空白字符串不算「给了」。
  assert.equal(resolvePaths({ home: '  ', dataDir }).home, resolvePaths({}).home);
  assert.ok(path.isAbsolute(resolvePaths({}).home));
});

test('normalizeConfig 清洗端口（host 已不是配置项）', () => {
  assert.equal(normalizeConfig({ port: 8081 }).port, 8081);
  assert.equal(normalizeConfig({ port: 0 }).port, DEFAULT_CONFIG.port, '0 不是合法端口，回退');
  assert.equal(normalizeConfig({ port: 70000 }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 'abc' }).port, DEFAULT_CONFIG.port);

  // 只监听回环之后，host 不再是一个配置项：默认表里没有，结果对象里也不该有。
  assert.equal('host' in DEFAULT_CONFIG, false, 'DEFAULT_CONFIG 不许再带 host');
  assert.equal('host' in normalizeConfig({}), false, '没配 host 时 config 上不该出现 host');
});

test('allowedHosts 只接受干净的值', () => {
  assert.deepEqual(
    normalizeConfig({ allowedHosts: ['A.example', 'a.example', 'bad host!', 'phone.local:47901'] }).allowedHosts,
    ['a.example', 'phone.local'],
    '去重 + 丢弃非法字符 + 去掉端口',
  );
});

/*
 * 旧配置兼容：v1 允许 `host: '0.0.0.0'`，v2 只监听 127.0.0.1。
 * 升级后配置文件里往往还留着这个键 —— 必须「忽略 + 告警 + 不崩」，
 * 而不是三种更糟的结局：抛错、静默照配、或者把 host 原样透传进 config
 * 让人以为「配了但没生效」。
 */
test('旧配置里的 host:0.0.0.0 被忽略：不抛错、warn 一次、config 上不留 host 键', () => {
  const logger = recorder();
  let config;
  assert.doesNotThrow(() => {
    config = normalizeConfig({ host: '0.0.0.0', port: 48123 }, logger);
  }, '老配置不能让插件起不来');

  assert.equal('host' in config, false, 'host 不许跟着对象展开漏进 config');
  assert.equal(config.host, undefined);
  assert.equal(config.port, 48123, '忽略 host 不该连累其它字段');

  const hostWarnings = logger.warnings.filter((line) => line.includes('host'));
  assert.equal(hostWarnings.length, 1, `host 必须告警且只告警一次，实际：${JSON.stringify(logger.warnings)}`);
  assert.match(hostWarnings[0], /127\.0\.0\.1/u, '告警必须说清楚只监听回环，否则用户以为还能开回局域网');
});

/*
 * 旧配置兼容：设备数量曾经有上限（`maxDevices`，默认 8）。上限已取消，
 * 升级后配置文件里往往还留着这个键 —— 必须「忽略 + 告警 + 不崩」，
 * 而不是三种更糟的结局：抛错、静默照配（用户以为上限还在）、
 * 或者把 maxDevices 原样透传进 config 让人以为「配了但没生效」。
 */
test('旧配置里的 maxDevices 被忽略：不抛错、warn 一次、config 上不留这个键', () => {
  const logger = recorder();
  let config;
  assert.doesNotThrow(() => {
    config = normalizeConfig({ maxDevices: 999, port: 48124 }, logger);
  }, '老配置不能让插件起不来');

  assert.equal('maxDevices' in config, false, 'maxDevices 不许跟着对象展开漏进 config');
  assert.equal(config.maxDevices, undefined);
  assert.equal('maxDevices' in DEFAULT_CONFIG, false, '默认表里也不许再出现 maxDevices');
  assert.equal(config.port, 48124, '忽略 maxDevices 不该连累其它字段');

  const warnings = logger.warnings.filter((line) => line.includes('maxDevices'));
  assert.equal(warnings.length, 1, `maxDevices 必须告警且只告警一次，实际：${JSON.stringify(logger.warnings)}`);

  // 没配这个键时不该有噪音。
  const quiet = recorder();
  normalizeConfig({}, quiet);
  assert.deepEqual(quiet.warnings, [], '没配 maxDevices 时不该告警');
});
