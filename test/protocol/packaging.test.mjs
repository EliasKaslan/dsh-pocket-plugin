/**
 * 发布元数据门禁：插件名、版本号、插件市场索引的 format:1 合法性。
 *
 * 断言各对应一类真实事故（CI 里同名步骤会再跑一次本文件，失败时能直接指出是哪一类）：
 *
 * 1. `cordis.patch.yml` 的 `name`、`lib/index.mjs` 导出的 `name`、`package.json` 的
 *    `name` 三者必须逐字相同。写成 `dsh-pocket` 之类任一个对不上，宿主按包名解析
 *    插件就会失败，表现为"装上了但没加载"，日志里只有一句找不到服务。
 * 2. `market/index.json` 必须是合法 format:1 —— 判定与宿主里真实的校验器
 *    `@deepseek-ai/dsh-plugin-market-index`（本机 `D:\tools\dsh\resources\app.asar`
 *    里实测 **0.2.2-rc.5**，`src/index.ts`）等价。镜像实现与逐条依据见
 *    `test/support/market-index-validator.mjs` 的文件头注释。
 *    为什么不能只用正则抽查：手写校验器曾经漏掉「重复插件名」与「`source.url` 必填」，
 *    这两处真校验器都 **REJECT**、旧门禁都 **ACCEPT** —— 发布出去就是市场整份索引被拒
 *    （`MarketIndexError: must be keyed by a lowercase language id` 一类），插件在市场
 *    里根本不出现，而 CI 全绿。所以下面除了"当前文件通过"，还钉了变异必须被拒。
 * 3. 版本号的三处手写副本必须一致：`package.json` 的 `version`、
 *    `lib/util.mjs` 的 `PLUGIN_VERSION`（`/api/v1/health` 返回的就是它）、
 *    `market/index.json` 里登记的 `version`。任何一处漏改，市场登记的版本与运行时
 *    自报的版本就对不上，排障时会被误导。
 *
 * 本文件刻意不 import `lib/**`：门禁只读文件、只做字符串/JSON 校验，因此别的模块
 * 正在改的时候它不会因为加载链断掉而变成一条假红。唯一 import 的是
 * `test/support/market-index-validator.mjs`（纯函数镜像，零第三方依赖）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { MarketIndexError, parseMarketIndex } from '../support/market-index-validator.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const readText = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

/**
 * 索引发布后的绝对 URL。只用于解析相对图标引用（本仓索引目前没有 `icon`），
 * 用 RFC 2606 的 `.invalid` 是为了任何情况下都不会真的发请求。
 */
const INDEX_URL = 'https://dsh-market.invalid/market/index.json';

const pkg = JSON.parse(readText('package.json'));
const marketText = readText('market/index.json');
const market = JSON.parse(marketText);

/** 取 `engines.dsh` 里的下界（形如 `>=0.2.2-rc.2`），没有下界时返回 null。 */
function lowerBound(range) {
  const matched = /^\s*>=\s*([^\s]+)/u.exec(String(range ?? ''));
  return matched === null ? null : matched[1];
}

/** 深拷一份索引，变异测试改副本，绝不动真文件。 */
const cloneMarket = () => JSON.parse(JSON.stringify(market));

