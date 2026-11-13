/**
 * Server-rendered desktop pairing page.
 *
 * 配对页只可能来自回环（socket + Host 校验，见 `core.isLoopbackRequest`）。
 * 手机端**唯一**的入口是加密中继——二维码与链接来自 `remoteView()`
 * （`cloud.status().url`，形态 `<appBase>#s=<broker>&r=<room>&k=<key>`）。
 *
 * 手机端不再需要配对码：在中继外壳的登录页输入账号（`auth.user`）+ 口令，
 * 登录成功时电脑端自动登记该设备并下发设备令牌。本页只负责把二维码摆出来
 * （同一个二维码也落成 `~/dsh-pocket-qr.png`，见 lib/qr-file.mjs）。
 *
 * 桌面端只监听 127.0.0.1，没有第二条通路：本页不展示、也不探测任何地址。
 * 中继不可用时页面必须说清「现在连不上」以及原因，绝不给出备用地址。
 */
import { escapeHtml, PLUGIN_VERSION } from './util.mjs';

const LOGO = `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B8CFF"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><rect x="3" y="3" width="42" height="42" rx="13" fill="url(#lg)"/><path d="M15 24.5c3.2-6.8 14.8-6.8 18 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="30.5" r="3" fill="#fff"/></svg>`;

function layout({ title, body, extraHead = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/pair/pair.css">
${extraHead}
</head>
<body>
<div class="bg-orbit orbit-a"></div><div class="bg-orbit orbit-b"></div>
${body}
<script src="/pair/pair.js" defer></script>
</body>
</html>`;
}

/** Hidden CSRF field for every loopback-only form on this page. */
function csrfField(token) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token)}">`;
}

function deviceRows(devices) {
  if (devices.length === 0) {
    return `<div class="empty-devices"><span class="dot dot-idle"></span> 还没有登记设备</div>`;
  }
  return devices.map((device) => {
    // 「远程中继」是本机自己的凭据，不是一台手机：给它「移除」按钮只会让用户
    // 一键把二维码的初始凭据弄失效，顺带把自己的手机踢下线。这里只标注、不可移除。
    const isRelay = device.platform === 'relay';
    const action = isRelay
      ? '<span class="device-tag">本机 · 不可移除</span>'
      : `<button class="ghost danger" data-revoke="${escapeHtml(device.id)}" type="button">移除</button>`;
    return `
    <div class="device-row">
      <div class="device-icon">${device.platform === 'harmonyos' ? '鸿' : '设'}</div>
      <div class="device-main">
        <div class="device-name">${escapeHtml(device.name)}</div>
        <div class="device-meta">${escapeHtml(isRelay ? '中继通道' : (device.platform || 'unknown'))}${device.appVersion && !isRelay ? ` · v${escapeHtml(device.appVersion)}` : ''}</div>
      </div>
      ${action}
    </div>`;
  }).join('');
}

const REMOTE_BADGE = {
  online: ['已连通', 'ok'],
  connecting: ['连接中', 'soft'],
  starting: ['启动中', 'soft'],
  idle: ['待启动', 'soft'],
  reconnecting: ['重连中', 'warn'],
  offline: ['连不上', 'warn'],
  disabled: ['已暂停', 'soft'],
  unconfigured: ['未配置', 'warn'],
  blocked: ['缺少口令', 'warn'],
  error: ['中转异常', 'warn'],
};

/** `remoteView()` 的字段读不到时也不能把页面搞崩，统一在这里取值。 */
function relayFacts(remote) {
  const source = remote ?? {};
  return {
    state: typeof source.state === 'string' && source.state.length > 0 ? source.state : 'disabled',
    enabled: source.enabled !== false,
    url: typeof source.url === 'string' ? source.url : '',
    qrSvg: typeof source.qrSvg === 'string' ? source.qrSvg : '',
    appBase: typeof source.appBase === 'string' ? source.appBase : '',
    broker: typeof source.broker === 'string' ? source.broker : '',
    lastError: typeof source.lastError === 'string' ? source.lastError : '',
    phoneName: typeof source.phone?.name === 'string' ? source.phone.name : '',
  };
}

/**
 * 中继不可用时唯一的说明来源：说清「现在连不上 + 为什么」，并给出可执行的下一步。
 * 刻意不提供任何备用地址——中继是唯一通路。
 */
function relayBlocker(relay) {
  if (relay.state === 'online' && relay.url.length > 0) return null;
  if (relay.state === 'unconfigured' || relay.appBase.length === 0) {
    return {
      title: '现在连不上：没有配置手机端外壳地址',
      why: relay.lastError || '插件没有 cloud.appBase，中继不会启动，手机端连要打开哪个页面都不知道。',
      fix: '在这台电脑的 DSH 插件配置里把 <code>cloud.appBase</code> 设成你自己托管的静态外壳页面地址，然后重启 DSH。',
    };
  }
  if (relay.state === 'blocked') {
    return {
      title: '现在连不上：本机还没设访问口令',
      why: relay.lastError || '口令闸是 fail-closed：没有凭据时中继拒绝启动，手机端拿不到可用链接。',
      fix: '先在电脑上设置口令（写入数据目录的 <code>auth.json</code>，或把 <code>auth.required</code> 改为 <code>false</code>），再刷新本页。',
    };
  }
  if (relay.state === 'disabled' || relay.enabled === false) {
    return {
      title: '现在连不上：远程访问已暂停',
      why: relay.lastError || '中继被暂停了，手机端没有可用通路。',
      fix: '点下面中继卡片里的「启用远程」恢复。',
    };
  }
  if (relay.state === 'error') {
    return {
      title: '现在连不上：中继启动失败',
      why: relay.lastError || '中继报了错但没给出原因。',
      fix: '看 DSH 日志里的「远程访问未启动」那一行，修好后再刷新本页。',
    };
  }
  if (relay.state === 'online') {
    return {
      title: '现在连不上：中继在线但还没有可用链接',
      why: relay.lastError || '中继已连上 broker，但拼不出手机端链接（多半是 cloud.appBase 或身份文件的问题）。',
      fix: '点中继卡片里的「重置链接」重新生成；仍然失败就看 DSH 日志里生成链接时的报错。',
    };
  }
  // idle / connecting / starting / reconnecting / offline：链路还在，只是没连上。
  return {
    title: '现在连不上：中继还没连上 broker',
    why: relay.lastError || '电脑正在尝试连中转服务器，还没成功。',
    fix: '等 10 秒刷新本页；一直重连就检查网络或代理是否拦了到中转服务器的加密连接。',
  };
}

function relayBanner(relay) {
  const blocker = relayBlocker(relay);
  if (blocker === null) return '';
  return `<div class="card notice-card" id="relay-unavailable">
      <div class="card-head"><span>${escapeHtml(blocker.title)}</span><span class="badge warn">连不上</span></div>
      <p>${escapeHtml(blocker.why)}</p>
      <p class="hint">${blocker.fix}</p>
      <p class="hint">中继是手机端的唯一通路；它没起来时，手机暂时打不开面板，本页也不会给出任何备用地址。</p>
    </div>`;
}

function authBanner(auth, relay) {
  if (auth?.required === true && auth?.configured !== true) {
    return `<div class="card notice-card">
      <div class="card-head"><span>远程访问已停止</span><span class="badge warn">缺少口令</span></div>
      <p>配置要求手机登录口令，但本机没有可用的凭据文件，因此中继不会启动（这是刻意的失败即关闭）。</p>
      <p class="hint">先在这台电脑上设置口令（写入数据目录的 <code>auth.json</code>），或把配置项 <code>auth.required</code> 改为 <code>false</code>。</p>
    </div>`;
  }
  if (relay.enabled === true && relay.state === 'online' && auth?.enabled !== true) {
    return `<div class="card notice-card">
      <div class="card-head"><span>远程访问未设口令</span><span class="badge soft">仅链接即凭据</span></div>
      <p>任何拿到中继链接的人都能控制这台电脑。建议设置登录口令后再长期开启跨网络访问。</p>
    </div>`;
  }
  return '';
}

/**
 * 二维码 SVG 的插槽校验。
 *
 * `relay.qrSvg` 是本页唯一「原样插进 HTML」的内容 —— 转义它会把二维码本身
 * 变成一段文本，页面就再也扫不出来。目前 `core.qrSvg()` 只输出数字 `<rect>`，
 * 但那是**当前实现**、不是契约：一旦它开始内嵌链接 / title / 外部资源，任何
 * 能影响那段输出的输入就是一个 XSS sink。
 *
 * 所以按结构放行：必须是单个 `<svg…></svg>`，且不含脚本、事件属性、
 * `javascript:` 这类可执行内容；不合法的整段丢弃，由调用方退回纯文本占位。
 */
function safeQrSvg(svg) {
  if (typeof svg !== 'string' || svg.length === 0) return '';
  if (!/^<svg[\s\S]*<\/svg>$/u.test(svg)) return '';
  if (/<\s*script/iu.test(svg)) return '';
  if (/<\s*(?:foreignObject|iframe|object|embed|use|animate|set)\b/iu.test(svg)) return '';
  // `onxxx=` 前面可能是空格、`/`、`"`、`>`：`<svg/onload=…>` 也是合法的 HTML 写法。
  if (/(?:^|[\s/"'<>])on[a-z]+\s*=/iu.test(svg)) return '';
  if (/javascript:/iu.test(svg)) return '';
  // 引用只允许页内锚点：实体编码（`&#106;avascript:`）绕得过关键字匹配，
  // 但绕不过「href 必须以 # 开头」。
  for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']?([^"'>\s]*)/giu)) {
    if (!match[1].startsWith('#')) return '';
  }
  return svg;
}

