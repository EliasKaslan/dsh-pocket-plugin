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

test('normalizeConfig 清洗端口 / host / 配额', () => {
  const logger = recorder();
  assert.equal(normalizeConfig({ port: 8081 }).port, 8081);
  assert.equal(normalizeConfig({ port: 0 }).port, DEFAULT_CONFIG.port, '0 不是合法端口，回退');
  assert.equal(normalizeConfig({ port: 70000 }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 'abc' }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ host: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(normalizeConfig({ host: 'evil.example' }, logger).host, '0.0.0.0', '非法 host 回退到默认');
  assert.ok(logger.warnings.some((line) => line.includes('host')));
  assert.equal(normalizeConfig({ maxDevices: 999 }).maxDevices, 32);
  assert.equal(normalizeConfig({ maxDevices: 0 }).maxDevices, 1);
  assert.equal(normalizeConfig({ maxPairUses: 0 }).maxPairUses, 1);
  assert.equal(normalizeConfig({ pairTtlMs: 1 }).pairTtlMs, 60_000);
});

test('publicBaseUrl / allowedHosts 只接受干净的值', () => {
  assert.equal(normalizeConfig({}).publicBaseUrl, '');
  assert.equal(
    normalizeConfig({ publicBaseUrl: 'https://p.example/path?q=1#h' }).publicBaseUrl,
    'https://p.example/path',
    'query 与 fragment 必须被剥掉',
  );
  assert.equal(normalizeConfig({ publicBaseUrl: 'https://u:p@p.example' }).publicBaseUrl, '', '不许带口令');
  assert.equal(normalizeConfig({ publicBaseUrl: 'ftp://p.example' }).publicBaseUrl, '');
  assert.deepEqual(
    normalizeConfig({ allowedHosts: ['A.example', 'a.example', 'bad host!', 'phone.local:47901'] }).allowedHosts,
    ['a.example', 'phone.local'],
    '去重 + 丢弃非法字符 + 去掉端口',
  );
});
