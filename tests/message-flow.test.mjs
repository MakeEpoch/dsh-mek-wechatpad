import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { WechatPadService } from '../host/wechatpad-service.js';

const { WebSocketServer } = createRequire(import.meta.url)('ws');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline)
      throw new Error('timed out waiting for message flow');
    await pause(10);
  }
}

async function fixture(t, { legacyFile, groupConfig = {} } = {}) {
  const testHome = await mkdtemp('/tmp/dsh-session-memory-');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = testHome;
  if (legacyFile) {
    await mkdir(join(testHome, 'wechatpad'));
    await writeFile(join(testHome, 'wechatpad', 'bindings.json'), legacyFile);
  }
  const sent = [],
    calls = [],
    prompts = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST') return response.end('{"accounts":[]}');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    sent.push(...JSON.parse(Buffer.concat(chunks).toString()).MsgItem);
    response.end('{"Code":200,"Data":{"isSendSuccess":true}}');
  });
  const sockets = new WebSocketServer({ server, path: '/ws/outbound' });
  let service;
  t.after(async () => {
    await service?.dispose();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(testHome, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let events = new Context();
  const created = [];
  const createdCwds = [];
  const deleted = new Set();
  const values = { delay: 0.1, mode: 'queue', listFailure: false };
  const ctx = {
    on: events.on.bind(events),
    get: () => undefined,
    connection: { createPeer: () => ({ dispose: async () => {} }) },
    webServer: { register: () => () => {}, registerUpgrade: () => () => {} },
    typertGateway: {
      invoke: async ({ method, args }) => {
        calls.push(method);
        if (method === 'create') {
          await pause(values.createDelay ?? 20);
          const sessionId = `s${created.length + 1}`;
          created.push(sessionId);
          createdCwds.push(args.request.cwd);
          return { sessionId };
        }
        if (method === 'list') {
          if (values.listFailure) throw new Error('temporary list failure');
          return {
            items: created
              .filter((id) => !deleted.has(id))
              .map((sessionId) => ({ sessionId })),
          };
        }
        if (method !== 'prompt') return {};
        prompts.push(args.request);
        const session = { id: args.request.sessionId };
        await events.emit('session/event', session, { type: 'turn/start', data:{turn:prompts.length} });
        await events.emit('session/event', session, {type:'user/message',data:{source:{kind:'user',rpcId:args.request.requestId}}});
        for (const text of values.segments ?? [`reply-${prompts.length}`]) {
          await events.emit('session/event', session, {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text }] } },
          });
          if (values.segmentPause) await pause(values.segmentPause);
        }
        if (!values.holdTurnEnd) await events.emit('session/event', session, {type:'turn/end',data:{turn:prompts.length}});
        return { accepted: true };
      },
    },
  };
  const config = {
    receiveMode: 'bridge',
    bridgeBaseUrl: `http://127.0.0.1:${server.address().port}`,
    bridgeToken: 'test',
    bridgeAccounts: 'bot',
    selfWxid: 'bot',
    dmPolicy: 'open',
    showProgress: false,
    ...(legacyFile ? { persistBinding: true } : {}), // Legacy config must not restore old sessions.
    messageMergeDelaySeconds: { get: () => values.delay },
    incomingMessageMode: { get: () => values.mode },
    ...groupConfig,
  };
  service = new WechatPadService({ ctx, config });
  await service.start();
  let id = 0;
  const push = (text) => {
    const message = {
      from_user_name: { str: 'alice' },
      to_user_name: { str: 'bot' },
      content: { str: text },
      msg_type: 1,
      new_msg_id: String(++id),
    };
    for (const socket of sockets.clients)
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: 'message', wxid: 'bot', message }));
  };
  const pushGroup = (chatId, sender, text, atUsers = []) => {
    const message = {
      from_user_name: { str: chatId }, to_user_name: { str: 'bot' },
      content: { str: `${sender}:\n${text}` }, msg_type: 1,
      new_msg_id: String(++id), AtWxIDList: atUsers,
    };
    for (const socket of sockets.clients)
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: 'message', wxid: 'bot', message }));
  };
  return {
    sent,
    calls,
    prompts,
    createdCwds,
    values,
    push,
    pushGroup,
    testHome,
    removeSession: (id) => deleted.add(id),
    reconnect: () => service.reconnect(),
    restart: async () => {
      await service.dispose();
      events = new Context();
      ctx.on = events.on.bind(events);
      service = new WechatPadService({ ctx, config });
      await service.start();
    },
  };
}

