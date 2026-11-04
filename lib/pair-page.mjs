/**
 * Server-rendered desktop pairing page and the small LAN landing page.
 *
 * The pairing page is intentionally loopback-only (socket + Host header, see
 * `core.isLoopbackRequest`): it contains a live pairing code and, indirectly,
 * the pairing link. LAN visitors get the landing page instead, which never
 * reveals the code and never points at loopback-only downloads.
 */
import { escapeHtml, PLUGIN_VERSION, normalizeCode } from './util.mjs';

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
    return `<div class="empty-devices"><span class="dot dot-idle"></span> 还没有配对设备</div>`;
  }
  return devices.map((device) => `
    <div class="device-row">
      <div class="device-icon">${device.platform === 'harmonyos' ? '鸿' : '设'}</div>
      <div class="device-main">
        <div class="device-name">${escapeHtml(device.name)}</div>
        <div class="device-meta">${escapeHtml(device.platform || 'unknown')}${device.appVersion ? ` · v${escapeHtml(device.appVersion)}` : ''} · ${device.lastIp ? escapeHtml(device.lastIp) : '未知地址'}</div>
      </div>
      <button class="ghost danger" data-revoke="${escapeHtml(device.id)}" type="button">移除</button>
    </div>`).join('');
}

const REMOTE_BADGE = {
  online: ['已连通', 'ok'],
  connecting: ['连接中', 'soft'],
  starting: ['启动中', 'soft'],
  idle: ['待启动', 'soft'],
  reconnecting: ['重连中', 'warn'],
  offline: ['重连中', 'warn'],
  disabled: ['已暂停', 'soft'],
  unconfigured: ['未配置', 'warn'],
  blocked: ['缺少口令', 'warn'],
  error: ['中转异常', 'warn'],
};

function authBanner(auth, remote) {
  if (auth?.required === true && auth?.configured !== true) {
    return `<div class="card notice-card">
      <div class="card-head"><span>远程访问已停止</span><span class="badge warn">缺少口令</span></div>
      <p>配置要求手机登录口令，但本机没有可用的凭据文件，因此中继不会启动（这是刻意的失败即关闭）。</p>
      <p class="hint">先在这台电脑上设置口令（写入数据目录的 <code>auth.json</code>），或把配置项 <code>auth.required</code> 改为 <code>false</code>。</p>
    </div>`;
  }
  if (remote?.enabled === true && auth?.enabled !== true) {
    return `<div class="card notice-card">
      <div class="card-head"><span>远程访问未设口令</span><span class="badge soft">仅链接即凭据</span></div>
      <p>任何拿到远程链接的人都能控制这台电脑。建议设置登录口令后再长期开启跨网络访问。</p>
    </div>`;
  }
  return '';
}

