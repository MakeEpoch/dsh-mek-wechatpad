import { mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import test, { describe } from 'node:test';
import {
  CONNECTION_IDS, DEFAULT_CAPABILITIES, DEFAULT_PROVIDER, OPTIONAL_MEMBERS, REQUIRED_MEMBERS,
  assertConnection, createConnection, isConnection, normalizeCapabilities, resolveProvider, safeSend,
  unavailableConnection, unsupportedFeature,
} from '../host/connections/index.js';
import {
  OPTIONAL_MEMBERS as TYPES_OPTIONAL, REQUIRED_MEMBERS as TYPES_REQUIRED,
} from '../host/connections/types.js';
import { resolveConfig } from '../host/config.js';

describe('connection contracts', async () => {
/**
 * Connection contract tests.
 *
 * These pin the seam between the service and whichever protocol it speaks:
 * selection, the fail-closed path when an adapter cannot load, the shape every
 * adapter must expose, and the minimal message -> prompt -> reply -> send loop
 * driven by a fake connection. No real socket, no real Pad, no iLink adapter
 * file: the adapter under test is built inside this file, so it stays valid
 * whether or not `host/connections/weixin.js` exists yet.
 */
let isolatedHome;
let previousTestHome;
test.beforeEach(async () => {
  previousTestHome = process.env.DSH_HOME;
  isolatedHome = await mkdtemp('/tmp/wxp-route-test-');
  process.env.DSH_HOME = isolatedHome;
});
test.afterEach(async () => {
  if (previousTestHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousTestHome;
  await rm(isolatedHome, {recursive:true,force:true});
});



/** A protocol-neutral connection double: records calls, obeys the contract. */
function fakeConnection({ id = 'pad', capabilities = {}, fail = null } = {}) {
  const calls = [];
  let handlers = null;
  const connection = {
    id,
    label: id === 'weixin' ? '微信机器人' : 'WechatPad',
    calls,
    capabilities: normalizeCapabilities(capabilities),
    async start(next) {
      calls.push({ method: 'start' });
      handlers = next;
      if (fail) {
        next?.onState?.({ phase: 'error', error: fail });
        throw new Error(fail);
      }
      next?.onState?.({ phase: 'connected' });
    },
    async stop() {
      calls.push({ method: 'stop' });
    },
    async send({ chatId, text, contextToken, runId }) {
      calls.push({ method: 'send', chatId, text, contextToken, runId });
      return { ok: true, delivered: 1, messageId: `m-${calls.length}` };
    },
    async test() {
      calls.push({ method: 'test' });
      return { ok: true, detail: `${id} ok` };
    },
    status() {
      return { provider: id, connected: true, lastError: '', capabilities: { ...connection.capabilities } };
    },
    /** Test-only: push one already-normalized message up to the service. */
    emit(message) {
      return handlers?.onMessage?.(message);
    },
    emitState(state) {
      return handlers?.onState?.(state);
    },
  };
  return connection;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate, label = 'condition') {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── 契约形状 ────────────────────────────────────────────────────────────────

test('contract: the required member list is enforced and optional ones are documented', () => {
  assert.deepEqual(REQUIRED_MEMBERS, ['id', 'label', 'start', 'stop', 'send', 'test', 'capabilities']);
  assert.deepEqual([...OPTIONAL_MEMBERS].sort(), [
    'beginLogin', 'cancelLogin', 'pollLogin', 'resetAccount', 'sendFile', 'status', 'typing',
  ]);
  // Both entry points must advertise the same lists; a caller that imports the
  // contract from types.js and one that imports the selector may not disagree.
  assert.deepEqual(TYPES_REQUIRED, REQUIRED_MEMBERS);
  assert.deepEqual(TYPES_OPTIONAL, OPTIONAL_MEMBERS);
  assert.deepEqual([...CONNECTION_IDS], ['pad', 'weixin']);
  assert.equal(DEFAULT_PROVIDER, 'pad');
});

test('contract: a fake connection passes validation and a partial one names what is missing', () => {
  assert.equal(isConnection(fakeConnection()), true);
  assert.equal(isConnection(null), false);
  assert.equal(isConnection({ id: 'pad' }), false);
  assert.throws(() => assertConnection({ id: 'pad', label: 'x' }, '测试连接'), /不符合 Connection 契约.*start/);
  assert.throws(() => assertConnection({ ...fakeConnection(), id: 'telegram' }), /id 必须是 pad \| weixin/);
  assert.equal(assertConnection(fakeConnection()).id, 'pad');
});

test('contract: capabilities always normalize to the four known booleans', () => {
  assert.deepEqual(normalizeCapabilities(), DEFAULT_CAPABILITIES);
  assert.deepEqual(normalizeCapabilities({ typing: 1, media: 'yes' }), {
    typing: true, media: true, groupMention: false, nativeReply: false,
  });
  assert.deepEqual(DEFAULT_CAPABILITIES, {
    typing: false, media: false, groupMention: false, nativeReply: false,
  });
  // The returned record is a fresh object, so a caller cannot poison the default.
  const normalized = normalizeCapabilities();
  normalized.typing = true;
  assert.equal(DEFAULT_CAPABILITIES.typing, false);
});

test('contract: safeSend never throws and normalizes every failure shape', async () => {
  const ok = fakeConnection();
  assert.deepEqual(await safeSend(ok, { chatId: 'c', text: 'hi' }), { ok: true, delivered: 1, messageId: 'm-1' });

  assert.deepEqual(await safeSend(null, { chatId: 'c', text: 'hi' }),
    { ok: false, delivered: 0, error: '连接尚未就绪' });
  assert.deepEqual(await safeSend(ok, { chatId: '', text: 'hi' }), { ok: false, delivered: 0, error: '缺少 chatId' });
  assert.deepEqual(await safeSend(ok, { chatId: 'c', text: '' }), { ok: false, delivered: 0, error: 'empty reply' });

  const throwing = { async send() { throw new Error('socket gone'); } };
  assert.deepEqual(await safeSend(throwing, { chatId: 'c', text: 'hi' }),
    { ok: false, delivered: 0, error: 'socket gone' });

  const rubbish = { async send() { return null; } };
  assert.deepEqual(await safeSend(rubbish, { chatId: 'c', text: 'hi' }),
    { ok: false, delivered: 0, error: '连接未返回发送结果' });

  const refused = { async send() { return { ok: false, error: 'unauthorized' }; } };
  assert.deepEqual(await safeSend(refused, { chatId: 'c', text: 'hi' }),
    { ok: false, delivered: 0, error: 'unauthorized' });
});

// ── 选择逻辑 ────────────────────────────────────────────────────────────────

test('selection: provider defaults to pad for a legacy profile', async () => {
  assert.equal(resolveProvider({}), 'pad');
  assert.equal(resolveProvider({ provider: '' }), 'pad');
  assert.equal(resolveProvider({ provider: ' WEIXIN ' }), 'weixin');
  assert.equal(resolveProvider(undefined), 'pad');

  const connection = await createConnection(resolveConfig({ baseUrl: 'http://127.0.0.1:8059', key: 'k' }));
  assert.equal(connection.id, 'pad');
  assert.equal(connection.label, 'WechatPad');
  assert.equal(isConnection(connection), true);
});

test('selection: pad adapter declares the pad capabilities and fixed protocol facts', async () => {
  const connection = await createConnection(resolveConfig({ receiveMode: 'webhook', key: 'k' }));
  assert.deepEqual(connection.capabilities, { ...DEFAULT_CAPABILITIES, media: true });
  // The Pad cannot show typing, cannot bind by QR, and reports "unsupported".
  assert.equal(await connection.typing('wxid_a', true), false);
  for (const method of ['beginLogin', 'pollLogin', 'cancelLogin', 'resetAccount']) {
    const result = await connection[method]();
    assert.equal(result.supported, false, `${method} must report unsupported`);
    assert.equal(typeof result.detail, 'string');
  }
  const status = connection.status();
  assert.equal(status.provider, 'pad');
  assert.deepEqual(status.capabilities, { ...DEFAULT_CAPABILITIES, media: true });
  assert.equal(status.connected, false, 'not started yet');
});

test('selection: weixin is loaded through the injected importer', async () => {
  const seen = [];
  const fake = fakeConnection({ id: 'weixin', capabilities: { typing: true, nativeReply: true } });
  const connection = await createConnection({ provider: 'weixin' }, {
    load: async (spec) => { seen.push(spec); return { createWeixinConnection: () => fake }; },
  });
  assert.deepEqual(seen, [{ module: './weixin.js', export: 'createWeixinConnection' }]);
  assert.equal(connection.id, 'weixin');
  assert.equal(connection.capabilities.typing, true);
  assert.equal(isConnection(connection), true, 'the loaded adapter is validated, not trusted');
});

test('selection: an unknown provider degrades instead of throwing', async () => {
  const connection = await createConnection({ provider: 'telegram' });
  assert.equal(isConnection(connection), true, 'the fallback still satisfies the contract');
  assert.equal(connection.unavailable, true);
  assert.match(connection.status().lastError, /未知的 provider/);
  assert.equal(connection.status().connected, false);

  // It must be usable by the service: start reports the failure, send refuses.
  const states = [];
  await connection.start({ onState: (state) => states.push(state) });
  assert.equal(states[0].phase, 'error');
  const sent = await connection.send({ chatId: 'c', text: 'hi' });
  assert.equal(sent.ok, false);
  assert.match(sent.error, /连接适配器加载失败/);
  assert.equal((await connection.test()).ok, false);
  assert.equal(await connection.typing('c', true), false);
  assert.equal((await connection.beginLogin()).supported, false);
});

test('selection: a weixin adapter that fails to import degrades and never throws', async () => {
  const logged = [];
  const connection = await createConnection({ provider: 'weixin' }, {
    logger: (level, message) => logged.push(`${level}:${message}`),
    load: async () => { throw new Error('Cannot find module ./weixin.js'); },
  });
  assert.equal(isConnection(connection), true);
  assert.equal(connection.unavailable, true);
  // The concrete import failure reaches the panel's status verbatim.
  assert.match(connection.status().lastError, /Cannot find module/);
  assert.ok(logged.some((line) => line.startsWith('error:')), 'the loader failure is logged, not swallowed');
});

test('selection: an adapter module without the expected export degrades', async () => {
  const connection = await createConnection({ provider: 'weixin' }, {
    load: async () => ({ somethingElse: () => fakeConnection({ id: 'weixin' }) }),
  });
  assert.equal(connection.unavailable, true);
  assert.match(connection.status().lastError, /未导出 createWeixinConnection/);
});

test('selection: an adapter whose factory returns rubbish degrades via assertConnection', async () => {
  const connection = await createConnection({ provider: 'weixin' }, {
    load: async () => ({ createWeixinConnection: () => ({ id: 'weixin', label: 'broken' }) }),
  });
  assert.equal(connection.unavailable, true);
  assert.match(connection.status().lastError, /不符合 Connection 契约/);
});

test('selection: an adapter whose factory throws degrades', async () => {
  const connection = await createConnection({ provider: 'weixin' }, {
    load: async () => ({ createWeixinConnection: () => { throw new Error('缺失 bot token'); } }),
  });
  assert.equal(connection.unavailable, true);
  assert.match(connection.status().lastError, /缺失 bot token/);
});

test('selection: unavailableConnection exposes a full, inert contract', async () => {
  const connection = unavailableConnection('weixin', '模块缺失');
  assert.equal(isConnection(connection), true);
  assert.equal(connection.id, 'weixin');
  assert.match(connection.label, /不可用/);
  assert.deepEqual(connection.status(), {
    provider: 'weixin',
    connected: false,
    lastError: '模块缺失',
    unavailable: true,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await connection.stop();
  assert.deepEqual(await connection.send({ chatId: 'c', text: 't' }), {
    ok: false, delivered: 0, error: '连接适配器加载失败：模块缺失',
  });
  assert.deepEqual(unsupportedFeature('不行'), { supported: false, detail: '不行' });
});

// ── service 最小链路 ────────────────────────────────────────────────────────

/** The smallest dsh context the service actually touches. */
function fakeCtx() {
  const events = new Context();
  const prompts = [];
  const created = [];
  const ctx = {
    on: events.on.bind(events),
    get: () => undefined,
    connection: { createPeer: () => ({ dispose: async () => {} }) },
    webServer: {
      register: () => () => {},
      registerUpgrade: () => () => {},
      getOrigin: () => 'http://127.0.0.1:3080',
    },
    typertGateway: {
      invoke: async ({ method, args }) => {
        if (method === 'create') {
          const sessionId = `s${created.length + 1}`;
          created.push(sessionId);
          return { sessionId };
        }
        if (method === 'list') return { items: created.map((sessionId) => ({ sessionId })) };
        if (method !== 'prompt') return {};
        prompts.push(args.request);
        const session = { id: args.request.sessionId };
        await events.emit('session/event', session, { type: 'turn/start', data:{turn:prompts.length} });
        await events.emit('session/event', session, {type:'user/message',data:{source:{kind:'user',rpcId:args.request.requestId}}});
        await events.emit('session/event', session, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'reply-from-model' }] } },
        });
        await events.emit('session/event', session, {type:'turn/end',data:{turn:prompts.length}});
        return { accepted: true };
      },
    },
  };
  return { ctx, prompts };
}

/** A service whose protocol is the supplied double, via the documented seam. */
async function serviceWith(t, connection, config = {}) {
  const { WechatPadService } = await import('../host/wechatpad-service.js');
  const { ctx, prompts } = fakeCtx();
  const service = new WechatPadService({
    ctx,
    config: {
      baseUrl: 'http://127.0.0.1:8059',
      key: 'test-key',
      receiveMode: 'websocket',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      messageMergeDelaySeconds: 0,
      showProgress: false,
      maxReplyChunkLength: 500,
      ...config,
    },
    createConnection: async () => connection,
  });
  t.after(async () => { await service.dispose(); });
  await service.start();
  return { service, prompts };
}

test('service: the injected connection is the only transport it uses', async (t) => {
  const connection = fakeConnection();
  const { service } = await serviceWith(t, connection);
  assert.equal(connection.calls[0].method, 'start', 'the service starts the connection it was given');
  assert.equal(service.status().provider, 'pad');
  assert.equal(service.status().connected, true);
});

test('service: a message flows receive -> prompt -> model reply -> send', async (t) => {
  const connection = fakeConnection({ id: 'weixin', capabilities: { typing: true } });
  const { service, prompts } = await serviceWith(t, connection, { provider: 'weixin' });

  const status = service.status();
  assert.equal(status.provider, 'weixin');
  assert.equal(status.providerId, 'weixin');
  assert.deepEqual(status.capabilities, {
    typing: true, media: false, groupMention: false, nativeReply: false,
  });
  // Legacy Pad-shaped fields stay present for an older panel build.
  assert.equal(status.receiveMode, 'websocket');
  assert.equal(status.baseUrl, 'http://127.0.0.1:8059');
  assert.equal(typeof status.webhookUrl, 'string');
  assert.equal(status.keyConfigured, true);
  assert.equal(status.phase, 'connected');
  // The adapter's own status is forwarded verbatim so a protocol-specific field
  // (a bound bot id, a QR state) reaches the panel.
  assert.equal(status.providerStatus.provider, 'weixin');
  assert.deepEqual(status.providerStatus.capabilities, status.capabilities);

  await connection.emit({
    messageId: 'im-1',
    chatId: 'wxid_peer',
    isGroup: false,
    senderId: 'wxid_peer',
    text: '你好',
    msgType: 1,
    mentioned: false,
    createdAt: Date.now(),
  });
  await until(() => prompts.length === 1, 'the prompt to be admitted');
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: '你好' }]);

  await until(() => connection.calls.some((call) => call.method === 'send'), 'the reply send');
  const sends = connection.calls.filter((call) => call.method === 'send');
  assert.equal(sends[0].chatId, 'wxid_peer');
  assert.match(sends[0].text, /reply-from-model/, 'the model text is what gets delivered');
  assert.equal(service.status().messagesIn, 1);
  await until(() => service.status().messagesOut >= 1, 'the outbound counter');
});

