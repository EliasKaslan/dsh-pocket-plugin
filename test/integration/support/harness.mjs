/**
 * 集成测试脚手架：起**真的** BridgeCore + BridgeServer，用真 HTTP 打它。
 *
 * 与 test/e2e/run.mjs 完全同一套约束（这是本仓既有的写法，照抄它的风格）：
 *  - home / dataDir / webRoot / 工作区 / 下载目录全在 os.tmpdir() 下的一次性目录，
 *    after() 里关服务、断连接、删目录，不写进仓库、不留常驻进程；
 *  - 监听 127.0.0.1 的临时端口（port 0 + 读回实际端口），不占用固定端口；
 *  - 不联网、不连 MQTT、不碰 ~/.dsh、不 profile 任何真实 DSH 服务；
 *  - 宿主服务用内存假件注入（agents / sessionQuery / agentPresets），
 *    让「已授权 200」这条腿真的走到业务分支，而不是撞在 503 上。
 *
 * 假件只实现被测代码真实调用到的形状，方法名与 DSH 宿主 API 一致。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { BridgeCore } from '../../../lib/core.mjs';
import { BridgeServer } from '../../../lib/server.mjs';

/** 故意放在 webRoot 之外：任何一次成功穿越都会让这个串出现在响应体里。 */
export const SECRET = 'INTEGRATION-SENTINEL-9c1f0a';
/** 放在 webRoot/index.html 里的哨兵，用来证明回落确实回了 index.html。 */
export const FALLBACK = 'INTEGRATION-INDEX-FALLBACK-4b2e';

const DEFAULT_WEB_FILES = {
  'index.html': `<!doctype html><html><head><title>shell</title></head><body>${FALLBACK}</body></html>`,
  'app.js': 'console.log("shell");\n',
  'app.webmanifest': '{"name":"集成测试外壳","start_url":"."}\n',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"></svg>\n',
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>\n',
  'sw.js': 'const BUILD = "__POCKET_BUILD__";\nself.addEventListener("install", () => {});\n',
  'pair/pair.css': 'body{color:#fff}\n',
  'pair/pair.js': 'export const legacy = true;\n',
};

/** 内存版宿主服务：createTask / prompt / cancel / detail / presets 都能走通。 */
function installFakeHostServices(core) {
  const agents = new Map();
  const created = [];
  const fakeAgents = {
    async create({ sessionId, meta, ...rest }) {
      const agent = {
        header: { id: sessionId, cwd: meta?.cwd, createdAt: Date.now() },
        messages: [],
        cancelled: false,
        async followup(message) { agent.messages.push(message); },
        async cancel(reason) { agent.cancelled = true; agent.cancelReason = reason; },
      };
      agents.set(sessionId, agent);
      created.push({ sessionId, meta, ...rest });
      return { agent };
    },
    get(id) { return agents.get(id); },
    list() { return [...agents.keys()]; },
  };
  const fakeSessionQuery = {
    async listSessions() { return []; },
    async readSurface(id) { return { events: [], capturedThroughSeq: 0, id }; },
  };
  const fakePresets = {
    defaultId: 'it-default',
    async list() {
      return [
        { id: 'it-default', name: '集成默认', description: '假件预设' },
        { id: 'it-other', name: '集成备用', description: '' },
      ];
    },
    async resolve(id) { return { id, broken: undefined }; },
    async mount() { /* 不需要真的挂载 */ },
  };
  // 真实宿主一定有 workspaceRegistry；给一个空列表，才能走到「把最近任务的 cwd
  // 也列成工作区」那条分支（registry 缺失时 workspaces() 直接返回空数组）。
  const fakeWorkspaces = { list() { return []; } };
  core.bindService('agents', fakeAgents);
  core.bindService('sessionQuery', fakeSessionQuery);
  core.bindService('agentPresets', fakePresets);
  core.bindService('workspaceRegistry', fakeWorkspaces);
  return { agents, created };
}

/**
 * 起一个真实的 bridge。返回端口、临时目录、日志与 close()。
 *
 * @param {object} [options]
 * @param {object} [options.config] 覆盖 normalizeConfig 的输入（allowedRoots 默认指向临时工作区）
 * @param {Record<string,string>} [options.webFiles] 追加/覆盖 webRoot 里的静态文件
 * @param {Record<string,string>} [options.downloadFiles] 预置到下载目录里的文件
 * @param {boolean} [options.services] 是否注入假宿主服务（默认 true）
 * @param {boolean} [options.allowedRoots] 是否把临时工作区写进 allowedRoots（默认 true）
 */
