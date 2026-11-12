import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const BUILD = join(ROOT, 'tools', 'build-shell.mjs');

let out;
let second;

async function build(target) {
  return run(process.execPath, [BUILD, '--out', target], { cwd: ROOT });
}

/** 递归列出相对路径（产物有 lib/ views/ icons/ 三层）。 */
async function walk(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full, base));
    else found.push(full.slice(base.length + 1).split('\\').join('/'));
  }
  return found.sort();
}

before(async () => {
  out = await mkdtemp(join(tmpdir(), 'pocket-shell-'));
  second = await mkdtemp(join(tmpdir(), 'pocket-shell2-'));
  await Promise.all([build(out), build(second)]);
});

after(async () => {
  await Promise.all([rm(out, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
});

test('构建产物包含外壳需要的全部文件', async () => {
  const required = [
    'index.html', 'app.js', 'app.css', 'store.js', 'sw.js', 'remote.js', 'remote.css',
    'mqtt.min.js', 'manifest.webmanifest', 'favicon.svg', '.nojekyll',
    'lib/dom.js', 'lib/format.js', 'lib/markdown.js', 'lib/net.js', 'lib/sprite.js', 'lib/ui.js',
    'views/tasks.js', 'views/detail.js', 'views/compose.js', 'views/settings.js', 'views/connect.js',
    'icons/icon-192.png', 'icons/icon-512.png',
  ];
  for (const file of required) {
    await assert.doesNotReject(stat(join(out, file)), `缺少 ${file}`);
  }
});

test('不把只属于局域网布局的文件带进静态站', async () => {
  const entries = await readdir(out);
  assert.equal(entries.includes('pair.js'), false);
  assert.equal(entries.includes('pair.css'), false);
});

test('sw.js 的占位符已被内容哈希替换', async () => {
  const worker = await readFile(join(out, 'sw.js'), 'utf8');
  assert.equal(worker.includes('__POCKET_BUILD__'), false, '构建后不应残留占位符');
  const match = /const BUILD = '([0-9a-f]{16})';/u.exec(worker);
  assert.notEqual(match, null, 'BUILD 必须是 16 位十六进制内容哈希');
  assert.match(worker, new RegExp(`pocket-shell-\\$\\{BUILD\\}|pocket-shell-${match[1]}`));
});

test('index.html 里没有绝对路径（可部署在任意子路径）', async () => {
  const html = await readFile(join(out, 'index.html'), 'utf8');
  const offenders = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/gu)].map((match) => match[1]);
  assert.deepEqual(offenders, [], `发现绝对路径：${offenders.join(', ')}`);
  assert.match(html, /src="\.\/remote\.js"/u);
  assert.match(html, /href="\.\/app\.css"/u);
});

test('外壳 index.html 带 CSP 与视口设置', async () => {
  const html = await readFile(join(out, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /script-src 'self'/u, 'CSP 必须禁止内联与第三方脚本');
  assert.match(html, /interactive-widget=resizes-content/u, '否则软键盘会盖住输入框');
  assert.match(html, /viewport-fit=cover/u);
});

test('manifest 用相对 start_url 与相对图标', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('./'), `图标路径必须是相对路径：${icon.src}`);
  }
});

test('app.js 的每一条相对 import 在产物里都有对应文件', async () => {
  const seen = new Set();
  const queue = ['app.js'];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const source = await readFile(join(out, current), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s+'(\.[^']+)'/gu)) {
      const target = match[1].replace(/^\.\//u, '');
      const resolved = current.includes('/') ? `${current.slice(0, current.lastIndexOf('/'))}/${target}` : target;
      const normalised = resolved.replace(/\/\.\//gu, '/');
      await assert.doesNotReject(stat(join(out, normalised)), `${current} 引用了不存在的 ${normalised}`);
      queue.push(normalised);
    }
  }
  assert.ok(seen.size >= 12, `只走查到 ${seen.size} 个模块，链路可能断了`);
});

test('两次构建逐字节相同（可复现，CI 才敢用 --check）', async () => {
  const files = await walk(out);
  assert.ok(files.length > 20);
  for (const file of files) {
    const a = await readFile(join(out, file));
    const b = await readFile(join(second, file));
    assert.ok(a.equals(b), `${file} 两次构建结果不同`);
  }
});

test('--check 对同步的产物返回 0，对漂移返回非 0', async () => {
  await run(process.execPath, [BUILD, '--check', '--out', out], { cwd: ROOT });

  const target = join(out, 'app.css');
  const original = await readFile(target);
  await writeFile(target, `${original}\n/* drift */\n`);
  try {
    await assert.rejects(
      run(process.execPath, [BUILD, '--check', '--out', out], { cwd: ROOT }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /内容不一致 app\.css/u);
        return true;
      },
    );
  } finally {
    await writeFile(target, original);
  }
});

test('真实产物：docs/sw.js 的 PRECACHE 可解析且每个文件都存在', async () => {
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const sw = fsm.readFileSync(pathm.join(root, 'docs', 'sw.js'), 'utf8');
  const hit = /const PRECACHE = ([\s\S]*?);\n/u.exec(sw);
  assert.ok(hit !== null, 'docs/sw.js 里必须有 PRECACHE');
  const list = JSON.parse(hit[1]);
  assert.ok(Array.isArray(list) && list.length >= 5, 'PRECACHE 必须是非空数组');
  for (const entry of list) {
    const rel = entry.replace(/^\.\//u, '');
    const file = rel === '' ? pathm.join(root, 'docs', 'index.html') : pathm.join(root, 'docs', rel);
    assert.ok(fsm.existsSync(file), 'PRECACHE 里的文件必须真实存在: ' + entry);
  }
  assert.ok(!/__POCKET_[A-Z_]+__/u.test(sw), '产物不得残留占位符');
});

test('remote/ 下新增的脚本必须在构建白名单里（否则会被静默丢弃）', async () => {
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const build = fsm.readFileSync(pathm.join(root, 'tools', 'build-shell.mjs'), 'utf8');
  const block = /const REMOTE_FILES = \[([\s\S]*?)\];/u.exec(build);
  assert.ok(block !== null, '必须能读到 REMOTE_FILES');
  const listed = new Set([...block[1].matchAll(/'([^']+)'/gu)].map((hit) => hit[1]));
  // sw.js 由构建单独处理；pair.js/pair.css 属于局域网页，不走外壳产物。
  const skip = new Set(['sw.js', 'pair.js', 'pair.css']);
  const dir = pathm.join(root, 'remote');
  for (const name of fsm.readdirSync(dir)) {
    if (skip.has(name)) continue;
    if (!/\.(js|css)$/u.test(name)) continue;
    assert.ok(listed.has(name), 'remote/' + name + ' 不在 REMOTE_FILES 里，会被构建静默丢弃');
  }
});
