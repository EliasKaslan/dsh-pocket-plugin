#!/usr/bin/env node
/**
 * 逐文件 `node --check` —— 语法级守门。
 *
 * 为什么需要它：本仓的 `.mjs` 大多是 Node 直接执行的 ESM，一处语法错误不会在
 * 单测里报「哪个文件坏了」，而是整条加载链断掉、报一段没有文件名的栈。CI 里先
 * 跑这一条，失败信息才指向真正的文件。
 *
 *   node tools/check-syntax.mjs            检查全部
 *   node tools/check-syntax.mjs lib web    只查这些目录
 *
 * 退出码：全过 0；有失败 1（并打印每个失败文件 + node --check 的原文）。
 */
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'test-results', 'artifacts']);
/** 第三方压缩产物：语法一定过得去，检查它只是浪费几秒。 */
const SKIP_FILES = new Set(['mqtt.min.js']);
const EXTENSIONS = ['.mjs', '.js'];

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...await walk(join(dir, entry.name)));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (!EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const targets = process.argv.slice(2);
const roots = targets.length > 0 ? targets.map((item) => resolve(ROOT, item)) : [ROOT];

const files = [];
for (const root of roots) files.push(...await walk(root));
files.sort();

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').slice(0, 6).join('\n');
    failures.push({ file: relative(ROOT, file).split(sep).join('/'), detail });
  }
}

if (failures.length > 0) {
  process.stderr.write(`语法检查失败 ${failures.length}/${files.length}：\n`);
  for (const failure of failures) process.stderr.write(`\n  ${failure.file}\n${failure.detail}\n`);
  process.exit(1);
}

process.stdout.write(`语法检查通过：${files.length} 个文件\n`);