test('group flow: @others stays silent, saved context reaches the next @bot after restart', async (t) => {
  const f = await fixture(t, { groupConfig: {
    groupPolicy: 'allowlist', allowedGroups: ['room@chatroom'], groupRequireMention: false,
  } });
  f.values.delay = 0;
  f.pushGroup('room@chatroom', 'alice', '@Bob\u2005明天上午十点开会', ['wxid_bob']);
  f.pushGroup('other@chatroom', 'mallory', '@Bob\u2005不应保存的其他群消息', ['wxid_bob']);
  const contextPath = join(f.testHome, 'wechatpad', 'group-context.json');
  await until(async () => {
    try { return (await readFile(contextPath, 'utf8')).includes('明天上午十点'); }
    catch { return false; }
  });
  assert.equal(f.prompts.length, 0);
  assert.doesNotMatch(await readFile(contextPath, 'utf8'), /不应保存的其他群消息/);
  await f.restart();
  f.pushGroup('room@chatroom', 'alice', '@bot\u2005刚才约的时间是什么？', ['bot']);
  await until(() => f.prompts.length === 1);
  assert.match(f.prompts[0].content[0].text, /明天上午十点开会/);
  assert.doesNotMatch(f.prompts[0].content[0].text, /不应保存的其他群消息/);
  assert.match(f.prompts[0].content[0].text, /刚才约的时间是什么/);
  f.pushGroup('room@chatroom', 'alice', '@bot\u2005再说一次', ['bot']);
  await until(() => f.prompts.length === 2);
  assert.doesNotMatch(f.prompts[1].content[0].text, /明天上午十点开会/);
});

test('chat override merges a whole reply and new chats receive separate workspaces', async (t) => {
  const f = await fixture(t, { groupConfig: {
    mergeReplies: false,
    chatOverrides: [{ provider: 'pad', chatId: 'alice', mergeReplies: true }],
  } });
  f.values.delay = 0;
  f.values.segments = ['第一段', '第二段'];
  f.values.segmentPause = 900;
  f.push('请回答');
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].TextContent, '第一段\n\n第二段');
  assert.equal(f.createdCwds[0], join(f.testHome, 'wechat', 'alice'));
});

test('message flow: rapid messages merge, queued submissions retain earlier unsent replies', async (t) => {
  const f = await fixture(t);
  f.push('1');
  f.push('2');
  f.push('3');
  await until(() => f.prompts.length === 1);
  assert.deepEqual(f.prompts[0].content, [{ type: 'text', text: '1\n2\n3' }]);
  f.values.delay = 0;
  f.push('4');
  await until(() => f.prompts.length === 2);
  assert.equal(f.calls.filter((method) => method === 'create').length, 1);
  assert.equal(f.calls.includes('cancel'), false);
  assert.ok(f.prompts.every((prompt) => prompt.mode === 'queue'));
  await until(() => f.sent.length >= 2);
  assert.match(f.sent.map(row => row.TextContent).join('\n'), /reply-1[\s\S]*reply-2/);
  await assert.rejects(
    readFile(join(f.testHome, 'wechatpad', 'bindings.json')),
    { code: 'ENOENT' },
  );
});

test('message flow: live interrupt setting cancels before admitting the new batch', async (t) => {
  const f = await fixture(t);
  f.values.delay = 0; f.values.holdTurnEnd = true;
  f.push('first');
  await until(() => f.prompts.length === 1);
  f.values.mode = 'interrupt';
  f.push('second');
  await until(() => f.prompts.length === 2);
  const control = f.calls.filter(
    (method) => method === 'prompt' || method === 'cancel',
  );
  assert.deepEqual(control, ['prompt', 'cancel', 'prompt']);
  await until(() => f.sent.length > 0);
  assert.equal(f.sent[0].TextContent, 'reply-2');
});