/** 中继卡片：唯一入口。二维码/链接只在 online 时给；其余状态给原因。 */
function remoteCard(relay, csrfToken) {
  const [label, tone] = REMOTE_BADGE[relay.state] ?? ['未启用', 'soft'];
  const online = relay.state === 'online';
  const phone = relay.phoneName
    ? `手机「${escapeHtml(relay.phoneName)}」已接入中转`
    : '等待手机扫码接入';
  let qr;
  const qrSvg = safeQrSvg(relay.qrSvg);
  if (qrSvg.length > 0) qr = `<div class="remote-qr">${qrSvg}</div>`;
  else if (relay.qrSvg.length > 0) qr = '<div class="remote-qr remote-qr-empty">二维码内容异常，已隐藏</div>';
  else if (relay.state === 'unconfigured') qr = '<div class="remote-qr remote-qr-empty">未配置手机端外壳地址</div>';
  else qr = '<div class="remote-qr remote-qr-empty">远程访问已暂停</div>';
  const urlLine = relay.url.length > 0
    ? `<div class="remote-url" id="remote-url" title="中继链接">${escapeHtml(relay.url)}</div>`
    : '<div class="remote-url" id="remote-url" title="中继链接">（还没有生成）</div>';
  const copyButton = relay.url.length > 0
    ? '<button class="primary" type="button" data-copy-remote>复制中继链接</button>'
    : '';
  const appBaseHint = relay.appBase.length > 0
    ? `手机端外壳托管在 <code>${escapeHtml(relay.appBase)}</code>；打开它就是一个完整的任务面板。`
    : '尚未配置手机端外壳地址（<code>cloud.appBase</code>），中继不会启动；把它设成你自己托管的页面地址即可。';
  const errorHint = relay.lastError.length > 0
    ? `<div class="hint" id="remote-error">最近错误：${escapeHtml(relay.lastError)}</div>`
    : '';
  return `
    <div class="card remote-card" id="relay-card">
      <div class="card-head"><span>手机入口 · 加密中继</span><span class="badge ${tone}" id="remote-badge">${label}</span></div>
      <div class="remote-grid">
        ${qr}
        <div class="remote-copy">
          <h3>手机用 5G / 公共 Wi-Fi 也能接管这台电脑</h3>
          <p class="remote-lede">电脑只向中转发起<b>出站</b>连接，不监听公网端口、不做端口映射；手机扫上面这张码即可。</p>
          <ul class="remote-list">
            <li><b>端到端加密</b>：AES-256-GCM，密钥只在这张二维码的 # 片段里，中转服务器只能看到密文。</li>
            <li><b>可随时收回</b>：链接等同于凭据，点「重置链接」立刻作废旧码。</li>
            <li><b>中转可替换</b>：默认走公共 MQTT 中转，只转发密文；换自建中转只需改 <code>cloud.broker</code>。</li>
          </ul>
          <div class="remote-state" id="remote-state">${phone}</div>
          ${urlLine}
          <div class="row gap">
            ${copyButton}
            <form method="post" action="/cloud/rotate">${csrfField(csrfToken)}<button class="ghost" type="submit">重置链接</button></form>
            <form method="post" action="/cloud/toggle">${csrfField(csrfToken)}<button class="ghost" type="submit">${online ? '暂停远程' : '启用远程'}</button></form>
          </div>
          <div class="hint">${appBaseHint}</div>
          ${errorHint}
        </div>
      </div>
    </div>`;
}