test('service: the policy still runs in front of the connection', async (t) => {
  const connection = fakeConnection();
  const { service, prompts } = await serviceWith(t, connection, {
    dmPolicy: 'allowlist',
    allowedUsers: ['wxid_allowed'],
  });
  await connection.emit({
    messageId: 'im-2', chatId: 'wxid_stranger', isGroup: false, senderId: 'wxid_stranger',
    text: 'let me in', msgType: 1, mentioned: false, createdAt: Date.now(),
  });
  await flush();
  assert.deepEqual(prompts, [], 'a stranger must never reach the model');
  assert.equal(service.status().messagesReceived, 1);
  assert.equal(service.status().messagesIgnored, 1);
  assert.deepEqual({ reason: service.status().lastIgnored.reason, senderId: service.status().lastIgnored.senderId }, { reason: 'dm-not-allowed', senderId: 'wxid_stranger' });
  assert.equal(service.status().messagesIn, 0);
  // The same message from an allowed sender does get through.
  await connection.emit({
    messageId: 'im-3', chatId: 'wxid_allowed', isGroup: false, senderId: 'wxid_allowed',
    text: 'hello', msgType: 1, mentioned: false, createdAt: Date.now(),
  });
  await until(() => prompts.length === 1, 'the allowed prompt');
});

