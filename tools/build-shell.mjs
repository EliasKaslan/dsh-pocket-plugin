#!/usr/bin/env node
/**
 * 把 `web/`（同一个手机 UI）与 `remote/`（远端外壳）合成一份可以直接静态托管的产物，
 * 默认写进 `docs/`，用于 GitHub Pages。
 *
 *   node tools/build-shell.mjs            构建并写入 docs/
 *   node tools/build-shell.mjs --check    只校验 docs/ 是否与源码一致（CI 用）
 *   node tools/build-shell.mjs --out dist 换输出目录
 *
 * 产物必须可复现：同样的源码 → 逐字节相同的输出，否则 `--check` 会在 CI 里假报错。
 * 因此文件按路径排序、时间戳一律不写入、哈希只取内容。
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const REMOTE = join(ROOT, 'remote');
const MQTT_DIST = join(ROOT, 'node_modules', 'mqtt', 'dist', 'mqtt.min.js');

/**
 * `docs/mqtt.min.js` 是被提交进仓库的第三方产物 —— 手机端加载的就是它。
 *
 * 只校验「体积大于 64 KiB」等于没有校验：换成一个体积相同的恶意 bundle 照样过 CI，
 * 而这正是「改动一个文件」的攻击最可能选的位置。所以把它的字节钉在这里。
 *
 * 之所以不用「与 node_modules 逐字节比对」：那样 CI 里 `npm install` 装到任意
 * 5.x 小版本都会假红。`package.json` 里 mqtt 是**精确版本**（不是 `^`），因此
 * 钉住的哈希是确定的；升级 mqtt 时 `collect()` 会报出新哈希，照它改这一行即可。
 */
const MQTT_DIST_SHA256 = '75873d04a6400bbbac093b3602caf06f44ed92ee032925e1f4f21c03eba05a4e';

const args = parseArgs(process.argv.slice(2));
const OUT = resolve(ROOT, args.out ?? 'docs');
const CHECK = args.check === true;

/**
 * 递归删除前的护栏。
 *
 * 这个脚本会 `rm -rf` 输出目录再重建，而 `--out` 是命令行传进来的。一次手滑
 * （`--out .`、`--out ..`、`--out C:\Users\me`）就等于把整棵树删掉 —— 这类
 * 事故真实发生过。所以分两层拦：
 *
 *   A. 结构性红线（`--force` 也不能绕）：
 *      - 不许是仓库根，也不许是仓库的任何上级；
 *      - 不许是文件系统根、家目录、家目录的上级；
 *      - 不许落在源码目录里（web/ remote/ lib/ bin/ tools/ test/ 等）。
 *   B. 「这真是我的产物吗」校验：
 *      - 目录已存在且非空、但里面没有 .nojekyll → 拒绝，除非 `--force`。
 *        （.nojekyll 是 build-shell 特有的标记；没有它就说明这目录不是上一次
 *        构建的结果，可能是别人的东西。）
 *
 * 允许写到仓库外（CI 与单测都往临时目录里构建），因为 B 层已经保证了
 * 「只覆盖自己生成过的目录」；A 层保证不会碰到性命攸关的那几个位置。
 */
const SOURCE_DIRS = new Set([
  'web', 'remote', 'lib', 'bin', 'tools', 'test',
  'node_modules', '.git', '.github', 'assets',
]);

/** child 是否等于 parent 或位于 parent 之下。 */
function isWithin(parent, child) {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function assertSafeOut(out) {
  const fail = (why) => {
    process.stderr.write(`拒绝写入 ${out}\n  原因：${why}\n`);
    process.exit(2);
  };
  if (out === ROOT) fail('这正是仓库根目录，删掉它等于删掉整个项目');
  if (isWithin(out, ROOT)) fail('这是仓库的上级目录，删掉它会把整个项目一起带走');
  if (parse(out).root === out) fail('这是文件系统根目录');
  const home = homedir();
  if (isWithin(out, home)) fail('这是你的家目录或它的上级');
  if (isWithin(ROOT, out)) {
    const top = relative(ROOT, out).split(sep)[0];
    if (SOURCE_DIRS.has(top)) fail(`不能覆盖源码目录 ${top}/`);
  }
}

/** 从 `web/` 带进外壳的运行时文件（不含只在局域网布局里用的东西）。 */
const WEB_SKIP = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'pair.js', 'pair.css']);

/** 外壳自己的源码。 */
const REMOTE_FILES = ['index.html', 'remote.js', 'remote.css'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  // 写错的开关必须显式失败：`--check=true` 曾经静默落到真构建分支，
  // 把"只校验"变成"覆盖 docs/"，CI 里就是把红报成绿。
  for (const key of Object.keys(out)) {
    if (key !== 'check' && key !== 'out' && key !== 'force') {
      console.error(`未知参数 --${key}（支持：--check / --out <dir> / --force）`);
      process.exit(2);
    }
  }
  if (out.out !== undefined && typeof out.out !== 'string') {
    console.error('--out 需要一个目录参数');
    process.exit(2);
  }
  for (const key of ['check', 'force']) {
    if (out[key] !== undefined && out[key] !== true) {
      console.error(`--${key} 不接受取值，请只写 --${key}`);
      process.exit(2);
    }
  }
  return out;
}

