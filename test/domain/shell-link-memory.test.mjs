/**
 * 外壳"链接记忆"与「粘贴链接」页反馈的守卫。
 *
 * 事故：用户退出后再进来，页面停在「连接你的电脑」，链接框里有一段链接，
 * 点「连接」**毫无反应**。
 *
 * 两个原因：
 *   1. 从桌面图标启动 / 浏览器丢 hash 时，`#r=…&k=…&t=…` 没了，外壳判定
 *      "不是中继外壳"，把用户丢到手动页 —— 而链接从来没有被记住过。
 *   2. 手动页的提交处理是 `if (value.length === 0) return;`，空框点「连接」
 *      静默返回，用户只能看到"什么都没发生"。
 *
 * 第一组用例**执行** `remote/remote.js` 里真实的 `storeLink()` / `readStoredLink()` /
 * `dropStoredLink()`（切片 + vm 沙箱，见 `test/support/shell-source.mjs`），因为
 * "记住什么、什么算可用"全在这三个函数里：写进去的链接下次读不出来 = 事故原样复现。
 * 只对启动顺序 / 界面文案做结构断言 —— 那部分在 `main()` 与 DOM 渲染里，没有能单独
 * 切出来的入口（`remote/remote.js` 顶层就是启动流程），硬测只能靠正则，这里注明原因。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readRepoFile, runSlices, sliceConst, sliceFunction,
} from '../support/shell-source.mjs';

const read = readRepoFile;

/** 造一份假 localStorage 并把三个链接函数真跑起来。 */
function linkMemory({ storage } = {}) {
  const remote = read('remote/remote.js');
  const store = storage ?? new Map();
  const api = runSlices({
    declarations: [
      { name: 'LINK_KEY', source: sliceConst(remote, 'LINK_KEY') },
      { name: 'readStoredLink', source: sliceFunction(remote, 'readStoredLink') },
      { name: 'storeLink', source: sliceFunction(remote, 'storeLink') },
      { name: 'dropStoredLink', source: sliceFunction(remote, 'dropStoredLink') },
    ],
    globals: {
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); },
        removeItem: (key) => { store.delete(key); },
      },
    },
  });
  return { ...api, store };
}

test('链接记忆（行为）：记住 → 读回是同一条；缺 r/k 或超长一律读成 null', () => {
  const memory = linkMemory();
  const link = 'r=8f2c&k=AAAABBBBCCCC&t=dshb_dev_token&s=wss%3A%2F%2Fbroker.example%2Fmqtt';

  // ① 成功连接后记住 → 裸启动时能读回**逐字一致**的链接（事故的修复本体）。
  memory.storeLink(link);
  assert.equal(memory.readStoredLink(), link, '记住的链接必须能原样读回');
  assert.equal(memory.store.get('dsh.pocket.link.v1'), link, '落在约定好的 localStorage 键上');

  // ② 记的是"能被恢复"的链接：读回后仍然带 r 与 k（恢复后能直接进房间）。
  const restored = new URLSearchParams(memory.readStoredLink());
  assert.equal(restored.get('r'), '8f2c');
  assert.equal(restored.get('k'), 'AAAABBBBCCCC');
  assert.equal(restored.get('t'), 'dshb_dev_token', '设备令牌也要跟着恢复，否则每次都要重新登录');

  // ③ 缺 r 或 k 的链接没有恢复价值：读出来必须是 null（宁可不恢复，也别半条链接）。
  for (const broken of ['r=8f2c', 'k=AAAABBBBCCCC', 't=dshb_dev_token', '', 'r=&k=']) {
    memory.storeLink(broken);
    assert.equal(memory.readStoredLink(), null, `不完整的链接必须读成 null：${JSON.stringify(broken)}`);
  }

  // ④ 超长 / 非字符串不许落地（localStorage 里塞进几 MB 会让启动变慢，且一定是坏的）。
  memory.storeLink('x'.repeat(4097));
  assert.equal(memory.readStoredLink(), null, '超过 4096 字符的链接必须被忽略');
  memory.storeLink(undefined);
  memory.storeLink(42);
  assert.equal(memory.readStoredLink(), null, '非字符串不许写进本机存储');

  // ⑤ 解除配对：真的删掉，不是留一份。
  memory.storeLink(link);
  memory.dropStoredLink();
  assert.equal(memory.readStoredLink(), null, 'dropStoredLink 必须真的删掉链接');
});