test('service: a dead connection still leaves a renderable status and a settings panel', async (t) => {
  const dead = unavailableConnection('weixin', 'Cannot find module ./weixin.js');
  const { service } = await serviceWith(t, dead, { provider: 'weixin' });
  const status = service.status();
  assert.equal(status.phase, 'error');
  assert.match(status.lastError, /连接适配器加载失败/);
  assert.equal(status.provider, 'weixin');
  assert.equal(status.connected, false);
  // The panel's operations must answer rather than throw.
  const probe = await service.testConnection();
  assert.equal(probe.ok, false);
  assert.match(probe.error, /Cannot find module/);
  assert.equal(await service.typing('wxid_a', true), false);
  assert.equal((await service.beginLogin()).supported, false);
  assert.equal((await service.pollLogin('a1')).supported, false);
  assert.equal((await service.cancelLogin('a1')).supported, false);
  assert.equal((await service.resetAccount()).supported, false);
  // And teardown is clean.
  await service.dispose();
});

test('service: typing is forwarded to a protocol that implements it', async (t) => {
  const connection = fakeConnection({ id: 'weixin', capabilities: { typing: true } });
  const typing = [];
  connection.typing = async (chatId, on) => { typing.push([chatId, on]); return true; };
  const { service } = await serviceWith(t, connection, { provider: 'weixin' });
  assert.equal(await service.typing('wxid_a', true), true);
  assert.equal(await service.typing('wxid_a', false), true);
  assert.deepEqual(typing, [['wxid_a', true], ['wxid_a', false]]);
});

