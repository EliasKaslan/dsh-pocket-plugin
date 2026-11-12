/**
 * lib/util.mjs 的 IO / HTTP 面：原子写、响应发送、读体、限流、文件日志。
 *
 * 这里刻意不启动真实 HTTP 服务器：被测函数只依赖 `writeHead/end/destroy`
 * 三个方法和「可异步迭代的请求体」这两个契约，用最小桩就能把每条失败分支
 * （已发头、socket 已死、JSON 循环引用、body 超限）钉住，而不用赌端口和时序。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  FileLogger, RateLimiter, atomicWriteJson, drainRequest, ensureDir, fileStat,
  readJsonBody, readJsonFile, sendJson, sendText,
} from '../../lib/util.mjs';

let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-util-io-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 最小响应桩：记录 writeHead/end，可模拟「已发头」「已结束」「socket 已断」。 */
function stubRes({ headersSent = false, writableEnded = false, throwOnHead = false } = {}) {
  const res = {
    headersSent,
    writableEnded,
    destroyed: false,
    ended: false,
    head: undefined,
    body: undefined,
    writeHead(status, headers) {
      if (throwOnHead) throw new Error('socket 已被对端关掉');
      res.head = { status, headers };
    },
    end(body) {
      res.ended = true;
      res.body = body === undefined ? undefined : Buffer.from(body);
    },
    destroy() {
      res.destroyed = true;
    },
  };
  return res;
}

/** 可异步迭代的请求体桩（readJsonBody 只用 `for await` 读它）。 */
function stubReq(chunks) {
  return (async function* iterate() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
}

test('ensureDir：递归建目录、幂等、返回入参', () => {
  const nested = path.join(dir, 'a', 'b', 'c');
  assert.equal(ensureDir(nested), nested);
  assert.equal(statSync(nested).isDirectory(), true);
  assert.equal(ensureDir(nested), nested, '重复调用不能抛');
});

test('atomicWriteJson：落盘可解析、UTF-8 完整、不留 .tmp、覆盖后无尾随垃圾', () => {
  const file = path.join(dir, 'state', 'state.json');
  const value = { 版本: 1, 设备: [{ 名字: '书房主机😀', tokenHash: 'a'.repeat(64) }], 空: null };
  atomicWriteJson(file, value);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), value);
  assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true, '文件以换行结尾，diff 才干净');
  assert.deepEqual(readdirSync(path.dirname(file)), ['state.json'], '临时文件必须被 rename 掉');

  atomicWriteJson(file, { 版本: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 版本: 2 }, '覆盖写必须整体替换，不能残留旧尾部');
  assert.equal(statSync(file).size > 0, true);
});

test('readJsonFile：损坏 / 空 / 缺失都退到 fallback，正常时原样返回', () => {
  const file = path.join(dir, 'read.json');
  assert.equal(readJsonFile(file, 'fallback'), 'fallback', '文件不存在');
  writeFileSync(file, '', 'utf8');
  assert.equal(readJsonFile(file, 'fallback'), 'fallback', '空文件');
  writeFileSync(file, '   \n\t ', 'utf8');
  assert.equal(readJsonFile(file, 'fallback'), 'fallback', '纯空白也算空');
  writeFileSync(file, '{"a":', 'utf8');
  assert.equal(readJsonFile(file, 'fallback'), 'fallback', '半截 JSON 不能抛到调用方');
  writeFileSync(file, '[1,2,3]', 'utf8');
  assert.deepEqual(readJsonFile(file, 'fallback'), [1, 2, 3], '合法的数组要返回，fallback 只兜异常');
  writeFileSync(file, 'null', 'utf8');
  assert.equal(readJsonFile(file, 'fallback'), null, 'JSON null 是合法值，不能被当成 fallback');
});

test('fileStat：存在给 size/mtimeMs，缺失给 undefined', () => {
  const file = path.join(dir, 'stat.txt');
  writeFileSync(file, 'hello', 'utf8');
  const stat = fileStat(file);
  assert.equal(stat.size, 5);
  assert.equal(typeof stat.mtimeMs, 'number');
  assert.ok(stat.mtimeMs > 0);
  assert.equal(fileStat(path.join(dir, 'nope.txt')), undefined);
  assert.equal(typeof fileStat(dir).size, 'number', '目录也能取 stat，不能抛');
});

