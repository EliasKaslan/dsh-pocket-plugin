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
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const REMOTE = join(ROOT, 'remote');
const MQTT_DIST = join(ROOT, 'node_modules', 'mqtt', 'dist', 'mqtt.min.js');

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

async function collect() {
  const entries = new Map();

  const webFiles = (await walk(WEB)).filter((path) => !WEB_SKIP.has(path));
  for (const path of webFiles) entries.set(path, await readFile(join(WEB, path)));

  for (const name of REMOTE_FILES) entries.set(name, await readFile(join(REMOTE, name)));

  entries.set('manifest.webmanifest', Buffer.from(shellManifest(await readFile(join(WEB, 'manifest.webmanifest'), 'utf8'))));

  let mqtt;
  try {
    mqtt = await readFile(MQTT_DIST);
    await stat(MQTT_DIST);
  } catch {
    throw new Error(`找不到 ${MQTT_DIST}；先在仓库根目录运行 npm install（或 pnpm install），mqtt 的 dist 里就带上它了`);
  }
  entries.set('mqtt.min.js', mqtt);

  // 哈希覆盖除自身以外的全部产物，任一文件变化都会换掉 SW 缓存名。
  const build = stampHash(entries);

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

  const worker = await readFile(join(REMOTE, 'sw.js'), 'utf8');
  entries.set('sw.js', Buffer.from(
    worker
      .replaceAll('__POCKET_PRECACHE__', JSON.stringify(precache, null, 2))
      .replaceAll('__POCKET_BUILD__', build),
  ));

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
    // mqtt.min.js 是第三方发行物，不是「由本仓源码生成」的东西：它的字节取决于
    // 装的是哪个 mqtt 版本。若按字节比对，CI 里 `npm install` 装到 5.x 的任意小版本
    // 都会让 --check 假红。这里只验它在、且不是空壳（要换版本就重新 build:shell）。
    if (path === 'mqtt.min.js') {
      const actual = await readFile(join(OUT, path));
      if (actual.length < 64 * 1024) problems.push(`可疑 mqtt.min.js（只有 ${actual.length} 字节）`);
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
