import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

import { registerManagementRpc, RPC_ENDPOINT, RPC_PATH } from '../host/management-rpc.js';
import { savePanelSettings, describeSettingsEntry, SettingsUnavailableError } from '../host/settings-bridge.js';
import { resolveConfig } from '../host/config.js';
import { bridgeAccounts, buildBridgeWsUrl, groupsFromBridgeLog, unwrapBridgeFrame } from '../host/bridge.js';
import { decodeMessage } from '../host/inbound.js';
import { HarnessBridge, extractAssistantText } from '../host/harness.js';
import { OutboundSender } from '../host/outbound.js';

/** A Settings service double that records writes and reports one revision. */
function fakeSettings() {
  const writes = [];
  return {
    writes,
    describe: () => [{ ns: 'wechatpad', revision: 4, secrets: [{ path: ['key'], set: true }] }],
    update: async (ns, patch, revision) => { writes.push({ kind: 'update', ns, patch, revision }); },
    replace: async (ns, section, revision) => { writes.push({ kind: 'replace', ns, section, revision }); },
  };
}

function fakeCtx(overrides = {}) {
  const settings = fakeSettings();
  const ctx = {
    fiber: { uid: 11 },
    get: (name) => {
      if (name === 'settings') return settings;
      if (name === 'configEditor') return { entries: () => [{ id: 'wechatpad', options: { name: '@dsh/wechatpad', config: {} }, fiber: { uid: 11 } }] };
      return undefined;
    },
    ...overrides,
  };
  return { ctx, settings };
}

/** A service double exposing what the RPC dispatcher may call. */
function fakeService(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    status: () => ({ phase: 'connected', label: '已连接', messagesIn: 1, messagesOut: 2 }),
    panelSettings: () => ({ settings: { baseUrl: 'http://127.0.0.1:8059', keyConfigured: true }, defaults: {}, revision: 4 }),
    updateSettings: async (patch, revision) => { calls.push({ method: 'update', patch, revision }); return { saved: true }; },
    resetSettings: async (revision) => { calls.push({ method: 'reset', revision }); return { saved: true }; },
    testConnection: async () => ({ ok: true, detail: 'ok' }),
    reconnect: async () => ({ phase: 'connected' }),
    renameConversationGroup: async (groupKey, name) => { calls.push({ method: 'renameGroup', groupKey, name }); return {items: [{groupKey, label: name}]}; },
    listSeenGroups: async () => ({ items: [{ chatId: '1@chatroom', count: 2, lastAt: 1, sample: 'hi' }] }),
    ...overrides,
  };
  return base;
}

test('management rpc: every method round-trips and unknown methods fail closed', async () => {
  const service = fakeService();
  let handler;
  const ctx = { connection: { fetch: { register: (route) => { handler = (message) => route.fetch(message); return () => {}; } } } };
  const dispose = await registerManagementRpc({ ctx, service });
  assert.equal(typeof dispose, 'function');
  const post = async (body) => {
    const response = await handler(new Request('http://127.0.0.1:3080/api/dsh-wechatpad', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const json = await response.json();
    return json.result;
  };

  const call = (method, payload = {}) => post({ type: 'client-request', rpcId: `r-${method}`, method: RPC_ENDPOINT, payload: { method, payload } });

  const status = await call('status.get');
  assert.equal(status.ok, true);
  assert.equal(status.value.phase, 'connected');

  const read = await call('settings.get');
  assert.equal(read.value.settings.key, undefined, 'the secret never crosses the wire');
  assert.equal(read.value.settings.keyConfigured, true);

  const update = await call('settings.update', { patch: { baseUrl: 'http://x' }, expectedRevision: 4 });
  assert.equal(update.value.saved, true);
  assert.deepEqual(service.calls.at(-1), { method: 'update', patch: { baseUrl: 'http://x' }, revision: 4 });

  const reset = await call('settings.reset', { expectedRevision: 4 });
  assert.equal(reset.value.saved, true);

  const test = await call('connection.test');
  assert.equal(test.value.ok, true);

  const groups = await call('groups.seen');
  assert.equal(groups.value.items[0].chatId, '1@chatroom');

  const renamed = await call('conversations.renameGroup', {groupKey:'pad-alice', name:'我的微信'});
  assert.equal(renamed.value.items[0].label, '我的微信');
  assert.deepEqual(service.calls.at(-1), {method:'renameGroup',groupKey:'pad-alice',name:'我的微信'});

  for (const method of ['bindings.list', 'bindings.clear']) {
    assert.equal((await call(method)).error.code, 'wechatpad/unknown-method');
  }

  const unknown = await call('system.exec');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'wechatpad/unknown-method');

  const thrown = fakeService({ status: () => { throw new Error('boom'); } });
  const ctx2 = { connection: { fetch: { register: (route) => { handler = (message) => route.fetch(message); return () => {}; } } } };
  await registerManagementRpc({ ctx: ctx2, service: thrown });
  const failure = await post({ type: 'client-request', rpcId: 'r-boom', method: RPC_ENDPOINT, payload: { method: 'status.get', payload: {} } });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.message, 'boom');
});

