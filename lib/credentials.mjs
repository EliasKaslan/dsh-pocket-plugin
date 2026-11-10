/**
 * 账号 + 口令的校验与落盘 —— 配对页直接改口令时唯一的写入口。
 *
 * 为什么要有这个模块：口令以前只能由 `tools/set-auth.mjs` 在命令行写，
 * 于是「手机要登录」这件事在界面里没有任何入口。现在配对页可以改口令，
 * 写盘逻辑就必须只有一处，而且要比 CLI 更小心：它跑在长期驻留的 HTTP
 * 进程里，任何一次半截写都可能让用户再也登不进来。
 *
 * 三条硬约束：
 *   1. 结构必须与 `tools/set-auth.mjs` 写出的 auth.json 完全同构
 *      （`user` / `password{algo,salt,hash,N,r,p}` / `updatedAt`），否则 Auth 读不回来；
 *   2. 原子写：同目录临时文件（0600）→ fsync → rename。rename 失败时删掉临时文件，
 *      旧 auth.json 一个字节都不动 —— 失败可回滚，绝不截断旧凭据；
 *   3. 本模块只收明文、只写出哈希：不写日志、不回传，明文也不进临时文件名。
 */
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.mjs';
import { randomHex } from './util.mjs';

export const USER_MIN_LENGTH = 1;
export const USER_MAX_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * 账号允许的字符：ASCII 字母数字、`.` `_` `-` `@`，以及中日韩表意文字
 * （含扩展 A 与兼容区）。故意不用 `\p{L}`：那会把各种会影响日志与
 * 界面显示的字母也放进来；这里只放「用户真的会拿来当账号」的那几类。
 */
const USER_ALLOWED = /^[A-Za-z0-9._@\-\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/u;

/** 码点长度：一个 emoji 算 1 个字符，而不是 JS 的 2 个 UTF-16 单元。 */
function charLength(value) {
  return [...value].length;
}

/**
 * 校验待写入的账号 + 口令。
 *
 * @param {{user?: unknown, password?: unknown}} input
 * @returns {{ok: boolean, reason: string, user: string}} 失败时 `user` 恒为空串
 */
export function validateCredentials({ user, password } = {}) {
  const fail = (reason) => ({ ok: false, reason, user: '' });

  if (typeof user !== 'string' || user.trim().length === 0) {
    return fail('账号不能为空：手机登录页要显示这个名字');
  }
  const trimmed = user.trim();
  if (charLength(trimmed) > USER_MAX_LENGTH) {
    return fail(`账号最多 ${USER_MAX_LENGTH} 个字符`);
  }
  if (!USER_ALLOWED.test(trimmed)) {
    return fail('账号只能包含字母、数字、中文和 . _ - @');
  }

  if (typeof password !== 'string' || password.length === 0) {
    return fail('口令不能为空');
  }
  const length = charLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    return fail(`口令至少 ${PASSWORD_MIN_LENGTH} 个字符`);
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return fail(`口令最多 ${PASSWORD_MAX_LENGTH} 个字符`);
  }
  return { ok: true, reason: '', user: trimmed };
}

/**
 * 原子写入 auth.json（0600）。返回不含哈希的摘要，方便调用方记审计日志。
 *
 * 临时文件写在**同目录**：跨盘 rename 不是原子操作，写到系统临时目录再搬过来
 * 会在 rename 那一刻把「原子」这件事丢掉。
 *
 * @param {string} file auth.json 的绝对路径
 * @param {{user: string, password: string}} credentials 明文口令只在这一层出现
 * @returns {{user: string, updatedAt: number}}
 */
export function writeCredentials(file, { user, password } = {}) {
  // 双保险：即使调用方跳过了校验，也不能把非法账号写进凭据文件。
  const check = validateCredentials({ user, password });
  if (!check.ok) {
    const error = new Error(check.reason);
    error.code = 'invalid_credentials';
    throw error;
  }

  const record = {
    user: check.user,
    password: hashPassword(password),
    updatedAt: Date.now(),
  };

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomHex(4)}.tmp`;
  try {
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      try { fsyncSync(fd); } catch { /* 尽力而为：断电场景不靠这一行兜底 */ }
    } finally {
      closeSync(fd);
    }
    try { chmodSync(temp, 0o600); } catch { /* Windows 上是 no-op，失败不致命 */ }
    renameSync(temp, file);
  } catch (error) {
    // 关键：临时文件里是口令哈希，失败时不能把它留在数据目录里；
    // 而旧 auth.json 从头到尾没被打开过，所以它一定还是完整的。
    try { rmSync(temp, { force: true }); } catch { /* 已经没了 */ }
    throw error;
  }
  // rename 保留临时文件的模式；这一步只是把「权限尽力 0600」在最终路径上落实。
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs */ }

  return { user: record.user, updatedAt: record.updatedAt };
}

/**
 * 改口令 = 所有手机必须重新登录：删掉 sessions.json 就是「全部作废」。
 * 文件不存在视为成功（本来就是我们要的状态）。
 *
 * @param {string} file sessions.json 的绝对路径
 * @returns {true}
 */
export function clearSessions(file) {
  try {
    rmSync(file, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}
