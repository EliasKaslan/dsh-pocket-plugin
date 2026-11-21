import assert from 'node:assert/strict';
import test from 'node:test';
import { Relay, installWebSocket, makeSealer } from '../../docs/remote.js';
import { decodeAll, makeLink } from './_support/fixtures.mjs';

async function phone(link) {
  const { key, room } = link.identity;
  const shell = new Relay({ room, sealer: await makeSealer(key, room), brokers: [] });
  shell.ready = true;
  shell.client = { publish(_topic, payload) { link.onFrame(Buffer.from(payload)); } };
  return shell;
}

test('two phones process only their own login reply, including delayed and duplicate deliveries', async () => {
  const issued = new Set();
  const devices = new Map();
  const { link, sent } = makeLink({
    auth: {
      enabled: true, user: 'owner',
      login({ phone }) { const token = 'session-' + phone; issued.add(token); return { ok: true, token }; },
      check(token) { return issued.has(token) ? {} : null; },
    },
    core: {
      provisionDevice({ name }) {
        const device = { id: name };
        devices.set(name, device);
        return { token: name, device };
      },
      authenticateToken(token) { return devices.get(token); },
    },
  });
  const a = await phone(link);
  const b = await phone(link);
  a.phoneName = 'first';
  b.phoneName = 'second';
  const pending = [a.login({ user: 'owner', password: 'fixture' }), b.login({ user: 'owner', password: 'fixture' })];
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(tick); reject(new Error('missing control replies')); }, 1000);
    const tick = setInterval(() => {
      if (sent.length !== 2) return;
      clearInterval(tick); clearTimeout(timeout); resolve();
    }, 5);
  });
  for (const payload of [sent[1].payload, sent[0].payload, sent[1].payload]) {
    await Promise.all([a, b].map((p) => p.onMessage(Buffer.from(payload))));
  }
  assert.deepEqual((await Promise.all(pending)).map((r) => r.token), ['session-first', 'session-second']);
  assert.deepEqual([a.deviceId, b.deviceId], ['first', 'second']);
});

test('timed-out auth checks do not open the app or adopt a late device response', async () => {
  const { link, sent } = makeLink();
  const shell = await phone(link);
  const result = await shell.checkAuth(25);
  assert.deepEqual(result, { ok: false, unavailable: true });
  assert.equal(decodeAll(link, sent)[0]?.t, 'auth.reply');
  await shell.onMessage(Buffer.from(sent[0].payload));
  assert.equal(shell.deviceToken, '');
  assert.equal(shell.controlRequests.size, 0);
});

test('cancelled request waiting for transport readiness is never published', async () => {
  const { link } = makeLink();
  const shell = await phone(link);
  let messages = 0;
  shell.client.publish = () => { messages += 1; };
  shell.ready = false;
  const controller = new AbortController();
  const request = shell.request({ method: 'POST', path: '/api/v1/tasks', body: '{}', signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  shell.ready = true;
  for (const resolve of shell.readyWaiters) resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages, 0);
  assert.equal(shell.pending.size, 0);
});

test('a refused or malformed fragment does not consume a reassembly slot', async () => {
  const shell = await phone(makeLink().link);
  const part = { id: '123456789abc', seq: 0, total: 2 };
  assert.equal(shell.collectPart({ ...part, d: '@@' }), null);
  assert.equal(shell.collectPart({ ...part, d: Buffer.alloc(65537).toString('base64') }), null);
  assert.equal(shell.parts.size, 0);
});

test('a login that expires before MQTT is ready is never submitted', async () => {
  const { link } = makeLink();
  const shell = await phone(link);
  let sends = 0;
  shell.client.publish = () => { sends++; };
  shell.ready = false;
  const reply = await shell.login({ user: 'test', password: 'fixture', timeoutMs: 10 });
  assert.equal(reply.reason, 'timeout');
  shell.ready = true;
  for (const resolve of shell.readyWaiters) resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
});

test('the WebSocket shim preserves send order across Blob, text and close', async (t) => {
  // Node 22 has EventTarget and MessageEvent but lacks the browser CloseEvent.
  if (typeof globalThis.CloseEvent === 'undefined') {
    globalThis.CloseEvent = class extends Event {
      constructor(type, init) { super(type); Object.assign(this, init); }
    };
    t.after(() => { delete globalThis.CloseEvent; });
  }
  const originalWindow = globalThis.window;
  globalThis.window = { WebSocket: globalThis.WebSocket };
  t.after(() => { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
  const sent = [];
  const relay = {
    sockets: new Map(), async openSocket() {}, async closeSocket() { sent.push('closed'); },
    async send(frame) { sent.push(frame.data); }, nextSeq() { return sent.length + 1; }, serverNow: Date.now,
  };
  installWebSocket(relay);
  const socket = new window.WebSocket('wss://dsh-remote.local/ws');
  socket._open();
  const got = [];
  socket.onmessage = (event) => got.push(event.data);
  socket._message({ bin: true, data: 'AQI=' });
  socket.binaryType = 'arraybuffer';
  socket._message({ bin: true, data: 'AwQ=' });
  assert.ok(got[0] instanceof Blob);
  assert.deepEqual([...new Uint8Array(got[1])], [3, 4]);
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve));
  socket.send(new Blob([new Uint8Array([1, 2])]));
  socket.send('text');
  socket.close();
  await closed;
  assert.deepEqual(sent, ['AQI=', 'text', 'closed']);
});