test('panel settings: writes validate, drop unknown fields, and respect the revision', async () => {
  const { ctx, settings } = fakeCtx();
  await savePanelSettings({ ctx, patch: { baseUrl: 'http://127.0.0.1:9000', bogus: 'nope', key: '   ' }, expectedRevision: 4 });
  assert.deepEqual(settings.writes.at(-1), { kind: 'update', ns: 'wechatpad', patch: { baseUrl: 'http://127.0.0.1:9000' }, revision: 4 });

  await savePanelSettings({ ctx, patch: { key: 'secret-value' }, expectedRevision: 4 });
  assert.equal(settings.writes.at(-1).patch.key, 'secret-value', 'a provided secret is written');

  await assert.rejects(() => savePanelSettings({ ctx, patch: {}, expectedRevision: 4 }), /没有可保存的字段/);
  await assert.rejects(() => savePanelSettings({ ctx, patch: null }), /没有收到任何设置/);
});

test('panel settings: a missing Settings service is a coded, explainable failure', async () => {
  const ctx = { fiber: { uid: 11 }, get: () => undefined };
  await assert.rejects(
    () => savePanelSettings({ ctx, patch: { baseUrl: 'http://x' } }),
    (error) => error instanceof SettingsUnavailableError && error.code === 'wechatpad/settings-unavailable',
  );
  assert.equal(describeSettingsEntry(ctx).readable, false);
});

test('harness bridge: prompts are named, queued, and carry the time zone', async () => {
  const invocations = [];
  const gateway = {
    invoke: async (request) => { invocations.push(request); return { accepted: true }; },
    stream: async () => [],
  };
  const peer = { id: 'peer-1', dispose: async () => {} };
  const bridge = new HarnessBridge({ gateway, peer, timeZone: 'Asia/Shanghai' });

  await bridge.prompt({ sessionId: 's1', text: '你好' });
  const prompt = invocations.at(-1);
  assert.equal(prompt.namespace, 'session');
  assert.equal(prompt.method, 'prompt');
  assert.equal(prompt.peer, peer);
  assert.equal(prompt.args.request.sessionId, 's1');
  assert.equal(prompt.args.request.mode, 'queue');
  assert.equal(prompt.args.request.clientTimeZone, 'Asia/Shanghai');
  assert.deepEqual(prompt.args.request.content, [{ type: 'text', text: '你好' }]);
  assert.match(prompt.args.request.requestId, /^[0-9a-f-]{36}$/);

  await bridge.prompt({ sessionId: 's1', text: '', images: [{ mediaType: 'image/png', data: 'AAA' }] });
  assert.deepEqual(invocations.at(-1).args.request.content, [{ type: 'image', mediaType: 'image/png', data: 'AAA' }]);
  await assert.rejects(() => bridge.prompt({ sessionId: 's1', text: '  ' }), /消息内容为空/);
});