async function walk(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full, base));
    else if (entry.isFile()) found.push(relative(base, full).split(sep).join('/'));
  }
  return found;
}

/** 外壳的 web app manifest：路径必须是相对的，站点才能部署在任意子路径下。 */
function shellManifest(source) {
  const parsed = JSON.parse(source);
  return `${JSON.stringify({
    ...parsed,
    start_url: './',
    scope: './',
    icons: (parsed.icons ?? []).map((icon) => ({ ...icon, src: icon.src.replace(/^\/app\//u, './') })),
  }, null, 2)}\n`;
}

/** 内容哈希：只喂路径与字节，保证可复现。 */
function stampHash(entries) {
  const hash = createHash('sha256');
  for (const [path, buffer] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(path).update('\0').update(String(buffer.length)).update('\0').update(buffer);
  }
  return hash.digest('hex').slice(0, 16);
}

/** 会被当文本处理的扩展名；其余（png 等）原样复制。 */
const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.webmanifest', '.svg', '.json', '.txt']);

/**
 * 读源文件：文本一律归一到 LF，二进制原样返回。
 *
 * 不归一的话，Windows 上带 CRLF 的源文件和 CI（Linux，LF）会产出**不同字节**的
 * docs/，于是 `build-shell --check` 变成"跟谁的换行符比"的问题：本地绿、CI 红，
 * 或者反过来。产物必须只取决于内容，不取决于检出的换行风格。
 */
async function readAsset(file) {
  const buffer = await readFile(file);
  if (!TEXT_EXT.has(extname(file).toLowerCase())) return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8');
}

async function collect() {
  const entries = new Map();

  const webFiles = (await walk(WEB)).filter((path) => !WEB_SKIP.has(path));
  for (const path of webFiles) entries.set(path, await readAsset(join(WEB, path)));

  for (const name of REMOTE_FILES) entries.set(name, await readAsset(join(REMOTE, name)));

  entries.set('manifest.webmanifest', Buffer.from(shellManifest(await readFile(join(WEB, 'manifest.webmanifest'), 'utf8'))));

  let mqtt;
  try {
    mqtt = await readFile(MQTT_DIST);
    await stat(MQTT_DIST);
  } catch {
    throw new Error(`找不到 ${MQTT_DIST}；先在仓库根目录运行 npm install（或 pnpm install），mqtt 的 dist 里就带上它了`);
  }
  const mqttHash = createHash('sha256').update(mqtt).digest('hex');
  if (mqttHash !== MQTT_DIST_SHA256) {
    throw new Error([
      '装到的 mqtt dist 与钉住的版本不一致：',
      `  实际 sha256 = ${mqttHash}`,
      `  钉住 sha256 = ${MQTT_DIST_SHA256}`,
      '  若确实要升级 mqtt：package.json 改成新的精确版本，再把 tools/build-shell.mjs 里的',
      '  MQTT_DIST_SHA256 换成上面的「实际 sha256」，然后重新 build:shell。',
    ].join('\n'));
  }
  entries.set('mqtt.min.js', mqtt);

  // worker 源码先读出来：它既要参与 build 号，又要在替换占位符后写入产物。
  // 必须走 readAsset：CRLF 归一后才能和 CI 的 LF 检出产出同样的字节。
  const worker = (await readAsset(join(REMOTE, 'sw.js'))).toString('utf8');

  // 哈希覆盖除自身以外的全部产物，**外加 sw.js 源码**：只改 SW 的发布
  // （缓存策略、预缓存逻辑）也必须换掉 build 号，否则缓存名不变，
  // 客户端"比 cache 名"的旧外壳检测会漏报（实测踩过）。
  const stampInputs = new Map(entries);
  stampInputs.set('sw.js.src', Buffer.from(worker));
  // 构建脚本自身也进哈希：precache 的构成与序列化格式都写在这里。
  // 只改脚本会让产物字节变化而 build 号不变（同 build 不等于同行为）。
  stampInputs.set('build.mjs', await readFile(new URL(import.meta.url)));
  const build = stampHash(stampInputs);

  // SW 的预缓存清单由产物列表生成，而不是在 sw.js 里手写。
  // 手写会漏文件（历史上就漏了 store.js / lib/* / views/*，而 app.js 是
  // 静态 import 它们的，断网即白屏）。这里把真实产物全列进去：顺序无关紧要，
  // 安装时每个文件单独 fetch，单个缺失不会毁掉整个缓存。
  // 取哈希之前先算清单，保证清单本身也进了 build 号。
  const precache = ['./'];
  for (const path of entries.keys()) {
    if (path === 'sw.js' || path === '.nojekyll') continue;
    precache.push(`./${path}`);
  }
  precache.sort();

  // 占位符是构建契约：被改名或漏写时，产物会留下裸标识符，SW install 直接
  // ReferenceError（离线全废），而 check-syntax / build --check 都察觉不到。
  for (const marker of ['__POCKET_PRECACHE__', '__POCKET_BUILD__']) {
    if (!worker.includes(marker)) throw new Error(`sw.js 缺少占位符 ${marker}`);
  }
  const workerOut = worker
    .replaceAll('__POCKET_PRECACHE__', JSON.stringify(precache, null, 2))
    .replaceAll('__POCKET_BUILD__', build);
  // 替换后必须没有残留，且 PRECACHE 能解析成非空数组。
  const leftover = /__POCKET_[A-Z_]+__/u.exec(workerOut);
  if (leftover !== null) throw new Error(`sw.js 残留未替换占位符 ${leftover[0]}`);
  const precacheSource = /const PRECACHE = ([\s\S]*?);\n/u.exec(workerOut);
  if (precacheSource === null) throw new Error('sw.js 里找不到 PRECACHE');
  const precacheList = JSON.parse(precacheSource[1]);
  if (!Array.isArray(precacheList) || precacheList.length === 0) throw new Error('PRECACHE 不是非空数组');
  entries.set('sw.js', Buffer.from(workerOut));

  entries.set('.nojekyll', Buffer.from(''));
  return { entries, build };
}