export async function startBridge(options = {}) {
  const {
    config = {}, webFiles = {}, downloadFiles = {},
    services = true, allowedRoots = true,
  } = options;

  const root = await mkdtemp(path.join(tmpdir(), 'dsh-pocket-it-'));
  const home = path.join(root, 'home');
  const dataDir = path.join(home, 'pocket');
  const webRoot = path.join(root, 'web');
  const workRoot = path.join(root, 'workspace');
  const downloads = path.join(root, 'downloads');
  await mkdir(webRoot, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  await mkdir(downloads, { recursive: true });

  for (const [relative, content] of Object.entries({ ...DEFAULT_WEB_FILES, ...webFiles })) {
    const file = path.join(webRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  for (const [relative, content] of Object.entries(downloadFiles)) {
    const file = path.join(downloads, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  // webRoot 之外的哨兵：任何一次成功穿越都会把它带进响应体。
  const secretPath = path.join(root, 'secret.txt');
  await writeFile(secretPath, SECRET, 'utf8');

  const logs = [];
  const push = (level) => (...args) => logs.push(`${level} ${args.map((value) => (value instanceof Error ? `${value.message} ${value.stack ?? ''}` : String(value))).join(' ')}`);
  const logger = { info: push('info'), warn: push('warn'), error: push('error') };

  const core = new BridgeCore({}, {
    home,
    dataDir,
    // host 已不是配置项（只监听 127.0.0.1）；这里写它会触发一条废弃告警。
    port: 1,
    // 与线上一致：默认 fail-closed，必须有口令才允许中继；这里只测本机 HTTP 面。
    authRequired: true,
    ...(allowedRoots ? { allowedRoots: [workRoot] } : {}),
    ...config,
  }, logger);
  const server = new BridgeServer(core, { logger, webRoot, downloadDirs: [downloads] });
  // normalizeConfig 把 0 当非法端口回退到 47901；测试必须用临时端口，所以显式改 0，
  // 让 core.start() 走真实的 listen(0) → 读回实际端口。
  core.config.port = 0;
  const fakes = services ? installFakeHostServices(core) : undefined;
  await core.start();

  const ctx = {
    root,
    home,
    dataDir,
    webRoot,
    workRoot,
    downloads,
    secretPath,
    core,
    server,
    httpServer: server.http,
    port: core.port,
    logs,
    fakes,
  };

  ctx.close = async () => {
    try { core.dispose(); } catch { /* 已经关了 */ }
    try { ctx.httpServer?.closeAllConnections?.(); } catch { /* 已断 */ }
    try { server.close(); } catch { /* 已经关了 */ }
    await rm(root, { recursive: true, force: true });
  };

  ctx.mint = (overrides = {}) => core.mintDevice({ name: '集成测试设备', platform: 'test', ...overrides });

  return ctx;
}

/**
 * 发一次真 HTTP 请求，读完整个响应体。
 *
 * 只忽略「响应已经完整收到之后」的 socket 错误（413 这类提前回包的场景），
 * 响应还没到就出错一定 reject —— 不吞任何断言。
 */
export function request(port, pathname, { method = 'GET', headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers, agent: false,
    }, (res) => {
      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          ...extra,
        });
      };
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => finish());
      res.on('aborted', () => finish({ aborted: true }));
      res.on('error', () => { /* 响应体读取错误由 end/close 兜底 */ });
      res.on('close', () => finish({ aborted: res.complete === false }));
    });
    req.on('error', (error) => {
      if (!settled) { settled = true; reject(error); }
    });
    if (rawBody !== undefined) req.write(rawBody);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 发请求并把响应体按 JSON 解析；非 JSON 直接抛错，避免断言落在 undefined 上。 */
export async function requestJson(port, pathname, options) {
  const response = await request(port, pathname, options);
  try {
    return { ...response, json: JSON.parse(response.body) };
  } catch {
    throw new Error(`${options?.method ?? 'GET'} ${pathname} 的响应不是 JSON（HTTP ${response.status}）：${response.body.slice(0, 160)}`);
  }
}

/** 打开一条流式响应（SSE），等响应头到达。 */
export function openStream(port, pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers, agent: false,
    }, (res) => {
      responded = true;
      res.on('error', () => { /* 客户端主动断开时正常发生 */ });
      resolve({
        req,
        res,
        readUntil: (predicate, { timeoutMs = 4000 } = {}) => readUntil(res, predicate, timeoutMs),
        waitEnd: (timeoutMs = 4000) => waitEnd(res, timeoutMs),
        destroy: () => { try { req.destroy(); } catch { /* 已断 */ } },
      });
    });
    req.on('error', (error) => { if (!responded) reject(error); });
    req.end();
  });
}

