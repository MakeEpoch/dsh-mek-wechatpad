/**
 * End-to-end wiring check against a real socket.
 *
 * The unit tests cover decoding and policy; this one proves the parts that
 * only a real server can show: the `/dsh-wechatpad/ws` upgrade connecting to a
 * fake WechatPad push feed, the webhook route accepting only the issued token,
 * and the settings RPC channel answering over `ctx.connection.rpc`.
 *
 * A minimal stand-in for dsh's `webServer` and `connection` services is used,
 * so the run needs nothing beyond Node itself.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

import { registerPushRoute, registerWebhookRoute } from '../host/ws-route.js';
import { registerManagementRpc } from '../host/management-rpc.js';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** A fake WechatPad: one HTTP endpoint plus its push WebSocket. */
async function startFakePad() {
  const http = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/ws/GetSyncMsg') {
      response.writeHead(400).end('upgrade required');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"Success":true,"Code":200,"Data":{}}');
  });
  const wss = new WebSocketServer({ server: http, path: '/ws/GetSyncMsg' });
  const port = await listen(http);
  return { http, wss, port, close: () => { for (const client of wss.clients) client.terminate(); wss.close(); http.close(); } };
}

/** The subset of ctx.webServer this plugin uses. */
function fakeWebServer(server) {
  const routes = new Map();
  const upgrades = new Map();
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const handler = upgrades.get(path);
    if (!handler) {
      socket.destroy();
      return;
    }
    handler(request, socket, head);
  });
  server.on('request', (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const route = routes.get(path);
    if (!route) {
      response.writeHead(404).end('not found');
      return;
    }
    Promise.resolve()
      .then(() => route(request, response))
      .catch((error) => {
        if (!response.headersSent) response.writeHead(500).end(String(error?.message ?? error));
        else response.destroy();
      });
  });
  return {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
    registerUpgrade(route) {
      upgrades.set(route.path, route.handler);
      return () => upgrades.delete(route.path);
    },
    getOrigin() {
      return `http://127.0.0.1:${server.address().port}`;
    },
  };
}

test('push feed proxying: frames reach the handler through the dsh route', async () => {
  const pad = await startFakePad();
  const server = createServer();
  const webServer = fakeWebServer(server);
  const port = await listen(server);
  const frames = [];
  const ctx = {
    webServer,
    connection: { requestRejection: () => undefined },
  };

  const dispose = registerPushRoute({
    ctx,
    padTarget: () => ({ url: `ws://127.0.0.1:${pad.port}/ws/GetSyncMsg?key=k`, key: 'k' }),
    onFrame: (frame) => frames.push(frame),
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}/dsh-wechatpad/ws`);
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  // The Pad pushes only after the proxy has connected upstream.
  await new Promise((resolve) => pad.wss.once('connection', resolve));
  const message = JSON.stringify({ from_user_name: { str: 'wxid_a' }, to_user_name: { str: 'wxid_bot' }, content: { str: 'hi' }, msg_type: 1, new_msg_id: 'm1' });
  for (const client of pad.wss.clients) client.send(message);

  const forwarded = await new Promise((resolve) => client.once('message', (data) => resolve(String(data))));
  assert.equal(forwarded, message);
  assert.deepEqual(frames, [message]);

  client.close();
  dispose();
  pad.close();
  await new Promise((resolve) => server.close(resolve));
});

test('push feed stops at the connection gate', async () => {
  const server = createServer();
  const webServer = fakeWebServer(server);
  const port = await listen(server);
  const ctx = { webServer, connection: { requestRejection: () => 403 } };
  const dispose = registerPushRoute({
    ctx,
    padTarget: () => ({ url: 'ws://127.0.0.1:1/ws/GetSyncMsg', key: 'k' }),
    onFrame: () => assert.fail('a rejected request must not reach the Pad'),
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}/dsh-wechatpad/ws`);
  const outcome = await new Promise((resolve) => {
    client.once('error', () => resolve('error'));
    client.once('open', () => resolve('open'));
  });
  assert.equal(outcome, 'error');
  dispose();
  await new Promise((resolve) => server.close(resolve));
});

test('webhook route: token and Host fence are enforced before parsing', async () => {
  const server = createServer();
  const webServer = fakeWebServer(server);
  const port = await listen(server);
  const received = [];
  let reject = false;
  const ctx = {
    webServer,
    connection: { requestRejection: () => (reject ? 403 : undefined) },
  };
  const dispose = registerWebhookRoute({
    ctx,
    path: '/dsh-wechatpad/callback',
    webhookAuth: () => ({ token: 'issued-token' }),
    onPayload: (payload) => received.push(payload),
  });
  const url = `http://127.0.0.1:${port}/dsh-wechatpad/callback`;

  const noToken = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(noToken.status, 401);

  const wrongToken = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-wechatpad-token': 'nope' } });
  assert.equal(wrongToken.status, 401);

  const ok = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ new_msg_id: 'm9', from_user_name: { str: 'wxid_a' } }),
    headers: { 'content-type': 'application/json', 'x-wechatpad-token': 'issued-token' },
  });
  assert.equal(ok.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].new_msg_id, 'm9');

  const badJson = await fetch(url, { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json', 'x-wechatpad-token': 'issued-token' } });
  assert.equal(badJson.status, 400);

  reject = true;
  const fenced = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-wechatpad-token': 'issued-token' } });
  assert.equal(fenced.status, 403);

  const wrongMethod = await fetch(url, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);

  dispose();
  await new Promise((resolve) => server.close(resolve));
});

test('management rpc channel is mounted on the connection carrier', async () => {
  let mounted = null;
  const ctx = { connection: { fetch: { register: (route) => { mounted = route; return () => {}; } } } };
  const service = {
    status: () => ({ phase: 'connected', label: '已连接' }),
    panelSettings: () => ({ settings: {}, revision: 0 }),
    updateSettings: async () => ({ saved: true }),
    resetSettings: async () => ({ saved: true }),
    testConnection: async () => ({ ok: true }),
    reconnect: async () => ({ phase: 'connected' }),
  };
  const dispose = await registerManagementRpc({ ctx, service });
  assert.equal(mounted.path, '/api/dsh-wechatpad');
  const response = await mounted.fetch(new Request('http://127.0.0.1:3080/api/dsh-wechatpad', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'dsh-wechatpad', payload: { method: 'status.get', payload: {} } }),
  }));
  const body = await response.json();
  assert.equal(body.result.ok, true);
  assert.equal(body.result.value.phase, 'connected');
  await dispose();
});
