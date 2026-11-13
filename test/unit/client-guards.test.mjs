/**
 * 源码级兜底门禁（三件互不相干、但都"错了就是白屏或假断开"的事）。
 *
 *  1. C1 那次的笔误不许再出现：`web/app.js` 里写的 `mine.slice(...)`（真名是
 *     `mines`）抛 ReferenceError，被外层 catch 吞掉，界面上一点痕迹都没有，
 *     所以只能靠机械检查兜住。
 *     判据是「`mine` 在这个文件里没有绑定」而不是「整份文件不许出现 `mine`」：
 *     `remote/remote.js:1035` 本来就有一个**合法**的 `const mine`（判断 4002
 *     是不是同一个 socket 复用它），一刀切会让这条门禁一上来就是红的。
 *
 *  2. `web/sw.js` 的 ASSETS 必须覆盖 `web/**\/*.js` 里**所有**相对 import
 *     —— 少一个，装好 SW 的首次离线打开就是一个 ES 模块 404（白屏）。
 *     历史上 `lib/answers.js` / `lib/perf.js` / `manifest.webmanifest` 就是漏的。
 *     这条直接在源码层做门禁：`web/sw.js` 不是构建产物（局域网布局下被
 *     `lib/server.mjs` 直接读出来发），构建期占位符覆盖不到它。
 *
 *  3. 解除配对要清的外壳侧键名清单（`web/lib/shell-session.js`）必须与
 *     `remote/remote.js` 实际读写的那几个键一致 —— 两边漂开就是"点了断开、
 *     刷新又连上"（C2）。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { test } from 'node:test';

import { unpairStorageKeys } from '../../web/lib/shell-session.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WEB = join(ROOT, 'web');
const read = (relative) => readFile(join(ROOT, relative), 'utf8');

/** 递归列出 dir 下所有文件（posix 相对路径）。 */
async function walk(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full, base));
    else if (entry.isFile()) found.push(full.slice(base.length + 1).split('\\').join('/'));
  }
  return found.sort();
}

/* ------------------------------------------------ 1) 裸 mine ---------------- */

/**
 * 去掉注释与字符串字面量，只留"会被执行"的代码。
 *
 * 为什么要去：注释里提一句「曾经写成 `mine`」不该让门禁变红（那是解释，不是
 * 引用），字符串里出现同名词也不是变量引用。局限：模板字面量整段被替换，
 * 所以 `${mine}` 这种写法查不出来 —— 这条只是兜底门禁，不指望它做类型检查。
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')          // 块注释
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1')     // 行注释（跳过 http:// 里的 //）
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''")      // 单引号字符串
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')      // 双引号字符串
    .replace(/`(?:[^`\\]|\\.)*`/gu, '``');       // 模板字面量
}

const NAKED_MINE = /(?<![\w$.])mine(?![\w$])/gu;

/**
 * 找出"没有绑定就被使用"的 `mine`。
 *
 * 绑定 = `const/let/var mine`、解构声明/参数、位置参数。
 * 有绑定就整份文件放行（多个使用点都是合法的）；没有绑定就每处都算命中。
 */
const BINDINGS = [
  /\b(?:const|let|var)\s+mine\b/u,                      // const mine = …
  /\b(?:const|let|var)\s*\{[^}]*\bmine\b[^}]*\}/u,      // const { a, mine } = …
  /\(\s*\{[^}]*\bmine\b[^}]*\}\s*\)/u,                  // function f({ mine })
  /(?:\(|,)\s*mine\s*(?:[,)=])/u,                       // f(mine) / (mine) => …
];

function nakedMine(source) {
  const code = codeOnly(String(source ?? ''));
  if (BINDINGS.some((pattern) => pattern.test(code))) return [];
  return [...code.matchAll(NAKED_MINE)];
}

test('web/app.js 里不存在没有绑定就使用的 mine（C1 那次的笔误）', async () => {
  const hits = nakedMine(await read('web/app.js'));
  assert.equal(
    hits.length,
    0,
    `web/app.js 里出现了没有声明的 mine（真名可能是 mines）：`
    + `下标 ${hits.map((hit) => hit.index).join(', ')}。`
    + '它会抛 ReferenceError，还可能被外层 catch 静默吞掉 —— C1 就是这一行。',
  );
});

test('remote/remote.js 里的 mine 必须有绑定（该文件本来就有一个合法的 const mine）', async () => {
  const source = await read('remote/remote.js');
  // 事实核对：这份文件确实声明了 mine，所以判据只能是"有没有绑定"
  assert.match(codeOnly(source), /\bconst mine =/u, 'remote/remote.js 里应当有一个合法的 const mine；若已改名，这条门禁可以收紧成"整份文件不许出现"');
  assert.deepEqual(nakedMine(source), []);
});

test('nakedMine 自检：C1 的写法必须命中，注释/字符串/属性名不算', () => {
  // C1 的原样（app.js 里那行死代码）
  assert.equal(nakedMine('const mines = keys.filter(() => true);\nconst mineBuild = mine.slice(9);').length, 1);
  // 拼写正确的不命中
  assert.equal(nakedMine('const mines = [];\nconst build = mines[0].slice(9);').length, 0);
  // 有绑定（含参数）就放行
  assert.equal(nakedMine('const mine = socket !== undefined;\nif (code === 4002 && mine) go();').length, 0);
  assert.equal(nakedMine('items.filter((mine) => mine.ok);').length, 0);
  assert.equal(nakedMine('function f({ mine }) { return mine; }').length, 0);
  // 注释、字符串、属性名都不算"标识符使用"
  assert.equal(nakedMine('// 注释里的 mine 不算\nconst x = 1;').length, 0);
  assert.equal(nakedMine("const s = 'mine';").length, 0);
  assert.equal(nakedMine('obj.mine = 1;').length, 0);
});

