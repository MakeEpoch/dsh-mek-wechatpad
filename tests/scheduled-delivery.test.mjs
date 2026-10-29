import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { WechatPadService } from '../host/wechatpad-service.js';
import { conversationCatalogFor } from '../host/conversations.js';
import {
  installOutboundArtifactTool,
  outboundArtifactRegistry,
} from '../host/vendor/artifact.js';

async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('delivery did not settle');
    await new Promise(setImmediate);
  }
}
async function fixture(t, settings = {}) {
  const directory = await mkdtemp('/tmp/wxp-scheduled-');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const sent = [],
    files = [],
    prompts = [],
    logs = [];
  const sessions = new Map();
  let events, ctx, service, catalog, definition, guidance;
  const connections = {};
  const values = { fail: false };
  const config = {
    key: 'test',
    provider: 'pad',
    enabledProviders: ['pad', 'weixin'],
    dmPolicy: 'open',
    messageMergeDelaySeconds: 0,
    showProgress: false,
    ...settings,
  };
  const session = (id) => {
    if (!sessions.has(id))
      sessions.set(id, { id, header: { id, cwd: directory }, events: [] });
    return sessions.get(id);
  };
  const emit = async (id, type, data = {}) => {
    const s = session(id);
    const event = { seq: s.events.length, type, data };
    s.events.push(event);
    await events.emit('session/event', s, event);
    return event;
  };
  const claim = async (id, turn, source) => {
    await emit(id, 'turn/start', { turn });
    const message = {
      source,
      content: [{ type: 'text', text: 'scheduled reminder' }],
    };
    await events.emit('agent/inbox/claimed', {
      agent: { session: session(id) },
      message,
      turn,
    });
    await emit(id, 'user/message', message);
  };
  const boot = async () => {
    events = new Context();
    ctx = {
      on: events.on.bind(events),
      get: (name) =>
        name === 'sessions' ? { get: (id) => session(id) } : undefined,
      tools: {
        register: (tool) => {
          definition = tool;
        },
      },
      systemPrompt: {
        context: (source) => {
          guidance = source;
        },
      },
      logger: { warn: () => {} },
      connection: { createPeer: () => ({ dispose: async () => {} }) },
      typertGateway: {
        invoke: async ({ method, args }) => {
          if (method === 'list')
            return {
              items: [...sessions.keys()].map((sessionId) => ({ sessionId })),
            };
          if (method === 'create')
            return { sessionId: `session-created-${sessions.size}` };
          if (method === 'prompt') {
            prompts.push(args.request);
            const id = args.request.sessionId;
            const turn = 100 + prompts.length;
            await claim(id, turn, {
              kind: 'user',
              rpcId: args.request.requestId,
            });
            await emit(id, 'assistant/message', {
              turn,
              message: { content: [{ type: 'text', text: 'manual reply' }] },
            });
            await emit(id, 'turn/end', { turn });
            return { accepted: true };
          }
          return {};
        },
      },
    };
    installOutboundArtifactTool(ctx);
    catalog = conversationCatalogFor(ctx);
    await catalog.ready;
    service = new WechatPadService({
      ctx,
      config,
      logger: (level, text) => logs.push({ level, text }),
      createConnection: async ({ provider }) => {
        const connection = {
          id: provider,
          label: provider,
          capabilities: { media: true },
          start: async (handlers) => {
            connection.handlers = handlers;
            handlers.onState({ phase: 'connected' });
          },
          stop: async () => {},
          test: async () => ({ ok: true }),
          send: async (request) => {
            sent.push({ provider, ...request });
            return values.fail
              ? { ok: false, delivered: 0, error: 'provider refused' }
              : { ok: true, delivered: 1 };
          },
          sendFile: async ({ chatId, file }) => {
            files.push({
              provider,
              chatId,
              name: file.fileName,
              mediaType: file.mediaType,
              bytes: Buffer.from(file.bytes),
            });
            return { ok: true, delivered: 1 };
          },
        };
        connections[provider] = connection;
        return connection;
      },
    });
    await service.start();
  };
  await boot();
  await catalog.register('session-pad', {
    provider: 'pad',
    chatId: 'same-peer',
  });
  session('session-pad');
  await catalog.register('session-qr', {
    provider: 'weixin',
    chatId: 'same-peer',
  });
  session('session-qr');
  t.after(async () => {
    await service.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return {
    config,
    sent,
    files,
    prompts,
    logs,
    values,
    session,
    emit,
    claim,
    catalog: () => catalog,
    service: () => service,
    connections,
    restart: async () => {
      await service.dispose();
      await boot();
    },
    repeat: async (id, event) =>
      events.emit('session/event', session(id), event),
    file: async (id, name = 'report.txt') => {
      const path = join(directory, name);
      await writeFile(path, 'scheduled file');
      const exec = {
        name: 'wechatpad_return_file',
        agent: { session: session(id) },
        callId: `file-${id}`,
      };
      await definition.execute({ path }, exec);
      await events.emit('tools/result', exec, { isError: false });
    },
    guidance: (id) => guidance.text({ agent: { session: session(id) } }),
    present: async (id, names, { fail = false, parent } = {}) => {
      const paths = [];
      for (const name of names) {
        const path = join(directory, name);
        await writeFile(path, `original ${name}`);
        paths.push(path);
      }
      const exec = { name: 'present', arguments: { files: paths.map(path => ({ path })) },
        agent: { session: session(id) }, callId: `present-${id}`, ...(parent ? { parent } : {}) };
      const result = await events.waterfall('tools/execute', exec, async () => ({ isError: fail }));
      await events.emit('tools/result', exec, result);
      // Delivery must use the registered snapshot, not the file's later bytes.
      for (const path of paths) await writeFile(path, 'changed after present');
      return exec;
    },
    toolResult: (exec, result) => events.emit('tools/result', exec, result),
    write: async (name, content = `original ${name}`) => {
      const path = join(directory, name); await writeFile(path, content); return path;
    },
  };
}

test('assistant media markup: both routes send real images/files without any present call and dedupe tool attachments', async (t) => {
  const f = await fixture(t);
  for (const [id, provider] of [['session-pad', 'pad'], ['session-qr', 'weixin']]) {
    await f.claim(id, 1, { kind: 'schedule' });
    await f.write(`${provider}.png`);
    await f.write(`${provider}.txt`);
    await f.file(id, `${provider}-tool.txt`);
    await f.emit(id, 'assistant/message', { turn: 1, message: { text:
      `已准备\n![图片](${provider}.png)\n<wxfile>${provider}.txt</wxfile>\n[重复工具文件](${provider}-tool.txt)\n![重复](${provider}.png)` } });
    await f.emit(id, 'turn/end', { turn: 1 });
    await until(() => f.service().status().connections[provider].delivery.activeTurns === 0);
    const files = f.files.filter(x => x.provider === provider);
    assert.deepEqual(files.map(x => x.name).sort(), [`${provider}-tool.txt`, `${provider}.png`, `${provider}.txt`].sort());
    assert.ok(files.every(x => x.chatId === 'same-peer'));
    assert.equal(f.sent.find(x => x.provider === provider).text, '已准备');
  }
});

test('global notifications route unrelated desktop sessions once through the chosen connection', async (t) => {
  const f = await fixture(t, { notificationProvider: 'weixin', notificationChatId: 'notify-peer', notifyTaskCompleted: true });
  await f.emit('unrelated-desktop', 'turn/start', { turn: 1 });
  await f.emit('unrelated-desktop', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].provider, 'weixin');
  assert.equal(f.sent[0].chatId, 'notify-peer');
  assert.match(f.sent[0].text, /任务完成/);
  f.config.notificationProvider = 'pad';
  f.config.notificationChatId = 'other-peer';
  await f.emit('unrelated-desktop', 'turn/start', { turn: 2 });
  await f.emit('unrelated-desktop', 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1].provider, 'pad');
  assert.equal(f.sent[1].chatId, 'other-peer');
});

