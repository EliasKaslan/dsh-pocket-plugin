import { startBridge, request, requestJson, openStream, wsHandshake, securityHeaderErrors, SECRET } from './harness.mjs';

const ctx = await startBridge({ downloadFiles: { 'installer.exe': 'MZ-fake' } });
console.log('port', ctx.port, 'workRoot', ctx.workRoot);

const health = await request(ctx.port, '/api/v1/health');
console.log('health', health.status, health.headers['content-type'], JSON.stringify(securityHeaderErrors(health.headers)));
console.log('health body', health.body.slice(0, 200));

const big = await request(ctx.port, '/api/v1/tasks', {
  method: 'POST',
  headers: { authorization: `Bearer ${ctx.mint().token}`, 'content-type': 'application/json' },
  body: 'x'.repeat(300 * 1024),
});
console.log('big body', big.status, big.aborted, big.body.slice(0, 200));

const exact = await request(ctx.port, '/api/v1/tasks', {
  method: 'POST',
  headers: { authorization: `Bearer ${ctx.mint().token}`, 'content-type': 'application/json' },
  body: `{"prompt":"${'a'.repeat(262144 - 13)}"}`,
});
console.log('exact body', exact.status, exact.aborted, exact.body.slice(0, 200));

const token = ctx.mint().token;
const me = await requestJson(ctx.port, '/api/v1/me', { headers: { authorization: `Bearer ${token}` } });
console.log('me', me.status, JSON.stringify(me.json).slice(0, 200));

const created = await requestJson(ctx.port, '/api/v1/tasks', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-pocket-csrf': ctx.core.csrfToken },
  body: JSON.stringify({ prompt: '集成测试任务', cwd: ctx.workRoot }),
});
console.log('create task', created.status, JSON.stringify(created.json).slice(0, 300));

const detail = await requestJson(ctx.port, `/api/v1/tasks/${created.json.data.task.id}`, { headers: { authorization: `Bearer ${token}` } });
console.log('detail', detail.status, JSON.stringify(detail.json).slice(0, 200));

const sse = await openStream(ctx.port, '/api/v1/events', { headers: { authorization: `Bearer ${token}` } });
console.log('sse status', sse.res.statusCode, sse.res.headers['content-type'], sse.res.headers['cache-control']);
const text = await sse.readUntil((value) => value.includes('event: hello'));
console.log('sse chunk', JSON.stringify(text.slice(0, 400)));
sse.destroy();

for (const badBody of ['{"prompt":', 'null', '[]', '"x"']) {
  const res = await requestJson(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: badBody,
  });
  console.log('malformed', JSON.stringify(badBody), res.status, res.json.error.code);
}

const head = await request(ctx.port, '/app/index.html', { method: 'HEAD' });
console.log('HEAD', head.status, JSON.stringify(head.headers), 'bodyLen', head.body.length);
const full = await request(ctx.port, '/app/index.html');
const etag = full.headers.etag;
const notModified = await request(ctx.port, '/app/index.html', { headers: { 'if-none-match': etag } });
console.log('304', notModified.status, notModified.headers.etag, 'bodyLen', notModified.body.length);

const forgedHost = await request(ctx.port, '/api/v1/health', { headers: { host: 'evil.example:1234' } });
console.log('forged host api', forgedHost.status, forgedHost.body);
const forgedHostPage = await request(ctx.port, '/pair', { headers: { host: 'evil.example:1234' } });
console.log('forged host page', forgedHostPage.status, forgedHostPage.body.slice(0, 40));
const localHost = await request(ctx.port, '/api/v1/health', { headers: { host: `localhost:${ctx.port}` } });
console.log('localhost host', localHost.status);

// 配对码接口已删除：设备令牌直接铸，回环设备列表是它唯一的 HTTP 出口。
const probeDevice = ctx.mint({ name: '探针', platform: 'test' });
const devices = await requestJson(ctx.port, '/api/v1/devices', {});
console.log('devices', devices.status, Object.keys(devices.json.data ?? {}), 'minted', probeDevice.device.id);

const ws401 = await wsHandshake(ctx.port, '/ws');
console.log('ws no ticket', ws401.status, JSON.stringify(ws401.body).slice(0, 80));
const ticket = await requestJson(ctx.port, '/api/v1/ws-ticket', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
const wsOk = await wsHandshake(ctx.port, `/ws?ticket=${ticket.json.data.ticket}`);
console.log('ws ok', wsOk.status, JSON.stringify(wsOk.messages[0]).slice(0, 200));
wsOk.socket.close();
const wsReuse = await wsHandshake(ctx.port, `/ws?ticket=${ticket.json.data.ticket}`);
console.log('ws reuse', wsReuse.status);

const formBody = `csrf=${ctx.core.csrfToken}&pad=${'a'.repeat(4096 - 37 - 5)}`;
console.log('form body length', Buffer.byteLength(formBody));
const form = await request(ctx.port, '/cloud/rotate', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
  body: formBody,
});
console.log('form exact', form.status, form.headers.location, form.body.slice(0, 120));
const formOver = await request(ctx.port, '/cloud/rotate', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
  body: `${formBody}b`,
});
console.log('form over', formOver.status, formOver.body.slice(0, 120));

const download = await request(ctx.port, '/download/installer.exe');
console.log('download', download.status, download.headers['content-type'], download.body);
const traverse = await request(ctx.port, '/download/..%2fsecret.txt');
console.log('download traversal', traverse.status, traverse.body.slice(0, 40));

console.log('logs', ctx.logs.slice(-5));
await ctx.close();
console.log('closed');
