/**
 * Server-rendered desktop pairing page.
 *
 * 配对页只可能来自回环（socket + Host 校验，见 `core.isLoopbackRequest`）：
 * 它带着一个活的配对码。手机端**唯一**的入口是加密中继——二维码与链接来自
 * `remoteView()`（`cloud.status().url`，形态 `<appBase>#s=<broker>&r=<room>&k=<key>`）。
 *
 * 桌面端只监听 127.0.0.1，没有第二条通路：本页不展示、也不探测任何地址。
 * 中继不可用时页面必须说清「现在连不上」以及原因，绝不给出备用地址。
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
        <div class="device-meta">${escapeHtml(device.platform || 'unknown')}${device.appVersion ? ` · v${escapeHtml(device.appVersion)}` : ''}</div>
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

function clockOf(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

/** 中继卡片：唯一入口。二维码/链接只在 online 时给；其余状态给原因。 */
function remoteCard(relay, csrfToken) {
  const [label, tone] = REMOTE_BADGE[relay.state] ?? ['未启用', 'soft'];
  const online = relay.state === 'online';
  const phone = relay.phoneName
    ? `手机「${escapeHtml(relay.phoneName)}」已接入中转`
    : '等待手机扫码接入';
  let qr;
  if (relay.qrSvg.length > 0) qr = `<div class="remote-qr">${relay.qrSvg}</div>`;
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

export function renderPairPage(core, view = {}, devices = [], remote = {}, options = {}) {
  const { csrfToken = '', auth = {} } = options;
  const pairing = view ?? {};
  const code = typeof pairing.code === 'string' ? pairing.code : '';
  const digitCount = normalizeCode(code).length;
  const expiresAt = Number(pairing.expiresAt) || 0;
  const ttlMs = Number(pairing.ttlMs) || 0;
  const uses = Number(pairing.uses) || 0;
  const maxUses = Number(pairing.maxUses) || 0;
  const maxDevices = Number(pairing.maxDevices) || 0;
  const fingerprint = String(pairing.fingerprint ?? core?.fingerprint ?? '');
  const available = pairing.available !== false && code.length > 0;
  const relay = relayFacts(remote);
  const deviceList = Array.isArray(devices) ? devices : [];
  const codeLabel = digitCount > 0 ? `配对码（${digitCount} 位）` : '配对码';
  const expiresText = expiresAt > 0
    ? `有效期至 ${clockOf(expiresAt)}${ttlMs > 0 ? `（约 ${Math.max(1, Math.round(ttlMs / 60_000))} 分钟）` : ''}`
    : '配对窗口已关闭，点「刷新配对码」重新生成';
  const limitText = [
    maxUses > 0 ? `本码最多可用 ${maxUses} 次` : '',
    maxDevices > 0 ? `设备上限 ${maxDevices} 台` : '',
  ].filter((item) => item.length > 0).join(' · ');
  const body = `
<main class="shell">
  <header class="topbar">
    <div class="brand">${LOGO}<div><div class="brand-title">DSH 随行</div><div class="brand-sub">用手机看与控电脑上的 DSH</div></div></div>
    <div class="status-pill"><span class="dot dot-live"></span> 服务运行中 <span class="sep">·</span> 本机端口 ${escapeHtml(String(core?.port ?? '—'))}</div>
  </header>

  <section class="hero">
    <div>
      <h1>让手机接管<br><span class="grad">你的 DSH 任务</span></h1>
      <p class="lede">电脑只向加密中继发起出站连接，不开放任何入站端口。手机打开中继外壳，扫一次码或输入配对码即可连上。</p>
      <div class="hero-points">
        <span>端到端加密</span><span>电脑零公网暴露</span><span>只走中继</span>
      </div>
    </div>
    <div class="hero-glow"></div>
  </section>

  ${relayBanner(relay)}
  ${authBanner(auth, relay)}
  ${remoteCard(relay, csrfToken)}

  <section class="grid">
    <div class="card qr-card">
      <div class="card-head"><span>配对码</span><span class="badge">一次性</span></div>
      <div class="code-label">${escapeHtml(codeLabel)}</div>
      <div class="pair-code" id="pair-code" style="user-select:all">${escapeHtml(code.length > 0 ? code : '——')}</div>
      <div class="hint">在手机的中继外壳里输入这串码即可认领这台电脑；点一下可全选复制。</div>
      <div class="countdown"><div class="countdown-bar" id="countdown-bar"></div></div>
      <div class="countdown-text"><span id="countdown-text">${escapeHtml(expiresText)}</span><span id="pair-uses">已配对 ${escapeHtml(String(uses))} 次</span></div>
      <div class="hint">${escapeHtml(limitText)}</div>
      <div class="row gap">
        <button class="primary" id="rotate" type="button">刷新配对码</button>
      </div>
      <div class="hint" id="copy-hint">${available ? '配对码只显示在这台电脑上，手机端只需输入它。' : '配对窗口已关闭，刷新后手机才能再次认领。'}</div>
    </div>

    <div class="right">
      <div class="card steps-card">
        <div class="card-head"><span>三步连接</span><span class="badge soft">约 10 秒</span></div>
        <ol class="steps">
          <li><span class="step-num">1</span><div><b>在手机上打开中继外壳</b><p>扫上方中继卡片里的二维码，或在手机浏览器打开外壳地址（<code>cloud.appBase</code>）。二维码里带着中转与房间参数。</p></div></li>
          <li><span class="step-num">2</span><div><b>输入配对码</b><p>在手机外壳里输入左侧显示的 ${digitCount > 0 ? `${digitCount} 位` : '页面显示的'}配对码，完成一次认领，之后这台手机不必再输。</p></div></li>
          <li><span class="step-num">3</span><div><b>开始使用</b><p>任务列表实时同步；点右下角「＋」即可在电脑上创建新任务。</p></div></li>
        </ol>
      </div>

      <div class="card devices-card">
        <div class="card-head"><span>已配对设备</span><span class="badge soft" id="device-count">${deviceList.length}</span></div>
        <div id="device-list">${deviceRows(deviceList)}</div>
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
    <span>配对页仅限本机访问 · 手机唯一入口是上面的加密中继</span>
  </footer>
</main>
<div class="toast" id="toast" role="status"></div>
<script type="application/json" id="pair-data">${JSON.stringify({
    available,
    expiresAt,
    ttlMs,
    uses,
    maxUses,
    maxDevices,
    relayUrl: relay.url,
    relayState: relay.state,
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
      : '打开电脑上的 DSH 配对页，用手机扫中继卡片上的二维码或输入配对码即可连接；手机只走加密中继这一条通路。'}</p>
    <div class="landing-foot">主机 ${escapeHtml(core.serverName)} · 端口 ${escapeHtml(String(core.port))}</div>
    <p class="hint">安装包只在运行 DSH 的电脑上下载，不在本页提供。手机端没有本地入口，请用中继卡片上的二维码或外壳地址。</p>
  </section>
</main>`;
  return layout({ title: 'DSH 随行', body });
}