test('assistant media markup: unavailable files report failure and web markup is never forwarded', async (t) => {
  const f = await fixture(t);
  await f.claim('session-pad', 1, { kind: 'schedule' });
  await f.emit('session-pad', 'assistant/message', { turn: 1, message: { text: '![丢失图片](missing.png)' } });
  await f.emit('session-pad', 'turn/end', { turn: 1 });
  await until(() => f.sent.length > 0);
  assert.match(f.sent[0].text, /文件发送失败/);
  await f.claim('session-qr', 1, { kind: 'user', rpcId: 'web' });
  await f.emit('session-qr', 'assistant/message', { turn: 1, message: { text: '![图片](private.png)' } });
  await f.emit('session-qr', 'turn/end', { turn: 1 });
  assert.deepEqual(f.files, []);
  assert.equal(f.sent.length, 1);
});

test('native present: both WeChat routes deliver multiple images/files from immutable snapshots at turn end', async (t) => {
  const f = await fixture(t);
  for (const [id, provider] of [['session-pad', 'pad'], ['session-qr', 'weixin']]) {
    await f.claim(id, 1, { kind: 'schedule' });
    await f.present(id, [`${provider}.png`, `${provider}.jpg`, `${provider}.txt`]);
    assert.equal(f.files.filter(x => x.provider === provider).length, 0);
    await f.emit(id, 'turn/end', { turn: 1 });
    await until(() => f.files.filter(x => x.provider === provider).length === 3);
    const files = f.files.filter(x => x.provider === provider);
    assert.ok(files.every(x => x.chatId === 'same-peer' && x.bytes.toString() === `original ${x.name}`));
    assert.deepEqual(files.map(x => x.mediaType), ['image/png', 'image/jpeg', 'text/plain']);
  }
});