test('harness bridge: session existence walks the list cursor', async () => {
  const pages = [
    { items: [{ sessionId: 'a' }], nextCursor: 'c1' },
    { items: [{ sessionId: 'b' }] },
  ];
  let index = 0;
  const gateway = { invoke: async (request) => {
    assert.equal(request.method, 'list');
    return pages[index++];
  } };
  const bridge = new HarnessBridge({ gateway, peer: {} });
  assert.equal(await bridge.sessionExists('b'), true);
  index = 0;
  assert.equal(await bridge.sessionExists('zzz'), false);
});

test('harness bridge: replies are folded from live session events, not follow', async () => {
  // `session/follow` only reads history up to the current cut; an answer produced
  // afterwards arrives through the Host's live `session/event`. Folding from the
  // follow stream is why replies used to be created but never delivered.
  let emit;
  const ctx = { on: (name, handler) => { if (name === 'session/event') emit = handler; return () => { emit = null; }; } };
  const gateway = { invoke: async () => ({}), stream: async () => [] };
  const bridge = new HarnessBridge({ gateway, peer: {}, ctx });

  const answers = [];
  const progress = [];
  const errors = [];
  const handle = bridge.follow({
    sessionId: 's1',
    onText: (text) => answers.push(text),
    onProgress: (info) => progress.push(info.tool),
    onError: (error) => errors.push(error.message),
  });

  const session = { id: 's1' };
  emit(session, {
    type: 'assistant/message', seq: 4,
    data: { message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '答案' }] } },
  });
  emit(session, { type: 'tool/call', seq: 5, data: { name: 'bash' } });
  // Another session's traffic must not leak into this chat.
  emit({ id: 'other' }, { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: '别人的' }] } } });
  emit(session, { type: 'turn/error', seq: 7, data: { message: 'boom' } });

  assert.deepEqual(answers, ['答案']);
  assert.deepEqual(progress, ['bash']);
  assert.deepEqual(errors, ['boom']);

  // Stopping removes only this chat's listener.
  handle.stop();
  emit(session, { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: '后续' }] } } });
  assert.deepEqual(answers, ['答案']);

  bridge.dispose();
  assert.equal(emit, null, 'teardown drops the Host subscription');
});

test('harness bridge: scoped events reach the global observer and stop on teardown', async () => {
  const ctx = new Context();
  const bridge = new HarnessBridge({ gateway: {}, peer: {}, ctx });
  const answers = [];
  bridge.follow({ sessionId: 'ours', onText: (text) => answers.push(text) });
  const carrier = { [Context.filter]: () => false };
  const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }] } } };
  await ctx.emit(carrier, 'session/event', { id: 'ours' }, event);
  await ctx.emit(carrier, 'session/event', { id: 'other' }, event);
  assert.deepEqual(answers, ['reply']);
  bridge.dispose();
  await ctx.emit(carrier, 'session/event', { id: 'ours' }, event);
  assert.deepEqual(answers, ['reply']);
});

test('outbound: one reply is chunked, spaced, and ordered per chat', async () => {
  const sent = [];
  const client = {
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, messageId: String(sent.length) }; },
  };
  const sender = new OutboundSender({ client });
  // Two chunks only: the 1.1s inter-message spacing is real behaviour, not a
  // test artifact, so keep this case short.
  const longReply = `${'甲'.repeat(150)}。`;
  const result = await sender.sendReply('wxid_a', longReply, { maxChunkLength: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, 2);
  for (const message of sent) {
    assert.equal(message.chatId, 'wxid_a');
    assert.ok(message.text.length <= 100);
  }
  assert.equal(sent.map((m) => m.text).join('').replace(/\s/g, ''), longReply);
});

test('outbound: a failed send reports the error instead of pretending success', async () => {
  const client = { sendText: async () => ({ ok: false, error: 'unauthorized' }) };
  const sender = new OutboundSender({ client });
  const result = await sender.sendReply('wxid_a', 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.delivered, 0);
  assert.equal(result.error, 'unauthorized');
});

