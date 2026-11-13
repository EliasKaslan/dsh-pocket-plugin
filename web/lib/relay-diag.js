/**
 * 中继断线的「可诊断性」纯逻辑：把真实断因翻译成人能读懂的一句话。
 *
 * 为什么单独抽成一个文件：手机「一直连不上」时，屏幕上只剩外壳那一句通用横幅，
 * 而真正的断因（socket 的 `ECONNRESET`、TLS 失败、connack 返回码）过去只进了
 * `console.warn` —— 手机上没有控制台，等于当场销毁证据。实测的典型现场：
 * 「WiFi 一切正常，切蜂窝流量后停在中继断开，正在重连…」，一次尝试之后本该能
 * 从屏幕读出「连接被重置」，而不是再靠猜。
 *
 * 放在这里可以被 Node 直接 import（不碰 DOM、不碰 mqtt，也不 import 任何浏览器
 * 模块），`test/unit/relay-diag.test.mjs` 能真的跑它，而不是对源码做正则断言。
 * 写法与注释风格参照同目录的 `shell-fresh.js`。
 *
 * 另一条硬约束：**诊断文本会被用户复制粘贴给别人**。所以 `buildDiagText()`
 * 只输出下面这张白名单里的字段；房间密钥 `k`、设备令牌、链接里的 `r`/`t`
 * 一个字都不许进去（中继地址本身可以显示，它不是密钥）。
 */

/** 「未知原因」里原始信息截断到这么多字：诊断要一眼读完，也不把整段栈塞进来。 */
const MAX_SNIPPET = 40;

/** 诊断文本里原始 message 的截断长度（比一句话稍长，够看又不会糊屏）。 */
const MAX_RAW_MESSAGE = 80;

/** 中继地址展示上限（地址可以显示，但没必要贴一条两 KB 的 URL）。 */
const MAX_BROKER_TEXT = 120;

/** 人的时间读法：`at` 是 ms 时间戳，负数/0 视作「没有记录」。 */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 把 MQTT 的 connack 归一成一个返回码；拿不到就返回 null。
 *
 * 两个字段都要认：mqtt.js v5 的 `connack` 事件给的是 packet，v4 语义的字段叫
 * `returnCode`，MQTT 5 叫 `reasonCode`。只认一个的话，另一版本上「中继拒绝了
 * 连接（返回码 5）」永远显示成「未知原因」—— 而 5（未授权）恰恰是链接失效时
 * 唯一能区分于"网络不通"的信号。
 *
 * @param {unknown} connack 数字、`{returnCode}`、`{reasonCode}` 或 null
 * @returns {number|null}
 */
