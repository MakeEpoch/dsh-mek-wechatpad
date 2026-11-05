import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createPadConnection } from '../host/connections/pad.js';
import { resolveConfig } from '../host/config.js';
import { registerManagementRpc } from '../host/management-rpc.js';

test('Pad WS: account isolation, heartbeat, HTTP probe and shared token', async t => {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, token: req.headers['x-bridge-token'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/bridge/accounts' ? { accounts: [{ wxid: 'bot', nick_name: 'Bot' }] } : { Code: 200, Data: { loginState: 1 } }));
  });
  const wss = new WebSocketServer({ server, path: '/ws/outbound' });
  const messages = [];
  let params, pong;
  const heartbeat = new Promise(resolve => { pong = resolve; });
  wss.on('connection', (socket, req) => {
    params = new URL(req.url, 'http://pad').searchParams;
    socket.on('message', data => { if (JSON.parse(data).type === 'pong') pong(); });
    setTimeout(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
      for (const wxid of ['another-bot', 'bot']) socket.send(JSON.stringify({ type: 'message', wxid, message: {
        msg_type: 1, new_msg_id: '9007199254740993', from_user_name: { str: 'peer' }, to_user_name: { str: 'bot' }, content: { str: 'hello' },
      } }));
    }, 20);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = createPadConnection({ config: resolveConfig({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'secret', wxid: 'bot' }) });
  t.after(async () => { await connection.stop(); for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  let received;
  const messageReady = new Promise(resolve => { received = resolve; });
  await connection.start({ onMessage: msg => { messages.push(msg); received(); } });
  await Promise.race([Promise.all([heartbeat, messageReady]), new Promise((_, reject) => setTimeout(() => reject(new Error('WS did not deliver')), 2000).unref())]);
  assert.equal(params.get('token'), 'secret');
  assert.equal(params.get('client_id'), 'dsh');
  assert.equal(params.get('wxids'), 'bot');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, '9007199254740993');
  assert.equal((await connection.test()).ok, true);
  assert.ok(calls.some(call => call.path === '/bridge/accounts' && call.token === 'secret'));
  assert.ok(calls.some(call => call.path === '/proxy/bot/login/GetLoginStatus' && call.token === 'secret'));
  assert.equal(connection.status().receiveMode, 'websocket');
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