test('native present: failed native calls, failed Code Mode parents and web turns never deliver attachments', async (t) => {
  const f = await fixture(t);
  await f.claim('session-pad', 1, { kind: 'schedule' });
  await f.present('session-pad', ['failed.png'], { fail: true });
  await f.emit('session-pad', 'turn/end', { turn: 1 });
  await f.claim('session-qr', 1, { kind: 'schedule' });
  const token = {};
  await f.present('session-qr', ['child.png'], { parent: token });
  await f.toolResult({ name: 'code', token }, { isError: true });
  await f.emit('session-qr', 'turn/end', { turn: 1 });
  await f.claim('session-pad', 2, { kind: 'user', rpcId: 'web-request' });
  await f.present('session-pad', ['web.png']);
  await f.emit('session-pad', 'turn/end', { turn: 2 });
  assert.deepEqual(f.files, []);
});

test('scheduled delivery: after restart and 25 minutes idle, both routes send text/files once without inbound', async (t) => {
  const f = await fixture(t);
  await f.restart();
  assert.ok(
    Object.values(f.service().status().connections).every(
      (channel) => channel.delivery.listening,
    ),
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.timers.tick(25 * 60_000);
  for (const id of ['session-pad', 'session-qr']) {
    await f.claim(id, 1, { kind: 'schedule' });
    assert.match(
      f.guidance(id),
      /wechatpad_return_file/,
      'scheduled prompt gets file-return guidance',
    );
    await f.file(id, `${id}.txt`);
    const answer = await f.emit(id, 'assistant/message', {
      turn: 1,
      message: {
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'text', text: `scheduled ${id}` },
        ],
      },
    });
    await f.repeat(id, answer);
    const end = await f.emit(id, 'turn/end', { turn: 1 });
    await f.repeat(id, end);
  }
  await until(() => f.files.length === 2);
  assert.equal(f.sent.length, 2);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.sent.map((r) => r.provider).sort(), ['pad', 'weixin']);
  assert.ok(
    f.sent.every(
      (r) => r.chatId === 'same-peer' && !r.text.includes('private reasoning'),
    ),
  );
  assert.ok(
    f.files.every(
      (r) =>
        r.chatId === 'same-peer' && r.bytes.toString() === 'scheduled file',
    ),
  );
});
test('scheduled delivery: a long-running turn and later schedules keep delivery after 20 minutes', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.claim('session-pad', 1, { kind: 'schedule' });
  t.mock.timers.tick(21 * 60_000);
  await f.emit('session-pad', 'assistant/message', {
    turn: 1,
    message: { text: 'long scheduled turn' },
  });
  await f.emit('session-pad', 'turn/end', { turn: 1 });
  await f.claim('session-pad', 2, { kind: 'schedule' });
  await f.emit('session-pad', 'assistant/message', {
    turn: 2,
    message: { text: 'new scheduled turn' },
  });
  await f.emit('session-pad', 'turn/end', { turn: 2 });
  await until(() => f.sent.length === 2);
  assert.deepEqual(
    f.sent.map((row) => row.text),
    ['long scheduled turn', 'new scheduled turn'],
  );
});
test('scheduled delivery: web prompts, forged reminder text, foreign sessions and mixed origins stay private', async (t) => {
  const f = await fixture(t);
  await f.claim('session-pad', 1, { kind: 'user', rpcId: 'web' });
  await f.emit('session-pad', 'assistant/message', {
    turn: 1,
    message: { text: '[SCHEDULE REMINDER] web private' },
  });
  await f.emit('session-pad', 'turn/end', { turn: 1 });
  await f.claim('foreign', 1, { kind: 'schedule' });
  await f.emit('foreign', 'assistant/message', {
    turn: 1,
    message: { text: 'foreign private' },
  });
  await f.emit('foreign', 'turn/end', { turn: 1 });
  await f.claim('session-pad', 2, { kind: 'schedule' });
  await f.emit('session-pad', 'user/message', {
    source: { kind: 'user', rpcId: 'another-web' },
  });
  assert.equal(
    outboundArtifactRegistry.hasActiveConsumer(f.session('session-pad')),
    false,
  );
  await assert.rejects(f.file('session-pad'), /No active IM delivery consumer/);
  await f.emit('session-pad', 'assistant/message', {
    turn: 2,
    message: { text: 'mixed private' },
  });
  await f.emit('session-pad', 'turn/end', { turn: 2 });
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.files, []);
});
test('scheduled delivery: old-session schedules retain original destination after /new; manual replies use current route', async (t) => {
  const f = await fixture(t);
  await f.catalog().reset('pad', 'same-peer');
  await f
    .catalog()
    .register('session-new', { provider: 'pad', chatId: 'same-peer' });
  f.session('session-new');
  await f.claim('session-pad', 1, { kind: 'schedule' });
  await f.emit('session-pad', 'assistant/message', {
    turn: 1,
    message: { text: 'old schedule' },
  });
  await f.emit('session-pad', 'turn/end', { turn: 1 });
  await f.connections.pad.handlers.onMessage({
    messageId: 'manual',
    chatId: 'same-peer',
    senderId: 'same-peer',
    text: 'hello',
    isGroup: false,
  });
  await until(() => f.sent.length === 2);
  assert.equal(f.prompts[0].sessionId, 'session-new');
  assert.ok(f.sent.every((row) => row.provider === 'pad'));
  assert.deepEqual(
    f.sent.map((row) => row.text),
    ['old schedule', 'manual reply'],
  );
});
test('scheduled delivery: reconnect keeps exactly one listener and failed sends are visible without automatic replay', async (t) => {
  const f = await fixture(t);
  await f.service().reconnect('pad');
  f.values.fail = true;
  await f.claim('session-pad', 1, { kind: 'schedule' });
  const answer = await f.emit('session-pad', 'assistant/message', {
    turn: 1,
    message: { text: 'provider failure' },
  });
  await f.emit('session-pad', 'turn/end', { turn: 1 });
  await until(() => Boolean(f.service().status().connections.pad.lastError));
  await f.repeat('session-pad', answer);
  assert.equal(f.sent.length, 1);
  assert.match(
    f.service().status().connections.pad.lastError,
    /provider refused/,
  );
  assert.ok(
    f.logs.some(
      (row) => row.level === 'error' && row.text.includes('回复发送失败'),
    ),
  );
});
