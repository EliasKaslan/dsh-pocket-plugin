#!/usr/bin/env node
/**
 * dsh-pocket 命令行：给「手边只有终端」的场景用。
 *
 *   dsh-pocket pair            打印中继链接、二维码与配对码（别名 link）
 *   dsh-pocket status          健康状态、中继状态、已配对设备数
 *   dsh-pocket devices         列出已配对设备
 *   dsh-pocket revoke <id|all> 撤销某台（或全部）设备
 *   dsh-pocket broker [url]    查看 / 设置中继地址
 *
 * 所有请求都打到 127.0.0.1 的插件端口：这些接口在电脑端只对回环开放，
 * 没有任何一条能给远程用，所以这个 CLI 天然不可能从手机侧调用。
 *
 * 手机端的唯一入口是加密中继：链接来自 `remoteView().url`（`cloud.status().url`，
 * 形态 `<appBase>#s=<broker>&r=<room>&k=<key>`）。`/api/v1/pairing` 只给配对码，
 * 不再带任何地址，所以这里没有中继链接时就只报原因和下一步，绝不打印本机地址。
 */
import { qrcode } from '../lib/vendor/qrcode.mjs';

const DEFAULT_PORT = 47901;

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const BASE = String(flag('base') ?? process.env.DSH_POCKET_BASE ?? `http://127.0.0.1:${flag('port') ?? process.env.DSH_POCKET_PORT ?? DEFAULT_PORT}`).replace(/\/+$/u, '');

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code) => (text) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : String(text));
const dim = paint('2');
const bold = paint('1');
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text.length > 0 ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const code = payload?.error?.code ?? `http-${response.status}`;
    const message = payload?.error?.message ?? text.slice(0, 200) ?? '';
    throw new Error(`${code}: ${message}`.trim());
  }
  return payload?.data ?? payload;
}

/** 终端二维码：两行像素拼成一行字符，省一半高度。 */
function renderQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const pad = 2;
  const dark = (row, col) => {
    if (row < 0 || col < 0 || row >= count || col >= count) return false;
    return qr.isDark(row, col);
  };
  const lines = [];
  for (let row = -pad; row < count + pad; row += 2) {
    let line = '';
    for (let col = -pad; col < count + pad; col += 1) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  // 二维码浅色模块也要有背景色，否则深色终端里会反色扫不出来。
  return lines.map((line) => (useColor ? `\u001B[30;47m${line}\u001B[0m` : line)).join('\n');
}

function fail(error) {
  process.stderr.write(`${red('错误')} ${error?.message ?? error}\n`);
  process.stderr.write(`${dim('提示：插件没在跑时先启动 DSH，或用 --base 指定地址。')}\n`);
  process.exitCode = 1;
}

/**
 * 中继不可用：给「为什么」和「下一步」，两者都不含任何地址。
 * 中继是唯一通路，所以这里没有备用方案可给。
 */
function relayHint(remote) {
  const state = typeof remote?.state === 'string' ? remote.state : 'unknown';
  const url = typeof remote?.url === 'string' ? remote.url : '';
  const appBase = typeof remote?.appBase === 'string' ? remote.appBase : '';
  const lastError = typeof remote?.lastError === 'string' ? remote.lastError : '';
  if (state === 'online' && url.length > 0) return null;
  if (state === 'unconfigured' || (appBase.length === 0 && url.length === 0)) {
    return {
      why: lastError || '中继未启动：没有配置手机端外壳地址（cloud.appBase）',
      next: '在电脑的 DSH 插件配置里把 cloud.appBase 设成你自己托管的静态外壳地址，然后重启 DSH，再跑一次 pair。',
    };
  }
  if (state === 'blocked') {
    return {
      why: lastError || '中继未启动：本机还没有访问口令（fail-closed，刻意的失败即关闭）',
      next: '先在电脑上设置口令（本仓 tools/set-auth.mjs，写入数据目录的 auth.json），或把 auth.required 改为 false，然后重试。',
    };
  }
  if (state === 'disabled') {
    return {
      why: lastError || '远程访问被暂停了',
      next: '在电脑配对页的中继卡片里点「启用远程」，然后重试。',
    };
  }
  if (state === 'error') {
    return {
      why: lastError || '中继启动失败，但没有给出原因',
      next: '看 DSH 日志里「远程访问未启动」那一行，修好后重试。',
    };
  }
  if (state === 'online') {
    return {
      why: lastError || '中继在线，但没有生成出可用的手机端链接',
      next: '在电脑配对页里点「重置链接」重新生成；仍然失败就看 DSH 日志里生成链接时的报错。',
    };
  }
  return {
    why: lastError || '中继还没连上 broker',
    next: '等 10 秒重试；一直重连就检查网络或代理是否拦了 wss:// 连接。',
  };
}

