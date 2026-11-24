#!/usr/bin/env node
/**
 * 手工运行的「真机复现」探针 —— **不进 CI，也绝不要改名成 `*.test.mjs`**。
 *
 * ⚠️ 为什么不能进 CI：它会读本机 `http://127.0.0.1:47901` 上的电脑端状态接口，
 * 再连**公网** MQTT broker（真实中继），依赖一台正在运行、已配对、且连着网的电脑端。
 * CI 的用例收集是「`test/` 下所有 `*.test.mjs`」（npm test 里的 glob，任意层级递归）：
 * **只要文件名叫 `*.test.mjs`，它就会被自动收进去**，然后在没有电脑端、没有网络、
 * 也没有这台机器的 runner 上必然假红。所以它固定叫 `live-probe.mjs`，只由人手工
 * `node test/support/live-probe.mjs` 跑。
 * 需要自动化覆盖的离线部分已拆到 `test/integration/relay-e2e.test.mjs`（内存 broker +
 * `127.0.0.1:0` 真监听）与 `test/support/relay-client.interop.test.mjs`（跨实现互开）。
 *
 * 干什么：
 *   1. 从 `http://127.0.0.1:47901/api/v1/cloud/status` 取 `data.url`，自己解析出
 *      room / key / token / broker（`#r=&k=&t=&s=`）；
 *   2. 用 `test/support/relay-client.mjs`（Node 版手机端）连**真**公网 broker；
 *   3. 完整走一遍 hello → 等 beat → `req GET /api/v1/tasks`，打印每一帧的
 *      `t` / 耗时 / 体积，以及 `res` 的 status 与正文长度；
 *   4. 再连续发 5 个 `req`（其中一个是 `GET /api/v1/tasks/<真实会话 id>`），
 *      统计成功率与耗时；
 *   5. 用电脑端 `/api/v1/cloud/status` 的 `stats` 前后差值定位**断在哪一帧**：
 *      `rx` 涨了说明帧解开了；`unauthorized` 涨了说明卡在 `authorized()`；
 *      `stale` 涨了说明卡在 `checkFreshness()`；`rpc` 涨了说明转发到了本地 HTTP；
 *      `tx` 涨了但手机没收到 res 说明卡在下行（seal/publish/订阅）。
 *
 * 用法：
 *   node test/support/live-probe.mjs                 # 用离线的设备令牌
 *   node test/support/live-probe.mjs --token <t>     # 手工给一个会话令牌（不进日志）
 *   node test/support/live-probe.mjs --port 47901
 *
 * **绝不打印 `key` 或 `token`**：只显示 room（它本来就在主题里，没有密钥打不开任何
 * 东西）、broker、以及"有没有令牌"的布尔值。
 */
import process from 'node:process';

import { createRelayClient } from './relay-client.mjs';

const DEFAULT_PORT = 47901;
const FRAME_LIMIT = 12 * 1024;

