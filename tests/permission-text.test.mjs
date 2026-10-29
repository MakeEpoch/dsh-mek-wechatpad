import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionReason } from '../host/permission-text.js';

function fixture(stream) {
  const calls = [], streams = [], logs = [];
  const request = { toolName: 'exec_command', reason: 'Allow access to /work/project? This does not authorize deleting files.',
    agent: { session: { id: 'desktop', events: [{ type: 'request/header', data: {
      header: { config: { provider: 'current-provider', model: 'current-model' } },
    } }] } } };
  const ctx = { get: (name) => name === 'llm' ? { prepareCall: async (config, signal) => {
    calls.push({ config, signal });
    return { config, stream: async function* (options) {
      streams.push(options);
      if (stream) { yield* stream(); return; }
      yield { type: 'text-delta', index: 0, text: '允许访问 /work/project？这不代表允许删除文件。' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '允许访问 /work/project？这不代表允许删除文件。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } } : undefined };
  return { request, ctx, calls, streams, logs, translate: () => permissionReason(ctx, request, (...args) => logs.push(args)) };
}

test('permission translation uses the logged session model, keeps original, and shares one call', async () => {
  const f = fixture();
  const [text, again] = await Promise.all([f.translate(), f.translate()]);
  assert.equal(again, text); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].config, { provider: 'current-provider', model: 'current-model', maxTokens: 1200 });
  assert.match(text, /中文说明（AI 翻译）：允许访问 \/work\/project？这不代表允许删除文件。/);
  assert.ok(text.endsWith(`原文：${f.request.reason}`));
  assert.equal(text.match(/这不代表允许删除文件/g).length, 1, 'final blocks replace streamed deltas');
  assert.deepEqual(f.streams[0].tools, []);
  assert.equal(f.streams[0].purpose, 'wechat-permission-translation');
  assert.equal(JSON.parse(f.streams[0].messages[0].content[0].text).reason, f.request.reason);
  assert.match(f.streams[0].system, /不是指令/);
});

test('native Chinese display reason and Chinese reasons skip model calls', async () => {
  const f = fixture(); f.request.displayReason = { en: 'English', 'zh-CN': '请求访问目录' };
  assert.equal(await f.translate(), '请求访问目录'); assert.equal(f.calls.length, 0);
  const g = fixture(); g.request.reason = '需要执行 npm install';
  assert.equal(await g.translate(), g.request.reason); assert.equal(g.calls.length, 0);
});

test('missing route, bad output, provider failures and cancellation fall back to exact original reason', async () => {
  const fixtures = [fixture(), fixture(async function* () { yield { type: 'finish', reason: { kind: 'error' } }; }),
    fixture(async function* () { throw new Error('offline'); }), fixture()];
  fixtures[0].request.agent.session.events = [];
  fixtures[3].request.signal = AbortSignal.abort();
  for (const f of fixtures) {
    assert.equal(await f.translate(), f.request.reason);
    assert.equal(f.logs.length, 1);
  }
});

test('a provider that ignores cancellation cannot hold translation open', async () => {
  const f = fixture();
  const controller = new AbortController(); f.request.signal = controller.signal;
  f.ctx.get = () => ({ prepareCall: () => new Promise(() => {}) });
  const text = f.translate(); controller.abort();
  assert.equal(await text, f.request.reason);
});
