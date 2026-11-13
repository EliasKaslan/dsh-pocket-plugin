/**
 * 登录之后的「设备状态」屏。
 *
 * 手输 8 位码那一步已经删掉：手机只用口令登录，登录成功时桌面随应答把设备令牌
 * 发下来，app.js 拿着它直接进任务列表。所以这里只剩「为什么进不去」——
 * 设备被电脑端移除、设备数已满、或者本地压根没有登录。
 * 三种情况都必须说清楚，不能静默退回。
 *
 * 这里还多了第三块内容：**中继诊断**。它存在的理由就是"连不上的时候能看"——
 * 所以每一行都只读外壳记下的本地状态（`__POCKET_DIAG__.snapshot()`），
 * 不依赖 MQTT 是否连通、也不发起任何请求。
 */
import { h, icon } from '../lib/dom.js';
import { isRelayShell, shellDeviceError } from '../store.js';

/**
 * 外壳（`remote/remote.js`）挂出来的诊断接口：只读快照 + 纯函数。
 *
 * 为什么这里不直接静态引用 `web/lib/relay-diag.js`：本文件同时被打进局域网布局，
 * 而 `web/sw.js` 的 `ASSETS` 是一份**手写清单** —— 新加一条相对 import 而清单
 * 没跟上，装过 SW 的手机首次离线打开就是模块 404、整屏白（`test/unit/client-guards`
 * 专门钉着这条，`web/sw.js` 不在本次可改范围内）。所以纯逻辑留在
 * `web/lib/relay-diag.js` 由外壳 import，这里只读外壳交过来的接口。
 * 局域网布局里没有外壳 → 没有这个 global → 诊断块整块不渲染。
 */
function readDiagApi() {
  const api = globalThis.__POCKET_DIAG__;
  if (api === null || typeof api !== 'object') return null;
  for (const name of ['snapshot', 'diagRows', 'buildDiagText']) {
    if (typeof api[name] !== 'function') return null;
  }
  return api;
}

/**
 * 诊断附带的设备上下文（**只**有两项非敏感信息）。
 *
 * 拿不到一律给默认值：诊断永远不该因为一个取不到的属性把连接页搞崩。
 */
function deviceContext() {
  let userAgent = '未知';
  let pwa = false;
  try { userAgent = String(globalThis.navigator?.userAgent ?? '未知'); } catch { /* 隐私模式 */ }
  try {
    pwa = globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true
      || globalThis.navigator?.standalone === true;
  } catch { /* 老浏览器 */ }
  return { pwa, userAgent };
}

/** 没有中继外壳就没有任何可用的连接方式 —— 这句提示必须原样出现。 */
export const RELAY_REQUIRED_MESSAGE = '本页面必须从中继外壳打开';

/** 与 `remote/remote.js` 里 `__POCKET_SHELL__.deviceError` 的取值一一对应。 */
export const DEVICE_MESSAGES = {
  revoked: '这台设备已被电脑端移除，请重新用口令登录',
  limit: '设备数已达上限，请先在电脑上移除旧设备',
};

/** 没有设备令牌、也不是上面两种：这台手机就是还没登录过。 */
export const SIGNED_OUT_MESSAGE = '这台手机还没有登录，请用电脑上设置的用户名和访问口令登录。';

/** 设备状态码 → 给人看的一句话；未知状态返回空串，由调用方兜底。 */
export function deviceIssueMessage(code) {
  const key = String(code ?? '');
  return key === 'revoked' || key === 'limit' ? DEVICE_MESSAGES[key] : '';
}

