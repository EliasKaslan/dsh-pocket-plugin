/**
 * 发布元数据门禁：插件名、版本号、插件市场索引的 format:1 合法性。
 *
 * 三条断言各对应一类真实事故（CI 里同名步骤会再跑一次本文件，失败时能直接指出是哪一类）：
 *
 * 1. `cordis.patch.yml` 的 `name`、`lib/index.mjs` 导出的 `name`、`package.json` 的
 *    `name` 三者必须逐字相同。写成 `dsh-pocket` 之类任一个对不上，宿主按包名解析
 *    插件就会失败，表现为"装上了但没加载"，日志里只有一句找不到服务。
 * 2. `market/index.json` 必须是合法 format:1。语言键规则来自宿主里真实的校验器
 *    `@deepseek-ai/dsh-plugin-market-index` 0.2.2-rc.2 的 `src/index.ts`：
 *      `const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u`
 *    不匹配时的失败信息是 `must be keyed by a lowercase language id`。
 *    实测把 `zh-cn` 写成 `zh-CN`，整份索引抛 `MarketIndexError`，插件在市场里根本不出现。
 * 3. 版本号的三处手写副本必须一致：`package.json` 的 `version`、
 *    `lib/util.mjs` 的 `PLUGIN_VERSION`（`/api/v1/health` 返回的就是它）、
 *    `market/index.json` 里登记的 `version`。任何一处漏改，市场登记的版本与运行时
 *    自报的版本就对不上，排障时会被误导。
 *
 * 本文件刻意不 import `lib/**`：门禁只读文件、只做字符串/JSON 校验，因此别的模块
 * 正在改的时候它不会因为加载链断掉而变成一条假红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const readText = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

/** 索引里的语言键规则，逐字照抄宿主校验器（见文件头注释 2）。 */
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
/** format:1 要求版本号是精确 SemVer（`SEMVER` 常量同上，另见 `marketVersion()` 的校验）。 */
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const pkg = JSON.parse(readText('package.json'));
const market = JSON.parse(readText('market/index.json'));

/**
 * 校验一个本地化文本字段（宿主校验器的 `localizedText()`）：
 * 允许纯字符串，或 `{ 语言键: 字符串 }`；对象的键必须匹配 `LANGUAGE_ID`，
 * 且必须含 `en`（`if (!Object.hasOwn(text, 'en')) fail(path, 'must contain en')`）。
 */
function assertLocalized(value, at) {
  if (typeof value === 'string') {
    assert.notEqual(value.trim(), '', `${at} 必须是非空白字符串`);
    return;
  }
  assert.equal(typeof value, 'object', `${at} 必须是字符串或本地化文本对象`);
  assert.notEqual(value, null, `${at} 不能是 null`);
  assert.equal(Array.isArray(value), false, `${at} 不能是数组`);
  for (const [language, member] of Object.entries(value)) {
    assert.match(language, LANGUAGE_ID, `${at}.${language} 必须是小写语言 id（如 en / zh-cn），否则宿主抛 must be keyed by a lowercase language id`);
    assert.equal(typeof member, 'string', `${at}.${language} 必须是字符串`);
  }
  assert.ok(Object.hasOwn(value, 'en'), `${at} 必须含 en`);
}

/** 取 `engines.dsh` 里的下界（形如 `>=0.2.2-rc.2`），没有下界时返回 null。 */
function lowerBound(range) {
  const matched = /^\s*>=\s*([^\s]+)/u.exec(String(range ?? ''));
  return matched === null ? null : matched[1];
}