test('service: lifecycle hooks reach the adapter and its answer is returned as-is', async (t) => {
  const connection = fakeConnection({ id: 'weixin' });
  connection.beginLogin = async () => ({ supported: true, attemptId: 'att-1', qrUrl: 'https://qr.example/x' });
  connection.pollLogin = async (attemptId) => ({ supported: true, state: 'confirmed', account: { wxid: 'bot' }, attemptId });
  connection.cancelLogin = async (attemptId) => ({ supported: true, cancelled: true, attemptId });
  connection.resetAccount = async () => ({ supported: true, ok: true });
  const { service } = await serviceWith(t, connection, { provider: 'weixin' });

  assert.deepEqual(await service.beginLogin(), { supported: true, attemptId: 'att-1', qrUrl: 'https://qr.example/x' });
  assert.deepEqual(await service.pollLogin('att-1'), {
    supported: true, state: 'confirmed', account: { wxid: 'bot' }, attemptId: 'att-1',
  });
  assert.deepEqual(await service.cancelLogin('att-1'), { supported: true, cancelled: true, attemptId: 'att-1' });
  assert.deepEqual(await service.resetAccount(), { supported: true, ok: true });
});

test('service: a throwing lifecycle hook is reported, never propagated', async (t) => {
  const connection = fakeConnection({ id: 'weixin' });
  connection.beginLogin = async () => { throw new Error('iLink 不可达'); };
  connection.resetAccount = async () => { throw new Error('账号状态损坏'); };
  const { service } = await serviceWith(t, connection, { provider: 'weixin' });
  assert.deepEqual(await service.beginLogin(), { supported: false, error: 'iLink 不可达' });
  assert.deepEqual(await service.resetAccount(), { supported: false, error: '账号状态损坏' });
});

