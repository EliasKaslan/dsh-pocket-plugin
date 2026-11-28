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
    // 「中继在线」和「电脑端在线」是两件事：手机连上公共 broker 只说明上行链路
    // 还在，电脑端有没有在说话要看心跳。这两句以前被同一行「当前状态：在线」盖住，
    // 屏幕上就出现了"一边显示在线、一边横幅说电脑端已离线"的自相矛盾。
    if (source.pcStale === true) {
      return '中继在线，但电脑端已经停止心跳：先确认电脑没有休眠 / 断网 / 关掉远程访问，再点界面上的「重连」；仍不恢复请复制诊断信息发给维护者。';
    }
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

/** 计数字段：非法 / 缺失一律当 0，诊断永远不该显示 `NaN` 或 `undefined`。 */
function countOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number);
}

/**
 * 连接页「中继诊断」的表格数据（纯数据，DOM 由调用方拼）。
 *
 * 离线时这些字段必须照样有值 —— 这块内容存在的意义就是"连不上的时候能看"，
 * 所以每一行都只依赖 relay 自己记下的东西，不依赖任何网络请求。
 *
 * 1.0.3 追加了收发计数与在途/隧道/重建数：只有 `online` 时**判断不了"手机收不到
 * 下行"**这种坏法（自认为在线、实际一帧都收不进来）。同时把「中继」与「电脑端
 * 心跳」拆成两行 —— 它们本来就是两个判据，挤在一行就会出现"同屏一边在线、
 * 一边说电脑端已离线"。
 *
 * @param {{brokers?: unknown, online?: boolean, pcStale?: boolean, attempts?: number,
 *   lastFailure?: object|null, lastOkAt?: number, lastAttemptAt?: number,
 *   stats?: {rx?: number, tx?: number, err?: number, lastRxAt?: number},
 *   pending?: number, restartCount?: number, sockets?: number, stallRebuilds?: number,
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
  const stats = source.stats !== null && typeof source.stats === 'object' ? source.stats : {};
  const lastRxAt = Number(stats.lastRxAt);

  const rows = [
    { key: 'broker', label: '中继地址', value: describeBrokerChoice(source.brokers) },
    { key: 'state', label: '当前状态', value: source.online === true ? '在线' : '离线' },
    {
      key: 'pc',
      label: '电脑端心跳',
      // 与「当前状态」并列、不复用：中继在线只说明手机连上了公共 broker，
      // 电脑端有没有在说话是另一个判据。
      value: source.pcStale === true
        ? '已静默（电脑端可能休眠 / 断网）'
        : source.online === true ? '正常' : '未连上（无从判断）',
    },
    { key: 'attempts', label: '连续失败', value: `${attempts} 次` },
    {
      key: 'ok',
      label: '最后成功',
      value: `${formatAgo(okAt, now, '还没有成功过')}${formatClock(okAt) === '' ? '' : `（${formatClock(okAt)}）`}`,
    },
    { key: 'attempt', label: '最后尝试', value: formatAgo(attemptAt, now, '还没有尝试过') },
    { key: 'rx', label: '收到下行', value: `${countOf(stats.rx)} 帧 · ${formatAgo(lastRxAt, now, '还没收到过')}` },
    { key: 'tx', label: '发出上行', value: `${countOf(stats.tx)} 帧` },
    { key: 'err', label: '解析 / 传输错误', value: `${countOf(stats.err)} 次` },
    { key: 'pending', label: '在途请求', value: `${countOf(source.pending)} 条` },
    /*
     * 这两行是 1.0.3 之后补的：`pending` 只能说明"还有几条没回来"，分不清是
     *   ① 回包真的没到（下行丢帧 / 电脑端没回），还是
     *   ② 回包到了、但我们早就不等了（迟到）。
     * 两个数一起看才有判据：`timeouts` 高 = 下行慢或丢；`resMiss` 高 = 我们放弃得太早
     * （预算/超时配错了）；两个都是 0 而界面仍卡 = 去看大响应解压（`decompressGzip`）。
     */
    { key: 'rpctimeout', label: 'RPC 超时未回包', value: `${countOf(source.timeouts)} 次` },
    { key: 'resmiss', label: '迟到的回包', value: `${countOf(source.resMiss)} 次` },
    /*
     * 分片三件套：大响应（>64 KiB 封帧后拆片）在手机端丢了片时，以前两边都没有
     * 任何痕迹 —— 电脑端的 `publishRetries/publishLost` 对这种丢法是 0（broker
     * 收下了、订阅方没收到），手机端只表现为"一直没内容"。
     *   - `partsOpen`：现在有几组半包在拼（>0 且界面卡住 = 正在等一个不会来的片）；
     *   - `partsIncomplete`：累计没集齐（TTL 过期 / 被淘汰 / 判定丢失 / 重连作废）；
     *   - `partsNacked`：累计发过几次补片请求（老桌面会忽略，所以它涨而
     *     `partsIncomplete` 不降 = 对端还不支持补片）。
     */
    { key: 'partsopen', label: '半包在拼', value: `${countOf(source.partsOpen)} 组` },
    { key: 'partslost', label: '分片没集齐', value: `${countOf(source.partsIncomplete)} 次` },
    { key: 'partsnack', label: '已发补片请求', value: `${countOf(source.partsNacked)} 次` },
    /*
     * 「有请求在途 + 下行静默」触发的重建次数（F1，`RPC_STALL_REBUILD_MS`）。
     *
     * 这一行专门用来分辨"没救"和"救了没用"：
     *   - 它 0 而 `RPC 超时未回包` 也在涨 → 看门狗压根没动手（阈值/接线坏了）；
     *   - 它涨而 `RPC 超时未回包` 还在涨 → 重建发生了，但回包仍然进不来
     *     （链路反复半死 / 电脑端一侧的问题），别再只盯着应用侧超时。
     * 旧实现在这种坏法里**一次重建都不会记**：要等 26 s，而请求 15.2 s 就已经判死了。
     */
    { key: 'stallrebuild', label: '静默重建', value: `${countOf(source.stallRebuilds)} 次` },
    { key: 'sockets', label: '实时通道', value: `${countOf(source.sockets)} 条` },
    { key: 'restart', label: '连接重建', value: `${countOf(source.restartCount)} 次` },
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
 * 一条 RPC 面包屑 → 一行可粘贴的文本。
 *
 * 白名单式读取：只碰 `verb / path / tries / resends / sawRes / resBytes / resAt /
 * ms / end / id` 这几个**外壳自己写进去**的字段。就算有人把别的字段塞进来
 * （房间密钥、设备令牌），这段文本也不会读它 —— 「复制诊断」是要发出去的。
 *
 * `id` 是手机端自己生成的 8 位 request id（不是凭据），必须留着：电脑端日志里
 * 记的是**同一个 id**，两边对不上的时候只有它能把"这条请求在电脑那边到底发生了什么"
 * 接起来（桌面统计里 `replays` 也是按它数的）。
 *
 * @param {object} crumb `Relay#rpcBreadcrumbs()` 的一项
 * @param {number} [now]
 * @returns {string}
 */