test('config resolution is what the panel and runtime both read', () => {
  const resolved = resolveConfig({ baseUrl: 'http://127.0.0.1:8059', receiveMode: 'webhook', webhookPath: 'cb' });
  assert.equal(resolved.webhookPath, '/cb');
  assert.equal(resolved.receiveMode, 'webhook');
  assert.equal(resolved.messageMergeDelaySeconds, 0);
  assert.equal(resolved.incomingMessageMode, 'queue');
  assert.equal(resolveConfig({ messageMergeDelaySeconds: 2.5, incomingMessageMode: 'interrupt' }).messageMergeDelaySeconds, 2.5);
  assert.equal(resolveConfig({ messageMergeDelaySeconds: -1 }).messageMergeDelaySeconds, 0);
  assert.equal(resolveConfig({ messageMergeDelaySeconds: 99 }).messageMergeDelaySeconds, 30);
  assert.equal(resolveConfig({ incomingMessageMode: 'unknown' }).incomingMessageMode, 'queue');
});

test('host entry: accepts the parsed Config dsh actually passes and mounts routes', async () => {
  const registered = { routes: [], upgrades: [], rpc: [], effects: [] };
  let managementRoute;
  const ctx = {
    fiber: { uid: 7 },
    on: () => () => {},
    logger: () => () => {},
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); registered.effects.push(dispose); return dispose; },
    webServer: {
      register: (route) => { registered.routes.push(route.path); return () => {}; },
      registerUpgrade: (route) => { registered.upgrades.push(route.path); return () => {}; },
      getOrigin: () => 'http://127.0.0.1:3080',
    },
    connection: {
      requestRejection: () => undefined,
      createPeer: () => ({ dispose: async () => {} }),
      fetch: { register: (route) => { managementRoute = route; registered.rpc.push(route.path); return () => {}; } },
    },
    typertGateway: { invoke: async () => ({}), stream: async () => [] },
  };
  // The Loader hands `apply` the *parsed* Config, whose volatile fields are
  // references; re-parsing it throws, and reading it without `.get()` produced a
  // "/[object Object]" route path. Both regressions must stay fixed.
  const { apply, Config } = await import('../host/index.js');
  apply(ctx, Config({ key: 'fake-key', baseUrl: 'http://127.0.0.1:8059', receiveMode: 'webhook' }));
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.deepEqual(registered.routes, ['/wechatpad/callback']);
  assert.deepEqual(registered.upgrades, ['/dsh-wechatpad/ws']);
  assert.deepEqual(registered.rpc, ['/api/dsh-wechatpad']);
  // Exercise the real entry -> PanelFacade -> service -> catalog path. A
  // dispatcher-only service double cannot catch a missing facade method.
  const { conversationCatalogFor } = await import('../host/conversations.js');
  const catalog = conversationCatalogFor(ctx);
  await catalog.register('host-entry-rename', { provider: 'pad', chatId: 'host-entry-peer' });
  const groupKey = (await catalog.list()).items.find(row => row.sessionId === 'host-entry-rename').groupKey;
  const response = await managementRoute.fetch(new Request('http://127.0.0.1:3080/api/dsh-wechatpad', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'entry-rename', method: RPC_ENDPOINT,
      payload: { method: 'conversations.renameGroup', payload: { groupKey, name: '入口改名验证' } } }),
  }));
  const { result } = await response.json();
  assert.equal(result.ok, true, result.error?.message);
  assert.equal((await catalog.list()).items.find(row => row.groupKey === groupKey).label, '入口改名验证');
  for (const dispose of registered.effects) if (typeof dispose === 'function') await dispose();
});

test('push transport reports connection state so the panel is not stuck on idle', async () => {
  const { PushTransport } = await import('../host/transport.js');
  const states = [];
  let emit;
  const transport = new PushTransport({
    url: 'ws://pad',
    open: async () => ({
      on: (event, handler) => { if (event === 'message') emit = handler; },
      close: () => {},
      ping: () => {},
    }),
    onFrame: () => {},
    onState: (state, detail) => states.push(detail === undefined ? state : `${state}:${detail}`),
  });
  await transport.start();
  assert.deepEqual(states, ['open'], 'a successful connect must be observable, not only logged');
  transport.stop();
});