export function normalizeConnack(connack) {
  if (connack === null || connack === undefined) return null;
  if (typeof connack === 'number') return Number.isFinite(connack) ? connack : null;
  if (typeof connack === 'string') {
    const text = connack.trim();
    if (text === '' || !Number.isFinite(Number(text))) return null;
    return Number(text);
  }
  if (typeof connack === 'object') {
    for (const key of ['returnCode', 'reasonCode']) {
      const value = connack[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return null;
}

/** connack 非 0 时的专门说法：3/4/5 各有各的修法，其余只报返回码。 */
const CONNACK_TEXT = {
  3: '中继服务暂时不可用（返回码 3）',
  4: '中继不认这个账号或口令（返回码 4）',
  5: '中继拒绝了这次连接：没有授权（返回码 5）',
};

const CONNACK_SHORT = {
  3: '中继暂时不可用',
  4: '账号或口令不被接受',
  5: '没有授权',
};

/** 原始信息压成一行并截断：错误里常有换行与整段 URL，直接贴进 UI 会糊屏。 */
function snippet(text, max = MAX_SNIPPET) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/**
 * 断因分类：一句话文案（`describeFailure`）与短标签（横幅用）都从这里出。
 *
 * 只在这里判一次，两条对外函数就不会漂 —— 曾经考虑过各写一遍，结果是
 * 「横幅说超时、诊断块说被重置」这种比不说更坏的情况。
 *
 * @param {{code?: unknown, message?: unknown, connack?: unknown}} failure
 * @returns {{kind: string, short: string, text: string, connack: number|null}}
 */
function classify(failure) {
  const source = failure !== null && typeof failure === 'object' ? failure : {};
  const connack = normalizeConnack(source.connack);
  if (connack !== null && connack !== 0) {
    return {
      kind: 'connack',
      short: CONNACK_SHORT[connack] ?? '中继拒绝了连接',
      text: CONNACK_TEXT[connack] ?? `中继拒绝了连接（返回码 ${connack}）`,
      connack,
    };
  }

  const code = String(source.code ?? '').trim();
  const message = String(source.message ?? '').trim();
  // 大小写无关地找：Node 的 code 是大写，但 mqtt.js 的 websocket 错误、
  // 浏览器的 NetworkError 文本大小写并不统一。
  const haystack = `${code} ${message}`.toUpperCase();

  if (code === 'CLOSE') {
    return {
      kind: 'closed',
      short: '连接被关闭',
      text: '底层连接被关闭（没有错误码，可能是线路被掐断或网络切换）',
      connack,
    };
  }
  if (haystack.includes('ENOTFOUND') || haystack.includes('EAI_AGAIN')) {
    return { kind: 'dns', short: '域名解析失败', text: '域名解析失败（当前网络可能拦了 DNS）', connack };
  }
  if (haystack.includes('ECONNREFUSED') || haystack.includes('ECONNRESET')) {
    return {
      kind: 'reset',
      short: '连接被重置',
      text: '连接被对方重置（运营商/网络设备可能干扰了这个端口）',
      connack,
    };
  }
  if (haystack.includes('ETIMEDOUT') || haystack.includes('TIMEOUT') || haystack.includes('超时')) {
    return { kind: 'timeout', short: '连接超时', text: '连接超时（这个端口很可能被当前网络挡住了）', connack };
  }
  if (haystack.includes('CERTIFICATE') || haystack.includes('TLS') || haystack.includes('SSL')) {
    return { kind: 'tls', short: 'TLS 握手失败', text: 'TLS 握手失败', connack };
  }

  // 未知原因：把原始 code / message 截断后带上，好歹留一条可搜的线索。
  const raw = snippet(code !== '' ? code : message !== '' ? message : '', MAX_SNIPPET);
  return {
    kind: 'unknown',
    short: '未知原因',
    text: raw === '' ? '未知原因（没有拿到任何错误信息）' : `未知原因（${raw}）`,
    connack,
  };
}

/**
 * 一句给人看的中文原因（诊断块与复制文本用）。
 *
 * 映射表（与 `test/unit/relay-diag.test.mjs` 逐条对应）：
 *   - `ENOTFOUND` / `EAI_AGAIN` → 域名解析失败
 *   - `ECONNREFUSED` / `ECONNRESET`（含 websocket 包装过的）→ 连接被重置
 *   - `ETIMEDOUT` / 任何 timeout / 超时 → 连接超时
 *   - cert / TLS / SSL → TLS 握手失败
 *   - connack 非 0 → 中继拒绝了连接（返回码 N），3/4/5 有专门说法
 *   - `code === 'CLOSE'`（close 事件没有错误码）→ 连接被关闭
 *   - 其余 → 未知原因（原始 code 或 message 截断 40 字）
 *
 * @param {{code?: unknown, message?: unknown, connack?: unknown}} [failure]
 * @returns {string}
 */
export function describeFailure(failure) {
  return classify(failure).text;
}

/**
 * 短标签，只给横幅用（`中继断开，正在重连…（连接被重置）`）。
 *
 * 横幅只有一行，塞不进带括号的完整解释；完整解释在连接页的「中继诊断」里。
 *
 * @param {{code?: unknown, message?: unknown, connack?: unknown}} [failure]
 * @returns {string}
 */
export function describeFailureShort(failure) {
  return classify(failure).short;
}

/**
 * 剥掉中继地址里可能的秘密，再拿去展示 / 复制。
 *
 * `#s=` 是链接里可控的一段，理论上可以写成 `wss://user:pass@host/…`。地址本身
 * 可以显示，但 userinfo / query / fragment 属于凭据，绝不能进「复制诊断信息」。
 *
 * @param {unknown} broker
 * @returns {string} 可以安全展示的地址；不是字符串就返回空串
 */
function sanitizeBroker(broker) {
  if (typeof broker !== 'string') return '';
  const raw = broker.trim();
  if (raw === '') return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    // 不是标准 URL（比如手填的 host:port）：保守地砍掉 @ 之前与 ? # 之后的部分。
    return raw.replace(/^[^/?#]*@/u, '').replace(/[?#].*$/u, '');
  }
}

/**
 * 当前用的是哪个中继地址。
 *
 * 地址可以显示 —— 它不是密钥；真正的密钥是链接里的 `k`，永远不从这里过。
 *
 * @param {Iterable<string>|string|null|undefined} brokers
 * @returns {string}
 */
export function describeBrokerChoice(brokers) {
  const list = (Array.isArray(brokers) ? brokers : [brokers])
    .map(sanitizeBroker)
    .filter((item) => item !== '');
  if (list.length === 0) return '未知（还没有可用的中继地址）';
  const first = list[0].slice(0, MAX_BROKER_TEXT);
  if (list.length === 1) return first;
  return `${first}（共 ${list.length} 个备选）`;
}

/**
 * 从第一个中继地址里取端口号（建议文案要说清「挡住的是哪个端口」）。
 *
 * @param {Iterable<string>|string|null|undefined} brokers
 * @returns {number|null}
 */
export function brokerPort(brokers) {
  const list = (Array.isArray(brokers) ? brokers : [brokers])
    .map(sanitizeBroker)
    .filter((item) => item !== '');
  if (list.length === 0) return null;
  try {
    const url = new URL(list[0]);
    if (url.port !== '') return Number(url.port);
    return url.protocol === 'wss:' || url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** `at` 这一刻距 `now` 多远，读作中文相对时间；没有记录时返回 `empty`。 */
export function formatAgo(at, now = Date.now(), empty = '还没有记录') {
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) return empty;
  const nowMs = Number(now);
  // 手机时钟回拨时差值会变成负数：钳到 0，别显示「-3 秒前」。
  const delta = Math.max(0, (Number.isFinite(nowMs) ? nowMs : Date.now()) - when);
  if (delta < 5 * SECOND) return '刚刚';
  if (delta < MINUTE) return `${Math.round(delta / SECOND)} 秒前`;
  if (delta < HOUR) return `${Math.round(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.round(delta / HOUR)} 小时前`;
  return `${Math.round(delta / DAY)} 天前`;
}

/**
 * 绝对时刻（本地时区），用于诊断文本里「最后成功」的对照。
 *
 * 不依赖 Intl / toLocaleString：手机上不同浏览器的本地化输出差别很大，
 * 诊断文本要能被人逐字比对。
 *
 * @param {number} at ms 时间戳；0 / 非法值返回空串
 * @returns {string} `YYYY-MM-DD HH:MM:SS`
 */
export function formatClock(at) {
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) return '';
  const date = new Date(when);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 把 `{lastFailure}` 形式的快照摊平；直接传失败对象也认。 */
function failureOf(source) {
  if (source === null || typeof source !== 'object') return {};
  const nested = source.lastFailure;
  if (nested !== null && typeof nested === 'object') return nested;
  return source;
}

/** 原始 code / message：诊断文本里的「证据行」，刻意不做翻译。 */
export const NO_FAILURE_RAW = '（还没有失败记录）';

export function rawFailureText(failure) {
  const source = failure !== null && typeof failure === 'object' ? failure : {};
  const code = String(source.code ?? '').trim();
  const message = String(source.message ?? '').trim();
  const parts = [];
  if (code !== '') parts.push(`code=${snippet(code, MAX_SNIPPET)}`);
  if (message !== '' && message !== code) parts.push(`message=${snippet(message, MAX_RAW_MESSAGE)}`);
  if (parts.length === 0) return NO_FAILURE_RAW;
  return parts.join(' · ');
}

/**
 * 一句可执行的操作建议，按断因分类。
 *
 * 「重连试试」是废话；用户需要知道的是**该换什么**：端口被挡就换网络或自建 443
 * 中继，DNS 不通就换 DNS/网络，返回码 5 就回电脑上重新生成链接。
 *
 * @param {{online?: boolean, brokers?: Iterable<string>|string, lastFailure?: object}
 *   | {code?: unknown, message?: unknown, connack?: unknown}} [diag]
 * @returns {string}
 */
export function describeAdvice(diag) {
  const source = diag !== null && typeof diag === 'object' ? diag : {};
  if (source.online === true) {
    return '中继当前在线。如果页面还是进不去，问题在登录状态或电脑端，请复制诊断信息发给维护者。';
  }
  const failure = failureOf(source);
  const classified = classify(failure);
  const port = brokerPort(source.brokers);
  const portText = port === null ? '中继端口' : `中继端口 ${port}`;

  switch (classified.kind) {
    case 'connack':
      if (classified.connack === 5) {
        return '这条链接已经没有授权了：回到电脑上重新生成远程链接，再扫一次二维码（见 INSTALL.md）。';
      }
      if (classified.connack === 4) {
        return '中继不认这个账号或口令：用电脑上的用户名和访问口令重新登录一次。';
      }
      if (classified.connack === 3) {
        return '中继服务暂时不可用：等几分钟再试，或换成自建中继（见 INSTALL.md）。';
      }
      return `中继用返回码 ${classified.connack} 拒绝了连接：先换 WiFi 复现一次，再把诊断信息发给维护者。`;
    case 'dns':
      return '域名解析失败：先换一个网络（WiFi / 蜂窝）复现；若所有网络都失败，说明这个中继域名在你这边不可用，改用自建 443 中继（见 INSTALL.md）。';
    case 'reset':
      return `连接被重置：当前网络可能挡住了${portText}；换 WiFi 或改用自建 443 中继（见 INSTALL.md）。`;
    case 'timeout':
      return `连接超时：${portText} 很可能被当前网络挡住了；先换 WiFi，长期方案是自建 443 中继（见 INSTALL.md）。`;
    case 'tls':
      return 'TLS 握手失败：多半是网络中有中间代理（公司/校园网/加速器），换网络再试；仍失败就在电脑上换一个中继地址。';
    case 'closed':
      return '连接被掐断且没有错误码：运营商 NAT 常在空闲后丢连接（心跳已缩短到 20 秒）；反复出现请换 WiFi 或自建 443 中继。';
    case 'unknown':
      if (rawFailureText(failure) === NO_FAILURE_RAW) {
        return '还没有断因信息：先确认电脑上的 DSH 正在运行、「远程访问」已开启，再在 WiFi 与蜂窝之间换一次网络复现；仍有问题请复制诊断信息发给维护者。';
      }
      return '先在 WiFi 与蜂窝流量之间换一次网络复现；仍有问题请复制诊断信息发给维护者。';
    default:
      return '先在 WiFi 与蜂窝流量之间换一次网络复现；仍有问题请复制诊断信息发给维护者。';
  }
}

/**
 * 连接页「中继诊断」的表格数据（纯数据，DOM 由调用方拼）。
 *
 * 离线时这些字段必须照样有值 —— 这块内容存在的意义就是"连不上的时候能看"，
 * 所以每一行都只依赖 relay 自己记下的东西，不依赖任何网络请求。
 *
 * @param {{brokers?: unknown, online?: boolean, attempts?: number,
 *   lastFailure?: object|null, lastOkAt?: number, lastAttemptAt?: number,
 *   now?: number}} [diag]
 * @returns {Array<{key: string, label: string, value: string}>}
 */
export function diagRows(diag) {
  const source = diag !== null && typeof diag === 'object' ? diag : {};
  const nowValue = Number(source.now);
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const attemptsValue = Number(source.attempts);
  const attempts = Number.isFinite(attemptsValue) ? Math.max(0, Math.trunc(attemptsValue)) : 0;
  const failure = source.lastFailure !== null && typeof source.lastFailure === 'object'
    ? source.lastFailure
    : null;
  const okAt = Number(source.lastOkAt);
  const attemptAt = Number(source.lastAttemptAt);

  const rows = [
    { key: 'broker', label: '中继地址', value: describeBrokerChoice(source.brokers) },
    { key: 'state', label: '当前状态', value: source.online === true ? '在线' : '离线' },
    { key: 'attempts', label: '连续失败', value: `${attempts} 次` },
    {
      key: 'ok',
      label: '最后成功',
      value: `${formatAgo(okAt, now, '还没有成功过')}${formatClock(okAt) === '' ? '' : `（${formatClock(okAt)}）`}`,
    },
    { key: 'attempt', label: '最后尝试', value: formatAgo(attemptAt, now, '还没有尝试过') },
    {
      key: 'failure',
      label: '最后失败',
      value: failure === null ? '（还没有失败过）' : describeFailure(failure),
    },
  ];
  if (failure !== null) {
    rows.push({ key: 'raw', label: '原始信息', value: rawFailureText(failure) });
  }
  rows.push({ key: 'advice', label: '建议', value: describeAdvice({ ...source, online: source.online === true }) });
  return rows;
}

/**
 * 「复制诊断信息」按钮真正复制的那段文本。
 *
 * 只输出白名单字段：中继地址（已剥掉 userinfo/query）、连续失败次数、最后成功 /
 * 最后尝试时刻、最后失败原因与原始 code、当前是否在线、是否 PWA、UA。
 * **不含**房间密钥 `k`、设备令牌、链接里的 `r`/`t`、房间号 —— 这段文本会被
 * 用户粘贴到聊天窗口里求助，任何一项泄露都等于把配对交出去。
 *
 * @param {{brokers?: unknown, online?: boolean, attempts?: number,
 *   lastFailure?: object|null, lastOkAt?: number, lastAttemptAt?: number,
 *   now?: number, pwa?: boolean, userAgent?: unknown}} [diag]
 * @returns {string}
 */
export function buildDiagText(diag) {
  const source = diag !== null && typeof diag === 'object' ? diag : {};
  const nowValue = Number(source.now);
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const snapshot = { ...source, now };
  const lines = [
    'DSH 随行 · 中继诊断',
    `采集时间：${formatClock(now) || '未知'}`,
  ];
  for (const row of diagRows(snapshot)) {
    lines.push(`${row.label}：${row.value}`);
  }
  lines.push(`运行方式：${source.pwa === true ? 'PWA（从桌面图标打开）' : '浏览器标签页'}`);
  lines.push(`UA：${snippet(source.userAgent ?? '未知', 120)}`);
  return lines.join('\n');
}