export function mountConnect(root, ctx) {
  const relay = isRelayShell();
  const issue = relay ? shellDeviceError() : '';
  const status = deviceIssueMessage(issue) || SIGNED_OUT_MESSAGE;
  // 设备数满了手机这边修不了，只能等电脑上腾出位置；其余情况都回口令闸门。
  const needsPassword = issue !== 'limit';

  const hint = h('p', { class: 'connect-hint' });
  hint.textContent = relay
    ? '手机只用口令登录：登录成功后直接进入任务列表，没有第二步。'
    : '局域网直连已经删除，这个页面不再能直接连到电脑。';

  const hero = h('div', { class: 'connect-hero' },
    h('div', { class: 'hero-mark' }, icon('sparkles', { size: 26 })),
    h('h1', { text: '连接你的电脑' }),
    hint,
  );

  const notice = h('div', { class: 'connect-notice', role: 'alert', hidden: relay },
    icon('alert', { size: 18 }),
    h('div', { class: 'connect-notice-text' },
      h('strong', { text: RELAY_REQUIRED_MESSAGE }),
      h('span', { text: '手机只能通过中继外壳（静态站点 + 加密中继）访问电脑，请从那个地址打开。' }),
    ),
  );

  const statusLine = h('p', {
    class: issue.length > 0 ? 'connect-status is-issue' : 'connect-status',
    text: status,
  });
  const submit = h('button', { class: 'btn btn-primary connect-submit', type: 'button' },
    icon(needsPassword ? 'link' : 'refresh', { size: 18 }),
    h('span', { text: needsPassword ? '重新登录' : '重试' }));
  const errorLine = h('p', { class: 'connect-error', hidden: true });

  /* ------------------------------ 中继诊断 ------------------------------ */
  //
  // 这一块**不进** `.connect-card`：它是排障信息，不是"下一步该点哪里"。
  // 离线时同样渲染 —— 那正是它存在的场景。
  const diagApi = readDiagApi();
  const showDiag = relay === true && diagApi !== null;
  const diagList = h('div', { class: 'diag-rows' });
  const diagAdvice = h('p', { class: 'diag-advice' });
  const diagNote = h('p', { class: 'diag-note', hidden: true });
  const diagFallback = h('textarea', {
    class: 'diag-text',
    rows: '9',
    readonly: '',
    hidden: true,
    'aria-label': '诊断信息（可长按全选手动复制）',
  });
  const diagCopy = h('button', { class: 'btn diag-copy', type: 'button' },
    icon('copy', { size: 16 }),
    h('span', { text: '复制诊断信息' }));
  const diagCard = h('section', { class: 'diag-card', hidden: !showDiag },
    h('h2', { class: 'diag-title', text: '中继诊断' }),
    h('p', { class: 'diag-lead', text: '连不上时先读这里的结论。仍然不行就复制下面这段发给维护者——里面没有房间密钥、没有设备令牌。' }),
    diagList,
    diagAdvice,
    diagCopy,
    diagNote,
    diagFallback,
  );

  const screen = h('div', { class: 'screen screen-connect' },
    h('div', { class: 'scroll connect-scroll' },
      hero,
      notice,
      h('div', { class: 'connect-card' },
        statusLine,
        submit,
        errorLine,
      ),
      diagCard,
      h('p', { class: 'connect-foot', text: '所有数据都在你自己的电脑上；中继只转发密文，密钥不会离开这台手机和你的电脑。' }),
    ),
  );
  root.append(screen);

  if (!relay) {
    // 明确认输，而不是偷偷按 location.origin 直连。
    submit.disabled = true;
  }

  function fail(message) {
    errorLine.hidden = false;
    errorLine.textContent = message;
  }

  /* -------------------------- 诊断块的实现 -------------------------- */

  /** 外壳记下的快照；外壳不在 / 读失败都返回 null（诊断块保持空白，绝不抛）。 */
  function diagSnapshot() {
    if (diagApi === null) return null;
    try {
      const value = diagApi.snapshot();
      return value !== null && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  /** 「复制诊断信息」要复制的文本（白名单字段，见 relay-diag.js 的注释）。 */
  function diagText() {
    if (diagApi === null) return '';
    const snapshot = diagSnapshot();
    if (snapshot === null) return '';
    try {
      return String(diagApi.buildDiagText({ ...snapshot, ...deviceContext() }));
    } catch {
      return '';
    }
  }

  /**
   * 重画诊断行。
   *
   * 只读本地状态，**不依赖 MQTT 已连上** —— 这正是这块内容存在的意义。
   * 行数据由纯函数 `diagRows()` 生成（`test/unit/relay-diag.test.mjs` 直接测它），
   * 这里只负责把 `{label, value}` 摆成 DOM。
   */
  function paintDiag() {
    if (!showDiag) return;
    const snapshot = diagSnapshot();
    if (snapshot === null) return;
    let rows;
    try {
      rows = diagApi.diagRows({ ...snapshot, ...deviceContext() });
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    const advice = rows.filter((row) => row.key === 'advice');
    diagList.replaceChildren(...rows
      .filter((row) => row.key !== 'advice')
      .map((row) => h('div', { class: 'diag-row' },
        h('span', { class: 'diag-label', text: String(row.label ?? '') }),
        h('span', { class: 'diag-value', text: String(row.value ?? '') }))));
    diagAdvice.textContent = advice.length === 0 ? '' : String(advice[0].value ?? '');
  }

  diagCopy.addEventListener('click', async () => {
    const text = diagText();
    if (text === '') {
      diagNote.hidden = false;
      diagNote.textContent = '暂时没有可复制的诊断信息。';
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      diagNote.hidden = false;
      diagNote.textContent = '诊断信息已复制，可以直接粘贴发给维护者。';
      diagFallback.hidden = true;
    } catch {
      // 非 https / 旧 WebView 没有剪贴板 API：降级成一个可长按选中的文本框。
      // 手机上"长按全选复制"是人人都会的动作，比再弹一句"复制失败"有用得多。
      diagFallback.value = text;
      diagFallback.hidden = false;
      diagNote.hidden = false;
      diagNote.textContent = '这个浏览器不允许自动复制，请长按下面的文本框全选手动复制。';
    }
  });

  // 每 2 秒重画：重试过程中「连续失败次数 / 最后尝试」一直在变，正是要看的。
  const diagTimer = setInterval(paintDiag, 2_000);
  // Node（单测）里 setInterval 返回的句柄会吊住进程；浏览器里返回数字，`?.` 安全。
  diagTimer?.unref?.();
  paintDiag();

  submit.addEventListener('click', () => {
    if (!relay) {
      fail(RELAY_REQUIRED_MESSAGE);
      return;
    }
    errorLine.hidden = true;
    if (!needsPassword) {
      // 设备数已满：电脑上移除一台旧设备后重来，手机端没有别的动作可做。
      if (typeof ctx.reloadPage === 'function') ctx.reloadPage();
      else location.reload();
      return;
    }
    if (typeof ctx.relogin === 'function') {
      ctx.relogin();
      return;
    }
    fail('重新登录需要从电脑端生成的远程链接打开这个页面。');
  });

  return {
    screen,
    paint() {
      statusLine.textContent = deviceIssueMessage(shellDeviceError()) || SIGNED_OUT_MESSAGE;
      // 诊断块跟着刷新：状态变化时（重新登录 / 中继恢复）失败计数要一起变。
      paintDiag();
    },
    destroy() {
      clearInterval(diagTimer);
    },
  };
}