export function crumbText(crumb, now = Date.now()) {
  const source = crumb !== null && typeof crumb === 'object' ? crumb : {};
  const verb = snippet(String(source.verb ?? 'GET'), 6) || 'GET';
  const path = snippet(String(source.path ?? ''), 48) || '（无路径）';
  const tries = Number(source.tries);
  const resends = Number(source.resends);
  const sent = Number.isFinite(tries) ? Math.max(0, Math.trunc(tries)) : 0;
  const extra = Number.isFinite(resends) && resends > 0 ? `（其中重连补发 ${Math.trunc(resends)} 次）` : '';
  const id = snippet(String(source.id ?? ''), 12);
  const end = String(source.end ?? '');
  let tail;
  if (source.sawRes === true) {
    const bytes = Number(source.resBytes);
    const size = Number.isFinite(bytes) && bytes > 0 ? `${Math.round(bytes / 1024 * 10) / 10} KB` : '空';
    tail = `已收到回包 ${size}`;
  } else if (end === 'timeout') {
    tail = '没收到回包 · 已判死（超时）';
  } else if (end === 'aborted') {
    tail = '没收到回包 · 已取消';
  } else if (end === 'error') {
    tail = '没收到回包 · 出错了';
  } else {
    tail = '还没回包（还在等）';
  }
  const resAt = Number(source.resAt);
  const at = Number.isFinite(resAt) && resAt > 0 ? formatClock(resAt) : '';
  const ms = Number(source.ms);
  const waited = Number.isFinite(ms) && ms > 0
    ? (ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`)
    : formatAgo(Number(source.at), now, '');
  const parts = [`${verb} ${path}`, `发 ${sent} 次${extra}`, waited, tail];
  if (at !== '') parts.push(at);
  if (id !== '') parts.push(`#${id}`);
  return parts.filter((part) => part !== '').join(' · ');
}

/**
 * 「复制诊断信息」按钮真正复制的那段文本。
 *
 * 只输出白名单字段：中继地址（已剥掉 userinfo/query）、中继与电脑端两个状态、
 * 连续失败次数、最后成功 / 最后尝试时刻、收发帧计数、在途请求 / 超时未回包 /
 * 迟到回包 / 实时通道 / 重建次数、最后失败原因与原始 code、最近几条 RPC 面包屑、
 * 是否 PWA、UA。
 * **不含**房间密钥 `k`、设备令牌、链接里的 `r`/`t`、房间号 —— 这段文本会被
 * 用户粘贴到聊天窗口里求助，任何一项泄露都等于把配对交出去。
 *
 * @param {{brokers?: unknown, online?: boolean, pcStale?: boolean, attempts?: number,
 *   lastFailure?: object|null, lastOkAt?: number, lastAttemptAt?: number,
 *   stats?: {rx?: number, tx?: number, err?: number, lastRxAt?: number},
 *   pending?: number, restartCount?: number, sockets?: number, timeouts?: number,
 *   resMiss?: number, stallRebuilds?: number, crumb?: object[], rpcBudget?: number,
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
  // 最近几条 RPC：只留 5 条（再多也没人看，而复制出来的文本会变长）。
  const crumbs = Array.isArray(source.crumb) ? source.crumb.filter((item) => item !== null && typeof item === 'object') : [];
  if (crumbs.length > 0) {
    const budget = Number(source.rpcBudget);
    const head = Number.isFinite(budget) && budget > 0 ? `（单条预算 ${Math.round(budget)} ms）` : '';
    lines.push(`最近在途 RPC${head}：`);
    for (const crumb of crumbs.slice(-5)) lines.push(`  ${crumbText(crumb, now)}`);
  }
  lines.push(`运行方式：${source.pwa === true ? 'PWA（从桌面图标打开）' : '浏览器标签页'}`);
  lines.push(`UA：${snippet(source.userAgent ?? '未知', 120)}`);
  return lines.join('\n');
}
