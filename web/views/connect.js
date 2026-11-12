/**
 * 登录之后的「设备状态」屏。
 *
 * 手输 8 位码那一步已经删掉：手机只用口令登录，登录成功时桌面随应答把设备令牌
 * 发下来，app.js 拿着它直接进任务列表。所以这里只剩「为什么进不去」——
 * 设备被电脑端移除、设备数已满、或者本地压根没有登录。
 * 三种情况都必须说清楚，不能静默退回。
 */
import { h, icon } from '../lib/dom.js';
import { isRelayShell, shellDeviceError } from '../store.js';

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

  const screen = h('div', { class: 'screen screen-connect' },
    h('div', { class: 'scroll connect-scroll' },
      hero,
      notice,
      h('div', { class: 'connect-card' },
        statusLine,
        submit,
        errorLine,
      ),
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
    },
    destroy() {},
  };
}