test('service: a send failure is logged and does not kill the turn loop', async (t) => {
  const connection = fakeConnection({ id: 'weixin' });
  connection.send = async () => ({ ok: false, delivered: 0, error: 'context_token 过期' });
  const { service, prompts } = await serviceWith(t, connection, { provider: 'weixin' });
  await connection.emit({
    messageId: 'im-9', chatId: 'wxid_peer', isGroup: false, senderId: 'wxid_peer',
    text: 'hi', msgType: 1, mentioned: false, createdAt: Date.now(),
  });
  await until(() => prompts.length === 1, 'the prompt to be admitted');
  await until(() => service.status().phase === 'error', 'the send failure to surface');
  assert.match(service.status().lastError, /context_token 过期/);
  assert.equal(service.status().messagesOut, 0, 'a failed send is not counted as delivered');
});

test('service: connection state updates drive the panel phase', async (t) => {
  const connection = fakeConnection();
  const { service } = await serviceWith(t, connection);
  assert.equal(service.status().phase, 'connected');
  connection.emitState({ phase: 'reconnecting', label: '重连中' });
  assert.equal(service.status().phase, 'reconnecting');
  connection.emitState({ phase: 'error', error: '推送已断开' });
  assert.equal(service.status().phase, 'error');
  assert.match(service.status().lastError, /推送已断开/);
  connection.emitState({ phase: 'connected' });
  assert.equal(service.status().phase, 'connected');
  assert.equal(service.status().lastError, '');
});

