import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { NotificationRelay } from '../host/notifications.js';
import { resolveConfig } from '../host/config.js';

const settle = () => new Promise(setImmediate);
function fixture(t, send) {
  const ctx = new Context();
  const sent = [], logs = [];
  const config = resolveConfig({ enabledProviders: ['pad', 'weixin'], notificationChatId: 'recipient',
    notificationProvider: 'weixin', notifyTaskCompleted: true, notifyPermissionRequest: true });
  const relay = new NotificationRelay({ ctx, config: () => config,
    send: send ?? (async (...args) => { sent.push(args); return { ok: true }; }),
    logger: (...args) => logs.push(args) });
  const session = { id: 'desktop-session', header: { cwd: '/work/project' },
    events: [{ type: 'session/title', data: { title: '桌面任务' } }] };
  const end = (kind = 'completed', turn = 1) => ctx.emit('session/event', session,
    { seq: turn * 10, type: 'turn/end', data: { turn, reason: { kind } } });
  t.after(() => relay.dispose());
  return { ctx, sent, logs, config, relay, session, end };
}

test('desktop completion routes once to the selected provider/chat with session context', async (t) => {
  const f = fixture(t);
  await f.end(); await f.end(); await settle();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].slice(0, 2), ['weixin', 'recipient']);
  assert.match(f.sent[0][2], /任务完成.*\n会话：桌面任务\n会话 ID：desktop-session\n工作目录：\/work\/project/s);
  await f.end('completed', 2); await settle();
  assert.equal(f.sent.length, 2);
  await f.end('completed', 1); await settle();
  assert.equal(f.sent.length, 2);
});

test('only normal completion notifies; defaults and independent switches remain off', async (t) => {
  const f = fixture(t);
  assert.equal(resolveConfig({}).notifyTaskCompleted, false);
  assert.equal(resolveConfig({}).notifyPermissionRequest, false);
  for (const kind of ['aborted', 'error', 'blocked', 'interrupted', 'forked', 'max-tokens']) await f.end(kind);
  f.config.notifyTaskCompleted = false;
  await f.end(); await settle();
  assert.equal(f.sent.length, 0);
});

test('approval notification preserves native result, request and signal without awaiting delivery', async (t) => {
  const f = fixture(t, () => new Promise(() => {}));
  const signal = new AbortController().signal;
  const request = { agent: { session: f.session }, toolName: 'exec', reason: '需要访问目录', signal };
  let calls = 0;
  const outcome = await f.ctx.waterfall('approval/request', request, async (actual) => {
    calls++; assert.equal(actual, request); return 'rejected';
  });
  assert.equal(outcome, 'rejected'); assert.equal(calls, 1); assert.equal(request.signal, signal);
});

test('approval reminder is one-way, deduplicated, independent and skips already aborted requests', async (t) => {
  const f = fixture(t);
  const request = { agent: { session: f.session }, toolName: 'exec', reason: '访问目录' };
  for (let i = 0; i < 2; i++) assert.equal(await f.ctx.waterfall('approval/request', request, async () => 'allowed-once'), 'allowed-once');
  await settle();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][2], /权限请求/); assert.match(f.sent[0][2], /工具：exec/);
  assert.match(f.sent[0][2], /不接受回复/); assert.doesNotMatch(f.sent[0][2], /\/answer/);
  f.config.notifyPermissionRequest = false;
  await f.ctx.waterfall('approval/request', { ...request }, async () => 'rejected');
  f.config.notifyPermissionRequest = true;
  await f.ctx.waterfall('approval/request', { ...request, signal: AbortSignal.abort() }, async () => 'cancelled');
  await settle(); assert.equal(f.sent.length, 1);
});

test('missing target, disabled connection/plugin and disposal suppress notifications', async (t) => {
  const f = fixture(t);
  f.config.notificationChatId = ''; await f.end('completed', 1);
  f.config.notificationChatId = 'recipient'; f.config.enabledProviders = ['pad']; await f.end('completed', 2);
  f.config.enabledProviders = ['weixin']; f.config.enabled = false; await f.end('completed', 3);
  f.config.enabled = true; f.relay.dispose(); await f.end('completed', 4);
  await settle(); assert.equal(f.sent.length, 0);
});

test('provider failures are logged without failing session events or approvals', async (t) => {
  const f = fixture(t, async () => ({ ok: false, error: 'offline' }));
  await f.end();
  await f.ctx.waterfall('approval/request', { agent: { session: f.session } }, async () => 'unavailable');
  await settle(); assert.equal(f.logs.length, 2);
  assert.match(f.logs[0][1], /offline/);
});