/**
 * 「账号与口令」卡片：本机直接改，不用再去命令行跑 tools/set-auth.mjs。
 *
 * 只渲染账号本身：两个口令输入框永远是空的，服务端也从不把口令或哈希
 * 下发到页面。表单不走原生 submit（CSP 禁内联脚本），提交由 web/pair.js
 * 用 fetch + `<meta name="pocket-csrf">` 里的 token 完成。
 */
function accountCard(account) {
  const current = account.length > 0
    ? `<span class="addr" id="account-current">${escapeHtml(account)}</span>`
    : '<span class="account-empty" id="account-current">还没有设置口令</span>';
  return `
    <div class="card account-card" id="account-card">
      <div class="card-head"><span>账号与口令</span><span class="badge soft">只在本机修改</span></div>
      <p class="remote-lede">手机登录用的就是这里的账号和口令。口令只以 scrypt 哈希写进这台电脑的 <code>auth.json</code>，明文不落盘，也不会回传到这个页面。</p>
      <div class="account-current">当前账号：${current}</div>
      <form class="account-form" id="account-form" method="post" action="/pair" autocomplete="off" novalidate>
        <label class="field">
          <span class="field-label">账号</span>
          <input class="input" id="account-user" name="user" type="text" autocomplete="username" maxlength="64" value="${escapeHtml(account)}" placeholder="例如 小明" required>
        </label>
        <label class="field">
          <span class="field-label">新口令</span>
          <input class="input" id="account-password" name="password" type="password" autocomplete="new-password" maxlength="200" placeholder="至少 8 个字符" required>
        </label>
        <label class="field">
          <span class="field-label">确认口令</span>
          <input class="input" id="account-password2" name="confirm" type="password" autocomplete="new-password" maxlength="200" placeholder="再输入一次" required>
        </label>
        <div class="row gap">
          <button class="primary" id="account-save" type="submit">保存账号与口令</button>
        </div>
        <div class="account-status" id="account-status" role="status" aria-live="polite"></div>
      </form>
      <p class="account-warn">改口令会让<b>所有手机</b>立刻退出登录，需要用新口令重新登录；<b>已登记的设备不会被移除</b>，重新登录后照旧使用。</p>
    </div>`;
}