test('链接记忆（行为）：隐私模式 / 存储抛错时退化成"没记住"，不许抛到启动流程', () => {
  // 隐私模式下 getItem/setItem 会直接抛 SecurityError；外壳必须照常工作（只是下次要重新扫码）。
  const throwing = {
    getItem() { throw new Error('SecurityError: localStorage is disabled'); },
    setItem() { throw new Error('SecurityError: localStorage is disabled'); },
    removeItem() { throw new Error('SecurityError: localStorage is disabled'); },
  };
  const memory = linkMemory({ storage: throwing });
  assert.doesNotThrow(() => memory.storeLink('r=1&k=2&t=3'), '写失败不许抛');
  assert.equal(memory.readStoredLink(), null, '读失败返回 null（外壳据此进手动页）');
  assert.doesNotThrow(() => memory.dropStoredLink(), '删失败不许抛');

  // 存储里存的不是字符串（被别的脚本写坏）：也必须当成"没记住"。
  const brokenStore = new Map([['dsh.pocket.link.v1', 12345]]);
  const memory2 = linkMemory({ storage: brokenStore });
  assert.equal(memory2.readStoredLink(), null, '存储里不是字符串时返回 null');
});

test('外壳：恢复顺序——缺参数时先用记住的链接，再回填地址栏', () => {
  const source = read('remote/remote.js');
  // 这一段在 `main()` 里，没有可单独执行的入口，只能结构断言：钉住「恢复在手动页之前」
  // 与「地址栏也要补回链接」两个顺序特征（顺序错了就退回"点了没反应"）。
  const start = source.indexOf('const savedLink = readStoredLink();');
  const manual = source.indexOf("renderManualEntry('这个页面需要电脑端生成的远程链接才能工作。');");
  assert.ok(start > 0 && manual > start, '恢复逻辑必须排在手动页之前');
  assert.match(source, /history\.replaceState\(null, '', '#' \+ savedLink\)/u, '恢复后地址栏也要补回链接');
  assert.match(source, /storeLink\(link\.toString\(\)\);?/u, '校验通过后必须落盘');
  // 之后一律用恢复出来的 link，不许再读裸 params（否则恢复等于没做）。
  assert.equal(/resolveBrokerHint\(params\.get\('s'\)\)/u.test(source), false, 'broker 提示必须来自 link');
});

test('手动页：空/不完整链接要给出明确反馈，不许静默 return', () => {
  const source = read('remote/remote.js');
  assert.match(source, /const note = el\('small'/u, '需要一个可更新的提示元素');
  assert.match(source, /note\.classList\.add\('pocket-note-error'\)/u, '错误要标红');
  assert.match(source, /还没有填链接/u, '空框要有专门的提示');
  assert.match(source, /这段链接不完整/u, '缺参数要有专门的提示');
  // 以前的核心 bug：空框直接 return（用户只看到"点什么都没发生"）。
  assert.equal(/if \(value\.length === 0\) return;/u.test(source), false, '不许再静默返回');
  // 当前配对需要房间和密钥；旧链接的 t 字段允许保留。
  assert.match(source, /!parsed\.get\('r'\) \|\| !parsed\.get\('k'\)/u);
});

test('手动页：输入框会预填上次的链接（可直接点连接）', () => {
  const source = read('remote/remote.js');
  // 行为上等价的一条：预填用的正是 readStoredLink()（它上面已被真跑验证过）。
  const prefill = /input\.value = fromHash\.length > 0 \? fromHash : \(readStoredLink\(\) \?\? ''\);/u.exec(source);
  assert.notEqual(prefill, null, '没有 hash 时用记住的链接预填');
});

test('样式：错误提示有可见的颜色', () => {
  const css = read('remote/remote.css');
  assert.match(css, /\.pocket-note-error \{[^}]*color:/u);
});
