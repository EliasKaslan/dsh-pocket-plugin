#!/usr/bin/env node
/**
 * 假宿主（mock host）：按 `/api/v1/*` 契约返回一份**完全虚构**的数据。
 *
 * 两个用途：
 *   1. 截图与文档用——真机截图里会出现用户自己的任务标题、项目名和目录，
 *      那些不能进公开仓库，所以公开素材一律来自这里。
 *   2. E2E 与协议测试用——不依赖 DSH 本体，CI 里也能跑。
 *
 *   node tools/mock-host.mjs --port 47902 [--latency 60] [--quiet]
 *
 * 它是**故意**宽松的：只校验 Bearer 是否存在，不做任何真实鉴权。
 * 绝不要把手机端的信任模型建立在这个文件上，它只出现在开发与测试链路里。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 47902);
const HOST = args.host ?? '127.0.0.1';
const LATENCY = Number(args.latency ?? 55);
const QUIET = args.quiet === true;
const TOKEN = 'mock-token-000000000000000000000000000000000000000000';

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

const MINUTE = 60_000;
const now = Date.now();
const at = (minutesAgo) => now - minutesAgo * MINUTE;

/* ------------------------------- fixtures ------------------------------- */

function message(id, role, text, extra = {}) {
  return { id, role, text, at: at(extra.minutesAgo ?? 12), turn: extra.turn ?? 1, seq: extra.seq ?? 1, ...extra };
}

function transcriptFor(kind) {
  const start = { id: 'd1', role: 'divider', kind: 'turn-start', at: at(14), turn: 1, seq: 0 };
  const user = message('m1', 'user', '把登录页改成手机号 + 验证码，原来的密码登录留一个入口。改完把改动过的文件和验证方式列一下。', { minutesAgo: 14 });

  if (kind === 'short') {
    return [start, user, { ...message('d2', 'divider', '', { minutesAgo: 13, turn: 1, seq: 9 }), kind: 'turn-end', status: 'stopped', reason: '用户取消' }];
  }

  const think = message('m2', 'assistant', '先摸清现有的登录实现，再看验证码发送链路有没有现成的。', {
    minutesAgo: 13, seq: 2, reasoning: '需要先确认项目里有没有短信服务商的 SDK，以及 session 是怎么存的。', model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  });
  const toolRead = { id: 't1', role: 'tool', at: at(13), turn: 1, seq: 3, tool: { callId: 'c1', name: 'read', args: 'src/pages/login.tsx', status: 'done' } };
  const toolReadResult = { id: 'tr1', role: 'tool-result', at: at(13), turn: 1, seq: 4, text: '已读取 214 行：表单用 react-hook-form，提交走 /api/auth/login。', tool: { callId: 'c1', name: 'read', status: 'done', isError: false } };
  const toolGrep = { id: 't2', role: 'tool', at: at(12), turn: 1, seq: 5, tool: { callId: 'c2', name: 'grep', args: 'sendSms|verifyCode', status: 'done' } };
  const toolGrepResult = { id: 'tr2', role: 'tool-result', at: at(12), turn: 1, seq: 6, text: 'src/lib/sms.ts\nsrc/api/auth.ts\nsrc/pages/login.tsx', tool: { callId: 'c2', name: 'grep', status: 'done', isError: false } };

  const answer = message('m3', 'assistant', [
    '改完了，一共动了 4 个文件。',
    '',
    '### 改动',
    '- `src/pages/login.tsx`：拆成「验证码登录」与「密码登录」两个 tab，默认验证码。',
    '- `src/api/auth.ts`：新增 `requestCode()` 与 `loginByCode()`，走原来的 `/api/auth/*` 前缀。',
    '',
    '```ts',
    'export async function loginByCode(phone: string, code: string) {',
    '  return post("/api/auth/login-by-code", { phone, code });',
    '}',
    '```',
    '',
    '| 场景 | 验证方式 |',
    '| --- | --- |',
    '| 验证码 60 秒倒计时 | 手动点两次发送 |',
    '| 密码入口仍可用 | 切到密码 tab 登录 |',
    '',
    '> 短信服务商仍然是 mock，接真实网关时改 `src/lib/sms.ts` 一处即可。',
  ].join('\n'), {
    minutesAgo: 8, seq: 7, model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  });

  const end = { id: 'd2', role: 'divider', kind: 'turn-end', at: at(8), turn: 1, seq: 8, status: 'done', reason: '' };
  return [start, user, think, toolRead, toolReadResult, toolGrep, toolGrepResult, answer, end];
}