test('service: an unconfigured profile keeps its own phase, not a connection error', async (t) => {
  const connection = fakeConnection();
  connection.start = async (handlers) => {
    handlers.onState({ phase: 'unconfigured', error: '缺少扫码绑定' });
  };
  const { service } = await serviceWith(t, connection, { provider: 'weixin' });
  assert.equal(service.status().phase, 'unconfigured');
  assert.match(service.status().lastError, /缺少扫码绑定/);
});

test('service: a connection that throws on start() leaves the service alive', async (t) => {
  const connection = fakeConnection();
  connection.start = async () => { throw new Error('boom'); };
  const { service } = await serviceWith(t, connection);
  assert.equal(service.status().phase, 'error');
  assert.match(service.status().lastError, /boom/);
  // The panel is the recovery path, so it must still answer.
  assert.equal(typeof service.panelSettings, 'function');
  assert.doesNotThrow(() => service.panelSettings());
});

test('coexistence: both protocols receive the same chat/message id without sharing sessions or replies', async (t) => {
  const { WechatPadService } = await import('../host/wechatpad-service.js');
  const { ctx, prompts } = fakeCtx();
  const connections = { pad: fakeConnection(), weixin: fakeConnection({ id: 'weixin' }) };
  const service = new WechatPadService({ ctx, config: {
    provider: 'pad', enabledProviders: ['pad', 'weixin'], key: 'fake-key', dmPolicy: 'open', showProgress: false,
  }, createConnection: async (config) => connections[config.provider] });
  t.after(() => service.dispose());
  await service.start();
  assert.equal(service.status().connections.pad.connected, true);
  assert.equal(service.status().connections.weixin.connected, true);
  const message = { messageId: 'identical-id', chatId: 'same-peer', senderId: 'same-peer', text: 'hello', isGroup: false, createdAt: Date.now() };
  await Promise.all([connections.pad.emit(message), connections.weixin.emit(message)]);
  await until(() => prompts.length === 2);
  assert.notEqual(prompts[0].sessionId, prompts[1].sessionId);
  await until(() => Object.values(connections).every((connection) => connection.calls.some((call) => call.method === 'send')));
  assert.equal(connections.pad.calls.filter((call) => call.method === 'send').length, 1);
  assert.equal(connections.weixin.calls.filter((call) => call.method === 'send').length, 1);
  const botStarts = connections.weixin.calls.filter((call) => call.method === 'start').length;
  await service.reconnect('pad');
  assert.equal(connections.weixin.calls.filter((call) => call.method === 'stop').length, 0);
  assert.equal(connections.weixin.calls.filter((call) => call.method === 'start').length, botStarts);
  connections.pad.emitState({ phase: 'error', error: 'Pad disconnected' });
  assert.equal(service.status().connections.pad.phase, 'error');
  assert.equal(service.status().connections.weixin.phase, 'connected');
  await service.testConnection('weixin');
  assert.equal(connections.pad.calls.filter((call) => call.method === 'test').length, 0);
  assert.equal(connections.weixin.calls.filter((call) => call.method === 'test').length, 1);
});

test('coexistence: legacy configs keep their channel, an explicit empty list closes both', async (t) => {
  const { Config } = await import('../host/config.js');
  assert.deepEqual(resolveConfig(Config({})).enabledProviders, ['pad']);
  assert.deepEqual(resolveConfig(Config({ provider: 'weixin' })).enabledProviders, ['weixin']);
  assert.deepEqual(resolveConfig(Config({ enabledProviders: [] })).enabledProviders, []);
  const { WechatPadService } = await import('../host/wechatpad-service.js');
  const { ctx } = fakeCtx(); let created = 0;
  const service = new WechatPadService({ ctx, config: { enabledProviders: [] }, createConnection: async () => { created++; return fakeConnection(); } });
  t.after(() => service.dispose()); await service.start();
  assert.equal(created, 0); assert.equal(service.status().connections.pad.phase, 'disabled');
});