function argOf(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function port() {
  const value = Number(argOf('--port'));
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT;
}

/** 从状态接口的 `data.url` 里解析出连接参数；`key`/`token` 只留在内存里。 */
export function parseLinkUrl(url) {
  const parsed = new URL(String(url));
  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(hash);
  const room = params.get('r') ?? '';
  const key = params.get('k') ?? '';
  const token = params.get('t') ?? '';
  const broker = params.get('s') ?? '';
  const name = params.get('n') ?? 'DSH';
  if (room.length === 0 || key.length === 0) throw new Error('链接里缺少 r/k，无法连接');
  return { room, key, token, broker, name };
}

async function readStatus(base) {
  const response = await fetch(`${base}/api/v1/cloud/status`, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  if (payload?.ok !== true) throw new Error(`状态接口返回异常（HTTP ${response.status}）`);
  return payload.data;
}

/** 只取诊断需要的计数，绝不回显 url（里面含密钥与令牌）。 */
function statSnapshot(data) {
  const stats = data?.stats ?? {};
  return {
    state: data?.state ?? '?',
    rx: Number(stats.rx) ?? 0,
    tx: Number(stats.tx) ?? 0,
    rpc: Number(stats.rpc) ?? 0,
    unauthorized: Number(stats.unauthorized) ?? 0,
    stale: Number(stats.stale) ?? 0,
    errors: Number(stats.errors) ?? 0,
    wsOpen: Number(stats.wsOpen) ?? 0,
    lastPhoneAt: Number(data?.lastPhoneAt) ?? 0,
    sockets: Number(data?.sockets) ?? 0,
    authEnabled: data?.auth?.enabled === true,
    anonymous: data?.guard?.anonymous === true,
    blocked: data?.guard?.blocked?.code ?? null,
  };
}

function diff(before, after) {
  const keys = ['rx', 'tx', 'rpc', 'unauthorized', 'stale', 'errors', 'wsOpen'];
  const out = {};
  for (const key of keys) out[key] = (after[key] ?? 0) - (before[key] ?? 0);
  return out;
}

function fmtMs(ms) {
  return `${ms >= 0 ? '+' : ''}${ms}ms`;
}

/** 判断这一次「请求不被应答」断在哪一层。 */
function diagnose(snapshotDiff, responses) {
  const notes = [];
  const gotSomething = responses.some((entry) => entry.t === 'res');
  if (snapshotDiff.rx <= 0 && !gotSomething) {
    notes.push('电脑端 rx 没有增长：帧没到 / 解不开（密钥或主题不对，或下行订阅缺失）');
    return notes;
  }
  if (snapshotDiff.unauthorized > 0) {
    notes.push('电脑端 unauthorized 增长：断在 CloudLink.authorized()（token 不被 Auth.check() 认可）');
  }
  if (snapshotDiff.stale > 0) {
    notes.push('电脑端 stale 增长：断在 checkFreshness()（seq/ts/sid 判据）');
  }
  if (snapshotDiff.rpc > 0) {
    notes.push('电脑端 rpc 增长：请求已经转发到本地 HTTP 桥');
  }
  if (snapshotDiff.rpc > 0 && snapshotDiff.tx > 0 && !gotSomething) {
    notes.push('电脑端发了下行帧但手机没收到：断在下行（seal/publish/下行订阅）');
  }
  if (notes.length === 0) notes.push('未发现丢帧：所有帧都走通了');
  return notes;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const base = `http://127.0.0.1:${port()}`;
  const lines = [];
  const say = (line = '') => { lines.push(line); process.stdout.write(`${line}\n`); };

  say(`[status] ${base}/api/v1/cloud/status`);
  let status;
  try {
    status = await readStatus(base);
  } catch (error) {
    say(`[fatal] 读不到电脑端状态：${error?.message ?? error}`);
    say('[hint] 插件没在跑，或者端口不是 47901（用 --port 指定）');
    return 1;
  }
  const before = statSnapshot(status);
  const link = parseLinkUrl(status.url);
  say(`[link] room=${link.room} broker=${link.broker || '(默认)'} name=${link.name}`);
  say(`[link] key=${'*'.repeat(6)}(已隐藏) token=${link.token.length > 0 ? '来自链接 t= (已隐藏)' : '缺失'}`);
  say(`[desktop] state=${before.state} auth.enabled=${before.authEnabled} anonymous=${before.anonymous} blocked=${before.blocked ?? '-'}`);
  say(`[desktop] stats rx=${before.rx} tx=${before.tx} rpc=${before.rpc} unauthorized=${before.unauthorized} stale=${before.stale}`);

  const explicitToken = argOf('--token') ?? process.env.POCKET_RELAY_TOKEN ?? '';
  const useToken = explicitToken.length > 0 ? explicitToken : link.token;
  say(`[client] 使用${explicitToken.length > 0 ? '命令行给的会话' : '链接里的设备'}令牌（${useToken.length} 字符，不打印内容）`);

  const client = createRelayClient({
    room: link.room,
    key: link.key,
    token: useToken,
    broker: link.broker || undefined,
    name: 'node-live-probe',
  });

  const frames = [];
  const sendTimes = [];
  let lastAt = Date.now();
  let now = () => Date.now();
  client.on('frame', (message, meta) => {
    const at = meta?.at ?? Date.now();
    const delta = at - lastAt;
    lastAt = at;
    frames.push({ t: String(message.t), bytes: meta?.bytes ?? 0, delta, message });
    const extra = [];
    if (message.t === 'res') extra.push(`status=${message.status}`, `body=${Buffer.from(String(message.body ?? ''), 'base64').length}B`, `enc=${message.enc || 'plain'}`);
    if (message.t === 'reject') extra.push(`code=${message.code}`);
    if (message.t === 'part') extra.push(`part=${Number(message.seq) + 1}/${Number(message.total)}`);
    if (message.t === 'hello' || message.t === 'beat') extra.push(`name=${message.name ?? '?'}`);
    say(`[frame] t=${String(message.t).padEnd(6)} bytes=${String(meta?.bytes ?? 0).padStart(7)} Δ=${fmtMs(delta).padStart(8)} ${extra.join(' ')}`);
  });
  client.on('unseal-error', (error) => say(`[frame] 解不开一帧：${error?.message ?? error}`));
  client.on('transport-error', (error) => say(`[transport] ${error?.message ?? error}`));

  const started = Date.now();
  try {
    await client.connect();
  } catch (error) {
    say(`[fatal] 连不上 broker：${error?.message ?? error}`);
    client.close();
    return 1;
  }
  say(`[connect] 已连上 broker（${Date.now() - started}ms）sid=${client.sid}`);

  // 1) hello → 等 beat：证明「手机连上中继」这一半是好的。
  lastAt = Date.now();
  const beatPromise = client.waitForFrame((message) => message.t === 'beat', 12_000).catch(() => null);
  const helloSentAt = Date.now();
  await client.announce(true);
  const beat = await beatPromise;
  const beatDelta = Date.now() - helloSentAt;
  const helloEcho = frames.filter((frame) => frame.t === 'hello').length;
  const beatCount = frames.filter((frame) => frame.t === 'beat').length;
  say(`[step1] hello → 收到 hello回声=${helloEcho} 条、beat=${beatCount} 条；首个 beat 往返 ${beat ? `${beatDelta}ms` : '超时'}`);

  // 2) 鉴权探测：电脑端到底要不要口令，怎么评价我们这枚令牌。
  let authReply = null;
  try {
    authReply = await client.checkAuth({ timeout: 8_000 });
    const review = {
      required: authReply.required === true,
      ok: authReply.ok === true,
      revoked: authReply.revoked === true,
      deviceToken: typeof authReply.deviceToken === 'string' && authReply.deviceToken.length > 0 ? 'echoed' : 'none',
    };
    say(`[step2] auth 帧 → required=${review.required} ok=${review.ok} revoked=${review.revoked} deviceToken=${review.deviceToken}`);
  } catch (error) {
    say(`[step2] auth 帧超时：${error?.message ?? error}`);
  }

  // 3) 主探针：GET /api/v1/tasks
  const responses = [];
  const rtt = [];
  const firstAt = Date.now();
  let listReply = null;
  try {
    listReply = await client.request('GET', '/api/v1/tasks', {
      headers: { authorization: `Bearer ${useToken}`, accept: 'application/json' },
      timeout: 20_000,
    });
    const ms = Date.now() - firstAt;
    rtt.push(ms);
    responses.push({ t: 'res', status: listReply.status, ms });
    say(`[step3] GET /api/v1/tasks → status=${listReply.status} 往返=${ms}ms 正文=${listReply.body.length}B enc=${listReply.enc || 'plain'}`);
    const text = listReply.body.toString('utf8').slice(0, 200);
    if (listReply.status !== 200) say(`[step3] 正文：${text}`);
  } catch (error) {
    const ms = Date.now() - firstAt;
    responses.push({ t: 'error', code: error?.code ?? 'error', ms });
    say(`[step3] GET /api/v1/tasks → 失败：${error?.message ?? error}（${ms}ms）`);
  }

  // 从列表里挑一个真实会话 id。中继这条路若被拒，就**绕开中继**、用同一枚令牌直连
  // 本地桥再要一次列表 —— 那只是取一个 id，不进中继诊断结论，但能让详情请求用的
  // 是真实会话 id 而不是占位串。顺带证明「这枚令牌对本地桥是有效的」。
  const pickTaskId = (body) => {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      const items = parsed?.data?.tasks ?? parsed?.data?.items ?? parsed?.tasks ?? parsed?.items ?? [];
      const first = Array.isArray(items) ? items[0] : undefined;
      return typeof first?.id === 'string' ? first.id : null;
    } catch {
      return null;
    }
  };
  let taskId = listReply?.status === 200 ? pickTaskId(listReply.body) : null;
  let idSource = '来自中继列表返回';
  if (taskId === null) {
    try {
      const direct = await fetch(`${base}/api/v1/tasks`, { headers: { authorization: `Bearer ${useToken}`, accept: 'application/json' } });
      const text = await direct.text();
      say(`[bridge] 本地桥直连（同一枚令牌，不经中继）→ status=${direct.status} 正文=${Buffer.byteLength(text)}B`);
      if (direct.status === 200) {
        taskId = pickTaskId(Buffer.from(text, 'utf8'));
        idSource = '来自本地桥直取（中继被拒）';
      }
    } catch (error) {
      say(`[bridge] 本地桥直连失败：${error?.message ?? error}`);
    }
  }
  if (taskId === null) taskId = 'task_missing_from_list';
  say(`[step4] 详情用的会话 id = ${taskId}（${idSource}）`);

  // 4) 连续 5 个 req（含一个详情）。目标是量成功率与耗时，而不是压测。
  const plan = [
    ['GET', '/api/v1/tasks'],
    ['GET', `/api/v1/tasks/${taskId}`],
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/tasks'],
    ['GET', '/api/v1/presets'],
  ];
  for (let index = 0; index < plan.length; index += 1) {
    const [method, path] = plan[index];
    const at = Date.now();
    try {
      const reply = await client.request(method, path, {
        headers: { authorization: `Bearer ${useToken}`, accept: 'application/json' },
        timeout: 20_000,
      });
      const ms = Date.now() - at;
      rtt.push(ms);
      responses.push({ t: 'res', status: reply.status, ms, path });
      frames.push({ t: 'res', bytes: reply.bytes ?? 0 });
      say(`[req ${index + 1}/5] ${method} ${path} → status=${reply.status} 往返=${ms}ms 正文=${reply.body.length}B ${reply.status === 200 ? 'OK' : '非 200'}`);
    } catch (error) {
      const ms = Date.now() - at;
      responses.push({ t: 'error', code: error?.code ?? 'error', ms, path });
      say(`[req ${index + 1}/5] ${method} ${path} → 失败：${error?.message ?? error}（${ms}ms）`);
    }
    await sleep(120);
  }

  // 5) 用电脑端计数差值定断层。
  let after;
  try {
    after = statSnapshot(await readStatus(base));
  } catch {
    after = { ...before };
  }
  const delta = diff(before, after);
  say(`[desktop] 差值 rx=${delta.rx} tx=${delta.tx} rpc=${delta.rpc} unauthorized=${delta.unauthorized} stale=${delta.stale} errors=${delta.errors} wsOpen=${delta.wsOpen}`);
  const ok = responses.filter((entry) => entry.t === 'res' && entry.status === 200).length;
  const answered = responses.filter((entry) => entry.t === 'res').length;
  const failed = responses.length - answered;
  const total = responses.length;
  const avg = rtt.length > 0 ? Math.round(rtt.reduce((sum, value) => sum + value, 0) / rtt.length) : 0;
  const max = rtt.length > 0 ? Math.max(...rtt) : 0;
  say(`[summary] req 共 ${total} 次：有应答 ${answered} 次（其中 200 ${ok} 次），无应答 ${failed} 次；平均 ${avg}ms，最大 ${max}ms`);
  for (const note of diagnose(delta, responses)) say(`[diag] ${note}`);

  // 6) 如果链接令牌被拒，顺手确认「唯一的换令路要口令」——只报 reason，不带口令。
  const unauthorized = responses.some((entry) => entry.status === 401);
  if (unauthorized) {
    try {
      const reply = await client.login({ user: 'probe-should-not-exist', password: '' , timeout: 8_000 });
      say(`[step5] login 探测 → ok=${reply.ok === true} reason=${reply.reason ?? '-'} retryAfterSec=${reply.retryAfterSec ?? 0}`);
    } catch (error) {
      say(`[step5] login 探测超时：${error?.message ?? error}`);
    }
    say('[diag] 链接里的 t= 是设备令牌，CloudLink.authorized() 只查 Auth.check() 的会话表 → 必然 401；换会话令牌必须走 login，而口令未知');
  }

  client.close();
  say(`[done] 共收到 ${frames.length} 帧（含分片），统计 tx=${client.stats.tx} rx=${client.stats.rx} res=${client.stats.res} reject=${client.stats.reject} beat=${client.stats.beat}`);
  return failed > 0 ? 1 : 0;
}

const isMain = process.argv[1]?.replace(/\\/gu, '/').endsWith('live-probe.mjs');
if (isMain) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`[fatal] ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