test('bridge subscription: URL carries token, client_id, and the subscribed wxids', () => {
  const url = new URL(buildBridgeWsUrl({
    baseUrl: 'http://127.0.0.1:8002/',
    token: 'tok-123',
    accounts: ['user_example', 'wxid_b'],
    clientId: 'dsh',
  }));
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.pathname, '/ws/outbound');
  assert.equal(url.searchParams.get('token'), 'tok-123');
  assert.equal(url.searchParams.get('client_id'), 'dsh');
  assert.equal(url.searchParams.get('wxids'), 'user_example,wxid_b');

  const secure = new URL(buildBridgeWsUrl({ baseUrl: 'https://bridge.example', token: 't', accounts: ['a'] }));
  assert.equal(secure.protocol, 'wss:');

  assert.throws(() => buildBridgeWsUrl({ baseUrl: 'http://x', token: 't', accounts: [] }), /wxid/);
  assert.throws(() => buildBridgeWsUrl({ baseUrl: 'http://x', token: '', accounts: ['a'] }), /token/);
});

test('bridge subscription: the frame envelope unwraps to a plain Pad payload', () => {
  const message = { from_user_name: { str: 'user_example' }, msg_type: 1, content: { str: '你好' }, new_msg_id: 'm1' };
  assert.deepEqual(unwrapBridgeFrame({ type: 'message', wxid: 'user_example', message }), { wxid: 'user_example', message });
  assert.deepEqual(unwrapBridgeFrame({ type: 'ping' }), { control: 'ping' });
  assert.deepEqual(unwrapBridgeFrame({ type: 'pong' }), { control: 'pong' });
  assert.deepEqual(unwrapBridgeFrame({ type: 'error', message: 'bad token' }), { control: 'error', detail: 'bad token' });
  // A bare payload without the Bridge envelope still decodes.
  assert.deepEqual(unwrapBridgeFrame(message), { wxid: '', message });
  assert.equal(unwrapBridgeFrame(null), null);

  // End to end: an unwrapped frame decodes like a direct Pad push.
  const decoded = decodeMessage(message);
  assert.equal(decoded.senderId, 'user_example');
  assert.equal(decoded.text, '你好');
});

test('bridge subscription: accounts come from config, falling back to the bot wxid', () => {
  assert.deepEqual(bridgeAccounts({ bridgeAccounts: 'a, b', selfWxid: 'x' }), ['a', 'b']);
  assert.deepEqual(bridgeAccounts({ bridgeAccounts: '', selfWxid: 'wxid_bot' }), ['wxid_bot']);
  assert.deepEqual(bridgeAccounts({ bridgeAccounts: '', selfWxid: '' }), []);
});

test('bridge log parser: only the requested account contributes groups', () => {
  // The Bridge log is shared by every bot it serves, and each line names the
  // account it belongs to. Parsing without that filter reported another bot's
  // groups as if they were ours.
  const log = [
    '2026-10-20 05:00:00,000 [INFO] [BRIDGE-INBOUND] received wxid=user_example msg_id=1 payload={"from_user_name":{"str":"111@chatroom"},"content":{"str":"other bot"}}',
    '2026-10-20 06:00:00,000 [INFO] [BRIDGE-INBOUND] received wxid=wxid_fixture_bot msg_id=2 payload={"from_user_name":{"str":"222@chatroom"},"content":{"str":"ours"}}',
  ].join('\n');
  assert.deepEqual(groupsFromBridgeLog(log, { accounts: ['wxid_fixture_bot'] }).map((r) => r.chatId), ['222@chatroom']);
  assert.deepEqual(groupsFromBridgeLog(log, { accounts: ['user_example'] }).map((r) => r.chatId), ['111@chatroom']);
  // No account filter means nothing may be attributed to this plugin.
  assert.deepEqual(groupsFromBridgeLog(log, {}), []);
  assert.deepEqual(groupsFromBridgeLog(log, { accounts: [] }), []);
});

test('harness bridge: a truncated session listing is unknown rather than confirmed deletion', async () => {
  const bridge = new HarnessBridge({gateway:{invoke:async()=>({items:[],nextCursor:'more'})},peer:{}});
  await assert.rejects(bridge.sessionExists('existing'), /分页未读取完/);
});
