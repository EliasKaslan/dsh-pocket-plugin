/**
 * 外壳自检（C1）的守卫。
 *
 * 事故：`checkShellFresh()` 里写了一个根本不存在的变量 `mine`，抛出的
 * ReferenceError 被外层的 `catch { /* 自检失败不影响使用 *\/ }` 吞掉 ——
 * 自检每次都在第一行死掉，「界面是旧版本，立即刷新」的横幅与
 * `hardRefreshShell()` 于是成了不可达代码，手机一直跑着 SW 缓存里的旧壳。
 *
 * 这里直接 import `web/lib/shell-fresh.js` 的真函数，不对源码做正则断言：
 * 把修复回退成"内联在 app.js 里的一坨"或改坏判据，这些用例都会红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SHELL_CACHE_PREFIXES,
  parseShellBuild,
  shellCacheBuilds,
  staleShellBuilds,
} from '../../web/lib/shell-fresh.js';

/* ------------------------------- parseShellBuild ------------------------------- */

test('parseShellBuild 从 sw.js 文本里取出构建哈希', () => {
  const source = [
    '/** 由构建脚本替换：__POCKET_BUILD__ */',
    "const BUILD = 'a1b2c3d4e5f60718';",
    'const CACHE = `pocket-shell-${BUILD}`;',
  ].join('\n');
  assert.equal(parseShellBuild(source), 'a1b2c3d4e5f60718');
});

test('parseShellBuild：占位符没被替换 / 取不到 一律当"不知道线上是哪版"', () => {
  // 直接拿源码起开发服务器时就是这个样子。若把占位符当成真实 build，
  // 界面会永远挂着「是旧版本」的横幅。
  assert.equal(parseShellBuild("const BUILD = '__POCKET_BUILD__';"), null);
  assert.equal(parseShellBuild('const CACHE = "x";'), null);
  assert.equal(parseShellBuild(''), null);
  assert.equal(parseShellBuild(null), null);
  assert.equal(parseShellBuild(undefined), null);
  // 空字符串同样不算一个合法 build（否则会拿去和缓存名比对）
  assert.equal(parseShellBuild("const BUILD = '';"), null);
});

/* ------------------------------ shellCacheBuilds ------------------------------ */

test('shellCacheBuilds 认得两代外壳的缓存前缀，别的缓存键一律忽略', () => {
  // 远端外壳 remote/sw.js 用 pocket-shell-，局域网 /app 的 web/sw.js 用 dsh-pocket-
  assert.deepEqual(SHELL_CACHE_PREFIXES, ['pocket-shell-', 'dsh-pocket-']);
  const keys = [
    'pocket-shell-aaaa1111',
    'dsh-pocket-bbbb2222',
    'some-other-app-cache',
    'dsh-pocket-',
    'pocket-shell-',
    42,
    null,
  ];
  assert.deepEqual(shellCacheBuilds(keys), ['aaaa1111', 'bbbb2222']);
  assert.deepEqual(shellCacheBuilds([]), []);
  assert.deepEqual(shellCacheBuilds(undefined), []);
});

/* ------------------------------ staleShellBuilds ------------------------------ */

test('staleShellBuilds：新旧缓存同时存在时逐条比对，不误报也不漏报', () => {
  // 新 SW 先预缓存、旧 SW 后才 activate 删除，所以新旧会同时存在。
  // 随手 find 一个可能拿到旧的 → 误报「界面是旧版本」；只比对一个又可能漏报。
  assert.deepEqual(staleShellBuilds(['pocket-shell-old'], 'new'), ['old']);
  assert.deepEqual(staleShellBuilds(['pocket-shell-new'], 'new'), []);
  assert.deepEqual(
    staleShellBuilds(['pocket-shell-old', 'pocket-shell-new', 'dsh-pocket-old'], 'new'),
    ['old', 'old'],
  );
  // 不是外壳缓存的名字再多也不能算进来
  assert.deepEqual(staleShellBuilds(['pocket-shell-old', 'unrelated-cache-x'], 'new'), ['old']);
});

test('staleShellBuilds：拿不到线上 build 时不做判断（宁可不提示，也不误报）', () => {
  for (const live of [null, undefined, '']) {
    assert.deepEqual(staleShellBuilds(['pocket-shell-old'], live), []);
  }
});

test('回归场景：旧壳在跑 → 恰好一条 stale，且就是本机那一版', () => {
  // 一次真实事故的形状：手机缓存里是 old，线上已经发布 new。
  const keys = ['pocket-shell-6f1a2b3c4d5e6f70'];
  const live = parseShellBuild("const BUILD = '0011aabbccddeeff';");
  const stale = staleShellBuilds(keys, live);
  assert.equal(stale.length, 1);
  assert.equal(stale[0], '6f1a2b3c4d5e6f70');
  assert.notEqual(stale[0], live);
});