function remoteCard(remote, csrfToken) {
  const [label, tone] = REMOTE_BADGE[remote.state] ?? ['未启用', 'soft'];
  const phone = remote.phone?.name
    ? `手机「${escapeHtml(remote.phone.name)}」已接入中转`
    : '等待手机扫码接入';
  let qr;
  if (remote.qrSvg) qr = `<div class="remote-qr">${remote.qrSvg}</div>`;
  else if (remote.state === 'unconfigured') qr = '<div class="remote-qr remote-qr-empty">未配置静态外壳地址</div>';
  else qr = '<div class="remote-qr remote-qr-empty">远程访问已暂停</div>';
  const appBaseHint = remote.appBase
    ? `手机端页面托管在 ${escapeHtml(remote.appBase)}，打开后即为完整的任务面板。`
    : '尚未配置手机端外壳地址（<code>cloud.appBase</code>），远程访问不会启动；把它设成你自己托管的页面地址即可。';
  return `
    <div class="card remote-card">
      <div class="card-head"><span>远程访问 · 不在同一局域网也能用</span><span class="badge ${tone}" id="remote-badge">${label}</span></div>
      <div class="remote-grid">
        ${qr}
        <div class="remote-copy">
          <h3>手机用 5G / 公共 Wi-Fi 也能接管这台电脑</h3>
          <p class="remote-lede">电脑只向中转发起<b>出站</b>连接，不监听公网端口、不做端口映射、不装反向代理；手机扫上面这张码即可。</p>
          <ul class="remote-list">
            <li><b>端到端加密</b>：AES-256-GCM，密钥只在这张二维码的 # 片段里，中转服务器只能看到密文。</li>
            <li><b>可随时收回</b>：链接等同于凭据，点「重置链接」立刻作废旧码。</li>
            <li><b>中转可替换</b>：默认走公共 MQTT 中转，只转发密文；换自建中转只需改 <code>cloud.broker</code>。</li>
          </ul>
          <div class="remote-state" id="remote-state">${phone}</div>
          <div class="remote-url" id="remote-url" title="远程链接">${escapeHtml(remote.url || '（未生成）')}</div>
          <div class="row gap">
            <button class="primary" type="button" data-copy-remote>复制远程链接</button>
            <form method="post" action="/cloud/rotate">${csrfField(csrfToken)}<button class="ghost" type="submit">重置链接</button></form>
            <form method="post" action="/cloud/toggle">${csrfField(csrfToken)}<button class="ghost" type="submit">${remote.enabled ? '暂停远程' : '启用远程'}</button></form>
          </div>
          <div class="hint">${appBaseHint}</div>
          <div class="hint">局域网地址打不开？先确认手机与电脑在同一局域网，并让系统防火墙放行本插件的监听端口（入站 TCP ${escapeHtml(String(remote.port ?? ''))}）。</div>
        </div>
      </div>
    </div>`;
}