/** 断言某份变异索引被校验器拒绝，并返回错误（用于检查拒在哪条规则上）。 */
function rejected(document, because) {
  assert.throws(
    () => parseMarketIndex(document, INDEX_URL),
    (error) => {
      assert.equal(error instanceof MarketIndexError, true, `${because}：应当抛 MarketIndexError，实际 ${error?.name}`);
      return true;
    },
    because,
  );
  try {
    parseMarketIndex(document, INDEX_URL);
  } catch (error) {
    return error;
  }
  return null;
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

test('market/index.json 通过宿主 format:1 校验器的等价实现（语言键 / SemVer / source / engines）', () => {
  // 真校验器只在宿主里（CI 没有这个包），所以用镜像实现；镜像与宿主的一致性由
  // `test/support/market-index-validator.mjs` 头部记录的依据 + 下面两条变异测试钉住。
  const parsed = parseMarketIndex(market, INDEX_URL);
  assert.equal(parsed.format, 1, '市场索引的 format 必须是数字 1');

  // 仓库策略（**不是** format:1 的规则，宿主的校验器允许空 plugins）：
  // 本仓的市场索引必须至少登记一个插件，否则发布出去等于"市场里没有这个插件"。
  assert.equal(parsed.plugins.length > 0, true, '本仓 market/index.json 必须至少登记一个插件');

  // 索引文本本身也钉一下：JSON.parse 已被上面用掉，这里保证文件不是被生成器美化坏的。
  assert.equal(marketText.includes('\t'), false, '索引用两空格缩进，不要混 tab（发布流程按文本 diff 审阅）');
});

test('变异：重复插件名必须被拒（旧手写校验器在这里 ACCEPT，真校验器 REJECT）', () => {
  const duplicated = cloneMarket();
  duplicated.plugins.push(JSON.parse(JSON.stringify(duplicated.plugins[0])));
  const error = rejected(duplicated, '重复插件名必须被拒，否则宿主整份索引拒收');
  assert.equal(error.reason, `duplicates ${market.plugins[0].name}`, '拒的理由必须与宿主一致（duplicates <name>）');
});

test('变异：删除 versions[0].source.url 必须被拒（旧手写校验器在这里 ACCEPT，真校验器 REJECT）', () => {
  const noUrl = cloneMarket();
  delete noUrl.plugins[0].versions[0].source.url;
  const error = rejected(noUrl, 'git 来源必须有 url，删掉它宿主会拒收整份索引');
  assert.equal(error.path, '$.plugins[0].versions[0].source.url', '拒的路径必须精确指向缺字段的位置');
  assert.match(error.reason, /non-whitespace character/u, '拒的理由必须是"必填字符串缺失"');

  // 顺带钉住 commit：git 来源的 commit 必须是 40 位小写 hex。
  const badCommit = cloneMarket();
  badCommit.plugins[0].versions[0].source.commit = 'ABC1234';
  rejected(badCommit, 'commit 不是 40 位小写 hex 时必须被拒');
});

test('变异：语言键 / SemVer / publishTimestamp / engines 的越界值必须被拒', () => {
  const cases = [
    ['语言键 zh-CN', (doc) => { doc.title['zh-CN'] = doc.title['zh-cn']; delete doc.title['zh-cn']; }, /lowercase language id/u],
    ['title 缺 en', (doc) => { delete doc.title.en; }, /must contain en/u],
    ['SemVer 写成 1.0', (doc) => { doc.plugins[0].versions[0].version = '1.0'; }, /exact SemVer/u],
    ['SemVer 前导零 1.0.0-01', (doc) => { doc.plugins[0].versions[0].version = '1.0.0-01'; }, /exact SemVer/u],
    ['publishTimestamp 负数', (doc) => { doc.plugins[0].versions[0].publishTimestamp = -1; }, /\[0, 10\^11\)/u],
    ['publishTimestamp 上界 1e11', (doc) => { doc.plugins[0].versions[0].publishTimestamp = 1e11; }, /\[0, 10\^11\)/u],
    ['publishTimestamp 非整数', (doc) => { doc.plugins[0].versions[0].publishTimestamp = 1.5; }, /\[0, 10\^11\)/u],
    ['engines.dsh 是 workspace: 范围', (doc) => { doc.plugins[0].versions[0].engines.dsh = 'workspace:*'; }, /workspace:/u],
    ['engines.dsh 不是范围', (doc) => { doc.plugins[0].versions[0].engines.dsh = 'latest'; }, /SemVer range/u],
    ['source.type 不是 npm/git', (doc) => { doc.plugins[0].versions[0].source.type = 'hg'; }, /"npm" or "git"/u],
    ['插件名不是合法 npm 包名', (doc) => { doc.plugins[0].name = 'DSH Pocket'; }, /valid npm package name/u],
    ['format 是字符串 "1"', (doc) => { doc.format = '1'; }, /must be 1/u],
  ];
  for (const [name, mutate, reason] of cases) {
    const doc = cloneMarket();
    mutate(doc);
    const error = rejected(doc, `${name} 必须被拒`);
    assert.match(error.reason, reason, `${name} 的拒因必须命中规则（实际：${error.reason}）`);
  }

  // 反向对照：`engines` 是**可选**的，删掉不能红（宿主同样接受）。少了这条，
  // 镜像实现会把"必填"和"可选"写反，而变异测试全都还是会绿。
  const noEngines = cloneMarket();
  delete noEngines.plugins[0].versions[0].engines;
  assert.doesNotThrow(() => parseMarketIndex(noEngines, INDEX_URL), 'engines 是可选的，删掉必须仍然通过');
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