export function renderPairPage(core, view = {}, devices = [], remote = {}, options = {}) {
  const { csrfToken = '', auth = {} } = options;
  // 只剩安装指纹要读（页面底部用来区分「同一台电脑」）。
  const pageView = view ?? {};
  const fingerprint = String(pageView.fingerprint ?? core?.fingerprint ?? '');
  const relay = relayFacts(remote);
  const deviceList = Array.isArray(devices) ? devices : [];
  // 账号取 core.auth.user（server.mjs 直接注入的那份真身），其次才是中继层
  // 透下来的 auth 视图；两者在生产里是同一个 Auth 实例。绝不写死 admin。
  const account = typeof core?.auth?.user === 'string' && core.auth.user.trim().length > 0
    ? core.auth.user.trim()
    : (typeof auth?.user === 'string' ? auth.user.trim() : '');
  const authRequired = auth?.required === true;
  const authConfigured = auth?.configured === true;
  const accountChip = account.length > 0
    ? `<span class="addr">${escapeHtml(account)}</span>`
    : '<span class="addr">设置口令时填的用户名</span>';
  const accountHint = account.length > 0
    ? '就是上面这个账号：设置口令时填的用户名，登录页把它填进「用户名」。'
    : '这台电脑还没有可用的口令凭据（<code>auth.json</code>），先设置口令再让手机登录。';
  // 三态：有凭据 / 配置要求口令但没凭据 / 明确关掉了口令。别把「缺凭据」说成
  // 「未启用口令」——那会把 authRequired=true 的 fail-closed 说反。
  const loginState = authConfigured
    ? '口令闸已开启：口令只在这台电脑上校验，中继只转发密文。'
    : authRequired
      ? '配置要求口令，但本机还没有可用凭据（见上方横幅），先设置口令再让手机登录。'
      : '当前未启用口令：登录页不校验口令，直接进入。';
  const body = `
<main class="shell">
  <header class="topbar">
    <div class="brand">${LOGO}<div><div class="brand-title">DSH 随行</div><div class="brand-sub">用手机看与控电脑上的 DSH</div></div></div>
    <div class="status-pill"><span class="dot dot-live"></span> 服务运行中 <span class="sep">·</span> 本机端口 ${escapeHtml(String(core?.port ?? '—'))}</div>
  </header>

  <section class="hero">
    <div>
      <h1>让手机接管<br><span class="grad">你的 DSH 任务</span></h1>
      <p class="lede">电脑只向加密中继发起出站连接，不开放任何入站端口。手机扫上面的二维码打开中继外壳，用账号 + 口令登录即可连上。</p>
      <div class="hero-points">
        <span>端到端加密</span><span>电脑零公网暴露</span><span>只走中继</span>
      </div>
    </div>
    <div class="hero-glow"></div>
  </section>

  ${relayBanner(relay)}
  ${authBanner(auth, relay)}
  ${remoteCard(relay, csrfToken)}
  ${accountCard(account)}

  <section class="grid">
    <div class="card login-card">
      <div class="card-head"><span>手机登录 · 账号 + 口令</span><span class="badge soft">首次登录自动登记</span></div>
      <p class="remote-lede">在手机的中继外壳登录页填下面这个账号和你的口令；登录成功时电脑端会自动登记这台手机并下发设备令牌，<b>首次登录即完成登记</b>。</p>
      <div class="row gap">${accountChip}</div>
      <ul class="remote-list">
        <li><b>账号</b>：${accountHint}</li>
        <li><b>口令</b>：就是这台电脑的访问口令。${loginState}</li>
        <li><b>首次登录</b>：自动成为已登记设备，之后这台手机靠设备令牌直接进入，不必再输。</li>
        <li><b>收回权限</b>：在右侧「已登记设备」里点「移除」，那台手机的令牌立刻失效。</li>
      </ul>
      <div class="hint">手机的唯一入口仍然是上面的中继二维码；本页不显示任何口令或令牌。</div>
    </div>

    <div class="right">
      <div class="card steps-card">
        <div class="card-head"><span>三步连接</span><span class="badge soft">约 10 秒</span></div>
        <ol class="steps">
          <li><span class="step-num">1</span><div><b>在手机上打开中继外壳</b><p>扫上方中继卡片里的二维码（或把中继链接发到手机上打开）。二维码里只有中转、房间与密钥参数，不含任何地址入口。</p></div></li>
          <li><span class="step-num">2</span><div><b>输入账号 + 口令登录</b><p>登录页填账号 <b>${account.length > 0 ? escapeHtml(account) : '（见左侧）'}</b> 与你的口令；首次登录即自动登记为已登记设备。</p></div></li>
          <li><span class="step-num">3</span><div><b>开始使用</b><p>任务列表实时同步；点右下角「＋」即可在电脑上创建新任务。</p></div></li>
        </ol>
      </div>

      <div class="card devices-card">
        <div class="card-head"><span>已登记设备</span><span class="badge soft" id="device-count">${deviceList.length}</span></div>
        <div id="device-list">${deviceRows(deviceList)}</div>
        <div class="hint">已登记 ${deviceList.length} 台；移除后那台手机需要重新用账号 + 口令登录。</div>
      </div>

      <div class="card install-card">
        <div class="card-head"><span>链路与凭据</span><span class="badge soft">AES-256-GCM</span></div>
        <p>手机与电脑之间的所有请求都经中转加密转发，中转只看到密文；口令闸在电脑端校验，凭据文件只留在本机。</p>
        <p class="hint">想当 App 用：iOS 用 Safari「分享 → 添加到主屏幕」，Android 用 Chrome「⋮ → 添加到主屏幕」。加到主屏后是全屏无地址栏的独立图标。</p>
      </div>
    </div>
  </section>

  <footer class="foot">
    <span>DSH 随行 v${escapeHtml(PLUGIN_VERSION)}</span>
    <span>设备指纹 ${escapeHtml(fingerprint)}</span>
    <span>本页仅限本机访问 · 手机唯一入口是上面的加密中继</span>
  </footer>
</main>
<div class="toast" id="toast" role="status"></div>
<script type="application/json" id="pair-data">${JSON.stringify({
    relayUrl: relay.url,
    relayState: relay.state,
    account,
  }).replace(/</gu, '\\u003c')}</script>`;
  return layout({
    title: 'DSH 随行 · 手机连接',
    body,
    extraHead: `<meta name="pocket-csrf" content="${escapeHtml(csrfToken)}">`,
  });
}

