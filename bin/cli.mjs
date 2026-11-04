#!/usr/bin/env node
/**
 * dsh-pocket 命令行：给「手边只有终端」的场景用。
 *
 *   dsh-pocket link            打印配对链接、二维码与配对码
 *   dsh-pocket status          健康状态、中继状态、已配对设备数
 *   dsh-pocket devices         列出已配对设备
 *   dsh-pocket revoke <id|all> 撤销某台（或全部）设备
 *   dsh-pocket broker [url]    查看 / 设置中继地址
 *
 * 所有请求都打到 127.0.0.1 的插件端口：这些接口在电脑端只对回环开放，
 * 没有任何一条能给远程用，所以这个 CLI 天然不可能从手机侧调用。
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

async function commandLink() {
  const data = await request('/api/v1/pairing');
  const link = String(data?.link ?? '');
  const code = String(data?.code ?? '');
  if (link.length === 0) throw new Error('电脑端没有返回配对链接');

  process.stdout.write(`\n${bold('扫码配对')}\n`);
  if (flag('no-qr') !== true) process.stdout.write(`${renderQr(link)}\n`);
  process.stdout.write(`${dim('链接')} ${cyan(link)}\n`);
  process.stdout.write(`${dim('配对码')} ${bold(code)}   ${dim(`（${data?.expiresInSec ?? data?.ttlMs / 1000 ?? '?'} 秒内有效）`)}\n`);
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  if (devices.length > 0) {
    // 上限由插件下发（config.maxDevices，默认 8），不要在这里写死 10。
    const maxDevices = Number(data?.maxDevices) || 0;
    const full = maxDevices > 0 && devices.length >= maxDevices;
    process.stdout.write(`${dim('已配对')} ${devices.length}${maxDevices > 0 ? `/${maxDevices}` : ''} 台${full ? `  ${yellow('已达上限，先 revoke 旧设备')}` : ''}\n`);
  }
  process.stdout.write(`\n${dim('手机与电脑同一个 Wi-Fi 时扫上面这个；不在同一个网络请用中继链接（DSH 界面 → 手机访问 → 远程）。')}\n\n`);
  if (flag('json') === true) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function commandStatus() {
  const health = await request('/api/v1/health');
  const ready = health?.ready === true || health?.status === 'ok' || health?.started === true;
  const lines = [
    `${dim('地址')}   ${BASE}`,
    `${dim('状态')}   ${ready ? green('运行中') : yellow('启动中')}`,
    `${dim('版本')}   ${String(health?.version ?? '?')}${health?.protocol === undefined ? '' : dim(`  协议 v${health.protocol}`)}`,
    `${dim('运行')}   ${formatUptime(health?.uptimeMs)}`,
  ];
  // 中继状态是最有用的一行，读不到也要给出原因，而不是整块消失。
  try {
    const cloud = await request('/api/v1/cloud/status');
    lines.push(`${dim('中继')}   ${cloudStateText(cloud?.state)}`);
    if (typeof cloud?.link === 'string' && cloud.link.length > 0) lines.push(`${dim('远程')}   ${cyan(cloud.link)}`);
  } catch (error) {
    lines.push(`${dim('中继')}   ${dim(`读不到状态（${error.message}）`)}`);
  }
  // `/api/v1/health` 是**未鉴权**视图，publicStatus() 只给 ok/version/protocol/
  // started/ready/uptimeMs/requiresPairing —— 故意不含任务数与设备数。所以这里
  // 不再读 health.tasks / health.devices（曾经读了，两行永远不打印），设备数改从
  // 回环可用的 `/api/v1/pairing` 取；任务数没有免鉴权的来源，就不显示。
  try {
    const pairing = await request('/api/v1/pairing');
    const devices = Array.isArray(pairing?.devices) ? pairing.devices.length : 0;
    const maxDevices = Number(pairing?.maxDevices) || 0;
    lines.push(`${dim('设备')}   ${devices}${maxDevices > 0 ? `/${maxDevices}` : ''} 台`);
  } catch (error) {
    lines.push(`${dim('设备')}   ${dim(`读不到（${error.message}）`)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cloudStateText(state) {
  switch (state) {
    case 'online': return green('已连接');
    case 'connecting': return yellow('连接中');
    case 'unconfigured': return dim('未配置（在 DSH 界面里开启远程访问）');
    case 'blocked': return red('已阻止（未设置访问口令）');
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
    `  ${cyan('dsh-pocket-plugin link')}             打印配对链接、二维码与配对码`,
    `  ${cyan('dsh-pocket-plugin status')}           健康状态、中继状态、设备数`,
    `  ${cyan('dsh-pocket-plugin devices')}          列出已配对设备`,
    `  ${cyan('dsh-pocket-plugin revoke <id|all>')}  撤销设备`,
    `  ${cyan('dsh-pocket-plugin broker [url]')}     查看或设置中继地址`,
    '',
    `  ${dim('--port <n>')}   插件端口，默认 ${DEFAULT_PORT}（或环境变量 DSH_POCKET_PORT）`,
    `  ${dim('--base <url>')} 直接指定地址（或环境变量 DSH_POCKET_BASE）`,
    `  ${dim('--no-qr')}      link 只打印链接，不画二维码`,
    '',
  ].join('\n'));
}

const handlers = {
  link: commandLink,
  status: commandStatus,
  devices: commandDevices,
  revoke: commandRevoke,
  broker: commandBroker,
  help: commandHelp,
  '--help': commandHelp,
  '-h': commandHelp,
};

const handler = handlers[command];
if (handler === undefined) {
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