const TASKS = [
  {
    id: 'task_mock_001', title: '把登录页改成手机号验证码', status: 'running', statusReason: '',
    cwd: '/home/dev/demo-web', cwdName: 'demo-web', createdAt: at(14), updatedAt: at(0.2), turn: 3,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'mobile',
    parentId: null, isSubagent: false, live: true, blank: false, messageCount: 9, toolCount: 2,
    lastText: '改完了，一共动了 4 个文件。正在跑 lint 与单元测试。', lastRole: 'assistant', titleSource: 'user', childCount: 1,
  },
  {
    id: 'task_mock_002', title: '补一遍登录链路的单元测试', status: 'running', statusReason: '',
    cwd: '/home/dev/demo-web', cwdName: 'demo-web', createdAt: at(3), updatedAt: at(0.4), turn: 1,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'subagent',
    parentId: 'task_mock_001', isSubagent: true, live: true, blank: false, messageCount: 3, toolCount: 1,
    lastText: '正在给 requestCode() 补边界用例。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_003', title: '整理上季度报表并核对差异', status: 'done', statusReason: '',
    cwd: '/home/dev/finance-ops', cwdName: 'finance-ops', createdAt: at(190), updatedAt: at(96), turn: 2,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'desktop',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 12, toolCount: 5,
    lastText: '三张表都核对完了，差异集中在退款科目，明细见下表。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_004', title: '修复导出 CSV 的中文乱码', status: 'done', statusReason: '',
    cwd: '/home/dev/demo-admin', cwdName: 'demo-admin', createdAt: at(420), updatedAt: at(300), turn: 1,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'mobile',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 6, toolCount: 3,
    lastText: '原因是响应头少了 charset，并且没写 BOM。两处都补上了，用 Excel 打开正常。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_005', title: '升级依赖到 Node 22', status: 'error', statusReason: 'pnpm install 失败：peer 依赖冲突',
    cwd: '/home/dev/demo-api', cwdName: 'demo-api', createdAt: at(520), updatedAt: at(480), turn: 1,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'desktop',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 4, toolCount: 2,
    lastText: '卡在 peer 依赖冲突，需要你决定是升 vite 还是锁 esbuild 版本。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_006', title: '批量把截图压到 1080 宽', status: 'cancelled', statusReason: '用户取消',
    cwd: '/home/dev/assets-pipeline', cwdName: 'assets-pipeline', createdAt: at(700), updatedAt: at(690), turn: 1,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'mobile',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 3, toolCount: 1,
    lastText: '已经压完 12 张，剩下的先停下。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_007', title: '给导出的接口写一页文档', status: 'done', statusReason: '',
    cwd: '/home/dev/demo-api', cwdName: 'demo-api', createdAt: at(1500), updatedAt: at(1440), turn: 1,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'docs', origin: 'desktop',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 8, toolCount: 2,
    lastText: '写在 docs/api.md，包含 6 个端点与三个错误码示例。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_008', title: '排查长连接每隔几分钟断开', status: 'done', statusReason: '',
    cwd: '/home/dev/demo-api', cwdName: 'demo-api', createdAt: at(2600), updatedAt: at(2400), turn: 4,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'mobile',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 21, toolCount: 9,
    lastText: '根因是中间层 300 秒空闲超时，加了 45 秒 ping 之后不再断。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_009', title: '把首页图表换成按周聚合', status: 'done', statusReason: '',
    cwd: '/home/dev/demo-admin', cwdName: 'demo-admin', createdAt: at(4300), updatedAt: at(4100), turn: 2,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'desktop',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 9, toolCount: 3,
    lastText: '改成按 ISO 周聚合，周末归到下一个周一。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
  {
    id: 'task_mock_010', title: '为什么构建产物里多了 2MB', status: 'error', statusReason: '命令超时',
    cwd: '/home/dev/demo-web', cwdName: 'demo-web', createdAt: at(6000), updatedAt: at(5900), turn: 1,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: 'standard', origin: 'mobile',
    parentId: null, isSubagent: false, live: false, blank: false, messageCount: 5, toolCount: 2,
    lastText: '跑构建分析时超时了，下次把 timeout 调大再试。', lastRole: 'assistant', titleSource: 'user', childCount: 0,
  },
];

const TRANSCRIPTS = new Map([
  ['task_mock_001', transcriptFor('full')],
  ['task_mock_002', transcriptFor('short')],
]);

const PRESETS = [
  { id: 'standard', name: 'standard', label: '标准', description: '默认预设：完整工具集' },
  { id: 'docs', name: 'docs', label: '文档', description: '只读为主，适合写文档' },
];

const WORKSPACES = [
  { path: '/home/dev/demo-web', name: 'demo-web', tasks: 31, lastAt: at(0.5) },
  { path: '/home/dev/demo-api', name: 'demo-api', tasks: 18, lastAt: at(480) },
  { path: '/home/dev/demo-admin', name: 'demo-admin', tasks: 12, lastAt: at(300) },
  { path: '/home/dev/finance-ops', name: 'finance-ops', tasks: 7, lastAt: at(96) },
];

/* -------------------------------- helpers ------------------------------- */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function publicTask(task) {
  const { ...rest } = task;
  return rest;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const ok = (res, data) => send(res, 200, { ok: true, data });
const bad = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } });

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function authorized(req) {
  const header = String(req.headers.authorization ?? '');
  return /^Bearer\s+mock-token-[0-9]+$/u.test(header) || header === `Bearer ${TOKEN}`;
}

