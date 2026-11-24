/**
 * 把**生产源码**里的函数/方法/常量切出来，在 `node:vm` 沙箱里真跑一遍。
 *
 * 为什么需要它（而不是继续用正则断言源码文本）：
 * `remote/remote.js` 是浏览器外壳（模块顶层就启动 splash、读 localStorage、连 MQTT），
 * Node 里 import 不起来。于是历史上这三组用例退化成"对源码做正则"——它们能证明
 * "某行代码还在"，却证明不了"那段逻辑还算得对"：把 `Date.now() - Math.max(...)`
 * 里的 `Math.max` 换成 `Math.min`，正则照样绿。这里换个做法：
 *
 *   - 只从生产文件里**切出**要测的那几段（函数 / 类方法 / const），不复制逻辑；
 *   - 在 vm 沙箱里执行，注入假的 `localStorage` / 时钟 / `setInterval`；
 *   - 断言**行为**（返回值、副作用、是否触发重建），而不是源码里有没有某个字符串。
 *
 * 适用边界：只能切**自包含**的片段——依赖必须能通过 `globals` 注入（或同一次切片里
 * 带上）。切不出来（比如依赖整个启动流程的 `main()`）就仍然只能做结构断言，那种情况
 * 在用例里写明原因。`remote/`、`web/` 一行都不用改。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** 仓库根目录（从本文件位置推：test/support/x.mjs → ../..）。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 读仓库里的某个文本文件（路径相对仓库根）。 */
export function readRepoFile(relative) {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** 从 `start` 处的 `(` 起做括号平衡，返回配对 `)` 的下标。参数里有字符串时也能过。 */
function matchParen(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') { quote = char; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('参数列表括号不平衡，切片失败');
}

/** 从 `start` 处的 `{` 起做花括号平衡，返回配对 `}` 的下标。 */
function matchBrace(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') { quote = char; continue; }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('函数体花括号不平衡，切片失败');
}

/**
 * 切一个**顶层函数声明**（含 `async function`），返回可直接执行的源码。
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
export function sliceFunction(source, name) {
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*((?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\()`, 'u');
  const matched = pattern.exec(source);
  if (matched === null) throw new Error(`源码里找不到函数声明 ${name}()`);
  const start = matched.index + matched[0].indexOf(matched[1]);
  const parenAt = source.indexOf('(', start + matched[1].indexOf(name) + name.length);
  const parenEnd = matchParen(source, parenAt);
  const braceAt = source.indexOf('{', parenEnd);
  const braceEnd = matchBrace(source, braceAt);
  return source.slice(start, braceEnd + 1);
}

/**
 * 切一个**类方法**（含 `async`），并改写成同名函数声明：
 * `noteFailure(a = {}) { ... }` → `function noteFailure(a = {}) { ... }`。
 * 调用时用 `.call(fakeThis, ...)`，`this` 的字段由用例自己准备。
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
export function sliceMethod(source, name) {
  const pattern = new RegExp(`(?:^|\\n)(\\s+)((?:async\\s+)?${name}\\s*\\()`, 'u');
  const matched = pattern.exec(source);
  if (matched === null) throw new Error(`源码里找不到方法 ${name}()`);
  const isAsync = matched[2].trimStart().startsWith('async');
  const nameAt = matched.index + 1 + matched[1].length + (isAsync ? 'async '.length : 0);
  const parenAt = source.indexOf('(', nameAt + name.length);
  const parenEnd = matchParen(source, parenAt);
  const braceAt = source.indexOf('{', parenEnd);
  const braceEnd = matchBrace(source, braceAt);
  const body = source.slice(nameAt, braceEnd + 1);
  return `${isAsync ? 'async ' : ''}function ${body}`;
}

/**
 * 切一个**顶层 const 声明**（单行或跨行，扫到深度 0 的分号为止）。
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
export function sliceConst(source, name) {
  // 允许行首缩进：外壳里不少 `const xxx = () => {…}` 写在 `main()` 里（缩进两格）。
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*const\\s+${name}\\s*=`, 'u');
  const matched = pattern.exec(source);
  if (matched === null) throw new Error(`源码里找不到 const ${name}`);
  const start = matched.index + matched[0].indexOf('const');
  let depth = 0;
  let quote = null;
  for (let index = matched.index + matched[0].length; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') { quote = char; continue; }
    if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') depth -= 1;
    else if (char === ';' && depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`const ${name} 没找到结束分号，切片失败`);
}

/** vm 里需要能拿到宿主环境的那些全局（Node 已经有的，直接转过去）。 */
function hostGlobals() {  return {
    console,
    crypto: globalThis.crypto,
    btoa: globalThis.btoa?.bind(globalThis),
    atob: globalThis.atob?.bind(globalThis),
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone: globalThis.structuredClone,
  };
}

/**
 * 在沙箱里执行切出来的片段，返回 `{ name: value }`。
 *
 * @param {object} options
 * @param {{source: string, name: string}[]} options.declarations 按顺序执行的片段
 * @param {object} [options.globals] 额外注入的全局（会覆盖同名宿主全局）
 * @param {(() => number)|number} [options.clock] 把沙箱里的 `Date.now()` 钉到这个时钟上
 * @param {string} [options.prologue] 片段执行前的追加代码
 * @returns {Record<string, unknown>}
 */
export function runSlices({ declarations, globals = {}, clock, prologue = '' }) {
  const names = declarations.map((item) => item.name);
  const code = [
    prologue,
    ...declarations.map((item) => item.source),
    `;({ ${names.join(', ')} });`,
  ].join('\n');
  const context = vm.createContext({ ...hostGlobals(), ...globals });
  if (clock !== undefined) {
    // 在沙箱里改 `Date.now`：切出来的片段读的是沙箱自己的 Date，用外部 stub 覆盖不到。
    context.__now = typeof clock === 'function' ? clock : () => clock;
    vm.runInContext('Date.now = () => __now();', context);
  }
  const result = vm.runInContext(code, context, { filename: 'shell-slice.mjs' });
  return { ...result, __context: context };
}

/**
 * 把沙箱里造出来的对象转成「本 realm 的普通对象」。
 *
 * 为什么必须转：`vm.runInNewContext` 有自己的一套内建原型，沙箱里 `{}` 的
 * `Object.prototype` 与宿主的不是同一个，`assert.deepEqual` 会以
 * "Values have same structure but are not reference-equal" 失败。门禁要比的是**值**，
 * 所以先按 JSON 走一遍（这些片段产出的都是 JSON 兼容数据）。
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function plain(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