export function renderLandingPage(core, { forbidden = false } = {}) {
  const body = `
<main class="shell landing">
  <header class="topbar">
    <div class="brand">${LOGO}<div><div class="brand-title">DSH 随行</div><div class="brand-sub">用手机看与控电脑上的 DSH</div></div></div>
  </header>
  <section class="landing-card card">
    <div class="landing-mark">${forbidden ? '🔒' : '📱'}</div>
    <h1>${forbidden ? '连接页仅限电脑本机访问' : '请在电脑上完成连接'}</h1>
    <p>${forbidden
      ? '为保护登录凭据，中继二维码与账号只在运行 DSH 的这台电脑上显示。请回到电脑，打开插件输出的连接地址。'
      : '打开电脑上的 DSH 连接页，用手机扫中继卡片上的二维码打开外壳，再输入账号 + 口令登录；手机只走加密中继这一条通路。'}</p>
    <div class="landing-foot">主机 ${escapeHtml(core.serverName)} · 端口 ${escapeHtml(String(core.port))}</div>
    <p class="hint">安装包只在运行 DSH 的电脑上下载，不在本页提供。手机端没有本地入口，请用中继卡片上的二维码或外壳地址。</p>
  </section>
</main>`;
  return layout({ title: 'DSH 随行', body });
}