async function write(entries) {
  assertSafeOut(OUT);
  // 第二道闸：目录里已经有东西、但没有本脚本的标记文件，说明那不是上一次的
  // 构建产物（可能是别人的目录），此时拒绝递归删除，除非显式 --force。
  if (args.force !== true) {
    const existing = await readdir(OUT).catch(() => []);
    if (existing.length > 0 && !existing.includes('.nojekyll')) {
      process.stderr.write(`拒绝清空 ${relative(ROOT, OUT) || OUT}：目录非空，且没有 .nojekyll（不像是 build-shell 的产物）\n`);
      process.stderr.write('  确认要覆盖它就加 --force；想写到别处请用 --out <仓库内的新目录>。\n');
      process.exit(2);
    }
  }
  await rm(OUT, { recursive: true, force: true });
  for (const [path, buffer] of entries) {
    const target = join(OUT, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);
  }
}

async function verify(entries) {
  const problems = [];
  const onDisk = new Set(await walk(OUT).catch(() => []));
  for (const [path, buffer] of entries) {
    if (!onDisk.has(path)) { problems.push(`缺失 ${path}`); continue; }
    // mqtt.min.js 是第三方发行物，不是「由本仓源码生成」的东西，所以不能拿
    // node_modules 的当前字节当基准（CI 里装到别的 5.x 小版本就会假红）。
    // 基准是钉住的 sha256：产物被换成任何别的 bundle 都会在这里红。
    if (path === 'mqtt.min.js') {
      const actual = await readFile(join(OUT, path));
      const digested = createHash('sha256').update(actual).digest('hex');
      if (digested !== MQTT_DIST_SHA256) {
        problems.push(`内容不一致 ${path}（sha256=${digested}，钉住=${MQTT_DIST_SHA256}）`);
      }
      onDisk.delete(path);
      continue;
    }
    const actual = await readFile(join(OUT, path));
    if (!actual.equals(buffer)) problems.push(`内容不一致 ${path}`);
    onDisk.delete(path);
  }
  for (const path of onDisk) problems.push(`多余 ${path}`);
  return problems;
}

const { entries, build } = await collect();

if (CHECK) {
  const problems = await verify(entries);
  if (problems.length > 0) {
    process.stderr.write(`docs/ 与源码不一致（build ${build}）：\n`);
    for (const problem of problems.slice(0, 40)) process.stderr.write(`  ${problem}\n`);
    if (problems.length > 40) process.stderr.write(`  …共 ${problems.length} 项\n`);
    process.stderr.write('运行 node tools/build-shell.mjs 重新生成。\n');
    process.exit(1);
  }
  process.stdout.write(`docs/ 已是最新（build ${build}，${entries.size} 个文件）\n`);
} else {
  await write(entries);
  const total = [...entries.values()].reduce((sum, buffer) => sum + buffer.length, 0);
  process.stdout.write(`已生成 ${relative(process.cwd(), OUT) || OUT}（build ${build}）\n`);
  process.stdout.write(`  ${entries.size} 个文件，共 ${(total / 1024).toFixed(1)} KiB\n`);
  process.stdout.write(`  预览：${posix.join(OUT.split(sep).join('/'))}/index.html\n`);
}