test('message flow: stop commands bypass merging and drop the unsent batch', async (t) => {
  const f = await fixture(t);
  f.values.delay = 0.2;
  f.push('buffered');
  f.push('/stop');
  await until(() => f.sent.length > 0);
  await pause(300);
  assert.deepEqual(f.prompts, []);
  assert.match(f.sent[0].TextContent, /没有可停止/);
});

test('sessions: reuse across reconnect and fresh plugin context after restart, ignore legacy file', async (t) => {
  const legacyFile = JSON.stringify({
    version: 1,
    chats: { alice: { sessionId: 'old-session' } },
  });
  const f = await fixture(t, { legacyFile });
  f.values.delay = 0;
  f.push('first');
  await until(() => f.prompts.length === 1);
  f.push('second');
  await until(() => f.prompts.length === 2);
  await f.reconnect();
  f.push('after reconnect');
  await until(() => f.prompts.length === 3);
  await f.restart();
  f.push('after restart');
  await until(() => f.prompts.length === 4);
  assert.deepEqual(
    f.prompts.map((prompt) => prompt.sessionId),
    ['s1', 's1', 's1', 's1'],
  );
  assert.equal(
    await readFile(join(f.testHome, 'wechatpad', 'bindings.json'), 'utf8'),
    legacyFile,
  );
});

test('sessions: new/reset boundaries survive restart before another message arrives', async (t) => {
  const f = await fixture(t);
  f.values.delay = 0;
  f.push('first');
  await until(() => f.prompts.length === 1);
  f.push('/new');
  await until(() => f.sent.some((row) => /已开启新会话/.test(row.TextContent)));
  await f.restart();
  f.push('after new and restart');
  await until(() => f.prompts.length === 2);
  assert.equal(f.prompts[1].sessionId, 's2');
  const count = f.sent.filter((row) =>
    /已开启新会话/.test(row.TextContent),
  ).length;
  f.push('/reset');
  await until(
    () =>
      f.sent.filter((row) => /已开启新会话/.test(row.TextContent)).length >
      count,
  );
  await f.restart();
  f.push('after reset and restart');
  await until(() => f.prompts.length === 3);
  assert.equal(f.prompts[2].sessionId, 's3');
});
test('sessions: only confirmed deletion creates a replacement, lookup errors preserve the route', async (t) => {
  const f = await fixture(t);
  f.values.delay = 0;
  f.push('first');
  await until(() => f.prompts.length === 1);
  await f.restart();
  f.values.listFailure = true;
  f.push('temporary failure');
  await until(() => f.prompts.length === 2);
  assert.equal(f.prompts[1].sessionId, 's1');
  f.values.listFailure = false;
  f.removeSession('s1');
  f.push('after deletion');
  await until(() => f.prompts.length === 3);
  assert.equal(f.prompts[2].sessionId, 's2');
  await f.restart();
  f.push('continue replacement');
  await until(() => f.prompts.length === 4);
  assert.equal(f.prompts[3].sessionId, 's2');
});

test('sessions: a reset during slow creation cannot restore the cancelled route', async (t) => {
  const f = await fixture(t);
  f.values.delay = 0;
  f.values.createDelay = 150;
  f.push('cancelled first message');
  await until(() => f.calls.includes('create'));
  f.push('/new');
  await until(() => f.sent.length > 0);
  await pause(200);
  assert.equal(f.prompts.length, 0);
  f.values.createDelay = 0;
  f.push('fresh message');
  await until(() => f.prompts.length === 1);
  assert.equal(f.prompts[0].sessionId, 's2');
  await f.restart();
  f.push('continue fresh');
  await until(() => f.prompts.length === 2);
  assert.equal(f.prompts[1].sessionId, 's2');
});