test('sendJson：头部三件套齐全、content-length 按字节算、附加头可覆盖', () => {
  const res = stubRes();
  sendJson(res, 200, { ok: true, 名字: '全书房' });
  assert.equal(res.head.status, 200);
  assert.equal(res.head.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.head.headers['cache-control'], 'no-store', '接口响应不能被缓存');
  assert.equal(res.head.headers['content-length'], res.body.length, 'content-length 必须是字节数，不是字符数');
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { ok: true, 名字: '全书房' });
  assert.equal(res.ended, true);

  const withExtra = stubRes();
  sendJson(withExtra, 201, { ok: true }, { 'x-trace': 'abc', 'content-length': 999 });
  assert.equal(withExtra.head.headers['x-trace'], 'abc');
  // extraHeaders 在 content-length 之后展开，所以它能覆盖长度（footgun，见报告 F-9）。
  // 这里钉住现实：调用方传了 content-length 就会与 body 脱节，HTTP/1.1 会因此错位。
  assert.equal(withExtra.head.headers['content-length'], 999, '附加头确实在后面展开');
  assert.notEqual(withExtra.body.length, withExtra.head.headers['content-length'], '这正是错位的证据');
});

test('sendJson：循环引用回退成 500 与固定错误体；已发头/已结束/socket 断都只 destroy', () => {
  const circular = {};
  circular.self = circular;
  const res = stubRes();
  sendJson(res, 200, circular);
  assert.equal(res.head.status, 500, '序列化失败必须是 500，不能假装成功');
  assert.match(res.body.toString('utf8'), /"code":"internal"/u);

  for (const flag of ['headersSent', 'writableEnded']) {
    const dead = stubRes({ [flag]: true });
    sendJson(dead, 200, { ok: true });
    assert.equal(dead.head, undefined, `${flag} 时绝不能二次 writeHead`);
    assert.equal(dead.ended, false);
    assert.equal(dead.destroyed, true, `${flag} 时必须 destroy，否则连接会挂住`);
  }

  const broken = stubRes({ throwOnHead: true });
  sendJson(broken, 200, { ok: true });
  assert.equal(broken.destroyed, true, 'writeHead 抛错时要兜住，不能冒泡到请求路径');

  assert.doesNotThrow(() => sendJson(undefined, 200, {}), 'res 缺失也不能抛');
  assert.doesNotThrow(() => sendJson(null, 200, {}), 'res 为 null 也不能抛');
});

test('sendText：默认纯文本、可指定类型、按字节算长度', () => {
  const res = stubRes();
  sendText(res, 404, '没找到');
  assert.equal(res.head.status, 404);
  assert.equal(res.head.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(res.head.headers['content-length'], Buffer.byteLength('没找到', 'utf8'));
  assert.equal(res.body.toString('utf8'), '没找到');

  const html = stubRes();
  sendText(html, 200, '<h1>x</h1>', 'text/html; charset=utf-8');
  assert.equal(html.head.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(html.body.toString('utf8'), '<h1>x</h1>');

  const dead = stubRes({ headersSent: true });
  sendText(dead, 200, 'x');
  assert.equal(dead.destroyed, true);
});

test('readJsonBody：空体给 {}、跨分片拼接、数组/标量一律给 {}', async () => {
  assert.deepEqual(await readJsonBody(stubReq([])), {}, '空 body 是合法的空对象');
  assert.deepEqual(await readJsonBody(stubReq(['{"a":', '1}'])), { a: 1 }, '分片拼不起来就丢数据');
  assert.deepEqual(await readJsonBody(stubReq(['{"a":1}'])), { a: 1 });
  assert.deepEqual(await readJsonBody(stubReq(['{"a":"中文"}'])), { a: '中文' }, '多字节字符被切成两半也要拼对');
  assert.deepEqual(await readJsonBody(stubReq(['[1,2]'])), {}, '顶层数组不接受（防原型污染/类型混淆）');
  assert.deepEqual(await readJsonBody(stubReq(['"str"'])), {});
  assert.deepEqual(await readJsonBody(stubReq(['null'])), {});
});

test('readJsonBody：超限与坏 JSON 各自抛出带 code 的 Error', async () => {
  await assert.rejects(readJsonBody(stubReq(['{"a":1}']), 5), (error) => {
    assert.equal(error.code, 'body_too_large');
    assert.match(error.message, /too large/u);
    return true;
  });
  await assert.rejects(readJsonBody(stubReq(['{"a":1}']), 6), { code: 'body_too_large' }, '超限判定先于解析：7 字节 > 6');
  await assert.rejects(readJsonBody(stubReq(['{']), 1), { code: 'invalid_json' }, '不超限但坏 JSON 才走 invalid_json');
  await assert.rejects(readJsonBody(stubReq(['{'])), (error) => {
    assert.equal(error.code, 'invalid_json');
    assert.match(error.message, /invalid JSON/u);
    return true;
  });
  assert.deepEqual(await readJsonBody(stubReq(['{"a":1}']), 7), { a: 1 }, '正好卡在上限内要放行');
});

test('drainRequest：resume 被调用，resume 抛错不外泄', () => {
  let called = 0;
  drainRequest({ resume: () => { called += 1; } });
  assert.equal(called, 1);
  assert.doesNotThrow(() => drainRequest({ resume: () => { throw new Error('already ended'); } }));
  assert.doesNotThrow(() => drainRequest(undefined));
});

test('RateLimiter：配额、剩余数、被拒时的 retryAfterMs、窗口过期与 sweep', (t) => {
  // 实现只读 Date.now()，没有可注入时钟。旧用例用 1ms 窗口 + 真实 sleep 赌「两次调用落在
  // 同一毫秒内」，跨过毫秒边界就假失败（重跑即过）。这里只接管 Date.now，窗口推进由 tick
  // 显式给定：既不碰实现，也不再依赖真实时间。
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const start = Date.now();

  const limiter = new RateLimiter();
  assert.deepEqual(limiter.take('ip:1', 2, 60_000), { ok: true, remaining: 1, retryAfterMs: 0 });
  assert.deepEqual(limiter.take('ip:1', 2, 60_000), { ok: true, remaining: 0, retryAfterMs: 0 }, '配额内剩余数必须递减');
  const blocked = limiter.take('ip:1', 2, 60_000);
  assert.equal(blocked.ok, false, '超过配额必须拒绝');
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterMs, 60_000, '同一毫秒被拒时 retryAfterMs 就是整个窗口');
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000, `retryAfterMs 要在窗口内：${blocked.retryAfterMs}`);
  assert.equal(limiter.take('ip:2', 2, 60_000).ok, true, '不同 key 的桶必须互不影响');
  assert.deepEqual(limiter.peek('ip:1'), { count: 2, retryAfterMs: 60_000 });
  assert.deepEqual(limiter.peek('从未出现'), { count: 0, retryAfterMs: 0 });

  // retryAfterMs 要随流逝缩短，而不是复述窗口长度。
  t.mock.timers.tick(1);
  assert.equal(limiter.peek('ip:1').retryAfterMs, 59_999);
  assert.equal(limiter.take('ip:1', 2, 60_000).retryAfterMs, 59_999, '窗口内被拒时要给真实剩余量');

  // 推进到 resetAt 当刻：实现按 resetAt <= now 判过期，计数归零并重新放行。
  t.mock.timers.tick(59_999);
  assert.equal(Date.now(), start + 60_000);
  assert.deepEqual(limiter.peek('ip:1'), { count: 0, retryAfterMs: 0 }, '窗口过期后计数必须归零');
  assert.equal(limiter.take('ip:1', 2, 60_000).ok, true, '过期后要重新放行，否则一次误触发就永久封禁');

  // sweep：过期桶清掉、仍在窗口内的桶保留。
  const sweeper = new RateLimiter();
  sweeper.take('live', 1, 60_000);
  sweeper.take('dead', 1, 1);
  t.mock.timers.tick(1);
  sweeper.sweep();
  assert.deepEqual([...sweeper.buckets.keys()], ['live'], 'sweep 只能清过期桶，不能误删仍有效的配额');
  t.mock.timers.tick(60_000);
  sweeper.sweep();
  assert.equal(sweeper.buckets.size, 0, 'sweep 必须清掉过期桶，否则 Map 会无限增长');
});