async function commandPair() {
  const data = await request('/api/v1/pairing');
  const code = String(data?.code ?? '');
  if (code.length === 0) throw new Error('电脑端还没生成配对码：先打开电脑上的配对页并刷新一次');

  let remote;
  try {
    // `/api/v1/cloud/status` 返回的正是 remoteView()：url / state / appBase / lastError。
    remote = await request('/api/v1/cloud/status');
  } catch (error) {
    remote = { state: 'error', url: '', lastError: `读不到中继状态（${error.message}）` };
  }
  const url = typeof remote?.url === 'string' ? remote.url : '';
  const blocker = relayHint(remote);
  const expiresAt = Number(data?.expiresAt) || 0;
  const ttlMs = Number(data?.ttlMs) || 0;
  const remainingSec = expiresAt > 0
    ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
    : Math.round(ttlMs / 1000);
  const ttlText = remainingSec > 0 ? `${remainingSec} 秒内有效` : '有效期未知';
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  const maxDevices = Number(data?.maxDevices) || 0;

  if (url.length > 0 && blocker === null) {
    process.stdout.write(`\n${bold('手机入口 · 加密中继')}\n`);
    if (flag('no-qr') !== true) process.stdout.write(`${renderQr(url)}\n`);
    process.stdout.write(`${dim('链接')} ${cyan(url)}\n`);
    process.stdout.write(`${dim('配对码')} ${bold(code)}   ${dim(`（${ttlText}）`)}\n`);
    if (devices.length > 0) {
      // 上限由插件下发（config.maxDevices，默认 8），不要在这里写死数字。
      const full = maxDevices > 0 && devices.length >= maxDevices;
      process.stdout.write(`${dim('已配对')} ${devices.length}${maxDevices > 0 ? `/${maxDevices}` : ''} 台${full ? `  ${yellow('已达上限，先 revoke 旧设备')}` : ''}\n`);
    }
    process.stdout.write(`\n${dim('手机扫上面这张码（或在浏览器打开链接），再输入配对码完成认领；# 之后的密钥不会发给中转。')}\n\n`);
  } else {
    // 没有中继链接：只说原因和下一步，绝不打印本机地址假装手机能用。
    process.stdout.write(`\n${bold('配对码')} ${bold(code)}   ${dim(`（${ttlText}）`)}\n`);
    process.stdout.write(`${red('现在连不上')}  手机端暂时没有可用入口（中继没起来）。\n`);
    process.stdout.write(`  ${dim('原因')}   ${blocker?.why ?? '中继不可用'}\n`);
    process.stdout.write(`  ${dim('下一步')} ${blocker?.next ?? '先把电脑端的中继启动起来。'}\n`);
    process.stdout.write(`  ${dim('说明')}   中继是唯一通路；没有中继就没有手机入口，本命令不会给出任何备用地址。\n\n`);
  }
  if (flag('json') === true) process.stdout.write(`${JSON.stringify({ ...data, relay: remote }, null, 2)}\n`);
}

