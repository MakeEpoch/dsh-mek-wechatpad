import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { QuestionRelay, formatQuestion, parseQuestionAnswer } from '../host/questions.js';

const question = {
  id: 'intent', header: '确认意图', question: '想让我做哪件事？',
  options: [{ label: '查新闻', description: '搜索今天的新闻' }, { label: '测试在线', description: '确认连接' }],
};
const noProvider = () => Promise.reject(Object.assign(new Error('no client'), { code: 'NO_PROVIDER' }));

function fixture({ questions = [question], native = noProvider, send } = {}) {
  const ctx = new Context();
  const sent = [];
  const relay = new QuestionRelay({ ctx, send: send ?? (async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; }) });
  relay.trackPrompt({ requestId: 'wx-prompt', sessionId: 's1', chatId: '1@chatroom', senderId: 'alice' });
  const controller = new AbortController();
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user', rpcId: 'wx-prompt' } } },
    { type: 'user/message', data: { source: { kind: 'time-context' } } },
  ];
  const request = { agent: { session: { id: 's1', snapshotEvents: () => events } }, questions, signal: controller.signal };
  return {
    relay, sent, controller, request, events, ctx,
    ask: () => ctx.waterfall('user-questions/request', request, native),
    answer: (text, overrides = {}) => relay.answer({ chatId: '1@chatroom', senderId: 'alice', text, ...overrides }),
  };
}

test('questions: full question and choices reach WeChat, numeric answer resumes the tool', async () => {
  const f = fixture();
  const done = f.ask();
  assert.match(f.sent[0].text, /想让我做哪件事/);
  assert.match(f.sent[0].text, /1\. 查新闻：搜索今天的新闻/);
  assert.equal(await f.answer('2'), true);
  assert.deepEqual(await done, { answers: [{ id: 'intent', selected: ['测试在线'] }] });
  assert.equal(f.request.signal.aborted, true, 'retire the native Web card');
  assert.equal(f.controller.signal.aborted, false, 'the enclosing turn must keep running');
  assert.equal(await f.answer('1'), false, 'no stale answer may resolve twice');
  f.relay.dispose();
});

test('questions: only the originating sender and chat may answer', async () => {
  const f = fixture();
  const done = f.ask();
  assert.equal(await f.answer('1', { senderId: 'bob' }), false);
  assert.equal(await f.answer('1', { chatId: '2@chatroom' }), false);
  assert.equal(f.relay.canAnswer({ chatId: '1@chatroom', senderId: 'alice' }), true);
  await f.answer('只是测试');
  assert.deepEqual(await done, { answers: [{ id: 'intent', selected: [], custom: '只是测试' }] });
  f.relay.dispose();
});

test('questions: browser answers retire pending WeChat choices without aborting the turn', async () => {
  let resolveNative;
  const f = fixture({ native: () => new Promise((resolve) => { resolveNative = resolve; }) });
  const done = f.ask();
  await Promise.resolve();
  const answer = { answers: [{ id: 'intent', selected: ['查新闻'] }] };
  resolveNative(answer);
  assert.deepEqual(await done, answer);
  assert.equal(await f.answer('2'), false);
  assert.equal(f.controller.signal.aborted, false);
  f.relay.dispose();
});

test('questions: browser-owned turns and completed historical prompts are never claimed', async () => {
  const sentinel = { answers: [] };
  for (const tail of [
    [{ type: 'user/message', data: { source: { kind: 'user', rpcId: 'browser' } } }],
    [{ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } }],
  ]) {
    const f = fixture({ native: async () => sentinel });
    f.events.push(...tail);
    assert.equal(await f.ask(), sentinel);
    assert.deepEqual(f.sent, []);
    f.relay.dispose();
  }
});

test('questions: question batches retain IDs and collect single, multiple and free-text answers', async () => {
  const f = fixture({ questions: [question, { ...question, id: 'multi', multiSelect: true }, { id: 'free', question: '补充说明？' }] });
  const done = f.ask();
  await f.answer('1,2');
  assert.match(f.sent.at(-1).text, /只能选择一个/);
  await f.answer('9');
  assert.match(f.sent.at(-1).text, /范围内/);
  await f.answer('1');
  assert.match(f.sent.at(-1).text, /2\/3/);
  await f.answer('1，2');
  assert.match(f.sent.at(-1).text, /补充说明/);
  await f.answer('123');
  assert.deepEqual(await done, { answers: [
    { id: 'intent', selected: ['查新闻'] },
    { id: 'multi', selected: ['查新闻', '测试在线'] },
    { id: 'free', selected: [], custom: '123' },
  ] });
  f.relay.dispose();
});