export function renderPairPage(core, view, devices, remote = {}, options = {}) {
  const { csrfToken = '', auth = {} } = options;
  const digitCount = normalizeCode(view.code).length;
  const codeLabel = digitCount > 0 ? `配对码（${digitCount} 位）` : '配对码';
  const addresses = view.addresses.length > 0
    ? view.addresses.map((entry) => `<button class="addr" type="button" data-addr="${escapeHtml(entry.url)}">${escapeHtml(entry.address)} <span>${escapeHtml(entry.name)}</span></button>`).join('')
    : '<span class="muted">未检测到局域网 IPv4 地址</span>';
  const remoteWithPort = { port: core.port, ...remote };
  const body = `
<main class="shell">
  <header class="topbar">
    <div class="brand">${LOGO}<div><div class="brand-title">DSH 随行</div><div class="brand-sub">用手机看与控电脑上的 DSH</div></div></div>
    <div class="status-pill"><span class="dot dot-live"></span> 服务运行中 <span class="sep">·</span> 端口 ${escapeHtml(String(core.port))}</div>
  </header>

  <section class="hero">
    <div>
      <h1>让手机接管<br><span class="grad">你的 DSH 任务</span></h1>
      <p class="lede">扫描右侧二维码，手机即刻连接这台电脑。实时查看所有任务、下发新任务、随时中断。</p>
      <div class="hero-points">
        <span>局域网直连</span><span>端到端令牌</span><span>本机不暴露公网</span>
      </div>
    </div>
    <div class="hero-glow"></div>
  </section>

  ${authBanner(auth, remoteWithPort)}
  ${remoteCard(remoteWithPort, csrfToken)}

  <section class="grid">
    <div class="card qr-card">
      <div class="card-head"><span>扫码配对</span><span class="badge">一次性</span></div>
      <div class="qr-frame" id="qr-frame">${view.qrSvg}</div>
      <div class="code-label">${escapeHtml(codeLabel)}</div>
      <div class="pair-code" id="pair-code">${escapeHtml(view.code)}</div>
      <div class="countdown"><div class="countdown-bar" id="countdown-bar"></div></div>
      <div class="countdown-text"><span id="countdown-text">剩余 —</span><span id="pair-uses">已配对 ${escapeHtml(String(view.uses))} 次</span></div>
      <div class="row gap">
        <button class="primary" id="rotate" type="button">刷新二维码</button>
        <button class="ghost" id="copy-link" type="button">复制链接</button>
      </div>
      <div class="hint" id="copy-hint">在手机浏览器打开链接也可配对</div>
    </div>

    <div class="right">
      <div class="card steps-card">
        <div class="card-head"><span>三步连接</span><span class="badge soft">约 10 秒</span></div>
        <ol class="steps">
          <li><span class="step-num">1</span><div><b>在手机上打开本机地址</b><p>与电脑同一局域网时，点下面的地址；不在同一局域网时，扫上方「远程访问」的二维码。</p></div></li>
          <li><span class="step-num">2</span><div><b>输入配对码</b><p>输入左侧显示的 ${digitCount > 0 ? `${digitCount} 位` : '页面显示的'}配对码，完成一次配对，之后这台手机不必再输。</p></div></li>
          <li><span class="step-num">3</span><div><b>开始使用</b><p>任务列表实时同步；点右下角「＋」即可在电脑上创建新任务。</p></div></li>
        </ol>
        <div class="addresses">
          <div class="addresses-label">电脑地址 <span>手机需与本机同一局域网</span></div>
          <div class="addr-list">${addresses}</div>
          <p class="addr-hint">优先使用「以太网 / WLAN」地址；TAP、VPN、Hyper-V 等虚拟网卡手机通常访问不到。若打不开，请放行本插件的监听端口并暂时断开 VPN。</p>
        </div>
      </div>

      <div class="card devices-card">
        <div class="card-head"><span>已配对设备</span><span class="badge soft" id="device-count">${devices.length}</span></div>
        <div id="device-list">${deviceRows(devices)}</div>
      </div>

      <div class="card install-card">
        <div class="card-head"><span>装到手机上</span><span class="badge soft">免安装</span></div>
        <p>手机浏览器打开下面的地址即可使用，不需要装 App：</p>
        <div class="row gap">
          <a class="primary as-link" href="/app" target="_blank" rel="noreferrer">打开 Web 版</a>
        </div>
        <p class="hint">想当 App 用：iOS 用 Safari「分享 → 添加到主屏幕」，Android 用 Chrome「⋮ → 添加到主屏幕」。加到主屏后是全屏无地址栏的独立图标，断网时也能打开外壳。</p>
      </div>
    </div>
  </section>

  <footer class="foot">
    <span>DSH 随行 v${escapeHtml(PLUGIN_VERSION)}</span>
    <span>设备指纹 ${escapeHtml(view.fingerprint)}</span>
    <span>配对页仅限本机访问 · 跨网络请用上方「远程访问」</span>
  </footer>
</main>
<div class="toast" id="toast" role="status"></div>
<script type="application/json" id="pair-data">${JSON.stringify({
    available: view.available !== false,
    expiresAt: view.expiresAt,
    ttlMs: view.ttlMs,
    link: view.link,
    uses: view.uses,
    maxUses: view.maxUses,
  }).replace(/</gu, '\\u003c')}</script>`;
  return layout({
    title: 'DSH 随行 · 手机配对',
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
    <h1>${forbidden ? '配对页仅限电脑本机访问' : '请在电脑上完成配对'}</h1>
    <p>${forbidden
      ? '为保护配对码，二维码与配对码只在运行 DSH 的这台电脑上显示。请回到电脑，打开插件输出的配对地址。'
      : '打开电脑上的 DSH 配对页，用手机扫码或输入配对码即可连接。已经配对过？直接打开手机版。'}</p>
    <div class="row gap center">
      <a class="primary as-link" href="/app">打开手机版</a>
    </div>
    <div class="landing-foot">主机 ${escapeHtml(core.serverName)} · 端口 ${escapeHtml(String(core.port))}</div>
    <p class="hint">安装包只在运行 DSH 的电脑上下载，不在本页提供。</p>
  </section>
</main>`;
  return layout({ title: 'DSH 随行', body });
}
