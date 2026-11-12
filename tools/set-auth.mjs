#!/usr/bin/env node
/**
 * 设置 / 查看 / 清除手机远程访问的口令。
 *
 * 口令只以 scrypt 加盐哈希落盘（`auth.json`，0600），明文不会写进任何文件。
 * 改口令会让所有已登录的手机立即失效：会话存服务端，删掉即失联。
 *
 *   node tools/set-auth.mjs --user 你的名字            交互式输入（不回显、不进历史）
 *   node tools/set-auth.mjs --user 你的名字 --status   看当前状态
 *   node tools/set-auth.mjs --remove                  取消口令要求
 *   node tools/set-auth.mjs --user 你的名字 --password '...'   仅用于自动化，会留在历史里
 *
 * 数据目录默认 `$DSH_HOME/pocket`（DSH_HOME 未设置时用 `~/.dsh`），
 * 插件配置里写了 `dataDir` 的用 `--data <目录>` 指过去。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { hashPassword } from '../lib/auth.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const argOf = (name, fallback = undefined) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : fallback;
};

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const DATA_DIR = path.resolve(argOf('data', path.join(DSH_HOME, 'pocket')));
const CREDENTIALS = path.join(DATA_DIR, 'auth.json');
const SESSIONS = path.join(DATA_DIR, 'sessions.json');

const MIN_LENGTH = 8;

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** 最早到期的那个会话才是“什么时候需要重新登录”的答案。 */
function nextExpiry(sessions) {
  const alive = sessions.filter((item) => Number(item?.expiresAt) > Date.now());
  if (alive.length === 0) return 0;
  return Math.min(...alive.map((item) => Number(item.expiresAt)));
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function writeToOutput(chunk) {
        // 口令输入不回显；回车仍然回显，否则用户会以为卡住了。
        if (rl.stdoutMuted === true && chunk.includes('\n') === false) rl.output.write('*');
        else rl.output.write(chunk);
      };
    }
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    if (hidden) rl.stdoutMuted = true;
  });
}

if (flag('status')) {
  if (!existsSync(CREDENTIALS)) {
    console.log('未设置口令');
    console.log(`数据目录：${DATA_DIR}`);
    console.log('远程访问需要口令；手机端登录必须用它（局域网直连与配对码都不存在）。');
    process.exit(0);
  }
  const record = readJson(CREDENTIALS) ?? {};
  const sessions = (readJson(SESSIONS)?.sessions ?? []).filter((item) => Number(item?.expiresAt) > Date.now());
  const expiry = nextExpiry(sessions);
  console.log(`用户：${record.user ?? '（未记录）'}`);
  console.log(`哈希：${record.password?.algo ?? '?'} / N=${record.password?.N ?? '?'} / salt ${String(record.password?.salt ?? '').slice(0, 8)}…`);
  console.log(`设置于：${record.updatedAt ? new Date(record.updatedAt).toLocaleString('zh-CN') : '未知'}`);
  console.log(`有效会话：${sessions.length}${expiry > 0 ? `（最早 ${new Date(expiry).toLocaleString('zh-CN')} 到期）` : ''}`);
  console.log(`数据目录：${DATA_DIR}`);
  process.exit(0);
}

if (flag('remove')) {
  rmSync(CREDENTIALS, { force: true });
  rmSync(SESSIONS, { force: true });
  console.log('已删除口令与会话：中继将以「未设置口令」状态关闭，直到你重新设置。');
  console.log('（要让公网无口令可用，还得显式配置 cloud.allowAnonymous: true —— 不建议。）');
  process.exit(0);
}

const user = argOf('user');
let password = argOf('password');

if (typeof user !== 'string' || user.trim().length === 0) {
  console.error('缺少 --user（手机登录页要显示的用户名，例如 --user 小明）');
  process.exit(2);
}

if (typeof password === 'string' && password.length > 0) {
  console.warn('提示：--password 会留在命令历史与进程列表里；能用交互输入就别用它。');
} else if (!process.stdin.isTTY) {
  console.error('没有 --password，且当前不是交互终端。');
  process.exit(2);
} else {
  password = await ask(`为 ${user.trim()} 设置访问口令（至少 ${MIN_LENGTH} 位）：`, { hidden: true });
  const again = await ask('再输入一次：', { hidden: true });
  if (password !== again) {
    console.error('两次输入不一致');
    process.exit(2);
  }
}

if (password.length < MIN_LENGTH) {
  console.error(`口令至少 ${MIN_LENGTH} 位`);
  process.exit(2);
}

// 全空格或全是同一个字符的口令挡一下：这类口令在公网入口上等于没有。
if (new Set(password).size < 3) {
  console.error('口令太简单（至少要有 3 种不同字符）');
  process.exit(2);
}

const record = {
  user: user.trim(),
  password: hashPassword(password),
  updatedAt: Date.now(),
};

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
writeFileSync(`${CREDENTIALS}.tmp`, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
try { chmodSync(`${CREDENTIALS}.tmp`, 0o600); } catch { /* Windows 上是 no-op */ }
renameSync(`${CREDENTIALS}.tmp`, CREDENTIALS);
// 改口令 = 旧会话全部作废，避免旧手机拿着旧令牌继续访问。
rmSync(SESSIONS, { force: true });

console.log(`已设置：${record.user}（scrypt / N=${record.password.N}，明文未落盘）`);
console.log('所有已登录的手机会被要求重新登录。');
console.log('下一步：确认插件配置里 authRequired: true，然后重启 DSH（插件代码改动需要冷启动）。');