/* ------------------------------ ws plumbing ----------------------------- */

/** 已连接的手机（假的多端扇出，用来验证 UI 的实时刷新）。 */
const clients = new Set();

function broadcast(frame) {
  seq += 1;
  const body = JSON.stringify({ ...frame, at: Date.now(), seq });
  for (const socket of clients) {
    if (socket.readyState === 1) socket.send(body);
  }
}

let seq = 100;

/* ------------------------------ live motion ----------------------------- */

/** 让运行中的任务真的“动起来”，这样截图和 E2E 都能看到实时刷新。 */
function startTicker() {
  const running = TASKS.find((task) => task.id === 'task_mock_001');
  const beats = [
    'lint 通过，测试 42/42。',
    '补了一个验证码过期的用例，现在 44 个测试全绿。',
    '把倒计时改成用 requestAnimationFrame 之外的 setInterval，避免切后台停摆。',
  ];
  let index = 0;
  setInterval(() => {
    if (clients.size === 0) return;
    running.turn = 3;
    running.updatedAt = Date.now();
    running.lastText = beats[index % beats.length];
    index += 1;
    broadcast({ type: 'task.updated', payload: publicTask(running) });
  }, 9_000);
}

/* -------------------------------- server -------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/u, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    res.end();
    return;
  }

  if (!QUIET) process.stdout.write(`${req.method} ${path}${url.search}\n`);
  if (LATENCY > 0) await sleep(LATENCY);

  if (path === '/api/v1/health') {
    ok(res, { ready: true, started: true, port: PORT, tasks: TASKS.length, devices: 1, version: '1.0.0', protocol: 2, uptimeMs: 86_400_000 });
    return;
  }
  if (path.startsWith('/api/v1/') && !authorized(req)) {
    bad(res, 401, 'unauthorized', '未授权：请先登录');
    return;
  }

  if (path === '/api/v1/me') {
    ok(res, { device: { id: 'dev_mock', name: '演示手机', platform: 'android' }, server: { name: '演示电脑' }, model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } });
    return;
  }

  if (path === '/api/v1/tasks' && req.method === 'GET') {
    const includeSubagents = url.searchParams.get('subagents') === '1';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 300) || 300, 500);
    const list = TASKS.filter((task) => includeSubagents || !task.isSubagent).slice(0, limit);
    ok(res, { tasks: list.map(publicTask), total: list.length, offset: 0, limit, hasMore: false, loading: false, loadedAt: Date.now(), error: null });
    return;
  }

  if (path === '/api/v1/tasks' && req.method === 'POST') {
    const body = await readJson(req);
    const prompt = String(body.prompt ?? '').trim();
    if (prompt.length === 0) { bad(res, 400, 'empty-prompt', '任务内容不能为空'); return; }
    const id = `task_mock_${String(TASKS.length + 1).padStart(3, '0')}`;
    const task = {
      id, title: prompt.split('\n')[0].slice(0, 40), status: 'running', statusReason: '',
      cwd: String(body.cwd ?? '/home/dev/demo-web'), cwdName: String(body.cwd ?? 'demo-web').split('/').pop(),
      createdAt: Date.now(), updatedAt: Date.now(), turn: 1,
      model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, preset: String(body.preset ?? 'standard'),
      origin: 'mobile', parentId: null, isSubagent: false, live: true, blank: false,
      messageCount: 1, toolCount: 0, lastText: prompt.slice(0, 120), lastRole: 'user', titleSource: 'user', childCount: 0,
    };
    TASKS.unshift(task);
    TRANSCRIPTS.set(id, [
      { id: 'd1', role: 'divider', kind: 'turn-start', at: Date.now(), turn: 1, seq: 0 },
      message('m1', 'user', prompt, { minutesAgo: 0 }),
    ]);
    broadcast({ type: 'task.created', payload: publicTask(task) });
    ok(res, { task: publicTask(task) });
    return;
  }

  const detail = /^\/api\/v1\/tasks\/([\w-]+)$/u.exec(path);
  if (detail !== null && req.method === 'GET') {
    const task = TASKS.find((item) => item.id === detail[1]);
    if (task === undefined) { bad(res, 404, 'not-found', '任务不存在'); return; }
    ok(res, { task: publicTask(task), messages: TRANSCRIPTS.get(task.id) ?? transcriptFor('short') });
    return;
  }

  const prompt = /^\/api\/v1\/tasks\/([\w-]+)\/prompt$/u.exec(path);
  if (prompt !== null && req.method === 'POST') {
    const body = await readJson(req);
    const text = String(body.prompt ?? '').trim();
    if (text.length === 0) { bad(res, 400, 'empty-prompt', '内容不能为空'); return; }
    const task = TASKS.find((item) => item.id === prompt[1]);
    if (task === undefined) { bad(res, 404, 'not-found', '任务不存在'); return; }
    task.updatedAt = Date.now();
    task.lastText = text.slice(0, 120);
    task.lastRole = 'user';
    broadcast({ type: 'task.message', payload: { taskId: task.id, message: message(`m_${Date.now()}`, 'user', text, { minutesAgo: 0, turn: task.turn }) } });
    broadcast({ type: 'task.updated', payload: publicTask(task) });
    ok(res, { queued: true });
    return;
  }

  const cancel = /^\/api\/v1\/tasks\/([\w-]+)\/cancel$/u.exec(path);
  if (cancel !== null && req.method === 'POST') {
    const task = TASKS.find((item) => item.id === cancel[1]);
    if (task === undefined) { bad(res, 404, 'not-found', '任务不存在'); return; }
    task.status = 'cancelled';
    task.statusReason = '用户取消';
    task.live = false;
    task.updatedAt = Date.now();
    broadcast({ type: 'task.updated', payload: publicTask(task) });
    ok(res, { cancelled: true });
    return;
  }

  if (path === '/api/v1/presets') { ok(res, { presets: PRESETS }); return; }
  if (path === '/api/v1/workspaces') { ok(res, { workspaces: WORKSPACES }); return; }
  if (path === '/api/v1/devices') { ok(res, { devices: [{ id: 'dev_mock', name: '演示手机', platform: 'android', lastSeenAt: Date.now() }] }); return; }
  if (path === '/api/v1/cloud/status') { ok(res, { state: 'online', link: '', broker: 'wss://broker-cn.emqx.io:8084/mqtt' }); return; }
  if (path === '/api/v1/ws-ticket' && req.method === 'POST') { ok(res, { ticket: 'mock-ticket' }); return; }

  if (path === '/api/v1/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now(), seq: 1, payload: { device: { id: 'dev_mock', name: '演示手机' }, server: { name: '演示电脑' } } })}\n\n`);
    const timer = setInterval(() => { res.write(`: ping\n\n`); }, 15_000);
    req.on('close', () => { clearInterval(timer); });
    return;
  }

  bad(res, 404, 'not-found', `没有这个接口：${path}`);
});

const sockets = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    seq += 1;
    ws.send(JSON.stringify({
      type: 'hello', at: Date.now(), seq,
      payload: { device: { id: 'dev_mock', name: '演示手机' }, server: { name: '演示电脑' }, protocol: 2 },
    }));
    ws.send(JSON.stringify({ type: 'bridge.status', at: Date.now(), seq: seq + 1, payload: { ready: true, loading: false, error: null, tasks: TASKS.length } }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
});

/**
 * 只在「被直接运行」时监听。
 *
 * 之前这里无条件 listen：任何人 import 这个文件（测试、别的脚本、将来某个
 * 工具）都会静默占用 47902 端口，而且拿不到句柄去关它 —— 典型的一次
 * `import` 就把端口泄漏到进程结束。被判为库使用时只导出 server，由调用方决定
 * 什么时候监听、监听在哪（`server.listen(0)` 就能拿到系统分配的端口）。
 */
export { server };

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`mock host: http://${HOST}:${PORT}\n`);
    process.stdout.write(`  token : ${TOKEN}\n`);
    process.stdout.write(`  tasks : ${TASKS.length}\n`);
    startTicker();
  });
}