function readUntil(res, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let text = '';
    let done = false;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res.off('data', onData);
      res.off('end', onEnd);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(undefined, new Error(`等待流内容超时，已收到：${text.slice(0, 240)}`));
    }, timeoutMs);
    timer.unref?.();
    const onData = (chunk) => {
      text += chunk.toString('utf8');
      if (predicate(text)) finish(text);
    };
    const onEnd = () => finish(text);
    res.on('data', onData);
    res.on('end', onEnd);
    if (predicate(text)) finish(text);
  });
}

function waitEnd(res, timeoutMs) {
  if (res.readableEnded || res.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待流关闭超时')), timeoutMs);
    timer.unref?.();
    const finish = () => { clearTimeout(timer); resolve(); };
    res.once('end', finish);
    res.once('close', finish);
  });
}

/**
 * WebSocket 握手。成功时等第一帧（服务端的 hello）再返回；
 * 服务端拒绝（401/403/404/503）时通过 `unexpected-response` 拿状态码。
 */
export async function wsHandshake(port, pathname, { headers = {}, expectFirstFrame = true, timeoutMs = 4000 } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, {
    headers,
    perMessageDeflate: false,
  });
  const messages = [];
  let closed;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('ws 握手超时')); }, timeoutMs);
    timer.unref?.();
    const cleanup = () => clearTimeout(timer);
    socket.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        cleanup();
        resolve({ status: res.statusCode, messages, body: Buffer.concat(chunks).toString('utf8') });
        try { socket.terminate(); } catch { /* 已断 */ }
      });
      res.on('error', () => { /* 拒绝响应不需要正文 */ });
      res.resume();
    });
    socket.on('message', (data) => {
      messages.push(JSON.parse(data.toString('utf8')));
      if (expectFirstFrame && messages.length >= 1) {
        cleanup();
        resolve({ status: 101, messages });
      }
    });
    socket.on('close', (code, reason) => { closed = { code, reason: String(reason) }; });
    socket.on('error', (error) => { cleanup(); reject(error); });
  });
  return { socket, ...result, get closed() { return closed; } };
}

/** 等 socket 关闭，返回服务端给的 close code（用于 4001「设备已吊销」）。 */
export function waitClose(socket, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 ws 关闭超时')), timeoutMs);
    timer.unref?.();
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

/** 断言响应带齐安全头（每个出口都该有，包括 401/403/404/304）。 */
export function securityHeaderErrors(headers) {
  const problems = [];
  const expect = (name, value) => {
    if (headers[name] !== value) problems.push(`${name}=${JSON.stringify(headers[name])}（期望 ${JSON.stringify(value)}）`);
  };
  expect('x-content-type-options', 'nosniff');
  expect('referrer-policy', 'no-referrer');
  expect('x-frame-options', 'DENY');
  expect('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  expect('cross-origin-opener-policy', 'same-origin');
  expect('cross-origin-resource-policy', 'same-origin');
  const csp = String(headers['content-security-policy'] ?? '');
  for (const directive of [
    "default-src 'self'", "img-src 'self' data:", "style-src 'self' 'unsafe-inline'",
    "script-src 'self'", "connect-src 'self' http: https: ws: wss:",
    "font-src 'self' data:", "manifest-src 'self'", "base-uri 'none'", "frame-ancestors 'none'",
  ]) {
    if (!csp.includes(directive)) problems.push(`CSP 缺少 ${directive}`);
  }
  if (/script-src 'self' 'unsafe-inline'/u.test(csp)) problems.push("CSP 的 script-src 混入了 'unsafe-inline'");
  if (headers['access-control-allow-origin'] !== undefined) problems.push('响应带上了 CORS 允许头');
  return problems;
}

/** 断言带齐安全头，失败时把缺哪几条全列出来。 */
export function expectSecurityHeaders(response, label = '') {
  const problems = securityHeaderErrors(response.headers);
  assert.deepEqual(problems, [], `${label} 的安全头不齐：${problems.join('；')}`);
}

/**
 * 断言状态码 + JSON 出口的三件套（content-type / no-store / 安全头），
 * 再返回解析后的对象。JSON 解析失败时直接报出状态码与响应片段。
 */
export function jsonResponse(response, expectedStatus, label = '') {
  assert.equal(response.status, expectedStatus, `${label} 期望 HTTP ${expectedStatus}，实际 ${response.status}：${response.body.slice(0, 200)}`);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8', `${label} 的 content-type 不对`);
  assert.equal(response.headers['cache-control'], 'no-store', `${label} 的 cache-control 必须是 no-store`);
  expectSecurityHeaders(response, label);
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`${label} 的响应不是 JSON：${response.body.slice(0, 160)}`);
  }
}

/** Windows 下路径比较不分大小写；这里统一成小写绝对路径。 */
export function samePath(left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