test('cordis.patch.yml 与 lib/index.mjs 的插件名严格等于 package.json 的 name', () => {
  // 只解析标量行、跳过注释：本仓没有 yaml 依赖，而这段文件里 `name:` 只出现一次。
  const names = [];
  for (const raw of readText('cordis.patch.yml').split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const matched = /^name:\s*(.+)$/u.exec(line);
    if (matched !== null) names.push(matched[1].trim().replace(/^['"]|['"]$/gu, ''));
  }
  assert.equal(names.length, 1, 'cordis.patch.yml 里应当恰好有一个插件行 name（多写一行会变成两个同名插件）');
  assert.equal(names[0], pkg.name, 'cordis.patch.yml 的 name 必须与 package.json 的 name 逐字相同');

  const exported = /^export\s+const\s+name\s*=\s*'([^']+)'/mu.exec(readText('lib/index.mjs'));
  assert.notEqual(exported, null, 'lib/index.mjs 必须用 `export const name = \'...\'` 声明插件名');
  assert.equal(exported[1], pkg.name, 'lib/index.mjs 导出的 name 必须与 package.json 的 name 逐字相同');
});

test('market/index.json 是合法的 format:1 索引（format + 语言键 + SemVer）', () => {
  assert.equal(market.format, 1, '市场索引的 format 必须是数字 1');

  assertLocalized(market.title, '$.title');
  if (Object.hasOwn(market, 'description')) assertLocalized(market.description, '$.description');

  const metadata = market.metadata ?? {};
  for (const kind of ['categories', 'labels', 'sortKeys']) {
    for (const [id, declaration] of Object.entries(metadata[kind] ?? {})) {
      assertLocalized(declaration?.title, `$.metadata.${kind}.${id}.title`);
    }
  }

  assert.ok(Array.isArray(market.plugins) && market.plugins.length > 0, '$.plugins 必须是非空数组');
  for (const [position, plugin] of market.plugins.entries()) {
    const at = `$.plugins[${position}]`;
    assert.equal(typeof plugin?.name, 'string', `${at}.name 必须是字符串`);
    if (Object.hasOwn(plugin, 'title')) assertLocalized(plugin.title, `${at}.title`);
    if (Object.hasOwn(plugin, 'description')) assertLocalized(plugin.description, `${at}.description`);

    assert.ok(Array.isArray(plugin.versions) && plugin.versions.length > 0, `${at}.versions 必须是非空数组`);
    for (const [index, version] of plugin.versions.entries()) {
      const versionAt = `${at}.versions[${index}]`;
      assert.equal(typeof version?.version, 'string', `${versionAt}.version 必须是字符串`);
      assert.match(version.version, EXACT_SEMVER, `${versionAt}.version 必须是精确 SemVer`);
      assert.equal(Number.isInteger(version.publishTimestamp), true, `${versionAt}.publishTimestamp 必须是整数（Unix 秒）`);
      assert.equal(typeof version?.source?.type, 'string', `${versionAt}.source.type 必须是字符串`);
      const engines = version.engines ?? {};
      for (const [engine, range] of Object.entries(engines)) {
        assert.equal(typeof range, 'string', `${versionAt}.engines.${engine} 必须是字符串`);
      }
    }
  }
});

test('market/index.json 登记的版本等于 package.json 的 version', () => {
  assert.equal(typeof pkg.version, 'string', 'package.json 必须有 version');
  for (const plugin of market.plugins) {
    for (const version of plugin.versions) {
      assert.equal(version.version, pkg.version, `market/index.json 的 ${plugin.name}@${version.version} 与 package.json 的 ${pkg.version} 不一致`);
    }
  }
});

test('lib/util.mjs 的 PLUGIN_VERSION 等于 package.json 的 version', () => {
  const matched = /^export\s+const\s+PLUGIN_VERSION\s*=\s*'([^']+)'/mu.exec(readText('lib/util.mjs'));
  assert.notEqual(matched, null, 'lib/util.mjs 必须导出 PLUGIN_VERSION');
  assert.equal(matched[1], pkg.version, 'PLUGIN_VERSION（/api/v1/health 的 version）必须与 package.json 一致');
});

test('market/index.json 的 engines.dsh 下界不宽于 package.json', () => {
  // 两处形态不同是故意的：package.json 只声明已验证的下界，市场索引需要带上界。
  // 但下界本身必须一致——市场若声明更宽的 `>=0.2.2-rc.1`，就会把插件推给未验证的宿主。
  const packageLower = lowerBound(pkg.engines?.dsh);
  assert.notEqual(packageLower, null, 'package.json 的 engines.dsh 必须以 >= 声明下界');
  for (const plugin of market.plugins) {
    for (const version of plugin.versions) {
      const marketLower = lowerBound(version.engines?.dsh);
      assert.notEqual(marketLower, null, 'market/index.json 的 engines.dsh 必须以 >= 声明下界');
      assert.equal(marketLower, packageLower, 'market/index.json 的 engines.dsh 下界必须与 package.json 一致');
    }
  }
});
