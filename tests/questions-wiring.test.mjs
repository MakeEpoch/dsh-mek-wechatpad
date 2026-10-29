import { mkdtemp, rm } from 'node:fs/promises';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { WechatPadService } from '../host/wechatpad-service.js';

describe('question delivery', async () => {
/** Real local Bridge sockets with the production service and simulated DSH questions. */
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


const { WebSocketServer } = createRequire(import.meta.url)('ws');

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the question round trip');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const isGroup of [false, true]) {
  test(`questions wiring: ${isGroup ? 'group reply without another @' : 'DM'} answers the pending tool, not a new prompt`, async (t) => {
    const sent = [];
    const server = createServer(async (request, response) => {
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.equal(new URL(request.url, 'http://bridge').searchParams.has('key'), false);
        sent.push(...JSON.parse(Buffer.concat(chunks).toString()).MsgItem);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ Code: 200, Data: { isSendSuccess: true, newMsgId: String(sent.length) } }));
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ accounts: [] }));
      }
    });
    const sockets = new WebSocketServer({ server, path: '/ws/outbound' });
    let service;
    t.after(async () => {
      await service?.dispose();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const events = new Context();
    const admitted = [];
    const answers = [];
    let questionDone;
    const ctx = {
      on: events.on.bind(events),
      get: () => undefined,
      connection: { createPeer: () => ({ dispose: async () => {} }) },
      webServer: { register: () => () => {}, registerUpgrade: () => () => {} },
      typertGateway: {
        invoke: async ({ method, args }) => {
          if (method === 'create') return { sessionId: 's1' };
          if (method === 'list') return { items: [{ sessionId: 's1' }] };
          if (method !== 'prompt') return {};
          admitted.push(args.request);
          const session = {
            id: 's1',
            snapshotEvents: () => [
              { type: 'turn/start', data: { turn: 1 } },
              { type: 'user/message', data: { source: { kind: 'user', rpcId: args.request.requestId } } },
            ],
          };
          await events.emit('session/event', session, {type:'turn/start',data:{turn:1}});
          await events.emit('session/event', session, {type:'user/message',data:{source:{kind:'user',rpcId:args.request.requestId}}});
          const request = {
            agent: { session }, signal: new AbortController().signal,
            questions: [{ id: 'intent', question: '选择操作？', options: [{ label: '查新闻' }, { label: '测试在线' }] }],
          };
          questionDone = events.waterfall('user-questions/request', request, () => (
            Promise.reject(Object.assign(new Error('no browser'), { code: 'NO_PROVIDER' }))
          )).then(async (answer) => {
            answers.push(answer);
            await events.emit('session/event', session, {
              type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到你的选择：测试在线' }] } },
            });
          });
          return { accepted: true };
        },
      },
    };
    let mergeDelay = 0;
    service = new WechatPadService({ ctx, config: {
      receiveMode: 'bridge', bridgeBaseUrl: baseUrl, bridgeToken: 'test', bridgeAccounts: 'wxid_bot',
      selfWxid: 'wxid_bot',
      messageMergeDelaySeconds: { get: () => mergeDelay },
      dmPolicy: 'allowlist', allowedUsers: ['alice'],
      groupPolicy: 'allowlist', allowedGroups: ['1@chatroom'], groupRequireMention: true,
    } });
    await service.start();
    const chatId = isGroup ? '1@chatroom' : 'alice';
    function push(id, text, mentioned) {
      const message = {
        from_user_name: { str: chatId }, to_user_name: { str: 'wxid_bot' },
        content: { str: isGroup ? `alice:\n${text}` : text },
        msg_type: 1, new_msg_id: id,
        msg_source: mentioned ? '<msgsource><atuserlist>wxid_bot</atuserlist></msgsource>' : '',
      };
      for (const socket of sockets.clients) socket.send(JSON.stringify({ type: 'message', wxid: 'wxid_bot', message }));
    }
    push('initial', '1', isGroup);
    await until(() => sent.length === 1);
    assert.equal(sent[0].ToUserName, chatId);
    assert.match(sent[0].TextContent, /选择操作/);
    assert.match(sent[0].TextContent, /2\. 测试在线/);
    mergeDelay = 30; // Pending answers must bypass even the longest merge delay.
    push('answer', '2', false);
    await until(() => answers.length === 1);
    await questionDone;
    assert.deepEqual(answers, [{ answers: [{ id: 'intent', selected: ['测试在线'] }] }]);
    assert.equal(admitted.length, 1, 'answer must not be queued as a new model prompt');
    await until(() => sent.length === 2);
    assert.equal(sent[1].ToUserName, chatId);
    assert.match(sent[1].TextContent, /收到你的选择/);
  });
}

});