test('live settings: enabling and disabling iLink applies without plugin remount or Pad reconnect', async (t) => {
  const { WechatPadService } = await import('../host/wechatpad-service.js');
  const { ctx } = fakeCtx();
  const config = { provider: 'pad', enabledProviders: ['pad'], key: 'test-key' };
  const settings = {
    describe: () => [{ ns: 'wechatpad', revision: 1, value: {} }],
    update: async (_ns, patch) => { Object.assign(config, patch); },
  };
  ctx.get = (name) => name === 'settings' ? settings : undefined;
  const pad = fakeConnection();
  const bots = [];
  const service = new WechatPadService({ ctx, config, createConnection: async (next) => {
    if (next.provider === 'pad') return pad;
    const bot = fakeConnection({ id: 'weixin' });
    bot.beginLogin = async () => ({ supported: true, ticket: 'new-login' });
    bots.push(bot); return bot;
  } });
  t.after(() => service.dispose());
  await service.start();
  await assert.rejects(service.beginLogin(), /先启用并保存/);
  await service.updateSettings({ enabledProviders: ['pad', 'weixin'] }, 1);
  assert.equal((await service.beginLogin()).ticket, 'new-login');
  assert.equal(service.status().connections.weixin.phase, 'connected');
  assert.equal(bots.length, 1);
  assert.equal(pad.calls.filter((call) => call.method === 'start').length, 1);
  assert.equal(pad.calls.filter((call) => call.method === 'stop').length, 0);
  await service.updateSettings({ enabledProviders: ['pad'] }, 1);
  assert.equal(bots[0].calls.filter((call) => call.method === 'stop').length, 1);
  assert.equal(service.status().connections.weixin.phase, 'disabled');
  assert.equal(pad.calls.filter((call) => call.method === 'stop').length, 0);
  // Edits from the generic settings form are live references too. The first
  // action reconciles them even when this page did not perform the save.
  config.enabledProviders = ['pad', 'weixin'];
  assert.equal((await service.beginLogin()).ticket, 'new-login');
  assert.equal(bots.length, 2);
});

test('access isolation: QR bot accepts a peer that Pad whitelist rejects', async (t) => {
  const { WechatPadService } = await import('../host/wechatpad-service.js');
  const { ctx, prompts } = fakeCtx();
  const connections = { pad: fakeConnection(), weixin: fakeConnection({ id: 'weixin' }) };
  const service = new WechatPadService({ ctx, config: {
    enabledProviders: ['pad', 'weixin'], key: 'test-key', dmPolicy: 'allowlist',
    allowedUsers: ['only-pad-member'], selfWxid: 'pad-identity', showProgress: false,
  }, createConnection: async (config) => connections[config.provider] });
  t.after(() => service.dispose()); await service.start();
  const message = { messageId: 'access-1', chatId: 'shared-peer', senderId: 'shared-peer', isGroup: false, mentioned: false, text: 'hello', msgType: 1, createdAt: Date.now() };
  await connections.pad.emit(message);
  assert.equal(prompts.length, 0);
  await connections.weixin.emit(message);
  await until(() => prompts.length === 1);
  assert.equal(service.status().connections.weixin.messagesIn, 1);
  assert.equal(service.status().connections.weixin.messagesIgnored, 0);
  assert.equal(service.status().connections.pad.messagesIn, 0);
  await until(() => connections.weixin.calls.some((call) => call.method === 'send'));
  assert.equal(connections.pad.calls.filter((call) => call.method === 'send').length, 0);
  await connections.weixin.emit({ ...message, messageId: 'access-2', senderId: 'pad-identity', chatId: 'pad-identity' });
  await until(() => prompts.length === 2);
});

test('access isolation: Pad DM ignore policy does not disable the QR bot', async (t) => {
  const connection = fakeConnection({ id: 'weixin' });
  const { service, prompts } = await serviceWith(t, connection, { provider: 'weixin', dmPolicy: 'disabled', allowedUsers: [] });
  await connection.emit({ messageId: 'qr-open', chatId: 'peer', senderId: 'peer', text: 'hello', isGroup: false, msgType: 1, createdAt: Date.now() });
  await until(() => prompts.length === 1);
  assert.equal(service.status().messagesIgnored, 0);
});

});
