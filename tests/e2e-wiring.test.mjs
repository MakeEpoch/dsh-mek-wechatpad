import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createPadConnection } from '../host/connections/pad.js';
import { resolveConfig } from '../host/config.js';
import { registerManagementRpc } from '../host/management-rpc.js';

test('OneBot WS: account isolation, HTTP probe, shared token and standard messages', async t => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push({ path: req.url, token: req.headers.authorization, body });
    const data = body.action === 'get_self_info' ? { user_id: 'bot', user_name: 'Bot', user_displayname: '' }
      : { good: true, bots: [{ self: { platform: 'wechat', user_id: 'bot' }, online: true }] };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', retcode: 0, data, message: '', echo: body.echo }));
  });
  const wss = new WebSocketServer({ server, path: '/' });
  const messages = []; let auth;
  wss.on('connection', (socket, req) => {
    auth = req.headers.authorization;
    setTimeout(() => {
      socket.send(JSON.stringify({ type: 'meta', detail_type: 'connect', id: 'connect', time: 1, sub_type: '', version: { impl: 'test', version: '1', onebot_version: '12' } }));
      for (const wxid of ['another-bot', 'bot']) socket.send(JSON.stringify({ id: 'event', time: 1, type: 'message', detail_type: 'private', sub_type: '',
        self: { platform: 'wechat', user_id: wxid }, message_id: '9007199254740993', user_id: 'peer', message: [{ type: 'text', data: { text: 'hello' } }], alt_message: 'hello' }));
    }, 20);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = createPadConnection({ config: resolveConfig({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'secret', wxid: 'bot' }) });
  t.after(async () => { await connection.stop(); for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  let received; const messageReady = new Promise(resolve => { received = resolve; });
  await connection.start({ onMessage: msg => { messages.push(msg); received(); } });
  await Promise.race([messageReady, new Promise((_, reject) => setTimeout(() => reject(new Error('WS did not deliver')), 2000).unref())]);
  assert.equal(auth, 'Bearer secret'); assert.equal(messages.length, 1); assert.equal(messages[0].messageId, '9007199254740993');
  assert.equal((await connection.test()).ok, true);
  assert.ok(calls.some(c => c.body.action === 'get_self_info' && c.token === 'Bearer secret'));
  assert.ok(calls.every(c => c.path === '/'));
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