test('FileLogger：行格式、级别、Error/循环对象的序列化、镜像开关', () => {
  const file = path.join(dir, 'logs', 'pocket.log');
  const logger = new FileLogger(file, { maxBytes: 1024 * 1024, mirror: false });
  assert.equal(statSync(file).size, 0, '构造时就应创建空文件（权限从第一字节起生效）');
  logger.info('启动完成', { port: 47901 });
  logger.warn('重连中');
  logger.error(new Error('boom'));
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length >= 3, true);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] 启动完成 \{"port":47901\}$/u);
  assert.match(lines[1], /\[warn\] 重连中$/u);
  assert.match(text, /\[error\] boom\n/u, 'Error 要先写 message');
  assert.match(text, /Error: boom/u, 'Error 的栈也要落盘，否则排障只剩一句话');

  const circular = {};
  circular.self = circular;
  logger.info(circular);
  assert.match(readFileSync(file, 'utf8'), /\[object Object\]/u, '循环引用不能把 logger 自己搞崩');

  const quiet = new FileLogger(path.join(dir, 'logs', 'quiet.log'), { mirror: false });
  quiet.info('只落盘');
  assert.equal(readFileSync(path.join(dir, 'logs', 'quiet.log'), 'utf8').includes('只落盘'), true);
});

test('FileLogger：超过 maxBytes 轮转成 .1，新文件从当行重新开始', () => {
  const file = path.join(dir, 'rotate', 'r.log');
  const logger = new FileLogger(file, { maxBytes: 1, mirror: false });
  logger.info('第一行');
  logger.info('第二行');
  assert.equal(statSync(`${file}.1`).isFile(), true, '第二行写入前应先轮转');
  assert.match(readFileSync(`${file}.1`, 'utf8'), /第一行/u);
  const current = readFileSync(file, 'utf8');
  assert.match(current, /第二行/u);
  assert.equal(current.includes('第一行'), false, '轮转后新文件不能还留着旧行');
});