/* ------------------------------------------- 2) sw.js 的 ASSETS ---------------- */

/** 从 `web/sw.js` 里取出 ASSETS 数组（纯字符串列表，不 eval 任何代码）。 */
function parseAssets(source) {
  const block = /const ASSETS = \[([\s\S]*?)\];/u.exec(source);
  assert.notEqual(block, null, 'web/sw.js 里必须有 `const ASSETS = [...]`');
  return [...block[1].matchAll(/'([^']*)'/gu)].map((hit) => hit[1]);
}

/** JS 里所有相对静态/动态 import 的目标（相对所在文件）。 */
function relativeImports(source) {
  const out = [];
  for (const hit of source.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/gu)) out.push(hit[1]);
  return out;
}

test('web/sw.js 的 ASSETS 覆盖 web/**/*.js 里每一条相对 import', async () => {
  const assets = new Set(parseAssets(await read('web/sw.js')));
  const files = (await walk(WEB)).filter((file) => file.endsWith('.js') && file !== 'sw.js');
  assert.ok(files.length >= 15, `只扫到 ${files.length} 个源文件，扫描链可能断了`);

  let checked = 0;
  for (const file of files) {
    const source = await read(join('web', file));
    for (const spec of relativeImports(source)) {
      // 相对 spec 一律以 ./ 开头（ESM 规范），dirname 用 posix 语义拼。
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      checked += 1;
      assert.ok(
        assets.has(`./${target}`),
        `${file} import 了 ${spec}，但 web/sw.js 的 ASSETS 里没有 ./${target}`
        + ' —— 装好 SW 后首次离线打开会模块 404（白屏）',
      );
    }
  }
  assert.ok(checked >= 25, `只核对到 ${checked} 条 import，扫描可能没生效`);
});

test('web/sw.js 的 ASSETS 里每一项都真实存在（防手滑 / 防改名）', async () => {
  for (const entry of parseAssets(await read('web/sw.js'))) {
    assert.equal(entry.startsWith('./'), true, `ASSETS 项必须是 ./ 开头的相对路径：${entry}`);
    const relative = entry.slice(2);
    // './' 是目录本身，对应 index.html（浏览器会补）。
    const file = relative === '' ? join(WEB, 'index.html') : join(WEB, relative);
    await assert.doesNotReject(readFile(file), `ASSETS 里的 ${entry} 在 web/ 下不存在`);
  }
});

test('历史上漏掉的那几个文件必须在 ASSETS 里（否则首次离线打开白屏）', async () => {
  const assets = new Set(parseAssets(await read('web/sw.js')));
  for (const required of [
    './lib/answers.js',     // views/detail.js 静态 import
    './lib/perf.js',        // app.js 静态 import（性能探针）
    './manifest.webmanifest', // web/index.html 的 <link rel="manifest">
  ]) {
    assert.ok(assets.has(required), `ASSETS 缺少 ${required}`);
  }
  assert.ok(assets.has('./'), 'ASSETS 必须包含壳入口 ./');
  assert.ok(assets.has('./index.html'), 'ASSETS 必须包含 ./index.html');
});

/* --------------------------------------- 3) 解除配对的键名清单 ---------------- */

test('解除配对清单覆盖外壳写的每一份会话与链接', async () => {
  const keys = unpairStorageKeys();
  // 设备令牌两份键名（remote/remote.js 的 readDeviceSession 会依次读）
  assert.ok(keys.includes('pocket.session.v1'), '必须清外壳的 pocket.session.v1');
  assert.ok(keys.includes('dsh.pocket.session.v1'), '必须清 app/外壳镜像的 dsh.pocket.session.v1');
  // 更早的一代键名
  assert.ok(keys.includes('dsh.bridge.session.v1'));
  // 记住的配对链接（含房间 AES 密钥）
  assert.ok(keys.includes('dsh.pocket.link.v1'), '解除配对必须连记住的链接一起清');
  // 去重
  assert.equal(new Set(keys).size, keys.length);
});

test('清单里的键名与 remote/remote.js 实际使用的一致（防两边漂开）', async () => {
  const source = await read('remote/remote.js');
  for (const key of unpairStorageKeys()) {
    assert.ok(source.includes(`'${key}'`), `remote/remote.js 里找不到键名 ${key}，清单与外壳实现已经漂开`);
  }
  // 外壳必须有 forgetSession 这个入口：只清 app 自己的会话等于没解除配对。
  assert.match(source, /forgetSession\(\) \{/u, '外壳必须提供 __POCKET_SHELL__.forgetSession()');
});

test('web/app.js 自己的会话键也在清单里（三处键名不许各写各的）', async () => {
  const app = await read('web/app.js');
  const hit = /const SESSION_CACHE = '([^']+)';/u.exec(app);
  assert.notEqual(hit, null, 'web/app.js 里找不到 SESSION_CACHE');
  assert.ok(
    unpairStorageKeys().includes(hit[1]),
    `web/app.js 的会话键 ${hit[1]} 不在解除配对清单里 —— 清了外壳却留下 app 自己那份`,
  );
});