async function commandStatus() {
  const health = await request('/api/v1/health');
  const ready = health?.ready === true || health?.status === 'ok' || health?.started === true;
  const lines = [
    `${dim('本机 API')} ${BASE}`,
    `${dim('状态')}     ${ready ? green('运行中') : yellow('启动中')}`,
    `${dim('版本')}     ${String(health?.version ?? '?')}${health?.protocol === undefined ? '' : dim(`  协议 v${health.protocol}`)}`,
    `${dim('运行')}     ${formatUptime(health?.uptimeMs)}`,
  ];
  // 中继状态是最有用的一行，读不到也要给出原因，而不是整块消失。
  try {
    const cloud = await request('/api/v1/cloud/status');
    lines.push(`${dim('中继')}     ${cloudStateText(cloud?.state)}`);
    // 手机端唯一入口是 remoteView().url，`/api/v1/pairing` 里已经没有任何地址。
    if (typeof cloud?.url === 'string' && cloud.url.length > 0) lines.push(`${dim('手机入口')} ${cyan(cloud.url)}`);
    else if (typeof cloud?.lastError === 'string' && cloud.lastError.length > 0) lines.push(`${dim('中继原因')} ${red(cloud.lastError)}`);
  } catch (error) {
    lines.push(`${dim('中继')}     ${dim(`读不到状态（${error.message}）`)}`);
  }
  // `/api/v1/health` 是**未鉴权**视图，publicStatus() 只给 ok/version/protocol/
  // started/ready/uptimeMs/requiresPairing —— 故意不含任务数与设备数。所以这里
  // 不再读 health.tasks / health.devices（曾经读了，两行永远不打印），设备数改从
  // 回环可用的 `/api/v1/pairing` 取；任务数没有免鉴权的来源，就不显示。
  try {
    const pairing = await request('/api/v1/pairing');
    const devices = Array.isArray(pairing?.devices) ? pairing.devices.length : 0;
    const maxDevices = Number(pairing?.maxDevices) || 0;
    lines.push(`${dim('设备')}     ${devices}${maxDevices > 0 ? `/${maxDevices}` : ''} 台`);
  } catch (error) {
    lines.push(`${dim('设备')}     ${dim(`读不到（${error.message}）`)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cloudStateText(state) {
  switch (state) {
    case 'online': return green('已连接（手机走这条中继）');
    case 'connecting': return yellow('连接中');
    case 'reconnecting': return yellow('重连中');
    case 'offline': return red('连不上（broker 无响应）');
    case 'unconfigured': return dim('未配置（缺 cloud.appBase，中继不会启动）');
    case 'blocked': return red('已阻止（未设置访问口令）');
    case 'disabled': return dim('已暂停');
    case 'error': return red('连接失败');
    default: return dim(String(state ?? '未知'));
  }
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${total} 秒`;
}

async function commandDevices() {
  const data = await request('/api/v1/devices');
  const list = Array.isArray(data?.devices) ? data.devices : [];
  if (list.length === 0) { process.stdout.write(`${dim('还没有配对任何设备。')}\n`); return; }
  for (const device of list) {
    const seen = Number(device.lastSeenAt) > 0 ? new Date(Number(device.lastSeenAt)).toLocaleString('zh-CN') : '从未连接';
    process.stdout.write(`${bold(String(device.name ?? '未命名'))}  ${dim(String(device.platform ?? ''))}  ${dim(seen)}\n  ${dim(device.id)}\n`);
  }
}

async function commandRevoke() {
  const target = args[1];
  if (target === undefined) throw new Error('用法：dsh-pocket revoke <设备 id|all>');
  if (target === 'all') {
    const data = await request('/api/v1/devices');
    const list = Array.isArray(data?.devices) ? data.devices : [];
    if (list.length === 0) { process.stdout.write(`${dim('没有设备需要撤销。')}\n`); return; }
    let count = 0;
    for (const device of list) {
      await request(`/api/v1/devices/${encodeURIComponent(String(device.id))}/revoke`, { method: 'POST' });
      count += 1;
    }
    process.stdout.write(`${green('已撤销')} ${count} 台设备；它们需要重新配对。\n`);
    return;
  }
  await request(`/api/v1/devices/${encodeURIComponent(target)}/revoke`, { method: 'POST' });
  process.stdout.write(`${green('已撤销')} ${target}\n`);
}

async function commandBroker() {
  const target = args[1];
  if (target === undefined) {
    const cloud = await request('/api/v1/cloud/status');
    process.stdout.write(`${dim('中继地址')} ${String(cloud?.broker ?? cloud?.brokerUrl ?? '（未设置，用默认公共 broker）')}\n`);
    return;
  }
  await request('/api/v1/cloud/broker', { method: 'POST', body: { broker: target } });
  process.stdout.write(`${green('已更新')} 中继地址：${target}\n`);
}

function commandHelp() {
  process.stdout.write([
    '',
    `${bold('dsh-pocket-plugin')} ${dim('— DSH 随行 · 手机远程接管电脑上的 DeepSeek Harness')}`,
    '',
    `  ${cyan('dsh-pocket-plugin pair')}             打印中继链接、二维码与配对码（别名 link）`,
    `  ${cyan('dsh-pocket-plugin status')}           健康状态、中继状态、设备数`,
    `  ${cyan('dsh-pocket-plugin devices')}          列出已配对设备`,
    `  ${cyan('dsh-pocket-plugin revoke <id|all>')}  撤销设备`,
    `  ${cyan('dsh-pocket-plugin broker [url]')}     查看或设置中继地址`,
    '',
    `  ${dim('--port <n>')}   插件端口，默认 ${DEFAULT_PORT}（或环境变量 DSH_POCKET_PORT）`,
    `  ${dim('--base <url>')} 直接指定本机 API 地址（或环境变量 DSH_POCKET_BASE）`,
    `  ${dim('--no-qr')}      pair 只打印链接，不画二维码`,
    '',
    `  ${dim('手机端唯一的入口是加密中继；中继没起来时 pair 只报原因和下一步，不给任何备用地址。')}`,
    '',
  ].join('\n'));
}

const handlers = {
  pair: commandPair,
  link: commandPair,
  status: commandStatus,
  devices: commandDevices,
  revoke: commandRevoke,
  broker: commandBroker,
  help: commandHelp,
  '--help': commandHelp,
  '-h': commandHelp,
};

const wantsHelp = args.includes('--help') || args.includes('-h');
const handler = handlers[command];
if (wantsHelp && command !== 'help' && command !== '--help' && command !== '-h') {
  // `pair --help` 这类只读调用不该去打网络。
  commandHelp();
} else if (handler === undefined) {
  process.stderr.write(`未知命令：${command}\n`);
  commandHelp();
  process.exitCode = 2;
} else {
  try {
    await handler();
  } catch (error) {
    fail(error);
  }
}