test('questions: abort, skip and teardown settle the tool and remove pending choices', async () => {
  for (const action of ['abort', 'skip', 'dispose', 'cancelChat']) {
    const f = fixture();
    const done = f.ask();
    const rejected = assert.rejects(done, (error) => error.code === (action === 'skip' ? 'ASK_CANCELLED' : 'ASK_ABORTED'));
    if (action === 'abort') f.controller.abort();
    else if (action === 'skip') await f.answer('/skip');
    else if (action === 'cancelChat') f.relay.cancelChat('1@chatroom');
    else f.relay.dispose();
    await rejected;
    assert.equal(await f.answer('1'), false);
    assert.equal(f.request.signal.aborted, true);
    if (action !== 'abort') assert.equal(f.controller.signal.aborted, false);
    f.relay.dispose();
  }
});

test('questions: delivery failure leaves the native answerer usable', async () => {
  const f = fixture({ send: async () => ({ ok: false, error: 'offline' }), native: async () => ({ answers: [] }) });
  assert.deepEqual(await f.ask(), { answers: [] });
  assert.equal(await f.answer('1'), false);
  f.relay.dispose();
});

test('questions: plan details and literal numeric custom answers are preserved', () => {
  const detail = '执行 sudo command --flag && check';
  assert.ok(formatQuestion({ ...question, detail }, 0, 1, 'abc').includes(detail));
  assert.deepEqual(parseQuestionAnswer(question, '文字: 123'), { id: 'intent', selected: [], custom: '123' });
  assert.deepEqual(parseQuestionAnswer(question, '查新闻'), { id: 'intent', selected: ['查新闻'] });
  assert.ok(parseQuestionAnswer({ ...question, multiSelect: true }, '1,1').error);
});

test('questions: concurrent requests require their own displayed answer token', async () => {
  const f = fixture();
  const first = f.ask();
  const second = f.ctx.waterfall('user-questions/request', {
    ...f.request, signal: f.controller.signal, questions: [{ ...question, id: 'other' }],
  }, noProvider);
  const tokens = f.sent.map((item) => /\/answer (\S+)/.exec(item.text)[1]);
  await f.answer('2');
  assert.match(f.sent.at(-1).text, /标识回复/);
  await f.answer(`/answer ${tokens[0]} 2`);
  assert.deepEqual(await first, { answers: [{ id: 'intent', selected: ['测试在线'] }] });
  await f.answer(`/answer ${tokens[1]} 1`);
  assert.deepEqual(await second, { answers: [{ id: 'other', selected: ['查新闻'] }] });
  f.relay.dispose();
});

test('approvals: exact operation reaches iLink and explicit token resumes once', async () => {
  const f = fixture();
  const command = 'npm install -g --cache /tmp/postfaro-npm-cache https://postfaro.1007.us/downloads/postfaro-cli-v0.4.1.tgz';
  f.events.push({ type: 'tool/call', data: { callId: 'c1', name: 'exec_command', arguments: command } });
  const request = { agent: f.request.agent, signal: f.controller.signal, toolName: 'exec_command', callId: 'c1', reason: '允许本次操作使用 danger-full-access 权限' };
  const done = f.ctx.waterfall('approval/request', request, async () => 'unavailable');
  await new Promise(setImmediate);
  assert.ok(f.sent[0].text.includes(command));
  assert.match(f.sent[0].text, /danger-full-access/);
  const token = /\/answer (\S+)/.exec(f.sent[0].text)[1];
  assert.equal(await f.answer(`/answer ${token} 允许一次`, { senderId: 'other' }), false);
  await f.answer('2');
  assert.equal(f.relay.canAnswer({ chatId: '1@chatroom', senderId: 'alice' }), true);
  await f.answer(`/answer ${token} 随便`);
  await f.answer(`/answer ${token} 允许一次`);
  assert.equal(await done, 'allowed-once');
  assert.equal(f.controller.signal.aborted, false);
  assert.equal(await f.answer(`/answer ${token} 允许一次`), false);
  f.relay.dispose();
});

test('approvals: native decision, rejection, abort and delivery failure settle safely', async () => {
  for (const mode of ['native', 'reject', 'abort', 'failure']) {
    const f = fixture({ ...(mode === 'failure' ? { send: async () => ({ ok: false }) } : {}) });
    const request = { agent: f.request.agent, signal: f.controller.signal, toolName: 'exec_command', reason: '确认权限' };
    const done = f.ctx.waterfall('approval/request', request, async () => mode === 'native' ? 'rejected' : 'unavailable');
    if (mode === 'reject') {
      await new Promise(setImmediate);
      const token = /\/answer (\S+)/.exec(f.sent[0].text)[1];
      await f.answer(`/answer ${token} 拒绝`);
    }
    if (mode === 'abort') f.controller.abort();
    assert.equal(await done, mode === 'abort' ? 'cancelled' : mode === 'failure' ? 'unavailable' : 'rejected');
    assert.equal(await f.answer('2'), false);
    f.relay.dispose();
  }
});
